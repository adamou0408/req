# 契約：資料授權流程包（`data_access`）

這份文件是資料授權流程包的實作契約。業務規則的唯一來源是 [packs/data-access/rules.md](../packs/data-access/rules.md)；核心與流程包的介面以 [00-spine.md](00-spine.md) 為準。本文件只定義流程包自己的部分：內容結構、路徑、資料表、hook 的演算法、專屬的對外 function、執行與驗證的格式。

驗收用的種子資料與逐步腳本在 [packs/data-access/acceptance-cases.md](../packs/data-access/acceptance-cases.md)。本文件所有範例使用該文件 §1.1 的種子目錄（四個主題包：`customer_master`、`sales_order`、`product_cost`、`payroll`）。

[pending-amendments.md](pending-amendments.md) 列出的增修（A3 保密、A5 依事件到期、A16 受管系統、A17 最後一關拆分等）還沒有進骨幹，這份文件不處理；附錄 B 說明它們之後會影響哪些段落。

## 0. 範圍與前提

### 0.1 流程包負責什麼

| 項目 | 位置 |
|---|---|
| 資料表、hook、內部 function | schema `pack_data_access` |
| 對外 function | `api.data_access_*` |
| migration | `db/packs/data_access/` |
| 測試 | `db/tests/packs/data_access/` |
| 後端 adapter（DC、資料目錄） | `api/src/packs/data_access/` |
| 前端專屬元件 | `web/src/packs/data_access/` |

流程包不修改核心資料表，也不對核心資料表建立外鍵（外鍵會在核心資料表上產生約束觸發器）。需要寫入核心資料時，只呼叫 §0.3 列出的核心入口。

### 0.2 被授權者與授權起迄不在內容裡

被授權者（`principal`）與授權起迄（有效期間）是核心的欄位，存在 `case` 上。流程類型選用 `uses_principal`、`has_validity` 之後，由核心在表單上產生這兩個區段、檢查上限（`K-VALIDITY-MAX`）、判斷修改是縮小還是擴大。因此：

- 流程包的內容（`case_version` 的內容 jsonb）只有：資料範圍、資料期間、使用情境、可否匯出。
- `compare_content` 只比較內容。被授權者與授權起迄的比較由核心負責（被授權者有任何變更＝擴大；授權起迄落在原範圍內＝縮小，否則＝擴大），核心取兩者中較嚴重的結果。
- 需要被授權者或授權起迄的 hook（`find_overlaps`、`automated_checks`、`build_fulfilment`、`build_verification_cases`）用 `p_case_id` 從核心讀取。

### 0.3 對核心的依賴

骨幹沒有固定下列入口的名稱。本文件先用「假設的名稱」撰寫；`01-kernel.md` 定案的名稱不同時，只需要修改 §4.3 的「核心存取」function 與 §10 的登記檔，hook 的演算法不受影響。假設的寫法盡量和 [03-pack-seal.md](03-pack-seal.md) §0.2 相同，讓核心只需要對照一套。

| # | 需要的能力 | 假設的入口 | 用在 |
|---|---|---|---|
| D1 | 現在時間與營業日期（支援假時鐘） | `sgn_internal.now() returns timestamptz`、`sgn_internal.today() returns date` | 所有需要「今天」的 function |
| D2 | 讀參數 | `sgn_internal.setting(p_key text, p_scope jsonb) returns jsonb`；`p_scope` 例如 `{"process": "data_access", "tier": "L4"}` | `setting_boolean`（§4.3） |
| D3 | 丟錯、取得訊息文字 | `sgn_internal.raise_error(p_code text, variadic p_args text[])`、`sgn_internal.error_message(p_code text, variadic p_args text[]) returns text`（以 `format()` 套用訊息裡的 `%s`） | 全部 |
| D4 | 授權檢查 | `sgn_internal.require_active_person(p_actor)`、`sgn_internal.require_role(p_actor, p_role text, p_scope_ref text default null)`、`sgn_internal.has_role(p_actor, p_role text, p_scope_ref text default null) returns boolean`、`sgn_internal.is_system_actor(p_actor) returns boolean` | §6 的對外 function |
| D5 | 稽核寫入 | `sgn_internal.write_audit(p_actor bigint, p_action text, p_rule_code text, p_case_id bigint, p_changes jsonb)`；`p_case_id` 可為 null（與申請單無關的事件，例如目錄同步） | §6 |
| D6 | 通知寫入 | `sgn_internal.enqueue_notification(p_event_code text, p_person_ids bigint[], p_role_codes text[], p_payload jsonb)` | 目錄同步、DC 規則撤回 |
| D7 | 升版時的登記入口 | `sgn_internal.register_role`、`register_setting_definition`、`register_setting_value`、`register_rule`、`register_error`、`register_notification_template`、`register_process_type`、`register_approval_policy`（全部可重複執行） | §10 的登記檔 |
| D8 | 依範圍的角色指派同步 | `sgn_internal.sync_scoped_role_assignments(p_actor bigint, p_role text, p_source text, p_assignments jsonb) returns jsonb`；`p_assignments` 為 `[{"scope_ref","person_id"}]`，代表「這個來源目前的完整指派」。核心結束不在清單內的舊指派、建立新指派、寫稽核事件，回傳 `{"added","ended"}` | `catalog_sync` |
| D9 | 範本登記 | `sgn_internal.save_case_template(p_actor bigint, p_template_id bigint, p_process text, p_name text, p_content jsonb, p_is_standard boolean) returns bigint`、`sgn_internal.retire_case_template(p_actor bigint, p_template_id bigint)` | §6.4 |
| D10 | 讀取核心資料 | 核心資料表的欄位名稱：見 §4.3 的「核心存取」function | hook |
| D11 | 驗證的執行入口 | `api.verification_pending(p_actor, p_process text, p_limit integer) returns jsonb`、`api.verification_report(p_actor, p_run_id bigint, p_results jsonb) returns jsonb` | §8.4 |
| D12 | 訊息目錄可以登記不是錯誤的訊息（提示、檢查結果） | `register_error` 的 SQLSTATE 與 HTTP 狀態可為 null | §7.5 |

核心行為的前提（本流程包的正確性依賴這些行為；`01-kernel.md` 必須保證）：

| # | 前提 |
|---|---|
| B1 | 寫入任何 `case_version` 之前，核心先呼叫 `normalize_content`，並以回傳的 `content` 為準；之後才呼叫 `validate_content`、`classify_tier`、`compare_content`、`find_overlaps`。 |
| B2 | 每次產生新版本都重新呼叫 `classify_tier`。級別升高時視為擴大（`K-CHANGE-EXPAND`），改用新級別的關卡從第一關重簽。 |
| B3 | `find_overlaps` 只在申請單已經存檔（有 `case` 資料列）之後呼叫，`p_case_id` 不為 null。新申請畫面的即時重複檢查，由核心先儲存草稿再呼叫。 |
| B4 | `scoped_role` 解析出同一個人負責多個範圍時，只產生一件簽核工作。 |
| B5 | `grant` 在執行完成時建立（`K-FULFIL`：生效以執行完成為準），此時呼叫 `on_grant_event(grant_id, 'activated')`；之後到期呼叫 `'expired'`，任何原因的撤銷（手動、確認逾期、負責人寬限期逾期、被授權者結束）呼叫 `'revoked'`。 |
| B6 | 續期單的授權起日預設為來源授權的迄日隔天。 |
| B7 | 有重疊警示（`find_overlaps` 的結果不是 `none`）的單不能放進批次核准。 |
| B8 | 核心在 `automated_checks` 的結果之前，自己加上與領域無關的檢查（被授權者有在職的負責人、每一關都是不同的人、授權期間在上限內）。 |
| B9 | 執行關（§3 的 `dc_apply`）預設由核准 `mis` 關的同一人接續；他不在時由 `mis` 群組的其他成員認領。「每一關都是不同的人」只適用於簽核關，不適用於簽核關與執行關之間（rules.md：MIS 負責「資安合規檢查＋執行設定」，認領後負責到結案）。 |

## 1. 流程類型登記

### 1.1 基本資料

| 項目 | 值 |
|---|---|
| 代碼 | `data_access` |
| 名稱 | 資料授權 |
| 所屬流程包 | `data_access` |
| 規則代碼前綴 | `DA-` |
| 單號前綴 | `DA`（格式由核心決定，例如 `DA-2026-0142`） |
| 狀態 | 啟用 |

### 1.2 選項（骨幹第 3 節）

| 選項 | 值 | 對應的規則 |
|---|---|---|
| `uses_principal` | `true` | 被授權者只能是團隊、專案或 agent |
| `has_validity` | `true` | 授權起迄；到期自動失效 |
| `renewable` | `true` | 一鍵續期 |
| `overlap_check` | `true` | 重複申請 |
| `requires_fulfilment` | `true` | 待套用：等 DC 套用 |
| `requires_verification` | `true` | 驗證中：自動測試 |
| `requires_confirmation` | `true` | 驗證中：申請人確認 |
| `confirmation_timeout_action` | `revoke` | 申請人逾期沒有確認，自動撤銷 |
| `revocable_after_fulfilment` | `true` | 撤銷 |
| `batch_renewal` | `true` | 批次核准 |

### 1.3 級別

| 級別代碼 | 名稱 | 排序 | 判定 |
|---|---|---|---|
| `L3` | L3 | 1 | 內容裡所有欄位的分級最高為 L3 |
| `L4` | L4 | 2 | 內容裡至少一個欄位的分級為 L4 |

L1、L2 是資料目錄的欄位分級，不是流程的級別：這兩級的欄位不走申請，不會出現在送審的內容裡。

### 1.4 hook 登記

骨幹第 6 節的十二個 hook 與第 11 節的兩個 hook 全部實作。函式都在 `pack_data_access`，名稱與 hook 名稱相同（例如 `pack_data_access.normalize_content`）。擁有者是 `sgn_owner`，`security invoker`，固定 `search_path = pack_data_access, sgn_internal, sgn, pg_temp`。

| Hook | 規格 | 易變性 | 讀目錄 | 寫入流程包資料表 |
|---|---|---|---|---|
| `normalize_content` | §5.1 | `stable` | 是 | 否 |
| `validate_content` | §5.2 | `stable` | 是 | 否 |
| `classify_tier` | §5.3 | `immutable` | 否 | 否 |
| `compare_content` | §5.4 | `immutable` | 否 | 否 |
| `diff_content` | §5.5 | `stable` | 是（只取名稱） | 否 |
| `summarize_content` | §5.6 | `stable` | 是（只取名稱） | 否 |
| `find_overlaps` | §5.7 | `stable` | 是 | 否 |
| `stage_scopes` | §5.8 | `immutable` | 否 | 否 |
| `automated_checks` | §5.9 | `stable` | 是 | 否 |
| `build_fulfilment` | §5.10 | `stable` | 是 | 否 |
| `build_verification_cases` | §5.11 | `stable` | 是 | 否 |
| `on_grant_event` | §5.12 | `volatile` | 否 | `dc_rule` |
| `describe_entitlements` | §5.13 | `stable` | 是 | 否 |
| `evaluate_constraints` | §5.14 | `stable` | 否 | 否 |

### 1.5 登記資料

```json
{
  "code": "data_access",
  "name": "資料授權",
  "pack": "data_access",
  "case_no_prefix": "DA",
  "options": {
    "uses_principal": true,
    "has_validity": true,
    "renewable": true,
    "overlap_check": true,
    "requires_fulfilment": true,
    "requires_verification": true,
    "requires_confirmation": true,
    "confirmation_timeout_action": "revoke",
    "revocable_after_fulfilment": true,
    "batch_renewal": true
  },
  "tiers": [
    {"code": "L3", "name": "L3", "sort_order": 1},
    {"code": "L4", "name": "L4", "sort_order": 2}
  ],
  "hooks": {
    "normalize_content": "pack_data_access.normalize_content",
    "validate_content": "pack_data_access.validate_content",
    "classify_tier": "pack_data_access.classify_tier",
    "compare_content": "pack_data_access.compare_content",
    "diff_content": "pack_data_access.diff_content",
    "summarize_content": "pack_data_access.summarize_content",
    "find_overlaps": "pack_data_access.find_overlaps",
    "stage_scopes": "pack_data_access.stage_scopes",
    "automated_checks": "pack_data_access.automated_checks",
    "build_fulfilment": "pack_data_access.build_fulfilment",
    "build_verification_cases": "pack_data_access.build_verification_cases",
    "on_grant_event": "pack_data_access.on_grant_event",
    "describe_entitlements": "pack_data_access.describe_entitlements",
    "evaluate_constraints": "pack_data_access.evaluate_constraints"
  },
  "hook_rules": {
    "normalize_content": ["DA-TIER-AUTO-GRANT", "DA-EXPORT-TIER", "DA-EXPORT-SWITCH"],
    "validate_content": ["DA-SCOPE-STRUCTURED", "DA-DATA-PERIOD", "DA-PURPOSE", "DA-EXPORT-TIER", "DA-STAGE-OWNER"],
    "classify_tier": ["DA-TIER-MAX"],
    "compare_content": ["DA-CHANGE-COMPARE", "DA-CHANGE-PURPOSE"],
    "diff_content": ["DA-DIFF"],
    "find_overlaps": ["DA-OVERLAP-COVERED", "DA-OVERLAP-PARTIAL"],
    "stage_scopes": ["DA-STAGE-OWNER"],
    "automated_checks": ["DA-MIS-CHECK"],
    "build_fulfilment": ["DA-FULFIL-RULE"],
    "build_verification_cases": ["DA-VERIFY-CASES"],
    "on_grant_event": ["DA-DC-WITHDRAW"],
    "describe_entitlements": ["DA-ENTITLEMENT"],
    "evaluate_constraints": ["DA-ENTITLEMENT"]
  }
}
```

`case_no_prefix`、`hook_rules` 骨幹沒有定義，是本流程包需要、建議加入骨幹的登記項目（見回報的骨幹修改建議）。`hook_rules` 的意思：核心依某個 hook 的結果寫稽核事件時，除了自己的 `K-*` 代碼，再附上這裡列的流程包規則代碼。例如送審時的級別判定事件附 `DA-TIER-MAX`。完整的表單定義（§2.3）在登記時放進同一份資料的 `form_schema` 鍵。

## 2. 內容結構與表單定義

### 2.1 內容（`case_version` 的內容）

```json
{
  "scope": [
    {
      "package": "sales_order",
      "fields": [
        {"code": "amount", "classification": "L3"},
        {"code": "order_no", "classification": "L3"}
      ],
      "row_filters": [
        {"filter": "region", "op": "in", "values": ["north"]}
      ]
    }
  ],
  "data_period": {"from": "2024-01-01", "to": "2024-12-31"},
  "purpose_category": "reporting",
  "purpose_description": "分析北區客戶續約率下降的原因，每季產出報告給業務主管會議。",
  "export_allowed": false
}
```

| 鍵 | 型別 | 意義 |
|---|---|---|
| `scope` | 陣列 | 資料範圍。一個元素是一個主題包。 |
| `scope[].package` | 字串 | 主題包代碼（`catalog_package.package_code`）。同一個主題包只出現一次。 |
| `scope[].fields` | 陣列，至少一個 | 申請的欄位。`code` 是欄位代碼；`classification` 是整理內容當時目錄上的分級（只會是 `L3` 或 `L4`），由 `normalize_content` 寫入，使用者送來的值會被覆蓋。 |
| `scope[].row_filters` | 陣列，可為空 | 這個主題包的列條件，全部都要成立（AND）。空陣列代表不限制資料列。同一個列條件欄位只能出現一次。 |
| `row_filters[].filter` | 字串 | 列條件欄位代碼（`catalog_filter.filter_code`）。 |
| `row_filters[].op` | `in`、`between`（輸入時另接受 `eq`） | 條件。 |
| `row_filters[].values` | 陣列 | `in`：一個以上的值。`between`：恰好兩個值 `[下限, 上限]`，含頭尾，其中一個可以是 `null`（代表不設該側的界限）。 |
| `data_period` | `{"from","to"}` 或 `null` | 資料期間：資料本身的日期範圍，含頭尾，`YYYY-MM-DD`，起日與迄日都要填。只套用在有期間欄位的主題包（`catalog_package.period_field_code` 不為 null）；至少一個選到的主題包有期間欄位時必填。和授權起迄分開存放（授權起迄在核心的 `case` 上）。 |
| `purpose_category` | 字串 | 使用情境分類代碼（`purpose_category.category_code`）。 |
| `purpose_description` | 字串，最長 500 字 | 使用情境說明。分類標示為「需說明」時必填。 |
| `export_allowed` | 布林或 `null` | 可否匯出：`false`＝只能查詢，`true`＝可以匯出成檔案。參數 `data_access.export_field_enabled` 為 false 時固定為 `null`（不區分查詢與匯出）。 |

正規形式（`normalize_content` 的輸出一律符合）：

- `scope` 依 `package` 排序；`fields` 依 `code` 排序；`row_filters` 依 `filter` 排序；`in` 的 `values` 去除重複後排序。排序一律用位元組順序（`collate "C"`），不依目錄的顯示順序，目錄調整順序不會改變內容雜湊。
- 列條件依欄位的值型別只用一種寫法：`enum` 用 `in`；`number`、`date` 用 `between`。輸入的 `eq` 會被改寫（`enum`：`in [v]`；`number`、`date`：`between [v, v]`）。
- 不含表上以外的鍵。

內容不記錄「媒介」（BI、API、查詢工具、agent）：簽核的對象是資料本身（`DA-NO-MEDIUM`）。

### 2.2 列條件的值型別

| `value_type` | 允許的 `op` | 值 | 代表的集合 |
|---|---|---|---|
| `enum` | `in` | 字串，必須是該列條件欄位的啟用值 | 有限集合 |
| `number` | `between` | JSON 數字或 `null` | 閉區間；`null` 的一側無界 |
| `date` | `between` | `YYYY-MM-DD` 字串或 `null` | 閉區間；`null` 的一側無界 |

不提供否定條件（不等於、不屬於）與自由輸入的 SQL：否定條件無法穩定判斷縮小與涵蓋，依「一律從嚴」不開放。

### 2.3 表單定義（`form_schema`）

```json
{
  "fields": [
    {
      "key": "scope",
      "type": "custom",
      "component": "data_access.scope_picker",
      "label": "資料範圍",
      "help": "先選主題包，再勾選欄位。列條件只能從清單選，不開放自由輸入條件。",
      "required": true,
      "summary": true,
      "reducible": true
    },
    {
      "key": "data_period",
      "type": "date_range",
      "label": "資料期間",
      "help": "資料本身的時間範圍，例如只能看哪幾年的訂單。和授權起迄是兩回事。",
      "required": false,
      "summary": true,
      "reducible": true
    },
    {
      "key": "purpose_category",
      "type": "select",
      "label": "使用情境分類",
      "options_source": "api.data_access_purpose_category_list",
      "required": true,
      "summary": true,
      "reducible": false
    },
    {
      "key": "purpose_description",
      "type": "textarea",
      "label": "使用情境說明",
      "max_length": 500,
      "required": false,
      "summary": true,
      "reducible": false
    },
    {
      "key": "export_allowed",
      "type": "boolean",
      "label": "可否匯出",
      "true_label": "可以匯出成檔案",
      "false_label": "只能查詢",
      "default": false,
      "help": "L4 預設只能查詢。",
      "enabled_setting": "data_access.export_field_enabled",
      "required": true,
      "summary": true,
      "reducible": false
    }
  ]
}
```

| 欄位 | 型別（骨幹第 10 節） | 摘要欄位 | 簽核人可縮小 | 說明 |
|---|---|---|---|---|
| `scope` | `custom`（`data_access.scope_picker`） | 是 | 是 | 取消勾選欄位、移除主題包、新增或收緊列條件 |
| `data_period` | `date_range` | 是 | 是 | 只能縮在原範圍內 |
| `purpose_category` | `select` | 是 | 否 | 修改使用情境算擴大 |
| `purpose_description` | `textarea` | 是 | 否 | 同上 |
| `export_allowed` | `boolean` | 是 | 否 | rules.md 列出簽核人可縮小的項目只有資料範圍、授權起迄、資料期間，所以不開放簽核人直接改。申請人在退回後把「可以匯出」改成「只能查詢」，`compare_content` 判為縮小 |

說明：

- 被授權者與授權起迄不在 `form_schema`（§0.2）。授權起迄由核心處理，簽核人可以縮短。
- `required` 只表示核心的必填檢查；`data_period`、`purpose_description` 的「有條件必填」由 `validate_content` 檢查。
- 屬性 `key`、`type`、`label`、`help`、`required`、`summary`、`reducible`、`max_length` 與 03-pack-seal.md 相同。本流程包另外需要三個屬性（骨幹第 10 節只列出欄位型別，這些是對表單定義格式的假設）：
  - `options_source`：`select` 的選項由這個對外 function 即時提供（回傳 `[{"value","label"}]`）。使用情境分類可以在後台調整，不能在升版時寫死。
  - `enabled_setting`：這個布林參數為 false 時，表單不顯示這個欄位。
  - `true_label`、`false_label`、`default`：布林欄位兩個選項的文字與預設值。
- `date_range` 的值格式假設為 `{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}`。
- 流程包實作了 `summarize_content`，清單與簽核畫面的摘要事實以它的回傳為準；`summary` 屬性只在 hook 沒登記時才有作用，這裡仍然標示，讓兩者一致。

### 2.4 專屬元件

| 元件名稱 | 用在 | 值 | 模式 |
|---|---|---|---|
| `data_access.scope_picker` | 新申請、簽核詳情、申請單詳情 | `scope` 陣列（§2.1） | `edit`：自由選取；`reduce`：以送來的值為上限，只能取消勾選欄位、移除主題包、新增或收緊列條件；`readonly`：只顯示 |
| `data_access.rule_set_view` | 執行詳情、證據頁 | 執行內容（§8.1） | 只顯示；提供「複製規則」「下載規則檔」 |

`scope_picker` 用 `api.data_access_catalog_search` 搜尋主題包，用 `api.data_access_catalog_get` 取得已選主題包的名稱與值域。L1、L2 欄位顯示為「自動給」且不能勾選。`reduce` 模式只是讓簽核人不會選出會被擋下的內容；是否縮小一律由資料庫的 `compare_content` 判定。資料擁有者關的簽核人，畫面預設只展開他負責的主題包。

## 3. 路徑

路徑（`approval_policy`）版本 1，生效時間為 migration 套用時。一個流程類型一份路徑，關卡用「適用條件」決定哪些級別會經過。

### 3.1 關卡定義

| 順序 | 代碼 | 名稱 | 階段 | resolver | 參數 | 模式 | 並行群組 | 適用條件 | 時限參數 |
|---|---|---|---|---|---|---|---|---|---|
| 10 | `manager` | 申請人主管 | `approval` | `applicant_manager` | — | 逐一 | 無 | 全部級別 | 催辦 `approval.remind_after_workdays`；升級 `approval.escalate_after_workdays` |
| 20 | `data_owner` | 資料擁有者 | `approval` | `scoped_role` | `role = data_owner` | 並行 | 無 | 全部級別 | 同上 |
| 30 | `ciso` | 資安長 | `approval` | `role_holder` | `role = ciso` | 逐一 | 無 | 只有 `L4` | 同上 |
| 40 | `mis` | MIS 合規檢查 | `approval` | `role_group_claim` | `role = mis` | 逐一 | 無 | 全部級別 | 同上 |
| 50 | `dc_apply` | DC 套用 | `fulfilment` | `role_group_claim` | `role = mis` | 逐一 | 無 | 全部級別 | 同上 |

- 「逐一」（`sequential`）：這一關只有一件工作，一人決定。「並行」（`parallel`）：resolver 解析出的每個人各一件工作，全部核准才往下（`K-PARALLEL-ALL`）。
- 第 20 關的範圍由 `stage_scopes('data_owner', 內容)` 回傳主題包代碼，核心對每個代碼找 `role = data_owner`、`scope_ref = 主題包代碼` 的持有人。
- 四個簽核關都宣告催辦與升級的參數（rules.md：逾時規則「所有關卡都適用」）。
- 資安長的代理人用核心的 `delegation`（`K-DELEGATE`）。
- `dc_apply` 是執行關，不是簽核關：`mis` 關核准之後才開始，工作內容是「到 DC 套用規則並標記完成」。宣告方式沿用 03-pack-seal.md 的做法（路徑裡 `phase = "fulfilment"` 的關卡）；預設由核准 `mis` 關的人接續（前提 B9）。

### 3.2 各級別實際經過的關卡

| 級別 | 簽核路徑 | 之後 |
|---|---|---|
| `L3` | `manager` → `data_owner`（並行）→ `mis` | `dc_apply`（執行）→ 自動驗證 → 申請人確認 |
| `L4` | `manager` → `data_owner`（並行）→ `ciso` → `mis` | 同上 |

L3 與 L4 用同一套關卡定義與同一組時限參數，差別只有 L4 多一關 `ciso`、有效期間上限較短、預設不可匯出。

### 3.3 人工檢查清單

| 關卡 | 代碼 | 文字 |
|---|---|---|
| `mis` | `purpose_matches_scope` | 使用情境和資料範圍相符，沒有要求超過用途的欄位 |
| `mis` | `environment_compliant` | 被授權者使用的系統環境符合資安政策 |
| `mis` | `export_reasonable` | 匯出設定合理 |
| `dc_apply` | `dc_rule_applied` | 已在 DC 依下方規則逐條套用 |
| `dc_apply` | `dc_grantee_matched` | 已核對 DC 上的被授權者與本單相同 |

其他關卡沒有人工檢查清單。每一項都要勾選才能核准或標記完成。

### 3.4 登記資料

