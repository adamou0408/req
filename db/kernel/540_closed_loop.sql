-- 核准內容 → 使用方系統的閉環，核心的部分（裁決 D91、D92；docs/handoff/closed-loop-1.md）。
-- 核心只提供通用的入口，判斷都在流程包的 hook：
--   1. sgn_sdk 補上流程包要用的入口：標準化雜湊、寫稽核、開與結例外、通知、工作日、列出某些狀態的單、重新綁定內容。
--   2. 重新綁定（K-CONTENT-REBIND）：流程包依據的外部定義改版（例如資料目錄）時，簽核中的單以新定義重新整理成新的一版，
--      從第一關重簽；整理後有錯就退回申請人。誰之前簽過都不算數（版本雜湊變了，K-VERSION-BOUND）。
--   3. 交付結果的判定（K-DELIVERY-RESULT-CHECK）：外部系統的證明驗過、核心判定「成功」之後，再問流程包的 hook
--      check_delivery_result：回 null 接受；{action: retry} 視同沒送到（寬限時間內重送）；其他視同外部系統拒絕
--      （不生效、撤回、開 hook 指定規則代碼的例外）。
--   4. 對帳回報的判定（K-RECON-REPORT-CHECK）：收下的回報再交給 hook check_reconciliation_report，回傳的問題各開一筆例外
--      （同一個規則代碼、同一張單、同一個通道同時只有一筆未結案）。
--   5. 驗證案例可以標成「不驗」（K-VERIFY-SKIPPED）：hook 產生的案例帶 skip 時不送外部系統、不算進比對，記在驗證紀錄與鏈上。
--   6. 有期限的例外（K-EXCEPTION-FOLLOWUP）：開例外時給期限，逾期還沒結案就通知升級對象（只通知一次，不替人做決定）。

-- ── 1. sgn_sdk ──

