-- 找簽核人的唯一入口（骨幹第 7 節）：每一關開始時，依關卡宣告的 resolver 解析，並在這裡統一套用
--   K-SOD-APPLICANT        申請人不能簽自己的單
--   K-SOD-DISTINCT         同一張單每一關都是不同的人；撞到就往上一層主管
--   K-AUDITOR-INDEPENDENT  持有 approval.excluded_decider_roles 的人（稽核、技術維運）永遠不會被指派
--   K-TOP-RESOLVER         主管線走到頂仍沒有合格的人時，交給路徑設定的最終決定者
--   K-RESOLVE-HALT         都沒有就回傳空集合，由呼叫者把關卡停住並開例外
-- 主管異動的冷卻期（K-HR-SYNC）在找主管的入口 resolve_manager 裡處理。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('approval.manager_change_cooling_workdays', 'integer', '1', '{}',
        '人員同步帶來的主管異動，幾個營業日後才用於指派簽核；期間內仍由原主管負責'),
    ('approval.excluded_decider_roles', 'json', '["auditor", "tech_ops"]', '{}',
        '持有這些角色的人不會被解析為任何關卡的簽核人或執行人');

-- 找主管的唯一入口（同 20_directory.sql 的簽章，加上冷卻期 K-HR-SYNC）：
-- 基準之後由同步異動而來的關係，要過了冷卻期（approval.manager_change_cooling_workdays 個營業日）才「生效」。
-- 回傳最近一條已生效、而且生效時仍是目前關係的那一條；還沒生效就被換掉的關係（例如假快照之後又改回）略過。
-- 都沒有（例如基準之後才到職的人）時回傳目前的關係。主管必須仍在職；目前沒有主管就回傳空的關係。
create or replace function sgn_internal.resolve_manager(p_person_id uuid)
returns sgn.reporting_line
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cooling int := sgn_internal.setting_int('approval.manager_change_cooling_workdays');
    v_now timestamptz := sgn_internal.now();
    v_current sgn.reporting_line;
    v_line sgn.reporting_line;
    v_settled_at timestamptz;
begin
    select r.* into v_current
    from sgn.reporting_line as r
    join sgn.person as m on m.id = r.manager_person_id
    where r.person_id = p_person_id
      and r.valid_to is null
      and m.active;
    if v_current.id is null then
        -- 沒有目前的主管（或主管已不在職）：不回頭用已結束的關係
        return v_current;
    end if;
    for v_line in
        select r.*
        from sgn.reporting_line as r
        join sgn.person as m on m.id = r.manager_person_id
        where r.person_id = p_person_id
          and m.active
        order by r.id desc
    loop
        v_settled_at := case
            when v_line.origin = 'baseline' then v_line.valid_from
            else sgn_internal.add_workdays(v_line.valid_from, v_cooling)
        end;
        if v_settled_at <= v_now and (v_line.valid_to is null or v_line.valid_to >= v_settled_at) then
            return v_line;
        end if;
    end loop;
    return v_current;
end;
$$;

-- 一個人能不能在這張單的這一關擔任決定者（簽核或執行）。解析、認領、決定當下都用這一個判斷（K-DECISION-ELIGIBLE），
-- 由授權入口 denial_reason 與解析器共用。回傳拒絕代碼；可以時回 null。
create function sgn_internal.decider_denial(p_case_id uuid, p_person_id uuid, p_stage_id bigint)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when not coalesce((select p.active from sgn.person as p where p.id = p_person_id), false) then 'PERSON_UNKNOWN'
        when p_person_id = c.applicant_person_id then 'SELF_APPROVAL'
        when exists (
            select 1
            from jsonb_array_elements_text(sgn_internal.setting('approval.excluded_decider_roles')) as r (role_code)
            where sgn_internal.has_role(p_person_id, r.role_code)
        ) then 'DECIDER_ROLE_EXCLUDED'
        when exists (
            select 1
            from sgn.case_task as t
            join sgn.case_stage as s on s.id = t.stage_id
            where t.case_id = p_case_id
              and t.assignee_person_id = p_person_id
              and t.status in ('pending', 'approved', 'completed')
              and s.status not in ('cancelled', 'returned')
              and s.id <> p_stage_id
        ) then 'SOD_DISTINCT'
    end
    from sgn.request_case as c
    where c.id = p_case_id
