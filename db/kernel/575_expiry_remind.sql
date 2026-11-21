-- 功能第四批 B：授權到期前提醒（rules.md「時間規則」：到期前提醒；「預設時限」：到期前提醒 14 天；骨幹 K-EXPIRE-REMIND；
-- 交接 docs/handoff/feature-4-deadlines.md）。
--
-- 1. 生效中的授權在迄日前 validity.remind_before_days 天（依級別、流程類型；預設 14）由排程提醒申請人與被授權者負責人，
--    每筆授權只提醒一次（sgn.grant_expiry_reminder 以授權為主鍵，只增不改），排程重跑不重複。
-- 2. 不提醒：已撤銷、已到期（授權不是 active）；已續期——續期（K-RENEW）還沒實作，這裡以「同一個被授權者有一張送審後還在
--    簽核、執行或已生效的單，由原申請人或被授權者負責人送出，它的重疊檢查列了這筆授權，而且迄日比這筆晚」當作已續期
--    （交接寫明這個近似）。那張單被駁回、撤回或退回之後就不算，下一輪補寄提醒。
-- 3. 進入提醒期間還沒寄的算逾期工作（expiry_remind；排程停擺時由 K-PROGRAM-STALLED 讓人知道）。

select sgn_internal.register_setting_definition(
    'validity.remind_before_days', 'integer', '14', array['process', 'tier'],
    '授權迄日前幾天（日曆天）提醒申請人與被授權者負責人；依級別（tier:<流程類型>:<級別>）、流程類型設定（rules.md「預設時限」：14 天）'
);

create table sgn.grant_expiry_reminder (
    grant_id uuid primary key references sgn.grant_record (id),
    case_id uuid not null references sgn.request_case (id),
    valid_to date not null,
    sent_at timestamptz not null,
    recipients jsonb not null,
    event_seq bigint not null
);

create trigger grant_expiry_reminder_append_only
    before update or delete on sgn.grant_expiry_reminder
    for each row execute function sgn_internal.reject_change();

create trigger grant_expiry_reminder_no_truncate
    before truncate on sgn.grant_expiry_reminder
    for each statement execute function sgn_internal.reject_change();

