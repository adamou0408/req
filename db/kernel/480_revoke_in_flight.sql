-- 紅隊第五輪的修復之一（裁決 D84 (4)、(6)、(8)；redteam/findings-5.md 中-1、資訊 1）。
--
-- (4) 權限一旦可能已在外部系統上（待套用、驗證中），有權撤銷的人都能撤銷（rules.md「撤銷：等於縮小到零，所以申請人、
--     負責人、任一位簽核人、MIS 都可以直接撤銷」）：撤回並作廢未完成的交付；撤銷時正在送的套用與驗證一併作廢
--     （交付程式之後的回報不再被採信，也不會再被重送；外部系統收到撤回＝封存整張單，晚到的套用一律 409）。
--     第四輪之前只開了 active 與「驗證中而且已開確認」：交付程式（或網路上的人）謊稱連不上，就能讓權限留在外部系統上而沒有人撤銷得了。
-- (8) 人工執行的單也開申請人確認（D83 (4)）：人工執行沒有自動驗證，確認是唯一的驗證；執行人標記已套用後轉驗證中、開確認。
-- (6) 等確認的提醒不只靠郵件：首頁的待辦（站內）直接從資料庫取剩幾個工作天與是不是快到期；排程在期限前逐日提醒，
--     提醒對象逐日擴大（最後一天加上主管與被授權者負責人），每一次都進鏈。

insert into sgn.state_transition (entity, from_state, action, to_state) values
    ('case', 'pending_fulfilment', 'revoke', 'revoked'),
    ('case', 'pending_fulfilment', 'manual_applied', 'verifying'),
    ('delivery_op', 'sending', 'supersede', 'superseded');

insert into sgn.action (action, scope, actor_rule, role_setting, denied_code, needs_proof, changes_state) values
    ('manual_applied', 'case', 'system', null, null, false, true);

select sgn_internal.register_setting_definition(
    'confirmation.remind_workdays_before', 'integer', '2', array['process'],
    '確認期限前幾個工作天開始提醒（每個工作天一次；最後一個工作天另外通知申請人的主管與被授權者負責人，K-CONFIRM-REMIND）'
);

-- ── 撤銷時正在送的套用與驗證一併作廢 ──

-- 這張單在這個通道上正在送（sending）的套用與驗證：作廢、收回租約。交付程式之後的回報會因租約不符被拒（DELIVERY_LEASE），
-- 也不會被重新領取或排回重送（findings-5 資訊 1：「重送」的回報原本會排回佇列，撤銷後仍送出）。
create function sgn_internal.delivery_void_in_flight(p_case_id uuid, p_channel text, p_by bigint)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_op sgn.delivery_op;
    v_count int := 0;
