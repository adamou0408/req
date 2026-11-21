# 交接：資料授權的完整簽核流程（資料庫這一半）

> **本檔寫於 2026-11-20，以下已過時：§0 的測試數字（121 個資料庫測試、47 個規則代碼）與「端對端失敗 6／7」（已由 `flow-surface.md` 修好）；§8「需要決定的事」（多數已由 `docs/decision-log.md` 裁決）；§9 留給下一位的多數項目（交付、確認、對帳、紅隊修復都已做）；§4「給後端與前端的介面」的 function 清單（現況以 `packages/contract/src/routes.ts` 與資料庫為準）。仍有效：資料表與 function 的設計說明（§2、§3）仍可參考。現況見 `closed-loop-2.md`（最近一次經複核的結果：資料庫測試 320）與 `docs/contract/02-pack-data-access.md`。**

日期：2026-11-20。範圍：`db/`、`packages/contract/`、本文件。`api/`、`web/`、`e2e/`、`tools/`、`sim/` 沒有動。
本文分清楚：**跑過且通過**、**寫了但沒跑**、**沒做到**。

## 0. 結果一覽

| 項目 | 結果 |
|---|---|
| `tools/check.sh --fast`（安裝、格式、lint、型別、shellcheck、plpgsql_check、禁止字串、追蹤檔案、npm audit） | **跑過且通過** |
| 資料庫測試（`db/build.sh`，含規則代碼覆蓋檢查） | **跑過且通過**：`# tests 121 # pass 121`；規則代碼 47 個，每個都有測試 |
| 通行金鑰的 Node 對照組 | **跑過且通過**：16／16（沒有改） |
| 端對端（`tools/run-all.sh` 第 6 段） | **失敗 6／7**（預期中：後端與畫面仍呼叫舊的 function 簽章，見 §5）。由下一位處理 |
| 變異測試（把規則改壞，對應的測試會失敗） | **跑過**：6 個變異，每個都讓對應的測試失敗（§3.3） |

最後一次完整執行：`tools/check.sh`（從乾淨狀態重建兩個資料庫）→ 只有「測試」一段失敗，失敗的全是端對端。

```bash
db/build.sh                 # 建 sgn_test、sgn_e2e，載入種子，跑資料庫測試（要先 sim/up.sh ldap idp）
db/build.sh --no-test       # 只建置
db/build.sh --plpgsql-check # 靜態分析（123 個 PL/pgSQL function）
```

**沒有照「先寫會失敗的測試再實作」的順序做**：多數規則是先寫實作、再寫測試。為了補上「測試真的抓得到」這一點，另做了 §3.3 的變異測試，但只涵蓋 6 個規則，不是每一條。

## 1. 目錄與套用順序

| 位置 | 內容 |
|---|---|
| `db/kernel/01_core.sql`～`90_grants.sql` | 原有的核心 migration，**沒有修改**（promote.md：從這一版起只能新增） |
| `db/kernel/100_settings.sql`～`190_sdk.sql` | 這一輪新增的核心 migration（§2.1） |
| `db/packs/data_access/010～050` | 資料授權流程包（§2.2） |
| `db/testing/60_probe_process.sql` | 只裝在 `sgn_test`：核心測試用的兩個完全宣告的流程類型 `probe`、`probe_chain`，讓核心測試不依賴任何流程包 |
| `db/seed/kernel/`、`db/seed/packs/data_access/` | 示範與驗收用的種子（被授權者、系統管理人、資料目錄），在人員同步之後載入；不進正式環境 |
| `db/tests/kernel/76-flow.test.mjs` | 核心的多關卡流程測試（新） |
| `db/tests/packs/data_access/` | 流程包的 hook、完整流程、架構邊界測試（新） |

`db/build.sh` 的順序：`01_core` → 其餘 `db/kernel/*.sql`（依版本序，不含 `90_grants`）→ `db/packs/*/` 各自依版本序 → `db/testing/`（只有 `sgn_test`）→ `90_grants.sql` → 開發環境的參數值（`webauthn.*`）→ 人員同步 → `db/seed/`。

## 2. 資料表與 function

### 2.1 核心（新增的 migration）

