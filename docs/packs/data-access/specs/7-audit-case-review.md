# 規格：功能第七批——查核案與定期複查

狀態：**待實作規格**（2026-11-21）。條文草稿要負責人確認後才貼進 `rules.md`；本文件不修改任何規則。

依據：`docs/decision-log.md` D99 (3)(4)(a)、D101；`requester-scenarios.md` 設計 b、c-2；骨幹 `audit_engagement`、`access_review_campaign`、`access_review_item`、`K-REVIEW-CYCLE`、`K-REVIEW-FREEZE`、`K-REVIEW-NORESPONSE`、`K-REVIEW-SOD`、`K-SOD-BENEFICIARY`、`K-AUDITOR-INDEPENDENT`。

沿用的入口：通行金鑰簽資料庫產生的顯示摘要（`signing_challenge`、`signature_verify`，同 `principal_owner_accept_passkey` 的做法）、轉移表 `sgn.state_transition`（新 `entity`）、主管 resolver `resolve_manager`、角色持有人 `role_holders`、範圍角色解析與撞到時找同角色其他人（`360_role_stage_alternate.sql`）、例外 `exception_open_due`、縮小 `grant_redeliver`（第六批）、撤銷與到期 `grant_end`、被授權者結束 `principal_end_due`（第四批）、送審複核 hook `review_submission`、報告 `test_report_for`（第五批）、使用摘要與閒置 `K-USAGE-IDLE`、營業日 `add_workdays`。

## 1. 範圍與不做的事

做：

| # | 項目 |
|---|---|
| A1 | 查核案（核心實體）：內部稽核與會計師查核由稽核主管提出、稽核治理人核准；法遵查核由法遵或法務主管提出、另一方核准；都用通行金鑰 |
| A2 | 查核案核准後系統建立專案被授權者（負責人＝查核案負責人、結束日＝查核期間迄日） |
| A3 | 使用情境「稽核或法遵查核」只能在引用有效查核案、申請人是成員、被授權者是它的專案時選；範圍、資料期間、迄日受查核案框住；正式區免測試區依據 |
| A4 | 路徑不變，資料擁有者留在路徑上；任一關退回或駁回，原因自動送查核案負責人（D99 (4)） |
| A5 | 查核案到期或提前結案：引用它的授權一起失效，產生結案使用報告給負責人與核准人 |
| V1 | 定期複查（核心實體）：每 6 個月建立活動、凍結母體 |
| V2 | 兩段決定：被授權者負責人（仍需要／不需要／縮小）→ 每個主題包的資料擁有者（保留／縮小／撤銷） |
| V3 | 有風險訊號的逐筆決定並填理由；其餘依被授權者分組確認（每組上限 20 筆），沒有全選 |
| V4 | 逾期先升級給複查人的上一層主管，再沒回應就撤銷（D99 (3)） |
| V5 | 活動由控制負責人簽核完成 |

不做：

- 查核案修改或延長：核准後不能改，只能提前結案；要延長或擴大就開新的查核案（引用前案編號）。修改要再一套兩人核准與重新綁定，第一版不值得。
- 查核情境的 L4 匯出：維持不能匯出（D99 (a)）；L3 照一般匯出調查。
- 查核案的成員異動：成員在提出時列出、隨核准固定；要加人就開新案。
- 複查的「暫停」：裁決是撤銷（D99 (3)），授權沒有暫停狀態。
- 複查範圍涵蓋平台角色與 `api_client`（骨幹 `K-REVIEW-CYCLE`）：這批只複查資料授權；角色另議。
- 外部成員、成員異動的風險訊號：第八批才有成員資料，第八批補進 `review_signals`。
- `K-DETECT-ENGAGEMENT-RATE`（查核案頻率偵測）：查核案要兩個治理或控制角色核准，第一版先不做門檻。

## 2. rules.md 條文草稿

**新增一節「稽核與法遵查核」，貼在「需求單」的「重複申請」之前**：

