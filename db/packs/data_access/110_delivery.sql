-- 資料授權接上系統對系統的交付（裁決 D63；契約 §5.10、§5.11、§8）：
--   build_delivery            交給某一組受管系統的規則：build_fulfilment 只留這些系統的規則（規則代碼不變）
--   build_verification_cases  依送出的規則產生自動驗證的案例（契約 §5.11：範圍內應允許，列條件外、未申請的欄位、
--                             資料期間外、匯出、到期後應拒絕）
--   expected_entitlements     送出的規則展開成外部系統上應該存在的權限（每條規則 × 欄位 × 查詢／匯出），對帳用
--   normalize_constraints     列條件與資料期間整理成可以直接比對的樣子
-- 判斷都在這裡與核心；交付程式只送資料庫給的位元組。

create function pack_data_access.build_delivery(p_case_id uuid, p_scopes text[])
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case when jsonb_array_length(k.rules) = 0 then null else f.rs || jsonb_build_object('rules', k.rules) end
    from (select pack_data_access.build_fulfilment(p_case_id) as rs) as f
    cross join lateral (
        select coalesce(jsonb_agg(r.rule order by r.n), '[]'::jsonb) as rules
        from jsonb_array_elements(f.rs -> 'rules') with ordinality as r (rule, n)
        where 'system:' || (r.rule ->> 'system') = any (p_scopes)
    ) as k
$$;

-- ── 驗證案例（DA-VERIFY-CASES）──

