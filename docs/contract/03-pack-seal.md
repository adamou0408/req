# 契約：合約用印流程包（`seal`）

這份文件定義合約用印流程包的全部實作內容。業務規則的來源是 [packs/seal/rules.md](../packs/seal/rules.md)，這裡只引用、不重寫；介面以 [00-spine.md](00-spine.md)（以下稱「骨幹」）為準。

這個流程包的目的是證明核心不綁定領域，所以設計上守住四條界線：

- 不修改任何核心資料表、核心 function、後端核心、前端核心。
- 沒有前端專屬元件：表單、簽核、執行、確認全部用通用畫面與通用欄位型別（含 `attachment`）。`web/src/packs/seal/` 不存在。
- 沒有外部系統：`api/src/packs/seal/` 不存在。
- 沒有專屬的對外 function（第 6 節）。

## 0. 前提與依賴

### 0.1 流程包總覽

| 項目 | 數量 | 位置 |
|---|---|---|
| 表單欄位 | 8 | 第 2 節 |
| 級別 | 2 | 第 1 節 |
| 關卡 | 簽核 3 關、執行 1 關 | 第 3 節 |
| 代碼表 | 2（`seal_kind`、`contract_type`） | 第 4 節 |
| 讀取用 view | 1（`seal_case`） | 第 4 節 |
| 實作的 hook | 8；另外 4 個用核心預設 | 第 5 節 |
| 專屬對外 function | 0 | 第 6 節 |
| 專屬參數 | 1；另釘住 1 個核心參數的流程類型值 | 第 7.1 節 |
| 規則代碼 | 10 | 第 7.2 節 |
| 錯誤代碼 | 2 | 第 7.3 節 |
| 通知範本 | 3 | 第 7.4 節 |

### 0.2 依賴的核心介面（骨幹沒有定名的部分）

骨幹固定了 hook 簽章、resolver、選項與參數命名，但下列項目要等 `01-kernel.md` 才有正式寫法。這份契約對每一項都寫出「假定的寫法」，並把依賴集中在指定的位置；`01-kernel.md` 定案後只需要改那個位置，業務內容不變。每一項都同時列在回報的「對核心的需求」。

| 編號 | 需要的能力 | 這份文件假定的寫法 | 依賴集中在 |
|---|---|---|---|
| D-1 | 登記入口：流程類型、級別、路徑、角色、參數定義與初始值、規則代碼、錯誤代碼、通知範本 | `sgn_internal.register_*`（第 10.1 節列出每個呼叫要帶的資料） | migration `020`、`050`、`060` |
| D-2 | 讀取申請單的申請人、狀態、目前版本內容、執行結果 | `sgn.case(id, case_no, process_type_code, applicant_id, status, current_version_id)`、`sgn.case_version(id, content)`、`sgn.fulfilment(case_id, completed_at, result)` | view `pack_seal.seal_case`（唯一讀核心資料表的地方） |
| D-3 | 讀取參數 | `sgn_internal.setting(p_key text, p_scope jsonb) returns jsonb` | `pack_seal.major_amount_threshold()` |
| D-4 | 丟出錯誤 | `sgn_internal.raise_error(p_code text)` | `pack_seal.find_overlaps`、`pack_seal.build_fulfilment` |
| D-5 | 欄位值在內容 JSON 裡的形狀 | `money`：JSON 整數（幣別最小單位，新台幣為元）。`attachment`：陣列，元素為 `{"attachment_id", "file_name", "sha256", "size_bytes", "mime_type"}`，`sha256` 一定有值 | `pack_seal.file_hashes()`、各 hook |
| D-6 | `form_schema` 的屬性 | `key`、`type`、`label`、`help`、`required`、`summary`、`reducible`、`options`、`min`、`max`、`max_length`、`min_items`、`currency`（第 2 節） | `pack_seal.build_form_schema()` |
| D-7 | 關卡適用條件的格式 | `null`＝所有級別；`{"tier_in": ["major"]}`＝只有列出的級別 | 第 3 節的路徑資料 |
| D-8 | 執行人的宣告方式：誰執行、時限、檢查清單 | 路徑裡 `phase = "fulfilment"` 的關卡（骨幹修改建議 S-1） | 第 3 節的 `sealing` 關 |
| D-9 | 人工執行的通用格式：通用畫面能顯示執行內容，並依 `result_schema` 收集、檢查、保存完成回報 | `build_fulfilment` 回傳 `format = "manual_task"` 的結構（第 8.1 節；骨幹修改建議 S-2） | `pack_seal.build_fulfilment` |
| D-10 | hook 的呼叫順序與參數保證 | 順序：`normalize_content` → 表單定義檢查 → `validate_content` → `classify_tier` → `find_overlaps`。`find_overlaps` 與 `build_fulfilment` 的 `p_case_id` 一定是已存在的申請單（草稿先存檔再檢查） | 第 5 節 |
| D-11 | 稽核事件能引用流程包的規則代碼 | 登記流程類型時帶 `hook_rules`：hook 名稱 → 規則代碼；核心寫入該 hook 相關的稽核事件時一併記下 | 第 1.3 節 |
| D-12 | 申請人確認畫面的說明文字可由流程類型指定 | 流程類型登記的 `confirmation_prompt` | 第 1.1 節 |
| D-13 | 通知的事件代碼與範本變數 | 事件 `fulfilment_ready`、`fulfilment_completed`、`confirmation_reminder`；變數 `{{case_no}}`、`{{title}}`、`{{applicant_name}}`、`{{due_date}}`、`{{case_url}}`、`{{fulfilment_url}}` | 第 7.4 節 |
| D-14 | 選項 `revocable_after_fulfilment = false` 的效果 | 執行完成（狀態進入 `verifying`）之後，取消與撤銷都被核心拒絕 | 第 8.3 節 |
| D-15 | 選項 `confirmation_timeout_action = remind` 的效果 | 確認逾期時只寄催辦並寫稽核事件，狀態維持 `verifying`；之後持續催辦，間隔由核心決定 | 第 8.2 節 |
| D-16 | 新版本的級別重新判定 | 每個新版本都呼叫 `classify_tier`。級別升高時視為擴大；級別降低時，尚未開始的關卡依新級別重新套用適用條件，已開始的關卡不取消 | 第 5.3 節 |

## 1. 流程類型登記

### 1.1 基本資料

| 項目 | 值 |
|---|---|
| 代碼 | `seal` |
| 名稱 | 合約用印 |
| 所屬流程包 | `seal` |
| hook 所在 schema | `pack_seal` |
| 規則代碼前綴 | `SEAL-` |
| 申請人確認的說明文字（D-12） | 我已領回用印完成的文件 |

### 1.2 選項

骨幹第 3 節的每一項：

| 選項 | 值 | 在這個流程的效果 |
|---|---|---|
| `uses_principal` | `false` | 申請單不指定被授權者；不使用 `principal_owner` resolver |
| `has_validity` | `false` | 沒有有效起迄；完成後狀態是 `completed`，不產生授權 |
| `renewable` | `false` | 沒有續期入口 |
| `overlap_check` | `true` | 送審時呼叫 `find_overlaps` |
| `requires_fulfilment` | `true` | 核准後進入 `pending_fulfilment`，由印鑑管理人執行 |
| `requires_verification` | `false` | 不產生驗證案例；執行完成後直接等申請人確認 |
| `requires_confirmation` | `true` | 申請人確認領回後才 `completed` |
| `confirmation_timeout_action` | `remind` | 確認逾期只催辦 |
| `revocable_after_fulfilment` | `false` | 用印後不可取消、不可撤銷 |
| `batch_renewal` | `false` | 沒有批次核准 |

狀態路徑因此是：

```
draft → in_approval ⇄ returned
      → pending_fulfilment → verifying → completed
draft、in_approval、returned、pending_fulfilment → cancelled
```

`active`、`expired`、`revoked` 在這個流程不會出現。

### 1.3 級別與 hook

| 級別代碼 | 名稱 | 排序 |
|---|---|---|
| `standard` | 一般 | 1 |
| `major` | 重大 | 2 |

登記資料：

```json
{
  "code": "seal",
  "name": "合約用印",
  "pack": "seal",
  "options": {
    "uses_principal": false,
    "has_validity": false,
    "renewable": false,
    "overlap_check": true,
    "requires_fulfilment": true,
    "requires_verification": false,
    "requires_confirmation": true,
    "confirmation_timeout_action": "remind",
    "revocable_after_fulfilment": false,
    "batch_renewal": false
  },
  "confirmation_prompt": "我已領回用印完成的文件",
  "tiers": [
    {"code": "standard", "name": "一般", "sort_order": 1},
    {"code": "major", "name": "重大", "sort_order": 2}
  ],
  "hooks": {
    "normalize_content": "pack_seal.normalize_content",
    "validate_content": "pack_seal.validate_content",
    "classify_tier": "pack_seal.classify_tier",
    "compare_content": "pack_seal.compare_content",
    "diff_content": "pack_seal.diff_content",
    "summarize_content": "pack_seal.summarize_content",
    "find_overlaps": "pack_seal.find_overlaps",
    "build_fulfilment": "pack_seal.build_fulfilment"
  },
  "hook_rules": {
    "validate_content": "SEAL-TYPE-OTHER",
    "classify_tier": "SEAL-TIER",
    "compare_content": "SEAL-CHANGE",
    "find_overlaps": "SEAL-OVERLAP",
    "build_fulfilment": "SEAL-FULFIL"
  }
}
```

`form_schema` 由 `pack_seal.build_form_schema()` 產生後一起登記（第 2 節）。沒有登記的 hook：`stage_scopes`、`automated_checks`、`build_verification_cases`、`on_grant_event`（原因見第 5.9 節）。

## 2. 表單定義（`form_schema`）

八個欄位，和 rules.md「申請內容」的八列一一對應。

