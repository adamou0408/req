-- 核准之後的系統對系統交付（裁決 D63；方向頁策略 2「內容不走樣」、4「核准之後繼續把關」）。
--
-- 交付是 port＋adapter：核心只認「受管系統的交付方式」（參數 delivery.mode，依 system:<代碼> 設定：
-- system＝系統對系統、file＝檔案交換、manual＝人工），哪個受管系統用哪一種、走哪個通道（delivery.channel）是資料。
-- 交付程式（api/src/delivery.ts，帳號 sgn_delivery，只能執行 api_delivery）依通道選 adapter，把資料庫給的位元組原樣送出。
--
-- 為什麼由資料庫產生內容並簽章（威脅表見 docs/handoff/delivery.md）：
--   - 規則內容由流程包的 hook 從核准的內容版本產生（build_delivery），存成文字；交付程式只拿得到這串文字與簽章。
--   - 私鑰在 sgn.signing_key（只有 owner 讀得到），簽章在 SECURITY DEFINER 的領取入口裡做；後端（sgn_app）與
--     交付程式（sgn_delivery）都拿不到私鑰，所以改內容、簽自己編的規則都會被外部系統以簽章擋下。
--   - 外部系統的回報只收交付程式（資料庫驗證過的登入角色）在租約內的回報；回報的分類（成功、重送、拒絕）由資料庫依
--     外部系統的證明（405：驗章、請求摘要、這次領取的一次性亂數）判斷，交付程式說的 HTTP 狀態與回應不算數（裁決 D81 (2)）。
--
-- 可靠送達：outbox（sgn.delivery_op）、冪等鍵（request_id，重送不變）、租約、退避（參數）、持續送不到開例外。
-- 順序：同一張單在同一通道上一次只送最前面一筆（head-of-line）；撤銷時還沒送出的套用與驗證直接作廢，
-- 正在送的套用等它有結果才送撤回，所以撤回不會被較舊的套用蓋掉（K-DELIVERY-ORDER）。
-- 狀態轉移一律經轉移表（sgn.state_transition 加上 entity 欄）。

create schema api_delivery;

-- ── 轉移表加上實體種類（申請單以外，交付也由同一張表驅動）──

alter table sgn.state_transition add column entity text not null default 'case';
alter table sgn.state_transition drop constraint state_transition_pkey;
alter table sgn.state_transition add primary key (entity, from_state, action);

