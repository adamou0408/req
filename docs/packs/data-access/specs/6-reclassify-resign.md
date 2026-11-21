# 規格：功能第六批——分級調高的補簽與自動縮小

狀態：**待實作規格**（2026-11-21）。條文草稿要負責人確認後才貼進 `rules.md`；本文件不修改任何規則。

依據：`docs/decision-log.md` D95 (1)(2)、D97 (2)、D99 (a)(b)；`requester-scenarios.md` 第 3 節（補簽單）與設計 e；骨幹 `K-REAPPROVE`、`K-CHANGE-EXPAND`、`K-GRANT-REDUCE`、`K-SOD-DISTINCT`。

沿用的入口：目錄改版 `pack_data_access.catalog_record` → `catalog_drift`（`130_catalog_version.sql`）、簽核中的重新綁定 `sgn_sdk.case_rebind`（`540`）、帶期限例外 `exception_open_due`、縮小交付 `grant_reduce_deliver`（`565`）、撤銷 `grant_end`（含待套用、驗證中的交付撤回，`480`）、關卡適用 `sgn_internal.stage_applies`（`160`）、決定者資格 `decider_denial`／`resolve_eligible`（`150`、`360`）、時限 `approval_sla_due`（第四批，補簽單照一般時限）、測試報告 `test_report_for`（第五批）。

## 1. 範圍與不做的事

做：

| # | 項目 |
|---|---|
| T1 | 核心的「補簽單」：引用來源單、只開來源單缺的關卡、職責分離跨兩張單計算、不能退回、逾期取消 |
| T2 | 目錄改版時，生效中的單有欄位在該區分級調高：算出新級別、調高的欄、缺的關卡、新級別帶來的自動縮小 |
| T3 | 有缺的關卡 → 建補簽單並開帶期限的例外 `DA-TIER-RAISED`；寬限期內原核准的那一版繼續有效 |
| T4 | 補簽核准 → 來源單換成補簽的那一版（新版本、重新交付、重新驗證）；駁回或逾期 → 只拿掉調高的欄，拿掉後沒有欄位就撤銷 |
| T5 | 沒有缺的關卡但有自動縮小（不可匯出、期限上限較短）→ 直接系統縮小，免簽、通知 |
| T6 | 待套用、驗證中的單遇到要補關卡的調高 → 系統撤銷並為申請人建預填的新草稿 |
| T7 | 原本自動給（L1、L2）的欄位調成 L3 以上：通知使用方停止自動給（D99 (a)），通知最近用過那一欄的被授權者負責人改走申請 |
| T8 | 偵測：同一欄調低後短期內又調高（`DA-DETECT-TIER-FLIP`） |

不做：

- 分級調低：縮小只需通知（③），不處理；只列入 T8 的偵測。
- 寬限期內暫停調高的欄（欄位層級暫停）：D99 (a) 裁決寬限期內照用。
- 待套用、驗證中的單在**沒有**缺關卡時的目錄改版：維持現況（開 `DA-CATALOG-DRIFT`，交付由 `DA-CATALOG-MISMATCH` 擋下），D95 (2) 的殘餘不在這批。
- 骨幹 `K-REAPPROVE` 的「依新級別的路徑重新核准、逾期撤銷」：D97 (2)、D99 (b) 以「補缺的關卡、逾期只縮掉那一欄」取代。

## 2. rules.md 條文草稿

**新增一節，貼在「修改、退回與撤銷」之後**：

> ### 分級調高
>
> （D97 (2)、D99。）
>
> - 生效中的授權遇到資料目錄把某欄在該區的分級調高：系統依新級別找出原本沒有簽過的關卡（例如 L3 調為 L4 時補資安長），開一張補簽單，期限內（預設 30 天，L4 14 天，參數）補簽。補簽的是依新目錄與新級別整理後的那一版；新級別不能匯出或期限上限較短時，一併縮小。
> - 補簽期間，原核准的那一版繼續有效。補簽人可以核准、縮小後核准或駁回，不能退回。期限內沒有補簽完或被駁回，系統自動把分級調高的欄位從授權拿掉，其餘欄位、期限與匯出照原核准；拿掉後沒有欄位就撤銷。
> - 不需要補關卡的調高，只做縮小或更新目錄版本，免簽、通知。
> - 還沒生效（待套用、驗證中）的單遇到需要補關卡的調高：系統撤銷這張單，替申請人建一張預填的新草稿，重送時從第一關簽。
> - 原本自動給的欄位（L1、L2）調成 L3 以上：使用方立即停止自動給，系統通知最近用過那一欄的被授權者負責人改走申請。
> - 補簽單的每一關也要和來源單上的申請人、簽核人都是不同的人（原則 ②）。