> ### 稽核與法遵查核
>
> （D99 (4)。）
>
> - 使用情境選「稽核或法遵查核」時，必須引用一個有效的查核案，申請人必須是查核案的成員，被授權者是查核案的專案。查核案由稽核主管（內部稽核、會計師查核）或法遵、法務主管（法遵查核）提出，寫明依據文號、範圍（主題包）、資料期間、查核期間與成員；由另一位指定的角色（稽核治理人；法遵與法務互相）以通行金鑰核准。查核案核准後不能修改，只能提前結案。
> - 引用查核案的正式區申請不需要測試區依據，也不開例外；範圍與資料期間不得超出查核案，授權迄日不得晚於查核期間迄日，且最長 30 天（參數）。
> - 簽核路徑與一般申請相同，受查單位的資料擁有者照常簽核。任一關退回或駁回，原因自動通知查核案負責人。查核案負責人不能簽引用它的申請。
> - 查核案結束時，引用它的授權一起失效，系統產生使用報告給查核案負責人與核准人。不能續期。

**「環境」第 4 點之後再加一點**（第五批也在這裡加了續期的一點）：

> - 引用有效查核案的正式區申請不必引用測試區單，也不開例外（見「稽核與法遵查核」）。

**新增一節「定期複查」，貼在「時間規則」之前**：

> ### 定期複查
>
> （D99 (3)。）
>
> - 每 6 個月複查一次生效中的授權：先由被授權者負責人確認仍需要、不需要或縮小，再由每個主題包的資料擁有者決定保留、縮小或撤銷。資料擁有者不能是該授權的申請人或被授權者負責人。「仍需要」與「保留」要用通行金鑰；不需要等於撤銷。30 天內到期的授權不列入決定，由續期取代。
> - 有風險訊號（久未使用、有沒用到的欄位、有被擋下的嘗試、使用方沒有回報、負責人換過、分級調高過、沒有測試紀錄就上線）的逐筆決定並填理由；其餘依被授權者分組確認，每組最多 20 筆，沒有全選。
> - 複查人 15 天內沒有回應，升級給他的上一層主管；再 5 天沒有回應就撤銷，不預設保留。活動由控制負責人簽核完成。

**「預設時限」表新增四列**：

> | 查核情境的授權上限 | 30 天 |
> | 定期複查週期 | 6 個月 |
> | 複查回應時限 | 15 天；升級後再 5 天未回應撤銷 |
> | 查核案期間上限 | 90 天 |

## 3. 資料模型與參數

### 3.1 查核案（核心，`db/kernel/600_audit_engagement.sql`）

| 表 | 欄位 | 只增不改 | 說明 |
|---|---|---|---|
| `sgn.audit_engagement` | `id uuid`、`engagement_no bigint identity`、`kind`（`internal_audit`、`external_audit`、`compliance`）、`basis_ref`（文號，1–128 字）、`process_type`（目前只有 `data_access`）、`scope jsonb`（流程包驗過的範圍：主題包清單、資料期間）、`period_from date`、`period_to date`、`owner_person_id`、`proposed_by`、`proposed_at`、`state`、`principal_id`（核准後建立）、`event_seq` | 只有 `state`、`principal_id` 經轉移表改；其餘建立後不改（trigger 擋其他欄位的 UPDATE、擋 DELETE、TRUNCATE） | 內容雜湊 `content_sha256`（JCS）建立時寫入，申請單的顯示摘要引用它 |
| `sgn.audit_engagement_member` | `engagement_id`、`person_id`、`added_at`、`event_seq` | 是 | 提出時一次寫入 |
| `sgn.audit_engagement_decision` | `engagement_id`、`decision`（`approve`、`reject`、`close`）、`actor_person_id`、`reason`、`proof_hash`、`at`、`event_seq` | 是 | 核准、駁回要通行金鑰；提前結案只需登入（縮小到零） |
| `sgn.audit_engagement_kind_role`（代碼表） | `kind`、`proposer_role`、`approver_role` | 只經 migration | 種子：`internal_audit` → `audit_head`／`audit_governor`；`external_audit` → `audit_head`／`audit_governor`；`compliance` → `compliance_officer`／`legal_head`，以及 `legal_head`／`compliance_officer` 兩列 |

轉移表 `entity = 'audit_engagement'`：`proposed --approve--> active`、`proposed --reject--> rejected`、`active --close--> closed`、`active --expire--> closed`。