| 檔案 | 資料表 | 主要 function |
|---|---|---|
| `100_settings.sql` | `setting_definition`、`setting_value`（只增不改，觸發器擋下）、`calendar_holiday`；`error_catalog` 加 `kind`（error／notice／check），`http_status` 只有 error 有；刪除 `sgn.setting` | `setting(key, scopes)`（參數的唯一入口：最具體的範圍 → 全域 → 預設值）、`setting_text`／`setting_int`（同簽章，改讀新表）、`register_setting_definition`、`register_setting_value`、`message_text`（訊息的唯一入口，`format()` 代入參數）、`today()`、`is_workday`、`add_workdays`、`reject_change`（只增不改的共用觸發器） |
| `110_rules.sql` | `rule` 加 `pack`、`coverage`、`note` | `register_rule`；PRB-* 改為 K-*（§3.1）；新的錯誤代碼 |
| `120_flow_definition.sql` | `process_type`、`process_tier`、`hook_definition`（核心固定的 hook 介面）、`approval_policy`（帶版本、`top_resolver_role`）、`policy_stage` | `register_process_type`（登記時檢查 hook 函式存在、參數與回傳型別相符）、`register_approval_policy`（定義不同才新增一版）、`policy_latest`、`process_option`、`message_register`、`hook_normalize`／`hook_classify`／`hook_compare`／`hook_overlaps`／`hook_stage_scopes`／`hook_fulfilment`（每種 hook 一個呼叫入口，沒登記時用預設行為；hook 回傳不認得的值時往嚴格的方向） |
| `130_principal_grant.sql` | `principal`（團隊、專案、agent；一定有負責人；專案與 agent 必有結束日）、`grant_record`、`notification_template`、`notification_outbox`；`role_assignment` 加 `scope_ref`、`source` | `role_holders(role, scope)`（角色持有人的唯一入口）、`sync_scoped_role_assignments`（某來源對某角色的完整依範圍指派）、`directory_set_source_roles`（人員同步只動自己來源的角色）、`api_sync.directory_apply`（同簽章重建）、`principal_upsert`、`principal_usable`、`principal_json`、`notify`（通知寫入的唯一入口；只寫佇列） |
| `140_case_model.sql` | `request_case` 加 `process_type`、`policy_id`、`tier`、`resume_seq`、`returned_version`，刪除 `approver_person_id`、`approver_line_id`；`case_version` 加 `terms`、`version_sha256`、`tier`、`change_kind`、`created_by`、`notices`、`errors`；新表 `case_stage`、`case_task`、`case_overlap`、`fulfilment`；狀態轉移表與動作目錄改寫 | — |
| `150_resolver.sql` | — | `resolve_manager`（同簽章，加冷卻期）、`decider_denial`（決定者資格：解析、認領、決定共用）、`resolve_eligible`（不合格就沿主管線往上 → 最終決定者 → 找不到）、`claim_candidates`、`resolve_applicant_manager`、`resolve_role_holders`、`resolve_claim_groups`、`resolve_stage`（找簽核人的唯一入口） |
| `160_case_flow.sql` | — | `terms_normalized`、`terms_errors`、`terms_compare`、`versions_compare`（內容、terms、級別取最嚴重）、`version_prepare`、`version_store`、`version_add`、`person_open_task`、`person_claimable_task`、`person_has_task`、`denial_reason`（同簽章重建，授權的唯一入口）、`stage_open`、`stage_add_tasks`、`stage_close_if_done`、`stages_close_open`、`case_advance`（關卡推進）、`fulfilment_prepare`、`grant_activate`、`case_new`、`case_overlap_check`、`case_resume_mode`、`case_submit_draft` |
| `170_decide.sql` | — | `decision_input`、`api.challenge_issue`（新簽章）、`decision_prepare`／`decision_commit`（同簽章重建）、`task_approve`、`task_close_negative`、`decision_apply`、`api.task_claim`、`api.case_create`／`case_submit_new`／`case_revise`／`case_submit`（新簽章） |
| `180_views.sql` | — | `case_summary`（同簽章重建）、`case_detail`、`case_current_stage`、`case_waiting_on`、`case_terms_view`、`case_stages_view`、`case_versions_view`、`person_waiting_cases`、`person_capabilities`、`audit_case_events`（同簽章重建）、`api.case_get`、`api.inbox_list`、`api.process_type_list`、`api.principal_list`、`api.error_catalog`（只回 kind = error） |
| `190_sdk.sql` | schema `sgn_sdk` | 流程包接觸核心的唯一介面：`setting`、`message`、`raise_error`、`session_person`、`today`、`case_context`、`active_grants`、`role_holders`、`person_by_identity`、`register_*`、`sync_scoped_role_assignments`。沒有任何連線角色有權限 |

