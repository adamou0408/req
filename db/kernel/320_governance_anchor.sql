-- 最高治理角色是錨點：平台內沒有人能產生它（裁決 D77；紅隊第三輪 高-3、中-1）。
--
-- 根因：最高治理角色（示範資料的董事長）由流程管理者提出、控制負責人核准，而控制負責人又由最高治理角色核准——
-- 「誰核准誰」形成迴圈，兩個人就能產生新的最高治理角色持有人，再由他核准新的控制負責人。它也不是必要角色，
-- 唯一的持有人可以被提出撤除；冷卻期內擋下變更的人不排除當事人，被撤的人可以自己擋下。
-- 中-1：衝突矩陣對稽核治理人只列了稽核人員，稽核治理人可以同時是流程管理者。
--
-- 這一版（規則都是資料；程式只認旗標與政策，不認角色名稱）：
--   1. 角色多一種指派來源政策 ceremony：不能經平台內的角色指派變更（ROLE_CHANGE_CEREMONY），只能由資料庫擁有者
--      以 sgn_internal.governance_anchor_install 的儀式建立（安裝與更替各一次一筆，進鏈）。這個 function 不授權給
--      任何執行期帳號（db/tests/kernel/12-grants.test.mjs 檢查）。錨點角色（sgn.role.anchor）都是 ceremony、必要角色。
--   2. 角色之間「誰核准誰」（change_approver_role → 角色）必須是有向無環圖；ceremony 的角色沒有核准人。
--      db/tests/kernel/85-governance-anchor.test.mjs 以 pg_catalog 與資料表做架構測試。
--   3. 冷卻期內擋下變更的人不得是當事人（被指派的人）、提出人、核准人（ROLE_CHANGE_SELF）。
--   4. 衝突矩陣補上：稽核治理人與流程管理、控制負責人、技術維運互斥；錨點角色與流程管理、控制負責人、技術維運、稽核治理人互斥。
--   5. 治理類角色的持有人必須有可用的通行金鑰（否則冷卻期內擋不下任何變更），沒有就開例外 K-GOVERNANCE-KEY：
--      排程每次檢查（api_job.governance_check），治理類變更進冷卻期時也檢查。

insert into sgn.error_catalog (code, message, http_status) values
    ('ROLE_CHANGE_CEREMONY', '這個角色是最高治理角色，只能由資料庫擁有者在安裝或更替時以儀式指派，不能在平台內變更', 422),
    ('GOVERNANCE_ANCHOR_INVALID', '只有標為錨點的角色可以用這個儀式指派，被指派的人必須在職、不得持有衝突的角色', 422);

alter table sgn.role
    add column anchor boolean not null default false;

alter table sgn.role
    drop constraint role_assignment_source_policy_check,
    add constraint role_assignment_source_policy_check check (assignment_source_policy in ('manual', 'sync_proposed', 'ceremony')),
    drop constraint role_check,
    add constraint role_source_by_category check (
        (category = 'business' and assignment_source_policy in ('manual', 'sync_proposed'))
        or (category <> 'business' and assignment_source_policy = 'manual')
        or (category = 'governance' and assignment_source_policy = 'ceremony')
    ),
    alter column change_proposer_role drop not null,
    alter column change_approver_role drop not null,
    add constraint role_ceremony_no_approver check (
        (assignment_source_policy = 'ceremony') = (change_proposer_role is null and change_approver_role is null)
    ),
    add constraint role_anchor_is_ceremony check (not anchor or (assignment_source_policy = 'ceremony' and required));

comment on column sgn.role.anchor is '最高治理角色（錨點）：平台內沒有人能產生它，只能由資料庫擁有者以儀式指派（D77）。';

-- 最高治理角色：示範資料的董事長（top_resolver 也是它）。
update sgn.role
set anchor = true, required = true, assignment_source_policy = 'ceremony', change_proposer_role = null, change_approver_role = null
where code = 'board_chair';

select sgn_internal.register_role_conflict(c.role, c.other, false)
from (values
    ('audit_governor', 'process_admin'),
    ('audit_governor', 'control_owner'),
    ('audit_governor', 'tech_ops'),
    ('board_chair', 'process_admin'),
    ('board_chair', 'control_owner'),
    ('board_chair', 'tech_ops'),
    ('board_chair', 'audit_governor')
) as c (role, other);

-- ── 1. 錨點的儀式（只有資料庫擁有者能執行；沒有授權給任何執行期帳號）──

create function sgn_internal.governance_anchor_install(p_role_code text, p_person_id uuid, p_reason text)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_role sgn.role := sgn_internal.role_of(p_role_code);
    v_now timestamptz := sgn_internal.now();
    v_previous jsonb;
    v_seq bigint;
