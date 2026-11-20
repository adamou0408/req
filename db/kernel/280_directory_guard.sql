-- 人員同步與找主管的補強（裁決 D70；紅隊第二輪 高-1、中-1、低-2 的 G1）。
--
-- 根因：
--   高-1  resolve_manager 找不到「已過冷卻期且主管仍在職」的關係時，退回使用還沒生效的那一條。
--         再用一次增量同步停用原主管，同步改上去的主管就立即生效。
--   中-1  大量停用的門檻只算單次呼叫，拆成很多次增量同步就繞過；恢復在職、改姓名、改 email 立即生效
--         （可以把某人的名字改成別人的，誤導簽核人）。
--   低-2  同步新增人員不寫事件，鏈上查不到這個人。
--
-- 這一版：
--   1. 找主管：取最近一條已生效的關係（不論主管現在是否在職）。主管已不在職就往上一層（找那位主管的主管，同樣規則）；
--      沒有任何已生效的關係時不用未生效的，只有「基準之後才由同步新增的人」（新到職）可以用目前的關係。
--   2. 停用的門檻改為時間窗內累計：directory.deactivation_window_hours 小時內已停用與已延後的人數，加上這次要停用的，
--      超過 directory.bulk_deactivation_max 就全部延後並開例外（增量同步也計入）。停用本身仍立即生效。
--   3. 恢復在職、改姓名、改 email 進冷卻期（directory.sync_cooling_workdays）並開例外；目錄又改回原值就取消。
--   4. 同步新增人員寫進鏈（directory.person_added：姓名、email、在職狀態、外部帳號）。
--   5. 畫面上的姓名（person_name 是唯一入口）遇到同名的在職人員時加上 email，簽核畫面看得出是哪一位。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('directory.deactivation_window_hours', 'integer', '24', '{}',
        '大量停用的門檻在這個時間窗內累計（已停用與已延後的人數，含增量同步）');

alter table sgn.person
    add column joined_after_baseline boolean not null default false;

-- 延後的姓名、email、在職狀態異動：到期前維持原值；目錄又改回原值就取消。
create table sgn.person_change (
    id bigint generated always as identity primary key,
    person_id uuid not null references sgn.person (id),
    field text not null check (field in ('display_name', 'email', 'active')),
    from_value jsonb not null,
    to_value jsonb not null,
    requested_at timestamptz not null,
    effective_at timestamptz not null,
    applied_at timestamptz,
    cancelled_at timestamptz,
    exception_id bigint references sgn.exception_record (id),
    event_seq bigint not null
);

create unique index person_change_open_idx on sgn.person_change (person_id, field)
    where applied_at is null and cancelled_at is null;

-- ── 1. 找主管 ──

-- 這個人有沒有已生效的關係之外的例外：基準之後才由同步新增（新到職），沒有可以回頭看的基準。
create function sgn_internal.resolve_manager_from(p_person_id uuid, p_seen uuid[])
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
    v_settled sgn.reporting_line;
    v_empty sgn.reporting_line;
begin
    select r.* into v_current from sgn.reporting_line as r where r.person_id = p_person_id and r.valid_to is null;
    if v_current.id is null then
        -- 目錄明寫沒有主管：不回頭用已結束的關係
        return v_empty;
    end if;
    for v_line in
        select r.* from sgn.reporting_line as r where r.person_id = p_person_id order by r.id desc
    loop
        if (case when v_line.origin = 'baseline' then v_line.valid_from else sgn_internal.add_workdays(v_line.valid_from, v_cooling) end) <= v_now
           and (
               v_line.valid_to is null
               or v_line.valid_to >= case when v_line.origin = 'baseline' then v_line.valid_from
                                          else sgn_internal.add_workdays(v_line.valid_from, v_cooling) end
           ) then
            v_settled := v_line;
            exit;
        end if;
    end loop;
    if v_settled.id is null then
        if coalesce((select p.joined_after_baseline from sgn.person as p where p.id = p_person_id), false)
           and coalesce((select m.active from sgn.person as m where m.id = v_current.manager_person_id), false) then
            return v_current;
        end if;
        return v_empty;
    end if;
    if coalesce((select m.active from sgn.person as m where m.id = v_settled.manager_person_id), false) then
        return v_settled;
    end if;
    if v_settled.manager_person_id = any (p_seen) then
        return v_empty;
    end if;
    -- 已生效的主管已不在職：往上一層，同樣只用已生效的關係
    return sgn_internal.resolve_manager_from(v_settled.manager_person_id, p_seen || v_settled.manager_person_id);