**「預設時限」表新增一列**：

> | 分級調高的補簽期限 | 30 天；L4 14 天 |

**原則 ③ 的說明**：條文需要負責人確認「分級調高不是申請人的擴大」，見 README 確認項 C3。

## 3. 資料模型與參數

### 3.1 資料表

| 表 | 欄位 | 只增不改 | 說明 |
|---|---|---|---|
| `sgn.request_case`（改 check） | `source_kind in ('renewal', 'supplement')` | — | 第五批加的欄位；補簽單的 `source_case_id` 是來源單 |
| `sgn.case_supplement`（新，核心） | `supplement_case_id uuid primary key`、`source_case_id`、`source_version int`（建立時來源單的版本）、`rule_code`、`due_at timestamptz`、`exception_id`、`missing_stages text[]`、`detail jsonb`（調高的欄、新舊級別、自動縮小、參數值）、`created_at`、`event_seq` | 是 | 一張來源單同時只有一張開著的補簽單（唯一索引在 `request_case` 用 `source_kind = 'supplement'` 加狀態條件） |
| `sgn.case_supplement_outcome`（新，核心） | `supplement_case_id primary key`、`outcome`（`approved`、`rejected`、`expired`、`cancelled`）、`source_action`（`apply`、`reduce`、`revoke`、`none`）、`source_version_after int`、`at`、`event_seq` | 是 | 每張補簽單一筆終局 |
| `pack_data_access.tier_raise`（新，流程包） | `id`、`case_id`、`catalog_version_from`、`catalog_version_to`、`environment`、`fields jsonb`（`[{package, field, from_tier, to_tier}]`）、`old_tier`、`new_tier`、`handling`（`supplement`、`reduce`、`revoke_redraft`、`none`）、`supplement_case_id`、`at`、`event_seq` | 是 | 每次目錄改版對每張受影響的單一筆；`DA-DETECT-TIER-FLIP` 從這裡與目錄版本歷程判斷 |

`sgn.policy_stage.applies_when` 增加一個運算子：`{"missing_on_source": true}`（骨幹 6.3 的條件式集合；不是程式判斷）。

### 3.2 流程類型與路徑（流程包登記，`db/packs/data_access/190_tier_raise.sql`）

- 流程類型 `data_access_supplement`（名稱「資料授權補簽」）：`uses_principal true`、`has_validity false`、`overlap_check false`、`requires_fulfilment false`、`allows_urgent false`、`renewable false`；hooks 同 `data_access` 的 `normalize_content`、`classify_tier`、`compare_content`、`stage_scopes`、`display_content`，另加 `on_supplement_closed`。
- 路徑：與 `data_access` 相同的四個簽核關（`manager`、`data_owner`、`ciso`、`mis`），每關 `applies_when = {"missing_on_source": true}`；沒有執行關。`top_resolver_role` 同 `data_access`。
- `data_access` 的 `options` 加 `supplement_process_type: "data_access_supplement"`，核心建補簽單時依此找流程類型。

`missing_on_source` 的判斷（核心 `stage_applies_for`）：以補簽單的級別評估**來源單路徑**同代碼關卡原本的 `applies_when`（`tier_in` 等），成立、而且來源單目前生效的那一版的簽核過程中這個代碼沒有完成（`done`）的關卡 → 這一關適用。

### 3.3 參數

| key | 型別 | 預設 | 界限 | 適用範圍 | 說明 |
|---|---|---|---|---|---|
| `grant.reapproval_grace_days`（核心，新登記） | integer | 30＊ | 1–60 | `process`、`tier` | 補簽期限（日曆天），從目錄改版時起算 |
| 值：`grant.reapproval_grace_days` @ `tier:data_access:L4` | — | 14＊ | — | — | 流程包初始值（D99 (a)） |
| `detector.DA-DETECT-TIER-FLIP.window_days` | integer | 90＊ | 7–365 | `process` | 調低後幾天內又調高算翻轉 |
| `data_access.auto_field_notify_lookback_days` | integer | 30＊ | 1–180 | — | T7：多久內用過那一欄的被授權者要通知 |

期限照骨幹 `K-VALIDITY-READTIME`：逾期縮小以邏輯到期時間為準；排程停擺不順延。每次縮小把參數值記進事件。

