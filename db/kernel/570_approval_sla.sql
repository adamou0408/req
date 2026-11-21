-- 功能第四批 A：關卡時限——催辦、升級、群組認領逾期（rules.md「逾時」「預設時限」；骨幹 K-SLA-REMIND、K-SLA-ESCALATE；
-- 交接 docs/handoff/feature-4-deadlines.md）。
--
-- 1. 時限是參數（依級別、流程類型、全域；sgn_internal.setting）：approval.remind_after_workdays（催辦）、
--    approval.escalate_after_workdays（催辦後多久升級）。工作天走既有的營業日入口（sgn_internal.add_workdays：週六、週日與
--    sgn.calendar_holiday 登記的休假日不算）。只算簽核關（phase = approval）；執行關由交付的卡住檢查（K-DELIVERY-STUCK）處理。
-- 2. 計時的起點：等人決定的工作＝升級的時間（sla_from）、認領的時間或開始的時間；等認領的工作＝開始的時間。
--    催辦期限＝起點＋催辦天數；升級期限＝催辦期限＋升級天數。期限是規則決定的時刻，不因排程停擺順延（停擺由既有的心跳與
--    逾期工作 K-PROGRAM-STALLED 讓人知道）；但一定先催辦、下一輪才升級，升級前簽核人一定收過催辦。
-- 3. 每件工作每個步驟只做一次（sgn.case_task_sla 的 (task_id, step) 唯一，只增不改），排程重跑不重複。
-- 4. 升級（K-SLA-ESCALATE）：經既有的主管 resolver（只用已過冷卻期的主管關係，K-DETECT-MANAGER-FLIP）從簽核人的上一層主管開始，
--    以同一個決定者資格入口（decider_denial：在職、不是申請人、不在本單其他關、不是排除的角色）往上找，找不到再到路徑的
--    top_resolver。找到就把這件工作改指派給他（原簽核人不再是指派對象，不能再簽；已發給原簽核人的挑戰值在驗章後的授權檢查失敗）；
--    找不到就開例外 K-SLA-STALLED，工作留給原簽核人（不卡死、不自動通過）。升級過的工作不再升級：再逾期開 K-SLA-STALLED。
-- 5. 群組認領關（K-SLA-CLAIM）：沒人認領超過催辦期限 → 催辦整個群組（目前的候選人）；再過升級期限 → 開例外，通知候選人的主管
--    （經主管 resolver）與治理角色（參數 approval.stalled_notify_roles）。認領之後照一般的工作計時。
-- 6. 事件寫明規則代碼、期限與用到的參數值；例外在工作不再等待（已決定、退回、改指派、認領）時由排程結案。
-- 7. 畫面（K-SLA-VIEW）：case_summary 的 sla（已等幾個工作天、催辦與升級期限、是否逾期、是否已升級），待簽清單逾期的在前。

insert into sgn.error_catalog (code, message, http_status, kind) values
    ('SLA_STEP_UNKNOWN', '沒有這個時限步驟', 500, 'error');

select sgn_internal.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description)
from (values
    ('approval.remind_after_workdays', 'integer', '3', array['process', 'tier'],
        '簽核關卡未簽多久（工作天）催辦；依級別（tier:<流程類型>:<級別>）、流程類型設定（rules.md「預設時限」：每關 3 個工作天）'),
    ('approval.escalate_after_workdays', 'integer', '2', array['process', 'tier'],
        '催辦後再多久（工作天）未簽就升級給簽核人的上一層主管；群組認領關則開例外（rules.md「預設時限」：催辦後再 2 個工作天）'),
    ('approval.stalled_notify_roles', 'json', '["control_owner"]', array['process'],
        '關卡升級不了（往上找不到人、升級後仍逾期）或群組沒人認領時，例外通知的治理角色')
) as d (key, value_type, default_value, scope_kinds, description);

-- 升級之後重新起算的時間（升級對象的期限從這裡算）；沒有升級過是 null
alter table sgn.case_task
    add column sla_from timestamptz;

