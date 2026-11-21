-- 示範與驗收用的種子（不進正式環境）：docs/packs/data-access/acceptance-cases.md §1.1 的資料目錄。
-- 擁有者的身分來源改為 sim-ldap（種子名單的代號）；system 是主題包所在的受管系統（seed-directory.md「受管系統」）。
-- resource 是代碼到實體資源的對照（主題包 → 資料表、欄位與列條件 → 欄；D92 (1)），和 sim/dc 的目錄（sim/dc/src/catalog.ts）相同，
-- 兩邊算出的目錄版本才一致（測試向量 db/tests/packs/data_access/fixtures/catalog-vectors.json）。
-- environments 是欄位在某一區已遮罩或去識別後的分級（D93 (2)；db/packs/data_access/150_environment.sql）：測試區的聯絡人電話、薪轉帳號已遮罩。
select pack_data_access.catalog_load($json$
{
  "packages": [
    {
      "code": "customer_master", "name": "客戶主檔", "system": "dc", "resource": "data.customer_master",
      "owner": {"provider": "sim-ldap", "external_id": "p09"},
      "period_field": null,
      "fields": [
        {"code": "customer_id", "name": "客戶編號", "classification": "L3", "resource": "customer_id"},
        {"code": "customer_name", "name": "客戶名稱", "classification": "L3", "resource": "customer_name"},
        {"code": "contract_end_date", "name": "合約到期日", "classification": "L3", "resource": "contract_end_date"},
        {"code": "tax_id", "name": "統一編號", "classification": "L4", "resource": "tax_id"},
        {"code": "contact_phone", "name": "聯絡人電話", "classification": "L4", "resource": "contact_phone",
         "environments": [{"environment": "test", "treatment": "masked", "classification": "L3"}]},
        {"code": "industry", "name": "產業別", "classification": "L1", "resource": "industry"}
      ],
      "filters": [
        {"code": "region", "name": "區域", "value_type": "enum", "resource": "region",
         "values": [{"value": "north", "label": "北區"}, {"value": "central", "label": "中區"},
                    {"value": "south", "label": "南區"}, {"value": "east", "label": "東區"}]}
      ]
    },
    {
      "code": "sales_order", "name": "銷售訂單", "system": "dc", "resource": "data.sales_order",
      "owner": {"provider": "sim-ldap", "external_id": "p11"},
      "period_field": "order_date",
      "fields": [
        {"code": "order_no", "name": "訂單編號", "classification": "L3", "resource": "order_no"},
        {"code": "customer_id", "name": "客戶編號", "classification": "L3", "resource": "customer_id"},
        {"code": "amount", "name": "訂單金額", "classification": "L3", "resource": "amount"},
        {"code": "order_date", "name": "訂單日期", "classification": "L3", "resource": "order_date"},
        {"code": "gross_margin", "name": "毛利", "classification": "L4", "resource": "gross_margin"},
        {"code": "channel", "name": "通路別", "classification": "L2", "resource": "channel"}
      ],
      "filters": [
        {"code": "region", "name": "區域", "value_type": "enum", "resource": "region",
         "values": [{"value": "north", "label": "北區"}, {"value": "central", "label": "中區"},
                    {"value": "south", "label": "南區"}, {"value": "east", "label": "東區"}]},
        {"code": "order_amount", "name": "訂單金額", "value_type": "number", "resource": "amount"}
      ]
    },
    {
      "code": "product_cost", "name": "產品成本明細", "system": "dc", "resource": "data.product_cost",
      "owner": {"provider": "sim-ldap", "external_id": "p11"},
      "period_field": "cost_date",
      "fields": [
        {"code": "product_id", "name": "產品編號", "classification": "L3", "resource": "product_id"},
        {"code": "product_name", "name": "產品名稱", "classification": "L2", "resource": "product_name"},
        {"code": "cost_date", "name": "成本日期", "classification": "L3", "resource": "cost_date"},
        {"code": "material_cost", "name": "材料成本", "classification": "L4", "resource": "material_cost"},
        {"code": "labor_cost", "name": "人工成本", "classification": "L4", "resource": "labor_cost"},
        {"code": "overhead_cost", "name": "製造費用", "classification": "L4", "resource": "overhead_cost"},
        {"code": "unit_cost", "name": "單位成本", "classification": "L4", "resource": "unit_cost"}
      ],
      "filters": [
        {"code": "product_line", "name": "產品線", "value_type": "enum", "resource": "product_line",
         "values": [{"value": "consumer", "label": "消費性"}, {"value": "industrial", "label": "工業用"},
                    {"value": "medical", "label": "醫療用"}]}
      ]
    },
    {
      "code": "payroll", "name": "員工薪資", "system": "hr_saas", "resource": "data.payroll",
      "owner": {"provider": "sim-ldap", "external_id": "p15"},
      "period_field": "pay_date",
      "fields": [
        {"code": "employee_id", "name": "員工編號", "classification": "L3", "resource": "employee_id"},
        {"code": "department", "name": "部門", "classification": "L2", "resource": "department"},
        {"code": "pay_date", "name": "發薪日", "classification": "L3", "resource": "pay_date"},
        {"code": "base_salary", "name": "本薪", "classification": "L4", "resource": "base_salary"},
        {"code": "bonus", "name": "獎金", "classification": "L4", "resource": "bonus"},
        {"code": "net_pay", "name": "實發金額", "classification": "L4", "resource": "net_pay"},
        {"code": "bank_account", "name": "薪轉帳號", "classification": "L4", "resource": "bank_account",
         "environments": [{"environment": "test", "treatment": "masked", "classification": "L3"}]}
      ],
      "filters": [
        {"code": "pay_type", "name": "薪資類別", "value_type": "enum", "resource": "pay_type",
         "values": [{"value": "monthly", "label": "月薪"}, {"value": "bonus", "label": "獎金"}]}
      ]
    }
  ]
}
$json$::jsonb);
