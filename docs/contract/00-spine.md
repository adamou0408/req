# 契約骨幹：核心與流程包的介面

這份文件固定核心的命名、實體、狀態和流程包介面。其他契約文件（核心細節、各流程包、API 與畫面）都以這裡為準；需要修改骨幹時，先改這裡，再改其他文件。

## 1. 命名

| 項目 | 名稱 |
|---|---|
| 平台代號 | `sgn` |
| 核心資料表 schema | `sgn` |
| 核心內部函式 schema | `sgn_internal` |
| 對外 function schema | `api`（核心 function 直接命名；流程包專屬的對外 function 以流程包代號為前綴，例如 `api.data_access_catalog_search`） |
| 流程包 schema | `pack_<代號>`，例如 `pack_data_access`、`pack_seal`（放該流程包的資料表與 hook function） |
| 資料庫角色 | `sgn_owner`（擁有者，執行升版）、`sgn_app`（後端連線，只能 `EXECUTE` `api` 的 function） |
| 假時鐘 GUC | `sgn.fake_now`（只有參數 `system.allow_fake_clock` 為 true 時有效） |
| migration 目錄 | `db/kernel/*.sql`（核心）、`db/packs/<代號>/*.sql`（流程包）；套用順序：核心全部 → 各流程包 |
| 測試目錄 | `db/tests/kernel/`、`db/tests/packs/<代號>/` |

術語（全專案只用這些詞）：

| 中文 | 識別字 | 意義 |
|---|---|---|
| 流程類型 | `process_type` | 一種申請，例如資料授權、合約用印 |
| 申請單 | `case` | 一次申請 |
| 內容版本 | `case_version` | 申請內容的一個不可變版本 |
| 級別 | `tier` | 流程包判定的風險等級，決定路徑與參數 |
| 路徑 | `approval_policy` | 某流程類型的簽核關卡定義（帶版本） |
| 關卡 | `stage` | 路徑中的一關 |
| 簽核工作 | `task` | 某一關指派給某個人的一件工作 |
| 執行 | `fulfilment` | 核准後實際去做（套用規則、用印） |
| 驗證 | `verification` | 檢查執行結果是否符合核准內容 |
| 授權 | `grant` | 核准並執行後持續有效的結果（有效期間、負責人） |
| 被授權者 | `principal` | 團隊、專案、agent 等持有授權的主體，一定有負責人 |
| 稽核事件 | `audit_event` | 只增不改的紀錄 |

## 2. 核心實體

只列實體與關鍵欄位；完整 DDL 在 `01-kernel.md`。

**人員與組織**
- `person`（內部 id、姓名、email、狀態、生效期間）、`person_identity`（provider、external_id → person）
- `org_unit`（樹）、`org_membership`（person ↔ org_unit，生效期間）、`reporting_line`（person → manager，生效期間）
- `role`（代碼、名稱、是否群組認領）、`role_assignment`（person → role，可帶 `scope_ref`，生效期間、來源）
- `delegation`（委託人 → 代理人，期間、原因）
- `principal`（類型 team/project/agent、名稱、負責人、結束日、狀態）、`principal_member`

**設定**
- `setting_definition`（key、型別、單位、預設值、範圍、允許的適用範圍種類、說明、所屬流程包）
- `setting_value`（key、`scope_kind` global/process/tier/org_unit/scope_ref、`scope_ref`、值、生效時間、修改人、原因；只增不改）
- `calendar_holiday`、`rule`（規則代碼、說明、來源文件、所屬流程包）、`error_catalog`（代碼、SQLSTATE、訊息、HTTP 狀態）
- `notification_template`（事件代碼 → 主旨、內文、連結樣板）

**流程定義**
- `process_type`（代碼、名稱、所屬流程包、表單定義 `form_schema`、選項、hook 函式名稱、狀態）
- `process_tier`（流程類型、級別代碼、名稱、排序）
- `approval_policy`（流程類型、版本、生效時間）、`policy_stage`（順序、代碼、名稱、resolver 種類與參數、模式、並行群組、適用條件、時限參數 key、人工檢查清單）

