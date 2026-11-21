-- 授權生效之後的後續（閉環第二批；裁決 D94 (4)；交接 docs/handoff/closed-loop-2.md）。
--
-- 有些流程包要在授權生效的那一刻開一筆帶期限的待辦（例如：沒有測試紀錄就上線的正式區授權，要限期補一份上線後的使用報告）。
-- 核心在建立授權之後呼叫流程包的 after_grant_activated(case_id)：回傳 [{rule_code, detail, due_workdays, people}]，核心逐筆開帶期限的例外
-- （sgn_internal.exception_open_due；逾期由既有的 K-EXCEPTION-FOLLOWUP 升級，不自動做任何決定）並通知 people。
-- 核心不解讀內容；沒有登記這個 hook 的流程包行為不變。

insert into sgn.hook_definition (hook, arg_types, result_type, returns_set, description) values
    ('after_grant_activated', 'uuid', 'jsonb', false,
        '授權剛生效（同一個交易）：回傳要開的帶期限例外 [{rule_code, detail, due_workdays, people}]。核心開例外、通知 people；'
        '逾期由 K-EXCEPTION-FOLLOWUP 升級。沒有登記：不開');

create function sgn_internal.hook_after_grant_activated(p_process_type text, p_case_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'after_grant_activated');
    v_result jsonb;
begin
    if v_fn is null then
        return '[]'::jsonb;
    end if;
    execute format('select %s($1)', v_fn::regprocedure::regproc) into v_result using p_case_id;
    return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- 執行全部完成：建立授權並生效（同 160 的簽章；K-FULFIL）。多了生效後的後續（K-GRANT-FOLLOWUP）。
create or replace function sgn_internal.grant_activate(p_case sgn.request_case)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_terms jsonb := (select v.terms from sgn.case_version as v where v.case_id = p_case.id and v.version = p_case.current_version);
    v_grant_id uuid := gen_random_uuid();
    v_seq bigint;
    v_item jsonb;
    v_people uuid[];
begin
    v_seq := sgn_internal.audit_append(
        'grant.activated', p_case.id, null,
        jsonb_build_object('grant_id', v_grant_id, 'version', p_case.current_version, 'terms', v_terms, 'rules', jsonb_build_array('K-FULFIL'))
    );
    insert into sgn.grant_record (id, case_id, process_type, principal_id, valid_from, valid_to, version, status, created_at, event_seq)
    values (
        v_grant_id,
        p_case.id,
        p_case.process_type,
        (v_terms ->> 'principal_id')::uuid,
        sgn_internal.try_date(v_terms ->> 'valid_from'),
        sgn_internal.try_date(v_terms ->> 'valid_to'),
        p_case.current_version,
        'active',
        sgn_internal.now(),
        v_seq
    );
    perform sgn_internal.notify(
        'case.activated', array[p_case.applicant_person_id], p_case.id, jsonb_build_object('case_no', p_case.case_no)
    );
    for v_item in select x from jsonb_array_elements(sgn_internal.hook_after_grant_activated(p_case.process_type, p_case.id)) as x loop
        v_people := array(select (p #>> '{}')::uuid from jsonb_array_elements(coalesce(v_item -> 'people', '[]'::jsonb)) as p);
        perform sgn_internal.exception_open_due(v_item ->> 'rule_code', p_case.id,
            coalesce(v_item -> 'detail', '{}'::jsonb) || jsonb_build_object('rules', jsonb_build_array(v_item ->> 'rule_code', 'K-GRANT-FOLLOWUP')),
            sgn_internal.add_workdays(sgn_internal.now(), (v_item ->> 'due_workdays')::int), v_people);
        perform sgn_internal.notify('grant.followup', v_people, p_case.id, jsonb_build_object(
            'case_no', p_case.case_no::text, 'what', coalesce(v_item ->> 'what', v_item ->> 'rule_code')));
    end loop;
end;
$$;

insert into sgn.notification_template (event_code, subject, body) values
    ('grant.followup', '授權生效後要補的事：{{case_no}}', '{{case_no}} 已生效。{{what}}');

select sgn_internal.register_rule(r.code, r.description, null, 'full', null)
from (values
    ('K-GRANT-FOLLOWUP', '授權生效的同一個交易裡，流程包要求的後續各開一筆帶期限的例外並通知；逾期由 K-EXCEPTION-FOLLOWUP 升級，不自動撤銷')
) as r (code, description);