end;
$$;

-- 找主管的唯一入口（同 150_resolver.sql 的簽章）。
create or replace function sgn_internal.resolve_manager(p_person_id uuid)
returns sgn.reporting_line
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.resolve_manager_from(p_person_id, array[p_person_id])
$$;

-- ── 5. 畫面上的姓名（同 180_views.sql 的簽章）──

create or replace function sgn_internal.person_name(p_person_id uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p.display_name || case
        when exists (
            select 1 from sgn.person as o where o.id <> p.id and o.active and o.display_name = p.display_name
        ) then '（' || p.email || '）'
        else ''
    end
    from sgn.person as p
    where p.id = p_person_id
$$;

-- 目前等誰處理（同 180_views.sql 的簽章）：姓名改用唯一入口 person_name（同名的人加上 email）。
create or replace function sgn_internal.case_waiting_on(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(distinct sgn_internal.person_name(p.id)), '[]'::jsonb)
    from sgn.case_task as t
    join sgn.case_stage as s on s.id = t.stage_id
    cross join lateral unnest(
        case
            when t.status = 'pending' then array[t.assignee_person_id]
            else sgn_internal.claim_candidates(t.case_id, s.id, t.claim_role, t.claim_scope)
        end
    ) as w (person_id)
    join sgn.person as p on p.id = w.person_id
    where t.case_id = p_case_id and s.status = 'open' and t.status in ('pending', 'unclaimed')
$$;

-- 單張摘要（同 180_views.sql 的簽章）：申請人的姓名改用唯一入口 person_name。
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
        'exceptions', sgn_internal.case_exceptions(c.id)
    )
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    join sgn.person as a on a.id = c.applicant_person_id
    where c.id = p_case_id
$$;

-- ── 3、4. 人員的寫入 ──