**申請與簽核**
- `case`（單號、流程類型、路徑版本、申請人、被授權者、級別、狀態、目前版本、來源單與來源種類、有效起迄）
- `case_version`（版本號、內容 jsonb、內容雜湊、相對前一版的變更分類、建立者）
- `case_overlap`（重疊對象、程度、申請人說明）
- `case_stage`（關卡實例、狀態）、`case_task`（指派對象、原指派對象、代理或升級來源、狀態、到期時間、催辦與升級時間、決定、意見、裝置、MFA）
- `attachment`（檔名、大小、型別、sha256、儲存位置、所屬版本）
- `case_template`（範本：流程類型、名稱、內容、建立者、是否為擁有者維護的標準範本）

**執行、驗證、授權**
- `fulfilment`（內容 payload、認領人、交付方式、完成時間、完成說明）
- `verification_run`、`verification_case`（預期、實際、結果）、`requester_confirmation`
- `grant`（申請單、被授權者、有效起迄、狀態、撤銷資訊）

**證據與通知**
- `audit_event`（序號、時間、actor、actor 角色、動作、申請單、規則代碼、參數快照、路徑版本、變更內容、IP、裝置、代理、MFA、前一筆雜湊、本筆雜湊）
- `notification_outbox`、`scheduler_run`

## 3. 流程類型的選項

每個流程類型宣告自己用到哪些核心能力。核心依選項決定狀態怎麼走。

| 選項 | 意義 | 資料授權 | 合約用印 |
|---|---|---|---|
| `uses_principal` | 需要指定被授權者 | 是 | 否 |
| `has_validity` | 有有效期間，會到期 | 是 | 否 |
| `renewable` | 可以續期 | 是 | 否 |
| `overlap_check` | 送審時檢查重複或重疊 | 是 | 是 |
| `requires_fulfilment` | 核准後需要執行 | 是 | 是 |
| `requires_verification` | 執行後自動驗證 | 是 | 否 |
| `requires_confirmation` | 需要申請人確認 | 是 | 是 |
| `confirmation_timeout_action` | 確認逾期的處理：`revoke` 或 `remind` | revoke | remind |
| `revocable_after_fulfilment` | 執行後是否可撤銷 | 是 | 否 |
| `batch_renewal` | 無差異的續期可批次核准 | 是 | 否 |

## 4. 狀態

### 申請單（`case.status`）

| 狀態 | 意義 |
|---|---|
| `draft` | 草稿 |
| `in_approval` | 簽核中 |
| `returned` | 已退回，等申請人修改 |
| `pending_fulfilment` | 已核准，等待執行 |
| `verifying` | 已執行，驗證中或等申請人確認 |
| `active` | 生效中（有有效期間的流程） |
| `completed` | 已完成（沒有有效期間的流程） |
| `expired` | 已到期 |
| `revoked` | 已撤銷 |
| `cancelled` | 生效或完成前取消 |

主要轉移（完整的轉移表在 `01-kernel.md`，由資料表驅動）：

```
draft → in_approval → pending_fulfilment → verifying → active → expired
                 ↘ returned → in_approval                  ↘ revoked
                                          verifying → completed
任何未生效的狀態 → cancelled；verifying 驗證失敗 → pending_fulfilment
```

沒有選用的能力就略過對應的狀態。例如不需要執行的流程，核准後直接進入 `active` 或 `completed`。

### 簽核工作（`case_task.status`）

`pending`、`approved`、`returned`、`superseded`（被升級或重新分派取代）、`cancelled`。群組認領的工作另有 `unclaimed`。

### 授權（`grant.status`）

`active`、`expired`、`revoked`。

## 5. 核心規則

這些規則屬於核心，對所有流程類型一律生效，流程包不能關閉。每條都有規則代碼。

