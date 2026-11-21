-- 使用紀錄摘要的細節（閉環第二批；裁決 D93 (3)、D94 (7)；格式 docs/contract/02-pack-data-access.md §8.7；交接 docs/handoff/closed-loop-2.md）。
--
-- 批次格式 usage_summary_batch/2 每一筆多了三樣（/1 照收，三樣都是空的）：
--   environment      這張單的規則所在的區（交付內容的 environment 鍵；流程包沒有這個鍵時是 null）。要和平台在這個通道上送出的最新一版
--                    規則相同，否則整批不收（使用方系統把一區的使用記到另一區的單上）。核心不解讀它的值。
--   fields           逐欄的使用：[{package, field, queries, exports, blocked, last_used_at}]，次數與時間的檢查和整筆相同
--   client_versions  這個時段裡使用方系統帶過的程式或報表版本識別（字串陣列；沒有帶是空的）
-- 讀取：usage_latest_detail 取每個鍵（單、人、時段）最新的一批，給流程包算測試報告用（sgn_sdk.case_usage_detail）。

alter table sgn.usage_summary
    add column environment text,
    add column field_usage jsonb not null default '[]'::jsonb,
    add column client_versions text[] not null default '{}';

-- 這個通道交付過的單，平台送出的最新一版規則所在的區：{case_no: environment 或 null}。
create function sgn_internal.usage_channel_environments(p_channel text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_object_agg(x.case_no, x.environment), '{}'::jsonb)
    from (
        select distinct on (c.id) c.case_no::text as case_no, to_jsonb(o.body::jsonb ->> 'environment') as environment
        from sgn.request_case as c
        join sgn.delivery_op as o on o.case_id = c.id and o.channel = p_channel and o.kind = 'apply' and o.attempts > 0
        order by c.id, o.id desc
    ) as x
$$;