## 4. SQL function、轉移、規則代碼、錯誤代碼

migration：`db/kernel/595_supplement.sql`、`db/packs/data_access/190_tier_raise.sql`。

### 4.1 function

| schema.function | 簽章 | 誰可呼叫 | 規則 |
|---|---|---|---|
| `sgn_sdk.supplement_missing_stages` | `(p_source_case_id uuid, p_tier text) returns text[]` stable | 流程包 | `K-SUPPLEMENT` |
| `sgn_sdk.supplement_open` | `(p_source_case_id uuid, p_content jsonb, p_rule_code text, p_detail jsonb, p_due_at timestamptz) returns uuid` | 流程包（目錄改版的交易內） | `K-SUPPLEMENT` |
| `sgn_internal.supplement_open` | 同上 | 核心：建單（申請人＝來源單申請人、`source_kind = 'supplement'`、terms 同來源）、寫 `case_supplement`、開帶期限例外（`p_rule_code`，責任角色同 `grant.owner_reassign_roles`）、以送審的內部路徑直接進 `in_approval` 並解析第一個適用關卡；沒有適用關卡 → `SUPPLEMENT_NOTHING_MISSING` | `K-SUPPLEMENT` |
| `sgn_internal.stage_applies_for` | `(p_case sgn.request_case, p_stage sgn.policy_stage) returns boolean` stable | 核心：取代各呼叫端的 `stage_applies(p_stage, p_tier)`（`create or replace` 呼叫端）；`tier_in` 照舊，加 `missing_on_source` | `K-SUPPLEMENT` |
| `sgn_internal.decider_denial`（`create or replace`，同簽章） | 補簽單：來源單的申請人與來源單所有已決定的人（簽核、執行、負責人確認）也算「本單其他關」 | 核心 | `K-SUPPLEMENT`、`K-SOD-DISTINCT` |
| `sgn_internal.denial_reason`（`create or replace`，case 版，同簽章） | 補簽單的 `return`、`recall` → `SUPPLEMENT_NO_RETURN` | 核心 | `K-SUPPLEMENT` |
| `sgn_internal.supplement_close` | `(p_supplement_case_id uuid, p_outcome text) returns void` | 核心：最後一關核准（`finish_approval_final` → `completed`）、駁回、逾期、取消時呼叫；呼叫 hook `on_supplement_closed` 取得處置，再由核心執行（hook 不改核心資料表） | `K-SUPPLEMENT` |
| hook `on_supplement_closed`（新，`sgn.hook_definition`） | `(p_source_case_id uuid, p_supplement_case_id uuid, p_outcome text) returns jsonb`：`{"action": "apply"\|"reduce"\|"revoke"\|"none", "content", "terms", "reason_code", "detail"}` | 核心呼叫；沒登記＝`none` | `K-SUPPLEMENT` |
| `sgn_internal.grant_redeliver` | `(p_case sgn.request_case, p_actor uuid, p_reason text, p_rules jsonb) returns void` | 核心：`grant_reduce_deliver` 的本體抽出，事件規則由參數決定；`grant_reduce_deliver` 改為呼叫它（行為不變） | `K-GRANT-REDUCE`、`K-SUPPLEMENT` |
| `sgn_internal.supplement_apply` | `(p_source sgn.request_case, p_supplement_case_id uuid) returns void` | 核心：來源單 `supplement_apply` 轉移、寫新版本（補簽單最後核准的那一版內容與 terms）、`grant_redeliver`；驗證照縮小的路線（自動驗證，不需申請人再確認） | `K-SUPPLEMENT` |
| `sgn_internal.supplement_due` ／ `api_job.supplement_due` | `() returns jsonb` | 排程（`sgn_scheduler`）：`due_at` 已過的補簽單 `supplement_expire` → `supplement_close(…, 'expired')`；來源單已到期或撤銷的開著的補簽單 `supplement_cancel` | `K-SUPPLEMENT` |
| `pack_data_access.tier_raise_assess` | `(p_case_id uuid, p_content jsonb, p_from int, p_to int) returns jsonb` stable | 流程包：重新整理內容、`classify_tier`、逐欄比較該區分級、缺的關卡、自動縮小（`data_access.export_requestable`、`validity.max_months` 依新級別） | `DA-TIER-RAISED` |
| `pack_data_access.catalog_drift`（`create or replace`，同簽章） | 生效中：先 `tier_raise_assess`，依 §4.2 的表處理，再照舊判斷 `DA-CATALOG-DRIFT`；待套用、驗證中：要補關卡就 `revoke_redraft`；回傳多 `supplements`、`reduced`、`redrafted` | 流程包 | `DA-TIER-RAISED`、`DA-TIER-RAISE-RESIGN` |
| `pack_data_access.on_supplement_closed` | 同 hook | approved → `apply`；rejected、expired → 來源內容拿掉調高的欄（綁新目錄），剩下沒有欄位 → `revoke`，否則 `reduce`；cancelled → `none` | `DA-TIER-RAISE-SHRINK` |
| `pack_data_access.auto_field_raised` | `(p_to int, p_fields jsonb) returns int` | 流程包（`catalog_record` 內）：T7 的通知與例外 | `DA-AUTO-FIELD-RAISED` |
| `pack_data_access.tier_flip_check` | `(p_to int) returns int` | 流程包（`catalog_record` 內） | `DA-DETECT-TIER-FLIP` |

