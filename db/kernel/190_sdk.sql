-- 給流程包的穩定介面 sgn_sdk（骨幹 1.1、6.1）：流程包只能透過這裡接觸核心——讀參數、取訊息、丟錯、
-- 讀申請單與有效授權、找人、登記。架構測試檢查流程包的程式碼不直接引用 sgn 與 sgn_internal。
-- 沒有任何連線角色對這個 schema 有權限；流程包的 hook 由核心以擁有者身分呼叫。

create schema sgn_sdk;

create function sgn_sdk.setting(p_key text, p_scopes text[] default '{}')
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.setting(p_key, p_scopes)
$$;

create function sgn_sdk.message(p_code text, variadic p_args text[] default '{}')
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.message_text(p_code, p_args)
$$;

create function sgn_sdk.raise_error(p_code text, p_detail text default null)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.raise_error(p_code, p_detail);
end;
$$;

-- 流程包的對外 function（api.<流程包>_*）取得行為人：只能從 session 得出（K-ACTOR-PROVEN）。
create function sgn_sdk.session_person(p_session text)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.session_person(p_session)
$$;

create function sgn_sdk.today()
returns date
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.today()
$$;

-- 一張單與它目前的版本。terms 的日期轉成 date；找不到回 null。
create function sgn_sdk.case_context(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'case_id', c.id,
        'case_no', c.case_no,
        'process_type', c.process_type,
        'state', c.state,
        'tier', v.tier,
        'applicant_id', c.applicant_person_id,
        'principal', sgn_internal.case_terms_view(v.terms) -> 'principal',
        'valid_from', sgn_internal.try_date(v.terms ->> 'valid_from'),
        'valid_to', sgn_internal.try_date(v.terms ->> 'valid_to'),
        'version', v.version,
        'content', v.content
    )
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    where c.id = p_case_id
$$;

-- 某個被授權者在某個流程類型的有效授權，以及各自核准並執行的那一版內容（有效性以時間計算：迄日還沒過）。
create function sgn_sdk.active_grants(p_process_type text, p_principal_id uuid)
returns table (grant_id uuid, case_id uuid, case_no bigint, valid_from date, valid_to date, content jsonb)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select g.id, g.case_id, c.case_no, g.valid_from, g.valid_to, v.content
    from sgn.grant_record as g
    join sgn.request_case as c on c.id = g.case_id
    join sgn.case_version as v on v.case_id = g.case_id and v.version = g.version
    where g.process_type = p_process_type
      and g.principal_id = p_principal_id
      and g.status = 'active'
      and (g.valid_to is null or g.valid_to >= sgn_internal.today())
$$;

create function sgn_sdk.role_holders(p_role text, p_scope_ref text default null)
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.role_holders(p_role, p_scope_ref)
$$;

create function sgn_sdk.person_by_identity(p_source text, p_external_id text)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.person_by_identity(p_source, p_external_id)
$$;

-- ── 登記入口（可重複執行）──

create function sgn_sdk.register_rule(p_code text, p_description text, p_pack text, p_coverage text, p_note text)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_rule(p_code, p_description, p_pack, p_coverage, p_note)
$$;

create function sgn_sdk.register_message(p_code text, p_kind text, p_message text, p_http_status int default null)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.message_register(p_code, p_kind, p_message, p_http_status)
$$;

create function sgn_sdk.register_setting_definition(
    p_key text,
    p_value_type text,
    p_default jsonb,
    p_scope_kinds text[],
    p_description text,
    p_pack text
)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_setting_definition(p_key, p_value_type, p_default, p_scope_kinds, p_description, p_pack)
$$;

create function sgn_sdk.register_setting_value(p_key text, p_scope_ref text, p_value jsonb, p_reason text)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_setting_value(p_key, p_scope_ref, p_value, p_reason)
$$;

create function sgn_sdk.register_process_type(p_def jsonb)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_process_type(p_def)
$$;

create function sgn_sdk.register_approval_policy(p_process_type text, p_def jsonb)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_approval_policy(p_process_type, p_def)
$$;

create function sgn_sdk.sync_scoped_role_assignments(p_source text, p_role text, p_assignments jsonb)
returns jsonb
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.sync_scoped_role_assignments(p_source, p_role, p_assignments)
$$;

revoke all on all functions in schema sgn_sdk from public;