create function sgn_internal.entity_next_state(p_entity text, p_state text, p_action text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select t.to_state
    from sgn.state_transition as t
    where t.entity = p_entity
      and t.from_state = p_state
      and t.action = p_action
$$;

-- 申請單的轉移查詢（同 40 的簽章）：只看申請單的列。
create or replace function sgn_internal.next_state(p_state text, p_action text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.entity_next_state('case', p_state, p_action)
$$;

-- 申請單以外的實體的轉移入口：不允許就丟錯。
create function sgn_internal.entity_transition(p_entity text, p_state text, p_action text)
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_to text := sgn_internal.entity_next_state(p_entity, p_state, p_action);
begin
    if v_to is null then
        perform sgn_internal.raise_error('STATE_TRANSITION', p_entity || ':' || p_state || ':' || p_action);
    end if;
    return v_to;
end;
$$;

insert into sgn.state_transition (entity, from_state, action, to_state) values
    ('case', 'pending_fulfilment', 'delivery_applied', 'verifying'),
    ('case', 'verifying', 'finish_fulfilment', 'active'),
    ('case', 'pending_fulfilment', 'fail_fulfilment', 'fulfilment_failed'),
    ('case', 'verifying', 'fail_fulfilment', 'fulfilment_failed'),
    ('case', 'active', 'revoke', 'revoked'),
    ('case', 'active', 'reduce', 'active'),
    ('case', 'active', 'expire', 'expired'),
    ('delivery_op', 'queued', 'claim', 'sending'),
    ('delivery_op', 'sending', 'claim', 'sending'),
    ('delivery_op', 'sending', 'succeed', 'done'),
    ('delivery_op', 'sending', 'retry', 'queued'),
    ('delivery_op', 'sending', 'reject', 'rejected'),
    ('delivery_op', 'queued', 'supersede', 'superseded'),
    ('verification_run', 'pending', 'pass', 'passed'),
    ('verification_run', 'pending', 'fail', 'failed'),
    ('verification_run', 'pending', 'cancel', 'cancelled');

-- ── 動作目錄：撤銷、生效後縮小（revoker：申請人、被授權者負責人、這張單的任一位簽核人或執行人、參數列的角色）──

alter table sgn.action drop constraint action_actor_rule_check;
alter table sgn.action
    add constraint action_actor_rule_check
        check (actor_rule in ('applicant', 'assignee', 'claimant', 'fulfiller', 'case_party', 'role', 'system', 'revoker'));

insert into sgn.action (action, scope, actor_rule, role_setting, denied_code, needs_proof, changes_state) values
    ('revoke', 'case', 'revoker', null, null, false, true),
    ('reduce', 'case', 'revoker', null, null, false, true),
    ('delivery_applied', 'case', 'system', null, null, false, true),
    ('fail_fulfilment', 'case', 'system', null, null, false, true),
    ('expire', 'case', 'system', null, null, false, true);

insert into sgn.error_catalog (code, message, http_status) values
    ('NOT_REVOKER', '只有申請人、被授權者的負責人、這張單的簽核人或執行人、MIS 可以撤銷或縮小這筆授權', 403),
    ('DELIVERY_LEASE', '這筆交付已經被重新領取或已經有結果', 409),
    ('DELIVERY_REPORT_INVALID', '交付結果的格式不正確', 422),
    ('DELIVERY_CHANNEL_MISSING', '這個受管系統設定為系統對系統交付，但沒有設定交付通道', 500),
    ('DELIVERY_MANUAL_ONLY', '這筆授權有人工執行的受管系統，不能直接縮小；請撤銷後重新申請', 409),
    ('SIGNING_KEY_MISSING', '平台沒有可用的交付簽章金鑰', 500);

insert into sgn.error_catalog (code, message, http_status) values
    ('DELIVERY_CASE_NO_MISSING', '這種交付要有單號', 500);

-- ── 參數 ──

select sgn_internal.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description)
from (values
    ('delivery.mode', 'text', '"manual"', array['system'],
        '受管系統的交付方式：system（系統對系統）、file（檔案交換，這一版視同人工）、manual（人工執行，只在外部系統沒有介面時）。'
        '依 system:<代碼> 設定（裁決 D63）'),
    ('delivery.channel', 'text', '""', array['system'],
        '系統對系統交付時，這個受管系統走哪個交付通道（交付程式依通道選 adapter；同一個外部系統的幾個受管系統共用一個通道）'),
    ('delivery.signature_context', 'text', '"sgn-dc-sig/1"', array['channel'],
        '交付簽章的領域分隔：被簽的位元組＝這個字串＋換行＋本文的原始位元組'),
    ('delivery.lease_seconds', 'integer', '60', array['channel'], '交付程式領走一筆之後，幾秒內沒有回報就可以被重新領取'),
    ('delivery.retry_base_seconds', 'integer', '5', array['channel'], '送不到時第一次重送的等待秒數；之後每次加倍'),
    ('delivery.retry_max_seconds', 'integer', '300', array['channel'], '重送等待秒數的上限'),
    ('delivery.stuck_alert_seconds', 'integer', '900', array['channel'],
        '一筆交付建立後超過幾秒還沒有結果，就開例外 K-DELIVERY-STUCK 並通知升級對象（持續送不到、交付程式停擺）'),
    ('delivery.escalation_roles', 'json', '["mis", "ciso"]', array[]::text[],
        '交付卡住、被拒絕、驗證沒過時通知哪些角色的持有人（升級；撤回送不到時不得靜默）'),
    ('grant.revoker_roles', 'json', '["mis"]', array['process'],
        '除了申請人、被授權者負責人、這張單的簽核人與執行人，持有這些角色的人也可以直接撤銷或縮小（rules.md「撤銷」）')
) as d (key, value_type, default_value, scope_kinds, description);

create function sgn_internal.delivery_mode(p_scope_ref text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.setting('delivery.mode', array[p_scope_ref]) #>> '{}'
$$;

create function sgn_internal.delivery_automated(p_scope_ref text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.delivery_mode(p_scope_ref) = 'system'
$$;

create function sgn_internal.delivery_setting_int(p_key text, p_channel text)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (sgn_internal.setting(p_key, array['channel:' || p_channel]) #>> '{}')::int
$$;

-- 升級對象：參數 delivery.escalation_roles 的持有人。
create function sgn_internal.delivery_escalation_people()
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(distinct p), '{}')
    from jsonb_array_elements_text(sgn_internal.setting('delivery.escalation_roles')) as r (code)
    cross join lateral unnest(sgn_internal.role_holders(r.code)) as p
$$;

-- ── 簽章金鑰：只有 owner 讀得到；一次只有一把在用 ──

create table sgn.signing_key (
    key_id text primary key check (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
    seed bytea not null check (length(seed) = 32),
    public_key bytea not null check (length(public_key) = 32),
    created_at timestamptz not null,
    retired_at timestamptz
);

create unique index signing_key_one_current on sgn.signing_key ((true)) where retired_at is null;

-- 產生新的簽章金鑰（安裝與輪替時由資料庫擁有者執行，db/tools/delivery-keys.mjs）。私鑰在資料庫裡產生、不離開資料庫；
-- 回傳公鑰的 PEM，交給外部系統設定為信任的金鑰。舊的那一把標為退役。
create function sgn_internal.signing_key_create(p_key_id text)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_seed bytea := sgn_internal.gen_random_bytes(32);
    v_public bytea := sgn_internal.ed25519_public_key(v_seed);
begin
    update sgn.signing_key set retired_at = sgn_internal.now() where retired_at is null;
    insert into sgn.signing_key (key_id, seed, public_key, created_at) values (p_key_id, v_seed, v_public, sgn_internal.now());
    perform sgn_internal.audit_append(
        'delivery.signing_key_created', null, null,
        jsonb_build_object('key_id', p_key_id, 'public_key', encode(v_public, 'hex'), 'rules', jsonb_build_array('K-DELIVERY-SIGNED'))
    );
    return sgn_internal.ed25519_spki_pem(v_public);
end;
$$;

-- 外部系統的信任清單用：目前這一把的代號與公鑰（PEM）。
create function sgn_internal.signing_keys_current()
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object('key_id', k.key_id, 'public_key_pem', sgn_internal.ed25519_spki_pem(k.public_key))), '[]')
    from sgn.signing_key as k
    where k.retired_at is null
$$;

-- 簽一串本文：被簽的位元組＝領域分隔＋換行＋本文（UTF-8）。
create function sgn_internal.delivery_sign(p_context text, p_body text)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_key sgn.signing_key;
begin
    select * into v_key from sgn.signing_key where retired_at is null;
    if v_key.key_id is null then
        perform sgn_internal.raise_error('SIGNING_KEY_MISSING');
    end if;
    return jsonb_build_object(
        'key_id', v_key.key_id,
        'alg', 'ed25519',
        'sig', replace(encode(sgn_internal.ed25519_sign(v_key.seed, v_key.public_key, convert_to(p_context || chr(10) || p_body, 'UTF8')), 'base64'), chr(10), ''),
        'context', p_context
    );
end;
$$;

-- ── outbox ──

create table sgn.delivery_op (
    id bigint generated always as identity primary key,
    channel text not null check (channel <> ''),
    kind text not null check (kind in ('apply', 'withdraw', 'purge', 'verify')),
    case_id uuid references sgn.request_case (id),
    version int,
    -- 冪等鍵：同一筆重送時不變（外部系統以它避免重複動作）
    request_id uuid not null unique,
    -- 送出的就是這串文字的 UTF-8 位元組（簽章涵蓋它），交付程式不得重新序列化
    body text not null,
    body_sha256 bytea not null,
    -- 外部系統上的方法與路徑（環境前綴之後），簽章的信封與證明都要相符
    method text not null,
    path text not null,
    -- 實際送出的位元組：套用與撤回是簽過的信封（帶期限，過期時重新簽），其他是 body 原樣
    sent_body text,
    sent_sha256 bytea,
    signed_until timestamptz,
    signature jsonb,
    -- 這次領取的一次性亂數：外部系統的證明必須帶著它（不能拿別次的回應來回報）
    nonce text,
    status text not null,
    attempts int not null default 0,
    next_attempt_at timestamptz not null,
    lease_token uuid,
    lease_until timestamptz,
    created_at timestamptz not null,
    finished_at timestamptz,
    last_http_status int,
    last_error text,
    result jsonb,
    superseded_by bigint references sgn.delivery_op (id),
    stuck_exception_id bigint references sgn.exception_record (id),
    -- 撤回被外部系統拒絕：不是終態，退避重送；第一次被拒時開例外並升級（紅隊第四輪 低-1、裁決 D81 (6)）
    refused_exception_id bigint references sgn.exception_record (id),
    check ((kind = 'purge') = (case_id is null))
);

create index delivery_op_pending_idx on sgn.delivery_op (channel, id) where status in ('queued', 'sending');
create index delivery_op_case_idx on sgn.delivery_op (case_id, channel, id);

-- 自動驗證（K-VERIFY-AUTO）：每一筆套用成功後一輪，案例由流程包從送出的規則產生。
create table sgn.verification_run (
    id bigint generated always as identity primary key,
    case_id uuid not null references sgn.request_case (id),
    version int not null,
    channel text not null,
    apply_op_id bigint not null references sgn.delivery_op (id),
    op_id bigint references sgn.delivery_op (id),
    cases jsonb not null,
    status text not null,
    results jsonb,
    mismatches jsonb,
    created_at timestamptz not null,
    finished_at timestamptz
);

create index verification_run_case_idx on sgn.verification_run (case_id, version);

-- 外部系統交付介面的端點（平台定義的介面，sim/dc/README.md）：方法與環境前綴之後的路徑。
create function sgn_internal.delivery_target(p_kind text, p_case_no text, out method text, out path text)
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
    if p_kind in ('apply', 'withdraw') and p_case_no is null then
        perform sgn_internal.raise_error('DELIVERY_CASE_NO_MISSING', p_kind);
    end if;
    method := case p_kind when 'apply' then 'PUT' when 'withdraw' then 'DELETE' else 'POST' end;
    path := case p_kind
        when 'purge' then '/maintenance/purge-expired'
        when 'verify' then '/test-queries'
        else '/rule-sets/' || p_case_no
    end;
end;
$$;

-- 建立一筆交付。撤回與驗證的本文帶冪等鍵；套用的本文是規則原樣。
create function sgn_internal.delivery_op_create(p_channel text, p_kind text, p_case_id uuid, p_version int, p_body jsonb)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_request uuid := gen_random_uuid();
    v_body text := case when p_kind in ('withdraw', 'verify')
        then (p_body || jsonb_build_object('request_id', v_request))::text
        else p_body::text
    end;
    v_hash bytea := sgn_internal.digest(convert_to(v_body, 'UTF8'), 'sha256');
    v_target record := sgn_internal.delivery_target(p_kind, (select c.case_no::text from sgn.request_case as c where c.id = p_case_id));
    v_id bigint;
begin
    insert into sgn.delivery_op (channel, kind, case_id, version, request_id, body, body_sha256, method, path, status, next_attempt_at, created_at)
    values (p_channel, p_kind, p_case_id, p_version, v_request, v_body, v_hash, v_target.method, v_target.path, 'queued',
        sgn_internal.now(), sgn_internal.now())
    returning id into v_id;
    perform sgn_internal.audit_append(
        'delivery.queued', p_case_id, null,
        jsonb_build_object(
            'op', v_id, 'channel', p_channel, 'kind', p_kind, 'version', p_version, 'request_id', v_request,
            'body_sha256', encode(v_hash, 'hex'), 'rules', jsonb_build_array('K-DELIVERY-AUTO', 'K-DELIVERY-SIGNED')
        )
    );
    return v_id;
end;
$$;

-- ── 卡住（持續送不到）：每筆開一次例外並通知升級對象。入口有排程、交付程式的領取與回報、以及寫入交付的交易 ──

create function sgn_internal.delivery_stuck_check()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_op sgn.delivery_op;
    v_seconds int;
    v_opened int := 0;
begin
    for v_op in
        select o.*
        from sgn.delivery_op as o
        where o.status in ('queued', 'sending')
          and o.stuck_exception_id is null
          and o.created_at < sgn_internal.now()
              - make_interval(secs => sgn_internal.delivery_setting_int('delivery.stuck_alert_seconds', o.channel))
        order by o.id
        for update skip locked
    loop
        v_seconds := sgn_internal.delivery_setting_int('delivery.stuck_alert_seconds', v_op.channel);
        update sgn.delivery_op
        set stuck_exception_id = sgn_internal.exception_open('K-DELIVERY-STUCK', v_op.case_id, jsonb_build_object(
            'op', v_op.id, 'channel', v_op.channel, 'kind', v_op.kind, 'attempts', v_op.attempts,
            'last_http_status', v_op.last_http_status, 'last_error', v_op.last_error, 'created_at', v_op.created_at,
            'settings', jsonb_build_object('delivery.stuck_alert_seconds', v_seconds)
        ))
        where id = v_op.id;
        perform sgn_internal.notify(
            'delivery.stuck', sgn_internal.delivery_escalation_people(), v_op.case_id,
            jsonb_build_object(
                'case_no', coalesce((select c.case_no::text from sgn.request_case as c where c.id = v_op.case_id), '-'),
                'kind', v_op.kind, 'channel', v_op.channel, 'attempts', v_op.attempts
            )
        );
        v_opened := v_opened + 1;
    end loop;
    return v_opened;
end;
$$;

-- 外部系統交付介面的信封（sgn_dc_request/1）：通道、環境、方法、路徑、期限與本文。被簽的就是這串文字。
create function sgn_internal.delivery_envelope(p_channel text, p_method text, p_path text, p_payload jsonb, p_until timestamptz)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'format', 'sgn_dc_request/1',
        'channel', p_channel,
        'environment', sgn_internal.setting('delivery.target_environment', array['channel:' || p_channel]) #>> '{}',
        'method', p_method,
        'path', p_path,
        'not_after', to_char(p_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'payload', p_payload
    )::text
$$;

-- 套用與撤回要送出的信封：通道、環境、方法、路徑、期限與本文一起簽（裁決 D81 (2)）。每次簽都進鏈（簽了什麼的摘要）。
create function sgn_internal.delivery_seal(p_op sgn.delivery_op, p_context text)
returns sgn.delivery_op
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_ttl int := sgn_internal.delivery_setting_int('delivery.signature_ttl_seconds', p_op.channel);
    v_until timestamptz := sgn_internal.now() + make_interval(secs => v_ttl);
    v_text text := sgn_internal.delivery_envelope(p_op.channel, p_op.method, p_op.path, p_op.body::jsonb, v_until);
    v_op sgn.delivery_op;
begin
    update sgn.delivery_op
    set sent_body = v_text, sent_sha256 = sgn_internal.digest(convert_to(v_text, 'UTF8'), 'sha256'),
        signature = sgn_internal.delivery_sign(p_context, v_text), signed_until = v_until
    where id = p_op.id
    returning * into v_op;
    perform sgn_internal.audit_append(
        'delivery.signed', v_op.case_id, null,
        jsonb_build_object('op', v_op.id, 'channel', v_op.channel, 'kind', v_op.kind, 'sent_sha256', encode(v_op.sent_sha256, 'hex'),
            'key_id', v_op.signature ->> 'key_id', 'not_after', v_until,
            'settings', jsonb_build_object('delivery.signature_ttl_seconds', v_ttl),
            'rules', jsonb_build_array('K-DELIVERY-SIGNED', 'K-DELIVERY-ATTESTED'))
    );
    return v_op;
end;
$$;

-- ── 領取：同一張單在同一通道一次只給最前面一筆；套用與撤回在第一次領取、以及簽章快過期時簽（之後重送用同一份）──

create function sgn_internal.delivery_claim(p_channel text, p_limit int)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_op sgn.delivery_op;
    v_token uuid;
    v_out jsonb := '[]'::jsonb;
    v_lease int := sgn_internal.delivery_setting_int('delivery.lease_seconds', p_channel);
    v_context text := sgn_internal.setting('delivery.signature_context', array['channel:' || p_channel]) #>> '{}';
begin
    perform sgn_internal.delivery_stuck_check();
    for v_op in
        select o.*
        from sgn.delivery_op as o
        where o.channel = p_channel
          and ((o.status = 'queued' and o.next_attempt_at <= sgn_internal.now())
               or (o.status = 'sending' and o.lease_until < sgn_internal.now()))
          and not exists (
              select 1 from sgn.delivery_op as e
              where e.channel = o.channel and e.case_id = o.case_id and e.id < o.id and e.status in ('queued', 'sending')
          )
        order by o.id
        limit greatest(p_limit, 1)
        for update skip locked
    loop
        if v_op.kind in ('apply', 'withdraw')
           and (v_op.signature is null or v_op.signed_until < sgn_internal.now() + make_interval(secs => v_lease)) then
            v_op := sgn_internal.delivery_seal(v_op, v_context);
        elsif v_op.sent_body is null then
            update sgn.delivery_op set sent_body = body, sent_sha256 = body_sha256 where id = v_op.id returning * into v_op;
        end if;
        v_token := gen_random_uuid();
        update sgn.delivery_op
        set status = sgn_internal.entity_transition('delivery_op', v_op.status, 'claim'),
            attempts = attempts + 1, lease_token = v_token, nonce = encode(sgn_internal.gen_random_bytes(18), 'hex'),
            lease_until = sgn_internal.now() + make_interval(secs => v_lease)
        where id = v_op.id
        returning * into v_op;
        v_out := v_out || jsonb_build_object(
            'op_id', v_op.id, 'lease_token', v_token, 'kind', v_op.kind, 'request_id', v_op.request_id,
            'case_no', (select c.case_no::text from sgn.request_case as c where c.id = v_op.case_id),
            'method', v_op.method, 'path', v_op.path, 'nonce', v_op.nonce,
            'body', v_op.sent_body, 'signature', v_op.signature - 'context'
        );
    end loop;
    return v_out;
end;
$$;

-- ── 回報的分類（資料庫判斷，不信交付程式的說法）：succeed、retry、reject ──
-- 交付程式交回 {http_status, response, error}：http_status 是 null 代表連不上。其餘一律以外部系統的證明為準：
-- 驗章、這筆的方法與路徑、送出的位元組的摘要、這次領取的一次性亂數都要相符；不符就當成沒有送到（retry），
-- 交付程式（或網路上的人）說的 HTTP 狀態與內容不採信。回傳 {class, http_status, result, error}。
-- p_expect：這一筆的 {method, path, request_sha256, nonce}（delivery_classify 從交付列取；合約測試直接給）。
create function sgn_internal.delivery_verdict(p_channel text, p_kind text, p_expect jsonb, p_outcome jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_att jsonb;
    v_http int;
    v_result jsonb;
    v_status text;
    v_expected text := case p_kind
        when 'apply' then 'applied' when 'withdraw' then 'withdrawn' when 'purge' then 'purged' else 'completed'
    end;
    v_class text;
begin
    if jsonb_typeof(p_outcome) is distinct from 'object'
       or jsonb_typeof(p_outcome -> 'http_status') not in ('number', 'null') then
        perform sgn_internal.raise_error('DELIVERY_REPORT_INVALID');
    end if;
    if p_outcome ->> 'http_status' is null then
        return jsonb_build_object('class', 'retry', 'http_status', null, 'result', null, 'error', left(p_outcome ->> 'error', 1000));
    end if;
    -- 摘要以外都相符才是「這一次」的回應；不是就當成沒送到（重放、別筆的回應、網路上的人編的）
    v_att := sgn_internal.attestation_open(p_channel, p_outcome -> 'response', p_expect - 'request_sha256');
    if not (v_att ->> 'ok')::boolean then
        return jsonb_build_object('class', 'retry', 'http_status', null, 'result', null,
            'error', 'RESPONSE_UNVERIFIED:' || (v_att ->> 'reason'), 'unverified', v_att);
    end if;
    v_http := (v_att #>> '{payload,http_status}')::int;
    v_result := v_att #> '{payload,result}';
    -- 外部系統收到的位元組和資料庫給的不同：送出途中被改過（交付程式或網路）。不論外部系統怎麼處理，一律當成被拒絕
    -- （套用不生效並撤回；撤回則重送並升級）
    if v_att #>> '{payload,request_sha256}' is distinct from p_expect ->> 'request_sha256' then
        return jsonb_build_object('class', 'reject', 'http_status', v_http, 'result', v_result,
            'error', 'REQUEST_ALTERED:' || coalesce(v_result ->> 'error', v_http::text), 'expired', false);
    end if;
    v_status := v_result ->> 'status';
    v_class := case
        when v_http >= 500 or v_http in (408, 429) then 'retry'
        when v_http between 200 and 299 and v_status = v_expected then 'succeed'
        -- 撤回時外部系統沒有這張單的規則（從沒套用成功）：目的已經達成（外部系統仍封存這張單）
        when p_kind = 'withdraw' and v_http = 404 then 'succeed'
        -- 信封過期（例如在佇列裡等太久）：下次領取時重新簽
        when v_http = 401 and v_result ->> 'code' = 'signature_expired' then 'retry'
        else 'reject'
    end;
    return jsonb_build_object('class', v_class, 'http_status', v_http, 'result', v_result, 'error', left(v_result ->> 'error', 1000),
        'expired', v_http = 401 and v_result ->> 'code' = 'signature_expired');
end;
$$;

create function sgn_internal.delivery_classify(p_op sgn.delivery_op, p_outcome jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.delivery_verdict(p_op.channel, p_op.kind, jsonb_build_object(
        'method', p_op.method, 'path', p_op.path, 'request_sha256', encode(p_op.sent_sha256, 'hex'), 'nonce', p_op.nonce), p_outcome)
$$;

create function sgn_internal.delivery_backoff_seconds(p_channel text, p_attempts int)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select least(
        sgn_internal.delivery_setting_int('delivery.retry_base_seconds', p_channel) * power(2, least(greatest(p_attempts - 1, 0), 20))::int,
        sgn_internal.delivery_setting_int('delivery.retry_max_seconds', p_channel)
    )
$$;

create function sgn_internal.delivery_report(p_op_id bigint, p_lease_token uuid, p_outcome jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_op sgn.delivery_op;
    v_verdict jsonb;
    v_class text;
    v_refused boolean;
    v_wait int;
begin
    select * into v_op from sgn.delivery_op where id = p_op_id for update;
    if v_op.id is null or v_op.status <> 'sending' or v_op.lease_token is distinct from p_lease_token then
        perform sgn_internal.raise_error('DELIVERY_LEASE', p_op_id::text);
    end if;
    v_verdict := sgn_internal.delivery_classify(v_op, p_outcome);
    v_class := v_verdict ->> 'class';
    -- 撤回被拒絕不是終態（權限可能還在外部系統上）：退避重送，第一次被拒時開例外並升級（K-DELIVERY-REJECTED）
    v_refused := v_class = 'reject' and v_op.kind = 'withdraw';
    if v_refused then
        v_class := 'retry';
    end if;
    v_wait := case v_class when 'retry' then sgn_internal.delivery_backoff_seconds(v_op.channel, v_op.attempts) end;
    update sgn.delivery_op
    set status = sgn_internal.entity_transition('delivery_op', v_op.status, v_class),
        lease_token = null, lease_until = null, nonce = null,
        last_http_status = (v_verdict ->> 'http_status')::int,
        last_error = v_verdict ->> 'error',
        result = v_verdict -> 'result',
        signature = case when (v_verdict ->> 'expired')::boolean then null else signature end,
        next_attempt_at = case v_class when 'retry' then sgn_internal.now() + make_interval(secs => v_wait) else next_attempt_at end,
        finished_at = case v_class when 'retry' then null else sgn_internal.now() end
    where id = v_op.id
    returning * into v_op;
    perform sgn_internal.audit_append(
        'delivery.' || v_class, v_op.case_id, null,
        jsonb_build_object(
            'op', v_op.id, 'channel', v_op.channel, 'kind', v_op.kind, 'attempts', v_op.attempts, 'request_id', v_op.request_id,
            'http_status', v_op.last_http_status, 'response', v_op.result, 'error', v_op.last_error,
            'unverified', v_verdict -> 'unverified', 'refused', v_refused,
            'settings', case v_class when 'retry' then jsonb_build_object(
                'delivery.retry_base_seconds', sgn_internal.delivery_setting_int('delivery.retry_base_seconds', v_op.channel),
                'delivery.retry_max_seconds', sgn_internal.delivery_setting_int('delivery.retry_max_seconds', v_op.channel),
                'wait_seconds', v_wait) end,
            'rules', jsonb_build_array(case when v_class = 'reject' or v_refused then 'K-DELIVERY-REJECTED' else 'K-DELIVERY-RETRY' end,
                'K-DELIVERY-ATTESTED')
        )
    );
    if v_refused and v_op.refused_exception_id is null then
        perform sgn_internal.delivery_withdraw_refused(v_op);
    end if;
    if v_class = 'succeed' then
        perform sgn_internal.delivery_after_success(v_op);
    elsif v_class = 'reject' then
        perform sgn_internal.delivery_after_reject(v_op);
    end if;
    perform sgn_internal.delivery_stuck_check();
    return jsonb_build_object('op_id', v_op.id, 'status', v_op.status, 'next_attempt_at', v_op.next_attempt_at);
end;
$$;

-- ── 驗證 ──

-- 一輪驗證：案例由流程包從「實際送出的規則」產生（同一份規則在同一天產生的案例相同），再排一筆驗證交付。
create function sgn_internal.verification_start(p_apply sgn.delivery_op)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_rule_set jsonb := p_apply.body::jsonb;
    v_cases jsonb := sgn_internal.hook_verification_cases(
        (select c.process_type from sgn.request_case as c where c.id = p_apply.case_id), p_apply.case_id, v_rule_set
    );
    v_run bigint;
    v_op bigint;
begin
    insert into sgn.verification_run (case_id, version, channel, apply_op_id, cases, status, created_at)
    values (p_apply.case_id, p_apply.version, p_apply.channel, p_apply.id, v_cases, 'pending', sgn_internal.now())
    returning id into v_run;
    v_op := sgn_internal.delivery_op_create(p_apply.channel, 'verify', p_apply.case_id, p_apply.version, jsonb_build_object(
        'run_id', v_run,
        'rule_set', v_rule_set,
        'cases', (select coalesce(jsonb_agg(jsonb_build_object('code', c ->> 'code', 'expected', c ->> 'expected', 'query', c -> 'query')), '[]')
                  from jsonb_array_elements(v_cases) as c)
    ));
    update sgn.verification_run set op_id = v_op where id = v_run;
    perform sgn_internal.audit_append(
        'verification.started', p_apply.case_id, null,
        jsonb_build_object('run', v_run, 'op', v_op, 'channel', p_apply.channel, 'version', p_apply.version,
            'cases', jsonb_array_length(v_cases), 'rules', jsonb_build_array('K-VERIFY-AUTO'))
    );
    return v_run;
end;
$$;

-- 核心比對預期與實際：每個案例恰好一筆、實際等於預期。外部系統多回、少回、重複都算不一致。沒有任何案例也不算通過。
create function sgn_internal.verification_mismatches(p_cases jsonb, p_results jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    with e as (
        select c ->> 'code' as code, c ->> 'expected' as expected
        from jsonb_array_elements(p_cases) as c
    ),
    a as (
        select r ->> 'code' as code, r ->> 'actual' as actual, count(*) over (partition by r ->> 'code') as n
        from jsonb_array_elements(case when jsonb_typeof(p_results) = 'array' then p_results else '[]' end) as r
    )
    select case when jsonb_array_length(p_cases) = 0 then '[{"code": null, "problem": "no_cases"}]'::jsonb else coalesce(
        jsonb_agg(jsonb_build_object('code', coalesce(e.code, a.code), 'expected', e.expected, 'actual', a.actual)),
        '[]'::jsonb
    ) end
    from e
    full join a on a.code = e.code
    where e.code is null or a.code is null or a.actual is distinct from e.expected or a.n > 1
$$;

create function sgn_internal.verification_finish(p_op sgn.delivery_op, p_response jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_run sgn.verification_run;
    v_mismatches jsonb;
begin
    select * into v_run from sgn.verification_run where op_id = p_op.id for update;
    if v_run.status <> 'pending' then
        return;
    end if;
    v_mismatches := sgn_internal.verification_mismatches(v_run.cases, p_response -> 'results');
    update sgn.verification_run
    set status = sgn_internal.entity_transition('verification_run', status, case when jsonb_array_length(v_mismatches) = 0 then 'pass' else 'fail' end),
        results = p_response -> 'results', mismatches = v_mismatches, finished_at = sgn_internal.now()
    where id = v_run.id;
    perform sgn_internal.audit_append(
        case when jsonb_array_length(v_mismatches) = 0 then 'verification.passed' else 'verification.failed' end, v_run.case_id, null,
        jsonb_build_object('run', v_run.id, 'channel', v_run.channel, 'version', v_run.version, 'mismatches', v_mismatches,
            'results', p_response -> 'results', 'rules', jsonb_build_array('K-VERIFY-AUTO'))
    );
    if jsonb_array_length(v_mismatches) > 0 then
        perform sgn_internal.fulfilment_fail(v_run.case_id, 'K-VERIFY-AUTO', jsonb_build_object(
            'run', v_run.id, 'channel', v_run.channel, 'version', v_run.version, 'mismatches', v_mismatches
        ));
        return;
    end if;
    perform sgn_internal.fulfilment_progress(v_run.case_id);
end;
$$;

-- ── 成功、拒絕之後 ──

create function sgn_internal.delivery_after_success(p_op sgn.delivery_op)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
begin
    if p_op.kind = 'verify' then
        perform sgn_internal.verification_finish(p_op, p_op.result);
        return;
    end if;
    if p_op.kind <> 'apply' then
        return;
    end if;
    select * into v_case from sgn.request_case where id = p_op.case_id;
    -- 撤銷、到期、失敗之後才送達的舊套用：不驗證、不生效，後面排著的撤回會把它收回
    if v_case.state in ('pending_fulfilment', 'verifying', 'active') and p_op.version = v_case.current_version then
        perform sgn_internal.verification_start(p_op);
    end if;
    perform sgn_internal.fulfilment_progress(p_op.case_id);
end;
$$;

create function sgn_internal.delivery_after_reject(p_op sgn.delivery_op)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_detail jsonb := jsonb_build_object(
        'op', p_op.id, 'channel', p_op.channel, 'kind', p_op.kind, 'http_status', p_op.last_http_status,
        'response', p_op.result, 'error', p_op.last_error
    );
begin
    perform sgn_internal.notify(
        'delivery.rejected', sgn_internal.delivery_escalation_people(), p_op.case_id,
        jsonb_build_object(
            'case_no', coalesce((select c.case_no::text from sgn.request_case as c where c.id = p_op.case_id), '-'),
            'kind', p_op.kind, 'channel', p_op.channel,
            'error', coalesce(p_op.result ->> 'error', p_op.last_error, p_op.last_http_status::text, '-')
        )
    );
    if p_op.kind in ('apply', 'verify') then
        update sgn.verification_run
        set status = sgn_internal.entity_transition('verification_run', status, 'cancel'), finished_at = sgn_internal.now()
        where op_id = p_op.id and status = 'pending';
        perform sgn_internal.fulfilment_fail(p_op.case_id, 'K-DELIVERY-REJECTED', v_detail);
    else
        -- 撤回或清除被拒絕：外部系統上的權限可能還在，不能靜默
        perform sgn_internal.exception_open('K-DELIVERY-REJECTED', p_op.case_id, v_detail);
    end if;
end;
$$;

-- 撤回被外部系統拒絕（第一次）：開例外、通知升級對象；之後照退避繼續重送，直到外部系統接受或有人處理。
create function sgn_internal.delivery_withdraw_refused(p_op sgn.delivery_op)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    update sgn.delivery_op
    set refused_exception_id = sgn_internal.exception_open('K-DELIVERY-REJECTED', p_op.case_id, jsonb_build_object(
        'op', p_op.id, 'channel', p_op.channel, 'kind', p_op.kind, 'http_status', p_op.last_http_status,
        'response', p_op.result, 'error', p_op.last_error, 'retrying', true))
    where id = p_op.id;
    perform sgn_internal.notify(
        'delivery.rejected', sgn_internal.delivery_escalation_people(), p_op.case_id,
        jsonb_build_object(
            'case_no', coalesce((select c.case_no::text from sgn.request_case as c where c.id = p_op.case_id), '-'),
            'kind', p_op.kind, 'channel', p_op.channel,
            'error', coalesce(p_op.result ->> 'error', p_op.last_error, p_op.last_http_status::text, '-')
        )
    );
end;
$$;

-- ── 撤回與清除的排程 ──

-- 一張單在各通道的撤回：曾經送出過套用（可能已在外部系統上）的通道排一筆撤回；
-- 還沒送出的套用與驗證直接作廢（撤銷不得被較舊的套用蓋掉，K-DELIVERY-ORDER）。回傳排了幾筆撤回。
create function sgn_internal.delivery_withdraw_case(p_case_id uuid)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_channel text;
    v_op bigint;
    v_count int := 0;
begin
    for v_channel in
        select distinct o.channel from sgn.delivery_op as o where o.case_id = p_case_id and o.kind = 'apply' order by 1
    loop
        v_op := null;
        if exists (select 1 from sgn.delivery_op as o where o.case_id = p_case_id and o.channel = v_channel and o.kind = 'apply' and o.attempts > 0)
           and not exists (select 1 from sgn.delivery_op as o where o.case_id = p_case_id and o.channel = v_channel and o.kind = 'withdraw' and o.status in ('queued', 'sending')) then
            v_op := sgn_internal.delivery_op_create(v_channel, 'withdraw', p_case_id,
                (select c.current_version from sgn.request_case as c where c.id = p_case_id),
                jsonb_build_object('case_no', (select c.case_no::text from sgn.request_case as c where c.id = p_case_id)));
            v_count := v_count + 1;
        end if;
        perform sgn_internal.delivery_supersede(p_case_id, v_channel, v_op);
    end loop;
    return v_count;
end;
$$;

create function sgn_internal.delivery_supersede(p_case_id uuid, p_channel text, p_by bigint)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_op sgn.delivery_op;
begin
    for v_op in
        select * from sgn.delivery_op as o
        where o.case_id = p_case_id and o.channel = p_channel and o.kind in ('apply', 'verify') and o.status = 'queued'
        order by o.id
        for update
    loop
        update sgn.delivery_op
        set status = sgn_internal.entity_transition('delivery_op', v_op.status, 'supersede'), superseded_by = p_by,
            finished_at = sgn_internal.now()
        where id = v_op.id;
        update sgn.verification_run
        set status = sgn_internal.entity_transition('verification_run', status, 'cancel'), finished_at = sgn_internal.now()
        where (op_id = v_op.id or apply_op_id = v_op.id) and status = 'pending';
        perform sgn_internal.audit_append(
            'delivery.superseded', p_case_id, null,
            jsonb_build_object('op', v_op.id, 'by', p_by, 'kind', v_op.kind, 'channel', p_channel, 'rules', jsonb_build_array('K-DELIVERY-ORDER'))
        );
    end loop;
end;
$$;

-- 到期的權限由外部系統依規則的有效迄日擋下；清除（把到期的權限從外部系統的目錄上拿掉）是通道層級的一筆。
create function sgn_internal.delivery_purge(p_channel text)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_existing bigint := (select o.id from sgn.delivery_op as o where o.channel = p_channel and o.kind = 'purge' and o.status in ('queued', 'sending') limit 1);
begin
    if v_existing is not null then
        return v_existing;
    end if;
    return sgn_internal.delivery_op_create(p_channel, 'purge', null, null, '{}'::jsonb);
end;
$$;

-- ── 執行關的進度（交付與人工兩條路的唯一判斷）──

-- 執行關的人工工作都做完、每一筆自動套用都成功 → 驗證中；每一筆套用的驗證都通過 → 執行關完成、往下（生效）。
create function sgn_internal.fulfilment_progress(p_case_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_stage_id bigint;
    v_applies int;
begin
    if v_case.state not in ('pending_fulfilment', 'verifying') then
        return;
    end if;
    select s.id into v_stage_id
    from sgn.case_stage as s
    join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
    where s.case_id = p_case_id and s.status = 'open' and ps.phase = 'fulfilment';
    if v_stage_id is null
       or exists (select 1 from sgn.case_task as t where t.stage_id = v_stage_id and t.status not in ('approved', 'completed')) then
        return;
    end if;
    select count(*) into v_applies
    from sgn.delivery_op as o
    where o.case_id = p_case_id and o.version = v_case.current_version and o.kind = 'apply' and o.status <> 'superseded';
    if v_applies > 0 then
        if exists (select 1 from sgn.delivery_op as o where o.case_id = p_case_id and o.version = v_case.current_version
                   and o.kind = 'apply' and o.status in ('queued', 'sending', 'rejected')) then
            return;
        end if;
        if v_case.state = 'pending_fulfilment' then
            perform sgn_internal.case_transition(p_case_id, 'delivery_applied');
            perform sgn_internal.audit_append('case.delivery_applied', p_case_id, null,
                jsonb_build_object('version', v_case.current_version, 'rules', jsonb_build_array('K-DELIVERY-AUTO')));
        end if;
        if (select count(*) from sgn.verification_run as r
            where r.case_id = p_case_id and r.version = v_case.current_version and r.status = 'passed') < v_applies then
            return;
        end if;
    end if;
    update sgn.case_stage set status = 'done', closed_at = sgn_internal.now() where id = v_stage_id;
    perform sgn_internal.case_advance(p_case_id);
end;
$$;

-- 交付或驗證失敗：不得生效。還在執行中的單轉為 fulfilment_failed、收掉執行關；已生效的單（生效後縮小的驗證）由系統撤銷。
-- 兩者都把已經送出的規則撤回（一律從嚴），開例外並通知申請人與升級對象。
create function sgn_internal.fulfilment_fail(p_case_id uuid, p_rule_code text, p_detail jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
begin
    perform sgn_internal.exception_open(p_rule_code, p_case_id, p_detail);
    if v_case.state in ('pending_fulfilment', 'verifying') then
        perform sgn_internal.case_transition(p_case_id, 'fail_fulfilment');
        perform sgn_internal.stages_close_open(p_case_id, 'cancelled', 'fulfilment_failed');
        perform sgn_internal.audit_append('case.fulfilment_failed', p_case_id, null,
            jsonb_build_object('version', v_case.current_version, 'detail', p_detail, 'rules', jsonb_build_array(p_rule_code, 'K-DELIVERY-AUTO')));
        perform sgn_internal.delivery_withdraw_case(p_case_id);
    elsif v_case.state = 'active' then
        perform sgn_internal.grant_end(v_case, 'revoked', null, 'verification_failed', p_rule_code);
    end if;
    perform sgn_internal.notify(
        'verification.failed', array_append(sgn_internal.delivery_escalation_people(), v_case.applicant_person_id), p_case_id,
        jsonb_build_object('case_no', v_case.case_no::text, 'channel', coalesce(p_detail ->> 'channel', '-'))
    );
end;
$$;

-- ── 流程包 hook：交給某一組受管系統的內容、驗證案例 ──

insert into sgn.hook_definition (hook, arg_types, result_type, returns_set, description) values
    ('build_delivery', 'uuid, text[]', 'jsonb', false,
        '產生交給某一組受管系統（scope_ref）的執行內容：只含這些系統的部分；沒有可交付的內容回 null。沒有登記：build_fulfilment 的整份'),
    ('build_verification_cases', 'uuid, jsonb', 'jsonb', false,
        '依送出的執行內容產生自動驗證的案例 [{code, description, expected, query}]（範圍內應允許、範圍外應拒絕）。沒有登記：沒有案例（驗證不會通過）');

create function sgn_internal.hook_build_delivery(p_process_type text, p_case_id uuid, p_scopes text[])
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'build_delivery');
    v_result jsonb;
begin
    if v_fn is null then
        return sgn_internal.hook_fulfilment(p_process_type, p_case_id);
    end if;
    execute format('select %s($1, $2)', v_fn::regprocedure::regproc) into v_result using p_case_id, p_scopes;
    return v_result;
end;
$$;

create function sgn_internal.hook_verification_cases(p_process_type text, p_case_id uuid, p_rule_set jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'build_verification_cases');
    v_result jsonb;
begin
    if v_fn is null then
        return '[]'::jsonb;
    end if;
    execute format('select %s($1, $2)', v_fn::regprocedure::regproc) into v_result using p_case_id, p_rule_set;
    return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- 一張單目前版本在執行關涉及的受管系統範圍。
create function sgn_internal.case_fulfilment_scopes(p_case sgn.request_case, p_stage_code text)
returns text[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.hook_stage_scopes(
        p_case.process_type, p_stage_code,
        (select v.content from sgn.case_version as v where v.case_id = p_case.id and v.version = p_case.current_version)
    )
$$;

-- 執行關開始時：系統對系統的受管系統依通道各排一筆套用。回傳排了幾筆。
create function sgn_internal.delivery_enqueue_case(p_case sgn.request_case, p_stage_code text)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_channel text;
    v_scopes text[];
    v_body jsonb;
    v_count int := 0;
begin
    for v_channel, v_scopes in
        select sgn_internal.setting('delivery.channel', array[s]) #>> '{}', array_agg(s order by s)
        from unnest(sgn_internal.case_fulfilment_scopes(p_case, p_stage_code)) as s
        where sgn_internal.delivery_automated(s)
        group by 1
        order by 1
    loop
        if v_channel = '' then
            perform sgn_internal.raise_error('DELIVERY_CHANNEL_MISSING', array_to_string(v_scopes, ','));
        end if;
        v_body := sgn_internal.hook_build_delivery(p_case.process_type, p_case.id, v_scopes);
        if v_body is not null then
            perform sgn_internal.delivery_op_create(v_channel, 'apply', p_case.id, p_case.current_version, v_body);
            v_count := v_count + 1;
        end if;
    end loop;
    return v_count;
end;
$$;