$$;

-- 從 p_start 開始，不合格就沿主管線往上，走到頂再交給最終決定者。
-- 回傳 {person_id, via: direct／manager_chain／top_resolver／none, path: [{person_id, denied}]}；person_id 為 null＝找不到。
create function sgn_internal.resolve_eligible(p_case_id uuid, p_stage_id bigint, p_start uuid, p_top_role text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_candidate uuid := p_start;
    v_seen uuid[] := '{}'::uuid[];
    v_path jsonb := '[]'::jsonb;
    v_denial text;
    v_holder uuid;
begin
    while v_candidate is not null and not v_candidate = any (v_seen) loop
        v_denial := sgn_internal.decider_denial(p_case_id, v_candidate, p_stage_id);
        if v_denial is null then
            return jsonb_build_object(
                'person_id', v_candidate,
                'via', case when jsonb_array_length(v_path) = 0 then 'direct' else 'manager_chain' end,
                'path', v_path
            );
        end if;
        v_path := v_path || jsonb_build_object('person_id', v_candidate, 'denied', v_denial);
        v_seen := v_seen || v_candidate;
        v_candidate := (sgn_internal.resolve_manager(v_candidate)).manager_person_id;
    end loop;
    if p_top_role is not null then
        foreach v_holder in array sgn_internal.role_holders(p_top_role) loop
            v_denial := sgn_internal.decider_denial(p_case_id, v_holder, p_stage_id);
            if v_denial is null then
                return jsonb_build_object('person_id', v_holder, 'via', 'top_resolver', 'path', v_path);
            end if;
            v_path := v_path || jsonb_build_object('person_id', v_holder, 'denied', v_denial);
        end loop;
    end if;
    return jsonb_build_object('person_id', null, 'via', 'none', 'path', v_path);
end;
$$;

-- 群組認領的候選人：持有角色（與範圍）且在這一關合格的人。
create function sgn_internal.claim_candidates(p_case_id uuid, p_stage_id bigint, p_role text, p_scope_ref text)
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(h order by h), '{}')
    from unnest(sgn_internal.role_holders(p_role, p_scope_ref)) as h
    where sgn_internal.decider_denial(p_case_id, h, p_stage_id) is null
$$;

-- 指派給一個人的工作規格；p_resolved 是 resolve_eligible 的結果。
create function sgn_internal.task_spec_assigned(p_resolved jsonb, p_scope_refs text[], p_basis jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'assignee', p_resolved -> 'person_id',
        'claim_role', null,
        'claim_scope', null,
        'scope_refs', to_jsonb(p_scope_refs),
        'basis', p_basis || jsonb_build_object('via', p_resolved -> 'via', 'path', p_resolved -> 'path')
    )
$$;