### 2.2 資料授權流程包（`pack_data_access`）

| 檔案 | 內容 |
|---|---|
| `010_catalog.sql` | `catalog_package`（含所屬受管系統 `system_code`）、`catalog_field`、`catalog_filter`、`catalog_filter_value`、`purpose_category`（六個分類）；`owner_scope`、`catalog_load`（載入快照並把擁有者同步成核心的 `data_owner` 依範圍指派） |
| `020_scope_algebra.sql` | 契約 §5.0：`condition_set`、`set_within`、`set_disjoint`、`filters_wellformed`、`filters_within`、`filters_disjoint`、`filters_relation`、`period_valid`、`period_relation`、`period_disjoint` |
| `030_hooks.sql` | 六個 hook：`normalize_content`、`classify_tier`、`compare_content`、`find_overlaps`、`stage_scopes`、`build_fulfilment`；輔助：`scope_grouped`、`package_normalized`、`filter_normalized`、`content_errors`、`filter_errors`、`filter_value_problem`、`package_change`、`grant_touched`、`grant_covers` 等 |
| `040_api.sql` | `api.data_access_catalog(p_session)`（新申請畫面的目錄） |
| `050_registration.sql` | 規則代碼 17 個、訊息、參數（`data_access.export_requestable`；`validity.max_months` 的 L3＝12、L4＝6）、流程類型與路徑 |

路徑（資料，不是程式）：

| 順序 | 代碼 | 階段 | resolver | 角色 | 模式 | 適用 |
|---|---|---|---|---|---|---|
| 10 | `manager` | approval | `applicant_manager` | — | one | 全部 |
| 20 | `data_owner` | approval | `scoped_role` | `data_owner`（範圍 `data_access:bundle:<主題包>`） | all | 全部 |
| 30 | `ciso` | approval | `role_holder` | `ciso` | one | L4 |
| 40 | `mis` | approval | `role_group_claim` | `mis` | one | 全部 |
| 50 | `fulfil` | fulfilment | `system_custodian` | `system_custodian`（範圍 `system:<受管系統>`） | one | 全部 |

最終決定者：`board_chair`。

## 3. 規則與測試

### 3.1 規則代碼（`sgn.rule`，47 個）

PRB-* 的對照（舊測試只改名稱，內容不變的部分照舊）：PRB-APPLICANT → `K-ACTOR-PROVEN`、PRB-STATE → `K-NO-REGRESS`、PRB-APPROVER → `K-DECISION-ELIGIBLE`、PRB-SELF → `K-SOD-APPLICANT`、PRB-PROOF → `K-DECISION-PROOF`、PRB-CHAIN → `K-AUDIT-APPEND`、PRB-CONTENT-HASH → `K-AUDIT-CHAIN`、PRB-AUDIT-READ → `K-AUDITOR-READONLY`、PRB-DIRECTORY → `K-HR-SYNC`、PRB-SYNC-GUARD → `K-DETECT-MANAGER-FLIP`、PRB-SESSION → `K-SESSION`。每個代碼在 `sgn.rule.coverage` 標 full／partial，`note` 寫這一版沒做的部分（多數是 partial：只做到骨幹規則的一部分）。

### 3.2 每條規則對應的測試（測試名稱以代碼開頭）

