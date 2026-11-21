# 規格：功能第五批——急件與續期

狀態：**待實作規格**（2026-11-21）。條文草稿要負責人確認後才貼進 `rules.md`（見 [README.md](README.md) 的彙整表）；本文件不修改任何規則。

依據：`rules.md`「逾時」「修改、退回與撤銷」「加速功能」「預設時限」「環境」；`docs/decision-log.md` D97、D99 (1)、D101；`requester-scenarios.md` 設計 a 選項 A、c-1；骨幹 `K-URGENT`、`K-RENEW`、`K-REUSE`；交接 `docs/handoff/feature-4-deadlines.md` §3 #6、§7。

沿用的入口（不得另寫一套）：時限的唯一計算 `sgn_internal.task_sla_due`／`task_sla_next`（`db/kernel/570_approval_sla.sql`）、排程 `api_job.approval_sla_due`、到期前提醒 `575_expiry_remind.sql`、例外 `exception_open`／`exception_close`、參數 `sgn_internal.setting` 與 `validity_scopes`、顯示摘要 `sgn_internal.case_display`（`display.baseline` 機制）、送審複核 hook `review_submission`、測試報告 `pack_data_access.test_report`、通知範本。

## 1. 範圍與不做的事

做：

| # | 項目 |
|---|---|
| U1 | 申請人在草稿或退回時把單標為急件，必填需要完成時間、原因代碼、事件或工單編號、說明；送審時開一筆例外 |
| U2 | 急件的催辦與升級改讀小時參數；路徑、關卡、職責分離、通行金鑰一律不變 |
| U3 | 申請人或任一位目前的簽核人可以取消急件標示（必填原因），之後照一般時限 |
| U4 | 顯示摘要多一行急件說明，簽核人簽到它；待簽清單急件排最前 |
| R1 | 生效中的授權在到期前的開放期間內，由申請人或被授權者負責人一鍵產生續期草稿：預填前案、起日是前案迄日的隔天 |
| R2 | 續期走完整路徑；簽核畫面以前案為比較基準標示差異 |
| R3 | 正式區的續期以前案本期的使用紀錄產生報告，取代測試區依據 |
| R4 | 到期前提醒的「已續期」改看續期的來源單（取代第四批的近似）；提醒內附「續期」按鈕 |

不做（理由）：

- 先給後補（選項 B）：D99 (1) 裁決不開放，D49 維持。
- 急件比率偵測 `K-DETECT-URGENT-RATE` 的門檻例外：每張急件已開例外（D99 (1)），比率由例外清單統計；之後要再加門檻另議。
- 急件改通知通道（即時推播）：平台沒有分級通道（`K-NOTIFY-DELIVERY` 部分實作），急件用獨立的通知範本，通道照舊。
- 到期後才續期（骨幹 `renewal.max_gap_days`）：裁決「到期前可申請」；到期後是新申請（可沿用前案），不標續期。
- 生效中「沒用到的欄位」持續提醒（D94 (5)）：併入第七批定期複查的風險訊號。
- 批次續期（`batch_kinds = renewal_identical`）：批次核准尚未實作。

## 2. rules.md 條文草稿

**貼在「逾時」小節最後**（新增一點）：

> - 急件：申請人可以把單標為急件，必填需要完成的時間、原因、事件或工單編號。急件的路徑與關卡不變，每關仍要簽，只把催辦與升級的時限改為以小時計（見「預設時限」）。每張急件送審時開一筆例外，稽核看得到。申請人或任一位目前的簽核人可以取消急件標示，必須填原因；取消後照一般時限。

**取代「修改、退回與撤銷」表中「一鍵續期」那一列**：

> | 一鍵續期 | 生效中的授權在到期前 30 天內（參數），申請人或被授權者負責人可以申請續期。續期預填前案，起日是前案迄日的隔天，仍走完整路徑；畫面標示「與前案差異」。正式區的續期以前案本期的使用紀錄產生報告，取代測試區依據。到期後就不算續期，要重新申請。 |