-- applicant_manager：申請人的主管（含冷卻期），不合格就往上。
create function sgn_internal.resolve_applicant_manager(p_case sgn.request_case, p_stage_id bigint, p_top_role text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_line sgn.reporting_line := sgn_internal.resolve_manager(p_case.applicant_person_id);
    v_resolved jsonb := sgn_internal.resolve_eligible(p_case.id, p_stage_id, v_line.manager_person_id, p_top_role);
begin
    if v_resolved -> 'person_id' = 'null'::jsonb then
        return '[]'::jsonb;
    end if;
    return jsonb_build_array(sgn_internal.task_spec_assigned(
        v_resolved,
        '{}',
        jsonb_build_object(
            'resolver', 'applicant_manager',
            'line', case when v_line.id is not null then jsonb_build_object(
                'reporting_line_id', v_line.id,
                'manager', v_line.manager_person_id,
                'origin', v_line.origin,
                'change_event_seq', v_line.change_event_seq,
                'valid_from', v_line.valid_from
            ) end
        )
    ));
end;
$$;

-- role_holder（單一持有人）與 scoped_role（每個範圍的持有人，同一人合併成一件工作）。
-- 範圍沒有持有人時從最終決定者找；任何一個範圍找不到人，整關停住（不能略過某個範圍）。
create function sgn_internal.resolve_role_holders(
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
begin
    foreach v_scope in array p_scopes loop
        v_holders := sgn_internal.role_holders(p_stage.resolver_role, nullif(v_scope, ''));
        if cardinality(v_holders) = 0 then
            v_holders := array[null::uuid];
        elsif p_stage.resolver_kind = 'role_holder' then
            -- 單一持有人的角色：只取一位（資料異常出現多位時，取固定順序的第一位）
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

-- role_group_claim 與 system_custodian：每個範圍一件等認領的工作（沒有範圍＝一件）。
-- 沒有合格的候選人時：簽核關交給最終決定者；執行關不交（執行要有那個系統的管理人），停住。
create function sgn_internal.resolve_claim_groups(
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
    v_candidates uuid[];
    v_resolved jsonb;
    v_specs jsonb := '[]'::jsonb;
    v_basis jsonb;
begin
    foreach v_scope in array p_scopes loop
        v_candidates := sgn_internal.claim_candidates(p_case.id, p_stage_id, p_stage.resolver_role, nullif(v_scope, ''));
        v_basis := jsonb_build_object('resolver', p_stage.resolver_kind, 'role', p_stage.resolver_role, 'scope', nullif(v_scope, ''));
        if cardinality(v_candidates) > 0 then
            v_specs := v_specs || jsonb_build_object(
                'assignee', null,
                'claim_role', p_stage.resolver_role,
                'claim_scope', nullif(v_scope, ''),
                'scope_refs', to_jsonb(array_remove(array[v_scope], '')),
                'basis', v_basis || jsonb_build_object('candidates', to_jsonb(v_candidates))
            );
            continue;
        end if;
        if p_stage.phase <> 'approval' then
            return '[]'::jsonb;
        end if;
        v_resolved := sgn_internal.resolve_eligible(p_case.id, p_stage_id, null, p_top_role);
        if v_resolved -> 'person_id' = 'null'::jsonb then
            return '[]'::jsonb;
        end if;
        v_specs := v_specs || sgn_internal.task_spec_assigned(v_resolved, array_remove(array[v_scope], ''), v_basis);
    end loop;
    return v_specs;
end;
$$;

-- 解析一關的工作規格：[{assignee, claim_role, claim_scope, scope_refs, basis}]；空陣列＝找不到人（呼叫者停住關卡）。
create function sgn_internal.resolve_stage(p_case sgn.request_case, p_stage_id bigint, p_stage sgn.policy_stage)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_top_role text := (select p.top_resolver_role from sgn.approval_policy as p where p.id = p_stage.policy_id);
    v_scopes text[];
begin
    if p_stage.resolver_kind = 'applicant_manager' then
        return sgn_internal.resolve_applicant_manager(p_case, p_stage_id, v_top_role);
    end if;
    if p_stage.resolver_kind in ('scoped_role', 'system_custodian') then
        v_scopes := sgn_internal.hook_stage_scopes(
            p_case.process_type,
            p_stage.code,
            (select v.content from sgn.case_version as v where v.case_id = p_case.id and v.version = p_case.current_version)
        );
        if cardinality(v_scopes) = 0 then
            return '[]'::jsonb;
        end if;
    else
        -- 不依範圍的角色：一個空字串代表「不限範圍」
        v_scopes := array[''];
    end if;
    if p_stage.resolver_kind in ('role_holder', 'scoped_role') then
        return sgn_internal.resolve_role_holders(p_case, p_stage_id, p_stage, v_scopes, v_top_role);
    end if;
    return sgn_internal.resolve_claim_groups(p_case, p_stage_id, p_stage, v_scopes, v_top_role);
end;
$$;