| key | 型別 | 名稱 | 必填 | 限制 | 摘要欄位 | 簽核人可縮小 |
|---|---|---|---|---|---|---|
| `contract_name` | `text` | 合約名稱 | 是 | 最長 200 字 | 是 | 否 |
| `counterparty` | `text` | 合約對象 | 是 | 最長 200 字 | 是 | 否 |
| `contract_type` | `select` | 合約類型 | 是 | 選項來自 `pack_seal.contract_type` | 是 | 否 |
| `amount` | `money` | 合約金額 | 是 | 新台幣整數，0 到 999,999,999,999 | 是 | 是，只能調降，最低 0 |
| `seal_kind` | `select` | 印鑑種類 | 是 | 選項來自 `pack_seal.seal_kind` | 是 | 否 |
| `copies` | `integer` | 用印份數 | 是 | 1 到 999 | 是 | 是，只能減少，最低 1 |
| `description` | `textarea` | 說明 | 否；合約類型是「其他」時必填（`validate_content`） | 最長 2,000 字 | 否 | 否 |
| `contract_files` | `attachment` | 合約檔案 | 是 | 至少 1 份 | 否 | 否 |

- 金額上限 999,999,999,999 與份數上限 999 是輸入防呆用的技術上限，不是業務規則。
- 「合約類型：其他（需說明）」的說明寫在既有的「說明」欄位，不另外增加欄位（附錄 A-2）。
- 兩個可縮小的欄位由核心在簽核畫面提供縮小入口；送出後核心呼叫 `compare_content`，結果不是 `reduce` 就拒絕（`K-CHANGE-REDUCE`）。

`pack_seal.build_form_schema()` 的輸出（選項依代碼表的 `sort_order` 排列；以下是套用第 4.2 節初始資料後的結果）：

```json
{
  "fields": [
    {
      "key": "contract_name",
      "type": "text",
      "label": "合約名稱",
      "required": true,
      "max_length": 200,
      "summary": true
    },
    {
      "key": "counterparty",
      "type": "text",
      "label": "合約對象",
      "help": "請填合約上對方的完整名稱",
      "required": true,
      "max_length": 200,
      "summary": true
    },
    {
      "key": "contract_type",
      "type": "select",
      "label": "合約類型",
      "required": true,
      "summary": true,
      "options": [
        {"value": "procurement", "label": "採購"},
        {"value": "sales", "label": "銷售"},
        {"value": "nda", "label": "保密"},
        {"value": "lease", "label": "租賃"},
        {"value": "other", "label": "其他（需說明）"}
      ]
    },
    {
      "key": "amount",
      "type": "money",
      "label": "合約金額",
      "help": "新台幣整數；無金額的合約填 0",
      "currency": "TWD",
      "required": true,
      "min": 0,
      "max": 999999999999,
      "summary": true,
      "reducible": "decrease"
    },
    {
      "key": "seal_kind",
      "type": "select",
      "label": "印鑑種類",
      "required": true,
      "summary": true,
      "options": [
        {"value": "company_seal", "label": "公司大章"},
        {"value": "contract_seal", "label": "合約專用章"}
      ]
    },
    {
      "key": "copies",
      "type": "integer",
      "label": "用印份數",
      "required": true,
      "min": 1,
      "max": 999,
      "summary": true,
      "reducible": "decrease"
    },
    {
      "key": "description",
      "type": "textarea",
      "label": "說明",
      "help": "合約類型選「其他」時必填",
      "required": false,
      "max_length": 2000
    },
    {
      "key": "contract_files",
      "type": "attachment",
      "label": "合約檔案",
      "required": true,
      "min_items": 1
    }
  ]
}
```

內容範例（一張完整的申請內容，後面各節的範例稱它為「範例 A」）：

```json
{
  "contract_name": "年度設備採購合約",
  "counterparty": "宏遠科技股份有限公司",
  "contract_type": "procurement",
  "amount": 1200000,
  "seal_kind": "contract_seal",
  "copies": 3,
  "contract_files": [
    {
      "attachment_id": 501,
      "file_name": "equipment_purchase_2027.pdf",
      "sha256": "h1",
      "size_bytes": 248113,
      "mime_type": "application/pdf"
    }
  ]
}
```

範例裡的 `sha256` 用 `h1`、`h2` 代表不同的雜湊值。

## 3. 路徑

一個路徑（`approval_policy`，版本 1，生效時間＝migration 套用時間），四個關卡。級別的差異用適用條件表達。

| 順序 | 代碼 | 名稱 | 階段 | resolver | resolver 參數 | 模式 | 並行群組 | 適用條件 | 時限參數 |
|---|---|---|---|---|---|---|---|---|---|
| 10 | `manager` | 申請人主管 | `approval` | `applicant_manager` | `{}` | 逐一 | 無 | 所有級別 | 催辦 `approval.remind_after_workdays`、升級 `approval.escalate_after_workdays` |
| 20 | `legal` | 法務 | `approval` | `role_group_claim` | `{"role": "legal"}` | 逐一 | 無 | 所有級別 | 同上 |
| 30 | `cfo` | 財務長 | `approval` | `role_holder` | `{"role": "cfo"}` | 逐一 | 無 | `{"tier_in": ["major"]}` | 同上 |
| 40 | `sealing` | 用印 | `fulfilment` | `role_group_claim` | `{"role": "seal_keeper"}` | 逐一 | 無 | 所有級別 | 同上 |

所以一般級別走 `manager → legal → sealing`，重大級別走 `manager → legal → cfo → sealing`。這個流程沒有並行關卡。時限參數沒有流程包自己的值，取核心預設（催辦 3 個工作天、升級再 2 個工作天）。

`sealing` 是執行關，不是簽核關：它在最後一個簽核關核准之後才開始，認領、職責分離、代理、催辦、升級都沿用核心對關卡的處理（`K-CLAIM`、`K-SOD-APPLICANT`、`K-DELEGATE`、`K-SLA-REMIND`、`K-SLA-ESCALATE`），差別只在工作內容是「執行並回報」而不是「核准或退回」。這一列依賴 D-8；核心若改用其他位置宣告執行人，這一列的內容原樣搬過去。

人工檢查清單（每一項都要勾選才能核准或標記完成）：

| 關卡 | 項目代碼 | 文字 |
|---|---|---|
| `manager` | — | 無 |
| `legal` | `declared_matches_file` | 申請單填寫的合約對象與金額，和合約檔案一致 |
| `legal` | `seal_kind_appropriate` | 印鑑種類符合這份合約的性質 |
| `legal` | `terms_reviewed` | 合約條款已經審閱 |
| `cfo` | — | 無 |
| `sealing` | `paper_matches_approved_file` | 紙本合約和核准版本的合約檔案一致 |
| `sealing` | `seal_kind_as_approved` | 使用的印鑑和核准的印鑑種類相同 |
| `sealing` | `copies_within_approved` | 用印份數沒有超過核准份數 |

`declared_matches_file` 存在的原因：級別是依申請人自己填的金額判定的，必須有人核對填寫的金額和合約檔案一致，否則低報金額就能避開財務長（附錄 A-4）。

登記資料：

```json
{
  "process_type": "seal",
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
      "seq": 20, "code": "legal", "name": "法務", "phase": "approval",
      "resolver": {"kind": "role_group_claim", "role": "legal"},
      "mode": "sequential", "parallel_group": null, "applies_when": null,
      "sla": {"remind": "approval.remind_after_workdays", "escalate": "approval.escalate_after_workdays"},
      "checklist": [
        {"code": "declared_matches_file", "label": "申請單填寫的合約對象與金額，和合約檔案一致", "required": true},
        {"code": "seal_kind_appropriate", "label": "印鑑種類符合這份合約的性質", "required": true},
        {"code": "terms_reviewed", "label": "合約條款已經審閱", "required": true}
      ]
    },
    {
      "seq": 30, "code": "cfo", "name": "財務長", "phase": "approval",
      "resolver": {"kind": "role_holder", "role": "cfo"},
      "mode": "sequential", "parallel_group": null, "applies_when": {"tier_in": ["major"]},
      "sla": {"remind": "approval.remind_after_workdays", "escalate": "approval.escalate_after_workdays"},
      "checklist": []
    },
    {
      "seq": 40, "code": "sealing", "name": "用印", "phase": "fulfilment",
      "resolver": {"kind": "role_group_claim", "role": "seal_keeper"},
      "mode": "sequential", "parallel_group": null, "applies_when": null,
      "sla": {"remind": "approval.remind_after_workdays", "escalate": "approval.escalate_after_workdays"},
      "checklist": [
        {"code": "paper_matches_approved_file", "label": "紙本合約和核准版本的合約檔案一致", "required": true},
        {"code": "seal_kind_as_approved", "label": "使用的印鑑和核准的印鑑種類相同", "required": true},
        {"code": "copies_within_approved", "label": "用印份數沒有超過核准份數", "required": true}
      ]
    }
  ]
}
```

這個流程包登記三個角色（已存在就略過；角色的持有人是管理資料，不在 migration 裡）：

| 角色代碼 | 名稱 | 類型 |
|---|---|---|
| `legal` | 法務 | 群組認領 |
| `cfo` | 財務長 | 單一持有人（可設代理人） |
| `seal_keeper` | 印鑑管理人 | 群組認領 |

這個流程會遇到的職責分離組合，全部由核心處理，流程包不寫任何判斷；列在這裡是為了讓核心的測試涵蓋到（人員見 [seed-directory.md](seed-directory.md)）：