create function sgn_sdk.jcs_sha256(p_value jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select encode(sgn_internal.jcs_sha256(p_value), 'hex')
$$;

create function sgn_sdk.now()
returns timestamptz
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.now()
$$;

create function sgn_sdk.add_workdays(p_from timestamptz, p_days int)
returns timestamptz
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.add_workdays(p_from, p_days)
$$;

create function sgn_sdk.audit_append(p_event_type text, p_case_id uuid, p_actor uuid, p_data jsonb)
returns bigint
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.audit_append(p_event_type, p_case_id, p_actor, p_data)
$$;

create function sgn_sdk.exception_open(p_rule_code text, p_case_id uuid, p_detail jsonb)
returns bigint
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.exception_open(p_rule_code, p_case_id, p_detail)
$$;

create function sgn_sdk.exception_close(p_id bigint, p_detail jsonb)
returns boolean
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.exception_close(p_id, p_detail)
$$;

-- 未結案的例外（流程包去重、找要確認的那一筆用）。
create function sgn_sdk.exceptions_open(p_rule_code text)
returns table (id bigint, case_id uuid, detail jsonb, opened_at timestamptz)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select x.id, x.case_id, x.detail, x.opened_at
    from sgn.exception_record as x
    where x.rule_code = p_rule_code and x.closed_at is null
    order by x.id
$$;

create function sgn_sdk.notify(p_event_code text, p_person_ids uuid[], p_case_id uuid, p_payload jsonb)
returns int
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.notify(p_event_code, p_person_ids, p_case_id, p_payload)
$$;

create function sgn_sdk.register_notification_template(p_event_code text, p_subject text, p_body text)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    insert into sgn.notification_template (event_code, subject, body) values (p_event_code, p_subject, p_body)
    on conflict (event_code) do update set subject = excluded.subject, body = excluded.body
$$;

-- 某個流程類型、某些狀態的單與它目前的版本（流程包在外部定義改版時逐張比對用）。
create function sgn_sdk.cases_in_states(p_process_type text, p_states text[])
returns table (case_id uuid, case_no bigint, state text, version int, content jsonb, applicant_id uuid)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select c.id, c.case_no, c.state, v.version, v.content, c.applicant_person_id
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    where c.process_type = p_process_type and c.state = any (p_states)
    order by c.case_no
$$;

-- ── 2. 重新綁定（K-CONTENT-REBIND）──

insert into sgn.state_transition (entity, from_state, action, to_state) values
    ('case', 'in_approval', 'rebind', 'in_approval'),
    ('case', 'in_approval', 'rebind_return', 'returned');

insert into sgn.error_catalog (code, message, http_status) values
    ('REBIND_STATE', '只有簽核中的單可以重新綁定', 409);

-- 之前的關卡全部作廢、改用最新版路徑（和退回後擴大重送相同的做法，K-RETURN）。
create function sgn_internal.case_restart_stages(p_case sgn.request_case, p_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.stages_close_open(p_case.id, 'cancelled', p_reason);
    update sgn.case_stage set status = 'cancelled', close_reason = 'restart'
    where case_id = p_case.id and status in ('done', 'returned');
    update sgn.request_case set policy_id = (sgn_internal.policy_latest(p_case.process_type)).id where id = p_case.id;
end;
$$;

-- 以目前的內容重新整理（流程包的 normalize_content 依當下的外部定義）成新的一版。內容沒變（版本雜湊相同）就不動，回 null。
-- 整理後沒有錯：從第一關重簽；有錯：退回申請人修正（退回的那一版就是新的一版）。回傳新的版本號。
create function sgn_internal.case_rebind(p_case_id uuid, p_rule_code text, p_detail jsonb)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_current sgn.case_version;
    v_prepared jsonb;
    v_version int;
    v_invalid boolean;
begin
    if v_case.state <> 'in_approval' then
        perform sgn_internal.raise_error('REBIND_STATE', v_case.state);
    end if;
    select * into v_current from sgn.case_version where case_id = p_case_id and version = v_case.current_version;
    v_prepared := sgn_internal.version_prepare(v_case.process_type, v_current.content, v_current.terms);
    if v_prepared ->> 'version_sha256' = encode(v_current.version_sha256, 'hex') then
        return null;
    end if;
    v_invalid := jsonb_array_length(v_prepared -> 'errors') > 0;
    v_version := sgn_internal.version_store(p_case_id, v_prepared, 'expand', null);
    perform sgn_internal.case_restart_stages(v_case, 'rebind');
    if v_invalid then
        update sgn.request_case set resume_seq = null, returned_version = v_version where id = p_case_id;
    end if;
    perform sgn_internal.case_transition(p_case_id, case when v_invalid then 'rebind_return' else 'rebind' end);
    perform sgn_internal.audit_append('case.rebound', p_case_id, null, jsonb_build_object(
        'from_version', v_current.version, 'version', v_version,
        'from_version_sha256', encode(v_current.version_sha256, 'hex'), 'version_sha256', v_prepared ->> 'version_sha256',
        'content_sha256', v_prepared ->> 'content_sha256', 'tier', v_prepared ->> 'tier',
        'returned', v_invalid, 'errors', v_prepared -> 'errors', 'detail', p_detail,
        'rules', jsonb_build_array('K-CONTENT-REBIND', p_rule_code)));
    perform sgn_internal.notify('case.rebound', array[v_case.applicant_person_id], p_case_id,
        jsonb_build_object('case_no', v_case.case_no::text));
    if not v_invalid then
        perform sgn_internal.case_advance(p_case_id);
    end if;
    return v_version;
end;
$$;

create function sgn_sdk.case_rebind(p_case_id uuid, p_rule_code text, p_detail jsonb)
returns int
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.case_rebind(p_case_id, p_rule_code, p_detail)
$$;

insert into sgn.notification_template (event_code, subject, body) values
    ('case.rebound', '申請內容依新的定義重新整理：{{case_no}}',
        '{{case_no}} 依據的定義（例如資料目錄）已改版，內容已重新整理成新的一版，要從第一關重新簽核；整理後有問題時已退回給你修正。');

-- ── 3. 交付結果的判定（K-DELIVERY-RESULT-CHECK）──

insert into sgn.hook_definition (hook, arg_types, result_type, returns_set, description) values
    ('check_delivery_result', 'uuid, jsonb', 'jsonb', false,
        '外部系統的證明驗過、核心判定成功之後再判定結果（p_context：kind、channel、created_at、rule_set、result）。'
        '回 null 接受；{action: retry, reason} 當成沒送到；{rule_code, reason, ...} 當成拒絕（不生效、撤回、開這個規則代碼的例外）。沒有登記：接受'),
    ('check_reconciliation_report', 'text, jsonb, uuid[]', 'jsonb', false,
        '收下的對帳回報再判定（p_case_ids：這個通道上平台認為該有權限的單）。回傳問題 [{rule_code, case_id, detail}]，'
        '核心各開一筆例外（同一規則代碼、單、通道未結案時不重開）。沒有登記：沒有問題');

create function sgn_internal.hook_delivery_result(p_process_type text, p_case_id uuid, p_context jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'check_delivery_result');
    v_result jsonb;
begin
    if v_fn is null then
        return null;
    end if;
    execute format('select %s($1, $2)', v_fn::regprocedure::regproc) into v_result using p_case_id, p_context;
    return nullif(v_result, 'null'::jsonb);
end;
$$;

-- 一筆判定成功的套用或驗證交給流程包再判定。回傳 null（接受）或 hook 的結果。
create function sgn_internal.delivery_result_check(p_op sgn.delivery_op, p_result jsonb)
returns jsonb
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.hook_delivery_result(c.process_type, p_op.case_id, jsonb_build_object(
        'kind', p_op.kind, 'channel', p_op.channel, 'created_at', p_op.created_at,
        'rule_set', case p_op.kind when 'verify' then p_op.body::jsonb -> 'rule_set' else p_op.body::jsonb end,
        'result', p_result))
    from sgn.request_case as c
    where c.id = p_op.case_id and p_op.kind in ('apply', 'verify')
$$;

-- 流程包判定不接受的結果：和外部系統拒絕相同的後果，但例外的規則代碼是流程包給的。
create function sgn_internal.delivery_after_refusal(p_op sgn.delivery_op, p_check jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.notify(
        'delivery.rejected', sgn_internal.delivery_escalation_people(), p_op.case_id,
        jsonb_build_object(
            'case_no', coalesce((select c.case_no::text from sgn.request_case as c where c.id = p_op.case_id), '-'),
            'kind', p_op.kind, 'channel', p_op.channel, 'error', coalesce(p_check ->> 'reason', p_check ->> 'rule_code')
        )
    );
    update sgn.verification_run
    set status = sgn_internal.entity_transition('verification_run', status, 'cancel'), finished_at = sgn_internal.now()
    where op_id = p_op.id and status = 'pending';
    perform sgn_internal.fulfilment_fail(p_op.case_id, p_check ->> 'rule_code', jsonb_build_object(
        'op', p_op.id, 'channel', p_op.channel, 'kind', p_op.kind, 'check', p_check, 'response', p_op.result));
end;
$$;

-- 外部系統的回報（同 410 的簽章）：多了核心判定成功之後的流程包判定（K-DELIVERY-RESULT-CHECK）。
create or replace function sgn_internal.delivery_report(p_op_id bigint, p_lease_token uuid, p_outcome jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_op sgn.delivery_op;
    v_verdict jsonb;
    v_class text;
    v_refused boolean;
    v_wait int;
    v_check jsonb;
begin
    select * into v_op from sgn.delivery_op where id = p_op_id for update;
    if v_op.id is null or v_op.status <> 'sending' or v_op.lease_token is distinct from p_lease_token then
        perform sgn_internal.raise_error('DELIVERY_LEASE', p_op_id::text);
    end if;
    v_verdict := sgn_internal.delivery_classify(v_op, p_outcome);
    v_class := v_verdict ->> 'class';
    if v_class = 'succeed' then
        v_check := sgn_internal.delivery_result_check(v_op, v_verdict -> 'result');
        if v_check is not null then
            v_class := case when v_check ->> 'action' = 'retry' then 'retry' else 'reject' end;
            v_verdict := v_verdict || jsonb_build_object('error', left(coalesce(v_check ->> 'reason', v_check ->> 'rule_code'), 1000));
        end if;
    end if;
    v_refused := v_class = 'reject' and v_op.kind = 'withdraw';
    if v_refused then
        v_class := 'retry';
    end if;
    v_wait := case v_class when 'retry' then sgn_internal.delivery_backoff_seconds(v_op.channel, v_op.attempts) end;
    update sgn.delivery_op
    set status = sgn_internal.entity_transition('delivery_op', v_op.status, v_class),
        lease_token = null, lease_until = null, nonce = null,
        last_http_status = (v_verdict ->> 'http_status')::int,
        last_error = v_verdict ->> 'error',
        result = v_verdict -> 'result',
        signature = case when (v_verdict ->> 'expired')::boolean then null else signature end,
        next_attempt_at = case v_class when 'retry' then sgn_internal.now() + make_interval(secs => v_wait) else next_attempt_at end,
        finished_at = case v_class when 'retry' then null else sgn_internal.now() end
    where id = v_op.id
    returning * into v_op;
    perform sgn_internal.delivery_report_audit(v_op, v_class, v_verdict, v_refused, v_wait, v_check);
    if v_refused and v_op.refused_exception_id is null then
        perform sgn_internal.delivery_withdraw_refused(v_op);
    end if;
    if v_class = 'succeed' then
        perform sgn_internal.delivery_after_success(v_op);
    elsif v_class = 'reject' and v_check is not null then
        perform sgn_internal.delivery_after_refusal(v_op, v_check);
    elsif v_class = 'reject' then
        perform sgn_internal.delivery_after_reject(v_op);
    end if;
    perform sgn_internal.delivery_stuck_check();
    return jsonb_build_object('op_id', v_op.id, 'status', v_op.status, 'next_attempt_at', v_op.next_attempt_at);
end;
$$;

create function sgn_internal.delivery_report_audit(
    p_op sgn.delivery_op,
    p_class text,
    p_verdict jsonb,
    p_refused boolean,
    p_wait int,
    p_check jsonb
)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.audit_append(
        'delivery.' || p_class, p_op.case_id, null,
        jsonb_build_object(
            'op', p_op.id, 'channel', p_op.channel, 'kind', p_op.kind, 'attempts', p_op.attempts, 'request_id', p_op.request_id,
            'http_status', p_op.last_http_status, 'response', p_op.result, 'error', p_op.last_error,
            'unverified', p_verdict -> 'unverified', 'refused', p_refused, 'check', p_check,
            'settings', case p_class when 'retry' then jsonb_build_object(
                'delivery.retry_base_seconds', sgn_internal.delivery_setting_int('delivery.retry_base_seconds', p_op.channel),
                'delivery.retry_max_seconds', sgn_internal.delivery_setting_int('delivery.retry_max_seconds', p_op.channel),
                'wait_seconds', p_wait) end,
            'rules', jsonb_build_array(
                case when p_check is not null then 'K-DELIVERY-RESULT-CHECK'
                     when p_class = 'reject' or p_refused then 'K-DELIVERY-REJECTED' else 'K-DELIVERY-RETRY' end,
                'K-DELIVERY-ATTESTED')
                || case when p_check ->> 'rule_code' is not null then jsonb_build_array(p_check ->> 'rule_code') else '[]'::jsonb end
        )
    )
$$;

-- ── 4. 對帳回報的判定（K-RECON-REPORT-CHECK）──

create function sgn_internal.hook_reconciliation_report(p_process_type text, p_channel text, p_report jsonb, p_case_ids uuid[])
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'check_reconciliation_report');
    v_result jsonb;
begin
    if v_fn is null then
        return '[]'::jsonb;
    end if;
    execute format('select %s($1, $2, $3)', v_fn::regprocedure::regproc) into v_result using p_channel, p_report, p_case_ids;
    return case when jsonb_typeof(v_result) = 'array' then v_result else '[]'::jsonb end;
end;
$$;

-- 一份收下的回報交給流程包判定，回傳的問題各開一筆例外（未結案的同一筆不重開）並通知升級對象。回傳開了幾筆。
create function sgn_internal.reconciliation_report_checks(p_channel text, p_run bigint, p_report jsonb)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_problem jsonb;
    v_opened int := 0;
begin
    for v_problem in
        select p from jsonb_array_elements(sgn_internal.hook_reconciliation_report(
            p_report ->> 'process_type', p_channel, p_report,
            (select coalesce(array_agg(x.case_id order by x.case_no), '{}')
             from sgn_internal.reconciliation_cases(p_channel) as x where x.standing in ('expected', 'tolerated'))
        )) as p
    loop
        continue when exists (
            select 1 from sgn.exception_record as x
            where x.rule_code = v_problem ->> 'rule_code' and x.closed_at is null and x.detail ->> 'channel' = p_channel
              and x.case_id is not distinct from sgn_internal.try_uuid(v_problem ->> 'case_id')
        );
        perform sgn_internal.exception_open(v_problem ->> 'rule_code', sgn_internal.try_uuid(v_problem ->> 'case_id'),
            coalesce(v_problem -> 'detail', '{}'::jsonb) || jsonb_build_object('channel', p_channel, 'run', p_run,
                'rules', jsonb_build_array('K-RECON-REPORT-CHECK', v_problem ->> 'rule_code')));
        v_opened := v_opened + 1;
    end loop;
    if v_opened > 0 then
        perform sgn_internal.notify('reconciliation.finding', sgn_internal.delivery_escalation_people(), null,
            jsonb_build_object('channel', p_channel, 'count', v_opened::text));
    end if;
    return v_opened;
end;
$$;

-- 一輪對帳（同 485 的簽章）：收下之後先交給流程包判定（K-RECON-REPORT-CHECK），再比對。
create or replace function sgn_internal.reconciliation_submit(p_channel text, p_response jsonb)
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
    perform sgn_internal.reconciliation_run_issued(v_run, (v_accepted ->> 'issued_at')::timestamptz);
    perform sgn_internal.reconciliation_report_checks(p_channel, v_run, v_report);
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

-- ── 5. 不驗的驗證案例（K-VERIFY-SKIPPED）──

alter table sgn.verification_run add column skipped jsonb not null default '[]'::jsonb;

-- 一輪驗證（同 410 的簽章）：hook 產生的案例裡帶 skip 的不送、不比對，記在 skipped 與鏈上。
create or replace function sgn_internal.verification_start(p_apply sgn.delivery_op)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_rule_set jsonb := p_apply.body::jsonb;
    v_all jsonb := sgn_internal.hook_verification_cases(
        (select c.process_type from sgn.request_case as c where c.id = p_apply.case_id), p_apply.case_id, v_rule_set
    );
    v_cases jsonb := (select coalesce(jsonb_agg(c order by n), '[]') from jsonb_array_elements(v_all) with ordinality as x (c, n)
                      where c -> 'skip' is null);
    v_skipped jsonb := (select coalesce(jsonb_agg(c order by n), '[]') from jsonb_array_elements(v_all) with ordinality as x (c, n)
                        where c -> 'skip' is not null);
    v_run bigint;
    v_op bigint;
begin
    insert into sgn.verification_run (case_id, version, channel, apply_op_id, cases, skipped, status, created_at)
    values (p_apply.case_id, p_apply.version, p_apply.channel, p_apply.id, v_cases, v_skipped, 'pending', sgn_internal.now())
    returning id into v_run;
    v_op := sgn_internal.delivery_op_create(p_apply.channel, 'verify', p_apply.case_id, p_apply.version, jsonb_build_object(
        'run_id', v_run,
        'rule_set', v_rule_set,
        'cases', (select coalesce(jsonb_agg(jsonb_build_object('code', c ->> 'code', 'expected', c ->> 'expected', 'query', c -> 'query')), '[]')
                  from jsonb_array_elements(v_cases) as c)
    ));
    update sgn.verification_run set op_id = v_op where id = v_run;
    perform sgn_internal.audit_append(
        'verification.started', p_apply.case_id, null,
        jsonb_build_object('run', v_run, 'op', v_op, 'channel', p_apply.channel, 'version', p_apply.version,
            'cases', jsonb_array_length(v_cases),
            'skipped', (select coalesce(jsonb_agg(jsonb_build_object('code', s ->> 'code', 'skip', s -> 'skip')), '[]') from jsonb_array_elements(v_skipped) as s),
            'rules', jsonb_build_array('K-VERIFY-AUTO', 'K-VERIFY-SKIPPED'))
    );
    return v_run;
end;
$$;

-- ── 6. 有期限的例外（K-EXCEPTION-FOLLOWUP）──

select sgn_internal.register_setting_definition(
    'exception.followup_escalation_roles', 'json', '["ciso", "audit_head"]', array['rule']::text[],
    '有期限的例外逾期還沒結案時，通知哪些角色的持有人（K-EXCEPTION-FOLLOWUP）；可依規則代碼（rule:<代碼>）設定'
);

create table sgn.exception_followup (
    exception_id bigint primary key references sgn.exception_record (id),
    due_at timestamptz not null,
    -- 開立時通知的人（逾期時一併再通知）
    notified uuid[] not null,
    escalated_at timestamptz
);

-- 開一筆有期限的例外並通知負責處理的人。回傳例外的 id。
create function sgn_internal.exception_open_due(p_rule_code text, p_case_id uuid, p_detail jsonb, p_due_at timestamptz, p_people uuid[])
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_id bigint := sgn_internal.exception_open(p_rule_code, p_case_id, p_detail || jsonb_build_object('due_at', p_due_at));
begin
    insert into sgn.exception_followup (exception_id, due_at, notified) values (v_id, p_due_at, coalesce(p_people, '{}'));
    return v_id;
end;
$$;

create function sgn_sdk.exception_open_due(p_rule_code text, p_case_id uuid, p_detail jsonb, p_due_at timestamptz, p_people uuid[])
returns bigint
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.exception_open_due(p_rule_code, p_case_id, p_detail, p_due_at, p_people)
$$;

-- 逾期還沒結案的有期限例外：通知升級對象與原本的處理人（每筆一次），進鏈。回傳升級了幾筆。
create function sgn_internal.exception_followup_due()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row record;
    v_roles jsonb;
    v_count int := 0;
begin
    for v_row in
        select f.exception_id, f.due_at, f.notified, x.rule_code, x.case_id
        from sgn.exception_followup as f
        join sgn.exception_record as x on x.id = f.exception_id
        where f.escalated_at is null and x.closed_at is null and f.due_at < sgn_internal.now()
        order by f.exception_id
        for update of f skip locked
    loop
        v_roles := sgn_internal.setting('exception.followup_escalation_roles', array['rule:' || v_row.rule_code]);
        update sgn.exception_followup set escalated_at = sgn_internal.now() where exception_id = v_row.exception_id;
        perform sgn_internal.audit_append('exception.escalated', v_row.case_id, null, jsonb_build_object(
            'exception', v_row.exception_id, 'rule_code', v_row.rule_code, 'due_at', v_row.due_at,
            'settings', jsonb_build_object('exception.followup_escalation_roles', v_roles),
            'rules', jsonb_build_array('K-EXCEPTION-FOLLOWUP')));
        perform sgn_internal.notify('exception.overdue', sgn_internal.roles_holders(v_roles) || v_row.notified, v_row.case_id,
            jsonb_build_object('rule_code', v_row.rule_code,
                'case_no', coalesce((select c.case_no::text from sgn.request_case as c where c.id = v_row.case_id), '-')));
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

create function api_job.exception_followup_due()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('escalated', sgn_internal.exception_followup_due());
end;
$$;

comment on function api_job.exception_followup_due() is
    '排程：有期限的例外逾期還沒結案時，通知 exception.followup_escalation_roles 的持有人與原本的處理人（每筆一次），不替人做決定。'
    '呼叫者：sgn_scheduler（db/tools/jobs.mjs）。規則：K-EXCEPTION-FOLLOWUP';

insert into sgn.notification_template (event_code, subject, body) values
    ('exception.overdue', '例外逾期未處理：{{rule_code}}',
        '例外 {{rule_code}}（單號 {{case_no}}）已超過處理期限還沒有結案，請負責的人儘快處理。');

select sgn_internal.register_rule(r.code, r.description, null, 'full', null)
from (values
    ('K-CONTENT-REBIND', '流程包依據的外部定義改版時，簽核中的單以新定義重新整理成新的一版並從第一關重簽；整理後有錯就退回申請人；'
        '之前的簽核不算數（版本雜湊不同）'),
    ('K-DELIVERY-RESULT-CHECK', '外部系統的證明驗過、核心判定成功之後，流程包再判定結果：不接受時視同外部系統拒絕（不生效、撤回、'
        '開流程包指定的例外），或在寬限內當成沒送到重送'),
    ('K-RECON-REPORT-CHECK', '收下的對帳回報交給流程包判定，回傳的問題各開一筆例外（同一規則代碼、單、通道未結案時不重開）並通知升級對象'),
    ('K-VERIFY-SKIPPED', '流程包標成不驗的驗證案例不送外部系統、不算進比對，記在驗證紀錄與鏈上'),
    ('K-EXCEPTION-FOLLOWUP', '有期限的例外逾期還沒結案時，通知升級對象與原本的處理人（每筆一次），不自動做任何決定')
) as r (code, description);
