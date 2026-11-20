-- 資料授權專屬的對外 function（骨幹 1.1：放在 api，以流程包代號為前綴）。

create function api.data_access_catalog(p_session text)
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
                    select jsonb_agg(jsonb_build_object('code', f.field_code, 'name', f.name, 'classification', f.classification)
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
        )
    );
end;
$$;

comment on function api.data_access_catalog(text) is
    '新申請畫面用的資料目錄：主題包、欄位（含分級；L1、L2 欄位顯示為自動給）、列條件欄位與可選的值、期間欄位，以及使用情境分類。'
    '呼叫者：sgn_app。規則：DA-SCOPE-STRUCTURED、DA-TIER-AUTO-GRANT、DA-PURPOSE';