```json
{
  "process_type": "data_access",
  "version": 1,
  "stages": [
    {
      "seq": 10, "code": "manager", "name": "申請人主管", "phase": "approval",
      "resolver": {"kind": "applicant_manager"},
      "mode": "sequential", "parallel_group": null, "applies_when": null,
      "sla": {"remind": "approval.remind_after_workdays", "escalate": "approval.escalate_after_workdays"},
      "checklist": []
    },
    {
      "seq": 20, "code": "data_owner", "name": "資料擁有者", "phase": "approval",
      "resolver": {"kind": "scoped_role", "role": "data_owner"},
      "mode": "parallel", "parallel_group": null, "applies_when": null,
      "sla": {"remind": "approval.remind_after_workdays", "escalate": "approval.escalate_after_workdays"},
      "checklist": []
    },
    {
      "seq": 30, "code": "ciso", "name": "資安長", "phase": "approval",
      "resolver": {"kind": "role_holder", "role": "ciso"},
      "mode": "sequential", "parallel_group": null, "applies_when": {"tier_in": ["L4"]},
      "sla": {"remind": "approval.remind_after_workdays", "escalate": "approval.escalate_after_workdays"},
      "checklist": []
    },
    {
      "seq": 40, "code": "mis", "name": "MIS 合規檢查", "phase": "approval",
      "resolver": {"kind": "role_group_claim", "role": "mis"},
      "mode": "sequential", "parallel_group": null, "applies_when": null,
      "sla": {"remind": "approval.remind_after_workdays", "escalate": "approval.escalate_after_workdays"},
      "checklist": [
        {"code": "purpose_matches_scope", "label": "使用情境和資料範圍相符，沒有要求超過用途的欄位", "required": true},
        {"code": "environment_compliant", "label": "被授權者使用的系統環境符合資安政策", "required": true},
        {"code": "export_reasonable", "label": "匯出設定合理", "required": true}
      ]
    },
    {
      "seq": 50, "code": "dc_apply", "name": "DC 套用", "phase": "fulfilment",
      "resolver": {"kind": "role_group_claim", "role": "mis"},
      "continue_from_stage": "mis",
      "mode": "sequential", "parallel_group": null, "applies_when": null,
      "sla": {"remind": "approval.remind_after_workdays", "escalate": "approval.escalate_after_workdays"},
      "checklist": [
        {"code": "dc_rule_applied", "label": "已在 DC 依下方規則逐條套用", "required": true},
        {"code": "dc_grantee_matched", "label": "已核對 DC 上的被授權者與本單相同", "required": true}
      ]
    }
  ]
}
```

骨幹沒有定義、這裡採用的寫法：`mode` 的值（`sequential`、`parallel`）、`applies_when` 的格式（`null`＝全部級別；`{"tier_in": [...]}`＝列出的級別）、`phase`、`sla` 的鍵、`checklist` 的元素格式，都和 03-pack-seal.md 相同。`continue_from_stage` 是本流程包另外需要的（前提 B9）。

### 3.5 角色

| 角色代碼 | 名稱 | 類型 | 用在 |
|---|---|---|---|
| `data_owner` | 資料擁有者 | 依範圍（`scope_ref`＝主題包代碼）；指派來源為目錄同步 | 第 20 關 |
| `ciso` | 資安長 | 單一持有人 | 第 30 關 |
| `mis` | MIS | 群組認領 | 第 40、50 關 |

三個角色由本流程包的登記檔以 `register_role` 登記（已存在且屬性相同時不動作）。`sys_admin`、`auditor` 屬於核心。

## 4. 資料表與維護用的 function

### 4.1 DDL

```sql
create schema pack_data_access authorization sgn_owner;

create type pack_data_access.classification as enum ('L1', 'L2', 'L3', 'L4');
create type pack_data_access.filter_value_type as enum ('enum', 'number', 'date');
create type pack_data_access.dc_rule_status as enum ('applied', 'withdraw_pending', 'withdrawn', 'lapsed');

-- 每次目錄同步一筆；只增不改（觸發器擋下 update、delete、truncate）
create table pack_data_access.catalog_sync_run (
    sync_run_id            bigint generated always as identity primary key,
    synced_at              timestamptz not null,
    actor_id               bigint not null,
    source                 text not null check (btrim(source) <> ''),
    snapshot_hash          text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
    snapshot               jsonb,
    unchanged_since_run_id bigint references pack_data_access.catalog_sync_run,
    result                 jsonb not null,
    constraint catalog_sync_run_snapshot_or_reference
        check ((snapshot is null) <> (unchanged_since_run_id is null))
);

create table pack_data_access.catalog_package (
    package_code      text primary key check (package_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name              text not null check (btrim(name) <> ''),
    description       text not null default '',
    period_field_code text,
    sort_order        integer not null,
    is_active         boolean not null default true,
    updated_run_id    bigint not null references pack_data_access.catalog_sync_run
);

create table pack_data_access.catalog_field (
    package_code   text not null references pack_data_access.catalog_package,
    field_code     text not null check (field_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name           text not null check (btrim(name) <> ''),
    classification pack_data_access.classification not null,
    sort_order     integer not null,
    is_active      boolean not null default true,
    updated_run_id bigint not null references pack_data_access.catalog_sync_run,
    primary key (package_code, field_code)
);

alter table pack_data_access.catalog_package
    add constraint catalog_package_period_field_fk
    foreign key (package_code, period_field_code)
    references pack_data_access.catalog_field (package_code, field_code)
    deferrable initially deferred;

create table pack_data_access.catalog_filter (
    package_code   text not null references pack_data_access.catalog_package,
    filter_code    text not null check (filter_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name           text not null check (btrim(name) <> ''),
    value_type     pack_data_access.filter_value_type not null,
    sort_order     integer not null,
    is_active      boolean not null default true,
    updated_run_id bigint not null references pack_data_access.catalog_sync_run,
    primary key (package_code, filter_code)
);

-- 只有 value_type = 'enum' 的列條件欄位有值域
create table pack_data_access.catalog_filter_value (
    package_code   text not null,
    filter_code    text not null,
    value          text not null check (value <> ''),
    label          text not null check (btrim(label) <> ''),
    sort_order     integer not null,
    is_active      boolean not null default true,
    updated_run_id bigint not null references pack_data_access.catalog_sync_run,
    primary key (package_code, filter_code, value),
    foreign key (package_code, filter_code)
        references pack_data_access.catalog_filter (package_code, filter_code)
);

create table pack_data_access.purpose_category (
    category_code        text primary key check (category_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name                 text not null check (btrim(name) <> ''),
    requires_description boolean not null default false,
    sort_order           integer not null,
    is_active            boolean not null default true,
    updated_at           timestamptz not null,
    updated_by           bigint not null
);

-- 應該存在於 DC 的規則；由 on_grant_event 維護
create table pack_data_access.dc_rule (
    rule_id       text primary key,
    grant_id      bigint not null,
    case_id       bigint not null,
    case_no       text not null,
    package_code  text not null,
    rule          jsonb not null,
    status        pack_data_access.dc_rule_status not null default 'applied',
    applied_at    timestamptz not null,
    ended_at      timestamptz,
    ended_event   text check (ended_event in ('expired', 'revoked')),
    withdrawn_at  timestamptz,
    withdrawn_by  bigint,
    withdraw_note text,
    constraint dc_rule_ended_consistent
        check ((status = 'applied') = (ended_at is null)),
    constraint dc_rule_withdrawn_consistent
        check ((status = 'withdrawn') = (withdrawn_at is not null))
);

create index dc_rule_grant_idx on pack_data_access.dc_rule (grant_id);
create index dc_rule_pending_idx on pack_data_access.dc_rule (status) where status = 'withdraw_pending';
```

權限：schema 與所有物件的擁有者是 `sgn_owner`；`sgn_app` 對這個 schema 沒有任何權限（連 `usage` 都沒有）。

設計說明：

- 目錄的四張表是 DC 資料目錄的鏡像，只有 `catalog_sync` 會寫入（`DA-CATALOG-SOURCE`）。資料列不刪除，目錄上消失的項目改成 `is_active = false`，舊申請單仍然查得到名稱。每次同步的原始內容保存在 `catalog_sync_run.snapshot`，所以任何時間點的目錄都可以重建。
- 資料擁有者不存在流程包的表裡：以核心的 `role_assignment`（`role = data_owner`、`scope_ref = package_code`）為唯一來源，由 `catalog_sync` 透過 D8 同步。
- `purpose_category` 做成代碼表而不是參數，原因是申請內容引用分類代碼，代碼不能被刪除；停用的分類仍然要能顯示名稱。資料列不刪除，只能停用；每次修改寫一筆稽核事件（含修改前後的值）。
- `dc_rule` 是「本站認為 DC 上應該有哪些規則」的帳。撤銷之後 DC 上的規則必須撤回，這張表讓「撤銷」到「DC 實際撤回」之間的時間差看得見（見 §8.3）。

### 4.2 目錄同步：`catalog_sync`

對外入口是 `api.data_access_catalog_sync(p_actor, p_snapshot)`（§6.1）。一次呼叫是一份完整的快照；整份在同一個交易裡套用，任何檢查失敗就整份不套用。

#### 匯入格式

```json
{
  "format": "data_access_catalog/1",
  "source": "dc_export_file",
  "packages": [
    {
      "code": "sales_order",
      "name": "銷售訂單",
      "description": "ERP 銷售訂單明細",
      "owner": {"provider": "seed", "external_id": "p11"},
      "period_field": "order_date",
      "fields": [
        {"code": "order_no", "name": "訂單編號", "classification": "L3"},
        {"code": "order_date", "name": "訂單日期", "classification": "L3"}
      ],
      "filters": [
        {
          "code": "region", "name": "區域", "value_type": "enum",
          "values": [
            {"value": "north", "label": "北區"},
            {"value": "central", "label": "中區"}
          ]
        },
        {"code": "order_amount", "name": "訂單金額", "value_type": "number"}
      ]
    }
  ]
}
```

| 鍵 | 必填 | 檢查 |
|---|---|---|
| `format` | 是 | 必須等於 `data_access_catalog/1` |
| `source` | 是 | 非空字串；寫進 `catalog_sync_run.source` |
| `packages` | 是 | 非空陣列（空陣列丟 `DA-E-CATALOG-EMPTY`，避免誤把整個目錄停用） |
| `packages[].code` | 是 | 符合 `^[a-z][a-z0-9_]{0,62}$`；整份快照內不重複。DC 的識別字不符合時，由資料目錄 adapter 負責對應 |
| `packages[].name` | 是 | 非空字串 |
| `packages[].description` | 否 | 字串；預設空字串 |
| `packages[].owner` | 否 | `{"provider","external_id"}`，對應核心的 `person_identity`；省略或為 `null` 代表目錄上沒有擁有者 |
| `packages[].period_field` | 否 | `null`，或這個主題包 `fields` 裡的一個 `code`（任何分級皆可） |
| `packages[].fields` | 是 | 非空陣列；`code` 在主題包內不重複；`classification` 是 `L1`–`L4` |
| `packages[].filters` | 否 | 陣列，預設空；`code` 在主題包內不重複；`value_type` 是 `enum`、`number`、`date` |
| `filters[].values` | `enum` 必填 | 非空陣列；`value` 是非空字串且在該列條件欄位內不重複；`label` 非空。`number`、`date` 不得有 `values` |

`sort_order` 取陣列中的位置（從 1 開始）。格式錯誤丟 `DA-E-CATALOG-FORMAT`，訊息參數是第一個錯誤的位置與原因，例如 `packages[1].fields[3].classification：必須是 L1–L4`；代碼重複丟 `DA-E-CATALOG-DUPLICATE`。

#### 演算法

```
catalog_sync(p_actor, p_snapshot):
 1. 授權：p_actor 是系統 actor 或持有 sys_admin；否則由 D4 丟錯
 2. 檢查格式（上表）；失敗就丟錯，不留任何紀錄
 3. hash := sha256(p_snapshot::text) 的十六進位字串（pgcrypto digest）
 4. changes := catalog_diff(p_snapshot)         -- 與目前四張表逐項比較，不寫入
 5. 解析擁有者：對每個 package，
        person_id := resolve_person(owner.provider, owner.external_id)
        找不到人、人已不在職、或 owner 為 null → 記入 owner_missing，該 package 不產生指派
        否則 → assignments 加一筆 {"scope_ref": code, "person_id": person_id}
    已停用（快照裡沒有）的 package 不產生指派
    與 package_owner_ids(code) 的現況不同時，changes 加一筆 owner_changed 或 owner_missing
 6. impacts := catalog_impacts(changes)          -- 見下方「影響」
 7. 寫入 catalog_sync_run：
        hash 與前一筆相同 → snapshot = null，unchanged_since_run_id = 最近一筆有 snapshot 的 run
        否則             → snapshot = p_snapshot
        result = {"changed": changes 非空, "counts", "changes", "impacts"}
 8. 套用到四張表：
        快照裡有的項目：新增，或更新 name、description、classification、value_type、label、
                        sort_order、period_field_code，並設 is_active = true
        快照裡沒有、表裡 is_active = true 的項目：設 is_active = false
        （package 停用時，它的 field、filter、filter_value 一併停用）
        有變動的資料列才更新，並把 updated_run_id 設為這次的 run
 9. sync_scoped_role_assignments(p_actor, 'data_owner', 'data_access.catalog_sync', assignments)
10. write_audit(p_actor, 'data_access.catalog_synced', 'DA-CATALOG-SOURCE', null,
                {"sync_run_id", "snapshot_hash", "counts"})
11. impacts 非空 → 通知 data_access.catalog_sync_impact：sys_admin 群組＋受影響主題包的資料擁有者
    owner_missing 非空 → 通知 data_access.catalog_owner_missing：sys_admin 群組
12. 回傳 {"sync_run_id", "changed", "counts", "changes", "impacts"}
```

相同的快照重複匯入：`changes` 為空，四張表不變，仍然寫一筆 `catalog_sync_run` 與一筆稽核事件（證明這個時間點同步過）。步驟 5 每次都重新解析，所以擁有者離職後的下一次同步會把該主題包列為 `owner_missing`。

#### `changes` 的種類

| `kind` | 其他鍵 | 意義 |
|---|---|---|
| `package_added`、`package_reactivated`、`package_deactivated` | `package` | |
| `package_renamed` | `package`、`from`、`to` | |
| `period_field_changed` | `package`、`from`、`to` | 期間欄位改變（含變成 null） |
| `field_added`、`field_reactivated`、`field_deactivated` | `package`、`field` | |
| `field_renamed` | `package`、`field`、`from`、`to` | |
| `field_reclassified` | `package`、`field`、`from`、`to` | 分級改變 |
| `filter_added`、`filter_reactivated`、`filter_deactivated` | `package`、`filter` | |
| `filter_type_changed` | `package`、`filter`、`from`、`to` | |
| `filter_value_added`、`filter_value_deactivated` | `package`、`filter`、`value` | |
| `owner_changed` | `package`、`from_person_id`、`to_person_id` | |
| `owner_missing` | `package` | 目錄上沒有擁有者，或對應不到在職的人 |

`changes` 的順序：依 `package`、種類在上表的順序、`field` 或 `filter`、`value`。`counts` 是各種類的筆數，例如 `{"field_reclassified": 1, "owner_changed": 1}`。

#### 影響（`impacts`）

下列變更會讓已核准或簽核中的內容和目錄不一致：`field_reclassified`（`to` 高於 `from`，且 `to` 是 `L4`）、`field_deactivated`、`package_deactivated`、`filter_deactivated`、`filter_type_changed`、`filter_value_deactivated`、`period_field_changed`。對每一筆這樣的變更，找出內容引用到該項目的申請單（`referencing_cases()`：狀態為 `in_approval`、`returned`、`pending_fulfilment`、`verifying`、`active`）：

```json
{"case_id": 31, "case_no": "DA-2026-0003", "status": "active",
 "change": {"kind": "field_reclassified", "package": "product_cost", "field": "product_id", "from": "L3", "to": "L4"}}
```

系統不自動撤銷或退回受影響的單（人做決定，系統只執行）：通知系統管理員與資料擁有者，由他們決定是否撤銷（`K-REVOKE`）。簽核中的單在下一關的自動檢查會出現 `DA-CHK-CATALOG` 失敗（§5.9）。

範例：種子目錄已匯入後，再匯入一份把 `customer_master.contract_end_date` 從 L3 改成 L4、其餘相同的快照，回傳：

```json
{
  "sync_run_id": 2,
  "changed": true,
  "counts": {"field_reclassified": 1},
  "changes": [
    {"kind": "field_reclassified", "package": "customer_master", "field": "contract_end_date", "from": "L3", "to": "L4"}
  ],
  "impacts": []
}
```

### 4.3 內部 function

全部在 `pack_data_access`，擁有者 `sgn_owner`，不對 `sgn_app` 開放。

**核心存取**（流程包讀取核心資料只透過這一組；核心的資料表或欄位名稱與假設不同時，只改這裡）

| Function | 回傳 | 內容 |
|---|---|---|
| `case_context(p_case_id bigint)` | `table(case_id bigint, case_no text, status text, tier text, applicant_id bigint, principal_id bigint, principal_type text, principal_name text, principal_ends_on date, valid_from date, valid_to date, source_case_id bigint, source_kind text, version_no integer, content jsonb)` | 一張單與它目前版本的內容。找不到、或流程類型不是 `data_access` 時丟 `DA-E-CASE-NOT-FOUND` |
| `active_grants(p_principal_id bigint)` | `table(grant_id bigint, case_id bigint, case_no text, valid_from date, valid_to date, content jsonb)` | 這個被授權者所有 `grant.status = 'active'` 的資料授權，以及各自申請單目前版本的內容 |
| `referencing_cases()` | `table(case_id bigint, case_no text, status text, content jsonb)` | 狀態為 `in_approval`、`returned`、`pending_fulfilment`、`verifying`、`active` 的資料授權申請單 |
| `grant_context(p_grant_id bigint)` | `table(grant_id bigint, case_id bigint, case_no text, valid_to date, rule_set jsonb)` | 授權對應的申請單，以及最近一次執行完成時核心保存的執行內容（`fulfilment` 的 payload） |
| `package_owner_ids(p_package_code text)` | `setof bigint` | `role = data_owner`、`scope_ref = p_package_code` 目前有效且在職的持有人 |
| `resolve_person(p_provider text, p_external_id text)` | `bigint` | 依 `person_identity` 找在職的人；找不到回 `null` |
| `setting_boolean(p_key text, p_tier text default null)` | `boolean` | `sgn_internal.setting(p_key, p_scope)` 轉成布林；`p_scope` 是 `{"process": "data_access"}`，`p_tier` 不是 null 時再加 `"tier": p_tier` |
| `person_name(p_person_id bigint)` | `text` | 人員的顯示名稱；找不到回 `null` |
| `template_content(p_template_id bigint)` | `jsonb` | 資料授權的標準範本內容；找不到、不是資料授權、不是標準範本時回 `null` |

假設的核心欄位（主鍵與流程類型欄位的寫法和 03-pack-seal.md、05-integration 的假設相同）：`sgn."case"(id, case_no, process_type_code, status, tier_code, applicant_id, principal_id, valid_from, valid_to, source_case_id, source_kind, current_version_id)`、`sgn.case_version(id, case_id, version_no, content)`、`sgn.principal(id, principal_type, name, ends_on)`、`sgn."grant"(id, case_id, principal_id, valid_from, valid_to, status)`、`sgn.fulfilment(case_id, payload, completed_at)`、`sgn.person_identity(provider, external_id, person_id)`、`sgn.person(id, name, status)`、`sgn.case_template(id, process_type_code, name, content, is_standard, retired_at)`。授權起迄是日期（含頭尾）。`source_kind` 的值假設為 `renewal`（續期）、`reuse`（沿用前案）、`template`（範本）。

**目錄**

| Function | 回傳 | 內容 |
|---|---|---|
| `catalog_validate_snapshot(p_snapshot jsonb)` | `void` | §4.2 的格式檢查 |
| `catalog_diff(p_snapshot jsonb)` | `jsonb` | §4.2 的 `changes`（不含擁有者） |
| `catalog_impacts(p_changes jsonb)` | `jsonb` | §4.2 的 `impacts` |
| `catalog_apply_snapshot(p_snapshot jsonb, p_run_id bigint)` | `void` | §4.2 步驟 8 |
| `catalog_package_json(p_package_code text, p_include_inactive boolean)` | `jsonb` | 一個主題包的完整描述（§6.1 的元素格式） |
| `package_has_period(p_package_code text)` | `boolean` | 主題包存在且 `period_field_code` 不為 null |

**範圍運算**（演算法在 §5.0；全部 `immutable`，只看傳入的 JSON）

| Function | 回傳 |
|---|---|
| `condition_set(p_condition jsonb)` | `jsonb`：`{"kind":"enum","values":[...]}`、`{"kind":"number","lo","hi"}`、`{"kind":"date","lo","hi"}` 或 `{"kind":"unknown"}` |
| `set_within(p_inner jsonb, p_outer jsonb)` | `boolean` |
| `set_disjoint(p_a jsonb, p_b jsonb)` | `boolean` |
| `filters_within(p_inner jsonb, p_outer jsonb)` | `boolean` |
| `filters_disjoint(p_a jsonb, p_b jsonb)` | `boolean` |
| `filters_relation(p_new jsonb, p_old jsonb)` | `text`：`equal`、`stricter`、`other` |
| `period_relation(p_new jsonb, p_old jsonb)` | `text`：`equal`、`stricter`、`other` |
| `period_disjoint(p_a jsonb, p_b jsonb)` | `boolean` |

**文字**（`stable`；名稱取自目錄，查不到時顯示代碼）

| Function | 回傳 | 範例 |
|---|---|---|
| `package_name(p_package_code text)` | `text` | `銷售訂單` |
| `fields_text(p_package_code text, p_field_codes text[])` | `text` | `訂單編號、訂單金額`（依目錄的 `sort_order`、`field_code`） |
| `filters_text(p_package_code text, p_row_filters jsonb)` | `text` | `區域 屬於 北區、中區；訂單金額 介於 0～100000`；空陣列回 `全部資料列` |
| `period_text(p_period jsonb)` | `text` | `2024-01-01～2025-12-31`；`null` 回 `未指定` |
| `export_text(p_export_allowed boolean)` | `text` | `只能查詢`、`可以匯出成檔案`；`null` 回 `不區分查詢與匯出` |

`filters_text` 的單一條件格式：`in` 為「{名稱} 屬於 {標籤以「、」連接，依值域的 `sort_order`；查不到標籤時顯示值}」；`between` 兩側都有為「{名稱} 介於 {下限}～{上限}」，只有下限為「{名稱} ≥ {下限}」，只有上限為「{名稱} ≤ {上限}」；無法辨識的條件為「{名稱}（無法辨識的條件）」。多個條件依目錄的 `sort_order` 排列，以「；」連接。

**其他**

| Function | 回傳 | 內容 |
|---|---|---|
| `reject_change()` | `trigger` | `catalog_sync_run` 的只增不改觸發器；丟 `DA-E-APPEND-ONLY` |

## 5. hook 的實作規格

共同規定：

- 簽章、回傳格式照骨幹第 6 節。hook 不寫核心資料表；除了 `on_grant_event`，也不寫流程包資料表。
- 訊息文字（提示、檢查結果、錯誤）一律用 `sgn_internal.error_message(代碼, 參數…)` 從訊息目錄取得，不在 function 裡寫死文字（代碼與文字在 §7.4、§7.5）。
- 輸入的內容不符合 §2.1 的結構時，hook 不丟例外，而是往嚴格的方向回傳（`classify_tier` 回 `L4`、`compare_content` 回 `expand`、`find_overlaps` 不會回 `covered`）。例外只用在「這張單不是資料授權」這類呼叫錯誤。
- 範例裡的主題包、欄位、分級、值域見 [acceptance-cases.md §1.1](../packs/data-access/acceptance-cases.md)。重點：`customer_master.industry` 是 L1、`sales_order.channel` 是 L2、`sales_order.gross_margin` 是 L4；`customer_master` 沒有期間欄位，`sales_order` 的期間欄位是 `order_date`；`region` 的值域是 `north`、`central`、`south`、`east`。

### 5.0 範圍運算：什麼叫「更嚴」

`compare_content`（縮小判定）與 `find_overlaps`（涵蓋判定）共用同一組運算。原則：**只在能證明的時候回答「是」；任何無法判定的情況都回答「否」**，呼叫端因此落到 `expand` 或 `partial`。

#### 條件代表的集合：`condition_set(條件)`

```
op := 條件.op；v := 條件.values
v 不是陣列                               → unknown
op = 'in'
    元素至少一個，且全部是字串            → enum，values = 去除重複後排序
    其他                                 → unknown
op = 'eq'
    恰好一個元素：字串                    → enum，values = [該值]
    恰好一個元素：數字                    → number，lo = hi = 該值
    其他                                 → unknown
op = 'between'
    不是恰好兩個元素，或兩個都是 null     → unknown
    兩個元素都是「數字或 null」           → number，lo = 第一個，hi = 第二個
    兩個元素都是「有效的 YYYY-MM-DD 字串或 null」 → date，lo、hi 同上
    其他（數字與字串混用、日期無效）      → unknown
    lo、hi 都不是 null 且 lo > hi         → unknown
其他 op                                   → unknown
```

#### 集合之間的關係

| 運算 | `enum` | `number`、`date`（閉區間，`null` 代表該側無界） | 任一方 `unknown`，或兩方種類不同 |
|---|---|---|---|
| `set_within(a, b)`：a 是 b 的子集 | a 的每個值都在 b 裡 | （b.lo 為 null，或 a.lo 不為 null 且 a.lo ≥ b.lo）而且（b.hi 為 null，或 a.hi 不為 null 且 a.hi ≤ b.hi） | `false` |
| `set_disjoint(a, b)`：a 與 b 沒有交集 | 沒有共同的值 | （a.hi、b.lo 都不為 null 且 a.hi < b.lo）或（b.hi、a.lo 都不為 null 且 b.hi < a.lo） | `false` |