**貼在「環境」第 4 點之後**（新增一點，不改第 4 點原文）：

> - 正式區的續期以前案為依據：前案是同一個被授權者、同一區、仍在生效，就不必再引用測試區單，也不開例外。

**「預設時限」表新增三列**：

> | 急件催辦 | 每關 2 小時未簽 |
> | 急件升級 | 催辦後再 2 小時未簽 |
> | 續期開放期間 | 到期前 30 天內 |

## 3. 資料模型與參數

### 3.1 資料表

| 表 | 欄位 | 只增不改 | 說明 |
|---|---|---|---|
| `sgn.case_urgent`（新，核心） | `id` identity、`case_id`、`kind`（`declared`、`withdrawn`）、`need_by timestamptz`、`reason_code`、`ticket_ref`、`reason_text`、`actor_person_id`、`at`、`event_seq` | 是（`reject_change` trigger 擋 UPDATE、DELETE、TRUNCATE） | 一張單目前是不是急件＝最後一筆是 `declared`。`declared` 只能在 `draft`、`returned`；`withdrawn` 在 `draft`、`returned`、`in_approval` |
| `sgn.urgent_reason`（新，核心代碼表） | `code`、`name`、`requires_text`、`sort_order`、`is_active` | 只經 migration | 種子：`incident`（事故）、`customer`（客訴）、`legal_deadline`（法定期限）、`other`（其他，要說明） |
| `sgn.request_case`（加欄） | `source_case_id uuid references sgn.request_case`、`source_kind text check (source_kind in ('renewal'))` | 建立時寫入，之後不改 | 只能由系統寫（`K-REUSE`）；第六批把 check 擴成含 `supplement` |
| — | 唯一索引 `request_case_renewal_open_idx`：`(source_case_id) where source_kind = 'renewal' and state not in ('rejected','cancelled','expired','revoked')` | — | 同一筆來源同時只有一張進行中的續期 |

急件不是內容的一部分（內容雜湊不變），所以取消急件不產生新版本、不重簽；簽核人簽的顯示摘要裡有急件說明（§3.4）。

### 3.2 參數（`sgn.setting_definition`）

| key | 型別 | 預設 | 界限 | 適用範圍 | 說明 |
|---|---|---|---|---|---|
| `approval.urgent_remind_after_hours` | integer | 2＊ | 1–24 | `process`、`tier` | 急件未簽多久（日曆小時）催辦 |
| `approval.urgent_escalate_after_hours` | integer | 2＊ | 1–24 | `process`、`tier` | 急件催辦後再多久升級 |
| `approval.urgent_notify_roles` | json | `["control_owner"]` | — | `process` | 急件例外的責任角色（稽核另收通知，不當責任人：`K-AUDITOR-INDEPENDENT`） |
| `renewal.open_before_days` | integer | 30＊ | 14–90 | `process`、`tier` | 迄日前幾天（日曆天）開放續期 |

界限：核心沒有 `hard_floor`、`hard_ceiling` 欄位，界限寫進 description，資料庫測試檢查種子值在界限內。急件以**日曆小時**計（見 README 確認項 C1）。`validity.remind_before_days`（14）照舊，提醒落在開放期間內。

### 3.3 流程類型選項

`data_access` 的 `options` 加 `allows_urgent: true`、`renewable: true`（骨幹第 3 節）。核心在 `case_urgent_set`、`case_renew_draft` 檢查選項，沒開就 `URGENT_NOT_ALLOWED`、`RENEW_NOT_ALLOWED`。

### 3.4 顯示摘要

`sgn_internal.case_display` 加 `urgent`：`{need_by, reason (名稱), ticket_ref, reason_text, declared_by, withdrawn: {by, reason, at} | null}`；續期加 `renewal: {source_case_no, source_valid_to}`，並把 `display.baseline` 設為來源單目前版本的顯示（簽核人還沒決定過時）。`web/lib/signing.js` 不改：簽的是整份顯示摘要。