流程包（`db/packs/data_access/200_audit_case.sql`）：`pack_data_access.purpose_category` 的 `audit_compliance` 加欄 `requires_engagement boolean`（新欄，預設 false；這一列為 true）；`usage_report.kind` 的 check 加 `engagement_close`、`review`。

### 3.2 定期複查（核心，`db/kernel/605_access_review.sql`）

| 表 | 欄位 | 只增不改 | 說明 |
|---|---|---|---|
| `sgn.review_campaign` | `id`、`campaign_no`、`process_type`、`period_start date`、`frozen_at`、`population_sha256`、`item_count`、`state`（`open`、`signed_off`）、`event_seq` | 只有 `state` 經轉移表改 | 凍結時算母體雜湊（JCS：每筆授權的單號、版本、版本雜湊） |
| `sgn.review_item` | `id`、`campaign_id`、`case_id`、`grant_version`、`kind`（`decide`、`view_only`）、`signals jsonb`（凍結時算）、`state`、`demand_person_id`、`control_due_at`、`demand_due_at`、`event_seq` | 只有 `state`、`demand_person_id`（升級）經轉移表與升級入口改 | `view_only`：快到期或已結束的 |
| `sgn.review_decision` | `item_id`、`stage`（`demand`、`control`）、`scope_ref`（控制段是主題包範圍）、`decision`、`reason`、`actor_person_id`、`on_behalf_of`（升級後代決）、`group_id`、`proof_hash`、`at`、`event_seq` | 是 | 每段每範圍一筆 |
| `sgn.review_item_step` | `item_id`、`stage`、`step`（`remind`、`escalate`、`revoke`）、`due_at`、`done_at`、`to_person`、`event_seq`；唯一 `(item_id, stage, step)` | 是 | 同第四批 `case_task_sla` 的做法 |
| `sgn.review_signoff` | `campaign_id`、`actor_person_id`、`proof_hash`、`stats jsonb`、`at`、`event_seq` | 是 | 控制負責人簽核 |

轉移表：`entity = 'review_campaign'`：`open --sign_off--> signed_off`。`entity = 'review_item'`：`pending_demand --demand_need--> pending_control`、`pending_demand --demand_reduce--> pending_control`（縮小已執行）、`pending_demand --demand_drop--> revoked`、`pending_control --control_keep--> kept`、`pending_control --control_reduce--> reduced`、`pending_control --control_revoke--> revoked`、`pending_demand`／`pending_control --no_response--> revoked`、`pending_demand`／`pending_control --grant_ended--> closed`（期間內授權已因其他原因結束）。

控制段：每個主題包的資料擁有者各決定一次；全部「保留」才 `control_keep`；任一「撤銷」→ 整筆撤銷；有「縮小」沒有「撤銷」→ 合併各包的縮小後 `control_reduce`。

### 3.3 參數

| key | 型別 | 預設 | 界限 | 適用範圍 |
|---|---|---|---|---|
| `data_access.audit_validity_max_days` | integer | 30＊ | 1–90 | `tier` |
| `audit.engagement_max_days` | integer | 90＊ | 7–365 | — |
| `review.interval_months`（核心） | integer | 6 | 1–12 | `process` |
| `review.anchor_month` | integer | 1＊ | 1–12 | — |
| `review.due_days`（核心） | integer | 15 | 5–30 | — |
| `review.remind_before_due_days` | integer | 3＊ | 1–10 | — |
| `review.escalate_grace_days` | integer | 5＊ | 1–15 | — |
| `review.skip_within_days` | integer | 30＊ | 0–60 | `process` |
| `review.group_max_items` | integer | 20 | 1–50 | — |
| `review.signoff_due_days` | integer | 10＊ | 1–30 | — |
| `review.signoff_role` | json | `["control_owner"]` | — | `process` |

活動在 `review.anchor_month` 起每 `review.interval_months` 個月的第 1 天（`calendar.timezone`）建立（預設 1/1、7/1）；部署後第一輪排程發現本期沒有活動就立刻建立並在事件註明「晚建立」。逾期與升級以日曆天計。

## 4. SQL function、轉移、規則代碼、錯誤代碼

### 4.1 查核案

