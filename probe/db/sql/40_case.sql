-- 申請單：內容（jsonb）帶版本與內容雜湊；狀態由轉移表驅動（PRB-STATE）。

create table sgn.state_transition (
    from_state text not null,
    action text not null,
    to_state text not null,
    primary key (from_state, action)
);

insert into sgn.state_transition (from_state, action, to_state) values
    ('draft', 'revise', 'draft'),
    ('draft', 'submit', 'submitted'),
    ('submitted', 'approve', 'approved'),
    ('submitted', 'return', 'draft');

create table sgn.request_case (
    id uuid primary key default gen_random_uuid(),
    case_no bigint generated always as identity unique,
    applicant_person_id uuid not null references sgn.person (id),
    state text not null,
    current_version int not null,
    approver_person_id uuid references sgn.person (id),
    created_at timestamptz not null
);

create table sgn.case_version (
    case_id uuid not null references sgn.request_case (id),
    version int not null,
    content jsonb not null,
    content_sha256 bytea not null,
    created_at timestamptz not null,
    primary key (case_id, version)
);

-- 內容雜湊。探針用 jsonb 的文字輸出（PostgreSQL 內是確定的）；正式版改 RFC 8785。
create function sgn_internal.content_hash(p_content jsonb)
returns bytea
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select sha256(convert_to(p_content::text, 'UTF8'))
$$;

-- 狀態轉移的唯一入口：查轉移表、更新狀態，回傳新狀態。
create function sgn_internal.case_transition(p_case_id uuid, p_action text)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_to text;
begin
    select t.to_state into v_to
    from sgn.request_case c
    join sgn.state_transition t on t.from_state = c.state and t.action = p_action
    where c.id = p_case_id;
    if v_to is null then
        perform sgn_internal.raise_error('STATE_TRANSITION', p_action);
    end if;
    update sgn.request_case set state = v_to where id = p_case_id;
    return v_to;
end;
$$;

-- 鎖住並取出申請單；不存在就丟錯。
create function sgn_internal.case_lock(p_case_id uuid)
returns sgn.request_case
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
begin
    select * into v_case from sgn.request_case where id = p_case_id for update;
    if v_case.id is null then
        perform sgn_internal.raise_error('CASE_UNKNOWN');
    end if;
    return v_case;
end;
$$;

create function sgn_internal.case_add_version(p_case_id uuid, p_version int, p_content jsonb)
returns bytea
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_hash bytea := sgn_internal.content_hash(p_content);
begin
    insert into sgn.case_version (case_id, version, content, content_sha256, created_at)
    values (p_case_id, p_version, p_content, v_hash, clock_timestamp());
    update sgn.request_case set current_version = p_version where id = p_case_id;
    return v_hash;
end;
$$;

create function api.case_create(p_session text, p_content jsonb, out case_id uuid, out case_no bigint)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_hash bytea;
begin
    insert into sgn.request_case (applicant_person_id, state, current_version, created_at)
    values (v_person_id, 'draft', 0, clock_timestamp())
    returning id, request_case.case_no into case_id, case_no;
    v_hash := sgn_internal.case_add_version(case_id, 1, p_content);
    perform sgn_internal.audit_append(
        'case.created', case_id, v_person_id,
        jsonb_build_object('version', 1, 'content_sha256', encode(v_hash, 'hex'))
    );
end;
$$;

comment on function api.case_create(text, jsonb) is
    '建立申請單草稿（版本 1）。呼叫者：sgn_probe_app，代表已登入的申請人。規則：PRB-APPLICANT、PRB-CHAIN';

create function api.case_revise(p_session text, p_case_id uuid, p_content jsonb)
returns int
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_hash bytea;
begin
    if v_case.applicant_person_id <> v_person_id then
        perform sgn_internal.raise_error('NOT_APPLICANT');
    end if;
    perform sgn_internal.case_transition(p_case_id, 'revise');
    v_hash := sgn_internal.case_add_version(p_case_id, v_case.current_version + 1, p_content);
    perform sgn_internal.audit_append(
        'case.revised', p_case_id, v_person_id,
        jsonb_build_object('version', v_case.current_version + 1, 'content_sha256', encode(v_hash, 'hex'))
    );
    return v_case.current_version + 1;
end;
$$;

comment on function api.case_revise(text, uuid, jsonb) is
    '修改草稿內容，產生新版本。只有申請人、只在草稿狀態。呼叫者：sgn_probe_app。規則：PRB-APPLICANT、PRB-STATE、PRB-CHAIN';

create function api.case_submit(p_session text, p_case_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_approver uuid;
begin
    if v_case.applicant_person_id <> v_person_id then
        perform sgn_internal.raise_error('NOT_APPLICANT');
    end if;
    v_approver := sgn_internal.resolve_manager(v_person_id);
    if v_approver is null then
        perform sgn_internal.raise_error('NO_APPROVER');
    end if;
    perform sgn_internal.case_transition(p_case_id, 'submit');
    update sgn.request_case set approver_person_id = v_approver where id = p_case_id;
    perform sgn_internal.audit_append(
        'case.submitted', p_case_id, v_person_id,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', (
                select encode(content_sha256, 'hex') from sgn.case_version
                where case_id = p_case_id and version = v_case.current_version
            ),
            'approver', v_approver
        )
    );
    return v_approver;
end;
$$;

comment on function api.case_submit(text, uuid) is
    '送審：解析申請人目前的主管為簽核人。呼叫者：sgn_probe_app。規則：PRB-APPLICANT、PRB-STATE、PRB-APPROVER、PRB-CHAIN';

create function api.case_get(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_result jsonb;
begin
    select jsonb_build_object(
        'case_id', c.id,
        'case_no', c.case_no,
        'state', c.state,
        'version', c.current_version,
        'content', v.content,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'applicant', c.applicant_person_id,
        'approver', c.approver_person_id
    ) into v_result
    from sgn.request_case c
    join sgn.case_version v on v.case_id = c.id and v.version = c.current_version
    where c.id = p_case_id
      and v_person_id in (c.applicant_person_id, c.approver_person_id);
    if v_result is null then
        perform sgn_internal.raise_error('CASE_UNKNOWN');
    end if;
    return v_result;
end;
$$;

comment on function api.case_get(text, uuid) is
    '讀取申請單目前版本。只有申請人與簽核人看得到。呼叫者：sgn_probe_app。';