#### 一組列條件之間的關係

一組列條件是同一個主題包的 `row_filters` 陣列，條件之間是 AND。沒有設定條件的列條件欄位代表不限制。

```
filters_within(inner, outer)：inner 和 outer 一樣嚴或更嚴
    inner 或 outer 不是陣列                         → false
    inner 或 outer 裡有重複的 filter 代碼            → false
    對 outer 的每個條件 co：
        ci := inner 裡 filter 相同的條件；沒有       → false
        ci 與 co 的 JSON 完全相同                   → 通過，看下一個
        set_within(condition_set(ci), condition_set(co)) 為 false → false
    → true
    （inner 多出來的條件只會更嚴，不影響結果；outer 為空陣列時一律 true）

filters_disjoint(a, b)：能證明 a 與 b 沒有共同的資料列
    a 或 b 不是陣列，或任一方有重複的 filter 代碼    → false
    存在一個 filter 代碼，a、b 各有一個條件，
        且 set_disjoint(兩個條件的集合) 為 true      → true
    → false

filters_relation(new, old)
    new 與 old 是同一組條件（不計順序，逐一 JSON 相同） → 'equal'
    filters_within(new, old)                           → 'stricter'
    → 'other'
```

#### 資料期間之間的關係

「有效的期間」指物件、`from` 與 `to` 都是有效日期、`from ≤ to`。

```
period_relation(new, old)
    new 與 old 的 JSON 相同（包含都是 null）          → 'equal'
    old 是 null，new 是有效的期間                     → 'stricter'（原本沒有限制，現在加上限制）
    兩者都是有效的期間，new.from ≥ old.from 且 new.to ≤ old.to → 'stricter'
    → 'other'（包含 new 是 null 而 old 不是）

period_disjoint(a, b)
    兩者都是有效的期間，且 a.to < b.from 或 b.to < a.from → true
    → false
```

#### 判定表

| 原條件（old／既有授權） | 新條件（new／本次申請） | `set_within(new, old)` | 說明 |
|---|---|---|---|
| `region in [central, north]` | `region in [north]` | true | 值集合是子集 |
| `region in [north]` | `region in [central, north]` | false | 多了 `central` |
| `region in [north]` | `region in [north]` | true | 相同 |
| `order_amount between [0, 100000]` | `order_amount between [1000, 50000]` | true | 區間被包含 |
| `order_amount between [0, 100000]` | `order_amount between [0, 200000]` | false | 上限超出 |
| `order_amount between [null, 100000]` | `order_amount between [0, 100000]` | true | 原本下限無界 |
| `order_amount between [0, 100000]` | `order_amount between [0, null]` | false | 新條件上限無界 |
| `order_amount between [0, 100000]` | `order_amount between [100000, 100000]` | true | 邊界值，含頭尾 |
| `region in [north]` | `region between ["a", "z"]` | false | 種類不同（`unknown`），無法判定 |
| （沒有條件） | `region in [north]` | —（`filters_within` 為 true） | 新增條件只會更嚴 |
| `region in [north]` | （沒有條件） | —（`filters_within` 為 false） | 拿掉條件是擴大 |
| `region in [north, central, south, east]`（整個值域） | （沒有條件） | —（`filters_within` 為 false） | 「列出全部的值」不等於「不限制」：值域之後可能增加 |

### 5.1 `normalize_content`

```sql
pack_data_access.normalize_content(p_actor bigint, p_content jsonb) returns jsonb
```

用途：把輸入整理成 §2.1 的正規形式；移除不需要申請或已經不存在的項目，並告訴申請人（`DA-TIER-AUTO-GRANT`）。只往「更少」的方向調整，不會幫使用者加上任何東西。`p_actor` 不影響結果。

演算法：

```
 1. p_content 是 null 或不是物件 → 視為 {}
 2. scope := p_content.scope；不是陣列 → []
    每個元素取 package（字串）、fields（不是陣列 → []）、row_filters（不是陣列 → []）；
    沒有 package 的元素捨棄
    同一個 package 出現多次 → 合併成一個：fields 取聯集、row_filters 依序串接
 3. 依 package 排序後，逐一處理每個主題包 P：
    3a. 目錄上找不到 P，或 P 已停用
            → 移除，notice DA-N-PACKAGE-UNAVAILABLE（參數：P 的名稱，查不到名稱時用代碼）
    3b. fields 的每個元素：字串就是欄位代碼；物件取它的 code；其他型別捨棄。去除重複後依代碼排序，逐一查目錄：
            找不到或已停用 → 移除，notice DA-N-FIELD-UNAVAILABLE（主題包名稱、欄位名稱或代碼）
            分級是 L1 或 L2 → 移除，notice DA-N-AUTO-GRANTED（主題包名稱、欄位名稱、分級）
            分級是 L3 或 L4 → 保留為 {"code": 代碼, "classification": 目錄上現在的分級}
    3c. fields 變成空的 → 移除整個主題包，notice DA-N-PACKAGE-EMPTY（主題包名稱）
    3d. row_filters 的每個條件：只保留 filter、op、values 三個鍵；values 不是陣列時包成單一元素的陣列。
        在目錄上找得到這個列條件欄位（且啟用）時，依它的 value_type 改寫：
            enum：op 是 eq → 改成 in；op 是 in → values 去除重複並排序
            number、date：op 是 eq 且恰好一個值 v → 改成 between，values = [v, v]
        找不到時原樣保留（由 validate_content 回報錯誤）。
        列條件不會被移除，也不會被合併：移除列條件等於擴大範圍。
        最後依（filter、op、values 的文字）排序
 4. data_period := p_content.data_period
        是物件 → {"from": from, "to": to}，空字串改成 null；from、to 都是 null → 整個改成 null
        其他 → null
    （主題包沒有期間欄位時，這個值不會被用到，但也不會被清掉）
 5. purpose_category := 去除前後空白；空字串或不是字串 → null
    purpose_description := 去除前後空白；不是字串 → ''
 6. export_allowed：
        setting_boolean('data_access.export_field_enabled') 為 false → null
        否則，p_content.export_allowed 不是 true → false
        否則，tier := classify_tier(步驟 3 的 scope)；
              setting_boolean('data_access.export_requestable', tier) 為 false
                  → false，notice DA-N-EXPORT-FORCED（tier）
              否則 → true
 7. 回傳 {"content": {scope, data_period, purpose_category, purpose_description, export_allowed},
           "notices": [...]}
```

`notices` 的順序就是上面產生的順序（主題包依代碼、欄位依代碼，最後是匯出）。同一份內容再整理一次，內容不變、`notices` 為空（冪等）；測試要涵蓋這一點。

範例 1：L1 欄位被移除；欄位用字串輸入；`eq` 改寫成 `in`。

```json
{
  "input": {
    "scope": [{"package": "customer_master", "fields": ["customer_id", "customer_name", "industry"],
               "row_filters": [{"filter": "region", "op": "eq", "values": ["north"]}]}],
    "purpose_category": "reporting", "purpose_description": "  每月客戶報表  ", "export_allowed": false
  },
  "output": {
    "content": {
      "scope": [{"package": "customer_master",
                 "fields": [{"code": "customer_id", "classification": "L3"}, {"code": "customer_name", "classification": "L3"}],
                 "row_filters": [{"filter": "region", "op": "in", "values": ["north"]}]}],
      "data_period": null,
      "purpose_category": "reporting", "purpose_description": "每月客戶報表", "export_allowed": false
    },
    "notices": [
      {"code": "DA-N-AUTO-GRANTED", "message": "「客戶主檔」的「產業別」是 L1 欄位，不需要申請，已自動從這張單移除。"}
    ]
  }
}
```

範例 2：含 L4 欄位又要求匯出，改成只能查詢；排序與去除重複。

```json
{
  "input": {
    "scope": [{"package": "sales_order", "fields": ["order_no", "gross_margin", "amount"],
               "row_filters": [{"filter": "region", "op": "in", "values": ["north", "central", "north"]}]}],
    "data_period": {"from": "2025-01-01", "to": "2025-12-31"},
    "purpose_category": "reporting", "purpose_description": "毛利分析", "export_allowed": true
  },
  "output": {
    "content": {
      "scope": [{"package": "sales_order",
                 "fields": [{"code": "amount", "classification": "L3"}, {"code": "gross_margin", "classification": "L4"},
                            {"code": "order_no", "classification": "L3"}],
                 "row_filters": [{"filter": "region", "op": "in", "values": ["central", "north"]}]}],
      "data_period": {"from": "2025-01-01", "to": "2025-12-31"},
      "purpose_category": "reporting", "purpose_description": "毛利分析", "export_allowed": false
    },
    "notices": [
      {"code": "DA-N-EXPORT-FORCED", "message": "這張單包含 L4 資料，L4 資料不可匯出，已改為只能查詢。"}
    ]
  }
}
```

範例 3（邊界）：選到的欄位全部是 L1、L2，主題包被移除，資料範圍變成空的（之後由 `validate_content` 擋下）。

```json
{
  "input": {"scope": [{"package": "sales_order", "fields": ["channel"], "row_filters": []}],
            "purpose_category": "reporting", "purpose_description": "", "export_allowed": false},
  "output": {
    "content": {"scope": [], "data_period": null, "purpose_category": "reporting",
                "purpose_description": "", "export_allowed": false},
    "notices": [
      {"code": "DA-N-AUTO-GRANTED", "message": "「銷售訂單」的「通路別」是 L2 欄位，不需要申請，已自動從這張單移除。"},
      {"code": "DA-N-PACKAGE-EMPTY", "message": "「銷售訂單」沒有需要申請的欄位，已從這張單移除。"}
    ]
  }
}
```

範例 4（邊界）：目錄上沒有的主題包與欄位；數字的 `eq` 改寫成 `between`。

```json
{
  "input": {
    "scope": [{"package": "vendor_master", "fields": ["vendor_id"]},
              {"package": "sales_order", "fields": ["order_no", "discount"],
               "row_filters": [{"filter": "order_amount", "op": "eq", "values": [100000]}]}],
    "data_period": {"from": "2025-01-01", "to": "2025-12-31"},
    "purpose_category": "reporting", "purpose_description": "大額訂單追蹤", "export_allowed": false
  },
  "output": {
    "content": {
      "scope": [{"package": "sales_order", "fields": [{"code": "order_no", "classification": "L3"}],
                 "row_filters": [{"filter": "order_amount", "op": "between", "values": [100000, 100000]}]}],
      "data_period": {"from": "2025-01-01", "to": "2025-12-31"},
      "purpose_category": "reporting", "purpose_description": "大額訂單追蹤", "export_allowed": false
    },
    "notices": [
      {"code": "DA-N-FIELD-UNAVAILABLE", "message": "「銷售訂單」的「discount」已經不在資料目錄裡，已從這張單移除。"},
      {"code": "DA-N-PACKAGE-UNAVAILABLE", "message": "「vendor_master」已經不在資料目錄裡，已從這張單移除。"}
    ]
  }
}
```

範例 5（邊界）：輸入是 `null`。輸出 `{"content": {"scope": [], "data_period": null, "purpose_category": null, "purpose_description": "", "export_allowed": false}, "notices": []}`。

### 5.2 `validate_content`

```sql
pack_data_access.validate_content(p_actor bigint, p_content jsonb) returns jsonb
```

用途：檢查送審前必須成立的條件。回傳 `[{"path","code","message"}]`，沒有錯誤時回 `[]`。輸入必須是 `normalize_content` 的輸出（前提 B1）；不是的話會得到 `DA-E-NOT-NORMALIZED`，所以即使核心漏了整理這一步，偽造的分級也過不了。

`path` 的寫法：鍵用「.」連接，陣列索引用方括號，從 0 開始，例如 `scope[1].row_filters[0].values`。

檢查項目，依這個順序產生錯誤：

| # | 位置 | 條件（不成立就報錯） | 代碼 |
|---|---|---|---|
| 1 | `scope` | 至少一個主題包 | `DA-E-SCOPE-EMPTY` |
| 2 | `scope[i]` | 主題包在目錄上啟用；`fields` 至少一個；每個欄位在目錄上啟用、分級是 L3 或 L4、內容裡的 `classification` 與目錄相同；主題包沒有重複。同一個主題包最多報一次 | `DA-E-NOT-NORMALIZED` |
| 3 | `scope[i].package` | `package_owner_ids(主題包)` 至少一人 | `DA-E-OWNER-MISSING` |
| 4 | `scope[i].row_filters[j].filter` | 列條件欄位在這個主題包的目錄上啟用 | `DA-E-FILTER-UNKNOWN` |
| 5 | `scope[i].row_filters[j].filter` | 同一個主題包裡，這個列條件欄位沒有在前面出現過 | `DA-E-FILTER-DUPLICATE` |
| 6 | `scope[i].row_filters[j].op` | `enum` 用 `in`；`number`、`date` 用 `between` | `DA-E-FILTER-OP` |
| 7 | `scope[i].row_filters[j].values` | `enum`：至少一個值，都是字串，都是啟用的值域值。`number`：恰好兩個，各為數字或 `null`，不同時為 `null`，下限 ≤ 上限。`date`：恰好兩個，各為有效的 `YYYY-MM-DD` 或 `null`，不同時為 `null`，下限 ≤ 上限 | `DA-E-FILTER-VALUE` |
| 8 | `data_period` | 選到的主題包至少一個有期間欄位時：是物件，`from`、`to` 都是有效日期 | `DA-E-PERIOD-REQUIRED` |
| 9 | `data_period` | 不是 `null` 時：`from`、`to` 都是有效日期且 `from ≤ to`（第 8 項已報錯時不重複報） | `DA-E-PERIOD-ORDER` |
| 10 | `purpose_category` | 不是 `null`，而且是啟用的分類 | `DA-E-PURPOSE-CATEGORY` |
| 11 | `purpose_description` | 分類的 `requires_description` 為 true 時不是空字串 | `DA-E-PURPOSE-DESCRIPTION` |
| 12 | `export_allowed` | `export_field_enabled` 為 true 時是布林；為 false 時是 `null` | `DA-E-NOT-NORMALIZED` |
| 13 | `export_allowed` | 為 `true` 時，`setting_boolean('data_access.export_requestable', classify_tier(p_content))` 為 true | `DA-E-EXPORT-NOT-ALLOWED` |

第 4 項報錯的條件，不再檢查第 5–7 項；第 6 項報錯的條件，不再檢查第 7 項。第 2 項報錯的主題包，仍然檢查它的列條件。`DA-E-FILTER-VALUE` 的訊息參數是原因，固定用下列文字之一：「至少要選一個值」「值 {v} 不在可選的清單裡」「要填下限和上限（可以只填其中一個）」「要填數字」「要填日期」「下限不能大於上限」。

範例 1：§5.1 範例 1 的輸出 → `[]`。

範例 2（邊界）：§5.1 範例 3 的輸出（資料範圍是空的）。

```json
[{"path": "scope", "code": "DA-E-SCOPE-EMPTY", "message": "請至少選一個需要申請的欄位（L3 或 L4）。"}]
```

範例 3：列條件的值有誤、缺資料期間、分類「其他」沒有說明。

```json
{
  "input": {
    "scope": [{"package": "sales_order", "fields": [{"code": "order_no", "classification": "L3"}],
               "row_filters": [{"filter": "order_amount", "op": "between", "values": [500000, 100000]},
                               {"filter": "region", "op": "in", "values": ["north", "west"]}]}],
    "data_period": null, "purpose_category": "other", "purpose_description": "", "export_allowed": false
  },
  "output": [
    {"path": "scope[0].row_filters[0].values", "code": "DA-E-FILTER-VALUE", "message": "「訂單金額」的條件不正確：下限不能大於上限。"},
    {"path": "scope[0].row_filters[1].values", "code": "DA-E-FILTER-VALUE", "message": "「區域」的條件不正確：值 west 不在可選的清單裡。"},
    {"path": "data_period", "code": "DA-E-PERIOD-REQUIRED", "message": "請填寫資料期間的起日和迄日。"},
    {"path": "purpose_description", "code": "DA-E-PURPOSE-DESCRIPTION", "message": "選擇「其他（需說明）」時，請填寫使用情境說明。"}
  ]
}
```

範例 4（邊界）：內容裡的分級被改過（`gross_margin` 寫成 L3，目錄是 L4）。

```json
{
  "input": {
    "scope": [{"package": "sales_order", "fields": [{"code": "gross_margin", "classification": "L3"}], "row_filters": []}],
    "data_period": {"from": "2025-01-01", "to": "2025-12-31"},
    "purpose_category": "reporting", "purpose_description": "", "export_allowed": false
  },
  "output": [
    {"path": "scope[0]", "code": "DA-E-NOT-NORMALIZED", "message": "申請內容和資料目錄不一致，請重新整理頁面後再試一次。"}
  ]
}
```

### 5.3 `classify_tier`

```sql
pack_data_access.classify_tier(p_content jsonb) returns text
```

用途：取內容裡所有欄位的最高分級（`DA-TIER-MAX`）。只看內容裡的 `classification`，不查目錄，所以同一份內容永遠得到同一個級別。

```
1. fields := p_content.scope 每個元素的 fields 的每個元素（scope 不是陣列 → 沒有元素）
2. 沒有任何元素                                             → 'L3'
3. 任何一個元素不是物件，或它的 classification 不是 'L3' 也不是 'L4' → 'L4'（無法判定，從嚴）
4. 任何一個元素的 classification 是 'L4'                     → 'L4'
5. → 'L3'
```

| # | 輸入（只列欄位） | 輸出 | 說明 |
|---|---|---|---|
| 1 | `customer_master`：`customer_id` L3、`customer_name` L3 | `L3` | |
| 2 | `sales_order`：`amount` L3、`gross_margin` L4 | `L4` | 同時有 L3、L4，整張照 L4 |
| 3 | `customer_master`：`customer_id` L3；`payroll`：`net_pay` L4 | `L4` | 跨主題包也取最高 |
| 4（邊界） | `scope` 是空陣列 | `L3` | 排序最低的級別；這種內容過不了 `validate_content` |
| 5（邊界） | `fields` 是 `["gross_margin"]`（字串，沒整理過） | `L4` | 無法判定，從嚴 |

### 5.4 `compare_content`

```sql
pack_data_access.compare_content(p_old jsonb, p_new jsonb) returns text
```

用途：判定一次內容修改是 `same`、`reduce` 還是 `expand`（`DA-CHANGE-COMPARE`、`DA-CHANGE-PURPOSE`）。核心用這個結果執行 `K-CHANGE-REDUCE`、`K-CHANGE-EXPAND`、`K-RETURN`、`K-BATCH`。被授權者與授權起迄不在這裡比較（§0.2）。

縮小的定義：新內容允許存取的每一筆資料（哪個欄位、哪些資料列、哪段資料期間、能不能匯出），舊內容都已經允許；而且使用情境沒有改變。具體來說只有這四種變動算縮小，其他一律 `expand`：

| 項目 | 算縮小的變動 |
|---|---|
| 欄位 | 新內容每個主題包的欄位是舊內容同一個主題包欄位的子集（含移除整個主題包） |
| 列條件 | 每個主題包的列條件相同或更嚴（§5.0 `filters_relation` 為 `equal` 或 `stricter`） |
| 資料期間 | 落在原範圍內（§5.0 `period_relation` 為 `equal` 或 `stricter`） |
| 匯出 | 可以匯出 → 只能查詢 |

演算法：

```
 1. p_old 與 p_new 的 JSON 相同 → 'same'
 2. result := 'same'
 3. 使用情境：purpose_category 或 purpose_description 不同 → 回傳 'expand'   -- DA-CHANGE-PURPOSE
 4. 匯出：old.export_allowed 與 new.export_allowed 不同時
        old 是 true 且 new 是 false → result := 'reduce'
        其他（false → true、null 與布林互換）→ 回傳 'expand'
 5. 結構：old.scope、new.scope 任一不是陣列；任一元素缺 package 或 fields 不是陣列；
          任一 fields 元素不是含 code、classification 的物件；任一方的 package 重複
        → 回傳 'expand'
 6. 對 new.scope 的每個主題包 PN：
        PO := old.scope 裡 package 相同的元素；沒有 → 回傳 'expand'（新增主題包）
        對 PN.fields 的每個欄位 f：
            PO.fields 裡沒有相同 code 的欄位 → 回傳 'expand'（新增欄位）
            classification 與 PO 裡的不同 → 回傳 'expand'（分級變動，要用正確的路徑重簽）
        PN 的欄位數少於 PO → result := 'reduce'
        r := filters_relation(PN.row_filters, PO.row_filters)
            'other' → 回傳 'expand'；'stricter' → result := 'reduce'
 7. old.scope 裡有主題包不在 new.scope → result := 'reduce'
 8. r := period_relation(new.data_period, old.data_period)
        'other' → 回傳 'expand'；'stricter' → result := 'reduce'
 9. 回傳 result
```

說明：

- 步驟 9 回傳 `same` 只會發生在兩份內容語意相同但寫法不同（例如陣列順序）；正規形式下這種情況已經在步驟 1 回傳。
- 新內容把資料範圍縮到空的（`scope` 為 `[]`）時回 `reduce`；能不能存檔由 `validate_content` 決定。
- 分級在兩個版本之間變動（目錄在這段期間調整了分級）一律 `expand`，包含調降：級別可能因此改變，要由正確路徑上的人重新確認。

範例使用的基準內容 `BASE`：

```json
{
  "scope": [
    {"package": "customer_master",
     "fields": [{"code": "contract_end_date", "classification": "L3"}, {"code": "customer_id", "classification": "L3"},
                {"code": "customer_name", "classification": "L3"}],
     "row_filters": [{"filter": "region", "op": "in", "values": ["central", "north"]}]},
    {"package": "sales_order",
     "fields": [{"code": "amount", "classification": "L3"}, {"code": "customer_id", "classification": "L3"},
                {"code": "order_date", "classification": "L3"}, {"code": "order_no", "classification": "L3"}],
     "row_filters": [{"filter": "region", "op": "in", "values": ["central", "north"]}]}
  ],
  "data_period": {"from": "2025-01-01", "to": "2026-12-31"},
  "purpose_category": "reporting",
  "purpose_description": "通路業務組每月檢視客戶與訂單",
  "export_allowed": false
}
```

| # | `p_old` | `p_new`（相對於 `p_old` 的變動） | 輸出 | 說明 |
|---|---|---|---|---|
| 1 | `BASE` | 不變 | `same` | |
| 2 | `BASE` | `sales_order` 拿掉 `order_date`；`sales_order` 的 `region` 改成 `in [north]`；資料期間改成 2025-01-01～2025-12-31 | `reduce` | 欄位子集、列條件更嚴、期間在原範圍內 |
| 3 | `BASE` | `purpose_description` 改成「改為每週檢視」 | `expand` | 修改使用情境算擴大 |
| 4 | `BASE` | `customer_master` 的 `region` 改成 `in [central, north, south]` | `expand` | 值集合多了 `south` |
| 5 | `BASE` | 移除整個 `customer_master` | `reduce` | 移除主題包 |
| 6 | `BASE` | `sales_order` 新增 `{"filter": "order_amount", "op": "between", "values": [0, 100000]}` | `reduce` | 新增列條件只會更嚴 |
| 7（邊界） | 第 6 列的結果 | `order_amount` 改成 `between [0, null]` | `expand` | 上限變成無界 |
| 8（邊界） | 第 6 列的結果 | 拿掉 `order_amount` 條件 | `expand` | 拿掉條件 |
| 9（邊界） | `BASE` | 資料期間改成 2025-01-01～2027-01-01 | `expand` | 迄日超出一天 |
| 10（邊界） | `BASE`，但 `export_allowed` 為 `true` | `export_allowed` 改成 `false` | `reduce` | 可匯出 → 不可匯出 |
| 11（邊界） | `BASE` | `export_allowed` 改成 `true` | `expand` | |
| 12（邊界） | `BASE` | `sales_order` 的 `amount` 的 `classification` 變成 `L4` | `expand` | 分級變動 |
| 13（邊界） | `BASE` | `sales_order` 拿掉 `order_date`，同時新增 `gross_margin`（L4） | `expand` | 有縮有擴，算擴大 |
| 14（邊界） | `BASE` | `sales_order` 的 `region` 條件改成 `{"filter": "region", "op": "like", "values": ["n%"]}` | `expand` | 無法辨識的條件，無法判定 |
| 15（邊界） | `BASE` | `data_period` 改成 `null` | `expand` | 拿掉資料期間的限制 |

### 5.5 `diff_content`

```sql
pack_data_access.diff_content(p_old jsonb, p_new jsonb) returns jsonb
```

用途：給人看的差異清單（`DA-DIFF`），用在「與前案差異」、版本之間的差異、批次核准畫面的差異摘要。回傳 `[{"kind","label","detail"}]`，`kind` 是 `added`、`removed`、`reduced`、`expanded`、`same`。被授權者與授權起迄的差異由核心加在前面。

產生規則，依這個順序：

1. 主題包：取兩邊主題包的聯集，依目錄的 `sort_order`、代碼排序。

| 情況 | `kind` | `label` | `detail` |
|---|---|---|---|
| 只在新內容 | `added` | 主題包名稱 | `fields_text(全部欄位)`＋「｜」＋`filters_text(列條件)` |
| 只在舊內容 | `removed` | 主題包名稱 | 同上（用舊內容） |
| 兩邊都有：新內容多出的欄位 | `added` | 「{主題包名稱}・欄位」 | `fields_text(多出的欄位)` |
| 兩邊都有：新內容少掉的欄位 | `removed` | 「{主題包名稱}・欄位」 | `fields_text(少掉的欄位)` |
| 兩邊都有：同一個欄位的分級不同 | `expanded` | 「{主題包名稱}・分級」 | 每個欄位「{欄位名稱} {舊分級} → {新分級}」，以「、」連接 |
| 兩邊都有：以上三種都沒有 | `same` | 「{主題包名稱}・欄位」 | `fields_text(全部欄位)` |
| 兩邊都有：`filters_relation` 為 `equal` | `same` | 「{主題包名稱}・列條件」 | `filters_text(新)` |
| 兩邊都有：`filters_relation` 為 `stricter` | `reduced` | 「{主題包名稱}・列條件」 | `filters_text(舊)`＋「 → 」＋`filters_text(新)` |
| 兩邊都有：`filters_relation` 為 `other` | `expanded` | 「{主題包名稱}・列條件」 | 同上 |

