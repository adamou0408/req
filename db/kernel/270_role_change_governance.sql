-- 角色指派變更的治理（裁決 D69；紅隊第二輪 高-4、高-2 情境 2）。
--
-- 根因：治理角色可以自我繁殖（控制負責人核准控制負責人）；授權只比對提出人與被指派人；範圍不驗證、不比對；
-- 可以撤掉某個角色的最後一位持有人；提出不需要任何證明。兩人串通（或一個被入侵的後端）就能接管稽核治理。
--
-- 這一版（規則都是資料，程式只認類別、旗標與對照表，不認角色名稱）：
--   1. 提出與核准都要通行金鑰（D68 的同一套挑戰值；用途 role_change.propose、role_change.decision）。
--   2. 核准人不得持有被變更的那個角色（不得自我繁殖）；登記時核准人角色也不得是角色本身（檢查條件）。
--   3. 每個角色的「經手人不得持有的角色」改成對照表 sgn.role_change_excluded（可以多個）。
--      稽核治理人的指派與撤除由稽核線提出、董事長核准，經手人不得持有流程管理、控制負責人、技術維運。
--   4. 職責衝突矩陣 sgn.role_conflict（骨幹 18.2，K-ADMIN-SOD）在提出與核准時檢查。
--   5. 範圍必須是登記過的（sgn.scope_registry，或已登記流程類型的 process:<代碼>）；
--      提出人與核准人自己的角色範圍必須涵蓋被指派的範圍（全域涵蓋全部）。
--   6. 業務類角色（由同步帶入）不能在平台內指派（K-ROLE-SOURCE）。
--   7. 標為必要的角色（sgn.role.required）不得撤除最後一位持有人。
--   8. 標為要冷卻的角色（sgn.role.change_cooling，治理類）核准後有冷卻期，通知全部治理類角色的持有人，期間內任一人可擋下。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('role_change.governance_cooling_workdays', 'integer', '1', '{}',
        '治理類角色的指派變更核准後，幾個營業日後才生效；期間內任何一位治理類角色的持有人可以擋下');

insert into sgn.error_catalog (code, message, http_status) values
    ('ROLE_CHANGE_SAME_ROLE', '持有這個角色的人不能核准這個角色的指派變更', 403),
    ('ROLE_CHANGE_SOURCE', '這個角色由人員目錄同步帶入，不能在平台內指派', 422),
    ('ROLE_CHANGE_SCOPE_UNKNOWN', '這個範圍沒有登記', 422),
    ('ROLE_CHANGE_SCOPE_NOT_COVERED', '你的角色範圍沒有涵蓋這個範圍', 403),
    ('ROLE_CHANGE_NOT_GOVERNOR', '只有治理類角色的持有人可以擋下冷卻期內的變更', 403),
    ('ROLE_CONFLICT', '這個人已經持有不能同時持有的角色（職責衝突）', 409),
    ('ROLE_LAST_HOLDER', '不能撤除這個必要角色的最後一位持有人', 409);

-- ── 規則的資料 ──

alter table sgn.role
    add column required boolean not null default false,
    add column change_cooling boolean not null default false;

create table sgn.role_change_excluded (
    role_code text not null references sgn.role (code),
    excluded_role text not null references sgn.role (code),
    primary key (role_code, excluded_role)
);

comment on table sgn.role_change_excluded is '某個角色的指派變更，提出人與核准人都不得持有的角色（例如稽核角色不得經技術維運之手）。';

insert into sgn.role_change_excluded (role_code, excluded_role)
select r.code, r.change_excluded_role from sgn.role as r where r.change_excluded_role is not null;

-- 衝突矩陣（骨幹 18.2）：同一個人不得同時持有。same_scope：只有範圍相同（或其中一方是全域）時才衝突。
create table sgn.role_conflict (
    role_a text not null references sgn.role (code),
    role_b text not null references sgn.role (code),
    same_scope boolean not null,
    primary key (role_a, role_b),
    check (role_a < role_b)
);

comment on table sgn.role_conflict is '職責衝突矩陣（K-ADMIN-SOD）：一列代表兩個角色不得由同一人同時持有；兩個代碼依字母序存一次。';

create function sgn_internal.register_role_conflict(p_role text, p_other text, p_same_scope boolean)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    insert into sgn.role_conflict (role_a, role_b, same_scope)
    values (least(p_role, p_other), greatest(p_role, p_other), p_same_scope)
    on conflict (role_a, role_b) do update set same_scope = excluded.same_scope
$$;

