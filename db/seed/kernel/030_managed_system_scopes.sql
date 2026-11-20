-- 示範與驗收用的種子（不進正式環境）：受管系統的範圍代碼（system:<代碼>，docs/contract/seed-directory.md「受管系統」）
-- 登記到核心的範圍登記，角色指派變更才能指派這些範圍（裁決 D69）。
select sgn_internal.register_scope(s.scope_ref, s.label)
from (values
    ('system:dc', '資料中心（dc）'),
    ('system:hr_saas', '人資系統（hr_saas）'),
    ('system:erp', 'ERP（erp）'),
    ('system:cicd', 'CI/CD（cicd）'),
    ('system:jp_crm', '日本 CRM（jp_crm）')
) as s (scope_ref, label);
