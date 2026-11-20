-- 不認得的代碼整張拒收，不默默丟掉（裁決 D79 (3)；紅隊第三輪 資訊 3）。
-- 根因：整理內容時，目錄裡沒有的主題包與欄位代碼（例如大小寫不同、多了空白）只被移除並提示，單照樣能送出；
-- 申請人以為自己申請了某個欄位，簽核人看到的卻是另一張單。
-- 這一版：從來不在目錄裡的代碼（不分是否啟用都找不到）列為送審前必須修正的錯誤（DA-SCOPE-STRUCTURED：
-- 資料範圍只能用目錄上的代碼）；目錄裡有、但已停用的維持原本的提示與移除。

select sgn_sdk.register_message('DA-E-CODE-UNKNOWN', 'check', '「%s」不是資料目錄裡的代碼（大小寫與空白都要完全相同），這張單不能送出。');

-- 輸入的資料範圍裡，目錄從來沒有的主題包或欄位代碼。
create function pack_data_access.unknown_code_errors(p_scope jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    with items as (
        select x.p
        from jsonb_array_elements(case when jsonb_typeof(p_scope) = 'array' then p_scope else '[]'::jsonb end) as x (p)
        where jsonb_typeof(x.p -> 'package') = 'string'
    ),
    codes as (
        select i.p ->> 'package' as code, 0 as n
        from items as i
        where not exists (select 1 from pack_data_access.catalog_package as k where k.package_code = i.p ->> 'package')
        union
        select (i.p ->> 'package') || '.' || coalesce(case when jsonb_typeof(f) = 'string' then f #>> '{}' end, f ->> 'code'), 1
        from items as i
        cross join lateral jsonb_array_elements(case when jsonb_typeof(i.p -> 'fields') = 'array' then i.p -> 'fields' else '[]'::jsonb end) as f
        where exists (select 1 from pack_data_access.catalog_package as k where k.package_code = i.p ->> 'package')
          and coalesce(case when jsonb_typeof(f) = 'string' then f #>> '{}' end, f ->> 'code') is not null
          and not exists (
              select 1 from pack_data_access.catalog_field as c
              where c.package_code = i.p ->> 'package'
                and c.field_code = coalesce(case when jsonb_typeof(f) = 'string' then f #>> '{}' end, f ->> 'code')
          )
    )
    select coalesce(jsonb_agg(pack_data_access.error('scope', 'DA-E-CODE-UNKNOWN', c.code) order by c.n, c.code collate "C"), '[]'::jsonb)
    from codes as c
$$;

-- 整理內容（同 030 的簽章與 hook 登記）：錯誤多了不認得的代碼。
create or replace function pack_data_access.normalize_content(p_content jsonb)
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
    return jsonb_build_object(
        'content', v_content,
        'notices', v_notices,
        'errors', pack_data_access.unknown_code_errors(v_in -> 'scope') || pack_data_access.content_errors(v_content)
    );
end;
$$;

revoke all on all functions in schema pack_data_access from public;