| 情況 | 例子 | 預期（核心規則） |
|---|---|---|
| 財務長就是申請人的主管 | 張美玲申請重大合約：`manager` 關與 `cfo` 關都解析到蘇慧敏 | `cfo` 關改由蘇慧敏的上一層主管高志遠簽（`K-SOD-DISTINCT`） |
| 財務長的代理人已經在前面的關卡簽過 | 吳家豪申請重大合約，張美玲在 `manager` 關簽過；蘇慧敏請假由張美玲代理 | `cfo` 關不能由張美玲代簽，改由上一層（`K-SOD-DISTINCT`、`K-DELEGATE`） |
| 法務成員是申請人或已經簽過 | 葉佳蓉申請：簡志豪在 `manager` 關簽過，葉佳蓉是申請人 | `legal` 關沒有合格的認領人；處理方式由核心定義（對核心的需求 N-12） |
| 印鑑管理人是申請人或已經簽過 | 游志明申請：洪美惠在 `manager` 關簽過，游志明是申請人 | `sealing` 關沒有合格的認領人；同上 |

## 4. 資料表與 function（schema `pack_seal`）

這個流程包不保存任何申請單資料。申請內容、執行結果、紀錄都在核心；流程包只有兩張代碼表、一個讀取用的 view 和幾個小工具 function。

### 4.1 schema 與權限

```sql
create schema pack_seal authorization sgn_owner;
revoke all on schema pack_seal from public;
```

- 所有物件的擁有者是 `sgn_owner`。`sgn_app` 在這個 schema 沒有任何權限。
- 所有 function 固定 `set search_path = pg_catalog, pg_temp`，內文一律寫完整的 schema 名稱。
- 沒有任何 function 對 `sgn` 的資料表做 `insert`、`update`、`delete`（架構測試檢查，見第 10.2 節）。

### 4.2 代碼表

```sql
create table pack_seal.seal_kind (
    code text primary key,
    name text not null,
    forces_major boolean not null,
    sort_order integer not null unique
);
comment on table pack_seal.seal_kind is '印鑑種類。forces_major 為 true 的種類一律判定為重大（SEAL-TIER）';

create table pack_seal.contract_type (
    code text primary key,
    name text not null,
    requires_description boolean not null,
    sort_order integer not null unique
);
comment on table pack_seal.contract_type is '合約類型。requires_description 為 true 的類型必須填寫說明（SEAL-TYPE-OTHER）';
```

初始資料：

| `seal_kind.code` | `name` | `forces_major` | `sort_order` |
|---|---|---|---|
| `company_seal` | 公司大章 | true | 1 |
| `contract_seal` | 合約專用章 | false | 2 |

| `contract_type.code` | `name` | `requires_description` | `sort_order` |
|---|---|---|---|
| `procurement` | 採購 | false | 1 |
| `sales` | 銷售 | false | 2 |
| `nda` | 保密 | false | 3 |
| `lease` | 租賃 | false | 4 |
| `other` | 其他（需說明） | true | 5 |

維護方式：代碼表會影響級別判定，屬於控管規則，只能由新的 migration 變更。變更的 migration 要做兩件事：修改代碼表的資料，然後用 `pack_seal.build_form_schema()` 的結果重新登記表單定義。測試 `SEAL-FORM schema_matches_code_tables` 會比對已登記的表單定義和 `build_form_schema()` 的輸出，兩者不同就失敗。

### 4.3 讀取用的 view

hook 需要讀申請單時只讀這個 view。它是整個流程包唯一接觸核心資料表的地方（D-2）。

```sql
create view pack_seal.seal_case as
select
    c.id as case_id,
    c.case_no,
    c.applicant_id,
    c.status,
    v.content,
    f.completed_at as sealed_at,
    (f.result ->> 'actual_copies')::integer as actual_copies
from sgn.case as c
inner join sgn.case_version as v
    on v.id = c.current_version_id
left join sgn.fulfilment as f
    on f.case_id = c.id
    and f.completed_at is not null
where c.process_type_code = 'seal';
```

每張申請單一列。`sealed_at` 與 `actual_copies` 在用印完成前是 null。

### 4.4 工具 function

| function | 簽章 | 性質 | 用途 |
|---|---|---|---|
| `match_key` | `(p_text text) returns text` | `immutable` | 比對合約名稱與對象用的鍵 |
| `file_hashes` | `(p_content jsonb) returns text[]` | `immutable` | 內容裡合約檔案的雜湊集合 |
| `major_amount_threshold` | `() returns numeric` | `stable` | 讀參數 `seal.major_amount_threshold`（唯一讀這個參數的地方） |
| `format_amount` | `(p_amount numeric) returns text` | `immutable` | 金額的顯示文字 |
| `seal_kind_name` | `(p_code text) returns text` | `stable` | 印鑑種類名稱；查不到回傳代碼本身 |
| `contract_type_name` | `(p_code text) returns text` | `stable` | 合約類型名稱；查不到回傳代碼本身 |
| `build_form_schema` | `() returns jsonb` | `stable` | 產生第 2 節的表單定義 |

**`match_key`**：

```sql
select lower(regexp_replace(normalize(coalesce(p_text, ''), nfkc), '\s+', '', 'g'));
```

先做 NFKC 正規化（全形英數與全形空白變成半形），再移除所有空白，最後轉小寫。

| 輸入 | 輸出 |
|---|---|
| `北區經銷合約` | `北區經銷合約` |
| `　北區 經銷合約 `（開頭是全形空白） | `北區經銷合約` |
| `ＡＢＣ Trading Co., Ltd.` | `abctradingco.,ltd.` |
| null | 空字串 |

不處理的差異：公司名稱的寫法不同（例如「股份有限公司」與「（股）公司」）、錯別字。這些情況不會被判定為重複。

**`file_hashes`**：`p_content -> 'contract_files'` 是陣列時，取每個元素的 `sha256`，去除重複後由小到大排序；不是陣列時回傳空陣列。元素沒有 `sha256` 時，結果裡會有一個 null。

| 輸入的 `contract_files` | 輸出 |
|---|---|
| `[{"sha256": "h2"}, {"sha256": "h1"}]` | `{h1,h2}` |
| `[{"sha256": "h1"}, {"sha256": "h1"}]` | `{h1}` |
| 沒有這個 key | `{}` |
| `[{"file_name": "a.pdf"}]` | `{NULL}` |

**`major_amount_threshold`**：回傳 `sgn_internal.setting('seal.major_amount_threshold', '{}')` 轉成的 `numeric`。

**`format_amount`**：`'NT$ ' || to_char(p_amount, 'FM999,999,999,990')`；`p_amount` 是 0 時回傳 `NT$ 0（無金額）`；null 時回傳 `（未填）`。例：`850000` → `NT$ 850,000`。

## 5. hook 規格

共同規定：

- 所有 hook 都不寫入任何資料表。
- 「內容」指已經過 `normalize_content` 的 JSON 物件。hook 收到不完整的內容（草稿預覽）時不得丟錯，依各節的邊界情況處理。
- 下列範例的參數門檻都是預設值 1,000,000。

### 5.1 `normalize_content`

```sql
pack_seal.normalize_content(p_actor bigint, p_content jsonb) returns jsonb  -- immutable
```

`p_actor` 不使用。步驟：

1. `p_content` 不是 JSON 物件（SQL null、JSON null、陣列、純量）：回傳 `{"content": <原值，SQL null 時為 JSON null>, "notices": []}`，不做其他事。
2. 移除值是 JSON null 的頂層 key。
3. `contract_name`、`counterparty`：值是字串時，去掉前後的空白字元（半形空白、tab、換行、全形空白 U+3000），再把中間連續的空白字元換成一個半形空白。
4. `description`：值是字串時，只去掉前後的空白字元（保留中間的換行）。
5. 步驟 3、4 處理後變成空字串的 key 整個移除。
6. 其他 key、以及型別不是字串的值都不動（交給表單定義檢查）。
7. `notices` 一律是空陣列。

性質：同一份內容再整理一次，結果不變。

| # | 輸入 `p_content` | 輸出 |
|---|---|---|
| 1 | `{"contract_name": "　北區  經銷合約 ", "counterparty": "大昌通路股份有限公司", "amount": 850000}` | `{"content": {"contract_name": "北區 經銷合約", "counterparty": "大昌通路股份有限公司", "amount": 850000}, "notices": []}` |
| 2 | `{"contract_name": "A", "description": "  \n ", "copies": null}` | `{"content": {"contract_name": "A"}, "notices": []}` |
| 3 | `{"description": " 第一行\n第二行 ", "contract_name": 123}` | `{"content": {"description": "第一行\n第二行", "contract_name": 123}, "notices": []}` |
| 4（邊界） | SQL null | `{"content": null, "notices": []}` |
| 5（邊界） | `[]` | `{"content": [], "notices": []}` |

### 5.2 `validate_content`

```sql
pack_seal.validate_content(p_actor bigint, p_content jsonb) returns jsonb  -- stable
```

只檢查表單定義檢查不到的一件事（規則 `SEAL-TYPE-OTHER`）。`p_actor` 不使用。步驟：

1. `p_content` 不是 JSON 物件：回傳 `[]`。
2. 用 `p_content ->> 'contract_type'` 查 `pack_seal.contract_type`。查不到，或 `requires_description` 是 false：回傳 `[]`。
3. `p_content` 沒有 `description`，或它不是字串，或去掉前後空白後是空字串：回傳一筆錯誤（訊息取自錯誤代碼表，見第 7.3 節）。
4. 其他情況回傳 `[]`。

| # | 輸入 | 輸出 |
|---|---|---|
| 1 | 範例 A 把 `contract_type` 改成 `other`，沒有 `description` | `[{"path": "description", "code": "seal_description_required_for_other", "message": "合約類型選「其他」時，請在「說明」寫明這是哪一種合約"}]` |
| 2 | 同上，加上 `"description": "合作備忘錄"` | `[]` |
| 3 | 範例 A（`contract_type` 是 `procurement`，沒有 `description`） | `[]` |
| 4（邊界） | `{}`（草稿，還沒選合約類型） | `[]` |
| 5（邊界） | `{"contract_type": "other", "description": "   "}`（沒有先整理過） | 和 #1 相同 |

### 5.3 `classify_tier`

