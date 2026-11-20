-- 人員同步改寫（K-HR-SYNC、K-ROLE-SOURCE；紅隊 redteam/findings.md 高-1、中-1）。
--
-- 根因（中-1）：directory_apply 宣稱是完整快照，卻只處理傳入的人；主管只在同一批裡找，找不到就當成「沒有主管」；
-- 在職狀態、email 由同步直接覆寫、不留紀錄。一份只列幾個人的「快照」就能拆掉主管線、讓簽核人出缺。
-- 根因（高-1）：角色原封不動寫進 role_assignment（見 210_role_registry.sql）。
--
-- 這一版：
--   1. 同步必須宣告種類：full（完整快照，帶總筆數；沒列到的人視為離職）或 incremental（只動有列到的人）。
--      不宣告就沒有可呼叫的 function（舊的兩個參數的版本刪除）。第一次（基準）必須是完整快照。
--   2. 完整快照與現況的差異超過參數 directory.full_snapshot_max_change_percent 就整批拒絕、什麼都不改，並開例外。
--   3. 主管依身分對應找（同一批 → 已同步過的人），只有明寫 null 才是移除主管；對不到的外部帳號整批拒絕。
--   4. 改姓名、email 逐筆進鏈；停用一次超過參數 directory.bulk_deactivation_max 人、或停用持有控制類角色的人，
--      進冷卻期（directory.sync_cooling_workdays 個營業日）並開例外，期間內仍在職；到期由下一次同步或排程套用。
--   5. 角色：業務類由同步帶入，基準之後的異動有冷卻期並開例外；控制、平台、治理類一律不套用，只記下目錄的說法，
--      新出現的說法開例外（要走平台內的角色指派變更，220_role_change.sql）；沒有登記的群組名稱忽略。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('directory.sync_cooling_workdays', 'integer', '1', '{}',
        '人員同步帶來的業務角色異動與延後的停用，幾個營業日後才生效；期間內維持原狀'),
    ('directory.full_snapshot_max_change_percent', 'integer', '20', '{}',
        '完整快照與現況不同的人數佔現有人數的百分比超過這個值，就整批拒絕並開例外'),
    ('directory.bulk_deactivation_max', 'integer', '1', '{}',
        '一次同步停用超過這個人數，全部延後到冷卻期之後並開例外');

insert into sgn.error_catalog (code, message, http_status) values
    ('SYNC_KIND_REQUIRED', '人員同步必須宣告是完整快照（full）還是增量（incremental）', 422),
    ('SYNC_TOTAL_MISMATCH', '人員同步宣告的總筆數與實際筆數不符', 422),
    ('SYNC_BASELINE_FULL', '第一次人員同步必須是完整快照', 422),
    ('DIRECTORY_ENTRY_INVALID', '人員同步的資料格式不正確', 422),
    ('DIRECTORY_MANAGER_UNKNOWN', '人員同步的主管對不到任何已知的人', 422);

-- 延後的停用：到期前這個人仍在職；目錄又說他在職就取消。
create table sgn.person_deactivation (
    id bigint generated always as identity primary key,
    person_id uuid not null references sgn.person (id),
    requested_at timestamptz not null,
    effective_at timestamptz not null,
    applied_at timestamptz,
    cancelled_at timestamptz,
    exception_id bigint not null references sgn.exception_record (id),
    event_seq bigint not null
);

create unique index person_deactivation_open_idx on sgn.person_deactivation (person_id)
    where applied_at is null and cancelled_at is null;

-- 目錄對「不能由同步帶入的角色」的說法（例如某人在目錄的 auditor 群組裡）。只是紀錄，不是指派。
create table sgn.directory_role_claim (
    id bigint generated always as identity primary key,
    source text not null references sgn.directory_source (code),
    person_id uuid not null references sgn.person (id),
    role_code text not null references sgn.role (code),
    seen_from timestamptz not null,
    seen_to timestamptz
);

create unique index directory_role_claim_open_idx on sgn.directory_role_claim (source, person_id, role_code)
    where seen_to is null;

drop function api_sync.directory_apply(text, jsonb);
drop function sgn_internal.directory_upsert_person(text, jsonb, timestamptz);
drop function sgn_internal.directory_set_source_roles(text, uuid, text[], timestamptz);