`case_display` 對補簽單多三行（資料庫產生、被簽到）：「分級調高：『主題包／欄位』在○○區從 L3 調為 L4（目錄第 N 版，雜湊前 12 碼）」、「補簽的是單號 ○○ 的第 V 版；原核准的那一版在 ○○ 前繼續有效」、「期限內未核准或被駁回，系統會在 ○○ 移除：『欄位清單』，其餘不變」；並附來源單本期的使用報告（`test_report_for(來源單, 內容, 'renewal')`）。來源單的 `case_summary` 加 `supplement`：`{case_no, due, fields, missing_stages}`。

### 4.2 目錄改版時對每張單的處理

| 單的狀態 | 情形 | 處理 | 規則 |
|---|---|---|---|
| `active` | 有缺的關卡 | `supplement_open`（內容＝綁新目錄＋自動縮小）；寬限期內原版照用 | `DA-TIER-RAISED` |
| `active` | 已有開著的補簽單又調高 | 用新內容 `case_rebind` 那張補簽單（從它的第一關重簽），期限不延長 | `DA-TIER-RAISED`、`K-CONTENT-REBIND` |
| `active` | 沒有缺的關卡、有自動縮小 | 系統 `K-GRANT-REDUCE`（行為人＝系統，事件寫規則代碼與參數值），通知 | `DA-TIER-RAISED` |
| `active` | 沒有缺的關卡、沒有縮小 | 現況（`DA-CATALOG-DRIFT`） | — |
| `pending_fulfilment`、`verifying` | 有缺的關卡 | `grant_end('revoked', …, 'DA-TIER-RAISED')`（交付撤回），再為申請人建預填草稿（內容綁新目錄；事件記來源單號） | `DA-TIER-RAISED` |
| `pending_fulfilment`、`verifying` | 沒有缺的關卡 | 現況 | — |
| `in_approval` | 任何 | 現況（`case_rebind` 從第一關重簽，依新級別） | `K-CONTENT-REBIND` |
| 任何 | 只有另一區的分級變了 | 不處理（依單的環境判斷） | — |

### 4.3 狀態轉移表（`entity = 'case'`）

| from | action | to | 用途 |
|---|---|---|---|
| `in_approval` | `supplement_expire` | `cancelled` | 補簽單逾期 |
| `in_approval` | `supplement_cancel` | `cancelled` | 來源單已終止 |
| `active` | `supplement_apply` | `active` | 來源單換成補簽核准的那一版 |

補簽單的核准完成走既有的 `finish_approval_final → completed`。動作目錄：三個動作 `actor_rule = 'system'`。

### 4.4 新規則代碼

| 代碼 | 說明 |
|---|---|
| `K-SUPPLEMENT` | 補簽單：引用來源單；只開來源單在新級別下應有而沒簽過的關卡；每關不同人跨兩張單計算；不能退回或撤回；逾期或來源終止時取消；終局時依流程包的處置換版、縮小或撤銷來源單 |
| `DA-TIER-RAISED` | 目錄改版使生效中的單在其環境的欄位分級調高：缺關卡就建補簽單並開帶期限例外；沒缺關卡只做自動縮小；未生效的單撤銷並建預填草稿 |
| `DA-TIER-RAISE-RESIGN` | 補簽的內容是依新目錄與新級別整理並自動縮小後的那一版；寬限期內原版有效；顯示摘要寫明調高的欄、期限與逾期的後果 |
| `DA-TIER-RAISE-SHRINK` | 補簽駁回或逾期：只拿掉調高的欄，其餘照原核准；拿掉後沒有欄位就撤銷 |
| `DA-AUTO-FIELD-RAISED` | 自動給的欄位調成 L3 以上：開例外給控制負責人，通知用過那一欄的被授權者負責人改走申請 |
| `DA-DETECT-TIER-FLIP` | 同一欄在視窗內先調低再調高：開例外給控制負責人，稽核收通知 |

