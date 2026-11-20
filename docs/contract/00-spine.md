# 契約骨幹（v2）：核心與流程包的介面

這份文件固定核心的命名、實體、狀態、規則代碼與流程包介面，是其他契約文件（核心各模組、各流程包、畫面、對外整合介面）的唯一依據。

- v2 納入 [decision-log.md](../decision-log.md) D1–D62、[reality-check/00-decisions.md](../reality-check/00-decisions.md) 的全部裁決，以及原 pending-amendments 的 A1–A24。設計理由不在這裡重述，見該兩份文件。
- 其他契約與本文件衝突時以本文件為準。需要修改骨幹時先改這裡，再改其他文件。
- 這裡只定名稱、關鍵欄位、語意與界線。完整 DDL、function 簽章、演算法在第 21 節列出的各契約。
- 每個實體、規則代碼、參數都只屬於一份契約（標在表格的「契約」欄或小節標題的括號內），其他契約只能引用。

## 1. 命名

### 1.1 資料庫

| 項目 | 名稱 |
|---|---|
| 平台代號 | `sgn` |
| 核心資料表 schema | `sgn`（任何連線角色都沒有資料表權限） |
| 核心內部函式 schema | `sgn_internal` |
| 給流程包的穩定介面 | `sgn_sdk`：唯讀 view、讀參數、丟錯、登記入口。流程包只能透過它接觸核心 |
| 對外 function schema | `api`（人員介面；決定類 function 只存在這裡）、`api_job`（排程）、`api_sync`（人事與身分來源同步）、`api_int`（機器介面） |
| 流程包專屬的對外 function | 放在 `api`，以流程包代號為前綴，例如 `api.data_access_catalog_search` |
| 流程包 schema | `pack_<代號>`，例如 `pack_data_access`（該流程包的資料表與 hook function） |
| 連線角色 | `sgn_app` → `api`；`sgn_job` → `api_job`；`sgn_sync` → `api_sync`；`sgn_integration` → `api_int`；`sgn_idp_sync` → 只能執行匯入身分提供者簽章金鑰的那一個 function。每個角色只能 `EXECUTE` 自己的 schema |
| 擁有者角色 | `sgn_owner`：不是 superuser，平時不可登入，只在核准的升版期間啟用 |
| hook 的執行身分 | `sgn_pack_<代號>`：擁有該流程包的 hook，只能使用 `sgn_sdk` 與自己的 schema |
| `api` function 的第一個參數 | `p_session`。`api` 內沒有任何 function 接受人員 id 作為行為人；hook 仍收 `p_actor`，只由核心呼叫 |
| `api` function 的回傳 | 統一的結果信封（成功的資料或錯誤代碼）。規則拒絕由外層 `sgn_internal.guard` 捕捉、寫入 denied 事件後以結果回傳，不以例外離開交易 |
| 取得時間 | 只有 `sgn_internal.now()` 一個入口；事件時間取資料庫時鐘，一律 UTC |
| 保留字 | `case`、`grant` 是 SQL 保留字：資料表實體名稱為 `sgn.case_file`、`sgn.grant_record`；術語、欄位與子表仍用 `case_`、`grant_` 前綴（`case_id`、`case_version`、`grant_id`） |
| migration 目錄 | `db/kernel/*.sql`、`db/packs/<代號>/*.sql`；套用順序：核心全部 → 各流程包。`db/testing/*.sql` 是測試專用（含假時鐘），不進發行包，只能裝在 `environment.kind = test` |
| 測試目錄 | `db/tests/kernel/`、`db/tests/packs/<代號>/` |

### 1.2 流程包與流程類型

| 流程包 | 代號 | 規則前綴 | 說明 |
|---|---|---|---|
| 資料授權 | `data_access` | `DA-` | 第一個實際上線的流程；有 hook |
| 合約用印 | `seal` | `SEAL-` | 完全宣告、不登記任何 hook |
| 系統帳號與角色權限 | `account_access` | `AA-` | 含特權、緊急、委外人員 |
| 程式變更上線 | `change_release` | `CR-` | 平台自己的升版也走這個流程 |
| 供應商銀行帳號變更 | `vendor_bank` | `VB-` | 人工的獨立驗證、冷卻期 |
| 治理範本 | `governance` | `GOV-` | 全宣告、沒有 hook：`subject_request`、`content_disclosure`、`incident_record`、`attestation`、`regulator_reply` |

- 流程類型代碼全域唯一，由各流程包契約決定，不得以 `sys_` 開頭。
- `sys_` 是核心內建流程類型的保留前綴：`sys_config_change`、`sys_correction`、`sys_baseline`、`sys_member_change`、`sys_disposal`、`sys_legal_hold`（定義見第 18.4 節）。
- 規則代碼：核心 `K-`；人事事件 `K-HR-`；偵測 `K-DETECT-`；對外整合介面的細部規則 `K-INT-`；流程包用自己的前綴。
- 單號：`<case_no_prefix>-<公司代碼>-<年度>-<六位流水號>`，例如 `DA-HQ-2026-000004`。
- 範圍代碼 `scope_ref` 一律寫成 `<種類>:<代碼>`：`company:HQ`、`process:data_access`、`tier:data_access:L4`、`org_unit:<代碼>`、`system:hr_saas`、`class:security`、`api_client:<代碼>`；流程包自訂的範圍寫成 `<流程包>:<種類>:<代碼>`，例如 `data_access:bundle:customer_master`。

### 1.3 術語

全專案只用這些詞；同一概念不得有第二個名字。

| 中文 | 識別字 | 意義 |
|---|---|---|
| 公司 | `company` | 集團內的一個法人；核心的維度（第 17 節） |
| 流程類型 | `process_type` | 一種申請 |
| 申請單 | `case` | 一次申請 |
| 內容版本 | `case_version` | 申請內容的一個不可變版本 |
| 級別 | `tier` | 風險等級，決定路徑與參數 |
| 路徑 | `approval_policy` | 某流程類型、某公司的關卡定義（帶版本） |
| 關卡 | `stage` | 路徑中的一關 |
| 階段 | `phase` | 關卡屬於哪個階段：`approval`（簽核）、`fulfilment`（執行）、`verification`（驗證）、`review`（事後覆核） |
| 需求側、控制側 | `side` | 簽核關卡的性質：`demand`（證明業務需要）、`control`（獨立把關） |
| 工作 | `task` | 某一關指派給某個人的一件工作（簽核、執行、驗證、覆核共用） |
| 申請人、填單人 | `applicant`、`drafter` | 對申請負責的人；替他準備內容的人 |
| 當事人 | `case_party` | 申請單上有利害或職責的人（申請人、填單人、受益人、開發者、上線者、執行人、驗證人等） |
| 受益人 | `beneficiary` | 被授權者的負責人、成員、agent 的使用對象 |
| 被授權者 | `principal` | 持有授權的主體，一定有負責人 |
| 授權 | `grant` | 核准並執行後的結果：存續型（有有效期間）或一次性許可 |
| 權限項目 | `entitlement` | 授權的通用描述：資源、動作、限制條件 |
| 受管系統 | `resource_system` | 權限實際生效的系統；有自己的擁有單位與管理人（第 19 節） |
| 系統管理人、對帳執行人 | `system_custodian`、`reconciler` | 在受管系統上執行設定的人；獨立提供讀回與對帳資料的人 |
| 執行、驗證 | `fulfilment`、`verification` | 核准後實際去做；讀回實際結果與核准內容比對 |
| 撤銷、暫停、收回 | `revoke`、`suspend`、`reclaim` | 永久終止授權；可恢復的止血；把外部系統上的設定拿掉 |
| 取消、撤回、駁回、退回 | `cancel`、`recall`、`reject`、`return` | 生效前終止（終局）；申請人把簽核中的單取回修改；簽核人終止（終局）；簽核人要求修改 |
| 急件、緊急路徑 | `urgent`、`emergency` | 只改時效；先執行後覆核 |
| 雇用 | `employment` | 自然人在某公司的一段任職 |
| 人事事件 | `hr_event` | 權威來源送來的到職、調職、離職等事實 |
| 技術維運、流程管理者 | `tech_ops`、`process_admin` | 平台管理角色（第 18 節） |
| 控制負責人 | `control_owner` | 公司的第二線（內控、法遵、資安、個資窗口），承接覆核、放寬核准、例外結案 |
| 稽核治理人 | `audit_governor` | 董事會或審計委員會指定，核准稽核角色的授予 |
| 決定證明 | `decision_proof` | 綁定內容的身分證明（第 13 節） |
| 設定變更 | `sys_config_change` | 修改流程、路徑、參數、角色指派等設定的申請單 |
| 稽核事件 | `audit_event` | 只增不改的紀錄；分骨架與封套（第 14 節） |
| 骨架、封套 | — | 進雜湊鏈的最小欄位；逐單金鑰加密、可銷毀的內容與個資 |
| 檢查點 | `audit_checkpoint` | 鏈頭的定期摘要，推到外部錨定位置 |
| 例外 | `exception` | 控制沒有如預期運作的一件事，有責任人並追蹤到結案（第 15 節） |
| 機密欄位、保密流程 | — | 內容不經平台後端的欄位；整張單限縮可見範圍的流程類型（第 20 節） |
| 敏感事件、知悉名單 | `sensitive_event`、`roster_entry` | 例如尚未公告的財報；知悉的自然人與時間 |
| 環境 | `environment` | 一個部署的身分、種類與運作模式（第 16 節） |

## 2. 核心實體

只列實體與關鍵欄位。小節標題的括號是擁有該組實體的契約（第 21 節）。帶「雙時間」的實體同時保存生效期間與記錄期間。

**公司與基礎（01a）**
- `company`（代碼、名稱、母公司、適用法域、預設語言、時區、內容儲存位置、主金鑰參照）、`site`（據點：公司、時區）
- `calendar_holiday`（公司、據點、日期）
- `setting_definition`（key、型別、單位、預設值、`hard_floor`、`hard_ceiling`、允許的適用範圍種類、`control_class`、`control_owner_role`、放寬方向、可否走快速路徑、所屬流程包）
- `setting_value`（key、`scope_ref`、值、生效起迄 `effective_from`／`effective_to`、依據生效日、來源的設定變更單；只增不改）
- `rule`（規則代碼、說明、來源文件、所屬流程包）
- `message_catalog`（代碼、種類 error／notice／check／text、SQLSTATE 與 HTTP 狀態（只有 error 有）、訊息 key）
- `language_pack`（語言、key、文字；資料，可在執行期新增）
- `notification_template`（事件代碼、語言 → 主旨、內文；連結由系統產生）、`notification_outbox`（收件人、通道、分級、寄送狀態、每次嘗試）
- `scheduler_run`（唯一鍵：動作、對象、邏輯到期時間；結果、心跳）
- `privacy_notice`（告知書版本、語言）、`notice_ack`（人、版本、時間）

**身分與決定證明（01b）**
- `identity_provider`、`identity_provider_key`（簽章金鑰、狀態）
- `auth_session`（人、來源、`auth_time`、`acr` 與 `amr` 原值、到期與閒置時限）
- `person_credential`（WebAuthn 憑證、狀態）
- `action`（動作目錄：代碼、類別、最低證明等級）
- `decision_challenge`（一次性挑戰：動作、對象清單與各自的版本雜湊、顯示快照雜湊）、`decision_proof`（原始簽章資料、驗章結果）

**人員與組織（01c）**
- `person`（自然人：姓名、email、時區、語言、`processing_restricted`、狀態；不硬刪，離任後分階段最小化）
- `employment`（人、公司、員工編號、類型 regular／contractor／intern／dispatch／external、狀態、起迄、據點；外部人員另有保證人與委外合約）
- `person_identity`（身分來源、`external_id` → 人；只增不改，`external_id` 必須是來源宣告永不重用的屬性）
- `org_unit`（公司、樹）、`org_membership`（雇用 ↔ 單位）、`reporting_line`（雇用 → 主管，`kind` line／functional、公司）：皆雙時間
- `appointment`（跨公司職權的任命：人、公司、職務、起迄、依據）
- `role`（代碼、名稱、類別 business／control／platform／governance、單一或多人持有、是否依範圍、`assignment_source_policy`、所屬流程包）
- `role_assignment`（人 → 角色、公司、`scope_ref`、來源、可見範圍；雙時間）、`designated_deputy`（角色的指定代理人名單）
- `delegation`（委託人 → 代理人；範圍：公司、流程類型、級別上限、金額上限、是否含保密單；期間、來源 self／hr、狀態、核准引用）
- `assistant_link`（委託人、助理、期間、可見範圍）
- `principal`（類型 team／project／agent／service_account／legacy_individual、公司、名稱、負責人、結束日、狀態、保密旗標與代號、單一成員旗標）、`principal_member`（人、種類 member／audience、加入與離開時間；雙時間）、`principal_identity`（被授權者在各受管系統上的識別碼）
- `outsourcing_contract`（委外合約：對象、起迄、內部負責人）、`related_party`（關係人名單）、`interest_declaration`（利害關係申報）
- `hr_event`（種類、生效時間、得知時間、旗標）、`hr_transition`（異動處理清單與各項目的負責人、期限）、`managed_source`（權威來源登記：負責單位、協定、心跳）

**流程定義（01d）**
- `process_type`（代碼、名稱、所屬流程包、擁有單位、適用公司、`form_schema`、宣告、選項、登記的 hook 與 `hook_rules`、`hook_api_version`、函式雜湊、`case_no_prefix`、版本、狀態）
- `process_tier`（流程類型、級別代碼、名稱、排序）
- `approval_policy`（流程類型、公司、版本、生效時間、`top_resolver`、狀態）
- `policy_stage`（順序、代碼、名稱、`phase`、`side`、resolver 種類與參數、`mode`、`parallel_group`、`applies_when`、`sla`、`checklist`、`question`、迴避替代人、出缺替代人、`addable_roles`、`cross_company_required`）
- `authority_matrix`（核決權限表：公司、版本、依據文件、核准日、生效日；列為流程類型、類別、金額區間 → 角色或層級）
- `sod_conflict_rule`（職責衝突矩陣：互相衝突的權限項目組合、公司、版本）
- `governance_meeting`（會議別、日期、議案編號、決議內容、出席與迴避、議事錄、登錄人、確認人）
- `case_template`（流程類型、名稱、內容、建立者、是否為擁有者維護的標準範本）

**申請與簽核（01e）**
- `case`（單號、流程類型、公司、路徑版本、申請人、`drafted_by`、被授權者、級別、狀態、目前版本、來源單與 `source_kind`、有效起迄、急件欄位、緊急路徑欄位、`contains_offline_decision`、套組、`row_hash`、`last_event_seq`）。`source_kind`：`renewal`、`reuse`（沿用前案）、`template`、`converted_from`、`resubmission_of`、`ratified`、`legacy_approval`
- `case_version`（版本號、內容、內容雜湊、相對前一版的變更分類、建立者）
- `case_party`（當事人角色、人、來源）、`case_recusal`（迴避名單；機密）
- `case_overlap`（重疊對象、程度、申請人說明）
- `case_stage`（關卡實例、狀態、略過或停住的原因）
- `case_task`（指派對象、簽核身分（公司、職務）、原指派對象、被取代的原因、狀態、結果、到期與催辦升級時間、`opened_at`、意見、`decision_proof` 引用、`basis_snapshot`、`display_snapshot`、批次編號）
- `case_question`（提問與回覆，綁內容版本）、`case_consult`（徵詢與意見）、`case_note`（不屬於內容版本的附註）
- `case_bundle`（職務套組：共用欄位、連結的申請單）
- `offline_decision`（登錄人、原決定人、登錄時間、宣稱的決定時間、佐證、確認）
- `attachment`（檔名、大小、型別、sha256、所屬版本、加密、掃描結果、變更說明、安全預覽）

**執行、驗證、授權（01f）**
- `resource_system`（第 19 節）、`system_role`（角色目錄）、`export_mapping`（匯出檔對應）、`resource`（受管系統下的資源：型別、識別碼、擁有者範圍、上線狀態、綁定的敏感事件）
- `fulfilment`（種類 provision／reclaim、依據的內容版本、交付信封：`content_hash`、冪等鍵、鑑別碼、期限；認領人、完成回報、對方端點與憑證指紋）、`fulfilment_attempt`
- `verification_run`（方式、讀回的來源與提供者、觀察到的事實、結果）、`verification_case`（預期、實際、結果）
- `case_confirmation`（確認人、身分、時間）
- `grant`（申請單、被授權者、受管系統、種類 standing／one_time、有效起迄、狀態、`origin`（approved、migrated、ratified、legacy_approval、emergency）、`external_state`、`last_used_at`、生效窗口、敏感事件、延後生效、撤銷資訊、`row_hash`、`last_event_seq`）、`grant_entitlement`（核准時封存的權限項目）
- `incident_hold`（某人某期間的決定、單、授權、設定變更的整批暫停與逐筆覆核）
- `sensitive_event`（代碼、擁有人、狀態、預定與實際公告時間、是否循環、公告後的降級目標）、`roster_entry`（自然人、開始知悉時間、依據、義務確認）

