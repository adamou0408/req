-- 平台內的角色指派變更（K-ROLE-SOURCE、K-AUDITOR-INDEPENDENT；紅隊 高-1 的修法）。
-- 控制、平台、治理類角色不能由同步帶入，只能走這裡：一人提出、另一位有權的人用通行金鑰核准，
-- 核准人不得是提出人、不得是被指派的人；誰能提出、誰能核准、誰不得經手（例如稽核角色不得經技術維運之手）
-- 都是角色登記（sgn.role）的資料。提出與核准都寫進雜湊鏈，核准附通行金鑰的證明。
-- 這是最小可用的版本：沒有駁回、撤回、到期，提出與核准不比對範圍（見 sgn.rule 的 note）。

create table sgn.role_change_request (
    id uuid primary key default gen_random_uuid(),
    holder_person_id uuid not null references sgn.person (id),
    role_code text not null references sgn.role (code),
    scope_ref text,
    change text not null check (change in ('grant', 'revoke')),
    reason text not null check (btrim(reason) <> ''),
    status text not null check (status in ('pending', 'approved')),
    proposed_by uuid not null references sgn.person (id),
    proposed_at timestamptz not null,
    proposed_seq bigint not null,
    approved_by uuid references sgn.person (id),
    approved_at timestamptz,
    approved_seq bigint,
    approval_challenge_id uuid references sgn.auth_challenge (id),
    check ((status = 'approved') = (approved_by is not null and approved_seq is not null and approval_challenge_id is not null))
);

-- 同一個人、同一個角色與範圍，同時只能有一張待核准的變更。
create unique index role_change_request_pending_idx
    on sgn.role_change_request (holder_person_id, role_code, coalesce(scope_ref, ''))
    where status = 'pending';

alter table sgn.auth_challenge
    drop constraint auth_challenge_purpose_check,
    add constraint auth_challenge_purpose_check check (purpose in ('session', 'passkey_register', 'decision', 'role_change'));

insert into sgn.error_catalog (code, message, http_status) values
    ('ROLE_CHANGE_UNKNOWN', '沒有這張角色指派變更', 404),
    ('ROLE_CHANGE_NOT_PROPOSER', '你不能提出這個角色的指派變更', 403),
    ('ROLE_CHANGE_NOT_APPROVER', '你不能核准這個角色的指派變更', 403),
    ('ROLE_CHANGE_SELF', '提出人與被指派的人不能核准這張變更', 403),
    ('ROLE_CHANGE_EXCLUDED', '你的角色不能經手這個角色的指派變更', 403),
    ('ROLE_CHANGE_STATE', '這張角色指派變更已經處理過了', 409),
    ('ROLE_CHANGE_NOOP', '這個人目前的指派已經是這樣，不需要變更', 409),
    ('ROLE_CHANGE_PENDING', '這個人、這個角色已經有一張待核准的變更', 409),
    ('ROLE_CHANGE_INVALID', '變更種類只能是授予或撤除', 422);

-- 授權檢查的唯一入口（角色指派變更的版本；與 160_case_flow.sql 的申請單版本同名，以第三個參數的型別區分）。
-- 回傳拒絕代碼；可以時回 null。規則：K-ROLE-SOURCE、K-AUDITOR-INDEPENDENT
create function sgn_internal.denial_reason(
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
        when p_action not in ('role_change.propose', 'role_change.approve') then 'ACTION_UNKNOWN'
        when p_action = 'role_change.approve' and p_request.id is null then 'ROLE_CHANGE_UNKNOWN'
        when p_role.code is null then 'ROLE_UNKNOWN'
        when p_role.change_excluded_role is not null
             and sgn_internal.has_role(p_person_id, p_role.change_excluded_role) then 'ROLE_CHANGE_EXCLUDED'
        when p_action = 'role_change.propose'
             and not sgn_internal.has_role(p_person_id, p_role.change_proposer_role) then 'ROLE_CHANGE_NOT_PROPOSER'
        when p_action = 'role_change.propose' then null
        when p_request.status <> 'pending' then 'ROLE_CHANGE_STATE'
        when p_person_id = p_request.proposed_by or p_person_id = p_request.holder_person_id then 'ROLE_CHANGE_SELF'
        when exists (
            select 1
            from jsonb_array_elements_text(sgn_internal.setting('approval.excluded_decider_roles')) as r (role_code)
            where sgn_internal.has_role(p_person_id, r.role_code)
        ) then 'DECIDER_ROLE_EXCLUDED'
        when not sgn_internal.has_role(p_person_id, p_role.change_approver_role) then 'ROLE_CHANGE_NOT_APPROVER'
    end
$$;

-- 不允許就丟錯（角色指派變更的版本）。
create function sgn_internal.authorize(
    p_person_id uuid,
    p_action text,
    p_role sgn.role,
    p_request sgn.role_change_request default null
)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_denial text := sgn_internal.denial_reason(p_person_id, p_action, p_role, p_request);
begin
    if v_denial is not null then
        perform sgn_internal.raise_error(v_denial, p_action || ' ' || coalesce(p_role.code, ''));
    end if;
end;
$$;

create function sgn_internal.role_of(p_code text)
returns sgn.role
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select r.* from sgn.role as r where r.code = p_code
$$;

-- 這個人目前有沒有這個角色（與範圍）的平台內指派。變更只動平台內（source = manual）的指派。
create function sgn_internal.manual_assignment_exists(p_person_id uuid, p_role_code text, p_scope_ref text)
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
          and a.scope_ref is not distinct from p_scope_ref
          and a.source = 'manual'
          and a.valid_to is null
    )