| 規則 | 測試檔 |
|---|---|
| `K-RESOLVE-STAGE-START`、`K-CLAIM`、`K-SOD-DISTINCT`、`K-FULFIL`、`K-TOP-RESOLVER`、`K-AUDITOR-INDEPENDENT`、`K-REJECT`、`K-RECALL`、`K-CHANGE-EXPAND`（含 K-RETURN 的「不修改就從退回那關繼續」） | `db/tests/kernel/76-flow.test.mjs` |
| `K-RESOLVE-HALT`、`K-HR-SYNC`（含冷卻期）、`K-ACTOR-PROVEN`、`K-NO-REGRESS`、`K-DECISION-ELIGIBLE`、`K-SOD-APPLICANT`、`K-DECISION-PROOF`、`K-AUDIT-APPEND`、`K-AUDITOR-READONLY` | `db/tests/kernel/70-business.test.mjs` |
| `K-DETECT-MANAGER-FLIP`（攻擊測試，含冷卻期內攻擊者還不是簽核人） | `db/tests/kernel/72-sync-guard.test.mjs` |
| `K-SESSION`、`K-AUDIT-CHAIN`、`K-DECISION-PROOF`（a）（b）（c） | `74`、`25`、`30`、`40`、`50`、`80` |
| `DA-TIER-AUTO-GRANT`、`DA-NO-MEDIUM`、`DA-SCOPE-STRUCTURED`、`DA-TIER-MAX`、`DA-EXPORT-TIER`、`DA-DATA-PERIOD`、`DA-PURPOSE`、`DA-STAGE-OWNER`、`DA-CHANGE-COMPARE`、`DA-CHANGE-PURPOSE` | `db/tests/packs/data_access/10-hooks.test.mjs` |
| `DA-PATH-L3`（含 `K-PARALLEL-ALL`）、`DA-FULFIL-RULE`、`DA-FULFIL-CUSTODIAN`、`DA-PATH-L4`、`K-VALIDITY-MAX`（含 `DA-DEFAULT-SETTINGS`）、`K-NO-BACKDATE`、`K-PRINCIPAL`、`K-CHANGE-REDUCE`（兩個，含 `K-VERSION-BOUND`）、`K-RETURN`、`K-SOD-DISTINCT`（主管同時是資料擁有者）、`DA-OVERLAP-COVERED`（含 `K-OVERLAP-BLOCK`）、`DA-OVERLAP-PARTIAL`（含 `K-OVERLAP-REASON`） | `db/tests/packs/data_access/20-flow.test.mjs` |
| 邊界：核心不出現流程包概念；流程包只經 `sgn_sdk`；流程包沒有寫死的時限；`sgn_app` 碰不到流程包與 `sgn_sdk`；hook 與路徑的登記；流程包路由的結構 | `db/tests/packs/data_access/90-architecture.test.mjs` |

`db/tools/rule-coverage.mjs` 改成掃 `db/tests/` 底下全部的 `*.test.mjs`。

### 3.3 變異測試（一次性腳本，沒有放進 repo）

在 `sgn_test` 上把 function 改壞，只跑對應的測試，再改回來：

| 變異 | 結果 |
|---|---|
| `decider_denial` 不檢查「已經在別關」 | 76 的 K-SOD-DISTINCT、20 的 K-SOD-DISTINCT 等 7 個失敗 |
| `resolve_manager` 沒有冷卻期 | 70 的 K-HR-SYNC 冷卻期測試等 3 個失敗 |
| 送審不擋完全涵蓋 | DA-OVERLAP-COVERED 失敗 |
| `compare_content` 不把改說明當擴大 | DA-CHANGE-PURPOSE 失敗 |
| `terms_errors` 不檢查上限 | K-VALIDITY-MAX 等 6 個失敗 |
| 並行關卡一件工作完成就往下 | DA-PATH-L3（K-PARALLEL-ALL）等 6 個失敗 |

### 3.4 既有測試的調整（逐項原因）

102 個既有測試沒有刪除；資料庫測試由 79 個變成 121 個。調整的地方：

