-- 紅隊第七輪 中-2（裁決 D88 (3)；redteam/exploits/47）：排程與交付程式同時停擺時沒有任何訊號。
-- 逾期與卡住的偵測都掛在這兩個程式自己身上（排程檢查交付卡住，交付程式的領取順帶處理確認逾期），兩個一起停就沒有人補位。
-- 偵測機制不能和它要偵測的東西死在一起：
--   1. 每個背景程式每一輪回報心跳，各用自己的資料庫角色、自己的函式（拿到一個程式的密鑰，不能替別的程式報平安）。
--      程式清單是 sgn.program（每個程式一列，對應它的心跳函式）。
--   2. 存活檢查 sgn_internal.program_stall_check：誰的心跳超過 program.heartbeat_max_seconds 沒有回報、最舊的逾期工作
--      （授權到期沒處理、確認逾期沒處理、交付逾時）逾期多久了；超過 program.overdue_max_seconds 就開例外 K-PROGRAM-STALLED 並通知，
--      狀況解除就結案。觸發的人：其他每個程式的心跳（每個心跳都跑一次全部的檢查，不只檢查自己）與稽核頁（api.program_health）。
--      被檢查的程式停了，別的程式照樣會檢查；所有程式都停了，稽核頁一打開就會檢查。
--   3. 首頁與單的頁面：逾期但還沒被處理的單顯示警示（case_summary 的 overdue，由這裡的 sgn_internal.overdue_work 算，頁面不自行推斷）。
-- 檢查只開例外與通知，不替停擺的程式做它的工作（各程式的角色只能做自己的事）。

select sgn_internal.register_setting_definition(
    'program.heartbeat_max_seconds', 'integer', '300', array['program'],
    '背景程式超過幾秒沒有回報心跳就算停擺（K-PROGRAM-STALLED）；可依程式（program:<代碼>）設定'
);
select sgn_internal.register_setting_definition(
    'program.overdue_max_seconds', 'integer', '600', array['work'],
    '逾期還沒被處理的工作（授權到期、確認逾期、交付逾時）最舊的一筆超過幾秒就開例外 K-PROGRAM-STALLED；可依種類（work:<種類>）設定'
);
select sgn_internal.register_setting_definition(
    'program.stall_check_interval_seconds', 'integer', '10', array[]::text[],
    '心跳觸發的存活檢查最少間隔幾秒（每個程式每一輪都會回報心跳；稽核頁的檢查不受這個限制）'
);
select sgn_internal.register_setting_definition(
    'program.stalled_notify_roles', 'json', '["tech_ops", "audit_head", "ciso"]', array[]::text[],
    '背景程式停擺或逾期工作沒人處理（K-PROGRAM-STALLED）時通知哪些角色的持有人'
);

insert into sgn.error_catalog (code, message, http_status) values
    ('PROGRAM_UNKNOWN', '沒有這個背景程式', 500);

create table sgn.program (
    code text primary key,
    name text not null,
    registered_at timestamptz not null,
    first_seen timestamptz,
    last_seen timestamptz
);

-- 心跳觸發的檢查上一次跑的時間（一列）。
create table sgn.program_check (
    id boolean primary key default true check (id),
    last_run timestamptz
);

insert into sgn.program_check (id, last_run) values (true, null);

insert into sgn.program (code, name, registered_at)
select x.code, x.name, sgn_internal.now()
from (values
    ('jobs', '排程'),
    ('mailer', '通知寄送'),
    ('delivery', '交付'),
    ('reconciler', '對帳'),
    ('anchor', '錨定'),
    ('idp-keys', '身分提供者金鑰更新')
) as x (code, name);

-- ── 逾期還沒被處理的工作（唯一來源：存活檢查與畫面的警示共用） ──
-- grant_expiry：生效中的授權過了迄日（排程 grant_expire_due 該處理）；confirmation_expiry：確認期限已過（排程與交付程式的領取該處理）；
-- delivery：排著或正在送的交付超過 delivery.stuck_alert_seconds 沒有結果（交付程式該處理）。since 是開始逾期的時間。
create function sgn_internal.overdue_work(p_case_id uuid default null)
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
$$;