$$;

create function sgn_internal.role_change_json(p_request sgn.role_change_request, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'request_id', p_request.id,
        'holder_name', sgn_internal.person_name(p_request.holder_person_id),
        'role_code', p_request.role_code,
        'role_name', r.name,
        'scope_ref', p_request.scope_ref,
        'change', p_request.change,
        'reason', p_request.reason,
        'status', p_request.status,
        'proposed_by_name', sgn_internal.person_name(p_request.proposed_by),
        'proposed_at', p_request.proposed_at,
        'approved_by_name', sgn_internal.person_name(p_request.approved_by),
        'approved_at', p_request.approved_at,
        'actions', case
            when sgn_internal.denial_reason(p_viewer, 'role_change.approve', r, p_request) is null then '["approve"]'::jsonb
            else '[]'::jsonb
        end
    )
    from sgn.role as r
    where r.code = p_request.role_code
$$;

-- 套用核准的變更：授予＝新增一筆平台內的指派；撤除＝結束平台內的指派。
create function sgn_internal.role_change_apply(p_request sgn.role_change_request, p_now timestamptz)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    if p_request.change = 'grant' then
        insert into sgn.role_assignment (person_id, role_code, valid_from, scope_ref, source, change_event_seq)
        values (p_request.holder_person_id, p_request.role_code, p_now, p_request.scope_ref, 'manual', p_request.approved_seq);
    else
        update sgn.role_assignment
        set valid_to = p_now,
            change_event_seq = p_request.approved_seq
        where person_id = p_request.holder_person_id
          and role_code = p_request.role_code
          and scope_ref is not distinct from p_request.scope_ref
          and source = 'manual'
          and valid_to is null;
    end if;
end;
$$;

-- ── 對外 function ──

create function api.role_change_options(p_session text)
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
    return jsonb_build_object(
        'roles', v_roles,
        -- 能提出變更的人才需要挑人；其他人拿不到人員名單
        'people', case when v_roles = '[]'::jsonb then '[]'::jsonb else (
            select coalesce(jsonb_agg(jsonb_build_object('person_id', p.id, 'name', p.display_name) order by p.display_name), '[]'::jsonb)
            from sgn.person as p
            where p.active
        ) end
    );
end;
$$;

comment on function api.role_change_options(text) is
    '角色指派變更畫面的選項：我可以提出的角色、可以指派的人（只有能提出的人拿得到）。呼叫者：sgn_app。規則：K-ROLE-SOURCE';

create function api.role_change_list(p_session text)
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
    ), '[]'::jsonb);
end;
$$;

comment on function api.role_change_list(text) is
    '我提出的、與我可以核准的角色指派變更；每張附上我現在能做的動作。呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-AUDITOR-INDEPENDENT';