-- 一筆摘要的細節哪裡不對（同 usage_item_problem 的寫法）；沒錯回 null。p_zones：usage_channel_environments。
create function sgn_internal.usage_detail_problem(p_item jsonb, p_zones jsonb, p_max int)
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_from timestamptz := sgn_internal.try_timestamptz(p_item #>> '{period,from}');
    v_to timestamptz := sgn_internal.try_timestamptz(p_item #>> '{period,to}');
    v_f jsonb;
    v_key text;
    v_last timestamptz;
begin
    if coalesce(p_item -> 'environment', 'null'::jsonb) is distinct from coalesce(p_zones -> (p_item ->> 'case_no'), 'null'::jsonb) then
        return 'environment';
    end if;
    if p_item ? 'fields' and jsonb_typeof(p_item -> 'fields') is distinct from 'array' then
        return 'fields';
    end if;
    for v_f in select f from jsonb_array_elements(coalesce(p_item -> 'fields', '[]'::jsonb)) as f loop
        if jsonb_typeof(v_f) is distinct from 'object' or coalesce(v_f ->> 'package', '') !~ '^[a-z][a-z0-9_]{0,62}$'
           or coalesce(v_f ->> 'field', '') !~ '^[a-z][a-z0-9_]{0,62}$' then
            return 'fields';
        end if;
        foreach v_key in array array['queries', 'exports', 'blocked'] loop
            if jsonb_typeof(v_f -> v_key) is distinct from 'number' or (v_f ->> v_key)::numeric <> floor((v_f ->> v_key)::numeric)
               or (v_f ->> v_key)::numeric < 0 or (v_f ->> v_key)::numeric > p_max then
                return 'fields';
            end if;
        end loop;
        v_last := sgn_internal.try_timestamptz(v_f ->> 'last_used_at');
        if (v_f ->> 'last_used_at') is not null and (v_last is null or v_last < v_from or v_last >= v_to) then
            return 'fields';
        end if;
    end loop;
    if p_item ? 'client_versions' and (jsonb_typeof(p_item -> 'client_versions') is distinct from 'array'
        or exists (select 1 from jsonb_array_elements(p_item -> 'client_versions') as v
                   where jsonb_typeof(v) <> 'string' or length(v #>> '{}') not between 1 and 128)) then
        return 'client_versions';
    end if;
    return null;
end;
$$;

-- 交上來的回應 → 驗過的一批（同 545 的簽章）：格式 /1 與 /2 都收（/2 多了區、逐欄的次數與版本識別）。
create or replace function sgn_internal.usage_accept(p_channel text, p_response jsonb)
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
    if (v_att #>> '{payload,http_status}')::int <> 200 or v_batch ->> 'format' not in ('usage_summary_batch/1', 'usage_summary_batch/2')
       or v_batch ->> 'format' is null
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

-- 收一批（同 545 的簽章）：多了細節的檢查與保存。

create or replace function sgn_internal.usage_submit(p_channel text, p_response jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_accepted jsonb;
    v_cases jsonb := sgn_internal.usage_channel_cases(p_channel);
    v_zones jsonb := sgn_internal.usage_channel_environments(p_channel);
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
    select x.n - 1 as idx,
        coalesce(sgn_internal.usage_item_problem(x.item, v_cases, v_max), sgn_internal.usage_detail_problem(x.item, v_zones, v_max)) as problem
    into v_bad
    from jsonb_array_elements(v_accepted #> '{batch,items}') with ordinality as x (item, n)
    where coalesce(sgn_internal.usage_item_problem(x.item, v_cases, v_max), sgn_internal.usage_detail_problem(x.item, v_zones, v_max)) is not null
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
        query_count, export_count, blocked_count, last_used_at, environment, field_usage, client_versions)
    select v_batch, (v_cases ->> (i ->> 'case_no'))::uuid, i #>> '{actor,provider}', i #>> '{actor,external_id}',
        sgn_internal.person_by_identity(i #>> '{actor,provider}', i #>> '{actor,external_id}'),
        (i #>> '{period,from}')::timestamptz, (i #>> '{period,to}')::timestamptz,
        (i ->> 'queries')::int, (i ->> 'exports')::int, (i ->> 'blocked')::int, (i ->> 'last_used_at')::timestamptz,
        i ->> 'environment', coalesce(i -> 'fields', '[]'::jsonb),
        array(select v #>> '{}' from jsonb_array_elements(coalesce(i -> 'client_versions', '[]'::jsonb)) as v order by 1)
    from jsonb_array_elements(v_accepted #> '{batch,items}') as i
    on conflict do nothing;
    return jsonb_build_object('status', 'accepted', 'batch', v_batch, 'items', jsonb_array_length(v_accepted #> '{batch,items}'),
        'idle', sgn_internal.usage_idle_check());
end;
$$;

-- 一張單每個鍵（單、人、時段）最新的一批，含細節。
create function sgn_internal.usage_latest_detail(p_case_id uuid)
returns table (actor_provider text, actor_external_id text, person_id uuid, period_from timestamptz, period_to timestamptz,
               query_count int, export_count int, blocked_count int, last_used_at timestamptz,
               environment text, field_usage jsonb, client_versions text[])
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select distinct on (u.actor_provider, u.actor_external_id, u.period_from)
        u.actor_provider, u.actor_external_id, u.person_id, u.period_from, u.period_to,
        u.query_count, u.export_count, u.blocked_count, u.last_used_at, u.environment, u.field_usage, u.client_versions
    from sgn.usage_summary as u
    join sgn.usage_batch as b on b.id = u.batch_id
    where u.case_id = p_case_id
    order by u.actor_provider, u.actor_external_id, u.period_from, b.issued_at desc
$$;

-- 流程包讀一張單的使用摘要（測試報告用）：每個鍵最新的一批，[{actor, person_id, period, queries, exports, blocked, last_used_at,
-- environment, fields, client_versions}]，依時段排序；另帶這張單交付過的通道有沒有回報過使用紀錄（沒有回報＝不知道，不是沒用）。
create function sgn_sdk.case_usage_detail(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'reported', exists (
            select 1 from sgn.delivery_op as o join sgn.usage_batch as b on b.channel = o.channel
            where o.case_id = p_case_id and o.kind = 'apply' and o.attempts > 0),
        'first_batch_at', (
            select min(b.received_at) from sgn.delivery_op as o join sgn.usage_batch as b on b.channel = o.channel
            where o.case_id = p_case_id and o.kind = 'apply' and o.attempts > 0),
        'last_batch_at', (
            select max(b.received_at) from sgn.delivery_op as o join sgn.usage_batch as b on b.channel = o.channel
            where o.case_id = p_case_id and o.kind = 'apply' and o.attempts > 0),
        'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                'actor', jsonb_build_object('provider', u.actor_provider, 'external_id', u.actor_external_id),
                'person_id', u.person_id,
                'period', jsonb_build_object('from', u.period_from, 'to', u.period_to),
                'queries', u.query_count, 'exports', u.export_count, 'blocked', u.blocked_count, 'last_used_at', u.last_used_at,
                'environment', u.environment, 'fields', u.field_usage, 'client_versions', to_jsonb(u.client_versions)
            ) order by u.period_from, u.actor_provider, u.actor_external_id)
            from sgn_internal.usage_latest_detail(p_case_id) as u
        ), '[]'::jsonb)
    )
$$;

select sgn_internal.register_rule(r.code, r.description, null, 'full', null)
from (values
    ('K-USAGE-DETAIL', '使用摘要每一筆可以帶區、逐欄的次數與使用方系統的版本識別；區要和平台在那個通道送出的最新一版規則相同，'
        '任何一項格式不對整批不收（K-USAGE-UNVERIFIED）')
) as r (code, description);