-- 範圍內的值：列舉取排序後的第一個，數字與日期取下限（沒有下限取上限）。
create function pack_data_access.inside_value(p_condition jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_set jsonb := pack_data_access.condition_set(p_condition);
begin
    if v_set ->> 'kind' = 'enum' then
        return (select to_jsonb(v) from jsonb_array_elements_text(v_set -> 'values') as v order by v limit 1);
    end if;
    if v_set ->> 'kind' in ('number', 'date') then
        return case when v_set -> 'lo' <> 'null'::jsonb then v_set -> 'lo' else v_set -> 'hi' end;
    end if;
    perform sgn_sdk.raise_error('DA-E-CONTENT-INVALID', p_condition::text);
    return null;
end;
$$;

-- 範圍外的值：列舉取值域裡第一個不在條件裡的（沒有就 null）；數字取下限減一或上限加一；日期取前一天或隔天。
create function pack_data_access.outside_value(p_package_code text, p_condition jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_set jsonb := pack_data_access.condition_set(p_condition);
    v_lo boolean := v_set -> 'lo' is not null and v_set -> 'lo' <> 'null'::jsonb;
begin
    if v_set ->> 'kind' = 'enum' then
        return (
            select to_jsonb(fv.value) from pack_data_access.catalog_filter_value as fv
            where fv.package_code = p_package_code and fv.filter_code = p_condition ->> 'filter' and fv.is_active
              and not (v_set -> 'values') ? fv.value
            order by fv.sort_order, fv.value
            limit 1
        );
    end if;
    if v_set ->> 'kind' = 'number' then
        return to_jsonb(case when v_lo then (v_set ->> 'lo')::numeric - 1 else (v_set ->> 'hi')::numeric + 1 end);
    end if;
    if v_set ->> 'kind' = 'date' then
        return to_jsonb(to_char(case when v_lo then (v_set ->> 'lo')::date - 1 else (v_set ->> 'hi')::date + 1 end, 'YYYY-MM-DD'));
    end if;
    return null;
end;
$$;

create function pack_data_access.unrequested_field(p_package_code text, p_fields jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select f.field_code from pack_data_access.catalog_field as f
    where f.package_code = p_package_code and f.is_active and f.classification in ('L3', 'L4') and not p_fields ? f.field_code
    order by f.classification desc, f.sort_order, f.field_code
    limit 1
$$;

create function pack_data_access.fields_text(p_package_code text, p_fields jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select string_agg(pack_data_access.field_label(p_package_code, f), '、' order by f)
    from jsonb_array_elements_text(p_fields) as f
$$;

create function pack_data_access.value_label(p_package_code text, p_filter_code text, p_value jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        (select fv.label from pack_data_access.catalog_filter_value as fv
         where fv.package_code = p_package_code and fv.filter_code = p_filter_code and fv.value = p_value #>> '{}'),
        p_value #>> '{}'
    )
$$;

-- 一條規則的案例（契約 §5.11 步驟 3 的 a–d）。
create function pack_data_access.rule_cases(p_rule jsonb, p_as_of date)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_pkg text := p_rule ->> 'package';
    v_name text := pack_data_access.package_label(v_pkg);
    v_row jsonb := coalesce((select jsonb_object_agg(c ->> 'filter', pack_data_access.inside_value(c))
                             from jsonb_array_elements(p_rule -> 'row_filter') as c), '{}'::jsonb);
    v_period jsonb := nullif(p_rule -> 'data_period', 'null'::jsonb);
    v_query jsonb := jsonb_build_object(
        'package', v_pkg, 'fields', p_rule -> 'fields', 'row', v_row,
        'data_date', coalesce(v_period -> 'from', v_period -> 'to', 'null'::jsonb), 'action', 'query', 'as_of', p_as_of
    );
    v_cases jsonb;
    v_cond jsonb;
    v_out jsonb;
    v_field text := pack_data_access.unrequested_field(v_pkg, p_rule -> 'fields');
begin
    v_cases := jsonb_build_array(jsonb_build_object('code', v_pkg || ':in', 'expected', 'allow', 'query', v_query,
        'description', sgn_sdk.message('DA-T-VC-IN', v_name, pack_data_access.fields_text(v_pkg, p_rule -> 'fields'))));
    for v_cond in select c from jsonb_array_elements(p_rule -> 'row_filter') as c loop
        v_out := pack_data_access.outside_value(v_pkg, v_cond);
        if v_out is not null then
            v_cases := v_cases || jsonb_build_object('code', v_pkg || ':row:' || (v_cond ->> 'filter'), 'expected', 'deny',
                'query', jsonb_set(v_query, array['row', v_cond ->> 'filter'], v_out),
                'description', sgn_sdk.message('DA-T-VC-ROW', v_name, (pack_data_access.filter_row(v_pkg, v_cond ->> 'filter')).name,
                    pack_data_access.value_label(v_pkg, v_cond ->> 'filter', v_out)));
        end if;
    end loop;
    if v_field is not null then
        v_cases := v_cases || jsonb_build_object('code', v_pkg || ':field', 'expected', 'deny',
            'query', v_query || jsonb_build_object('fields', jsonb_build_array(v_field)),
            'description', sgn_sdk.message('DA-T-VC-FIELD', v_name, pack_data_access.field_label(v_pkg, v_field)));
    end if;
    if v_period is not null then
        v_out := to_jsonb(to_char(case when v_period -> 'from' <> 'null'::jsonb then (v_period ->> 'from')::date - 1
                                       else (v_period ->> 'to')::date + 1 end, 'YYYY-MM-DD'));
        v_cases := v_cases || jsonb_build_object('code', v_pkg || ':period', 'expected', 'deny',
            'query', v_query || jsonb_build_object('data_date', v_out),
            'description', sgn_sdk.message('DA-T-VC-PERIOD', v_name, pack_data_access.field_label(v_pkg, v_period ->> 'field'), v_out #>> '{}'));
    end if;
    return v_cases;
end;
$$;

-- ── 外部系統的判斷（契約 §8.5「規則的語意」，以欄位為單位取聯集：sim/dc 對同一被授權者的每條規則各自放行，
--    一個欄位只要有一條規則放行那一列就讀得到）──

create function pack_data_access.condition_holds(p_condition jsonb, p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_set jsonb := pack_data_access.condition_set(p_condition);
begin
    if p_value is null or jsonb_typeof(p_value) = 'null' then
        return false;
    end if;
    if v_set ->> 'kind' = 'enum' then
        return jsonb_typeof(p_value) = 'string' and (v_set -> 'values') ? (p_value #>> '{}');
    end if;
    if v_set ->> 'kind' = 'number' then
        return jsonb_typeof(p_value) = 'number'
            and (jsonb_typeof(v_set -> 'lo') = 'null' or p_value::numeric >= (v_set ->> 'lo')::numeric)
            and (jsonb_typeof(v_set -> 'hi') = 'null' or p_value::numeric <= (v_set ->> 'hi')::numeric);
    end if;
    if v_set ->> 'kind' = 'date' then
        return jsonb_typeof(p_value) = 'string'
            and (jsonb_typeof(v_set -> 'lo') = 'null' or p_value #>> '{}' >= v_set ->> 'lo')
            and (jsonb_typeof(v_set -> 'hi') = 'null' or p_value #>> '{}' <= v_set ->> 'hi');
    end if;
    return false;
end;
$$;

create function pack_data_access.rule_allows_field(p_rule_set jsonb, p_rule jsonb, p_field text, p_query jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select p_rule ->> 'package' = p_query ->> 'package'
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

-- 這幾份規則合起來放不放行這個查詢：查詢的每個欄位都有某一條規則放行。
create function pack_data_access.rules_allow(p_rule_sets jsonb, p_query jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_array_length(p_query -> 'fields') > 0 and not exists (
        select 1 from jsonb_array_elements_text(p_query -> 'fields') as f
        where not exists (
            select 1
            from jsonb_array_elements(p_rule_sets) as rs
            cross join jsonb_array_elements(rs -> 'rules') as r
            where pack_data_access.rule_allows_field(rs, r, f, p_query)
        )
    )
$$;

-- 同一被授權者的其他單（權限可能在外部系統上的）的規則，只留和這份規則同一批受管系統的部分。
create function pack_data_access.other_rule_sets(p_case_id uuid, p_rule_set jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(f.rs || jsonb_build_object('rules', (
        select coalesce(jsonb_agg(r), '[]'::jsonb) from jsonb_array_elements(f.rs -> 'rules') as r
        where r ->> 'system' in (select x ->> 'system' from jsonb_array_elements(p_rule_set -> 'rules') as x)
    ))), '[]'::jsonb)
    from sgn_sdk.cases_possibly_granted('data_access', p_rule_set #>> '{grantee,principal_id}', p_case_id) as c (id)
    cross join lateral (select pack_data_access.build_fulfilment(c.id) as rs) as f
$$;

-- 整份規則的案例：每條規則的 a–d，再以第一條規則測匯出與到期後（契約 §5.11 步驟 4）。
-- 反例若被同一被授權者的其他單合法放行（外部系統看的是聯集），就不能證明這張單設定錯，不列入（只留得出結論的案例）。
create function pack_data_access.build_verification_cases(p_case_id uuid, p_rule_set jsonb)
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
        select coalesce(jsonb_agg(c order by n), '[]'::jsonb)
        from jsonb_array_elements(v_cases) with ordinality as e (c, n)
        where c ->> 'expected' = 'allow' or not pack_data_access.rules_allow(v_others, c -> 'query')
    );
end;
$$;

-- ── 對帳 ──

create function pack_data_access.normalize_constraints(p_constraints jsonb)
returns jsonb
language sql
immutable
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
        ) end
    )
$$;

-- 外部系統上應該存在的權限：每條規則的每個欄位可以查詢；本單可以匯出或不設定匯出限制（export 為 null）時也可以匯出。
create function pack_data_access.expected_entitlements(p_rule_set jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'subject', p_rule_set #>> '{grantee,principal_id}',
        'resource', (r ->> 'package') || '.' || f,
        'action', a,
        'rule_id', r ->> 'rule_id',
        'case_no', p_rule_set ->> 'case_no',
        'constraints', pack_data_access.normalize_constraints(jsonb_build_object('row_filter', r -> 'row_filter', 'data_period', r -> 'data_period')),
        'valid', p_rule_set -> 'valid'
    ) order by r ->> 'rule_id', f, a), '[]'::jsonb)
    from jsonb_array_elements(p_rule_set -> 'rules') as r
    cross join jsonb_array_elements_text(r -> 'fields') as f
    cross join unnest(case when coalesce(p_rule_set -> 'export', 'null'::jsonb) = 'false'::jsonb
        then array['read'] else array['read', 'export'] end) as a
$$;

select sgn_sdk.register_hook('data_access', h.hook, h.fn)
from (values
    ('build_delivery', 'pack_data_access.build_delivery'),
    ('build_verification_cases', 'pack_data_access.build_verification_cases'),
    ('expected_entitlements', 'pack_data_access.expected_entitlements'),
    ('normalize_constraints', 'pack_data_access.normalize_constraints')
) as h (hook, fn);

select sgn_sdk.register_message('DA-E-CONTENT-INVALID', 'error', '這張單的執行內容無法產生驗證案例', 500);

select sgn_sdk.register_message(m.code, 'notice', m.message)
from (values
    ('DA-T-VC-IN', '%s・%s（範圍內）'),
    ('DA-T-VC-ROW', '%s・%s＝%s（列條件外）'),
    ('DA-T-VC-FIELD', '%s・%s（未申請的欄位）'),
    ('DA-T-VC-PERIOD', '%s・%s＝%s（資料期間外）'),
    ('DA-T-VC-EXPORT-ALLOWED', '匯出 %s（本單可以匯出）'),
    ('DA-T-VC-EXPORT-DENIED', '匯出 %s（本單只能查詢）'),
    ('DA-T-VC-AFTER', '%s 查詢 %s（授權到期後）')
) as m (code, message);

select sgn_sdk.register_rule(r.code, r.description, 'data_access', r.coverage, r.note)
from (values
    ('DA-FULFIL-RULE', '核准結果輸出成結構化的規則交給外部系統；本站不執行權限', 'full', null),
    ('DA-VERIFY-CASES',
        '依送出的規則自動產生驗證案例：每條規則範圍內應允許；列條件外、未申請的 L3/L4 欄位、資料期間外應拒絕；匯出依本單；授權到期後應拒絕',
        'full', null),
    ('DA-DC-WITHDRAW', '授權撤銷後，外部系統上的規則自動撤回；到期後自動清除', 'full', null)
) as r (code, description, coverage, note);

revoke all on all functions in schema pack_data_access from public;