begin
    for v_op in
        select * from sgn.delivery_op as o
        where o.case_id = p_case_id and o.channel = p_channel and o.kind in ('apply', 'verify') and o.status = 'sending'
        order by o.id
        for update
    loop
        update sgn.delivery_op
        set status = sgn_internal.entity_transition('delivery_op', v_op.status, 'supersede'), superseded_by = p_by,
            lease_token = null, lease_until = null, nonce = null, finished_at = sgn_internal.now()
        where id = v_op.id;
        update sgn.verification_run
        set status = sgn_internal.entity_transition('verification_run', status, 'cancel'), finished_at = sgn_internal.now()
        where (op_id = v_op.id or apply_op_id = v_op.id) and status = 'pending';
        perform sgn_internal.audit_append(
            'delivery.superseded', p_case_id, null,
            jsonb_build_object('op', v_op.id, 'by', p_by, 'kind', v_op.kind, 'channel', p_channel, 'in_flight', true,
                'attempts', v_op.attempts, 'rules', jsonb_build_array('K-DELIVERY-ORDER', 'K-GRANT-REVOKE'))
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- 一張單在各通道的撤回（同 410 的簽章）：曾經送出過套用的通道排一筆撤回；還沒送出的套用與驗證作廢；
-- 正在送的也作廢（撤回＝封存整張單，外部系統之後不收這張單的任何套用，所以不必等正在送的有結果）。回傳排了幾筆撤回。
create or replace function sgn_internal.delivery_withdraw_case(p_case_id uuid)
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
        perform sgn_internal.delivery_void_in_flight(p_case_id, v_channel, v_op);
    end loop;
    return v_count;
end;
$$;

-- ── 授權檢查的唯一入口（同 470 的簽章）：撤銷不再要求「已開確認」；確認與回報不對仍要 ──

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
        -- 驗證中：自動驗證還在跑的時候不能確認或回報；要等全部通過、開了確認（K-CONFIRM）。撤銷隨時可以（K-GRANT-REVOKE，裁決 D84 (4)）
        when p_case.state = 'verifying' and a.action in ('confirm_verification', 'dispute_verification')
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

-- ── 授權結束（同 470 的簽章）：待套用、驗證中被撤銷時，開著的執行關一併收掉（人工的工作作廢） ──

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
    if p_case.state in ('pending_fulfilment', 'verifying') then
        perform sgn_internal.stages_close_open(p_case.id, 'cancelled', p_event);
    end if;
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
        jsonb_build_object('version', p_case.current_version, 'reason', p_reason, 'withdrawals', v_withdrawals, 'from_state', p_case.state,
            'rules', jsonb_build_array(p_rule_code, 'K-DELIVERY-AUTO'))
    );
    perform sgn_internal.grant_manual_followup(p_case, p_event);
    perform sgn_internal.notify(
        'case.' || p_event, array[p_case.applicant_person_id, sgn_internal.case_principal_owner(p_case)], p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'reason', coalesce(p_reason, '-'))
    );
end;
$$;

-- ── 開確認（同 470 的簽章）：人工執行的單沒有自動驗證，通知的文字不同 ──

create or replace function sgn_internal.confirmation_open(p_case sgn.request_case)
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
    v_manual boolean := v_runs = '[]'::jsonb;
begin
    if sgn_internal.case_confirmation_pending(p_case.id) is not null then
        return;
    end if;
    insert into sgn.case_confirmation (case_id, version, status, opened_at, due_at, settings)
    values (p_case.id, p_case.current_version, 'pending', sgn_internal.now(), v_due, v_settings);
    perform sgn_internal.audit_append(
        'confirmation.opened', p_case.id, null,
        jsonb_build_object('version', p_case.current_version, 'due_at', v_due, 'verification_runs', v_runs, 'manual', v_manual,
            'settings', v_settings, 'rules', jsonb_build_array('K-CONFIRM', case when v_manual then 'K-CONFIRM-MANUAL' else 'K-VERIFY-AUTO' end))
    );
    perform sgn_internal.notify(
        case when v_manual then 'confirmation.requested_manual' else 'confirmation.requested' end,
        array[p_case.applicant_person_id], p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'due', sgn_internal.local_minute_text(v_due),
            'cases', (select count(*) from sgn.verification_run as r cross join jsonb_array_elements(r.cases)
                      where r.case_id = p_case.id and r.version = p_case.current_version and r.status = 'passed')::text)
    );
end;
$$;

-- ── 往下一個適用的關卡走（同 470 的簽章）：執行關完成時，選了 requires_confirmation 的流程一律開確認；
-- 人工執行的單（沒有自動交付，還在待套用）先轉驗證中（K-CONFIRM-MANUAL） ──

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
            elsif v_case.state in ('pending_fulfilment', 'verifying') and sgn_internal.process_option(v_case.process_type, 'requires_confirmation') then
                if v_case.state = 'pending_fulfilment' then
                    perform sgn_internal.case_transition(p_case_id, 'manual_applied');
                    perform sgn_internal.audit_append('case.manual_applied', p_case_id, null,
                        jsonb_build_object('version', v_case.current_version, 'rules', jsonb_build_array('K-CONFIRM-MANUAL', 'K-FULFIL')));
                    select * into v_case from sgn.request_case where id = p_case_id;
                end if;
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

-- ── 期限前的提醒（K-CONFIRM-REMIND）：每個工作天一次，進鏈；最後一個工作天加上主管與被授權者負責人 ──