-- 一張單最舊的逾期工作（畫面的警示）；沒有時為 null。
create function sgn_internal.case_overdue(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('kind', w.kind, 'since', w.since)
    from sgn_internal.overdue_work(p_case_id) as w
    order by w.since, w.kind
    limit 1
$$;

-- 心跳從什麼時候算起：最後一次心跳；從來沒回報過的，從「登記時」與「第一個程式開始回報時」較晚的那個算起
-- （建置之後、程式啟動之前的空檔不算停擺；所有程式都沒啟動過時，從登記時算起）。
create function sgn_internal.program_seen_baseline(p_program sgn.program)
returns timestamptz
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(p_program.last_seen, greatest(p_program.registered_at, (select min(q.first_seen) from sgn.program as q)))
$$;

create function sgn_internal.setting_int_in(p_key text, p_scope text)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (sgn_internal.setting(p_key, array[p_scope]) #>> '{}')::int
$$;

-- ── 存活檢查 ──

-- 現在不正常的對象：{subject, kind, ...}。program:<代碼>＝心跳逾時；work:<種類>＝最舊的逾期工作超過參數。
create function sgn_internal.program_stalled_subjects()
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(s.subject order by s.subject ->> 'subject'), '[]'::jsonb)
    from (
        select jsonb_build_object(
            'subject', 'program:' || p.code, 'kind', 'heartbeat', 'program', p.code, 'last_seen', p.last_seen,
            'registered_at', p.registered_at,
            'settings', jsonb_build_object('program.heartbeat_max_seconds', sgn_internal.setting_int_in('program.heartbeat_max_seconds', 'program:' || p.code))
        ) as subject
        from sgn.program as p
        where sgn_internal.program_seen_baseline(p)
              < sgn_internal.now() - make_interval(secs => sgn_internal.setting_int_in('program.heartbeat_max_seconds', 'program:' || p.code))
        union all
        select jsonb_build_object(
            'subject', 'work:' || w.kind, 'kind', 'overdue', 'work', w.kind, 'since', w.since,
            'age_seconds', floor(extract(epoch from sgn_internal.now() - w.since))::bigint,
            'case_id', w.case_id, 'case_no', (select c.case_no from sgn.request_case as c where c.id = w.case_id),
            'count', w.n,
            'settings', jsonb_build_object('program.overdue_max_seconds', sgn_internal.setting_int_in('program.overdue_max_seconds', 'work:' || w.kind))
        )
        from (
            select distinct on (o.kind) o.kind, o.case_id, o.since, count(*) over (partition by o.kind) as n
            from sgn_internal.overdue_work() as o
            order by o.kind, o.since, o.case_id
        ) as w
        where w.since < sgn_internal.now() - make_interval(secs => sgn_internal.setting_int_in('program.overdue_max_seconds', 'work:' || w.kind))
    ) as s
$$;

-- 開新的、結掉已解除的（K-PROGRAM-STALLED，一個對象最多一筆未結案）。只有一個交易在跑（拿不到鎖就跳過，不擋住心跳）。
-- p_force＝稽核頁：等鎖、不看間隔。
create function sgn_internal.program_stall_check(p_force boolean default false)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_interval int := sgn_internal.setting_int('program.stall_check_interval_seconds');
    v_bad jsonb;
    v_subject jsonb;
    v_open record;
    v_opened int := 0;
    v_closed int := 0;
begin
    if p_force then
        perform pg_advisory_xact_lock(hashtext('sgn.program_stall_check'));
    elsif not pg_try_advisory_xact_lock(hashtext('sgn.program_stall_check'))
          or (select c.last_run from sgn.program_check as c) > v_now - make_interval(secs => v_interval) then
        return jsonb_build_object('checked', false);
    end if;
    update sgn.program_check set last_run = v_now;
    v_bad := sgn_internal.program_stalled_subjects();
    for v_open in
        select x.id, x.detail ->> 'subject' as subject from sgn.exception_record as x
        where x.rule_code = 'K-PROGRAM-STALLED' and x.closed_at is null order by x.id
    loop
        if not exists (select 1 from jsonb_array_elements(v_bad) as b where b ->> 'subject' = v_open.subject)
           and sgn_internal.exception_close(v_open.id, jsonb_build_object('subject', v_open.subject, 'rules', jsonb_build_array('K-PROGRAM-STALLED'))) then
            v_closed := v_closed + 1;
        end if;
    end loop;
    for v_subject in select b from jsonb_array_elements(v_bad) as b loop
        continue when exists (
            select 1 from sgn.exception_record as x
            where x.rule_code = 'K-PROGRAM-STALLED' and x.closed_at is null and x.detail ->> 'subject' = v_subject ->> 'subject'
        );
        perform sgn_internal.exception_open('K-PROGRAM-STALLED', null, v_subject);
        perform sgn_internal.notify(
            'program.stalled', sgn_internal.roles_holders(sgn_internal.setting('program.stalled_notify_roles')), null,
            jsonb_build_object(
                'what', coalesce((select p.name from sgn.program as p where p.code = v_subject ->> 'program'), v_subject ->> 'work'),
                'kind', v_subject ->> 'kind',
                'case_no', coalesce(v_subject ->> 'case_no', '-')
            )
        );
        v_opened := v_opened + 1;
    end loop;
    return jsonb_build_object('checked', true, 'opened', v_opened, 'closed', v_closed, 'stalled', jsonb_array_length(v_bad));
end;
$$;

-- 心跳的唯一入口：記下這個程式還活著，再跑一次全部的存活檢查（檢查別人，不只自己）。
create function sgn_internal.program_heartbeat(p_code text)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    update sgn.program set last_seen = sgn_internal.now(), first_seen = coalesce(first_seen, sgn_internal.now()) where code = p_code;
    if not found then
        perform sgn_internal.raise_error('PROGRAM_UNKNOWN', p_code);
    end if;
    return jsonb_build_object('program', p_code) || sgn_internal.program_stall_check(false);
end;
$$;

-- ── 各程式自己的心跳函式（各授權給自己的資料庫角色；路由表 schedulerCalls 等） ──

create function api_job.scheduler_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.program_heartbeat('jobs');
end;
$$;

comment on function api_job.scheduler_heartbeat() is
    '排程每一輪回報心跳，並檢查其他程式有沒有停擺、逾期工作有沒有人處理（K-PROGRAM-STALLED）。'
    '呼叫者：程式自己的資料庫角色（排程 db/tools/jobs.mjs）。規則：K-PROGRAM-STALLED';

create function api_job.mailer_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.program_heartbeat('mailer');
end;
$$;

comment on function api_job.mailer_heartbeat() is
    '通知寄送每一輪回報心跳，並檢查其他程式有沒有停擺、逾期工作有沒有人處理（K-PROGRAM-STALLED）。'
    '呼叫者：程式自己的資料庫角色（api/src/mailer.ts）。規則：K-PROGRAM-STALLED';

create function api_job.reconciler_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.program_heartbeat('reconciler');
end;
$$;

comment on function api_job.reconciler_heartbeat() is
    '對帳每一輪回報心跳，並檢查其他程式有沒有停擺、逾期工作有沒有人處理（K-PROGRAM-STALLED）。'
    '呼叫者：程式自己的資料庫角色（api/src/reconciler.ts）。規則：K-PROGRAM-STALLED';

create function api_job.anchor_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.program_heartbeat('anchor');
end;
$$;

comment on function api_job.anchor_heartbeat() is
    '錨定程式每一輪回報心跳，並檢查其他程式有沒有停擺、逾期工作有沒有人處理（K-PROGRAM-STALLED）。'
    '呼叫者：程式自己的資料庫角色（db/tools/anchor.mjs）。規則：K-PROGRAM-STALLED';

create function api_delivery.delivery_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.program_heartbeat('delivery');
end;
$$;

comment on function api_delivery.delivery_heartbeat() is
    '交付程式每一輪回報心跳，並檢查其他程式有沒有停擺、逾期工作有沒有人處理（K-PROGRAM-STALLED）。'
    '呼叫者：sgn_delivery（api/src/delivery.ts）。規則：K-PROGRAM-STALLED';

create function api_idp.idp_keys_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.program_heartbeat('idp-keys');
end;
$$;

comment on function api_idp.idp_keys_heartbeat() is
    '身分提供者金鑰更新程序每一輪回報心跳，並檢查其他程式有沒有停擺、逾期工作有沒有人處理（K-PROGRAM-STALLED）。'
    '呼叫者：sgn_idp_keys（db/tools/idp-keys.mjs）。規則：K-PROGRAM-STALLED';

-- ── 稽核頁：觸發一次檢查並回傳每個程式與每種逾期工作的狀況 ──
-- 不叫 audit_*：api.audit_* 是唯讀（stable）的稽核讀取；這個會開例外與結案（D88 (3)：稽核頁也要能觸發檢查）。

create function api.program_health(p_session text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_check jsonb;
begin
    perform sgn_internal.authorize(sgn_internal.session_person(p_session), 'audit.read');
    v_check := sgn_internal.program_stall_check(true);
    return jsonb_build_object(
        'programs', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', p.code, 'name', p.name, 'last_seen', p.last_seen,
                'max_seconds', sgn_internal.setting_int_in('program.heartbeat_max_seconds', 'program:' || p.code),
                'stalled', sgn_internal.program_seen_baseline(p)
                    < sgn_internal.now() - make_interval(secs => sgn_internal.setting_int_in('program.heartbeat_max_seconds', 'program:' || p.code))
            ) order by p.code), '[]'::jsonb)
            from sgn.program as p
        ),
        'overdue', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'kind', w.kind, 'count', w.n, 'oldest_since', w.since,
                'oldest_case_no', (select c.case_no from sgn.request_case as c where c.id = w.case_id),
                'max_seconds', sgn_internal.setting_int_in('program.overdue_max_seconds', 'work:' || w.kind),
                'stalled', w.since < sgn_internal.now() - make_interval(secs => sgn_internal.setting_int_in('program.overdue_max_seconds', 'work:' || w.kind))
            ) order by w.kind), '[]'::jsonb)
            from (
                select distinct on (o.kind) o.kind, o.case_id, o.since, count(*) over (partition by o.kind) as n
                from sgn_internal.overdue_work() as o
                order by o.kind, o.since, o.case_id
            ) as w
        ),
        'opened', (v_check ->> 'opened')::int,
        'closed', (v_check ->> 'closed')::int
    );
