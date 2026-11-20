-- 被授權者、授權、依範圍的角色指派、通知寫入（骨幹第 2 節 01c、01f、01a）。

-- ── 依範圍的角色指派：一筆指派帶範圍（null＝不限範圍）與來源；每個來源只管自己的指派 ──

alter table sgn.role_assignment
    add column scope_ref text,
    add column source text not null default 'sim-ldap';

alter table sgn.role_assignment
    alter column source drop default;

drop index sgn.role_assignment_current_idx;

create unique index role_assignment_current_idx
    on sgn.role_assignment (person_id, role_code, coalesce(scope_ref, ''), source)
    where valid_to is null;

-- 人員目錄同步的角色：只增減這個來源、不限範圍的指派（其他來源的依範圍指派不受影響）。
create function sgn_internal.directory_set_source_roles(p_source text, p_person_id uuid, p_roles text[], p_now timestamptz)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    update sgn.role_assignment
    set valid_to = p_now
    where person_id = p_person_id
      and source = p_source
      and valid_to is null
      and role_code <> all (p_roles);
    insert into sgn.role_assignment (person_id, role_code, valid_from, source)
    select p_person_id, r, p_now, p_source
    from unnest(p_roles) as r
    where not exists (
        select 1
        from sgn.role_assignment as a
        where a.person_id = p_person_id
          and a.role_code = r
          and a.source = p_source
          and a.valid_to is null
    );
end;
$$;

-- 同 20_directory.sql 的版本，只把角色改由 directory_set_source_roles 寫入（帶來源）。
create or replace function api_sync.directory_apply(p_source text, p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_source sgn.directory_source;
    v_is_baseline boolean;
    v_entry jsonb;
    v_ids jsonb := '{}'::jsonb;
    v_person_id uuid;
    v_manager_changes int := 0;
    v_seq bigint;
begin
    select * into v_source from sgn.directory_source where code = p_source for update;
    if v_source.code is null then
        perform sgn_internal.raise_error('DIRECTORY_SOURCE_UNKNOWN', p_source);
    end if;
    v_is_baseline := v_source.baseline_seq is null;
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_ids := v_ids || jsonb_build_object(
            v_entry ->> 'external_id',
            sgn_internal.directory_upsert_person(p_source, v_entry, v_now)
        );
    end loop;
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_person_id := (v_ids ->> (v_entry ->> 'external_id'))::uuid;
        if sgn_internal.directory_set_manager(
            p_source,
            v_person_id,
            (v_ids ->> (v_entry ->> 'manager_external_id'))::uuid,
            v_is_baseline,
            v_now
        ) then
            v_manager_changes := v_manager_changes + 1;
        end if;
        perform sgn_internal.directory_set_source_roles(
            p_source,
            v_person_id,
            array(select jsonb_array_elements_text(coalesce(v_entry -> 'roles', '[]'::jsonb))),
            v_now
        );
    end loop;
    v_seq := sgn_internal.audit_append(
        'directory.synced',
        null,
        null,
        jsonb_build_object(
            'source', p_source,
            'baseline', v_is_baseline,
            'entries', jsonb_array_length(p_entries),
            'manager_changes', v_manager_changes,
            'input_sha256', encode(sgn_internal.jcs_sha256(p_entries), 'hex')
        )
    );
    if v_is_baseline then
        update sgn.directory_source set baseline_seq = v_seq where code = p_source;
    end if;
    return jsonb_build_object(
        'entries', jsonb_array_length(p_entries),
        'manager_changes', v_manager_changes,
        'baseline', v_is_baseline
    );
end;
$$;

comment on function api_sync.directory_apply(text, jsonb) is
    '以人員目錄的完整快照更新人員、主管關係與角色。來源必須已登記；基準之後的每一筆主管異動單獨進鏈。'
    '呼叫者：sgn_sync（目錄同步工具）。規則：K-HR-SYNC、K-DETECT-MANAGER-FLIP';

drop function sgn_internal.directory_set_roles(uuid, text[], timestamptz);

-- 某個來源對某個角色的完整依範圍指派（骨幹 0.3 D8）：結束不在清單內的、新增清單內還沒有的，寫一筆事件。
-- p_assignments：[{"scope_ref", "person_id"}]
create function sgn_internal.sync_scoped_role_assignments(p_source text, p_role text, p_assignments jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_ended int;
    v_added int;
begin
    with wanted as (
        select a ->> 'scope_ref' as scope_ref, (a ->> 'person_id')::uuid as person_id
        from jsonb_array_elements(p_assignments) as a
    ),
    ended as (
        update sgn.role_assignment as r
        set valid_to = v_now
        where r.source = p_source
          and r.role_code = p_role
          and r.valid_to is null
          and not exists (select 1 from wanted as w where w.scope_ref = r.scope_ref and w.person_id = r.person_id)
        returning 1
    )
    select count(*) into v_ended from ended;
    with wanted as (
        select a ->> 'scope_ref' as scope_ref, (a ->> 'person_id')::uuid as person_id
        from jsonb_array_elements(p_assignments) as a
    ),
    added as (
        insert into sgn.role_assignment (person_id, role_code, valid_from, scope_ref, source)
        select w.person_id, p_role, v_now, w.scope_ref, p_source
        from wanted as w
        where not exists (
            select 1 from sgn.role_assignment as r
            where r.source = p_source
              and r.role_code = p_role
              and r.valid_to is null
              and r.scope_ref = w.scope_ref
              and r.person_id = w.person_id
        )
        returning 1
    )
    select count(*) into v_added from added;
    perform sgn_internal.audit_append(
        'role.assignments_synced',
        null,
        null,
        jsonb_build_object(
            'source', p_source,
            'role', p_role,
            'added', v_added,
            'ended', v_ended,
            'input_sha256', encode(sgn_internal.jcs_sha256(p_assignments), 'hex')
        )
    );
    return jsonb_build_object('added', v_added, 'ended', v_ended);
end;
$$;

-- 角色持有人的唯一入口：目前有效、人仍在職。p_scope_ref 為 null＝不限範圍的指派。
create function sgn_internal.role_holders(p_role text, p_scope_ref text default null)
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(distinct a.person_id order by a.person_id), '{}')
    from sgn.role_assignment as a
    join sgn.person as p on p.id = a.person_id
    where a.role_code = p_role
      and a.valid_to is null
      and p.active
      and a.scope_ref is not distinct from p_scope_ref
$$;

-- ── 被授權者（K-PRINCIPAL）：團隊、專案、agent，一定有負責人；專案與 agent 必有結束日 ──

create table sgn.principal (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('team', 'project', 'agent')),
    name text not null check (btrim(name) <> ''),
    owner_person_id uuid not null references sgn.person (id),
    ends_on date,
    status text not null check (status in ('active', 'ended')),
    source text not null,
    external_ref text not null,
    unique (source, external_ref),
    check (kind = 'team' or ends_on is not null)
);