```sql
pack_seal.classify_tier(p_content jsonb) returns text  -- stable
```

規則 `SEAL-TIER`。步驟：

1. `v_forces_major`：用 `p_content ->> 'seal_kind'` 查 `pack_seal.seal_kind.forces_major`；查不到是 null。
2. `v_amount`：`p_content -> 'amount'` 的 JSON 型別是 `number` 時取它的數值；否則是 null。
3. `v_forces_major` 或 `v_amount` 是 null：回傳 `major`。內容不完整時無法判定，走較嚴的路徑。
4. `v_forces_major` 是 true：回傳 `major`。
5. `v_amount >= pack_seal.major_amount_threshold()`：回傳 `major`。
6. 其他：回傳 `standard`。

「低於門檻」是嚴格小於；金額等於門檻屬於重大。

| # | 門檻 | `amount` | `seal_kind` | 回傳 |
|---|---|---|---|---|
| 1 | 1,000,000 | 999,999 | `contract_seal` | `standard` |
| 2（邊界） | 1,000,000 | 1,000,000 | `contract_seal` | `major` |
| 3 | 1,000,000 | 0 | `company_seal` | `major` |
| 4（邊界） | 1,000,000 | 0 | `contract_seal` | `standard` |
| 5 | 500,000 | 600,000 | `contract_seal` | `major` |
| 6（邊界） | 1,000,000 | 沒有這個 key | `contract_seal` | `major` |
| 7（邊界） | 1,000,000 | 100 | `unknown_seal` | `major` |
| 8（邊界） | 0 | 0 | `contract_seal` | `major` |

門檻變更的影響：已經判定的申請單不會因為參數變更而改變級別；之後產生新版本時用當時的門檻重新判定（D-16）。判定當下的門檻值由核心記進稽核事件的參數快照（對核心的需求 N-11）。

### 5.4 `compare_content`

```sql
pack_seal.compare_content(p_old jsonb, p_new jsonb) returns text  -- immutable
```

規則 `SEAL-CHANGE`。只有「金額調降」和「份數減少」是縮小；任何其他差異都是擴大。步驟（依序，符合就回傳）：

1. `p_old` 或 `p_new` 不是 JSON 物件：`expand`。
2. `p_old = p_new`（jsonb 相等）：`same`。
3. 把兩邊都拿掉 `amount`、`copies`、`contract_files` 三個 key 後比較，不相等：`expand`。這一步涵蓋合約名稱、對象、類型、印鑑種類、說明，以及任何不認得的 key。
4. `pack_seal.file_hashes(p_old)` 和 `pack_seal.file_hashes(p_new)` 不相等，或任一邊含有 null：`expand`。
5. 兩邊的 `amount`、`copies` 四個值，只要有一個的 JSON 型別不是 `number`：`expand`。
6. 新的 `amount` 大於舊的，或新的 `copies` 大於舊的：`expand`。
7. `amount` 與 `copies` 都相等：`same`（只有檔案的檔名或附件編號不同，雜湊相同）。
8. 其他（兩者都沒有增加，至少一個減少）：`reduce`。

以範例 A 為 `p_old`（金額 1,200,000、3 份、檔案 `h1`）：

| # | `p_new` 相對範例 A 的差異 | 回傳 | 命中步驟 |
|---|---|---|---|
| 1 | 沒有差異 | `same` | 2 |
| 2 | `amount` 改成 900000 | `reduce` | 8 |
| 3 | `copies` 改成 2 | `reduce` | 8 |
| 4 | `amount` 改成 900000、`copies` 改成 2 | `reduce` | 8 |
| 5 | `amount` 改成 900000、`copies` 改成 4 | `expand` | 6 |
| 6 | `amount` 改成 1200001 | `expand` | 6 |
| 7 | 檔案換成 `h2` | `expand` | 4 |
| 8 | 多加一個檔案 `h2` | `expand` | 4 |
| 9 | `counterparty` 改成其他公司 | `expand` | 3 |
| 10 | `contract_type` 改成 `sales` | `expand` | 3 |
| 11 | `seal_kind` 改成 `company_seal` | `expand` | 3 |
| 12 | 加上 `description` | `expand` | 3 |
| 13 | `amount` 改成 900000，同時 `contract_name` 改一個字 | `expand` | 3 |
| 14（邊界） | 同一個檔案（`h1`）改了檔名、附件編號不同 | `same` | 7 |
| 15（邊界） | `amount` 改成 0 | `reduce` | 8 |
| 16（邊界） | 多了一個不認得的 key `"x": 1` | `expand` | 3 |
| 17（邊界） | `p_new` 是 SQL null | `expand` | 1 |
| 18（邊界） | `amount` 改成字串 `"900000"` | `expand` | 5 |

### 5.5 `diff_content`

```sql
pack_seal.diff_content(p_old jsonb, p_new jsonb) returns jsonb  -- stable
```

給人看的差異。分類和 `compare_content` 一致（下面的「一致性」）。任一邊不是 JSON 物件時當成空物件 `{}`。

依下列固定順序檢查，每個有差異的項目輸出一筆：

| 順序 | 項目 | `label` | 顯示值 |
|---|---|---|---|
| 1 | `contract_name` | 合約名稱 | 原文 |
| 2 | `counterparty` | 合約對象 | 原文 |
| 3 | `contract_type` | 合約類型 | `contract_type_name()` |
| 4 | `amount` | 合約金額 | `format_amount()` |
| 5 | `seal_kind` | 印鑑種類 | `seal_kind_name()` |
| 6 | `copies` | 用印份數 | `<n> 份` |
| 7 | `description` | 說明 | 原文，超過 80 字取前 80 字加 `…` |
| 8 | `contract_files` | 合約檔案 | 檔名 |
| 9 | 其他不認得的 key（依 key 排序） | 其他欄位 | key 的名稱 |

每筆的 `kind` 與 `detail`：

| 項目 | 情況 | `kind` | `detail` |
|---|---|---|---|
| 1、2、3、5、7 | 舊的沒有、新的有 | `added` | 新的顯示值 |
| 1、2、3、5、7 | 舊的有、新的沒有 | `removed` | 舊的顯示值 |
| 1、2、3、5、7 | 兩邊都有且不同 | `expanded` | `<舊的顯示值> → <新的顯示值>` |
| 4、6 | 兩邊都是數字，新的較小 | `reduced` | `<舊的顯示值> → <新的顯示值>` |
| 4、6 | 兩邊都是數字，新的較大 | `expanded` | 同上 |
| 4、6 | 任一邊不是數字且兩邊不同 | `expanded` | `<舊值的 JSON 文字，沒有則「（未填）」> → <新值，同樣規則>` |
| 8 | 雜湊只出現在新的 | `added` | 檔名；每個檔案一筆，依檔名排序 |
| 8 | 雜湊只出現在舊的 | `removed` | 檔名；每個檔案一筆，依檔名排序 |
| 8 | 元素沒有 `sha256` | 新的那邊列 `added`、舊的那邊列 `removed` | 檔名 |
| 9 | 該 key 的值兩邊不同 | `expanded` | key 的名稱 |

沒有任何一筆時，回傳 `[{"kind": "same", "label": "申請內容", "detail": "與前一版相同"}]`。

一致性（測試 `SEAL-CHANGE diff_agrees_with_compare` 對第 5.4 節的 18 組輸入逐一檢查）：

- `compare_content` 回傳 `same` ⟺ `diff_content` 只有一筆 `same`。
- `compare_content` 回傳 `reduce` ⟺ `diff_content` 至少一筆，而且每一筆都是 `reduced`。
- `compare_content` 回傳 `expand` ⟺ `diff_content` 至少有一筆 `added`、`removed` 或 `expanded`。

以範例 A 為 `p_old`：

| # | `p_new` 相對範例 A 的差異 | 輸出 |
|---|---|---|
| 1 | `amount` 改成 900000 | `[{"kind": "reduced", "label": "合約金額", "detail": "NT$ 1,200,000 → NT$ 900,000"}]` |
| 2 | `copies` 改成 4，檔案 `equipment_purchase_2027.pdf`（`h1`）換成 `equipment_purchase_2027_v2.pdf`（`h2`） | `[{"kind": "expanded", "label": "用印份數", "detail": "3 份 → 4 份"}, {"kind": "added", "label": "合約檔案", "detail": "equipment_purchase_2027_v2.pdf"}, {"kind": "removed", "label": "合約檔案", "detail": "equipment_purchase_2027.pdf"}]` |
| 3 | `seal_kind` 改成 `company_seal`，加上 `description`「對方要求蓋大章」 | `[{"kind": "expanded", "label": "印鑑種類", "detail": "合約專用章 → 公司大章"}, {"kind": "added", "label": "說明", "detail": "對方要求蓋大章"}]` |
| 4（邊界） | 沒有差異 | `[{"kind": "same", "label": "申請內容", "detail": "與前一版相同"}]` |
| 5（邊界） | 同一個檔案改了檔名（雜湊相同） | 和 #4 相同 |
| 6（邊界） | `p_old` 是 SQL null，`p_new` 是 `{"copies": 1}` | `[{"kind": "expanded", "label": "用印份數", "detail": "（未填） → 1"}]` |

### 5.6 `summarize_content`

```sql
pack_seal.summarize_content(p_content jsonb) returns jsonb  -- stable
```

清單與簽核畫面第一眼看到的事實。`p_content` 不是 JSON 物件時當成 `{}`。

| 輸出 | 內容 | 缺值時 |
|---|---|---|
| `title` | `contract_name` | `（未填合約名稱）` |
| `subtitle` | `<counterparty>・<contract_type_name()>` | 對象缺：`（未填合約對象）`；類型缺：省略「・」和類型 |
| `facts[0]` | 合約金額：`format_amount()`；`emphasis`＝金額是數字且大於等於門檻 | `（未填）`，`emphasis` false |
| `facts[1]` | 印鑑種類：`seal_kind_name()`；`emphasis`＝該種類的 `forces_major` | `（未填）`，`emphasis` false |
| `facts[2]` | 用印份數：`<n> 份`；`emphasis` false | `（未填）` |
| `facts[3]` | 合約檔案：`<檔案數> 份`；`emphasis` false | `0 份` |

