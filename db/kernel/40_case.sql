-- 申請單：內容（jsonb）帶版本與內容雜湊；狀態由轉移表驅動（PRB-STATE）；
-- 誰能對一張單做什麼只由 sgn_internal.denial_reason 決定（授權檢查的唯一入口，工程規範第 2 節）。

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

-- 動作目錄：每個動作由誰做、要不要決定證明、是不是改狀態。授權規則是這張表加上 denial_reason，不散落在各 function。
--   actor_rule  applicant＝只有申請人；approver＝只有送審時解析出的簽核人，且不是申請人；
--               case_party＝申請人或簽核人；role＝持有 role_setting 指定的角色
--   scope       case＝對一張單的動作；global＝不針對單
create table sgn.action (
    action text primary key,
    scope text not null check (scope in ('case', 'global')),
    actor_rule text not null check (actor_rule in ('applicant', 'approver', 'case_party', 'role')),
    role_setting text,
    denied_code text references sgn.error_catalog (code),
    needs_proof boolean not null,
    changes_state boolean not null,
    check ((actor_rule = 'role') = (role_setting is not null and denied_code is not null))
);

insert into sgn.action (action, scope, actor_rule, role_setting, denied_code, needs_proof, changes_state) values
    ('revise', 'case', 'applicant', null, null, false, true),
    ('submit', 'case', 'applicant', null, null, false, true),
    ('approve', 'case', 'approver', null, null, true, true),
    ('return', 'case', 'approver', null, null, true, true),
    ('read', 'case', 'case_party', null, null, false, false),
    ('audit.read', 'global', 'role', 'audit.auditor_role', 'AUDITOR_REQUIRED', false, false);

