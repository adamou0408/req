-- 測試區與正式區（裁決 D93；交接 docs/handoff/closed-loop-2.md）。rules.md 還沒有這幾條，條文草稿在交接。
--
-- 1. 環境是申請內容的必填欄位（內容的 environment 鍵），值來自代碼表 data_environment；一張單一個環境，進版本雜湊與顯示摘要。
--    舊單（這一版之前的內容沒有這個鍵）：已存的雜湊不重算、顯示摘要不多這一行，一律視為代碼表標為 applies_to_legacy 的環境（正式區）。
--    新的輸入沒有這個鍵：視為代碼表標為 default_when_missing 的環境（測試區），並提示——沒說要哪一區就只給較不敏感、期限較短的那一區；
--    要正式區必須明講，而且要附測試報告的依據（下面第 5 點）。系統自己整理過的舊內容（帶 catalog 鍵，例如目錄改版時重新整理）沒有這個鍵時
--    照舊單處理（正式區），不會因為重新整理就被改到另一區。
-- 2. 級別由目錄逐欄、逐環境決定（DA-ENV-TIER）：目錄的欄位可以標示「在某一區已去識別／遮罩，分級是 X」（catalog_field_environment），
--    沒有標示的與正式區同級。申請人不能自稱。目錄版本的快照涵蓋這個標示（格式 data_access_catalog/2）；引用摘要只看這張單那一區的標示，
--    所以標示測試區不會讓正式區的單被當成目錄異動。
-- 3. 交付的規則帶 environment（舊單不帶，使用方系統視為正式區）；使用方系統在已簽的套用與驗證結果裡回報實際套用的區，
--    和規則不同（或沒有回報）→ 不生效並開例外（DA-ENV-MISMATCH，經核心的 check_delivery_result）。
-- 4. 自動驗證：每個案例的查詢帶這張單的區，另加一個反例「同一份規則在另一區查不到」（DA-ENV-VERIFY）。對帳的限制條件帶區
--    （規則代碼本來就分到單，一張單一區；沒有規則的權限以限制條件的區比對）。重疊與完全涵蓋只和同一區的授權比。
-- 5. 正式區（代碼表標 requires_test_basis 的區）送審時必須引用一張涵蓋它的測試區單（同一位申請人或同一個被授權者、主題包與欄位涵蓋、
--    列條件不比它窄、曾經生效），由核心的送審複核（K-SUBMIT-REVIEW）判定（DA-ENV-TEST-BASIS）。沒有可引用的單時填例外理由，
--    送審後開例外 DA-TEST-EXCEPTION，簽核人看得到（D93 (4)、D94 (4)）。升版前建立、沒有環境鍵的舊內容不追加這條。
-- 6. 期限上限依環境（DA-ENV-VALIDITY）：參數 data_access.environment_validity_max_months，適用範圍 environment:data_access:<區>，
--    測試區的初始值較短。和核心依級別的上限（K-VALIDITY-MAX）同時成立。
-- 前端只顯示資料庫回傳的選項、提示與錯誤。

-- ── 代碼表 ──

create table pack_data_access.data_environment (
    environment_code text primary key check (environment_code ~ '^[a-z][a-z0-9_]{0,30}$'),
    name text not null check (btrim(name) <> ''),
    description text not null,
    -- 這一區的單送審時要引用一張測試區的單（或填例外理由）
    requires_test_basis boolean not null,
    -- 這一區的單可以當成別區的測試依據
    is_test_source boolean not null,
    -- 舊單（沒有 environment 鍵）視為這一區；只能有一個
    applies_to_legacy boolean not null,
    -- 新的輸入沒有 environment 鍵時視為這一區；只能有一個
    default_when_missing boolean not null,
    sort_order int not null,
    is_active boolean not null
);

create unique index data_environment_legacy_idx on pack_data_access.data_environment (applies_to_legacy) where applies_to_legacy;
create unique index data_environment_missing_idx on pack_data_access.data_environment (default_when_missing) where default_when_missing;

insert into pack_data_access.data_environment
    (environment_code, name, description, requires_test_basis, is_test_source, applies_to_legacy, default_when_missing, sort_order, is_active)
values
    ('test', '測試區', '正式區過去時間的副本；目錄標示已去識別或遮罩的欄位分級較低', false, true, false, true, 1, true),
    ('prod', '正式區', '實際營運中的資料', true, false, true, false, 2, true);

-- 欄位在某一區的處理（已去識別或遮罩）與那一區的分級（必須比正式區低）。沒有一列＝與正式區同級。
create table pack_data_access.catalog_field_environment (
    package_code text not null,
    field_code text not null,
    environment_code text not null references pack_data_access.data_environment (environment_code),
    treatment text not null check (treatment in ('deidentified', 'masked')),
    classification text not null check (classification in ('L1', 'L2', 'L3', 'L4')),
    primary key (package_code, field_code, environment_code),
    foreign key (package_code, field_code) references pack_data_access.catalog_field (package_code, field_code)
);

select sgn_sdk.register_message(m.code, m.kind, m.message, m.http_status)
from (values
    ('DA-E-CATALOG-ZONE', 'error', '資料目錄的分區標示不正確（分區的分級必須比正式區低，處理方式只能是去識別或遮罩）', 422)
) as m (code, kind, message, http_status);

select sgn_sdk.register_message(m.code, m.kind, m.message)
from (values
    ('DA-E-ENVIRONMENT-UNKNOWN', 'check', '沒有「%s」這個環境，請選測試區或正式區。'),
    ('DA-E-ENV-VALIDITY', 'check', '%s的授權期間最多 %s 個月，請縮短迄日。'),
    ('DA-E-TEST-BASIS-REQUIRED', 'check', '%s的申請要引用一張已經在測試區用過的單；沒有的話請填寫沒有測試紀錄的理由。'),
    ('DA-E-TEST-BASIS-INVALID', 'check', '引用的測試區單 %s 不能當依據：%s'),
    ('DA-N-ENVIRONMENT-DEFAULT', 'notice', '沒有指定環境，以「%s」處理。'),
    ('DA-N-ENV-DOWNGRADED', 'notice', '「%s」的%s在%s已%s，分級由 %s 降為 %s。'),
    ('DA-T-ENV-LINE', 'notice', '環境：%s'),
    ('DA-T-TEST-BASIS-LINE', 'notice', '測試依據：測試區單 %s'),
    ('DA-T-TEST-EXCEPTION-LINE', 'notice', '沒有測試紀錄的理由：%s'),
    ('DA-T-TREATMENT-DEIDENTIFIED', 'notice', '去識別'),
    ('DA-T-TREATMENT-MASKED', 'notice', '遮罩'),
    ('DA-T-BASIS-UNKNOWN', 'notice', '找不到這張單'),
    ('DA-T-BASIS-NOT-TEST', 'notice', '它不是測試區的單'),
    ('DA-T-BASIS-NEVER-ACTIVE', 'notice', '它還沒有生效過'),
    ('DA-T-BASIS-UNRELATED', 'notice', '它不是你申請的，也不是同一個被授權者'),
    ('DA-T-BASIS-NOT-COVERING', 'notice', '它的主題包、欄位或列條件沒有涵蓋這次的申請'),
    ('DA-T-VC-OTHER-ENV', 'notice', '%s查詢 %s（同一份規則，另一區：%s）')
) as m (code, kind, message);

