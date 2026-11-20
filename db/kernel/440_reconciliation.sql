-- 對帳（策略 4：核准之後繼續把關；裁決 D81 (3)）：對帳程式（api/src/reconciler.ts，帳號 sgn_job、外部系統的唯讀稽核金鑰）
-- 拉外部系統「實際存在」的權限，與平台認為該有的比對。多出來的、少掉的、範圍不同的各開例外（K-RECON-*）。
-- 採信的只有外部系統簽過的回報（405 的證明：驗章、端點、新鮮度、同一份只收一次）；對帳程式改、刪、加任何項目都沒有用，
-- 它只能不交——超過時間沒有有效回報由資料庫開例外（K-RECON-OVERDUE）。單輪項目與新發現有上限（參數，K-RECON-LIMIT）。
-- 「多出來的」屬於平台認得、已不該有權限的單（撤銷、到期、失敗）時自動排撤回；其餘升級（例外＋通知）。發現的結案進鏈。
--
-- 平台認為該有的：以平台的決定為準（目前這一版），不以「最後一筆送達的」為準——撤銷、縮小在平台那一刻生效，
-- 撤回或新的一版還沒送達時，外部系統上舊的權限就是多出來的（紅隊第四輪 高-2；交付程式或網路擋下送出也藏不住）。
-- 不確定期只留給「第一次套用還沒成功」（少的不算）與「已到期、清除還沒完成」。細節見 reconciliation_cases。

insert into sgn.hook_definition (hook, arg_types, result_type, returns_set, description) values
    ('expected_entitlements', 'jsonb', 'jsonb', false,
        '把送出的執行內容展開成外部系統上應該存在的權限項目 [{subject, resource, action, rule_id, constraints, valid}]。沒有登記：沒有項目'),
    ('normalize_constraints', 'jsonb', 'jsonb', false, '把權限項目的限制整理成可以直接比對的樣子。沒有登記：原樣');

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

select sgn_internal.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description)
from (values
    ('reconciliation.max_report_age_seconds', 'integer', '120', array['channel'],
        '外部系統簽的對帳回報，簽發時間離現在超過幾秒就不收（新鮮度；同一份回報也只收一次）'),
    ('reconciliation.max_interval_seconds', 'integer', '300', array['channel'],
        '超過幾秒沒有收到有效的對帳回報，就開例外 K-RECON-OVERDUE 並通知升級對象'),
    ('reconciliation.max_items', 'integer', '5000', array['channel'], '一份對帳回報最多幾個項目；超過整份不收並開例外 K-RECON-LIMIT'),
    ('reconciliation.max_new_findings', 'integer', '100', array['channel'],
        '一輪對帳最多逐筆開幾個新發現的例外；超過的仍記成發現，合併在一筆 K-RECON-LIMIT 例外裡並升級')
) as d (key, value_type, default_value, scope_kinds, description);

create table sgn.reconciliation_run (
    id bigint generated always as identity primary key,
    channel text not null,
    process_type text not null references sgn.process_type (code),
    observed_at timestamptz,
    received_at timestamptz not null,
    -- 外部系統簽的那段 payload 的 SHA-256：同一份回報只收一次
    report_sha256 bytea not null unique,
    observed_count int not null,
    expected_count int not null,
    summary jsonb not null
);

-- 一個發現從第一次出現到消失（下一輪有效的對帳沒看到）為止；每個發現只開一次例外。
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