`emphasis` 標出的正是讓這張單成為重大級別的原因。摘要涵蓋表單定義裡全部六個摘要欄位（測試 `SEAL-FORM summary_covers_summary_fields`）。

| # | 輸入 | 輸出 |
|---|---|---|
| 1 | 範例 A | `{"title": "年度設備採購合約", "subtitle": "宏遠科技股份有限公司・採購", "facts": [{"label": "合約金額", "value": "NT$ 1,200,000", "emphasis": true}, {"label": "印鑑種類", "value": "合約專用章", "emphasis": false}, {"label": "用印份數", "value": "3 份", "emphasis": false}, {"label": "合約檔案", "value": "1 份", "emphasis": false}]}` |
| 2 | `{"contract_name": "客戶資料保密協議", "counterparty": "遠見數位行銷有限公司", "contract_type": "nda", "amount": 0, "seal_kind": "company_seal", "copies": 2, "contract_files": [{"sha256": "h3", "file_name": "nda.pdf"}]}` | `{"title": "客戶資料保密協議", "subtitle": "遠見數位行銷有限公司・保密", "facts": [{"label": "合約金額", "value": "NT$ 0（無金額）", "emphasis": false}, {"label": "印鑑種類", "value": "公司大章", "emphasis": true}, {"label": "用印份數", "value": "2 份", "emphasis": false}, {"label": "合約檔案", "value": "1 份", "emphasis": false}]}` |
| 3（邊界） | `{}` | `{"title": "（未填合約名稱）", "subtitle": "（未填合約對象）", "facts": [{"label": "合約金額", "value": "（未填）", "emphasis": false}, {"label": "印鑑種類", "value": "（未填）", "emphasis": false}, {"label": "用印份數", "value": "（未填）", "emphasis": false}, {"label": "合約檔案", "value": "0 份", "emphasis": false}]}` |
| 4（邊界） | 範例 A 把 `amount` 改成 1000000 | 合約金額那一筆是 `{"label": "合約金額", "value": "NT$ 1,000,000", "emphasis": true}` |

### 5.7 `find_overlaps`

```sql
pack_seal.find_overlaps(p_case_id bigint, p_content jsonb) returns jsonb  -- stable
```

規則 `SEAL-OVERLAP`：同一申請人、同一合約名稱與對象，已有進行中或已完成的申請時回傳 `partial`。這個流程永遠不回傳 `covered`。步驟：

1. 從 `pack_seal.seal_case` 取 `case_id = p_case_id` 的 `applicant_id`。`p_case_id` 是 null 或查不到（包含不是這個流程類型的申請單）：丟出錯誤 `seal_case_required`。
2. `v_name := pack_seal.match_key(p_content ->> 'contract_name')`、`v_party := pack_seal.match_key(p_content ->> 'counterparty')`。任一個是空字串：回傳 `{"level": "none", "items": []}`（草稿還沒填完時無從比對；送審時這兩欄必填，不會走到這裡）。
3. 從 `pack_seal.seal_case` 找出符合全部條件的其他申請單，依 `case_id` 由大到小排序，不限筆數：
   - `applicant_id` 相同；
   - `case_id <> p_case_id`；
   - `status` 不是 `draft` 也不是 `cancelled`；
   - 目前版本內容的 `match_key(contract_name) = v_name` 且 `match_key(counterparty) = v_party`。
4. 沒有找到：回傳 `{"level": "none", "items": []}`。
5. 有找到：回傳 `{"level": "partial", "items": [...]}`，每筆的 `detail`：
   - `sealed_at` 有值：`已用印 <actual_copies> 份（<印鑑種類名稱>）`；
   - 否則：`申請用印 <copies> 份（<印鑑種類名稱>），尚未用印`。

說明：

- 步驟 3 的狀態條件採排除法：除了草稿和已取消以外都算。「進行中」是 `in_approval`、`returned`、`pending_fulfilment`、`verifying`；「已完成」是 `completed`。
- 比對用的是另一張單的「目前版本」內容。
- 只比對申請人本人的申請單；不同申請人送出同一份合約不會被找到（附錄 A-6）。
- 回傳 `partial` 之後，「必須填原因才能送審」由核心執行（`K-OVERLAP-REASON`），原因存在核心的 `case_overlap`，不屬於申請內容，所以填寫或修改原因不會被 `compare_content` 當成內容變更。

範例。資料：林怡君（申請人編號以 `p04` 表示）有四張用印申請，內容的合約名稱都是「北區經銷合約」、對象都是「大昌通路股份有限公司」、印鑑都是合約專用章：

| `case_id` | 單號 | 狀態 | 份數 | 用印結果 |
|---|---|---|---|---|
| 101 | `S-0101` | `completed` | 2 | 已用印 2 份 |
| 102 | `S-0102` | `cancelled` | 2 | — |
| 103 | `S-0103` | `in_approval` | 1 | — |
| 104 | `S-0104` | `draft` | 1 | — |

另外王志明有一張 `case_id` 105、內容相同、狀態 `in_approval` 的申請。

| # | 呼叫 | 回傳 |
|---|---|---|
| 1 | `p_case_id = 104`，內容的名稱是 `北區 經銷合約`、對象是 `大昌通路股份有限公司` | `{"level": "partial", "items": [{"case_id": 103, "case_no": "S-0103", "detail": "申請用印 1 份（合約專用章），尚未用印"}, {"case_id": 101, "case_no": "S-0101", "detail": "已用印 2 份（合約專用章）"}]}` |
| 2 | `p_case_id = 104`，名稱改成 `北區經銷合約增補協議` | `{"level": "none", "items": []}` |
| 3 | `p_case_id = 105`（王志明），內容相同 | `{"level": "none", "items": []}`（申請人不同） |
| 4（邊界） | `p_case_id = 103`，內容不變 | `{"level": "partial", "items": [{"case_id": 101, "case_no": "S-0101", "detail": "已用印 2 份（合約專用章）"}]}`（不含自己、草稿、已取消） |
| 5（邊界） | `p_case_id = 104`，內容是 `{}` | `{"level": "none", "items": []}` |
| 6（邊界） | `p_case_id` 是 null，或 999999（不存在） | 錯誤 `seal_case_required` |

### 5.8 `build_fulfilment`

```sql
pack_seal.build_fulfilment(p_case_id bigint) returns jsonb  -- stable
```

規則 `SEAL-FULFIL`。產生交給印鑑管理人的執行內容，格式見第 8.1 節。步驟：

1. 從 `pack_seal.seal_case` 取 `case_id = p_case_id` 的 `content`。查不到：丟出錯誤 `seal_case_required`。
2. 依第 8.1 節組出結果。`result_schema` 裡 `actual_copies` 的 `max` 是 `content ->> 'copies'` 的整數值。

| # | 申請單目前版本的內容 | 回傳 |
|---|---|---|
| 1 | 範例 A | 第 8.1 節的完整範例 |
| 2 | 範例 A 把 `copies` 改成 1、`seal_kind` 改成 `company_seal` | 和 #1 相同，但「印鑑種類」是 `公司大章`、「核准份數」是 `1 份`、`actual_copies` 的 `max` 是 1 |
| 3（邊界） | 內容有兩個合約檔案（`h1`、`h2`） | `attachments` 有兩筆，順序和內容裡的順序相同 |
| 4（邊界） | `p_case_id` 是 null 或不存在 | 錯誤 `seal_case_required` |

### 5.9 使用核心預設行為的 hook

| hook | 不登記的原因 | 核心的預設行為 |
|---|---|---|
| `stage_scopes` | 沒有任何關卡使用 `scoped_role` | 無 |
| `automated_checks` | rules.md 沒有定義自動檢查；簽核人需要的事實已在摘要、重疊警示與人工檢查清單 | 空陣列 |
| `build_verification_cases` | `requires_verification` 是 false | 空陣列 |
| `on_grant_event` | `has_validity` 是 false，不產生授權；流程包沒有需要同步的資料表 | 不做事 |

## 6. 專屬的對外 function

這個流程包沒有任何 `api.seal_*` function，路由表也沒有它的專屬路由。原因：

- 申請、簽核、執行、確認、查詢全部走核心的通用 function 與通用畫面。
- 代碼表的選項已經包含在表單定義裡，前端不需要另外查詢。
- 用印紀錄的查詢與匯出用核心的稽核查詢（流程類型篩選「合約用印」），執行結果（實際用印份數）保存在核心的執行紀錄與稽核事件裡。

如果日後需要專屬的查詢（例如依印鑑種類統計的用印登記簿），再以 `api.seal_` 為前綴新增，並依工程規範補上 `COMMENT`、路由與測試。第一版不做。

## 7. 參數、規則代碼、錯誤代碼、通知範本

### 7.1 參數

流程包定義的參數：

| key | 意義 | 型別 | 單位 | 預設值 | 允許範圍 | 可設定的適用範圍 | 所屬流程包 |
|---|---|---|---|---|---|---|---|
| `seal.major_amount_threshold` | 合約金額大於等於這個值就是重大合約 | 整數 | 新台幣元 | 1000000 | 0 到 999999999999 | 只有全域 | `seal` |

門檻只能設全域值：它用來決定級別，所以不能依級別設定；它只有這個流程使用，所以不需要依流程類型設定。設為 0 時所有合約都是重大。

使用的核心參數：