select sgn_internal.register_role_conflict(c.role, c.other, c.same_scope)
from (values
    ('tech_ops', 'process_admin', false),
    ('tech_ops', 'control_owner', false),
    ('tech_ops', 'key_custodian', false),
    ('tech_ops', 'auditor', false),
    ('process_admin', 'control_owner', true),
    ('security_responder', 'ciso', false)
) as c (role, other, same_scope);

-- 稽核：稽核主管以外的任何平台管理、控制、治理角色（含系統管理人）。
select sgn_internal.register_role_conflict('auditor', r.code, false)
from sgn.role as r
where r.category <> 'business' and r.code not in ('auditor', 'audit_head');

-- 登記過的範圍。流程類型的 process:<代碼> 不必另外登記。
create table sgn.scope_registry (
    scope_ref text primary key check (scope_ref ~ '^[a-z_]+:.+$'),
    label text not null,
    pack text,
    registered_at timestamptz not null
);

create function sgn_internal.register_scope(p_scope_ref text, p_label text, p_pack text default null)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    insert into sgn.scope_registry (scope_ref, label, pack, registered_at)
    values (p_scope_ref, p_label, p_pack, sgn_internal.now())
    on conflict (scope_ref) do update set label = excluded.label, pack = excluded.pack
$$;

create function sgn_sdk.register_scope(p_scope_ref text, p_label text, p_pack text)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_scope(p_scope_ref, p_label, p_pack)
$$;