create table sgn.case_confirmation_reminder (
    confirmation_id bigint not null references sgn.case_confirmation (id),
    workdays_left int not null,
    sent_at timestamptz not null,
    recipients jsonb not null,
    primary key (confirmation_id, workdays_left)
);

-- 這筆確認剩幾個工作天（含今天之後到期日；畫面與提醒共用）。
create function sgn_internal.confirmation_workdays_left(p_conf sgn.case_confirmation)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.workdays_between(
        sgn_internal.today(), (p_conf.due_at at time zone sgn_internal.setting_text('calendar.timezone'))::date)
$$;

-- 這筆確認是不是已經在提醒期間（畫面的待辦標「快到期」也用它）。
create function sgn_internal.confirmation_reminding(p_conf sgn.case_confirmation, p_process_type text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p_conf.status = 'pending'
       and sgn_internal.confirmation_workdays_left(p_conf)
           <= (sgn_internal.setting('confirmation.remind_workdays_before', array['process:' || p_process_type]) #>> '{}')::int
$$;

create function sgn_internal.confirmation_remind_due()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_conf sgn.case_confirmation;
    v_case sgn.request_case;
    v_left int;
    v_before int;
    v_people uuid[];
    v_count int := 0;
begin
    for v_conf in
        select * from sgn.case_confirmation as c where c.status = 'pending' and c.due_at > sgn_internal.now() order by c.due_at, c.id
    loop
        select * into v_case from sgn.request_case where id = v_conf.case_id;
        v_left := sgn_internal.confirmation_workdays_left(v_conf);
        v_before := (sgn_internal.setting('confirmation.remind_workdays_before', array['process:' || v_case.process_type]) #>> '{}')::int;
        if v_left > v_before
           or exists (select 1 from sgn.case_confirmation_reminder as r where r.confirmation_id = v_conf.id and r.workdays_left = v_left) then
            continue;
        end if;
        v_people := array[v_case.applicant_person_id];
        if v_left <= 1 then
            v_people := v_people || array_remove(array[
                (sgn_internal.resolve_manager(v_case.applicant_person_id)).manager_person_id,
                sgn_internal.case_principal_owner(v_case)], null);
        end if;
        select coalesce(array_agg(distinct p), '{}') into v_people from unnest(v_people) as p;
        insert into sgn.case_confirmation_reminder (confirmation_id, workdays_left, sent_at, recipients)
        values (v_conf.id, v_left, sgn_internal.now(), to_jsonb(v_people));
        perform sgn_internal.audit_append(
            'confirmation.reminded', v_case.id, null,
            jsonb_build_object('confirmation', v_conf.id, 'due_at', v_conf.due_at, 'workdays_left', v_left, 'recipients', to_jsonb(v_people),
                'settings', jsonb_build_object('confirmation.remind_workdays_before', v_before), 'rules', jsonb_build_array('K-CONFIRM-REMIND'))
        );
        perform sgn_internal.notify(
            'confirmation.reminder', v_people, v_case.id,
            jsonb_build_object('case_no', v_case.case_no::text, 'due', sgn_internal.local_minute_text(v_conf.due_at), 'days', v_left::text)
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

create function api_job.confirmation_remind_due()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('reminded', sgn_internal.confirmation_remind_due());
end;
$$;

comment on function api_job.confirmation_remind_due() is
    '確認期限前 confirmation.remind_workdays_before 個工作天起，每個工作天提醒一次還沒確認的申請人（最後一個工作天加上主管與被授權者負責人），'
    '每一次進鏈；首頁的站內待辦同時標出快到期（不只靠郵件）。呼叫者：sgn_scheduler（db/tools/jobs.mjs）。規則：K-CONFIRM-REMIND';

-- ── 申請單摘要（同 280 的簽章）：等確認時多 confirm_due（站內待辦：剩幾個工作天、期限、是不是在提醒期間）──

create or replace function sgn_internal.case_summary(p_case_id uuid, p_person_id uuid)
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
        'version', v.version,
        'content', v.content,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'version_sha256', encode(v.version_sha256, 'hex'),
        'terms', sgn_internal.case_terms_view(v.terms),
        'updated_at', v.created_at,
        'applicant_name', sgn_internal.person_name(a.id),
        'current_stage', sgn_internal.case_current_stage(c.id),
        'waiting_on', sgn_internal.case_waiting_on(c.id),
        'notices', v.notices,
        'errors', case
            when c.state in ('draft', 'returned') then v.errors || sgn_internal.terms_errors(c.process_type, v.terms, v.tier)
            else '[]'::jsonb
        end,
        'actions', sgn_internal.case_actions(c, p_person_id),
        'exceptions', sgn_internal.case_exceptions(c.id),
        'confirm_due', (
            select jsonb_build_object(
                'due_text', sgn_internal.local_minute_text(k.due_at),
                'workdays_left', sgn_internal.confirmation_workdays_left(k),
                'reminding', sgn_internal.confirmation_reminding(k, c.process_type)
            )
            from sgn.case_confirmation as k
            where k.case_id = c.id and k.status = 'pending'
        )
    )
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    join sgn.person as a on a.id = c.applicant_person_id
    where c.id = p_case_id
$$;

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-GRANT-REVOKE',
        '撤銷等於縮小到零：申請人、被授權者負責人、這張單的任一位簽核人或執行人、MIS 都可以直接撤銷，不需要簽核，必須填原因；'
        '待套用、驗證中（不論有沒有開確認）、生效中都可以（權限可能已在外部系統上，裁決 D84 (4)）；外部系統上的規則自動撤回，'
        '還沒送出的套用與驗證作廢，正在送的也作廢（之後的回報不採信、不重送）',
        'full', null),
    ('K-CONFIRM-MANUAL',
        '人工執行的單也要申請人確認（裁決 D84 (8)）：執行人標記已套用後轉驗證中、開確認，申請人確認後才生效；'
        '回報不對、逾期的處理同自動驗證的單，人工執行的受管系統另開例外並通知管理人去撤回',
        'full', null),
    ('K-CONFIRM-REMIND',
        '確認期限前 confirmation.remind_workdays_before 個工作天起每個工作天提醒一次（進鏈）；最後一個工作天加上申請人的主管與被授權者負責人；'
        '首頁的站內待辦同時標出剩幾個工作天與快到期（不只靠郵件，裁決 D84 (6)）',
        'full', null),
    ('K-CONFIRM',
        '流程類型選了 requires_confirmation：自動驗證全部通過（人工執行時是執行人標記已套用）後不直接生效，開一筆確認；'
        '只有申請人本人能確認（資料授權的 confirmation_parties），確認後才產生授權並生效；自動驗證還沒通過、已經結束或逾期都不能確認',
        'partial', '骨幹的 confirmation_parties 其他選項（負責人、指定成員）與 confirmation_prompt 沒做'),
    ('K-CONFIRM-TIMEOUT',
        '確認期限（參數 confirmation.due_workdays，工作天，開確認時算好）已過還沒確認就自動撤銷並撤回；事件寫明規則代碼、期限與用到的參數值；'
        '排程與交付程式的領取兩個入口',
        'full', null)
) as r (code, description, coverage, note);

insert into sgn.notification_template (event_code, subject, body) values
    ('confirmation.requested_manual', '請確認權限已設定好：{{case_no}}',
        '{{case_no}} 的系統管理人已標記在外部系統上設定完成（人工執行，沒有自動驗證）。請在 {{due}} 前打開申請單，'
        '實際用一次確認結果是不是你要的；確認後授權才生效。逾期沒有確認，系統會自動撤銷。'),
    ('confirmation.reminder', '還有 {{days}} 個工作天：請確認驗證結果 {{case_no}}',
        '{{case_no}} 的驗證結果還沒有確認，期限是 {{due}}（還有 {{days}} 個工作天）。逾期沒有確認，系統會自動撤銷這筆授權。'
        '首頁的「等你確認驗證結果」也看得到。');