create table sgn.request_case (
    id uuid primary key default gen_random_uuid(),
    case_no bigint generated always as identity unique,
    applicant_person_id uuid not null references sgn.person (id),
    state text not null,
    current_version int not null,
    approver_person_id uuid references sgn.person (id),
    -- 簽核人的依據：送審時 resolver 用的那條主管關係（PRB-SYNC-GUARD）
    approver_line_id bigint references sgn.reporting_line (id),
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

-- 例外：控制沒有如預期運作、需要有人看的事（骨幹術語 exception）。目前只有開立，結案流程還沒做。
create table sgn.exception_record (
    id bigint generated always as identity primary key,
    rule_code text not null references sgn.rule (code),
    case_id uuid references sgn.request_case (id),
    detail jsonb not null,
    opened_at timestamptz not null,
    event_seq bigint not null
);

create index exception_record_case_idx on sgn.exception_record (case_id);

-- 開例外的唯一入口：寫一筆、同時進雜湊鏈。
create function sgn_internal.exception_open(p_rule_code text, p_case_id uuid, p_detail jsonb)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_seq bigint := sgn_internal.audit_append(
        'exception.opened',
        p_case_id,
        null,
        jsonb_build_object('rule_code', p_rule_code, 'detail', p_detail)
    );
    v_id bigint;
begin
    insert into sgn.exception_record (rule_code, case_id, detail, opened_at, event_seq)
    values (p_rule_code, p_case_id, p_detail, sgn_internal.now(), v_seq)
    returning id into v_id;
    return v_id;
end;
$$;

-- 內容雜湊：RFC 8785 標準化 JSON 的 SHA-256（PRB-CONTENT-HASH）。
create function sgn_internal.content_hash(p_content jsonb)
returns bytea
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.jcs_sha256(p_content)
$$;

-- 轉移表查詢：這個狀態做這個動作會到哪個狀態；不允許時回 null。
create function sgn_internal.next_state(p_state text, p_action text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select t.to_state from sgn.state_transition t where t.from_state = p_state and t.action = p_action
$$;

-- 授權檢查的唯一入口。回傳拒絕的錯誤代碼；可以做時回 null。
-- 每個動作 function 都透過 sgn_internal.authorize 呼叫它；畫面的可執行動作清單（case_actions）、
-- 畫面可以顯示的功能（api.me）也由它算出，所以「能不能做」和「畫面顯示什麼」不會走樣。
-- 規則：PRB-APPLICANT、PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-AUDIT-READ
create function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_case sgn.request_case)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when a.action is null then 'ACTION_UNKNOWN'
        when a.scope = 'case' and p_case.id is null then 'CASE_UNKNOWN'
        when a.actor_rule = 'role'
             and not sgn_internal.has_role(p_person_id, sgn_internal.setting_text(a.role_setting)) then a.denied_code
        when a.actor_rule = 'case_party'
             and p_person_id is distinct from p_case.applicant_person_id
             and p_person_id is distinct from p_case.approver_person_id then 'CASE_UNKNOWN'
        when a.actor_rule = 'applicant' and p_person_id is distinct from p_case.applicant_person_id then 'NOT_APPLICANT'
        when a.actor_rule = 'approver' and p_person_id = p_case.applicant_person_id then 'SELF_APPROVAL'
        when a.actor_rule = 'approver' and p_person_id is distinct from p_case.approver_person_id then 'NOT_APPROVER'
        when a.changes_state and sgn_internal.next_state(p_case.state, a.action) is null then 'STATE_TRANSITION'
    end
    from (select 1) as one
    left join sgn.action a on a.action = p_action
$$;

-- 不允許就丟錯。動作 function 一律呼叫這個，不自己判斷。
create function sgn_internal.authorize(p_person_id uuid, p_action text, p_case sgn.request_case default null)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_denial text := sgn_internal.denial_reason(p_person_id, p_action, p_case);
begin
    if v_denial is not null then
        perform sgn_internal.raise_error(v_denial, p_action);
    end if;
end;
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
    select sgn_internal.next_state(c.state, p_action) into v_to
    from sgn.request_case c
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
    values (p_case_id, p_version, p_content, v_hash, sgn_internal.now());
    update sgn.request_case set current_version = p_version where id = p_case_id;
    return v_hash;
end;
$$;

-- 建立草稿（版本 1）。任何登入的人都可以替自己建立申請單。
create function sgn_internal.case_new(p_person_id uuid, p_content jsonb)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case_id uuid;
    v_hash bytea;
begin
    insert into sgn.request_case (applicant_person_id, state, current_version, created_at)
    values (p_person_id, 'draft', 0, sgn_internal.now())
    returning id into v_case_id;
    v_hash := sgn_internal.case_add_version(v_case_id, 1, p_content);
    perform sgn_internal.audit_append(
        'case.created', v_case_id, p_person_id,
        jsonb_build_object('version', 1, 'content_sha256', encode(v_hash, 'hex'))
    );
    return v_case_id;
end;
$$;

-- 送審：解析申請人目前的主管為簽核人，並記下依據的那條主管關係。
-- 那條關係是基準之後由同步異動而來時，開 PRB-SYNC-GUARD 例外：同步帳號能決定誰是主管，這一點要讓人看得到。
create function sgn_internal.case_submit_draft(p_person_id uuid, p_case_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_line sgn.reporting_line;
begin
    perform sgn_internal.authorize(p_person_id, 'submit', v_case);
    v_line := sgn_internal.resolve_manager(v_case.applicant_person_id);
    if v_line.id is null then
        perform sgn_internal.raise_error('NO_APPROVER');
    end if;
    perform sgn_internal.case_transition(p_case_id, 'submit');
    update sgn.request_case
    set approver_person_id = v_line.manager_person_id,
        approver_line_id = v_line.id
    where id = p_case_id;
    perform sgn_internal.audit_append(
        'case.submitted', p_case_id, p_person_id,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', (
                select encode(v.content_sha256, 'hex') from sgn.case_version v
                where v.case_id = p_case_id and v.version = v_case.current_version
            ),
            'approver', v_line.manager_person_id,
            'approver_basis', jsonb_build_object(
                'reporting_line_id', v_line.id,
                'origin', v_line.origin,
                'change_event_seq', v_line.change_event_seq
            )
        )
    );
    if v_line.origin = 'sync_change' then
        perform sgn_internal.exception_open(
            'PRB-SYNC-GUARD',
            p_case_id,
            jsonb_build_object(
                'approver', v_line.manager_person_id,
                'reporting_line_id', v_line.id,
                'change_event_seq', v_line.change_event_seq,
                'line_valid_from', v_line.valid_from
            )
        );
    end if;
end;
$$;

-- ── 給畫面的單張摘要（所有回傳申請單的 api function 共用這個結構）──

-- 某個人在某張單目前可以做的動作：轉移表裡的動作，經授權入口判定可以的才列出。
create function sgn_internal.case_actions(p_case sgn.request_case, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(a.action order by a.action), '[]'::jsonb)
    from sgn.action a
    where a.scope = 'case'
      and a.changes_state
      and sgn_internal.denial_reason(p_person_id, a.action, p_case) is null
$$;