select sgn_sdk.register_setting_definition(
    'data_access.environment_validity_max_months', 'integer', '12'::jsonb, array['environment'],
    '依環境的授權期間上限（月）：迄日必須早於起日加上這個月數；和依級別的上限（validity.max_months）同時成立', 'data_access'
);

select sgn_sdk.register_setting_value(
    'data_access.environment_validity_max_months', 'environment:data_access:test', '3'::jsonb,
    '資料授權流程包初始值（裁決 D93 (5)：測試區的期限上限較短）'
);

-- ── 讀取 ──

create function pack_data_access.environment_row(p_code text)
returns pack_data_access.data_environment
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from pack_data_access.data_environment where environment_code = p_code
$$;

-- 一份內容的環境代碼：有鍵用鍵，沒有就是舊單（代碼表標 applies_to_legacy 的那一區）。
create function pack_data_access.content_environment(p_content jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        case when jsonb_typeof(p_content -> 'environment') = 'string' then p_content ->> 'environment' end,
        (select e.environment_code from pack_data_access.data_environment as e where e.applies_to_legacy)
    )
$$;

create function pack_data_access.rule_set_environment(p_rule_set jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(p_rule_set ->> 'environment', (select e.environment_code from pack_data_access.data_environment as e where e.applies_to_legacy))
$$;

create function pack_data_access.environment_label(p_code text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce((select e.name from pack_data_access.data_environment as e where e.environment_code = p_code), p_code)
$$;

-- 一個欄位在某一區的分級：有分區標示用標示的，否則與正式區同級。
create function pack_data_access.field_classification(p_package_code text, p_field_code text, p_environment text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        (select z.classification from pack_data_access.catalog_field_environment as z
         where z.package_code = p_package_code and z.field_code = p_field_code and z.environment_code = p_environment),
        (select f.classification from pack_data_access.catalog_field as f
         where f.package_code = p_package_code and f.field_code = p_field_code and f.is_active)
    )
$$;

-- ── 目錄：分區標示的載入、快照與引用摘要 ──

-- 一個欄位的分區標示（快照用）：[{environment, treatment, classification}]，依區的代碼排序；沒有標示是 null（快照不放這個鍵）。
create function pack_data_access.field_environments(p_package_code text, p_field_code text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_agg(jsonb_build_object('environment', z.environment_code, 'treatment', z.treatment, 'classification', z.classification)
        order by z.environment_code collate "C")
    from pack_data_access.catalog_field_environment as z
    where z.package_code = p_package_code and z.field_code = p_field_code
$$;

-- 標準化快照（同 130 的簽章）：格式升為 data_access_catalog/2，欄位有分區標示時多一個 environments 鍵（沒有標示的欄位和 /1 相同）。
create or replace function pack_data_access.catalog_snapshot()
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('format', 'data_access_catalog/2', 'packages', coalesce(jsonb_agg(jsonb_build_object(
        'code', p.package_code, 'name', p.name, 'system', p.system_code, 'period_field', p.period_field_code, 'resource', p.resource,
        'fields', (
            select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'code', f.field_code, 'name', f.name, 'classification', f.classification,
                'environments', pack_data_access.field_environments(f.package_code, f.field_code)
            )) || jsonb_build_object('resource', f.resource) order by f.field_code collate "C"), '[]'::jsonb)
            from pack_data_access.catalog_field as f
            where f.package_code = p.package_code and f.is_active
        ),
        'filters', pack_data_access.catalog_filter_snapshot(p.package_code)
    ) order by p.package_code collate "C"), '[]'::jsonb))
    from pack_data_access.catalog_package as p
    where p.is_active
$$;

-- 快照裡的一個主題包只留某一區的分區標示（其他區的標示和這張單無關）。
create function pack_data_access.snapshot_package_in(p_pkg jsonb, p_environment text)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select p_pkg || jsonb_build_object('fields', coalesce((
        select jsonb_agg((f - 'environments') || coalesce((
            select jsonb_build_object('environments', jsonb_agg(z))
            from jsonb_array_elements(coalesce(f -> 'environments', '[]')) as z
            where z ->> 'environment' = p_environment
            having count(*) > 0
        ), '{}'::jsonb) order by n)
        from jsonb_array_elements(coalesce(p_pkg -> 'fields', '[]')) with ordinality as x (f, n)
    ), '[]'::jsonb))
$$;

-- 引用摘要（同 130 的簽章）：只看這張單那一區的分區標示。
create or replace function pack_data_access.catalog_ref(p_content jsonb, p_version_no int)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('packages', coalesce(jsonb_agg(coalesce(
        (select pack_data_access.catalog_ref_package(
                    pack_data_access.snapshot_package_in(p, pack_data_access.content_environment(p_content)), s.item)
         from pack_data_access.catalog_version as v
         cross join lateral jsonb_array_elements(v.snapshot -> 'packages') as p
         where v.version_no = p_version_no and p ->> 'code' = s.item ->> 'package'),
        jsonb_build_object('code', s.item ->> 'package', 'missing', true)
    ) order by s.item ->> 'package' collate "C"), '[]'::jsonb))
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'scope') = 'array' then p_content -> 'scope' else '[]' end) as s (item)
$$;

