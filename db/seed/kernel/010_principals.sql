-- 示範與驗收用的種子（不進正式環境）：docs/contract/seed-directory.md 的「被授權者」。
-- 負責人依人員來源 sim-ldap 的代號對到內部 id。服務帳號（dc-etl-svc）不在這一版的被授權者種類內，沒有載入。
select sgn_internal.principal_upsert(
    'seed-directory', s.ref, s.kind, s.name, sgn_internal.person_by_identity('sim-ldap', s.owner), s.ends_on::date
)
from (values
    ('team:sales_analysis', 'team', '業務分析部', 'p03', null),
    ('team:channel_sales', 'team', '通路業務組', 'p07', null),
    ('team:jp_sales', 'team', '日本業務部', 'p33', null),
    ('project:north_churn', 'project', '北區客戶流失分析', 'p04', '2027-06-30'),
    ('project:quarterly_dashboard', 'project', '季度業績看板', 'p06', '2027-03-31'),
    ('agent:sales-report-bot', 'agent', 'sales-report-bot', 'p04', '2027-12-31'),
    ('agent:ap-recon-bot', 'agent', 'ap-recon-bot', 'p12', '2027-12-31')
) as s (ref, kind, name, owner, ends_on);