| 測試 | 調整 | 原因 |
|---|---|---|
| 全部 | 規則代碼 PRB-* → K-* | 範圍 8 |
| 全部用到申請單的 | `case_create`、`case_submit_new` 多了流程類型與 terms；`case_revise` 多了 terms；`case_submit` 多了重疊理由；`challenge_issue` 多了 input；用測試專用的流程類型 `probe` | 流程類型與被授權者、授權起迄是核心的欄位 |
| 30、40、50、60、70、72、80、90 | 狀態 `approved` → `completed`、`submitted` → `in_approval`、退回後 `draft` → `returned` | 狀態依骨幹 4.1 命名；沒有執行關的流程核准完成即 `completed` |
| 30、40、50、70、90 | 退回要帶原因 `{reason}` | 退回、駁回、撤回必須填原因 |
| 30、40 | 改參數改成新增一筆參數值（`setSetting`） | 參數改為定義＋只增不改的值 |
| 70 K-HR-SYNC（換主管） | 先斷言冷卻期內仍由原主管簽、沒有例外；把新關係起點往前移 5 天模擬時間經過，再斷言新主管簽並開例外；結束時同樣讓「改回原主管」過冷卻期 | 範圍 8 的冷卻期 |
| 70 K-DECISION-ELIGIBLE | 「沒有主管的人不能送審（NO_APPROVER）」拆成新的 `K-RESOLVE-HALT` 測試：可以送審、關卡停住並開例外 | 骨幹 K-RESOLVE-HALT／K-TOP-RESOLVER：找不到人是例外，不是送審錯誤 |
| 70 K-DECISION-PROOF | 改狀態的入口清單更新（多了 `case_advance`、`task_claim`、`decision_apply`），並斷言 `decision_apply` 只由 `decision_commit` 呼叫；需要證明的動作多了 `approve_reduced`、`fulfil`、`recall`、`reject` | 多關卡與新的簽核動作 |
| 70 K-AUDIT-APPEND、K-AUDITOR-READONLY | 事件多了 `case.stage_opened`、`case.completed` | 每一關開始與核准完成各寫一筆事件 |
| 70、72 | `approver_name` → `waiting_on`；簽核人從 `case_task` 查 | 簽核人由每一關的工作記錄 |
| 72 攻擊測試 | 先斷言冷卻期內攻擊者不是簽核人，再模擬時間經過後走原本的斷言 | 冷卻期 |
| 90 契約 | 結構檢查涵蓋新的路由（`process_type_list`、`principal_list`、`task_claim`）；授權單一入口的擁有者加上 `decider_denial`、錯誤代碼加上 4 個；「改狀態卻不自己授權」的兩個內部 function 逐項列出理由；掃描範圍加上 `sgn_sdk` 與流程包 | 決定者資格由解析器與授權入口共用 |

## 4. 給後端與前端的介面

### 4.1 路由（`packages/contract/src/routes.ts`，唯一來源）

| function | 參數 | 回傳 | 誰用 |
|---|---|---|---|
| `me` | session | `{person_id, name, passkeys, capabilities}`；capabilities：`case.submit`（一律）、`inbox`（有等我處理或可認領的）、`audit` | 全部 |
| `process_type_list` **新** | session | `[{code, name, options, tiers: [{code, name}]}]` | 新申請 |
| `principal_list` **新** | session | `[{principal_id, kind, name, owner_name, ends_on}]` | 新申請 |
| `data_access_catalog` **新** | session | `{packages: [{code, name, period_field, fields: [{code, name, classification}], filters: [{code, name, value_type, values: [{value, label}]}]}], purpose_categories: [{code, name, requires_description}]}`；L1、L2 欄位照列，畫面顯示為「自動給」 | 新申請、修改 |
| `case_create` | session, process_type, content, terms | `CaseDetail` | 存草稿 |
| `case_submit_new` | session, process_type, content, terms, overlap_reason | `CaseDetail` | 送出（建立＋送審同一交易） |
| `case_revise` | session, case_id, content, terms | `CaseDetail` | 修改草稿、退回或撤回後的單 |
| `case_submit` | session, case_id, overlap_reason | `CaseDetail` | 送審草稿、重送 |
| `case_get` | session, case_id | `CaseDetail` | 申請單詳情、簽核詳情、執行詳情 |
| `case_list_mine` | session | `[CaseSummary]` | 我的申請 |
| `inbox_list` | session | `[CaseSummary]`（只列我現在能做事的：指派給我，或我能認領） | 待辦 |
| `task_claim` **新** | session, case_id | `CaseSummary` | 認領（MIS、系統管理人） |
| `challenge_issue` | session, case_id, decision, **input** | `{challenge_id, challenge, binding: {case_id, case_no, version, content_sha256, version_sha256, decision, input, input_sha256}}` | 每個決定的第一步 |
| `case_decide_passkey` | 不變 | `CaseSummary` | 每個決定的第二步 |
| 稽核、登入、登記通行金鑰 | 不變 | `audit_case.case` 的結構跟著 CaseSummary 改（沒有 actions） | |

`terms`：`{principal_id, valid_from, valid_to}`（日期 `YYYY-MM-DD`）；流程類型的 `options.uses_principal`、`has_validity` 為 true 時才保留對應的鍵。

