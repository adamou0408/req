-- 交付接上簽核流程與授權的一生（裁決 D63）：執行關、生效、撤銷、生效後縮小、到期。
--
-- 執行關開始時，交付方式是 system 的受管系統依通道各排一筆套用（410 delivery_enqueue_case），不開人工工作；
-- 只有交付方式是 manual（或 file，這一版視同人工）的受管系統才由該系統的管理人執行（既有的人工退路），並開常設例外
-- K-DELIVERY-MANUAL。生效以「套用成功＋自動驗證通過」為準（fulfilment_progress）。
-- 撤銷、縮小、到期都自動送出；撤回送不到時開例外並通知升級對象（410 delivery_stuck_check），不靜默。

alter table sgn.grant_record drop constraint grant_record_status_check;
alter table sgn.grant_record
    add constraint grant_record_status_check check (status in ('active', 'revoked', 'expired')),
    add column ended_at timestamptz,
    add column ended_by uuid references sgn.person (id),
    add column end_reason text;

-- ── 解析一關（同 370 的簽章）：執行關只為人工交付的受管系統開工作 ──

create or replace function sgn_internal.resolve_stage(p_case sgn.request_case, p_stage_id bigint, p_stage sgn.policy_stage)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_top_role text := (select p.top_resolver_role from sgn.approval_policy as p where p.id = p_stage.policy_id);
    v_scopes text[];
begin
    if p_stage.resolver_kind = 'applicant_manager' then
        return sgn_internal.resolve_applicant_manager(p_case, p_stage_id, v_top_role);
    end if;
    if p_stage.resolver_kind = 'principal_owner' then
        return sgn_internal.resolve_principal_owner(p_case, p_stage_id, v_top_role);
    end if;
    if p_stage.resolver_kind in ('scoped_role', 'system_custodian') then
        v_scopes := sgn_internal.case_fulfilment_scopes(p_case, p_stage.code);
        if p_stage.phase = 'fulfilment' then
            v_scopes := array(select s from unnest(v_scopes) as s where not sgn_internal.delivery_automated(s));
        end if;
        if cardinality(v_scopes) = 0 then
            return '[]'::jsonb;
        end if;
    else
        -- 不依範圍的角色：一個空字串代表「不限範圍」
        v_scopes := array[''];
    end if;
    if p_stage.resolver_kind in ('role_holder', 'scoped_role') then
        return sgn_internal.resolve_role_holders(p_case, p_stage_id, p_stage, v_scopes, v_top_role);
    end if;
    return sgn_internal.resolve_claim_groups(p_case, p_stage_id, p_stage, v_scopes, v_top_role);
end;
$$;

-- 開關卡的稽核事件與升級例外（從 stage_open 拆出來）。
create function sgn_internal.stage_opened_record(p_case sgn.request_case, p_stage sgn.policy_stage, p_tasks jsonb, p_deliveries int)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_line jsonb;
    v_basis jsonb;
    v_rule text := sgn_internal.stage_escalation_rule(p_stage.resolver_kind);
begin
    perform sgn_internal.audit_append(
        'case.stage_opened', p_case.id, null,
        jsonb_build_object(
            'stage', p_stage.code,
            'seq', p_stage.seq,
            'version', p_case.current_version,
            'tasks', p_tasks,
            'deliveries', p_deliveries,
            'settings', jsonb_build_object(
                'approval.manager_change_cooling_workdays', sgn_internal.setting('approval.manager_change_cooling_workdays'),
                'approval.excluded_decider_roles', sgn_internal.setting('approval.excluded_decider_roles')
            ),
            'rules', jsonb_build_array(
                'K-RESOLVE-STAGE-START', 'K-SOD-APPLICANT', 'K-SOD-DISTINCT', 'K-AUDITOR-INDEPENDENT', 'K-SOD-ROLE-ESCALATED',
                'K-PRINCIPAL-OWNER-CONFIRM'
            ) || case when p_stage.phase = 'fulfilment' then jsonb_build_array('K-DELIVERY-AUTO', 'K-DELIVERY-MANUAL') else '[]'::jsonb end
        )
    );
    for v_line in select t #> '{basis,line}' from jsonb_array_elements(p_tasks) as t loop
        if v_line ->> 'origin' = 'sync_change' then
            perform sgn_internal.exception_open('K-DETECT-MANAGER-FLIP', p_case.id, v_line);
        end if;
    end loop;
    if v_rule is not null then
        for v_basis in select t -> 'basis' from jsonb_array_elements(p_tasks) as t loop
            if v_basis ->> 'via' in ('manager_chain', 'top_resolver') then
                perform sgn_internal.exception_open(v_rule, p_case.id, jsonb_build_object(
                    'stage', p_stage.code, 'seq', p_stage.seq, 'role', p_stage.resolver_role, 'resolver', p_stage.resolver_kind,
                    'via', v_basis ->> 'via', 'path', v_basis -> 'path'
                ));
            end if;
        end loop;
    end if;
    -- 人工執行是退路（D63）：每一張走人工的單都留一筆常設例外
    if p_stage.phase = 'fulfilment' and jsonb_array_length(p_tasks) > 0 then
        perform sgn_internal.exception_open('K-DELIVERY-MANUAL', p_case.id, jsonb_build_object(
            'stage', p_stage.code,
            'scopes', (select jsonb_agg(distinct s) from jsonb_array_elements(p_tasks) as t cross join jsonb_array_elements_text(t -> 'scope_refs') as s)
        ));
    end if;
