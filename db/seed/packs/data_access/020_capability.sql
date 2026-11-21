-- 示範與驗收用的種子（不進正式環境）：受管系統的能力宣告（裁決 D92 (5)；db/packs/data_access/140_capability.sql）。
-- 資料中心（dc）有 sim/dc，欄、列、資料期間、匯出、使用紀錄都做得到；人資系統（hr_saas）在示範環境是人工執行，
-- 依負責人「現有的系統都做得到」（D91-c）宣告做得到。沒有宣告的系統（erp、cicd、jp_crm）一律當作做不到。
select sgn_sdk.register_setting_value('data_access.capability.' || a.aspect, s.scope_ref, 'true'::jsonb, s.reason)
from (values
    ('system:dc', '示範環境：sim/dc 宣告欄、列、資料期間、匯出、使用紀錄都做得到'),
    ('system:hr_saas', '示範環境：負責人說明現有的系統都做得到（D91-c）')
) as s (scope_ref, reason)
cross join (values ('column'), ('row'), ('data_period'), ('export'), ('usage_log')) as a (aspect);
