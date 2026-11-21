-- 功能第四批 C：被授權者的負責人離職或停用（rules.md 原則 ④「沒人負責就失效」、「被授權者」；骨幹 K-OWNER-CONTINUITY；
-- 交接 docs/handoff/feature-4-deadlines.md）。
--
-- 1. 偵測：人員同步把人停用（sgn_internal.directory_deactivate，包含冷卻期後才套用的延後停用）的同一個交易裡，替他負責、
--    仍有效的被授權者各開一筆「負責人缺口」（sgn.principal_owner_gap）與例外 K-OWNER-CONTINUITY，期限＝現在＋寬限期
--    （參數 grant.owner_grace_days，預設 14 天），通知他的主管（經主管 resolver，開缺口時記下）與治理角色
--    （參數 grant.owner_reassign_roles）。排程每一輪也補開漏掉的（例如這一版之前就停用的人）。
--    調職（調離單位）沒有偵測：人員與組織 port 目前只同步人員、主管與群組，沒有單位（交接寫明）。
-- 2. 改指派：缺口記下的主管或治理角色指定新的負責人（只是提議，不改任何東西），新負責人用通行金鑰確認接下才生效；
--    簽的內容是資料庫產生的顯示摘要（被授權者、原負責人、新負責人、提議人、原因、期限）。新負責人必須在職、不是原負責人，
--    而且不能是這個被授權者任何一張還在進行或生效中的單的簽核人（每關不同人：負責人確認是路徑上的一關，簽核人接手負責人
--    就等於同一個人簽了兩關；K-OWNER-SOD）。提議與確認都是稽核事件；確認時重新檢查。
-- 3. 逾期沒有改指派（負責人仍不在職）：排程把這個被授權者名下所有生效中的授權撤銷並交付撤回（既有入口 grant_end），
--    事件寫明規則代碼與參數值。原負責人在寬限期內恢復在職（同步改回、過了冷卻期）：缺口結案，不撤銷。
-- 4. 簽核中的單：被授權者不能用（負責人不在職、被授權者已結束）時不能再核准（授權入口 PRINCIPAL_UNAVAILABLE），
--    退回、駁回、撤回照常；單的頁面顯示原因（case_summary 的 hold）；時限暫停計算（不催、不升級）。
-- 5. 被授權者結束（rules.md「被授權者」；K-PRINCIPAL-END）：專案、agent 過了結束日 → 名下生效中的授權到期失效；
--    團隊解散（被授權者狀態 ended）→ 撤銷。由排程執行。

insert into sgn.error_catalog (code, message, http_status) values
    ('PRINCIPAL_UNAVAILABLE', '被授權者目前沒有在職的負責人或已經結束，這張單不能再往下核准；請等負責人改指派完成，或退回申請人', 409),
    ('OWNER_GAP_UNKNOWN', '找不到這筆負責人改指派', 404),
    ('OWNER_GAP_STATE', '這筆負責人改指派已經結束', 409),
    ('NOT_OWNER_REASSIGNER', '只有原負責人的主管或治理角色可以指定新的負責人', 403),
    ('NOT_OWNER_CANDIDATE', '只有被指定的新負責人可以確認接下', 403),
    ('OWNER_HANDOVER_NONE', '還沒有指定新的負責人', 409),
    ('OWNER_CANDIDATE_INVALID', '新的負責人必須是在職的人，而且不能是原負責人', 422),
    ('OWNER_CANDIDATE_SOD', '新的負責人是這個被授權者進行中或生效中的單的簽核人，接手負責人會讓每關不同人失效', 422),
    ('OWNER_REASON_REQUIRED', '請寫指定的原因', 422),
    ('OWNER_CANDIDATE_SELF', '不能指定自己當新的負責人：要接手時請由另一位有權指定的人（主管或治理角色）指定你', 422),
    ('SOD_PRINCIPAL_OWNER', '你是這張單的被授權者目前的負責人，不能簽這張單的其他關卡', 403);

select sgn_internal.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description)
from (values
    ('grant.owner_grace_days', 'integer', '14', array[]::text[],
        '被授權者的負責人離職或停用之後，改指派新負責人的寬限期（日曆天）；逾期名下生效中的授權自動撤銷（rules.md「預設時限」：14 天）'),
    ('grant.owner_reassign_roles', 'json', '["control_owner"]', array[]::text[],
        '負責人離職時，除了原負責人的主管之外，也可以指定新負責人、並收到通知的治理角色')
) as d (key, value_type, default_value, scope_kinds, description);

alter table sgn.auth_challenge
    drop constraint auth_challenge_purpose_check,
    add constraint auth_challenge_purpose_check check (purpose in (
        'session', 'passkey_register', 'decision', 'role_change',
        'case.decision', 'role_change.propose', 'role_change.decision', 'passkey.enrollment',
        'passkey.revocation', 'passkey.restore', 'passkey.restore_endorse', 'principal.owner_accept'
    ));

-- 負責人缺口：open 等改指派；reassigned 新負責人已接下；restored 原負責人恢復在職；revoked 逾期、名下授權已撤銷。
create table sgn.principal_owner_gap (
    id uuid primary key default gen_random_uuid(),
    principal_id uuid not null references sgn.principal (id),
    departed_person_id uuid not null references sgn.person (id),
    -- 開缺口時經主管 resolver 解析出的主管（之後主管關係再改也不影響誰能指定）
    manager_person_id uuid references sgn.person (id),
    opened_at timestamptz not null,
    due_at timestamptz not null,
    grace_days int not null,
    exception_id bigint not null references sgn.exception_record (id),
    status text not null check (status in ('open', 'reassigned', 'restored', 'revoked')),
    closed_at timestamptz,
    event_seq bigint not null
);

create unique index principal_owner_gap_open_idx on sgn.principal_owner_gap (principal_id) where status = 'open';

-- 改指派的提議：proposed 等新負責人確認；accepted 已接下；superseded 被新的提議取代；cancelled 缺口結束時作廢。
create table sgn.principal_owner_handover (
    id uuid primary key default gen_random_uuid(),
    gap_id uuid not null references sgn.principal_owner_gap (id),
    new_owner_person_id uuid not null references sgn.person (id),
    proposed_by uuid not null references sgn.person (id),
    reason text not null check (btrim(reason) <> ''),
    proposed_at timestamptz not null,
    status text not null check (status in ('proposed', 'accepted', 'superseded', 'cancelled')),
    accepted_at timestamptz,
    challenge_id uuid references sgn.auth_challenge (id),
    event_seq bigint not null
);

create unique index principal_owner_handover_open_idx on sgn.principal_owner_handover (gap_id) where status = 'proposed';

create function sgn_internal.owner_gap_lock(p_gap_id uuid)
returns sgn.principal_owner_gap
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_gap sgn.principal_owner_gap;
begin
    select * into v_gap from sgn.principal_owner_gap where id = p_gap_id for update;
    if v_gap.id is null then
        perform sgn_internal.raise_error('OWNER_GAP_UNKNOWN');
    end if;
    return v_gap;
end;
$$;

create function sgn_internal.owner_handover_open(p_gap_id uuid)
returns sgn.principal_owner_handover
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from sgn.principal_owner_handover where gap_id = p_gap_id and status = 'proposed'
$$;

