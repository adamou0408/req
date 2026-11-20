-- 申請人確認驗證結果（rules.md「驗證中：系統自動測試……再由申請人確認。兩者都通過才結案生效」「申請人逾期沒有確認驗證結果，
-- 自動撤銷」；裁決 D80 (4)；骨幹 §2 case_confirmation、§3 requires_confirmation、§5.5 K-CONFIRM、§8 confirmation.due_workdays）。
--
-- 狀態照骨幹 §4.1：verifying 是「驗證中或等確認」，不另開狀態；等確認這一段由 sgn.case_confirmation 的一筆 pending 表示。
--   自動驗證全部通過、執行關完成 → 流程類型選了 requires_confirmation 時開一筆確認（時限是參數），授權還不產生；
--   申請人確認 → 生效（產生授權）；申請人回報不對 → 不生效（fulfilment_failed）、撤回已送出的、開例外、通知；
--   逾期沒確認 → 自動撤銷（revoked）、撤回已送出的，事件寫明規則代碼與用到的參數值。
-- 等確認時，外部系統上的規則已經套用（自動驗證要對真的權限查），所以撤銷（縮小到零）也開放；撤回走既有的 outbox。
-- 誰可以確認：骨幹附錄 B「資料授權只有申請人」（confirmation_parties），授權判斷在 denial_reason。

insert into sgn.state_transition (entity, from_state, action, to_state) values
    ('case', 'verifying', 'confirm_verification', 'active'),
    ('case', 'verifying', 'dispute_verification', 'fulfilment_failed'),
    ('case', 'verifying', 'confirmation_expire', 'revoked'),
    ('case', 'verifying', 'revoke', 'revoked'),
    ('confirmation', 'pending', 'confirm', 'confirmed'),
    ('confirmation', 'pending', 'dispute', 'disputed'),
    ('confirmation', 'pending', 'expire', 'expired'),
    ('confirmation', 'pending', 'cancel', 'cancelled');

insert into sgn.action (action, scope, actor_rule, role_setting, denied_code, needs_proof, changes_state) values
    ('confirm_verification', 'case', 'applicant', null, null, false, true),
    ('dispute_verification', 'case', 'applicant', null, null, false, true),
    ('confirmation_expire', 'case', 'system', null, null, false, true);

insert into sgn.error_catalog (code, message, http_status) values
    ('CONFIRMATION_NOT_OPEN', '這張單現在不是等申請人確認驗證結果的階段（自動驗證還沒全部通過，或已經確認過）', 409),
    ('CONFIRMATION_OVERDUE', '確認期限已過，這筆授權會由系統自動撤銷；還需要的話請重新申請', 409);

select sgn_internal.register_setting_definition(
    'confirmation.due_workdays', 'integer', '5', array['process'],
    '自動驗證通過後，申請人要在幾個工作天內確認驗證結果；逾期沒確認，系統自動撤銷（rules.md「驗證結果確認時限」，K-CONFIRM-TIMEOUT）'
);

-- ── 流程類型的選項（骨幹 §3）：流程包以 sgn_sdk 合併登記，不必重登整個流程類型 ──