同一個主題包的列，順序是：欄位（added、removed、分級、same）→ 列條件。

2. 資料期間（兩邊都是 `null` 時不產生）：`period_relation` 為 `equal` → `same`，`detail` 是 `period_text(新)`；`stricter` → `reduced`；`other` → `expanded`；後兩者的 `detail` 是 `period_text(舊)`＋「 → 」＋`period_text(新)`。`label` 是「資料期間」。
3. 使用情境：分類與說明都相同 → `same`，`detail` 是分類名稱；否則 `expanded`，`detail` 是「{舊分類名稱}：{舊說明} → {新分類名稱}：{新說明}」。`label` 是「使用情境」。
4. 可否匯出（兩邊都是 `null` 時不產生）：相同 → `same`，`detail` 是 `export_text(新)`；可以匯出 → 只能查詢為 `reduced`；其他為 `expanded`；後兩者的 `detail` 是 `export_text(舊)`＋「 → 」＋`export_text(新)`。`label` 是「可否匯出」。

與 `compare_content` 的一致性（要有測試）：全部是 `same` ⇔ `compare_content` 回 `same`；沒有 `added`、`expanded` 且至少一列 `removed` 或 `reduced` ⇔ `reduce`；有任何 `added` 或 `expanded` ⇔ `expand`。（前提是兩份內容都是正規形式。）

範例 1：前案（種子授權 S1 的內容）對驗收案例 3 的申請。

```json
{
  "old": {
    "scope": [{"package": "sales_order",
               "fields": [{"code": "amount", "classification": "L3"}, {"code": "order_no", "classification": "L3"}],
               "row_filters": [{"filter": "region", "op": "in", "values": ["north"]}]}],
    "data_period": {"from": "2024-01-01", "to": "2024-12-31"},
    "purpose_category": "reporting", "purpose_description": "分析北區客戶續約率下降的原因", "export_allowed": false
  },
  "new": {
    "scope": [{"package": "customer_master",
               "fields": [{"code": "contract_end_date", "classification": "L3"}, {"code": "customer_id", "classification": "L3"},
                          {"code": "customer_name", "classification": "L3"}],
               "row_filters": [{"filter": "region", "op": "in", "values": ["north"]}]},
              {"package": "sales_order",
               "fields": [{"code": "amount", "classification": "L3"}, {"code": "customer_id", "classification": "L3"},
                          {"code": "order_date", "classification": "L3"}, {"code": "order_no", "classification": "L3"}],
               "row_filters": [{"filter": "region", "op": "in", "values": ["north"]}]}],
    "data_period": {"from": "2024-01-01", "to": "2025-12-31"},
    "purpose_category": "reporting", "purpose_description": "分析北區客戶續約率下降的原因", "export_allowed": false
  },
  "output": [
    {"kind": "added", "label": "客戶主檔", "detail": "客戶編號、客戶名稱、合約到期日｜區域 屬於 北區"},
    {"kind": "added", "label": "銷售訂單・欄位", "detail": "客戶編號、訂單日期"},
    {"kind": "same", "label": "銷售訂單・列條件", "detail": "區域 屬於 北區"},
    {"kind": "expanded", "label": "資料期間", "detail": "2024-01-01～2024-12-31 → 2024-01-01～2025-12-31"},
    {"kind": "same", "label": "使用情境", "detail": "報表與分析"},
    {"kind": "same", "label": "可否匯出", "detail": "只能查詢"}
  ]
}
```

範例 2：§5.4 的 `BASE` 對第 2 列的新內容。

```json
[
  {"kind": "same", "label": "客戶主檔・欄位", "detail": "客戶編號、客戶名稱、合約到期日"},
  {"kind": "same", "label": "客戶主檔・列條件", "detail": "區域 屬於 北區、中區"},
  {"kind": "removed", "label": "銷售訂單・欄位", "detail": "訂單日期"},
  {"kind": "reduced", "label": "銷售訂單・列條件", "detail": "區域 屬於 北區、中區 → 區域 屬於 北區"},
  {"kind": "reduced", "label": "資料期間", "detail": "2025-01-01～2026-12-31 → 2025-01-01～2025-12-31"},
  {"kind": "same", "label": "使用情境", "detail": "報表與分析"},
  {"kind": "same", "label": "可否匯出", "detail": "只能查詢"}
]
```

範例 3（邊界）：兩份內容相同（無差異續期）。以 `BASE` 對 `BASE`：

```json
[
  {"kind": "same", "label": "客戶主檔・欄位", "detail": "客戶編號、客戶名稱、合約到期日"},
  {"kind": "same", "label": "客戶主檔・列條件", "detail": "區域 屬於 北區、中區"},
  {"kind": "same", "label": "銷售訂單・欄位", "detail": "訂單編號、客戶編號、訂單金額、訂單日期"},
  {"kind": "same", "label": "銷售訂單・列條件", "detail": "區域 屬於 北區、中區"},
  {"kind": "same", "label": "資料期間", "detail": "2025-01-01～2026-12-31"},
  {"kind": "same", "label": "使用情境", "detail": "報表與分析"},
  {"kind": "same", "label": "可否匯出", "detail": "只能查詢"}
]
```

範例 4（邊界）：`p_old` 是 `null`。視為空內容 `{"scope": [], "data_period": null, "purpose_category": null, "purpose_description": "", "export_allowed": null}`，再依上面的規則產生；因此新內容的每個主題包各得到一列 `added`。核心在沒有前案時不應呼叫這個 hook，這裡只保證不會出錯。

### 5.6 `summarize_content`

```sql
pack_data_access.summarize_content(p_content jsonb) returns jsonb
```

用途：清單與簽核畫面第一眼要看到的事實（UI/UX 驗收 T2：哪些資料）。申請人、被授權者、授權起迄、級別、重疊警示由核心顯示，不在這裡。

```
title    := 主題包名稱以「、」連接（依目錄的 sort_order、代碼）；scope 為空 → 「尚未選擇資料範圍」
subtitle := 以「｜」連接下列各段（沒有的段落省略）：
              「{欄位總數} 個欄位」
              「資料期間 {period_text}」      -- 至少一個主題包有期間欄位，且 data_period 不是 null
              export_text(export_allowed)     -- export_allowed 不是 null
facts    := 依序：
  a. 每個主題包一筆（順序同 title）：
       label    = 「{主題包名稱}（{這個主題包欄位的最高分級}）」
       value    = fields_text(欄位)＋「｜」＋filters_text(列條件)
       emphasis = 最高分級是 L4
  b. 至少一個主題包有期間欄位時：
       label = 「資料期間」
       value = period_text(data_period)；若不是每個主題包都有期間欄位，再加上「（只套用在{有期間欄位的主題包名稱，以「、」連接}）」
       emphasis = false
  c. label = 「使用情境」
     value = 分類名稱；說明不是空字串時為「{分類名稱}：{說明}」；分類是 null 時為「尚未選擇」
     emphasis = false
  d. export_allowed 不是 null 時：
       label = 「可否匯出」，value = export_text(export_allowed)，emphasis = (export_allowed = true)
```

`emphasis` 是布林：true 代表畫面要特別標示（含 L4 的主題包、可以匯出）。

範例 1：§5.4 的 `BASE`。

```json
{
  "title": "客戶主檔、銷售訂單",
  "subtitle": "7 個欄位｜資料期間 2025-01-01～2026-12-31｜只能查詢",
  "facts": [
    {"label": "客戶主檔（L3）", "value": "客戶編號、客戶名稱、合約到期日｜區域 屬於 北區、中區", "emphasis": false},
    {"label": "銷售訂單（L3）", "value": "訂單編號、客戶編號、訂單金額、訂單日期｜區域 屬於 北區、中區", "emphasis": false},
    {"label": "資料期間", "value": "2025-01-01～2026-12-31（只套用在銷售訂單）", "emphasis": false},
    {"label": "使用情境", "value": "報表與分析：通路業務組每月檢視客戶與訂單", "emphasis": false},
    {"label": "可否匯出", "value": "只能查詢", "emphasis": false}
  ]
}
```

範例 2：L4（驗收案例 2 的內容：`payroll` 的 `employee_id` L3、`net_pay` L4、`pay_date` L3，沒有列條件，資料期間 2026-01-01～2026-12-31，分類 `operations`，說明「薪資入帳對帳」，只能查詢）。

```json
{
  "title": "員工薪資",
  "subtitle": "3 個欄位｜資料期間 2026-01-01～2026-12-31｜只能查詢",
  "facts": [
    {"label": "員工薪資（L4）", "value": "員工編號、發薪日、實發金額｜全部資料列", "emphasis": true},
    {"label": "資料期間", "value": "2026-01-01～2026-12-31", "emphasis": false},
    {"label": "使用情境", "value": "客戶服務或營運作業：薪資入帳對帳", "emphasis": false},
    {"label": "可否匯出", "value": "只能查詢", "emphasis": false}
  ]
}
```

範例 3（邊界）：空白草稿（§5.1 範例 5 的輸出）。

```json
{
  "title": "尚未選擇資料範圍",
  "subtitle": "0 個欄位｜只能查詢",
  "facts": [
    {"label": "使用情境", "value": "尚未選擇", "emphasis": false},
    {"label": "可否匯出", "value": "只能查詢", "emphasis": false}
  ]
}
```

範例 4（邊界）：只有沒有期間欄位的主題包（`customer_master`：`customer_id`、`customer_name`，`region in [north]`，分類 `reporting`，說明空字串，`export_allowed` 為 `true`）。

```json
{
  "title": "客戶主檔",
  "subtitle": "2 個欄位｜可以匯出成檔案",
  "facts": [
    {"label": "客戶主檔（L3）", "value": "客戶編號、客戶名稱｜區域 屬於 北區", "emphasis": false},
    {"label": "使用情境", "value": "報表與分析", "emphasis": false},
    {"label": "可否匯出", "value": "可以匯出成檔案", "emphasis": true}
  ]
}
```

### 5.7 `find_overlaps`

```sql
pack_data_access.find_overlaps(p_case_id bigint, p_content jsonb) returns jsonb
```

用途：判定這次申請和同一個被授權者的有效授權是否重複（`DA-OVERLAP-COVERED`、`DA-OVERLAP-PARTIAL`）。核心依回傳的 `level` 執行 `K-OVERLAP-BLOCK`（`covered`：擋下）與 `K-OVERLAP-REASON`（`partial`：必須填理由）。

定義：

- **有效授權**：`grant.status = 'active'` 的資料授權，包含授權起日還沒到的。簽核中、還沒執行的申請單不算。
- **完全涵蓋（`covered`）**：存在**單獨一筆**有效授權，本次申請的每個主題包、每個欄位、列條件、資料期間、整段授權起迄、匯出能力，都已經在那一筆授權的範圍內。
- **部分重疊（`partial`）**：沒有完全涵蓋，但至少一筆有效授權和本次申請有共同的欄位，而且無法證明兩者的資料列、資料期間、有效期間沒有交集。
- **多筆授權合起來才涵蓋**：一律判為 `partial`，`items` 列出每一筆有重疊的授權。原因是無法證明：DC 對同一個被授權者的多條規則是否會在欄位、資料列、期間的層級合併，目前沒有確認（見回報的待確認事項）。判成 `partial` 不會放行任何多餘的權限：申請人要填理由，簽核人會看到每一筆重疊的授權。

演算法：

```
 1. c := case_context(p_case_id)
 2. c.principal_id、c.valid_from、c.valid_to 任一為 null → {"level": "none", "items": []}
 3. N := p_content；N.scope 不是陣列或是空陣列 → {"level": "none", "items": []}
 4. 候選 := active_grants(c.principal_id)，排除：
      a. g.case_id = p_case_id（自己）
      b. 續期的來源：c.source_kind = 'renewal' 且 g.case_id = c.source_case_id 且 c.valid_to > g.valid_to
         （續期就是要接續同一筆授權；起迄沒有往後延長的「續期」不排除，會被判為完全涵蓋）
      c. 有效期間沒有交集：g.valid_to < c.valid_from 或 g.valid_from > c.valid_to
 5. 對每個候選 g（依 case_no 排序），G := g.content：
      touched := 空清單
      對 N.scope 的每個主題包 PN：
          PG := G.scope 裡 package 相同的元素；沒有 → 看下一個主題包
          common := PN 與 PG 的欄位代碼交集；空 → 看下一個主題包
          filters_disjoint(PN.row_filters, PG.row_filters) → 看下一個主題包
          package_has_period(PN.package) 且 period_disjoint(N.data_period, G.data_period) → 看下一個主題包
          touched 加入 (PN.package, common, PG)
      touched 是空的 → 這筆授權不重疊，看下一筆
      covers := 下列全部成立
          有效期間：g.valid_from ≤ c.valid_from 且 g.valid_to ≥ c.valid_to
          匯出：N.export_allowed 是 false；或 G.export_allowed 是 true；或兩者都是 null
          對 N.scope 的每個主題包 PN：
              PG 存在，而且 PN 的每個欄位代碼都在 PG 裡
              filters_within(PN.row_filters, PG.row_filters)
              package_has_period(PN.package) 為 false；或 G.data_period 是 null；
                  或 period_relation(N.data_period, G.data_period) 是 'equal' 或 'stricter'
      記下 (g, touched, covers)
 6. 有任何一筆 covers 為 true → level := 'covered'，items 只列 covers 為 true 的授權
    否則有記下任何授權          → level := 'partial'，items 列出全部記下的授權
    否則                        → level := 'none'，items := []
 7. items 的每一筆：
      {"case_id": g.case_id, "case_no": g.case_no, "detail": 見下}
```

`detail` 的格式（描述既有授權裡和本次申請重疊的部分）：

```
對 touched 的每個主題包（依目錄的 sort_order、代碼），以「；」連接：
    「{主題包名稱}：{fields_text(common)}｜{filters_text(PG.row_filters)}」
    主題包有期間欄位且 G.data_period 不是 null 時，再加「｜資料期間 {period_text(G.data_period)}」
最後加上「；授權 {g.valid_from}～{g.valid_to}」
G.export_allowed 不是 null 時，再加「；{export_text(G.export_allowed)}」
```

邊界情況：

| 情況 | 結果 |
|---|---|
| 被授權者不同 | 不會成為候選 → `none` |
| 草稿還沒選被授權者或還沒填授權起迄 | `none`（送審時這兩項已經必填，會重新檢查） |
| 本次申請的授權迄日比既有授權晚一天 | 不是 `covered`；有重疊時是 `partial` |
| 既有授權只能查詢，本次要求匯出，其餘都在範圍內 | `partial` |
| 既有授權的列條件是 `region in [north]`，本次沒有列條件 | `partial`（本次比較寬） |
| 既有授權沒有列條件，本次是 `region in [north]`，其餘都在範圍內 | `covered` |
| 既有授權的分級快照和本次不同 | 不影響：只比欄位代碼 |
| 既有授權的內容有無法辨識的列條件 | 不會被判為沒有交集，也不會被判為涵蓋 → 有共同欄位時是 `partial` |
| 兩筆授權分別涵蓋北區與中區，本次申請北區加中區 | `partial`，兩筆都列出 |

範例共用的既有授權（種子 S1）：被授權者「北區客戶流失分析」，單號 `DA-2026-0001`（`case_id` 以 1 表示），授權 2026-08-01～2027-01-31，內容是 `sales_order` 的 `amount`、`order_no`，`region in [north]`，資料期間 2024-01-01～2024-12-31，只能查詢。以下各例的本次申請都是同一個被授權者（另有說明者除外）。

| # | 本次申請 | 輸出 |
|---|---|---|
| 1 | 授權 2026-12-01～2027-01-31；`sales_order` 的 `order_no`；`region in [north]`；資料期間 2024-01-01～2024-06-30；只能查詢 | `covered`，一筆（見下） |
| 2（邊界） | 同 1，但授權迄日改成 2027-02-28 | `partial`，同一筆 |
| 3 | 授權 2026-12-01～2027-05-31；`customer_master` 三個欄位加 `sales_order` 四個欄位（§5.5 範例 1 的新內容） | `partial`，一筆（見下） |
| 4 | 同 1，但 `region in [south]` | `none`（列條件沒有交集） |
| 5 | 同 1，但資料期間 2025-01-01～2025-06-30 | `none`（資料期間沒有交集） |
| 6（邊界） | 同 1，但可以匯出 | `partial`，同一筆 |
| 7（邊界） | 同 1，但沒有列條件 | `partial`，同一筆 |
| 8（邊界） | 同 1，但被授權者是「季度業績看板」 | `none` |
| 9（邊界） | 這張單是 S1 的續期（`source_kind = 'renewal'`），內容相同，授權 2027-01-15～2027-07-14 | `none`（來源授權被排除） |
| 10（邊界） | 這張單是 S1 的續期，內容相同，授權 2026-12-01～2027-01-31（沒有往後延長） | `covered`，一筆 |

第 1 列的輸出：

```json
{
  "level": "covered",
  "items": [
    {"case_id": 1, "case_no": "DA-2026-0001",
     "detail": "銷售訂單：訂單編號｜區域 屬於 北區｜資料期間 2024-01-01～2024-12-31；授權 2026-08-01～2027-01-31；只能查詢"}
  ]
}
```

第 3 列的輸出：

```json
{
  "level": "partial",
  "items": [
    {"case_id": 1, "case_no": "DA-2026-0001",
     "detail": "銷售訂單：訂單編號、訂單金額｜區域 屬於 北區｜資料期間 2024-01-01～2024-12-31；授權 2026-08-01～2027-01-31；只能查詢"}
  ]
}
```

多筆授權的範例（邊界）：同一個被授權者另有一筆有效授權 `DA-2026-0010`（`case_id` 以 10 表示），和 S1 只差在 `region in [central]`。本次申請同第 1 列，但 `region in [central, north]`：

```json
{
  "level": "partial",
  "items": [
    {"case_id": 1, "case_no": "DA-2026-0001",
     "detail": "銷售訂單：訂單編號｜區域 屬於 北區｜資料期間 2024-01-01～2024-12-31；授權 2026-08-01～2027-01-31；只能查詢"},
    {"case_id": 10, "case_no": "DA-2026-0010",
     "detail": "銷售訂單：訂單編號｜區域 屬於 中區｜資料期間 2024-01-01～2024-12-31；授權 2026-08-01～2027-01-31；只能查詢"}
  ]
}
```

### 5.8 `stage_scopes`

```sql
pack_data_access.stage_scopes(p_stage_code text, p_content jsonb) returns setof text
```

用途：告訴核心資料擁有者關要找哪些主題包的擁有者（`DA-STAGE-OWNER`）。

```
p_stage_code = 'data_owner' → p_content.scope 每個元素的 package，去除重複，依代碼排序
其他關卡，或 scope 不是陣列 → 不回傳任何資料列
```

| # | `p_stage_code` | 內容的主題包 | 輸出 |
|---|---|---|---|
| 1 | `data_owner` | `customer_master`、`sales_order` | `customer_master`、`sales_order`（核心解析出周文傑、張美玲，並行） |
| 2 | `data_owner` | `sales_order`、`product_cost` | `product_cost`、`sales_order`（兩個範圍的擁有者都是張美玲，核心只產生一件工作，前提 B4） |
| 3 | `ciso` | `payroll` | 沒有資料列 |
| 4（邊界） | `data_owner` | `scope` 是空陣列 | 沒有資料列 |

### 5.9 `automated_checks`

```sql
pack_data_access.automated_checks(p_case_id bigint, p_stage_code text) returns jsonb
```

用途：顯示給該關簽核人的自動檢查結果（`DA-MIS-CHECK`）。每次開啟簽核畫面時重新計算，所以送審之後目錄或授權有變動也看得到。與領域無關的檢查由核心自己加（前提 B8）。

`c := case_context(p_case_id)`；以下的「內容」是 `c.content`。

| 代碼 | `label` | 計算 | `result` 與 `detail`（訊息代碼見 §7.5） |
|---|---|---|---|
| `DA-CHK-CATALOG` | 欄位和列條件都在資料目錄裡 | `errors := validate_content(c.applicant_id, 內容)` 裡代碼為 `DA-E-NOT-NORMALIZED`、`DA-E-FILTER-UNKNOWN`、`DA-E-FILTER-OP`、`DA-E-FILTER-VALUE` 的項目 | 沒有 → `pass`，最近一次目錄同步的日期。有 → `fail`，各項的 `message` 以空白連接 |
| `DA-CHK-OWNER` | 每個主題包都有在職的資料擁有者 | 對內容的每個主題包呼叫 `package_owner_ids` | 都有 → `pass`。有缺 → `fail`，列出主題包名稱 |
| `DA-CHK-OVERLAP` | 和既有授權的重疊 | `find_overlaps(p_case_id, 內容)` | `none` → `pass`。`partial` → `warn`，列出單號。`covered` → `fail`，列出單號 |
| `DA-CHK-EXPORT` | 匯出設定 | 內容的 `export_allowed` 與 `c.tier` | `null` → `pass`（不區分）。`false` → `pass`。`true` 且 `export_requestable(c.tier)` 為 true → `warn`。`true` 且為 false → `fail` |
| `DA-CHK-PRINCIPAL-END` | 被授權者的結束日 | `c.principal_ends_on` 與 `c.valid_to` | 結束日是 `null` 或不早於授權迄日 → `pass`。早於 → `warn` |

各關回傳的檢查，依這個順序：

| 關卡 | 檢查 |
|---|---|
| `manager`、`data_owner`、`ciso` | `DA-CHK-CATALOG`、`DA-CHK-OVERLAP` |
| `mis` | `DA-CHK-CATALOG`、`DA-CHK-OWNER`、`DA-CHK-OVERLAP`、`DA-CHK-EXPORT`、`DA-CHK-PRINCIPAL-END` |
| 其他代碼 | `[]` |

`fail` 代表這張單不應該在這一關核准（應退回）。骨幹目前只規定「顯示」；建議核心在有 `fail` 時擋下核准（見回報的骨幹修改建議）。

範例 1：驗收案例 1 的單在 `mis` 關（沒有重疊、只能查詢、被授權者是團隊，沒有結束日；目錄在 2026-11-09 同步）。

```json
[
  {"code": "DA-CHK-CATALOG", "label": "欄位和列條件都在資料目錄裡", "result": "pass", "detail": "資料目錄最近一次同步：2026-11-09。"},
  {"code": "DA-CHK-OWNER", "label": "每個主題包都有在職的資料擁有者", "result": "pass", "detail": "每個主題包都有在職的資料擁有者。"},
  {"code": "DA-CHK-OVERLAP", "label": "和既有授權的重疊", "result": "pass", "detail": "沒有和既有授權重疊。"},
  {"code": "DA-CHK-EXPORT", "label": "匯出設定", "result": "pass", "detail": "只能查詢。"},
  {"code": "DA-CHK-PRINCIPAL-END", "label": "被授權者的結束日", "result": "pass", "detail": "被授權者不會在授權期間內結束。"}
]
```

範例 2：驗收案例 3 的單在 `manager` 關（和 S1 部分重疊）。

```json
[
  {"code": "DA-CHK-CATALOG", "label": "欄位和列條件都在資料目錄裡", "result": "pass", "detail": "資料目錄最近一次同步：2026-11-09。"},
  {"code": "DA-CHK-OVERLAP", "label": "和既有授權的重疊", "result": "warn", "detail": "和 DA-2026-0001 部分重疊。"}
]
```

範例 3（邊界）：一張 L3 的單在 `mis` 關；送審之後目錄把 `customer_master.contract_end_date` 調成 L4；被授權者是專案「季度業績看板」（結束日 2027-03-31），授權迄日 2027-05-15；可以匯出。

```json
[
  {"code": "DA-CHK-CATALOG", "label": "欄位和列條件都在資料目錄裡", "result": "fail", "detail": "申請內容和資料目錄不一致，請重新整理頁面後再試一次。"},
  {"code": "DA-CHK-OWNER", "label": "每個主題包都有在職的資料擁有者", "result": "pass", "detail": "每個主題包都有在職的資料擁有者。"},
  {"code": "DA-CHK-OVERLAP", "label": "和既有授權的重疊", "result": "pass", "detail": "沒有和既有授權重疊。"},
  {"code": "DA-CHK-EXPORT", "label": "匯出設定", "result": "warn", "detail": "這張單可以匯出成檔案，請確認有必要。"},
  {"code": "DA-CHK-PRINCIPAL-END", "label": "被授權者的結束日", "result": "warn", "detail": "被授權者會在 2027-03-31 結束，早於授權迄日 2027-05-15；結束時授權會自動失效。"}
]
```

範例 4（邊界）：`p_stage_code` 是 `unknown_stage` → `[]`。

### 5.10 `build_fulfilment`

```sql
pack_data_access.build_fulfilment(p_case_id bigint) returns jsonb
```

用途：把核准的內容轉成交給 DC 的規則（`DA-FULFIL-RULE`）。格式與交付方式見 §8.1–§8.2。