## 4. SQL function、轉移、規則代碼、錯誤代碼

### 4.1 function

migration：`db/kernel/585_urgent.sql`、`db/kernel/590_renewal.sql`、`db/packs/data_access/180_renewal.sql`（只新增檔案，不改已套用的）。

| schema.function | 簽章 | 誰可呼叫 | 規則 |
|---|---|---|---|
| `api.case_urgent_set` | `(p_session text, p_case_id uuid, p_urgent jsonb) returns jsonb`（caseDetail） | 申請人；單在 `draft`、`returned`。`p_urgent` 為 `{need_by, reason_code, ticket_ref, reason_text}`，`null`＝不再標急件（寫 `withdrawn`） | `K-URGENT` |
| `api.case_urgent_withdraw` | `(p_session text, p_case_id uuid, p_reason text) returns jsonb`（caseSummary） | 申請人，或這張單開著的簽核關裡任一件等他決定的工作的指派對象；單在 `in_approval` 且目前是急件 | `K-URGENT` |
| `api.case_renew_draft` | `(p_session text, p_case_id uuid) returns jsonb`（caseDetail） | 來源單的申請人或被授權者目前的負責人；來源 `active`、`valid_to - today ≤ renewal.open_before_days`、`valid_to ≥ today`；已有進行中的續期就回那一張 | `K-RENEW`、`K-REUSE` |
| `sgn_internal.case_is_urgent` | `(p_case_id uuid) returns boolean` stable | 核心內部 | `K-URGENT` |
| `sgn_internal.task_sla_settings`（`create or replace`，同簽章） | 多回 `urgent` 與兩個小時參數 | 核心內部 | `K-URGENT` |
| `sgn_internal.task_sla_due`（`create or replace`，同簽章） | 急件：`remind_at = started_at + 催辦小時`、`escalate_at = remind_at + 升級小時`；一般照舊用工作天 | 核心內部 | `K-URGENT`、`K-SLA-REMIND`、`K-SLA-ESCALATE` |
| `sgn_internal.case_sla`（`create or replace`） | 多回 `urgent`、`waiting_hours` | 核心內部 | `K-SLA-VIEW` |
| `sgn_internal.urgent_on_submit` | `(p_case sgn.request_case) returns void` | 由送審入口（`case_submit`、`case_submit_new` 的共同路徑）在轉移成功的同一個交易呼叫 | `K-URGENT` |
| `sgn_internal.urgent_settle` | `() returns int` | `approval_sla_due` 每一輪最後呼叫：單核准完成（到 `pending_fulfilment` 以後）、駁回、取消，或急件被取消 → 結案 `K-URGENT` 例外，`close_detail` 記結果與實際花的小時數。退回、撤回不結案（同一張單只有一筆例外，重送沿用） | `K-URGENT` |
| `sgn_internal.grant_renewed_by`（`create or replace`，同簽章） | 改為：`source_kind = 'renewal'`、`source_case_id = 這筆授權的單`、狀態不是終局 | 核心內部 | `K-EXPIRE-REMIND` |
| `pack_data_access.review_submission`（`create or replace`，同簽章） | 續期的正式區單：來源是同一個被授權者、同一區、`active` → 視同測試依據，不開 `DA-TEST-EXCEPTION`；報告改用 `test_report(來源單, 內容)`，`purpose = 'renewal'` | 核心經 hook 呼叫 | `DA-RENEW-BASIS` |
| `pack_data_access.test_report_for`（新） | `(p_source uuid, p_content jsonb, p_purpose text) returns jsonb`；`p_purpose` ∈ `prod_basis`、`renewal`（第七批加 `review`、`engagement_close`），只決定區塊標題代碼與適用的警示（`requester-scenarios.md` c-1 的表），計算不變。原 `test_report(p_source, p_content)` 改為呼叫它並帶 `prod_basis`（簽章不變） | 流程包內部 | `DA-RENEW-REPORT` |
急件的欄位檢查（必填；`need_by` 在未來；原因代碼有效；`other` 要說明；工單編號 1–64 字）與領域無關，全部在核心 `case_urgent_set` 做，代碼表在核心，流程包不另寫、不新增 hook。