`content`（資料授權）：`{scope: [{package, fields: [欄位代碼或 {code}], row_filters: [{filter, op, values}]}], data_period: {from, to} | null, purpose_category, purpose_description, export_allowed}`。送進來的內容由流程包整理（L1、L2 欄位移除、`eq` 改寫、排序），回傳的 `content` 是整理後的版本。

`challenge_issue` 的 `decision` 與 `input`：

| decision | 誰 | input |
|---|---|---|
| `approve` | 這一關的指派對象 | `{}` |
| `approve_reduced` | 同上 | `{content?, terms?}`（省略的沿用目前版本）；必須比目前版本縮小，否則 `CHANGE_NOT_REDUCE`（在按通行金鑰之前就回錯） |
| `return`、`reject` | 同上 | `{reason}`，必填（`REASON_REQUIRED`） |
| `recall` | 申請人（簽核中） | `{reason}`，必填 |
| `fulfil` | 執行關的指派對象（認領後） | `{}`；綁定執行內容的雜湊 |

### 4.2 CaseSummary 與 CaseDetail

CaseSummary：`case_id, case_no, process_type, state, tier, version, content, content_sha256, version_sha256, terms {principal | null, valid_from, valid_to}, updated_at, applicant_name, current_stage {seq, code, name, phase, status} | null, waiting_on [姓名], notices [{code, message}], errors [{path, code, message}], actions [動作], exceptions [{id, rule_code, opened_at, event_seq}]`。

- `state`：`draft`、`in_approval`、`returned`、`rejected`、`pending_fulfilment`、`active`、`completed`（骨幹 4.1）。
- `current_stage.status` 為 `halted` 時：找不到合格的簽核人，已開例外（`K-RESOLVE-HALT`），畫面要顯示「停住」而不是「等某人」。
- `errors` 只有草稿與退回的單有；不為空時送審一定被擋（`CONTENT_INVALID`）。`path` 例：`scope[1].row_filters[0].values`、`terms.valid_to`、`data_period`。
- `notices`：例如「「客戶主檔」的「產業別」是 L1 欄位，不需要申請，已自動從這張單移除。」

CaseDetail＝CaseSummary＋：

- `stages`：`[{seq, code, name, phase, status, opened_at, closed_at, tasks: [{task_id, assignee_name, status, scope_refs, decided_version, reason, closed_at}]}]`。同一關可能有多個實例（退回後重開、重簽時舊的標 `returned`／`cancelled`）。
- `versions`：`[{version, change_kind (initial／same／reduce／expand), tier, created_by_name, created_at, content_sha256, version_sha256}]`。
- `overlap`：`{level (none／partial／covered), items, reason, version} | null`。草稿與退回的單即時重算；送審後是送審當時的結果。資料授權的 `items`：`[{case_id, case_no, valid_from, valid_to, export_allowed, packages: [{package, fields}]}]`。
- `fulfilment`：`{version, payload, payload_sha256} | null`（核准完成後才有）。資料授權的 payload：`{format: "data_access_rule_set/1", case_no, case_version_no, grantee {type, principal_id, name}, valid {from, to}, export, rules: [{rule_id, system, package, fields, row_filter, data_period}]}`。
- `grant`：`{grant_id, valid_from, valid_to, status} | null`。

### 4.3 每個畫面要用的讀取與動作

畫面依 `actions` 顯示按鈕，不依狀態推斷。

| 畫面 | 讀取 | `actions` 可能出現的值 |
|---|---|---|
| 新申請 | `process_type_list`、`principal_list`、`data_access_catalog`；存草稿後 `case_create` 回傳的 `notices`、`errors`、`overlap` | 草稿：`revise`、`submit` |
| 我的申請 | `case_list_mine` | `revise`、`submit`（草稿、退回）；`recall`（簽核中） |
| 申請單詳情 | `case_get` | 同上 |
| 待辦 | `inbox_list` | `claim`；`approve`、`approve_reduced`、`return`、`reject`；`fulfil` |
| 簽核詳情 | `case_get`（`overlap` 標示重疊、`versions` 標示縮小、`exceptions` 標示例外） | `approve`、`approve_reduced`、`return`、`reject` |
| 執行詳情 | `case_get` 的 `fulfilment.payload`（要交給外部系統的規則） | `claim`、`fulfil` |
| 稽核 | 不變 | — |

### 4.4 新的錯誤代碼