```
 1. c := case_context(p_case_id)
 2. 下列任一成立 → 丟 DA-E-CONTENT-INVALID：
      c.principal_id、c.valid_from、c.valid_to 任一為 null
      c.content.scope 不是非空陣列；任一元素沒有 package，或 fields 不是非空陣列
 3. rules := 對 c.content.scope 的第 n 個主題包（依 package 代碼排序，n 從 1 開始）：
      {
        "rule_id":     c.case_no || '-' || n,
        "package":     package,
        "fields":      欄位代碼陣列（依代碼排序）,
        "row_filter":  row_filters 原樣,
        "data_period": 主題包目前的 period_field_code 不是 null 且 c.content.data_period 不是 null
                           → {"field": period_field_code, "from": …, "to": …}
                       否則 → null
      }
 4. 回傳
      {
        "format": "dc_rule_set/1",
        "case_no": c.case_no,
        "case_version_no": c.version_no,
        "grantee": {"type": c.principal_type, "principal_id": c.principal_id, "name": c.principal_name},
        "valid": {"from": c.valid_from, "to": c.valid_to},
        "export": c.content.export_allowed,
        "rules": rules
      }
```

即使目錄上的項目在核准後被停用，規則仍然照核准的內容輸出：核准的版本就是要執行的版本（`K-VERSION-BOUND`）；目錄的變動由 `catalog_sync` 的影響通知與 `DA-CHK-CATALOG` 處理。

範例 1：驗收案例 1（單號以 `DA-2026-0004` 表示；被授權者「通路業務組」的 `principal_id` 以 2 表示；內容是 §5.4 的 `BASE`；授權 2026-11-16～2027-05-15；目前是第 1 版）。

```json
{
  "format": "dc_rule_set/1",
  "case_no": "DA-2026-0004",
  "case_version_no": 1,
  "grantee": {"type": "team", "principal_id": 2, "name": "通路業務組"},
  "valid": {"from": "2026-11-16", "to": "2027-05-15"},
  "export": false,
  "rules": [
    {"rule_id": "DA-2026-0004-1", "package": "customer_master",
     "fields": ["contract_end_date", "customer_id", "customer_name"],
     "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
     "data_period": null},
    {"rule_id": "DA-2026-0004-2", "package": "sales_order",
     "fields": ["amount", "customer_id", "order_date", "order_no"],
     "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
     "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}}
  ]
}
```

範例 2：L4（驗收案例 2；被授權者 agent「ap-recon-bot」；`payroll` 的 `employee_id`、`net_pay`、`pay_date`；沒有列條件；資料期間 2026 年；授權 2026-11-16～2027-04-30）。

```json
{
  "format": "dc_rule_set/1",
  "case_no": "DA-2026-0004",
  "case_version_no": 1,
  "grantee": {"type": "agent", "principal_id": 6, "name": "ap-recon-bot"},
  "valid": {"from": "2026-11-16", "to": "2027-04-30"},
  "export": false,
  "rules": [
    {"rule_id": "DA-2026-0004-1", "package": "payroll",
     "fields": ["employee_id", "net_pay", "pay_date"],
     "row_filter": [],
     "data_period": {"field": "pay_date", "from": "2026-01-01", "to": "2026-12-31"}}
  ]
}
```

範例 3（邊界）：參數 `data_access.export_field_enabled` 為 false 時核准的單，`"export": null`，其餘相同。DC adapter 看到 `null` 時不設定匯出的限制。

範例 4（邊界）：`p_case_id` 是合約用印的單 → 丟 `DA-E-CASE-NOT-FOUND`。草稿（還沒填授權起迄）→ 丟 `DA-E-CONTENT-INVALID`。

### 5.11 `build_verification_cases`

```sql
pack_data_access.build_verification_cases(p_case_id bigint) returns jsonb
```

用途：依核准的範圍自動產生「查得到該查的、查不到不該查的」測試案例（`DA-VERIFY-CASES`）。回傳 `[{"code","description","expected","query"}]`。案例完全由規則決定，同一份規則在同一天產生的案例相同。

`query` 的格式：

```json
{
  "package": "sales_order",
  "fields": ["amount", "customer_id", "order_date", "order_no"],
  "row": {"region": "central"},
  "data_date": "2025-01-01",
  "action": "query",
  "as_of": "2026-11-16"
}
```

| 鍵 | 意義 |
|---|---|
| `package`、`fields` | 查哪個主題包的哪些欄位 |
| `row` | 一筆測試資料列在各列條件欄位上的值（列條件欄位代碼 → 值）。只包含規則有設條件的列條件欄位 |
| `data_date` | 這筆資料在期間欄位上的日期；主題包沒有資料期間限制時是 `null` |
| `action` | `query`（查看）或 `export`（帶走） |
| `as_of` | 查詢發生的日期 |

演算法：

```
 1. rs := build_fulfilment(p_case_id)；c := case_context(p_case_id)
 2. as_of := c.valid_from 與 sgn_internal.today() 較晚的一個；若晚於 c.valid_to → c.valid_to
    （授權起日還沒到時，用起日測試）
 3. 對 rs.rules 的每條規則 R（依序），P := R.package：
      inside_row  := 對 R.row_filter 的每個條件：{filter 代碼: inside_value(條件)}
      inside_date := R.data_period 是 null → null；否則 R.data_period.from
      a. 範圍內（正例）
           code = P || ':in'，expected = 'allow'
           query = {P, R.fields, inside_row, inside_date, 'query', as_of}
      b. 列條件外（反例）：對 R.row_filter 的每個條件（依序）
           v := outside_value(P, 條件)；v 是 null → 不產生
           code = P || ':row:' || filter 代碼，expected = 'deny'
           query = 同 a，但 row 裡這個 filter 的值換成 v
      c. 未申請的欄位（反例）
           f := unrequested_field(P, R.fields)；f 是 null → 不產生
           code = P || ':field'，expected = 'deny'
           query = 同 a，但 fields = [f]
      d. 資料期間外（反例）：R.data_period 不是 null 時
           code = P || ':period'，expected = 'deny'
           query = 同 a，但 data_date = R.data_period.from 的前一天
 4. 以第一條規則 R1 為對象，再產生：
      e. 匯出：rs.export 不是 null 時
           code = 'request:export'，expected = rs.export 為 true → 'allow'，否則 'deny'
           query = 同 R1 的 a，但 action = 'export'
      f. 授權到期後（反例）
           code = 'request:after_validity'，expected = 'deny'
           query = 同 R1 的 a，但 as_of = c.valid_to 的隔天

inside_value(條件)：s := condition_set(條件)
    enum          → s.values 的第一個（已排序）
    number、date  → s.lo 不是 null 時取 s.lo，否則取 s.hi
    unknown       → 丟 DA-E-CONTENT-INVALID

outside_value(P, 條件)：s := condition_set(條件)
    enum   → 這個列條件欄位啟用的值域值裡，不在 s.values 的第一個（依 sort_order、value）；沒有 → null
    number → s.lo 不是 null 時為 s.lo − 1，否則 s.hi + 1
    date   → s.lo 不是 null 時為 s.lo 的前一天，否則 s.hi 的隔天

unrequested_field(P, fields)：
    P 在目錄上啟用、分級為 L3 或 L4、不在 fields 裡的欄位；
    依分級由高到低、sort_order、field_code 排序，取第一個；沒有 → null
```

`description` 的格式：

| 案例 | 文字 |
|---|---|
| a | 「{主題包名稱}・{fields_text(fields)}{列}{日期}」 |
| b | a 的文字（用換過的值）＋「（列條件外）」 |
| c | 「{主題包名稱}・{欄位名稱}（未申請的欄位）」 |
| d | a 的文字（用換過的日期）＋「（資料期間外）」 |
| e | 「匯出 {主題包名稱}・{fields_text(fields)}」＋ `rs.export` 為 true 時「（本單可以匯出）」，否則「（本單只能查詢）」 |
| f | 「{as_of} 查詢 {主題包名稱}（授權到期後）」 |

`{列}`：`row` 不是空的時為「，」＋每個列條件欄位「{名稱}＝{標籤或值}」以「、」連接（依目錄的 `sort_order`）；空的時省略。`{日期}`：`data_date` 不是 `null` 時為「，{期間欄位名稱}＝{data_date}」；否則省略。

範例 1：§5.10 範例 1 的規則，在 2026-11-13 執行完成（`as_of` = 2026-11-16）。共 9 個案例：

```json
[
  {"code": "customer_master:in", "expected": "allow",
   "description": "客戶主檔・客戶編號、客戶名稱、合約到期日，區域＝中區",
   "query": {"package": "customer_master", "fields": ["contract_end_date", "customer_id", "customer_name"],
             "row": {"region": "central"}, "data_date": null, "action": "query", "as_of": "2026-11-16"}},
  {"code": "customer_master:row:region", "expected": "deny",
   "description": "客戶主檔・客戶編號、客戶名稱、合約到期日，區域＝南區（列條件外）",
   "query": {"package": "customer_master", "fields": ["contract_end_date", "customer_id", "customer_name"],
             "row": {"region": "south"}, "data_date": null, "action": "query", "as_of": "2026-11-16"}},
  {"code": "customer_master:field", "expected": "deny",
   "description": "客戶主檔・統一編號（未申請的欄位）",
   "query": {"package": "customer_master", "fields": ["tax_id"],
             "row": {"region": "central"}, "data_date": null, "action": "query", "as_of": "2026-11-16"}},
  {"code": "sales_order:in", "expected": "allow",
   "description": "銷售訂單・訂單編號、客戶編號、訂單金額、訂單日期，區域＝中區，訂單日期＝2025-01-01",
   "query": {"package": "sales_order", "fields": ["amount", "customer_id", "order_date", "order_no"],
             "row": {"region": "central"}, "data_date": "2025-01-01", "action": "query", "as_of": "2026-11-16"}},
  {"code": "sales_order:row:region", "expected": "deny",
   "description": "銷售訂單・訂單編號、客戶編號、訂單金額、訂單日期，區域＝南區，訂單日期＝2025-01-01（列條件外）",
   "query": {"package": "sales_order", "fields": ["amount", "customer_id", "order_date", "order_no"],
             "row": {"region": "south"}, "data_date": "2025-01-01", "action": "query", "as_of": "2026-11-16"}},
  {"code": "sales_order:field", "expected": "deny",
   "description": "銷售訂單・毛利（未申請的欄位）",
   "query": {"package": "sales_order", "fields": ["gross_margin"],
             "row": {"region": "central"}, "data_date": "2025-01-01", "action": "query", "as_of": "2026-11-16"}},
  {"code": "sales_order:period", "expected": "deny",
   "description": "銷售訂單・訂單編號、客戶編號、訂單金額、訂單日期，區域＝中區，訂單日期＝2024-12-31（資料期間外）",
   "query": {"package": "sales_order", "fields": ["amount", "customer_id", "order_date", "order_no"],
             "row": {"region": "central"}, "data_date": "2024-12-31", "action": "query", "as_of": "2026-11-16"}},
  {"code": "request:export", "expected": "deny",
   "description": "匯出 客戶主檔・客戶編號、客戶名稱、合約到期日（本單只能查詢）",
   "query": {"package": "customer_master", "fields": ["contract_end_date", "customer_id", "customer_name"],
             "row": {"region": "central"}, "data_date": null, "action": "export", "as_of": "2026-11-16"}},
  {"code": "request:after_validity", "expected": "deny",
   "description": "2027-05-16 查詢 客戶主檔（授權到期後）",
   "query": {"package": "customer_master", "fields": ["contract_end_date", "customer_id", "customer_name"],
             "row": {"region": "central"}, "data_date": null, "action": "query", "as_of": "2027-05-16"}}
]
```

範例 2：§5.10 範例 2 的規則（`payroll`，沒有列條件），在 2026-11-13 執行完成。共 5 個案例：

| `code` | `expected` | 與正例不同的地方 |
|---|---|---|
| `payroll:in` | `allow` | `fields` 為 `["employee_id", "net_pay", "pay_date"]`、`row` 為 `{}`、`data_date` 為 2026-01-01、`as_of` 為 2026-11-16 |
| `payroll:field` | `deny` | `fields` 為 `["base_salary"]`（未申請的 L4 欄位有 `base_salary`、`bonus`、`bank_account`，依 `sort_order` 取第一個） |
| `payroll:period` | `deny` | `data_date` 為 2025-12-31 |
| `request:export` | `deny` | `action` 為 `export` |
| `request:after_validity` | `deny` | `as_of` 為 2027-05-01 |

沒有列條件，所以沒有 `payroll:row:*`。

範例 3（邊界）：規則是 `sales_order` 全部五個 L3、L4 欄位（`amount`、`customer_id`、`gross_margin`、`order_date`、`order_no`），列條件 `region in [central, east, north, south]`（整個值域）與 `order_amount between [null, 100000]`，可以匯出。

- `sales_order:field` 不產生（沒有未申請的 L3、L4 欄位）。
- `sales_order:row:region` 不產生（值域裡沒有範圍外的值）。
- `sales_order:row:order_amount` 產生：正例的 `row` 是 `{"order_amount": 100000, "region": "central"}`（下限是 `null`，`inside_value` 取上限）；這個反例把 `order_amount` 換成 100001。
- `request:export` 的 `expected` 是 `allow`。

範例 4（邊界）：執行完成的日期（2027-05-20）已經超過授權迄日（2027-05-15）：`as_of` 取 2027-05-15；`request:after_validity` 的 `as_of` 是 2027-05-16。

### 5.12 `on_grant_event`

```sql
pack_data_access.on_grant_event(p_grant_id bigint, p_event text) returns void
```

用途：維護 `dc_rule`（本站認為 DC 上應該有哪些規則），並在授權被撤銷時要求撤回 DC 規則（`DA-DC-WITHDRAW`）。事件值與觸發時點見前提 B5。

```
g := grant_context(p_grant_id)；now := sgn_internal.now()；today := sgn_internal.today()

p_event = 'activated'：
    對 g.rule_set.rules 的每條規則 R：
        row_rule := R 加上 g.rule_set 的 grantee、valid、export 三個鍵（單條規則本身就完整）
        dc_rule 沒有 rule_id = R.rule_id   → 新增：status 'applied'、applied_at = now、rule = row_rule
        已有且 status = 'applied'           → 更新 rule = row_rule（驗證沒過、重新執行後的內容）
        已有且是其他狀態                    → 不動

p_event = 'expired'：
    這筆授權 status = 'applied' 的每一列 → status 'lapsed'、ended_at = now、ended_event = 'expired'
    （規則本身帶有效迄日，DC 到期後不再放行，不需要人工撤回）

p_event = 'revoked'：
    這筆授權 status = 'applied' 的每一列：
        g.valid_to < today → status 'lapsed'、ended_at = now、ended_event = 'revoked'
        否則               → status 'withdraw_pending'、ended_at = now、ended_event = 'revoked'
    有任何一列變成 withdraw_pending →
        enqueue_notification('data_access.dc_withdraw_required', null, array['mis'],
            {"case_no", "grantee_name", "rule_ids", "revoked_at"})

其他事件值 → 不做事
```

重複呼叫同一個事件不會產生重複的資料列，也不會重複通知（第二次呼叫時已經沒有 `applied` 的列）。撤回的後續處理見 §8.3。

| # | 情況 | 結果 |
|---|---|---|
| 1 | 驗收案例 1 的授權 `activated`（規則 `DA-2026-0004-1`、`-2`） | `dc_rule` 新增兩列，`status = 'applied'` |
| 2 | 同一筆授權在 2026-11-30 `revoked`（授權迄日 2027-05-15） | 兩列變成 `withdraw_pending`、`ended_event = 'revoked'`；寫一筆 `data_access.dc_withdraw_required` 通知給 `mis` 群組 |
| 3 | 種子授權 S2 在 2026-12-04 `expired` | 它的一列變成 `lapsed`、`ended_event = 'expired'`；沒有通知 |
| 4（邊界） | 第 1 列之後再呼叫一次 `activated` | 仍然是兩列，`applied_at` 不變 |
| 5（邊界） | 第 2 列之後再呼叫一次 `revoked` | 沒有變化，沒有第二筆通知 |
| 6（邊界） | `p_event = 'suspended'`（未定義的事件） | 沒有變化 |
| 7（邊界） | 授權迄日 2026-11-30 的授權，在 2026-12-01 才 `revoked`（到期排程還沒跑） | 變成 `lapsed`、`ended_event = 'revoked'`；沒有通知 |

### 5.13 `describe_entitlements`

```sql
pack_data_access.describe_entitlements(p_case_id bigint) returns jsonb
```

用途：把這張單核准的權限翻譯成骨幹第 11 節的通用結構，讓其他系統可以查詢與判定（`DA-ENTITLEMENT`）。

對應方式：

| 資料授權的概念 | 通用結構 |
|---|---|
| 主題包的一個欄位 | 資源：`resource_type = "data_field"`，`resource_id = "{主題包代碼}.{欄位代碼}"` |
| 查看 | 動作 `read` |
| 帶走（`export_allowed = true`） | 動作 `export` |
| 這個主題包的列條件 | `constraints.row_filter`（陣列，格式同 §2.1 的 `row_filters`） |
| 資料期間（主題包有期間欄位時） | `constraints.data_period`：`{"field","from","to"}` |
| 主題包 | `scope_ref`（定期複查找資料擁有者時使用，與 `stage_scopes` 同一套代碼） |
| 被授權者、授權起迄 | 不在這裡：核心從 `case` 與 `grant` 取得 |
| 使用情境 | 不進權限項目：它是核准的理由，不是存取的範圍 |

```
1. c := case_context(p_case_id)
2. c.content.scope 不是陣列 → 回傳 []
3. 對 scope 的每個主題包 P（依代碼）、P 的每個欄位 f（依代碼），產生一筆：
     {
       "resource_type": "data_field",
       "resource_id":   P.package || '.' || f.code,
       "actions":       c.content.export_allowed 是 true → ["read", "export"]；否則 ["read"],
       "constraints":   物件，只放有值的鍵：
                          "row_filter"  ← P.row_filters（不是空陣列時）
                          "data_period" ← {"field": period_field_code, "from", "to"}
                                          （P 目前有期間欄位，且 c.content.data_period 不是 null 時）
                        兩個都沒有 → {},
       "scope_ref":     P.package
     }
```

`export_allowed` 是 `null`（不區分查詢與匯出）時只有 `read`：本站沒有另外核准「匯出」這個動作。資源識別碼在一張單內不會重複（主題包不重複、欄位不重複）。這個 function 不丟例外、不寫資料表。

範例 1：驗收案例 1（§5.4 的 `BASE`）。共 7 筆，每個欄位一筆；列出其中兩筆：

```json
[
  {"resource_type": "data_field", "resource_id": "customer_master.contract_end_date", "actions": ["read"],
   "constraints": {"row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}]},
   "scope_ref": "customer_master"},
  {"resource_type": "data_field", "resource_id": "sales_order.amount", "actions": ["read"],
   "constraints": {"row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
                   "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}},
   "scope_ref": "sales_order"}
]
```

範例 2：驗收案例 2（`payroll`，沒有列條件）。共 3 筆，其中一筆：

```json
{"resource_type": "data_field", "resource_id": "payroll.net_pay", "actions": ["read"],
 "constraints": {"data_period": {"field": "pay_date", "from": "2026-01-01", "to": "2026-12-31"}},
 "scope_ref": "payroll"}
```

範例 3（邊界）：`customer_master` 的 `customer_id`，沒有列條件，可以匯出。沒有任何限制條件時 `constraints` 是 `{}`：

```json
[
  {"resource_type": "data_field", "resource_id": "customer_master.customer_id", "actions": ["read", "export"],
   "constraints": {}, "scope_ref": "customer_master"}
]
```

範例 4（邊界）：草稿，還沒選資料範圍 → `[]`。

### 5.14 `evaluate_constraints`

```sql
pack_data_access.evaluate_constraints(p_constraints jsonb, p_context jsonb) returns boolean
```

用途：判定一次請求或一筆回報的實際權限，是否落在核准的限制條件之內（`DA-ENTITLEMENT`）。`p_constraints` 是 §5.13 產生的 `constraints`；`p_context` 的結構由核心定義，本流程包只讀 `mode` 與 `context` 兩個鍵。`context` 裡本流程包認得的鍵：

| 鍵 | 格式 | 意義 |
|---|---|---|
| `row_filter` | 陣列，元素格式同 §2.1 的列條件 | 這次要存取（或實際設定）的資料列範圍 |
| `data_period` | `{"from","to"}` | 這次要存取（或實際設定）的資料期間 |

查單一筆資料時，把值寫成只有一個值的條件，例如 `{"filter": "region", "op": "in", "values": ["north"]}`、`{"from": "2025-03-01", "to": "2025-03-01"}`。

```
整個 function 包在例外處理裡：發生任何例外 → false
cf := p_constraints.row_filter（沒有這個鍵 → []）
cp := p_constraints.data_period 的 {"from","to"}（沒有這個鍵 → null）
p_constraints 有 row_filter、data_period 以外的鍵 → false（看不懂的限制條件，無法驗證）
ctx := p_context.context（不是物件 → {}）

p_context.mode = 'check'（權限判定）：
    ctx 有 row_filter 這個鍵：filters_within(ctx.row_filter, cf) 為 false → false
    ctx 有 data_period 這個鍵，且 cp 不是 null：
        period_relation(ctx.data_period, cp) 不是 'equal' 也不是 'stricter' → false
    → true
    （請求沒有提到的面向不檢查；核心會把限制條件放在回應裡，使用方必須自己套用）

p_context.mode = 'reconcile'（對帳）：
    filters_within(ctx.row_filter（沒有 → []）, cf) 為 false → false
    cp 不是 null：ctx 沒有 data_period，或 period_relation(ctx.data_period, cp) 不是 'equal'、'stricter' → false
    → true
    （回報沒有提到的面向，視為實際上沒有限制）

其他 mode → false
```

範例共用的限制條件 `C`：

```json
{"row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
 "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}}
```

| # | `mode` | `context` | 輸出 | 說明 |
|---|---|---|---|---|
| 1 | `check` | `{"row_filter": [{"filter": "region", "op": "in", "values": ["north"]}], "data_period": {"from": "2025-03-01", "to": "2025-03-31"}}` | `true` | 北區 ⊆ {中區, 北區}；期間在範圍內 |
| 2 | `check` | `{"row_filter": [{"filter": "region", "op": "in", "values": ["south"]}]}` | `false` | 南區不在核准的值裡 |
| 3 | `check` | `{"data_period": {"from": "2024-12-01", "to": "2025-01-31"}}` | `false` | 期間的起日早於核准的起日 |
| 4（邊界） | `check` | `{}` | `true` | 請求沒有描述範圍；使用方必須依回應裡的限制條件自行套用 |
| 5（邊界） | `check` | `{"row_filter": []}` | `false` | 明確表示「不限資料列」，超出核准的列條件 |
| 6 | `reconcile` | `{"row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}], "data_period": {"from": "2025-01-01", "to": "2026-12-31"}}` | `true` | 實際設定和核准相同 |
| 7 | `reconcile` | `{"row_filter": [{"filter": "region", "op": "in", "values": ["central", "north", "south"]}], "data_period": {"from": "2025-01-01", "to": "2026-12-31"}}` | `false` | 實際設定多了南區 |
| 8（邊界） | `reconcile` | `{}` | `false` | 回報沒有列條件與期間，視為沒有限制 |
| 9（邊界） | `audit`（未定義的模式） | 任意 | `false` | |
| 10（邊界） | `check`，但 `p_constraints` 是 `{"ip_range": "10.0.0.0/8"}` | `{}` | `false` | 看不懂的限制條件 |

## 6. 專屬的對外 function（`api.data_access_*`）

共同規定（工程規範第 2、5 節）：`security definer`、固定 `search_path = pack_data_access, sgn_internal, sgn, pg_temp`、第一個參數是 `p_actor`、有 `COMMENT ON FUNCTION`（用途、誰可以呼叫、規則代碼）、`sgn_app` 只有 `execute` 權限。每個 function 第一步是授權檢查（D4）；不符合時由核心的授權入口丟錯。回傳一律是 `jsonb`。

每個 function 都要在 `packages/contract/src/routes.ts` 有一條路由；標示「內部」的由後端的排程或 adapter 呼叫，列在路由表的內部清單。

| # | Function | 用途 | 誰可以呼叫 |
|---|---|---|---|
| 1 | `api.data_access_catalog_sync` | 匯入資料目錄快照 | 系統 actor（內部：目錄 adapter 的排程）、`sys_admin`（上傳檔案） |
| 2 | `api.data_access_catalog_search` | 搜尋主題包（資料範圍選擇器） | 任何在職人員 |
| 3 | `api.data_access_catalog_get` | 取得指定主題包的完整描述 | 任何在職人員 |
| 4 | `api.data_access_catalog_sync_runs` | 目錄同步紀錄（設定頁的整合狀態） | `sys_admin`、`mis`、`auditor` |
| 5 | `api.data_access_purpose_category_list` | 使用情境分類清單（表單選項） | 任何在職人員 |
| 6 | `api.data_access_purpose_category_save` | 新增、修改、停用使用情境分類 | `sys_admin` |
| 7 | `api.data_access_standard_template_save` | 資料擁有者新增或修改標準範本 | 範本內每個主題包的資料擁有者 |
| 8 | `api.data_access_standard_template_retire` | 停用標準範本 | 範本內每個主題包的資料擁有者，或 `sys_admin` |
| 9 | `api.data_access_dc_rule_list` | DC 規則清單（含等待撤回） | `mis`、`sys_admin`、`auditor` |
| 10 | `api.data_access_dc_rule_mark_withdrawn` | 標記已在 DC 撤回規則 | `mis` |

### 6.1 資料目錄

```sql
api.data_access_catalog_sync(p_actor bigint, p_snapshot jsonb) returns jsonb
api.data_access_catalog_search(p_actor bigint, p_query text default null, p_limit integer default 20) returns jsonb
api.data_access_catalog_get(p_actor bigint, p_package_codes text[]) returns jsonb
api.data_access_catalog_sync_runs(p_actor bigint, p_limit integer default 20) returns jsonb
```

**`catalog_sync`**：參數、演算法、回傳見 §4.2。錯誤：`DA-E-CATALOG-FORMAT`、`DA-E-CATALOG-EMPTY`、`DA-E-CATALOG-DUPLICATE`。規則代碼 `DA-CATALOG-SOURCE`。