| schema.function | 簽章 | 誰可呼叫 | 規則 |
|---|---|---|---|
| `api.audit_engagement_propose` | `(p_session text, p_engagement jsonb) returns jsonb` | 持有 `audit_engagement_kind_role.proposer_role` 的人；負責人與成員必須在職（第八批再加「正職」）；期間 ≤ `audit.engagement_max_days`、起日不早於今天 | `K-ENGAGEMENT` |
| `api.audit_engagement_challenge` | `(p_session text, p_engagement_id uuid, p_decision text) returns jsonb` | 核准角色持有人，不是提出人、不是負責人、不是成員 | `K-ENGAGEMENT` |
| `api.audit_engagement_decide_passkey` | `(p_challenge_id uuid, p_credential_id text, p_authenticator_data text, p_client_data_json text, p_signature text) returns jsonb` | 同上，簽資料庫產生的查核案顯示摘要；核准時建專案被授權者（`principal_upsert`，`source = 'audit_engagement'`） | `K-ENGAGEMENT` |
| `api.audit_engagement_close` | `(p_session text, p_engagement_id uuid, p_reason text) returns jsonb` | 負責人、提出人或核准人；必填原因 | `K-ENGAGEMENT`、`DA-AUDIT-CLOSE` |
| `api.audit_engagement_list` | `(p_session text) returns jsonb` | 提出、核准、負責、成員的人；稽核唯讀全部 | `K-ENGAGEMENT` |
| `sgn_internal.engagement_end` ／ `api_job.audit_engagement_due` | `() returns jsonb` | 排程：`period_to` 已過 → `expire`；結案時把被授權者標 `ended` 並經 `grant_end('expired', …, 'DA-AUDIT-CLOSE')` 讓名下授權失效（取代等 `principal_end_due` 的下一輪），再呼叫 hook 產生報告 | `DA-AUDIT-CLOSE` |
| hook `validate_engagement_scope`（新） | `(p_scope jsonb) returns jsonb`：`{"scope", "errors"}` | 核心在提出時呼叫流程包 | `K-ENGAGEMENT` |
| hook `after_engagement_closed`（新） | `(p_engagement_id uuid) returns jsonb` | 核心在結案交易內呼叫；流程包寫 `usage_report`（`kind = 'engagement_close'`）並回傳通知對象 | `DA-AUDIT-CLOSE` |
| `pack_data_access.review_submission`（`create or replace`） | 分類 `requires_engagement` 時：內容的 `engagement_id` 有效（`active`）、申請人是成員、被授權者是它的專案、範圍是查核案範圍的子集、資料期間在內、`valid_to ≤ period_to` 且 ≤ `audit_validity_max_days`；通過就不開 `DA-TEST-EXCEPTION`，記「依據：查核案」。沒有查核案卻選這個分類 → 錯誤 | 核心經 hook | `DA-AUDIT-ENGAGEMENT`、`DA-AUDIT-SCOPE` |
| `pack_data_access.normalize_content`（`create or replace`） | 保留 `engagement_id` 鍵（字串 uuid）；其他分類丟掉它 | — | `DA-AUDIT-ENGAGEMENT` |
| `pack_data_access.display_content`（`create or replace`） | 多一行「查核依據：○○查核案（種類、文號、範圍、期間至 ○○，雜湊前 12 碼）；免測試區依據」 | — | `DA-AUDIT-SCOPE` |
| `sgn_internal.decider_denial`（`create or replace`） | 被授權者來源是查核案時，查核案負責人不能決定（受益人） | 核心 | `K-SOD-BENEFICIARY`（部分） |
| `sgn_internal.case_return_notify`（新，退回與駁回的共同路徑呼叫） | 被授權者來源是查核案 → 另通知查核案負責人（範本 `audit.case_blocked`：單號、關卡、決定、原因） | 核心 | `DA-AUDIT-OBSTRUCT` |

查核案的內容檢查放核心；範圍是流程包的（主題包代碼、資料期間格式），所以經 hook。

### 4.2 定期複查