續期草稿的內容：

1. 內容＝來源單目前版本，先經 `normalize_content` 重新整理（目錄綁到目前版本，同 `K-CONTENT-REBIND` 的做法）。
2. terms：`principal_id` 同來源；`valid_from = 來源 valid_to + 1`；`valid_to = valid_from + 重新分級後的級別上限 − 1 天`。
3. 匯出調查（`170_export_survey.sql`）的答案預填前案，申請人可改；改了照一般判斷擴大或縮小。
4. 事件 `case.renewal_drafted`，帶來源單號、來源版本、規則代碼。

### 4.2 狀態轉移表

不新增申請單狀態與轉移。續期草稿走既有的 `draft → in_approval → …`；急件不碰轉移表。

### 4.3 新規則代碼（登記在 `sgn.rule`）

| 代碼 | 說明 | coverage |
|---|---|---|
| `K-URGENT` | 急件：申請人在草稿或退回時標示，必填需要完成時間、原因代碼、事件或工單編號；路徑不變，催辦與升級改讀小時參數；送審開例外、離開簽核時結案；申請人或目前的簽核人可取消，必填原因 | full |
| `K-RENEW` | 續期：生效中、到期前開放期間內，由申請人或被授權者負責人產生；預填前案、起日為前案迄日隔天、完整路徑、以前案為差異基準；同一來源只有一張進行中的續期；標示只能由系統產生 | full |
| `DA-RENEW-BASIS` | 正式區的續期以前案（同被授權者、同區、生效中）為依據，不必引用測試區單、不開例外 | full |
| `DA-RENEW-REPORT` | 續期的報告由前案本期的使用紀錄產生，送審時凍結；列出沒用到的欄位並建議從續期拿掉 | full |

`K-EXPIRE-REMIND` 的 `coverage` 改為 `full`、`note` 清掉（第四批的近似取消）。

### 4.4 新錯誤代碼（`sgn.error_catalog`）

| code | message | http |
|---|---|---|
| `URGENT_NOT_ALLOWED` | 這種申請不能標急件 | 422 |
| `URGENT_STATE` | 只有草稿或退回的單可以標急件；簽核中只能取消急件 | 409 |
| `URGENT_FIELDS` | 急件要填需要完成的時間（未來的時間）、原因與事件或工單編號；原因選「其他」要寫說明 | 422 |
| `URGENT_NOT_PARTY` | 只有申請人或這張單目前的簽核人可以取消急件 | 403 |
| `URGENT_NONE` | 這張單不是急件 | 409 |
| `URGENT_REASON_REQUIRED` | 取消急件要寫原因 | 422 |
| `RENEW_NOT_ALLOWED` | 這種申請不能續期 | 422 |
| `RENEW_SOURCE_STATE` | 只有生效中、還沒到期的授權可以續期；到期後請重新申請 | 409 |
| `RENEW_TOO_EARLY` | 到期前 %s 天內才能續期 | 409 |
| `RENEW_NOT_PARTY` | 只有原申請人或被授權者的負責人可以續期 | 403 |

通知範本（`sgn.notification_template`）：`case.urgent_declared`（責任角色、稽核：單號、需要完成時間、原因、工單）、`case.urgent_withdrawn`（申請人、目前的簽核人：誰取消、原因）。第四批的催辦、升級範本不另開急件版：`sgn_internal.task_sla_payload`（`create or replace`）多給 `waited`（「3 個工作天」或「2 小時」）與 `urgent_tag`，範本內文改用它們（新 migration 更新範本列）。到期前提醒 `grant.expiry_reminder` 的內文改為附續期連結。