end;
$$;

-- 開一關（同 370 的簽章）：執行關先排自動交付；沒有人工工作但有自動交付時不停住。
create or replace function sgn_internal.stage_open(p_case sgn.request_case, p_stage sgn.policy_stage)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_stage_id bigint;
    v_specs jsonb;
    v_tasks jsonb := '[]'::jsonb;
    v_deliveries int := 0;
begin
    insert into sgn.case_stage (case_id, policy_id, seq, status, opened_version, opened_at)
    values (p_case.id, p_stage.policy_id, p_stage.seq, 'open', p_case.current_version, sgn_internal.now())
    returning id into v_stage_id;
    if p_stage.phase = 'fulfilment' then
        v_deliveries := sgn_internal.delivery_enqueue_case(p_case, p_stage.code);
    end if;
    v_specs := sgn_internal.resolve_stage(p_case, v_stage_id, p_stage);
    if jsonb_array_length(v_specs) = 0 and v_deliveries = 0 then
        perform sgn_internal.stage_halt(p_case, p_stage, v_stage_id);
        return;
    end if;
    if jsonb_array_length(v_specs) > 0 then
        v_tasks := sgn_internal.stage_add_tasks(p_case, v_stage_id, p_stage, v_specs);
    end if;
    perform sgn_internal.stage_opened_record(p_case, p_stage, v_tasks, v_deliveries);
end;
$$;

-- 關卡的工作都做完時（同 160 的簽章）：執行關另由 fulfilment_progress 判斷（還要等自動交付與驗證）。
create or replace function sgn_internal.stage_close_if_done(p_stage_id bigint)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case_id uuid := (select s.case_id from sgn.case_stage as s where s.id = p_stage_id);
begin
    if exists (
        select 1 from sgn.case_task as t
        where t.stage_id = p_stage_id and t.status not in ('approved', 'completed')
    ) then
        return;
    end if;
    if exists (
        select 1 from sgn.case_stage as s join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
        where s.id = p_stage_id and ps.phase = 'fulfilment'
    ) then
        perform sgn_internal.fulfilment_progress(v_case_id);
        return;
    end if;
    update sgn.case_stage set status = 'done', closed_at = sgn_internal.now() where id = p_stage_id;
    perform sgn_internal.case_advance(v_case_id);
end;
$$;

