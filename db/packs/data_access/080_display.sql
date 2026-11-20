-- 資料授權的顯示 hook（裁決 D75）：簽核畫面上的每一個字由資料庫從自己的目錄產生，頁面只畫這一份、簽這一份的雜湊。
-- 名稱一律取目錄裡的名稱（停用的欄位與主題包仍有名稱）；分級取內容裡記下的分級（決定級別的那一份，DA-TIER-MAX）。
-- 只輸出字串、布林、null、陣列與物件（數值與日期一律換成文字），讓資料庫與瀏覽器的標準化結果相同。

create function pack_data_access.field_label(p_package_code text, p_field_code text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        (select f.name from pack_data_access.catalog_field as f where f.package_code = p_package_code and f.field_code = p_field_code),
        p_field_code
    )
$$;

-- 一個列條件的顯示：條件欄位的名稱、運算、每個值與它的標籤（列舉取目錄的標籤，數字與日期就是值本身）。
create function pack_data_access.filter_display(p_package_code text, p_condition jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'filter', p_condition ->> 'filter',
        'filter_name', coalesce(
            (select r.name from pack_data_access.catalog_filter as r
             where r.package_code = p_package_code and r.filter_code = p_condition ->> 'filter'),
            p_condition ->> 'filter'
        ),
        'op', p_condition ->> 'op',
        'values', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'value', v.value #>> '{}',
                'label', coalesce(
                    (select fv.label from pack_data_access.catalog_filter_value as fv
                     where fv.package_code = p_package_code and fv.filter_code = p_condition ->> 'filter' and fv.value = v.value #>> '{}'),
                    v.value #>> '{}'
                )
            ) order by v.n), '[]'::jsonb)
            from jsonb_array_elements(
                case when jsonb_typeof(p_condition -> 'values') = 'array' then p_condition -> 'values' else '[]'::jsonb end
            ) with ordinality as v (value, n)
        )
    )
$$;

-- 一個主題包的顯示：名稱、欄位（名稱與分級）、列條件。p_fields 可以是 {code, classification} 物件或欄位代碼。
create function pack_data_access.package_display(p_item jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'package', p_item ->> 'package',
        'package_name', pack_data_access.package_label(p_item ->> 'package'),
        'fields', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', coalesce(f.value ->> 'code', f.value #>> '{}'),
                'name', pack_data_access.field_label(p_item ->> 'package', coalesce(f.value ->> 'code', f.value #>> '{}')),
                'classification', f.value ->> 'classification'
            ) order by f.n), '[]'::jsonb)
            from jsonb_array_elements(
                case when jsonb_typeof(p_item -> 'fields') = 'array' then p_item -> 'fields' else '[]'::jsonb end
            ) with ordinality as f (value, n)
        ),
        'row_filters', (
            select coalesce(jsonb_agg(pack_data_access.filter_display(p_item ->> 'package', c.value) order by c.n), '[]'::jsonb)
            from jsonb_array_elements(
                case when jsonb_typeof(p_item -> 'row_filters') = 'array' then p_item -> 'row_filters' else '[]'::jsonb end
            ) with ordinality as c (value, n)
        )
    )
$$;

create function pack_data_access.display_content(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'scope', (
            select coalesce(jsonb_agg(pack_data_access.package_display(s.value) order by s.n), '[]'::jsonb)
            from jsonb_array_elements(
                case when jsonb_typeof(p_content -> 'scope') = 'array' then p_content -> 'scope' else '[]'::jsonb end
            ) with ordinality as s (value, n)
        ),
        'data_period', case when jsonb_typeof(p_content -> 'data_period') = 'object' then jsonb_build_object(
            'from', p_content #>> '{data_period,from}',
            'to', p_content #>> '{data_period,to}'
        ) end,
        'purpose', jsonb_build_object(
            'category', p_content ->> 'purpose_category',
            'category_name', coalesce(
                (select c.name from pack_data_access.purpose_category as c where c.category_code = p_content ->> 'purpose_category'),
                p_content ->> 'purpose_category'
            ),
            'description', p_content ->> 'purpose_description'
        ),
        'export_allowed', coalesce(p_content -> 'export_allowed' = 'true'::jsonb, false)
    )
$$;

-- 重疊的項目（find_overlaps 的 items）：單號、授權起迄、重疊的主題包與欄位（名稱）。
create function pack_data_access.display_overlap(p_items jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'case_no', i.value ->> 'case_no',
        'valid_from', i.value ->> 'valid_from',
        'valid_to', i.value ->> 'valid_to',
        'packages', (
            select coalesce(jsonb_agg(pack_data_access.package_display(p.value) order by p.n), '[]'::jsonb)
            from jsonb_array_elements(
                case when jsonb_typeof(i.value -> 'packages') = 'array' then i.value -> 'packages' else '[]'::jsonb end
            ) with ordinality as p (value, n)
        )
    ) order by i.n), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality as i (value, n)
$$;

select sgn_sdk.register_hook('data_access', 'display_content', 'pack_data_access.display_content');
select sgn_sdk.register_hook('data_access', 'display_overlap', 'pack_data_access.display_overlap');

revoke all on all functions in schema pack_data_access from public;