## 5. 路由與畫面

路由表 `packages/contract/src/routes.ts` 的 `routes` 加三筆：`case_urgent_set(session, case_id, urgent)`、`case_urgent_withdraw(session, case_id, reason)`、`case_renew_draft(session, case_id)`。`caseDetail`、`caseSummary` 加 `urgent`（nullable object）、`renewal`（nullable object）；`case_summary.sla` 加 `urgent`、`waiting_hours`。`90-contract` 實際呼叫三個新路由。

| 角色 | 動作 | 步數（390px） | 步驟 |
|---|---|---|---|
| 申請人 | 標急件並送審 | +3 | 新申請頁勾「急件」→ 填需要完成時間、選原因、填工單編號 → 送審（說明欄只在「其他」出現） |
| 簽核人 | 看出急件 | 0 | 待簽清單卡片有「急件」標籤與「還剩 N 小時」，急件排最前（再依逾期、等最久） |
| 簽核人 | 取消急件 | 2 | 單的頁面按「取消急件」→ 寫原因送出（不用通行金鑰） |
| 申請人或負責人 | 續期 | 2＋一般送審 | 首頁「快到期」區塊或提醒信的連結按「續期」→ 草稿已預填，檢查差異後送審 |
| 簽核人 | 看續期差異 | 0 | 單的頁面最上方是「與前案差異」與報告警示（沿用 `diff.js`） |

文案 key 加在 `web/i18n.js`（`urgent.*`、`renewal.*`）；按鈕依 `case_summary.actions` 顯示（加 `urgent_withdraw`、`renew`），頁面不自行判斷。觸控目標 44px，390px 不水平捲動（`ux-acceptance.md`）。

## 6. 測試清單

資料庫測試 `db/tests/packs/data_access/89-urgent-renewal.test.mjs`（假時鐘）：

| 規則代碼 | 測試 |
|---|---|
| `K-URGENT` | 標急件缺欄位、`need_by` 在過去、原因 `other` 沒說明 → `URGENT_FIELDS`；`in_approval` 標急件 → `URGENT_STATE` |
| `K-URGENT` | 送審後開一筆 `K-URGENT` 例外，通知責任角色與稽核；退回再送審不重開第二筆（同一段簽核只一筆） |
| `K-URGENT` | 2 小時後 `approval_sla_due` 催辦、再 2 小時升級給上一層主管；事件記小時參數值；一般單同時刻不催 |
| `K-URGENT` | 升級後仍守 `K-SOD-DISTINCT`、`K-SLA-STALLED`（沿用 87 的情境改成急件跑一次） |
| `K-URGENT` | 簽核人取消急件 → 下一步改用工作天計；非當事人取消 → `URGENT_NOT_PARTY`；取消要原因 |
| `K-URGENT` | 單核准完成、駁回後，下一輪 `urgent_settle` 結案例外並記實際小時數；退回時不結案 |
| `K-URGENT` | 急件不改內容雜湊；顯示摘要有急件行，簽核人的通行金鑰簽到它（後端換掉急件行 → `SIGNED_CONTENT_MISMATCH`） |
| `K-RENEW` | 開放期間外 → `RENEW_TOO_EARLY`；來源到期或撤銷 → `RENEW_SOURCE_STATE`；別人 → `RENEW_NOT_PARTY` |
| `K-RENEW` | 草稿預填、起日＝前案迄日隔天、迄日依目前上限；重按回同一張；`source_kind` 無法由 `case_create`、`case_revise` 寫入 |
| `K-RENEW` | 續期走完整路徑（L4 有資安長）；`display.baseline` 是前案；續期加欄位 → `change_kind = expand` |
| `K-RENEW` | 重疊檢查不把來源單當完全涵蓋；續期生效後來源照原迄日到期 |
| `DA-RENEW-BASIS` | 正式區續期不開 `DA-TEST-EXCEPTION`；來源不同區或不同被授權者 → 照一般要求 |
| `DA-RENEW-REPORT` | 報告來自來源單的使用紀錄、送審凍結、雜湊進內容；沒用到的欄位列出 |
| `K-EXPIRE-REMIND` | 有進行中的續期就不提醒；續期被駁回之後仍在提醒期間 → 補提醒 |