create function sgn_internal.scope_known(p_scope_ref text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p_scope_ref is null
        or exists (select 1 from sgn.scope_registry as s where s.scope_ref = p_scope_ref)
        or exists (select 1 from sgn.process_type as t where 'process:' || t.code = p_scope_ref)
$$;

-- 這個人有沒有一筆現在有效、範圍涵蓋 p_scope_ref 的指派（全域涵蓋全部）。
create function sgn_internal.role_scope_covers(p_person_id uuid, p_role_code text, p_scope_ref text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1
        from sgn.role_assignment as a
        where a.person_id = p_person_id
          and a.role_code = p_role_code
          and sgn_internal.role_assignment_active(a.valid_from, a.effective_from, a.valid_to)
          and (a.scope_ref is null or a.scope_ref is not distinct from p_scope_ref)
    )
$$;

-- 目前的角色資料：
--   稽核治理人：由稽核線提出（稽核主管），董事長核准。裁決 D69 寫「由稽核線核准」，但稽核線的人都持有稽核角色，
--   而持有稽核角色的人不得做任何決定（K-AUDITOR-INDEPENDENT、approval.excluded_decider_roles），所以核准落在
--   董事會（骨幹：稽核治理人由董事會或審計委員會指定）。見 docs/handoff/redteam-fixes-2.md。
--   控制負責人：不再由控制負責人核准（不得自我繁殖），改由董事長核准。
--   必要角色與要冷卻的角色。
update sgn.role set change_proposer_role = 'audit_head', change_approver_role = 'board_chair' where code = 'audit_governor';
update sgn.role set change_approver_role = 'board_chair' where code = 'control_owner';
update sgn.role set required = true
where code in ('audit_governor', 'audit_head', 'control_owner', 'process_admin', 'passkey_registrar');
update sgn.role set change_cooling = true where category = 'governance';

insert into sgn.role_change_excluded (role_code, excluded_role)
values ('audit_governor', 'process_admin'), ('audit_governor', 'control_owner'), ('audit_governor', 'tech_ops')
on conflict do nothing;

alter table sgn.role
    add constraint role_approver_not_self check (change_approver_role <> code);

-- ── 變更單：冷卻與擋下 ──

alter table sgn.role_change_request
    add column propose_challenge_id uuid references sgn.auth_challenge (id),
    add column effective_at timestamptz,
    add column blocked_by uuid references sgn.person (id),
    add column blocked_at timestamptz,
    add column blocked_seq bigint,
    add column block_challenge_id uuid references sgn.auth_challenge (id);

alter table sgn.role_change_request
    drop constraint role_change_request_status_check,
    add constraint role_change_request_status_check check (status in ('pending', 'approved', 'cooling', 'blocked'));

alter table sgn.role_change_request
    drop constraint role_change_request_check,
    add constraint role_change_request_decided_check check (
        (status <> 'pending') = (approved_by is not null and approved_seq is not null and approval_challenge_id is not null)
    ),
    add constraint role_change_request_blocked_check check ((status = 'blocked') = (blocked_by is not null and blocked_seq is not null));

-- 這個人、這個角色與範圍是否已有一張還在進行（待核准，或冷卻中）的變更。
create function sgn_internal.role_change_open(p_holder_id uuid, p_role_code text, p_scope_ref text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1
        from sgn.role_change_request as q
        where q.holder_person_id = p_holder_id and q.role_code = p_role_code and q.scope_ref is not distinct from p_scope_ref
          and (q.status = 'pending' or (q.status = 'cooling' and q.effective_at > sgn_internal.now()))
    )
$$;

-- 授權檢查的唯一入口（角色指派變更的版本；取代 220_role_change.sql）。p_request 在提出時是還沒寫入的變更（id 為 null）；
-- 列出可提出的角色時是 null（不看範圍）。動作：role_change.propose、role_change.approve、role_change.block。
-- 規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE、K-AUDITOR-INDEPENDENT
create or replace function sgn_internal.denial_reason(
    p_person_id uuid,
    p_action text,
    p_role sgn.role,
    p_request sgn.role_change_request default null
)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_action not in ('role_change.propose', 'role_change.approve', 'role_change.block') then 'ACTION_UNKNOWN'
        when p_action <> 'role_change.propose' and p_request.id is null then 'ROLE_CHANGE_UNKNOWN'
        when p_role.code is null then 'ROLE_UNKNOWN'
        when p_role.assignment_source_policy <> 'manual' then 'ROLE_CHANGE_SOURCE'
        when p_action = 'role_change.block' then case
            when p_request.status <> 'cooling' or p_request.effective_at <= sgn_internal.now() then 'ROLE_CHANGE_STATE'
            when not exists (
                select 1
                from sgn.role as g
                where g.category = 'governance' and sgn_internal.has_role(p_person_id, g.code)
            ) then 'ROLE_CHANGE_NOT_GOVERNOR'
        end
        when exists (
            select 1
            from sgn.role_change_excluded as x
            where x.role_code = p_role.code and sgn_internal.has_role(p_person_id, x.excluded_role)
        ) then 'ROLE_CHANGE_EXCLUDED'
        when p_action = 'role_change.propose' then case
            when not sgn_internal.has_role(p_person_id, p_role.change_proposer_role) then 'ROLE_CHANGE_NOT_PROPOSER'
            when p_request.holder_person_id is null then null
            when not sgn_internal.scope_known(p_request.scope_ref) then 'ROLE_CHANGE_SCOPE_UNKNOWN'
            when not sgn_internal.role_scope_covers(p_person_id, p_role.change_proposer_role, p_request.scope_ref)
                then 'ROLE_CHANGE_SCOPE_NOT_COVERED'
        end
        when p_request.status <> 'pending' then 'ROLE_CHANGE_STATE'
        when p_person_id = p_request.proposed_by or p_person_id = p_request.holder_person_id then 'ROLE_CHANGE_SELF'
        when exists (
            select 1
            from jsonb_array_elements_text(sgn_internal.setting('approval.excluded_decider_roles')) as r (role_code)
            where sgn_internal.has_role(p_person_id, r.role_code)
        ) then 'DECIDER_ROLE_EXCLUDED'
        when sgn_internal.has_role(p_person_id, p_role.code) then 'ROLE_CHANGE_SAME_ROLE'
        when not sgn_internal.has_role(p_person_id, p_role.change_approver_role) then 'ROLE_CHANGE_NOT_APPROVER'
        when not sgn_internal.role_scope_covers(p_person_id, p_role.change_approver_role, p_request.scope_ref)
            then 'ROLE_CHANGE_SCOPE_NOT_COVERED'
    end
$$;

-- 變更本身能不能成立（不是誰能做，而是這張變更合不合規）：衝突矩陣、最後一位持有人、已經是這樣、已有進行中的變更。
-- p_existing：檢查的是已經寫入的那一張（核准時），不把它自己算成「進行中的另一張」。
create function sgn_internal.role_change_problem(p_request sgn.role_change_request, p_existing boolean)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_request.change is null or p_request.change not in ('grant', 'revoke') then 'ROLE_CHANGE_INVALID'
        when not coalesce((select p.active from sgn.person as p where p.id = p_request.holder_person_id), false) then 'PERSON_UNKNOWN'
        when sgn_internal.manual_assignment_exists(p_request.holder_person_id, p_request.role_code, p_request.scope_ref)
             = (p_request.change = 'grant') then 'ROLE_CHANGE_NOOP'
        when not p_existing
             and sgn_internal.role_change_open(p_request.holder_person_id, p_request.role_code, p_request.scope_ref)
            then 'ROLE_CHANGE_PENDING'
        when p_request.change = 'grant' and exists (
            select 1
            from sgn.role_assignment as a
            join sgn.role_conflict as c
              on (c.role_a = a.role_code and c.role_b = p_request.role_code)
              or (c.role_b = a.role_code and c.role_a = p_request.role_code)
            where a.person_id = p_request.holder_person_id
              and (a.valid_to is null or a.valid_to > sgn_internal.now())
              and (not c.same_scope or a.scope_ref is null or p_request.scope_ref is null or a.scope_ref = p_request.scope_ref)
        ) then 'ROLE_CONFLICT'
        when p_request.change = 'revoke'
             and (select r.required from sgn.role as r where r.code = p_request.role_code)
             and not exists (
                 select 1
                 from sgn.role_assignment as a
                 join sgn.person as p on p.id = a.person_id
                 where a.role_code = p_request.role_code
                   and a.scope_ref is not distinct from p_request.scope_ref
                   and a.person_id <> p_request.holder_person_id
                   and a.valid_to is null
                   and sgn_internal.role_assignment_active(a.valid_from, a.effective_from, a.valid_to)
                   and p.active
             ) then 'ROLE_LAST_HOLDER'
    end
$$;

create function sgn_internal.role_change_check(p_person_id uuid, p_action text, p_request sgn.role_change_request)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_problem text := coalesce(
        sgn_internal.denial_reason(p_person_id, p_action, sgn_internal.role_of(p_request.role_code), p_request),
        case when p_action <> 'role_change.block' then sgn_internal.role_change_problem(p_request, p_request.id is not null) end
    );
begin
    if v_problem is not null then
        perform sgn_internal.raise_error(v_problem, p_action || ' ' || coalesce(p_request.role_code, ''));
    end if;
end;
$$;

-- 提出與決定時要簽的內容：被指派的人（id 與畫面上的名字）、角色（代碼與名稱）、範圍、授予或撤除、原因。
create function sgn_internal.role_change_signed_content(p_request sgn.role_change_request)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'holder_id', p_request.holder_person_id,
        'holder_name', sgn_internal.person_name(p_request.holder_person_id),
        'role_code', p_request.role_code,
        'role_name', (select r.name from sgn.role as r where r.code = p_request.role_code),
        'scope_ref', p_request.scope_ref,
        'change', p_request.change,
        'reason', p_request.reason
    )