**證據（01g）**
- `audit_event`（骨架：序號、時間、`business_time`、事件類型、行為人內部 id、`channel`（web、api、job、sync、release）、`api_client_id`、連線角色與來源位址、申請單、規則代碼（核心與流程包）、`outcome`（allowed、denied、error）、公司集合、路徑版本、hook 版本與函式雜湊、封套承諾、`proof_hash`、`hash_version`、被雜湊的 bytes、前一筆雜湊、本筆雜湊）
- `event_envelope`（加密封套：內容類、軌跡類）、`case_key`（逐單資料金鑰：包裝後的金鑰、主金鑰版本、銷毀時間）
- `audit_checkpoint`、`anchor_sink`、`anchor_receipt`、`audit_segment_seal`
- `decision_log`（判定紀錄）、`access_log`（查閱紀錄）、`log_block`（區塊承諾）、`security_event`（安全事件）
- `legal_hold`（範圍、案號、檢討日）、`export_record`（匯出：用途、序號、浮水印、檔案雜湊）、`external_archive`（舊系統的唯讀封存）

**治理與稽核作業（01h）**
- `environment`（id、種類、模式）、`service_outage`、`release_install`、`connection_endpoint`（控制相關的連線設定：端點、憑證指紋、是否備援、環境種類）
- `rollout_scope`（上線範圍，依資源分批，有版本）
- `exception`、`detector`（偵測規則與門檻）、`audit_remark`
- `audit_engagement`（查核案）、`population_definition`（母體定義，有版本）、`audit_sample`、`evidence_snapshot`、`company_control`（客戶自己的控制目錄）

**對外整合（05）**
- `api_client`（負責人、範圍、可詢問的受管系統、金鑰與效期）、`webhook_subscription`、`webhook_delivery`、`integration_event`
- `reconciliation_run`、`reconciliation_finding`、`reconciliation_exclusion`
- `access_review_campaign`（凍結的母體快照與雜湊、活動簽核）、`access_review_item`（風險訊號、兩段決定）

## 3. 流程類型的選項

每個流程類型宣告自己用到哪些核心能力，核心依選項決定狀態怎麼走。其餘三個流程包與治理範本包的值在各自的契約決定。

| 選項 | 意義 | 預設 | 資料授權 | 合約用印 |
|---|---|---|---|---|
| `uses_principal` | 需要指定被授權者 | 否 | 是 | 否 |
| `has_validity` | 有有效期間，會到期 | 否 | 是 | 否 |
| `validity_unit` | 有效期間的單位：`day`、`hour` | day | day | — |
| `renewable` | 可以續期 | 否 | 是 | 否 |
| `overlap_check` | 送審時檢查重複或重疊 | 否 | 是 | 是 |
| `requires_fulfilment` | 核准後需要執行 | 否 | 是 | 是 |
| `requires_verification` | 執行後驗證（方式依受管系統的整合方式；沒有受管系統時由驗證階段的關卡指定驗證人） | 否 | 是 | 否 |
| `requires_confirmation` | 需要確認 | 否 | 是 | 是 |
| `confirmation_parties` | 誰可以確認：申請人，可加被授權者負責人與指定成員 | 申請人 | 申請人 | 申請人 |
| `confirmation_timeout_action` | 確認逾期：`revoke` 或 `remind` | remind | revoke | remind |
| `confirmation_prompt` | 確認畫面的文字 key | 通用文字 | 包自訂 | 包自訂 |
| `revocable_after_fulfilment` | 執行後可否撤銷。為否時，執行完成後的取消與撤銷一律拒絕 | 是 | 是 | 否 |
| `batch_kinds` | 允許的批次種類：`renewal_identical`、`template_identical`（後者開啟屬放寬類設定變更） | 無 | renewal_identical | 無 |
| `confidential_case` | 保密流程（第 20 節）：`never`、`always`、`by_resource`（涉及的資源或受管系統要求保密時） | never | by_resource | never |
| `allows_urgent` | 可標急件 | 否 | 是 | 包決定 |
| `allows_emergency_path` | 可先執行後覆核；必須同時是可收回的權限 | 否 | 否（固定） | 否 |
| `allows_recusal_list` | 可設迴避名單 | 否 | 是 | 否 |
| `allows_external_members` | 被授權者可含外部成員 | 否 | 包決定 | — |
| `allows_effective_window` | 授權可綁生效窗口 | 否 | 是 | — |
| `escalation_handback` | 升級對象可交回一次 | 否 | 否 | 包決定 |
| `external_signature` | 依級別要求外接憑證機構的個人簽章 | 否 | 否 | 否 |
| `company_from` | 申請單的公司別由哪個內容欄位或資源決定；不由申請人選 | 申請人的雇用 | 資源所屬公司 | 包決定 |
| `party_roles` | 這種流程有哪些當事人角色、來源、哪些互斥 | 申請人、填單人 | 包決定 | 包決定 |
| `authoritative_language` | 以哪個語言的文字為準 | 公司預設語言 | zh-Hant | zh-Hant |
| `retention_class` | 保存類別（第 14 節） | standard | 包決定 | standard |
| `notification_delay` | 對特定對象延後通知（調查類） | 無 | 調查路徑 | 無 |

## 4. 狀態

狀態轉移由轉移表驅動，只能前進（`K-NO-REGRESS`）。完整的轉移表在各擁有契約。

### 4.1 申請單（`case.status`，01e）

| 狀態 | 意義 | 終局 |
|---|---|---|
| `draft` | 草稿；不取號、不進母體 | |
| `in_approval` | 簽核中 | |
| `returned` | 已退回或已撤回，等申請人修改 | |
| `rejected` | 已駁回 | 是 |
| `pending_fulfilment` | 已核准，等待執行 | |
| `verifying` | 已執行，驗證中或等確認 | |
| `active` | 生效中（有有效期間的流程） | |
| `completed` | 已完成（沒有有效期間的流程） | 是 |
| `expired` | 已到期 | 是 |
| `revoked` | 已撤銷 | 是 |
| `cancelled` | 生效或完成前取消 | 是 |

```
draft → in_approval → pending_fulfilment → verifying → active → expired
            │  ↘ returned → in_approval                     ↘ revoked
            ↘ rejected                     verifying → completed
未生效的狀態 → cancelled；verifying 驗證失敗 → pending_fulfilment；returned 逾時 → cancelled
```

- 沒有選用的能力就略過對應的狀態。
- 每張送審過的單都會到達終局狀態：退回逾時自動取消；申請人離職時由被授權者負責人接手或取消。
- 緊急路徑不增加狀態：事前核准（或等待逾時先行）後直接進入執行，授權結束後開啟 `review` 階段的關卡；事後覆核不改變申請單的終局狀態，逾期列例外。

### 4.2 關卡與工作（01e）

| 對象 | 狀態 |
|---|---|
| `case_stage.status` | `waiting`、`open`、`halted`（解析不到人）、`awaiting_resolution`（等會議決議）、`done`、`skipped`（不適用，記原因）、`cancelled` |
| `case_task.status` | `unclaimed`（群組未認領）、`pending`、`approved`、`returned`、`rejected`、`completed`（執行、驗證、覆核類工作完成，結果另記）、`withdrawn`（決定被撤回）、`transferred`、`handed_back`、`superseded`（必帶原因：升級、組織異動、迴避、重新解析）、`cancelled` |

### 4.3 授權（`grant.status`，01f）

- `active` ⇄ `suspended` → `revoked`；`active` → `expired`。
- 有效性在讀取時以時間計算（`K-VALIDITY-READTIME`）：起日未到、迄日已過、生效窗口外、延後生效未滿，都視為無效，不依賴排程把狀態改掉。
- `external_state`：`synced`、`pending_reclaim`、`reclaimed`。撤銷與暫停在平台立即生效，外部設定的收回另外追蹤（`K-RECLAIM`）。
- 建立時點：存續型授權在執行完成且驗證通過時建立（沒有選用驗證的流程在執行完成時；沒有選用執行的流程在核准完成時）；流程選用確認時（`requires_confirmation`），授權在確認通過時才建立（依流程包的規則，例如資料授權「兩者都通過才結案生效」；D83）；等確認期間外部系統上已套用的權限記為「已套用、等確認」。一次性許可在核准完成時建立，到執行完成或 `grant.one_time_max_hours` 為止。

### 4.4 其他狀態機

| 對象 | 狀態 | 契約 |
|---|---|---|
| `exception.status` | `open` → `in_progress` → `pending_review` → `closed` 或 `risk_accepted` | 01h |
| `environment.mode` | `bootstrap`、`normal`、`maintenance`、`restore_pending`、`isolated`、`archive` | 01h |
| `employment.status` | `pending_start`、`active`、`notice`、`on_leave`、`terminated` | 01c |
| `delegation.status` | `active`、`suspended`、`expired` | 01c |
| `principal.status` | `active`、`ended` | 01c |
| `person_credential.status` | `cooling`、`active`、`revoked` | 01b |
| `identity_provider_key.status` | `pending`、`active`、`revoked` | 01b |
| `resource_system` 的涵蓋狀態 | `managed`、`scheduled`（附日期）、`excluded`（附理由） | 01f |
| `sensitive_event.status` | `open`、`announced` | 01f |

## 5. 核心規則

這些規則屬於核心，對所有流程類型一律生效。流程包、設定、任何角色都不能關閉；可調的只有第 8 節列出的參數，而且受硬上下限約束。每條規則都有測試，包含「試著繞過」的測試。「契約」欄是擁有該規則的契約。

### 5.1 身分與證明

| 代碼 | 規則 | 契約 |
|---|---|---|
| `K-ACTOR-PROVEN` | 行為人只由資料庫從 session 得出；session 由資料庫驗身分提供者簽的 token 後建立，後端造不出來 | 01b |
| `K-DECISION-PROOF` | 每個決定類動作都要達到動作目錄的最低證明等級，證明綁定對象的內容版本雜湊與顯示快照雜湊，驗章與決定在同一個交易；不分裝置，沒有「幾分鐘內免再驗」 | 01b |
| `K-DECISION-ELIGIBLE` | 決定當下重驗雇用狀態、角色資格、代理有效性與職責分離，不符即拒絕 | 01e |
| `K-CRED-COOLING` | 新憑證在冷卻期內不能做 `passkey` 等級的動作；單一持有人角色或掛失後重登記需主管或資安確認；登記時通知本人既有信箱與直屬主管；作廢時列出它在指定期間內的決定交資安覆核 | 01b |
| `K-SESSION` | session 有閒置與絕對時限，接收身分提供者的登出與停用事件；來源突變寫 denied 事件並告警 | 01b |
| `K-NAMED-ACCOUNT` | 只有具名個人帳號；不提供本機密碼登入（啟動與破窗例外）；平台內不提供修改通知信箱 | 01b |
| `K-EXTERNAL-SPONSOR` | 外部人員走外部身分來源、所有決定都要 `passkey`、必有內部保證人並掛在委外合約下；效期不超過合約且單次最長 6 個月；新憑證須保證人確認才啟用；保證人定期確認，保證人離職、留停、調職時立即停止認領新工作。非正職人員不得為負責人、單一持有人角色或簽核人 | 01c |
| `K-PRIVACY-NOTICE` | 首次登入與告知書改版後須確認才能繼續，外部人員相同 | 01a |

### 5.2 職責分離

職責分離一律以自然人判斷，不以帳號或雇用判斷。

| 代碼 | 規則 | 契約 |
|---|---|---|
| `K-SOD-APPLICANT` | 申請人不能簽自己的單，不論以主管、角色、群組、代理、轉簽、加簽哪種方式被指派 | 01e |
| `K-SOD-DRAFTER` | 填單人比照申請人；申請人確認後才能送審 | 01e |
| `K-SOD-DISTINCT` | 同一張單的每個簽核關卡都是不同的人，代理人同樣適用。不同關卡解析到同一人時，保留解析依據最具體的那一關，其餘依序找迴避替代人、上一層主管、`top_resolver`，不得落到當事人的代理人或下屬。同一個 `scoped_role` 關卡內同一人持有多個範圍時合併成一件工作，決定逐範圍記錄 | 01e |
| `K-SOD-BENEFICIARY` | 受益人不得簽控制側關卡，也不得執行、驗證、複查。需求側關卡不得由申請人、填單人、專案與 agent 的直接成員簽；依人資組織推導的團隊，其主管可以簽需求側 | 01e |
| `K-STAGE-CONTROL-SIDE` | 會產生授權的路徑至少要有一個控制側關卡；啟用路徑時檢查 | 01d |
| `K-SOD-INTEREST` | 出現可判定的間接利害關係（`detect_interest`、`related_party`、申報）時，簽核人必須迴避，或揭露並填理由後簽（進例外報表）；流程類型或級別可宣告強制迴避 | 01e |
| `K-SOD-RECUSAL` | 迴避名單上的人不被指派、不能認領、看不到、收不到通知。只能由法務、法遵、個資窗口設定，或由調查類申請的申請人提出並經第一關核准後生效；不得用來排除正常的簽核人 | 01e |
| `K-SOD-PARTY` | 流程類型宣告的當事人角色之間的互斥（例如開發者不得核准或上線）由核心強制；核心的最低要求不可放寬 | 01e |
| `K-SOD-CONFLICT` | 職責衝突矩陣：送審與核准時，以自然人聚合其可觸及的全部有效授權與在途申請單比對 `sod_conflict_rule`。違反時擋下；例外須經控制負責人關卡、較短的有效期並列入複查。存量授權持續檢查，對帳發現同樣比對 | 01f |
| `K-SOD-FULFIL` | 執行人不得是申請人、填單人、該單的簽核人、受益人 | 01f |
| `K-VERIFY-INDEPENDENT` | 驗證是讀回實際設定與核准的權限項目做集合相等比對，多一項或少一項都失敗。讀回不得由執行人提供；人工驗證人不得參與該單的申請、簽核與執行，並須記錄實際觀察到的事實，截圖不算驗證 | 01f |
| `K-REVIEW-SOD` | 複查人不得複查自己的授權；控制側的複查人不得是該授權的申請人或受益人；`review.recusal_months` 開啟時，曾核准該授權或近期任職同單位者迴避 | 05 |
| `K-AUDITOR-INDEPENDENT` | 持有稽核角色的人不會被解析為簽核人、執行人、驗證人、例外的責任人或覆核人、設定變更核准人、金鑰保管人；撞到時當作設定錯誤擋下。稽核角色的授予、範圍與撤除由稽核主管提出、`audit_governor` 核准 | 01h |
| `K-AUDITOR-READONLY` | 稽核唯讀，可查其範圍（公司、流程類型、事件期間、到期日）內的全部；可匯出、驗證、留言、提出 `audit_remark` | 01h |
| `K-ADMIN-SOD` | 平台角色衝突矩陣（第 18.2 節）在指派時檢查；無法避免時以最長 12 個月的例外持有，並由他人每月覆核其全部動作 | 01h |
| `K-AGENT-CEILING` | 判定帶 `on_behalf_of` 時，結果是 agent 的授權與該使用者自己的授權的交集 | 05 |

### 5.3 解析與指派

| 代碼 | 規則 | 契約 |
|---|---|---|
| `K-RESOLVE-STAGE-START` | 簽核人在每關開始時解析，不在送審時一次算完；人事事件到達時主動重新解析，舊工作轉 `superseded`，新工作帶著問答、徵詢意見與備註。已完成的關卡不因事後異動失效 | 01e |
| `K-RESOLVE-HALT` | 解析不到合格的人時關卡停住（`halted`），開高嚴重度例外給流程擁有單位主管；任何情況都不自動通過、不跳關 | 01e |
| `K-TOP-RESOLVER` | 每個路徑必須設定 `top_resolver`（治理角色）才能啟用。技術維運、流程管理、人資、稽核都不能逐張指定簽核人或代簽；補救一律是結構性的（人資登記代理主管，或以設定變更補上替代人）。頂層申請人的單生效時通知稽核主管並列入複查；部屬簽上級的單在畫面與紀錄上標示 | 01d |
| `K-ROLE-CONTINUITY` | 單一持有人角色、治理角色、控制負責人、金鑰保管人、系統管理人隨時要有在職的持有人；出缺或少於要求人數時列例外 | 01c |
| `K-ROLE-SOURCE` | 角色指派的來源依 `assignment_source_policy`：`manual`（走設定變更）、`position_derived`（隨人事事件變更並寫事件）、`sync_proposed`（外部群組同步只能提議，平台內核准後生效，移除立即生效）。平台管理類角色只能 `manual` | 01c |
| `K-OWNER-FALLBACK` | 資源擁有者空缺時由業務擁有單位主管暫代並開例外；連業務擁有單位都沒有的資源不開放申請 | 01f |
| `K-AUTHORITY-MATRIX` | 核決權限表是有版本的受控設定，變更必須引用依據文件、核准日與預定生效日；每季做一致性簽核 | 01d |
| `K-PARALLEL-ALL` | 並行的關卡與 `all` 模式的工作要全部核准才往下；後續關卡看得到各並行關的意見與時間 | 01e |
| `K-CLAIM` | 群組關卡由一人認領後負責；被職責分離排除的人不能認領。放回群組須填原因並記錄期間檢視的內容 | 01e |
| `K-RESOLUTION` | `resolution` 模式的決定者是會議：決議內容須含單號與金額並與申請單一致才放行；議事單位一人登錄、另一人確認；時限依下次會議日計算 | 01e |
| `K-DELEGATE` | 代理人簽核時紀錄寫明誰代誰簽。代理帶範圍與期間、不得回溯；超過自助上限需委託人的主管核准；控制側角色只能代理給 `designated_deputy` 名單；任一方有人事異動時暫停；代理人是申請人、填單人、受益人時自動跳過。人資登記的職務代理人直接適用並寫明來源，控制側角色只在他屬於指定代理人名單時適用 | 01c |
| `K-ASSISTANT` | 助理只能看清單、代提問、寫準備備註、標記建議，不能決定；由委託人以 `passkey` 建立；保密流程預設排除 | 01c |