| 代碼 | 規則 |
|---|---|
| `K-SOD-APPLICANT` | 申請人不能簽自己的單 |
| `K-SOD-DISTINCT` | 同一張單的每一關都是不同的人；撞到時改由該人的上一層主管；代理人同樣適用 |
| `K-VERSION-BOUND` | 每個簽核決定綁定當時的內容版本 |
| `K-CHANGE-REDUCE` | 簽核人只能做縮小的修改；縮小後通知申請人，不用重簽 |
| `K-CHANGE-EXPAND` | 擴大或無法判定的修改，從第一關重簽 |
| `K-RETURN` | 退回後，申請人只做縮小就從退回的那一關繼續；否則從第一關重簽 |
| `K-PARALLEL-ALL` | 並行的關卡要全部核准才往下 |
| `K-SLA-REMIND`、`K-SLA-ESCALATE` | 逾時先催辦，再升級給上一層主管；升級後原簽核人不能再簽 |
| `K-DELEGATE` | 代理人簽核，紀錄寫明誰代誰簽 |
| `K-CLAIM` | 群組關卡由一人認領後負責；認領人不得在前面的關卡簽過這張單 |
| `K-BATCH` | 只有與來源單無差異的續期可以批次核准；每張單各留一筆紀錄 |
| `K-MOBILE-MFA` | 用手機做簽核決定時必須通過 MFA |
| `K-OVERLAP-BLOCK`、`K-OVERLAP-REASON` | 完全涵蓋就擋下；部分重疊必須填理由 |
| `K-FULFIL` | 執行完成才進入下一步；生效以執行完成為準 |
| `K-VERIFY`、`K-CONFIRM` | 驗證沒過退回執行；申請人逾期未確認，依流程類型的選項撤銷或催辦 |
| `K-VALIDITY-MAX` | 有效期間不得超過該級別的上限 |
| `K-EXPIRE`、`K-EXPIRE-REMIND` | 到期前提醒，到期自動失效 |
| `K-REVOKE` | 申請人、負責人、任一位簽核人、執行人可以直接撤銷，必須填原因 |
| `K-OWNER-CONTINUITY` | 授權隨時要有在職的負責人；負責人異動給寬限期改派，逾期自動撤銷；被授權者結束時授權失效 |
| `K-AUDIT-APPEND`、`K-AUDIT-CHAIN` | 紀錄只增不改；雜湊鏈可驗證 |
| `K-SETTING-ADMIN` | 參數只有系統管理員能改，要填原因並留紀錄；路徑只能由升版變更 |
| `K-AUDITOR-READONLY` | 稽核角色唯讀，可查全部 |

流程包的規則用自己的前綴，例如 `DA-`（資料授權）、`SEAL-`（合約用印）。

## 6. 流程包介面（hook）

流程包在自己的 schema 裡實作下列 function，並在 `process_type` 登記函式名稱。核心在登記時檢查函式存在、簽章正確、擁有者是 `sgn_owner`。沒有登記的 hook 使用核心的預設行為。

所有 hook 都不得修改核心資料表；只能讀取，並回傳結果給核心。

| Hook | 簽章 | 回傳 | 預設行為 |
|---|---|---|---|
| `normalize_content` | `(p_actor bigint, p_content jsonb) returns jsonb` | `{"content": {...}, "notices": [{"code","message"}]}`：整理後的內容，以及要顯示給申請人的提示（例如「L1 欄位已自動移除」） | 原樣回傳 |
| `validate_content` | `(p_actor bigint, p_content jsonb) returns jsonb` | `[{"path","code","message"}]`：表單定義檢查不到的錯誤 | 空陣列 |
| `classify_tier` | `(p_content jsonb) returns text` | 級別代碼 | 該流程類型排序最低的級別 |
| `compare_content` | `(p_old jsonb, p_new jsonb) returns text` | `same`、`reduce`、`expand` | 內容相同回 `same`，否則 `expand` |
| `diff_content` | `(p_old jsonb, p_new jsonb) returns jsonb` | `[{"kind": "added|removed|reduced|expanded|same", "label", "detail"}]`：給人看的差異 | 依表單定義逐欄比較 |
| `summarize_content` | `(p_content jsonb) returns jsonb` | `{"title", "subtitle", "facts": [{"label","value","emphasis"}]}`：清單與簽核畫面第一眼要看到的事實 | 依表單定義取標示為摘要的欄位 |
| `find_overlaps` | `(p_case_id bigint, p_content jsonb) returns jsonb` | `{"level": "none|partial|covered", "items": [{"case_id","case_no","detail"}]}` | `none` |
| `stage_scopes` | `(p_stage_code text, p_content jsonb) returns setof text` | 這一關涉及的範圍代碼（例如主題包代碼），核心用它查「某範圍的角色持有人」 | 無 |
| `automated_checks` | `(p_case_id bigint, p_stage_code text) returns jsonb` | `[{"code","label","result": "pass|warn|fail","detail"}]`：顯示給該關簽核人的自動檢查結果 | 空陣列 |
| `build_fulfilment` | `(p_case_id bigint) returns jsonb` | 要交給外部系統或執行人的內容 | 目前版本的內容 |
| `build_verification_cases` | `(p_case_id bigint) returns jsonb` | `[{"code","description","expected": "allow|deny","query": {...}}]` | 空陣列 |
| `on_grant_event` | `(p_grant_id bigint, p_event text) returns void` | 授權生效、到期、撤銷時通知流程包更新自己的資料表 | 不做事 |