| schema.function | 簽章 | 誰可呼叫 | 規則 |
|---|---|---|---|
| `sgn_internal.review_campaign_open` ／ `api_job.review_campaign_due` | `() returns jsonb` | 排程：到了期初就建立、凍結母體、算風險訊號、指派需求段、寄通知 | `K-REVIEW-CYCLE`、`K-REVIEW-FREEZE` |
| hook `review_signals`（新） | `(p_case_id uuid, p_since timestamptz) returns jsonb`：`[{"code", "detail"}]` | 核心在凍結時呼叫；流程包回傳 `idle`（`K-USAGE-IDLE`）、`unused_fields`、`blocked_attempts`、`usage_missing`、`tier_raised`、`test_exception`；核心自己加 `owner_changed`（第四批 `principal_owner_gap`） | `DA-REVIEW-SIGNALS` |
| `api.review_inbox` | `(p_session text) returns jsonb` | 任何人：自己要決定的項目，已分好「逐筆」與「分組」 | `K-REVIEW-CYCLE` |
| `api.review_item_get` | `(p_session text, p_item_id uuid) returns jsonb` | 該項目的複查人、升級對象、簽核負責人、稽核 | — |
| `api.review_challenge` | `(p_session text, p_item_ids uuid[], p_stage text, p_decision text, p_input jsonb) returns jsonb` | 該段的複查人；分組時每筆都沒有風險訊號、同一個被授權者、筆數 ≤ `group_max_items`；逐筆時 `p_item_ids` 一筆且 `p_input.reason` 必填 | `K-REVIEW-CYCLE`、`K-REVIEW-SOD` |
| `api.review_decide_passkey` | `(p_challenge_id uuid, p_credential_id text, p_authenticator_data text, p_client_data_json text, p_signature text) returns jsonb` | 同上；一次證明涵蓋每筆的版本雜湊與顯示摘要雜湊 | `K-REVIEW-CYCLE` |
| `api.review_decide` | `(p_session text, p_item_ids uuid[], p_stage text, p_decision text, p_input jsonb) returns jsonb` | 只接受不擴大的決定：需求段 `drop`、`reduce`；控制段 `reduce`、`revoke`（D84：縮小與撤銷只需登入）。`reduce` 的 `p_input.content` 經 `compare_content` 必須是 `reduce` | `K-REVIEW-CYCLE`、`K-GRANT-REDUCE` |
| `sgn_internal.review_due` ／ `api_job.review_due` | `() returns jsonb` | 排程：到期前提醒、逾期升級（主管 resolver，升級對象不能是該授權的申請人或受益人，找不到就開 `K-SLA-STALLED` 同性質的例外 `K-REVIEW-STALLED`，不自動撤銷）、升級後再逾期撤銷 | `K-REVIEW-NORESPONSE` |
| `api.review_signoff_challenge`、`api.review_signoff_passkey` | 同前兩組的形狀 | `review.signoff_role` 持有人，不是本期任何項目的複查人；所有 `decide` 項目都已終局 | `K-REVIEW-SIGNOFF` |
| `api.review_campaign_list` | `(p_session text) returns jsonb` | 簽核負責人、稽核：活動、進度、統計（分組比例、平均時間、撤銷數） | `K-REVIEW-CYCLE` |

控制段的複查人解析：對每個主題包範圍找 `data_owner` 持有人，撞到申請人或被授權者負責人 → 同角色其他持有人 → 主管線往上並開 `K-SOD-ROLE-ESCALATED`（`360` 的同一套）。需求段：被授權者目前的負責人；負責人有開著的缺口（第四批）→ 等改指派完成，期限從接下時重算。

縮小與撤銷的執行一律走 `grant_redeliver`（規則 `K-GRANT-REDUCE`、`DA-REVIEW`）與 `grant_end('revoked', …)`；複查不另寫交付。

### 4.3 新規則代碼