### 5.4 簽核動作與內容

| 代碼 | 規則 | 契約 |
|---|---|---|
| `K-CASE-NUMBER` | 單號在送審的交易內依（公司、流程類型、年度）無間隙取號；草稿不取號，刪除草稿寫事件 | 01e |
| `K-VERSION-BOUND` | 每個決定綁定當時的內容版本；問答與徵詢同樣綁版本 | 01e |
| `K-CHANGE-REDUCE` | 簽核人只能做縮小的修改；縮小後通知申請人，不用重簽。被授權者與授權起迄的縮小或擴大由核心判定，與內容的比較結果取較嚴重者。級別因縮小而降低時，尚未開始的關卡依新級別重新套用適用條件 | 01e |
| `K-CHANGE-EXPAND` | 擴大或無法判定的修改從第一關重簽；每個新版本重新分級，級別升高一律視為擴大 | 01e |
| `K-APPLICANT-REDUCE` | 送審中申請人可直接縮小，不重簽，通知已簽與待簽者 | 01e |
| `K-RETURN` | 退回後申請人只做縮小就從退回的那一關繼續，否則從第一關重簽；退回或擴大後重送一律改用最新版路徑。退回逾 `approval.returned_expire_workdays` 自動取消 | 01e |
| `K-REJECT` | 駁回是終局；重送自動連結前案（`resubmission_of`），所有關卡看得到前次駁回原因 | 01e |
| `K-RECALL` | 申請人可把簽核中的單撤回修改，狀態轉 `returned`，重送依 `K-RETURN` 判定 | 01e |
| `K-CANCEL` | 生效或完成前，申請人、被授權者負責人、該單任一位簽核人、執行人可以取消，必須填原因；`revocable_after_fulfilment` 為否時，執行完成後拒絕 | 01e |
| `K-QUESTION` | 提問不改變關卡，可問本單的任一參與者；暫停本關計時，上限 `approval.question_pause_max_workdays`；回覆不能夾帶內容修改 | 01e |
| `K-CONSULT` | 徵詢指定一人提供意見：沒有否決權、不暫停計時、寫查閱紀錄、意見進事件；保密單須簽核人確認可讓對方看 | 01e |
| `K-TRANSFER` | 轉簽對象限該關 resolver 可解析的人或指定代理人，每關一次，須通過職責分離檢查，保留轉出者的檢查與意見 | 01e |
| `K-ADDSIGN` | 加簽只增不減，限路徑宣告的 `addable_roles`，同受職責分離約束；保密單的加簽人只看簽核人勾選的非機密欄位 | 01e |
| `K-DECISION-WITHDRAW` | 下一關尚未決定、尚未被認領、尚未進入執行前，簽核人可撤回自己的決定（追加事件、必填原因、需決定證明） | 01e |
| `K-CONVERT` | 簽核人可把選錯流程的單轉為正確的流程類型：原單取消，新單為草稿並記 `converted_from`，由申請人確認後送審 | 01e |
| `K-SLA-REMIND` | 逾時先催辦；時限依簽核人在該關所代表公司與據點的行事曆與時區計算；申請人每關每個週期可提醒一次 | 01e |
| `K-SLA-ESCALATE` | 催辦後仍未簽，升級給目前指派對象的上一層主管，找不到時依出缺順序到 `top_resolver`；升級後原簽核人不能再簽；升級前 1 個工作天預告 | 01e |
| `K-SLA-HANDBACK` | 流程類型開啟 `escalation_handback` 時，升級對象可交回原簽核人一次並設新期限 | 01e |
| `K-URGENT` | 急件不改路徑，只改時效（以小時計、即時推播）；須填結構化的需要完成日與原因；簽核人可否決急件 | 01e |
| `K-BATCH` | 可進批次的單須同時符合：內容無差異（與來源單相同）、情境無差異（重判的級別相同、成員無增加、負責人相同、資源分級未變、所屬單位未改組、沒有未結的例外或對帳差異、有使用資料時前一期有使用紀錄、沒有受益人衝突）、不屬於不可批次的類別（最高級別、綁定敏感事件的資源、追認型、有重疊警示）。每批不超過 `approval.batch_max_items`，逐列勾選、沒有全選；一次決定證明涵蓋每張的版本雜湊與顯示快照雜湊；每張單各一筆事件並帶批次編號。不符合的踢出並寫明原因 | 01e |
| `K-OVERLAP-BLOCK` | 被同一被授權者的既有有效授權完全涵蓋就擋下，並給可執行的下一步；既有授權進入到期提醒期間時改為部分重疊 | 01e |
| `K-OVERLAP-REASON` | 部分重疊必須填理由。比對對象含有效授權、在途申請單，以及 `overlap.rejected_lookback_days` 內被駁回的單（換名稱或換申請人也會帶出） | 01e |
| `K-RENEW` | 續期是新的申請單，走完整路徑，標示與來源單的差異；起日預設為來源授權迄日的隔天；來源已到期者須在 `renewal.max_gap_days` 內 | 01e |
| `K-REUSE` | 沿用前案或範本只預填內容，來源記在 `source_kind`；「續期」「無差異」「急件」等標示只能由系統產生 | 01e |
| `K-OFFLINE-DECISION` | 線下決定登錄：登錄人不是原決定人；記登錄時間與宣稱的決定時間；原決定人在系統內以決定證明確認；整張單標記並自動列例外，由未參與的人覆核結案 | 01e |
| `K-PRINCIPAL` | 被授權者一定有在職的負責人；專案與非人類主體（agent、服務帳號）必有結束日，其授權必有有效期；建立時比對相似名稱；保密的被授權者對外只顯示代號；`legacy_individual` 只能由匯入產生 | 01c |

### 5.5 執行、驗證與存續

| 代碼 | 規則 | 契約 |
|---|---|---|
| `K-FULFIL` | 執行完成才進入下一步；送去執行的內容就是核准的那一版，完成回報必須帶回同一個 `content_hash` | 01f |
| `K-FULFIL-ENVELOPE` | 交付內容由資料庫附上訊息鑑別碼（每個受管系統一把金鑰），含單號、版本雜湊、冪等鍵與期限；能驗的系統只套用驗證通過的交付；結果不明時先查詢，不自動重試 | 01f |
| `K-VERIFY` | 驗證沒過退回執行；沒有驗證紀錄不生效 | 01f |
| `K-CONFIRM` | 確認人依 `confirmation_parties`，紀錄寫明是誰確認；逾期依流程類型選項撤銷或催辦；提醒對象逐日擴大，撤銷前一天明說 | 01f |
| `K-NO-BACKDATE` | 授權的起日不得早於核准完成時間；設定的生效時間不得早於最後一關核准時間 | 01f |
| `K-NO-REGRESS` | 狀態只能依轉移表前進；已核准內容的任何修改都是新版本；任何角色都不能改已核准的內容或倒退狀態；更正只能走 `sys_correction` | 01e |
| `K-EFFECTIVE-DELAY` | 流程類型或級別可設定核准後延後生效（`grant.effective_delay_hours`），期間 `check` 拒絕並發事件 | 01f |
| `K-VALIDITY-MAX` | 有效期間不得超過該級別的上限；單位可為小時 | 01f |
| `K-VALIDITY-READTIME` | 判定與查詢一律以時間計算有效性；排程只負責通知與收回外部設定；停機只順延要人做事的時限，不順延授權到期 | 01f |
| `K-EXPIRE`、`K-EXPIRE-REMIND` | 到期自動失效並通知下游；到期前提醒負責人與成員 | 01f |
| `K-EVENT-EXPIRE` | 授權可綁定事件（敏感事件公告、專案結束、合約到期、同意撤回）：事件發生時失效或降級。敏感事件由擁有人確認已公告才觸發，不依預定時間自動觸發；逾預定時間未確認列例外 | 01f |
| `K-WINDOW` | 生效窗口：授權可綁循環事件或行事曆，窗口外 `check` 拒絕，每次開關留紀錄；仍受有效期上限與定期複查約束 | 01f |
| `K-REVOKE` | 申請人、被授權者負責人、該單任一位簽核人、執行人、資源的現任擁有者可以直接撤銷，必須填原因。撤銷在平台立即生效 | 01f |
| `K-SUSPEND` | 暫停可恢復：`security_responder` 只能暫停，1 個工作天內由資安長覆核；`incident_hold` 可整批暫停某人某期間經手的對象，逐筆由他人覆核後恢復或撤銷；暫停在時限內推送下游並自動做一次拒絕驗證 | 01f |
| `K-GRANT-REDUCE` | 生效中的授權可以縮小範圍或迄日：由可撤銷的人提出，產生新的內容版本，不重簽，重新交付並驗證。複查決定的縮小與設定變更對既有授權的縮短都走這個入口 | 01f |
| `K-RECLAIM` | 凡曾完成交付的單，其授權撤銷、到期、暫停或申請單取消時，產生收回的執行工作給系統管理人；授權記 `pending_reclaim` 並計時，以對方系統的證據或對帳結案，逾期列例外 | 01f |
| `K-OWNER-CONTINUITY` | 授權隨時要有在職的負責人：預告離職即開始移交；負責人異動給寬限期改派並同時列例外，逾期自動撤銷；agent 與服務帳號在負責人離任當天暫停，新負責人確認憑證已輪替才恢復；被授權者結束時授權失效 | 01f |
| `K-MEMBER-EXPAND` | 專案與 agent 的成員（含使用對象）增加視為授權擴大：經 `sys_member_change` 重跑該被授權者每筆有效授權的控制側關卡，所有級別都要簽 | 01f |
| `K-MEMBER-REDUCE` | 移除成員免簽。團隊成員隨人事事件自動異動，通知擁有者並列入複查 | 01f |
| `K-REAPPROVE` | 資源的級別調高時，受影響的有效授權須在 `grant.reapproval_grace_days` 內依新級別的路徑重新核准，逾期自動撤銷 | 01f |
| `K-INACTIVE` | 超過 `grant.inactive_days` 沒有使用紀錄的授權標記為久未使用，作為複查的風險訊號並列例外；沒有使用資料的來源照實標示 | 01f |
| `K-LEGACY-TRANSITION` | 既有權限匯入為 `origin = migrated`，不冒充核准；依風險分波，整體不超過 `migration.transition_days`；逾期先暫停再撤銷。`legacy_individual` 強制結束日，不能續期或擴大 | 01f |
| `K-RATIFY` | 追認：事後補單必須引用對帳發現，發現轉為已追認並保留未核准存在的期間；追認由兩個不同的人核准並加一關控制負責人，不得批次；簽核畫面第一眼顯示未核准期間 | 01f |
| `K-EMERGENCY` | 緊急路徑只開放給宣告可收回的權限；必填事件或工單編號；預設要一位合格的人即時事前核准（不得是宣告人或執行人），`emergency.preapproval_wait_minutes` 內無人回應時值勤的宣告人可先行，並自動列為較高嚴重度的例外；有效期以小時計，不得續期 | 01f |
| `K-EMERGENCY-REVIEW` | 緊急權限結束後一律事後覆核，附期間的實際操作紀錄（取不到時標示自報）；覆核人不得是宣告人、事前核准人、兩者的下屬或同一直屬主管下的同事；結論三選一（確屬緊急、不應走緊急、拒絕並開調查例外）；逾期列例外且宣告人在覆核完成前不得再宣告 | 01f |
| `K-PRIV-REVIEW` | 特權授權結束後一律由未使用的人覆核，附活動紀錄 | 01f |
| `K-ROSTER` | 知悉名單以自然人與時間切片記錄：授權生效、成員加入、查閱、簽核、執行、外部人登錄都自動寫入；新進者確認保密與禁止交易義務，未確認列例外；公告時名單凍結並產出帶雜湊的匯出檔 | 01f |

### 5.6 人事事件

權威來源的事實（雇用、單位、職位、主管、代理主管）不走簽核，平台內不提供覆寫；錯在來源就改來源。每種事件對進行中的單、負責的授權、所屬被授權者、角色、代理與保證各有固定的處置，處置事件引用人事事件。全部屬 01c。

| 代碼 | 規則 |
|---|---|
| `K-HR-HIRE` | 到職前（`pending_start`）主管可預先申請，生效以報到日與執行完成較晚者為準；到職取消即自動撤銷 |
| `K-HR-TRANSFER` | 調職：產生異動處理清單；自動移出舊團隊；專案成員由專案負責人在寬限期內重新確認；個人直接持有的授權交新主管確認；範圍角色交角色指派的管理者處理 |
| `K-HR-PROMOTION` | 升遷：主管線與依職位推導的角色隨之變更，進行中的關卡重新解析 |
| `K-HR-CONCURRENT` | 兼任：每個任職是一筆雇用或任命，簽核身分分開標示，職責分離仍以自然人判斷 |
| `K-HR-SECONDMENT` | 借調：由兩家公司的人資事件連結；借調期間依借調公司的雇用解析主管線，原公司的負責關係進入待移交 |
| `K-HR-LEAVE` | 留停超過 30 天：不被指派、不能當負責人（改派可標「暫代至復職」）；他給出的代理在留停日失效 |
| `K-HR-NOTICE` | 預告離職：授權迄日不得晚於最後工作日；擴大類申請自動加資安關；負責關係進入待移交 |
| `K-HR-TERMINATION` | 離職當天移出所有被授權者、待簽改派；標為立即處置時，唯一負責的授權立即暫停，近 90 天的經手清單交資安與控制負責人覆核；角色持有人離任時，繼任者覆核前任最後 30 天核准且仍有效的授權；申請人離職時進行中的單由被授權者負責人接手或取消 |
| `K-HR-REHIRE` | 再雇用建立新的雇用；舊權限、代理、角色不自動恢復 |
| `K-HR-ACTING` | 人資派代的代理主管是出缺解析的第一順位 |
| `K-HR-RENAME` | 更名不改身分對應；既有快照保留當時的姓名 |
| `K-HR-RESTRUCTURE` | 改組造成團隊擴大時，舊名單凍結為有迄日的過渡團隊並自動產生續期草稿；改組後的複查依新組織解析複查人 |
| `K-HR-RETRO` | 生效日早於得知日的離職或調職：期間內此人的決定列例外；仍在進行的關卡重新解析並重簽；已完成且仍有效的由依新資料應簽的人追認，或填理由確認無需處置。撤銷時效從生效日起算 |
| `K-HR-SYNC` | 同步分暫存、差異、門檻、套用四段；欄位增減或超過門檻即暫停，由人資的資料管理人加一位技術維運以外的人確認；只收固定的最小欄位；心跳逾時列例外，對狀態不確定的人擋下新決定，既有授權不動 |

### 5.7 證據

全部屬 01g，除另標者。

| 代碼 | 規則 |
|---|---|
| `K-AUDIT-APPEND` | 每個狀態變更、每個決定、每個設定變更都寫一筆事件，欄位齊全（誰、何時、什麼事、對什麼、結果、從哪裡、依據什麼）；紀錄只增不改，防改寫的 trigger 設為 `ENABLE ALWAYS`，並強制列層級安全 |
| `K-AUDIT-DENIED` | 被規則擋下的操作寫入 `outcome = denied` 的事件，含規則代碼 |
| `K-AUDIT-SNAPSHOT` | 每筆指派與決定封存 `basis_snapshot`（當時的姓名、工號、公司、單位、職稱、與申請人關係、resolver 與解析依據）與 `display_snapshot`（摘要、差異、警示、自動檢查、語言、附件雜湊）；每次分級與規則判斷記參數快照、路徑版本、hook 版本與函式雜湊 |
| `K-ACCESS-LOG` | 查看申請單詳情、證據頁、機密內容與每次匯出都寫查閱紀錄；查閱紀錄只有稽核、個資窗口、該流程的流程管理者能查，查查閱紀錄也留紀錄 |
| `K-AUDIT-CHAIN` | 雜湊鏈只算骨架，以保存的正規化 bytes 計算，可由第三方離線重算 |
| `K-AUDIT-SEGMENT` | 鏈依月分段並封印；高頻的判定紀錄與查閱紀錄以區塊承諾進主鏈 |
| `K-AUDIT-ANCHOR` | 定期、每次匯出、升版前後產生檢查點並推到至少兩個外部錨定位置，其中至少一個不由技術維運與資料庫管理員控制；不足不能離開啟動模式，之後中斷列最高嚴重度例外 |
| `K-STATE-CONSISTENT` | 業務表每列帶 `row_hash` 與 `last_event_seq`；判定與決定類 function 讀取時比對，不符即拒絕並開最高嚴重度例外；另以事件重播與物件指紋定期比對 |
| `K-RESTORE-GAP` | 啟動時與外部錨點比對，落後即進入 `restore_pending`；還原後第一筆事件寫明遺失的序號區間，不重算、不偽裝連續 |
| `K-ENV-IDENTITY` | 環境身分寫入鏈起點與每頁證據；身分不符即 `isolated`：排程不跑、對外不送；正式環境拒絕連到登記為模擬或測試的端點 |
| `K-CLOCK` | 正式發行包不含假時鐘的程式路徑；時間一律以 UTC 保存、對外以 RFC 3339 表示；時間倒退照常寫入並另開例外；時鐘偏差超過門檻告警 |
| `K-RETENTION` | 保存期依流程類型與紀錄類別設定並有起算基準；期滿的銷毀是銷毀該單的資料金鑰並寫事件，骨架保留；只銷毀已錨定、已過期、不在法律保全範圍內的資料；銷毀走 `sys_disposal` |
| `K-LEGAL-HOLD` | 法律保全範圍內排除銷毀與當事人刪除；建立與解除走 `sys_legal_hold`；每 6 個月提醒檢討 |
| `K-SUBJECT-RESTRICT` | 保存期內的個資刪除請求拒絕並標「限制處理」：從一般查詢、清單、匯出中遮蔽；期滿依 `K-RETENTION` 抹除 |
| `K-POPULATION` | 母體由有版本的定義加事件序號截止點產生，同一定義同一截止點的結果永遠相同；每張送審過的單都有終點；跨公司單同時出現在兩家公司的母體（01h） |
| `K-EXPORT` | 匯出必選用途，用途決定預設欄位；檔案加密、帶序號與浮水印；母體清單不含機密；產出本身寫事件（01h） |
| `K-CONFIDENTIAL` | 機密欄位的讀寫不經平台後端；保密流程的內容只有申請人、填單人、被指派的簽核人、執行人（只看交付內容）與選了查核案或填了目的的稽核看得到；清單與通知遮蔽摘要；日誌、錯誤回報、監控不記請求與回應內容（06） |
| `K-KEY-CUSTODY` | 逐單資料金鑰由主金鑰包裝；主金鑰在 KMS／HSM 或由 `key_custodian` 分持（至少 3 取 2，至少來自兩個單位，技術維運與稽核不得擔任）；輪替只增版本；每季自動做可解密性檢查（06） |

