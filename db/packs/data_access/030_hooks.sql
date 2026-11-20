-- 資料授權的 hook（骨幹 6.4；契約 §5）。核心以登記的名稱呼叫，簽章由核心的 hook 定義表固定：
--   normalize_content  整理內容並檢查（契約 §5.1＋§5.2；這一版把檢查併在整理裡，結果放在 errors）
--   classify_tier      級別取所選欄位的最高分級（§5.3）
--   compare_content    兩版內容是 same、reduce 還是 expand（§5.4）
--   find_overlaps      與同一被授權者的有效授權比對（§5.7）
--   stage_scopes       資料擁有者關：每個主題包的擁有者範圍；執行關：主題包所在的受管系統
--   build_fulfilment   交給外部系統的規則（§5.10，另加每條規則的受管系統）
-- 訊息一律從核心的訊息目錄取（sgn_sdk.message），不寫死文字。

-- ── 目錄的讀取 ──

create function pack_data_access.package_row(p_package_code text)
returns pack_data_access.catalog_package
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from pack_data_access.catalog_package where package_code = p_package_code and is_active
$$;

create function pack_data_access.package_label(p_package_code text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce((select p.name from pack_data_access.catalog_package as p where p.package_code = p_package_code), p_package_code)
$$;

create function pack_data_access.filter_row(p_package_code text, p_filter_code text)
returns pack_data_access.catalog_filter
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from pack_data_access.catalog_filter
    where package_code = p_package_code and filter_code = p_filter_code and is_active
$$;

create function pack_data_access.export_requestable(p_tier text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (sgn_sdk.setting('data_access.export_requestable', array['tier:data_access:' || p_tier, 'process:data_access']) #>> '{}')::boolean
$$;

create function pack_data_access.notice(p_code text, variadic p_args text[] default '{}')
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('code', p_code, 'message', sgn_sdk.message(p_code, variadic p_args))
$$;

create function pack_data_access.error(p_path text, p_code text, variadic p_args text[] default '{}')
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('path', p_path, 'code', p_code, 'message', sgn_sdk.message(p_code, variadic p_args))
$$;

-- ── classify_tier（DA-TIER-MAX）：只看內容裡的 classification，無法判定時從嚴取 L4 ──

create function pack_data_access.classify_tier(p_content jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    with fields as (
        select f
        from jsonb_array_elements(case when jsonb_typeof(p_content -> 'scope') = 'array' then p_content -> 'scope' else '[]' end) as p
        cross join lateral jsonb_array_elements(case when jsonb_typeof(p -> 'fields') = 'array' then p -> 'fields' else '[]' end) as f
    )
    select case
        when not exists (select 1 from fields) then 'L3'
        when exists (select 1 from fields where jsonb_typeof(f) <> 'object' or f ->> 'classification' not in ('L3', 'L4')) then 'L4'
        when exists (select 1 from fields where f ->> 'classification' = 'L4') then 'L4'
        else 'L3'
    end
$$;

-- ── normalize_content（DA-TIER-AUTO-GRANT、DA-SCOPE-STRUCTURED、DA-EXPORT-TIER、DA-NO-MEDIUM）──

-- 一個列條件只留 filter、op、values，依目錄的值型別改成唯一的寫法（enum 用 in；number、date 用 between）。
create function pack_data_access.filter_normalized(p_package_code text, p_condition jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_filter pack_data_access.catalog_filter := pack_data_access.filter_row(p_package_code, p_condition ->> 'filter');
    v_op text := p_condition ->> 'op';
    v_values jsonb := case
        when jsonb_typeof(p_condition -> 'values') = 'array' then p_condition -> 'values'
        else jsonb_build_array(p_condition -> 'values')
    end;
begin
    if v_filter.value_type = 'enum' and v_op in ('eq', 'in') then
        v_op := 'in';
        v_values := (select coalesce(jsonb_agg(distinct v order by v), '[]'::jsonb) from jsonb_array_elements(v_values) as v);
    elsif v_filter.value_type in ('number', 'date') and v_op = 'eq' and jsonb_array_length(v_values) = 1 then
        v_op := 'between';
        v_values := jsonb_build_array(v_values -> 0, v_values -> 0);
    end if;
    return jsonb_build_object('filter', p_condition -> 'filter', 'op', v_op, 'values', v_values);
end;
$$;

-- 一個主題包：欄位查目錄，L1、L2 與不存在的移除並提示。回傳 {package（null＝整個移除）, notices}。
create function pack_data_access.package_normalized(p_package_code text, p_fields jsonb, p_filters jsonb)
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
        if v_field.field_code is null then
            v_notices := v_notices || pack_data_access.notice('DA-N-FIELD-UNAVAILABLE', v_pkg.name, v_code);
        elsif v_field.classification in ('L1', 'L2') then
            v_notices := v_notices || pack_data_access.notice('DA-N-AUTO-GRANTED', v_pkg.name, v_field.name, v_field.classification);
        else
            v_kept := v_kept || jsonb_build_object('code', v_code, 'classification', v_field.classification);
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

-- 輸入的資料範圍依主題包分組（位元組順序）；沒有 package 的元素捨棄。
create function pack_data_access.scope_grouped(p_scope jsonb)
returns table (package_code text, fields jsonb, filters jsonb)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    with items as (
        select x.o, x.p
        from jsonb_array_elements(case when jsonb_typeof(p_scope) = 'array' then p_scope else '[]' end) with ordinality as x (p, o)
        where jsonb_typeof(x.p -> 'package') = 'string'
    )
    select
        k.package_code,
        (
            select coalesce(jsonb_agg(f.v order by i.o, f.n), '[]'::jsonb)
            from items as i
            cross join lateral jsonb_array_elements(case when jsonb_typeof(i.p -> 'fields') = 'array' then i.p -> 'fields' else '[]' end)
                with ordinality as f (v, n)
            where i.p ->> 'package' = k.package_code
        ),
        (
            select coalesce(jsonb_agg(c.v order by i.o, c.n), '[]'::jsonb)
            from items as i
            cross join lateral jsonb_array_elements(case when jsonb_typeof(i.p -> 'row_filters') = 'array' then i.p -> 'row_filters' else '[]' end)
                with ordinality as c (v, n)
            where i.p ->> 'package' = k.package_code
        )
    from (select distinct i.p ->> 'package' as package_code from items as i) as k
    order by k.package_code collate "C"
$$;

create function pack_data_access.normalize_content(p_content jsonb)
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
    -- 同一個主題包出現多次就合併：欄位取聯集、列條件依序串接（移除列條件等於擴大，所以不合併條件）
    for v_group in select * from pack_data_access.scope_grouped(v_in -> 'scope') loop
        v_result := pack_data_access.package_normalized(v_group.package_code, v_group.fields, v_group.filters);
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
    -- 只留表上的鍵：申請內容不記錄媒介（DA-NO-MEDIUM）
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

-- ── 送審前必須成立的檢查（契約 §5.2 對整理後內容仍然有意義的項目）──

-- 一個列條件的值錯在哪裡；沒錯回 null。
create function pack_data_access.filter_value_problem(p_filter pack_data_access.catalog_filter, p_values jsonb)
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_bad text;
    v_set jsonb;
begin
    if p_filter.value_type = 'enum' then
        if jsonb_array_length(p_values) = 0 then
            return sgn_sdk.message('DA-T-FV-EMPTY');
        end if;
        select v #>> '{}' into v_bad
        from jsonb_array_elements(p_values) as v
        where jsonb_typeof(v) <> 'string'
           or not exists (
               select 1 from pack_data_access.catalog_filter_value as d
               where d.package_code = p_filter.package_code and d.filter_code = p_filter.filter_code
                 and d.value = v #>> '{}' and d.is_active
           )
        limit 1;
        return case when v_bad is not null then sgn_sdk.message('DA-T-FV-NOT-IN-DOMAIN', v_bad) end;
    end if;
    if jsonb_array_length(p_values) <> 2 or (jsonb_typeof(p_values -> 0) = 'null' and jsonb_typeof(p_values -> 1) = 'null') then
        return sgn_sdk.message('DA-T-FV-BOUNDS');
    end if;
    v_set := pack_data_access.condition_set(jsonb_build_object('op', 'between', 'values', p_values));
    if v_set ->> 'kind' = p_filter.value_type then
        return null;
    end if;
    if exists (
        select 1 from jsonb_array_elements(p_values) as v
        where jsonb_typeof(v) <> 'null'
          and not (case p_filter.value_type when 'number' then jsonb_typeof(v) = 'number' else pack_data_access.is_date_text(v) end)
    ) then
        return sgn_sdk.message(case p_filter.value_type when 'number' then 'DA-T-FV-NUMBER' else 'DA-T-FV-DATE' end);
    end if;
    return sgn_sdk.message('DA-T-FV-ORDER');
end;
$$;

-- 一個主題包的列條件檢查（DA-SCOPE-STRUCTURED）。
create function pack_data_access.filter_errors(p_index int, p_package jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_errors jsonb := '[]'::jsonb;
    v_condition jsonb;
    v_pos int;
    v_filter pack_data_access.catalog_filter;
    v_seen text[] := '{}'::text[];
    v_path text;
    v_problem text;
begin
    for v_condition, v_pos in
        select c, o::int - 1 from jsonb_array_elements(p_package -> 'row_filters') with ordinality as x (c, o)
    loop
        v_path := format('scope[%s].row_filters[%s]', p_index, v_pos);
        v_filter := pack_data_access.filter_row(p_package ->> 'package', v_condition ->> 'filter');
        if v_filter.filter_code is null then
            v_errors := v_errors || pack_data_access.error(
                v_path || '.filter', 'DA-E-FILTER-UNKNOWN',
                pack_data_access.package_label(p_package ->> 'package'), coalesce(v_condition ->> 'filter', '')
            );
            continue;
        end if;
        if v_filter.filter_code = any (v_seen) then
            v_errors := v_errors || pack_data_access.error(v_path || '.filter', 'DA-E-FILTER-DUPLICATE', v_filter.name);
            continue;
        end if;
        v_seen := v_seen || v_filter.filter_code;
        if v_condition ->> 'op' is distinct from (case v_filter.value_type when 'enum' then 'in' else 'between' end) then
            v_errors := v_errors || pack_data_access.error(v_path || '.op', 'DA-E-FILTER-OP', v_filter.name);
            continue;
        end if;
        v_problem := pack_data_access.filter_value_problem(v_filter, v_condition -> 'values');
        if v_problem is not null then
            v_errors := v_errors || pack_data_access.error(v_path || '.values', 'DA-E-FILTER-VALUE', v_filter.name, v_problem);
        end if;
    end loop;
    return v_errors;
end;
$$;

create function pack_data_access.content_errors(p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_errors jsonb := '[]'::jsonb;
    v_package jsonb;
    v_index int;
    v_category pack_data_access.purpose_category;
    v_needs_period boolean := false;
    v_period jsonb := p_content -> 'data_period';
begin
    if jsonb_array_length(p_content -> 'scope') = 0 then
        v_errors := v_errors || pack_data_access.error('scope', 'DA-E-SCOPE-EMPTY');
    end if;
    for v_package, v_index in select p, o::int - 1 from jsonb_array_elements(p_content -> 'scope') with ordinality as x (p, o) loop
        -- DA-STAGE-OWNER：每個主題包都要有在職的資料擁有者才能送審
        if cardinality(sgn_sdk.role_holders('data_owner', pack_data_access.owner_scope(v_package ->> 'package'))) = 0 then
            v_errors := v_errors || pack_data_access.error(
                format('scope[%s].package', v_index), 'DA-E-OWNER-MISSING', pack_data_access.package_label(v_package ->> 'package')
            );
        end if;
        v_errors := v_errors || pack_data_access.filter_errors(v_index, v_package);
        v_needs_period := v_needs_period or (pack_data_access.package_row(v_package ->> 'package')).period_field_code is not null;
    end loop;
    -- DA-DATA-PERIOD：選到有期間欄位的主題包時，資料期間必填
    if v_needs_period and not (
        jsonb_typeof(v_period) = 'object'
        and pack_data_access.is_date_text(v_period -> 'from')
        and pack_data_access.is_date_text(v_period -> 'to')
    ) then
        v_errors := v_errors || pack_data_access.error('data_period', 'DA-E-PERIOD-REQUIRED');
    elsif jsonb_typeof(v_period) = 'object' and not pack_data_access.period_valid(v_period) then
        v_errors := v_errors || pack_data_access.error('data_period', 'DA-E-PERIOD-ORDER');
    end if;
    -- DA-PURPOSE
    select * into v_category from pack_data_access.purpose_category
    where category_code = p_content ->> 'purpose_category' and is_active;
    if v_category.category_code is null then
        v_errors := v_errors || pack_data_access.error('purpose_category', 'DA-E-PURPOSE-CATEGORY');
    elsif v_category.requires_description and p_content ->> 'purpose_description' = '' then
        v_errors := v_errors || pack_data_access.error('purpose_description', 'DA-E-PURPOSE-DESCRIPTION', v_category.name);
    end if;
    return v_errors;
end;
$$;

-- ── compare_content（DA-CHANGE-COMPARE、DA-CHANGE-PURPOSE）──

create function pack_data_access.scope_wellformed(p_scope jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_typeof(p_scope) = 'array'
       and not exists (
           select 1 from jsonb_array_elements(p_scope) as p
           where jsonb_typeof(p -> 'package') is distinct from 'string'
              or jsonb_typeof(p -> 'fields') is distinct from 'array'
              or exists (
                  select 1 from jsonb_array_elements(p -> 'fields') as f
                  where jsonb_typeof(f) <> 'object' or f ->> 'code' is null or f ->> 'classification' is null
              )
       )
       and (select count(*) = count(distinct p ->> 'package') from jsonb_array_elements(p_scope) as p)
$$;

-- 新版的一個主題包相對舊版：expand（新增主題包、欄位、分級變動、列條件放寬）、reduce 或 same。
create function pack_data_access.package_change(p_new jsonb, p_old_scope jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_old jsonb := (select p from jsonb_array_elements(p_old_scope) as p where p ->> 'package' = p_new ->> 'package');
    v_relation text;
begin
    if v_old is null then
        return 'expand';
    end if;
    -- 每個欄位都要在舊版、且分級相同（分級變動要由正確路徑上的人重新確認）
    if exists (
        select 1 from jsonb_array_elements(p_new -> 'fields') as f
        where not (v_old -> 'fields') @> jsonb_build_array(jsonb_build_object('code', f ->> 'code', 'classification', f ->> 'classification'))
    ) then
        return 'expand';
    end if;
    v_relation := pack_data_access.filters_relation(coalesce(p_new -> 'row_filters', '[]'), coalesce(v_old -> 'row_filters', '[]'));
    if v_relation = 'other' then
        return 'expand';
    end if;
    return case
        when v_relation = 'stricter' or jsonb_array_length(p_new -> 'fields') < jsonb_array_length(v_old -> 'fields') then 'reduce'
        else 'same'
    end;
end;
$$;

create function pack_data_access.compare_content(p_old jsonb, p_new jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_kinds text[] := '{}'::text[];
    v_period text;
begin
    if p_old = p_new then
        return 'same';
    end if;
    if p_old -> 'purpose_category' is distinct from p_new -> 'purpose_category'
       or p_old -> 'purpose_description' is distinct from p_new -> 'purpose_description' then
        return 'expand';
    end if;
    if p_old -> 'export_allowed' is distinct from p_new -> 'export_allowed' then
        if p_old -> 'export_allowed' = 'true'::jsonb and p_new -> 'export_allowed' = 'false'::jsonb then
            v_kinds := v_kinds || 'reduce'::text;
        else
            return 'expand';
        end if;
    end if;
    if not pack_data_access.scope_wellformed(p_old -> 'scope') or not pack_data_access.scope_wellformed(p_new -> 'scope') then
        return 'expand';
    end if;
    v_kinds := v_kinds || array(
        select pack_data_access.package_change(p, p_old -> 'scope') from jsonb_array_elements(p_new -> 'scope') as p
    );
    if exists (
        select 1 from jsonb_array_elements(p_old -> 'scope') as o
        where not exists (select 1 from jsonb_array_elements(p_new -> 'scope') as n where n ->> 'package' = o ->> 'package')
    ) then
        v_kinds := v_kinds || 'reduce'::text;
    end if;
    v_period := pack_data_access.period_relation(
        nullif(p_new -> 'data_period', 'null'::jsonb), nullif(p_old -> 'data_period', 'null'::jsonb)
    );
    v_kinds := v_kinds || case v_period when 'other' then 'expand' when 'stricter' then 'reduce' else 'same' end;
    return case
        when 'expand' = any (v_kinds) then 'expand'
        when 'reduce' = any (v_kinds) then 'reduce'
        else 'same'
    end;
end;
$$;

-- ── find_overlaps（DA-OVERLAP-COVERED、DA-OVERLAP-PARTIAL）──

-- 一筆有效授權和本次申請重疊的主題包與共同欄位；沒有重疊回空陣列。
create function pack_data_access.grant_touched(p_new jsonb, p_grant_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'package', pn ->> 'package',
        'fields', (
            select jsonb_agg(fn ->> 'code' order by fn ->> 'code')
            from jsonb_array_elements(pn -> 'fields') as fn
            where exists (select 1 from jsonb_array_elements(pg -> 'fields') as fg where fg ->> 'code' = fn ->> 'code')
        )
    ) order by pn ->> 'package'), '[]'::jsonb)
    from jsonb_array_elements(p_new -> 'scope') as pn
    join jsonb_array_elements(p_grant_content -> 'scope') as pg on pg ->> 'package' = pn ->> 'package'
    where exists (
        select 1 from jsonb_array_elements(pn -> 'fields') as fn
        join jsonb_array_elements(pg -> 'fields') as fg on fg ->> 'code' = fn ->> 'code'
    )
      and not pack_data_access.filters_disjoint(pn -> 'row_filters', pg -> 'row_filters')
      and not (
          (pack_data_access.package_row(pn ->> 'package')).period_field_code is not null
          and pack_data_access.period_disjoint(p_new -> 'data_period', p_grant_content -> 'data_period')
      )
$$;

-- 單獨一筆授權完全涵蓋本次申請（內容的部分；有效期間由呼叫者比較）。
create function pack_data_access.grant_covers(p_new jsonb, p_grant_content jsonb)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (p_new -> 'export_allowed' = 'false'::jsonb or p_grant_content -> 'export_allowed' = 'true'::jsonb)
       and not exists (
           select 1
           from jsonb_array_elements(p_new -> 'scope') as pn
           left join jsonb_array_elements(p_grant_content -> 'scope') as pg on pg ->> 'package' = pn ->> 'package'
           where pg is null
              or exists (
                  select 1 from jsonb_array_elements(pn -> 'fields') as fn
                  where not exists (select 1 from jsonb_array_elements(pg -> 'fields') as fg where fg ->> 'code' = fn ->> 'code')
              )
              or not pack_data_access.filters_within(pn -> 'row_filters', pg -> 'row_filters')
              or not (
                  (pack_data_access.package_row(pn ->> 'package')).period_field_code is null
                  or coalesce(p_grant_content -> 'data_period', 'null') = 'null'
                  or pack_data_access.period_relation(p_new -> 'data_period', p_grant_content -> 'data_period') in ('equal', 'stricter')
              )
       )
$$;

create function pack_data_access.find_overlaps(p_case_id uuid, p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case jsonb := sgn_sdk.case_context(p_case_id);
    v_from date := (v_case ->> 'valid_from')::date;
    v_to date := (v_case ->> 'valid_to')::date;
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
    ) as g
    where jsonb_array_length(g.touched) > 0;
    -- 多筆授權合起來才涵蓋時，無法證明 DC 會怎麼合併，一律算部分重疊（契約 §5.7）
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

-- ── stage_scopes（DA-STAGE-OWNER、DA-FULFIL-CUSTODIAN）──

create function pack_data_access.stage_scopes(p_stage_code text, p_content jsonb)
returns setof text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select distinct s.scope_ref
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'scope') = 'array' then p_content -> 'scope' else '[]' end) as p
    cross join lateral (
        select case p_stage_code
            when 'data_owner' then pack_data_access.owner_scope(p ->> 'package')
            when 'fulfil' then 'system:' || (pack_data_access.package_row(p ->> 'package')).system_code
        end as scope_ref
    ) as s
    where s.scope_ref is not null
$$;

-- ── build_fulfilment（DA-FULFIL-RULE）：核准的那一版就是要執行的那一版 ──

create function pack_data_access.build_fulfilment(p_case_id uuid)
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
    )
    from sgn_sdk.case_context(p_case_id) as c
$$;
