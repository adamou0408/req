-- 對帳（策略 4：核准之後繼續把關）：排程以獨立的通道（帳號 sgn_job、外部系統的唯讀稽核金鑰，api/src/reconciler.ts）
-- 拉外部系統「實際存在」的權限，與平台認為該有的比對。多出來的、少掉的、範圍不同的各開例外（K-RECON-*）。
-- 與交付程式不同帳號、不同金鑰：交付程式被拿走而謊報套用、驗證、撤回成功時，這裡會事後抓到。
--
-- 平台認為該有的（expected）：每張單在這個通道上最後一筆成功的套用，單仍在執行中或生效、之後沒有撤回或清除。
-- 還不確定的（tolerated）：這張單在這個通道上還有交付沒有結果（送出中、等重送、撤回或清除還沒完成），
-- 外部系統上有它的舊或新權限都不算不一致——卡住由 K-DELIVERY-STUCK 處理。

insert into sgn.hook_definition (hook, arg_types, result_type, returns_set, description) values
    ('expected_entitlements', 'jsonb', 'jsonb', false,
        '把送出的執行內容展開成外部系統上應該存在的權限項目 [{subject, resource, action, rule_id, constraints, valid}]。沒有登記：沒有項目'),
    ('normalize_constraints', 'jsonb', 'jsonb', false, '把權限項目的限制整理成可以直接比對的樣子。沒有登記：原樣');

insert into sgn.error_catalog (code, message, http_status) values
    ('RECONCILIATION_INVALID', '對帳回報的格式不正確', 422);

create function sgn_internal.hook_jsonb(p_process_type text, p_hook text, p_arg jsonb, p_default jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, p_hook);
    v_result jsonb;
begin
    if v_fn is null then
        return p_default;
    end if;
    execute format('select %s($1)', v_fn::regprocedure::regproc) into v_result using p_arg;
    return v_result;
end;
$$;

-- 外部系統給的時間：格式不對時是 null（不讓整輪對帳失敗）。
create function sgn_internal.try_timestamptz(p_text text)
returns timestamptz
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
    return p_text::timestamptz;
exception
    when others then
        return null;
end;
$$;

create table sgn.reconciliation_run (
    id bigint generated always as identity primary key,
    channel text not null,
    process_type text not null references sgn.process_type (code),
    observed_at timestamptz,
    received_at timestamptz not null,
    report_sha256 bytea not null,
    observed_count int not null,
    expected_count int not null,
    summary jsonb not null
);

-- 一個發現從第一次出現到消失（下一輪對帳沒看到）為止；每個發現只開一次例外。
create table sgn.reconciliation_finding (
    id bigint generated always as identity primary key,
    channel text not null,
    finding_key text not null,
    kind text not null check (kind in ('extra', 'missing', 'different')),
    case_id uuid references sgn.request_case (id),
    detail jsonb not null,
    first_run_id bigint not null references sgn.reconciliation_run (id),
    last_run_id bigint not null references sgn.reconciliation_run (id),
    resolved_run_id bigint references sgn.reconciliation_run (id),
    exception_id bigint not null references sgn.exception_record (id)
);

create unique index reconciliation_finding_open on sgn.reconciliation_finding (channel, finding_key) where resolved_run_id is null;

-- 每張單在這個通道上的對帳狀態：expected（最後一筆成功套用的內容該在）、tolerated（還不確定）、或都不是（不該有任何權限）。
create function sgn_internal.reconciliation_cases(p_channel text)
returns table (case_id uuid, case_no text, standing text, current_rule_set jsonb, rule_sets jsonb)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select
        c.id,
        c.case_no::text,
        case
            when exists (select 1 from sgn.delivery_op as o where o.case_id = c.id and o.channel = p_channel and o.status in ('queued', 'sending')
                         and (o.kind <> 'verify'))
                 or exists (select 1 from sgn.delivery_op as o where o.channel = p_channel and o.kind = 'purge' and o.status in ('queued', 'sending')
                            and c.state = 'expired')
                then 'tolerated'
            when c.state in ('pending_fulfilment', 'verifying', 'active')
                 and last_apply.id is not null
                 and last_apply.version = c.current_version
                 and not exists (select 1 from sgn.delivery_op as w where w.case_id = c.id and w.channel = p_channel
                                 and w.kind = 'withdraw' and w.status = 'done' and w.id > last_apply.id)
                then 'expected'
            else 'none'
        end,
        last_apply.body::jsonb,
        coalesce((select jsonb_agg(o.body::jsonb order by o.id) from sgn.delivery_op as o
                  where o.case_id = c.id and o.channel = p_channel and o.kind = 'apply' and o.attempts > 0), '[]'::jsonb)
    from sgn.request_case as c
    left join lateral (
        select o.id, o.version, o.body from sgn.delivery_op as o
        where o.case_id = c.id and o.channel = p_channel and o.kind = 'apply' and o.status = 'done'
        order by o.id desc
        limit 1
    ) as last_apply on true
    where exists (select 1 from sgn.delivery_op as o where o.case_id = c.id and o.channel = p_channel and o.kind = 'apply')