| 代碼 | 說明 |
|---|---|
| `K-ENGAGEMENT` | 查核案：依種類由指定角色提出、另一指定角色以通行金鑰核准（提出人、負責人、成員不得核准）；核准後建立專案被授權者；不可修改，只能提前結案；期間上限 |
| `DA-AUDIT-ENGAGEMENT` | 「稽核或法遵查核」分類只能引用有效查核案、申請人是成員、被授權者是它的專案 |
| `DA-AUDIT-SCOPE` | 引用查核案的申請範圍、資料期間、迄日受查核案框住，迄日最長 30 天；正式區免測試區依據、不開例外 |
| `DA-AUDIT-OBSTRUCT` | 引用查核案的單被退回或駁回，原因自動通知查核案負責人 |
| `DA-AUDIT-CLOSE` | 查核案結束時引用它的授權一起失效，產生結案使用報告給負責人與核准人 |
| `K-REVIEW-CYCLE` | 定期活動、兩段決定、逐筆與分組（沒有全選、每組上限）、「仍需要」「保留」要通行金鑰 |
| `K-REVIEW-FREEZE` | 活動開始時凍結母體（快照、雜湊、筆數），含上次活動以來曾經有效的授權（只供查看） |
| `K-REVIEW-SOD` | 控制段複查人不得是該授權的申請人或被授權者負責人；撞到時照角色關卡的順序 |
| `K-REVIEW-NORESPONSE` | 逾期升級給複查人的上一層主管，再逾期撤銷，不預設保留（D99 (3)，取代骨幹「再暫停」） |
| `K-REVIEW-STALLED` | 升級找不到合格的人：開例外給簽核負責人，項目留給原複查人，不自動撤銷 |
| `K-REVIEW-SIGNOFF` | 活動由控制負責人簽核完成；簽核人不得是本期複查人；逾期開例外 |
| `DA-REVIEW-SIGNALS` | 資料授權的風險訊號：久未使用、沒用到的欄位、被擋下的嘗試、使用方沒有回報、分級調高過、沒有測試紀錄就上線 |
| `DA-REVIEW` | 資料授權的複查：控制段依主題包由資料擁有者決定；30 天內到期的只供查看；縮小以欄位為單位 |

### 4.4 新錯誤代碼

| code | message | http |
|---|---|---|
| `ENGAGEMENT_NOT_PROPOSER` | 只有稽核主管（內部稽核、會計師查核）或法遵、法務主管（法遵查核）可以提出查核案 | 403 |
| `ENGAGEMENT_FIELDS` | 查核案要寫依據文號、範圍、資料期間、查核期間（最長 %s 天）、負責人與成員 | 422 |
| `ENGAGEMENT_NOT_APPROVER` | 這種查核案要由指定的另一個角色核准；提出人、負責人與成員不能核准 | 403 |
| `ENGAGEMENT_STATE` | 這個查核案不在可以做這件事的狀態 | 409 |
| `ENGAGEMENT_REQUIRED` | 「稽核或法遵查核」要引用一個生效中的查核案，你必須是它的成員，被授權者要選它的專案 | 422 |
| `ENGAGEMENT_SCOPE` | 申請超出查核案的範圍、資料期間或查核期間；授權最長 %s 天 | 422 |
| `REVIEW_NOT_REVIEWER` | 這筆複查不是由你決定 | 403 |
| `REVIEW_STATE` | 這筆複查已經決定或已經結束 | 409 |
| `REVIEW_GROUP_INVALID` | 分組確認只能放同一個被授權者、沒有風險訊號的項目，最多 %s 筆；有風險訊號的請逐筆決定 | 422 |
| `REVIEW_REASON_REQUIRED` | 有風險訊號的項目要寫理由 | 422 |
| `REVIEW_SOD` | 你是這筆授權的申請人或被授權者負責人，不能做控制段的複查 | 403 |
| `REVIEW_SIGNOFF_PENDING` | 還有項目沒有決定，不能簽核活動 | 409 |

通知範本：`audit.engagement_proposed`、`audit.engagement_decided`、`audit.engagement_closed`、`audit.case_blocked`；`review.assigned`、`review.due_soon`、`review.escalated`、`review.escalated_away`、`review.revoked_no_response`（附「重新申請」預填連結）、`review.signoff_ready`。

## 5. 路由與畫面

`routes` 加：`audit_engagement_propose`、`audit_engagement_challenge`、`audit_engagement_decide_passkey`、`audit_engagement_close`、`audit_engagement_list`、`review_inbox`、`review_item_get`、`review_challenge`、`review_decide_passkey`、`review_decide`、`review_signoff_challenge`、`review_signoff_passkey`、`review_campaign_list`。`schedulerCalls` 加 `audit_engagement_due`、`review_campaign_due`、`review_due`。新頁面 `web/pages/engagements.js`、`web/pages/review.js`；按鈕依回傳的 `actions`。