骨幹 `K-REAPPROVE` 不登記（由 `K-SUPPLEMENT` 加上面四條取代；骨幹 5.5 的現況註記寫明）。

### 4.5 新錯誤代碼

| code | message | http |
|---|---|---|
| `SUPPLEMENT_NO_RETURN` | 補簽單不能退回或撤回；不同意請駁回（系統會移除分級調高的欄位） | 409 |
| `SUPPLEMENT_NOTHING_MISSING` | 來源單沒有需要補簽的關卡 | 500 |
| `SUPPLEMENT_SOURCE_STATE` | 來源單已不在生效中，補簽單已取消 | 409 |

通知範本：`data_access.tier_raised`（申請人、被授權者負責人：欄位、期限、逾期後果；資料擁有者：知會）、`data_access.tier_raise_applied`、`data_access.tier_raise_shrunk`（申請人、負責人、擁有者、系統管理人）、`data_access.tier_raise_redrafted`、`data_access.auto_field_raised`。補簽人的待簽通知走一般的關卡開啟通知。

## 5. 路由與畫面

不新增路由：補簽單是一般的申請單（`case_get`、`inbox_list`、`challenge_issue`、`case_decide_passkey`）。`caseSummary`、`caseDetail` 加 `supplement`（nullable：來源單看到的補簽狀態）與 `source`（nullable：`{case_no, kind}`）；`actions` 對補簽單不給 `return`。排程路由表 `schedulerCalls` 加 `supplement_due`。

| 角色 | 動作 | 步數（390px） | 步驟 |
|---|---|---|---|
| 補簽人（例如資安長） | 補簽 | 0＋一般決定 | 待簽清單出現「補簽」標籤的單 → 單的頁面最上方是三行說明與使用報告 → 核准、縮小後核准或駁回（通行金鑰） |
| 申請人、負責人 | 知道發生了什麼 | 0 | 收到通知；「我的申請」的來源單卡片顯示「補簽中，○○ 前」與會被移除的欄位 |
| 申請人 | 未生效的單被撤銷後重送 | 2 | 首頁「已為你建立草稿」→ 檢查後送審 |

## 6. 測試清單

資料庫測試 `db/tests/packs/data_access/89a-tier-raise.test.mjs`（載入兩版目錄、假時鐘）：

| 規則代碼 | 測試 |
|---|---|
| `K-SUPPLEMENT` | L3 單某欄調成 L4：補簽單只開 `ciso` 關（主管、擁有者、MIS 不開）；`case_supplement` 一筆；`source_kind` 無法由 api 寫入 |
| `K-SUPPLEMENT` | 資安長恰好是來源單的主管關簽核人 → 不能簽補簽單，照角色關卡順序找替代並開 `K-SOD-ROLE-ESCALATED` |
| `K-SUPPLEMENT` | 補簽人退回 → `SUPPLEMENT_NO_RETURN`；申請人撤回 → 同 |
| `K-SUPPLEMENT` | 來源單在寬限期內被撤銷 → 下一輪 `supplement_due` 取消補簽單，`outcome = cancelled` |
| `K-SUPPLEMENT` | 補簽單照一般時限催辦與升級（`approval_sla_due`） |
| `DA-TIER-RAISED` | 待套用的單調高 → 撤銷、交付撤回、申請人有預填草稿；驗證中的單同 |
| `DA-TIER-RAISED` | L4 單某欄 L3 → L4（沒有缺的關卡）→ 不建補簽單；另一區的分級變了 → 不處理 |
| `DA-TIER-RAISED` | 新級別不可匯出：補簽內容已關匯出；新級別上限較短：迄日已縮短 |
| `DA-TIER-RAISED` | 寬限期內第二次調高 → 同一張補簽單重新綁定、期限不變 |
| `DA-TIER-RAISE-RESIGN` | 顯示摘要有三行說明與報告雜湊；後端換掉顯示 → `SIGNED_CONTENT_MISMATCH`；寬限期內調高的欄 DC 仍查得到 |
| `DA-TIER-RAISE-RESIGN` | 核准 → 來源單新版本、級別 L4、重新交付、驗證通過；例外結案 |
| `DA-TIER-RAISE-SHRINK` | 駁回 → 來源單只少那一欄、其餘不變、DC 驗證那一欄查不到；逾期同；只有那一欄的單 → 撤銷 |
| `DA-TIER-RAISE-SHRINK` | 事件記 `grant.reapproval_grace_days` 的值（L4 為 14） |
| `DA-AUTO-FIELD-RAISED` | L2 欄位調成 L3：例外一筆，30 天內用過那一欄的被授權者負責人收到通知 |
| `DA-DETECT-TIER-FLIP` | 調低再於 90 天內調高 → 例外；超過視窗 → 不開 |

