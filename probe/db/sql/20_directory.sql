-- 人員、身分對應、主管關係、角色（PRB-DIRECTORY）。資料由 api_sync.directory_apply 從人員目錄同步。

create table sgn.person (
    id uuid primary key default gen_random_uuid(),
    display_name text not null,
    email text not null,
    active boolean not null,
    synced_at timestamptz not null
);

-- 外部帳號 → 內部 id。任何地方都不拿外部帳號當主鍵。
create table sgn.person_identity (
    source text not null,
    external_id text not null,
    person_id uuid not null references sgn.person (id),
    primary key (source, external_id)
);

-- 「誰向誰報告」，帶生效期間；valid_to 為 null 代表目前有效。
create table sgn.reporting_line (
    id bigint generated always as identity primary key,
    person_id uuid not null references sgn.person (id),
    manager_person_id uuid not null references sgn.person (id),
    valid_from timestamptz not null,
    valid_to timestamptz,
    check (person_id <> manager_person_id)
);

create unique index reporting_line_current_idx on sgn.reporting_line (person_id) where valid_to is null;

create table sgn.role_assignment (
    id bigint generated always as identity primary key,
    person_id uuid not null references sgn.person (id),
    role_code text not null,
    valid_from timestamptz not null,
    valid_to timestamptz
);

create unique index role_assignment_current_idx on sgn.role_assignment (person_id, role_code) where valid_to is null;

-- 找主管的唯一入口（resolver）。
create function sgn_internal.resolve_manager(p_person_id uuid)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select r.manager_person_id
    from sgn.reporting_line r
    join sgn.person m on m.id = r.manager_person_id
    where r.person_id = p_person_id
      and r.valid_to is null
      and m.active
$$;

create function sgn_internal.has_role(p_person_id uuid, p_role_code text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1
        from sgn.role_assignment a
        where a.person_id = p_person_id
          and a.role_code = p_role_code
          and a.valid_to is null
    )
$$;

create function sgn_internal.person_by_identity(p_source text, p_external_id text)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select i.person_id
    from sgn.person_identity i
    join sgn.person p on p.id = i.person_id
    where i.source = p_source
      and i.external_id = p_external_id
      and p.active
$$;

-- 一筆目錄資料：建立或更新人員與身分對應，回傳內部 id。
create function sgn_internal.directory_upsert_person(p_source text, p_entry jsonb, p_now timestamptz)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid;
begin
    select person_id into v_person_id
    from sgn.person_identity
    where source = p_source and external_id = p_entry ->> 'external_id';
    if v_person_id is null then
        insert into sgn.person (display_name, email, active, synced_at)
        values (p_entry ->> 'display_name', p_entry ->> 'email', (p_entry ->> 'active')::boolean, p_now)
        returning id into v_person_id;
        insert into sgn.person_identity (source, external_id, person_id)
        values (p_source, p_entry ->> 'external_id', v_person_id);
    else
        update sgn.person
        set display_name = p_entry ->> 'display_name',
            email = p_entry ->> 'email',
            active = (p_entry ->> 'active')::boolean,
            synced_at = p_now
        where id = v_person_id;
    end if;
    return v_person_id;
end;
$$;

-- 主管關係：和目前的不同才關閉舊的、開新的；回傳是否有變更。
create function sgn_internal.directory_set_manager(p_person_id uuid, p_manager_id uuid, p_now timestamptz)
returns boolean
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_current uuid;
begin
    select manager_person_id into v_current
    from sgn.reporting_line
    where person_id = p_person_id and valid_to is null;
    if v_current is not distinct from p_manager_id then
        return false;
    end if;
    update sgn.reporting_line set valid_to = p_now where person_id = p_person_id and valid_to is null;
    if p_manager_id is not null then
        insert into sgn.reporting_line (person_id, manager_person_id, valid_from)
        values (p_person_id, p_manager_id, p_now);
    end if;
    return true;
end;
$$;

-- 角色：讓目前有效的角色等於 p_roles。
create function sgn_internal.directory_set_roles(p_person_id uuid, p_roles text[], p_now timestamptz)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    update sgn.role_assignment
    set valid_to = p_now
    where person_id = p_person_id
      and valid_to is null
      and role_code <> all (p_roles);
    insert into sgn.role_assignment (person_id, role_code, valid_from)
    select p_person_id, r, p_now
    from unnest(p_roles) as r
    where not sgn_internal.has_role(p_person_id, r);
end;
$$;

create function api_sync.directory_apply(p_source text, p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_entry jsonb;
    v_ids jsonb := '{}'::jsonb;
    v_person_id uuid;
    v_manager_changes int := 0;
begin
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_ids := v_ids || jsonb_build_object(
            v_entry ->> 'external_id',
            sgn_internal.directory_upsert_person(p_source, v_entry, v_now)
        );
    end loop;
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_person_id := (v_ids ->> (v_entry ->> 'external_id'))::uuid;
        if sgn_internal.directory_set_manager(
            v_person_id,
            (v_ids ->> (v_entry ->> 'manager_external_id'))::uuid,
            v_now
        ) then
            v_manager_changes := v_manager_changes + 1;
        end if;
        perform sgn_internal.directory_set_roles(
            v_person_id,
            array(select jsonb_array_elements_text(coalesce(v_entry -> 'roles', '[]'::jsonb))),
            v_now
        );
    end loop;
    perform sgn_internal.audit_append(
        'directory.synced',
        null,
        null,
        jsonb_build_object(
            'source', p_source,
            'entries', jsonb_array_length(p_entries),
            'manager_changes', v_manager_changes,
            'input_sha256', encode(sha256(convert_to(p_entries::text, 'UTF8')), 'hex')
        )
    );
    return jsonb_build_object('entries', jsonb_array_length(p_entries), 'manager_changes', v_manager_changes);
end;
$$;

comment on function api_sync.directory_apply(text, jsonb) is
    '以人員目錄的完整快照更新人員、主管關係與角色。呼叫者：sgn_probe_sync（目錄同步工具）。規則：PRB-DIRECTORY';