-- 排定一筆延後的異動（同一欄位只留最新的一筆）。回傳 {person, field, from, to, effective_at}。
create function sgn_internal.person_change_schedule(p_person_id uuid, p_field text, p_from jsonb, p_to jsonb, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cooling int := sgn_internal.setting_int('directory.sync_cooling_workdays');
    v_effective timestamptz := sgn_internal.add_workdays(p_now, v_cooling);
    v_open sgn.person_change;
begin
    select * into v_open from sgn.person_change
    where person_id = p_person_id and field = p_field and applied_at is null and cancelled_at is null;
    if v_open.id is not null and v_open.to_value = p_to then
        return null;
    end if;
    update sgn.person_change set cancelled_at = p_now where id = v_open.id;
    if p_from = p_to then
        return null;
    end if;
    insert into sgn.person_change (person_id, field, from_value, to_value, requested_at, effective_at, event_seq)
    values (
        p_person_id, p_field, p_from, p_to, p_now, v_effective,
        sgn_internal.audit_append('directory.person_change_deferred', null, null, jsonb_build_object(
            'person', p_person_id, 'field', p_field, 'from', p_from, 'to', p_to, 'effective_at', v_effective,
            'cooling_workdays', v_cooling, 'rules', jsonb_build_array('K-HR-SYNC')
        ))
    );
    return jsonb_build_object('person', p_person_id, 'field', p_field, 'from', p_from, 'to', p_to, 'effective_at', v_effective);
end;
$$;

-- 建立人員（逐筆進鏈），或排定姓名與 email 的異動（基準之後進冷卻期）。回傳 {id, deferred: [...]}。
drop function sgn_internal.directory_write_person(text, jsonb, timestamptz);

create function sgn_internal.directory_write_person(p_source text, p_entry jsonb, p_is_baseline boolean, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person sgn.person;
    v_deferred jsonb := '[]'::jsonb;
    v_field text;
begin
    select p.* into v_person
    from sgn.person_identity as i
    join sgn.person as p on p.id = i.person_id
    where i.source = p_source and i.external_id = p_entry ->> 'external_id';
    if v_person.id is null then
        insert into sgn.person (display_name, email, active, synced_at, joined_after_baseline)
        values (p_entry ->> 'display_name', p_entry ->> 'email', (p_entry ->> 'active')::boolean, p_now, not p_is_baseline)
        returning * into v_person;
        insert into sgn.person_identity (source, external_id, person_id)
        values (p_source, p_entry ->> 'external_id', v_person.id);
        perform sgn_internal.audit_append('directory.person_added', null, null, jsonb_build_object(
            'source', p_source,
            'person', v_person.id,
            'external_id', p_entry ->> 'external_id',
            'display_name', v_person.display_name,
            'email', v_person.email,
            'active', v_person.active,
            'baseline', p_is_baseline,
            'rules', jsonb_build_array('K-HR-SYNC')
        ));
        return jsonb_build_object('id', v_person.id, 'deferred', v_deferred);
    end if;
    update sgn.person set synced_at = p_now where id = v_person.id;
    foreach v_field in array array['display_name', 'email'] loop
        v_deferred := v_deferred || coalesce(sgn_internal.person_change_schedule(
            v_person.id, v_field, to_jsonb(v_person) -> v_field, p_entry -> v_field, p_now
        ), '[]'::jsonb);
    end loop;
    return jsonb_build_object('id', v_person.id, 'deferred', v_deferred);
end;
$$;

-- 人員、主管、角色（同 230_directory_sync.sql 的簽章）。多回傳 deferred：延後的姓名與 email 異動。
create or replace function sgn_internal.directory_write_entries(p_source text, p_entries jsonb, p_is_baseline boolean, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_ids jsonb := '{}'::jsonb;
    v_entry jsonb;
    v_written jsonb;
    v_person_id uuid;
    v_manager_changes int := 0;
    v_roles jsonb;
    v_deferred jsonb := '[]'::jsonb;
    v_role_changes jsonb := '[]'::jsonb;
    v_not_applied jsonb := '[]'::jsonb;
    v_ignored jsonb := '[]'::jsonb;
begin
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_written := sgn_internal.directory_write_person(p_source, v_entry, p_is_baseline, p_now);
        v_ids := v_ids || jsonb_build_object(v_entry ->> 'external_id', v_written -> 'id');
        v_deferred := v_deferred || (v_written -> 'deferred');
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
        'deferred', v_deferred,
        'manager_changes', v_manager_changes,
        'role_changes', v_role_changes,
        'not_applied', v_not_applied,
        'ignored', (select coalesce(jsonb_agg(distinct c), '[]'::jsonb) from jsonb_array_elements_text(v_ignored) as c)
    );
end;
$$;

-- ── 2、3. 在職狀態 ──

-- 時間窗內已停用與已延後停用的人數（含增量同步與排程套用的）。
create function sgn_internal.directory_recent_deactivations(p_now timestamptz)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select count(*)::int
    from sgn.audit_event as e
    where e.event_type in ('directory.person_deactivated', 'directory.deactivation_deferred')
      and e.occurred_at > p_now - make_interval(hours => sgn_internal.setting_int('directory.deactivation_window_hours'))
$$;

-- 在職狀態（同 230_directory_sync.sql 的簽章）。目錄說在職：取消排定的停用；已停用的人「恢復在職」進冷卻期。
-- 目錄說離職：取消排定的恢復；時間窗內累計超過門檻、或持有控制類角色的人，延後並開例外；其餘立即停用。
create or replace function sgn_internal.directory_status_apply(p_source text, p_kind text, p_entries jsonb, p_ids jsonb, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cooling int := sgn_internal.setting_int('directory.sync_cooling_workdays');
    v_bulk_max int := sgn_internal.setting_int('directory.bulk_deactivation_max');
    v_recent int := sgn_internal.directory_recent_deactivations(p_now);
    v_listed_active uuid[] := array(
        select (p_ids ->> (e ->> 'external_id'))::uuid from jsonb_array_elements(p_entries) as e where (e ->> 'active')::boolean
    );
    v_targets uuid[];
    v_deferred uuid[];
    v_reactivations jsonb := '[]'::jsonb;
    v_exception bigint;
    v_person_id uuid;
begin
    update sgn.person_deactivation set cancelled_at = p_now
    where person_id = any (v_listed_active) and applied_at is null and cancelled_at is null;
    foreach v_person_id in array array(select p.id from sgn.person as p where p.id = any (v_listed_active) and not p.active) loop
        v_reactivations := v_reactivations
            || coalesce(sgn_internal.person_change_schedule(v_person_id, 'active', 'false'::jsonb, 'true'::jsonb, p_now), '[]'::jsonb);
    end loop;
    v_targets := array(
        select p.id
        from sgn.person as p
        join sgn.person_identity as i on i.person_id = p.id and i.source = p_source
        where exists (
                  select 1 from jsonb_array_elements(p_entries) as e
                  where e ->> 'external_id' = i.external_id and not (e ->> 'active')::boolean
              )
           or (p_kind = 'full' and not p_ids ? i.external_id)
        order by p.id
    );
    -- 目錄又說離職：取消排定的恢復在職
    update sgn.person_change set cancelled_at = p_now
    where person_id = any (v_targets) and field = 'active' and applied_at is null and cancelled_at is null;
    v_targets := array(
        select t from unnest(v_targets) as t
        join sgn.person as p on p.id = t
        where p.active
          and not exists (
              select 1 from sgn.person_deactivation as d where d.person_id = t and d.applied_at is null and d.cancelled_at is null
          )
    );
    v_deferred := array(
        select t from unnest(v_targets) as t
        where v_recent + cardinality(v_targets) > v_bulk_max or sgn_internal.holds_control_role(t)
    );
    if cardinality(v_deferred) > 0 then
        v_exception := sgn_internal.exception_open('K-HR-SYNC', null, jsonb_build_object(
            'kind', 'deactivation_deferred', 'source', p_source, 'persons', to_jsonb(v_deferred),
            'bulk', v_recent + cardinality(v_targets) > v_bulk_max, 'bulk_deactivation_max', v_bulk_max,
            'recent_in_window', v_recent,
            'window_hours', sgn_internal.setting_int('directory.deactivation_window_hours'),
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
        'reactivated', 0,
        'reactivations_deferred', jsonb_array_length(v_reactivations),
        'reactivations', v_reactivations,
        'exception', v_exception
    );
end;
$$;

-- 套用到期的延後停用與延後的人員異動。由每一次同步與排程呼叫。回傳兩種各套用了幾筆（230 的版本只回停用的筆數）。
drop function sgn_internal.directory_apply_due(timestamptz);

create function sgn_internal.directory_apply_due(p_now timestamptz)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row sgn.person_deactivation;
    v_change sgn.person_change;
    v_count int := 0;
    v_changes int := 0;
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
    for v_change in
        select * from sgn.person_change
        where applied_at is null and cancelled_at is null and effective_at <= p_now
        order by id
        for update
    loop
        update sgn.person
        set display_name = case when v_change.field = 'display_name' then v_change.to_value #>> '{}' else display_name end,
            email = case when v_change.field = 'email' then v_change.to_value #>> '{}' else email end,
            active = case when v_change.field = 'active' then (v_change.to_value #>> '{}')::boolean else active end
        where id = v_change.person_id;
        update sgn.person_change set applied_at = p_now where id = v_change.id;
        v_changes := v_changes + 1;
        perform sgn_internal.audit_append(
            case when v_change.field = 'active' then 'directory.person_reactivated' else 'directory.person_changed' end,
            null,
            null,
            jsonb_build_object(
                'person', v_change.person_id,
                'changes', jsonb_build_object(v_change.field, jsonb_build_object('from', v_change.from_value, 'to', v_change.to_value)),
                'deferred_id', v_change.id,
                'exception_id', v_change.exception_id
            )
        );
    end loop;
    return jsonb_build_object('deactivations_applied', v_count, 'person_changes_applied', v_changes);
end;
$$;

create or replace function api_job.directory_settle()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.directory_apply_due(sgn_internal.now());
end;
$$;

comment on function api_job.directory_settle() is
    '套用已過冷卻期的延後停用與延後的人員異動（姓名、email、恢復在職；沒有同步時也要生效）。'
    '呼叫者：sgn_job（排程 db/tools/jobs.mjs）。規則：K-HR-SYNC';

-- 延後的人員異動（姓名、email、恢復在職）開一筆例外，讓人來看。回傳例外 id 的陣列。
create function sgn_internal.directory_change_exceptions(p_source text, p_changes jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_exception bigint;
begin
    if jsonb_array_length(p_changes) = 0 then
        return '[]'::jsonb;
    end if;
    v_exception := sgn_internal.exception_open('K-HR-SYNC', null, jsonb_build_object(
        'kind', 'person_change_deferred', 'source', p_source, 'changes', p_changes,
        'cooling_workdays', sgn_internal.setting_int('directory.sync_cooling_workdays')
    ));
    update sgn.person_change as c
    set exception_id = v_exception
    from jsonb_array_elements(p_changes) as x
    where c.person_id = (x ->> 'person')::uuid and c.field = x ->> 'field'
      and c.applied_at is null and c.cancelled_at is null;
    return jsonb_build_array(v_exception);
end;
$$;

create or replace function api_sync.directory_apply(p_source text, p_kind text, p_total int, p_entries jsonb)
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
    v_exceptions := v_exceptions
        || sgn_internal.directory_change_exceptions(p_source, (v_written -> 'deferred') || (v_status -> 'reactivations'));
    if not v_is_baseline then
        v_exceptions := v_exceptions || sgn_internal.directory_role_exceptions(p_source, v_written);
    end if;
    v_seq := sgn_internal.audit_append('directory.synced', null, null, jsonb_build_object(
        'source', p_source, 'kind', p_kind, 'baseline', v_is_baseline, 'entries', jsonb_array_length(p_entries),
        'diff', v_diff, 'manager_changes', v_written -> 'manager_changes',
        'person_changes_deferred', jsonb_array_length(v_written -> 'deferred'),
        'role_changes', jsonb_array_length(v_written -> 'role_changes'),
        'roles_not_applied', jsonb_array_length(v_written -> 'not_applied'),
        'status', v_status - 'exception' - 'reactivations', 'exceptions', v_exceptions,
        'settings', jsonb_build_object(
            'directory.sync_cooling_workdays', sgn_internal.setting_int('directory.sync_cooling_workdays'),
            'directory.full_snapshot_max_change_percent', v_max_percent,
            'directory.bulk_deactivation_max', sgn_internal.setting_int('directory.bulk_deactivation_max'),
            'directory.deactivation_window_hours', sgn_internal.setting_int('directory.deactivation_window_hours')
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
        'person_changes_deferred', jsonb_array_length(v_written -> 'deferred'),
        'role_changes', jsonb_array_length(v_written -> 'role_changes'),
        'roles_not_applied', jsonb_array_length(v_written -> 'not_applied'),
        'roles_ignored', v_written -> 'ignored',
        'deactivated', v_status -> 'deactivated',
        'deactivations_deferred', v_status -> 'deactivations_deferred',
        'reactivated', v_status -> 'reactivated',
        'reactivations_deferred', v_status -> 'reactivations_deferred',
        'exceptions', v_exceptions
    );
end;
$$;

comment on function api_sync.directory_apply(text, text, int, jsonb) is
    '人員同步。p_kind：full（完整快照，沒列到的人視為離職；與現況差異超過門檻整批拒絕並開例外）或 incremental（只動有列到的人）；'
    'p_total 必須等於筆數。新增人員、主管、角色、在職狀態的異動逐筆進鏈；控制類角色不套用；業務角色異動、延後的停用、'
    '恢復在職、改姓名與 email 有冷卻期並開例外；停用的門檻在時間窗內累計。'
    '呼叫者：sgn_sync（目錄同步工具）。規則：K-HR-SYNC、K-DETECT-MANAGER-FLIP、K-ROLE-SOURCE';

select sgn_internal.register_rule(
    'K-HR-SYNC',
    '人員目錄是權威來源，但同步帳號被入侵時不能立即改變誰來簽：主管異動、業務角色、恢復在職、改姓名與 email 都有冷卻期並開例外；'
    '停用立即生效，但時間窗內累計超過門檻（directory.bulk_deactivation_max、directory.deactivation_window_hours）或持有控制類角色就延後；'
    '找主管只用已生效的關係，主管不在職就往上一層；新增人員寫進鏈；同名的人在畫面上加上 email',
    null,
    'partial',
    '暫存區、雙人確認沒做；延後的異動要靠下一次同步或排程 api_job.directory_settle 套用'
);