begin
    if not coalesce(v_role.anchor, false)
       or not coalesce((select p.active from sgn.person as p where p.id = p_person_id), false)
       or coalesce(btrim(p_reason), '') = ''
       or exists (
           select 1
           from sgn.role_assignment as a
           join sgn.role_conflict as c
             on (c.role_a = a.role_code and c.role_b = p_role_code) or (c.role_b = a.role_code and c.role_a = p_role_code)
           where a.person_id = p_person_id
             and sgn_internal.role_assignment_active(a.valid_from, a.effective_from, a.valid_to)
       ) then
        perform sgn_internal.raise_error('GOVERNANCE_ANCHOR_INVALID', p_role_code);
    end if;
    select coalesce(jsonb_agg(a.person_id order by a.id), '[]'::jsonb) into v_previous
    from sgn.role_assignment as a
    where a.role_code = p_role_code and a.valid_to is null;
    v_seq := sgn_internal.audit_append('role.anchor_installed', null, null, jsonb_build_object(
        'role', p_role_code,
        'person', p_person_id,
        'replaced', v_previous,
        'reason', p_reason,
        'by', current_user,
        'rules', jsonb_build_array('K-GOVERNANCE-ANCHOR')
    ));
    update sgn.role_assignment
    set valid_to = v_now, change_event_seq = v_seq
    where role_code = p_role_code and valid_to is null;
    insert into sgn.role_assignment (person_id, role_code, valid_from, source, change_event_seq)
    values (p_person_id, p_role_code, v_now, 'ceremony', v_seq);
    return v_seq;
end;
$$;

comment on function sgn_internal.governance_anchor_install(text, uuid, text) is
    '最高治理角色（錨點）的指派儀式：安裝與更替各呼叫一次，結束原持有人、指派新的持有人並寫進鏈。只有資料庫擁有者能執行'
    '（不授權給任何執行期帳號）。規則：K-GOVERNANCE-ANCHOR';

-- ── 3. 授權檢查的唯一入口（角色指派變更的版本；同 270 的簽章）：ceremony 的角色不能變更；擋下的人不得是當事人、提出人、核准人 ──

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
        when p_role.assignment_source_policy = 'ceremony' then 'ROLE_CHANGE_CEREMONY'
        when p_role.assignment_source_policy <> 'manual' then 'ROLE_CHANGE_SOURCE'
        when p_action = 'role_change.block' then case
            when p_request.status <> 'cooling' or p_request.effective_at <= sgn_internal.now() then 'ROLE_CHANGE_STATE'
            when p_person_id in (p_request.holder_person_id, p_request.proposed_by, p_request.approved_by) then 'ROLE_CHANGE_SELF'
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

-- ── 5. 治理類持有人沒有可用金鑰就開例外 ──

-- 現在持有治理類角色、卻沒有可用通行金鑰的人，各開一筆例外（同一個人只開一次）。回傳新開的例外 id。
create function sgn_internal.governance_key_check()
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_opened jsonb := '[]'::jsonb;
    v_holder record;
begin
    for v_holder in
        select h.person_id, jsonb_agg(h.role_code order by h.role_code) as roles
        from (
            select distinct x as person_id, g.code as role_code
            from sgn.role as g, unnest(sgn_internal.role_holders(g.code)) as x
            where g.category = 'governance'
        ) as h
        where sgn_internal.passkey_usable_count(h.person_id) = 0
          and not exists (
              select 1 from sgn.exception_record as e
              where e.rule_code = 'K-GOVERNANCE-KEY' and e.detail ->> 'person' = h.person_id::text
          )
        group by h.person_id
    loop
        v_opened := v_opened || to_jsonb(sgn_internal.exception_open('K-GOVERNANCE-KEY', null, jsonb_build_object(
            'kind', 'governance_holder_without_key', 'person', v_holder.person_id, 'roles', v_holder.roles
        )));
    end loop;
    return v_opened;
end;
$$;

create function api_job.governance_check()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('exceptions', sgn_internal.governance_key_check());
end;
$$;

comment on function api_job.governance_check() is
    '治理類角色的持有人沒有可用的通行金鑰（冷卻期內擋不下任何變更）時開例外 K-GOVERNANCE-KEY。'
    '呼叫者：sgn_job（排程 db/tools/jobs.mjs）。規則：K-GOVERNANCE-KEY';

-- 核准（同 270 的簽章）：治理類變更進冷卻期時，也檢查能擋下的人有沒有可用的金鑰。
create or replace function sgn_internal.role_change_approve(
    p_request sgn.role_change_request,
    p_signer uuid,
    p_challenge sgn.auth_challenge,
    p_signed bytea,
    p_raw jsonb
)
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
        perform sgn_internal.governance_key_check();
    end if;
    return v_row;
end;
$$;

select sgn_internal.register_rule(
    'K-GOVERNANCE-ANCHOR',
    '最高治理角色是錨點（D77）：角色之間「誰核准誰」是有向無環圖；錨點角色不能經平台內的角色指派變更，'
    '只能由資料庫擁有者以有紀錄的儀式建立（安裝與更替，進鏈），而且是必要角色；冷卻期內擋下變更的人不得是當事人、提出人、核准人；'
    '衝突矩陣含稽核治理人與流程管理、控制負責人、技術維運互斥',
    null,
    'full',
    null
);

select sgn_internal.register_rule(
    'K-GOVERNANCE-KEY',
    '治理類角色的持有人必須有可用的通行金鑰（否則冷卻期內擋不下任何變更）；沒有就開例外，排程與治理類變更進冷卻期時檢查',
    null,
    'partial',
    '例外沒有結案流程：持有人補登金鑰後例外仍在（例外的覆核與結案是核心尚未做的部分）'
);