**`catalog_search`**

| 參數 | 說明 |
|---|---|
| `p_query` | 搜尋字串。`null` 或只有空白 → 全部啟用的主題包。否則去除前後空白後，不分大小寫比對「主題包名稱、主題包代碼、啟用欄位的名稱」是否包含這個字串（`%`、`_`、`\` 當成一般字元） |
| `p_limit` | 最多回傳幾個主題包；小於 1 當成 1，大於 100 當成 100 |

回傳（主題包依 `sort_order`、代碼排序；只含啟用的主題包、欄位、列條件欄位、值）：

```json
{
  "packages": [
    {
      "code": "sales_order",
      "name": "銷售訂單",
      "description": "ERP 銷售訂單明細",
      "is_active": true,
      "max_classification": "L4",
      "owners": [{"person_id": 11, "name": "張美玲"}],
      "period_field": {"code": "order_date", "name": "訂單日期"},
      "fields": [
        {"code": "order_no", "name": "訂單編號", "classification": "L3", "requestable": true, "is_active": true},
        {"code": "channel", "name": "通路別", "classification": "L2", "requestable": false, "is_active": true}
      ],
      "filters": [
        {"code": "region", "name": "區域", "value_type": "enum", "is_active": true,
         "values": [{"value": "north", "label": "北區", "is_active": true}]},
        {"code": "order_amount", "name": "訂單金額", "value_type": "number", "is_active": true, "values": []}
      ]
    }
  ],
  "truncated": false
}
```

`requestable` 是「分級為 L3 或 L4」。`max_classification` 是啟用欄位的最高分級。`owners` 來自 `package_owner_ids`，沒有擁有者時是空陣列。`period_field` 沒有時是 `null`。符合的主題包超過 `p_limit` 時 `truncated` 為 true。這個 function 不丟業務錯誤。

**`catalog_get`**：回傳 `{"packages": [...]}`，元素格式同上，依傳入代碼的順序；包含已停用的主題包、欄位、列條件欄位、值（`is_active` 為 false），讓舊申請單仍然顯示得出名稱。目錄上沒有的代碼略過。`p_package_codes` 是 `null` 或空陣列時回傳 `{"packages": []}`。

**`catalog_sync_runs`**：回傳最近的同步紀錄，新的在前；`p_limit` 的處理同上。

```json
{
  "runs": [
    {"sync_run_id": 2, "synced_at": "2026-11-09T18:00:00+08:00", "actor_id": 16, "source": "dc_export_file",
     "snapshot_hash": "5d2c…e81a", "changed": true, "counts": {"field_reclassified": 1}, "impact_count": 0}
  ]
}
```

### 6.2 使用情境分類

```sql
api.data_access_purpose_category_list(p_actor bigint, p_include_inactive boolean default false) returns jsonb
api.data_access_purpose_category_save(
    p_actor bigint, p_code text, p_name text, p_requires_description boolean,
    p_sort_order integer, p_is_active boolean, p_reason text) returns jsonb
```

**`purpose_category_list`**：回傳陣列，依 `sort_order`、代碼排序。`p_include_inactive` 為 false 時只回傳啟用的（表單選項）；為 true 時包含停用的（顯示舊申請單、設定頁）。

```json
[
  {"value": "reporting", "label": "報表與分析", "requires_description": false, "sort_order": 10, "is_active": true},
  {"value": "other", "label": "其他（需說明）", "requires_description": true, "sort_order": 60, "is_active": true}
]
```

**`purpose_category_save`**（`DA-PURPOSE-ADMIN`）：`p_code` 已存在就修改，不存在就新增。分類不能刪除，只能把 `p_is_active` 設為 false。

```
1. require_role(p_actor, 'sys_admin')
2. p_reason 去除空白後是空的 → DA-E-REASON-REQUIRED
3. p_code 不符合 ^[a-z][a-z0-9_]{0,62}$、p_name 去除空白後是空的、任何參數是 null
       → DA-E-CATEGORY-INVALID（參數：哪一項不正確）
4. 這次修改之後沒有任何啟用的分類 → DA-E-CATEGORY-LAST-ACTIVE
5. 新增或修改資料列；updated_at = sgn_internal.now()、updated_by = p_actor
6. write_audit(p_actor, 'data_access.purpose_category_saved', 'DA-PURPOSE-ADMIN', null,
               {"code", "before": 修改前的資料列或 null, "after": 修改後的資料列, "reason"})
7. 回傳修改後的資料列（格式同清單的元素）
```

停用分類不影響已送出的申請單。停用之後，新送審或重送的內容如果還用這個分類，`validate_content` 會回 `DA-E-PURPOSE-CATEGORY`。

### 6.3 DC 規則

```sql
api.data_access_dc_rule_list(
    p_actor bigint, p_status text default null, p_limit integer default 50, p_offset integer default 0) returns jsonb
api.data_access_dc_rule_mark_withdrawn(p_actor bigint, p_grant_id bigint, p_note text) returns jsonb
```

**`dc_rule_list`**：`p_status` 是 `null`（全部）或 `dc_rule_status` 的值，其他值丟 `DA-E-ARGUMENT-INVALID`。`p_limit` 限制在 1–200；`p_offset` 小於 0 當成 0。排序：`withdraw_pending` 在最前面，依 `ended_at` 由早到晚；其餘依 `applied_at` 由晚到早；最後依 `rule_id`。

```json
{
  "total": 1,
  "rules": [
    {"rule_id": "DA-2026-0004-1", "grant_id": 6, "case_id": 6, "case_no": "DA-2026-0004",
     "package_code": "customer_master", "package_name": "客戶主檔", "grantee_name": "通路業務組",
     "status": "withdraw_pending", "applied_at": "2026-11-13T15:00:00+08:00",
     "ended_at": "2026-11-30T12:00:00+08:00", "ended_event": "revoked",
     "withdrawn_at": null, "withdrawn_by": null, "withdraw_note": null,
     "rule": {"rule_id": "DA-2026-0004-1", "package": "customer_master", "fields": ["contract_end_date", "customer_id", "customer_name"],
              "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}], "data_period": null,
              "grantee": {"type": "team", "principal_id": 2, "name": "通路業務組"},
              "valid": {"from": "2026-11-16", "to": "2027-05-15"}, "export": false}}
  ]
}
```

**`dc_rule_mark_withdrawn`**（`DA-DC-WITHDRAW`）：MIS 在 DC 撤回某一筆授權的全部規則之後呼叫。

```
1. require_role(p_actor, 'mis')
2. p_note 去除空白後是空的 → DA-E-REASON-REQUIRED（要寫 DC 上的異動單號或撤回方式）
3. 這筆授權沒有 status = 'withdraw_pending' 的規則 → DA-E-DC-RULE-NOT-PENDING
4. 這筆授權所有 withdraw_pending 的規則 → status 'withdrawn'、withdrawn_at = now、
   withdrawn_by = p_actor、withdraw_note = p_note
5. write_audit(p_actor, 'data_access.dc_rule_withdrawn', 'DA-DC-WITHDRAW', 這筆授權的 case_id,
               {"grant_id", "rule_ids", "note"})
6. 回傳 {"grant_id", "rule_ids": [...], "withdrawn_at"}
```

### 6.4 標準範本

擁有者維護的標準資料組合，存在核心的 `case_template`（標示為標準範本）。流程包只負責「誰可以維護」與「內容是否正確」，寫入透過 D9。申請人在新申請畫面選用範本、列出範本，都是核心的功能。

```sql
api.data_access_standard_template_save(
    p_actor bigint, p_template_id bigint, p_name text, p_content jsonb, p_reason text) returns jsonb
api.data_access_standard_template_retire(p_actor bigint, p_template_id bigint, p_reason text) returns jsonb
```

範本的內容只有資料範圍與資料期間（使用情境、可否匯出、被授權者、授權起迄每次申請都不同，由申請人填）：

```json
{
  "scope": [{"package": "sales_order",
             "fields": [{"code": "amount", "classification": "L3"}, {"code": "order_date", "classification": "L3"},
                        {"code": "order_no", "classification": "L3"}],
             "row_filters": []}],
  "data_period": null
}
```

**`standard_template_save`**（`DA-TEMPLATE-STANDARD`）：`p_template_id` 是 `null` 代表新增。

```
1. require_active_person(p_actor)
2. p_reason 去除空白後是空的 → DA-E-REASON-REQUIRED
3. p_name 去除空白後是空的 → DA-E-TEMPLATE-INVALID
4. n := normalize_content(p_actor, p_content)；content := {"scope": n.content.scope, "data_period": n.content.data_period}
5. content.scope 是空的 → DA-E-TEMPLATE-INVALID
6. errors := validate_content(p_actor, n.content) 裡 path 以 scope 或 data_period 開頭、
   而且代碼不是 DA-E-PERIOD-REQUIRED、DA-E-OWNER-MISSING 的項目；
   有任何一項 → DA-E-TEMPLATE-INVALID（參數：第一項的 message）
7. p_template_id 不是 null：old := template_content(p_template_id)；null → DA-E-TEMPLATE-NOT-FOUND
8. 對 content.scope（以及 old.scope）裡的每個主題包：
       has_role(p_actor, 'data_owner', 主題包代碼) 為 false → DA-E-TEMPLATE-NOT-OWNER（參數：主題包名稱）
9. id := save_case_template(p_actor, p_template_id, 'data_access', 去除空白的 p_name, content, true)
10. write_audit(p_actor, 'data_access.standard_template_saved', 'DA-TEMPLATE-STANDARD', null,
                {"template_id": id, "name", "packages": [...], "reason"})
11. 回傳 {"template_id": id, "name", "content", "notices": n.notices}
```

範本裡的欄位之後被目錄停用或調成 L1、L2 時不需要維護範本：申請人套用範本後內容會經過 `normalize_content`，不適用的欄位會被移除並提示。

**`standard_template_retire`**：`template_content(p_template_id)` 是 null → `DA-E-TEMPLATE-NOT-FOUND`；`p_reason` 空白 → `DA-E-REASON-REQUIRED`；呼叫者必須是 `sys_admin`，或是範本內每個主題包的資料擁有者，否則 `DA-E-TEMPLATE-NOT-OWNER`。通過後呼叫 `retire_case_template`，寫稽核事件 `data_access.standard_template_retired`（`DA-TEMPLATE-STANDARD`），回傳 `{"template_id", "retired": true}`。

## 7. 參數、規則代碼、錯誤代碼、訊息、通知範本

### 7.1 流程包的參數定義

| key | 型別 | 預設 | 可依什麼設定 | 意義 |
|---|---|---|---|---|
| `data_access.export_field_enabled` | 布林 | `true` | 全域 | 是否使用「可否匯出」欄位。DC 無法區分查詢與匯出時設為 false（open-questions M5） |
| `data_access.export_requestable` | 布林 | `true` | 級別 | 這個級別可不可以申請匯出。登記時把 `L4` 設為 false（L4 預設不可匯出） |
| `data_access.dc_delivery_mode` | 列舉 `manual`、`auto` | `manual` | 全域 | DC 規則的交付方式（§8.2）。第一版只使用 `manual` |

三個參數都只有系統管理員能改，要填原因並留紀錄（`K-SETTING-ADMIN`）。

### 7.2 登記在核心參數上的值

rules.md 的預設時限由流程包在升版時登記成「流程類型」或「級別」範圍的值，原因欄寫「資料授權流程包初始值（rules.md：預設時限）」。這樣核心的預設值之後變動時，資料授權不會跟著變（`DA-DEFAULT-SETTINGS`）。

| key | 範圍 | 值 | rules.md |
|---|---|---|---|
| `approval.remind_after_workdays` | 流程類型 `data_access` | 3 | 催辦：每關 3 個工作天未簽 |
| `approval.escalate_after_workdays` | 流程類型 `data_access` | 2 | 升級：催辦後再 2 個工作天未簽 |
| `validity.max_months` | 級別 `data_access` 的 `L3` | 12 | 授權上限：L3 一年 |
| `validity.max_months` | 級別 `data_access` 的 `L4` | 6 | 授權上限：L4 半年 |
| `validity.remind_before_days` | 流程類型 `data_access` | 14 | 到期前提醒 14 天 |
| `grant.owner_grace_days` | 流程類型 `data_access` | 14 | 負責人異動寬限期 14 天 |
| `confirmation.due_workdays` | 流程類型 `data_access` | 5 | 驗證結果確認時限 5 個工作天 |
| `data_access.export_requestable` | 級別 `data_access` 的 `L4` | `false` | L4 預設不可匯出 |

`audit.retention_years`（10 年）骨幹定義為不分範圍的全域參數，流程包不登記值；rules.md 的預設值與核心預設相同。級別範圍的 `scope_ref` 寫法假設為 `data_access:L4`（骨幹沒有定義）。

### 7.3 規則代碼

登記到 `sgn.rule`，所屬流程包 `data_access`。「來源」是 rules.md 的段落（另外註明者除外）。

| 代碼 | 規則 | 來源 |
|---|---|---|
| `DA-NO-MEDIUM` | 申請內容不記錄媒介；簽核的對象是資料本身 | 不做的事 |
| `DA-TIER-AUTO-GRANT` | L1、L2 欄位不走申請：自動從單上移除，並提示「這些欄位自動給」 | 不做的事、簽核路徑 |
| `DA-TIER-MAX` | 級別取所有欄位的最高分級；同時有 L3、L4 時整張照 L4 | 簽核路徑 |
| `DA-PATH-L3` | L3：主管 → 資料擁有者（並行）→ MIS | 簽核路徑 |
| `DA-PATH-L4` | L4：主管 → 資料擁有者（並行）→ 資安長 → MIS | 簽核路徑 |
| `DA-STAGE-OWNER` | 資料擁有者依主題包決定；每個主題包都要有在職的擁有者才能送審 | 角色 |
| `DA-MIS-CHECK` | MIS 關做資安合規檢查：自動檢查加上人工檢查清單 | 角色 |
| `DA-SCOPE-STRUCTURED` | 資料範圍是主題包 → 欄位 → 列條件；列條件只能用目錄上的欄位與值，不開放自由輸入 | 需求單 |
| `DA-DATA-PERIOD` | 資料期間和授權起迄分開存；資料期間當成列條件交給 DC 套用 | 需求單、時間規則 |
| `DA-PURPOSE` | 使用情境＝分類＋說明；標示為需說明的分類必須填說明 | 需求單 |
| `DA-PURPOSE-ADMIN` | 使用情境分類可在後台調整；只有系統管理員能改，要填原因並留紀錄 | 需求單 |
| `DA-EXPORT-TIER` | 查看和帶走分開；L4 預設不可匯出 | 需求單 |
| `DA-EXPORT-SWITCH` | DC 無法區分查詢與匯出時，關閉「可否匯出」欄位 | 需求單 |
| `DA-CHANGE-COMPARE` | 縮小的判定：欄位子集、列條件相同或更嚴、資料期間在原範圍內、可匯出改為不可匯出；其他變動或無法判定，一律算擴大 | 修改、退回與撤銷 |
| `DA-CHANGE-PURPOSE` | 修改使用情境算擴大 | 修改、退回與撤銷 |
| `DA-DIFF` | 標示與前案（或前一版）的差異 | 修改、退回與撤銷；加速功能 |
| `DA-OVERLAP-COVERED` | 被單獨一筆有效授權完全涵蓋 | 重複申請 |
| `DA-OVERLAP-PARTIAL` | 部分重疊；無法證明完全涵蓋時一律算部分重疊 | 重複申請 |
| `DA-CATALOG-SOURCE` | 主題包、欄位、分級、擁有者以 DC 為準；只能由目錄同步變更 | 四個方向原則 |
| `DA-FULFIL-RULE` | 核准結果輸出成 DC 規則；本站不執行權限 | 不做的事、狀態 |
| `DA-VERIFY-CASES` | 自動產生「查得到該查的、查不到不該查的」測試案例 | 狀態 |
| `DA-DC-WITHDRAW` | 授權撤銷後，DC 上的規則必須撤回並留紀錄 | 本契約補充（rules.md 沒有寫，見附錄 A-1） |
| `DA-TEMPLATE-STANDARD` | 資料擁有者維護標準資料組合（範本） | 加速功能 |
| `DA-DEFAULT-SETTINGS` | 流程包登記的參數初始值等於 rules.md 的預設時限 | 時間規則 |
| `DA-ENTITLEMENT` | 核准的權限以通用結構提供給其他系統查詢、判定與對帳 | 00-spine 第 11 節 |

共 25 個。核心規則（`K-*`）不在這裡重複定義；rules.md 每一條對應到哪個代碼見 §9。

### 7.4 錯誤代碼

登記到 `sgn.error_catalog`。訊息裡的 `%s` 依序代入參數。`validate_content` 回傳的代碼（上半）不會由流程包丟出；核心在送審被擋下時使用它的 HTTP 狀態。

| 代碼 | SQLSTATE | HTTP | 訊息 | 參數 |
|---|---|---|---|---|
| `DA-E-SCOPE-EMPTY` | `DA001` | 422 | 請至少選一個需要申請的欄位（L3 或 L4）。 | — |
| `DA-E-NOT-NORMALIZED` | `DA002` | 422 | 申請內容和資料目錄不一致，請重新整理頁面後再試一次。 | — |
| `DA-E-OWNER-MISSING` | `DA003` | 422 | 「%s」目前沒有在職的資料擁有者，無法送審，請聯絡 MIS。 | 主題包名稱 |
| `DA-E-FILTER-UNKNOWN` | `DA004` | 422 | 「%s」沒有「%s」這個列條件欄位。 | 主題包名稱、列條件欄位代碼 |
| `DA-E-FILTER-DUPLICATE` | `DA005` | 422 | 同一個主題包裡，「%s」只能設定一個條件。 | 列條件欄位名稱 |
| `DA-E-FILTER-OP` | `DA006` | 422 | 「%s」不能使用這種條件。 | 列條件欄位名稱 |
| `DA-E-FILTER-VALUE` | `DA007` | 422 | 「%s」的條件不正確：%s。 | 列條件欄位名稱、原因（§7.5 的 `DA-T-FV-*`） |
| `DA-E-PERIOD-REQUIRED` | `DA008` | 422 | 請填寫資料期間的起日和迄日。 | — |
| `DA-E-PERIOD-ORDER` | `DA009` | 422 | 資料期間的起日不能晚於迄日。 | — |
| `DA-E-PURPOSE-CATEGORY` | `DA010` | 422 | 請選擇使用情境分類。 | — |
| `DA-E-PURPOSE-DESCRIPTION` | `DA011` | 422 | 選擇「%s」時，請填寫使用情境說明。 | 分類名稱 |
| `DA-E-EXPORT-NOT-ALLOWED` | `DA012` | 422 | %s 資料不可匯出，只能查詢。 | 級別 |
| `DA-E-CASE-NOT-FOUND` | `DA020` | 404 | 找不到這張資料授權申請單。 | — |
| `DA-E-CONTENT-INVALID` | `DA021` | 422 | 這張單的內容不完整，無法產生規則。 | — |
| `DA-E-CATALOG-FORMAT` | `DA030` | 422 | 資料目錄檔案的格式不正確：%s。 | 位置與原因 |
| `DA-E-CATALOG-EMPTY` | `DA031` | 422 | 資料目錄檔案裡沒有任何主題包，沒有匯入。 | — |
| `DA-E-CATALOG-DUPLICATE` | `DA032` | 422 | 資料目錄檔案裡有重複的代碼：%s。 | 位置 |
| `DA-E-APPEND-ONLY` | `DA033` | 409 | 目錄同步紀錄不能修改或刪除。 | — |
| `DA-E-CATEGORY-INVALID` | `DA040` | 422 | 使用情境分類的資料不正確：%s。 | 哪一項 |
| `DA-E-CATEGORY-LAST-ACTIVE` | `DA041` | 409 | 至少要保留一個啟用的使用情境分類。 | — |
| `DA-E-REASON-REQUIRED` | `DA042` | 422 | 請填寫原因。 | — |
| `DA-E-TEMPLATE-INVALID` | `DA050` | 422 | 範本內容不正確，請確認名稱和資料範圍。%s | 細節（可為空字串） |
| `DA-E-TEMPLATE-NOT-OWNER` | `DA051` | 403 | 範本只能包含你擔任資料擁有者的主題包；你不是「%s」的資料擁有者。 | 主題包名稱 |
| `DA-E-TEMPLATE-NOT-FOUND` | `DA052` | 404 | 找不到這個標準範本。 | — |
| `DA-E-DC-RULE-NOT-PENDING` | `DA060` | 409 | 這筆授權沒有等待撤回的 DC 規則。 | — |
| `DA-E-ARGUMENT-INVALID` | `DA061` | 422 | 參數不正確：%s。 | 參數名稱 |

共 26 個。授權不足的錯誤由核心的授權入口丟出，不在這裡定義。

### 7.5 提示、檢查結果與文字片段

這些訊息不是錯誤，但同樣登記在訊息目錄（SQLSTATE 與 HTTP 狀態為 null，依賴 D12），由 `sgn_internal.error_message` 取得，讓文字只有一個來源。

提示（`normalize_content` 的 `notices`）：

| 代碼 | 訊息 | 參數 |
|---|---|---|
| `DA-N-AUTO-GRANTED` | 「%s」的「%s」是 %s 欄位，不需要申請，已自動從這張單移除。 | 主題包名稱、欄位名稱、分級 |
| `DA-N-FIELD-UNAVAILABLE` | 「%s」的「%s」已經不在資料目錄裡，已從這張單移除。 | 主題包名稱、欄位名稱或代碼 |
| `DA-N-PACKAGE-UNAVAILABLE` | 「%s」已經不在資料目錄裡，已從這張單移除。 | 主題包名稱或代碼 |
| `DA-N-PACKAGE-EMPTY` | 「%s」沒有需要申請的欄位，已從這張單移除。 | 主題包名稱 |
| `DA-N-EXPORT-FORCED` | 這張單包含 %1$s 資料，%1$s 資料不可匯出，已改為只能查詢。 | 級別 |

自動檢查（`automated_checks`）：

| 代碼 | 文字 | 參數 |
|---|---|---|
| `DA-CHK-CATALOG` | 欄位和列條件都在資料目錄裡 | —（`label`） |
| `DA-CHK-CATALOG-PASS` | 資料目錄最近一次同步：%s。 | 日期 |
| `DA-CHK-OWNER` | 每個主題包都有在職的資料擁有者 | —（`label`） |
| `DA-CHK-OWNER-PASS` | 每個主題包都有在職的資料擁有者。 | — |
| `DA-CHK-OWNER-FAIL` | 沒有在職資料擁有者的主題包：%s。 | 主題包名稱，以「、」連接 |
| `DA-CHK-OVERLAP` | 和既有授權的重疊 | —（`label`） |
| `DA-CHK-OVERLAP-PASS` | 沒有和既有授權重疊。 | — |
| `DA-CHK-OVERLAP-WARN` | 和 %s 部分重疊。 | 單號，以「、」連接 |
| `DA-CHK-OVERLAP-FAIL` | 已經被 %s 完全涵蓋。 | 單號，以「、」連接 |
| `DA-CHK-EXPORT` | 匯出設定 | —（`label`） |
| `DA-CHK-EXPORT-PASS` | 只能查詢。 | — |
| `DA-CHK-EXPORT-NA` | 不區分查詢與匯出。 | — |
| `DA-CHK-EXPORT-WARN` | 這張單可以匯出成檔案，請確認有必要。 | — |
| `DA-CHK-EXPORT-FAIL` | %s 資料不可匯出。 | 級別 |
| `DA-CHK-PRINCIPAL-END` | 被授權者的結束日 | —（`label`） |
| `DA-CHK-PRINCIPAL-END-PASS` | 被授權者不會在授權期間內結束。 | — |
| `DA-CHK-PRINCIPAL-END-WARN` | 被授權者會在 %s 結束，早於授權迄日 %s；結束時授權會自動失效。 | 結束日、授權迄日 |

`DA-CHK-CATALOG` 失敗時的 `detail` 直接使用 `validate_content` 回傳的訊息。

文字片段（§4.3 的文字 function、`diff_content`、`summarize_content`、`find_overlaps`、`build_verification_cases` 使用）：

| 代碼 | 文字 | 代碼 | 文字 |
|---|---|---|---|
| `DA-T-ALL-ROWS` | 全部資料列 | `DA-T-PERIOD-NONE` | 未指定 |
| `DA-T-EXPORT-NO` | 只能查詢 | `DA-T-EXPORT-YES` | 可以匯出成檔案 |
| `DA-T-EXPORT-NA` | 不區分查詢與匯出 | `DA-T-SCOPE-NONE` | 尚未選擇資料範圍 |
| `DA-T-FILTER-IN` | %s 屬於 %s | `DA-T-FILTER-BETWEEN` | %s 介於 %s～%s |
| `DA-T-FILTER-GTE` | %s ≥ %s | `DA-T-FILTER-LTE` | %s ≤ %s |
| `DA-T-FILTER-UNKNOWN` | %s（無法辨識的條件） | `DA-T-PURPOSE-NONE` | 尚未選擇 |
| `DA-T-FIELD-COUNT` | %s 個欄位 | `DA-T-PERIOD-LABEL` | 資料期間 |
| `DA-T-PURPOSE-LABEL` | 使用情境 | `DA-T-EXPORT-LABEL` | 可否匯出 |
| `DA-T-PERIOD-ONLY` | （只套用在%s） | `DA-T-VALIDITY` | 授權 %s～%s |
| `DA-T-DIFF-FIELDS` | %s・欄位 | `DA-T-DIFF-FILTERS` | %s・列條件 |
| `DA-T-DIFF-CLASS` | %s・分級 | `DA-T-VC-ROW-OUT` | （列條件外） |
| `DA-T-VC-FIELD-OUT` | （未申請的欄位） | `DA-T-VC-PERIOD-OUT` | （資料期間外） |
| `DA-T-VC-EXPORT` | 匯出 %s | `DA-T-VC-EXPORT-NO` | （本單只能查詢） |
| `DA-T-VC-EXPORT-YES` | （本單可以匯出） | `DA-T-VC-AFTER` | %s 查詢 %s（授權到期後） |
| `DA-T-FV-EMPTY` | 至少要選一個值 | `DA-T-FV-NOT-IN-DOMAIN` | 值 %s 不在可選的清單裡 |
| `DA-T-FV-BOUNDS` | 要填下限和上限（可以只填其中一個） | `DA-T-FV-NUMBER` | 要填數字 |
| `DA-T-FV-DATE` | 要填日期 | `DA-T-FV-ORDER` | 下限不能大於上限 |

分隔符號（「、」「｜」「；」「：」「→」「～」「＝」）是格式的一部分，寫在組字的 function 裡。

### 7.6 通知範本

核心事件（指派、催辦、升級、退回、縮小通知、待執行、驗證結果、請申請人確認、到期提醒、撤銷、負責人異動）使用核心的範本。流程包只登記自己的三個事件；範本變數的寫法假設為 `{{名稱}}`。

| 事件代碼 | 收件人 | 主旨 | 內文 | 連結 |
|---|---|---|---|---|
| `data_access.catalog_sync_impact` | `sys_admin` 群組、受影響主題包的資料擁有者 | 資料目錄更新，影響 {{impact_count}} 張資料授權 | 資料目錄在 {{synced_at}} 更新。下列申請單或授權引用的項目有變動，請確認是否需要撤銷或退回：{{impact_lines}} | 授權總覽 |
| `data_access.catalog_owner_missing` | `sys_admin` 群組 | 有主題包沒有資料擁有者 | 資料目錄在 {{synced_at}} 更新後，下列主題包沒有在職的資料擁有者，包含這些主題包的申請無法送審：{{package_names}}。請到 DC 指定擁有者後重新同步。 | 設定的整合狀態 |
| `data_access.dc_withdraw_required` | `mis` 群組 | {{case_no}} 已撤銷，請到 DC 撤回規則 | {{case_no}}（{{grantee_name}}）已在 {{revoked_at}} 撤銷。請到 DC 撤回規則 {{rule_ids}}，完成後在本站標記「已撤回」。 | DC 規則清單（等待撤回） |

`impact_lines` 每行的格式：「{單號}（{狀態}）：{主題包名稱}的{項目名稱}{變動}」，例如「DA-2026-0003（生效中）：產品成本明細的產品編號分級由 L3 改為 L4」。

### 7.7 流程包寫入的稽核事件

| 動作代碼 | 規則代碼 | 寫入的 function | 申請單 |
|---|---|---|---|
| `data_access.catalog_synced` | `DA-CATALOG-SOURCE` | `api.data_access_catalog_sync` | 無 |
| `data_access.purpose_category_saved` | `DA-PURPOSE-ADMIN` | `api.data_access_purpose_category_save` | 無 |
| `data_access.standard_template_saved` | `DA-TEMPLATE-STANDARD` | `api.data_access_standard_template_save` | 無 |
| `data_access.standard_template_retired` | `DA-TEMPLATE-STANDARD` | `api.data_access_standard_template_retire` | 無 |
| `data_access.dc_rule_withdrawn` | `DA-DC-WITHDRAW` | `api.data_access_dc_rule_mark_withdrawn` | 該授權的申請單 |

其他稽核事件都由核心寫入（送審、級別判定、重疊檢查、分派、核准、縮小、執行、驗證、確認、到期、撤銷），並依 §1.5 的 `hook_rules` 附上流程包的規則代碼。

## 8. 執行、驗證與 DC adapter

### 8.1 執行內容的格式（`dc_rule_set/1`）

`build_fulfilment`（§5.10）的回傳值，也是核心保存在 `fulfilment` 的內容、MIS 在執行畫面看到與下載的檔案、交給 DC adapter 的規則。

| 鍵 | 型別 | 意義 |
|---|---|---|
| `format` | 字串 | 固定 `dc_rule_set/1`。格式改變時升版號 |
| `case_no`、`case_version_no` | 字串、整數 | 這份規則出自哪張單的哪個內容版本 |
| `grantee` | `{"type","principal_id","name"}` | 被授權者：類型（`team`、`project`、`agent`）、本站的內部 id、名稱 |
| `valid` | `{"from","to"}` | 授權起迄（日期，含頭尾）。DC 在這段期間以外不放行 |
| `export` | 布林或 `null` | `true`＝可以匯出；`false`＝只能查詢；`null`＝不設定匯出的限制 |
| `rules` | 陣列 | 每個主題包一條規則 |
| `rules[].rule_id` | 字串 | `{單號}-{序號}`，例如 `DA-2026-0142-1`。同一張單重新執行時不變 |
| `rules[].package` | 字串 | 主題包代碼 |
| `rules[].fields` | 字串陣列 | 可以查看的欄位代碼 |
| `rules[].row_filter` | 陣列 | 列條件，全部都要成立；空陣列＝不限制。元素格式同 §2.1 |
| `rules[].data_period` | `{"field","from","to"}` 或 `null` | 資料期間：`field` 這個日期欄位的值必須在 `from` 到 `to` 之間（含頭尾）；`null`＝不限制 |

主題包、欄位、列條件欄位的代碼就是 DC 資料目錄上的代碼（目錄 adapter 匯入時已經對應好）。被授權者在 DC 上對應到哪個帳號或群組，第一版由 MIS 套用時依名稱與類型對應（檢查清單 `dc_grantee_matched`）；自動交付需要被授權者的外部識別碼，見回報的待確認事項。

### 8.2 交付方式

第一版：`data_access.dc_delivery_mode = manual`。

```
1. mis 關核准 → 申請單進入 pending_fulfilment；核心呼叫 build_fulfilment 並保存結果
2. 執行關 dc_apply 的工作指派給核准 mis 關的人（前提 B9）
3. 他在執行詳情看到規則（元件 data_access.rule_set_view），複製或下載規則檔，到 DC 套用
4. 勾選檢查清單（dc_rule_applied、dc_grantee_matched），填寫完成說明（DC 上的異動單號），標記完成
5. 核心：建立 grant、呼叫 on_grant_event('activated')、申請單進入 verifying（K-FULFIL）
```

`auto`（之後才啟用，流程不變）：後端在步驟 2 改為呼叫 DC adapter 的 `deliver`；回 `applied` 時由系統 actor 標記完成（稽核事件的規則代碼 `DA-FULFIL-RULE`），回 `manual_required` 或 `failed` 時照 `manual` 的流程交給人處理。

### 8.3 撤銷之後：撤回 DC 規則

規則帶有效迄日，所以到期不需要撤回。撤銷是提前結束，DC 上的規則必須撤回（`DA-DC-WITHDRAW`）：

```
1. 授權被撤銷（任何原因）→ 核心呼叫 on_grant_event('revoked')
2. 流程包把這筆授權的規則標成 withdraw_pending，通知 mis 群組（§5.12）
3. MIS 到 DC 撤回規則，在「DC 規則清單」按「已撤回」並填寫說明
       → api.data_access_dc_rule_mark_withdrawn（§6.3），寫稽核事件