### 5.8 設定、發行與運作

全部屬 01h。

| 代碼 | 規則 |
|---|---|
| `K-CONFIG-CHANGE` | 所有平台設定（第 18.3 節的範圍）只能經 `sys_config_change` 變更：提出人以外的人核准、有版本、有生效時間、有影響試算、可回復 |
| `K-CONFIG-LOOSEN` | 放寬、路徑、角色指派的變更須流程擁有單位主管加該控制類別的控制負責人核准；核准人不得在提出人的上下屬鏈；方向無法判定視為放寬；稽核對每筆放寬收通知 |
| `K-CONFIG-BOUNDS` | 參數的 `hard_floor`、`hard_ceiling` 只能由發行版變更；核心規則沒有關閉開關 |
| `K-CONFIG-EFFECTIVE` | 生效時間不得早於最後一關核准時間；依據生效日早於設定生效日時，自動列出落差期間的單供權責主管追認；可預約生效並以人事事件為條件；`effective_to` 到期自動回復 |
| `K-CONFIG-FASTTRACK` | 只限設定定義標為可快速生效的類別（行事曆新增非工作日、切換到預先登記的備援端點、收緊方向的變更）：一人提出即生效，時限內另一人覆核，否決或逾期自動回復並列例外 |
| `K-CONFIG-TRANSITION` | 每張設定變更單必須宣告並一併核准與進行中申請單、既有授權的銜接方式。預設：收緊為進行中的單補上新增關卡（只增不減）加既有授權複查，放寬為只適用新案。「沿用送審時的版本」只適用路徑與參數，不適用組織事實與角色持有人；沿用舊版超過 30 天自動補上新增的關卡 |
| `K-BASELINE` | 安裝後處於啟動模式，只能指派第一批管理角色與提交 `sys_baseline`；核准後不能回到啟動模式，基準雜湊是第一個外部錨點；不設試營運模式 |
| `K-ROLLOUT` | 上線範圍依資源分批並走設定變更；資源一上線，任何部門取用都必須經平台；就緒報告未達 `rollout.readiness_min_percent`（單一持有人角色須 100%）時上線範圍的變更不能生效 |
| `K-RELEASE` | 客戶只安裝有簽章的發行版；升版須有程式變更上線流程中已核准的申請單（核准人與上線人不是開發者），套用前後寫 `release_install` 事件；hook 登記時記函式雜湊，啟動與排程時比對；發行版帶來的流程定義變更以待生效的設定變更單進入 |
| `K-CORRECTION` | 資料更正只能經 `sys_correction` 選用核心內建或流程包登記、且有測試的更正動作；更正是引用原事件的新事件 |
| `K-BREAKGLASS` | 平台自身的特權存取平常走特權流程；平台不可用時用預先封存、分持的破窗帳號（使用即告警；沒有簽核、執行、設定能力），事後補登並由資安覆核 |
| `K-DEGRADE` | 依賴服務中斷時依降級矩陣（第 16.4 節）處理，核心規則不因中斷而放寬 |
| `K-LICENSE-NEVER-BLOCKS` | 授權機制到期或超量只能停建立新申請與新增流程；撤銷、到期失效、驗證、對帳、稽核查詢與匯出、鏈驗證照常 |
| `K-NOTIFY-DELIVERY` | 通知分即時、彙整、僅站內三級，在收件人當地工作時段送出；催辦與升級的證據以寄送結果為準，連續失敗改通知主管並列例外；催辦與升級預告不能關，只能改通道；回信自動回覆「回信不會核准」並記錄（01a） |

### 5.9 例外、複查與偵測

| 代碼 | 規則 | 契約 |
|---|---|---|
| `K-EXCEPTION` | 例外有責任人（不得是造成者）、嚴重度、根因、改善計畫與佐證；條件自己消失只轉為待覆核；結案與接受風險須由責任人與造成者以外的人覆核，接受風險有到期日；不得批次結案；逾期升級給責任人的主管與控制負責人，稽核主管收通知 | 01h |
| `K-REVIEW-CYCLE` | 定期複查每 `review.interval_months` 自動建立，範圍涵蓋全部受管系統的授權、平台角色與 `api_client`；兩段決定（被授權者負責人確認仍需要 → 資源擁有者決定）；有風險訊號的逐筆決定並填理由，其餘分組確認，沒有全選；活動由控制負責人簽核完成 | 05 |
| `K-REVIEW-FREEZE` | 活動開始時凍結母體（快照、雜湊、筆數），含上次活動以來曾經有效的授權 | 05 |
| `K-REVIEW-NORESPONSE` | 未回應先升級、再暫停，不預設保留；撤銷決定直接執行，由下次對帳確認外部已移除 | 05 |
| `K-DETECT-RECIPROCAL` | 互惠核准 | 01h |
| `K-DETECT-CONFIG-FLIP` | 設定短期內改回 | 01h |
| `K-DETECT-SHORT-REVOKE` | 可匯出授權短期內撤銷 | 01h |
| `K-DETECT-MANAGER-FLIP` | 新主管關係被用於簽核後改回 | 01h |
| `K-DETECT-SAME-DEVICE` | 簽核裝置與申請人相同 | 01h |
| `K-DETECT-PRE-EXIT` | 離任前集中放行 | 01h |
| `K-DETECT-FAST-REVIEW` | 過短審閱與整批核准的比例 | 01h |
| `K-DETECT-SPLIT` | 疑似拆單 | 01h |
| `K-DETECT-EMERGENCY-RATE` | 緊急路徑使用頻率（依人、系統、流程類型） | 01h |
| `K-DETECT-URGENT-RATE` | 急件比率 | 01h |
| `K-DETECT-SHARED-ACCOUNT` | 帳號共用的跡象 | 01h |
| `K-DETECT-CLAIM-RELEASE` | 認領後放回群組的次數 | 01h |

偵測是對平台自己的決定紀錄做確定性規則，不是對日誌做行為分析。偵測到的例外派給該流程或系統的控制負責人，稽核收通知；門檻是設定，調寬屬放寬。

### 5.10 整合

全部屬 05。細部規則用 `K-INT-` 前綴。

| 代碼 | 規則 |
|---|---|
| `K-CHECK` | 權限判定在伺服器端依當下有效的授權回答，讀取時驗證 `row_hash`，每次判定寫 `decision_log`；`api_client` 只能詢問其範圍內的受管系統；保密流程的授權只回代碼；回應帶最長可快取時間；呼叫方連不上時一律視為拒絕 |
| `K-EVENT-DELIVERY` | 每次事件投遞的嘗試、狀態與對方確認都記錄；撤銷與暫停類事件未獲確認即列例外 |
| `K-RECON-FINDING` | 每筆對帳發現是一筆例外，有責任人與結案；回報原檔與雜湊封存；發現不因補單消失；回報由登記的呼叫方簽章送出或由 `reconciler` 上傳 |
| `K-RECON-COVERAGE` | 每個受管系統都有涵蓋狀態、管理人與對帳間隔；逾期未對帳、排定納管逾期、少於兩位管理人都列例外 |
| `K-CLIENT-GOVERN` | `api_client` 必有負責人、憑證有最長效期並支援新舊並存的輪替、納入定期複查；建立、範圍與金鑰輪替走設定變更；寫入類範圍必須以 `private_key_jwt` 簽章，由資料庫驗章 |

## 6. 流程包介面

原則是宣告優先、程式為輔：分級、縮小方向、重複判斷、摘要、權限項目都先用宣告表達；只有宣告表達不了的領域邏輯才寫 hook。合約用印與治理範本包完全宣告，不登記任何 hook。

### 6.1 登記

- 流程包在自己的 migration 裡呼叫 `sgn_sdk` 的登記入口，全部可重複執行：`register_role`、`register_setting_definition`、`register_setting_value`、`register_rule`、`register_message`、`register_notification_template`、`register_process_type`、`register_approval_policy`、`register_correction`、`save_case_template`、`retire_case_template`、`sync_resources`、`sync_scoped_role_assignments`、`report_tier_raised`。簽章在 01d。
- 登記產生的流程定義、路徑、參數值是新版本，以待生效的設定變更單進入，客戶核准後才生效（啟動模式下併入期初基準）。流程包的安裝與升版本身是設定變更。
- 登記 hook 時核心檢查：函式存在、簽章符合 `hook_api_version`、擁有者是 `sgn_pack_<代號>`；記下函式雜湊。核心支援目前與前一個主版本的 hook 介面。
- `hook_rules`：登記「hook 或宣告 → 流程包的規則代碼」。核心寫事件時同時記核心與流程包的規則代碼，以及流程包用到的參數值。
- 流程包不能直接讀寫 `sgn` 的資料表。讀取用 `sgn_sdk` 的 view（申請單、目前版本內容、被授權者、授權、執行結果）；讀參數用 `sgn_sdk.setting`；丟錯用 `sgn_sdk.raise_error`。

### 6.2 表單定義（`form_schema`）

欄位型別：`text`、`textarea`、`select`、`multiselect`、`integer`、`money`、`date`、`date_range`、`boolean`、`person`、`principal`、`company`、`counterparty`（結構化的交易對象）、`attachment`、`custom`（流程包註冊的前端元件名稱）。

| 屬性 | 意義 |
|---|---|
| `key`、`type`、`label`、`help` | 欄位鍵、型別、標籤與說明的文字 key |
| `required`、`max_length`、`min`、`max`、`min_items`、`default` | 基本檢查 |
| `options`、`options_source` | 固定選項；或由流程包的對外 function 即時提供 |
| `enabled_setting` | 依布林參數顯示或隱藏 |
| `true_label`、`false_label` | 布林欄位兩個值的文字 |
| `summary` | 列入摘要 |
| `reducible` | 縮小方向（見 6.3） |
| `confidential` | 機密欄位（第 20 節）；不得用於分級、摘要與重複判斷，除非宣告加密前的衍生值 |
| `personal_data` | 個資類別；含特種個資時由流程包決定加關 |
| `party_role` | 這個人員欄位對應的當事人角色 |

值的形狀：`money` 是整數（最小幣別單位）加幣別；`date_range` 是 `{"from","to"}`；`attachment` 是陣列，元素含 `attachment_id`、`file_name`、`sha256`；`person`、`principal`、`company` 存內部 id；`counterparty` 含名稱、統一編號或登記號、國別。被授權者與授權起迄不在內容裡，由核心保存與判定。

### 6.3 宣告式流程定義

`process_type` 的宣告與 `policy_stage` 的欄位。條件式是固定的運算子集合（欄位比較、`in`、存在、參數引用、`all`、`any`、`not`），不是程式；語法在 01d。

| 宣告 | 內容 |
|---|---|
| `tiering` | 有序的分級規則：條件 → 級別，並帶理由代碼。支援門檻取自參數 |
| `tiering` 的累計 | 同對象、N 天內、同公司、不分申請人的加總達門檻（防拆單） |
| `tiering` 的組合 | 以自然人可觸及的全部有效授權加本單一起評估 |
| `reducible` | 每個欄位的縮小方向：`decrease`（數值調降）、`shorten`（期間縮短）、`subset`（選項或項目減少）；未宣告的欄位任何修改都算擴大 |
| `overlap` | 重複判斷的比對鍵、正規化方式、比對對象的範圍、算完全涵蓋或部分重疊 |
| `summary` | 標題樣板與摘要欄位 |
| `entitlements` | 這張單核准的權限項目怎麼從欄位產生；`effective_during` 為 `validity`（存續型）或 `fulfilment`（一次性許可） |
| `fulfilment` | 交付內容的格式：`manual_task`（標題、事實、附件、完成回報的 `result_schema`）或流程包自訂的結構化格式 |
| `expiry_event` | 授權綁定的事件從哪個欄位或資源取得 |
| `requestables` | 需求導向搜尋用的名稱、說明與關鍵字 |
| `policy_stage.applies_when` | `null`（全部適用）、`{"tier_in": [...]}` 或條件式 |
| `policy_stage.sla` | `{"remind": <參數 key>, "escalate": <參數 key>}` |
| `policy_stage.checklist` | `[{"code","label","required"}]`：人工檢查清單 |
| `policy_stage.question` | 本關要簽核人判斷的問題 |

### 6.4 hook

流程包在自己的 schema 實作需要的 hook 並登記；沒登記的用宣告或預設行為。hook 不得修改核心資料表（`on_grant_event` 可以寫自己 schema 的表），除標明外必須是 `stable`。

| Hook | 簽章 | 回傳 | 沒有登記時 |
|---|---|---|---|
| `normalize_content` | `(p_actor bigint, p_content jsonb) returns jsonb` | `{"content", "notices": [{"code","message"}]}` | 原樣回傳 |
| `validate_content` | `(p_actor bigint, p_content jsonb) returns jsonb` | `[{"path","code","message"}]`；`path` 寫成 `scope[0].row_filters[1].values` | 空陣列 |
| `classify_tier` | `(p_content jsonb) returns jsonb` | `{"tier", "reasons": [{"code","message"}]}` | 依 `tiering` 宣告；沒有宣告則為排序最低的級別 |
| `compare_content` | `(p_old jsonb, p_new jsonb) returns text` | `same`、`reduce`、`expand` | 依 `reducible` 宣告；無法判定為 `expand` |
| `diff_content` | `(p_old jsonb, p_new jsonb) returns jsonb` | `[{"kind","label","detail"}]`，`kind` 為 added、removed、reduced、expanded、same | 依表單定義逐欄比較 |
| `summarize_content` | `(p_content jsonb) returns jsonb` | `{"title","subtitle","facts": [{"label","value","emphasis"}]}`，`emphasis` 是布林 | 依 `summary` 宣告 |
| `describe_impact` | `(p_case_id bigint) returns jsonb` | `[{"label","value","unknown"}]`：核准後會發生什麼；取不到就標 unknown，不編造 | 無影響陳述 |
| `find_overlaps` | `(p_case_id bigint, p_content jsonb) returns jsonb` | `{"level","items": [{"case_id","case_no","detail"}]}`，`level` 為 none、partial、covered | 依 `overlap` 宣告 |
| `stage_scopes` | `(p_stage_code text, p_content jsonb) returns setof text` | 這一關涉及的 `scope_ref` | 無 |
| `automated_checks` | `(p_case_id bigint, p_stage_code text) returns jsonb` | `[{"code","label","result","detail"}]`，`result` 為 pass、warn、fail。有 fail 時該關不能核准，只能退回或駁回 | 空陣列 |
| `list_parties` | `(p_case_id bigint) returns jsonb` | `[{"party_role","person_id"}]` | 依表單的 `party_role` 欄位 |
| `detect_interest` | `(p_case_id bigint, p_person_id bigint) returns jsonb` | `[{"kind","detail","mandatory_recusal"}]` | 空陣列 |
| `list_requestables` | `(p_actor bigint, p_query text) returns jsonb` | `[{"code","title","description","prefill"}]` | 依 `requestables` 宣告 |
| `batch_context_check` | `(p_case_id bigint) returns jsonb` | `[{"code","message"}]`：核心檢查之外不可批次的原因 | 空陣列 |
| `build_fulfilment` | `(p_case_id bigint, p_kind text) returns jsonb` | `p_kind` 為 provision 或 reclaim；回傳交付內容 | 依 `fulfilment` 宣告 |
| `build_verification_cases` | `(p_case_id bigint) returns jsonb` | `[{"code","description","expected","query"}]`：讀回比對之外的行為測試，`expected` 為 allow、deny | 空陣列 |
| `describe_entitlements` | `(p_case_id bigint) returns jsonb` | `[{"resource_type","resource_id","actions","constraints","effective_during","scope_ref"}]`；同一張單內資源不得重複 | 依 `entitlements` 宣告；都沒有則不產生授權 |
| `describe_expected_state` | `(p_resource_system_id bigint, p_scope jsonb) returns jsonb` | 對帳用的應有狀態（含主檔類資料） | 由有效授權的權限項目推得 |
| `evaluate_constraints` | `(p_constraints jsonb, p_context jsonb) returns boolean` | 請求情境是否符合限制條件；`p_context.mode` 為 check 或 reconcile | 沒有限制條件回 true；有限制條件而沒登記回 false |
| `on_grant_event` | `(p_grant_id bigint, p_event text) returns void`（`volatile`） | `p_event` 為 activated、suspended、resumed、expired、revoked | 不做事 |