-- 這筆授權的提醒天數（依這張單的級別 → 流程類型 → 全域 → 預設值）。
create function sgn_internal.grant_remind_days(p_grant sgn.grant_record)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (sgn_internal.setting('validity.remind_before_days', sgn_internal.validity_scopes(c.process_type, c.tier)) #>> '{}')::int
    from sgn.request_case as c
    where c.id = p_grant.case_id
$$;

-- 已續期（見檔頭第 2 點）：同一個被授權者、原申請人或負責人本人送審的單在重疊檢查列了這筆授權，迄日比這筆晚，
-- 而且還沒結束（駁回、撤回、退回之後就不算，下一輪補寄提醒）。
create function sgn_internal.grant_renewed_by(p_grant sgn.grant_record)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select c.id
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    join sgn.case_overlap as o on o.case_id = c.id
    where c.id <> p_grant.case_id
      and c.state in ('in_approval', 'pending_fulfilment', 'verifying', 'active')
      and v.terms ->> 'principal_id' = p_grant.principal_id::text
      and sgn_internal.try_date(v.terms ->> 'valid_to') > p_grant.valid_to
      -- 只認原申請人或被授權者負責人本人送出的單（別人送一張單不能讓這筆授權的人收不到提醒）
      and (
          c.applicant_person_id = (select o.applicant_person_id from sgn.request_case as o where o.id = p_grant.case_id)
          or c.applicant_person_id = (select x.owner_person_id from sgn.principal as x where x.id = p_grant.principal_id)
      )
      and exists (select 1 from jsonb_array_elements(o.items) as i where i ->> 'case_id' = p_grant.case_id::text)
    order by c.case_no
    limit 1
$$;

-- 進入提醒期間、還沒提醒、沒有續期的生效中授權，與它開始該提醒的時間。
create function sgn_internal.grant_expiry_remind_pending(p_case_id uuid default null)
returns table (grant_id uuid, case_id uuid, due_at timestamptz, remind_days int)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select g.id, g.case_id,
           greatest(g.created_at, ((g.valid_to - d.days)::timestamp at time zone sgn_internal.setting_text('calendar.timezone'))),
           d.days
    from sgn.grant_record as g
    cross join lateral (select sgn_internal.grant_remind_days(g) as days) as d
    where g.status = 'active'
      and g.valid_to >= sgn_internal.today()
      and g.valid_to - d.days <= sgn_internal.today()
      and (p_case_id is null or g.case_id = p_case_id)
      and not exists (select 1 from sgn.grant_expiry_reminder as r where r.grant_id = g.id)
      and sgn_internal.grant_renewed_by(g) is null
$$;

-- 排程逐件處理失敗時的例外（同一個對象沒結案的不再開）。
create function sgn_internal.job_failed(p_rule text, p_case_id uuid, p_subject jsonb, p_error text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    if exists (
        select 1 from sgn.exception_record as x
        where x.rule_code = p_rule and x.closed_at is null and x.detail ->> 'kind' = 'job_error' and x.detail -> 'subject' = p_subject
    ) then
        return;
    end if;
    perform sgn_internal.exception_open(p_rule, p_case_id, jsonb_build_object(
        'kind', 'job_error', 'subject', p_subject, 'error', left(p_error, 500), 'rules', jsonb_build_array(p_rule)
    ));
end;
$$;

create function sgn_internal.grant_expiry_remind_due()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row record;
    v_grant sgn.grant_record;
    v_case sgn.request_case;
    v_people uuid[];
    v_seq bigint;
    v_count int := 0;
begin
    for v_row in select * from sgn_internal.grant_expiry_remind_pending() as p order by p.due_at, p.grant_id loop
        begin
            v_case := sgn_internal.case_lock(v_row.case_id);
            select * into v_grant from sgn.grant_record where id = v_row.grant_id;
            -- 鎖住之後重新確認：仍生效、還沒提醒
            continue when v_grant.status <> 'active'
                or exists (select 1 from sgn.grant_expiry_reminder as r where r.grant_id = v_grant.id);
            select coalesce(array_agg(distinct p), '{}') into v_people
            from unnest(array[v_case.applicant_person_id, sgn_internal.case_principal_owner(v_case)]) as p
            where p is not null;
            v_seq := sgn_internal.audit_append('grant.expiry_reminded', v_case.id, null, jsonb_build_object(
                'grant_id', v_grant.id, 'valid_to', v_grant.valid_to, 'days_left', v_grant.valid_to - sgn_internal.today(),
                'recipients', to_jsonb(v_people), 'settings', jsonb_build_object('validity.remind_before_days', v_row.remind_days),
                'rules', jsonb_build_array('K-EXPIRE-REMIND')
            ));
            insert into sgn.grant_expiry_reminder (grant_id, case_id, valid_to, sent_at, recipients, event_seq)
            values (v_grant.id, v_case.id, v_grant.valid_to, sgn_internal.now(), to_jsonb(v_people), v_seq);
            perform sgn_internal.notify('grant.expiry_reminder', v_people, v_case.id, jsonb_build_object(
                'case_no', v_case.case_no::text, 'valid_to', v_grant.valid_to::text, 'days', (v_grant.valid_to - sgn_internal.today())::text
            ));
            v_count := v_count + 1;
        exception when others then
            -- 一筆失敗只回捲那一筆（savepoint），開例外；其他照常提醒
            perform sgn_internal.job_failed('K-EXPIRE-REMIND', v_row.case_id, jsonb_build_object('grant_id', v_row.grant_id), sqlerrm);
        end;
    end loop;
    return v_count;
end;
$$;

create function api_job.grant_expiry_remind_due()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('reminded', sgn_internal.grant_expiry_remind_due());
end;
$$;

comment on function api_job.grant_expiry_remind_due() is
    '生效中的授權到期前（validity.remind_before_days 天，依級別）提醒申請人與被授權者負責人，每筆授權一次；已撤銷、已到期、已續期的不提醒。'
    '呼叫者：sgn_scheduler（排程）。規則：K-EXPIRE-REMIND';

-- 逾期還沒被處理的工作（同 570 的簽章）：多了 expiry_remind（進入提醒期間還沒提醒）。
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
    union all
    select 'expiry_remind', r.case_id, r.due_at
    from sgn_internal.grant_expiry_remind_pending(p_case_id) as r
$$;

insert into sgn.notification_template (event_code, subject, body) values
    ('grant.expiry_reminder', '授權快到期：{{case_no}}', '{{case_no}} 的授權將在 {{valid_to}} 到期（還有 {{days}} 天）。還需要的話請提出新的申請；到期後系統會自動收回。');

select sgn_internal.register_rule(
    'K-EXPIRE-REMIND',
    '生效中的授權在迄日前 validity.remind_before_days 天（依級別）提醒申請人與被授權者負責人，每筆授權一次；已撤銷、已到期、已續期的不提醒',
    null, 'partial',
    '續期（K-RENEW）還沒實作：以「同一被授權者送審後的單在重疊檢查列了這筆授權、迄日較晚、還沒結束」當作已續期；骨幹的「提醒成員」沒有做（沒有成員表）'
);