create function sgn_internal.reconciliation_setting_int(p_key text, p_channel text)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (sgn_internal.setting(p_key, array['channel:' || p_channel]) #>> '{}')::int
$$;

-- 每張單在這個通道上的對帳狀態：expected（目前這一版的規則該在）、tolerated（還不確定）、或都不是（不該有任何權限）。
--   執行中或生效、而且曾經成功套用過：expected＝目前這一版（縮小送出中也一樣：縮小在平台那一刻生效，外部系統上舊版多出來的
--     欄位就是多出來的，交付程式擋下新的一版也藏不住；紅隊第四輪 腳本 21 b）。送達前的幾秒會有發現，下一輪結案並進鏈。
--   執行中、第一次套用還沒成功：tolerated＝目前這一版（少的不算，多出來的照算）。
--   已到期、清除還沒完成：tolerated＝送出過的每一版。
--   其他（撤銷、失敗、到期且已清除）：什麼都不該有。
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
            when c.state in ('pending_fulfilment', 'verifying', 'active') and current_apply.id is not null
                 and not exists (select 1 from sgn.delivery_op as o where o.case_id = c.id and o.channel = p_channel
                                 and o.kind = 'apply' and o.status = 'done')
                then 'tolerated'
            when c.state in ('pending_fulfilment', 'verifying', 'active') and current_apply.id is not null
                then 'expected'
            when c.state = 'expired'
                 and exists (select 1 from sgn.delivery_op as o where o.channel = p_channel and o.kind = 'purge' and o.status in ('queued', 'sending'))
                then 'tolerated'
            else 'none'
        end,
        current_apply.body::jsonb,
        case
            when c.state = 'expired'
                then coalesce((select jsonb_agg(o.body::jsonb order by o.id) from sgn.delivery_op as o
                               where o.case_id = c.id and o.channel = p_channel and o.kind = 'apply' and o.attempts > 0), '[]'::jsonb)
            else coalesce(jsonb_build_array(current_apply.body::jsonb), '[]'::jsonb)
        end
    from sgn.request_case as c
    left join lateral (
        select o.id, o.body from sgn.delivery_op as o
        where o.case_id = c.id and o.channel = p_channel and o.kind = 'apply' and o.version = c.current_version
        order by o.id desc
        limit 1
    ) as current_apply on true
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

-- 不收的回報（沒有有效的證明、過期、重送、太大）：回傳原因；同一個通道在新鮮度的時間內只開一筆例外並升級
-- （對帳帳號不能用大量的壞回報灌爆例外）。
create function sgn_internal.reconciliation_reject(p_channel text, p_rule_code text, p_reason text, p_detail jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_window int := sgn_internal.reconciliation_setting_int('reconciliation.max_report_age_seconds', p_channel);
begin
    if not exists (
        select 1 from sgn.exception_record as x
        where x.rule_code = p_rule_code and x.detail ->> 'channel' = p_channel
          and x.opened_at > sgn_internal.now() - make_interval(secs => v_window)
    ) then
        perform sgn_internal.exception_open(p_rule_code, null, p_detail || jsonb_build_object(
            'channel', p_channel, 'reason', p_reason,
            'settings', jsonb_build_object('reconciliation.max_report_age_seconds', v_window)));
        perform sgn_internal.notify('reconciliation.rejected', sgn_internal.delivery_escalation_people(), null,
            jsonb_build_object('channel', p_channel, 'reason', p_reason));
    end if;
    return jsonb_build_object('status', 'rejected', 'channel', p_channel, 'reason', p_reason);
end;
$$;

-- 交上來的回應 → 驗過的回報（證明的 payload.result）與它的摘要；不收時是 rejected 的結果。
create function sgn_internal.reconciliation_accept(p_channel text, p_response jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_att jsonb := sgn_internal.attestation_open(p_channel, p_response, jsonb_build_object(
        'method', 'GET', 'path', '/reconciliation', 'request_sha256', encode(sgn_internal.digest('', 'sha256'), 'hex')));
    v_max_age int := sgn_internal.reconciliation_setting_int('reconciliation.max_report_age_seconds', p_channel);
    v_issued timestamptz;
    v_sha bytea;
    v_report jsonb;
begin
    if not (v_att ->> 'ok')::boolean then
        return sgn_internal.reconciliation_reject(p_channel, 'K-RECON-UNVERIFIED', 'unverified', jsonb_build_object('attestation', v_att));
    end if;
    v_issued := sgn_internal.try_timestamptz(v_att #>> '{payload,issued_at}');
    if v_issued is null or abs(extract(epoch from sgn_internal.now() - v_issued)) > v_max_age then
        return sgn_internal.reconciliation_reject(p_channel, 'K-RECON-UNVERIFIED', 'stale', jsonb_build_object('issued_at', v_att #>> '{payload,issued_at}'));
    end if;
    v_sha := sgn_internal.digest(convert_to(p_response #>> '{attestation,payload}', 'UTF8'), 'sha256');
    if exists (select 1 from sgn.reconciliation_run as r where r.report_sha256 = v_sha) then
        return sgn_internal.reconciliation_reject(p_channel, 'K-RECON-UNVERIFIED', 'replay', jsonb_build_object('report_sha256', encode(v_sha, 'hex')));
    end if;
    v_report := v_att #> '{payload,result}';
    if (v_att #>> '{payload,http_status}')::int <> 200 or jsonb_typeof(v_report -> 'items') is distinct from 'array'
       or not exists (select 1 from sgn.process_type as t where t.code = v_report ->> 'process_type') then
        return sgn_internal.reconciliation_reject(p_channel, 'K-RECON-UNVERIFIED', 'format',
            jsonb_build_object('http_status', v_att #>> '{payload,http_status}', 'error', v_report ->> 'error'));
    end if;
    if jsonb_array_length(v_report -> 'items') > sgn_internal.reconciliation_setting_int('reconciliation.max_items', p_channel) then
        return sgn_internal.reconciliation_reject(p_channel, 'K-RECON-LIMIT', 'too_many_items', jsonb_build_object(
            'items', jsonb_array_length(v_report -> 'items'),
            'settings', jsonb_build_object('reconciliation.max_items', sgn_internal.reconciliation_setting_int('reconciliation.max_items', p_channel))));
    end if;
    return jsonb_build_object('status', 'accepted', 'report', v_report, 'report_sha256', encode(v_sha, 'hex'), 'issued_at', v_issued);
end;
$$;

-- 「多出來的」屬於平台認得、已經不該有權限的單：排撤回（已經有撤回在排就不重複）。回傳是否排了。
create function sgn_internal.reconciliation_withdraw_extra(p_channel text, p_case_id uuid, p_run bigint)
returns boolean
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_op bigint;
begin
    select * into v_case from sgn.request_case where id = p_case_id;
    if v_case.id is null or v_case.state in ('pending_fulfilment', 'verifying', 'active')
       or exists (select 1 from sgn.delivery_op as o where o.case_id = p_case_id and o.channel = p_channel
                  and o.kind = 'withdraw' and o.status in ('queued', 'sending')) then
        return false;
    end if;
    v_op := sgn_internal.delivery_op_create(p_channel, 'withdraw', p_case_id, v_case.current_version,
        jsonb_build_object('case_no', v_case.case_no::text));
    perform sgn_internal.audit_append(
        'reconciliation.withdraw_scheduled', p_case_id, null,
        jsonb_build_object('channel', p_channel, 'run', p_run, 'op', v_op, 'state', v_case.state, 'rules', jsonb_build_array('K-RECON-EXTRA'))
    );
    return true;
end;
$$;

-- 一個新發現：開例外（超過單輪上限時合併到這一輪的 K-RECON-LIMIT），多出來的再看要不要自動排撤回。
create function sgn_internal.reconciliation_open_finding(
    p_channel text,
    p_run bigint,
    p_kind text,
    p_key text,
    p_case_id uuid,
    p_detail jsonb,
    p_limit_exception bigint
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_withdraw boolean := false;
    v_detail jsonb;
begin
    if p_kind = 'extra' and p_case_id is not null then
        v_withdraw := sgn_internal.reconciliation_withdraw_extra(p_channel, p_case_id, p_run);
    end if;
    v_detail := p_detail || jsonb_build_object('channel', p_channel, 'run', p_run,
        'action', case when v_withdraw then 'withdraw_scheduled' else 'escalated' end);
    insert into sgn.reconciliation_finding (channel, finding_key, kind, case_id, detail, first_run_id, last_run_id, exception_id)
    values (p_channel, p_key, p_kind, p_case_id, p_detail, p_run, p_run,
        coalesce(p_limit_exception, sgn_internal.exception_open(
            case p_kind when 'extra' then 'K-RECON-EXTRA' when 'missing' then 'K-RECON-MISSING' else 'K-RECON-DIFFERENT' end,
            p_case_id, v_detail)));
end;
$$;

create function sgn_internal.reconciliation_submit(p_channel text, p_response jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_accepted jsonb;
    v_report jsonb;
    v_run bigint;
    v_finding record;
    v_new int := 0;
    v_cap int := sgn_internal.reconciliation_setting_int('reconciliation.max_new_findings', p_channel);
    v_limit_exception bigint;
    v_resolved int;
    v_process text;
begin
    -- 同一個通道一次只對一輪（排程與手動同時跑時，同一個發現不會被開兩次）
    perform pg_advisory_xact_lock(hashtext('sgn.reconciliation:' || p_channel));
    v_accepted := sgn_internal.reconciliation_accept(p_channel, p_response);
    if v_accepted ->> 'status' <> 'accepted' then
        return v_accepted;
    end if;
    v_report := v_accepted -> 'report';
    v_process := v_report ->> 'process_type';
    insert into sgn.reconciliation_run (channel, process_type, observed_at, received_at, report_sha256, observed_count, expected_count, summary)
    values (
        p_channel, v_process, sgn_internal.try_timestamptz(v_report ->> 'observed_at'), sgn_internal.now(),
        decode(v_accepted ->> 'report_sha256', 'hex'), jsonb_array_length(v_report -> 'items'),
        (select count(*) from sgn_internal.reconciliation_expected(p_channel, v_process) as e where e.standing = 'expected'),
        '{}'::jsonb
    )
    returning id into v_run;
    for v_finding in select * from sgn_internal.reconciliation_compare(p_channel, v_report) loop
        update sgn.reconciliation_finding set last_run_id = v_run, detail = v_finding.detail
        where channel = p_channel and finding_key = v_finding.finding_key and resolved_run_id is null;
        if not found then
            if v_new = v_cap then
                v_limit_exception := sgn_internal.exception_open('K-RECON-LIMIT', null, jsonb_build_object(
                    'channel', p_channel, 'run', v_run, 'reason', 'too_many_new_findings',
                    'settings', jsonb_build_object('reconciliation.max_new_findings', v_cap)));
            end if;
            perform sgn_internal.reconciliation_open_finding(p_channel, v_run, v_finding.kind, v_finding.finding_key, v_finding.case_id,
                v_finding.detail, v_limit_exception);
            v_new := v_new + 1;
        end if;
    end loop;
    v_resolved := sgn_internal.reconciliation_resolve(p_channel, v_run);
    return sgn_internal.reconciliation_close(v_run, v_new, v_resolved);
end;
$$;

-- 這一輪沒看到的發現結案；每一筆結案都進鏈（不會無人知曉地消失）。
create function sgn_internal.reconciliation_resolve(p_channel text, p_run bigint)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_finding sgn.reconciliation_finding;
    v_count int := 0;
begin
    for v_finding in
        update sgn.reconciliation_finding set resolved_run_id = p_run
        where channel = p_channel and resolved_run_id is null and last_run_id <> p_run
        returning *
    loop
        perform sgn_internal.audit_append(
            'reconciliation.finding_resolved', v_finding.case_id, null,
            jsonb_build_object('finding', v_finding.id, 'channel', p_channel, 'kind', v_finding.kind, 'key', v_finding.finding_key,
                'exception', v_finding.exception_id, 'first_run', v_finding.first_run_id, 'resolved_run', p_run,
                'rules', jsonb_build_array('K-RECON-RESOLVED'))
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
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
        'status', 'accepted', 'run', p_run, 'channel', v_run.channel, 'observed', v_run.observed_count, 'expected', v_run.expected_count,
        'open', (select jsonb_object_agg(k.kind, k.n) from (
            select f.kind, count(*) as n from sgn.reconciliation_finding as f
            where f.channel = v_run.channel and f.resolved_run_id is null group by f.kind) as k),
        'new_findings', p_new, 'resolved', p_resolved
    );
    update sgn.reconciliation_run set summary = v_summary where id = p_run;
    perform sgn_internal.audit_append(
        'reconciliation.completed', null, null,
        v_summary || jsonb_build_object('observed_at', v_run.observed_at, 'report_sha256', encode(v_run.report_sha256, 'hex'),
            'rules', jsonb_build_array('K-RECON-EXTRA', 'K-RECON-MISSING', 'K-RECON-DIFFERENT', 'K-DELIVERY-ATTESTED'))
    );
    if p_new > 0 then
        perform sgn_internal.notify('reconciliation.finding', sgn_internal.delivery_escalation_people(), null,
            jsonb_build_object('channel', v_run.channel, 'count', p_new::text));
    end if;
    return v_summary;
end;
$$;

-- 逾期：有自動交付的通道超過參數的時間沒有有效的對帳回報，開例外並升級（每段逾期一筆）。回傳開了幾筆。
create function sgn_internal.reconciliation_overdue_check()
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
    for v_channel in select distinct o.channel from sgn.delivery_op as o order by 1 loop
        v_seconds := sgn_internal.reconciliation_setting_int('reconciliation.max_interval_seconds', v_channel);
        v_since := coalesce(
            (select max(r.received_at) from sgn.reconciliation_run as r where r.channel = v_channel),
            (select min(o.created_at) from sgn.delivery_op as o where o.channel = v_channel)
        );
        if v_since < sgn_internal.now() - make_interval(secs => v_seconds)
           and not exists (select 1 from sgn.exception_record as x where x.rule_code = 'K-RECON-OVERDUE'
                           and x.detail ->> 'channel' = v_channel and x.opened_at > v_since) then
            perform sgn_internal.exception_open('K-RECON-OVERDUE', null, jsonb_build_object(
                'channel', v_channel, 'last_valid_report_or_first_delivery', v_since,
                'settings', jsonb_build_object('reconciliation.max_interval_seconds', v_seconds)));
            perform sgn_internal.notify('reconciliation.overdue', sgn_internal.delivery_escalation_people(), null,
                jsonb_build_object('channel', v_channel));
            v_count := v_count + 1;
        end if;
    end loop;
    return v_count;
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
    '對帳：交上外部系統的對帳回應（含外部系統的證明，dc_reconciliation_report/1），只採信證明裡的回報（驗章、端點、新鮮度、只收一次）；'
    '與平台認為該有的權限比對，多出來的、少掉的、範圍不同的各開一次例外，屬於已不該有權限的單的多出來的自動排撤回，'
    '下一輪有效的回報沒看到就結案並進鏈。不收的回應回 rejected（限速開例外）。'
    '呼叫者：sgn_job（api/src/reconciler.ts，以外部系統的唯讀稽核金鑰取得回報）。'
    '規則：K-RECON-EXTRA、K-RECON-MISSING、K-RECON-DIFFERENT、K-RECON-UNVERIFIED、K-RECON-LIMIT、K-RECON-RESOLVED、K-DELIVERY-ATTESTED';

create function api_job.reconciliation_overdue_check()
returns int
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.reconciliation_overdue_check();
end;
$$;

comment on function api_job.reconciliation_overdue_check() is
    '排程：有自動交付的通道超過 reconciliation.max_interval_seconds 沒有有效的對帳回報時開例外並通知升級對象。'
    '呼叫者：sgn_job（db/tools/jobs.mjs）。規則：K-RECON-OVERDUE';

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-RECON-EXTRA', '對帳：外部系統上有、平台沒有核准（或已撤銷、已到期且已清除）的權限，開例外；屬於平台認得、已不該有權限的單時自動排撤回',
        'full', null),
    ('K-RECON-MISSING', '對帳：平台認為已生效、外部系統上卻沒有的權限，開例外（抓交付程式謊報套用成功）', 'full', null),
    ('K-RECON-DIFFERENT', '對帳：兩邊都有但列條件、資料期間或有效期間不同，開例外', 'full', null),
    ('K-RECON-UNVERIFIED', '對帳：沒有外部系統有效證明、過期或重送的回報不採信，開例外並升級（同一通道在新鮮度的時間內一筆）', 'full', null),
    ('K-RECON-OVERDUE', '對帳：超過參數的時間沒有有效的對帳回報，由資料庫開例外並升級', 'full', null),
    ('K-RECON-LIMIT', '對帳：單輪項目超過上限整份不收；新發現超過上限時合併成一筆例外並升級', 'full', null),
    ('K-RECON-RESOLVED', '對帳：發現只在之後一份有效的回報沒看到時結案，每一筆結案都進鏈', 'full', null)
) as r (code, description, coverage, note);

insert into sgn.notification_template (event_code, subject, body) values
    ('reconciliation.finding', '對帳發現不一致：{{channel}}', '{{channel}} 的實際權限有 {{count}} 項與平台的核准不一致，已開例外。'),
    ('reconciliation.rejected', '對帳回報不採信：{{channel}}', '{{channel}} 交來的對帳回報沒有通過外部系統證明的檢查（{{reason}}），已開例外。'),
    ('reconciliation.overdue', '對帳逾期：{{channel}}', '{{channel}} 超過時間沒有有效的對帳回報，已開例外。請確認對帳程式與外部系統。');