### 6.5 呼叫保證

- 寫入任何內容版本前先 `normalize_content`，再 `validate_content`。
- 每個新版本重新分級；草稿先存檔才檢查重疊，所以 `p_case_id` 不為 null。
- `automated_checks` 之外，核心自己加上與領域無關的檢查：被授權者有在職負責人、每關不同人、期間在上限內、受益人與利害關係。
- 每次 hook 或宣告的判斷都記下發行版號、函式雜湊、輸入輸出摘要（`K-AUDIT-SNAPSHOT`）。
- 機密欄位不會傳給 hook；需要時由機密內容服務依宣告算出衍生值（第 20 節）。

## 7. 簽核人解析器與關卡模式

每一關宣告一種 resolver，由 `sgn_internal.resolve_stage_assignees` 統一解析，並在這裡套用職責分離、迴避、代理與出缺。執行、驗證、覆核階段的關卡用同一套機制。

| 種類 | 參數 | 解析方式 |
|---|---|---|
| `applicant_manager` | `line_kind`（line、functional） | 申請人在申請單所屬公司的雇用的直屬主管 |
| `principal_owner` | — | 被授權者的負責人 |
| `role_holder` | `role` | 該角色目前的持有人（一人） |
| `role_group_claim` | `role` | 該角色群組的任一合格成員認領 |
| `scoped_role` | `role` | 對 `stage_scopes` 回傳的每個範圍，找該範圍的角色持有人 |
| `authority_matrix` | 類別與金額的欄位 | 依核決權限表查出應簽的角色或層級 |
| `control_owner` | 範圍種類（流程、受管系統、控制類別） | 該範圍的控制負責人 |
| `system_custodian` | — | 本單涉及的受管系統的管理人（主要與備援，一人認領） |
| `system_reconciler` | — | 該受管系統登記的對帳執行人 |
| `meeting` | 會議別 | 搭配 `resolution` 模式；決定者是會議 |
| `governance_role` | `role` | 治理角色的持有人；供 `top_resolver` 使用 |

關卡模式（`policy_stage.mode`）：

| 模式 | 意義 |
|---|---|
| `one` | 解析出的一人決定；群組類 resolver 由一人認領 |
| `all` | 解析出的每個人都要核准（例如多位資料擁有者並行） |
| `resolution` | 會議決議（`K-RESOLUTION`） |

`parallel_group` 相同的關卡同時開啟，全部完成才往下。

規定：

- 解析時點：每關開始時解析，決定時重驗，人事事件到達時重派。
- 解析依據的具體程度（`K-SOD-DISTINCT` 用）：`scoped_role` 最具體，其次是角色類與 `authority_matrix`，最後是 `applicant_manager` 與 `principal_owner`。
- 出缺順序：人資派代的代理主管 → 上一層單位主管 → 該關宣告的出缺替代人 → `top_resolver`。都沒有就停住（`K-RESOLVE-HALT`）。
- 迴避順序：該關宣告的迴避替代人 → 上一層主管 → `top_resolver`；不得落到當事人的代理人或下屬。群組關卡套用職責分離後沒有合格成員時同此順序。
- 未認領的群組工作逾時：催辦全體合格成員，再逾時依出缺順序升級。執行階段依受管系統的主要管理人 → 備援管理人 → 業務擁有單位主管，並列例外。
- 持有稽核角色或技術維運角色的人不會被解析為任何關卡的決定者。任何角色都不能逐張指定簽核人。
- 每個工作記錄簽核身分（以哪家公司的什麼職務）與 `basis_snapshot`；解析出的人在該公司沒有職權（雇用或 `appointment`）就不指派。
- 簽核人不在而有人資登記的職務代理人時，直接指派給代理人並寫明來源；送出前就顯示「這一關會由某某代理」。

## 8. 參數

命名為 `<範圍>.<項目>`。核心前綴：`approval.`、`validity.`、`grant.`、`confirmation.`、`renewal.`、`delegation.`、`overlap.`、`fulfilment.`、`privileged.`、`emergency.`、`review.`、`retention.`、`audit.`、`decision_log.`、`authn.`、`session.`、`migration.`、`external.`、`rollout.`、`detector.`、`integration.`、`reconciliation.`、`evidence.`；流程包參數用流程包代號當前綴。

讀取一律經 `sgn_internal.setting`，依「最具體的適用範圍 → 全域 → 預設值」取值；每次決定用到的參數值記進事件。界限就是 `setting_definition` 的 `hard_floor`、`hard_ceiling`。預設值標 ＊ 的沒有法規或實務依據，是產品判斷。

| key | 意義 | 預設 | 界限 | 可依什麼設定 |
|---|---|---|---|---|
| `approval.remind_after_workdays` | 未簽多久催辦 | 3 | — | 公司、流程類型、級別 |
| `approval.escalate_after_workdays` | 催辦後多久升級 | 2 | — | 公司、流程類型、級別 |
| `approval.proof_level` | 決定的證明等級 | 依動作目錄 | 只能調高 | 流程類型、級別 |
| `approval.returned_expire_workdays` | 退回後多久自動取消 | 20＊ | — | 流程類型 |
| `approval.question_pause_max_workdays` | 提問暫停計時的上限 | 3＊ | 上限 10 | 流程類型 |
| `approval.batch_max_items` | 每批上限 | 20＊ | 上限 50 | 流程類型 |
| `validity.max_months` | 有效期間上限（`validity_unit` 為 day 時） | 12 | — | 流程類型、級別 |
| `validity.remind_before_days` | 到期前幾天提醒 | 14 | — | 流程類型 |
| `privileged.max_hours` | 特權授權的有效期上限（`validity_unit` 為 hour 時） | 8＊ | 上限 72 | 流程類型、級別 |
| `emergency.max_hours` | 緊急授權的有效期 | 4＊ | 上限 24 | 流程類型 |
| `emergency.preapproval_wait_minutes` | 等待事前核准的時間 | 15＊ | — | 流程類型 |
| `emergency.review_due_hours` | 事後覆核時限（從權限結束起算） | 72＊ | 上限 168 | 流程類型 |
| `renewal.max_gap_days` | 來源授權到期後多久內仍算續期 | 30＊ | 上限 120 | 流程類型 |
| `overlap.rejected_lookback_days` | 重疊檢查涵蓋多久內被駁回的單 | 90＊ | — | 流程類型 |
| `confirmation.due_workdays` | 確認時限 | 5 | — | 流程類型 |
| `confirmation.remind_every_workdays` | 確認逾期後多久再催 | 2＊ | — | 流程類型 |
| `fulfilment.provision_due_days` | 執行時限 | 3＊ | — | 受管系統 |
| `fulfilment.reclaim_due_days` | 收回時限 | 1＊ | — | 受管系統 |
| `grant.owner_grace_days` | 負責人異動寬限期 | 14＊ | — | 流程類型 |
| `grant.reapproval_grace_days` | 級別調高後重新核准的寬限期 | 30＊ | — | 流程類型 |
| `grant.inactive_days` | 久未使用的天數 | 90 | 只能調短 | 流程類型 |
| `grant.effective_delay_hours` | 核准後延後生效 | 0 | — | 流程類型、級別 |
| `grant.one_time_max_hours` | 一次性許可的最長時間 | 72＊ | — | 流程類型 |
| `delegation.max_days` | 自助代理的上限；超過需核准 | 30＊ | 上限 90 | 公司 |
| `review.interval_months` | 定期複查的週期 | 6 | 1–12 | 公司、流程類型 |
| `review.due_days` | 複查回應時限 | 15 | — | 公司 |
| `review.recusal_months` | 複查人迴避的回溯月數 | 0（關閉） | — | 公司 |
| `retention.years` | 保存年限 | 5 | 下限 5 | 流程類型、紀錄類別 |
| `decision_log.retention_years` | 判定紀錄保存年限 | 3 | 下限 1 | — |
| `audit.anchor_interval_minutes` | 檢查點與錨定的間隔 | 60 | 上限 1440 | — |
| `authn.credential_cooling_hours` | 新憑證冷卻期 | 24＊ | 下限 1 | — |
| `authn.idp_key_activation_hours` | 身分提供者新簽章金鑰的延遲生效 | 24＊ | 下限 1 | — |
| `session.idle_minutes` | 閒置登出 | 15＊ | 上限 60 | — |
| `migration.first_wave_days` | 既有權限第一波的追認期限 | 30＊ | — | 公司 |
| `migration.transition_days` | 既有權限的整體追認期限 | 180＊ | 上限 180 | 公司 |
| `external.sponsor_confirm_days` | 保證人定期確認的間隔 | 90＊ | 上限 180 | — |
| `rollout.readiness_min_percent` | 上線就緒門檻 | 95＊ | 下限 90 | — |

- 流程包以自己的參數表達領域值，例如資料授權的保存年限 10 年（待稽核室確認）是 `retention.years` 在 `process:data_access` 範圍的值；`seal.major_amount_threshold`；`vendor_bank.cooling_hours`（預設 48）。
- 偵測門檻用 `detector.<偵測代碼>.<項目>`，定義在 01h；對外整合介面的參數用 `integration.`、`reconciliation.`、`evidence.`，定義在 05。
- 受管系統的對帳間隔是 `resource_system` 的欄位，不是參數（第 19 節）。
- v1 的 `approval.mobile_mfa_required`、`system.allow_fake_clock`、`audit.retention_years` 已刪除。

## 9. 目錄結構與邊界規則

```
db/kernel/            核心 migration
db/packs/<代號>/      流程包 migration（表、hook、流程定義、參數、規則代碼、範本）；含 db/packs/governance/
db/testing/           測試專用 migration（假時鐘等），不進發行包
db/seed/              示範與驗收用的種子資料（不進正式環境）
db/tests/             kernel/ 與 packs/<代號>/
packages/contract/    路由表與共用型別（唯一來源）
api/                  後端核心；api/src/packs/<代號>/ 放流程包的 adapter
web/                  前端核心；web/src/packs/<代號>/ 放流程包專屬的輸入元件
vault/                機密內容服務（獨立部署，不與 api/ 共用程序與連線帳號）
e2e/                  端對端測試與 UI/UX 自動檢查
sim/                  模擬環境（不進發行包）
tools/                產生器、檢查腳本；tools/verify/ 是不依賴平台程式碼的離線驗證工具
deploy/               部署設定
docs/                 文件；docs/reference/ 為自動產生
```

邊界規則（檢查腳本驗證）：

- `db/kernel`、`api/src`（不含 `packs/`）、`web/src`（不含 `packs/`）、`vault/` 裡不得出現任何流程包的代號。
- 流程包的 migration 只能使用 `sgn_sdk` 與自己的 schema。
- `tools/verify/` 不得引用 repo 內其他目錄的程式碼。
- 發行包不含 `db/testing/`、`db/seed/`、`sim/`。
- 受保護路徑（職責分離、狀態機、雜湊鏈、驗章、授權檢查、時間入口）的變更須人工資安審查；清單在 01h。

## 10. 前端的通用畫面

畫面要顯示哪個按鈕，依後端回傳的可執行動作清單。系統判定的事實與申請人填寫的文字分區顯示。決定一律在平台內完成，郵件與聊天訊息只帶連結。

| 畫面 | 內容 | 流程包可以提供 | 規格 |
|---|---|---|---|
| 首頁與搜尋 | 待我處理、我的申請、需求導向的單一搜尋入口 | 可申請項目 | 04a |
| 新申請 | 依表單定義產生表單；沿用前案、範本、續期、職務套組；即時顯示級別與理由、路徑與每關會由誰簽、重複檢查；代填與申請人確認 | 專屬輸入元件 | 04a |
| 申請單詳情 | 進度精確到人與時間、摘要、內容、差異、問答、紀錄、驗證與確認 | 內容的專屬呈現 | 04a |
| 待簽清單 | 待我簽、我已簽、代理；簽核身分；批次（逐列勾選） | — | 04a |
| 簽核詳情 | 本關的問題、摘要事實、影響陳述、與前案或上次核准版本的差異、重疊與利害警示、自動檢查、參考區、可縮小的欄位、追認與未核准期間的標示、決定與決定證明 | 縮小用的專屬元件 | 04a |
| 我的決定、憑證、代理與助理 | 可撤回的決定、passkey 登記、代理與助理設定、通知偏好 | — | 04a |
| 執行佇列與執行詳情 | 認領、檢查清單、交付內容、完成回報、收回工作 | 交付內容的呈現 | 04b |
| 驗證與對帳 | 讀回比對結果、人工驗證紀錄、對帳檔上傳、發現的處理 | — | 04b |
| 授權總覽 | 我負責的、我擁有的資源上的、我可以使用的授權；撤銷、負責人異動、成員異動 | — | 04b |
| 複查活動 | 需求確認、擁有者決定、分組確認、風險訊號 | — | 04b |
| 異動處理清單 | 人事事件帶出的待辦，逐項分派 | — | 04b |
| 敏感事件與知悉名單 | 事件、公告確認、名單、義務確認 | — | 04b |
| 設定 | 所有修改產生設定變更單；結構化流程編輯器、試跑、影響試算、白話摘要；角色指派、受管系統、行事曆、語言包 | — | 04c |
| 上線就緒與上線範圍 | 期初基準、就緒報告、既有權限的追認進度 | — | 04c |
| 稽核準備度與例外 | 未結案的例外（轉換中與真正的例外分開）、技術控制區塊、追蹤報告 | — | 04c |
| 稽核查詢與證據頁 | 控制證據檢視、母體定義與截止點、抽樣、快照、重新判定、匯出（必選用途）、鏈驗證 | — | 04c |
| 營運狀態 | 排程、寄送、adapter、錨定、憑證到期、環境模式；不顯示任何申請內容 | — | 04c |

## 11. 對外整合介面

平台核准出來的授權要能被其他系統直接使用。這裡固定範圍與命名，詳細契約在 05。

| 能力 | 說明 | 命名 |
|---|---|---|
| 權限判定 | 「這個主體現在能不能對這個資源做這個動作」。情境可帶 `on_behalf_of` 與委派鏈；限制條件 `requires_per_use_approval` 回拒絕並帶申請入口 | `check` |
| 授權查詢 | 列出某主體、某資源、某受管系統的授權與限制條件；支援 `as_of` 與期間；可帶成員名單 | `grants` |
| 事件通知 | 授權生效、變更、暫停、到期、撤銷時通知訂閱的系統；推送與可重播的事件串流並存 | `events`、`webhook_subscription`、`webhook_delivery`、`integration_event` |
| 交付 | 受管系統拉取交付信封、回報完成 | `fulfilment` |
| 對帳 | 其他系統回報現況與異動紀錄，平台與應有狀態比對。發現分五類：未核准卻存在、超出核准、核准未設定、已失效仍存在、未核准的異動 | `reconciliation_run`、`reconciliation_finding` |
| 用量回報 | 回報授權的最後使用時間 | `usage` |
| 定期複查 | 見 `K-REVIEW-*` | `access_review_campaign`、`access_review_item` |
| 證據輸出 | 稽核事件、檢查點與封印、公司別的可驗證子集合、匯出紀錄，提供給稽核、GRC、SIEM | `audit_feed` |
| 安全事件 | 登入、驗證失敗、拒絕、匯出、查閱，與稽核事件分開輸出，帶連續序號，內容最小化 | `security_feed` |
| 代建草稿 | 外部系統只能建立草稿，須申請人確認才送審 | `drafts` |
| 待辦清單 | 待簽數與深層連結，決定回到平台 | `todo` |

規定：

- 呼叫方是登記過的系統 `api_client`（`K-CLIENT-GOVERN`）；每次呼叫都留紀錄。
- 介面與領域無關：主體、資源、動作、限制條件用通用結構。流程包以宣告或 `describe_entitlements`、`describe_expected_state`、`evaluate_constraints` 翻譯。
- 盡量採用公開標準；採用哪些在 05 決定並說明理由。判定回應不簽章。
- 對外路徑帶主版本（`/integration/v1/…`），同主版本只增不改，舊主版本至少再支援兩年。
- 這些介面只提供資訊與判定；實際擋下存取的仍是各系統自己。
- 檢查點由核心產生（01g），05 只負責輸出。時間造成的生效與失效在讀取時計算，下游以事件與查詢兩者對齊。
- `resource_system.authority` 決定哪些差異算未核准：`platform`（平台為準）、`external_iga`（對方為準，只匯入對方的核准紀錄做對帳與證據）、`mixed`。

## 12. 模擬環境

整合測試與端對端測試一律對著以真實協定運作的模擬環境 `sim/`；模擬替身只用在單元測試。每個服務都能用一支腳本啟動與停止，並有健康檢查。`sim/` 另打包成客戶可用的沙箱。

| 對象 | 模擬方式 |
|---|---|
| 人員與組織 | 真的 LDAP 伺服器，載入種子名單；另有 SCIM 2.0 與 CSV 兩種來源、請假與職務代理資料 |
| 登入 | 真的 OIDC 身分提供者；另有一個 SAML 身分來源經身分中介轉成 OIDC |
| 決定證明 | 瀏覽器自動化用的虛擬 passkey |
| 通知 | 真的 SMTP 伺服器（可用 API 讀信）；Teams 與 LINE WORKS 通道的模擬端點 |
| 受管系統 | DC（獨立服務與資料庫，把規則套用成真正的資料庫權限）；一個只用檔案交換的外購人資系統；一個只能人工的系統；付款系統（冷卻期與暫停付款）；部署管線 |
| 使用授權的系統 | 示範用的小系統：呼叫判定、訂閱事件、回報對帳與用量 |
| 證據 | 兩個錨定位置（物件鎖定儲存、時戳服務） |
| 機密 | 金鑰服務與機密內容服務；測試憑證機構 |
| 資料品質 | 髒資料與錯誤同步批次的種子（循環主管、主管是自己、未分級資源、對不到人的帳號） |

