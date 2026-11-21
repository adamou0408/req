-- 使用方系統的能力宣告（裁決 D92 (5)；設計 docs/contract/pending-amendments.md D91-c；交接 docs/handoff/closed-loop-1.md）。
--
-- 每個受管系統宣告做得到哪些限制：欄、列、資料期間、匯出、使用紀錄。資料放在既有的受管系統登記處——依 system:<代碼> 設定的參數
-- （和交付方式 delivery.mode 同一種範圍），值帶生效時間、只增不改；沒有宣告的系統一律當作做不到（從嚴）。
-- 送審時（整理內容的 hook），申請用到某個系統做不到的限制：
--   - 匯出：關閉「可否匯出」（rules.md「若 DC 無法區分，這個欄位就關閉」），並提示。
--   - 欄、列、資料期間、使用紀錄：記進內容的 capability_gaps（版本雜湊與顯示摘要都涵蓋，簽核人簽的內容包含這個提示），
--     並依參數 data_access.capability_gap_action（依級別；L3 預設 warn、L4 預設 block）只提示或擋下送審。
-- 自動驗證：做不到的限制不產生反例（不驗），記在驗證紀錄（核心 K-VERIFY-SKIPPED）。
-- 前端只顯示後端回傳的提示與錯誤，不自己依能力推斷。

select sgn_sdk.register_setting_definition(d.key, 'boolean', 'false'::jsonb, array['system'], d.description, 'data_access')
from (values
    ('data_access.capability.column', '這個受管系統做不做得到只放行部分欄位（做不到：主題包只能整包給）'),
    ('data_access.capability.row', '這個受管系統做不做得到列條件'),
    ('data_access.capability.data_period', '這個受管系統做不做得到資料期間（資料本身的日期）'),
    ('data_access.capability.export', '這個受管系統分不分得出查詢與匯出（分不出：可否匯出的欄位關閉）'),
    ('data_access.capability.usage_log', '這個受管系統有沒有使用紀錄（每張單 × 每個人 × 每個時段的摘要，D92 (4)）')
) as d (key, description);

select sgn_sdk.register_setting_definition(
    'data_access.capability_gap_action', 'text', '"warn"'::jsonb, array['tier'],
    '申請用到受管系統做不到的限制時：warn（在顯示摘要提示落差，簽核人簽的內容包含它）或 block（擋下送審）', 'data_access'
);

select sgn_sdk.register_setting_value(
    'data_access.capability_gap_action', 'tier:data_access:L4', '"block"'::jsonb, '資料授權流程包初始值（裁決 D92 (5)：L4 預設擋下）'
);

select sgn_sdk.register_message(m.code, m.kind, m.message)
from (values
    ('DA-N-CAPABILITY-GAP', 'notice', '「%s」所在的系統 %s 不能執行「%s」：%s'),
    ('DA-N-CAPABILITY-EXPORT', 'notice', '「%s」所在的系統 %s 分不出查詢與匯出，已改為只能查詢。'),
    ('DA-E-CAPABILITY-GAP', 'check', '「%s」所在的系統 %s 不能執行「%s」，%s 的申請不能送出。'),
    ('DA-T-CAP-COLUMN', 'notice', '只給部分欄位'),
    ('DA-T-CAP-ROW', 'notice', '列條件'),
    ('DA-T-CAP-DATA-PERIOD', 'notice', '資料期間'),
    ('DA-T-CAP-USAGE-LOG', 'notice', '使用紀錄'),
    ('DA-T-CAP-COLUMN-WHAT', 'notice', '整個主題包的欄位都會開放'),
    ('DA-T-CAP-ROW-WHAT', 'notice', '所有的列都會開放'),
    ('DA-T-CAP-DATA-PERIOD-WHAT', 'notice', '所有期間的資料都會開放'),
    ('DA-T-CAP-USAGE-LOG-WHAT', 'notice', '看不到實際使用的情形'),
    ('DA-T-VC-UNENFORCED', 'notice', '系統 %s 不執行「%s」，未驗證')
) as m (code, kind, message);