-- ── 授權入口（同一個 denial_reason，第四種實體）：誰能指定新負責人、誰能確認接下 ──

create function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_gap sgn.principal_owner_gap)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_action not in ('owner.reassign', 'owner.accept') then 'ACTION_UNKNOWN'
        when p_gap.id is null then 'OWNER_GAP_UNKNOWN'
        -- 寬限期內才能改指派（rules.md「在寬限期內改指派」）；期限一到就等排程撤銷
        when p_gap.status <> 'open' or p_gap.due_at <= sgn_internal.now() then 'OWNER_GAP_STATE'
        when not coalesce((select p.active from sgn.person as p where p.id = p_person_id), false) then 'PERSON_UNKNOWN'
        when p_action = 'owner.accept' and (sgn_internal.owner_handover_open(p_gap.id)).id is null then 'OWNER_HANDOVER_NONE'
        when p_action = 'owner.accept'
             and (sgn_internal.owner_handover_open(p_gap.id)).new_owner_person_id is distinct from p_person_id then 'NOT_OWNER_CANDIDATE'
        when p_action = 'owner.accept' then null
        when exists (
            select 1
            from jsonb_array_elements_text(sgn_internal.setting('approval.excluded_decider_roles')) as r (role_code)
            where sgn_internal.has_role(p_person_id, r.role_code)
        ) then 'DECIDER_ROLE_EXCLUDED'
        when p_gap.manager_person_id = p_person_id then null
        when exists (
            select 1
            from jsonb_array_elements_text(sgn_internal.setting('grant.owner_reassign_roles')) as r (role_code)
            where sgn_internal.has_role(p_person_id, r.role_code)
        ) then null
        else 'NOT_OWNER_REASSIGNER'
    end
$$;

create function sgn_internal.authorize(p_person_id uuid, p_action text, p_gap sgn.principal_owner_gap)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_denial text := sgn_internal.denial_reason(p_person_id, p_action, p_gap);
begin
    if v_denial is not null then
        perform sgn_internal.raise_error(v_denial, p_action);
    end if;
end;
$$;

-- ── 被授權者能不能用、單上的被授權者 ──

create function sgn_internal.case_principal_id(p_case sgn.request_case)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.try_uuid(v.terms ->> 'principal_id')
    from sgn.case_version as v
    where v.case_id = p_case.id and v.version = p_case.current_version
$$;

create function sgn_internal.case_principal_usable(p_case sgn.request_case)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select not coalesce(sgn_internal.process_option(p_case.process_type, 'uses_principal'), false)
        or sgn_internal.principal_usable(sgn_internal.case_principal_id(p_case))
$$;

-- 這個被授權者還在進行或生效中的單（新負責人的職責分離與逾期撤銷都用它）。
create function sgn_internal.principal_live_cases(p_principal_id uuid)
returns setof sgn.request_case
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select c.*
    from sgn.request_case as c
    where c.state in ('in_approval', 'pending_fulfilment', 'verifying', 'active')
      and sgn_internal.case_principal_id(c) = p_principal_id
$$;

-- 這張單還在等的負責人確認工作（負責人確認關，K-PRINCIPAL-OWNER-CONFIRM）。
create function sgn_internal.owner_confirm_tasks(p_case_id uuid)
returns setof sgn.case_task
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select t.*
    from sgn_internal.approval_tasks_waiting(p_case_id) as t
    join sgn.case_stage as s on s.id = t.stage_id
    join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
    where ps.resolver_kind = 'principal_owner' and t.status = 'pending'
$$;

-- 新負責人的檢查（K-OWNER-SOD）：回傳錯誤代碼，可以時回傳 null。
create function sgn_internal.owner_candidate_problem(p_gap sgn.principal_owner_gap, p_candidate uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_candidate is null
             or p_candidate = p_gap.departed_person_id
             or not coalesce((select p.active from sgn.person as p where p.id = p_candidate), false) then 'OWNER_CANDIDATE_INVALID'
        when exists (
            select 1
            from sgn_internal.principal_live_cases(p_gap.principal_id) as c
            join sgn.case_task as t on t.case_id = c.id
            where t.assignee_person_id = p_candidate and t.status in ('pending', 'approved', 'completed')
        ) then 'OWNER_CANDIDATE_SOD'
        -- 負責人確認還在等的單：工作會交給新負責人，他不能是那張單的申請人（不能簽自己的單）
        when exists (
            select 1
            from sgn_internal.principal_live_cases(p_gap.principal_id) as c
            where c.applicant_person_id = p_candidate
              and exists (select 1 from sgn_internal.owner_confirm_tasks(c.id) as t)
        ) then 'OWNER_CANDIDATE_SOD'
    end
$$;

-- 畫面上給指定的人挑的候選人：原負責人主管的直屬部屬與主管本人（在職、不是原負責人），標出不能選的原因。
create function sgn_internal.owner_candidates(p_gap sgn.principal_owner_gap)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'person', sgn_internal.person_display(x.id),
        'problem', sgn_internal.owner_candidate_problem(p_gap, x.id)
    ) order by sgn_internal.owner_candidate_problem(p_gap, x.id) nulls first, x.display_name, x.id), '[]'::jsonb)
    from sgn.person as x
    where x.active
      and x.id <> p_gap.departed_person_id
      and (
          x.id = p_gap.manager_person_id
          or (sgn_internal.resolve_manager(x.id)).manager_person_id is not distinct from p_gap.manager_person_id
      )
      and p_gap.manager_person_id is not null
$$;

-- 新負責人簽的內容（瀏覽器從畫面上的這一份自己算挑戰值；資料庫驗章時用自己的紀錄重算）。
create function sgn_internal.owner_handover_display(p_gap sgn.principal_owner_gap, p_handover sgn.principal_owner_handover)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'gap_id', p_gap.id::text,
        'principal', (select jsonb_build_object('id', x.id::text, 'name', x.name, 'kind', x.kind) from sgn.principal as x where x.id = p_gap.principal_id),
        'departed', sgn_internal.person_display(p_gap.departed_person_id),
        'new_owner', sgn_internal.person_display(p_handover.new_owner_person_id),
        'proposed_by', sgn_internal.person_display(p_handover.proposed_by),
        'reason', p_handover.reason,
        'due', sgn_internal.local_minute_text(p_gap.due_at)
    )
$$;

-- ── 開缺口（K-OWNER-CONTINUITY）──

create function sgn_internal.owner_gap_open(p_principal sgn.principal)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_grace int := sgn_internal.setting_int('grant.owner_grace_days');
    v_roles jsonb := sgn_internal.setting('grant.owner_reassign_roles');
    v_manager uuid := (sgn_internal.resolve_manager(p_principal.owner_person_id)).manager_person_id;
    v_due timestamptz := sgn_internal.now() + make_interval(days => v_grace);
    v_grants jsonb := (
        select coalesce(jsonb_agg(c.case_no order by c.case_no), '[]'::jsonb)
        from sgn_internal.principal_live_cases(p_principal.id) as c
        where c.state = 'active'
    );
    v_detail jsonb := jsonb_build_object(
        'principal', p_principal.id, 'person', p_principal.owner_person_id, 'manager', v_manager, 'due_at', v_due,
        'active_cases', v_grants,
        'settings', jsonb_build_object('grant.owner_grace_days', v_grace, 'grant.owner_reassign_roles', v_roles),
        'rules', jsonb_build_array('K-OWNER-CONTINUITY')
    );
    v_exception bigint := sgn_internal.exception_open('K-OWNER-CONTINUITY', null, v_detail);
    v_id uuid := gen_random_uuid();