正式環境以端點指紋登記拒絕連到任何模擬端點（`K-ENV-IDENTITY`）。

## 13. 身分與決定證明

資料庫不信任後端傳入的身分。後端只負責轉送；「是誰」與「他決定了什麼」都由資料庫驗證身分提供者或使用者裝置簽發的證明。契約 01b。

### 13.1 session

- `api.session_begin` 發出一次性的 nonce；使用者在身分提供者登入；後端把原始的 ID token 交給 `api.session_open`；資料庫以登記的 `identity_provider_key` 驗章並檢查 `iss`、`aud`、`exp`、`nonce`，對到 `person_identity` 與有效的 `employment`，建立 `auth_session`。
- 登入只接受資料庫可驗章的 OIDC token；SAML 身分提供者經身分中介轉成 OIDC。可登記第二個身分提供者。平台不自己驗 TOTP、簡訊或推播，這些因子只會以 `amr` 出現。
- 驗章在資料庫內以 PL/pgSQL 實作（RS256、ES256），以公開測試向量驗證，列為受保護路徑。效能門檻是單次驗章 p95 小於 150 毫秒；不達標時改用只做驗章的擴充套件並修改工程規範。
- 身分提供者的簽章金鑰是受控設定：初次登記走設定變更；輪替的新金鑰匯入後先為 `pending`，延遲 `authn.idp_key_activation_hours` 生效並告警資安，可被否決。

### 13.2 證明等級與動作目錄

`action` 登記每個動作的類別與最低證明等級。等級寫在核心，設定只能調高。動作代碼寫成 `<對象>.<動詞>`（例如 `case.submit`、`task.approve`、`grant.revoke`），由擁有該對象的契約登記，完整清單彙整在 01b。

| 等級 | 取得方式 | 動作類別 |
|---|---|---|
| `session` | 有效的 session | 讀取、草稿、提問與回覆、徵詢意見、準備備註、認領與放回 |
| `idp_stepup` | 身分提供者以挑戰值為 nonce 重新驗證後簽發的 token | 送審、撤回、取消、申請人縮小、確認、一般級別的決定（核准、退回、駁回、執行完成、驗證紀錄、複查決定）、憑證登記、提出設定變更、對帳檔上傳、匯出 |
| `passkey` | 平台登記的 WebAuthn 憑證對挑戰值簽章，並要求使用者驗證 | 最高級別與重大案件的決定、`sys_` 流程類型的所有決定、高風險動作（代理、轉簽、加簽、助理設定、緊急宣告與事前核准、暫停或撤銷他人的授權、憑證作廢、接受風險、會議決議的登錄與確認）、外部人員的所有決定 |

- 決定證明綁定內容：`api.challenge_issue` 由資料庫算出對象清單（單號、內容版本雜湊、顯示快照雜湊、決定種類），產生一次性、5 分鐘內有效的 `decision_challenge`；使用者簽章或再驗證後，資料庫驗章並在同一個交易內完成決定。批次是一份清單、一次簽章。
- `decision_proof` 保存原始簽章資料，事件骨架引用它的雜湊，隨證據匯出，第三方可離線重驗。
- 沒有 passkey 的人以 `idp_stepup` 完成一般級別的決定；上線前檢查每位可能被指派的簽核人的憑證登記（`K-ROLLOUT`）。
- 「每筆決定類事件都有驗得過的證明」是每小時自我檢查與離線驗證工具都會檢查的不變條件。

### 13.3 機器呼叫方

`sgn_job`、`sgn_sync`、`sgn_integration` 碰不到決定類 function。`api_client` 的寫入類請求（對帳回報、執行結果、代建草稿、用量回報）以 `private_key_jwt` 簽章，由資料庫驗章。

### 13.4 殘餘風險（只能偵測，對外不得宣稱擋得住）

資料庫 superuser 與 `sgn_owner` 可以改 function 或公鑰；被攻破的前端可以讓使用者看到甲、簽下乙；身分提供者的管理員可冒名登入並登記新憑證。對應的偵測：物件指紋、`pgaudit` 外送、憑證登記與檢查點的外部錨定、離線重驗、決定後由資料庫產生的通知摘要、同裝置與過短審閱的偵測、冷卻期與通知本人。

## 14. 證據層

這個結構在寫 DDL 前定案；上線後再改等於重算全部既有雜湊。契約 01g。

### 14.1 骨架與封套

- 骨架是 `audit_event` 的欄位（第 2 節），以 RFC 8785 正規化後的 bytes 保存並進鏈，帶 `hash_version`。驗證不依賴 `jsonb` 的輸出格式。
- 封套有兩種：內容類（申請內容、附件、顯示快照、意見文字）與軌跡類（判定依據快照、姓名、IP、裝置），以逐單的資料金鑰加密。骨架對每個封套放兩個值：密文雜湊（不解密就能驗儲存完整）與明文的加鹽承諾（鹽在封套內，有權解密的人可驗內容與承諾相符）。
- IP 只取可信代理附加的那一段並保留原標頭；裝置分自報與已驗證（憑證 id）。

### 14.2 鏈、封印與錨定

- 單一主鏈；鏈依月分段，段落結束產生 `audit_segment_seal`（段根、筆數、首末序號）。驗證可從任一封印開始，依月平行。
- `audit_checkpoint`（序號、鏈頭、筆數、各公司的 Merkle 根、環境 id）每 `audit.anchor_interval_minutes`、每次匯出、升版前後產生，互相串接，寫回鏈上並推到 `anchor_sink`，回執存 `anchor_receipt`。RFC 3161 時戳服務是一種可選的 sink，不強制。
- 多公司：每個檢查點對每家公司計算該區間事件的 Merkle 根；子公司的會計師拿到該公司的事件與檢查點就能自行驗證完整性，看不到其他公司的內容。提供公司資料移交包。
- 高頻紀錄：`check` 的判定寫 `decision_log`，查閱寫 `access_log`，依期間彙總成 `log_block`，區塊雜湊寫入主鏈。
- 驗證排程：每小時增量、每日全量，不符即告警並開例外。`pgaudit` 記錄所有非 `sgn_app` 連線的 DDL、DML 與停用 trigger，送到外部。
- 公開演算法與測試向量；`tools/verify/` 可離線驗證鏈、封印、錨點、決定證明與公司別子集合；完整匯出為 JSON Lines 加清單檔。

### 14.3 還原與環境

啟動時與外部錨點比對（`K-RESTORE-GAP`、`K-ENV-IDENTITY`）。還原例外由控制負責人覆核結案。備份加密，取用列入特權存取；每週自動還原驗證與年度演練（含金鑰還原）產生證據。

### 14.4 保存與銷毀

- 保存期依（流程類型、紀錄類別）設定，參數 `retention.years`，起算基準 `retention_basis`：終局日、失效日或年度決算日。`retention_class` 為 `standard`（依參數）或 `permanent`（議事錄）。
- 銷毀是 `sys_disposal`：銷毀該單的 `case_key` 並寫事件，骨架保留；行為人的可識別資料在他最後一張相關單期滿後抹除。整段移除只能在段內所有內容都已銷毀之後做，是一張設定變更並留下封印。
- 依主體彙整（某人出現過的全部紀錄，標示本人、第三人、他人對本人的評論）與「某資源在某期間的接觸者」查詢是核心能力，供治理範本包的當事人請求與事故紀錄使用。
- 舊系統的歷史紀錄進唯讀的 `external_archive`，只寫一筆匯入事件，標示非平台產生，不進母體。

### 14.5 效能目標

十年資料量下：核准 p95 小於 1 秒、單月鏈驗證小於 10 分鐘，以十年量級資料壓測。權限判定的效能目標在 05 決定。

## 15. 例外與稽核作業

契約 01h。

### 15.1 例外

`exception`：種類（規則代碼）、偵測時間、對象、責任人、嚴重度（`critical`、`high`、`medium`、`low`）、根因分類、改善計畫（負責人、預定與實際完成日）、佐證、狀態、關聯的前案。規則見 `K-EXCEPTION`。

- 責任人依受管系統或流程類型指派；執行不一致的例外送業務擁有單位主管，不送回執行者。
- 來源包括：規則擋下的嘗試、逾期未簽、解析不到人、負責人或角色出缺、到期未處理、複查逾期、對帳發現、緊急未覆核、鏈驗證或錨定失敗、受管系統逾期未對帳、寄送連續失敗、偵測規則、線下決定、回溯的人事異動、角色衝突的持有、排程與自我檢查失敗。
- 稽核準備度把「轉換中」（期初待追認、在途承接）與「真正的例外」分開；轉換中逾期即轉為真正的例外。另有技術控制區塊（排程、錨定、鏈驗證、憑證到期、時鐘偏差、管理人一覽）。
- 每季產出追蹤報告。稽核不改例外的狀態、不被指派，只能查閱與提出 `audit_remark`。

### 15.2 母體、抽樣、快照

- `population_definition`：送審、核准或生效於期間內；期間內任一時點有效；期末時點有效。加事件序號截止點 `as_of_seq`。
- 完整性的證明：送審事件與單號一一對應，且與檢查點的事件筆數一致。
- `audit_sample`：記母體定義、截止點、母體雜湊、種子、演算法版本、樣本數、分層與必抽；以 SHA-256（種子‖單號）排序取樣，平台外可重算。不內建固定樣本數。
- `evidence_snapshot`：基準日凍結母體、例外與狀態，之後的補簽與追認另列為「快照後異動」；由控制負責人建立。
- 重新判定工具：以事件中的參數快照、路徑版本、內容版本、函式雜湊重算級別、路徑與職責分離，並與當時的結果比對。

### 15.3 稽核資料包

任選一段期間一鍵產出，由稽核自己操作：

- 第一頁：母體定義版本、參數、截止點、產出人、筆數、檔案雜湊、平台版本。
- 全部申請單的清單，每列含核准時間、執行完成時間、生效時間、核准人與資格依據。
- 每張單的完整時間線、決定證明與快照承諾。
- 例外清單與處理結果；期間內所有控制相關參數的值與變更歷程；設定變更清單；複查活動的統計；對帳的涵蓋與發現。
- 跨上線日時自動附控制轉換說明；自動產生的系統說明書（身分驗證、紀錄產生、雜湊與錨定、時間來源、存取控制）。
- 格式：JSON Lines 加清單檔，另有人可讀版本；可用 `tools/verify/` 驗證。母體清單不含機密內容。

`company_control` 讓客戶以自己的控制編號查詢與匯出；產品內建控制對照表，每列帶期間內的運作數量、例外與證據連結。營運指標全部由事件計算、可追到明細；個人層級的統計只給本人與直屬主管，不提供匯出。

### 15.4 稽核的查閱

- 稽核預設看到控制證據與非機密欄位；保密流程的摘要與機密欄位要先選 `audit_engagement` 或填目的才解密，並寫事件。稽核解密的明細只有稽核主管與 `audit_governor` 可查；個資窗口每月收到不含對象的彙總。
- 外部稽核是具名、有期限的外部人員（保證人為稽核主管），角色帶範圍；機密內容預設不可解密，由稽核主管逐案開放。

## 16. 環境、發行與運作模式

契約 01h。

### 16.1 環境

`environment`（id、`kind`：`production`、`test`；`mode`）。

| 模式 | 意義 |
|---|---|
| `bootstrap` | 啟動模式：只能指派第一批管理角色與提交期初基準 |
| `normal` | 正常運作 |
| `maintenance` | 升版中：只有升版工具可寫 |
| `restore_pending` | 落後外部錨點：唯讀，等還原例外處理 |
| `isolated` | 環境身分不符：排程不跑、對外不送 |
| `archive` | 唯讀封存：不需授權機制即可查詢、匯出與驗證 |

### 16.2 導入

- 期初基準 `sys_baseline`：全部設定的快照、雜湊與白話的基準報告；導入顧問提出，流程擁有者與控制負責人至少兩位主管核准，稽核見證。
- `rollout_scope` 依資源分批上線。受管系統有涵蓋狀態。資源上線日舊表單停收；在途單清單封存，以 `legacy_approval` 承接。
- 既有權限的承接與追認見 `K-LEGACY-TRANSITION`、`K-RATIFY`；以分群為單位確認，久未使用的不得成組，到期日錯開（只縮不長）。
- 期初資料品質：未分級的資源一律視為最高級別並標示；擁有者空缺依 `K-OWNER-FALLBACK`；循環與「主管是自己」在同步時擋下；組織資料健檢報告由人資確認。

### 16.3 發行與升版

規則見 `K-RELEASE`。發行版是有簽章的離線安裝包，附 SBOM、校驗碼與來源證明。同一發行版單一交易、維護模式、只往前修。緊急安全修補由資安長即時事前核准、事後完整覆核。每日比對資料庫物件指紋、角色與成員關係和最近核准的變更。開發期「有進度就進 main」（D7）不適用於發行。

### 16.4 降級矩陣

| 失效的依賴 | 行為 |
|---|---|
| 身分提供者 | 不能開新 session；已登記 passkey 的決定仍可進行 |
| 決定證明驗不過 | 不能決定 |
| 人員同步逾時 | 對狀態不確定的人擋下新決定；既有授權不動 |
| 金鑰或機密內容服務 | 看不到內容就不能核准 |
| 受管系統 | 交付與收回排隊並倒數時限；平台內的撤銷照常立即生效 |
| 錨定位置 | 繼續運作並列最高嚴重度例外 |
| 通知通道 | 改走其他通道；連續失敗依 `K-NOTIFY-DELIVERY` |
| 排程 | 有效性仍在讀取時計算；補跑依邏輯時間逐筆處理 |

中斷期間寫 `service_outage` 事件，催辦、升級、確認的時限順延，授權有效期不順延。

### 16.5 排程與自我檢查

排程以 advisory lock 保證單一執行；每個動作以（動作、對象、邏輯到期時間）為唯一鍵，重複執行不做事並記「跳過」。每小時自我檢查（排程心跳、寄送佇列、adapter、交付待確認、鏈驗證、憑證與金鑰到期、時鐘偏差、環境模式），失敗列入稽核準備度。參考架構：單機、本地同步複寫、加異地非同步；不做雙主。

## 17. 公司別維度

公司是核心的維度，不是租戶：同一個部署、同一條主鏈，資料依公司別區分可見範圍，不做雲端多租戶的資料隔離。

| 項目 | 依公司別的方式 |
|---|---|
| 人員 | `person` 是自然人；每家公司的任職是一筆 `employment`。集團內調動由兩家人資事件連結 |
| 組織與主管線 | `org_unit`、`reporting_line` 屬於公司 |
| 角色 | `role_assignment` 帶公司；角色分離可在集團層級滿足（跨公司服務指派，可見範圍受限） |
| 流程與路徑 | `process_type` 宣告適用公司；`approval_policy` 每家公司一份，各有 `top_resolver` |
| 參數 | 適用範圍種類含 `company` |
| 行事曆與時區 | `calendar_holiday` 依公司與據點；時限依簽核人在該關所代表的公司與據點計算；日期轉時間依公司時區 |
| 語言 | 公司預設語言；介面與通知依個人語言，缺翻譯時退回英文 |
| 申請單 | 公司別由 `company_from` 決定（內容歸屬），不由申請人選；單號含公司代碼 |
| 證據 | 單一主鏈加各公司的 Merkle 根；各公司的內容可指定儲存位置與獨立主金鑰 |
| 稽核與母體 | 稽核角色帶公司範圍；跨公司單在兩家公司的母體都出現 |
| 法域 | 公司有適用法域；被授權者公司與資料主體法域不同時由流程包標示跨境並加關 |

跨公司的申請與簽核：

- 需求側關卡跟申請人的雇用走。
- 控制側關卡取資源所屬公司的路徑，再加上申請人公司路徑中標為 `cross_company_required` 的關卡；門檻取較嚴者。
- 跨公司的職權來自 `appointment`；每個工作標示以哪家公司的什麼身分簽。

## 18. 平台管理角色與設定治理

契約 01h（角色實體在 01c）。

### 18.1 角色

沒有單一的系統管理員。平台管理類角色只能人工指派（`manual`），指派是設定變更。

| 角色 | 代碼 | 能做 | 不能做 |
|---|---|---|---|
| 技術維運 | `tech_ops` | 部署、升版、備份、監控、連線設定的提出 | 看申請內容、做任何業務決定、指定簽核人、核准設定變更 |
| 流程管理者 | `process_admin`（可依公司、流程類型、受管系統委派給業務單位） | 提出其範圍內的流程、路徑、參數、目錄、角色指派變更；核准他人提出的一般類或收緊類變更 | 核准自己提出的變更；逐張指定簽核人 |
| 控制負責人 | `control_owner`（依流程類型、受管系統、控制類別指派） | 核准放寬類變更、覆核例外與還原、追認加關、簽核複查活動、建立證據快照 | — |
| 稽核 | `auditor`（帶範圍） | 唯讀查閱、匯出、驗證、留言 | 任何決定（`K-AUDITOR-INDEPENDENT`） |
| 稽核主管、稽核治理人 | `audit_head`、`audit_governor` | 提出與核准稽核角色的授予；查閱稽核的解密明細 | — |
| 金鑰保管人 | `key_custodian` | 持有主金鑰的分持 | 由技術維運或稽核擔任 |
| 資安緊急停權 | `security_responder` | 暫停授權與 `incident_hold` | 恢復或撤銷自己暫停的對象 |
| 治理角色 | 各公司自訂（董事長、審計委員會召集人、指定的獨立董事、母公司指定的主管） | 作為 `top_resolver` | — |