| key | 這個流程的值 | 做法 |
|---|---|---|
| `approval.remind_after_workdays` | 3（核心預設） | 不設定流程包自己的值 |
| `approval.escalate_after_workdays` | 2（核心預設） | 不設定流程包自己的值 |
| `approval.mobile_mfa_required` | true（核心預設） | 不設定 |
| `confirmation.due_workdays` | 5 | migration 登記一筆流程類型範圍的初始值：`scope_kind = process`、`scope_ref = seal`、值 5、原因「合約用印流程包初始值（rules.md：領回確認時限）」。rules.md 明訂 5 個工作天，所以釘住，不隨核心預設變動 |

不使用的核心參數：`validity.max_months`、`validity.remind_before_days`、`grant.owner_grace_days`。

### 7.2 規則代碼

登記到 `sgn.rule`，來源文件都是 `docs/packs/seal/rules.md`，所屬流程包 `seal`。核心規則（`K-*`）不在這裡重複定義；和 rules.md 逐條的對應見第 9 節。

| 代碼 | 說明 | rules.md 的段落 |
|---|---|---|
| `SEAL-FORM` | 申請內容的八個欄位與各自的限制 | 申請內容 |
| `SEAL-TYPE-OTHER` | 合約類型是「其他」時必須填寫說明 | 申請內容 |
| `SEAL-TIER` | 金額達到門檻或印鑑種類是公司大章為重大，否則為一般；門檻是參數 | 級別、參數 |
| `SEAL-PATH` | 一般：主管 → 法務；重大：主管 → 法務 → 財務長；法務群組認領、財務長單一持有人 | 簽核路徑 |
| `SEAL-CHANGE` | 金額調降、份數減少是縮小；其他修改一律是擴大 | 修改 |
| `SEAL-OVERLAP` | 同一申請人、同一合約名稱與對象已有進行中或已完成的申請時，視為部分重疊 | 不需要的核心能力：重複檢查 |
| `SEAL-FULFIL` | 核准後由印鑑管理人認領用印，填寫實際用印份數（1 到核准份數）後標記完成 | 用途、簽核路徑、不需要的核心能力：執行 |
| `SEAL-CONFIRM` | 申請人在 5 個工作天內確認領回；逾期只催辦、不撤銷 | 不需要的核心能力：申請人確認；參數 |
| `SEAL-CANCEL` | 用印前可以取消；用印後不可取消、不可撤銷 | 不需要的核心能力：撤銷 |
| `SEAL-OPTIONS` | 不使用有效期間、續期、被授權者、自動驗證 | 不需要的核心能力 |

### 7.3 錯誤代碼

登記到 `sgn.error_catalog`。SQLSTATE 依 `01-kernel.md` 的配號規則；這裡先用流程包類別 `SL` 加 HTTP 狀態。

| 代碼 | SQLSTATE | HTTP | 訊息 | 何時出現 |
|---|---|---|---|---|
| `seal_description_required_for_other` | `SL422` | 422 | 合約類型選「其他」時，請在「說明」寫明這是哪一種合約 | `validate_content` 回傳（不是丟出）；核心擋下送審 |
| `seal_case_required` | `SL500` | 500 | 系統處理這張用印申請時發生問題，請聯絡系統管理員 | `find_overlaps`、`build_fulfilment` 收到 null、不存在或不屬於這個流程的申請單；代表核心的呼叫違反 D-10 |

`validate_content` 回傳的 `message` 從錯誤代碼表讀取，不在 function 裡另外寫一份。

完成回報不符合 `result_schema`（例如實際份數超過核准份數）時的錯誤，由核心的通用表單檢查產生，沒有流程包自己的代碼。

### 7.4 通知範本

只覆寫三個通用文字會讓人誤會的事件；其他事件（指派、催辦、升級、退回、縮小通知、取消）用核心的預設範本。事件代碼與變數依賴 D-13。

| 事件 | 收件人（核心決定） | 主旨 | 內文 | 連結 |
|---|---|---|---|---|
| `fulfilment_ready` | 印鑑管理人群組 | `[用印] {{case_no}} {{title}} 已核准，請認領` | `{{applicant_name}} 申請的「{{title}}」已經核准，請認領後用印。用印時請核對紙本和核准的合約檔案一致，份數不要超過核准份數。` | `{{fulfilment_url}}` |
| `fulfilment_completed` | 申請人 | `[已用印] {{case_no}} {{title}}，請領回並確認` | `「{{title}}」已經用印完成。請向印鑑管理人領回文件，並在 {{due_date}} 前到申請單按「我已領回用印完成的文件」。` | `{{case_url}}` |
| `confirmation_reminder` | 申請人 | `[催辦] {{case_no}} {{title}} 尚未確認領回` | `「{{title}}」已經用印，但你還沒有確認領回。文件已經用印，這張申請不會被撤銷；確認之前會持續提醒。` | `{{case_url}}` |

## 8. 執行、驗證與取消

### 8.1 執行內容的格式

`build_fulfilment` 回傳通用的人工執行格式（D-9）。核心在建立執行紀錄時保存這份內容，通用的執行詳情畫面直接依它顯示，不需要流程包的前端元件。

| key | 型別 | 內容 |
|---|---|---|
| `format` | 字串 | 固定 `manual_task` |
| `title` | 字串 | `用印：<contract_name>` |
| `facts` | 陣列 | 四筆，依序為合約對象、印鑑種類、核准份數、合約金額；格式和 `summarize_content` 的 `facts` 相同。印鑑種類與核准份數的 `emphasis` 是 true，其餘 false |
| `attachments` | 陣列 | 核准版本的合約檔案，每筆 `{"attachment_id", "file_name", "sha256"}`，順序和內容相同 |
| `result_schema` | 物件 | 完成回報的欄位定義，屬性和表單定義相同 |

`result_schema` 只有一個欄位：

| key | 型別 | 名稱 | 必填 | 限制 |
|---|---|---|---|---|
| `actual_copies` | `integer` | 實際用印份數 | 是 | 最小 1，最大＝核准份數 |

實際用印份數不得超過核准份數：超過就代表執行的內容和核准的內容不同。可以少於核准份數；原因寫在核心通用的完成說明。

範例 A 的回傳：

```json
{
  "format": "manual_task",
  "title": "用印：年度設備採購合約",
  "facts": [
    {"label": "合約對象", "value": "宏遠科技股份有限公司", "emphasis": false},
    {"label": "印鑑種類", "value": "合約專用章", "emphasis": true},
    {"label": "核准份數", "value": "3 份", "emphasis": true},
    {"label": "合約金額", "value": "NT$ 1,200,000", "emphasis": false}
  ],
  "attachments": [
    {"attachment_id": 501, "file_name": "equipment_purchase_2027.pdf", "sha256": "h1"}
  ],
  "result_schema": {
    "fields": [
      {
        "key": "actual_copies",
        "type": "integer",
        "label": "實際用印份數",
        "required": true,
        "min": 1,
        "max": 3
      }
    ]
  }
}
```

完成回報的範例（由核心保存在執行紀錄，並寫進稽核事件的變更內容）：

```json
{"actual_copies": 3}
```

### 8.2 交付方式與流程

交付方式是人工（`manual`）：沒有外部系統，沒有 adapter，沒有請求與回報的介面。

| 步驟 | 誰 | 動作 | 狀態 | 規則 |
|---|---|---|---|---|
| 1 | 核心 | 最後一個簽核關核准後，呼叫 `build_fulfilment` 建立執行紀錄，開啟 `sealing` 關，通知印鑑管理人群組 | `pending_fulfilment` | `K-FULFIL` |
| 2 | 印鑑管理人 | 在執行佇列認領。申請人本人、在這張單簽過的人不能認領 | `pending_fulfilment` | `K-CLAIM`、`K-SOD-APPLICANT` |
| 3 | 印鑑管理人 | 核對檢查清單、用印、填實際用印份數、標記完成 | `verifying` | `SEAL-FULFIL`、`K-FULFIL` |
| 4 | 核心 | 通知申請人領回；確認期限＝完成時間加 `confirmation.due_workdays`（5 個工作天） | `verifying` | `SEAL-CONFIRM` |
| 5 | 申請人 | 確認已領回 | `completed` | `K-CONFIRM` |
| 5′ | 核心 | 超過期限沒有確認：寄催辦、寫稽核事件，狀態不變，不撤銷 | `verifying` | `K-CONFIRM`、`SEAL-CONFIRM` |

印鑑管理人認領後逾時：依 `sealing` 關的時限參數先催辦，再升級給認領人的直屬主管；升級後原認領人不能再標記完成（`K-SLA-REMIND`、`K-SLA-ESCALATE`）。

### 8.3 驗證

不使用自動驗證：`requires_verification` 是 false，沒有登記 `build_verification_cases`，不產生驗證案例，也沒有驗證用的 adapter。狀態 `verifying` 在這個流程只代表「等申請人確認領回」。

### 8.4 取消與撤銷

| 時點 | 狀態 | 可以做什麼 | 規則 |
|---|---|---|---|
| 用印前 | `draft`、`in_approval`、`returned`、`pending_fulfilment` | 申請人、任一位簽核人可以取消，必須填原因（「簽核人」的範圍依核心對 `K-REVOKE` 的定義） | `SEAL-CANCEL`、`K-REVOKE` |
| 用印後 | `verifying`、`completed` | 取消與撤銷一律拒絕 | `SEAL-CANCEL`（選項 `revocable_after_fulfilment = false`，D-14） |

「用印」的時點以印鑑管理人標記完成為準。印鑑管理人已經認領但還沒標記完成時，申請單仍然可以取消；所以檢查清單與通知都要求用印後立刻標記完成。

## 9. 規則對照表

rules.md 的每一段、每一列、每個預設值各一列。「實作」欄寫明由核心或流程包的哪一部分負責。測試名稱的格式是「規則代碼＋空白＋說明」，全部在 `db/tests/packs/seal/`。