-- 每件工作做過的時限步驟。remind／escalate：等人決定的工作；claim_remind／claim_stalled：等認領的工作；
-- stalled：升級不了或升級後仍逾期（開例外）。to_person：升級對象（找不到是 null）。
create table sgn.case_task_sla (
    id bigint generated always as identity primary key,
    task_id bigint not null references sgn.case_task (id),
    case_id uuid not null references sgn.request_case (id),
    step text not null check (step in ('remind', 'escalate', 'stalled', 'claim_remind', 'claim_stalled')),
    due_at timestamptz not null,
    done_at timestamptz not null,
    from_person uuid references sgn.person (id),
    to_person uuid references sgn.person (id),
    exception_id bigint references sgn.exception_record (id),
    event_seq bigint not null,
    unique (task_id, step)
);

create index case_task_sla_case_idx on sgn.case_task_sla (case_id);

create trigger case_task_sla_append_only
    before update or delete on sgn.case_task_sla
    for each row execute function sgn_internal.reject_change();

create trigger case_task_sla_no_truncate
    before truncate on sgn.case_task_sla
    for each statement execute function sgn_internal.reject_change();

-- ── 時限（唯一的計算入口：排程、逾期工作、畫面都用它）──

-- 這張單用到的時限參數值（依級別 → 流程類型 → 全域 → 預設值）。
create function sgn_internal.task_sla_settings(p_case sgn.request_case)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_scopes text[] := sgn_internal.validity_scopes(p_case.process_type, p_case.tier);
begin
    return jsonb_build_object(
        'approval.remind_after_workdays', (sgn_internal.setting('approval.remind_after_workdays', v_scopes) #>> '{}')::int,
        'approval.escalate_after_workdays', (sgn_internal.setting('approval.escalate_after_workdays', v_scopes) #>> '{}')::int
    );
end;
$$;

-- 計時的起點（見檔頭第 2 點）。
create function sgn_internal.task_sla_start(p_task sgn.case_task)
returns timestamptz
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case when p_task.status = 'unclaimed' then p_task.opened_at else coalesce(p_task.sla_from, p_task.claimed_at, p_task.opened_at) end
$$;

-- 一件工作的期限：起點、催辦期限、升級期限。
-- 這幾個時限 function 用 PL/pgSQL：每張單的摘要與逾期工作都會呼叫，PL/pgSQL 的執行計畫會快取（SQL function 每次呼叫都重新規劃）。
create function sgn_internal.task_sla_due(p_task sgn.case_task, p_settings jsonb)
returns table (started_at timestamptz, remind_at timestamptz, escalate_at timestamptz)
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
    started_at := sgn_internal.task_sla_start(p_task);
    remind_at := sgn_internal.add_workdays(started_at, (p_settings ->> 'approval.remind_after_workdays')::int);
    escalate_at := sgn_internal.add_workdays(remind_at, (p_settings ->> 'approval.escalate_after_workdays')::int);
    return next;
end;
$$;

-- 一件工作下一個該做的步驟與它的期限（還沒到也回傳）；沒有該做的步驟回傳空。
--   等認領：claim_remind → claim_stalled。等人決定：沒升級過 remind → escalate；升級過 stalled（升級對象也逾期）。
create function sgn_internal.task_sla_next(p_task sgn.case_task, p_settings jsonb)
returns table (step text, due_at timestamptz)
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_done text[] := array(select x.step from sgn.case_task_sla as x where x.task_id = p_task.id);
    v_due record;
begin
    select * into v_due from sgn_internal.task_sla_due(p_task, p_settings);
    step := case
        when p_task.status = 'unclaimed' and not 'claim_remind' = any (v_done) then 'claim_remind'
        when p_task.status = 'unclaimed' and not 'claim_stalled' = any (v_done) then 'claim_stalled'
        when p_task.status <> 'pending' then null
        when p_task.sla_from is not null and not 'stalled' = any (v_done) then 'stalled'
        when p_task.sla_from is not null then null
        when not 'remind' = any (v_done) then 'remind'
        when not 'escalate' = any (v_done) then 'escalate'
    end;
    if step is null then
        return;
    end if;
    due_at := case when step in ('claim_remind', 'remind') then v_due.remind_at else v_due.escalate_at end;
    return next;
end;
$$;

-- 還在等的簽核工作（開著的簽核關裡等人決定或等認領的工作）。
create function sgn_internal.waiting_approval_tasks(p_case_id uuid default null)
returns setof sgn.case_task
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select t.*
    from sgn.case_task as t
    join sgn.case_stage as s on s.id = t.stage_id
    join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
    join sgn.request_case as c on c.id = t.case_id
    where s.status = 'open'
      and ps.phase = 'approval'
      and c.state = 'in_approval'
      and t.status in ('pending', 'unclaimed')
      and (p_case_id is null or t.case_id = p_case_id)
$$;

-- ── 升級對象（K-SLA-ESCALATE）：經主管 resolver 與決定者資格入口，從簽核人的上一層主管往上找 ──

create function sgn_internal.task_escalation_target(p_case sgn.request_case, p_task sgn.case_task)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_line sgn.reporting_line := sgn_internal.resolve_manager(p_task.assignee_person_id);
    v_top text := (select p.top_resolver_role from sgn.approval_policy as p join sgn.case_stage as s on s.policy_id = p.id where s.id = p_task.stage_id);
    v_resolved jsonb := sgn_internal.resolve_eligible(p_case.id, p_task.stage_id, v_line.manager_person_id, v_top);
begin
    -- 主管關係繞回原簽核人：同一關不算他自己的其他關卡，資格入口擋不到，在這裡擋
    if v_resolved ->> 'person_id' = p_task.assignee_person_id::text then
        v_resolved := v_resolved || jsonb_build_object('person_id', null, 'via', 'none');
    end if;
    return v_resolved || jsonb_build_object(
        'line', case when v_line.id is not null then jsonb_build_object(
            'reporting_line_id', v_line.id,
            'manager', v_line.manager_person_id,
            'origin', v_line.origin,
            'valid_from', v_line.valid_from
        ) end
    );
end;
$$;

-- ── 各步驟（只由 approval_sla_due 在鎖住單之後呼叫）──

create function sgn_internal.task_sla_record(
    p_task sgn.case_task,
    p_step text,
    p_due_at timestamptz,
    p_to uuid,
    p_exception bigint,
    p_seq bigint
)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    insert into sgn.case_task_sla (task_id, case_id, step, due_at, done_at, from_person, to_person, exception_id, event_seq)
    values (p_task.id, p_task.case_id, p_step, p_due_at, sgn_internal.now(), p_task.assignee_person_id, p_to, p_exception, p_seq)
$$;

-- 通知用的內容：單號、關卡名稱、期限、已等幾個工作天。
create function sgn_internal.task_sla_payload(p_case sgn.request_case, p_task sgn.case_task, p_due_at timestamptz)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'case_no', p_case.case_no::text,
        'stage_name', (select ps.name from sgn.case_stage as s join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq where s.id = p_task.stage_id),
        'due', sgn_internal.local_minute_text(p_due_at),
        'days', sgn_internal.workdays_between(
            (sgn_internal.task_sla_start(p_task) at time zone sgn_internal.setting_text('calendar.timezone'))::date, sgn_internal.today()
        )::text
    )
$$;

-- 事件的共同欄位：工作、關卡、期限、參數值、規則代碼。
create function sgn_internal.task_sla_event(p_task sgn.case_task, p_due_at timestamptz, p_settings jsonb, p_rule text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'task_id', p_task.id,
        'stage_seq', (select s.seq from sgn.case_stage as s where s.id = p_task.stage_id),
        'started_at', sgn_internal.task_sla_start(p_task),
        'due_at', p_due_at,
        'settings', p_settings,
        'rules', jsonb_build_array(p_rule)
    )
$$;

-- 催辦（K-SLA-REMIND）或催辦整個群組（K-SLA-CLAIM）。
create function sgn_internal.task_sla_remind(p_case sgn.request_case, p_task sgn.case_task, p_step text, p_due_at timestamptz, p_settings jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_people uuid[] := case
        when p_step = 'claim_remind' then sgn_internal.claim_candidates(p_task.case_id, p_task.stage_id, p_task.claim_role, p_task.claim_scope)
        else array[p_task.assignee_person_id]
    end;
    v_rule text := case when p_step = 'claim_remind' then 'K-SLA-CLAIM' else 'K-SLA-REMIND' end;
    v_seq bigint;
begin
    v_seq := sgn_internal.audit_append(
        'case.task_reminded', p_case.id, null,
        sgn_internal.task_sla_event(p_task, p_due_at, p_settings, v_rule) || jsonb_build_object('step', p_step, 'recipients', to_jsonb(v_people))
    );
    perform sgn_internal.task_sla_record(p_task, p_step, p_due_at, null, null, v_seq);
    perform sgn_internal.notify(
        case when p_step = 'claim_remind' then 'case.claim_reminder' else 'case.task_reminder' end,
        v_people, p_case.id, sgn_internal.task_sla_payload(p_case, p_task, p_due_at)
    );
end;
$$;

-- 開例外（K-SLA-STALLED、K-SLA-CLAIM）並通知：治理角色，加上指定的人。
create function sgn_internal.task_sla_stall(
    p_case sgn.request_case,
    p_task sgn.case_task,
    p_step text,
    p_due_at timestamptz,
    p_settings jsonb,
    p_kind text,
    p_extra jsonb,
    p_people uuid[]
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_rule text := case when p_step = 'claim_stalled' then 'K-SLA-CLAIM' else 'K-SLA-STALLED' end;
    v_roles jsonb := sgn_internal.setting('approval.stalled_notify_roles', array['process:' || p_case.process_type]);
    v_people uuid[] := sgn_internal.roles_holders(v_roles) || coalesce(p_people, '{}');
    v_detail jsonb := sgn_internal.task_sla_event(p_task, p_due_at, p_settings || jsonb_build_object('approval.stalled_notify_roles', v_roles), v_rule)
        || jsonb_build_object('kind', p_kind, 'person', p_task.assignee_person_id) || p_extra;
    v_exception bigint := sgn_internal.exception_open(v_rule, p_case.id, v_detail);
    v_seq bigint;
begin
    v_seq := sgn_internal.audit_append(
        'case.task_stalled', p_case.id, null, v_detail || jsonb_build_object('step', p_step, 'exception', v_exception, 'recipients', to_jsonb(v_people))
    );
    perform sgn_internal.task_sla_record(p_task, p_step, p_due_at, null, v_exception, v_seq);
    perform sgn_internal.notify(
        case when p_step = 'claim_stalled' then 'case.claim_stalled' else 'case.task_stalled' end,
        v_people, p_case.id, sgn_internal.task_sla_payload(p_case, p_task, p_due_at)
    );
end;
$$;

-- 升級（K-SLA-ESCALATE）：找得到升級對象就改指派；找不到就開 K-SLA-STALLED，工作留給原簽核人。
create function sgn_internal.task_sla_escalate(p_case sgn.request_case, p_task sgn.case_task, p_due_at timestamptz, p_settings jsonb)
returns boolean
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_target jsonb := sgn_internal.task_escalation_target(p_case, p_task);
    v_to uuid := (v_target ->> 'person_id')::uuid;
    v_seq bigint;
begin
    if v_to is null then
        v_seq := sgn_internal.audit_append(
            'case.task_escalation_failed', p_case.id, null,
            sgn_internal.task_sla_event(p_task, p_due_at, p_settings, 'K-SLA-ESCALATE') || jsonb_build_object('from', p_task.assignee_person_id, 'target', v_target)
        );
        perform sgn_internal.task_sla_record(p_task, 'escalate', p_due_at, null, null, v_seq);
        perform sgn_internal.task_sla_stall(
            p_case, p_task, 'stalled', p_due_at, p_settings, 'no_escalation_target', jsonb_build_object('target', v_target), array[p_case.applicant_person_id]
        );
        return false;
    end if;
    v_seq := sgn_internal.audit_append(
        'case.task_escalated', p_case.id, null,
        sgn_internal.task_sla_event(p_task, p_due_at, p_settings, 'K-SLA-ESCALATE')
            || jsonb_build_object('from', p_task.assignee_person_id, 'to', v_to, 'via', v_target -> 'via', 'path', v_target -> 'path', 'line', v_target -> 'line')
    );
    perform sgn_internal.task_sla_record(p_task, 'escalate', p_due_at, v_to, null, v_seq);
    update sgn.case_task
    set assignee_person_id = v_to,
        sla_from = sgn_internal.now(),
        basis = basis || jsonb_build_object('escalations', coalesce(basis -> 'escalations', '[]'::jsonb) || jsonb_build_object(
            'from', p_task.assignee_person_id, 'to', v_to, 'at', sgn_internal.now(), 'event_seq', v_seq,
            'via', v_target -> 'via', 'path', v_target -> 'path', 'line', v_target -> 'line', 'rules', jsonb_build_array('K-SLA-ESCALATE')
        ))
    where id = p_task.id;
    perform sgn_internal.notify('case.task_escalated', array[v_to], p_case.id, sgn_internal.task_sla_payload(p_case, p_task, p_due_at));
    perform sgn_internal.notify('case.task_escalated_away', array[p_task.assignee_person_id], p_case.id, sgn_internal.task_sla_payload(p_case, p_task, p_due_at));
    return true;
end;
$$;

-- 認領逾期（K-SLA-CLAIM）：例外通知候選人的主管（經主管 resolver）與治理角色。
create function sgn_internal.task_claim_stalled(p_case sgn.request_case, p_task sgn.case_task, p_due_at timestamptz, p_settings jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_candidates uuid[] := sgn_internal.claim_candidates(p_task.case_id, p_task.stage_id, p_task.claim_role, p_task.claim_scope);
    v_managers uuid[] := array(
        select distinct (sgn_internal.resolve_manager(c)).manager_person_id from unnest(v_candidates) as c
    );
begin
    v_managers := array_remove(v_managers, null);
    perform sgn_internal.task_sla_stall(
        p_case, p_task, 'claim_stalled', p_due_at, p_settings, 'unclaimed',
        jsonb_build_object('role', p_task.claim_role, 'scope', p_task.claim_scope, 'candidates', to_jsonb(v_candidates), 'managers', to_jsonb(v_managers)),
        v_managers
    );
end;
$$;

-- 一件工作的到期步驟（鎖住單之後重新讀工作，確認仍在等、步驟仍沒做）。回傳做了的步驟，沒做是 null。
create function sgn_internal.task_sla_apply(p_task_id bigint)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_task sgn.case_task;
    v_settings jsonb;
    v_next record;
begin
    v_case := sgn_internal.case_lock((select t.case_id from sgn.case_task as t where t.id = p_task_id));
    select w.* into v_task from sgn_internal.waiting_approval_tasks(v_case.id) as w where w.id = p_task_id;
    if v_task.id is null then
        return null;
    end if;
    v_settings := sgn_internal.task_sla_settings(v_case);
    select * into v_next from sgn_internal.task_sla_next(v_task, v_settings);
    if v_next.step is null or v_next.due_at > sgn_internal.now() then
        return null;
    end if;
    if v_next.step in ('remind', 'claim_remind') then
        perform sgn_internal.task_sla_remind(v_case, v_task, v_next.step, v_next.due_at, v_settings);
    elsif v_next.step = 'escalate' then
        if not sgn_internal.task_sla_escalate(v_case, v_task, v_next.due_at, v_settings) then
            return 'stalled';
        end if;
    elsif v_next.step = 'claim_stalled' then
        perform sgn_internal.task_claim_stalled(v_case, v_task, v_next.due_at, v_settings);
    elsif v_next.step = 'stalled' then
        perform sgn_internal.task_sla_stall(v_case, v_task, 'stalled', v_next.due_at, v_settings, 'escalated_overdue', '{}'::jsonb,
            array_remove(array[(sgn_internal.resolve_manager(v_task.assignee_person_id)).manager_person_id], null));
    else
        perform sgn_internal.raise_error('SLA_STEP_UNKNOWN', v_next.step);
    end if;
    return v_next.step;
end;
$$;

-- 例外結案：工作不再等待（已決定、退回、作廢），或等待的人換了（升級、認領）。
create function sgn_internal.task_sla_settle()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row record;
    v_count int := 0;
begin
    for v_row in
        select x.id, x.rule_code, (x.detail ->> 'task_id')::bigint as task_id, x.detail ->> 'person' as person
        from sgn.exception_record as x
        where x.rule_code in ('K-SLA-STALLED', 'K-SLA-CLAIM') and x.closed_at is null
        order by x.id
    loop
        continue when exists (
            select 1 from sgn_internal.waiting_approval_tasks((select t.case_id from sgn.case_task as t where t.id = v_row.task_id)) as w
            where w.id = v_row.task_id
              and w.assignee_person_id is not distinct from sgn_internal.try_uuid(v_row.person)
        );
        if sgn_internal.exception_close(v_row.id, jsonb_build_object(
            'task_id', v_row.task_id, 'reason', 'no_longer_waiting', 'rules', jsonb_build_array(v_row.rule_code)
        )) then
            v_count := v_count + 1;
        end if;
    end loop;
    return v_count;
end;
$$;

-- 排程的入口：逐件做到期的步驟（每件工作各自鎖單；步驟只做一次），再結案不再等待的例外。
create function sgn_internal.approval_sla_due()
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_task sgn.case_task;
    v_step text;
    v_counts jsonb := '{}'::jsonb;
begin
    for v_task in
        select w.* from sgn_internal.waiting_approval_tasks() as w
        join sgn.request_case as c on c.id = w.case_id
        where exists (
            select 1 from sgn_internal.task_sla_next(w, sgn_internal.task_sla_settings(c)) as n where n.due_at <= sgn_internal.now()
        )
        order by w.id
    loop
        v_step := sgn_internal.task_sla_apply(v_task.id);
        if v_step is not null then
            v_counts := v_counts || jsonb_build_object(v_step, coalesce((v_counts ->> v_step)::int, 0) + 1);
        end if;
    end loop;
    return v_counts || jsonb_build_object('closed', sgn_internal.task_sla_settle());
end;
$$;

create function api_job.approval_sla_due()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.approval_sla_due();
end;
$$;

comment on function api_job.approval_sla_due() is
    '簽核關卡的時限：到期的催辦、升級、群組認領逾期、升級後仍逾期（每件工作每步驟只做一次），並結案不再等待的例外。'
    '呼叫者：sgn_scheduler（排程）。規則：K-SLA-REMIND、K-SLA-ESCALATE、K-SLA-STALLED、K-SLA-CLAIM';

-- ── 畫面（K-SLA-VIEW）：目前這關等最久的那件工作的期限 ──

create function sgn_internal.case_sla(p_case_id uuid)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_tasks sgn.case_task[] := array(select w from sgn_internal.waiting_approval_tasks(p_case_id) as w);
    v_task sgn.case_task;
    v_oldest sgn.case_task;
    v_settings jsonb;
    v_due record;
    v_escalated jsonb := '[]'::jsonb;
begin
    if cardinality(v_tasks) = 0 then
        return null;
    end if;
    foreach v_task in array v_tasks loop
        if v_oldest.id is null or (sgn_internal.task_sla_start(v_task), v_task.id) < (sgn_internal.task_sla_start(v_oldest), v_oldest.id) then
            v_oldest := v_task;
        end if;
        if v_task.sla_from is not null then
            v_escalated := v_escalated || to_jsonb(sgn_internal.person_name(v_task.assignee_person_id));
        end if;
    end loop;
    v_settings := sgn_internal.task_sla_settings((select c from sgn.request_case as c where c.id = p_case_id));
    select * into v_due from sgn_internal.task_sla_due(v_oldest, v_settings);
    return jsonb_build_object(
        'stage_name', (
            select ps.name from sgn.case_stage as s join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
            where s.id = v_oldest.stage_id
        ),
        'since', v_due.started_at,
        'waiting_workdays', sgn_internal.workdays_between(
            (v_due.started_at at time zone sgn_internal.setting_text('calendar.timezone'))::date, sgn_internal.today()
        ),
        'remind_due', sgn_internal.local_minute_text(v_due.remind_at),
        'escalate_due', sgn_internal.local_minute_text(v_due.escalate_at),
        'overdue', v_due.remind_at <= sgn_internal.now(),
        'claim', v_oldest.status = 'unclaimed',
        'escalated', jsonb_array_length(v_escalated) > 0,
        'escalated_to', v_escalated,
        'settings', v_settings
    );
end;
$$;

-- 申請單摘要（同 525 的簽章）：多了 sla（K-SLA-VIEW）。
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
        'overdue', sgn_internal.case_overdue(c.id),
        'confirm_due', (
            select jsonb_build_object(
                'due_text', sgn_internal.local_minute_text(k.due_at),
                'workdays_left', sgn_internal.confirmation_workdays_left(k),
                'reminding', sgn_internal.confirmation_reminding(k, c.process_type)
            )
            from sgn.case_confirmation as k
            where k.case_id = c.id and k.status = 'pending'
        ),
        'sla', sgn_internal.case_sla(c.id)
    )
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    join sgn.person as a on a.id = c.applicant_person_id
    where c.id = p_case_id
$$;

-- 待簽清單（同 565 的簽章）：逾期的在前（系統的逾期警示，或這張單的關卡已過催辦期限），再依等最久、單號（K-SLA-VIEW）。
create or replace function api.inbox_list(p_session text)
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
        select jsonb_agg(s.summary order by s.overdue desc, s.since nulls last, (s.summary ->> 'case_no')::bigint)
        from (
            select sgn_internal.case_summary(w.case_id, v_person_id) as summary,
                   sgn_internal.case_overdue(w.case_id) is not null
                       or coalesce((sgn_internal.case_sla(w.case_id) ->> 'overdue')::boolean, false) as overdue,
                   sgn_internal.case_waiting_since(w.case_id) as since
            from sgn_internal.person_waiting_cases(v_person_id) as w (case_id)
        ) as s
        where jsonb_array_length(s.summary -> 'actions') > 0
    ), '[]'::jsonb);
end;
$$;

-- 這張單的經手人（同 160 的簽章）：被升級移走的原簽核人仍看得到這張單（只能看，不能簽）。
create or replace function sgn_internal.person_has_task(p_case_id uuid, p_person_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (select 1 from sgn.case_task as t where t.case_id = p_case_id and t.assignee_person_id = p_person_id)
        or exists (select 1 from sgn.case_task_sla as x where x.case_id = p_case_id and x.step = 'escalate' and x.from_person = p_person_id)
        or (sgn_internal.person_claimable_task(p_case_id, p_person_id)).id is not null
$$;

-- 逾期還沒被處理的工作（同 525 的簽章）：多了 approval_sla（關卡的時限步驟到期了，排程還沒做；排程停擺時由 K-PROGRAM-STALLED 讓人知道）。
create or replace function sgn_internal.overdue_work(p_case_id uuid default null)
returns table (kind text, case_id uuid, since timestamptz)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select 'grant_expiry', g.case_id, ((g.valid_to + 1)::timestamp at time zone sgn_internal.setting_text('calendar.timezone'))
    from sgn.grant_record as g
    where g.status = 'active' and g.valid_to < sgn_internal.today() and (p_case_id is null or g.case_id = p_case_id)
    union all
    select 'confirmation_expiry', k.case_id, k.due_at
    from sgn.case_confirmation as k
    where k.status = 'pending' and k.due_at < sgn_internal.now() and (p_case_id is null or k.case_id = p_case_id)
    union all
    select 'delivery', o.case_id, o.created_at + make_interval(secs => sgn_internal.delivery_setting_int('delivery.stuck_alert_seconds', o.channel))
    from sgn.delivery_op as o
    where o.status in ('queued', 'sending')
      and o.created_at < sgn_internal.now() - make_interval(secs => sgn_internal.delivery_setting_int('delivery.stuck_alert_seconds', o.channel))
      and (p_case_id is null or o.case_id = p_case_id)
    union all
    select 'approval_sla', w.case_id, n.due_at
    from sgn_internal.waiting_approval_tasks(p_case_id) as w
    join sgn.request_case as c on c.id = w.case_id
    cross join lateral sgn_internal.task_sla_next(w, sgn_internal.task_sla_settings(c)) as n
    where n.due_at < sgn_internal.now()
$$;

insert into sgn.notification_template (event_code, subject, body) values
    ('case.task_reminder', '催辦：{{case_no}} 等你簽核', '{{case_no}} 的「{{stage_name}}」已等 {{days}} 個工作天，催辦期限 {{due}} 已過。再不處理會升級給你的上一層主管。'),
    ('case.task_escalated', '升級給你簽核：{{case_no}}', '{{case_no}} 的「{{stage_name}}」逾期未簽（升級期限 {{due}}），已升級給你；只有你能簽這一關。'),
    ('case.task_escalated_away', '已升級給你的上一層主管：{{case_no}}', '{{case_no}} 的「{{stage_name}}」逾期未簽（升級期限 {{due}}），已升級給你的上一層主管，你不能再簽這一關。'),
    ('case.task_stalled', '關卡逾期且無法升級：{{case_no}}', '{{case_no}} 的「{{stage_name}}」逾期未簽（期限 {{due}}），往上找不到可以簽的人或升級對象也逾期，已開例外，請處理。'),
    ('case.claim_reminder', '催辦：{{case_no}} 等你們認領', '{{case_no}} 的「{{stage_name}}」已等 {{days}} 個工作天沒有人認領，催辦期限 {{due}} 已過。'),
    ('case.claim_stalled', '群組關卡逾期沒人認領：{{case_no}}', '{{case_no}} 的「{{stage_name}}」逾期沒有人認領（期限 {{due}}），已開例外，請安排人認領。');

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-SLA-REMIND', '簽核關卡超過催辦時限（approval.remind_after_workdays 個工作天，依級別）未簽，由排程催辦一次；事件寫明期限與參數值', 'full', null),
    ('K-SLA-ESCALATE', '催辦後再超過 approval.escalate_after_workdays 個工作天未簽，經主管 resolver（已過冷卻期的主管關係）升級給簽核人的上一層主管，'
        || '仍受每關不同人、不能是申請人約束，撞到再往上、最後到路徑的 top_resolver；升級後只有升級對象能簽，原簽核人不能再簽；每件工作只升級一次', 'partial',
        '骨幹的「升級前 1 個工作天預告」、依簽核人所在據點的行事曆與時區、申請人每週期可提醒一次沒有做'),
    ('K-SLA-STALLED', '升級時往上找不到合格的人、或升級對象也逾期未簽：開例外通知治理角色（approval.stalled_notify_roles），不卡死也不自動通過，'
        || '工作留給原來的人；工作不再等待時結案', 'full', null),
    ('K-SLA-CLAIM', '群組認領關超過催辦時限沒人認領：催辦整個群組；再過升級時限開例外，通知候選人的主管與治理角色；認領或不再等待時結案', 'full', null),
    ('K-SLA-VIEW', '待簽清單與單的頁面顯示已等幾個工作天、目前這關的催辦與升級期限、是否逾期與是否已升級；待簽清單逾期的在前、再依等最久', 'full', null)
) as r (code, description, coverage, note);