create function sgn_internal.case_exceptions(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        jsonb_agg(
            jsonb_build_object('id', x.id, 'rule_code', x.rule_code, 'opened_at', x.opened_at, 'event_seq', x.event_seq)
            order by x.id
        ),
        '[]'::jsonb
    )
    from sgn.exception_record x
    where x.case_id = p_case_id
$$;

-- 結構固定（packages/contract 的 CaseSummary；db/tests/kernel/90-contract.test.mjs 檢查）。
create function sgn_internal.case_summary(p_case_id uuid, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'case_id', c.id,
        'case_no', c.case_no,
        'state', c.state,
        'version', v.version,
        'content', v.content,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'updated_at', v.created_at,
        'applicant_name', a.display_name,
        'approver_name', m.display_name,
        'actions', sgn_internal.case_actions(c, p_person_id),
        'exceptions', sgn_internal.case_exceptions(c.id)
    )
    from sgn.request_case c
    join sgn.case_version v on v.case_id = c.id and v.version = c.current_version
    join sgn.person a on a.id = c.applicant_person_id
    left join sgn.person m on m.id = c.approver_person_id
    where c.id = p_case_id
$$;

-- ── 對外：每個使用者動作一個 function，回傳單張摘要 ──

create function api.case_create(p_session text, p_content jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case_id uuid := sgn_internal.case_new(v_person_id, p_content);
begin
    -- 摘要要在另一個陳述式讀：STABLE function 看到的是呼叫它的陳述式開始時的快照。
    return sgn_internal.case_summary(v_case_id, v_person_id);
end;
$$;

comment on function api.case_create(text, jsonb) is
    '使用者動作「儲存草稿」：建立申請單草稿（版本 1）。回傳單張摘要。呼叫者：sgn_app，代表已登入的申請人。規則：PRB-APPLICANT、PRB-CHAIN';

create function api.case_submit_new(p_session text, p_content jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case_id uuid := sgn_internal.case_new(v_person_id, p_content);
begin
    perform sgn_internal.case_submit_draft(v_person_id, v_case_id);
    return sgn_internal.case_summary(v_case_id, v_person_id);
end;
$$;

comment on function api.case_submit_new(text, jsonb) is
    '使用者動作「送出申請」：建立並送審，同一個交易（送審失敗時不留下草稿）。回傳單張摘要。'
    '呼叫者：sgn_app。規則：PRB-APPLICANT、PRB-APPROVER、PRB-SYNC-GUARD、PRB-CHAIN';

create function api.case_revise(p_session text, p_case_id uuid, p_content jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_hash bytea;
begin
    perform sgn_internal.authorize(v_person_id, 'revise', v_case);
    perform sgn_internal.case_transition(p_case_id, 'revise');
    v_hash := sgn_internal.case_add_version(p_case_id, v_case.current_version + 1, p_content);
    perform sgn_internal.audit_append(
        'case.revised', p_case_id, v_person_id,
        jsonb_build_object('version', v_case.current_version + 1, 'content_sha256', encode(v_hash, 'hex'))
    );
    return sgn_internal.case_summary(p_case_id, v_person_id);
end;
$$;

comment on function api.case_revise(text, uuid, jsonb) is
    '使用者動作「修改草稿」：產生新版本。只有申請人、只在草稿狀態。回傳單張摘要。呼叫者：sgn_app。規則：PRB-APPLICANT、PRB-STATE、PRB-CHAIN';

create function api.case_submit(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    perform sgn_internal.case_submit_draft(v_person_id, p_case_id);
    return sgn_internal.case_summary(p_case_id, v_person_id);
end;
$$;

comment on function api.case_submit(text, uuid) is
    '使用者動作「送審草稿」：解析申請人目前的主管為簽核人。回傳單張摘要。'
    '呼叫者：sgn_app。規則：PRB-APPLICANT、PRB-STATE、PRB-APPROVER、PRB-SYNC-GUARD、PRB-CHAIN';

create function api.case_get(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case;
begin
    select * into v_case from sgn.request_case where id = p_case_id;
    perform sgn_internal.authorize(v_person_id, 'read', v_case);
    return sgn_internal.case_summary(p_case_id, v_person_id);
end;
$$;

comment on function api.case_get(text, uuid) is
    '讀取申請單目前版本的摘要。只有申請人與簽核人看得到，其他人一律 CASE_UNKNOWN。呼叫者：sgn_app。規則：PRB-APPLICANT、PRB-APPROVER';
