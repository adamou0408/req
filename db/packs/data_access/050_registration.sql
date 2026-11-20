-- 資料授權流程包的登記（骨幹 6.1）：規則代碼、訊息、參數與參數值、流程類型、簽核路徑。全部可重複執行。

-- ── 規則代碼（契約 §7.3 中這一版實作的部分；rules.md 是定義的唯一來源）──

select sgn_sdk.register_rule(r.code, r.description, 'data_access', r.coverage, r.note)
from (values
    ('DA-NO-MEDIUM', '申請內容不記錄媒介；簽核的對象是資料本身', 'full', null),
    ('DA-TIER-AUTO-GRANT', 'L1、L2 欄位不走申請：自動從單上移除，並提示這些欄位自動給', 'full', null),
    ('DA-TIER-MAX', '級別取所有欄位的最高分級；同時有 L3、L4 時整張照 L4', 'full', null),
    ('DA-PATH-L3', 'L3：主管 → 資料擁有者（並行）→ 資安合規檢查（MIS 群組認領）→ 執行設定（該資源所屬系統的管理人）', 'full', null),
    ('DA-PATH-L4', 'L4：主管 → 資料擁有者（並行）→ 資安長 → 資安合規檢查 → 執行設定', 'partial', '資安長的代理沒做'),
    ('DA-STAGE-OWNER', '資料擁有者依主題包決定；每個主題包都要有在職的擁有者才能送審', 'full', null),
    ('DA-SCOPE-STRUCTURED', '資料範圍是主題包 → 欄位 → 列條件；列條件只能用目錄上的欄位與值，不開放自由輸入', 'full', null),
    ('DA-DATA-PERIOD', '資料期間和授權起迄分開存；選到有期間欄位的主題包時必填，交給外部系統套用', 'full', null),
    ('DA-PURPOSE', '使用情境＝分類＋說明；標示為需說明的分類必須填說明', 'full', null),
    ('DA-EXPORT-TIER', '查看和帶走分開；L4 不能申請匯出（參數 data_access.export_requestable 依級別設定）', 'full', null),
    ('DA-CHANGE-COMPARE', '縮小的判定：欄位子集、列條件相同或更嚴、資料期間在原範圍內、可匯出改為不可匯出；其他變動或無法判定，一律算擴大', 'full', null),
    ('DA-CHANGE-PURPOSE', '修改使用情境算擴大', 'full', null),
    ('DA-OVERLAP-COVERED', '被同一被授權者的單獨一筆有效授權完全涵蓋', 'full', null),
    ('DA-OVERLAP-PARTIAL', '部分重疊；無法證明完全涵蓋時（含多筆授權合起來才涵蓋）一律算部分重疊', 'full', null),
    ('DA-FULFIL-RULE', '核准結果輸出成結構化的規則交給外部系統；本站不執行權限', 'partial', '交付信封、自動交付與驗證沒做'),
    ('DA-FULFIL-CUSTODIAN', '執行設定由主題包所屬受管系統的管理人認領；與資安合規檢查必為不同的人', 'full', null),
    ('DA-DEFAULT-SETTINGS', '流程包登記的參數初始值等於 rules.md 的預設：授權上限 L3 12 個月、L4 6 個月', 'partial',
        '催辦、升級、到期提醒等時限的參數沒有登記（這一版沒有排程）')
) as r (code, description, coverage, note);

-- ── 訊息（契約 §7.4、§7.5 中這一版用到的）──

select sgn_sdk.register_message(m.code, m.kind, m.message)
from (values
    ('DA-N-AUTO-GRANTED', 'notice', '「%s」的「%s」是 %s 欄位，不需要申請，已自動從這張單移除。'),
    ('DA-N-FIELD-UNAVAILABLE', 'notice', '「%s」的「%s」已經不在資料目錄裡，已從這張單移除。'),
    ('DA-N-PACKAGE-UNAVAILABLE', 'notice', '「%s」已經不在資料目錄裡，已從這張單移除。'),
    ('DA-N-PACKAGE-EMPTY', 'notice', '「%s」沒有需要申請的欄位，已從這張單移除。'),
    ('DA-N-EXPORT-FORCED', 'notice', '這張單包含 %1$s 資料，%1$s 資料不可匯出，已改為只能查詢。'),
    ('DA-E-SCOPE-EMPTY', 'check', '請至少選一個需要申請的欄位（L3 或 L4）。'),
    ('DA-E-OWNER-MISSING', 'check', '「%s」目前沒有在職的資料擁有者，無法送審，請聯絡 MIS。'),
    ('DA-E-FILTER-UNKNOWN', 'check', '「%s」沒有「%s」這個列條件欄位。'),
    ('DA-E-FILTER-DUPLICATE', 'check', '同一個主題包裡，「%s」只能設定一個條件。'),
    ('DA-E-FILTER-OP', 'check', '「%s」不能使用這種條件。'),
    ('DA-E-FILTER-VALUE', 'check', '「%s」的條件不正確：%s。'),
    ('DA-E-PERIOD-REQUIRED', 'check', '請填寫資料期間的起日和迄日。'),
    ('DA-E-PERIOD-ORDER', 'check', '資料期間的起日不能晚於迄日。'),
    ('DA-E-PURPOSE-CATEGORY', 'check', '請選擇使用情境分類。'),
    ('DA-E-PURPOSE-DESCRIPTION', 'check', '選擇「%s」時，請填寫使用情境說明。'),
    ('DA-T-FV-EMPTY', 'check', '至少要選一個值'),
    ('DA-T-FV-NOT-IN-DOMAIN', 'check', '值 %s 不在可選的清單裡'),
    ('DA-T-FV-BOUNDS', 'check', '要填下限和上限（可以只填其中一個）'),
    ('DA-T-FV-NUMBER', 'check', '要填數字'),
    ('DA-T-FV-DATE', 'check', '要填日期'),
    ('DA-T-FV-ORDER', 'check', '下限不能大於上限')
) as m (code, kind, message);

