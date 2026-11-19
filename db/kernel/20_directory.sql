-- 人員、身分對應、主管關係、角色（PRB-DIRECTORY、PRB-SYNC-GUARD）。資料由 api_sync.directory_apply 從人員目錄同步。
--
-- 同步防護（PRB-SYNC-GUARD）。威脅：拿到同步帳號（sgn_sync）的人，可以送一份假快照，把自己或任何指定的人
-- 設成某位申請人的主管，再用那個人的通行金鑰核准。資料庫不知道同步帳號背後是誰，所以不能只防「同步者本人」，
-- 而要把「同步寫入的主管關係異動」本身當成未經確認的事實：
--   1. 來源要先登記（sgn.directory_source）；第一次同步是基準（baseline），之後每一筆主管異動
--      都單獨寫一筆 directory.manager_changed 事件進雜湊鏈（誰、舊主管、新主管）。
--   2. 每條主管關係記下來源是 baseline 還是 sync_change，以及異動事件的序號。
--   3. 送審時，若簽核人是從 sync_change 的關係解析出來，開一筆例外（sgn.exception_record），
--      單上、待簽清單、稽核證據頁都看得到；決定事件也記下當時未結案的例外。
--   4. 簽核人在送審時就固定（sgn.request_case.approver_person_id），之後的同步異動不改變進行中的單。
-- 依據：docs/reality-check/00-decisions.md RA-38（權威事實不在平台簽核，以同步防護與短期異動偵測控管）、
-- RA-24（新主管關係被用於簽核的偵測）、RB-03（同步出錯）。殘餘風險見 docs/handoff/promote.md。

-- 登記過的人員來源。baseline_seq 是第一次同步（基準）寫進鏈的事件序號；null 表示還沒同步過。
create table sgn.directory_source (
    code text primary key,
    description text not null,
    baseline_seq bigint
);

-- 開發與測試環境的來源（sim 的 LDAP）。正式環境的來源由導入時的 migration 登記。
insert into sgn.directory_source (code, description) values
    ('sim-ldap', '模擬環境的 LDAP（sim/ldap）');

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
-- origin：baseline＝來源第一次同步時就存在的關係；sync_change＝基準之後由同步異動而來（PRB-SYNC-GUARD）。
create table sgn.reporting_line (
    id bigint generated always as identity primary key,
    person_id uuid not null references sgn.person (id),
    manager_person_id uuid not null references sgn.person (id),
    valid_from timestamptz not null,
    valid_to timestamptz,
    origin text not null check (origin in ('baseline', 'sync_change')),
    change_event_seq bigint,
    check (person_id <> manager_person_id),
    check ((origin = 'sync_change') = (change_event_seq is not null))
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

-- 找主管的唯一入口（resolver）：回傳目前有效、且主管仍在職的那一條關係（沒有就回 null 列）。
-- 呼叫者要的是主管時取 manager_person_id；送審時另外記下關係本身，作為簽核人的依據（PRB-SYNC-GUARD）。
create function sgn_internal.resolve_manager(p_person_id uuid)
returns sgn.reporting_line
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select r.*
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
-- 不是基準同步時，每一筆異動都單獨進雜湊鏈，並把事件序號記在新的關係上（PRB-SYNC-GUARD）。
create function sgn_internal.directory_set_manager(
    p_source text,
    p_person_id uuid,
    p_manager_id uuid,
    p_is_baseline boolean,
    p_now timestamptz
)
returns boolean
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_current uuid;
    v_event_seq bigint;
begin
    select manager_person_id into v_current
    from sgn.reporting_line
    where person_id = p_person_id and valid_to is null;
    if v_current is not distinct from p_manager_id then
        return false;
    end if;
    update sgn.reporting_line set valid_to = p_now where person_id = p_person_id and valid_to is null;
    if not p_is_baseline then
        v_event_seq := sgn_internal.audit_append(
            'directory.manager_changed',
            null,
            null,
            jsonb_build_object(
                'source', p_source,
                'person', p_person_id,
                'previous_manager', v_current,
                'new_manager', p_manager_id
            )
        );
    end if;
    if p_manager_id is not null then
        insert into sgn.reporting_line (person_id, manager_person_id, valid_from, origin, change_event_seq)
        values (
            p_person_id,
            p_manager_id,
            p_now,
            case when p_is_baseline then 'baseline' else 'sync_change' end,
            v_event_seq
        );
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
    where not exists (
        select 1
        from sgn.role_assignment a
        where a.person_id = p_person_id
          and a.role_code = r
          and a.valid_to is null
    );
end;
$$;

create function api_sync.directory_apply(p_source text, p_entries jsonb)
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
        perform sgn_internal.directory_set_roles(
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
    '呼叫者：sgn_sync（目錄同步工具）。規則：PRB-DIRECTORY、PRB-SYNC-GUARD';
