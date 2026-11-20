-- 申請單的流程：寫入內容版本、比較版本、授權入口、關卡推進、送審（骨幹 5.3、5.4）。
-- 只新增：40_case.sql 的 denial_reason、case_submit_draft 與 api.case_* 由這裡取代。

-- ── 被授權者與授權起迄（terms）──

-- 文字 → uuid；不是 uuid 就是 null（不丟 SQLSTATE 22P02：輸入錯誤一律走錯誤目錄）。
create function sgn_internal.try_uuid(p_text text)
returns uuid
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
    return p_text::uuid;
exception
    when invalid_text_representation then
        return null;
end;
$$;

create function sgn_internal.try_date(p_text text)
returns date
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
    if p_text !~ '^\d{4}-\d{2}-\d{2}$' then
        return null;
    end if;
    return to_date(p_text, 'YYYY-MM-DD');
exception
    when datetime_field_overflow or invalid_datetime_format then
        return null;
end;
$$;

-- 只保留流程類型選用的鍵（uses_principal → principal_id；has_validity → valid_from、valid_to），其餘丟掉。
create function sgn_internal.terms_normalized(p_process_type text, p_terms jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_strip_nulls(jsonb_build_object(
        'principal_id', case when sgn_internal.process_option(p_process_type, 'uses_principal') then p_terms ->> 'principal_id' end,
        'valid_from', case when sgn_internal.process_option(p_process_type, 'has_validity') then p_terms ->> 'valid_from' end,
        'valid_to', case when sgn_internal.process_option(p_process_type, 'has_validity') then p_terms ->> 'valid_to' end
    ))
$$;

create function sgn_internal.validity_scopes(p_process_type text, p_tier text)
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select array['tier:' || p_process_type || ':' || p_tier, 'process:' || p_process_type]
$$;

-- 送審前必須成立的 terms 檢查（K-PRINCIPAL、K-VALIDITY-MAX、K-NO-BACKDATE）。回傳 [{path, code, message}]。
create function sgn_internal.terms_errors(p_process_type text, p_terms jsonb, p_tier text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_errors jsonb := '[]'::jsonb;
    v_from date := sgn_internal.try_date(p_terms ->> 'valid_from');
    v_to date := sgn_internal.try_date(p_terms ->> 'valid_to');
    v_max int;
    v_code text;
    v_path text;
begin
    if sgn_internal.process_option(p_process_type, 'uses_principal') then
        v_code := case
            when p_terms ->> 'principal_id' is null then 'PRINCIPAL_REQUIRED'
            -- 只認標準寫法（小寫、無空白與大括號）的 id；轉型不丟錯，格式不對一律走錯誤目錄（紅隊第四輪 資訊 2）
            when not exists (select 1 from sgn.principal as x where x.id::text = p_terms ->> 'principal_id')
                 or not sgn_internal.principal_usable(sgn_internal.try_uuid(p_terms ->> 'principal_id')) then 'PRINCIPAL_UNKNOWN'
        end;
        if v_code is not null then
            v_errors := v_errors || jsonb_build_object('path', 'terms.principal_id', 'code', v_code, 'message', sgn_internal.message_text(v_code));
        end if;
    end if;
    if sgn_internal.process_option(p_process_type, 'has_validity') then
        v_max := (sgn_internal.setting('validity.max_months', sgn_internal.validity_scopes(p_process_type, p_tier)) #>> '{}')::int;
        v_path := 'terms.valid_to';
        v_code := case
            when v_from is null or v_to is null then 'VALIDITY_REQUIRED'
            when v_from > v_to then 'VALIDITY_ORDER'
            when v_to >= (v_from + make_interval(months => v_max))::date then 'VALIDITY_TOO_LONG'
            when v_from < sgn_internal.today() then 'VALIDITY_BACKDATED'
        end;
        if v_code = 'VALIDITY_BACKDATED' then
            v_path := 'terms.valid_from';
        end if;
        if v_code is not null then
            v_errors := v_errors || jsonb_build_object('path', v_path, 'code', v_code, 'message', sgn_internal.message_text(v_code));
        end if;
    end if;
    return v_errors;
end;
$$;

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('validity.max_months', 'integer', '12', '{process,tier}', '授權起迄的上限（月）；迄日必須早於起日加上這個月數');

-- terms 的比較：被授權者改變＝擴大；授權起迄落在原範圍內＝縮小，否則＝擴大（骨幹 K-CHANGE-REDUCE）。
create function sgn_internal.terms_compare(p_old jsonb, p_new jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_old = p_new then 'same'
        when p_old -> 'principal_id' is distinct from p_new -> 'principal_id' then 'expand'
        when sgn_internal.try_date(p_new ->> 'valid_from') >= sgn_internal.try_date(p_old ->> 'valid_from')
             and sgn_internal.try_date(p_new ->> 'valid_to') <= sgn_internal.try_date(p_old ->> 'valid_to') then 'reduce'
        else 'expand'
    end
$$;

create function sgn_internal.tier_rank(p_process_type text, p_tier text)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select t.sort_order from sgn.process_tier as t where t.process_type = p_process_type and t.tier_code = p_tier
$$;

-- 兩個版本的變更分類：內容（流程包的 compare_content）、terms、級別，取最嚴重者（K-CHANGE-REDUCE、K-CHANGE-EXPAND）。
create function sgn_internal.versions_compare(
    p_process_type text,
    p_old_content jsonb,
    p_old_terms jsonb,
    p_old_tier text,
    p_new_content jsonb,
    p_new_terms jsonb,
    p_new_tier text
)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_kinds text[] := array[
        sgn_internal.hook_compare(p_process_type, p_old_content, p_new_content),
        sgn_internal.terms_compare(p_old_terms, p_new_terms),
        case
            when sgn_internal.tier_rank(p_process_type, p_new_tier) > sgn_internal.tier_rank(p_process_type, p_old_tier) then 'expand'
            else 'same'
        end
    ];
begin
    return case
        when 'expand' = any (v_kinds) then 'expand'
        when 'reduce' = any (v_kinds) then 'reduce'
        else 'same'
    end;
end;
$$;

-- 一份候選版本：整理內容（流程包的 normalize_content）、整理 terms、分級、算雜湊。還沒寫入。
-- 回傳 {content, terms, tier, notices, errors, content_sha256, version_sha256}
create function sgn_internal.version_prepare(p_process_type text, p_content jsonb, p_terms jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_normalized jsonb := sgn_internal.hook_normalize(p_process_type, p_content);
    v_terms jsonb := sgn_internal.terms_normalized(p_process_type, coalesce(p_terms, '{}'::jsonb));
begin
    return v_normalized || jsonb_build_object(
        'terms', v_terms,
        'tier', sgn_internal.hook_classify(p_process_type, v_normalized -> 'content'),
        'content_sha256', encode(sgn_internal.content_hash(v_normalized -> 'content'), 'hex'),
        'version_sha256', encode(
            sgn_internal.jcs_sha256(jsonb_build_object('content', v_normalized -> 'content', 'terms', v_terms)),
            'hex'
        )
    );
end;
$$;

-- 寫入一個準備好的版本並設為目前版本。
create function sgn_internal.version_store(p_case_id uuid, p_prepared jsonb, p_change_kind text, p_created_by uuid)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_version int := coalesce((select max(v.version) from sgn.case_version as v where v.case_id = p_case_id), 0) + 1;
begin
    insert into sgn.case_version (
        case_id, version, content, content_sha256, created_at,
        terms, version_sha256, tier, change_kind, created_by, notices, errors
    )
    values (
        p_case_id, v_version, p_prepared -> 'content', decode(p_prepared ->> 'content_sha256', 'hex'), sgn_internal.now(),
        p_prepared -> 'terms', decode(p_prepared ->> 'version_sha256', 'hex'), p_prepared ->> 'tier', p_change_kind,
        p_created_by, p_prepared -> 'notices', p_prepared -> 'errors'
    );
    update sgn.request_case
    set current_version = v_version,
        tier = p_prepared ->> 'tier'
    where id = p_case_id;
    return v_version;
end;
$$;

-- 新版本和目前版本比較後寫入，回傳變更分類。
create function sgn_internal.version_add(p_case sgn.request_case, p_prepared jsonb, p_created_by uuid)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_current sgn.case_version;
    v_kind text;
begin
    select * into v_current from sgn.case_version where case_id = p_case.id and version = p_case.current_version;
    v_kind := sgn_internal.versions_compare(
        p_case.process_type,
        v_current.content, v_current.terms, v_current.tier,
        p_prepared -> 'content', p_prepared -> 'terms', p_prepared ->> 'tier'
    );
    perform sgn_internal.version_store(p_case.id, p_prepared, v_kind, p_created_by);
    return v_kind;
end;
$$;

-- ── 工作的查詢（授權入口與畫面共用）──

-- 這個人在這張單目前開著的關卡裡、指派給他且等他處理的工作（每關不同人，所以最多一件）。
create function sgn_internal.person_open_task(p_case_id uuid, p_person_id uuid, p_phase text)
returns sgn.case_task
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select t.*
    from sgn.case_task as t
    join sgn.case_stage as s on s.id = t.stage_id
    join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
    where t.case_id = p_case_id
      and t.assignee_person_id = p_person_id
      and t.status = 'pending'
      and s.status = 'open'
      and ps.phase = p_phase
    order by t.id
    limit 1
$$;

-- 這個人可以認領的工作：開著的關卡裡等認領、他持有該角色（與範圍）且在這一關合格。
create function sgn_internal.person_claimable_task(p_case_id uuid, p_person_id uuid)
returns sgn.case_task
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select t.*
    from sgn.case_task as t
    join sgn.case_stage as s on s.id = t.stage_id
    where t.case_id = p_case_id
      and t.status = 'unclaimed'
      and s.status = 'open'
      and p_person_id = any (sgn_internal.claim_candidates(p_case_id, s.id, t.claim_role, t.claim_scope))
    order by t.id
    limit 1
$$;

-- 這個人和這張單有沒有工作上的關係（曾被指派、或目前可以認領）。
create function sgn_internal.person_has_task(p_case_id uuid, p_person_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (select 1 from sgn.case_task as t where t.case_id = p_case_id and t.assignee_person_id = p_person_id)
        or (sgn_internal.person_claimable_task(p_case_id, p_person_id)).id is not null
$$;

-- 授權檢查的唯一入口（取代 40_case.sql 的版本）。回傳拒絕代碼；可以做時回 null。
-- 簽核與執行另外經 decider_denial 重驗職責分離（K-DECISION-ELIGIBLE）。
-- 規則：K-ACTOR-PROVEN、K-DECISION-ELIGIBLE、K-SOD-APPLICANT、K-SOD-DISTINCT、K-NO-REGRESS、K-CLAIM、K-AUDITOR-READONLY
create or replace function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_case sgn.request_case)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when a.action is null or a.actor_rule = 'system' then 'ACTION_UNKNOWN'
        when a.scope = 'case' and p_case.id is null then 'CASE_UNKNOWN'
        when a.actor_rule = 'role'
             and not sgn_internal.has_role(p_person_id, sgn_internal.setting_text(a.role_setting)) then a.denied_code
        when a.actor_rule = 'case_party'
             and p_person_id is distinct from p_case.applicant_person_id
             and not sgn_internal.person_has_task(p_case.id, p_person_id) then 'CASE_UNKNOWN'
        when a.actor_rule = 'applicant' and p_person_id is distinct from p_case.applicant_person_id then 'NOT_APPLICANT'
        when a.actor_rule in ('assignee', 'claimant', 'fulfiller') and p_person_id = p_case.applicant_person_id then 'SELF_APPROVAL'
        when a.changes_state and sgn_internal.next_state(p_case.state, a.action) is null then 'STATE_TRANSITION'
        when a.actor_rule = 'assignee'
             and (sgn_internal.person_open_task(p_case.id, p_person_id, 'approval')).id is null then 'NOT_APPROVER'
        when a.actor_rule = 'fulfiller'
             and (sgn_internal.person_open_task(p_case.id, p_person_id, 'fulfilment')).id is null then 'NOT_FULFILLER'
        when a.actor_rule = 'claimant'
             and (sgn_internal.person_claimable_task(p_case.id, p_person_id)).id is null then 'NOT_CLAIMABLE'
        when a.actor_rule in ('assignee', 'fulfiller') then sgn_internal.decider_denial(
            p_case.id,
            p_person_id,
            (sgn_internal.person_open_task(
                p_case.id, p_person_id, case a.actor_rule when 'assignee' then 'approval' else 'fulfilment' end
            )).stage_id
        )
    end
    from (select 1) as one
    left join sgn.action as a on a.action = p_action
$$;

-- ── 關卡推進 ──

create function sgn_internal.stage_applies(p_stage sgn.policy_stage, p_tier text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select p_stage.applies_when is null or p_stage.applies_when -> 'tier_in' ? p_tier
$$;

-- 解析出的工作寫入，並通知指派對象或候選人。
create function sgn_internal.stage_add_tasks(p_case sgn.request_case, p_stage_id bigint, p_stage sgn.policy_stage, p_specs jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_spec jsonb;
    v_task_id bigint;
    v_tasks jsonb := '[]'::jsonb;
    v_payload jsonb := jsonb_build_object('case_no', p_case.case_no, 'stage_name', p_stage.name);
begin
    for v_spec in select * from jsonb_array_elements(p_specs) loop
        insert into sgn.case_task (case_id, stage_id, assignee_person_id, claim_role, claim_scope, scope_refs, status, basis, opened_at)
        values (
            p_case.id,
            p_stage_id,
            (v_spec ->> 'assignee')::uuid,
            v_spec ->> 'claim_role',
            v_spec ->> 'claim_scope',
            array(select jsonb_array_elements_text(v_spec -> 'scope_refs')),
            case when v_spec ->> 'assignee' is null then 'unclaimed' else 'pending' end,
            v_spec -> 'basis',
            sgn_internal.now()
        )
        returning id into v_task_id;
        v_tasks := v_tasks || (v_spec || jsonb_build_object('task_id', v_task_id));
        if v_spec ->> 'assignee' is null then
            perform sgn_internal.notify(
                'case.task_claimable',
                array(select jsonb_array_elements_text(v_spec #> '{basis,candidates}')::uuid),
                p_case.id,
                v_payload
            );
        else
            perform sgn_internal.notify('case.task_assigned', array[(v_spec ->> 'assignee')::uuid], p_case.id, v_payload);
        end if;
    end loop;
    return v_tasks;
end;
$$;

-- 開一關：建立關卡實例、解析工作。解析不到人就停住並開例外（K-RESOLVE-HALT）；
-- 主管關卡依據的是基準之後同步異動而來的主管關係時，開例外（K-DETECT-MANAGER-FLIP）。
create function sgn_internal.stage_open(p_case sgn.request_case, p_stage sgn.policy_stage)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_stage_id bigint;
    v_specs jsonb;
    v_tasks jsonb;
    v_line jsonb;
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
            'rules', jsonb_build_array('K-RESOLVE-STAGE-START', 'K-SOD-APPLICANT', 'K-SOD-DISTINCT', 'K-AUDITOR-INDEPENDENT')
        )
    );
    for v_line in select t #> '{basis,line}' from jsonb_array_elements(v_tasks) as t loop
        if v_line ->> 'origin' = 'sync_change' then
            perform sgn_internal.exception_open('K-DETECT-MANAGER-FLIP', p_case.id, v_line);
        end if;
    end loop;
end;
$$;

-- 核准完成且有執行關：產生執行內容（流程包的 build_fulfilment），之後的執行人綁定它的雜湊。
create function sgn_internal.fulfilment_prepare(p_case sgn.request_case)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_payload jsonb := sgn_internal.hook_fulfilment(p_case.process_type, p_case.id);
    v_hash bytea := sgn_internal.jcs_sha256(v_payload);
begin
    insert into sgn.fulfilment (case_id, version, payload, payload_sha256, created_at)
    values (p_case.id, p_case.current_version, v_payload, v_hash, sgn_internal.now());
    perform sgn_internal.audit_append(
        'case.approval_completed', p_case.id, null,
        jsonb_build_object(
            'version', p_case.current_version,
            'payload_sha256', encode(v_hash, 'hex'),
            'rules', jsonb_build_array('K-PARALLEL-ALL', 'K-FULFIL')
        )
    );
end;
$$;

-- 執行全部完成：建立授權並生效（K-FULFIL）。
create function sgn_internal.grant_activate(p_case sgn.request_case)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_terms jsonb := (select v.terms from sgn.case_version as v where v.case_id = p_case.id and v.version = p_case.current_version);
    v_grant_id uuid := gen_random_uuid();
    v_seq bigint;
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
end;
$$;

-- 沒有開著或停住的關卡時，往下一個適用的關卡走；沒有下一關就結束這個階段。
-- 「下一關」＝依順序第一個適用目前級別、且還沒有完成實例的關卡（退回後只做縮小時，之前完成的關卡仍然有效）。
create function sgn_internal.case_advance(p_case_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_next sgn.policy_stage;
begin
    loop
        select * into v_case from sgn.request_case where id = p_case_id;
        if exists (select 1 from sgn.case_stage where case_id = p_case_id and status in ('open', 'halted')) then
            return;
        end if;
        select ps.* into v_next
        from sgn.policy_stage as ps
        where ps.policy_id = v_case.policy_id
          and sgn_internal.stage_applies(ps, v_case.tier)
          and not exists (
              select 1 from sgn.case_stage as s
              where s.case_id = p_case_id and s.policy_id = ps.policy_id and s.seq = ps.seq and s.status = 'done'
          )
        order by ps.seq
        limit 1;
        if v_next.seq is null then
            if v_case.state = 'in_approval' then
                perform sgn_internal.case_transition(p_case_id, 'finish_approval_final');
                perform sgn_internal.audit_append(
                    'case.completed', p_case_id, null,
                    jsonb_build_object('version', v_case.current_version, 'rules', jsonb_build_array('K-PARALLEL-ALL'))
                );
            elsif v_case.state = 'pending_fulfilment' then
                perform sgn_internal.case_transition(p_case_id, 'finish_fulfilment');
                perform sgn_internal.grant_activate(v_case);
            end if;
            return;
        end if;
        if v_next.phase = 'fulfilment' and v_case.state = 'in_approval' then
            perform sgn_internal.case_transition(p_case_id, 'finish_approval');
            perform sgn_internal.fulfilment_prepare(v_case);
        end if;
        perform sgn_internal.stage_open(v_case, v_next);
    end loop;
end;
$$;

-- 一件工作結束後：同一關的工作都完成（核准或執行完成）就結束這一關並往下走（K-PARALLEL-ALL）。
create function sgn_internal.stage_close_if_done(p_stage_id bigint)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case_id uuid := (select s.case_id from sgn.case_stage as s where s.id = p_stage_id);
begin
    if exists (
        select 1 from sgn.case_task as t
        where t.stage_id = p_stage_id and t.status not in ('approved', 'completed')
    ) then
        return;
    end if;
    update sgn.case_stage set status = 'done', closed_at = sgn_internal.now() where id = p_stage_id;
    perform sgn_internal.case_advance(v_case_id);
end;
$$;

-- 把開著或停住的關卡收掉（退回、撤回、駁回、重簽時）。
create function sgn_internal.stages_close_open(p_case_id uuid, p_status text, p_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
begin
    update sgn.case_task as t
    set status = 'cancelled', closed_at = v_now, reason = p_reason
    from sgn.case_stage as s
    where s.id = t.stage_id
      and s.case_id = p_case_id
      and s.status in ('open', 'halted')
      and t.status in ('unclaimed', 'pending');
    update sgn.case_stage
    set status = p_status, closed_at = v_now, close_reason = p_reason
    where case_id = p_case_id and status in ('open', 'halted');
end;
$$;

-- ── 建立、修改、送審 ──

create function sgn_internal.case_new(p_person_id uuid, p_process_type text, p_content jsonb, p_terms jsonb)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case_id uuid;
    v_prepared jsonb;
begin
    if not exists (select 1 from sgn.process_type where code = p_process_type) then
        perform sgn_internal.raise_error('PROCESS_UNKNOWN', p_process_type);
    end if;
    insert into sgn.request_case (applicant_person_id, process_type, state, current_version, created_at)
    values (p_person_id, p_process_type, 'draft', 0, sgn_internal.now())
    returning id into v_case_id;
    v_prepared := sgn_internal.version_prepare(p_process_type, p_content, p_terms);
    perform sgn_internal.version_store(v_case_id, v_prepared, 'initial', p_person_id);
    perform sgn_internal.audit_append(
        'case.created', v_case_id, p_person_id,
        jsonb_build_object(
            'process_type', p_process_type,
            'version', 1,
            'content_sha256', v_prepared ->> 'content_sha256',
            'version_sha256', v_prepared ->> 'version_sha256',
            'tier', v_prepared ->> 'tier'
        )
    );
    return v_case_id;
end;
$$;

-- 送審前的重疊檢查（K-OVERLAP-BLOCK、K-OVERLAP-REASON）：完全涵蓋就擋下；部分重疊要有理由。結果記在 case_overlap。
create function sgn_internal.case_overlap_check(p_case sgn.request_case, p_content jsonb, p_reason text)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_overlap jsonb := jsonb_build_object('level', 'none', 'items', '[]'::jsonb);
begin
    if sgn_internal.process_option(p_case.process_type, 'overlap_check') then
        v_overlap := sgn_internal.hook_overlaps(p_case.process_type, p_case.id, p_content);
    end if;
    if v_overlap ->> 'level' = 'covered' then
        perform sgn_internal.raise_error('OVERLAP_COVERED', (v_overlap -> 'items')::text);
    end if;
    if v_overlap ->> 'level' = 'partial' and coalesce(btrim(p_reason), '') = '' then
        perform sgn_internal.raise_error('OVERLAP_REASON_REQUIRED', (v_overlap -> 'items')::text);
    end if;
    insert into sgn.case_overlap (case_id, version, level, items, reason, checked_at)
    values (
        p_case.id, p_case.current_version, v_overlap ->> 'level', v_overlap -> 'items',
        case when v_overlap ->> 'level' = 'partial' then btrim(p_reason) end, sgn_internal.now()
    );
    return v_overlap || jsonb_build_object('reason', case when v_overlap ->> 'level' = 'partial' then btrim(p_reason) end);
end;
$$;

-- 退回或撤回後重送：和退回當時的版本比較，只做縮小（或沒改）就從退回的那一關繼續；
-- 其他修改、或路徑已有新版，從第一關重簽（K-RETURN）。回傳 {mode, change_kind, compared_with}。
create function sgn_internal.case_resume_mode(p_case sgn.request_case)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_old sgn.case_version;
    v_new sgn.case_version;
    v_kind text;
begin
    if p_case.state <> 'returned' then
        return jsonb_build_object('mode', 'start');
    end if;
    select * into v_old from sgn.case_version where case_id = p_case.id and version = p_case.returned_version;
    select * into v_new from sgn.case_version where case_id = p_case.id and version = p_case.current_version;
    v_kind := sgn_internal.versions_compare(
        p_case.process_type, v_old.content, v_old.terms, v_old.tier, v_new.content, v_new.terms, v_new.tier
    );
    return jsonb_build_object(
        'mode', case
            when v_kind in ('same', 'reduce') and p_case.policy_id = (sgn_internal.policy_latest(p_case.process_type)).id then 'resume'
            else 'restart'
        end,
        'change_kind', v_kind,
        'compared_with', p_case.returned_version,
        'resume_seq', p_case.resume_seq
    );
end;
$$;

-- 送審（取代 40_case.sql 的兩個參數版本）。
create function sgn_internal.case_submit_draft(p_person_id uuid, p_case_id uuid, p_overlap_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_version sgn.case_version;
    v_errors jsonb;
    v_overlap jsonb;
    v_mode jsonb;
begin
    perform sgn_internal.authorize(p_person_id, 'submit', v_case);
    select * into v_version from sgn.case_version where case_id = p_case_id and version = v_case.current_version;
    v_errors := v_version.errors || sgn_internal.terms_errors(v_case.process_type, v_version.terms, v_version.tier);
    if jsonb_array_length(v_errors) > 0 then
        perform sgn_internal.raise_error('CONTENT_INVALID', v_errors::text);
    end if;
    v_overlap := sgn_internal.case_overlap_check(v_case, v_version.content, p_overlap_reason);
    v_mode := sgn_internal.case_resume_mode(v_case);
    if v_mode ->> 'mode' <> 'resume' then
        -- 從第一關重簽：之前的關卡全部作廢，改用最新版路徑
        update sgn.case_stage set status = 'cancelled', close_reason = 'restart'
        where case_id = p_case_id and status in ('done', 'returned');
        update sgn.request_case set policy_id = (sgn_internal.policy_latest(v_case.process_type)).id where id = p_case_id;
    end if;
    update sgn.request_case set resume_seq = null, returned_version = null where id = p_case_id;
    perform sgn_internal.case_transition(p_case_id, 'submit');
    perform sgn_internal.audit_append(
        'case.submitted', p_case_id, p_person_id,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', encode(v_version.content_sha256, 'hex'),
            'version_sha256', encode(v_version.version_sha256, 'hex'),
            'tier', v_version.tier,
            'policy_version', (select p.version from sgn.approval_policy as p join sgn.request_case as c on c.policy_id = p.id where c.id = p_case_id),
            'path', v_mode,
            'overlap', v_overlap,
            'settings', jsonb_build_object(
                'validity.max_months',
                sgn_internal.setting('validity.max_months', sgn_internal.validity_scopes(v_case.process_type, v_version.tier))
            ),
            'rules', jsonb_build_array('K-VALIDITY-MAX', 'K-NO-BACKDATE', 'K-PRINCIPAL', 'K-OVERLAP-BLOCK', 'K-OVERLAP-REASON', 'K-RETURN')
        )
    );
    perform sgn_internal.case_advance(p_case_id);
end;
$$;

drop function sgn_internal.case_submit_draft(uuid, uuid);
drop function sgn_internal.case_new(uuid, jsonb);
drop function sgn_internal.case_add_version(uuid, int, jsonb);
drop function api.case_create(text, jsonb);
drop function api.case_submit_new(text, jsonb);
drop function api.case_revise(text, uuid, jsonb);
drop function api.case_submit(text, uuid);