$$;

create or replace function sgn_internal.role_change_json(p_request sgn.role_change_request, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.role_change_signed_content(p_request) || jsonb_build_object(
        'request_id', p_request.id,
        'status', p_request.status,
        'proposed_by_name', sgn_internal.person_name(p_request.proposed_by),
        'proposed_at', p_request.proposed_at,
        'approved_by_name', sgn_internal.person_name(p_request.approved_by),
        'approved_at', p_request.approved_at,
        'effective_at', p_request.effective_at,
        'blocked_by_name', sgn_internal.person_name(p_request.blocked_by),
        'actions', to_jsonb(array_remove(array[
            case when sgn_internal.denial_reason(p_viewer, 'role_change.approve', r, p_request) is null then 'approve' end,
            case when sgn_internal.denial_reason(p_viewer, 'role_change.block', r, p_request) is null then 'block' end
        ], null))
    )
    from sgn.role as r
    where r.code = p_request.role_code
$$;

-- 套用核准的變更（取代 220_role_change.sql）。p_effective_at 之後才算數：授予＝之後才生效；撤除＝排定在那時結束。
create or replace function sgn_internal.role_change_apply(p_request sgn.role_change_request, p_now timestamptz)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_effective timestamptz := coalesce(p_request.effective_at, p_now);
begin
    if p_request.change = 'grant' then
        insert into sgn.role_assignment (person_id, role_code, valid_from, effective_from, scope_ref, source, change_event_seq)
        values (
            p_request.holder_person_id, p_request.role_code, p_now,
            case when v_effective > p_now then v_effective end,
            p_request.scope_ref, 'manual', p_request.approved_seq
        );
    else
        update sgn.role_assignment
        set valid_to = v_effective,
            change_event_seq = p_request.approved_seq
        where person_id = p_request.holder_person_id
          and role_code = p_request.role_code
          and scope_ref is not distinct from p_request.scope_ref
          and source = 'manual'
          and valid_to is null;
    end if;
end;
$$;

-- 擋下冷卻期內的變更：授予的指派從未生效就結束；撤除取消。
create function sgn_internal.role_change_undo(p_request sgn.role_change_request, p_now timestamptz)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    if p_request.change = 'grant' then
        update sgn.role_assignment
        set valid_to = p_now, change_event_seq = p_request.blocked_seq
        where person_id = p_request.holder_person_id and role_code = p_request.role_code
          and scope_ref is not distinct from p_request.scope_ref and source = 'manual'
          and change_event_seq = p_request.approved_seq;
    else
        update sgn.role_assignment
        set valid_to = null, change_event_seq = p_request.blocked_seq
        where person_id = p_request.holder_person_id and role_code = p_request.role_code
          and scope_ref is not distinct from p_request.scope_ref and source = 'manual'
          and change_event_seq = p_request.approved_seq;
    end if;
end;
$$;

-- 證明的原文（通行金鑰 assertion）。
create function sgn_internal.passkey_raw(p_credential_id text, p_authenticator_data text, p_client_data_json text, p_signature text)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'credential_id', p_credential_id,
        'authenticator_data', p_authenticator_data,
        'client_data_json', p_client_data_json,
        'signature', p_signature
    )
