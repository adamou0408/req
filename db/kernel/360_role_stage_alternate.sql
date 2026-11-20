-- 角色關卡遇到職責分離時，先找同一角色的其他持有人，找不到才升級並開例外（裁決 D79 (4)；紅隊第三輪 資訊 5）。
--
-- 根因：單一持有人的角色關卡（例如 L4 的資安長關）只取固定順序的第一位持有人；他不合格（例如他就是申請人的主管，
-- 已經簽過主管關）時，直接沿「他的」主管線往上，交給資安長的主管——不是資安角色的人在簽資安關，也沒有任何例外讓人來看。
--
-- 這一版：
--   1. role_holder 依固定順序逐一找同一角色的持有人，第一位合格的就是簽核人（via = role_alternate 表示不是第一位）。
--   2. 全部不合格才沿第一位持有人的主管線往上或交給最終決定者（原本的升級），並在開關時開例外 K-SOD-ROLE-ESCALATED，
--      記下這一關、角色與每一位持有人被排除的原因。代理人（D39 的指定代理人名單）還沒有，所以只找同一角色的其他持有人。

-- role_holder 與 scoped_role 的解析（同 150_resolver.sql 的簽章）。
create or replace function sgn_internal.resolve_role_holders(
    p_case sgn.request_case,
    p_stage_id bigint,
    p_stage sgn.policy_stage,
    p_scopes text[],
    p_top_role text
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_scope text;
    v_holders uuid[];
    v_holder uuid;
    v_resolved jsonb;
    v_found jsonb := '[]'::jsonb;
    v_path jsonb;
begin
    foreach v_scope in array p_scopes loop
        v_holders := sgn_internal.role_holders(p_stage.resolver_role, nullif(v_scope, ''));
        if cardinality(v_holders) = 0 then
            v_holders := array[null::uuid];
        elsif p_stage.resolver_kind = 'role_holder' then
            -- 單一持有人的角色：第一位合格的持有人；都不合格才從第一位往上升級
            v_resolved := null;
            v_path := '[]'::jsonb;
            foreach v_holder in array v_holders loop
                if sgn_internal.decider_denial(p_case.id, v_holder, p_stage_id) is null then
                    v_resolved := jsonb_build_object(
                        'person_id', v_holder,
                        'via', case when jsonb_array_length(v_path) = 0 then 'direct' else 'role_alternate' end,
                        'path', v_path
                    );
                    exit;
                end if;
                v_path := v_path || jsonb_build_object('person_id', v_holder, 'denied', sgn_internal.decider_denial(p_case.id, v_holder, p_stage_id));
            end loop;
            if v_resolved is not null then
                v_found := v_found || jsonb_build_object('scope', v_scope, 'holder', v_resolved -> 'person_id', 'resolved', v_resolved);
                continue;
            end if;
            v_holders := v_holders[1:1];
        end if;
        foreach v_holder in array v_holders loop
            v_resolved := sgn_internal.resolve_eligible(p_case.id, p_stage_id, v_holder, p_top_role);
            if v_resolved -> 'person_id' = 'null'::jsonb then
                return '[]'::jsonb;
            end if;
            v_found := v_found || jsonb_build_object('scope', v_scope, 'holder', v_holder, 'resolved', v_resolved);
        end loop;
    end loop;
    return (
        select coalesce(jsonb_agg(sgn_internal.task_spec_assigned(
            g.resolved,
            array_remove(g.scopes, ''),
            jsonb_build_object('resolver', p_stage.resolver_kind, 'role', p_stage.resolver_role, 'holders', g.holders)
        ) order by g.person), '[]'::jsonb)
        from (
            select
                f -> 'resolved' ->> 'person_id' as person,
                (array_agg(f -> 'resolved'))[1] as resolved,
                array_agg(distinct f ->> 'scope') as scopes,
                jsonb_agg(distinct f -> 'holder') as holders
            from jsonb_array_elements(v_found) as f
            group by f -> 'resolved' ->> 'person_id'
        ) as g
    );
end;
$$;

-- 開一關（同 160_case_flow.sql 的簽章）：多了角色關卡升級時的例外。
create or replace function sgn_internal.stage_open(p_case sgn.request_case, p_stage sgn.policy_stage)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_stage_id bigint;
    v_specs jsonb;
    v_tasks jsonb;
    v_line jsonb;
    v_basis jsonb;
begin
    insert into sgn.case_stage (case_id, policy_id, seq, status, opened_version, opened_at)
    values (p_case.id, p_stage.policy_id, p_stage.seq, 'open', p_case.current_version, sgn_internal.now())
    returning id into v_stage_id;
    v_specs := sgn_internal.resolve_stage(p_case, v_stage_id, p_stage);
    if jsonb_array_length(v_specs) = 0 then
        update sgn.case_stage set status = 'halted' where id = v_stage_id;
        perform sgn_internal.audit_append(
            'case.stage_halted', p_case.id, null,
            jsonb_build_object('stage', p_stage.code, 'seq', p_stage.seq, 'rules', jsonb_build_array('K-RESOLVE-HALT'))
        );
        perform sgn_internal.exception_open('K-RESOLVE-HALT', p_case.id, jsonb_build_object('stage', p_stage.code, 'seq', p_stage.seq));
        perform sgn_internal.notify(
            'case.halted', array[p_case.applicant_person_id], p_case.id,
            jsonb_build_object('case_no', p_case.case_no, 'stage_name', p_stage.name)
        );
        return;
    end if;
    v_tasks := sgn_internal.stage_add_tasks(p_case, v_stage_id, p_stage, v_specs);
    perform sgn_internal.audit_append(
        'case.stage_opened', p_case.id, null,
        jsonb_build_object(
            'stage', p_stage.code,
            'seq', p_stage.seq,
            'version', p_case.current_version,
            'tasks', v_tasks,
            'settings', jsonb_build_object(
                'approval.manager_change_cooling_workdays', sgn_internal.setting('approval.manager_change_cooling_workdays'),
                'approval.excluded_decider_roles', sgn_internal.setting('approval.excluded_decider_roles')
            ),
            'rules', jsonb_build_array('K-RESOLVE-STAGE-START', 'K-SOD-APPLICANT', 'K-SOD-DISTINCT', 'K-AUDITOR-INDEPENDENT', 'K-SOD-ROLE-ESCALATED')
        )
    );
    for v_line in select t #> '{basis,line}' from jsonb_array_elements(v_tasks) as t loop
        if v_line ->> 'origin' = 'sync_change' then
            perform sgn_internal.exception_open('K-DETECT-MANAGER-FLIP', p_case.id, v_line);
        end if;
    end loop;
    if p_stage.resolver_kind in ('role_holder', 'scoped_role') then
        for v_basis in select t -> 'basis' from jsonb_array_elements(v_tasks) as t loop
            if v_basis ->> 'via' in ('manager_chain', 'top_resolver') then
                perform sgn_internal.exception_open('K-SOD-ROLE-ESCALATED', p_case.id, jsonb_build_object(
                    'stage', p_stage.code, 'seq', p_stage.seq, 'role', p_stage.resolver_role,
                    'via', v_basis ->> 'via', 'path', v_basis -> 'path'
                ));
            end if;
        end loop;
    end if;
end;
$$;

select sgn_internal.register_rule(
    'K-SOD-ROLE-ESCALATED',
    '角色關卡的持有人因職責分離不合格時，先找同一角色的其他持有人；全部不合格才升級（主管線或最終決定者），並開例外讓人來看（D79 (4)）',
    null,
    'partial',
    '代理人（指定代理人名單）沒做，所以只找同一角色的其他持有人'
);