| 角色 | 動作 | 步數（390px） | 步驟 |
|---|---|---|---|
| 稽核主管 | 提出查核案 | 4 | 查核案頁「新增」→ 種類、文號、期間 → 選主題包與資料期間 → 選成員與負責人後送出 |
| 稽核治理人 | 核准 | 2 | 首頁待辦點開 → 通行金鑰核准 |
| 查核小組成員 | 申請 | 一般申請＋1 | 選分類「稽核或法遵查核」→ 選查核案（被授權者與期限自動帶入，可縮）→ 其餘同一般 |
| 查核案負責人 | 知道被阻擋 | 0 | 通知與查核案頁的「被退回或駁回的單」清單 |
| 被授權者負責人 | 分組確認 | 每組 2 | 複查頁每組一張卡（列出每筆的單號、主題包、迄日）→ 逐列勾選 → 通行金鑰「仍需要」 |
| 被授權者負責人 | 逐筆 | 每筆 3 | 點開看報告 → 選決定並填理由 → 通行金鑰或送出 |
| 資料擁有者 | 同上 | 同上 | 只看自己範圍的主題包 |
| 控制負責人 | 簽核活動 | 2 | 活動頁看統計 → 通行金鑰簽核 |

## 6. 測試清單

資料庫測試 `db/tests/packs/data_access/89b-audit-review.test.mjs`：

| 規則代碼 | 測試 |
|---|---|
| `K-ENGAGEMENT` | 非提出角色 → `ENGAGEMENT_NOT_PROPOSER`；期間超過上限 → `ENGAGEMENT_FIELDS`；提出人、負責人、成員核准 → `ENGAGEMENT_NOT_APPROVER`；法遵提出由法務核准、反之亦然 |
| `K-ENGAGEMENT` | 核准後有專案被授權者（負責人、結束日正確）；核准要通行金鑰，後端改顯示 → `SIGNED_CONTENT_MISMATCH`；查核案欄位 UPDATE 被擋 |
| `DA-AUDIT-ENGAGEMENT` | 沒有查核案選分類 → `ENGAGEMENT_REQUIRED`；非成員、被授權者不是它的專案 → 同 |
| `DA-AUDIT-SCOPE` | 超出主題包、資料期間、迄日晚於查核期間或超過 30 天 → `ENGAGEMENT_SCOPE`；正式區合規申請不開 `DA-TEST-EXCEPTION`，顯示摘要有查核依據行 |
| `DA-AUDIT-SCOPE` | 路徑照一般（L4 有資安長）；查核案負責人被解析到任一關 → 跳過並往上找 |
| `DA-AUDIT-OBSTRUCT` | 擁有者退回 → 查核案負責人收到通知含原因；駁回同 |
| `DA-AUDIT-CLOSE` | 期間結束 → 授權到期、交付撤回、`usage_report` 一筆 `engagement_close`；提前結案同；結案後不能再引用 |
| `K-REVIEW-CYCLE` | 到期初建立活動；同一期重跑不重複；風險訊號項目不能分組 → `REVIEW_GROUP_INVALID`；分組超過 20 → 同；沒有理由 → `REVIEW_REASON_REQUIRED` |
| `K-REVIEW-CYCLE` | 「仍需要」「保留」要通行金鑰；需求段「不需要」→ 撤銷、交付撤回；控制段縮小 → 新版本、重新交付 |
| `K-REVIEW-FREEZE` | 凍結後新生效的授權不在母體；母體雜湊可重算；上期以來已結束的授權列為 `view_only` |
| `K-REVIEW-SOD` | 擁有者是該授權的申請人 → 改派同角色其他人；只有他 → 升級並開 `K-SOD-ROLE-ESCALATED`；直接呼叫 → `REVIEW_SOD` |
| `K-REVIEW-NORESPONSE` | 15 天未回 → 升級給主管並通知原複查人；再 5 天 → 撤銷並寄附預填連結的通知；事件記參數值 |
| `K-REVIEW-STALLED` | 主管線上找不到合格的人 → 例外、項目留給原複查人、不撤銷 |
| `K-REVIEW-SIGNOFF` | 有未決項目 → `REVIEW_SIGNOFF_PENDING`；本期複查人簽核 → 擋下；逾期開例外 |
| `DA-REVIEW-SIGNALS` | 久未使用、沒用到的欄位、被擋下、沒回報、分級調高過、`DA-TEST-EXCEPTION` 各一筆授權，訊號正確 |
| `DA-REVIEW` | 兩個主題包：一包保留、一包縮小 → 整筆縮小；一包撤銷 → 整筆撤銷；30 天內到期的是 `view_only` |

