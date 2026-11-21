-- 使用紀錄的批次摘要（裁決 D92 (4)；docs/handoff/closed-loop-1.md）。
--
-- 使用方系統每個時段為每張單、每個實際操作的人記一筆摘要：查詢次數、匯出次數、被擋次數、最後使用時間。
-- 取得的方式沿用對帳（D92 (3)：平台拉取帶證明的回報）：對帳程式（sgn_reconciler，唯讀稽核金鑰）向外部系統要一批，
-- 原樣交給資料庫（api_job.usage_submit）。資料庫只採信外部系統的證明（405 的驗章入口、同一份環境）：
-- 簽發時間要比這個通道已收下的最新一批新（不能拿舊的一批蓋掉新的）、離現在不超過參數、同一批只收一次、項目數有上限、
-- 每一筆都要對得到這個通道交付過的單；任何一筆不合格整批不收（開例外、限速）。
-- 收下的整批記一筆稽核事件（整批的雜湊與筆數），每一筆摘要不逐筆進鏈（量大；整批的雜湊已經固定了內容）。
-- 同一張單、同一個人、同一個時段可以在之後的批次再出現（時段還沒結束時次數會增加）：以簽發時間最新的那一批為準，重送不重複計算。
-- 摘要只增不改。
--
-- 用到摘要的地方：單的頁面與稽核頁（最後使用時間、近 usage.recent_days 天的次數）；生效超過 usage.idle_alert_days 天
-- 仍沒有任何使用的授權開例外 K-USAGE-IDLE 並通知申請人與被授權者負責人（提醒收回，不自動撤銷）。只看「回報過使用紀錄」的通道，
-- 沒有使用紀錄的系統不會被誤判為閒置。回報過的通道超過 usage.max_interval_seconds 沒有新的一批，開例外 K-USAGE-OVERDUE。

insert into sgn.error_catalog (code, message, http_status) values
    ('USAGE_APPEND_ONLY', '使用紀錄的摘要只增不改', 409);

select sgn_internal.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description)
from (values
    ('usage.max_batch_age_seconds', 'integer', '120', array['channel'],
        '外部系統簽的使用摘要，簽發時間離現在超過幾秒就不收（新鮮度；同一批也只收一次、簽發時間要比上一批新）'),
    ('usage.max_items', 'integer', '20000', array['channel'], '一批使用摘要最多幾筆；超過整批不收並開例外 K-USAGE-UNVERIFIED'),
    ('usage.max_count', 'integer', '1000000', array['channel'], '一筆摘要裡任何一個次數的上限；超過視為格式不正確，整批不收'),
    ('usage.recent_days', 'integer', '30', array['process'], '單的頁面與稽核頁顯示「近幾天」的使用次數'),
    ('usage.idle_alert_days', 'integer', '30', array['process', 'tier'],
        '授權生效超過幾天仍沒有任何查詢或匯出，就開例外 K-USAGE-IDLE 並提醒收回（不自動撤銷）'),
    ('usage.max_interval_seconds', 'integer', '600', array['channel'],
        '回報過使用摘要的通道超過幾秒沒有新的一批，就開例外 K-USAGE-OVERDUE 並通知升級對象')
) as d (key, value_type, default_value, scope_kinds, description);

create table sgn.usage_batch (
    id bigint generated always as identity primary key,
    channel text not null,
    issued_at timestamptz not null,
    -- 外部系統簽的那段 payload 的 SHA-256：同一批只收一次
    batch_sha256 bytea not null unique,
    item_count int not null,
    received_at timestamptz not null,
    event_seq bigint not null
);

create table sgn.usage_summary (
    batch_id bigint not null references sgn.usage_batch (id),
    case_id uuid not null references sgn.request_case (id),
    actor_provider text not null,
    actor_external_id text not null,
    -- 對得到平台的人員時才有（沒有對應的照樣記，畫面顯示外部帳號）
    person_id uuid references sgn.person (id),
    period_from timestamptz not null,
    period_to timestamptz not null,
    query_count int not null check (query_count >= 0),
    export_count int not null check (export_count >= 0),
    blocked_count int not null check (blocked_count >= 0),
    last_used_at timestamptz,
    primary key (batch_id, case_id, actor_provider, actor_external_id, period_from)
);

