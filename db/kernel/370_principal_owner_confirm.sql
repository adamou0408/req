-- 代填申請要由被授權者的負責人確認（裁決 D79 (2)；紅隊第三輪 推論 I4）。
--
-- 根因：任何員工都能替任何被授權者送單，路徑裡沒有被授權者的負責人；負責人不知情就拿到權限，問責斷在第一步。
--
-- 這一版：
--   1. 新的 resolver 種類 principal_owner：這張單（目前版本）的被授權者的負責人。和其他種類一樣經 resolve_stage 這個
--      唯一入口、套用同一個合格判斷（decider_denial）：負責人不合格（例如持有不能簽核的角色）時沿他的主管線往上，
--      並開例外 K-PRINCIPAL-OWNER-CONFIRM 讓人來看。
--   2. 關卡的適用條件 applies_when 多一個鍵 applicant_not_principal_owner（只能是 true，流程類型要有被授權者）：
--      申請人不是負責人時才有這一關；是負責人本人時不加。適用條件只看資料，判斷只在 stage_applies_to_case 一處。
--   3. 負責人簽了這一關，就是這張單上的一件工作：之後每一關的人都不能是他（K-SOD-DISTINCT，既有規則，不另寫）。
--   4. 被授權者清單多一個 mine（看的人就是負責人），並把這些排在前面：新申請畫面先列不需要多一關的選擇。
--   5. 申請單詳情多一個 path：這張單會經過的關卡（依這張單算，含這一關），新申請畫面只畫它。
--   6. 申請單詳情多一個 resubmit：退回後修改中的單，這次修改和退回當時那一版比是縮小還是擴大、送出後從哪裡繼續
--      （K-RETURN 的判斷 case_resume_mode，送出前就讓申請人看到要不要重簽）。不是退回的單為 null。

alter table sgn.policy_stage
    drop constraint policy_stage_resolver_kind_check;

alter table sgn.policy_stage
    add constraint policy_stage_resolver_kind_check check (
        resolver_kind in ('applicant_manager', 'principal_owner', 'role_holder', 'scoped_role', 'role_group_claim', 'system_custodian')
    );

-- 不帶角色的種類：申請人主管與被授權者負責人（取代「只有 applicant_manager 不帶角色」的檢查）
alter table sgn.policy_stage
    drop constraint policy_stage_check;

alter table sgn.policy_stage
    add constraint policy_stage_role_check check ((resolver_kind in ('applicant_manager', 'principal_owner')) = (resolver_role is null));

alter table sgn.policy_stage
    add constraint policy_stage_owner_mode_check check (resolver_kind <> 'principal_owner' or mode = 'one');

-- 關卡定義的檢查（同 120 的簽章）：applies_when 只能有 tier_in（已知級別的陣列）與 applicant_not_principal_owner（true）。
create or replace function sgn_internal.policy_stage_checked(p_process_type text, p_stage jsonb)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_when jsonb := nullif(p_stage -> 'applies_when', 'null'::jsonb);
    v_tier text;
