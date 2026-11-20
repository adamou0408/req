-- 紅隊第五輪 中-2（裁決 D84 (5)；redteam/exploits/35）：對帳帳號用一份比較舊、但還在新鮮度內的已簽回報，把真的發現結案。
-- 外部系統簽的回報 D 改不了，但 D 可以先存一份、等後門被下一份抓到之後再交舊的；第四輪只檢查「新鮮度內、同一份只收一次」。
--   1. 簽發時間必須嚴格遞增：同一個通道上，比已收下的最新一份舊（或一樣）的回報不收（開例外、限速）。
--   2. 發現要連續 reconciliation.resolve_after_rounds 輪有效的回報都沒看到才結案；中間任何一輪又看到就重新計算。
--      一份舊回報（就算收得下）最多算一輪，D 藏不住真的發現；誠實的對帳程式每 30 秒一輪，結案慢幾輪不影響正確性。

alter table sgn.reconciliation_run add column issued_at timestamptz;

select sgn_internal.register_setting_definition(
    'reconciliation.resolve_after_rounds', 'integer', '3', array['channel'],
    '對帳的發現要連續幾輪有效的回報都沒看到才結案（K-RECON-RESOLVED；裁決 D84 (5)）'
);

-- 交上來的回應 → 驗過的回報（同 440 的簽章）：多了「簽發時間必須比已收下的最新一份新」。
create or replace function sgn_internal.reconciliation_accept(p_channel text, p_response jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_att jsonb := sgn_internal.attestation_open(p_channel, p_response, jsonb_build_object(
        'method', 'GET', 'path', '/reconciliation', 'request_sha256', encode(sgn_internal.digest('', 'sha256'), 'hex')));
    v_max_age int := sgn_internal.reconciliation_setting_int('reconciliation.max_report_age_seconds', p_channel);
    v_issued timestamptz;
    v_latest timestamptz;
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
    v_latest := (select max(r.issued_at) from sgn.reconciliation_run as r where r.channel = p_channel);
    if v_latest is not null and v_issued <= v_latest then
        return sgn_internal.reconciliation_reject(p_channel, 'K-RECON-UNVERIFIED', 'not_newer',
            jsonb_build_object('issued_at', v_issued, 'latest_accepted_issued_at', v_latest));
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

-- 收下的回報記下簽發時間（下一份要比它新）。由 reconciliation_submit 在建立這一輪之後呼叫。
create function sgn_internal.reconciliation_run_issued(p_run bigint, p_issued timestamptz)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    update sgn.reconciliation_run set issued_at = p_issued where id = p_run
$$;

-- 結案（同 440 的簽章）：連續 reconciliation.resolve_after_rounds 輪有效的回報都沒看到才結案；每一筆結案都進鏈。
create or replace function sgn_internal.reconciliation_resolve(p_channel text, p_run bigint)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_rounds int := sgn_internal.reconciliation_setting_int('reconciliation.resolve_after_rounds', p_channel);
    v_finding sgn.reconciliation_finding;
    v_count int := 0;
begin
    for v_finding in
        update sgn.reconciliation_finding as f set resolved_run_id = p_run
        where f.channel = p_channel and f.resolved_run_id is null and f.last_run_id <> p_run
          and (select count(*) from sgn.reconciliation_run as r where r.channel = p_channel and r.id > f.last_run_id) >= v_rounds
        returning f.*
    loop
        perform sgn_internal.audit_append(
            'reconciliation.finding_resolved', v_finding.case_id, null,
            jsonb_build_object('finding', v_finding.id, 'channel', p_channel, 'kind', v_finding.kind, 'key', v_finding.finding_key,
                'exception', v_finding.exception_id, 'first_run', v_finding.first_run_id, 'last_seen_run', v_finding.last_run_id,
                'resolved_run', p_run, 'settings', jsonb_build_object('reconciliation.resolve_after_rounds', v_rounds),
                'rules', jsonb_build_array('K-RECON-RESOLVED'))
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- 一輪對帳（同 440 的簽章）：多記簽發時間。
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
    -- 同一個通道一次只對一輪（排程與手動同時跑時，同一個發現不會被開兩次；簽發時間的比較也不會兩份同時通過）
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

comment on function api_job.reconciliation_submit(text, jsonb) is
    '對帳：交上外部系統的對帳回應（含外部系統的證明，dc_reconciliation_report/1），只採信證明裡的回報（驗章、端點、新鮮度、只收一次、'
    '簽發時間比已收下的最新一份新）；與平台認為該有的權限比對，多出來的、少掉的、範圍不同的各開一次例外，屬於已不該有權限的單的多出來的'
    '自動排撤回，連續 reconciliation.resolve_after_rounds 輪有效的回報沒看到才結案並進鏈。不收的回應回 rejected（限速開例外）。'
    '呼叫者：sgn_reconciler（api/src/reconciler.ts，以外部系統的唯讀稽核金鑰取得回報）。'
    '規則：K-RECON-EXTRA、K-RECON-MISSING、K-RECON-DIFFERENT、K-RECON-UNVERIFIED、K-RECON-LIMIT、K-RECON-RESOLVED、K-DELIVERY-ATTESTED';

comment on function api_job.reconciliation_overdue_check() is
    '排程：有自動交付的通道超過 reconciliation.max_interval_seconds 沒有有效的對帳回報時開例外並通知升級對象。'
    '呼叫者：sgn_scheduler（db/tools/jobs.mjs）。規則：K-RECON-OVERDUE';

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-RECON-UNVERIFIED',
        '對帳：沒有外部系統有效證明、過期、重送、或簽發時間不比已收下的最新一份新的回報不採信，開例外並升級（同一通道在新鮮度的時間內一筆）',
        'full', null),
    ('K-RECON-RESOLVED',
        '對帳：發現要連續 reconciliation.resolve_after_rounds 輪有效的回報都沒看到才結案，每一筆結案都進鏈（寫明用到的參數值）',
        'full', null)
) as r (code, description, coverage, note);