```

本站的授權在步驟 1 就已經是 `revoked`；步驟 1 到步驟 3 之間，DC 上的規則還在，這段時間差記錄在 `dc_rule.ended_at` 與 `withdrawn_at`，證據頁要顯示。`auto` 模式下步驟 3 改由後端呼叫 adapter 的 `withdraw`。骨幹第 11 節的對帳（`reconciliation_run`）是事後偵測「沒核准卻存在」的權限；`dc_rule` 是事前把撤回工作交給人，兩者互補。

### 8.4 驗證的執行

```
1. 執行完成 → 核心建立 verification_run，呼叫 build_verification_cases（§5.11）存成 verification_case
2. 後端的資料授權 worker（api/src/packs/data_access/）以系統 actor 呼叫
       api.verification_pending(p_actor, 'data_access', p_limit)
   取得待執行的項目：{"run_id", "case_no", "rule_set": 執行內容, "cases": [{"code","expected","query"}]}
3. worker 呼叫 DC adapter 的 verify
4. worker 把結果交回核心：api.verification_report(p_actor, p_run_id, p_results)
       p_results = {"status": "completed", "adapter": "http", "results": [{"code","actual","detail"}]}
              或 {"status": "unsupported", "adapter": "manual"}
              或 {"status": "failed", "adapter": "http", "error": "連線逾時"}
5. 核心比對每個案例的 expected 與 actual：
       全部相同                    → 驗證通過，等申請人確認（K-CONFIRM）
       任何一個不同，或 actual = error → 驗證沒過，退回執行（K-VERIFY）
       status = unsupported        → 改由 MIS 逐項記錄實際結果並附上證據（open-questions M3 的替代做法）
       status = failed             → 不算驗證結果；worker 之後重試
```

判定通過與否的是核心（比對 `expected` 與 `actual`），不是 adapter。步驟 2、4 的兩個入口是對核心的需求（D11）。

### 8.5 DC adapter 的介面

後端的 port（`api/src/packs/data_access/dcPort.ts`）：

```ts
export interface DcPort {
  readonly kind: 'manual' | 'http' | 'mock';
  deliver(request: DcDeliverRequest): Promise<DcDeliverResult>;
  withdraw(request: DcWithdrawRequest): Promise<DcWithdrawResult>;
  verify(request: DcVerifyRequest): Promise<DcVerifyResult>;
}
```

請求與回報的格式（三種 adapter 相同）：

```json
{
  "deliver_request":  {"request_id": "0b9f6c3e-…", "rule_set": {"format": "dc_rule_set/1", "…": "§8.1"}},
  "deliver_result":   {"status": "applied", "dc_ref": "DC-CHG-20261113-004"},
  "withdraw_request": {"request_id": "…", "case_no": "DA-2026-0004", "rule_ids": ["DA-2026-0004-1", "DA-2026-0004-2"]},
  "withdraw_result":  {"status": "withdrawn"},
  "verify_request":   {"request_id": "…", "run_id": 12, "rule_set": {"…": "§8.1"},
                       "cases": [{"code": "sales_order:in", "expected": "allow", "query": {"…": "§5.11"}}]},
  "verify_result":    {"status": "completed",
                       "results": [{"code": "sales_order:in", "actual": "allow", "reason": null}]}
}
```

| 欄位 | 可能的值 |
|---|---|
| `deliver_result.status` | `applied`（附 `dc_ref`）、`manual_required`、`failed`（附 `error`） |
| `withdraw_result.status` | `withdrawn`、`manual_required`、`failed`（附 `error`） |
| `verify_result.status` | `completed`（附 `results`，每個案例一筆，`code` 對應請求）、`unsupported`、`failed`（附 `error`） |
| `results[].actual` | `allow`：以被授權者的身分查得到這筆資料的所有欄位；`deny`：被擋下或查不到；`error`：這個案例無法執行 |
| `results[].reason` | `deny` 的原因：`no_rule`、`not_yet_valid`、`expired`、`field_not_granted`、`row_filter`、`data_period`、`export_not_allowed`；`allow` 時是 `null`；`error` 時是說明文字 |

`request_id` 是 UUID，同一個請求重試時不變，DC 端用它避免重複套用。`reason` 只供人閱讀與除錯，核心只比對 `actual`。

三種 adapter：

| `kind` | 用在 | `deliver` | `withdraw` | `verify` |
|---|---|---|---|---|
| `manual` | 正式環境，DC 的介面確認之前（open-questions M2、M3） | `manual_required` | `manual_required` | `unsupported` |
| `http` | DC 提供介面之後；整合測試與端對端測試連到 `sim/` 的 DC 模擬器（骨幹第 12 節） | `PUT {base}/rule-sets/{case_no}`，本文為 `rule_set` | `DELETE {base}/rule-sets/{case_no}` | `POST {base}/test-queries`，本文為 `verify_request` |
| `mock` | 只用在單元測試 | `applied`，`dc_ref` 為 `mock:{case_no}:v{case_version_no}` | `withdrawn` | 依下方的規則語意計算 |

`http` 的三個端點回傳上面的結果格式；DC 模擬器把規則套用成真正的資料庫權限，測試查詢是真的執行。DC 模擬器的資料必須讓每個測試查詢都有對應的資料列（否則無法分辨「被規則擋下」和「本來就沒有資料」，該案例要回 `error`），並且要支援 `as_of`（以指定日期判斷授權起迄）。端點路徑是本文件的假設，要和 `sim/` 的作者對齊。選用哪個 adapter 由後端設定（`api/src/config.ts`）決定；正式環境不得設定為 `mock`。

#### 規則的語意（`mock` 的計算方式，也是 DC 模擬器合約測試的預期結果）

```
evaluate_dc_query(rule_set, query) → {"actual", "reason"}
 1. R := rule_set.rules 裡 package = query.package 的規則；沒有          → deny，no_rule
 2. query.as_of < rule_set.valid.from                                  → deny，not_yet_valid
    query.as_of > rule_set.valid.to                                    → deny，expired
 3. query.fields 是空的，或有任何一個不在 R.fields                      → deny，field_not_granted
 4. 對 R.row_filter 的每個條件：v := query.row[該條件的 filter]
        v 不存在或是 null                                              → deny，row_filter
        s := condition_set(條件)（§5.0）
        s 是 enum 而 v 不在 s.values；s 是 number 或 date 而 v 不在 [lo, hi]；s 是 unknown → deny，row_filter
 5. R.data_period 不是 null：query.data_date 是 null，或不在 [from, to]  → deny，data_period
 6. query.action = 'export' 而 rule_set.export 是 false                 → deny，export_not_allowed
 7. → allow，reason 為 null