-- 往下一個適用的關卡走（同 370 的簽章）：驗證中的單在執行關完成後也是生效。
create or replace function sgn_internal.case_advance(p_case_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_next sgn.policy_stage;
begin
    loop
        select * into v_case from sgn.request_case where id = p_case_id;
        if exists (select 1 from sgn.case_stage where case_id = p_case_id and status in ('open', 'halted')) then
            return;
        end if;
        select ps.* into v_next
        from sgn.policy_stage as ps
        where ps.policy_id = v_case.policy_id
          and sgn_internal.stage_applies_to_case(ps, v_case)
          and not exists (
              select 1 from sgn.case_stage as s
              where s.case_id = p_case_id and s.policy_id = ps.policy_id and s.seq = ps.seq and s.status = 'done'
          )
        order by ps.seq
        limit 1;
        if v_next.seq is null then
            if v_case.state = 'in_approval' then
                perform sgn_internal.case_transition(p_case_id, 'finish_approval_final');
                perform sgn_internal.audit_append(
                    'case.completed', p_case_id, null,
                    jsonb_build_object('version', v_case.current_version, 'rules', jsonb_build_array('K-PARALLEL-ALL'))
                );
            elsif v_case.state in ('pending_fulfilment', 'verifying') then
                perform sgn_internal.case_transition(p_case_id, 'finish_fulfilment');
                perform sgn_internal.grant_activate(v_case);
            end if;
            return;
        end if;
        if v_next.phase = 'fulfilment' and v_case.state = 'in_approval' then
            perform sgn_internal.case_transition(p_case_id, 'finish_approval');
            perform sgn_internal.fulfilment_prepare(v_case);
        end if;
        perform sgn_internal.stage_open(v_case, v_next);
    end loop;
end;
$$;

-- ── 誰可以撤銷、縮小（rules.md「撤銷」：等於縮小到零，不需要簽核，但必須填原因）──
-- 申請人、被授權者的負責人、這張單上簽過或執行過的人、參數 grant.revoker_roles 的角色持有人（判斷在授權入口裡）。

-- 授權檢查的唯一入口（同 160 的簽章）：多了 revoker。
create or replace function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_case sgn.request_case)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when a.action is null or a.actor_rule = 'system' then 'ACTION_UNKNOWN'
        when a.scope = 'case' and p_case.id is null then 'CASE_UNKNOWN'
        when a.actor_rule = 'role'
             and not sgn_internal.has_role(p_person_id, sgn_internal.setting_text(a.role_setting)) then a.denied_code
        when a.actor_rule = 'case_party'
             and p_person_id is distinct from p_case.applicant_person_id
             and not sgn_internal.person_has_task(p_case.id, p_person_id) then 'CASE_UNKNOWN'
        when a.actor_rule = 'applicant' and p_person_id is distinct from p_case.applicant_person_id then 'NOT_APPLICANT'
        when a.actor_rule = 'revoker' and not coalesce(
            p_person_id = p_case.applicant_person_id
            or p_person_id = sgn_internal.case_principal_owner(p_case)
            or exists (
                select 1 from sgn.case_task as t
                where t.case_id = p_case.id and t.assignee_person_id = p_person_id and t.status in ('approved', 'completed')
            )
            or exists (
                select 1
                from jsonb_array_elements_text(sgn_internal.setting('grant.revoker_roles', array['process:' || p_case.process_type])) as r (code)
                where sgn_internal.has_role(p_person_id, r.code)
            ),
            false
        ) then 'NOT_REVOKER'
        when a.actor_rule in ('assignee', 'claimant', 'fulfiller') and p_person_id = p_case.applicant_person_id then 'SELF_APPROVAL'
        when a.changes_state and sgn_internal.next_state(p_case.state, a.action) is null then 'STATE_TRANSITION'
        when a.actor_rule = 'assignee'
             and (sgn_internal.person_open_task(p_case.id, p_person_id, 'approval')).id is null then 'NOT_APPROVER'
        when a.actor_rule = 'fulfiller'
             and (sgn_internal.person_open_task(p_case.id, p_person_id, 'fulfilment')).id is null then 'NOT_FULFILLER'
        when a.actor_rule = 'claimant'
             and (sgn_internal.person_claimable_task(p_case.id, p_person_id)).id is null then 'NOT_CLAIMABLE'
        when a.actor_rule in ('assignee', 'fulfiller') then sgn_internal.decider_denial(
            p_case.id,
            p_person_id,
            (sgn_internal.person_open_task(
                p_case.id, p_person_id, case a.actor_rule when 'assignee' then 'approval' else 'fulfilment' end
            )).stage_id
        )
    end
    from (select 1) as one
    left join sgn.action as a on a.action = p_action
$$;

-- 這張單的路徑上執行關的代碼（流程包決定叫什麼）。
create function sgn_internal.case_fulfilment_stage_code(p_case sgn.request_case)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select ps.code from sgn.policy_stage as ps where ps.policy_id = p_case.policy_id and ps.phase = 'fulfilment' order by ps.seq limit 1
$$;

-- ── 授權結束（撤銷、到期）：唯一入口 ──