-- 一個受管系統的一項能力（沒有宣告是 false）。
create function pack_data_access.system_capable(p_system text, p_aspect text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce((sgn_sdk.setting('data_access.capability.' || p_aspect, array['system:' || p_system]) #>> '{}')::boolean, false)
$$;

create function pack_data_access.aspect_label(p_aspect text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_sdk.message('DA-T-CAP-' || upper(replace(p_aspect, '_', '-')))
$$;

-- 整理後的內容用到哪些做不到的限制：[{package, system, aspect}]（依主題包、項目排序）。匯出另外處理（關閉欄位）。
create function pack_data_access.capability_gaps(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object('package', g.package, 'system', g.system, 'aspect', g.aspect)
        order by g.package collate "C", g.n), '[]'::jsonb)
    from (
        select s ->> 'package' as package, k.system_code as system, a.aspect, a.n
        from jsonb_array_elements(p_content -> 'scope') as s
        cross join lateral (select * from pack_data_access.catalog_package as p where p.package_code = s ->> 'package') as k
        cross join lateral (values
            (1, 'column', jsonb_array_length(s -> 'fields') < (
                select count(*) from pack_data_access.catalog_field as f
                where f.package_code = k.package_code and f.is_active and f.classification in ('L3', 'L4'))),
            (2, 'row', jsonb_array_length(coalesce(s -> 'row_filters', '[]')) > 0),
            (3, 'data_period', k.period_field_code is not null and jsonb_typeof(p_content -> 'data_period') = 'object'),
            (4, 'usage_log', true)
        ) as a (n, aspect, used)
        where a.used and not pack_data_access.system_capable(k.system_code, a.aspect)
    ) as g
$$;

-- 整理內容（hook）：目錄版本的綁定（130）之後，再處理能力落差。
create function pack_data_access.normalize_capable(p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_r jsonb := pack_data_access.normalize_bound(p_content);
    v_content jsonb := v_r -> 'content';
    v_notices jsonb := v_r -> 'notices';
    v_errors jsonb := v_r -> 'errors';
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

-- 比較內容（同 130 的簽章）：綁定的目錄版本與能力落差都不是申請範圍的一部分。
create or replace function pack_data_access.compare_bound(p_old jsonb, p_new jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.compare_content(p_old - 'catalog' - 'capability_gaps', p_new - 'catalog' - 'capability_gaps')
$$;

-- 顯示摘要（hook）：多了能力落差（每一項：主題包、系統、哪一項、後果）。沒有落差的內容不多這個鍵。
create function pack_data_access.display_capable(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.display_bound(p_content) || case
        when jsonb_typeof(p_content -> 'capability_gaps') = 'array' and jsonb_array_length(p_content -> 'capability_gaps') > 0
        then jsonb_build_object('capability_gaps', (
            select jsonb_agg(jsonb_build_object(
                'package_name', pack_data_access.package_label(g ->> 'package'),
                'system', g ->> 'system',
                'aspect', g ->> 'aspect',
                'text', sgn_sdk.message('DA-N-CAPABILITY-GAP', pack_data_access.package_label(g ->> 'package'), g ->> 'system',
                    pack_data_access.aspect_label(g ->> 'aspect'), sgn_sdk.message('DA-T-CAP-' || upper(replace(g ->> 'aspect', '_', '-')) || '-WHAT'))
            ) order by n)
            from jsonb_array_elements(p_content -> 'capability_gaps') with ordinality as x (g, n)
        ))
        else '{}'::jsonb
    end
$$;

-- 驗證案例（hook）：做不到的限制不驗（帶 skip，核心不送也不比對，記在驗證紀錄）。
-- 案例代碼：<主題包>:row:<列條件>、<主題包>:field、<主題包>:period、request:export（以第一條規則的系統）。
create function pack_data_access.verification_cases_capable(p_case_id uuid, p_rule_set jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(case
        when a.aspect is not null and not pack_data_access.system_capable(a.system, a.aspect)
        then c || jsonb_build_object('skip', jsonb_build_object('aspect', a.aspect, 'system', a.system,
            'reason', sgn_sdk.message('DA-T-VC-UNENFORCED', a.system, pack_data_access.aspect_label(a.aspect))))
        else c
    end order by n), '[]'::jsonb)
    from jsonb_array_elements(pack_data_access.build_verification_cases(p_case_id, p_rule_set)) with ordinality as x (c, n)
    cross join lateral (
        select
            case
                when c ->> 'code' like '%:row:%' then 'row'
                when c ->> 'code' like '%:field' then 'column'
                when c ->> 'code' like '%:period' then 'data_period'
                when c ->> 'code' = 'request:export' then 'export'
            end as aspect,
            (pack_data_access.package_row(c #>> '{query,package}')).system_code as system
    ) as a
$$;

select sgn_sdk.register_hook('data_access', h.hook, h.fn)
from (values
    ('normalize_content', 'pack_data_access.normalize_capable'),
    ('display_content', 'pack_data_access.display_capable'),
    ('build_verification_cases', 'pack_data_access.verification_cases_capable')
) as h (hook, fn);

select sgn_sdk.register_rule(r.code, r.description, 'data_access', r.coverage, r.note)
from (values
    ('DA-CAPABILITY-DECLARE', '每個受管系統宣告做得到的限制（欄、列、資料期間、匯出、使用紀錄），放在受管系統的參數；沒有宣告視為做不到',
        'partial', '宣告只能由 migration 或種子設定（骨幹 18.3 的設定變更還沒做）；使用方系統自己的能力查詢與不一致的例外沒做'),
    ('DA-CAPABILITY-GAP', '申請用到受管系統做不到的限制時：匯出關閉；其他記進內容並出現在顯示摘要（簽核人簽的內容包含它），'
        '依參數 data_access.capability_gap_action（L3 提示、L4 擋下）', 'full', null),
    ('DA-CAPABILITY-VERIFY', '自動驗證依能力產生案例：做不到的限制不驗，記在驗證紀錄並標示「未驗證」', 'full', null)
) as r (code, description, coverage, note);

revoke all on all functions in schema pack_data_access from public;