架構測試：`policy_stage.applies_when` 只出現登記過的運算子；`case_supplement`、`case_supplement_outcome`、`tier_raise` 擋 UPDATE、DELETE、TRUNCATE。

端對端 `e2e/tests/system-zz-tier-raise.test.mjs`：生效中的 L3 單 → 以目錄載入工具把一欄改成 L4 → 資安長在 390px 從待簽清單補簽（通行金鑰）→ DC 的規則換成新版本並驗證；第二張單讓假時鐘越過 14 天 → DC 上那一欄查不到、其餘欄位可查。

## 7. 威脅小表

| 誰 | 想做什麼 | 怎麼擋 | 殘餘 |
|---|---|---|---|
| 目錄維護者 | 先調低讓單簽過，再調回賺寬限期 | 目錄只經 migration 載入、有版本；`DA-DETECT-TIER-FLIP` | 寬限期內照用（D99 接受的風險），L4 只有 14 天 |
| 補簽人 | 故意不簽，讓系統替他縮小、不留表態 | 逾期也是例外、照一般時限催辦升級，升級對象可簽 | 結果是縮小（從嚴），不會放大 |
| 來源單的簽核人 | 再當補簽人，同一人簽兩關 | `decider_denial` 跨兩張單計算 | — |
| 後端 | 把補簽單偽裝成一般單或改顯示 | 補簽單只能由核心從目錄改版的交易建立；顯示由資料庫產生並被簽到 | — |
| 申請人 | 寬限期內大量查看調高的欄 | 補簽畫面附使用報告；L4 寬限較短 | 已看過的收不回 |
| 使用方系統 | 不套用縮小 | 既有交付重送、卡住例外 `K-DELIVERY-STUCK`、對帳 | 同既有 |
| 使用方系統 | L1、L2 欄位調高後不停止自動給 | 平台沒有那些存取的單，只能通知與開例外；對帳看不到 | 依賴 DC 的自動給規則，見開放問題 Q1 |

## 8. 接點、可能衝突、開放問題

| # | 接點或衝突 | 處理 |
|---|---|---|
| 1 | rules.md 原則 ③「任何擴大都從第一關重簽」、骨幹 `K-CHANGE-EXPAND`「級別升高一律視為擴大」 | D97 (2) 的取捨；條文要負責人確認（C3） |
| 2 | 骨幹 `K-NO-REGRESS`：待套用、驗證中的單不能回到簽核 | 改用撤銷＋預填草稿，不新增倒退的轉移 |
| 3 | 第四批「被授權者不能用時擋下核准」 | 補簽單同樣擋下；逾期照縮小（從嚴） |
| 4 | 第五批續期：來源單有補簽單時申請續期 | 續期內容綁新目錄、依新級別走完整路徑，與補簽單互不影響；續期生效不取消補簽單 |
| 5 | 第七批定期複查：「分級調高過」是風險訊號 | 讀 `pack_data_access.tier_raise` |
| 6 | 來源單在補簽期間被申請人縮小（`case_reduce`） | 縮小照做；開著的補簽單以縮小後的內容重新綁定（期限不變）；縮小後已不含調高的欄 → 補簽單取消 |
| 7 | `stage_applies` 換成 `stage_applies_for` 會動到所有解析路徑 | 只新增運算子，`tier_in` 行為不變；既有 `76-flow`、`20-flow` 全過才算完成 |

開放問題（只有負責人知道的事實）：

- Q1：DC 對 L1、L2 欄位的「依規則自動給」是 DC 自己的政策，還是平台交付的規則？若是 DC 自己的，目錄調成 L3 時誰負責在 DC 上停掉、多快？建議：由 MIS 在 DC 上以目錄版本為準自動停止（目錄版本已是交付的一部分），平台的通知只是提醒。