-- ── 參數（契約 §7.1、§7.2）──

select sgn_sdk.register_setting_definition(
    'data_access.export_requestable', 'boolean', 'true', array['process', 'tier'],
    '這個級別可不可以申請匯出', 'data_access'
);

select sgn_sdk.register_setting_value(v.key, v.scope_ref, v.value::jsonb, v.reason)
from (values
    ('data_access.export_requestable', 'tier:data_access:L4', 'false', '資料授權流程包初始值（rules.md：L4 預設不可匯出；A24：L4 不能申請匯出）'),
    ('validity.max_months', 'tier:data_access:L3', '12', '資料授權流程包初始值（rules.md：授權上限 L3 一年）'),
    ('validity.max_months', 'tier:data_access:L4', '6', '資料授權流程包初始值（rules.md：授權上限 L4 半年）')
) as v (key, scope_ref, value, reason);

-- ── 流程類型與路徑（契約 §1、§3；執行關依骨幹附錄 B 與 seed-directory.md 改為受管系統的管理人）──

select sgn_sdk.register_process_type(jsonb_build_object(
    'code', 'data_access',
    'name', '資料授權',
    'pack', 'data_access',
    'options', jsonb_build_object(
        'uses_principal', true,
        'has_validity', true,
        'overlap_check', true,
        'requires_fulfilment', true
    ),
    'tiers', jsonb_build_array(
        jsonb_build_object('code', 'L3', 'name', 'L3', 'sort_order', 1),
        jsonb_build_object('code', 'L4', 'name', 'L4', 'sort_order', 2)
    ),
    'hooks', jsonb_build_object(
        'normalize_content', 'pack_data_access.normalize_content',
        'classify_tier', 'pack_data_access.classify_tier',
        'compare_content', 'pack_data_access.compare_content',
        'find_overlaps', 'pack_data_access.find_overlaps',
        'stage_scopes', 'pack_data_access.stage_scopes',
        'build_fulfilment', 'pack_data_access.build_fulfilment'
    )
));

select sgn_sdk.register_approval_policy('data_access', jsonb_build_object(
    'top_resolver_role', 'board_chair',
    'stages', jsonb_build_array(
        jsonb_build_object(
            'seq', 10, 'code', 'manager', 'name', '申請人主管', 'phase', 'approval', 'side', 'demand',
            'resolver', jsonb_build_object('kind', 'applicant_manager'), 'mode', 'one', 'applies_when', null
        ),
        jsonb_build_object(
            'seq', 20, 'code', 'data_owner', 'name', '資料擁有者', 'phase', 'approval', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'scoped_role', 'role', 'data_owner'), 'mode', 'all', 'applies_when', null
        ),
        jsonb_build_object(
            'seq', 30, 'code', 'ciso', 'name', '資安長', 'phase', 'approval', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'role_holder', 'role', 'ciso'), 'mode', 'one',
            'applies_when', jsonb_build_object('tier_in', jsonb_build_array('L4'))
        ),
        jsonb_build_object(
            'seq', 40, 'code', 'mis', 'name', '資安合規檢查', 'phase', 'approval', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'role_group_claim', 'role', 'mis'), 'mode', 'one', 'applies_when', null
        ),
        jsonb_build_object(
            'seq', 50, 'code', 'fulfil', 'name', '執行設定', 'phase', 'fulfilment', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'system_custodian', 'role', 'system_custodian'), 'mode', 'one', 'applies_when', null
        )
    )
));

revoke all on all functions in schema pack_data_access from public;