## 7. 簽核人解析器（resolver）

每一關宣告一種 resolver，由 `sgn_internal.resolve_stage_assignees` 統一解析，並在這裡套用職責分離、代理與升級。

| 種類 | 參數 | 解析方式 |
|---|---|---|
| `applicant_manager` | — | 申請人的直屬主管 |
| `role_holder` | `role` | 該角色目前的持有人（一人） |
| `scoped_role` | `role` | 對 `stage_scopes` 回傳的每個範圍，找該範圍的角色持有人；多人時並行 |
| `role_group_claim` | `role` | 該角色群組的任一成員認領 |
| `principal_owner` | — | 被授權者的負責人 |

升級對象：一律是「目前指派對象的直屬主管」。找不到上一層時，升級給系統管理員群組處理，並記錄。

## 8. 參數的命名

`<範圍>.<項目>`，核心參數用 `approval.`、`validity.`、`grant.`、`audit.`、`system.` 等前綴；流程包參數用流程包代碼當前綴。

| key | 意義 | 預設 | 可依什麼設定不同的值 |
|---|---|---|---|
| `approval.remind_after_workdays` | 未簽多久催辦 | 3 | 流程類型、級別 |
| `approval.escalate_after_workdays` | 催辦後多久升級 | 2 | 流程類型、級別 |
| `approval.mobile_mfa_required` | 手機簽核是否需要 MFA | true | — |
| `validity.max_months` | 有效期間上限 | 12 | 流程類型、級別 |
| `validity.remind_before_days` | 到期前幾天提醒 | 14 | 流程類型 |
| `grant.owner_grace_days` | 負責人異動寬限期 | 14 | 流程類型 |
| `confirmation.due_workdays` | 申請人確認時限 | 5 | 流程類型 |
| `audit.retention_years` | 紀錄保存年限 | 10 | — |
| `system.allow_fake_clock` | 是否允許假時鐘（只有測試環境為 true） | false | — |

## 9. 目錄結構

```
db/kernel/            核心 migration
db/packs/<代號>/      流程包 migration（表、hook、流程定義、參數、規則代碼、範本）
db/seed/              示範與驗收用的種子資料（不進正式環境）
db/tests/             kernel/ 與 packs/<代號>/
packages/contract/    路由表與共用型別（唯一來源）
api/                  後端核心；api/src/packs/<代號>/ 放流程包的 adapter（例如 DC）
web/                  前端核心；web/src/packs/<代號>/ 放流程包專屬的輸入元件
e2e/                  端對端測試與 UI/UX 自動檢查
tools/                產生器、檢查腳本
deploy/               部署設定
docs/                 文件；docs/reference/ 為自動產生
```

邊界規則：`db/kernel`、`api/src`（不含 `packs/`）、`web/src`（不含 `packs/`）裡不得出現任何流程包的代號。檢查腳本會驗證。

## 10. 前端的通用畫面

| 畫面 | 內容 | 流程包可以提供 |
|---|---|---|
| 首頁／我的申請 | 待我處理、全部申請、我負責的被授權者 | — |
| 新申請 | 選流程類型 → 依表單定義產生表單；沿用前案、範本、續期；即時顯示級別、路徑、重複檢查 | 專屬輸入元件（例如資料範圍選擇器） |
| 申請單詳情 | 進度、摘要事實、內容、差異、紀錄、驗證確認 | 內容的專屬呈現方式 |
| 待簽清單 | 待我簽、我已簽、職務代理；批次核准 | — |
| 簽核詳情 | 摘要事實、與前案差異、重疊警示、自動檢查、可縮小的欄位、決定 | 縮小用的專屬元件 |
| 執行佇列與執行詳情 | 認領、檢查清單、交付內容、標記完成、驗證結果 | 交付內容的呈現方式 |
| 授權總覽 | 我擁有或負責的有效授權、撤銷、負責人異動 | — |
| 稽核查詢與證據頁 | 篩選、匯出、事件紀錄、雜湊鏈驗證 | — |
| 設定 | 參數、角色指派、流程定義與路徑（唯讀）、整合狀態 | — |

表單定義支援的欄位型別：`text`、`textarea`、`select`、`multiselect`、`integer`、`money`、`date`、`date_range`、`boolean`、`person`、`principal`、`attachment`，以及 `custom`（指定流程包註冊的元件名稱）。