create index usage_summary_case_idx on sgn.usage_summary (case_id, period_from);

create function sgn_internal.usage_reject_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.raise_error('USAGE_APPEND_ONLY', tg_table_name || ' ' || tg_op);
    return null;
end;
$$;

create trigger usage_batch_append_only before update or delete on sgn.usage_batch
    for each row execute function sgn_internal.usage_reject_change();
create trigger usage_batch_no_truncate before truncate on sgn.usage_batch
    for each statement execute function sgn_internal.usage_reject_change();
create trigger usage_summary_append_only before update or delete on sgn.usage_summary
    for each row execute function sgn_internal.usage_reject_change();
create trigger usage_summary_no_truncate before truncate on sgn.usage_summary
    for each statement execute function sgn_internal.usage_reject_change();

-- ── 收一批 ──

-- 不收的一批：同一個通道在新鮮度的時間內只開一筆例外並升級（壞批次灌不爆例外），回傳原因。
create function sgn_internal.usage_reject(p_channel text, p_reason text, p_detail jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_window int := sgn_internal.reconciliation_setting_int('usage.max_batch_age_seconds', p_channel);
begin
    if not exists (
        select 1 from sgn.exception_record as x
        where x.rule_code = 'K-USAGE-UNVERIFIED' and x.detail ->> 'channel' = p_channel
          and x.opened_at > sgn_internal.now() - make_interval(secs => v_window)
    ) then
        perform sgn_internal.exception_open('K-USAGE-UNVERIFIED', null, p_detail || jsonb_build_object(
            'channel', p_channel, 'reason', p_reason, 'settings', jsonb_build_object('usage.max_batch_age_seconds', v_window)));
        perform sgn_internal.notify('usage.rejected', sgn_internal.delivery_escalation_people(), null,
            jsonb_build_object('channel', p_channel, 'reason', p_reason));
    end if;
    return jsonb_build_object('status', 'rejected', 'channel', p_channel, 'reason', p_reason);
end;
$$;

-- 一筆摘要哪裡不對；沒錯回 null。p_cases：這個通道交付過的單（case_no → id）。
create function sgn_internal.usage_item_problem(p_item jsonb, p_cases jsonb, p_max int)
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_from timestamptz := sgn_internal.try_timestamptz(p_item #>> '{period,from}');
    v_to timestamptz := sgn_internal.try_timestamptz(p_item #>> '{period,to}');
    v_last timestamptz := sgn_internal.try_timestamptz(p_item ->> 'last_used_at');
    v_key text;
begin
    if jsonb_typeof(p_item) is distinct from 'object' or p_cases -> (p_item ->> 'case_no') is null then
        return 'case';
    end if;
    if coalesce(p_item #>> '{actor,provider}', '') = '' or coalesce(p_item #>> '{actor,external_id}', '') = '' then
        return 'actor';
    end if;
    if v_from is null or v_to is null or v_to <= v_from or v_from > sgn_internal.now() then
        return 'period';
    end if;
    foreach v_key in array array['queries', 'exports', 'blocked'] loop
        if jsonb_typeof(p_item -> v_key) is distinct from 'number' or (p_item ->> v_key)::numeric <> floor((p_item ->> v_key)::numeric)
           or (p_item ->> v_key)::numeric < 0 or (p_item ->> v_key)::numeric > p_max then
            return v_key;
        end if;
    end loop;
    if (p_item ->> 'last_used_at') is null then
        return case when (p_item ->> 'queries')::int + (p_item ->> 'exports')::int + (p_item ->> 'blocked')::int > 0 then 'last_used_at' end;
    end if;
    if v_last is null or v_last < v_from or v_last >= v_to then
        return 'last_used_at';
    end if;
    return null;
end;
$$;

-- 交上來的回應 → 驗過的一批（證明的 payload.result）；不收時是 rejected 的結果。
create function sgn_internal.usage_accept(p_channel text, p_response jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_att jsonb := sgn_internal.attestation_open(p_channel, p_response, jsonb_build_object(
        'method', 'GET', 'path', '/usage-summaries', 'request_sha256', encode(sgn_internal.digest('', 'sha256'), 'hex')));
    v_issued timestamptz;
    v_latest timestamptz;
    v_sha bytea;
    v_batch jsonb;
begin
    if not (v_att ->> 'ok')::boolean then
        return sgn_internal.usage_reject(p_channel, 'unverified', jsonb_build_object('attestation', v_att));
    end if;
    v_issued := sgn_internal.try_timestamptz(v_att #>> '{payload,issued_at}');
    if v_issued is null or abs(extract(epoch from sgn_internal.now() - v_issued))
        > sgn_internal.reconciliation_setting_int('usage.max_batch_age_seconds', p_channel) then
        return sgn_internal.usage_reject(p_channel, 'stale', jsonb_build_object('issued_at', v_att #>> '{payload,issued_at}'));
    end if;
    v_sha := sgn_internal.digest(convert_to(p_response #>> '{attestation,payload}', 'UTF8'), 'sha256');
    if exists (select 1 from sgn.usage_batch as b where b.batch_sha256 = v_sha) then
        return sgn_internal.usage_reject(p_channel, 'replay', jsonb_build_object('batch_sha256', encode(v_sha, 'hex')));
    end if;
    v_latest := (select max(b.issued_at) from sgn.usage_batch as b where b.channel = p_channel);
    if v_latest is not null and v_issued <= v_latest then
        return sgn_internal.usage_reject(p_channel, 'not_newer', jsonb_build_object('issued_at', v_issued, 'latest_accepted_issued_at', v_latest));
    end if;
    v_batch := v_att #> '{payload,result}';
    if (v_att #>> '{payload,http_status}')::int <> 200 or v_batch ->> 'format' is distinct from 'usage_summary_batch/1'
       or jsonb_typeof(v_batch -> 'items') is distinct from 'array' then
        return sgn_internal.usage_reject(p_channel, 'format', jsonb_build_object('http_status', v_att #>> '{payload,http_status}'));
    end if;
    if jsonb_array_length(v_batch -> 'items') > sgn_internal.reconciliation_setting_int('usage.max_items', p_channel) then
        return sgn_internal.usage_reject(p_channel, 'too_many_items', jsonb_build_object('items', jsonb_array_length(v_batch -> 'items'),
            'settings', jsonb_build_object('usage.max_items', sgn_internal.reconciliation_setting_int('usage.max_items', p_channel))));
    end if;
    return jsonb_build_object('status', 'accepted', 'batch', v_batch, 'batch_sha256', encode(v_sha, 'hex'), 'issued_at', v_issued);
end;
$$;

-- 這個通道交付過的單：{case_no: case_id}。
create function sgn_internal.usage_channel_cases(p_channel text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_object_agg(c.case_no::text, c.id), '{}'::jsonb)
    from sgn.request_case as c
    where exists (select 1 from sgn.delivery_op as o where o.case_id = c.id and o.channel = p_channel and o.kind = 'apply' and o.attempts > 0)
$$;

create function sgn_internal.usage_submit(p_channel text, p_response jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_accepted jsonb;
    v_cases jsonb := sgn_internal.usage_channel_cases(p_channel);
    v_max int := sgn_internal.reconciliation_setting_int('usage.max_count', p_channel);
    v_bad record;
    v_batch bigint;
    v_seq bigint;
begin
    -- 同一個通道一次只收一批（簽發時間的比較不會兩批同時通過）
    perform pg_advisory_xact_lock(hashtext('sgn.usage:' || p_channel));
    v_accepted := sgn_internal.usage_accept(p_channel, p_response);
    if v_accepted ->> 'status' <> 'accepted' then
        return v_accepted;
    end if;
    select x.n - 1 as idx, sgn_internal.usage_item_problem(x.item, v_cases, v_max) as problem into v_bad
    from jsonb_array_elements(v_accepted #> '{batch,items}') with ordinality as x (item, n)
    where sgn_internal.usage_item_problem(x.item, v_cases, v_max) is not null
    order by x.n
    limit 1;
    if v_bad.problem is not null then
        return sgn_internal.usage_reject(p_channel, 'item_invalid', jsonb_build_object('index', v_bad.idx, 'problem', v_bad.problem));
    end if;
    v_seq := sgn_internal.audit_append('usage.batch_received', null, null, jsonb_build_object(
        'channel', p_channel, 'batch_sha256', v_accepted ->> 'batch_sha256', 'issued_at', v_accepted ->> 'issued_at',
        'items', jsonb_array_length(v_accepted #> '{batch,items}'),
        'rules', jsonb_build_array('K-USAGE-ATTESTED', 'K-USAGE-BATCH-AUDIT', 'K-DELIVERY-ATTESTED')));
    insert into sgn.usage_batch (channel, issued_at, batch_sha256, item_count, received_at, event_seq)
    values (p_channel, (v_accepted ->> 'issued_at')::timestamptz, decode(v_accepted ->> 'batch_sha256', 'hex'),
        jsonb_array_length(v_accepted #> '{batch,items}'), sgn_internal.now(), v_seq)
    returning id into v_batch;
    insert into sgn.usage_summary (batch_id, case_id, actor_provider, actor_external_id, person_id, period_from, period_to,
        query_count, export_count, blocked_count, last_used_at)
    select v_batch, (v_cases ->> (i ->> 'case_no'))::uuid, i #>> '{actor,provider}', i #>> '{actor,external_id}',
        sgn_internal.person_by_identity(i #>> '{actor,provider}', i #>> '{actor,external_id}'),
        (i #>> '{period,from}')::timestamptz, (i #>> '{period,to}')::timestamptz,
        (i ->> 'queries')::int, (i ->> 'exports')::int, (i ->> 'blocked')::int, (i ->> 'last_used_at')::timestamptz
    from jsonb_array_elements(v_accepted #> '{batch,items}') as i
    on conflict do nothing;
    return jsonb_build_object('status', 'accepted', 'batch', v_batch, 'items', jsonb_array_length(v_accepted #> '{batch,items}'),
        'idle', sgn_internal.usage_idle_check());
end;
$$;

-- ── 讀取：每個鍵（單、人、時段）取簽發時間最新的那一批 ──

create function sgn_internal.usage_latest(p_case_id uuid)
returns table (actor_provider text, actor_external_id text, person_id uuid, period_from timestamptz, period_to timestamptz,
               query_count int, export_count int, blocked_count int, last_used_at timestamptz)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select distinct on (u.actor_provider, u.actor_external_id, u.period_from)
        u.actor_provider, u.actor_external_id, u.person_id, u.period_from, u.period_to,
        u.query_count, u.export_count, u.blocked_count, u.last_used_at
    from sgn.usage_summary as u
    join sgn.usage_batch as b on b.id = u.batch_id
    where u.case_id = p_case_id
    order by u.actor_provider, u.actor_external_id, u.period_from, b.issued_at desc
$$;

-- 單的頁面與稽核頁：有沒有使用紀錄、最後使用時間、近 N 天的次數與人數。這張單沒有任何回報時是 null。
create function sgn_internal.case_usage(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    with s as (
        select (sgn_internal.setting('usage.recent_days', array['process:' || c.process_type]) #>> '{}')::int as days
        from sgn.request_case as c where c.id = p_case_id
    ),
    u as (select * from sgn_internal.usage_latest(p_case_id))
    select case when exists (select 1 from u) then jsonb_build_object(
        'last_used_at', (select max(u.last_used_at) from u),
        'last_used_text', (select sgn_internal.local_minute_text(max(u.last_used_at)) from u),
        'recent_days', s.days,
        'queries', (select coalesce(sum(u.query_count), 0) from u where u.period_to > sgn_internal.now() - make_interval(days => s.days)),
        'exports', (select coalesce(sum(u.export_count), 0) from u where u.period_to > sgn_internal.now() - make_interval(days => s.days)),
        'blocked', (select coalesce(sum(u.blocked_count), 0) from u where u.period_to > sgn_internal.now() - make_interval(days => s.days)),
        'people', (select count(distinct (u.actor_provider, u.actor_external_id)) from u
                   where u.period_to > sgn_internal.now() - make_interval(days => s.days) and u.query_count + u.export_count + u.blocked_count > 0)
    ) end
    from s
$$;

-- ── 閒置與逾期 ──

-- 生效超過參數天數仍沒有任何查詢或匯出的授權（只看回報過使用摘要的通道）：開例外（每張單一筆未結案）並通知申請人與
-- 被授權者負責人；之後有使用就結案。回傳 {opened, closed}。
create function sgn_internal.usage_idle_check()
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row record;
    v_opened int := 0;
    v_closed int := 0;
    v_days int;
begin
    for v_row in
        select x.id, x.case_id from sgn.exception_record as x
        where x.rule_code = 'K-USAGE-IDLE' and x.closed_at is null
          and (exists (select 1 from sgn_internal.usage_latest(x.case_id) as u where u.query_count + u.export_count > 0)
               or not exists (select 1 from sgn.grant_record as g where g.case_id = x.case_id and g.status = 'active'))
    loop
        if sgn_internal.exception_close(v_row.id, jsonb_build_object('resolved', 'used_or_ended', 'rules', jsonb_build_array('K-USAGE-IDLE'))) then
            v_closed := v_closed + 1;
        end if;
    end loop;
    for v_row in
        select g.case_id, g.valid_from, g.principal_id, c.case_no, c.applicant_person_id, c.process_type, v.tier
        from sgn.grant_record as g
        join sgn.request_case as c on c.id = g.case_id
        join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
        where g.status = 'active'
          and exists (select 1 from sgn.usage_batch as b
                      join sgn.delivery_op as o on o.channel = b.channel and o.case_id = g.case_id and o.kind = 'apply' and o.status = 'done')
          and not exists (select 1 from sgn_internal.usage_latest(g.case_id) as u where u.query_count + u.export_count > 0)
          and not exists (select 1 from sgn.exception_record as x where x.rule_code = 'K-USAGE-IDLE' and x.case_id = g.case_id and x.closed_at is null)
        order by c.case_no
    loop
        v_days := (sgn_internal.setting('usage.idle_alert_days',
            array['tier:' || v_row.process_type || ':' || v_row.tier, 'process:' || v_row.process_type]) #>> '{}')::int;
        continue when v_row.valid_from + v_days > sgn_internal.today();
        perform sgn_internal.exception_open('K-USAGE-IDLE', v_row.case_id, jsonb_build_object(
            'valid_from', v_row.valid_from, 'settings', jsonb_build_object('usage.idle_alert_days', v_days)));
        perform sgn_internal.notify('usage.idle',
            array[v_row.applicant_person_id, (select p.owner_person_id from sgn.principal as p where p.id = v_row.principal_id)],
            v_row.case_id, jsonb_build_object('case_no', v_row.case_no::text, 'days', v_days::text));
        v_opened := v_opened + 1;
    end loop;
    return jsonb_build_object('opened', v_opened, 'closed', v_closed);
end;
$$;

-- 回報過使用摘要的通道超過參數的時間沒有新的一批：開例外並升級（每段逾期一筆）。回傳開了幾筆。
create function sgn_internal.usage_overdue_check()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_channel text;
    v_since timestamptz;
    v_seconds int;
    v_count int := 0;
begin
    for v_channel, v_since in select b.channel, max(b.received_at) from sgn.usage_batch as b group by b.channel order by 1 loop
        v_seconds := sgn_internal.reconciliation_setting_int('usage.max_interval_seconds', v_channel);
        continue when v_since >= sgn_internal.now() - make_interval(secs => v_seconds)
            or exists (select 1 from sgn.exception_record as x where x.rule_code = 'K-USAGE-OVERDUE'
                       and x.detail ->> 'channel' = v_channel and x.opened_at > v_since);
        perform sgn_internal.exception_open('K-USAGE-OVERDUE', null, jsonb_build_object('channel', v_channel, 'last_batch', v_since,
            'settings', jsonb_build_object('usage.max_interval_seconds', v_seconds)));
        perform sgn_internal.notify('usage.overdue', sgn_internal.delivery_escalation_people(), null, jsonb_build_object('channel', v_channel));
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- ── 對外入口 ──

create function api_job.usage_submit(p_channel text, p_response jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.usage_submit(p_channel, p_response);
end;
$$;

comment on function api_job.usage_submit(text, jsonb) is
    '使用紀錄：交上外部系統的使用摘要回應（含外部系統的證明，usage_summary_batch/1），只採信證明裡的一批（驗章、端點、環境、新鮮度、'
    '只收一次、簽發時間比已收下的最新一批新、每一筆都對得到這個通道交付過的單）；整批的雜湊寫一筆稽核事件，摘要不逐筆進鏈。'
    '不收的回應回 rejected（限速開例外）。收下後順帶檢查閒置的授權。'
    '呼叫者：sgn_reconciler（api/src/reconciler.ts，以外部系統的唯讀稽核金鑰取得）。'
    '規則：K-USAGE-ATTESTED、K-USAGE-BATCH-AUDIT、K-USAGE-UNVERIFIED、K-USAGE-IDLE、K-DELIVERY-ATTESTED';

create function api_job.usage_checks()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('idle', sgn_internal.usage_idle_check(), 'overdue', sgn_internal.usage_overdue_check());
end;
$$;

comment on function api_job.usage_checks() is
    '排程：生效超過 usage.idle_alert_days 天沒有任何使用的授權開例外並提醒申請人與被授權者負責人（不自動撤銷）；'
    '回報過使用摘要的通道超過 usage.max_interval_seconds 沒有新的一批時開例外並升級。'
    '呼叫者：sgn_scheduler（db/tools/jobs.mjs）。規則：K-USAGE-IDLE、K-USAGE-OVERDUE';

insert into sgn.notification_template (event_code, subject, body) values
    ('usage.idle', '授權一直沒有使用：{{case_no}}',
        '{{case_no}} 生效超過 {{days}} 天，使用方系統回報沒有任何查詢或匯出。不再需要時請撤銷（系統不會自動收回）。'),
    ('usage.rejected', '使用紀錄不採信：{{channel}}', '{{channel}} 交來的使用摘要沒有通過檢查（{{reason}}），已開例外。'),
    ('usage.overdue', '使用紀錄逾期：{{channel}}', '{{channel}} 超過時間沒有新的使用摘要，已開例外。請確認對帳程式與外部系統。');

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-USAGE-ATTESTED', '使用紀錄的批次摘要只在外部系統的證明驗章、端點、環境都相符，簽發時間在新鮮度內、比已收下的最新一批新、'
        '沒有收過，且每一筆都對得到這個通道交付過的單時才收；以每個鍵（單、人、時段）最新的一批為準，重送不重複計算', 'full', null),
    ('K-USAGE-BATCH-AUDIT', '收下的一批寫一筆稽核事件（整批的雜湊與筆數），摘要不逐筆進鏈；摘要只增不改', 'full', null),
    ('K-USAGE-UNVERIFIED', '不收的使用摘要（證明不符、過期、重送、不比上一批新、格式或任何一筆不合格、太多筆）開例外並升級'
        '（同一通道在新鮮度的時間內一筆）', 'full', null),
    ('K-USAGE-IDLE', '生效超過參數天數仍沒有任何查詢或匯出的授權（只看回報過使用摘要的通道），開例外並通知申請人與被授權者負責人，'
        '不自動撤銷；之後有使用或授權結束就結案', 'full', null),
    ('K-USAGE-OVERDUE', '回報過使用摘要的通道超過參數的時間沒有新的一批，開例外並升級', 'partial',
        '從來沒有回報過的通道不檢查（沒有使用紀錄的系統由能力宣告標示）')
) as r (code, description, coverage, note);

-- ── 畫面：申請單詳情多了使用紀錄、驗證多了不驗的案例；稽核證據頁多了使用紀錄 ──

-- 申請單詳情上的交付與驗證（同 430 的簽章）：每一輪驗證多了 skipped（K-VERIFY-SKIPPED）。
create or replace function sgn_internal.case_delivery_view(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'ops', coalesce((
            select jsonb_agg(jsonb_build_object(
                'op_id', o.id, 'channel', o.channel, 'kind', o.kind, 'version', o.version, 'status', o.status, 'attempts', o.attempts,
                'created_at', o.created_at, 'finished_at', o.finished_at,
                'next_attempt_at', case when o.status = 'queued' then o.next_attempt_at end,
                'last_http_status', o.last_http_status, 'last_error', coalesce(o.result ->> 'error', o.last_error)
            ) order by o.id)
            from sgn.delivery_op as o
            where o.case_id = p_case_id
        ), '[]'::jsonb),
        'verifications', coalesce((
            select jsonb_agg(jsonb_build_object(
                'run_id', r.id, 'channel', r.channel, 'version', r.version, 'status', r.status,
                'created_at', r.created_at, 'finished_at', r.finished_at,
                'skipped', (
                    select coalesce(jsonb_agg(jsonb_build_object(
                        'code', s ->> 'code', 'description', coalesce(s ->> 'description', s ->> 'code'),
                        'reason', coalesce(s #>> '{skip,reason}', s #>> '{skip}')
                    ) order by n), '[]'::jsonb)
                    from jsonb_array_elements(r.skipped) with ordinality as k (s, n)
                ),
                'cases', (
                    select coalesce(jsonb_agg(jsonb_build_object(
                        'code', c ->> 'code',
                        'description', coalesce(c ->> 'description', c ->> 'code'),
                        'expected', c ->> 'expected',
                        'actual', a.actual,
                        'match', case when a.actual is not null then a.actual = c ->> 'expected' end
                    ) order by n), '[]'::jsonb)
                    from jsonb_array_elements(r.cases) with ordinality as e (c, n)
                    left join lateral (
                        select x ->> 'actual' as actual from jsonb_array_elements(coalesce(r.results, '[]'::jsonb)) as x
                        where x ->> 'code' = c ->> 'code' limit 1
                    ) as a on true
                )
            ) order by r.id)
            from sgn.verification_run as r
            where r.case_id = p_case_id
        ), '[]'::jsonb)
    )
$$;

-- 申請單詳情（同 470 的簽章）：多了 usage。
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
        'confirmation', sgn_internal.case_confirmation_view(p_case_id),
        'usage', sgn_internal.case_usage(p_case_id)
    );
end;
$$;

-- 稽核證據頁（同 70 的簽章）：多了 usage。
create or replace function api.audit_case(p_session text, p_case_no bigint)
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
    perform sgn_internal.authorize(v_person_id, 'audit.read');
    select * into v_case from sgn.request_case where case_no = p_case_no;
    if v_case.id is null then
        perform sgn_internal.raise_error('CASE_UNKNOWN');
    end if;
    return jsonb_build_object(
        'case', sgn_internal.case_summary(v_case.id, null) - 'actions',
        'usage', sgn_internal.case_usage(v_case.id),
        'events', sgn_internal.audit_case_events(v_case),
        'proofs', sgn_internal.audit_case_proofs(v_case.id)
    );
end;
$$;

comment on function api.audit_case(text, bigint) is
    '稽核證據頁：一張單的內容與例外、使用紀錄（最後使用時間、近幾天的次數，K-USAGE-ATTESTED）、它的全部鏈上事件（含原始 bytes 與前後雜湊）、'
    '決定證明原文與所用的公開金鑰、登記該金鑰的事件與簽核人依據的主管異動事件。只限稽核角色，唯讀。呼叫者：sgn_app。'
    '規則：PRB-AUDIT-READ、PRB-CHAIN、PRB-PROOF、PRB-SYNC-GUARD、K-USAGE-ATTESTED';
