-- 紅隊第五輪 中-4（裁決 D84 (7)；redteam/exploits/41、32）：錨定程式的帳號讓錨定停擺，之後後端改寫鏈，頁面只顯示「尚未錨定」的警告。
-- 這裡是資料庫這一側（存放處的序號規則在 db/tools/anchor-store.mjs，稽核頁的判定在 web/verify.js，重新啟動在 tools/run-all.sh）：
--   - 錨定程式把錨點寫進存放處之後告訴資料庫（api_job.anchor_recorded）；資料庫用自己的鏈比對序號、雜湊與程式指紋才記下。
--     這個回報不進鏈（否則每次錨定都產生一筆新事件，永遠錨不完），只用來判斷落後。
--   - 排程（api_job.anchor_lag_check）：最後一次記下的錨點之後的事件超過參數（audit.anchor_max_lag_seconds、audit.anchor_max_lag_events）
--     就開例外 K-ANCHOR-LAG 並通知（每段落後一筆）。錨定程式停掉、被弄停、或存放處不收，資料庫都會開例外，不必等有人打開稽核頁。
--   - 稽核頁的程式指紋端點同時給落後的參數，頁面依它把「落後超過參數」判為失敗（不是警告）。

insert into sgn.error_catalog (code, message, http_status) values
    ('ANCHOR_RECEIPT_INVALID', '回報的錨點和資料庫的鏈對不上（序號、雜湊或程式指紋不符）', 422);

select sgn_internal.register_setting_definition(
    'audit.anchor_lag_notify_roles', 'json', '["audit_head", "ciso"]', array[]::text[],
    '錨定落後超過參數（K-ANCHOR-LAG）時通知哪些角色的持有人'
);

create table sgn.anchor_receipt (
    -- 不參照 sgn.audit_event：稽核紀錄表連 owner 都不能 TRUNCATE，外鍵會讓竄改測試（刪鏈尾）改變錯誤種類
    seq bigint primary key,
    hash bytea not null,
    code_fingerprint text not null,
    recorded_at timestamptz not null
);

-- 錨定程式回報：這個錨點已經寫進存放處。序號必須在鏈上、雜湊與程式指紋必須是資料庫自己算的那個；已經記過（或更舊）的不重複記。
create function sgn_internal.anchor_recorded(p_seq bigint, p_hash text, p_code_fingerprint text)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_hash bytea := (select e.hash from sgn.audit_event as e where e.seq = p_seq);
    v_last bigint := (select max(r.seq) from sgn.anchor_receipt as r);
begin
    if p_seq is null or p_seq < 1 or v_hash is null or encode(v_hash, 'hex') is distinct from p_hash
       or p_code_fingerprint is distinct from api_job.code_fingerprint() then
        perform sgn_internal.raise_error('ANCHOR_RECEIPT_INVALID', coalesce(p_seq::text, 'null'));
    end if;
    if v_last is not null and p_seq <= v_last then
        return jsonb_build_object('recorded', false, 'last_seq', v_last);
    end if;
    insert into sgn.anchor_receipt (seq, hash, code_fingerprint, recorded_at) values (p_seq, v_hash, p_code_fingerprint, sgn_internal.now());
    return jsonb_build_object('recorded', true, 'last_seq', p_seq);
end;
$$;