業務上常用的控制角色（`ciso`、`compliance_officer`、`privacy_officer`、`legal_head`、`hr_data_steward`）由核心登記代碼，持有人由客戶指派。系統管理人與對帳執行人是受管系統上的範圍角色（第 19 節）。

### 18.2 衝突矩陣

核心預載，指派時檢查（`K-ADMIN-SOD`）。同一個自然人不得同時持有：

| 角色 | 不得同時持有 |
|---|---|
| `tech_ops` | `process_admin`、`control_owner`、`key_custodian`、`auditor` |
| `auditor` | `audit_head` 以外的任何平台管理角色、控制角色、治理角色、系統管理人、對帳執行人 |
| `process_admin` | 同一範圍的 `control_owner` |
| `system_custodian` | 同一受管系統的 `reconciler` |
| `security_responder` | 覆核其暫停的角色（`ciso`） |

小型公司無法避免時以有期限的例外持有並每月覆核；也可由集團內其他公司的人以跨公司服務指派擔任。原廠代管時，原廠人員以外部人員身分擔任技術維運。

### 18.3 設定變更

範圍：流程定義、路徑、參數、角色指派與「角色與職位的對應規則」、核決權限表、職責衝突矩陣、受管系統與其角色目錄和匯出檔對應、上線範圍、`api_client` 與 webhook 訂閱、可信代理清單、連線設定、身分提供者金鑰的初次登記、通知範本、行事曆、語言包、關係人名單、偵測門檻、對帳排除項、流程包的安裝與升版。權威來源的事實不在範圍內（`K-HR-SYNC`）。

每個設定定義有控制類別 `control_class`（`general`、`sod`、`security`、`evidence`、`privacy`、`authority`、`detection`）與方向（`tighten`、`loosen`、`neutral`）。類別決定誰是控制負責人，方向決定要不要他簽：

| 變更 | 核准人 |
|---|---|
| 一般或收緊 | 提出人以外、不在其上下屬鏈的流程管理者（同範圍；沒有時取上一層範圍） |
| 放寬、路徑、角色指派 | 流程擁有單位主管，加該類別的控制負責人 |
| 設定變更的路徑本身 | 兩個不同單位，加控制負責人 |
| 標為「控制瑕疵修正」 | 另加一位控制負責人；重判進行中的單，已生效授權限期補核，整件列為例外 |

每張變更單有白話摘要、影響試算（受影響的進行中申請單與既有授權）、試跑報告（流程定義）、銜接宣告與回復方式。稽核對每筆放寬收通知。其餘規則見 `K-CONFIG-*`。

流程管理者用結構化流程編輯器建立與修改流程（表單式建立欄位、級別條件、關卡；只能選固定的 resolver 種類；即時顯示流程圖與職責分離衝突），不提供自由畫布。

### 18.4 核心內建流程類型

| 流程類型 | 用途 | 提出 | 核准 |
|---|---|---|---|
| `sys_config_change` | 設定變更 | 流程管理者、技術維運（連線設定）、發行版（待生效） | 見 18.3 |
| `sys_baseline` | 期初基準 | 導入顧問 | 流程擁有者與控制負責人至少兩位主管；稽核見證 |
| `sys_member_change` | 專案與 agent 的成員增加 | 被授權者負責人 | 該被授權者每筆有效授權的控制側關卡（並行） |
| `sys_correction` | 資料更正 | 發現者 | 流程擁有單位主管加一位未參與原事件的人；稽核收通知 |
| `sys_disposal` | 期滿銷毀 | 流程擁有單位確認 | 法遵或個資窗口；稽核收通知並有異議期 |
| `sys_legal_hold` | 法律保全的建立與解除 | 法務或法遵 | 法務主管（在範圍內時改由 `top_resolver`）；提出人不得自核 |

這些流程類型適用全部核心規則，決定一律要 `passkey`。平台自己的升版走 `change_release` 流程包；平台自己的特權存取走 `account_access` 流程包。

## 19. 受管系統與整合方式

不預設資訊單位負責執行。每個受管系統有自己的擁有單位與管理人，執行、驗證、對帳都交給他們。契約 01f（對外介面在 05）。

`resource_system` 的關鍵欄位：

| 欄位 | 意義 |
|---|---|
| 代碼、名稱、公司 | — |
| 業務擁有單位 | 對這個系統負責的單位；擁有者與管理人出缺時的後援 |
| 整合方式 `integration` | `api`、`file`、`manual` |
| `authority` | `platform`、`external_iga`、`mixed` |
| 涵蓋狀態 | `managed`、`scheduled`、`excluded` |
| `ops_can_view_content` | 平台技術維運能否查閱與這個系統有關的申請內容；為否時相關流程一律以保密流程處理 |
| 主要與備援管理人 | `system_custodian` 的範圍指派；可以是業務單位的人或有保證人的外部廠商人員；少於兩位列常設例外 |
| 對帳執行人 | `reconciler` 的範圍指派；不得是管理人或執行人，預設也不得與執行人同一直屬主管或有上下級關係（放寬屬放寬類設定變更） |
| `reconcile_interval_days` | 對帳間隔：`api` 預設 1、`file` 預設 30、`manual` 預設 90；逾期列例外 |
| 交付金鑰與登記的端點、憑證指紋 | `K-FULFIL-ENVELOPE` 用 |
| 子表 | `system_role`（角色目錄）、`export_mapping`（匯出檔欄位對應）、`resource`（資源） |

三種整合方式產生同樣格式的證據：

| | `api` | `file` | `manual` |
|---|---|---|---|
| 交付 | 平台經 adapter 交付信封；對方驗鑑別碼後套用 | 管理人依交付內容在系統上設定 | 同 `file` |
| 完成回報 | 對方回報並帶回 `content_hash` | 管理人在平台回報 | 同 `file` |
| 驗證（讀回） | 平台自行讀回並比對 | 對帳執行人自行匯出權限清單上傳，平台依 `export_mapping` 比對 | 未參與的驗證人記錄實際觀察到的事實 |
| 對帳 | 平台定期讀取，或對方以簽章回報 | 上傳現況檔與異動紀錄檔 | 畫面盤點表，由第二人核對；標示「僅能人工盤點」 |
| 驗不了鑑別碼時 | — | 最小範圍憑證、每次交付寫事件、獨立對帳，列為已知風險 | 同 `file` |

- 匯出檔缺欄、出現未知角色、筆數驟降一律拒絕；筆數前後期勾稽。
- 對帳排除項 `reconciliation_exclusion`（理由、負責人、最長一年）走設定變更。
- 每筆交付與驗證結果記對方端點與憑證指紋，不在登記清單即失敗。
- 沒有受管系統的流程（用印、供應商主檔變更的回撥確認）以 `manual_task` 交付，驗證由路徑中 `verification` 階段的關卡指定未參與的人。
- 資安合規檢查與執行設定是兩件事：前者是控制側的簽核關卡，後者是執行階段的關卡，依 `K-SOD-FULFIL` 必為不同的人。
- 外部廠商人員作為管理人時只看得到交付內容，每季產生「受託者接觸報告」由內部負責人確認。

## 20. 機密內容與金鑰

平台只存「誰可以看什麼」的描述，不存受保護的資料本身；驗證只回報通過與否，不回傳資料。契約 06。

| 層次 | 做法 |
|---|---|
| 保密流程（`confidential_case`） | 整個流程類型（`always`）或依涉及的資源與受管系統（`by_resource`）判定；可見範圍依 `K-CONFIDENTIAL`；清單、通知與任何通道只顯示「你有一張待簽」；群組未認領前只看得到流程類型、級別與時限；手機預設遮罩、按住顯示並寫查閱紀錄 |
| 保密的被授權者 | 對外一律顯示代號，真實名稱存機密欄位；名稱相似比對只在保密的被授權者之間進行且不顯示名稱 |
| 機密欄位（`form_schema` 的 `confidential`） | 讀寫不經平台後端：瀏覽器憑資料庫簽發、綁定人、單號與用途的一次性許可，直接向機密內容服務（`vault/`）讀寫機密欄位與附件 |
| 衍生值 | 分級與摘要只能使用非機密欄位，或由機密內容服務依流程定義算出並附鑑別碼的衍生值；資料庫驗過才採用。不在瀏覽器端計算 |
| 附件 | 一律以該單的資料金鑰加密；類型允許清單、巨集檔預設拒絕、伺服器端轉成安全預覽、下載網域分離、掃描結果寫事件 |
| 金鑰 | 見 `K-KEY-CUSTODY`。保管人異動走設定變更；各公司可有獨立的主金鑰 |
| 維運除錯 | 先給去識別化的診斷包；不足時對特定單提出有時限的支援存取（由該流程的流程管理者核准，仍不可解機密欄位，全程寫查閱紀錄） |
| 合法調閱 | 治理範本包的 `content_disclosure` 流程 |

機密內容服務應部署在技術維運以外的管理範圍；做不到的小型公司可同機部署，但列為有期限的角色衝突例外。它每次解密獨立記錄，可與平台的查閱紀錄勾稽。金鑰與機密內容、錨定位置、通知通道、翻譯、附件掃描、簽章、機密來源、可列印檔產生都是 port（契約 07）。

## 21. 契約文件切分

接下來的契約依下表切分，可以平行撰寫。每份契約只定義自己擁有的東西；別人的東西只引用名稱。

### 21.1 文件清單

| 檔案 | 範圍 | 擁有的規則 | 相依 |
|---|---|---|---|
| `01a-kernel-foundation.md` | schema 與連線角色的授權、`api` 的結果信封與 `guard`、錯誤與訊息目錄、規則表、參數的儲存與讀取、公司與據點、行事曆、語言包、通知範本與寄送、排程、告知書 | `K-PRIVACY-NOTICE`、`K-NOTIFY-DELIVERY` | 只依骨幹 |
| `01b-kernel-identity.md` | 第 13 節：身分提供者與金鑰、session、憑證、動作目錄、挑戰與決定證明、資料庫內驗章（含 `private_key_jwt`） | 5.1（另標者除外） | 01a |
| `01c-kernel-directory.md` | 人員與組織實體、雇用、角色與指派、指定代理人、代理、助理、被授權者與成員、外部人員與委外合約、關係人、權威來源同步（`api_sync`）、人事事件與異動處理清單 | `K-EXTERNAL-SPONSOR`、`K-ROLE-CONTINUITY`、`K-ROLE-SOURCE`、`K-DELEGATE`、`K-ASSISTANT`、`K-PRINCIPAL`、5.6 | 01a、01b |
| `01d-kernel-process.md` | 流程定義實體、表單定義、宣告的語法與求值、`sgn_sdk`（登記入口與唯讀 view）、hook 的登記與呼叫、resolver 種類與路徑的啟用檢查、核決權限表、會議 | `K-STAGE-CONTROL-SIDE`、`K-TOP-RESOLVER`、`K-AUTHORITY-MATRIX` | 01a、01c |
| `01e-kernel-case.md` | 申請與簽核實體、申請單與工作的狀態轉移、簽核人的解析與指派、全部簽核動作、批次、急件、重疊檢查、範本與套組、線下決定、附件 | 5.2（另標者除外）、5.3 其餘、5.4（`K-PRINCIPAL` 除外）、`K-DECISION-ELIGIBLE`、`K-NO-REGRESS` | 01a–01d、01g |
| `01f-kernel-grant.md` | 第 19 節：受管系統與資源、執行與交付信封、驗證、確認、授權的生命週期、收回、成員異動、既有權限承接與追認、緊急路徑、特權覆核、職責衝突矩陣的比對、敏感事件與知悉名單、事故保留 | 5.5（`K-NO-REGRESS` 除外，含 `K-GRANT-REDUCE`）、`K-SOD-CONFLICT`、`K-SOD-FULFIL`、`K-VERIFY-INDEPENDENT`、`K-OWNER-FALLBACK` | 01a–01e、01g |
| `01g-kernel-evidence.md` | 第 14 節：事件骨架與封套、逐單金鑰的包裝介面、鏈、封印、檢查點與錨定、判定與查閱紀錄的區塊、狀態一致性、還原偵測、保存與銷毀、法律保全、依主體彙整、匯出格式與離線驗證工具的規格 | 5.7（另標者除外） | 01a、01b |
| `01h-kernel-governance.md` | 第 15、16、18 節：平台角色與衝突矩陣、設定變更、期初基準與上線範圍、發行與升版、更正、環境與降級、例外、偵測、稽核作業（母體、抽樣、快照、資料包、查核案、控制目錄） | 5.8（另標者除外）、`K-EXCEPTION`、`K-DETECT-*`、`K-AUDITOR-INDEPENDENT`、`K-AUDITOR-READONLY`、`K-ADMIN-SOD`、`K-POPULATION`、`K-EXPORT` | 01a–01g |
| `05-integration.md` | 第 11 節：機器介面（`api_int`）、`api_client`、判定、查詢、事件與 webhook、交付的拉取與回報、對帳、用量回報、定期複查、證據與安全事件輸出、代建草稿、待辦清單（既有草稿依 v2 改寫） | 5.10、`K-REVIEW-*`、`K-AGENT-CEILING`、`K-INT-*` | 01b、01f、01g、01h |
| `06-vault.md` | 第 20 節：機密內容服務的協定、一次性許可、衍生值、金鑰保管與輪替、附件的加密與掃描、診斷包與支援存取 | `K-CONFIDENTIAL`、`K-KEY-CUSTODY` | 01b、01g |
| `07-ports.md` | 後端的 port 與 adapter：身分提供者、人資來源（LDAP／AD、SCIM 2.0 接收端、CSV 或資料庫 view）、通知通道（email、Teams、LINE WORKS、PWA 推播）、受管系統 adapter、金鑰與機密內容、錨定位置、翻譯、附件掃描、簽章、機密來源、可列印檔產生；各自的合約測試與對應的 `sim/` 服務 | — | 01a、05、06 |
| `04a-screens-request.md` | 申請人與簽核人的畫面（第 10 節標 04a 者）、通知內容與分級 | — | 01e、06 |
| `04b-screens-custody.md` | 系統管理人、對帳執行人、資源擁有者、被授權者負責人的畫面（標 04b 者） | — | 01f、05 |
| `04c-screens-governance.md` | 流程管理者、控制負責人、稽核、技術維運的畫面（標 04c 者） | — | 01h |
| `02-pack-data-access.md` | 資料授權流程包（既有草稿依 v2 改寫）；含人資、財會兩個資料領域 | `DA-*` | 01d、01f、05 |
| `03-pack-seal.md` | 合約用印流程包（既有草稿改為完全宣告） | `SEAL-*` | 01d |
| `08-pack-account-access.md` | 系統帳號與角色權限（含特權、緊急、委外人員） | `AA-*` | 01d、01f |
| `09-pack-change-release.md` | 程式變更上線（含平台自己的升版） | `CR-*` | 01d、01f、01h |
| `10-pack-vendor-bank.md` | 供應商銀行帳號變更 | `VB-*` | 01d、01f |
| `11-pack-governance.md` | 治理範本包（五個全宣告的流程類型） | `GOV-*` | 01d、01g |

`08`–`11` 四個流程包還沒有 `docs/packs/<流程包>/rules.md`。規則文件是業務規則的唯一來源，要先寫並經專案負責人確認，才能寫契約。

### 21.2 跨模組的接點

跨契約的呼叫只能經過這些入口。這裡只固定名稱與擁有者，簽章由擁有的契約決定；需要新的接點時先在這張表加一列。

| 入口 | 擁有 | 用途 |
|---|---|---|
| `sgn_internal.guard` | 01a | `api` function 的外層：建立行為人情境、捕捉規則拒絕、回傳結果信封 |
| `sgn_internal.raise_error` | 01a | 丟出訊息目錄裡的錯誤（唯一入口） |
| `sgn_internal.setting` | 01a | 依適用範圍讀參數並記下用到的值 |
| `sgn_internal.now` | 01a | 取得時間（唯一入口） |
| `sgn_internal.enqueue_notification` | 01a | 寫入通知 |
| `sgn_internal.schedule_action` | 01a | 登記排程動作（動作、對象、邏輯到期時間） |
| `sgn_internal.actor` | 01b | 由 `p_session` 取得行為人、雇用與證明等級 |
| `sgn_internal.require_proof` | 01b | 驗證並消耗決定證明 |
| `sgn_internal.verify_client_assertion` | 01b | 驗證 `api_client` 的簽章請求 |
| `sgn_internal.has_role`、`sgn_internal.role_holders` | 01c | 角色與範圍的查詢（唯一入口） |
| `sgn_internal.resolve_manager` | 01c | 找主管與出缺順序（唯一入口） |
| `sgn_internal.effective_delegate` | 01c | 取得有效的代理人 |
| `sgn_internal.call_hook` | 01d | 呼叫 hook 或求值宣告，記版本、函式雜湊與輸入輸出摘要 |
| `sgn_internal.resolve_stage_assignees` | 01e | 解析一關的指派對象並套用職責分離、迴避、代理 |
| `sgn_internal.transition_case` | 01e | 申請單的狀態轉移（唯一入口） |
| `sgn_internal.transition_grant` | 01f | 授權的建立、暫停、恢復、撤銷、到期（唯一入口；撤銷須帶規則代碼） |
| `sgn_internal.write_event` | 01g | 寫稽核事件（唯一入口） |
| `sgn_internal.log_access` | 01g | 寫查閱紀錄 |
| `sgn_internal.log_decision` | 01g | 寫判定紀錄 |
| `sgn_internal.open_exception` | 01h | 開例外 |
| `sgn_internal.assert_environment` | 01h | 依環境模式與降級矩陣決定動作能否進行 |