-- 一個欄位的分區標示（catalog_load 用）：檢查後重寫。
create function pack_data_access.field_environments_load(p_package_code text, p_field_code text, p_field jsonb, p_classification text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_z jsonb;
begin
    delete from pack_data_access.catalog_field_environment where package_code = p_package_code and field_code = p_field_code;
    for v_z in select z from jsonb_array_elements(coalesce(p_field -> 'environments', '[]'::jsonb)) as z loop
        if (pack_data_access.environment_row(v_z ->> 'environment')).environment_code is null
           or v_z ->> 'treatment' not in ('deidentified', 'masked')
           or v_z ->> 'classification' not in ('L1', 'L2', 'L3', 'L4')
           or v_z ->> 'classification' >= p_classification then
            perform sgn_sdk.raise_error('DA-E-CATALOG-ZONE', p_package_code || '.' || p_field_code);
        end if;
        insert into pack_data_access.catalog_field_environment (package_code, field_code, environment_code, treatment, classification)
        values (p_package_code, p_field_code, v_z ->> 'environment', v_z ->> 'treatment', v_z ->> 'classification');
    end loop;
end;
$$;

-- 載入一份完整的目錄快照（同 010、130 的簽章）：多了欄位的分區標示，套用後產生版本。
create or replace function pack_data_access.catalog_load(p_snapshot jsonb)
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
    v_sync jsonb;
begin
    update pack_data_access.catalog_package set is_active = false;
    update pack_data_access.catalog_field set is_active = false;
    update pack_data_access.catalog_filter set is_active = false;
    update pack_data_access.catalog_filter_value set is_active = false;
    delete from pack_data_access.catalog_field_environment;
    for v_pkg, v_pos in select e, o::int from jsonb_array_elements(p_snapshot -> 'packages') with ordinality as x (e, o) loop
        insert into pack_data_access.catalog_package (package_code, name, system_code, period_field_code, sort_order, is_active, resource)
        values (v_pkg ->> 'code', v_pkg ->> 'name', v_pkg ->> 'system', v_pkg ->> 'period_field', v_pos, true, v_pkg ->> 'resource')
        on conflict (package_code) do update
        set name = excluded.name, system_code = excluded.system_code, period_field_code = excluded.period_field_code,
            sort_order = excluded.sort_order, is_active = true, resource = excluded.resource;
        for v_item, v_vpos in select e, o::int from jsonb_array_elements(v_pkg -> 'fields') with ordinality as x (e, o) loop
            insert into pack_data_access.catalog_field (package_code, field_code, name, classification, sort_order, is_active, resource)
            values (v_pkg ->> 'code', v_item ->> 'code', v_item ->> 'name', v_item ->> 'classification', v_vpos, true, v_item ->> 'resource')
            on conflict (package_code, field_code) do update
            set name = excluded.name, classification = excluded.classification, sort_order = excluded.sort_order, is_active = true,
                resource = excluded.resource;
            perform pack_data_access.field_environments_load(v_pkg ->> 'code', v_item ->> 'code', v_item, v_item ->> 'classification');
        end loop;
        for v_item, v_vpos in select e, o::int from jsonb_array_elements(coalesce(v_pkg -> 'filters', '[]'::jsonb)) with ordinality as x (e, o) loop
            insert into pack_data_access.catalog_filter (package_code, filter_code, name, value_type, sort_order, is_active, resource)
            values (v_pkg ->> 'code', v_item ->> 'code', v_item ->> 'name', v_item ->> 'value_type', v_vpos, true, v_item ->> 'resource')
            on conflict (package_code, filter_code) do update
            set name = excluded.name, value_type = excluded.value_type, sort_order = excluded.sort_order, is_active = true,
                resource = excluded.resource;
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
    v_sync := sgn_sdk.sync_scoped_role_assignments('data_access.catalog', 'data_owner', v_owners);
    return v_sync || jsonb_build_object('catalog', pack_data_access.catalog_record('catalog_load'));
end;
$$;

-- ── 整理內容：依環境的分級 ──

-- 一個主題包（同 030 package_normalized，分級改為這一區的分級）：回傳 {package（null＝整個移除）, notices}。
create function pack_data_access.package_normalized_in(p_package_code text, p_fields jsonb, p_filters jsonb, p_environment text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_pkg pack_data_access.catalog_package := pack_data_access.package_row(p_package_code);
    v_notices jsonb := '[]'::jsonb;
    v_kept jsonb := '[]'::jsonb;
    v_code text;
    v_field pack_data_access.catalog_field;
    v_class text;
    v_zone pack_data_access.catalog_field_environment;
begin
    if v_pkg.package_code is null then
        return jsonb_build_object('package', null, 'notices', jsonb_build_array(
            pack_data_access.notice('DA-N-PACKAGE-UNAVAILABLE', pack_data_access.package_label(p_package_code))
        ));
    end if;
    for v_code in
        select d.code
        from (
            select distinct coalesce(case when jsonb_typeof(f) = 'string' then f #>> '{}' end, f ->> 'code') as code
            from jsonb_array_elements(p_fields) as f
            where jsonb_typeof(f) = 'string' or (jsonb_typeof(f) = 'object' and f ->> 'code' is not null)
        ) as d
        order by d.code collate "C"
    loop
        select * into v_field from pack_data_access.catalog_field
        where package_code = p_package_code and field_code = v_code and is_active;
        select * into v_zone from pack_data_access.catalog_field_environment
        where package_code = p_package_code and field_code = v_code and environment_code = p_environment;
        v_class := coalesce(v_zone.classification, v_field.classification);
        if v_zone.classification is not null and v_field.field_code is not null then
            v_notices := v_notices || pack_data_access.notice('DA-N-ENV-DOWNGRADED', v_pkg.name, v_field.name,
                pack_data_access.environment_label(p_environment),
                sgn_sdk.message('DA-T-TREATMENT-' || upper(v_zone.treatment)), v_field.classification, v_class);
        end if;
        if v_field.field_code is null then
            v_notices := v_notices || pack_data_access.notice('DA-N-FIELD-UNAVAILABLE', v_pkg.name, v_code);
        elsif v_class in ('L1', 'L2') then
            v_notices := v_notices || pack_data_access.notice('DA-N-AUTO-GRANTED', v_pkg.name, v_field.name, v_class);
        else
            v_kept := v_kept || jsonb_build_object('code', v_code, 'classification', v_class);
        end if;
    end loop;
    if jsonb_array_length(v_kept) = 0 then
        return jsonb_build_object('package', null, 'notices', v_notices || pack_data_access.notice('DA-N-PACKAGE-EMPTY', v_pkg.name));
    end if;
    return jsonb_build_object(
        'package', jsonb_build_object(
            'package', p_package_code,
            'fields', v_kept,
            'row_filters', (
                select coalesce(jsonb_agg(n order by n ->> 'filter' collate "C", n ->> 'op', (n -> 'values')::text), '[]'::jsonb)
                from (
                    select pack_data_access.filter_normalized(p_package_code, c) as n
                    from jsonb_array_elements(p_filters) as c
                    where jsonb_typeof(c) = 'object'
                ) as x
            )
        ),
        'notices', v_notices
    );
end;
$$;

-- 整理內容（同 030 normalize_content，主題包改以這一區的分級整理）。p_environment 是 null 時同正式區（舊單）。
create function pack_data_access.normalize_scoped(p_content jsonb, p_environment text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_in jsonb := case when jsonb_typeof(p_content) = 'object' then p_content else '{}'::jsonb end;
    v_scope jsonb := '[]'::jsonb;
    v_notices jsonb := '[]'::jsonb;
    v_group record;
    v_result jsonb;
    v_period jsonb := v_in -> 'data_period';
    v_tier text;
    v_export boolean := (v_in -> 'export_allowed') = 'true'::jsonb;
    v_content jsonb;
begin
    for v_group in select * from pack_data_access.scope_grouped(v_in -> 'scope') loop
        v_result := pack_data_access.package_normalized_in(v_group.package_code, v_group.fields, v_group.filters, p_environment);
        v_notices := v_notices || (v_result -> 'notices');
        if v_result -> 'package' <> 'null'::jsonb then
            v_scope := v_scope || jsonb_build_array(v_result -> 'package');
        end if;
    end loop;
    if jsonb_typeof(v_period) = 'object' then
        v_period := jsonb_build_object('from', nullif(v_period -> 'from', '""'), 'to', nullif(v_period -> 'to', '""'));
        if v_period -> 'from' = 'null'::jsonb and v_period -> 'to' = 'null'::jsonb then
            v_period := null;
        end if;
    else
        v_period := null;
    end if;
    v_tier := pack_data_access.classify_tier(jsonb_build_object('scope', v_scope));
    if v_export and not pack_data_access.export_requestable(v_tier) then
        v_export := false;
        v_notices := v_notices || pack_data_access.notice('DA-N-EXPORT-FORCED', v_tier);
    end if;
    -- 只留表上的鍵：申請內容不記錄媒介（DA-NO-MEDIUM；環境是「哪一份資料」不是媒介，D93 (6)）
    v_content := jsonb_build_object(
        'scope', v_scope,
        'data_period', coalesce(v_period, 'null'::jsonb),
        'purpose_category', to_jsonb(nullif(btrim(case when jsonb_typeof(v_in -> 'purpose_category') = 'string' then v_in ->> 'purpose_category' end), '')),
        'purpose_description', to_jsonb(btrim(case when jsonb_typeof(v_in -> 'purpose_description') = 'string' then v_in ->> 'purpose_description' else '' end)),
        'export_allowed', v_export
    );
    return jsonb_build_object('content', v_content, 'notices', v_notices, 'errors', pack_data_access.content_errors(v_content));
end;
$$;

-- 目錄版本的綁定（130 normalize_bound 的做法），給已整理的結果用。
create function pack_data_access.catalog_bound(p_result jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p_result || jsonb_build_object('content', (p_result -> 'content') || jsonb_build_object('catalog', pack_data_access.catalog_current()))
$$;

-- 能力落差（140 normalize_capable 的做法），給已綁定目錄的結果用。
create function pack_data_access.capability_applied(p_result jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_content jsonb := p_result -> 'content';
    v_notices jsonb := p_result -> 'notices';
    v_errors jsonb := p_result -> 'errors';
    v_gaps jsonb;
    v_gap jsonb;
    v_block boolean;
    v_pkg record;
begin
    if (v_content -> 'export_allowed') = 'true'::jsonb then
        for v_pkg in
            select s ->> 'package' as code, (pack_data_access.package_row(s ->> 'package')).system_code as system
            from jsonb_array_elements(v_content -> 'scope') as s
        loop
            continue when pack_data_access.system_capable(v_pkg.system, 'export');
            v_content := v_content || jsonb_build_object('export_allowed', false);
            v_notices := v_notices || pack_data_access.notice('DA-N-CAPABILITY-EXPORT', pack_data_access.package_label(v_pkg.code), v_pkg.system);
        end loop;
    end if;
    v_gaps := pack_data_access.capability_gaps(v_content);
    v_block := sgn_sdk.setting('data_access.capability_gap_action',
        array['tier:data_access:' || pack_data_access.classify_tier(v_content)]) #>> '{}' = 'block';
    for v_gap in select g from jsonb_array_elements(v_gaps) as g loop
        v_notices := v_notices || pack_data_access.notice('DA-N-CAPABILITY-GAP', pack_data_access.package_label(v_gap ->> 'package'),
            v_gap ->> 'system', pack_data_access.aspect_label(v_gap ->> 'aspect'),
            sgn_sdk.message('DA-T-CAP-' || upper(replace(v_gap ->> 'aspect', '_', '-')) || '-WHAT'));
        if v_block then
            v_errors := v_errors || pack_data_access.error('scope', 'DA-E-CAPABILITY-GAP', pack_data_access.package_label(v_gap ->> 'package'),
                v_gap ->> 'system', pack_data_access.aspect_label(v_gap ->> 'aspect'), pack_data_access.classify_tier(v_content));
        end if;
    end loop;
    return jsonb_build_object('content', v_content || jsonb_build_object('capability_gaps', v_gaps), 'notices', v_notices, 'errors', v_errors);
end;
$$;

-- 130、140 的兩個 hook 函式改由上面兩段組成（行為不變；舊單的模擬測試仍以它們產生沒有環境的內容）。
create or replace function pack_data_access.normalize_bound(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.catalog_bound(pack_data_access.normalize_content(p_content))
$$;

create or replace function pack_data_access.normalize_capable(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.capability_applied(pack_data_access.normalize_bound(p_content))
$$;

-- 輸入指定的環境：有鍵用鍵；沒有鍵時，系統整理過的舊內容（帶 catalog）是舊單的那一區，其他輸入是 default_when_missing 的那一區。
create function pack_data_access.input_environment(p_in jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_in ? 'environment' then jsonb_build_object('code', case when jsonb_typeof(p_in -> 'environment') = 'string' then p_in ->> 'environment' end,
            'defaulted', false)
        when jsonb_typeof(p_in -> 'catalog') = 'object' then jsonb_build_object('code', pack_data_access.content_environment('{}'::jsonb), 'defaulted', false)
        else jsonb_build_object('code', (select e.environment_code from pack_data_access.data_environment as e where e.default_when_missing),
            'defaulted', true)
    end
$$;

-- 測試依據與沒有測試紀錄的理由（只有 requires_test_basis 的區才有；引用另一張單時理由不留）。
create function pack_data_access.test_basis_normalized(p_in jsonb, p_env pack_data_access.data_environment)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_id uuid;
    v_ctx jsonb;
    v_reason text := btrim(coalesce(case when jsonb_typeof(p_in #> '{test_exception,reason}') = 'string' then p_in #>> '{test_exception,reason}' end, ''));
begin
    if not coalesce(p_env.requires_test_basis, false) then
        return jsonb_build_object('test_basis', null, 'test_exception', null);
    end if;
    if jsonb_typeof(p_in #> '{test_basis,case_id}') = 'string' and p_in #>> '{test_basis,case_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_id := (p_in #>> '{test_basis,case_id}')::uuid;
        v_ctx := sgn_sdk.case_context(v_id);
        return jsonb_build_object('test_basis', jsonb_build_object('case_id', v_id, 'case_no', v_ctx ->> 'case_no'), 'test_exception', null);
    end if;
    return jsonb_build_object('test_basis', null,
        'test_exception', case when v_reason <> '' then jsonb_build_object('reason', v_reason) end);
end;
$$;

-- 整理內容（hook，DA-ENV-FIELD、DA-ENV-TIER）：環境、依環境的分級、目錄版本、能力落差、測試依據。
create function pack_data_access.normalize_environment(p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_in jsonb := case when jsonb_typeof(p_content) = 'object' then p_content else '{}'::jsonb end;
    v_choice jsonb := pack_data_access.input_environment(v_in);
    v_env pack_data_access.data_environment := pack_data_access.environment_row(v_choice ->> 'code');
    v_r jsonb;
    v_errors jsonb := '[]'::jsonb;
    v_notices jsonb := '[]'::jsonb;
begin
    if v_env.environment_code is null or not v_env.is_active then
        v_errors := jsonb_build_array(pack_data_access.error('environment', 'DA-E-ENVIRONMENT-UNKNOWN', coalesce(v_choice ->> 'code', '')));
        v_env := pack_data_access.environment_row((select e.environment_code from pack_data_access.data_environment as e where e.default_when_missing));
    elsif (v_choice ->> 'defaulted')::boolean then
        v_notices := jsonb_build_array(pack_data_access.notice('DA-N-ENVIRONMENT-DEFAULT', v_env.name));
    end if;
    v_r := pack_data_access.capability_applied(pack_data_access.catalog_bound(pack_data_access.normalize_scoped(v_in, v_env.environment_code)));
    return jsonb_build_object(
        'content', (v_r -> 'content') || jsonb_build_object('environment', v_env.environment_code)
            || pack_data_access.test_basis_normalized(v_in, v_env),
        'notices', v_notices || (v_r -> 'notices'),
        'errors', v_errors || (v_r -> 'errors')
    );
end;
$$;

-- ── 比較、顯示 ──

-- 比較內容（hook）：換環境、換測試依據或理由一律算擴大（簽核人看到的依據變了）；其餘同 140。
create function pack_data_access.compare_environment(p_old jsonb, p_new jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when pack_data_access.content_environment(p_old) is distinct from pack_data_access.content_environment(p_new)
          or coalesce(p_old -> 'test_basis', 'null') is distinct from coalesce(p_new -> 'test_basis', 'null')
          or coalesce(p_old -> 'test_exception', 'null') is distinct from coalesce(p_new -> 'test_exception', 'null') then 'expand'
        else pack_data_access.compare_bound(p_old - 'environment' - 'test_basis' - 'test_exception', p_new - 'environment' - 'test_basis' - 'test_exception')
    end
$$;

-- 顯示摘要（hook）：多了環境、測試依據或沒有測試紀錄的理由。沒有環境鍵的舊內容不多這幾行（舊的顯示摘要不變）。
create function pack_data_access.display_environment(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.display_capable(p_content)
        || case when jsonb_typeof(p_content -> 'environment') = 'string' then jsonb_build_object('environment', jsonb_build_object(
            'code', p_content ->> 'environment',
            'name', pack_data_access.environment_label(p_content ->> 'environment'),
            'text', sgn_sdk.message('DA-T-ENV-LINE', pack_data_access.environment_label(p_content ->> 'environment'))))
           else '{}'::jsonb end
        || case when jsonb_typeof(p_content -> 'test_basis') = 'object' then jsonb_build_object('test_basis', jsonb_build_object(
            'case_no', p_content #>> '{test_basis,case_no}',
            'text', sgn_sdk.message('DA-T-TEST-BASIS-LINE', coalesce(p_content #>> '{test_basis,case_no}', '-'))))
           else '{}'::jsonb end
        || case when jsonb_typeof(p_content -> 'test_exception') = 'object' then jsonb_build_object('test_exception', jsonb_build_object(
            'reason', p_content #>> '{test_exception,reason}',
            'text', sgn_sdk.message('DA-T-TEST-EXCEPTION-LINE', p_content #>> '{test_exception,reason}')))
           else '{}'::jsonb end
$$;

-- ── 交付、驗證、對帳 ──

-- 交給外部系統的規則（同 030 的簽章）：內容有環境時規則帶 environment；舊單不帶（使用方視為正式區，已送出的位元組不變）。
create or replace function pack_data_access.build_fulfilment(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'format', 'data_access_rule_set/1',
        'case_no', c ->> 'case_no',
        'case_version_no', (c ->> 'version')::int,
        'grantee', jsonb_build_object(
            'type', c #>> '{principal,kind}',
            'principal_id', c #>> '{principal,principal_id}',
            'name', c #>> '{principal,name}'
        ),
        'valid', jsonb_build_object('from', c ->> 'valid_from', 'to', c ->> 'valid_to'),
        'export', c #> '{content,export_allowed}',
        'rules', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'rule_id', (c ->> 'case_no') || '-' || r.n,
                'system', (pack_data_access.package_row(r.p ->> 'package')).system_code,
                'package', r.p ->> 'package',
                'fields', (select jsonb_agg(f ->> 'code' order by f ->> 'code') from jsonb_array_elements(r.p -> 'fields') as f),
                'row_filter', r.p -> 'row_filters',
                'data_period', case
                    when (pack_data_access.package_row(r.p ->> 'package')).period_field_code is not null
                         and coalesce(c #> '{content,data_period}', 'null') <> 'null' then jsonb_build_object(
                        'field', (pack_data_access.package_row(r.p ->> 'package')).period_field_code,
                        'from', c #>> '{content,data_period,from}',
                        'to', c #>> '{content,data_period,to}'
                    )
                end
            ) order by r.n), '[]'::jsonb)
            from jsonb_array_elements(c #> '{content,scope}') with ordinality as r (p, n)
        )
    ) || case when jsonb_typeof(c #> '{content,environment}') = 'string' then jsonb_build_object('environment', c #>> '{content,environment}')
              else '{}'::jsonb end
    from sgn_sdk.case_context(p_case_id) as c
$$;

-- 交付結果（hook，DA-ENV-MISMATCH）：使用方系統在已簽的結果裡回報實際套用的區，和規則不同或沒有回報都不接受；之後照 130 比對目錄版本。
create function pack_data_access.check_delivery_zoned(p_case_id uuid, p_context jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_expected text := pack_data_access.rule_set_environment(p_context -> 'rule_set');
    v_reported text := p_context #>> '{result,environment}';
begin
    if v_reported is distinct from v_expected then
        return jsonb_build_object('rule_code', 'DA-ENV-MISMATCH', 'reason', 'DA-ENV-MISMATCH',
            'expected_environment', v_expected, 'reported_environment', v_reported);
    end if;
    return pack_data_access.check_delivery_result(p_case_id, p_context);
end;
$$;

-- 對帳的限制條件（同 110 的簽章）：多了區（沒有寫的是舊單的那一區）。
create or replace function pack_data_access.normalize_constraints(p_constraints jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'row_filter', coalesce((
            select jsonb_agg(jsonb_build_object(
                'filter', x ->> 'filter',
                'op', x ->> 'op',
                'values', case when x ->> 'op' = 'in'
                    then (select coalesce(jsonb_agg(v order by v #>> '{}'), '[]'::jsonb) from jsonb_array_elements(x -> 'values') as v)
                    else x -> 'values' end
            ) order by x ->> 'filter')
            from jsonb_array_elements(case when jsonb_typeof(p_constraints -> 'row_filter') = 'array' then p_constraints -> 'row_filter' else '[]' end) as x
        ), '[]'::jsonb),
        'data_period', case when jsonb_typeof(p_constraints -> 'data_period') = 'object' then jsonb_build_object(
            'field', p_constraints #>> '{data_period,field}',
            'from', p_constraints #> '{data_period,from}',
            'to', p_constraints #> '{data_period,to}'
        ) end,
        'environment', pack_data_access.rule_set_environment(p_constraints)
    )
$$;

-- 外部系統上應該存在的權限（同 110 的簽章）：限制條件帶規則的區。
create or replace function pack_data_access.expected_entitlements(p_rule_set jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'subject', p_rule_set #>> '{grantee,principal_id}',
        'resource', (r ->> 'package') || '.' || f,
        'action', a,
        'rule_id', r ->> 'rule_id',
        'case_no', p_rule_set ->> 'case_no',
        'constraints', pack_data_access.normalize_constraints(jsonb_build_object('row_filter', r -> 'row_filter', 'data_period', r -> 'data_period',
            'environment', pack_data_access.rule_set_environment(p_rule_set))),
        'valid', p_rule_set -> 'valid'
    ) order by r ->> 'rule_id', f, a), '[]'::jsonb)
    from jsonb_array_elements(p_rule_set -> 'rules') as r
    cross join jsonb_array_elements_text(r -> 'fields') as f
    cross join unnest(case when coalesce(p_rule_set -> 'export', 'null'::jsonb) = 'false'::jsonb
        then array['read'] else array['read', 'export'] end) as a
$$;

-- 外部系統的判斷（同 110 的簽章）：規則只放行同一區的查詢（查詢沒有寫區＝舊單的那一區）。
create or replace function pack_data_access.rule_allows_field(p_rule_set jsonb, p_rule jsonb, p_field text, p_query jsonb)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p_rule ->> 'package' = p_query ->> 'package'
        and pack_data_access.rule_set_environment(p_rule_set) = pack_data_access.rule_set_environment(p_query)
        and p_query ->> 'as_of' between p_rule_set #>> '{valid,from}' and p_rule_set #>> '{valid,to}'
        and p_rule -> 'fields' ? p_field
        and not exists (
            select 1 from jsonb_array_elements(p_rule -> 'row_filter') as c
            where not pack_data_access.condition_holds(c, p_query -> 'row' -> (c ->> 'filter'))
        )
        and (
            coalesce(p_rule -> 'data_period', 'null'::jsonb) = 'null'::jsonb
            or (p_query ->> 'data_date' is not null
                and p_query ->> 'data_date' between coalesce(p_rule #>> '{data_period,from}', '0000-01-01')
                                                and coalesce(p_rule #>> '{data_period,to}', '9999-12-31'))
        )
        and not (p_query ->> 'action' = 'export' and coalesce(p_rule_set -> 'export', 'null'::jsonb) = 'false'::jsonb)
$$;

-- 整份規則的案例（同 110 的簽章）：每個查詢帶這份規則的區（舊單的規則沒有區，查詢也不帶），再判斷反例是不是被同一被授權者的
-- 其他單合法放行（外部系統看的是同一區的聯集）。其餘同 110。
create or replace function pack_data_access.build_verification_cases(p_case_id uuid, p_rule_set jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_from date := (p_rule_set #>> '{valid,from}')::date;
    v_to date := (p_rule_set #>> '{valid,to}')::date;
    v_as_of date := least(greatest(v_from, sgn_sdk.today()), v_to);
    v_first jsonb := pack_data_access.rule_cases(p_rule_set #> '{rules,0}', v_as_of) -> 0;
    v_name text := pack_data_access.package_label(p_rule_set #>> '{rules,0,package}');
    v_others jsonb := pack_data_access.other_rule_sets(p_case_id, p_rule_set);
    v_zone jsonb := case when p_rule_set ? 'environment' then jsonb_build_object('environment', p_rule_set ->> 'environment') else '{}'::jsonb end;
    v_cases jsonb;
begin
    if p_case_id is null or jsonb_array_length(coalesce(p_rule_set -> 'rules', '[]')) = 0 then
        perform sgn_sdk.raise_error('DA-E-CONTENT-INVALID', 'rules');
    end if;
    select coalesce(jsonb_agg(c order by r.n, c.n), '[]'::jsonb) into v_cases
    from jsonb_array_elements(p_rule_set -> 'rules') with ordinality as r (rule, n)
    cross join lateral jsonb_array_elements(pack_data_access.rule_cases(r.rule, v_as_of)) with ordinality as c (c, n);
    if coalesce(p_rule_set -> 'export', 'null'::jsonb) <> 'null'::jsonb then
        v_cases := v_cases || jsonb_build_object('code', 'request:export',
            'expected', case when (p_rule_set ->> 'export')::boolean then 'allow' else 'deny' end,
            'query', v_first -> 'query' || jsonb_build_object('action', 'export'),
            'description', sgn_sdk.message(case when (p_rule_set ->> 'export')::boolean then 'DA-T-VC-EXPORT-ALLOWED' else 'DA-T-VC-EXPORT-DENIED' end, v_name));
    end if;
    v_cases := v_cases || jsonb_build_object('code', 'request:after_validity', 'expected', 'deny',
        'query', v_first -> 'query' || jsonb_build_object('as_of', v_to + 1),
        'description', sgn_sdk.message('DA-T-VC-AFTER', to_char(v_to + 1, 'YYYY-MM-DD'), v_name));
    return (
        select coalesce(jsonb_agg(z.c order by z.n), '[]'::jsonb)
        from (
            select c || jsonb_build_object('query', (c -> 'query') || v_zone) as c, n
            from jsonb_array_elements(v_cases) with ordinality as e (c, n)
        ) as z
        where z.c ->> 'expected' = 'allow' or not pack_data_access.rules_allow(v_others, z.c -> 'query')
    );
end;
$$;

-- 驗證案例（hook，DA-ENV-VERIFY）：140 的案例（查詢已帶這份規則的區）之後，另加「同一份規則在另一區查不到」
-- （另一區＝代碼表裡第一個啟用中的其他區）。反例若被同一被授權者在那一區的其他單合法放行就不列入。
create function pack_data_access.verification_cases_zoned(p_case_id uuid, p_rule_set jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_env text := pack_data_access.rule_set_environment(p_rule_set);
    v_other text := (select e.environment_code from pack_data_access.data_environment as e
                     where e.is_active and e.environment_code <> v_env order by e.sort_order, e.environment_code limit 1);
    v_cases jsonb := pack_data_access.verification_cases_capable(p_case_id, p_rule_set);
    v_first jsonb := (select c from jsonb_array_elements(v_cases) as c where c ->> 'expected' = 'allow' and c -> 'skip' is null limit 1);
    v_other_case jsonb;
begin
    if v_other is null or v_first is null then
        return v_cases;
    end if;
    v_other_case := jsonb_build_object('code', 'request:other_environment', 'expected', 'deny',
        'query', (v_first -> 'query') || jsonb_build_object('environment', v_other),
        'description', sgn_sdk.message('DA-T-VC-OTHER-ENV', pack_data_access.environment_label(v_other),
            pack_data_access.package_label(v_first #>> '{query,package}'), pack_data_access.environment_label(v_other)));
    if pack_data_access.rules_allow(pack_data_access.other_rule_sets(p_case_id, p_rule_set), v_other_case -> 'query') then
        return v_cases;
    end if;
    return v_cases || v_other_case;
end;
$$;

-- ── 重疊：只和同一區的授權比（DA-ENV-OVERLAP）──

-- 同 030 find_overlaps，多了「同一區」的條件。
create function pack_data_access.find_overlaps_zoned(p_case_id uuid, p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case jsonb := sgn_sdk.case_context(p_case_id);
    v_from date := (v_case ->> 'valid_from')::date;
    v_to date := (v_case ->> 'valid_to')::date;
    v_env text := pack_data_access.content_environment(p_content);
    v_items jsonb;
begin
    if v_case #>> '{principal,principal_id}' is null or v_from is null or v_to is null
       or jsonb_typeof(p_content -> 'scope') is distinct from 'array' or jsonb_array_length(p_content -> 'scope') = 0 then
        return jsonb_build_object('level', 'none', 'items', '[]'::jsonb);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'case_id', g.case_id,
        'case_no', g.case_no,
        'valid_from', g.valid_from,
        'valid_to', g.valid_to,
        'export_allowed', g.content -> 'export_allowed',
        'packages', g.touched,
        'covers', g.covers
    ) order by g.case_no), '[]'::jsonb) into v_items
    from (
        select a.*, pack_data_access.grant_touched(p_content, a.content) as touched,
               a.valid_from <= v_from and a.valid_to >= v_to and pack_data_access.grant_covers(p_content, a.content) as covers
        from sgn_sdk.active_grants('data_access', (v_case #>> '{principal,principal_id}')::uuid) as a
        where a.case_id <> p_case_id
          and not (a.valid_to < v_from or a.valid_from > v_to)
          and pack_data_access.content_environment(a.content) = v_env
    ) as g
    where jsonb_array_length(g.touched) > 0;
    if exists (select 1 from jsonb_array_elements(v_items) as i where (i -> 'covers')::boolean) then
        return jsonb_build_object('level', 'covered', 'items', (
            select jsonb_agg(i - 'covers') from jsonb_array_elements(v_items) as i where (i -> 'covers')::boolean
        ));
    end if;
    return jsonb_build_object(
        'level', case when jsonb_array_length(v_items) > 0 then 'partial' else 'none' end,
        'items', (select coalesce(jsonb_agg(i - 'covers'), '[]'::jsonb) from jsonb_array_elements(v_items) as i)
    );
end;
$$;

-- ── 送審複核（核心 K-SUBMIT-REVIEW 的 hook）──

-- 測試區的單涵蓋這次的申請：每個主題包都在、欄位都在、列條件不比這次窄（資料期間與匯出不比：測試區是過去時間的副本）。
create function pack_data_access.test_basis_covers(p_new jsonb, p_test jsonb)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select not exists (
        select 1
        from jsonb_array_elements(p_new -> 'scope') as pn
        left join jsonb_array_elements(p_test -> 'scope') as pt on pt ->> 'package' = pn ->> 'package'
        where pt is null
           or exists (
               select 1 from jsonb_array_elements(pn -> 'fields') as fn
               where not exists (select 1 from jsonb_array_elements(pt -> 'fields') as ft where ft ->> 'code' = fn ->> 'code')
           )
           or not pack_data_access.filters_within(pn -> 'row_filters', pt -> 'row_filters')
    )
$$;

-- 引用的測試區單哪裡不能當依據（訊息代碼）；可以回 null。
create function pack_data_access.test_basis_problem(p_case jsonb, p_content jsonb, p_basis_id uuid)
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_basis jsonb := sgn_sdk.case_context(p_basis_id);
begin
    if v_basis is null or v_basis ->> 'process_type' <> 'data_access' or p_basis_id = (p_case ->> 'case_id')::uuid then
        return 'DA-T-BASIS-UNKNOWN';
    end if;
    if not coalesce((pack_data_access.environment_row(pack_data_access.content_environment(v_basis -> 'content'))).is_test_source, false) then
        return 'DA-T-BASIS-NOT-TEST';
    end if;
    if sgn_sdk.case_grant(p_basis_id) is null then
        return 'DA-T-BASIS-NEVER-ACTIVE';
    end if;
    if v_basis ->> 'applicant_id' is distinct from p_case ->> 'applicant_id'
       and v_basis #>> '{principal,principal_id}' is distinct from p_case #>> '{principal,principal_id}' then
        return 'DA-T-BASIS-UNRELATED';
    end if;
    if not pack_data_access.test_basis_covers(p_content, v_basis -> 'content') then
        return 'DA-T-BASIS-NOT-COVERING';
    end if;
    return null;
end;
$$;

create function pack_data_access.review_submission(p_case_id uuid, p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case jsonb := sgn_sdk.case_context(p_case_id);
    v_env pack_data_access.data_environment := pack_data_access.environment_row(pack_data_access.content_environment(p_content));
    v_max int := (sgn_sdk.setting('data_access.environment_validity_max_months', array['environment:data_access:' || v_env.environment_code]) #>> '{}')::int;
    v_errors jsonb := '[]'::jsonb;
    v_exceptions jsonb := '[]'::jsonb;
    v_problem text;
begin
    -- DA-ENV-VALIDITY：依環境的期限上限
    if (v_case ->> 'valid_to')::date >= ((v_case ->> 'valid_from')::date + make_interval(months => v_max))::date then
        v_errors := v_errors || pack_data_access.error('terms.valid_to', 'DA-E-ENV-VALIDITY', v_env.name, v_max::text);
    end if;
    -- DA-ENV-TEST-BASIS、DA-TEST-EXCEPTION（舊單沒有環境鍵：升版前建立的內容不追加這條新規則，照樣能送審與簽核）
    if v_env.requires_test_basis and p_content ? 'environment' then
        if jsonb_typeof(p_content -> 'test_basis') = 'object' then
            v_problem := pack_data_access.test_basis_problem(v_case, p_content, (p_content #>> '{test_basis,case_id}')::uuid);
            if v_problem is not null then
                v_errors := v_errors || pack_data_access.error('test_basis', 'DA-E-TEST-BASIS-INVALID',
                    coalesce(p_content #>> '{test_basis,case_no}', '-'), sgn_sdk.message(v_problem));
            end if;
        elsif jsonb_typeof(p_content -> 'test_exception') = 'object' then
            v_exceptions := v_exceptions || jsonb_build_object('rule_code', 'DA-TEST-EXCEPTION', 'detail', jsonb_build_object(
                'environment', v_env.environment_code, 'reason', p_content #>> '{test_exception,reason}',
                'rules', jsonb_build_array('DA-ENV-TEST-BASIS', 'DA-TEST-EXCEPTION')));
        else
            v_errors := v_errors || pack_data_access.error('test_basis', 'DA-E-TEST-BASIS-REQUIRED', v_env.name);
        end if;
    end if;
    return jsonb_build_object('errors', v_errors, 'exceptions', v_exceptions,
        'settings', jsonb_build_object('data_access.environment_validity_max_months', v_max));
end;
$$;

-- ── 新申請畫面 ──

-- 新申請畫面用的資料目錄（同 040 的簽章）：多了環境的選項與每個欄位在各區的分級。
create or replace function api.data_access_catalog(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_sdk.session_person(p_session);
    return jsonb_build_object(
        'packages', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', p.package_code,
                'name', p.name,
                'period_field', p.period_field_code,
                'fields', (
                    select jsonb_agg(jsonb_build_object('code', f.field_code, 'name', f.name, 'classification', f.classification,
                        'environments', (
                            select coalesce(jsonb_agg(jsonb_build_object('environment', z.environment_code, 'classification', z.classification,
                                'treatment_name', sgn_sdk.message('DA-T-TREATMENT-' || upper(z.treatment))) order by z.environment_code), '[]'::jsonb)
                            from pack_data_access.catalog_field_environment as z
                            where z.package_code = f.package_code and z.field_code = f.field_code
                        ))
                        order by f.sort_order)
                    from pack_data_access.catalog_field as f
                    where f.package_code = p.package_code and f.is_active
                ),
                'filters', (
                    select coalesce(jsonb_agg(jsonb_build_object(
                        'code', r.filter_code,
                        'name', r.name,
                        'value_type', r.value_type,
                        'values', (
                            select coalesce(jsonb_agg(jsonb_build_object('value', v.value, 'label', v.label) order by v.sort_order), '[]'::jsonb)
                            from pack_data_access.catalog_filter_value as v
                            where v.package_code = r.package_code and v.filter_code = r.filter_code and v.is_active
                        )
                    ) order by r.sort_order), '[]'::jsonb)
                    from pack_data_access.catalog_filter as r
                    where r.package_code = p.package_code and r.is_active
                )
            ) order by p.sort_order), '[]'::jsonb)
            from pack_data_access.catalog_package as p
            where p.is_active
        ),
        'purpose_categories', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', c.category_code,
                'name', c.name,
                'requires_description', c.requires_description
            ) order by c.sort_order), '[]'::jsonb)
            from pack_data_access.purpose_category as c
            where c.is_active
        ),
        'environments', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', e.environment_code,
                'name', e.name,
                'description', e.description,
                'requires_test_basis', e.requires_test_basis,
                'is_default', e.default_when_missing,
                'applies_to_legacy', e.applies_to_legacy,
                'max_months', (sgn_sdk.setting('data_access.environment_validity_max_months',
                    array['environment:data_access:' || e.environment_code]) #>> '{}')::int
            ) order by e.sort_order), '[]'::jsonb)
            from pack_data_access.data_environment as e
            where e.is_active
        )
    );
end;
$$;

comment on function api.data_access_catalog(text) is
    '新申請畫面用的資料目錄：主題包、欄位（含分級與各區已去識別或遮罩後的分級；L1、L2 欄位顯示為自動給）、列條件欄位與可選的值、期間欄位、'
    '使用情境分類，以及環境的選項（是否要測試依據、期限上限）。呼叫者：sgn_app。規則：DA-SCOPE-STRUCTURED、DA-TIER-AUTO-GRANT、DA-PURPOSE、'
    'DA-ENV-FIELD、DA-ENV-TIER、DA-ENV-VALIDITY';

-- 可以當測試依據的單：看的人申請的、或這個被授權者的測試區單，曾經生效過。最新的在前。
create function api.data_access_test_bases(p_session text, p_principal_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'case_id', c.case_id,
        'case_no', c.case_no,
        'state', c.state,
        'principal_name', x #>> '{principal,name}',
        'valid_from', g ->> 'valid_from',
        'valid_to', g ->> 'valid_to',
        'packages', (select coalesce(jsonb_agg(pack_data_access.package_label(s ->> 'package') order by s ->> 'package'), '[]'::jsonb)
                     from jsonb_array_elements(c.content -> 'scope') as s)
    ) order by c.case_no desc), '[]'::jsonb)
    from sgn_sdk.cases_in_states('data_access', array['verifying', 'active', 'expired', 'revoked']) as c
    cross join lateral (select sgn_sdk.case_context(c.case_id) as x, sgn_sdk.case_grant(c.case_id) as g) as k
    where g is not null
      and coalesce((pack_data_access.environment_row(pack_data_access.content_environment(c.content))).is_test_source, false)
      and (c.applicant_id = sgn_sdk.session_person(p_session) or x #>> '{principal,principal_id}' = p_principal_id::text)
$$;

comment on function api.data_access_test_bases(text, uuid) is
    '新申請畫面：申請正式區時可以引用的測試區單（看的人申請的、或同一個被授權者的，曾經生效過）。涵蓋與否在送審時判定。'
    '呼叫者：sgn_app。規則：DA-ENV-TEST-BASIS';

-- ── 登記 ──

select sgn_sdk.register_hook('data_access', h.hook, h.fn)
from (values
    ('normalize_content', 'pack_data_access.normalize_environment'),
    ('compare_content', 'pack_data_access.compare_environment'),
    ('display_content', 'pack_data_access.display_environment'),
    ('check_delivery_result', 'pack_data_access.check_delivery_zoned'),
    ('build_verification_cases', 'pack_data_access.verification_cases_zoned'),
    ('find_overlaps', 'pack_data_access.find_overlaps_zoned'),
    ('review_submission', 'pack_data_access.review_submission')
) as h (hook, fn);

select sgn_sdk.register_rule(r.code, r.description, 'data_access', r.coverage, r.note)
from (values
    ('DA-ENV-FIELD', '環境（測試區、正式區，代碼表）是申請內容的必填欄位，一張單一個環境，進版本雜湊與顯示摘要；舊單視為正式區、雜湊不重算；'
        '新的輸入沒有指定時以測試區處理並提示', 'full', null),
    ('DA-ENV-TIER', '級別由資料目錄逐欄、逐環境決定：預設兩區同級，目錄標示該欄在某一區已去識別或遮罩時才用那一區的分級；申請人不能自稱。'
        '目錄版本涵蓋這個標示', 'full', null),
    ('DA-ENV-MISMATCH', '交付的規則帶環境；使用方系統在已簽的套用與驗證結果回報實際套用的區，不同或沒有回報就不生效並開例外', 'full', null),
    ('DA-ENV-VERIFY', '自動驗證的查詢帶這張單的區，另加反例「同一份規則在另一區查不到」', 'full', null),
    ('DA-ENV-OVERLAP', '重疊與完全涵蓋只和同一區的有效授權比；對帳的限制條件帶區', 'full', null),
    ('DA-ENV-TEST-BASIS', '正式區的單送審時必須引用一張涵蓋它的測試區單（同申請人或同被授權者、主題包與欄位涵蓋、列條件不比它窄、曾經生效），'
        '沒有可引用的單時必須填理由', 'full', null),
    ('DA-TEST-EXCEPTION', '正式區的單沒有測試紀錄時，送審後開例外並帶理由，簽核人在決定畫面看得到', 'partial',
        '核准後限期補上線後使用報告、逾期升級（D94 (4)）見 DA-TEST-REPORT-FOLLOWUP'),
    ('DA-ENV-VALIDITY', '授權期間的上限依環境（參數 data_access.environment_validity_max_months，適用範圍 environment）；測試區較短', 'full', null)
) as r (code, description, coverage, note);

-- 升版時：目錄已有內容就以新的快照格式產生一個版本（使用方系統從這一版起回報 /2 的雜湊）。
select pack_data_access.catalog_record('migration 150_environment');

revoke all on all functions in schema pack_data_access from public;
