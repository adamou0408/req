-- 稽核事件的雜湊鏈（PRB-CHAIN）。
--
-- 進鏈的是 body（RFC 8785 標準化 JSON 的 UTF-8 bytes），不是 jsonb：驗證工具只看 bytes，不依賴資料庫的輸出格式。
-- hash = sha256(prev_hash || body)；body 內含 seq，所以調換順序也會被發現。
-- 其他欄位只是為了查詢方便的索引；驗證工具會檢查它們和 body 一致。

create table sgn.audit_event (
    seq bigint primary key,
    occurred_at timestamptz not null,
    event_type text not null,
    case_id uuid,
    actor_person_id uuid,
    body bytea not null,
    prev_hash bytea not null,
    hash bytea not null
);

create index audit_event_case_idx on sgn.audit_event (case_id);

-- 鏈頭只有一列。寫事件時以 FOR UPDATE 鎖住它，所以併發的寫入會排隊、序號連續、沒有分叉。
create table sgn.audit_chain_head (
    singleton boolean primary key default true check (singleton),
    seq bigint not null,
    hash bytea not null
);

insert into sgn.audit_chain_head (seq, hash) values (0, decode(repeat('00', 32), 'hex'));

create function sgn_internal.audit_reject_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.raise_error('AUDIT_APPEND_ONLY', tg_table_name || ' ' || tg_op);
    return null;
end;
$$;

create trigger audit_event_no_update_delete
    before update or delete on sgn.audit_event
    for each row execute function sgn_internal.audit_reject_change();

create trigger audit_event_no_truncate
    before truncate on sgn.audit_event
    for each statement execute function sgn_internal.audit_reject_change();

create trigger audit_chain_head_no_delete
    before delete on sgn.audit_chain_head
    for each row execute function sgn_internal.audit_reject_change();

create trigger audit_chain_head_no_truncate
    before truncate on sgn.audit_chain_head
    for each statement execute function sgn_internal.audit_reject_change();

-- 鏈頭只能往前走一格，且必須指向剛寫入的那一筆。
create function sgn_internal.audit_head_check()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    if new.seq <> old.seq + 1
       or not exists (select 1 from sgn.audit_event e where e.seq = new.seq and e.hash = new.hash) then
        perform sgn_internal.raise_error('AUDIT_APPEND_ONLY', 'audit_chain_head must advance by one');
    end if;
    return new;
end;
$$;

create trigger audit_chain_head_advance_only
    before update on sgn.audit_chain_head
    for each row execute function sgn_internal.audit_head_check();

-- 寫稽核事件的唯一入口。
create function sgn_internal.audit_append(
    p_event_type text,
    p_case_id uuid,
    p_actor_person_id uuid,
    p_data jsonb
)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_head record;
    v_seq bigint;
    v_at timestamptz := sgn_internal.now();
    v_body bytea;
    v_hash bytea;
begin
    select seq, hash into v_head from sgn.audit_chain_head for update;
    v_seq := v_head.seq + 1;
    -- body 是標準化 JSON（RFC 8785）：資料庫以外的程式從欄位就能重建出相同的位元組。
    v_body := convert_to(
        sgn_internal.jcs(jsonb_build_object(
            'seq', v_seq,
            'at', v_at,
            'type', p_event_type,
            'case_id', p_case_id,
            'actor', p_actor_person_id,
            'data', coalesce(p_data, '{}'::jsonb)
        )),
        'UTF8'
    );
    v_hash := sha256(v_head.hash || v_body);
    insert into sgn.audit_event (seq, occurred_at, event_type, case_id, actor_person_id, body, prev_hash, hash)
    values (v_seq, v_at, p_event_type, p_case_id, p_actor_person_id, v_body, v_head.hash, v_hash);
    update sgn.audit_chain_head set seq = v_seq, hash = v_hash;
    return v_seq;
end;
$$;

-- ── 排程：給錨定與驗證工具（sgn_job）的唯讀入口 ──

create function api_job.chain_head(out seq bigint, out hash text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select seq, encode(hash, 'hex') from sgn.audit_chain_head
$$;

comment on function api_job.chain_head() is
    '目前的鏈頭（序號與雜湊）。呼叫者：sgn_job（錨定工具）。規則：PRB-CHAIN';

create function api_job.events_after(p_after_seq bigint, p_limit int)
returns table (
    seq bigint,
    occurred_at timestamptz,
    event_type text,
    case_id uuid,
    actor_person_id uuid,
    body text,
    prev_hash text,
    hash text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select seq, occurred_at, event_type, case_id, actor_person_id,
           encode(body, 'base64'), encode(prev_hash, 'hex'), encode(hash, 'hex')
    from sgn.audit_event
    where seq > p_after_seq
    order by seq
    limit least(p_limit, 10000)
$$;

comment on function api_job.events_after(bigint, int) is
    '依序號取原始事件（body 為 base64 的原始 bytes），給離線驗證工具重算。呼叫者：sgn_job。規則：PRB-CHAIN';

-- 程式指紋：所有自家 schema 的 function 定義、trigger 定義與啟用狀態、資料表與 function 的權限。
-- 錨定工具把它和鏈頭一起寫到資料庫以外；驗證工具比對，抓「最高權限者改了 function 或停用了 trigger」。
create function api_job.code_fingerprint()
returns text
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    with own as (
        select oid from pg_namespace
        where nspname in ('sgn', 'sgn_internal', 'api', 'api_sync', 'api_job', 'api_verified')
    ),
    parts as (
        select 'f:' || p.oid::regprocedure::text || ':' || pg_get_functiondef(p.oid) || ':' || coalesce(p.proacl::text, '') as part
        from pg_proc p
        where p.pronamespace in (select oid from own) and p.prokind = 'f'
        union all
        select 't:' || t.tgrelid::regclass::text || ':' || pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relnamespace in (select oid from own) and not t.tgisinternal
        union all
        select 'r:' || c.oid::regclass::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relowner::regrole::text
        from pg_class c
        where c.relnamespace in (select oid from own)
    )
    select encode(sha256(convert_to(string_agg(part, E'\n' order by part), 'UTF8')), 'hex') from parts
$$;

comment on function api_job.code_fingerprint() is
    '自家 schema 的 function、trigger（含啟用狀態）與權限的指紋。呼叫者：sgn_job。';