| # | rules.md 的內容 | 規則代碼 | 實作 | 測試 |
|---|---|---|---|---|
| 1 | 用途：核准後由印鑑管理人用印 | `SEAL-FULFIL`、`K-FULFIL` | 核心的執行流程；`sealing` 關；`build_fulfilment` | `SEAL-FULFIL keeper_claims_and_completes` |
| 2 | 用途：留下完整紀錄 | `K-AUDIT-APPEND`、`K-AUDIT-CHAIN` | 核心 | `SEAL-FULFIL completion_is_audited_with_actual_copies` |
| 3 | 欄位：合約名稱，文字 | `SEAL-FORM` | 表單定義 `contract_name` | `SEAL-FORM contract_name_required_text` |
| 4 | 欄位：合約對象，文字 | `SEAL-FORM` | 表單定義 `counterparty` | `SEAL-FORM counterparty_required_text` |
| 5 | 欄位：合約類型，下拉五個選項 | `SEAL-FORM` | 表單定義 `contract_type`；代碼表 `contract_type` | `SEAL-FORM contract_type_has_five_options` |
| 6 | 欄位：合約類型選「其他」需說明 | `SEAL-TYPE-OTHER` | `validate_content` | `SEAL-TYPE-OTHER other_requires_description`、`SEAL-TYPE-OTHER other_types_do_not_require_description` |
| 7 | 欄位：合約金額，新台幣整數 | `SEAL-FORM` | 表單定義 `amount` | `SEAL-FORM amount_is_twd_integer`、`SEAL-FORM amount_negative_rejected` |
| 8 | 欄位：無金額的合約填 0 | `SEAL-FORM` | 表單定義 `amount` 的 `min = 0` | `SEAL-FORM amount_zero_allowed` |
| 9 | 欄位：印鑑種類，下拉兩個選項 | `SEAL-FORM` | 表單定義 `seal_kind`；代碼表 `seal_kind` | `SEAL-FORM seal_kind_has_two_options` |
| 10 | 欄位：用印份數，正整數 | `SEAL-FORM` | 表單定義 `copies` 的 `min = 1` | `SEAL-FORM copies_is_positive_integer` |
| 11 | 欄位：說明，文字 | `SEAL-FORM` | 表單定義 `description` | `SEAL-FORM description_is_optional_text` |
| 12 | 欄位：合約檔案，附件，至少一份 | `SEAL-FORM` | 表單定義 `contract_files` 的 `min_items = 1` | `SEAL-FORM contract_files_at_least_one` |
| 13 | 級別：一般＝金額低於門檻且印鑑是合約專用章 | `SEAL-TIER` | `classify_tier` | `SEAL-TIER below_threshold_with_contract_seal_is_standard` |
| 14 | 級別：重大＝金額達到門檻 | `SEAL-TIER` | `classify_tier` | `SEAL-TIER amount_at_threshold_is_major`、`SEAL-TIER amount_above_threshold_is_major` |
| 15 | 級別：重大＝印鑑是公司大章 | `SEAL-TIER` | `classify_tier`；代碼表 `seal_kind.forces_major` | `SEAL-TIER company_seal_is_major_at_any_amount` |
| 16 | 級別：門檻是參數 | `SEAL-TIER`、`K-SETTING-ADMIN` | `major_amount_threshold()`；核心的參數 | `SEAL-TIER threshold_is_read_from_setting`、`SEAL-TIER threshold_change_affects_new_versions_only` |
| 17 | 級別：門檻預設新台幣 100 萬元 | `SEAL-TIER` | 參數定義 `seal.major_amount_threshold` 的預設值 | `SEAL-TIER threshold_default_is_1000000` |
| 18 | 路徑：一般＝申請人主管 → 法務 | `SEAL-PATH` | 路徑資料 `manager`、`legal` | `SEAL-PATH standard_is_manager_then_legal` |
| 19 | 路徑：重大＝申請人主管 → 法務 → 財務長 | `SEAL-PATH` | 路徑資料 `cfo` 的適用條件 | `SEAL-PATH major_adds_cfo_after_legal` |
| 20 | 路徑：法務是角色群組，一人認領 | `SEAL-PATH`、`K-CLAIM` | `legal` 關的 resolver `role_group_claim`；核心 | `SEAL-PATH legal_is_claimed_by_one_member` |
| 21 | 路徑：財務長指定一人 | `SEAL-PATH` | `cfo` 關的 resolver `role_holder` | `SEAL-PATH cfo_is_single_holder` |
| 22 | 路徑：財務長可設代理人 | `K-DELEGATE` | 核心 | `SEAL-PATH cfo_delegate_signs_on_behalf` |
| 23 | 路徑：核准後由印鑑管理人（角色群組，一人認領）用印 | `SEAL-FULFIL`、`K-CLAIM` | `sealing` 關的 resolver `role_group_claim` | `SEAL-FULFIL sealing_is_claimed_by_one_keeper` |
| 24 | 路徑：用印後標記完成 | `SEAL-FULFIL`、`K-FULFIL` | 核心的執行流程 | `SEAL-FULFIL completion_moves_case_to_verifying` |
| 25 | 沿用核心：職責分離 | `K-SOD-APPLICANT`、`K-SOD-DISTINCT` | 核心 | `SEAL-PATH cfo_who_is_applicant_manager_is_replaced`、`SEAL-FULFIL applicant_cannot_seal_own_case` |
| 26 | 沿用核心：代理 | `K-DELEGATE` | 核心 | `SEAL-PATH cfo_delegate_signs_on_behalf` |
| 27 | 沿用核心：催辦 | `K-SLA-REMIND` | 核心；各關的時限參數 | `SEAL-PATH stages_use_kernel_remind_setting`、`SEAL-FULFIL overdue_keeper_is_reminded` |
| 28 | 沿用核心：升級 | `K-SLA-ESCALATE` | 核心；各關的時限參數 | `SEAL-PATH stages_use_kernel_escalate_setting`、`SEAL-FULFIL overdue_keeper_is_escalated_to_manager` |
| 29 | 沿用核心：退回 | `K-RETURN` | 核心；`compare_content` | `SEAL-CHANGE returned_then_reduce_resumes_at_returning_stage`、`SEAL-CHANGE returned_then_expand_restarts_from_first_stage` |
| 30 | 沿用核心：手機核准 | `K-MOBILE-MFA` | 核心 | `SEAL-PATH mobile_approval_requires_mfa` |
| 31 | 修改：金額調降是縮小 | `SEAL-CHANGE`、`K-CHANGE-REDUCE` | `compare_content`；表單定義 `amount.reducible` | `SEAL-CHANGE amount_decrease_is_reduce`、`SEAL-CHANGE approver_reduces_amount_without_resigning` |
| 32 | 修改：份數減少是縮小 | `SEAL-CHANGE`、`K-CHANGE-REDUCE` | `compare_content`；表單定義 `copies.reducible` | `SEAL-CHANGE copies_decrease_is_reduce` |
| 33 | 修改：其他修改一律是擴大 | `SEAL-CHANGE`、`K-CHANGE-EXPAND` | `compare_content` 步驟 3、6 | `SEAL-CHANGE increase_is_expand`、`SEAL-CHANGE reduce_mixed_with_other_change_is_expand`、`SEAL-CHANGE name_or_description_change_is_expand`、`SEAL-CHANGE identical_content_is_same` |
| 34 | 修改：更換合約檔案是擴大 | `SEAL-CHANGE` | `compare_content` 步驟 4 | `SEAL-CHANGE file_change_is_expand` |
| 35 | 修改：更換合約對象是擴大 | `SEAL-CHANGE` | `compare_content` 步驟 3 | `SEAL-CHANGE counterparty_change_is_expand` |
| 36 | 修改：更換合約類型是擴大 | `SEAL-CHANGE` | `compare_content` 步驟 3 | `SEAL-CHANGE contract_type_change_is_expand` |
| 37 | 修改：更換印鑑種類是擴大 | `SEAL-CHANGE` | `compare_content` 步驟 3 | `SEAL-CHANGE seal_kind_change_is_expand` |
| 38 | 不使用：有效期間、到期、續期 | `SEAL-OPTIONS` | 選項 `has_validity`、`renewable`、`batch_renewal` 都是 false | `SEAL-OPTIONS no_validity_no_renewal` |
| 39 | 不使用：被授權者與負責人 | `SEAL-OPTIONS` | 選項 `uses_principal` 是 false | `SEAL-OPTIONS no_principal` |
| 40 | 使用：重複檢查（同一申請人、同一合約名稱與對象、進行中或已完成） | `SEAL-OVERLAP` | 選項 `overlap_check`；`find_overlaps` | `SEAL-OVERLAP in_progress_case_is_partial`、`SEAL-OVERLAP completed_case_is_partial`、`SEAL-OVERLAP draft_and_cancelled_are_ignored`、`SEAL-OVERLAP other_applicant_is_ignored`、`SEAL-OVERLAP match_ignores_width_case_and_spaces`、`SEAL-OVERLAP never_returns_covered` |
| 41 | 使用：重複時要求填寫原因 | `K-OVERLAP-REASON` | 核心 | `SEAL-OVERLAP submit_without_reason_is_rejected` |
| 42 | 使用：執行，印鑑管理人用印後標記完成 | `SEAL-FULFIL`、`K-FULFIL` | 選項 `requires_fulfilment`；核心 | `SEAL-FULFIL keeper_claims_and_completes` |
| 43 | 使用：執行時填寫實際用印份數 | `SEAL-FULFIL` | `build_fulfilment` 的 `result_schema` | `SEAL-FULFIL actual_copies_is_required`、`SEAL-FULFIL actual_copies_cannot_exceed_approved`、`SEAL-FULFIL payload_lists_approved_files_and_copies` |
| 44 | 不使用：自動驗證 | `SEAL-OPTIONS` | 選項 `requires_verification` 是 false | `SEAL-OPTIONS no_automated_verification` |
| 45 | 使用：申請人確認已領回用印文件 | `SEAL-CONFIRM`、`K-CONFIRM` | 選項 `requires_confirmation`；核心 | `SEAL-CONFIRM applicant_confirmation_completes_case` |
| 46 | 使用：確認時限 5 個工作天內 | `SEAL-CONFIRM` | 參數 `confirmation.due_workdays` 的流程類型值 | `SEAL-CONFIRM due_is_5_workdays` |
| 47 | 使用：逾期只催辦，不撤銷 | `SEAL-CONFIRM`、`K-CONFIRM` | 選項 `confirmation_timeout_action = remind`；核心 | `SEAL-CONFIRM overdue_is_reminded_not_revoked` |
| 48 | 撤銷：用印前可以由申請人取消 | `SEAL-CANCEL`、`K-REVOKE` | 核心 | `SEAL-CANCEL applicant_cancels_before_sealing` |
| 49 | 撤銷：用印前可以由任一位簽核人取消 | `SEAL-CANCEL`、`K-REVOKE` | 核心 | `SEAL-CANCEL approver_cancels_before_sealing` |
| 50 | 撤銷：用印後不可撤銷 | `SEAL-CANCEL` | 選項 `revocable_after_fulfilment = false`；核心 | `SEAL-CANCEL cancel_and_revoke_rejected_after_sealing` |
| 51 | 參數：重大合約金額門檻，預設 1,000,000 元 | `SEAL-TIER` | 參數定義 `seal.major_amount_threshold` | `SEAL-TIER threshold_default_is_1000000` |
| 52 | 參數：催辦時限沿用核心預設 | `K-SLA-REMIND` | 不登記流程包的值 | `SEAL-PATH stages_use_kernel_remind_setting` |
| 53 | 參數：升級時限沿用核心預設 | `K-SLA-ESCALATE` | 不登記流程包的值 | `SEAL-PATH stages_use_kernel_escalate_setting` |
| 54 | 參數：領回確認時限，預設 5 個工作天 | `SEAL-CONFIRM` | 參數 `confirmation.due_workdays` 的流程類型值 | `SEAL-CONFIRM due_is_5_workdays` |