端對端 `e2e/tests/system-zz-urgent-renewal.test.mjs`：(1) 申請人在 390px 標急件送審，假時鐘前進 4 小時，主管收到升級前的催辦、上一層主管收到升級，用通行金鑰簽完，例外在稽核頁可見並結案；(2) 生效中的單進入開放期間，負責人從首頁按續期、送審、走完整路徑、確認驗證，前案到期後續期仍生效。

## 7. 威脅小表

| 誰 | 想做什麼 | 怎麼擋 | 殘餘 |
|---|---|---|---|
| 申請人 | 把一般需求都標急件，逼簽核人在手機上草率簽 | 路徑不變、每關要通行金鑰簽完整顯示摘要；每張急件都是例外；簽核人可取消 | 例外量大時控制負責人可能不看；比率門檻沒做 |
| 申請人 | 利用升級讓特定主管簽 | 升級對象由主管 resolver 決定（已過冷卻期），急件只縮短時間 | 同第四批 §4.1：同步帳號被濫用時可挑主管，急件讓時間窗更短 |
| 後端 | 換掉顯示的急件說明或把一般單偽裝成急件 | 急件欄位只由資料庫寫、顯示摘要由資料庫產生並被簽到 | — |
| 簽核人 | 取消急件讓別人的單變慢 | 取消要原因、寫事件、通知申請人；只改時效 | 惡意取消只能事後看 |
| 申請人 | 用續期偷偷擴大 | 續期走完整路徑；預填以外的變動由 `compare_content` 判斷，擴大照一般重簽；差異在最上方 | — |
| 申請人 | 提早續期把授權拉長 | 開放期間只有到期前 30 天；起日固定為前案迄日隔天；上限依起日算 | 交付不帶起日：續期核准後到起日前，使用方已套用續期的規則（既有性質，見 §8 #3）；最多提早 30 天 |
| 排程停擺 | 急件不催不升級 | 心跳 `K-PROGRAM-STALLED`；`overdue_work` 照舊列出 | 停擺期間急件仍可簽，只是沒有催辦 |

## 8. 接點、可能衝突、開放問題

| # | 接點或衝突 | 處理 |
|---|---|---|
| 1 | `task_sla_due` 是唯一的時限計算；急件在這裡分支，`case_sla`、`overdue_work` 自動跟著 | 只改這一處，不在排程另寫 |
| 2 | 第四批「每件工作只催一次」：急件同樣只催一次 | 照舊 |
| 3 | 起日在未來的授權，交付不帶起日（`build_delivery` 沒有 `not_before`），核准後即套用 | 既有性質，非本批引入；續期把它限制在 30 天內。記為殘餘，若要擋需交付格式加起日（02 §8.8），另議 |
| 4 | 骨幹 `K-RENEW` 允許到期後 `renewal.max_gap_days` 內續期 | 依裁決只做到期前；骨幹 5.4 的現況註記要寫明 |
| 5 | 被授權者負責人可產生續期，但申請人是他自己（不是原申請人） | 申請人＝按下的人；負責人自己申請時不加負責人確認關（既有規則） |
| 6 | 續期期間來源單被撤銷或縮小 | 續期不受影響（它是獨立的單）；來源撤銷後續期照常簽，`DA-RENEW-BASIS` 在送審時判斷，送審後不重判 |

開放問題（只有負責人知道的事實）：無。需要負責人確認的取捨見 README 的 C1（日曆小時或工作時段）、C2（續期開放 30 天）。