begin
    if (p_stage #>> '{resolver,kind}') = 'principal_owner' and not sgn_internal.process_option(p_process_type, 'uses_principal') then
        perform sgn_internal.registration_fail(p_stage ->> 'code' || ': principal_owner needs uses_principal');
    end if;
    if v_when is null then
        return;
    end if;
    if jsonb_typeof(v_when) <> 'object'
       or v_when = '{}'::jsonb
       or exists (select 1 from jsonb_object_keys(v_when) as k where k not in ('tier_in', 'applicant_not_principal_owner')) then
        perform sgn_internal.registration_fail(p_stage ->> 'code' || ': applies_when');
    end if;
    if v_when ? 'tier_in' then
        if jsonb_typeof(v_when -> 'tier_in') <> 'array' then
            perform sgn_internal.registration_fail(p_stage ->> 'code' || ': applies_when.tier_in');
        end if;
        for v_tier in select jsonb_array_elements_text(v_when -> 'tier_in') loop
            if not exists (select 1 from sgn.process_tier as t where t.process_type = p_process_type and t.tier_code = v_tier) then
                perform sgn_internal.registration_fail(p_stage ->> 'code' || ': unknown tier ' || v_tier);
            end if;
        end loop;
    end if;
    if v_when ? 'applicant_not_principal_owner'
       and (v_when -> 'applicant_not_principal_owner' <> 'true'::jsonb
            or not sgn_internal.process_option(p_process_type, 'uses_principal')) then
        perform sgn_internal.registration_fail(p_stage ->> 'code' || ': applies_when.applicant_not_principal_owner');
    end if;
end;
$$;

-- 這張單目前版本的被授權者的負責人（沒有被授權者時為 null）。
create function sgn_internal.case_principal_owner(p_case sgn.request_case)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select x.owner_person_id
    from sgn.case_version as v
    join sgn.principal as x on x.id::text = v.terms ->> 'principal_id'
    where v.case_id = p_case.id
      and v.version = p_case.current_version
$$;

-- 只看級別的適用（同 160 的簽章）：級別符合，而且沒有依申請單而定的條件。
-- 用在「某級別對每一位申請人都會經過的關卡」（process_type_list）；依申請單的判斷在 stage_applies_to_case。
create or replace function sgn_internal.stage_applies(p_stage sgn.policy_stage, p_tier text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select p_stage.applies_when is null
        or (
            (not p_stage.applies_when ? 'tier_in' or p_stage.applies_when -> 'tier_in' ? p_tier)
            and not p_stage.applies_when ? 'applicant_not_principal_owner'
        )
$$;

-- 這一關適不適用這張單（唯一的判斷）：級別、以及申請人是不是被授權者的負責人（K-PRINCIPAL-OWNER-CONFIRM）。
create function sgn_internal.stage_applies_to_case(p_stage sgn.policy_stage, p_case sgn.request_case)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p_stage.applies_when is null
        or (
            (not p_stage.applies_when ? 'tier_in' or p_stage.applies_when -> 'tier_in' ? p_case.tier)
            and (
                not p_stage.applies_when ? 'applicant_not_principal_owner'
                or sgn_internal.case_principal_owner(p_case) is distinct from p_case.applicant_person_id
            )
        )
$$;

-- 往下一個適用的關卡走（同 160 的簽章）：適用與否改由 stage_applies_to_case 判斷。
create or replace function sgn_internal.case_advance(p_case_id uuid)
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
          and sgn_internal.stage_applies_to_case(ps, v_case)
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

-- principal_owner：被授權者的負責人；不合格就沿他的主管線往上（同一個 resolve_eligible）。
create function sgn_internal.resolve_principal_owner(p_case sgn.request_case, p_stage_id bigint, p_top_role text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_owner uuid := sgn_internal.case_principal_owner(p_case);
    v_resolved jsonb;
begin
    if v_owner is null then
        return '[]'::jsonb;
    end if;
    v_resolved := sgn_internal.resolve_eligible(p_case.id, p_stage_id, v_owner, p_top_role);
    if v_resolved -> 'person_id' = 'null'::jsonb then
        return '[]'::jsonb;
    end if;
    return jsonb_build_array(sgn_internal.task_spec_assigned(
        v_resolved,
        '{}',
        jsonb_build_object(
            'resolver', 'principal_owner',
            'owner', v_owner,
            'principal_id', (select v.terms ->> 'principal_id' from sgn.case_version as v where v.case_id = p_case.id and v.version = p_case.current_version)
        )
    ));
end;
$$;

-- 解析一關的唯一入口（同 150 的簽章）：多了 principal_owner。
create or replace function sgn_internal.resolve_stage(p_case sgn.request_case, p_stage_id bigint, p_stage sgn.policy_stage)
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
    if p_stage.resolver_kind = 'principal_owner' then
        return sgn_internal.resolve_principal_owner(p_case, p_stage_id, v_top_role);
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

-- 解析結果不是本人（角色的持有人、被授權者的負責人）而是升級來的人時，開例外讓人來看。
-- 回傳這一關升級時要開的例外代碼；不會升級的種類回傳 null。
create function sgn_internal.stage_escalation_rule(p_resolver_kind text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_resolver_kind in ('role_holder', 'scoped_role') then 'K-SOD-ROLE-ESCALATED'
        when p_resolver_kind = 'principal_owner' then 'K-PRINCIPAL-OWNER-CONFIRM'
    end
$$;

-- 開一關（同 360 的簽章）：升級時的例外改依 stage_escalation_rule，多了被授權者負責人的升級。
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
    v_rule text := sgn_internal.stage_escalation_rule(p_stage.resolver_kind);
begin
    insert into sgn.case_stage (case_id, policy_id, seq, status, opened_version, opened_at)
    values (p_case.id, p_stage.policy_id, p_stage.seq, 'open', p_case.current_version, sgn_internal.now())
    returning id into v_stage_id;
    v_specs := sgn_internal.resolve_stage(p_case, v_stage_id, p_stage);
    if jsonb_array_length(v_specs) = 0 then
        perform sgn_internal.stage_halt(p_case, p_stage, v_stage_id);
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
            'rules', jsonb_build_array(
                'K-RESOLVE-STAGE-START', 'K-SOD-APPLICANT', 'K-SOD-DISTINCT', 'K-AUDITOR-INDEPENDENT', 'K-SOD-ROLE-ESCALATED',
                'K-PRINCIPAL-OWNER-CONFIRM'
            )
        )
    );
    for v_line in select t #> '{basis,line}' from jsonb_array_elements(v_tasks) as t loop
        if v_line ->> 'origin' = 'sync_change' then
            perform sgn_internal.exception_open('K-DETECT-MANAGER-FLIP', p_case.id, v_line);
        end if;
    end loop;
    if v_rule is not null then
        for v_basis in select t -> 'basis' from jsonb_array_elements(v_tasks) as t loop
            if v_basis ->> 'via' in ('manager_chain', 'top_resolver') then
                perform sgn_internal.exception_open(v_rule, p_case.id, jsonb_build_object(
                    'stage', p_stage.code, 'seq', p_stage.seq, 'role', p_stage.resolver_role, 'resolver', p_stage.resolver_kind,
                    'via', v_basis ->> 'via', 'path', v_basis -> 'path'
                ));
            end if;
        end loop;
    end if;
end;
$$;

-- 解析不到人：停住這一關、進鏈、開例外、通知申請人（K-RESOLVE-HALT）。
create function sgn_internal.stage_halt(p_case sgn.request_case, p_stage sgn.policy_stage, p_stage_id bigint)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    update sgn.case_stage set status = 'halted' where id = p_stage_id;
    perform sgn_internal.audit_append(
        'case.stage_halted', p_case.id, null,
        jsonb_build_object('stage', p_stage.code, 'seq', p_stage.seq, 'rules', jsonb_build_array('K-RESOLVE-HALT'))
    );
    perform sgn_internal.exception_open('K-RESOLVE-HALT', p_case.id, jsonb_build_object('stage', p_stage.code, 'seq', p_stage.seq));
    perform sgn_internal.notify(
        'case.halted', array[p_case.applicant_person_id], p_case.id,
        jsonb_build_object('case_no', p_case.case_no, 'stage_name', p_stage.name)
    );
end;
$$;

-- 這張單會經過的關卡（依順序；含依申請人而定的關卡）。草稿與退回的單用目前最新的路徑（送審時才綁定）。
create function sgn_internal.case_path(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'seq', ps.seq,
        'code', ps.code,
        'name', ps.name,
        'phase', ps.phase,
        'mode', ps.mode
    ) order by ps.seq), '[]'::jsonb)
    from sgn.request_case as c
    join sgn.policy_stage as ps on ps.policy_id = case
        when c.state in ('draft', 'returned') or c.policy_id is null then (
            select p.id
            from sgn.approval_policy as p
            where p.process_type = c.process_type
              and p.effective_from <= sgn_internal.now()
            order by p.version desc
            limit 1
        )
        else c.policy_id
    end
    where c.id = p_case_id
      and sgn_internal.stage_applies_to_case(ps, c)