端對端 `e2e/tests/system-zz-audit-review.test.mjs`：(1) 稽核主管提出、治理人核准、成員在 390px 申請正式區（無測試單、無例外）、擁有者退回（負責人收到通知）、重送核准、查核期間結束後 DC 查不到；(2) 假時鐘到期初，負責人分組確認、擁有者逐筆縮小一筆，另一筆讓時鐘走 20 天被撤銷，控制負責人簽核活動。

## 7. 威脅小表

| 誰 | 想做什麼 | 怎麼擋 | 殘餘 |
|---|---|---|---|
| 一般申請人 | 選查核分類逃避測試依據 | 分類綁查核案；送審複核再查一次 | — |
| 稽核主管 | 開假查核案替人拿資料 | 治理人核准、文號結構化、範圍與期限受限；負責人不能簽；結案報告給核准人 | 治理人與稽核主管串通；文號平台驗不到真偽 |
| 受查單位擁有者 | 用退回或駁回阻撓查核 | 路徑不改（①），原因自動送查核案負責人 | 阻撓仍可發生，只是看得見 |
| 複查人 | 全部保留 | 沒有全選、風險訊號逐筆、分組上限、統計進活動簽核 | 分組內仍可能草率 |
| 複查人 | 不回應讓授權照舊 | 升級後撤銷 | 升級對象是同夥（同第四批 §4.1 的主管關係風險） |
| 控制負責人 | 簽核有問題的活動 | 不得是本期複查人；統計進稽核資料 | — |
| 後端 | 竄改分組內容 | 一次證明涵蓋每筆的版本雜湊；顯示由資料庫產生 | — |

## 8. 接點、可能衝突、開放問題

| # | 接點或衝突 | 處理 |
|---|---|---|
| 1 | rules.md「角色」：稽核「唯讀」 | 查核小組成員（可能持稽核角色）以申請人身分申請業務資料；他們不當簽核人（`K-AUDITOR-INDEPENDENT`）。需負責人確認（C5） |
| 2 | 骨幹 `K-REVIEW-NORESPONSE`「再暫停」 | D99 (3) 改為撤銷；骨幹 5.9 改寫 |
| 3 | 第四批升級機制是給申請單工作的；複查項目不是工作 | 共用 `resolve_manager` 與資格檢查；步驟表另立 `review_item_step`，不塞進 `case_task_sla` |
| 4 | 第五批續期：30 天內到期的不複查 | 前提是使用者會續期；不續期就到期，同樣從嚴 |
| 5 | 第六批：複查期間發生分級調高 | 補簽單與複查互不阻擋；複查縮小後補簽單依第六批 §8 #6 重新綁定 |
| 6 | `principal_end_due`（第四批）也會讓查核案專案到期 | 結案時直接處理；排程下一輪看到已結束就不重做 |
| 7 | 退回、駁回目前沒有共同的通知入口 | 新增 `case_return_notify` 並由兩處呼叫（不改既有行為） |

開放問題（只有負責人知道的事實）：

- Q1：會計師（`external_audit`）的成員是外部人員。第八批會擋下外部人員碰 L3、L4（D99 (2)），會計師就不能當成員。會計師要資料時是由內部稽核代為申請後提供（等於匯出），還是會計師自己登入？建議：第一版由內部稽核成員申請、走匯出調查（目的 `external_handover`），會計師不進平台。
- Q2：定期複查的第一次要在什麼時候（配合年度稽核計畫）？建議：1 月 1 日與 7 月 1 日（`review.anchor_month = 1`）。