end;
$$;

comment on function api.program_health(text) is
    '稽核頁的存活檢查（裁決 D88 (3)）：觸發一次 K-PROGRAM-STALLED 的檢查（開新的、結掉已解除的），回傳每個背景程式最後一次心跳、'
    '是否逾時，與每種逾期還沒被處理的工作（筆數、最舊的那張單與時間、是否超過參數）。只限稽核角色。'
    '不是唯讀：會開例外與結案（所以不叫 audit_*）。呼叫者：sgn_app。規則：K-PROGRAM-STALLED、PRB-AUDIT-READ';

-- ── 申請單摘要（同 480 的簽章）：多 overdue（逾期還沒被處理的工作，畫面顯示警示） ──

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
        )
    )
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    join sgn.person as a on a.id = c.applicant_person_id
    where c.id = p_case_id
$$;

select sgn_internal.register_rule(
    'K-PROGRAM-STALLED',
    '存活檢查不靠被檢查的程式（裁決 D88 (3)）：每個背景程式每一輪以自己的資料庫角色回報心跳；其他每個程式的心跳與稽核頁都會檢查'
    '「誰超過 program.heartbeat_max_seconds 沒有回報、最舊的逾期工作（授權到期、確認逾期、交付逾時）是否超過 program.overdue_max_seconds」，'
    '超過就開例外（一個對象一筆）並通知 program.stalled_notify_roles 的持有人，狀況解除就結案；逾期還沒被處理的單在首頁與單的頁面顯示警示',
    null,
    'partial',
    '所有背景程式都停了而且沒有人打開稽核頁時，沒有任何主動訊號（頁面的警示仍在）'
);

insert into sgn.notification_template (event_code, subject, body) values
    ('program.stalled', '背景程式可能停擺：{{what}}',
        '存活檢查發現「{{what}}」沒有在時限內回報或處理（{{kind}}；最舊的單 {{case_no}}）。到期、確認逾期或交付可能卡住，'
        '外部系統上的權限可能沒有被收回。請檢查背景程式；稽核頁的「背景程式」可以看到每個程式最後一次回報的時間。');