$$;

-- 退回後重送會怎樣（送出前的預告；判斷與送出時同一個 case_resume_mode）：{change_kind, mode}。不是退回的單回 null。
create function sgn_internal.case_resubmit_preview(p_case_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_mode jsonb;
begin
    select * into v_case from sgn.request_case where id = p_case_id;
    if v_case.state <> 'returned' then
        return null;
    end if;
    v_mode := sgn_internal.case_resume_mode(v_case);
    return jsonb_build_object('change_kind', v_mode ->> 'change_kind', 'mode', v_mode ->> 'mode');
end;
$$;

-- 申請單詳情（同 300 的簽章）：多了 path 與 resubmit。
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
        'resubmit', sgn_internal.case_resubmit_preview(p_case_id)
    );
end;
$$;

-- 被授權者清單（同 180 的簽章）：多了 mine，看的人自己負責的排在前面。
create or replace function api.principal_list(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    return coalesce((
        select jsonb_agg(
            sgn_internal.principal_json(x.id) || jsonb_build_object('mine', x.owner_person_id = v_person_id)
            order by x.owner_person_id = v_person_id desc, x.kind, x.name
        )
        from sgn.principal as x
        where sgn_internal.principal_usable(x.id)
    ), '[]'::jsonb);
end;
$$;

comment on function api.principal_list(text) is
    '可以選的被授權者（團隊、專案、agent）：有效、沒有過結束日、負責人在職。mine＝看的人就是負責人（送審時不必多一關'
    '「被授權者負責人確認」），排在前面。新申請畫面用。呼叫者：sgn_app。規則：K-PRINCIPAL、K-PRINCIPAL-OWNER-CONFIRM';

select sgn_internal.register_rule(
    'K-PRINCIPAL-OWNER-CONFIRM',
    '申請人不是被授權者的負責人時（代填），路徑第一關是「被授權者負責人確認」：負責人用通行金鑰簽顯示摘要；是負責人本人時不加這一關。'
    '這一關的人經同一個解析入口與合格判斷，之後每一關都不能是他；負責人不合格時沿他的主管線升級並開例外（D79 (2)）',
    null,
    'full',
    null
);