create function api.role_change_propose(
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
    v_role sgn.role := sgn_internal.role_of(p_role_code);
    v_now timestamptz := sgn_internal.now();
    v_request sgn.role_change_request;
begin
    perform sgn_internal.authorize(v_person_id, 'role_change.propose', v_role);
    if not coalesce((select p.active from sgn.person as p where p.id = p_holder_id), false) then
        perform sgn_internal.raise_error('PERSON_UNKNOWN');
    end if;
    if p_change is null or p_change not in ('grant', 'revoke') then
        perform sgn_internal.raise_error('ROLE_CHANGE_INVALID');
    end if;
    if coalesce(btrim(p_reason), '') = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED');
    end if;
    if sgn_internal.manual_assignment_exists(p_holder_id, p_role_code, p_scope_ref) = (p_change = 'grant') then
        perform sgn_internal.raise_error('ROLE_CHANGE_NOOP');
    end if;
    if exists (
        select 1 from sgn.role_change_request as q
        where q.holder_person_id = p_holder_id and q.role_code = p_role_code
          and q.scope_ref is not distinct from p_scope_ref and q.status = 'pending'
    ) then
        perform sgn_internal.raise_error('ROLE_CHANGE_PENDING');
    end if;
    insert into sgn.role_change_request (
        holder_person_id, role_code, scope_ref, change, reason, status, proposed_by, proposed_at, proposed_seq
    )
    values (
        p_holder_id, p_role_code, p_scope_ref, p_change, p_reason, 'pending', v_person_id, v_now,
        sgn_internal.audit_append('role.change_proposed', null, v_person_id, jsonb_build_object(
            'holder', p_holder_id,
            'role', p_role_code,
            'scope_ref', p_scope_ref,
            'change', p_change,
            'reason', p_reason,
            'approver_role', v_role.change_approver_role,
            'rules', jsonb_build_array('K-ROLE-SOURCE', 'K-AUDITOR-INDEPENDENT')
        ))
    )
    returning * into v_request;
    return sgn_internal.role_change_json(v_request, v_person_id);
end;
$$;

comment on function api.role_change_propose(text, uuid, text, text, text, text) is
    '提出角色指派變更（授予或撤除）。提出人必須持有該角色登記的提出人角色，且不得持有排除的角色；'
    '變更要另一位有權的人以通行金鑰核准才生效。呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-AUDITOR-INDEPENDENT';

create function api.role_change_challenge(p_session text, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_request sgn.role_change_request;
    v_challenge sgn.auth_challenge;
begin
    select * into v_request from sgn.role_change_request where id = p_request_id;
    perform sgn_internal.authorize(v_person_id, 'role_change.approve', sgn_internal.role_of(v_request.role_code), v_request);
    v_challenge := sgn_internal.challenge_new(
        'role_change',
        jsonb_build_object(
            'request_id', v_request.id,
            'holder', v_request.holder_person_id,
            'role_code', v_request.role_code,
            'scope_ref', v_request.scope_ref,
            'change', v_request.change,
            'proposed_seq', v_request.proposed_seq
        ),
        v_person_id
    );
    return jsonb_build_object(
        'challenge_id', v_challenge.id,
        'challenge', sgn_internal.b64url_encode(v_challenge.challenge),
        'binding', v_challenge.binding
    );
end;
$$;

comment on function api.role_change_challenge(text, uuid) is
    '核准角色指派變更的第一步：發一次性挑戰值，綁定這張變更的內容與核准人。呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-AUDITOR-INDEPENDENT';

-- 核准的第二步：誰核准由資料庫驗通行金鑰的簽章得出，挑戰值只能由發給的那個人使用；核准當下重新授權。
create function api.role_change_approve_passkey(
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
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume(p_challenge_id, 'role_change');
    v_signer uuid := sgn_internal.webauthn_verify(
        v_challenge.challenge, p_credential_id, p_authenticator_data, p_client_data_json, p_signature
    );
    v_now timestamptz := sgn_internal.now();
    v_raw jsonb := jsonb_build_object(
        'credential_id', p_credential_id,
        'authenticator_data', p_authenticator_data,
        'client_data_json', p_client_data_json,
        'signature', p_signature
    );
    v_request sgn.role_change_request;
begin
    if v_signer is distinct from v_challenge.person_id then
        perform sgn_internal.raise_error('CHALLENGE_PURPOSE', 'challenge was issued to another person');
    end if;
    select * into v_request from sgn.role_change_request where id = (v_challenge.binding ->> 'request_id')::uuid for update;
    perform sgn_internal.authorize(v_signer, 'role_change.approve', sgn_internal.role_of(v_request.role_code), v_request);
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at)
    values (v_challenge.id, 'passkey', v_raw, sgn_internal.jcs_sha256(v_raw), v_now);
    update sgn.role_change_request
    set status = 'approved',
        approved_by = v_signer,
        approved_at = v_now,
        approval_challenge_id = v_challenge.id,
        approved_seq = sgn_internal.audit_append('role.change_approved', null, v_signer, jsonb_build_object(
            'request_id', v_request.id,
            'holder', v_request.holder_person_id,
            'role', v_request.role_code,
            'scope_ref', v_request.scope_ref,
            'change', v_request.change,
            'proposed_by', v_request.proposed_by,
            'proposed_seq', v_request.proposed_seq,
            'challenge', sgn_internal.b64url_encode(v_challenge.challenge),
            'proof_kind', 'passkey',
            'proof_sha256', encode(sgn_internal.jcs_sha256(v_raw), 'hex'),
            'rules', jsonb_build_array('K-ROLE-SOURCE', 'K-AUDITOR-INDEPENDENT', 'K-DECISION-PROOF')
        ))
    where id = v_request.id
    returning * into v_request;
    perform sgn_internal.role_change_apply(v_request, v_now);
    return sgn_internal.role_change_json(v_request, v_signer);
end;
$$;

comment on function api.role_change_approve_passkey(uuid, text, text, text, text) is
    '核准角色指派變更的第二步：以通行金鑰的 assertion 核准並立即套用。核准人由資料庫驗章後從憑證得出，'
    '不得是提出人或被指派的人。呼叫者：sgn_app。規則：K-ROLE-SOURCE、K-AUDITOR-INDEPENDENT、K-DECISION-PROOF';

-- 畫面可以顯示的功能（取代 180_views.sql 的版本）：多了「角色指派」——能提出任何一個角色的變更，或有等我核准的變更。
-- 申請單版本的授權入口與角色變更版本同名，所以 null 要標明型別。
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
        ) then 'role_change' end
    ], null))
$$;
