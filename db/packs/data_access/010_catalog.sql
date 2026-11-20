-- 資料授權流程包（data_access）：schema 與最小的資料目錄（主題包 → 欄位 → 列條件），以及使用情境分類。
-- 業務規則的唯一來源：docs/packs/data-access/rules.md；實作契約：docs/contract/02-pack-data-access.md §2、§4。
-- 流程包只經 sgn_sdk 接觸核心（骨幹 6.1）。資料擁有者不存在這裡：以核心的依範圍角色指派
-- （role = data_owner、scope_ref = data_access:bundle:<主題包>）為唯一來源，由 catalog_load 同步。
-- 這一版不做目錄同步的差異、影響通知與匯入紀錄（契約 §4.2），只有載入入口（給種子與之後的同步 adapter）。

create schema pack_data_access;

create table pack_data_access.catalog_package (
    package_code text primary key check (package_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name text not null check (btrim(name) <> ''),
    -- 這個主題包所在的受管系統：執行設定由該系統的管理人負責（seed-directory.md「受管系統」）
    system_code text not null check (system_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    period_field_code text,
    sort_order int not null,
    is_active boolean not null
);

create table pack_data_access.catalog_field (
    package_code text not null references pack_data_access.catalog_package (package_code),
    field_code text not null check (field_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name text not null check (btrim(name) <> ''),
    classification text not null check (classification in ('L1', 'L2', 'L3', 'L4')),
    sort_order int not null,
    is_active boolean not null,
    primary key (package_code, field_code)
);

create table pack_data_access.catalog_filter (
    package_code text not null references pack_data_access.catalog_package (package_code),
    filter_code text not null check (filter_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name text not null check (btrim(name) <> ''),
    value_type text not null check (value_type in ('enum', 'number', 'date')),
    sort_order int not null,
    is_active boolean not null,
    primary key (package_code, filter_code)
);

create table pack_data_access.catalog_filter_value (
    package_code text not null,
    filter_code text not null,
    value text not null check (value <> ''),
    label text not null check (btrim(label) <> ''),
    sort_order int not null,
    is_active boolean not null,
    primary key (package_code, filter_code, value),
    foreign key (package_code, filter_code) references pack_data_access.catalog_filter (package_code, filter_code)
);

-- 代碼表而不是參數：申請內容引用分類代碼，停用的分類仍要顯示名稱（契約 §4.1）。
create table pack_data_access.purpose_category (
    category_code text primary key check (category_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name text not null check (btrim(name) <> ''),
    requires_description boolean not null,
    sort_order int not null,
    is_active boolean not null
);

-- rules.md「需求單」的六個分類（契約 §10.1）。
insert into pack_data_access.purpose_category (category_code, name, requires_description, sort_order, is_active) values
    ('reporting', '報表與分析', false, 10, true),
    ('development', '系統開發或測試', false, 20, true),
    ('ai_model', 'AI 模型訓練或推論', false, 30, true),
    ('audit_compliance', '稽核或法遵查核', false, 40, true),
    ('operations', '客戶服務或營運作業', false, 50, true),
    ('other', '其他（需說明）', true, 60, true);

-- 資料擁有者在核心的範圍代碼（骨幹 1.2 的流程包自訂範圍）。
create function pack_data_access.owner_scope(p_package_code text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select 'data_access:bundle:' || p_package_code
$$;

-- 載入一份完整的目錄快照（契約 §4.2 的匯入格式，另加每個主題包的 system）：
-- 快照裡有的新增或更新並啟用，沒有的停用（資料列不刪除）；擁有者同步成核心的依範圍角色指派。
create function pack_data_access.catalog_load(p_snapshot jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_pkg jsonb;
    v_item jsonb;
    v_val jsonb;
    v_pos int;
    v_vpos int;
    v_value_pos int;
    v_owners jsonb := '[]'::jsonb;
    v_owner uuid;
begin
    update pack_data_access.catalog_package set is_active = false;
    update pack_data_access.catalog_field set is_active = false;
    update pack_data_access.catalog_filter set is_active = false;
    update pack_data_access.catalog_filter_value set is_active = false;
    for v_pkg, v_pos in select e, o::int from jsonb_array_elements(p_snapshot -> 'packages') with ordinality as x (e, o) loop
        insert into pack_data_access.catalog_package (package_code, name, system_code, period_field_code, sort_order, is_active)
        values (v_pkg ->> 'code', v_pkg ->> 'name', v_pkg ->> 'system', v_pkg ->> 'period_field', v_pos, true)
        on conflict (package_code) do update
        set name = excluded.name, system_code = excluded.system_code, period_field_code = excluded.period_field_code,
            sort_order = excluded.sort_order, is_active = true;
        for v_item, v_vpos in select e, o::int from jsonb_array_elements(v_pkg -> 'fields') with ordinality as x (e, o) loop
            insert into pack_data_access.catalog_field (package_code, field_code, name, classification, sort_order, is_active)
            values (v_pkg ->> 'code', v_item ->> 'code', v_item ->> 'name', v_item ->> 'classification', v_vpos, true)
            on conflict (package_code, field_code) do update
            set name = excluded.name, classification = excluded.classification, sort_order = excluded.sort_order, is_active = true;
        end loop;
        for v_item, v_vpos in select e, o::int from jsonb_array_elements(coalesce(v_pkg -> 'filters', '[]'::jsonb)) with ordinality as x (e, o) loop
            insert into pack_data_access.catalog_filter (package_code, filter_code, name, value_type, sort_order, is_active)
            values (v_pkg ->> 'code', v_item ->> 'code', v_item ->> 'name', v_item ->> 'value_type', v_vpos, true)
            on conflict (package_code, filter_code) do update
            set name = excluded.name, value_type = excluded.value_type, sort_order = excluded.sort_order, is_active = true;
            for v_val, v_value_pos in select e, o::int from jsonb_array_elements(coalesce(v_item -> 'values', '[]'::jsonb)) with ordinality as y (e, o) loop
                insert into pack_data_access.catalog_filter_value (package_code, filter_code, value, label, sort_order, is_active)
                values (v_pkg ->> 'code', v_item ->> 'code', v_val ->> 'value', v_val ->> 'label', v_value_pos, true)
                on conflict (package_code, filter_code, value) do update
                set label = excluded.label, sort_order = excluded.sort_order, is_active = true;
            end loop;
        end loop;
        v_owner := sgn_sdk.person_by_identity(v_pkg #>> '{owner,provider}', v_pkg #>> '{owner,external_id}');
        if v_owner is not null then
            v_owners := v_owners || jsonb_build_object('scope_ref', pack_data_access.owner_scope(v_pkg ->> 'code'), 'person_id', v_owner);
        end if;
    end loop;
    return sgn_sdk.sync_scoped_role_assignments('data_access.catalog', 'data_owner', v_owners);
end;
$$;