## 10. migration 與測試

### 10.1 migration（`db/packs/seal/`）

在核心的 migration 全部套用之後依檔名順序套用。後面的檔案可以使用前面的物件，反過來不行。

| 檔案 | 內容 |
|---|---|
| `010_schema.sql` | schema `pack_seal`；代碼表 `seal_kind`、`contract_type` 與初始資料；view `seal_case`；工具 function `match_key`、`file_hashes`、`format_amount`、`seal_kind_name`、`contract_type_name` |
| `020_catalog.sql` | 透過登記入口登記：角色 `legal`、`cfo`、`seal_keeper`；參數定義 `seal.major_amount_threshold`；`confirmation.due_workdays` 的流程類型初始值；10 個規則代碼；2 個錯誤代碼。再建立 `major_amount_threshold()` |
| `030_content_hooks.sql` | `normalize_content`、`validate_content`、`classify_tier`、`compare_content`、`diff_content`、`summarize_content` |
| `040_case_hooks.sql` | `find_overlaps`、`build_fulfilment` |
| `050_process.sql` | `build_form_schema()`；登記流程類型（第 1.3 節的資料加上表單定義）、級別、路徑版本 1（第 3 節的資料） |
| `060_notifications.sql` | 登記 3 個通知範本 |

登記入口（D-1）每次呼叫要帶的資料：

| 假定的入口 | 資料 |
|---|---|
| `sgn_internal.register_role` | 第 3 節的三個角色 |
| `sgn_internal.register_setting_definition` | 第 7.1 節的參數定義 |
| `sgn_internal.register_setting_value` | 第 7.1 節 `confirmation.due_workdays` 的流程類型初始值 |
| `sgn_internal.register_rule` | 第 7.2 節的 10 列 |
| `sgn_internal.register_error` | 第 7.3 節的 2 列 |
| `sgn_internal.register_process_type` | 第 1.3 節的 JSON，加上 `form_schema` |
| `sgn_internal.register_approval_policy` | 第 3 節的 JSON |
| `sgn_internal.register_notification_template` | 第 7.4 節的 3 列，適用的流程類型是 `seal` |

### 10.2 測試（`db/tests/packs/seal/`）

與規則有關的測試名稱以第 9 節為準，這裡只列檔案與涵蓋範圍。

| 檔案 | 涵蓋 | 測試數 |
|---|---|---|
| `010_form_test.sql` | `SEAL-FORM`（第 9 節 #3–#5、#7–#12 的 10 個，加上下列 3 個）、`SEAL-TYPE-OTHER`（2 個） | 15 |
| `020_tier_test.sql` | `SEAL-TIER`（第 9 節的 7 個，加上下列 1 個） | 8 |
| `030_path_test.sql` | `SEAL-PATH`（第 9 節的 9 個） | 9 |
| `040_change_test.sql` | `SEAL-CHANGE`（第 9 節的 13 個，加上下列 1 個） | 14 |
| `050_overlap_test.sql` | `SEAL-OVERLAP`（第 9 節的 7 個，加上下列 1 個） | 8 |
| `060_fulfilment_test.sql` | `SEAL-FULFIL`（第 9 節的 10 個）、`SEAL-CONFIRM`（3 個）、`SEAL-CANCEL`（3 個） | 16 |
| `070_options_test.sql` | `SEAL-OPTIONS`（第 9 節的 3 個，加上下列 1 個） | 4 |
| `900_architecture_test.sql` | 下列架構測試 | 5 |

第 9 節以外的測試：

| 測試 | 檢查 |
|---|---|
| `SEAL-FORM schema_matches_code_tables` | 已登記的表單定義等於 `build_form_schema()` 的輸出；選項和代碼表一致 |
| `SEAL-FORM normalize_is_idempotent` | 第 5.1 節的範例；整理兩次的結果和整理一次相同 |
| `SEAL-FORM summary_covers_summary_fields` | 第 5.6 節的範例；摘要涵蓋表單定義裡 `summary` 為 true 的每個欄位 |
| `SEAL-TIER incomplete_content_is_major` | 第 5.3 節範例 #6、#7 |
| `SEAL-CHANGE diff_agrees_with_compare` | 第 5.4 節的 18 組輸入與第 5.5 節的一致性 |
| `SEAL-OVERLAP missing_case_raises_error` | 第 5.7 節範例 #6 |
| `SEAL-OPTIONS registered_options_match_contract` | 已登記的十個選項等於第 1.2 節 |
| `seal_arch hooks_are_registered_with_spine_signatures` | 8 個 hook 存在、簽章符合骨幹第 6 節、擁有者是 `sgn_owner`、固定 `search_path` |
| `seal_arch unregistered_hooks_use_kernel_default` | `stage_scopes`、`automated_checks`、`build_verification_cases`、`on_grant_event` 沒有登記 |
| `seal_arch functions_do_not_write_kernel_tables` | `pack_seal` 所有 function 的原始碼沒有對 `sgn.` 的 `insert`、`update`、`delete`、`truncate` |
| `seal_arch no_hardcoded_threshold` | `pack_seal` 所有 function 的原始碼沒有出現 `1000000`（門檻只能從參數讀取） |
| `seal_arch no_api_functions_and_app_role_has_no_access` | `api` schema 沒有 `seal_` 開頭的 function；`sgn_app` 對 `pack_seal` 沒有任何權限 |

需要核心流程配合的測試（例如退回後縮小、催辦與升級、確認逾期）用假時鐘 `sgn.fake_now` 與 [seed-directory.md](seed-directory.md) 的人員，透過核心的對外 function 操作，不直接寫核心資料表。

端對端的驗收腳本在 [packs/seal/acceptance-cases.md](../packs/seal/acceptance-cases.md)。

## 附錄 A：rules.md 的缺漏與這份契約的處理

以下各項 rules.md 沒有寫明，這份契約做了不弱化規則的選擇。每一項都需要規則的負責人確認。

| 編號 | rules.md 沒有寫明的地方 | 這份契約的處理 |
|---|---|---|
| A-1 | 「說明」欄位是否必填 | 選填；合約類型是「其他」時必填 |
| A-2 | 「其他（需說明）」的說明寫在哪裡 | 寫在既有的「說明」欄位，維持八個欄位，不新增欄位 |
| A-3 | 實際用印份數可不可以超過核准份數、可不可以是 0 | 限制在 1 到核准份數。超過代表執行內容和核准內容不同；0 代表沒有用印，不應標記完成 |
| A-4 | 級別依申請人自填的金額判定，但沒有規定誰核對金額和合約檔案一致 | 在法務關的人工檢查清單加上 `declared_matches_file` |
| A-5 | 印鑑管理人發現紙本和核准檔案不符時怎麼處理；印鑑管理人能不能取消。rules.md 只列申請人與簽核人，核心規則 `K-REVOKE` 的名單另外包含執行人 | 契約沒有給印鑑管理人專屬的取消或退回動作；他不標記完成，並請申請人或簽核人取消。是否讓執行人取消由核心對 `K-REVOKE` 的實作決定 |
| A-6 | 重複檢查只看同一申請人；不同申請人送同一份合約不會被找到。也沒有時間範圍，多年前完成的同名合約也算 | 照 rules.md 實作：只比對同一申請人，不限時間 |
| A-7 | 「同一合約名稱與對象」的比對精確度 | 忽略全形半形、大小寫、空白的差異；其他差異視為不同 |
| A-8 | 外幣合約的金額怎麼換算、金額含稅或未稅 | 不處理；欄位是新台幣整數，由申請人換算後填寫，法務關核對 |
| A-9 | 「用印後」的時點 | 以印鑑管理人標記完成為準 |
| A-10 | 縮小金額後級別從重大降為一般時，還沒開始的財務長關是否略過 | 依新級別重新套用適用條件，財務長關略過（D-16）；已經簽過的關卡不受影響 |