create function sgn_internal.register_process_options(p_process_type text, p_options jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    if jsonb_typeof(p_options) is distinct from 'object' then
        perform sgn_internal.registration_fail(p_process_type || ': options');
    end if;
    update sgn.process_type set options = options || p_options where code = p_process_type;
    if not found then
        perform sgn_internal.registration_fail(p_process_type || ': unknown process type');
    end if;
end;
$$;

create function sgn_sdk.register_process_options(p_process_type text, p_options jsonb)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_process_options(p_process_type, p_options)
$$;

revoke all on function sgn_sdk.register_process_options(text, jsonb) from public;

-- ── 確認紀錄（骨幹 case_confirmation：確認人、時間）：一張單同時最多一筆 pending ──

create table sgn.case_confirmation (
    id bigint generated always as identity primary key,
    case_id uuid not null references sgn.request_case (id),
    version int not null,
    status text not null,
    opened_at timestamptz not null,
    -- 開的時候就算好（之後改參數不影響已經開的確認）；用到的參數值記在 settings 與稽核事件
    due_at timestamptz not null,
    settings jsonb not null,
    decided_by uuid references sgn.person (id),
    decided_at timestamptz,
    reason text
);

create unique index case_confirmation_one_pending on sgn.case_confirmation (case_id) where status = 'pending';
create index case_confirmation_due_idx on sgn.case_confirmation (due_at) where status = 'pending';

create function sgn_internal.case_confirmation_pending(p_case_id uuid)
returns sgn.case_confirmation
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from sgn.case_confirmation where case_id = p_case_id and status = 'pending'
$$;

-- 兩個日期之間（不含起日、含迄日）有幾個工作天：畫面的「剩幾個工作天」由資料庫算。
create function sgn_internal.workdays_between(p_from date, p_to date)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select count(*)::int
    from generate_series(p_from + 1, p_to, interval '1 day') as d (day)
    where sgn_internal.is_workday(d.day::date)
$$;

create function sgn_internal.local_minute_text(p_at timestamptz)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select to_char(p_at at time zone sgn_internal.setting_text('calendar.timezone'), 'YYYY-MM-DD HH24:MI')
$$;

-- 開一筆確認：時限取參數（流程類型 → 全域 → 預設），進鏈並通知申請人。授權在確認後才產生（rules.md「兩者都通過才結案生效」）。
create function sgn_internal.confirmation_open(p_case sgn.request_case)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_workdays int := (sgn_internal.setting('confirmation.due_workdays', array['process:' || p_case.process_type]) #>> '{}')::int;
    v_due timestamptz := sgn_internal.add_workdays(sgn_internal.now(), v_workdays);
    v_settings jsonb := jsonb_build_object('confirmation.due_workdays', v_workdays);
    v_runs jsonb := (
        select coalesce(jsonb_agg(r.id order by r.id), '[]'::jsonb) from sgn.verification_run as r
        where r.case_id = p_case.id and r.version = p_case.current_version and r.status = 'passed'
    );
begin
    if sgn_internal.case_confirmation_pending(p_case.id) is not null then
        return;
    end if;
    insert into sgn.case_confirmation (case_id, version, status, opened_at, due_at, settings)
    values (p_case.id, p_case.current_version, 'pending', sgn_internal.now(), v_due, v_settings);
    perform sgn_internal.audit_append(
        'confirmation.opened', p_case.id, null,
        jsonb_build_object('version', p_case.current_version, 'due_at', v_due, 'verification_runs', v_runs,
            'settings', v_settings, 'rules', jsonb_build_array('K-CONFIRM', 'K-VERIFY-AUTO'))
    );
    perform sgn_internal.notify(
        'confirmation.requested', array[p_case.applicant_person_id], p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'due', sgn_internal.local_minute_text(v_due),
            'cases', (select count(*) from sgn.verification_run as r cross join jsonb_array_elements(r.cases)
                      where r.case_id = p_case.id and r.version = p_case.current_version and r.status = 'passed')::text)
    );
end;
$$;

-- 結束這張單的那筆確認（確認、回報不對、逾期、撤銷時作廢），進鏈。沒有 pending 的確認時不動作，回傳 false。
create function sgn_internal.confirmation_close(p_case_id uuid, p_action text, p_actor uuid, p_reason text)
returns boolean
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_conf sgn.case_confirmation;
begin
    select * into v_conf from sgn.case_confirmation where case_id = p_case_id and status = 'pending' for update;
    if v_conf.id is null then
        return false;
    end if;
    update sgn.case_confirmation
    set status = sgn_internal.entity_transition('confirmation', status, p_action),
        decided_by = p_actor, decided_at = sgn_internal.now(), reason = p_reason
    where id = v_conf.id
    returning * into v_conf;
    perform sgn_internal.audit_append(
        'confirmation.' || v_conf.status, p_case_id, p_actor,
        jsonb_build_object('version', v_conf.version, 'opened_at', v_conf.opened_at, 'due_at', v_conf.due_at, 'reason', p_reason,
            'settings', v_conf.settings,
            'rules', jsonb_build_array(case p_action when 'dispute' then 'K-CONFIRM-DISPUTE' when 'expire' then 'K-CONFIRM-TIMEOUT' else 'K-CONFIRM' end))
    );
    return true;
end;
$$;

-- 確認結束而不生效（回報不對、逾期）：撤回已送出的、人工系統通知管理人、進鏈、通知。狀態轉移由呼叫者先做。
create function sgn_internal.confirmation_unwind(p_case sgn.request_case, p_event text, p_actor uuid, p_detail jsonb, p_rule_code text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_withdrawals int := sgn_internal.delivery_withdraw_case(p_case.id);
begin
    perform sgn_internal.audit_append(
        'case.' || p_event, p_case.id, p_actor,
        p_detail || jsonb_build_object('version', p_case.current_version, 'withdrawals', v_withdrawals,
            'rules', jsonb_build_array(p_rule_code, 'K-DELIVERY-AUTO'))
    );
    perform sgn_internal.grant_manual_followup(p_case, 'revoked');
end;
$$;

-- ── 授權檢查的唯一入口（同 420 的簽章）：確認、回報不對、等確認時的撤銷只在有 pending 的確認時可以做；逾期不能再確認 ──

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
        -- 驗證中：自動驗證還在跑的時候不能確認、回報或撤銷；要等全部通過、開了確認（K-CONFIRM）
        when p_case.state = 'verifying' and a.action in ('confirm_verification', 'dispute_verification', 'revoke')
             and (sgn_internal.case_confirmation_pending(p_case.id)).id is null then 'CONFIRMATION_NOT_OPEN'
        -- 逾期之後不能再確認（排程或交付程式稍後自動撤銷；K-CONFIRM-TIMEOUT）；回報不對仍可以
        when a.action = 'confirm_verification'
             and (sgn_internal.case_confirmation_pending(p_case.id)).due_at <= sgn_internal.now() then 'CONFIRMATION_OVERDUE'
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

-- ── 往下一個適用的關卡走（同 420 的簽章）：驗證中的單在執行關完成後，選了 requires_confirmation 的流程開確認，否則生效 ──

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
            elsif v_case.state = 'verifying' and sgn_internal.process_option(v_case.process_type, 'requires_confirmation') then
                perform sgn_internal.confirmation_open(v_case);
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

-- ── 授權結束（同 420 的簽章）：等確認時被撤銷，那筆確認作廢 ──

create or replace function sgn_internal.grant_end(p_case sgn.request_case, p_event text, p_actor uuid, p_reason text, p_rule_code text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_withdrawals int := 0;
    v_channel text;
begin
    perform sgn_internal.case_transition(p_case.id, case p_event when 'revoked' then 'revoke' else 'expire' end);
    perform sgn_internal.confirmation_close(p_case.id, 'cancel', p_actor, p_reason);
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

-- ── 生效後縮小（同 420 的簽章）：新的一版的內容指紋也要進鏈（和縮小後核准同一個事件 case.reduced），
-- 稽核頁與離線工具才驗得出「目前的內容就是鏈上記下的最新一版」（K-AUDIT-CHAIN；420 漏記，畫面開放縮小後才在端對端測試發現）──

create or replace function api.case_reduce(p_session text, p_case_id uuid, p_content jsonb, p_terms jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_prepared jsonb;
    v_version int;
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
    v_version := sgn_internal.version_store(p_case_id, v_prepared, 'reduce', v_person_id);
    perform sgn_internal.audit_append(
        'case.reduced', p_case_id, v_person_id,
        jsonb_build_object(
            'from_version', v_case.current_version,
            'version', v_version,
            'content_sha256', v_prepared ->> 'content_sha256',
            'version_sha256', v_prepared ->> 'version_sha256',
            'tier', v_prepared ->> 'tier',
            'change_kind', 'reduce',
            'rules', jsonb_build_array('K-GRANT-REDUCE', 'K-CHANGE-REDUCE')
        )
    );
    perform sgn_internal.case_transition(p_case_id, 'reduce');
    perform sgn_internal.grant_reduce_deliver(sgn_internal.case_lock(p_case_id), v_person_id, btrim(p_reason));
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_reduce(text, uuid, jsonb, jsonb, text) is
    '使用者動作「縮小」：生效中的授權只做縮小（欄位、列條件、期間、匯出、授權迄日），不用重簽；新的一版的內容指紋進鏈，自動送出並重新驗證，'
    '驗證沒過由系統撤銷。人工執行的受管系統不能直接縮小。誰可以做同撤銷。回傳申請單詳情。呼叫者：sgn_app。'
    '規則：K-GRANT-REDUCE、K-CHANGE-REDUCE、K-DELIVERY-AUTO、K-VERIFY-AUTO';

-- ── 使用者動作 ──

create function api.case_confirm_verification(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
begin
    perform sgn_internal.authorize(v_person_id, 'confirm_verification', v_case);
    perform sgn_internal.confirmation_close(p_case_id, 'confirm', v_person_id, null);
    perform sgn_internal.case_transition(p_case_id, 'confirm_verification');
    perform sgn_internal.grant_activate(v_case);
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_confirm_verification(text, uuid) is
    '使用者動作「確認驗證結果」：自動驗證全部通過、開了確認之後，申請人本人確認外部系統上的結果正確，授權才生效。'
    '不是簽核決定，不需要通行金鑰；逾期不能確認。只有申請人可以做（骨幹附錄 B：資料授權的 confirmation_parties 只有申請人）。'
    '回傳申請單詳情。呼叫者：sgn_app。規則：K-CONFIRM';

create function api.case_dispute_verification(p_session text, p_case_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
begin
    perform sgn_internal.authorize(v_person_id, 'dispute_verification', v_case);
    if btrim(coalesce(p_reason, '')) = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED', 'dispute_verification');
    end if;
    perform sgn_internal.confirmation_close(p_case_id, 'dispute', v_person_id, btrim(p_reason));
    perform sgn_internal.case_transition(p_case_id, 'dispute_verification');
    perform sgn_internal.exception_open('K-CONFIRM-DISPUTE', p_case_id,
        jsonb_build_object('version', v_case.current_version, 'reason', btrim(p_reason)));
    perform sgn_internal.confirmation_unwind(v_case, 'verification_disputed', v_person_id,
        jsonb_build_object('reason', btrim(p_reason)), 'K-CONFIRM-DISPUTE');
    perform sgn_internal.notify(
        'confirmation.disputed',
        sgn_internal.delivery_escalation_people() || array[v_case.applicant_person_id, sgn_internal.case_principal_owner(v_case)],
        p_case_id, jsonb_build_object('case_no', v_case.case_no::text, 'reason', btrim(p_reason))
    );
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_dispute_verification(text, uuid, text) is
    '使用者動作「驗證結果不對」：申請人回報外部系統上的實際權限和他要的不一樣。不生效、已送出的規則自動撤回、開例外 K-CONFIRM-DISPUTE，'
    '通知升級對象（delivery.escalation_roles）、申請人與被授權者負責人。必須填原因；不需要通行金鑰。只有申請人可以做。'
    '回傳申請單詳情。呼叫者：sgn_app。規則：K-CONFIRM-DISPUTE、K-DELIVERY-AUTO';

-- ── 逾期自動撤銷：排程（sgn_job）與交付程式的領取（sgn_delivery）兩個入口，任一個停擺都擋不住 ──

create function sgn_internal.confirmation_expire_due()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_conf sgn.case_confirmation;
    v_case sgn.request_case;
    v_count int := 0;
begin
    for v_conf in
        select * from sgn.case_confirmation as c
        where c.status = 'pending' and c.due_at <= sgn_internal.now()
        order by c.due_at, c.id
        for update skip locked
    loop
        v_case := sgn_internal.case_lock(v_conf.case_id);
        perform sgn_internal.confirmation_close(v_case.id, 'expire', null, null);
        perform sgn_internal.case_transition(v_case.id, 'confirmation_expire');
        perform sgn_internal.confirmation_unwind(v_case, 'confirmation_expired', null,
            jsonb_build_object('due_at', v_conf.due_at, 'settings', v_conf.settings), 'K-CONFIRM-TIMEOUT');
        perform sgn_internal.notify(
            'confirmation.expired', array[v_case.applicant_person_id, sgn_internal.case_principal_owner(v_case)], v_case.id,
            jsonb_build_object('case_no', v_case.case_no::text, 'due', sgn_internal.local_minute_text(v_conf.due_at))
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

create function api_job.confirmation_expire_due()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('expired', sgn_internal.confirmation_expire_due());
end;
$$;

comment on function api_job.confirmation_expire_due() is
    '確認期限（confirmation.due_workdays，開確認時算好）已過還沒確認的單自動撤銷，外部系統上的規則自動撤回；事件寫明規則代碼與用到的參數值。'
    '交付程式的領取也會檢查（排程停擺也擋不住）。呼叫者：sgn_job（db/tools/jobs.mjs）。規則：K-CONFIRM-TIMEOUT';

-- 交付程式的領取（同 410 的簽章）：先處理逾期的確認，讓撤回和其他交付在同一輪送出。
create or replace function sgn_internal.delivery_claim(p_channel text, p_limit int)
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
    perform sgn_internal.confirmation_expire_due();
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

-- ── 申請單詳情（同 430 的簽章）：多了 confirmation（確認畫面的剩餘工作天由資料庫算）──

create function sgn_internal.case_confirmation_view(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'status', c.status,
        'version', c.version,
        'opened_at', c.opened_at,
        'due_at', c.due_at,
        'due_text', sgn_internal.local_minute_text(c.due_at),
        'workdays_left', case when c.status = 'pending' then sgn_internal.workdays_between(
            sgn_internal.today(), (c.due_at at time zone sgn_internal.setting_text('calendar.timezone'))::date) end,
        'due_workdays', (c.settings ->> 'confirmation.due_workdays')::int,
        'decided_at', c.decided_at,
        'decided_by', case when c.decided_by is not null then sgn_internal.person_display(c.decided_by) end,
        'reason', c.reason
    )
    from sgn.case_confirmation as c
    where c.case_id = p_case_id
    order by c.id desc
    limit 1
$$;

create or replace function sgn_internal.case_detail(p_case_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.case_summary(p_case_id, p_person_id) || jsonb_build_object(
        'stages', sgn_internal.case_stages_view(p_case_id),
        'versions', sgn_internal.case_versions_view(p_case_id),
        'overlap', sgn_internal.case_overlap_current(p_case_id),
        'fulfilment', (
            select jsonb_build_object('version', f.version, 'payload', f.payload, 'payload_sha256', encode(f.payload_sha256, 'hex'))
            from sgn.fulfilment as f
            where f.case_id = p_case_id
            order by f.id desc
            limit 1
        ),
        'grant', (
            select jsonb_build_object('grant_id', g.id, 'valid_from', g.valid_from, 'valid_to', g.valid_to, 'status', g.status)
            from sgn.grant_record as g
            where g.case_id = p_case_id
        ),
        'display', sgn_internal.case_display(p_case_id, p_person_id),
        'duplicates', sgn_internal.case_duplicates(p_case_id),
        'path', sgn_internal.case_path(p_case_id),
        'resubmit', sgn_internal.case_resubmit_preview(p_case_id),
        'delivery', sgn_internal.case_delivery_view(p_case_id),
        'confirmation', sgn_internal.case_confirmation_view(p_case_id)
    );
end;
$$;

-- ── 規則代碼與通知範本 ──

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-CONFIRM',
        '流程類型選了 requires_confirmation：自動驗證全部通過後不直接生效，開一筆確認；只有申請人本人能確認（資料授權的 confirmation_parties），'
        '確認後才產生授權並生效；自動驗證還沒通過、已經結束或逾期都不能確認',
        'partial', '骨幹的 confirmation_parties 其他選項（負責人、指定成員）與 confirmation_prompt 沒做；人工執行的退路沒有自動驗證，不開確認'),
    ('K-CONFIRM-DISPUTE',
        '申請人回報驗證結果不對：不生效、已送出的規則自動撤回、開例外並通知升級對象、申請人與被授權者負責人；必須填原因',
        'full', null),
    ('K-CONFIRM-TIMEOUT',
        '確認期限（參數 confirmation.due_workdays，工作天，開確認時算好）已過還沒確認就自動撤銷並撤回；事件寫明規則代碼、期限與用到的參數值；'
        '排程與交付程式的領取兩個入口',
        'partial', '骨幹 K-CONFIRM 的逾期前提醒（逐日擴大、撤銷前一天明說）與 confirmation_timeout_action = remind 沒做'),
    ('K-VERIFY-AUTO',
        '每筆套用成功後自動驗證：案例由流程包從送出的規則產生（範圍內應允許、範圍外應拒絕），由核心比對；不一致不得生效，開例外並撤回；'
        '全部通過後由申請人確認（K-CONFIRM）',
        'full', null),
    ('K-GRANT-REDUCE', '生效中的授權只做縮小時不用重簽；新的一版自動送出並重新驗證，驗證沒過由系統撤銷', 'full', null),
    ('K-FULFIL',
        '核准後產生交付內容；人工執行時執行人標記完成（需決定證明）後才產生授權並生效，交付的就是核准的那一版',
        'partial', '系統對系統的交付見 K-DELIVERY-AUTO，生效前的申請人確認見 K-CONFIRM')
) as r (code, description, coverage, note);

insert into sgn.notification_template (event_code, subject, body) values
    ('confirmation.requested', '請確認驗證結果：{{case_no}}',
        '{{case_no}} 已自動送到外部系統並通過自動驗證（{{cases}} 項）。請在 {{due}} 前打開申請單確認結果是不是你要的；'
        '確認後授權才生效。逾期沒有確認，系統會自動撤銷。'),
    ('confirmation.disputed', '申請人回報驗證結果不對：{{case_no}}',
        '{{case_no}} 的申請人回報外部系統上的實際權限和申請的不一樣：{{reason}}。這張單不會生效，已送出的規則會自動撤回，並已開例外。'),
    ('confirmation.expired', '逾期沒有確認，授權已自動撤銷：{{case_no}}',
        '{{case_no}} 在 {{due}} 前沒有確認驗證結果，系統依規則自動撤銷，外部系統上的權限會自動撤回。還需要的話請重新申請。');