begin
    insert into sgn.principal_owner_gap
        (id, principal_id, departed_person_id, manager_person_id, opened_at, due_at, grace_days, exception_id, status, event_seq)
    values (
        v_id, p_principal.id, p_principal.owner_person_id, v_manager, sgn_internal.now(), v_due, v_grace, v_exception, 'open',
        sgn_internal.audit_append('principal.owner_departed', null, null, v_detail || jsonb_build_object('gap_id', v_id, 'exception', v_exception))
    );
    perform sgn_internal.notify(
        'principal.owner_departed', array[v_manager] || sgn_internal.roles_holders(v_roles), null,
        jsonb_build_object(
            'principal_name', p_principal.name, 'person_name', sgn_internal.person_name(p_principal.owner_person_id),
            'due', sgn_internal.local_minute_text(v_due), 'cases', jsonb_array_length(v_grants)::text
        )
    );
    return v_id;
end;
$$;

-- 負責人不在職、仍有效、還沒有缺口的被授權者都開缺口；p_person_id 不是 null 時只看他負責的。回傳開了幾筆。
create function sgn_internal.owner_gaps_open(p_person_id uuid default null)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_principal sgn.principal;
    v_count int := 0;
begin
    for v_principal in
        select x.*
        from sgn.principal as x
        join sgn.person as o on o.id = x.owner_person_id
        where not o.active
          and x.status = 'active'
          and (x.ends_on is null or x.ends_on >= sgn_internal.today())
          and (p_person_id is null or x.owner_person_id = p_person_id)
          and not exists (select 1 from sgn.principal_owner_gap as g where g.principal_id = x.id and g.status = 'open')
          -- 同一位負責人的缺口已經逾期撤銷過：不再重開（否則每過一次寬限期就重來一次）
          and not exists (
              select 1 from sgn.principal_owner_gap as g
              where g.principal_id = x.id and g.departed_person_id = x.owner_person_id and g.status = 'revoked'
          )
        order by x.id
        for update of x
    loop
        perform sgn_internal.owner_gap_open(v_principal);
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- 人員同步停用一個人（同 230 的簽章）：同一個交易裡替他負責的被授權者開缺口。
create or replace function sgn_internal.directory_deactivate(p_person_id uuid, p_detail jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    update sgn.person set active = false where id = p_person_id and active;
    if found then
        perform sgn_internal.audit_append(
            'directory.person_deactivated',
            null,
            null,
            jsonb_build_object('person', p_person_id) || p_detail
        );
        perform sgn_internal.owner_gaps_open(p_person_id);
    end if;
end;
$$;

-- ── 缺口結束 ──

create function sgn_internal.owner_gap_close(p_gap sgn.principal_owner_gap, p_status text, p_detail jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    update sgn.principal_owner_gap set status = p_status, closed_at = sgn_internal.now() where id = p_gap.id;
    update sgn.principal_owner_handover set status = 'cancelled' where gap_id = p_gap.id and status = 'proposed';
    perform sgn_internal.exception_close(p_gap.exception_id, p_detail || jsonb_build_object('gap_id', p_gap.id, 'status', p_status));
end;
$$;

-- 原負責人恢復在職，或負責人已經換成在職的人（例如種子或匯入改了）：不撤銷，缺口結案。
create function sgn_internal.owner_gaps_restore()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_gap sgn.principal_owner_gap;
    v_count int := 0;
begin
    for v_gap in
        select g.* from sgn.principal_owner_gap as g
        join sgn.principal as x on x.id = g.principal_id
        join sgn.person as o on o.id = x.owner_person_id
        where g.status = 'open' and o.active
        order by g.id
        for update of g
    loop
        perform sgn_internal.audit_append('principal.owner_restored', null, null, jsonb_build_object(
            'gap_id', v_gap.id, 'principal', v_gap.principal_id, 'person', v_gap.departed_person_id,
            'owner', (select x.owner_person_id from sgn.principal as x where x.id = v_gap.principal_id),
            'rules', jsonb_build_array('K-OWNER-CONTINUITY')
        ));
        perform sgn_internal.owner_gap_close(v_gap, 'restored', jsonb_build_object('rules', jsonb_build_array('K-OWNER-CONTINUITY')));
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- 逾期沒有改指派（一筆缺口）：名下生效中的授權、執行中與驗證中的單都撤銷並交付撤回（既有入口 grant_end）；
-- 簽核中的單沒有可以作廢的轉移（申請人可以撤回、簽核人可以退回），每張開例外讓人處理，它們仍不能核准。
create function sgn_internal.owner_gap_expire(p_gap sgn.principal_owner_gap)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_revoked jsonb := '[]'::jsonb;
    v_blocked jsonb := '[]'::jsonb;
    v_reason text := sgn_internal.message_text('OWNER_GAP_EXPIRED_REASON', array[p_gap.grace_days::text]);
    v_settings jsonb := jsonb_build_object('grant.owner_grace_days', p_gap.grace_days);
begin
    for v_case in
        select c.* from sgn_internal.principal_live_cases(p_gap.principal_id) as c order by c.case_no
    loop
        v_case := sgn_internal.case_lock(v_case.id);
        if v_case.state in ('active', 'pending_fulfilment', 'verifying') then
            perform sgn_internal.grant_end(v_case, 'revoked', null, v_reason, 'K-OWNER-CONTINUITY');
            v_revoked := v_revoked || to_jsonb(v_case.case_no);
        elsif v_case.state = 'in_approval' then
            perform sgn_internal.exception_open('K-OWNER-CONTINUITY', v_case.id, jsonb_build_object(
                'kind', 'in_approval_blocked', 'gap_id', p_gap.id, 'principal', p_gap.principal_id, 'person', p_gap.departed_person_id,
                'settings', v_settings, 'rules', jsonb_build_array('K-OWNER-CONTINUITY')
            ));
            v_blocked := v_blocked || to_jsonb(v_case.case_no);
        end if;
    end loop;
    perform sgn_internal.audit_append('principal.owner_gap_expired', null, null, jsonb_build_object(
        'gap_id', p_gap.id, 'principal', p_gap.principal_id, 'person', p_gap.departed_person_id, 'due_at', p_gap.due_at,
        'revoked_cases', v_revoked, 'blocked_cases', v_blocked, 'settings', v_settings,
        'rules', jsonb_build_array('K-OWNER-CONTINUITY')
    ));
    perform sgn_internal.owner_gap_close(p_gap, 'revoked', jsonb_build_object(
        'revoked_cases', v_revoked, 'blocked_cases', v_blocked, 'rules', jsonb_build_array('K-OWNER-CONTINUITY')
    ));
end;
$$;

-- 排程：逐筆處理逾期的缺口；每筆自己一個 savepoint，失敗只回捲那一筆並開例外。
create function sgn_internal.owner_gaps_expire()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_gap_id uuid;
    v_gap sgn.principal_owner_gap;
    v_count int := 0;
begin
    for v_gap_id in
        select g.id from sgn.principal_owner_gap as g where g.status = 'open' and g.due_at < sgn_internal.now() order by g.due_at, g.id
    loop
        begin
            select * into v_gap from sgn.principal_owner_gap where id = v_gap_id for update skip locked;
            -- 鎖住之後重新確認：仍開著、仍逾期、負責人仍不在職
            continue when v_gap.id is null or v_gap.status <> 'open' or v_gap.due_at >= sgn_internal.now()
                or coalesce((select o.active from sgn.principal as x join sgn.person as o on o.id = x.owner_person_id where x.id = v_gap.principal_id), false);
            perform sgn_internal.owner_gap_expire(v_gap);
            v_count := v_count + 1;
        exception when others then
            perform sgn_internal.job_failed('K-OWNER-CONTINUITY', null, jsonb_build_object('gap_id', v_gap_id), sqlerrm);
        end;
    end loop;
    return v_count;
end;
$$;


insert into sgn.error_catalog (code, message, kind) values
    ('OWNER_GAP_EXPIRED_REASON', '被授權者的負責人離職或停用，%s 天的寬限期內沒有改指派新負責人（K-OWNER-CONTINUITY）', 'notice'),
    ('PRINCIPAL_ENDED_REASON', '被授權者已經結束（團隊解散或專案、agent 過了結束日），授權隨之失效（K-PRINCIPAL-END）', 'notice');

-- ── 被授權者結束（K-PRINCIPAL-END）：專案、agent 過了結束日 → 到期失效；團隊解散（ended）→ 撤銷 ──

create function sgn_internal.principal_end_pending(p_case_id uuid default null)
returns table (case_id uuid, event text, since timestamptz)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select g.case_id,
           case when x.status = 'ended' then 'revoked' else 'expired' end,
           case when x.status = 'ended' then g.created_at
                else ((x.ends_on + 1)::timestamp at time zone sgn_internal.setting_text('calendar.timezone')) end
    from sgn.grant_record as g
    join sgn.principal as x on x.id = g.principal_id
    where g.status = 'active'
      and (x.status = 'ended' or x.ends_on < sgn_internal.today())
      and (p_case_id is null or g.case_id = p_case_id)
$$;

create function sgn_internal.principal_end_due()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row record;
    v_case sgn.request_case;
    v_count int := 0;
begin
    for v_row in select * from sgn_internal.principal_end_pending() as p order by p.since, p.case_id loop
        begin
            v_case := sgn_internal.case_lock(v_row.case_id);
            -- 鎖住之後重新確認仍有生效中的授權
            continue when not exists (select 1 from sgn.grant_record as g where g.case_id = v_case.id and g.status = 'active');
            perform sgn_internal.grant_end(v_case, v_row.event, null, sgn_internal.message_text('PRINCIPAL_ENDED_REASON'), 'K-PRINCIPAL-END');
            v_count := v_count + 1;
        exception when others then
            perform sgn_internal.job_failed('K-PRINCIPAL-END', v_row.case_id, jsonb_build_object('case_id', v_row.case_id), sqlerrm);
        end;
    end loop;
    return v_count;
end;
$$;

create function api_job.principal_checks()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object(
        'gaps_opened', sgn_internal.owner_gaps_open(),
        'gaps_restored', sgn_internal.owner_gaps_restore(),
        'gaps_expired', sgn_internal.owner_gaps_expire(),
        'principal_ended', sgn_internal.principal_end_due()
    );
end;
$$;

comment on function api_job.principal_checks() is
    '被授權者的負責人與存續：負責人不在職的開缺口、恢復在職的結案、寬限期過了沒有改指派的撤銷名下授權；被授權者結束的授權失效。'
    '呼叫者：sgn_scheduler（排程）。規則：K-OWNER-CONTINUITY、K-PRINCIPAL-END';

-- ── 改指派（畫面）──

create function sgn_internal.owner_gap_json(p_gap sgn.principal_owner_gap, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'gap_id', p_gap.id,
        'principal', sgn_internal.principal_json(p_gap.principal_id),
        'departed', sgn_internal.person_display(p_gap.departed_person_id),
        'due_text', sgn_internal.local_minute_text(p_gap.due_at),
        'active_cases', (select count(*)::int from sgn_internal.principal_live_cases(p_gap.principal_id) as c where c.state = 'active'),
        'approving_cases', (select count(*)::int from sgn_internal.principal_live_cases(p_gap.principal_id) as c where c.state = 'in_approval'),
        'actions', to_jsonb(array_remove(array[
            case when sgn_internal.denial_reason(p_person_id, 'owner.reassign', p_gap) is null then 'reassign' end,
            case when sgn_internal.denial_reason(p_person_id, 'owner.accept', p_gap) is null then 'accept' end
        ], null)),
        'candidates', case
            when sgn_internal.denial_reason(p_person_id, 'owner.reassign', p_gap) is null then sgn_internal.owner_candidates(p_gap)
            else '[]'::jsonb
        end,
        'handover', (
            select sgn_internal.owner_handover_display(p_gap, h)
            from sgn.principal_owner_handover as h
            where h.gap_id = p_gap.id and h.status = 'proposed'
        )
    )
$$;

-- 看的人可以處理的缺口（可以指定，或等他確認接下）。
create function sgn_internal.owner_gaps_for(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(sgn_internal.owner_gap_json(g, p_person_id) order by g.due_at, g.id), '[]'::jsonb)
    from sgn.principal_owner_gap as g
    where g.status = 'open'
      and (
          sgn_internal.denial_reason(p_person_id, 'owner.reassign', g) is null
          or sgn_internal.denial_reason(p_person_id, 'owner.accept', g) is null
      )
$$;

create function api.principal_owner_gaps(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.owner_gaps_for(sgn_internal.session_person(p_session));
end;
$$;

comment on function api.principal_owner_gaps(text) is
    '看的人可以處理的負責人缺口：原負責人的主管或治理角色可以指定新負責人（附候選人與不能選的原因），被指定的人可以確認接下。'
    '呼叫者：已登入的人（只列他能處理的）。規則：K-OWNER-CONTINUITY';

create function api.principal_owner_propose(p_session text, p_gap_id uuid, p_new_owner uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_gap sgn.principal_owner_gap := sgn_internal.owner_gap_lock(p_gap_id);
    v_problem text;
    v_id uuid := gen_random_uuid();
begin
    perform sgn_internal.authorize(v_person_id, 'owner.reassign', v_gap);
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
        perform sgn_internal.raise_error('OWNER_REASON_REQUIRED');
    end if;
    -- 一律要第二個人：提議的人不能指定自己（主管要自己接手，由治理角色指定他）
    if p_new_owner = v_person_id then
        perform sgn_internal.raise_error('OWNER_CANDIDATE_SELF');
    end if;
    v_problem := sgn_internal.owner_candidate_problem(v_gap, p_new_owner);
    if v_problem is not null then
        perform sgn_internal.raise_error(v_problem);
    end if;
    update sgn.principal_owner_handover set status = 'superseded' where gap_id = v_gap.id and status = 'proposed';
    insert into sgn.principal_owner_handover (id, gap_id, new_owner_person_id, proposed_by, reason, proposed_at, status, event_seq)
    values (
        v_id, v_gap.id, p_new_owner, v_person_id, btrim(p_reason), sgn_internal.now(), 'proposed',
        sgn_internal.audit_append('principal.owner_proposed', null, v_person_id, jsonb_build_object(
            'gap_id', v_gap.id, 'handover_id', v_id, 'principal', v_gap.principal_id, 'new_owner', p_new_owner, 'reason', btrim(p_reason),
            'rules', jsonb_build_array('K-OWNER-CONTINUITY', 'K-OWNER-SOD')
        ))
    );
    perform sgn_internal.notify('principal.owner_handover', array[p_new_owner], null, jsonb_build_object(
        'principal_name', (select x.name from sgn.principal as x where x.id = v_gap.principal_id),
        'proposer_name', sgn_internal.person_name(v_person_id), 'due', sgn_internal.local_minute_text(v_gap.due_at)
    ));
    return sgn_internal.owner_gaps_for(v_person_id);
end;
$$;

comment on function api.principal_owner_propose(text, uuid, uuid, text) is
    '原負責人的主管或治理角色指定新的負責人（只是提議，新負責人用通行金鑰確認接下才生效）；新負責人必須在職、不是原負責人、'
    '不是這個被授權者進行中或生效中的單的簽核人。呼叫者：缺口記下的主管、grant.owner_reassign_roles 的持有人。規則：K-OWNER-CONTINUITY、K-OWNER-SOD';

create function api.principal_owner_challenge(p_session text, p_gap_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_gap sgn.principal_owner_gap := sgn_internal.owner_gap_lock(p_gap_id);
    v_handover sgn.principal_owner_handover;
    v_row sgn.auth_challenge;
begin
    perform sgn_internal.authorize(v_person_id, 'owner.accept', v_gap);
    v_handover := sgn_internal.owner_handover_open(v_gap.id);
    v_row := sgn_internal.challenge_new(
        'principal.owner_accept', jsonb_build_object('gap_id', v_gap.id, 'handover_id', v_handover.id), v_person_id
    );
    return jsonb_build_object(
        'challenge_id', v_row.id,
        'nonce', sgn_internal.b64url_encode(v_row.challenge),
        'expires_at', v_row.expires_at,
        'display', sgn_internal.owner_handover_display(v_gap, v_handover)
    );
end;
$$;

comment on function api.principal_owner_challenge(text, uuid) is
    '被指定的新負責人要確認接下時，取得一次性亂數與要簽的顯示摘要。呼叫者：被指定的新負責人。規則：K-OWNER-CONTINUITY';

-- 換了負責人之後，還在等「負責人確認」的工作交給新負責人（K-PRINCIPAL-OWNER-CONFIRM 的那一關要由現在的負責人確認）；
-- 重新計時（新的一輪），進鏈並通知。新負責人不是這些單的申請人（owner_candidate_problem 已檢查）。
create function sgn_internal.owner_confirm_handover(p_gap sgn.principal_owner_gap, p_handover sgn.principal_owner_handover, p_seq bigint)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_task sgn.case_task;
begin
    for v_case in select c.* from sgn_internal.principal_live_cases(p_gap.principal_id) as c where c.state = 'in_approval' order by c.case_no loop
        v_case := sgn_internal.case_lock(v_case.id);
        for v_task in select * from sgn_internal.owner_confirm_tasks(v_case.id) loop
            update sgn.case_task
            set assignee_person_id = p_handover.new_owner_person_id,
                sla_round = sla_round + 1,
                sla_restart_at = sgn_internal.now(),
                sla_from = null,
                sla_reminded_at = null,
                sla_shift = '0',
                basis = basis || jsonb_build_object('handovers', coalesce(basis -> 'handovers', '[]'::jsonb) || jsonb_build_object(
                    'from', v_task.assignee_person_id, 'to', p_handover.new_owner_person_id, 'at', sgn_internal.now(),
                    'owner_event_seq', p_seq, 'rules', jsonb_build_array('K-OWNER-CONTINUITY')
                ))
            where id = v_task.id;
            perform sgn_internal.audit_append('case.task_reassigned', v_case.id, null, jsonb_build_object(
                'task_id', v_task.id, 'from', v_task.assignee_person_id, 'to', p_handover.new_owner_person_id,
                'gap_id', p_gap.id, 'owner_event_seq', p_seq, 'rules', jsonb_build_array('K-OWNER-CONTINUITY', 'K-PRINCIPAL-OWNER-CONFIRM')
            ));
            perform sgn_internal.notify('case.task_assigned', array[p_handover.new_owner_person_id], v_case.id, jsonb_build_object(
                'case_no', v_case.case_no,
                'stage_name', (select ps.name from sgn.case_stage as s join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq where s.id = v_task.stage_id)
            ));
        end loop;
    end loop;
end;
$$;

-- 換負責人的唯一入口（被授權者的負責人只在這裡改；種子與匯入用 principal_upsert）。
create function sgn_internal.principal_owner_set(p_gap sgn.principal_owner_gap, p_handover sgn.principal_owner_handover, p_proof jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_seq bigint;
begin
    update sgn.principal set owner_person_id = p_handover.new_owner_person_id where id = p_gap.principal_id;
    v_seq := sgn_internal.audit_append('principal.owner_reassigned', null, p_handover.new_owner_person_id, jsonb_build_object(
        'gap_id', p_gap.id, 'handover_id', p_handover.id, 'principal', p_gap.principal_id,
        'from', p_gap.departed_person_id, 'to', p_handover.new_owner_person_id, 'proposed_by', p_handover.proposed_by,
        'reason', p_handover.reason, 'rules', jsonb_build_array('K-OWNER-CONTINUITY', 'K-OWNER-SOD')
    ) || p_proof);
    update sgn.principal_owner_handover
    set status = 'accepted', accepted_at = sgn_internal.now(), challenge_id = (p_proof ->> 'challenge_id')::uuid
    where id = p_handover.id;
    update sgn.principal_owner_gap set status = 'reassigned', closed_at = sgn_internal.now() where id = p_gap.id;
    perform sgn_internal.exception_close(p_gap.exception_id, jsonb_build_object(
        'gap_id', p_gap.id, 'status', 'reassigned', 'event_seq', v_seq, 'rules', jsonb_build_array('K-OWNER-CONTINUITY')
    ));
    perform sgn_internal.owner_confirm_handover(p_gap, p_handover, v_seq);
    perform sgn_internal.notify(
        'principal.owner_reassigned', array[p_handover.proposed_by, p_gap.manager_person_id], null, jsonb_build_object(
            'principal_name', (select x.name from sgn.principal as x where x.id = p_gap.principal_id),
            'owner_name', sgn_internal.person_name(p_handover.new_owner_person_id)
        )
    );
end;
$$;

create function api.principal_owner_accept_passkey(
    p_challenge_id uuid,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume(p_challenge_id, 'principal.owner_accept');
    v_gap sgn.principal_owner_gap := sgn_internal.owner_gap_lock((v_challenge.binding ->> 'gap_id')::uuid);
    v_handover sgn.principal_owner_handover := sgn_internal.owner_handover_open(v_gap.id);
    v_raw jsonb := sgn_internal.passkey_raw(p_credential_id, p_authenticator_data, p_client_data_json, p_signature);
    v_content jsonb;
    v_signer uuid;
    v_problem text;
begin
    -- 提議在拿到挑戰值之後換了：簽的不是現在的提議
    if v_handover.id is null or v_handover.id::text is distinct from v_challenge.binding ->> 'handover_id' then
        perform sgn_internal.raise_error('SIGNED_CONTENT_MISMATCH');
    end if;
    v_content := sgn_internal.owner_handover_display(v_gap, v_handover);
    v_signer := sgn_internal.signature_verify(
        v_challenge, v_gap.id::text, v_content, 'accept', p_credential_id, p_authenticator_data, p_client_data_json, p_signature
    );
    perform sgn_internal.authorize(v_signer, 'owner.accept', v_gap);
    perform sgn_internal.challenge_owner_check(v_challenge, v_signer);
    v_problem := sgn_internal.owner_candidate_problem(v_gap, v_signer);
    if v_problem is not null then
        perform sgn_internal.raise_error(v_problem);
    end if;
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge, display_snapshot)
    values (
        v_challenge.id, 'passkey', v_raw, sgn_internal.jcs_sha256(v_raw), sgn_internal.now(),
        sgn_internal.signing_challenge(v_challenge.purpose, v_gap.id::text, v_content, 'accept', v_challenge.challenge), v_content
    );
    perform sgn_internal.principal_owner_set(v_gap, v_handover, jsonb_build_object(
        'challenge_id', v_challenge.id, 'proof_kind', 'passkey', 'proof_sha256', encode(sgn_internal.jcs_sha256(v_raw), 'hex'),
        'display_sha256', encode(sgn_internal.jcs_sha256(v_content), 'hex')
    ));
    return sgn_internal.owner_gaps_for(v_signer);
end;
$$;

comment on function api.principal_owner_accept_passkey(uuid, text, text, text, text) is
    '被指定的新負責人用通行金鑰確認接下被授權者（簽的是資料庫產生的顯示摘要）；確認時重新檢查新負責人的資格與職責分離，'
    '通過才換負責人、缺口與例外結案。呼叫者：被指定的新負責人（行為人來自驗過的簽章）。規則：K-OWNER-CONTINUITY、K-OWNER-SOD';

-- ── 授權入口（同 480 的簽章）：被授權者不能用時不能再核准、標記已套用、確認生效（PRINCIPAL_UNAVAILABLE）；退回、駁回、撤回、撤銷照常 ──

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
        when a.actor_rule = 'revoker' and not coalesce(
            p_person_id = p_case.applicant_person_id
            or p_person_id = sgn_internal.case_principal_owner(p_case)
            or exists (
                select 1 from sgn.case_task as t
                where t.case_id = p_case.id and t.assignee_person_id = p_person_id and t.status in ('approved', 'completed')
            )
            or exists (
                select 1
                from jsonb_array_elements_text(sgn_internal.setting('grant.revoker_roles', array['process:' || p_case.process_type])) as r (code)
                where sgn_internal.has_role(p_person_id, r.code)
            ),
            false
        ) then 'NOT_REVOKER'
        when a.actor_rule in ('assignee', 'claimant', 'fulfiller') and p_person_id = p_case.applicant_person_id then 'SELF_APPROVAL'
        when a.changes_state and sgn_internal.next_state(p_case.state, a.action) is null then 'STATE_TRANSITION'
        when p_case.state = 'verifying' and a.action in ('confirm_verification', 'dispute_verification')
             and (sgn_internal.case_confirmation_pending(p_case.id)).id is null then 'CONFIRMATION_NOT_OPEN'
        when a.action = 'confirm_verification'
             and (sgn_internal.case_confirmation_pending(p_case.id)).due_at <= sgn_internal.now() then 'CONFIRMATION_OVERDUE'
        when a.actor_rule = 'assignee'
             and (sgn_internal.person_open_task(p_case.id, p_person_id, 'approval')).id is null then 'NOT_APPROVER'
        when a.actor_rule = 'fulfiller'
             and (sgn_internal.person_open_task(p_case.id, p_person_id, 'fulfilment')).id is null then 'NOT_FULFILLER'
        when a.actor_rule = 'claimant'
             and (sgn_internal.person_claimable_task(p_case.id, p_person_id)).id is null then 'NOT_CLAIMABLE'
        -- 原則 ④：被授權者沒有在職的負責人或已結束，不能再往下核准（K-OWNER-CONTINUITY、K-PRINCIPAL-END）
        -- 執行完成與確認生效也擋：不能在沒有負責人的期間讓授權生效
        when a.action in ('approve', 'approve_reduced', 'fulfil', 'confirm_verification')
             and not sgn_internal.case_principal_usable(p_case) then 'PRINCIPAL_UNAVAILABLE'
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

-- 決定者資格（同 150 的簽章）：多了「是這張單的被授權者目前的負責人」——負責人確認關以外的關卡都不合格
-- （每關不同人：負責人確認是路徑上的一關；改指派後的新負責人不能再簽同一被授權者進行中的單；K-OWNER-SOD）。
create or replace function sgn_internal.decider_denial(p_case_id uuid, p_person_id uuid, p_stage_id bigint)
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
        when p_person_id = sgn_internal.case_principal_owner(c)
             and not exists (
                 select 1 from sgn.case_stage as s
                 join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
                 where s.id = p_stage_id and ps.resolver_kind = 'principal_owner'
             ) then 'SOD_PRINCIPAL_OWNER'
    end
    from sgn.request_case as c
    where c.id = p_case_id
$$;

-- 授權生效（同 560 的簽章）：被授權者不能用時不生效。
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
    -- 原則 ④：被授權者沒有在職的負責人或已結束時不生效（授權入口已擋下確認與標記已套用，這裡是最後一道）
    if not sgn_internal.case_principal_usable(p_case) then
        perform sgn_internal.raise_error('PRINCIPAL_UNAVAILABLE', p_case.case_no::text);
    end if;
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

-- 要計時的簽核工作（同 570 的簽章）：被授權者不能用的單暫停計時（不能核准，催辦與升級沒有意義）。
-- 例外的結案用 approval_tasks_waiting（不看能不能用），所以被擋下的單上的時限例外不會被當成「不再等待」結案。
create or replace function sgn_internal.waiting_approval_tasks(p_case_id uuid default null)
returns setof sgn.case_task
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_task sgn.case_task;
    v_case_id uuid;
    v_usable boolean;
begin
    for v_task in select * from sgn_internal.approval_tasks_waiting(p_case_id) as w order by w.case_id, w.id loop
        if v_case_id is distinct from v_task.case_id then
            v_case_id := v_task.case_id;
            v_usable := sgn_internal.case_principal_usable((select c from sgn.request_case as c where c.id = v_case_id));
        end if;
        if v_usable then
            return next v_task;
        end if;
    end loop;
end;
$$;

-- 被擋下的期間（暫停計時）：開始時記一筆，恢復時把這段時間加進還在等的工作的起點與實際催辦時間（期限一起往後移）。
create table sgn.case_sla_hold (
    id bigint generated always as identity primary key,
    case_id uuid not null references sgn.request_case (id),
    held_from timestamptz not null,
    released_at timestamptz,
    event_seq bigint not null
);

create unique index case_sla_hold_open_idx on sgn.case_sla_hold (case_id) where released_at is null;

create function sgn_internal.sla_holds_sync()
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_hold sgn.case_sla_hold;
    v_held int := 0;
    v_resumed int := 0;
    v_paused interval;
begin
    for v_case in
        select c.* from sgn.request_case as c
        where c.state = 'in_approval'
          and exists (select 1 from sgn_internal.approval_tasks_waiting(c.id))
          and not sgn_internal.case_principal_usable(c)
          and not exists (select 1 from sgn.case_sla_hold as h where h.case_id = c.id and h.released_at is null)
        order by c.case_no
    loop
        insert into sgn.case_sla_hold (case_id, held_from, event_seq)
        values (v_case.id, sgn_internal.now(), sgn_internal.audit_append('case.sla_held', v_case.id, null, jsonb_build_object(
            'principal', sgn_internal.case_principal_id(v_case), 'rules', jsonb_build_array('K-OWNER-CONTINUITY', 'K-SLA-REMIND')
        )));
        v_held := v_held + 1;
    end loop;
    for v_hold in
        select h.* from sgn.case_sla_hold as h
        join sgn.request_case as c on c.id = h.case_id
        where h.released_at is null and (c.state <> 'in_approval' or sgn_internal.case_principal_usable(c))
        order by h.id
        for update of h
    loop
        v_paused := sgn_internal.now() - v_hold.held_from;
        update sgn.case_task as t
        set sla_shift = t.sla_shift + v_paused,
            sla_reminded_at = t.sla_reminded_at + v_paused
        from sgn_internal.approval_tasks_waiting(v_hold.case_id) as w
        where t.id = w.id;
        update sgn.case_sla_hold set released_at = sgn_internal.now() where id = v_hold.id;
        perform sgn_internal.audit_append('case.sla_resumed', v_hold.case_id, null, jsonb_build_object(
            'hold', v_hold.id, 'held_from', v_hold.held_from, 'paused_seconds', floor(extract(epoch from v_paused))::bigint,
            'rules', jsonb_build_array('K-OWNER-CONTINUITY', 'K-SLA-REMIND')
        ));
        v_resumed := v_resumed + 1;
    end loop;
    return jsonb_build_object('held', v_held, 'resumed', v_resumed);
end;
$$;

-- 排程的入口（同 570 的簽章）：先記下被擋下與恢復的單（恢復的單期限往後移），再做到期的步驟、結案不再等待的例外。
create or replace function sgn_internal.approval_sla_due()
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.sla_holds_sync() || sgn_internal.approval_sla_run() || jsonb_build_object('closed', sgn_internal.task_sla_settle());
end;
$$;

-- 單的頁面上「為什麼不能往下簽」：簽核中、被授權者不能用時的原因與（有缺口時）改指派的期限。
create function sgn_internal.case_hold(p_case sgn.request_case)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case when p_case.state = 'in_approval' and not sgn_internal.case_principal_usable(p_case) then jsonb_build_object(
        'code', 'PRINCIPAL_UNAVAILABLE',
        'message', sgn_internal.message_text('PRINCIPAL_UNAVAILABLE'),
        'due_text', (
            select sgn_internal.local_minute_text(g.due_at) from sgn.principal_owner_gap as g
            where g.principal_id = sgn_internal.case_principal_id(p_case) and g.status = 'open'
        )
    ) end
$$;

-- 申請單摘要（同 570 的簽章）：多了 hold（簽核中、被授權者不能用時為什麼不能往下簽）。
create or replace function sgn_internal.case_summary(p_case_id uuid, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'case_id', c.id,
        'case_no', c.case_no,
        'process_type', c.process_type,
        'state', c.state,
        'tier', v.tier,
        'version', v.version,
        'content', v.content,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'version_sha256', encode(v.version_sha256, 'hex'),
        'terms', sgn_internal.case_terms_view(v.terms),
        'updated_at', v.created_at,
        'applicant_name', sgn_internal.person_name(a.id),
        'current_stage', sgn_internal.case_current_stage(c.id),
        'waiting_on', sgn_internal.case_waiting_on(c.id),
        'notices', v.notices,
        'errors', case
            when c.state in ('draft', 'returned') then v.errors || sgn_internal.terms_errors(c.process_type, v.terms, v.tier)
            else '[]'::jsonb
        end,
        'actions', sgn_internal.case_actions(c, p_person_id),
        'exceptions', sgn_internal.case_exceptions(c.id),
        'overdue', sgn_internal.case_overdue(c.id),
        'confirm_due', (
            select jsonb_build_object(
                'due_text', sgn_internal.local_minute_text(k.due_at),
                'workdays_left', sgn_internal.confirmation_workdays_left(k),
                'reminding', sgn_internal.confirmation_reminding(k, c.process_type)
            )
            from sgn.case_confirmation as k
            where k.case_id = c.id and k.status = 'pending'
        ),
        'sla', sgn_internal.case_sla(c.id),
        'hold', sgn_internal.case_hold(c)
    )
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    join sgn.person as a on a.id = c.applicant_person_id
    where c.id = p_case_id
$$;

-- 首頁區塊（同 565 的簽章）：多了 owner_handover（有負責人缺口要我指定新負責人，或等我確認接下），排在待簽之後。
create or replace function sgn_internal.person_capabilities(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select to_jsonb(array_remove(array[
        case when exists (select 1 from sgn_internal.person_waiting_cases(p_person_id)) then 'inbox' end,
        case when exists (
            select 1 from sgn.principal_owner_gap as g
            where g.status = 'open'
              and (
                  sgn_internal.denial_reason(p_person_id, 'owner.reassign', g) is null
                  or sgn_internal.denial_reason(p_person_id, 'owner.accept', g) is null
              )
        ) then 'owner_handover' end,
        case when sgn_internal.denial_reason(p_person_id, 'audit.read', null::sgn.request_case) is null then 'audit' end,
        case when sgn_internal.denial_reason(p_person_id, 'audit.read', null::sgn.request_case) is null
               or sgn_internal.denial_reason(p_person_id, 'report.mis_read', null::sgn.request_case) is null then 'report' end,
        'case.submit',
        case when exists (
            select 1
            from sgn.role as r
            where sgn_internal.denial_reason(p_person_id, 'role_change.propose', r) is null
        ) or exists (
            select 1
            from sgn.role_change_request as q
            join sgn.role as r on r.code = q.role_code
            where sgn_internal.denial_reason(p_person_id, 'role_change.approve', r, q) is null
               or sgn_internal.denial_reason(p_person_id, 'role_change.block', r, q) is null
        ) then 'role_change' end,
        case when exists (
            select 1
            from sgn.passkey_enrollment as e
            where e.status = 'pending' and e.person_id <> p_person_id and sgn_internal.denial_reason(p_person_id, 'passkey.endorse', e) is null
        ) then 'passkey.endorse' end
    ], null))
$$;

-- 逾期還沒被處理的工作（同 575 的簽章）：多了 owner_gap（寬限期已過還沒撤銷）、principal_end（被授權者已結束、授權還沒失效）。
-- 改成 PL/pgSQL：每張單的摘要都會呼叫它，SQL function 沒辦法內聯時每次呼叫都重新規劃整個 union（每次約 30 毫秒）；
-- PL/pgSQL 的每一段各自快取執行計畫。
create or replace function sgn_internal.overdue_work(p_case_id uuid default null)
returns table (kind text, case_id uuid, since timestamptz)
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_task sgn.case_task;
begin
    return query
    select 'grant_expiry'::text, g.case_id, ((g.valid_to + 1)::timestamp at time zone sgn_internal.setting_text('calendar.timezone'))
    from sgn.grant_record as g
    where g.status = 'active' and g.valid_to < sgn_internal.today() and (p_case_id is null or g.case_id = p_case_id);
    return query
    select 'confirmation_expiry'::text, k.case_id, k.due_at
    from sgn.case_confirmation as k
    where k.status = 'pending' and k.due_at < sgn_internal.now() and (p_case_id is null or k.case_id = p_case_id);
    return query
    select 'delivery'::text, o.case_id, o.created_at + make_interval(secs => sgn_internal.delivery_setting_int('delivery.stuck_alert_seconds', o.channel))
    from sgn.delivery_op as o
    where o.status in ('queued', 'sending')
      and (p_case_id is null or o.case_id = p_case_id)
      and o.created_at < sgn_internal.now() - make_interval(secs => sgn_internal.delivery_setting_int('delivery.stuck_alert_seconds', o.channel));
    -- 逐件工作算（和單一起 join 時，執行計畫會替每張單把所有等待中的工作都算一次）
    for v_task in select * from sgn_internal.waiting_approval_tasks(p_case_id) loop
        return query
        select 'approval_sla'::text, v_task.case_id, n.due_at
        from sgn_internal.task_sla_next(
            v_task, sgn_internal.task_sla_settings((select c from sgn.request_case as c where c.id = v_task.case_id))
        ) as n
        where n.due_at < sgn_internal.now();
    end loop;
    return query
    select 'expiry_remind'::text, r.case_id, r.due_at
    from sgn_internal.grant_expiry_remind_pending(p_case_id) as r;
    return query
    select 'owner_gap'::text, g.case_id, x.due_at
    from sgn.principal_owner_gap as x
    join sgn.grant_record as g on g.principal_id = x.principal_id and g.status = 'active'
    where x.status = 'open' and x.due_at < sgn_internal.now() and (p_case_id is null or g.case_id = p_case_id);
    return query
    select 'principal_end'::text, e.case_id, e.since
    from sgn_internal.principal_end_pending(p_case_id) as e;
end;
$$;

-- 背景程式的存活（同 525 的簽章）：先讀心跳再做檢查。這一批的逾期工作多了幾種，檢查變久；原本先檢查再讀心跳，
-- 檢查期間每 2 秒回報一次的程式（錨定）會在畫面上變成「沒停擺」，和檢查剛開的例外對不上。
create or replace function api.program_health(p_session text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_check jsonb;
    v_programs jsonb;
begin
    perform sgn_internal.authorize(sgn_internal.session_person(p_session), 'audit.read');
    -- 先讀各程式的心跳（打開頁面那一刻的狀態），再做檢查：檢查要算全公司的逾期工作，期間別的程式回報的心跳
    -- 不應該讓這一頁看到的狀態和檢查開的例外對不上
    v_programs := (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', p.code, 'name', p.name, 'last_seen', p.last_seen,
                'max_seconds', sgn_internal.setting_int_in('program.heartbeat_max_seconds', 'program:' || p.code),
                'stalled', sgn_internal.program_seen_baseline(p)
                    < sgn_internal.now() - make_interval(secs => sgn_internal.setting_int_in('program.heartbeat_max_seconds', 'program:' || p.code))
            ) order by p.code), '[]'::jsonb)
            from sgn.program as p
    );
    v_check := sgn_internal.program_stall_check(true);
    return jsonb_build_object(
        'programs', v_programs,
        'overdue', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'kind', w.kind, 'count', w.n, 'oldest_since', w.since,
                'oldest_case_no', (select c.case_no from sgn.request_case as c where c.id = w.case_id),
                'max_seconds', sgn_internal.setting_int_in('program.overdue_max_seconds', 'work:' || w.kind),
                'stalled', w.since < sgn_internal.now() - make_interval(secs => sgn_internal.setting_int_in('program.overdue_max_seconds', 'work:' || w.kind))
            ) order by w.kind), '[]'::jsonb)
            from (
                select distinct on (o.kind) o.kind, o.case_id, o.since, count(*) over (partition by o.kind) as n
                from sgn_internal.overdue_work() as o
                order by o.kind, o.since, o.case_id
            ) as w
        ),
        'opened', (v_check ->> 'opened')::int,
        'closed', (v_check ->> 'closed')::int
    );
end;
$$;

insert into sgn.notification_template (event_code, subject, body) values
    ('principal.owner_departed', '被授權者的負責人離職：{{principal_name}}', '{{principal_name}} 的負責人 {{person_name}} 已離職或停用，名下有 {{cases}} 筆生效中的授權。請在 {{due}} 前指定新的負責人並由他確認接下，逾期名下的授權會自動撤銷。'),
    ('principal.owner_handover', '請確認接下被授權者：{{principal_name}}', '{{proposer_name}} 指定你接下 {{principal_name}} 的負責人。請在 {{due}} 前登入用通行金鑰確認；逾期名下的授權會自動撤銷。'),
    ('principal.owner_reassigned', '被授權者已改指派負責人：{{principal_name}}', '{{owner_name}} 已確認接下 {{principal_name}} 的負責人。');

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-OWNER-CONTINUITY', '被授權者的負責人離職或停用：開例外並通知他的主管，寬限期（grant.owner_grace_days）內由主管或治理角色指定新負責人、'
        || '新負責人用通行金鑰確認接下；逾期名下生效中的授權自動撤銷並交付撤回；簽核中的單不能再核准；原負責人恢復在職時結案', 'partial',
        '調職（調離單位）沒有偵測：人員與組織 port 沒有單位；骨幹的「agent 在負責人離任當天暫停」「預告離職」沒有做（沒有暫停的機制）'),
    ('K-OWNER-SOD', '新的負責人必須在職、不是原負責人，而且不能是這個被授權者進行中或生效中的單的簽核人（每關不同人）；提議與確認時都檢查', 'full', null),
    ('K-PRINCIPAL-END', '被授權者結束時相關授權失效：專案、agent 過了結束日 → 到期失效；團隊解散（狀態 ended）→ 撤銷；由排程執行並交付撤回', 'partial',
        '團隊解散沒有來源：團隊與目錄群組的同步（D97 (3)）還沒做，目前沒有任何入口把團隊標為 ended')
) as r (code, description, coverage, note);