```

以 §5.10 範例 1 的規則為例：

| # | 查詢 | 結果 |
|---|---|---|
| 1 | §5.11 範例 1 的 `sales_order:in` | `allow` |
| 2 | §5.11 範例 1 的 `sales_order:row:region`（`region` 是 `south`） | `deny`，`row_filter` |
| 3 | §5.11 範例 1 的 `sales_order:period`（`data_date` 是 2024-12-31） | `deny`，`data_period` |
| 4 | §5.11 範例 1 的 `request:after_validity`（`as_of` 是 2027-05-16） | `deny`，`expired` |
| 5（邊界） | `package` 是 `payroll` | `deny`，`no_rule` |
| 6（邊界） | `sales_order:in`，但 `row` 是 `{}`（沒有給 `region`） | `deny`，`row_filter` |
| 7（邊界） | `sales_order:in`，但 `as_of` 是 2027-05-15（迄日當天） | `allow` |
| 8（邊界） | `sales_order:in`，但 `fields` 是 `["amount", "gross_margin"]` | `deny`，`field_not_granted` |

這個演算法有兩份實作：`mock` adapter（TypeScript，模擬外部系統）與資料庫測試的輔助 function（`db/tests/packs/data_access/helpers/dc_reference.sql`）。兩者都用同一份固定資料（`db/tests/packs/data_access/fixtures/dc_evaluation.json`：上表的 8 列，加上 §5.11 範例 1 的 9 個案例）驗證。資料庫測試另外檢查自我一致：對任何核准的內容，`build_verification_cases` 產生的每個案例，用 `build_fulfilment` 的規則計算出來的結果都等於它的 `expected`。

### 8.6 資料目錄 adapter

後端的 port（`api/src/packs/data_access/catalogPort.ts`）只有一個動作：`fetch(): Promise<CatalogSnapshot>`，回傳 §4.2 的快照。後端不解讀內容，整份交給 `api.data_access_catalog_sync`。第一版的 adapter 讀取匯入檔案（open-questions M1）；排程每天執行一次，系統管理員也可以在設定頁上傳檔案。

## 9. 規則對照表

rules.md 逐條對照。「代碼」欄的 `K-*` 是核心規則（定義在骨幹第 5 節，這裡不重複定義），`DA-*` 是 §7.3 的流程包規則。「測試」是 `db/tests/packs/data_access/` 裡的測試名稱（格式：`規則代碼 說明`）；核心規則的測試是用資料授權的流程實際走一次，核心自己的測試另外在 `db/tests/kernel/`。

### 目標、不做的事

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 1 | 目標：加速簽核、減少重複申請 | `DA-OVERLAP-COVERED`、`DA-TEMPLATE-STANDARD`、`K-BATCH` | 由 #54、#55、#61–#66 的規則達成 | 同該幾列 |
| 2 | 目標：每張單都能直接當稽核證據 | `K-AUDIT-APPEND`、`K-AUDIT-CHAIN` | 核心 | `K-AUDIT-CHAIN data_access_case_chain_verifies_end_to_end` |
| 3 | 背景：上櫃公司，內控準則第 9 條與資通安全管控指引 | — | 背景說明，不是系統規則 | — |
| 4 | 不執行權限：核准結果輸出成規則，由 DC 套用 | `DA-FULFIL-RULE`、`K-FULFIL` | `build_fulfilment`；核心 | `DA-FULFIL-RULE rule_set_matches_approved_content` |
| 5 | L1、L2 不走申請，本站只處理 L3、L4 | `DA-TIER-AUTO-GRANT` | `normalize_content` | `DA-TIER-AUTO-GRANT removes_l1_l2_fields_with_notice` |
| 6 | 申請單不記錄「媒介」 | `DA-NO-MEDIUM` | 表單定義沒有這個欄位；`normalize_content` 捨棄未知的鍵 | `DA-NO-MEDIUM unknown_keys_are_dropped` |

### 四個方向原則與三條推論

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 7 | ① 一律從嚴；L3、L4 用同一套規則 | `DA-CHANGE-COMPARE`、`DA-OVERLAP-PARTIAL`、`DA-PATH-L4` | `compare_content`、`find_overlaps`（無法判定時往嚴格的方向）；路徑（L4 只多一關） | `DA-CHANGE-COMPARE undeterminable_condition_is_expand`、`DA-PATH-L4 same_stages_and_settings_as_l3_plus_ciso` |
| 8 | ② 每關不同人，也不能是申請人；代理人也一樣 | `K-SOD-DISTINCT`、`K-SOD-APPLICANT` | 核心 | `K-SOD-DISTINCT data_access_owner_same_as_manager_goes_to_upper_manager` |
| 9 | ③ 縮小只需通知；任何擴大都從第一關重簽 | `K-CHANGE-REDUCE`、`K-CHANGE-EXPAND`、`K-VERSION-BOUND`、`DA-CHANGE-COMPARE` | 核心（每個決定綁定當時的內容版本）；`compare_content` | `K-CHANGE-REDUCE data_access_approver_removes_field_without_resign`、`K-CHANGE-EXPAND data_access_added_field_restarts_from_first_stage` |
| 10 | ④ 每筆有效授權隨時要有在職、可問責的負責人 | `K-OWNER-CONTINUITY` | 核心 | `K-OWNER-CONTINUITY data_access_grants_revoked_after_grace` |
| 11 | 能結構化就結構化：列條件、使用情境；雜湊鏈 | `DA-SCOPE-STRUCTURED`、`DA-PURPOSE`、`K-AUDIT-CHAIN` | `validate_content`；核心 | `DA-SCOPE-STRUCTURED rejects_unknown_filter_and_value` |
| 12 | 生效以 DC 回報套用成功為準 | `K-FULFIL` | 核心（執行關完成才建立授權） | `K-FULFIL data_access_not_effective_until_dc_applied` |
| 13 | 主題包、欄位、分級、擁有者以 DC 為準 | `DA-CATALOG-SOURCE` | `api.data_access_catalog_sync`；沒有其他寫入目錄的入口 | `DA-CATALOG-SOURCE catalog_changes_only_through_sync` |
| 14 | 人做決定，系統只執行：系統做的動作要寫明依據哪條規則 | `K-AUDIT-APPEND` | 核心（依 `hook_rules` 附上流程包規則代碼） | `K-AUDIT-APPEND data_access_system_events_carry_rule_codes` |
| 15 | 控管規則由 MIS 負責；只有系統管理員能改設定，修改留紀錄 | `K-SETTING-ADMIN`、`DA-PURPOSE-ADMIN` | 核心；`api.data_access_purpose_category_save` | `K-SETTING-ADMIN data_access_setting_change_requires_admin_and_reason` |
| 16 | 泳道圖只畫人的泳道 | — | 文件的畫法，不是系統規則 | — |

### 角色

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 17 | 申請人：提出申請、確認驗證結果；不能簽自己的單 | `K-SOD-APPLICANT`、`K-CONFIRM` | 核心 | `K-SOD-APPLICANT data_access_applicant_never_assigned` |
| 18 | 申請人主管：第一關 | `DA-PATH-L3`、`DA-PATH-L4` | 路徑第 10 關 | `DA-PATH-L3 stages_manager_owner_mis` |
| 19 | 資料擁有者：依主題包決定；多位時並行，全部核准才往下 | `DA-STAGE-OWNER`、`K-PARALLEL-ALL` | `stage_scopes`；路徑第 20 關；核心 | `DA-STAGE-OWNER scopes_are_distinct_packages`、`K-PARALLEL-ALL data_access_two_owners_both_required` |
| 20 | 資安長：只在 L4；指定一人，可設代理人 | `DA-PATH-L4`、`K-DELEGATE` | 路徑第 30 關；核心 | `DA-PATH-L4 ciso_stage_only_for_l4`、`K-DELEGATE data_access_ciso_delegate_signs_on_behalf` |
| 21 | MIS：資安合規檢查＋執行設定；群組待辦，一人認領 | `DA-MIS-CHECK`、`K-CLAIM`、`K-FULFIL` | `automated_checks`；路徑第 40、50 關；核心 | `DA-MIS-CHECK mis_stage_returns_five_checks`、`K-CLAIM data_access_mis_claimed_by_one_member` |
| 22 | 稽核：唯讀，可查全公司的單並匯出 | `K-AUDITOR-READONLY` | 核心 | `K-AUDITOR-READONLY data_access_auditor_reads_all_cannot_write` |

### 簽核路徑、職責分離、逾時

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 23 | L3：主管 → 資料擁有者（並行）→ MIS | `DA-PATH-L3` | 登記的路徑 | `DA-PATH-L3 stages_manager_owner_mis` |
| 24 | L4：主管 → 資料擁有者（並行）→ 資安長 → MIS | `DA-PATH-L4` | 登記的路徑 | `DA-PATH-L4 stages_manager_owner_ciso_mis` |
| 25 | 同時有 L3、L4 欄位，整張照 L4 走 | `DA-TIER-MAX` | `classify_tier` | `DA-TIER-MAX mixed_l3_l4_is_l4` |
| 26 | L1、L2 欄位自動從單上移除，並提示 | `DA-TIER-AUTO-GRANT` | `normalize_content` | `DA-TIER-AUTO-GRANT removes_l1_l2_fields_with_notice` |
| 27 | 每一關是不同的自然人，也不能是申請人；撞到改由上一層主管 | `K-SOD-DISTINCT`、`K-SOD-APPLICANT` | 核心 | `K-SOD-DISTINCT data_access_owner_same_as_manager_goes_to_upper_manager` |
| 28 | 申請人本身是主管時，主管關給他的上一層主管 | `K-SOD-APPLICANT` | 核心（`applicant_manager`） | `K-SOD-APPLICANT data_access_manager_applicant_goes_to_own_manager` |
| 29 | 代理人簽核一樣遵守；紀錄寫明誰代誰簽 | `K-SOD-DISTINCT`、`K-DELEGATE` | 核心 | `K-DELEGATE data_access_delegate_blocked_if_signed_earlier_stage` |
| 30 | 每關超過時限先催辦；再超過升級給上一層主管 | `K-SLA-REMIND`、`K-SLA-ESCALATE` | 核心 | `K-SLA-REMIND data_access_reminds_after_3_workdays`、`K-SLA-ESCALATE data_access_escalates_2_workdays_after_reminder` |
| 31 | 升級後只有升級對象能簽 | `K-SLA-ESCALATE` | 核心 | `K-SLA-ESCALATE data_access_original_approver_blocked` |
| 32 | 所有關卡都適用；天數做成設定 | `DA-PATH-L3`、`DA-PATH-L4`、`DA-DEFAULT-SETTINGS` | 路徑每一關都宣告時限參數 | `DA-PATH-L3 every_stage_declares_sla_settings` |

### 修改、退回與撤銷

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 33 | 簽核人修改：只能縮小資料範圍、授權起迄或資料期間；通知申請人，不用重簽 | `K-CHANGE-REDUCE`、`DA-CHANGE-COMPARE` | 核心；`compare_content`；表單定義的 `reducible` | `DA-CHANGE-COMPARE subset_stricter_narrower_is_reduce`、`K-CHANGE-REDUCE data_access_approver_expand_rejected` |
| 34 | 退回後，申請人只做縮小：從退回的那一關繼續 | `K-RETURN`、`DA-CHANGE-COMPARE` | 核心；`compare_content` | `K-RETURN data_access_reduce_only_resumes_at_returned_stage` |
| 35 | 退回後，申請人做其他修改：從第一關重簽；修改使用情境也算擴大 | `K-RETURN`、`DA-CHANGE-PURPOSE` | 核心；`compare_content` | `DA-CHANGE-PURPOSE purpose_change_is_expand`、`K-RETURN data_access_purpose_change_restarts_from_first_stage` |
| 36 | 一鍵續期：預填前案，仍走完整路徑；標示「與前案差異」 | 核心的續期能力（骨幹沒有規則代碼，見附錄 A-9）、`DA-DIFF` | 核心（選項 `renewable`）；`diff_content` | `DA-DIFF identical_renewal_all_same`、`DA-PATH-L3 renewal_goes_through_full_path` |
| 37 | 撤銷：申請人、負責人、任一位簽核人、MIS 可直接撤銷，必須填原因 | `K-REVOKE`、`DA-DC-WITHDRAW` | 核心；`on_grant_event`、`api.data_access_dc_rule_mark_withdrawn` | `K-REVOKE data_access_each_allowed_role_can_revoke_with_reason`、`DA-DC-WITHDRAW revoke_marks_rules_pending_and_notifies_mis` |

### 被授權者

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 38 | 只能是團隊、專案或 agent，不直接授權給個人 | 核心的被授權者（骨幹沒有規則代碼，見附錄 A-9） | 核心（選項 `uses_principal`） | `DA-PATH-L3 submission_requires_principal` |
| 39 | 團隊：讀取組織資料；解散時授權自動撤銷 | `K-OWNER-CONTINUITY` | 核心 | `K-OWNER-CONTINUITY data_access_team_dissolved_ends_grants` |
| 40 | 專案：任何人可建立，必須指定負責人和結束日；相似名稱提示；專案不帶權限 | 核心的被授權者（骨幹沒有規則代碼，見附錄 A-9） | 核心 | 核心測試 |
| 41 | 專案結束時，相關授權自動失效 | `K-OWNER-CONTINUITY`、`DA-MIS-CHECK` | 核心；`automated_checks`（結束日早於授權迄日時提醒） | `K-OWNER-CONTINUITY data_access_project_end_ends_grants`、`DA-MIS-CHECK warns_when_principal_ends_before_validity` |
| 42 | agent：必須指定一位負責人 | `K-OWNER-CONTINUITY` | 核心 | `K-OWNER-CONTINUITY data_access_agent_requires_owner` |
| 43 | 負責人離職或調職：通知主管在寬限期內改派，逾期自動撤銷 | `K-OWNER-CONTINUITY` | 核心 | `K-OWNER-CONTINUITY data_access_grants_revoked_after_grace` |

### 需求單

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 44 | 資料範圍：主題包 → 欄位 → 列條件；結構化，不開放自由寫 SQL | `DA-SCOPE-STRUCTURED` | 表單定義 `scope`；`normalize_content`、`validate_content` | `DA-SCOPE-STRUCTURED rejects_unknown_filter_and_value`、`DA-SCOPE-STRUCTURED rewrites_eq_to_canonical_form` |
| 45 | 資料期間：資料本身的時間範圍；屬於列條件的一種，交給 DC 套用 | `DA-DATA-PERIOD` | 表單定義 `data_period`；`validate_content`；`build_fulfilment` | `DA-DATA-PERIOD required_when_package_has_period_field`、`DA-DATA-PERIOD emitted_per_rule_with_period_field` |
| 46 | 被授權者：團隊、專案或 agent | 同 #38 | 核心 | 同 #38 |
| 47 | 授權起迄：申請人自填，簽核人只能縮短；各級別有上限 | `K-VALIDITY-MAX`、`K-CHANGE-REDUCE` | 核心；§7.2 的參數值 | `K-VALIDITY-MAX data_access_l3_12_months_l4_6_months`、`K-CHANGE-REDUCE data_access_approver_shortens_validity` |
| 48 | 使用情境：分類下拉＋文字說明 | `DA-PURPOSE` | 表單定義；`validate_content` | `DA-PURPOSE category_required_and_active`、`DA-PURPOSE description_required_for_flagged_category` |
| 49 | 可否匯出：查看和帶走分開；L4 預設不可匯出 | `DA-EXPORT-TIER` | `normalize_content`、`validate_content`；參數 `data_access.export_requestable` | `DA-EXPORT-TIER l4_export_forced_to_query_only`、`DA-EXPORT-TIER l3_export_allowed` |
| 50 | 可否匯出：DC 無法區分時這個欄位就關閉 | `DA-EXPORT-SWITCH` | 參數 `data_access.export_field_enabled`；`normalize_content` | `DA-EXPORT-SWITCH disabled_field_becomes_null` |
| 51 | 驗證結果：系統自動測試，加上申請人確認 | `DA-VERIFY-CASES`、`K-VERIFY`、`K-CONFIRM` | `build_verification_cases`；核心 | `DA-VERIFY-CASES generates_in_row_field_period_cases` |
| 52 | 使用情境的六個分類 | `DA-PURPOSE` | `purpose_category` 的初始資料（§10.1 `120`） | `DA-PURPOSE initial_categories_are_the_six_in_rules` |
| 53 | 分類可在後台調整 | `DA-PURPOSE-ADMIN` | `api.data_access_purpose_category_save` | `DA-PURPOSE-ADMIN only_sys_admin_with_reason_and_audit` |
| 54 | 被既有有效授權完全涵蓋：直接擋下 | `K-OVERLAP-BLOCK`、`DA-OVERLAP-COVERED` | 核心；`find_overlaps` | `DA-OVERLAP-COVERED single_grant_covering_everything`、`K-OVERLAP-BLOCK data_access_covered_submission_blocked` |
| 55 | 部分重疊：必須填理由；簽核畫面標示重疊的部分 | `K-OVERLAP-REASON`、`DA-OVERLAP-PARTIAL` | 核心；`find_overlaps`（`items[].detail`） | `DA-OVERLAP-PARTIAL lists_overlapping_part_of_each_grant`、`K-OVERLAP-REASON data_access_partial_requires_reason` |
| 56 | 狀態：草稿 → 送審 → 逐關核准（或退回）→ 待套用 → 驗證中 → 生效 → 到期／撤銷 | 核心的狀態（依 §1.2 的選項） | 核心 | `K-FULFIL data_access_statuses_follow_declared_options` |
| 57 | 待套用：MIS 核准後，等 DC 回報套用成功 | `K-FULFIL`、`DA-FULFIL-RULE` | 核心；`build_fulfilment` | `K-FULFIL data_access_not_effective_until_dc_applied` |
| 58 | 驗證中：自動測試加申請人確認，兩者都通過才生效 | `K-VERIFY`、`K-CONFIRM`、`DA-VERIFY-CASES` | 核心；`build_verification_cases` | `K-CONFIRM data_access_active_only_after_tests_pass_and_confirmation` |
| 59 | 自動測試沒過，退回 MIS 修正設定 | `K-VERIFY` | 核心 | `K-VERIFY data_access_failed_case_returns_to_fulfilment` |
| 60 | 申請人逾期沒有確認，自動撤銷 | `K-CONFIRM`、`DA-DC-WITHDRAW` | 核心（選項 `confirmation_timeout_action = revoke`）；`on_grant_event` | `K-CONFIRM data_access_confirmation_timeout_revokes` |

### 加速功能

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 61 | 沿用前案或範本：可以從空白、前案或範本開始 | 核心的來源單與範本（骨幹沒有規則代碼，見附錄 A-9）、`DA-TEMPLATE-STANDARD` | 核心；`api.data_access_standard_template_save` | `DA-TEMPLATE-STANDARD only_owner_of_every_package_can_save`、`DA-TEMPLATE-STANDARD content_is_normalized_scope_and_period` |
| 62 | 一鍵續期 | 同 #36 | 同 #36 | 同 #36 |
| 63 | 批次核准：每張單各留一筆核准紀錄 | `K-BATCH` | 核心 | `K-BATCH data_access_identical_renewals_one_event_each` |
| 64 | 批次畫面每張單顯示差異摘要 | `DA-DIFF` | `diff_content` | `DA-DIFF rows_follow_documented_order_and_text` |
| 65 | 有「擴大」或「重疊警示」的單不能放進批次 | `K-BATCH`、`DA-CHANGE-COMPARE`、`DA-OVERLAP-PARTIAL` | 核心（前提 B7）；`compare_content`、`find_overlaps` | `K-BATCH data_access_overlap_or_expand_excluded_from_batch` |
| 66 | 手機核准：SSO 登入；核准時 MFA；L3、L4 都一樣 | `K-MOBILE-MFA` | 核心 | `K-MOBILE-MFA data_access_mobile_decision_requires_mfa_l3_and_l4` |

### 時間規則與預設時限

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 67 | 授權起迄和資料期間分開存 | `DA-DATA-PERIOD` | 內容的 `data_period`；核心的有效期間 | `DA-DATA-PERIOD stored_separately_from_validity` |
| 68 | 到期前提醒；到期自動失效 | `K-EXPIRE-REMIND`、`K-EXPIRE` | 核心 | `K-EXPIRE-REMIND data_access_reminds_14_days_before`、`K-EXPIRE data_access_grant_expires_after_valid_to` |
| 69 | 預設：催辦，每關 3 個工作天未簽 | `DA-DEFAULT-SETTINGS`、`K-SLA-REMIND` | §7.2 | `DA-DEFAULT-SETTINGS remind_after_3_workdays` |
| 70 | 預設：升級，催辦後再 2 個工作天未簽 | `DA-DEFAULT-SETTINGS`、`K-SLA-ESCALATE` | §7.2 | `DA-DEFAULT-SETTINGS escalate_after_2_workdays` |
| 71 | 預設：授權上限 L3 一年、L4 半年 | `DA-DEFAULT-SETTINGS`、`K-VALIDITY-MAX` | §7.2 | `DA-DEFAULT-SETTINGS max_months_l3_12_l4_6` |
| 72 | 預設：到期前提醒 14 天 | `DA-DEFAULT-SETTINGS`、`K-EXPIRE-REMIND` | §7.2 | `DA-DEFAULT-SETTINGS remind_before_expiry_14_days` |
| 73 | 預設：負責人異動寬限期 14 天 | `DA-DEFAULT-SETTINGS`、`K-OWNER-CONTINUITY` | §7.2 | `DA-DEFAULT-SETTINGS owner_grace_14_days` |
| 74 | 預設：驗證結果確認時限 5 個工作天 | `DA-DEFAULT-SETTINGS`、`K-CONFIRM` | §7.2 | `DA-DEFAULT-SETTINGS confirmation_due_5_workdays` |
| 75 | 預設：紀錄保存年限 10 年 | `DA-DEFAULT-SETTINGS`、`K-AUDIT-APPEND` | 核心的全域參數 `audit.retention_years` | `DA-DEFAULT-SETTINGS retention_10_years` |

### 稽核證據、整合、技術

| # | rules.md | 代碼 | 由誰實作 | 測試 |
|---|---|---|---|---|
| 76 | 每次狀態變更記下：誰、何時、依據哪條規則、改了什麼、IP 和裝置 | `K-AUDIT-APPEND` | 核心 | `K-AUDIT-APPEND data_access_every_transition_records_actor_rule_change_ip_device` |
| 77 | 紀錄只增不改，並加上雜湊鏈 | `K-AUDIT-APPEND`、`K-AUDIT-CHAIN` | 核心 | `K-AUDIT-CHAIN data_access_case_chain_verifies_end_to_end` |
| 78 | 稽核唯讀查詢全公司的單；匯出 Excel 清單與 PDF 證據頁 | `K-AUDITOR-READONLY` | 核心（稽核查詢與證據頁） | `K-AUDITOR-READONLY data_access_auditor_reads_all_cannot_write` |
| 79 | 整合：現有簽核系統、人員與組織做成可替換的介面；獨立網站＋SSO＋mail | 工程規範第 2 節（port 與 adapter） | 後端核心 | 後端的 adapter 合約測試 |
| 80 | 技術：PostgreSQL；商業邏輯全部在 SQL function | 工程規範第 1、2 節 | 本文件所有規則都在 `pack_data_access` 的 function | `900_architecture_test.sql` |
| 81 | 技術：薄後端只負責傳話和對外工作（與 DC 交換規則、自動驗證） | 工程規範第 2 節；`DA-FULFIL-RULE`、`DA-VERIFY-CASES` | §8.4、§8.5 的 worker 與 adapter（不做任何判斷） | 後端的 DC adapter 合約測試 |
| 82 | 技術：SSO、mail、DC、人員與組織先接模擬版本 | 工程規範第 2 節；骨幹第 12 節 | `mock`、`manual`、`http` adapter；`sim/` | 後端的 DC adapter 合約測試 |
| 83 | 技術：驗收先用 5 個模擬案例 | — | [acceptance-cases.md](../packs/data-access/acceptance-cases.md) | `200`–`240` 的流程測試與 `e2e/` |
| 84 | 技術：地端部署；上線範圍全公司 | — | 部署設定，不是流程包的規則 | — |

rules.md 沒有、來自骨幹的一條：骨幹第 11 節（對外整合介面）→ `DA-ENTITLEMENT` → `describe_entitlements`、`evaluate_constraints` → `DA-ENTITLEMENT one_entitlement_per_field`、`DA-ENTITLEMENT check_and_reconcile_modes`。

## 10. migration 與測試

### 10.1 migration（`db/packs/data_access/`）

後面的檔案可以呼叫前面的，反過來不行。

| 檔案 | 內容 |
|---|---|
| `010_schema.sql` | schema、三個 enum 型別、權限 |
| `020_tables.sql` | §4.1 的資料表、索引、`reject_change` 與只增不改的觸發器 |
| `030_kernel_access.sql` | §4.3「核心存取」的 function（唯一讀核心資料表的檔案） |
| `040_catalog.sql` | §4.3「目錄」的 function |
| `050_scope_algebra.sql` | §4.3「範圍運算」的 function（§5.0） |
| `060_text.sql` | §4.3「文字」的 function |
| `070_hooks_content.sql` | `normalize_content`、`validate_content`、`classify_tier`、`compare_content`、`diff_content`、`summarize_content` |
| `080_hooks_flow.sql` | `find_overlaps`、`stage_scopes`、`automated_checks` |
| `090_hooks_fulfilment.sql` | `build_fulfilment`、`build_verification_cases`、`on_grant_event`、`describe_entitlements`、`evaluate_constraints` |
| `100_api.sql` | §6 的十個 function、`COMMENT`、`grant execute … to sgn_app` |
| `110_registration.sql` | `register_role`（§3.5）、`register_setting_definition`（§7.1）、`register_setting_value`（§7.2）、`register_rule`（§7.3）、`register_error`（§7.4、§7.5）、`register_notification_template`（§7.6） |
| `120_reference_data.sql` | `purpose_category` 的六筆初始資料（下表） |
| `130_process.sql` | `register_process_type`（§1.5 加上 §2.3 的 `form_schema`）、`register_approval_policy`（§3.4） |

`purpose_category` 的初始資料（rules.md 的六個分類；`updated_by` 為系統 actor）：

| `category_code` | `name` | `requires_description` | `sort_order` |
|---|---|---|---|
| `reporting` | 報表與分析 | false | 10 |
| `development` | 系統開發或測試 | false | 20 |
| `ai_model` | AI 模型訓練或推論 | false | 30 |
| `audit_compliance` | 稽核或法遵查核 | false | 40 |
| `operations` | 客戶服務或營運作業 | false | 50 |
| `other` | 其他（需說明） | true | 60 |

種子資料（只載入開發與測試環境）：`db/seed/packs/data_access/010_catalog.sql`（以 `api.data_access_catalog_sync` 匯入 acceptance-cases.md §1.1 的快照）、`020_grants.sql`（acceptance-cases.md §1.3 的五筆既有授權，用假時鐘呼叫對外 function 走完流程產生，讓稽核紀錄與雜湊鏈完整）、`030_templates.sql`（acceptance-cases.md §1.4 的標準範本）。

### 10.2 測試（`db/tests/packs/data_access/`）

測試名稱的格式是「規則代碼 說明」。§9 列出的每個測試都要存在；下表是檔案的切分與最少的案例數。§5 每個 hook 的每一列範例都是一個測試案例。

| 檔案 | 涵蓋 | 最少案例數 |
|---|---|---|
| `010_catalog_sync_test.sql` | `DA-CATALOG-SOURCE`：匯入種子、重複匯入不變、缺少的項目停用、重新啟用、分級變更出現在 `changes`、影響清單、擁有者同步與缺擁有者、三種格式錯誤、空快照、重複代碼、非系統管理員被拒絕、同步紀錄不能修改 | 14 |
| `020_scope_algebra_test.sql` | `DA-CHANGE-COMPARE`：§5.0 判定表的 12 列；`filters_within`、`filters_disjoint`、`period_relation`、`period_disjoint` 的邊界（重複的列條件欄位、`unknown`、`null` 期間） | 20 |
| `030_normalize_test.sql` | `DA-TIER-AUTO-GRANT`（§5.1 範例 1、3、4、5，加上冪等）、`DA-EXPORT-TIER`（範例 2、L3 可匯出）、`DA-EXPORT-SWITCH`、`DA-SCOPE-STRUCTURED`（改寫 `eq`、排序、合併重複的主題包）、`DA-NO-MEDIUM` | 13 |
| `040_validate_test.sql` | §5.2 的 13 項檢查各至少一個不通過的案例，加上範例 1–4；`DA-STAGE-OWNER`（沒有擁有者）、`DA-DATA-PERIOD`、`DA-PURPOSE` | 18 |
| `050_classify_test.sql` | `DA-TIER-MAX`：§5.3 的 5 列 | 5 |
| `060_compare_test.sql` | `DA-CHANGE-COMPARE`、`DA-CHANGE-PURPOSE`：§5.4 的 15 列，加上「只改分類」「只改說明」 | 17 |
| `070_diff_summarize_test.sql` | `DA-DIFF`：§5.5 範例 1–4、與 `compare_content` 的一致性；`summarize_content`：§5.6 範例 1–4 | 10 |
| `080_overlap_test.sql` | `DA-OVERLAP-COVERED`、`DA-OVERLAP-PARTIAL`：§5.7 的 10 列、多筆授權的範例、邊界情況表的每一列 | 16 |
| `090_stage_checks_test.sql` | `DA-STAGE-OWNER`：§5.8 的 4 列；`DA-MIS-CHECK`：§5.9 範例 1–4、每個檢查的每種結果 | 16 |
| `100_fulfilment_test.sql` | `DA-FULFIL-RULE`：§5.10 範例 1–4；`DA-VERIFY-CASES`：§5.11 範例 1–4、自我一致；`DA-DATA-PERIOD` | 12 |
| `110_dc_rule_test.sql` | `DA-DC-WITHDRAW`：§5.12 的 7 列、`dc_rule_mark_withdrawn` 的成功與三種錯誤、`dc_rule_list` 的排序與篩選 | 13 |
| `120_entitlement_test.sql` | `DA-ENTITLEMENT`：§5.13 範例 1–4、§5.14 的 10 列 | 14 |
| `130_admin_api_test.sql` | `DA-PURPOSE`、`DA-PURPOSE-ADMIN`（新增、修改、停用、最後一個不能停用、沒填原因、非系統管理員、寫稽核事件）；`DA-TEMPLATE-STANDARD`（擁有者可存、非擁有者被拒、內容被整理、修改別人的範本被拒、停用）；`catalog_search`、`catalog_get` | 18 |
| `140_registration_test.sql` | `DA-PATH-L3`、`DA-PATH-L4`（關卡、順序、resolver、適用條件、時限參數、檢查清單）；`DA-DEFAULT-SETTINGS` 的 7 個；§1.2 的選項；14 個 hook 都已登記且簽章正確；§7.3 的 25 個規則代碼都已登記 | 16 |
| `200_flow_new_l3_test.sql` | 驗收案例 1，以及 §9 裡用這個流程驗證的核心規則（`K-PARALLEL-ALL`、`K-CLAIM`、`K-FULFIL`、`K-VERIFY`、`K-CONFIRM`、`K-AUDIT-*`） | 10 |
| `210_flow_l4_test.sql` | 驗收案例 2（`K-MOBILE-MFA`、`K-VALIDITY-MAX`、`K-SOD-*`） | 8 |
| `220_flow_overlap_reduce_test.sql` | 驗收案例 3（`K-OVERLAP-*`、`K-CHANGE-*`） | 8 |
| `230_flow_return_renew_batch_test.sql` | 驗收案例 4（`K-RETURN`、`K-BATCH`） | 9 |
| `240_flow_time_test.sql` | 驗收案例 5（`K-SLA-*`、`K-DELEGATE`、`K-OWNER-CONTINUITY`、`K-EXPIRE*`、`K-REVOKE`） | 12 |
| `900_architecture_test.sql` | 見下 | 7 |

架構測試（查 `pg_catalog` 與原始碼）：

1. `sgn_app` 對 `pack_data_access` 沒有任何權限。
2. `pack_data_access` 的所有 function 擁有者是 `sgn_owner`，都固定 `search_path`。
3. `api.data_access_*` 都是 `security definer`、第一個參數是 `p_actor`、有 `COMMENT`。
4. 除了 `030_kernel_access.sql` 定義的 function，沒有任何 function 的原始碼出現 `sgn.`（核心資料表）。
5. function 的原始碼裡沒有寫死的中文訊息（中文字元只能出現在註解與 §7.5 允許的分隔符號）。
6. function 的原始碼裡沒有寫死的時限：不得出現 `interval` 常數；對日期加減的數字常數只能是 1（§5.11 的「前一天」「隔天」）。
7. `sgn.rule` 裡每個 `DA-` 開頭的代碼，都至少有一個名稱以它開頭的測試。

輔助檔：`helpers/dc_reference.sql`（§8.5 的 `evaluate_dc_query`，只給測試用）、`fixtures/dc_evaluation.json`（§8.5 的固定資料，後端 `mock` adapter 的測試與 DC 模擬器的合約測試共用）。

## 附錄 A：rules.md 的缺漏與這份契約的處理

沒有修改或放寬任何一條 rules.md 的規則。下列是 rules.md 沒有寫明、實作時一定會遇到的問題，以及這份契約採用的做法；每一項都在回報中列出，請規則的負責人確認。

| # | 問題 | 這份契約的做法 |
|---|---|---|
| A-1 | 授權撤銷之後，DC 上已經套用的規則怎麼處理，rules.md 沒有寫。第一版 DC 是手動套用，撤銷後沒有人會被通知去撤回 | 新增 `DA-DC-WITHDRAW`：通知 MIS、列入待撤回清單、撤回後留紀錄（§8.3） |
| A-2 | 目錄把欄位從 L3 調成 L4（或停用欄位）之後，已生效的授權與簽核中的申請怎麼處理 | 不自動撤銷：通知系統管理員與資料擁有者；簽核中的單在下一關的自動檢查顯示失敗（§4.2、§5.9） |
| A-3 | 「L4 預設不可匯出」的「預設」可以有兩種解讀：表單的預設值，或 L4 不能申請匯出 | 採較嚴格的解讀：L4 不能申請匯出，由參數 `data_access.export_requestable` 控制，系統管理員可以調整（§7.1） |
| A-4 | 簽核人可不可以直接把「可以匯出」改成「只能查詢」。rules.md 列出簽核人可縮小的只有資料範圍、授權起迄、資料期間 | 不開放簽核人直接改；申請人在退回後自己改時算縮小（§2.3） |
| A-5 | 資料期間是否必填、可不可以不設起日或迄日 | 選到有期間欄位的主題包時必填，起日與迄日都要填（§5.2 第 8 項） |
| A-6 | 使用情境的文字說明什麼時候必填 | 只有分類標示為「需說明」時必填；初始資料只有「其他」標示（§10.1） |
| A-7 | 現任的資料擁有者（當初不是這張單的簽核人）可不可以撤銷。rules.md 的撤銷名單沒有；畫面草圖的「授權總覽」有撤銷按鈕 | 屬於核心的 `K-REVOKE`，這份契約不處理；需要確認 |
| A-8 | 多筆授權合起來才涵蓋本次申請時，算完全涵蓋還是部分重疊 | 部分重疊（§5.7）；DC 對多條規則的合併方式確認後可以再調整 |
| A-9 | 骨幹第 5 節沒有規則代碼的 rules.md 規則：一鍵續期、沿用前案或範本、被授權者的建立規則（只能是團隊、專案、agent；專案要有負責人與結束日；相似名稱提示） | §9 標示為「骨幹沒有規則代碼」；建議骨幹補上（見回報） |
| A-10 | `K-BATCH` 的文字是「只有與來源單無差異的續期可以批次核准」，rules.md 另外要求「有重疊警示的單不能放進批次」 | 列為前提 B7，建議骨幹把這個條件寫進 `K-BATCH` |
| A-11 | MIS 同一個人做合規檢查（簽核）與執行設定，和「每一關都是不同的人」的關係 | 「每關不同人」只適用於簽核關；執行關由同一位 MIS 接續（前提 B9） |
| A-12 | 兩張相同的申請同時在簽核中，算不算重複 | 不算：rules.md 只比對「既有有效授權」。第一張生效後，第二張在之後各關的自動檢查會顯示「已經被完全涵蓋」 |

## 附錄 B：待納入的增修對這份契約的影響

[pending-amendments.md](pending-amendments.md) 的項目進入骨幹之後，這份契約要跟著修訂的地方：

| 增修 | 影響 |
|---|---|
| A1 對外整合介面 | 已實作兩個 hook（§5.13、§5.14）；資源類型、動作、限制條件的鍵以本文件為準，`05-integration.md` 的例子要對齊（列條件的鍵是 `filter`，不是 `field`） |
| A3 申請單保密、A4 查閱紀錄 | 人資類主題包（例如 `payroll`）的申請可能要宣告保密：§1.2 增加選項；`summarize_content` 的摘要要有遮蔽版本 |
| A5 依事件到期 | 授權起迄之外多一種結束條件：`find_overlaps` 的有效期間比較（§5.7）、`build_fulfilment` 的 `valid`（§8.1）、驗證案例的 `request:after_validity`（§5.11）要跟著改 |
| A6 資料領域擴充 | 種子目錄與驗收案例增加人資、財會的主題包（acceptance-cases.md §1.1） |
| A11 宣告式流程定義 | 資料授權的範圍比較與涵蓋判定無法用宣告表達，仍然使用 hook |
| A16 受管系統、A17 最後一關拆分 | `catalog_package` 增加所屬的受管系統；`dc_apply` 關的 resolver 改成該系統的管理人；不經過 DC 的系統使用自己的交付格式（§8.1 的 `format` 依系統而定） |
| A20 平台管理角色分離 | §6 用到 `sys_admin` 的地方改成對應的管理角色 |
| A21 檔案與人工的整合方式 | `dc_rule` 的待撤回清單與對帳的關係（§8.3）要和 `05-integration.md` 一起定案 |