### 21.3 撰寫規則

- 命名空間：`api` function 以對象為前綴，由擁有該實體的契約定義（例如 `session_`、`case_`、`task_`、`grant_`、`config_`）；流程包的對外 function 以流程包代號為前綴。訊息代碼以契約的領域為前綴：`core.`、`authn.`、`dir.`、`proc.`、`case.`、`grant.`、`evid.`、`gov.`、`int.`、`vault.`、`<流程包代號>.`。
- 每份核心契約的固定章節：範圍與相依、資料表（DDL）、狀態轉移表、function（簽章、授權、規則代碼）、規則對照（每個規則代碼 → function 與測試名稱）、參數、訊息、事件類型、通知事件、測試、對骨幹的修改建議。
- 每份流程包契約的固定章節：規則對照（`rules.md` 每一條 → 宣告、hook 或核心規則）、表單定義、級別與宣告、路徑與關卡、hook（若有）、權限項目、參數、訊息與通知、資料表（若有）、驗收案例。
- 骨幹沒有寫到、但撰寫時必須決定的事：寫進自己契約的「對骨幹的修改建議」並同步記到 `spine-feedback.md`，不得自行改名或改語意。骨幹與流程包規則有出入時不改規則文件，回報。
- 種子人員、公司與受管系統一律用 [seed-directory.md](seed-directory.md)，不另外發明。
- 建議順序：`01a`–`01d`、`01g` 只依骨幹，可先完成；其餘可同時起草，引用尚未完成的契約時只用本節的接點與第 2 節的實體名稱。全部完成後做一次交叉審查。

## 22. 第一版範圍與不做的事

### 22.1 第一版包含

- 核心：本文件第 2–20 節的全部能力。
- 流程包：資料授權（含人資、財會、客戶、營運四個資料領域與 AI agent 情境）、合約用印、系統帳號與角色權限、程式變更上線、供應商銀行帳號變更、治理範本。它們同時用來驗證平台，不一定同時上線給使用者。
- 對外整合介面的全部能力（第 11 節）與示範使用方。
- 機密內容服務、離線驗證工具、`sim/` 沙箱。
- 語言：繁體中文與英文。通知通道：email、Teams、LINE WORKS、PWA 推播。
- 人資來源：LDAP／AD、SCIM 2.0 接收端、CSV 或資料庫 view。登入：OIDC（SAML 經身分中介）。
- 結構化流程編輯器與試跑。
- 部署：地端的單一部署，支援集團多公司。

隨第一個需要的客戶交付（port、合約測試與 `sim/` 的對應服務第一版就有）：實體憑證機構的簽章 adapter；其他通知通道。RFC 3161 時戳服務是選用的錨定位置。

### 22.2 明確不做

都不是因為工作量；理由見 00-decisions。

| 不做 | 理由 |
|---|---|
| 跨部署的聯盟 | 沒有具體的落地要求可據以設計，現在做會做錯；需要完全隔離的法人以獨立安裝處理。觸發條件：出現連骨架資料都不得出境的客戶 |
| 雲端多租戶的資料隔離 | 是另一種部署模式 |
| 依職務自動給權 | 不經簽核的授權，等於自己開一條繞過簽核的路 |
| 主管機關通報的表單與流程 | 是適用機關自己的義務；平台只提供事故當下的時間切面事實 |
| 自由畫布式流程設計器 | 無法保證只產生核心允許的結構 |
| 原生 App | PWA 已能推播與使用 passkey |
| 在郵件或聊天卡片內直接核准 | 無法做決定證明 |
| 平台自驗 TOTP、簡訊、推播；本機密碼登入；後端直接做 SAML | 不綁內容、可被轉送；或讓後端重新成為身分的信任點 |
| 對日誌的行為分析 | 只對平台自己的決定紀錄做確定性規則 |
| 逐張指定簽核人、管理員改派、組織資料覆寫 | 就是挑人簽的手法；錯在來源就改來源 |
| 試營運模式、假時鐘參數、任何核心規則的關閉開關 | 只要是開關，兩個熟人就能打開它 |
| 每家公司一條鏈、雙主資料庫、硬體 WORM、區塊鏈、平台金鑰逐筆簽章、判定回應簽章 | 順序與截止點不再唯一，或擋不住內部人；稽核要的是可偵測與可驗證 |
| 內建固定的抽樣樣本數 | 樣本數是稽核的專業判斷；平台只保證選樣可重現 |
| 「誰看過我」查詢、個人層級統計的匯出 | 會讓受查單位知道查誰；個人指標用於考核是目的外利用 |
| 稽核做任何決定（簽核、核准、結案、持有金鑰） | 參與受查事項即喪失獨立性 |
| 保存受保護的資料本身、特權帳號的操作軌跡 | 平台只存「誰可以看什麼」的描述與下游回報的摘要 |

### 22.3 平台不保證的部分

公司是否照規定使用平台、外部系統是否照核准設定、特權帳號在各系統內的操作內容。平台以對帳、受管系統涵蓋與例外讓它們提早浮現，不對外宣稱「管理員完全改不了」或「推定本人親簽」。

### 22.4 屬於維運與商務文件、不在契約範圍

錨定位置與 KMS 的選型與部署、`pgaudit` 與連線來源限制、備份與參考架構的 RPO／RTO、最小人力配置、支援週期與修補時限、滲透測試與 SBOM、弱點揭露政策、原始碼託管、計價（外部人員、agent、稽核、只申請的人不按人頭計價）。

## 附錄 A：控制對照表與規則代碼

[audit/control-matrix.md](../audit/control-matrix.md) 的每個控制在本文件的對應。該表的「平台怎麼做到」與「缺口」欄要依此更新。

| 控制 | 規則代碼 |
|---|---|
| C-01 申請人不能自核 | `K-SOD-APPLICANT`、`K-SOD-DRAFTER`、`K-TRANSFER`、`K-ADDSIGN`、`K-DELEGATE`、`K-AUDIT-DENIED` |
| C-02 各關不同人 | `K-SOD-DISTINCT`、`K-CLAIM`、`K-SLA-ESCALATE`、`K-PARALLEL-ALL` |
| C-03 簽核人有資格 | `K-RESOLVE-STAGE-START`、`K-DECISION-ELIGIBLE`、`K-AUTHORITY-MATRIX`、`K-TOP-RESOLVER`、`K-AUDIT-SNAPSHOT` |
| C-04 找不到人時停住 | `K-RESOLVE-HALT`、`K-TOP-RESOLVER` |
| C-05 職責衝突矩陣 | `K-SOD-CONFLICT`、`K-SOD-PARTY` |
| C-06 申請、核准、執行、驗證分離 | `K-SOD-FULFIL`、`K-VERIFY-INDEPENDENT`、`K-EXTERNAL-SPONSOR` |
| C-07 覆核的痕跡 | `K-VERSION-BOUND`、`K-AUDIT-SNAPSHOT`、`K-ACCESS-LOG`、`K-BATCH`、`K-DETECT-FAST-REVIEW` |
| C-08 簽核身分可辨識 | `K-ACTOR-PROVEN`、`K-DECISION-PROOF`、`K-SESSION`、`K-NAMED-ACCOUNT`、`K-CRED-COOLING` |
| C-09 簽核綁定版本 | `K-VERSION-BOUND`、`K-FULFIL`、`K-FULFIL-ENVELOPE` |
| C-10 修改規則與沒有後門 | `K-CHANGE-REDUCE`、`K-CHANGE-EXPAND`、`K-RETURN`、`K-NO-REGRESS`、`K-CORRECTION` |
| C-11 重複與過量 | `K-OVERLAP-BLOCK`、`K-OVERLAP-REASON` |
| C-12 續期與批次 | `K-RENEW`、`K-BATCH` |
| C-13 核准早於生效 | `K-FULFIL`、`K-NO-BACKDATE`、`K-POPULATION` |
| C-14 執行結果與核准一致 | `K-VERIFY`、`K-VERIFY-INDEPENDENT` |
| C-15 人工的獨立驗證 | `K-VERIFY-INDEPENDENT`、`K-SOD-FULFIL` |
| C-16 申請人確認 | `K-CONFIRM` |
| C-17 有效期與到期 | `K-VALIDITY-MAX`、`K-VALIDITY-READTIME`、`K-EXPIRE`、`K-EXPIRE-REMIND`、`K-EVENT-EXPIRE`、`K-EVENT-DELIVERY` |
| C-18 在職的負責人 | `K-OWNER-CONTINUITY`、`K-OWNER-FALLBACK`、`K-PRINCIPAL` |
| C-19 人事異動 | `K-HR-TERMINATION`、`K-HR-TRANSFER`、`K-HR-RETRO`、`K-RECLAIM`、`K-EVENT-DELIVERY` |
| C-20 隨時可撤銷 | `K-REVOKE`、`K-SUSPEND`、`K-RECLAIM`、`K-CHECK` |
| C-21 定期複查 | `K-REVIEW-CYCLE`、`K-REVIEW-FREEZE`、`K-REVIEW-NORESPONSE` |
| C-22 久未使用 | `K-INACTIVE` |
| C-23 複查人迴避 | `K-REVIEW-SOD` |
| C-24 特權授權 | `K-VALIDITY-MAX`、`K-PRIV-REVIEW` |
| C-25 緊急授權 | `K-EMERGENCY`、`K-EMERGENCY-REVIEW`、`K-DETECT-EMERGENCY-RATE` |
| C-26 委外與外部人員 | `K-EXTERNAL-SPONSOR`、`K-EVENT-EXPIRE`、`K-CONFIDENTIAL` |
| C-27 程式變更上線 | `K-SOD-PARTY`、`K-VERIFY-INDEPENDENT`、`K-RECON-FINDING` |
| C-28 平台與流程包的升版 | `K-RELEASE` |
| C-29 紀錄只增不改 | `K-AUDIT-APPEND`、`K-AUDIT-CHAIN`、`K-STATE-CONSISTENT` |
| C-30 外部錨定與獨立驗證 | `K-AUDIT-ANCHOR`、`K-AUDIT-SEGMENT`、`K-RESTORE-GAP` |
| C-31 紀錄內容齊全 | `K-AUDIT-APPEND`、`K-AUDIT-DENIED`、`K-AUDIT-SNAPSHOT` |
| C-32 讀取留紀錄 | `K-ACCESS-LOG`、`K-AUDITOR-READONLY`、`K-CONFIDENTIAL` |
| C-33 時間可信 | `K-CLOCK` |
| C-34 保存期間 | `K-RETENTION`、`K-LEGAL-HOLD`、`K-CONFIG-BOUNDS` |
| C-35 證據匯出 | `K-CASE-NUMBER`、`K-POPULATION`、`K-EXPORT`、`K-AUDITOR-READONLY` |
| C-36 例外追蹤到結案 | `K-EXCEPTION`、`K-DETECT-*` |
| C-37 設定變更走簽核 | `K-CONFIG-CHANGE`、`K-CONFIG-LOOSEN`、`K-CONFIG-BOUNDS`、`K-CONFIG-EFFECTIVE`、`K-CONFIG-FASTTRACK`、`K-CONFIG-TRANSITION` |
| C-38 決定可重新執行 | `K-AUDIT-SNAPSHOT`、`K-RELEASE` |
| C-39 平台管理角色分離 | `K-ADMIN-SOD`、`K-AUDITOR-INDEPENDENT`、`K-TOP-RESOLVER`、`K-REVIEW-CYCLE`、`K-BREAKGLASS` |
| C-40 機密內容 | `K-CONFIDENTIAL`、`K-KEY-CUSTODY` |
| C-41 對帳 | `K-RECON-FINDING`、`K-RATIFY`、`K-EXCEPTION` |
| C-42 受管系統涵蓋 | `K-RECON-COVERAGE`、`K-ROLLOUT` |
| C-43 判定介面 | `K-CHECK`、`K-CLIENT-GOVERN` |
| C-44 非人類主體 | `K-PRINCIPAL`、`K-OWNER-CONTINUITY`、`K-REVIEW-CYCLE` |
| C-45 AI agent | `K-AGENT-CEILING`、`K-MEMBER-EXPAND`、`K-CHECK` |
| C-46 `api_client` 受治理 | `K-CLIENT-GOVERN` |

## 附錄 B：與流程包規則的出入

規則文件不得自行修改。下列各項核心照裁決實作；流程包契約撰寫時照這裡的「目前的處理」，並等專案負責人確認。前十一項出自 00-decisions 6.2，其餘是本次改寫發現的。

| 流程包規則 | 骨幹的做法 | 目前的處理 |
|---|---|---|
| 資料授權「升級後只有升級對象能簽」 | 升級對象可交回一次 | 做成選項 `escalation_handback`，資料授權關閉 |
| 資料授權「申請人確認」 | 負責人或指定成員也可確認 | 做成選項 `confirmation_parties`，資料授權只有申請人 |
| 資料授權「團隊解散時授權自動撤銷」 | 改組時以過渡團隊承接 | 需確認「改組」是否算「解散」 |
| 資料授權「不直接授權給個人」 | 期初匯入的個人權限以 `legacy_individual` 承接 | 只限匯入，逾期撤銷 |
| 資料授權「完全涵蓋：直接擋下」 | 只在同一被授權者時成立；快到期時改為部分重疊 | 需確認 |
| 資料授權「專案本身不帶任何權限」 | 成員增加視為擴大 | 規則缺漏，核心從嚴 |
| 資料授權「負責人離職或調職給寬限期」 | agent 與服務帳號在負責人離任當天先暫停 | 核心從嚴 |
| 資料授權「手機核准…MFA」 | 不分裝置都要決定證明 | 核心從嚴 |
| 資料授權「只有 MIS 系統管理員能修改設定」 | 設定變更走簽核 | 規則文字待更新 |
| 資料授權「紀錄保存年限 10 年（待稽核室確認）」 | 核心預設終局後 5 年 | 以 `retention.years` 在資料授權範圍的值保留 10 年 |
| 資料授權「上線範圍為全公司」 | 依資源分批上線 | 需確認 |
| 資料授權「MIS：資安合規檢查＋執行設定，由組內一人認領」 | 合規檢查是控制側簽核關卡，執行是另一關，依 `K-SOD-FULFIL` 必為不同的人；執行人是該受管系統的管理人 | 核心從嚴；規則待補充說明（原 A17） |
| 資料授權的撤銷名單沒有現任資料擁有者 | `K-REVOKE` 含資源的現任擁有者 | 已裁決（原 A24），規則待補充說明 |
| 資料授權沒有規定撤銷後收回外部設定、目錄調高分級的處理、L4 可否匯出 | `K-RECLAIM`、`K-REAPPROVE`；L4 不能申請匯出，開放屬放寬類設定變更（流程包規則） | 已裁決（原 A24），規則待補充說明 |
| 合約用印「用印前可由申請人或任一位簽核人取消」 | `K-CANCEL` 的名單另含被授權者負責人與執行人 | 需確認印鑑管理人能否取消 |
| 合約用印：金額調降到門檻以下 | 尚未開始的關卡依新級別重新套用（財務長關略過） | 需規則負責人確認 |
| 合約用印「職責分離…沿用核心」，核心新增 `K-SOD-FULFIL` | 印鑑管理人不得是申請人或該單簽核人 | 核心從嚴 |

## 附錄 C：v1 到 v2 的更名與刪除

依舊骨幹寫的草稿（02、03、05）改寫時逐項替換。

| v1 | v2 |
|---|---|
| `api` function 的 `p_actor` | `p_session`（hook 的 `p_actor` 不變） |
| `K-MOBILE-MFA`、`approval.mobile_mfa_required`、`case_task` 的裝置與 MFA 欄位 | `K-DECISION-PROOF`、`decision_proof` |
| `K-SETTING-ADMIN`、「路徑只能由升版變更」 | `K-CONFIG-CHANGE` |
| 角色 `sys_admin`、「升級給系統管理員群組」 | `tech_ops`、`process_admin`、`control_owner`；`top_resolver` |
| `system.allow_fake_clock`、`sgn.fake_now` | 刪除；測試實作在 `db/testing/` |
| `audit.retention_years` | `retention.years`（依流程類型與紀錄類別） |
| `error_catalog` | `message_catalog` |
| `requester_confirmation` | `case_confirmation` |
| 選項 `batch_renewal` | `batch_kinds` |
| hook 擁有者 `sgn_owner` | `sgn_pack_<代號>` |
| `classify_tier` 回傳 text | 回傳 `{tier, reasons}` |
| `build_fulfilment(p_case_id)` | `build_fulfilment(p_case_id, p_kind)` |
| `audit_event` 的 actor 角色、IP、裝置、代理、MFA、變更內容欄位 | 骨架加封套；`basis_snapshot`、`display_snapshot` |
| 05 的 `evidence_checkpoint`、檢查點簽章 | 核心的 `audit_checkpoint` 與外部錨定 |
| 資料表 `sgn.case`、`sgn.grant` | `sgn.case_file`、`sgn.grant_record` |
| `K-AUDITOR-READONLY`「可查全部」 | 可查其範圍內的全部 |
| 流程包直接讀 `sgn` 的表、呼叫 `sgn_internal` | 只經 `sgn_sdk` |
