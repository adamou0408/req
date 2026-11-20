-- 範圍運算（契約 §5.0）：「縮小」（compare_content）與「涵蓋」（find_overlaps）共用。
-- 原則：只在能證明的時候回答「是」；任何無法判定的情況都回答「否」，呼叫端因此落到 expand 或 partial
-- （DA-CHANGE-COMPARE、DA-OVERLAP-PARTIAL）。全部只看傳入的 JSON。

create function pack_data_access.is_date_text(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
    if jsonb_typeof(p_value) <> 'string' or p_value #>> '{}' !~ '^\d{4}-\d{2}-\d{2}$' then
        return false;
    end if;
    return to_char(to_date(p_value #>> '{}', 'YYYY-MM-DD'), 'YYYY-MM-DD') = p_value #>> '{}';
exception
    when datetime_field_overflow or invalid_datetime_format then
        return false;
end;
$$;

-- 條件代表的集合：{"kind":"enum","values":[...]}、{"kind":"number"|"date","lo","hi"}，或 {"kind":"unknown"}。
create function pack_data_access.condition_set(p_condition jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_op text := p_condition ->> 'op';
    v_values jsonb := p_condition -> 'values';
    v_lo jsonb;
    v_hi jsonb;
    v_unknown constant jsonb := '{"kind": "unknown"}'::jsonb;
begin
    if jsonb_typeof(v_values) is distinct from 'array' then
        return v_unknown;
    end if;
    if v_op = 'in' or (v_op = 'eq' and jsonb_array_length(v_values) = 1 and jsonb_typeof(v_values -> 0) = 'string') then
        if jsonb_array_length(v_values) = 0
           or exists (select 1 from jsonb_array_elements(v_values) as e where jsonb_typeof(e) <> 'string') then
            return v_unknown;
        end if;
        return jsonb_build_object('kind', 'enum', 'values', (
            select jsonb_agg(distinct e #>> '{}') from jsonb_array_elements(v_values) as e
        ));
    end if;
    if v_op = 'eq' and jsonb_array_length(v_values) = 1 and jsonb_typeof(v_values -> 0) = 'number' then
        return jsonb_build_object('kind', 'number', 'lo', v_values -> 0, 'hi', v_values -> 0);
    end if;
    if v_op <> 'between' or jsonb_array_length(v_values) <> 2 then
        return v_unknown;
    end if;
    v_lo := v_values -> 0;
    v_hi := v_values -> 1;
    if jsonb_typeof(v_lo) = 'null' and jsonb_typeof(v_hi) = 'null' then
        return v_unknown;
    end if;
    if jsonb_typeof(v_lo) in ('number', 'null') and jsonb_typeof(v_hi) in ('number', 'null') then
        if jsonb_typeof(v_lo) = 'number' and jsonb_typeof(v_hi) = 'number' and v_lo::numeric > v_hi::numeric then
            return v_unknown;
        end if;
        return jsonb_build_object('kind', 'number', 'lo', v_lo, 'hi', v_hi);
    end if;
    if (jsonb_typeof(v_lo) = 'null' or pack_data_access.is_date_text(v_lo))
       and (jsonb_typeof(v_hi) = 'null' or pack_data_access.is_date_text(v_hi)) then
        if jsonb_typeof(v_lo) = 'string' and jsonb_typeof(v_hi) = 'string' and v_lo #>> '{}' > v_hi #>> '{}' then
            return v_unknown;
        end if;
        return jsonb_build_object('kind', 'date', 'lo', v_lo, 'hi', v_hi);
    end if;
    return v_unknown;
end;
$$;

-- 區間端點的比較（數字以數值、日期以 YYYY-MM-DD 字串比較）。
create function pack_data_access.bound_le(p_kind text, p_a jsonb, p_b jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case p_kind
        when 'number' then (p_a #>> '{}')::numeric <= (p_b #>> '{}')::numeric
        else p_a #>> '{}' <= p_b #>> '{}'
    end
$$;

-- a 是 b 的子集
create function pack_data_access.set_within(p_a jsonb, p_b jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_a ->> 'kind' = 'unknown' or p_a ->> 'kind' is distinct from p_b ->> 'kind' then false
        when p_a ->> 'kind' = 'enum' then (p_b -> 'values') @> (p_a -> 'values')
        else
            (jsonb_typeof(p_b -> 'lo') = 'null'
             or (jsonb_typeof(p_a -> 'lo') <> 'null' and pack_data_access.bound_le(p_a ->> 'kind', p_b -> 'lo', p_a -> 'lo')))
            and (jsonb_typeof(p_b -> 'hi') = 'null'
                 or (jsonb_typeof(p_a -> 'hi') <> 'null' and pack_data_access.bound_le(p_a ->> 'kind', p_a -> 'hi', p_b -> 'hi')))
    end
$$;

-- a 與 b 沒有交集
create function pack_data_access.set_disjoint(p_a jsonb, p_b jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_a ->> 'kind' = 'unknown' or p_a ->> 'kind' is distinct from p_b ->> 'kind' then false
        when p_a ->> 'kind' = 'enum' then not exists (
            select 1 from jsonb_array_elements_text(p_a -> 'values') as a (v)
            where p_b -> 'values' ? a.v
        )
        else
            (jsonb_typeof(p_a -> 'hi') <> 'null' and jsonb_typeof(p_b -> 'lo') <> 'null'
             and not pack_data_access.bound_le(p_a ->> 'kind', p_b -> 'lo', p_a -> 'hi'))
            or (jsonb_typeof(p_b -> 'hi') <> 'null' and jsonb_typeof(p_a -> 'lo') <> 'null'
                and not pack_data_access.bound_le(p_a ->> 'kind', p_a -> 'lo', p_b -> 'hi'))
    end
$$;

-- 一組列條件是陣列、每個列條件欄位只出現一次。
create function pack_data_access.filters_wellformed(p_filters jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_typeof(p_filters) = 'array'
       and (select count(*) = count(distinct f ->> 'filter') and bool_and(f ->> 'filter' is not null)
            from jsonb_array_elements(p_filters) as f) is not false
$$;

-- inner 和 outer 一樣嚴或更嚴：outer 的每個條件，inner 都有相同欄位、且集合是子集的條件。
create function pack_data_access.filters_within(p_inner jsonb, p_outer jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.filters_wellformed(p_inner)
       and pack_data_access.filters_wellformed(p_outer)
       and not exists (
           select 1
           from jsonb_array_elements(p_outer) as co
           where not exists (
               select 1
               from jsonb_array_elements(p_inner) as ci
               where ci ->> 'filter' = co ->> 'filter'
                 and (ci = co or pack_data_access.set_within(pack_data_access.condition_set(ci), pack_data_access.condition_set(co)))
           )
       )
$$;

-- 能證明 a 與 b 沒有共同的資料列：有一個列條件欄位，兩邊的集合沒有交集。
create function pack_data_access.filters_disjoint(p_a jsonb, p_b jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.filters_wellformed(p_a)
       and pack_data_access.filters_wellformed(p_b)
       and exists (
           select 1
           from jsonb_array_elements(p_a) as ca
           join jsonb_array_elements(p_b) as cb on cb ->> 'filter' = ca ->> 'filter'
           where pack_data_access.set_disjoint(pack_data_access.condition_set(ca), pack_data_access.condition_set(cb))
       )
$$;

create function pack_data_access.filters_relation(p_new jsonb, p_old jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when pack_data_access.filters_wellformed(p_new) and pack_data_access.filters_wellformed(p_old)
             and (select coalesce(jsonb_agg(f order by f::text), '[]') from jsonb_array_elements(p_new) as f)
               = (select coalesce(jsonb_agg(f order by f::text), '[]') from jsonb_array_elements(p_old) as f) then 'equal'
        when pack_data_access.filters_within(p_new, p_old) then 'stricter'
        else 'other'
    end
$$;

-- 有效的期間：物件，from、to 都是有效日期，from ≤ to。
create function pack_data_access.period_valid(p_period jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_typeof(p_period) = 'object'
       and pack_data_access.is_date_text(p_period -> 'from')
       and pack_data_access.is_date_text(p_period -> 'to')
       and p_period ->> 'from' <= p_period ->> 'to'
$$;

create function pack_data_access.period_relation(p_new jsonb, p_old jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when coalesce(p_new, 'null') = coalesce(p_old, 'null') then 'equal'
        when coalesce(p_old, 'null') = 'null' and pack_data_access.period_valid(p_new) then 'stricter'
        when pack_data_access.period_valid(p_new) and pack_data_access.period_valid(p_old)
             and p_new ->> 'from' >= p_old ->> 'from' and p_new ->> 'to' <= p_old ->> 'to' then 'stricter'
        else 'other'
    end
$$;

create function pack_data_access.period_disjoint(p_a jsonb, p_b jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.period_valid(p_a)
       and pack_data_access.period_valid(p_b)
       and (p_a ->> 'to' < p_b ->> 'from' or p_b ->> 'to' < p_a ->> 'from')
$$;