-- 種子與匯入用：依（來源、外部參照）建立或更新。
create function sgn_internal.principal_upsert(
    p_source text,
    p_external_ref text,
    p_kind text,
    p_name text,
    p_owner_person_id uuid,
    p_ends_on date
)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_id uuid;
begin
    insert into sgn.principal (kind, name, owner_person_id, ends_on, status, source, external_ref)
    values (p_kind, p_name, p_owner_person_id, p_ends_on, 'active', p_source, p_external_ref)
    on conflict (source, external_ref) do update
    set kind = excluded.kind,
        name = excluded.name,
        owner_person_id = excluded.owner_person_id,
        ends_on = excluded.ends_on
    returning id into v_id;
    perform sgn_internal.audit_append(
        'principal.saved', null, null,
        jsonb_build_object('principal', v_id, 'kind', p_kind, 'owner', p_owner_person_id, 'ends_on', p_ends_on)
    );
    return v_id;
end;
$$;

-- 可以用的被授權者：狀態有效、沒有過結束日、負責人在職。
create function sgn_internal.principal_usable(p_principal_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1
        from sgn.principal as x
        join sgn.person as o on o.id = x.owner_person_id
        where x.id = p_principal_id
          and x.status = 'active'
          and o.active
          and (x.ends_on is null or x.ends_on >= sgn_internal.today())
    )
$$;

create function sgn_internal.principal_json(p_principal_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'principal_id', x.id,
        'kind', x.kind,
        'name', x.name,
        'owner_name', o.display_name,
        'ends_on', x.ends_on
    )
    from sgn.principal as x
    join sgn.person as o on o.id = x.owner_person_id
    where x.id = p_principal_id
$$;

-- ── 授權（grant）：執行完成時建立（骨幹 4.3）──

create table sgn.grant_record (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null unique references sgn.request_case (id),
    process_type text not null references sgn.process_type (code),
    principal_id uuid references sgn.principal (id),
    valid_from date,
    valid_to date,
    -- 核准並執行的那一版
    version int not null,
    status text not null check (status in ('active')),
    created_at timestamptz not null,
    event_seq bigint not null
);

create index grant_record_principal_idx on sgn.grant_record (principal_id, process_type);

-- ── 通知（只寫入待寄送佇列；寄送不在這一版）──

create table sgn.notification_template (
    event_code text primary key,
    subject text not null,
    body text not null
);

insert into sgn.notification_template (event_code, subject, body) values
    ('case.task_assigned', '有一張單等你處理：{{case_no}}', '{{case_no}} 的「{{stage_name}}」等你處理。'),
    ('case.task_claimable', '有一張單可以認領：{{case_no}}', '{{case_no}} 的「{{stage_name}}」等群組內一人認領。'),
    ('case.reduced', '你的申請被縮小後核准：{{case_no}}', '{{case_no}} 在「{{stage_name}}」被縮小後核准，不需要重簽。'),
    ('case.returned', '你的申請被退回：{{case_no}}', '{{case_no}} 在「{{stage_name}}」被退回，原因：{{reason}}'),
    ('case.rejected', '你的申請被駁回：{{case_no}}', '{{case_no}} 在「{{stage_name}}」被駁回，原因：{{reason}}'),
    ('case.halted', '申請單找不到簽核人：{{case_no}}', '{{case_no}} 的「{{stage_name}}」找不到合格的簽核人，已停住並開例外。'),
    ('case.activated', '你的申請已生效：{{case_no}}', '{{case_no}} 已執行完成並生效。');

create table sgn.notification_outbox (
    id bigint generated always as identity primary key,
    event_code text not null references sgn.notification_template (event_code),
    person_id uuid not null references sgn.person (id),
    case_id uuid references sgn.request_case (id),
    payload jsonb not null,
    created_at timestamptz not null,
    status text not null check (status in ('pending'))
);

-- 通知寫入的唯一入口。
create function sgn_internal.notify(p_event_code text, p_person_ids uuid[], p_case_id uuid, p_payload jsonb)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_count int;
begin
    insert into sgn.notification_outbox (event_code, person_id, case_id, payload, created_at, status)
    select distinct on (p) p_event_code, p, p_case_id, p_payload, sgn_internal.now(), 'pending'
    from unnest(p_person_ids) as p
    where p is not null;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;