$$;

-- 平台這一側的項目：{key, standing, case_id, item}。standing 是 expected 或 tolerated。
create function sgn_internal.reconciliation_expected(p_channel text, p_process_type text)
returns table (key text, standing text, case_id uuid, item jsonb)
language sql
set search_path = pg_catalog, pg_temp
as $$
    select distinct on (e ->> 'subject', e ->> 'resource', e ->> 'action', e ->> 'rule_id', x.standing)
        concat_ws('|', e ->> 'subject', e ->> 'resource', e ->> 'action', e ->> 'rule_id'),
        x.standing,
        x.case_id,
        e
    from sgn_internal.reconciliation_cases(p_channel) as x
    cross join lateral jsonb_array_elements(
        case x.standing when 'expected' then jsonb_build_array(x.current_rule_set) else x.rule_sets end
    ) as rs (rule_set)
    cross join lateral jsonb_array_elements(sgn_internal.hook_jsonb(p_process_type, 'expected_entitlements', rs.rule_set, '[]')) as e
    where x.standing in ('expected', 'tolerated')
$$;

-- 外部系統回報的項目整理成 {key, item}；限制經流程包整理後才能直接比對。
create function sgn_internal.reconciliation_observed(p_report jsonb, p_process_type text)
returns table (key text, item jsonb)
language sql
set search_path = pg_catalog, pg_temp
as $$
    select
        concat_ws('|', i #>> '{subject,id}', i #>> '{resource,id}', i #>> '{action,name}', coalesce(i #>> '{properties,rule_id}', '-')),
        jsonb_build_object(
            'subject', i #>> '{subject,id}',
            'resource', i #>> '{resource,id}',
            'action', i #>> '{action,name}',
            'rule_id', i #>> '{properties,rule_id}',
            'case_no', i #>> '{properties,case_no}',
            'constraints', sgn_internal.hook_jsonb(p_process_type, 'normalize_constraints', coalesce(i -> 'constraints', '{}'), coalesce(i -> 'constraints', '{}')),
            'valid', i #> '{properties,valid}',
            'properties', i -> 'properties'
        )
    from jsonb_array_elements(p_report -> 'items') as i
$$;

-- 這一輪的發現：多出來的（外部系統有、平台不認為該有也不在不確定期）、少掉的、範圍或有效期間不同的。
create function sgn_internal.reconciliation_compare(p_channel text, p_report jsonb)
returns table (kind text, finding_key text, case_id uuid, detail jsonb)
language sql
set search_path = pg_catalog, pg_temp
as $$
    with obs as (
        select * from sgn_internal.reconciliation_observed(p_report, p_report ->> 'process_type')
    ),
    exp as (
        select * from sgn_internal.reconciliation_expected(p_channel, p_report ->> 'process_type')
    )
    select 'extra', 'extra|' || o.key,
        (select c.id from sgn.request_case as c where c.case_no::text = o.item ->> 'case_no'),
        jsonb_build_object('key', o.key, 'observed', o.item)
    from obs as o
    where not exists (select 1 from exp as e where e.key = o.key)
    union all
    select 'missing', 'missing|' || e.key, e.case_id, jsonb_build_object('key', e.key, 'expected', e.item)
    from exp as e
    where e.standing = 'expected' and not exists (select 1 from obs as o where o.key = e.key)
    union all
    select 'different', 'different|' || e.key, e.case_id, jsonb_build_object('key', e.key, 'expected', e.item, 'observed', o.item)
    from exp as e
    join obs as o on o.key = e.key
    where e.standing = 'expected'
      and (o.item -> 'constraints' is distinct from e.item -> 'constraints' or o.item -> 'valid' is distinct from e.item -> 'valid')
$$;

create function sgn_internal.reconciliation_submit(p_channel text, p_report jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_run bigint;
    v_finding record;
    v_new int := 0;
    v_resolved int;
    v_process text := p_report ->> 'process_type';
begin
    if jsonb_typeof(p_report) is distinct from 'object' or jsonb_typeof(p_report -> 'items') is distinct from 'array'
       or not exists (select 1 from sgn.process_type as t where t.code = v_process) then
        perform sgn_internal.raise_error('RECONCILIATION_INVALID');
    end if;
    -- 同一個通道一次只對一輪（排程與手動同時跑時，同一個發現不會被開兩次）
    perform pg_advisory_xact_lock(hashtext('sgn.reconciliation:' || p_channel));
    insert into sgn.reconciliation_run (channel, process_type, observed_at, received_at, report_sha256, observed_count, expected_count, summary)
    values (
        p_channel, v_process, sgn_internal.try_timestamptz(p_report ->> 'observed_at'), sgn_internal.now(), sgn_internal.jcs_sha256(p_report),
        jsonb_array_length(p_report -> 'items'),
        (select count(*) from sgn_internal.reconciliation_expected(p_channel, v_process) as e where e.standing = 'expected'),
        '{}'::jsonb
    )
    returning id into v_run;
    for v_finding in select * from sgn_internal.reconciliation_compare(p_channel, p_report) loop
        update sgn.reconciliation_finding set last_run_id = v_run, detail = v_finding.detail
        where channel = p_channel and finding_key = v_finding.finding_key and resolved_run_id is null;
        if not found then
            insert into sgn.reconciliation_finding (channel, finding_key, kind, case_id, detail, first_run_id, last_run_id, exception_id)
            values (p_channel, v_finding.finding_key, v_finding.kind, v_finding.case_id, v_finding.detail, v_run, v_run,
                sgn_internal.exception_open(
                    case v_finding.kind when 'extra' then 'K-RECON-EXTRA' when 'missing' then 'K-RECON-MISSING' else 'K-RECON-DIFFERENT' end,
                    v_finding.case_id, v_finding.detail || jsonb_build_object('channel', p_channel, 'run', v_run)));
            v_new := v_new + 1;
        end if;
    end loop;
    update sgn.reconciliation_finding set resolved_run_id = v_run
    where channel = p_channel and resolved_run_id is null and last_run_id <> v_run;
    get diagnostics v_resolved = row_count;
    return sgn_internal.reconciliation_close(v_run, v_new, v_resolved);
end;
$$;

-- 一輪對帳的結果：寫進鏈，有新的發現就通知升級對象。
create function sgn_internal.reconciliation_close(p_run bigint, p_new int, p_resolved int)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_run sgn.reconciliation_run;
    v_summary jsonb;
begin
    select * into v_run from sgn.reconciliation_run where id = p_run;
    v_summary := jsonb_build_object(
        'run', p_run, 'channel', v_run.channel, 'observed', v_run.observed_count, 'expected', v_run.expected_count,
        'open', (select jsonb_object_agg(k.kind, k.n) from (
            select f.kind, count(*) as n from sgn.reconciliation_finding as f
            where f.channel = v_run.channel and f.resolved_run_id is null group by f.kind) as k),
        'new_findings', p_new, 'resolved', p_resolved
    );
    update sgn.reconciliation_run set summary = v_summary where id = p_run;
    perform sgn_internal.audit_append(
        'reconciliation.completed', null, null,
        v_summary || jsonb_build_object('observed_at', v_run.observed_at, 'report_sha256', encode(v_run.report_sha256, 'hex'),
            'rules', jsonb_build_array('K-RECON-EXTRA', 'K-RECON-MISSING', 'K-RECON-DIFFERENT'))
    );
    if p_new > 0 then
        perform sgn_internal.notify('reconciliation.finding', sgn_internal.delivery_escalation_people(), null,
            jsonb_build_object('channel', v_run.channel, 'count', p_new::text));
    end if;
    return v_summary;
end;
$$;

create function api_job.reconciliation_submit(p_channel text, p_report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.reconciliation_submit(p_channel, p_report);
end;
$$;

comment on function api_job.reconciliation_submit(text, jsonb) is
    '對帳：交上外部系統的對帳回報（dc_reconciliation_report/1），與平台認為該有的權限比對；多出來的、少掉的、範圍不同的各開一次例外，'
    '下一輪沒看到就結案。呼叫者：sgn_job（api/src/reconciler.ts，以外部系統的唯讀稽核金鑰取得回報）。'
    '規則：K-RECON-EXTRA、K-RECON-MISSING、K-RECON-DIFFERENT';

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-RECON-EXTRA', '對帳：外部系統上有、平台沒有核准（或已撤銷、已到期且已清除）的權限，開例外', 'partial',
        '外部系統的對帳回報沒有簽章；對帳程式被拿走時可以交假的回報（威脅表未解）'),
    ('K-RECON-MISSING', '對帳：平台認為已生效、外部系統上卻沒有的權限，開例外（抓交付程式謊報套用成功）', 'partial',
        '同 K-RECON-EXTRA'),
    ('K-RECON-DIFFERENT', '對帳：兩邊都有但列條件、資料期間或有效期間不同，開例外', 'partial', '同 K-RECON-EXTRA')
) as r (code, description, coverage, note);

insert into sgn.notification_template (event_code, subject, body) values
    ('reconciliation.finding', '對帳發現不一致：{{channel}}', '{{channel}} 的實際權限有 {{count}} 項與平台的核准不一致，已開例外。');