-- ── 輸入檢查：固定的最小欄位（K-HR-SYNC），不多不少 ──

create function sgn_internal.directory_entry_problem(p_entry jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when jsonb_typeof(p_entry) is distinct from 'object' then 'entry'
        when (select array_agg(k collate "C" order by k collate "C") from jsonb_object_keys(p_entry) as k)
             <> array['active', 'display_name', 'email', 'external_id', 'manager_external_id', 'roles'] then 'fields'
        when jsonb_typeof(p_entry -> 'external_id') <> 'string' or btrim(p_entry ->> 'external_id') = '' then 'external_id'
        when jsonb_typeof(p_entry -> 'display_name') <> 'string' then 'display_name'
        when jsonb_typeof(p_entry -> 'email') <> 'string' then 'email'
        when jsonb_typeof(p_entry -> 'active') <> 'boolean' then 'active'
        when jsonb_typeof(p_entry -> 'manager_external_id') not in ('string', 'null') then 'manager_external_id'
        when p_entry ->> 'manager_external_id' = p_entry ->> 'external_id' then 'manager_external_id'
        when jsonb_typeof(p_entry -> 'roles') <> 'array' then 'roles'
        when exists (select 1 from jsonb_array_elements(p_entry -> 'roles') as r where jsonb_typeof(r) <> 'string') then 'roles'
    end
$$;

create function sgn_internal.directory_entries_check(p_entries jsonb, p_total int)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_problem text;
begin
    if jsonb_typeof(p_entries) is distinct from 'array' then
        perform sgn_internal.raise_error('DIRECTORY_ENTRY_INVALID', 'entries');
    end if;
    if p_total is null or p_total <> jsonb_array_length(p_entries) then
        perform sgn_internal.raise_error('SYNC_TOTAL_MISMATCH', format('declared %s, got %s', p_total, jsonb_array_length(p_entries)));
    end if;
    select format('[%s] %s', e.n - 1, sgn_internal.directory_entry_problem(e.value)) into v_problem
    from jsonb_array_elements(p_entries) with ordinality as e (value, n)
    where sgn_internal.directory_entry_problem(e.value) is not null
    order by e.n
    limit 1;
    if v_problem is null then
        select format('duplicate external_id %s', e.value ->> 'external_id') into v_problem
        from jsonb_array_elements(p_entries) as e (value)
        group by e.value ->> 'external_id'
        having count(*) > 1
        limit 1;
    end if;
    if v_problem is not null then
        perform sgn_internal.raise_error('DIRECTORY_ENTRY_INVALID', v_problem);
    end if;
end;
$$;

-- 完整快照與現況的差異：新增、沒列到（目前在職）、欄位或主管不同的人數。
create function sgn_internal.directory_snapshot_changes(p_source text, p_entries jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    with incoming as (
        select e ->> 'external_id' as external_id, e
        from jsonb_array_elements(p_entries) as e
    ),
    current_people as (
        select
            i.external_id,
            p.display_name,
            p.email,
            p.active,
            (
                select mi.external_id
                from sgn.reporting_line as r
                join sgn.person_identity as mi on mi.person_id = r.manager_person_id and mi.source = p_source
                where r.person_id = p.id and r.valid_to is null
            ) as manager_external_id
        from sgn.person_identity as i
        join sgn.person as p on p.id = i.person_id
        where i.source = p_source
    ),
    compared as (
        select case
            when c.external_id is null then 'added'
            when n.external_id is null then case when c.active then 'missing' end
            when (n.e ->> 'display_name', n.e ->> 'email', (n.e ->> 'active')::boolean, n.e ->> 'manager_external_id')
                 is distinct from (c.display_name, c.email, c.active, c.manager_external_id) then 'changed'
        end as kind
        from incoming as n
        full join current_people as c on c.external_id = n.external_id
    )
    select jsonb_build_object(
        'current', (select count(*) from current_people),
        'added', count(*) filter (where kind = 'added'),
        'missing', count(*) filter (where kind = 'missing'),
        'changed', count(*) filter (where kind = 'changed'),
        'changes', count(kind)
    )
    from compared
$$;

-- 整批拒絕：什麼都不改，只開例外並寫一筆事件，讓人來看（K-HR-SYNC 的門檻）。
create function sgn_internal.directory_reject(p_source text, p_entries jsonb, p_diff jsonb, p_max_percent int)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_detail jsonb := jsonb_build_object(
        'kind', 'full_snapshot_over_threshold',
        'source', p_source,
        'entries', jsonb_array_length(p_entries),
        'diff', p_diff,
        'max_change_percent', p_max_percent,
        'input_sha256', encode(sgn_internal.jcs_sha256(p_entries), 'hex')
    );
    v_exception bigint := sgn_internal.exception_open('K-HR-SYNC', null, v_detail);
begin
    perform sgn_internal.audit_append('directory.sync_rejected', null, null, v_detail || jsonb_build_object('exception_id', v_exception));
    return jsonb_build_object(
        'kind', 'full',
        'entries', jsonb_array_length(p_entries),
        'baseline', false,
        'rejected', true,
        'diff', p_diff,
        'exceptions', jsonb_build_array(v_exception)
    );
end;
$$;

-- ── 寫入 ──

-- 建立人員，或更新姓名與 email（逐筆進鏈）。在職狀態不在這裡改（directory_status_apply）。新的人照目錄的在職狀態建立。
create function sgn_internal.directory_write_person(p_source text, p_entry jsonb, p_now timestamptz)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person sgn.person;
    v_changes jsonb;
begin
    select p.* into v_person
    from sgn.person_identity as i
    join sgn.person as p on p.id = i.person_id
    where i.source = p_source and i.external_id = p_entry ->> 'external_id';
    if v_person.id is null then
        insert into sgn.person (display_name, email, active, synced_at)
        values (p_entry ->> 'display_name', p_entry ->> 'email', (p_entry ->> 'active')::boolean, p_now)
        returning * into v_person;
        insert into sgn.person_identity (source, external_id, person_id)
        values (p_source, p_entry ->> 'external_id', v_person.id);
        return v_person.id;
    end if;
    v_changes := jsonb_strip_nulls(jsonb_build_object(
        'display_name', case when v_person.display_name is distinct from p_entry ->> 'display_name'
            then jsonb_build_object('from', v_person.display_name, 'to', p_entry ->> 'display_name') end,
        'email', case when v_person.email is distinct from p_entry ->> 'email'
            then jsonb_build_object('from', v_person.email, 'to', p_entry ->> 'email') end
    ));
    update sgn.person
    set display_name = p_entry ->> 'display_name',
        email = p_entry ->> 'email',
        synced_at = p_now
    where id = v_person.id;
    if v_changes <> '{}'::jsonb then
        perform sgn_internal.audit_append('directory.person_changed', null, null, jsonb_build_object(
            'source', p_source,
            'person', v_person.id,
            'changes', v_changes
        ));
    end if;
    return v_person.id;
end;
$$;

-- 主管的內部 id：同一批 → 已同步過的人。明寫 null 才是「沒有主管」；對不到就整批拒絕。
create function sgn_internal.directory_manager_id(p_source text, p_manager_external_id text, p_ids jsonb)
returns uuid
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_id uuid;
begin
    if p_manager_external_id is null then
        return null;
    end if;
    v_id := (p_ids ->> p_manager_external_id)::uuid;
    if v_id is null then
        select i.person_id into v_id
        from sgn.person_identity as i
        where i.source = p_source and i.external_id = p_manager_external_id;
    end if;
    if v_id is null then
        perform sgn_internal.raise_error('DIRECTORY_MANAGER_UNKNOWN', p_manager_external_id);
    end if;
    return v_id;
end;
$$;

-- 一個人的角色（這個來源、不限範圍）。回傳 {changes: 業務角色異動, not_applied: 目錄新出現的不可同步角色（基準之後才算）, ignored: 沒登記的代碼}。
-- 目錄新說某人有控制類角色，不論平台內是否已經指派都要有人看：可能是攻擊，也可能是該走平台內變更的人事異動。
create function sgn_internal.directory_sync_roles(
    p_source text,
    p_person_id uuid,
    p_codes text[],
    p_is_baseline boolean,
    p_now timestamptz
)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cooling int := sgn_internal.setting_int('directory.sync_cooling_workdays');
    v_until timestamptz := case when p_is_baseline then p_now else sgn_internal.add_workdays(p_now, v_cooling) end;
    v_business text[] := array(
        select r.code from sgn.role as r
        where r.code = any (p_codes) and r.category = 'business' and r.assignment_source_policy = 'sync_proposed'
    );
    v_manual text[] := array(select r.code from sgn.role as r where r.code = any (p_codes) and r.assignment_source_policy = 'manual');
    v_changes jsonb := '[]'::jsonb;
    v_not_applied jsonb;
    v_code text;
begin
    for v_code in
        select a.role_code
        from sgn.role_assignment as a
        join sgn.role as r on r.code = a.role_code and r.category = 'business'
        where a.person_id = p_person_id and a.source = p_source and a.scope_ref is null and a.valid_to is null
          and a.role_code <> all (v_business)
    loop
        v_changes := v_changes || sgn_internal.directory_role_change(p_source, p_person_id, v_code, 'remove', v_until, p_is_baseline, p_now);
    end loop;
    foreach v_code in array v_business loop
        v_changes := v_changes || sgn_internal.directory_role_change(p_source, p_person_id, v_code, 'add', v_until, p_is_baseline, p_now);
    end loop;
    update sgn.directory_role_claim
    set seen_to = p_now
    where source = p_source and person_id = p_person_id and seen_to is null and role_code <> all (v_manual);
    with added as (
        insert into sgn.directory_role_claim (source, person_id, role_code, seen_from)
        select p_source, p_person_id, c, p_now
        from unnest(v_manual) as c
        where not exists (
            select 1 from sgn.directory_role_claim as x
            where x.source = p_source and x.person_id = p_person_id and x.role_code = c and x.seen_to is null
        )
        returning role_code
    )
    select coalesce(jsonb_agg(jsonb_build_object('person', p_person_id, 'role', a.role_code)), '[]'::jsonb) into v_not_applied
    from added as a
    where not p_is_baseline;
    return jsonb_build_object(
        'changes', v_changes,
        'not_applied', v_not_applied,
        'ignored', to_jsonb(array(select c from unnest(p_codes) as c where not exists (select 1 from sgn.role as r where r.code = c)))
    );
end;
$$;

-- 一筆業務角色的增減。基準之後：新增要過冷卻期才算（effective_from），移除排定在冷卻期之後（valid_to 在未來）；
-- 冷卻期內又加回來，就取消排定的移除。每筆異動進鏈。回傳異動的陣列（沒有異動時是空陣列）。
create function sgn_internal.directory_role_change(
    p_source text,
    p_person_id uuid,
    p_role text,
    p_change text,
    p_until timestamptz,
    p_is_baseline boolean,
    p_now timestamptz
)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_open sgn.role_assignment;
    v_kind text := p_change;
    v_seq bigint;
begin
    select * into v_open
    from sgn.role_assignment as a
    where a.person_id = p_person_id and a.role_code = p_role and a.source = p_source and a.scope_ref is null
      and (a.valid_to is null or a.valid_to > p_now)
    order by a.id desc
    limit 1;
    if p_change = 'add' and v_open.id is not null and v_open.valid_to is null then
        return '[]'::jsonb;
    end if;
    if p_change = 'add' and v_open.id is not null then
        v_kind := 'removal_cancelled';
    end if;
    if not p_is_baseline then
        v_seq := sgn_internal.audit_append('directory.role_changed', null, null, jsonb_build_object(
            'source', p_source, 'person', p_person_id, 'role', p_role, 'change', v_kind, 'effective_at', p_until,
            'cooling_workdays', sgn_internal.setting_int('directory.sync_cooling_workdays'),
            'rules', jsonb_build_array('K-ROLE-SOURCE')
        ));
    end if;
    if v_kind = 'remove' then
        -- 還在冷卻期內的新增被移除：它從來沒有生效過，直接結束
        update sgn.role_assignment
        set valid_to = case when p_is_baseline or coalesce(effective_from, valid_from) > p_now then p_now else p_until end,
            change_event_seq = v_seq
        where id = v_open.id;
    elsif v_kind = 'removal_cancelled' then
        update sgn.role_assignment set valid_to = null, change_event_seq = v_seq where id = v_open.id;
    else
        insert into sgn.role_assignment (person_id, role_code, valid_from, effective_from, scope_ref, source, change_event_seq)
        values (p_person_id, p_role, p_now, case when p_is_baseline then null else p_until end, null, p_source, v_seq);
    end if;
    return jsonb_build_array(jsonb_build_object('person', p_person_id, 'role', p_role, 'change', v_kind, 'effective_at', p_until));
end;
$$;

-- 人員、主管、角色。回傳 {ids: 外部帳號 → 內部 id, manager_changes, role_changes, not_applied, ignored}。
create function sgn_internal.directory_write_entries(p_source text, p_entries jsonb, p_is_baseline boolean, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_ids jsonb := '{}'::jsonb;
    v_entry jsonb;
    v_person_id uuid;
    v_manager_changes int := 0;
    v_roles jsonb;
    v_role_changes jsonb := '[]'::jsonb;
    v_not_applied jsonb := '[]'::jsonb;
    v_ignored jsonb := '[]'::jsonb;
begin
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_ids := v_ids || jsonb_build_object(
            v_entry ->> 'external_id',
            sgn_internal.directory_write_person(p_source, v_entry, p_now)
        );
    end loop;
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_person_id := (v_ids ->> (v_entry ->> 'external_id'))::uuid;
        if sgn_internal.directory_set_manager(
            p_source,
            v_person_id,
            sgn_internal.directory_manager_id(p_source, v_entry ->> 'manager_external_id', v_ids),
            p_is_baseline,
            p_now
        ) then
            v_manager_changes := v_manager_changes + 1;
        end if;
        v_roles := sgn_internal.directory_sync_roles(
            p_source,
            v_person_id,
            array(select jsonb_array_elements_text(v_entry -> 'roles')),
            p_is_baseline,
            p_now
        );
        v_role_changes := v_role_changes || (v_roles -> 'changes');
        v_not_applied := v_not_applied || (v_roles -> 'not_applied');
        v_ignored := v_ignored || (v_roles -> 'ignored');
    end loop;
    return jsonb_build_object(
        'ids', v_ids,
        'manager_changes', v_manager_changes,
        'role_changes', v_role_changes,
        'not_applied', v_not_applied,
        'ignored', (select coalesce(jsonb_agg(distinct c), '[]'::jsonb) from jsonb_array_elements_text(v_ignored) as c)
    );
end;
$$;

-- 立即停用一個人（逐筆進鏈）。
create function sgn_internal.directory_deactivate(p_person_id uuid, p_detail jsonb)
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
    end if;
end;
$$;

-- 在職狀態。目錄說在職：取消排定的停用、恢復已停用的人。目錄說離職（完整快照另含沒列到的人）：
-- 人數超過 directory.bulk_deactivation_max、或持有控制類角色的人，延後到冷卻期之後並開例外；其餘立即停用。
create function sgn_internal.directory_status_apply(p_source text, p_kind text, p_entries jsonb, p_ids jsonb, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cooling int := sgn_internal.setting_int('directory.sync_cooling_workdays');
    v_bulk_max int := sgn_internal.setting_int('directory.bulk_deactivation_max');
    v_listed_active uuid[] := array(
        select (p_ids ->> (e ->> 'external_id'))::uuid from jsonb_array_elements(p_entries) as e where (e ->> 'active')::boolean
    );
    v_targets uuid[];
    v_deferred uuid[];
    v_exception bigint;
    v_reactivated int;
    v_person_id uuid;
begin
    update sgn.person_deactivation set cancelled_at = p_now
    where person_id = any (v_listed_active) and applied_at is null and cancelled_at is null;
    with reactivated as (
        update sgn.person set active = true where id = any (v_listed_active) and not active returning id
    )
    select count(sgn_internal.audit_append('directory.person_reactivated', null, null, jsonb_build_object('source', p_source, 'person', r.id)))
    into v_reactivated
    from reactivated as r;
    v_targets := array(
        select p.id
        from sgn.person as p
        join sgn.person_identity as i on i.person_id = p.id and i.source = p_source
        where p.active
          and not exists (
              select 1 from sgn.person_deactivation as d where d.person_id = p.id and d.applied_at is null and d.cancelled_at is null
          )
          and (
              exists (
                  select 1 from jsonb_array_elements(p_entries) as e
                  where e ->> 'external_id' = i.external_id and not (e ->> 'active')::boolean
              )
              or (p_kind = 'full' and not p_ids ? i.external_id)
          )
        order by p.id
    );
    v_deferred := array(
        select t from unnest(v_targets) as t
        where cardinality(v_targets) > v_bulk_max or sgn_internal.holds_control_role(t)
    );
    if cardinality(v_deferred) > 0 then
        v_exception := sgn_internal.exception_open('K-HR-SYNC', null, jsonb_build_object(
            'kind', 'deactivation_deferred', 'source', p_source, 'persons', to_jsonb(v_deferred),
            'bulk', cardinality(v_targets) > v_bulk_max, 'bulk_deactivation_max', v_bulk_max,
            'cooling_workdays', v_cooling, 'effective_at', sgn_internal.add_workdays(p_now, v_cooling)
        ));
        insert into sgn.person_deactivation (person_id, requested_at, effective_at, exception_id, event_seq)
        select t, p_now, sgn_internal.add_workdays(p_now, v_cooling), v_exception,
            sgn_internal.audit_append('directory.deactivation_deferred', null, null, jsonb_build_object(
                'source', p_source, 'person', t, 'exception_id', v_exception,
                'effective_at', sgn_internal.add_workdays(p_now, v_cooling)
            ))
        from unnest(v_deferred) as t;
    end if;
    foreach v_person_id in array array(select t from unnest(v_targets) as t where t <> all (v_deferred)) loop
        perform sgn_internal.directory_deactivate(v_person_id, jsonb_build_object('source', p_source));
    end loop;
    return jsonb_build_object(
        'deactivated', cardinality(v_targets) - cardinality(v_deferred),
        'deactivations_deferred', cardinality(v_deferred),
        'reactivated', v_reactivated,
        'exception', v_exception
    );
end;
$$;

-- 套用到期的延後停用。由每一次同步與排程（api_job.directory_settle）呼叫。
create function sgn_internal.directory_apply_due(p_now timestamptz)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row sgn.person_deactivation;
    v_count int := 0;
begin
    for v_row in
        select * from sgn.person_deactivation
        where applied_at is null and cancelled_at is null and effective_at <= p_now
        order by id
        for update
    loop
        perform sgn_internal.directory_deactivate(
            v_row.person_id,
            jsonb_build_object('deferred_id', v_row.id, 'exception_id', v_row.exception_id)
        );
        update sgn.person_deactivation set applied_at = p_now where id = v_row.id;
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- 角色異動的例外：業務角色有冷卻期；不可同步的角色出現在目錄裡。回傳開出的例外 id。
create function sgn_internal.directory_role_exceptions(p_source text, p_written jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_ids jsonb := '[]'::jsonb;
begin
    if jsonb_array_length(p_written -> 'role_changes') > 0 then
        v_ids := v_ids || to_jsonb(sgn_internal.exception_open('K-ROLE-SOURCE', null, jsonb_build_object(
            'kind', 'business_role_from_sync', 'source', p_source, 'changes', p_written -> 'role_changes',
            'cooling_workdays', sgn_internal.setting_int('directory.sync_cooling_workdays')
        )));
    end if;
    if jsonb_array_length(p_written -> 'not_applied') > 0 then
        v_ids := v_ids || to_jsonb(sgn_internal.exception_open('K-ROLE-SOURCE', null, jsonb_build_object(
            'kind', 'role_not_syncable', 'source', p_source, 'claims', p_written -> 'not_applied'
        )));
    end if;
    return v_ids;
end;
$$;

create function api_sync.directory_apply(p_source text, p_kind text, p_total int, p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_max_percent int := sgn_internal.setting_int('directory.full_snapshot_max_change_percent');
    v_source sgn.directory_source;
    v_is_baseline boolean;
    v_diff jsonb;
    v_written jsonb;
    v_status jsonb;
    v_exceptions jsonb := '[]'::jsonb;
    v_seq bigint;
begin
    select * into v_source from sgn.directory_source where code = p_source for update;
    if v_source.code is null then
        perform sgn_internal.raise_error('DIRECTORY_SOURCE_UNKNOWN', p_source);
    end if;
    if p_kind is null or p_kind not in ('full', 'incremental') then
        perform sgn_internal.raise_error('SYNC_KIND_REQUIRED', p_kind);
    end if;
    v_is_baseline := v_source.baseline_seq is null;
    if v_is_baseline and p_kind <> 'full' then
        perform sgn_internal.raise_error('SYNC_BASELINE_FULL');
    end if;
    perform sgn_internal.directory_entries_check(p_entries, p_total);
    perform sgn_internal.directory_apply_due(v_now);
    if p_kind = 'full' and not v_is_baseline then
        v_diff := sgn_internal.directory_snapshot_changes(p_source, p_entries);
        if (v_diff ->> 'changes')::int * 100 > v_max_percent * greatest((v_diff ->> 'current')::int, 1) then
            return sgn_internal.directory_reject(p_source, p_entries, v_diff, v_max_percent);
        end if;
    end if;
    v_written := sgn_internal.directory_write_entries(p_source, p_entries, v_is_baseline, v_now);
    v_status := sgn_internal.directory_status_apply(p_source, p_kind, p_entries, v_written -> 'ids', v_now);
    if v_status ->> 'exception' is not null then
        v_exceptions := v_exceptions || (v_status -> 'exception');
    end if;
    if not v_is_baseline then
        v_exceptions := v_exceptions || sgn_internal.directory_role_exceptions(p_source, v_written);
    end if;
    v_seq := sgn_internal.audit_append('directory.synced', null, null, jsonb_build_object(
        'source', p_source, 'kind', p_kind, 'baseline', v_is_baseline, 'entries', jsonb_array_length(p_entries),
        'diff', v_diff, 'manager_changes', v_written -> 'manager_changes',
        'role_changes', jsonb_array_length(v_written -> 'role_changes'),
        'roles_not_applied', jsonb_array_length(v_written -> 'not_applied'),
        'status', v_status - 'exception', 'exceptions', v_exceptions,
        'settings', jsonb_build_object(
            'directory.sync_cooling_workdays', sgn_internal.setting_int('directory.sync_cooling_workdays'),
            'directory.full_snapshot_max_change_percent', v_max_percent,
            'directory.bulk_deactivation_max', sgn_internal.setting_int('directory.bulk_deactivation_max')
        ),
        'input_sha256', encode(sgn_internal.jcs_sha256(p_entries), 'hex')
    ));
    if v_is_baseline then
        update sgn.directory_source set baseline_seq = v_seq where code = p_source;
    end if;
    return jsonb_build_object(
        'kind', p_kind,
        'entries', jsonb_array_length(p_entries),
        'baseline', v_is_baseline,
        'rejected', false,
        'manager_changes', v_written -> 'manager_changes',
        'role_changes', jsonb_array_length(v_written -> 'role_changes'),
        'roles_not_applied', jsonb_array_length(v_written -> 'not_applied'),
        'roles_ignored', v_written -> 'ignored',
        'deactivated', v_status -> 'deactivated',
        'deactivations_deferred', v_status -> 'deactivations_deferred',
        'reactivated', v_status -> 'reactivated',
        'exceptions', v_exceptions
    );
end;
$$;

comment on function api_sync.directory_apply(text, text, int, jsonb) is
    '人員同步。p_kind：full（完整快照，沒列到的人視為離職；與現況差異超過門檻整批拒絕並開例外）或 incremental（只動有列到的人）；'
    'p_total 必須等於筆數。姓名、email、主管、在職狀態、角色的異動逐筆進鏈；控制類角色不套用；業務角色異動與延後的停用有冷卻期並開例外。'
    '呼叫者：sgn_sync（目錄同步工具）。規則：K-HR-SYNC、K-DETECT-MANAGER-FLIP、K-ROLE-SOURCE';

create function api_job.directory_settle()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('deactivations_applied', sgn_internal.directory_apply_due(sgn_internal.now()));
end;
$$;

comment on function api_job.directory_settle() is
    '套用已過冷卻期的延後停用（沒有同步時也要生效）。呼叫者：sgn_job（排程）。規則：K-HR-SYNC';