`PROCESS_UNKNOWN`、`POLICY_MISSING`、`REGISTRATION_INVALID`、`CONTENT_INVALID`（detail 是錯誤清單的 JSON）、`PRINCIPAL_REQUIRED`、`PRINCIPAL_UNKNOWN`、`VALIDITY_REQUIRED`、`VALIDITY_ORDER`、`VALIDITY_TOO_LONG`、`VALIDITY_BACKDATED`、`OVERLAP_COVERED`、`OVERLAP_REASON_REQUIRED`、`CHANGE_NOT_REDUCE`、`REASON_REQUIRED`、`NOT_CLAIMABLE`、`NOT_FULFILLER`、`SOD_DISTINCT`、`DECIDER_ROLE_EXCLUDED`、`RECORD_APPEND_ONLY`、`SETTING_UNKNOWN`、`SETTING_SCOPE_INVALID`。不再出現：`NO_APPROVER`（沒有主管改為關卡停住）。`api.error_catalog` 只回 `kind = error` 的；流程包的提示與檢查訊息（`DA-N-*`、`DA-E-*`）已經是組好的文字，畫面直接顯示 `message`。

## 5. 端對端失敗的原因（給下一位）

`web/` 與 `api/` 仍用舊介面：`case_submit_new(session, content)`、`challenge_issue` 三個參數、`approver_name`、狀態 `approved`／`draft`、退回不帶原因、`sgn_e2e` 裡沒有 `probe` 流程類型（只有 `data_access`）。e2e 7 個中 6 個失敗，都卡在送出申請或決定。要改：新申請畫面（流程類型、被授權者、授權起迄、資料範圍元件、提示與錯誤）、簽核詳情（縮小後核准、駁回、原因）、撤回、認領、執行詳情、狀態文字。

## 6. 和契約、骨幹不同的地方

| 項目 | 契約或骨幹 | 現在 | 理由 |
|---|---|---|---|
| 申請單資料表 | 骨幹：`sgn.case_file`、`status` | 沿用 `sgn.request_case`、`state` | 只能新增 migration；改名要重建所有引用的 function |
| hook 的數量與簽章 | 骨幹 6.4：十幾個 hook，id 是 bigint，`normalize_content` 收 `p_actor` | 六個；id 是 uuid；不收 `p_actor`；`validate_content` 併進 `normalize_content` 的 `errors` | 範圍只要求六個；結果不依行為人 |
| hook 執行身分 | 骨幹：`sgn_pack_<代號>` | 擁有者 `sgn_owner`；邊界靠架構測試檢查原始碼 | 這一輪不擴充角色 |
| 撞到同一人 | 骨幹 K-SOD-DISTINCT：保留解析依據最具體的那一關 | 後開的那一關往上一層主管找 | 每關開始時才解析（K-RESOLVE-STAGE-START），先開的關可能已經簽完；範圍 2 也是這樣寫 |
| 群組關卡沒有合格成員 | 骨幹：迴避替代人 → 上一層主管 → top_resolver | 簽核關：最終決定者；執行關：停住 | 「上一層主管」對群組沒有定義；執行要那個系統的管理人 |
| 冷卻期 | 範圍 8：冷卻期內由原主管簽 | 用「最近一條已過冷卻期、且過冷卻期時仍有效」的關係；還沒過冷卻期就被換掉的關係略過；基準之後才有主管的人沒有「原主管」，直接用目前的關係（仍開例外） | 假快照之後又改回時，不能讓攻擊者的關係當「原主管」 |
| 退回後只做縮小 | 骨幹 K-RETURN：重送一律改用最新版路徑 | 路徑沒有新版才從退回那關繼續；有新版就從第一關重簽 | 不同版本的路徑，關卡順序不能對應 |
| 撤回 | 骨幹動作目錄沒寫 | 需要決定證明 | 範圍 5：每個決定都要通行金鑰 |
| K-NO-BACKDATE | 起日不得早於核准完成時間 | 送審時檢查「不早於今天」 | 核准時間不可預知；之後在執行完成時再檢查 |
| 資料擁有者的範圍代碼 | 契約 02：`scope_ref = 主題包代碼` | `data_access:bundle:<代碼>` | 骨幹 1.2 與 seed-directory.md |
| 執行關 | 契約 02：`dc_apply`，MIS 接續 | `fulfil`，`system_custodian` 依主題包所屬系統 | 骨幹附錄 B、seed-directory.md：合規檢查與執行必為不同的人 |
| 執行內容格式 | 契約 02：`dc_rule_set/1` | `data_access_rule_set/1`，每條規則多 `system` | 員工薪資在 `hr_saas`，不經 DC |
| 重疊的 items | 契約 02：`detail` 是組好的文字 | 結構化（主題包與共同欄位、授權起迄、匯出） | 文字由畫面組，訊息不寫死在 SQL |
| 目錄同步 | 契約 02 §4.2：差異、影響、同步紀錄 | 只有 `catalog_load`（種子用），沒有對外入口 | 範圍 3：最小的資料表加種子資料 |
| 登記的生效 | 骨幹 6.1：以待生效的設定變更單進入 | migration 直接生效 | 設定變更流程不在範圍 |
| 單號 | 骨幹：`DA-HQ-2026-000004` | 流水號（bigint） | 不在範圍 |
| 參數值的生效 | 骨幹：可預約、有設定變更單 | `register_setting_value` 立即生效 | 同上 |
| 服務帳號 | seed-directory：`dc-etl-svc` | 沒有載入 | 範圍 3 的被授權者只有團隊、專案、agent |
| `hr_saas` 主要管理人 x01 | seed-directory | 沒有載入（不在 sim-ldap） | 外部人員來源沒做 |