create function api_job.anchor_recorded(p_seq bigint, p_hash text, p_code_fingerprint text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.anchor_recorded(p_seq, p_hash, p_code_fingerprint);
end;
$$;

comment on function api_job.anchor_recorded(bigint, text, text) is
    '錨定程式把錨點寫進錨點存放處之後回報：序號、雜湊與程式指紋要和資料庫自己的鏈相符才記下（不進鏈），排程依它判斷錨定有沒有落後。'
    '呼叫者：sgn_anchor（db/tools/anchor.mjs）。規則：K-ANCHOR-LAG';

-- 落後：最後一次記下的錨點之後有事件，而且最舊的一筆超過 audit.anchor_max_lag_seconds 或筆數超過 audit.anchor_max_lag_events。
-- 每段落後（上一次記下錨點之後）開一筆例外並通知。回傳開了幾筆（0 或 1）。
create function sgn_internal.anchor_lag_check()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_last sgn.anchor_receipt;
    v_head bigint := (select h.seq from sgn.audit_chain_head as h);
    v_oldest timestamptz;
    v_seconds int := sgn_internal.setting_int('audit.anchor_max_lag_seconds');
    v_events int := sgn_internal.setting_int('audit.anchor_max_lag_events');
    v_people uuid[];
begin
    select * into v_last from sgn.anchor_receipt order by seq desc limit 1;
    if v_head is null or v_head <= coalesce(v_last.seq, 0) then
        return 0;
    end if;
    v_oldest := (select e.occurred_at from sgn.audit_event as e where e.seq = coalesce(v_last.seq, 0) + 1);
    if v_oldest > sgn_internal.now() - make_interval(secs => v_seconds) and v_head - coalesce(v_last.seq, 0) <= v_events then
        return 0;
    end if;
    if exists (select 1 from sgn.exception_record as x where x.rule_code = 'K-ANCHOR-LAG'
               and x.opened_at >= coalesce(v_last.recorded_at, '-infinity'::timestamptz)) then
        return 0;
    end if;
    perform sgn_internal.exception_open('K-ANCHOR-LAG', null, jsonb_build_object(
        'last_anchored_seq', coalesce(v_last.seq, 0), 'last_anchored_at', v_last.recorded_at, 'head_seq', v_head,
        'oldest_unanchored_at', v_oldest,
        'settings', jsonb_build_object('audit.anchor_max_lag_seconds', v_seconds, 'audit.anchor_max_lag_events', v_events)));
    select coalesce(array_agg(distinct p), '{}') into v_people
    from jsonb_array_elements_text(sgn_internal.setting('audit.anchor_lag_notify_roles')) as r (code)
    cross join lateral unnest(sgn_internal.role_holders(r.code)) as p;
    perform sgn_internal.notify('audit.anchor_lag', v_people, null,
        jsonb_build_object('seq', coalesce(v_last.seq, 0)::text, 'head', v_head::text));
    return 1;
end;
$$;

create function api_job.anchor_lag_check()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('opened', sgn_internal.anchor_lag_check());
end;
$$;

comment on function api_job.anchor_lag_check() is
    '排程：最後一次記下的錨點之後的事件超過 audit.anchor_max_lag_seconds 或 audit.anchor_max_lag_events 時開例外 K-ANCHOR-LAG 並通知'
    '（每段落後一筆）。呼叫者：sgn_scheduler（db/tools/jobs.mjs）。規則：K-ANCHOR-LAG';

-- 稽核頁比對錨點用的程式指紋（同 70 的簽章）：多給落後的參數，頁面依它把「落後超過參數」判為失敗。
create or replace function api.audit_code_fingerprint(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.authorize(sgn_internal.session_person(p_session), 'audit.read');
    return jsonb_build_object(
        'code_fingerprint', api_job.code_fingerprint(),
        'anchor_policy', jsonb_build_object(
            'max_lag_seconds', sgn_internal.setting_int('audit.anchor_max_lag_seconds'),
            'max_lag_events', sgn_internal.setting_int('audit.anchor_max_lag_events'))
    );
end;
$$;

comment on function api.audit_code_fingerprint(text) is
    '目前的程式指紋與錨定落後的參數，讓稽核人員與錨點裡記下的指紋比對、把落後超過參數判為失敗。只限稽核角色，唯讀。'
    '呼叫者：sgn_app。規則：PRB-AUDIT-READ、K-ANCHOR-LAG';

comment on function api_job.chain_head() is
    '目前的鏈頭（序號與雜湊）。呼叫者：sgn_anchor（錨定程式）與操作者的離線驗證工具。規則：PRB-CHAIN';

select sgn_internal.register_rule(
    'K-ANCHOR-LAG',
    '錨定落後：最後一次記下的錨點之後的事件超過參數（audit.anchor_max_lag_seconds、audit.anchor_max_lag_events）時由資料庫開例外並通知；'
    '稽核頁與離線工具判為失敗；錨點存放處的序號嚴格遞增、不收 0 以下；錨定程式停掉會被重新啟動',
    null,
    'full',
    null
);

insert into sgn.notification_template (event_code, subject, body) values
    ('audit.anchor_lag', '稽核鏈的錨定落後', '稽核鏈最後一次外部錨定到第 {{seq}} 筆，目前已到第 {{head}} 筆，超過參數的時間或筆數。'
        '之後的紀錄只靠資料庫保護，請確認錨定程式與錨點存放處。');