-- 撤銷：自動撤回外部系統上的規則；到期：外部系統依有效迄日擋下，再排一筆清除。人工執行的受管系統開例外並通知該系統的管理人。
create function sgn_internal.grant_end(p_case sgn.request_case, p_event text, p_actor uuid, p_reason text, p_rule_code text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_withdrawals int := 0;
    v_channel text;
begin
    perform sgn_internal.case_transition(p_case.id, case p_event when 'revoked' then 'revoke' else 'expire' end);
    update sgn.grant_record
    set status = p_event, ended_at = sgn_internal.now(), ended_by = p_actor, end_reason = p_reason
    where case_id = p_case.id and status = 'active';
    if p_event = 'revoked' then
        v_withdrawals := sgn_internal.delivery_withdraw_case(p_case.id);
    else
        for v_channel in select distinct o.channel from sgn.delivery_op as o where o.case_id = p_case.id and o.kind = 'apply' order by 1 loop
            perform sgn_internal.delivery_supersede(p_case.id, v_channel, sgn_internal.delivery_purge(v_channel));
        end loop;
    end if;
    perform sgn_internal.audit_append(
        'grant.' || p_event, p_case.id, p_actor,
        jsonb_build_object('version', p_case.current_version, 'reason', p_reason, 'withdrawals', v_withdrawals,
            'rules', jsonb_build_array(p_rule_code, 'K-DELIVERY-AUTO'))
    );
    perform sgn_internal.grant_manual_followup(p_case, p_event);
    perform sgn_internal.notify(
        'case.' || p_event, array[p_case.applicant_person_id, sgn_internal.case_principal_owner(p_case)], p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'reason', coalesce(p_reason, '-'))
    );
end;
$$;

-- 人工執行的受管系統：撤銷或縮小要有人到外部系統去做，開例外並通知該系統的管理人（不靜默）。
create function sgn_internal.grant_manual_followup(p_case sgn.request_case, p_event text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_scopes text[];
    v_people uuid[];
begin
    if p_event = 'expired' then
        return;
    end if;
    v_scopes := array(
        select s from unnest(sgn_internal.case_fulfilment_scopes(p_case, sgn_internal.case_fulfilment_stage_code(p_case))) as s
        where not sgn_internal.delivery_automated(s)
    );
    if cardinality(v_scopes) = 0 then
        return;
    end if;
    perform sgn_internal.exception_open('K-DELIVERY-MANUAL', p_case.id, jsonb_build_object('event', p_event, 'scopes', to_jsonb(v_scopes)));
    select coalesce(array_agg(distinct p), '{}') into v_people
    from unnest(v_scopes) as s
    cross join lateral unnest(sgn_internal.role_holders('system_custodian', s)) as p;
    perform sgn_internal.notify('delivery.manual_required', v_people, p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'event', p_event));
end;
$$;