$$;

-- ── 對外 function（取代 220_role_change.sql 的提出與核准）──

drop function api.role_change_propose(text, uuid, text, text, text, text);
drop function api.role_change_challenge(text, uuid);
drop function api.role_change_approve_passkey(uuid, text, text, text, text);

create or replace function api.role_change_options(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_roles jsonb;
begin
    select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'name', r.name, 'category', r.category) order by r.code), '[]'::jsonb)
    into v_roles
    from sgn.role as r
    where sgn_internal.denial_reason(v_person_id, 'role_change.propose', r) is null;
    if v_roles = '[]'::jsonb then
        return jsonb_build_object('roles', v_roles, 'people', '[]'::jsonb, 'scopes', '[]'::jsonb);
    end if;
    return jsonb_build_object(
        'roles', v_roles,
        'people', (
            select coalesce(jsonb_agg(jsonb_build_object('person_id', p.id, 'name', sgn_internal.person_name(p.id)) order by p.display_name, p.email), '[]'::jsonb)
            from sgn.person as p
            where p.active
        ),
        'scopes', (
            select coalesce(jsonb_agg(jsonb_build_object('scope_ref', s.scope_ref, 'label', s.label) order by s.scope_ref), '[]'::jsonb)
            from (
                select scope_ref, label from sgn.scope_registry
                union
                select 'process:' || t.code, t.name from sgn.process_type as t
            ) as s
        )
    );
end;
$$;

comment on function api.role_change_options(text) is
    '角色指派變更畫面的選項：我可以提出的角色、可以指派的人與登記過的範圍（只有能提出的人拿得到）。'
    '呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE';