## 7. 殘餘風險

- **找不到人就停住，但沒有恢復的路**：關卡 `halted` 之後沒有重新解析（人事事件、設定補上替代人都不會讓它動）；只能撤回後重送。
- 決定者資格在每次決定時重驗（`decider_denial`），但角色、主管異動不會主動重派進行中的工作。
- hook 以動態 SQL 呼叫：plpgsql_check 檢查不到呼叫點；簽章由登記時檢查。hook 以擁有者身分執行，技術上能寫任何表，只靠架構測試檢查原始碼。
- 重疊只比對有效授權，不比對在途申請單與被駁回的單（K-OVERLAP-REASON 的 partial）。兩張相同的單同時在簽核中，都能生效。
- 授權的有效性只看 `valid_to`；沒有到期、撤銷、收回（範圍外）。`grant_record.status` 只有 `active`。
- 授權起日在送審時檢查，簽核拖過起日時，生效日會早於執行完成日。
- 被拒絕的操作沒有寫 denied 事件（骨幹 K-AUDIT-DENIED）。
- 有幾個 SQL function 超過工程規範的約 80 行（`decision_apply`、`case_submit_draft`、`normalize_content` 附近），沒有自動檢查。
- 通知只寫進 `notification_outbox`，沒有寄送；範本的變數沒有檢查。
- 測試用的「時間經過」是用管理者連線把主管關係的起點往前移，不是假時鐘；有假時鐘之後應改寫。
- 這段期間環境自動做了 `wip:` commit（`db/kernel/100`～`130` 等檔案在 git 裡已被追蹤）；我沒有下 commit 或 push。

## 8. 需要決定的事

1. 撞到同一人時「後開的關往上找」與骨幹「保留最具體的那一關」：要改骨幹，還是要在主管關開始時預先看後面各關？
2. 冷卻期的語意（§6）：新到職、沒有原主管的人，冷卻期內要不要改由上一層主管或最終決定者簽？
3. 撤回需要通行金鑰：申請人每次撤回都要按一次，可接受嗎？
4. 群組關卡沒有合格成員時交給最終決定者（董事長）：資安合規檢查交給董事長合理嗎？還是應該停住？
5. 路徑有新版時，退回後只做縮小也從第一關重簽：可接受嗎？
6. 工程規範第 5 節的 `p_actor` 與骨幹的 `p_session`（promote.md 已提，仍未裁決；這一輪照骨幹）。
7. `db/testing/` 的測試專用流程類型（`probe`、`probe_chain`）：骨幹說 `db/testing/` 是假時鐘等測試專用的 migration，放流程類型是否可以。

## 9. 留給下一位

- 後端與畫面改用新介面（§4、§5），端對端改寫。
- 停住的關卡的恢復（重新解析）、例外的結案流程。
- 執行完成時重檢授權起日；驗證、確認、到期、撤銷、收回（下一輪）。
- 目錄同步的對外入口與影響通知（契約 02 §4.2）。
- 把函式長度、SQL 格式（sqlfluff）納入 `tools/check.sh`。