create function api.case_revoke(p_session text, p_case_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
begin
    perform sgn_internal.authorize(v_person_id, 'revoke', v_case);
    if btrim(coalesce(p_reason, '')) = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED', 'revoke');
    end if;
    perform sgn_internal.grant_end(v_case, 'revoked', v_person_id, btrim(p_reason), 'K-GRANT-REVOKE');
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_revoke(text, uuid, text) is
    '使用者動作「撤銷」：生效中的授權立即結束，外部系統上的規則自動撤回（送不到時開例外並升級）。不需要簽核，必須填原因。'
    '申請人、被授權者負責人、這張單的簽核人或執行人、參數 grant.revoker_roles 的角色可以做。回傳申請單詳情。呼叫者：sgn_app。'
    '規則：K-GRANT-REVOKE、K-DELIVERY-AUTO、K-DELIVERY-ORDER';

-- ── 生效後縮小：縮小免簽（原則 ③），新的一版自動送出並重新驗證；驗證沒過就由系統撤銷 ──

create function api.case_reduce(p_session text, p_case_id uuid, p_content jsonb, p_terms jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_prepared jsonb;
begin
    perform sgn_internal.authorize(v_person_id, 'reduce', v_case);
    if btrim(coalesce(p_reason, '')) = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED', 'reduce');
    end if;
    v_prepared := sgn_internal.decision_input(v_case, 'approve_reduced',
        jsonb_build_object('content', p_content)
        || case when coalesce(p_terms, 'null'::jsonb) = 'null'::jsonb then '{}'::jsonb else jsonb_build_object('terms', p_terms) end);
    if sgn_internal.grant_has_manual_delivery(v_case) then
        perform sgn_internal.raise_error('DELIVERY_MANUAL_ONLY');
    end if;
    perform sgn_internal.version_store(p_case_id, v_prepared, 'reduce', v_person_id);
    perform sgn_internal.case_transition(p_case_id, 'reduce');
    perform sgn_internal.grant_reduce_deliver(sgn_internal.case_lock(p_case_id), v_person_id, btrim(p_reason));
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_reduce(text, uuid, jsonb, jsonb, text) is
    '使用者動作「縮小」：生效中的授權只做縮小（欄位、列條件、期間、匯出、授權迄日），不用重簽；新的一版自動送出並重新驗證，'
    '驗證沒過由系統撤銷。人工執行的受管系統不能直接縮小。誰可以做同撤銷。回傳申請單詳情。呼叫者：sgn_app。'
    '規則：K-GRANT-REDUCE、K-CHANGE-REDUCE、K-DELIVERY-AUTO、K-VERIFY-AUTO';

create function sgn_internal.grant_has_manual_delivery(p_case sgn.request_case)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1
        from unnest(sgn_internal.case_fulfilment_scopes(p_case, sgn_internal.case_fulfilment_stage_code(p_case))) as s
        where not sgn_internal.delivery_automated(s)
    )
$$;

-- 縮小後的一版：授權改綁新版本，每個曾經送過的通道送新的一版（縮小到沒有內容的通道改送撤回）。
create function sgn_internal.grant_reduce_deliver(p_case sgn.request_case, p_actor uuid, p_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_terms jsonb := (select v.terms from sgn.case_version as v where v.case_id = p_case.id and v.version = p_case.current_version);
    v_payload jsonb := sgn_internal.hook_fulfilment(p_case.process_type, p_case.id);
    v_channel text;
    v_scopes text[];
    v_body jsonb;
begin
    insert into sgn.fulfilment (case_id, version, payload, payload_sha256, created_at)
    values (p_case.id, p_case.current_version, v_payload, sgn_internal.jcs_sha256(v_payload), sgn_internal.now());
    update sgn.grant_record
    set version = p_case.current_version, valid_to = sgn_internal.try_date(v_terms ->> 'valid_to')
    where case_id = p_case.id and status = 'active';
    for v_channel in select distinct o.channel from sgn.delivery_op as o where o.case_id = p_case.id and o.kind = 'apply' order by 1 loop
        v_scopes := array(
            select s from unnest(sgn_internal.case_fulfilment_scopes(p_case, sgn_internal.case_fulfilment_stage_code(p_case))) as s
            where sgn_internal.delivery_automated(s) and sgn_internal.setting('delivery.channel', array[s]) #>> '{}' = v_channel
        );
        v_body := case when cardinality(v_scopes) > 0 then sgn_internal.hook_build_delivery(p_case.process_type, p_case.id, v_scopes) end;
        perform sgn_internal.delivery_supersede(p_case.id, v_channel, null);
        if v_body is null then
            perform sgn_internal.delivery_op_create(v_channel, 'withdraw', p_case.id, p_case.current_version,
                jsonb_build_object('case_no', p_case.case_no::text));
        else
            perform sgn_internal.delivery_op_create(v_channel, 'apply', p_case.id, p_case.current_version, v_body);
        end if;
    end loop;
    perform sgn_internal.audit_append(
        'grant.reduced', p_case.id, p_actor,
        jsonb_build_object('version', p_case.current_version, 'terms', v_terms, 'reason', p_reason,
            'payload_sha256', encode(sgn_internal.jcs_sha256(v_payload), 'hex'),
            'rules', jsonb_build_array('K-GRANT-REDUCE', 'K-CHANGE-REDUCE', 'K-DELIVERY-AUTO'))
    );
    perform sgn_internal.notify(
        'case.reduced_active', array[p_case.applicant_person_id, sgn_internal.case_principal_owner(p_case)], p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'reason', p_reason)
    );
end;
$$;

-- ── 到期：排程（sgn_job）把授權迄日已過的授權結束，並排清除 ──

create function sgn_internal.grant_expire_due()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case_id uuid;
    v_count int := 0;
begin
    for v_case_id in
        select g.case_id from sgn.grant_record as g
        where g.status = 'active' and g.valid_to < sgn_internal.today()
        order by g.valid_to, g.case_id
        for update skip locked
    loop
        perform sgn_internal.grant_end(sgn_internal.case_lock(v_case_id), 'expired', null, null, 'K-GRANT-EXPIRE');
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;