create or replace function api.role_change_list(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    return coalesce((
        select jsonb_agg(sgn_internal.role_change_json(q, v_person_id) order by q.proposed_at desc)
        from sgn.role_change_request as q
        join sgn.role as r on r.code = q.role_code
        where q.proposed_by = v_person_id
           or sgn_internal.denial_reason(v_person_id, 'role_change.approve', r, q) is null
           or sgn_internal.denial_reason(v_person_id, 'role_change.block', r, q) is null
    ), '[]'::jsonb);
end;
$$;

comment on function api.role_change_list(text) is
    '我提出的、我可以核准的、與冷卻期內我可以擋下的角色指派變更；每張附上我現在能做的動作。'
    '呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE、K-AUDITOR-INDEPENDENT';

create function api.role_change_propose_challenge(
    p_session text,
    p_holder_id uuid,
    p_role_code text,
    p_scope_ref text,
    p_change text,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_request sgn.role_change_request;
    v_row sgn.auth_challenge;
begin
    if coalesce(btrim(p_reason), '') = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED');
    end if;
    v_request.holder_person_id := p_holder_id;
    v_request.role_code := p_role_code;
    v_request.scope_ref := p_scope_ref;
    v_request.change := p_change;
    v_request.reason := p_reason;
    perform sgn_internal.role_change_check(v_person_id, 'role_change.propose', v_request);
    v_row := sgn_internal.challenge_new('role_change.propose', sgn_internal.role_change_signed_content(v_request), v_person_id);
    return jsonb_build_object('challenge_id', v_row.id, 'nonce', sgn_internal.b64url_encode(v_row.challenge), 'expires_at', v_row.expires_at);
end;
$$;

comment on function api.role_change_propose_challenge(text, uuid, text, text, text, text) is
    '提出角色指派變更的第一步：檢查我能不能提出、這張變更合不合規（範圍、衝突、最後一位持有人），發一次性亂數。'
    '瀏覽器用它和畫面上的被指派人、角色、範圍、授予或撤除、原因自己算挑戰值再簽。'
    '呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE、K-ADMIN-SOD、K-AUDITOR-INDEPENDENT';

create function api.role_change_propose_passkey(
    p_challenge_id uuid,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume(p_challenge_id, 'role_change.propose');
    v_request sgn.role_change_request;
    v_signer uuid;
    v_raw jsonb := sgn_internal.passkey_raw(p_credential_id, p_authenticator_data, p_client_data_json, p_signature);
    v_signed bytea;
    v_role sgn.role;
begin
    v_request.holder_person_id := (v_challenge.binding ->> 'holder_id')::uuid;
    v_request.role_code := v_challenge.binding ->> 'role_code';
    v_request.scope_ref := v_challenge.binding ->> 'scope_ref';
    v_request.change := v_challenge.binding ->> 'change';
    v_request.reason := v_challenge.binding ->> 'reason';
    v_signer := sgn_internal.signature_verify(
        v_challenge, 'new', sgn_internal.role_change_signed_content(v_request), 'propose',
        p_credential_id, p_authenticator_data, p_client_data_json, p_signature
    );
    perform sgn_internal.role_change_check(v_signer, 'role_change.propose', v_request);
    perform sgn_internal.challenge_owner_check(v_challenge, v_signer);
    v_role := sgn_internal.role_of(v_request.role_code);
    v_signed := sgn_internal.signing_challenge(v_challenge.purpose, 'new', sgn_internal.role_change_signed_content(v_request), 'propose', v_challenge.challenge);
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge)
    values (v_challenge.id, 'passkey', v_raw, sgn_internal.jcs_sha256(v_raw), sgn_internal.now(), v_signed);
    insert into sgn.role_change_request (
        holder_person_id, role_code, scope_ref, change, reason, status, proposed_by, proposed_at, proposed_seq, propose_challenge_id
    )
    values (
        v_request.holder_person_id, v_request.role_code, v_request.scope_ref, v_request.change, v_request.reason, 'pending',
        v_signer, sgn_internal.now(),
        sgn_internal.audit_append('role.change_proposed', null, v_signer, jsonb_build_object(
            'holder', v_request.holder_person_id,
            'role', v_request.role_code,
            'scope_ref', v_request.scope_ref,
            'change', v_request.change,
            'reason', v_request.reason,
            'approver_role', v_role.change_approver_role,
            'challenge', sgn_internal.b64url_encode(v_signed),
            'proof_kind', 'passkey',
            'proof_sha256', encode(sgn_internal.jcs_sha256(v_raw), 'hex'),
            'rules', jsonb_build_array('K-ROLE-SOURCE', 'K-ROLE-CHANGE-GOVERNANCE', 'K-AUDITOR-INDEPENDENT')
        )),
        v_challenge.id
    )
    returning * into v_request;
    return sgn_internal.role_change_json(v_request, v_signer);
end;
$$;

comment on function api.role_change_propose_passkey(uuid, text, text, text, text) is
    '提出角色指派變更的第二步：以通行金鑰的 assertion 提出。提出人由資料庫驗章後從憑證得出，提出當下重新檢查。'
    '呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE、K-ADMIN-SOD、K-AUDITOR-INDEPENDENT';

create function api.role_change_challenge(p_session text, p_request_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_request sgn.role_change_request;
    v_row sgn.auth_challenge;
begin
    select * into v_request from sgn.role_change_request where id = p_request_id;
    perform sgn_internal.role_change_check(v_person_id, 'role_change.' || coalesce(p_decision, ''), v_request);
    v_row := sgn_internal.challenge_new(
        'role_change.decision',
        jsonb_build_object('request_id', v_request.id, 'decision', p_decision),
        v_person_id
    );
    return jsonb_build_object('challenge_id', v_row.id, 'nonce', sgn_internal.b64url_encode(v_row.challenge), 'expires_at', v_row.expires_at);
end;
$$;

comment on function api.role_change_challenge(text, uuid, text) is
    '核准（approve）或在冷卻期內擋下（block）角色指派變更的第一步：發一次性亂數。瀏覽器用它和畫面上的變更內容自己算挑戰值再簽。'
    '呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE、K-AUDITOR-INDEPENDENT';

-- 核准：一般角色立即生效；要冷卻的角色排定在冷卻期之後，通知全部治理類角色的持有人。
create function sgn_internal.role_change_approve(p_request sgn.role_change_request, p_signer uuid, p_challenge sgn.auth_challenge, p_signed bytea, p_raw jsonb)
returns sgn.role_change_request
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_role sgn.role := sgn_internal.role_of(p_request.role_code);
    v_cooling int := sgn_internal.setting_int('role_change.governance_cooling_workdays');
    v_effective timestamptz := case when v_role.change_cooling then sgn_internal.add_workdays(v_now, v_cooling) else v_now end;
    v_row sgn.role_change_request;
begin
    update sgn.role_change_request
    set status = case when v_role.change_cooling then 'cooling' else 'approved' end,
        approved_by = p_signer,
        approved_at = v_now,
        approval_challenge_id = p_challenge.id,
        effective_at = v_effective,
        approved_seq = sgn_internal.audit_append('role.change_approved', null, p_signer, jsonb_build_object(
            'request_id', p_request.id,
            'holder', p_request.holder_person_id,
            'role', p_request.role_code,
            'scope_ref', p_request.scope_ref,
            'change', p_request.change,
            'proposed_by', p_request.proposed_by,
            'proposed_seq', p_request.proposed_seq,
            'effective_at', v_effective,
            'challenge', sgn_internal.b64url_encode(p_signed),
            'proof_kind', 'passkey',
            'proof_sha256', encode(sgn_internal.jcs_sha256(p_raw), 'hex'),
            'settings', case when v_role.change_cooling then jsonb_build_object('role_change.governance_cooling_workdays', v_cooling) end,
            'rules', jsonb_build_array('K-ROLE-SOURCE', 'K-ROLE-CHANGE-GOVERNANCE', 'K-ADMIN-SOD', 'K-DECISION-PROOF')
        ))
    where id = p_request.id
    returning * into v_row;
    perform sgn_internal.role_change_apply(v_row, v_now);
    if v_role.change_cooling then
        perform sgn_internal.notify(
            'role_change.cooling',
            array(
                select distinct h
                from sgn.role as g, unnest(sgn_internal.role_holders(g.code)) as h
                where g.category = 'governance'
            ),
            null,
            jsonb_build_object(
                'holder_name', sgn_internal.person_name(p_request.holder_person_id),
                'role_name', v_role.name,
                'change', p_request.change,
                'effective_at', v_effective
            )
        );
    end if;
    return v_row;
end;
$$;

create function api.role_change_decide_passkey(
    p_challenge_id uuid,
    p_decision text,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume(p_challenge_id, 'role_change.decision');
    v_request sgn.role_change_request;
    v_signer uuid;
    v_raw jsonb := sgn_internal.passkey_raw(p_credential_id, p_authenticator_data, p_client_data_json, p_signature);
    v_signed bytea;
    v_now timestamptz := sgn_internal.now();
begin
    if v_challenge.binding ->> 'decision' is distinct from p_decision then
        perform sgn_internal.raise_error('DECISION_MISMATCH');
    end if;
    select * into v_request from sgn.role_change_request where id = (v_challenge.binding ->> 'request_id')::uuid for update;
    v_signer := sgn_internal.signature_verify(
        v_challenge, v_request.id::text, sgn_internal.role_change_signed_content(v_request), p_decision,
        p_credential_id, p_authenticator_data, p_client_data_json, p_signature
    );
    perform sgn_internal.role_change_check(v_signer, 'role_change.' || p_decision, v_request);
    perform sgn_internal.challenge_owner_check(v_challenge, v_signer);
    v_signed := sgn_internal.signing_challenge(
        v_challenge.purpose, v_request.id::text, sgn_internal.role_change_signed_content(v_request), p_decision, v_challenge.challenge
    );
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge)
    values (v_challenge.id, 'passkey', v_raw, sgn_internal.jcs_sha256(v_raw), v_now, v_signed);
    if p_decision = 'approve' then
        v_request := sgn_internal.role_change_approve(v_request, v_signer, v_challenge, v_signed, v_raw);
    else
        update sgn.role_change_request
        set status = 'blocked',
            blocked_by = v_signer,
            blocked_at = v_now,
            block_challenge_id = v_challenge.id,
            blocked_seq = sgn_internal.audit_append('role.change_blocked', null, v_signer, jsonb_build_object(
                'request_id', v_request.id,
                'holder', v_request.holder_person_id,
                'role', v_request.role_code,
                'scope_ref', v_request.scope_ref,
                'change', v_request.change,
                'approved_seq', v_request.approved_seq,
                'challenge', sgn_internal.b64url_encode(v_signed),
                'proof_kind', 'passkey',
                'proof_sha256', encode(sgn_internal.jcs_sha256(v_raw), 'hex'),
                'rules', jsonb_build_array('K-ROLE-CHANGE-GOVERNANCE')
            ))
        where id = v_request.id
        returning * into v_request;
        perform sgn_internal.role_change_undo(v_request, v_now);
    end if;
    return sgn_internal.role_change_json(v_request, v_signer);
end;
$$;

comment on function api.role_change_decide_passkey(uuid, text, text, text, text, text) is
    '核准或擋下角色指派變更的第二步：以通行金鑰的 assertion 決定。決定者由資料庫驗章後從憑證得出，決定當下重新檢查'
    '（核准人不得是提出人、被指派的人、持有同一角色或排除角色的人，範圍要涵蓋；變更不得違反衝突矩陣或撤除最後一位持有人）。'
    '治理類角色核准後進冷卻期，期間內治理類角色的持有人可以擋下。呼叫者：sgn_app。'
    '規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE、K-ADMIN-SOD、K-AUDITOR-INDEPENDENT、K-DECISION-PROOF';

insert into sgn.notification_template (event_code, subject, body) values
    ('role_change.cooling', '治理類角色的指派變更進入冷卻期：{{role_name}}', '{{holder_name}} 的「{{role_name}}」（{{change}}）已核准，{{effective_at}} 生效；在那之前你可以在角色指派頁擋下。');

-- 畫面可以顯示的功能（取代 260_passkey_enrollment.sql 的版本）：角色指派多了「冷卻期內可以擋下」。
create or replace function sgn_internal.person_capabilities(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select to_jsonb(array_remove(array[
        'case.submit',
        case when exists (select 1 from sgn_internal.person_waiting_cases(p_person_id)) then 'inbox' end,
        case when sgn_internal.denial_reason(p_person_id, 'audit.read', null::sgn.request_case) is null then 'audit' end,
        case when exists (
            select 1
            from sgn.role as r
            where sgn_internal.denial_reason(p_person_id, 'role_change.propose', r) is null
        ) or exists (
            select 1
            from sgn.role_change_request as q
            join sgn.role as r on r.code = q.role_code
            where sgn_internal.denial_reason(p_person_id, 'role_change.approve', r, q) is null
               or sgn_internal.denial_reason(p_person_id, 'role_change.block', r, q) is null
        ) then 'role_change' end,
        case when exists (
            select 1
            from sgn.passkey_enrollment as e
            where e.status = 'pending' and e.person_id <> p_person_id and sgn_internal.denial_reason(p_person_id, 'passkey.endorse', e) is null
        ) then 'passkey.endorse' end
    ], null))
$$;

select sgn_internal.register_rule(
    'K-ROLE-CHANGE-GOVERNANCE',
    '角色指派變更的提出與決定都要通行金鑰；核准人不得持有被變更的角色（不得自我繁殖）、不得是提出人或被指派的人；'
    '範圍必須登記過，提出人與核准人的角色範圍必須涵蓋它；必要角色不得撤除最後一位持有人；'
    '治理類角色核准後有冷卻期（role_change.governance_cooling_workdays），通知全部治理類角色的持有人，期間內任一人可擋下',
    null,
    'partial',
    '變更單沒有駁回、撤回與到期；冷卻期結束後狀態仍顯示 cooling（以 effective_at 判斷是否已生效）'
);

select sgn_internal.register_rule(
    'K-ADMIN-SOD',
    '平台角色衝突矩陣（骨幹 18.2，資料表 sgn.role_conflict）在角色指派變更的提出與核准時檢查',
    null,
    'partial',
    '無法避免時的有期限例外持有與每月覆核沒做'
);

select sgn_internal.register_rule(
    'K-ROLE-SOURCE',
    '角色指派的來源依角色登記的政策：控制、平台、治理類只能在平台內指派（一人以通行金鑰提出、另一位有權的人以通行金鑰核准）；'
    '業務類只能由外部同步帶入，有冷卻期：參數 directory.sync_cooling_workdays 個營業日內新持有人不算、原持有人仍算，並開例外',
    null,
    'partial',
    '目錄對控制類角色的說法消失時，不會開例外，也不會撤除平台內的指派'
);
