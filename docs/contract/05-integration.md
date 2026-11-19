# 對外整合介面契約：讓其他系統參考、調用並持續把關權限

這份文件定義骨幹第 11 節六項能力的完整契約：權限判定（`check`）、授權查詢（`grants`）、事件（`events`、`webhook_subscription`）、對帳（`reconciliation_run`、`reconciliation_finding`）、定期複查（`access_review_campaign`、`access_review_item`）、證據輸出（`evidence`、`audit_feed`）。

命名、實體、狀態、hook 以 [00-spine.md](00-spine.md) 為準。本文件屬於核心：不得出現任何流程包的代號（範例除外，範例只出現在文件裡，不進 `db/kernel`）。

閱讀順序：第 1 節是採用哪些標準；第 2 節是本模組與核心其他部分的接點；第 3 節是通用模型；第 4 到 10 節逐項說明行為；第 11 到 15 節是實作清單（DDL、function、端點、代碼、參數、排程）；第 16 到 18 節是安全、檔案切分、測試與模擬環境。附錄 A 是骨幹修改建議，附錄 C 是已知限制，附錄 D 是需要其他契約配合的事項。

## 1. 採用的公開標準

### 1.1 查證結果（2026-11-19 查閱規格原文）

| 標準 | 版本與狀態 | 本文件用到的部分 |
|---|---|---|
| OpenID AuthZEN Authorization API | 1.0，OpenID Final Specification（2026 年 1 月核准） | 資訊模型（Subject、Resource、Action、Context、Decision）、Access Evaluation、Access Evaluations、PDP Metadata、HTTPS JSON 綁定 |
| OpenID Shared Signals Framework（SSF） | 1.0，Final（2025 年 9 月核准） | 只查證，第一版不實作（見 1.3） |
| OpenID CAEP | 1.0，Final（2025 年 9 月核准）。定義 8 種事件：session-revoked、token-claims-change、credential-change、assurance-level-change、device-compliance-change、session-established、session-presented、risk-level-change | 不採用：沒有「授權生效／撤銷」這類事件 |
| SCIM 2.0 | RFC 7643、RFC 7644（Standards Track）；RFC 9865（2025-10，游標分頁）；RFC 9967（2026-05，SCIM 事件，以 SET 表示） | 不採用（見 1.4） |
| CloudEvents | 1.0.2（規格庫最新的正式標籤） | 事件的格式：必要屬性 `id`、`source`、`specversion`、`type`；選用屬性 `time`、`subject`、`datacontenttype`；`sequence` 擴充屬性；HTTP structured mode（`application/cloudevents+json`） |
| Standard Webhooks | 1.0.0（社群規格，Apache 2.0；不是標準組織的標準） | 標頭 `webhook-id`、`webhook-timestamp`、`webhook-signature`；簽章 `v1`（HMAC-SHA256）與 `v2a`（ed25519）；重試、成功與失敗的判定、`410 Gone` 停用 |
| OAuth 2.0 | RFC 6749 第 4.4 節 client credentials；RFC 6750 Bearer token；RFC 9700（BCP 240，2025-01）安全實務 | 系統身分的驗證與 token 發放 |
| OCSF | 1.9.0（schema.ocsf.io 目前的預設版本；1.10.0 開發中） | 給 SIEM 的輸出格式：類別 3005 User Access Management、3004 Entity Management、6003 API Activity |
| JOSE | RFC 7515（JWS）、RFC 7517（JWK）、RFC 8037（OKP／Ed25519 金鑰）、RFC 9864（2025-10，以 `Ed25519` 取代多型的 `EdDSA` 演算法代號） | 檢查點的簽章、公開金鑰的發布 |
| RFC 3161 | Time-Stamp Protocol（2001-08） | 檢查點的外部時間戳記（選用） |

查證時確認、且會影響設計的事實：

- AuthZEN 的請求由 `subject`（`type`、`id` 必填，`properties` 選填）、`action`（`name` 必填）、`resource`（`type`、`id` 必填）、`context`（選填，自由結構）組成；回應是 `{"decision": true|false, "context": {...}}`。拒絕是 HTTP 200 加 `"decision": false`，不是 4xx。批次請求用 `evaluations` 陣列，頂層的 `subject`、`action`、`resource`、`context` 是預設值；`options.evaluations_semantic` 有 `execute_all`（預設）、`deny_on_first_deny`、`permit_on_first_permit`。預設路徑是 `/access/v1/evaluation` 與 `/access/v1/evaluations`，接在 PDP 的基底網址後面。中繼資料放在 `/.well-known/authzen-configuration`。請求識別用 `X-Request-ID` 標頭，請求帶了回應就必須帶同一個值。
- AuthZEN 把「回應的 `context` 放什麼」留給實作決定，也沒有定義判定結果的快取時間。依據（授權 id、申請單號）與快取秒數是本平台在 `context` 裡自訂的欄位。
- AuthZEN 的錯誤回應只規定狀態碼（400、401、403、500）與「一段錯誤訊息」。本平台回 `{"code","message"}`，與本站其他 API 相同。
- Standard Webhooks 的簽章內容：對稱是 `msg_id.timestamp.payload`，非對稱是 `endpoint_id.msg_id.timestamp.payload` 先做 SHA-256 再用 ed25519 簽。`webhook-signature` 可以放多個以空白分隔的簽章。早期的 `v1a` 已被 `v2a` 取代。
- Standard Webhooks 建議的內容欄位是 `type`、`timestamp`、`data`；CloudEvents 的時間欄位叫 `time`。兩者不完全相同（見 1.2 的取捨）。
- OCSF 3005 的必要屬性是 `time`、`user`、`metadata`、`category_uid`、`activity_id`、`severity_id`、`class_uid`、`type_uid`；`activity_id` 1 是 Assign Privileges、2 是 Revoke Privileges；`resource` 自 1.5.0 起改用 `resources`。3004 另外必要 `entity`。`metadata.version` 與 `metadata.product` 必填；`type_uid = class_uid * 100 + activity_id`；`time` 是毫秒的 UTC epoch。
- SCIM 使用者的 `entitlements` 屬性，RFC 7643 明文寫「No vocabulary or syntax is specified」，沒有資源、動作、限制條件的結構。
- OCSF 6003 API Activity（`category_uid` 6）的必要屬性是 `actor`、`api`、`src_endpoint` 加上各類別共通的 `time`、`metadata`、`category_uid`、`class_uid`、`activity_id`、`type_uid`、`severity_id`；`activity_id` 是 1 Create、2 Read、3 Update、4 Delete、99 Other。schema 的查詢介面另外把 `cloud`、`osint` 列為必要，這兩個屬性來自 profile，本平台不宣告這些 profile。`user` 物件的 `type_id` 是 0 Unknown、1 User、2 Admin、3 System、4 Service、99 Other，`type` 是它的名稱。

沒有查證的部分：各標準的認證測試（conformance suite）是否存在與涵蓋範圍；各廠牌 SIEM、IGA 產品實際支援到哪個版本；`cloud`、`osint` 在沒有宣告 profile 時是否會被個別 SIEM 產品的驗證器要求。導入時要對實際對接的產品再確認。

### 1.2 必須採用

| 標準 | 用在哪裡 | 理由 | 風險與處理 |
|---|---|---|---|
| AuthZEN Authorization API 1.0 | 權限判定的請求、回應、路徑、中繼資料 | 已是定案的最終規格；模型（主體、資源、動作、情境）與骨幹第 11 節的通用結構一致；支援 AuthZEN 的閘道與應用程式不用為本平台寫專屬程式 | 規格定案不到一年，產品支援還不普遍。處理：介面本身就是簡單的 JSON POST，不支援 AuthZEN 的系統照文件呼叫即可 |
| OAuth 2.0 client credentials（RFC 6749 4.4）＋ Bearer（RFC 6750） | 系統身分的驗證 | 機器對機器最普遍的做法；token 短效，密鑰不隨每次呼叫傳送 | 自建 token 端點要自己顧安全。處理：見第 4 節與第 16 節；之後可改接公司的身分提供者（見 1.3） |
| CloudEvents 1.0.2（JSON 格式） | 事件串流與 webhook 的事件格式 | 事件匯流排、閘道、SIEM 收集器普遍認得；推送與拉取用同一種格式 | `type` 建議以反向網域開頭，本平台沒有固定網域，用 `sgn.` 開頭。屬於 SHOULD，不影響相容 |
| Standard Webhooks 1.0.0 | webhook 的標頭、簽章、重試、停用條件 | 各語言有現成的驗證函式庫；簽章涵蓋 id、時間與內容，能防重放 | 不是標準組織的規格。內容欄位用 CloudEvents 的 `time`，不是它建議的 `timestamp`；驗證函式庫只看標頭與原始內容，不受影響。`v2a` 是規格較新的部分，函式庫支援可能落後，所以同時送 `v1` 與 `v2a` |
| OCSF 1.9.0 | 稽核事件與呼叫紀錄給 SIEM 的輸出格式（`format=ocsf`） | 主要 SIEM 與資安資料湖的共通格式 | OCSF 沒有「簽核」的類別，稽核事件只能對應到 3005 與 3004，細節放在 `unmapped`；呼叫紀錄對應到 6003。平台原生格式仍是完整來源 |
| JWS／JWK（Ed25519） | 檢查點簽章、公開金鑰發布 | 第三方用任何 JOSE 函式庫都能驗 | RFC 9864 剛把演算法代號從 `EdDSA` 改成 `Ed25519`。本平台簽章用 `Ed25519`；驗證工具兩個代號都接受 |

### 1.3 選用（介面已留位置，第一版不實作）

| 項目 | 做法 | 為什麼不放第一版 |
|---|---|---|
| RFC 3161 外部時間戳記 | 設定了時間戳記服務的網址才啟用；檢查點多一個 `tsa_token` | 需要公司有可用的時間戳記服務；沒有它，檢查點簽章與對外寄送仍然成立 |
| AuthZEN Search API（subject、resource、action 三個搜尋） | 之後加在 `/access/v1/search/*`；中繼資料目前不列這三個端點，依規格代表不支援 | `grants` 查詢已涵蓋需求，而且回的資訊更多 |
| SSF 1.0 發送端（以 SET 傳送事件） | 之後可以把同一批事件用自訂的事件類型 URI 包成 SET | 接收端多半是身分提供者，只認 CAEP、RISC 的事件類型；本平台的事件不屬於這些類型 |
| 改由公司的身分提供者發 token（JWT，RFC 9068） | `api_client` 對應到身分提供者的 client | 身分提供者尚未確認 |
| `private_key_jwt`（RFC 7523）、mTLS（RFC 8705）的 client 驗證與憑證綁定的 token | `api_client_credential` 之後加憑證種類 | 第一版以來源位址限制加上 token 綁定位址處理密鑰與 token 外洩的風險（4.10）；密鑰只在 token 端點出現 |
| Standard Webhooks 的 endpoint verification 擴充 | 之後以 `webhook-challenge` 標頭取代 ping | 第一版的 webhook 網址來源已由系統管理員事先登記，ping 足夠 |

### 1.4 不採用

| 標準 | 理由 |
|---|---|
| CAEP 1.0 的事件類型 | 8 種事件都在描述登入階段與憑證，沒有可以表達「授權生效、縮小、撤銷」的類型。硬套會讓接收端誤解 |
| SCIM 2.0（當作授權或對帳的格式） | SCIM 是帳號與群組的佈建協定；`entitlements` 沒有規定結構，無法表達資源、動作、限制條件，也就無法比對「超出核准範圍」。人員與組織的同步屬於核心的人員與組織 port，不在本文件範圍 |
| 自訂的 webhook 簽章、自訂的事件信封 | 已有公開規格可用 |
| syslog／CEF 推送 | 第一版由 SIEM 以游標拉取；需要推送時在收集器端轉換 |

## 2. 與核心其他部分的接點

核心契約（`01-kernel.md`）另行撰寫。本模組只依賴骨幹已固定的實體與 hook，加上下面列出的入口。帶 ⟨⟩ 的名稱是本文件暫用的名字，實際名稱以 `01-kernel.md` 為準；名稱不同時只需要改呼叫處，不影響本文件的行為定義。

### 2.1 本模組用到的核心入口

| 用途 | 暫用名稱 | 說明 |
|---|---|---|
| 取得現在時間 | ⟨`sgn_internal.now()`⟩ | 受假時鐘控制。本模組所有時間判斷都用它 |
| 丟出錯誤 | `sgn_internal.raise_error(代碼)` | 工程規範已固定 |
| 讀參數 | `sgn_internal.setting(...)` | 工程規範已固定 |
| 寫稽核事件 | ⟨`sgn_internal.write_audit(...)`⟩ | 本模組傳入：actor（人的 id，或 null 代表系統）、動作代碼、申請單 id（可為 null）、規則代碼、參數快照、變更內容（jsonb） |
| 檢查人的角色 | ⟨`sgn_internal.require_role(p_actor, 角色代碼)`⟩ | 角色代碼一律取自 `sgn_internal.integration_admin_role()` 與 `sgn_internal.integration_auditor_role()`（見下） |
| 找直屬主管 | ⟨`sgn_internal.resolve_manager(p_person_id)`⟩ | 骨幹第 7 節的升級規則：找不到上一層時交給系統管理員群組 |
| 找範圍角色的持有人 | ⟨`sgn_internal.resolve_scoped_role(角色, scope_ref)`⟩ | 複查對象是「擁有者」時使用 |
| 找有效的代理人 | ⟨`sgn_internal.resolve_delegate(p_person_id)`⟩ | 複查工作適用 `K-DELEGATE` |
| 寫通知 | ⟨`sgn_internal.enqueue_notification(事件代碼, 收件人, 內容)`⟩ | 寫入 `notification_outbox` |
| 計算工作天 | ⟨`sgn_internal.add_workdays(時間, 天數)`⟩ | 依 `calendar_holiday` |
| 撤銷授權 | ⟨`sgn_internal.revoke_grant(p_grant_id, p_actor, p_reason, p_rule_code)`⟩ | 複查與逾期處理要以自己的規則代碼撤銷；走核心唯一的狀態轉移入口 |
| 營業時區 | 參數 ⟨`system.business_timezone`⟩ | IANA 時區名稱，預設 `Asia/Taipei`。日期轉成時間一律用它（見 3.4）。骨幹納入前由本模組的 migration 登記（附錄 A 第 15 項） |

管理角色的代碼只寫在兩個地方：

```sql
sgn_internal.integration_admin_role()   returns text   -- immutable；目前回 'sys_admin'
sgn_internal.integration_auditor_role() returns text   -- immutable；目前回 'auditor'
```

本文件其餘地方寫的「系統管理員」「`sys_admin`」都是指 `integration_admin_role()` 回傳的角色，「稽核角色」「`auditor`」是指 `integration_auditor_role()` 回傳的角色。待納入的增修 A20（平台管理角色分離）定案後，只改這兩個 function（見附錄 D）。

本模組假設的核心欄位（只列用到的）：

| 資料表 | 欄位 |
|---|---|
| `sgn.person` | `id bigint`、狀態（是否在職） |
| `sgn.person_identity` | `provider text`、`external_id text`、`person_id` |
| `sgn.principal` | `id bigint`、類型（`team`／`project`／`agent`）、名稱、負責人的 `person_id`、狀態、結束日（日期，可為 null） |
| `sgn.principal_member` | `principal_id`、`person_id`、生效期間（起、迄；成員被移除時保留該列並填上迄，不刪除） |
| `sgn.process_type` | `id bigint`、`code text`、選項、hook 函式名稱 |
| `sgn."case"` | `id bigint`、單號、流程類型、申請人、被授權者、級別、狀態、目前版本、來源單、進入目前狀態的時間 |
| `sgn."grant"` | `id bigint`、申請單、被授權者、有效起迄（日期，含頭尾）、狀態 |
| `sgn.audit_event` | 序號、時間、actor、動作、申請單、規則代碼、參數快照、路徑版本、變更內容、前一筆雜湊、本筆雜湊 |

`case` 與 `grant` 是 SQL 保留字，本文件的 DDL 一律加雙引號。

### 2.2 投影：由觸發程序驅動，不靠呼叫方自律

整理好的權限表（`sgn.entitlement`）是判定與查詢的唯一來源，所以它不能依賴「核心每一條路徑都記得呼叫投影」。本模組在核心的資料表上掛觸發程序，任何路徑（狀態轉移、排程、日後新增的流程包、人工修正資料）只要改到這些欄位，投影就會執行。

| 觸發程序（都在本模組的 migration 建立） | 掛在 | 時機 | 做什麼 |
|---|---|---|---|
| `integration_case_projection_trg` | `sgn."case"` | `after insert or update of`（狀態、目前版本、被授權者）；`constraint trigger`，`deferrable initially deferred`，`for each row` | `sgn_internal.project_case(new.id)` |
| `integration_grant_projection_trg` | `sgn."grant"` | `after insert or update of`（狀態、有效起、有效迄、被授權者）；同上 | `sgn_internal.project_case(new.case_id)` |
| `integration_person_projection_trg` | `sgn.person` | `after update of`（狀態）；同上 | `sgn_internal.project_person(new.id)` |
| `integration_person_identity_trg` | `sgn.person_identity` | `after insert or update or delete`；同上 | `sgn_internal.project_person_identity(person_id, provider, 舊 external_id, 新 external_id)` |
| `integration_principal_projection_trg` | `sgn.principal` | `after update of`（負責人、狀態、結束日）；同上 | 負責人改變：`project_principal(new.id, 'owner_changed', …)`；狀態或結束日改變：對該被授權者每一張有未結束權限項目的申請單呼叫 `project_case` |
| `integration_member_projection_trg` | `sgn.principal_member` | `after insert or update or delete`；同上 | `project_principal(principal_id, 'member_added' 或 'member_removed', {"person_id", "valid_until"})` |

規定：

- 觸發程序是延後到交易提交時才執行的（`initially deferred`）。所以投影看到的是這個交易的最終狀態，一個交易裡對同一張單改幾次都只產生一組事件；事件的鎖也只在提交前的片刻持有（見 7.4）。
- 投影與造成改變的動作在**同一個交易**提交：投影失敗（例如 hook 回傳格式錯誤），整個交易回復，狀態轉移也不成立。
- `project_case` 依「目前的狀態」重新整理，不依賴呼叫的次數與順序；沒有改變時不產生事件。核心需要在交易中途就讀到投影結果時，可以直接呼叫 `sgn_internal.project_case(p_case_id)`，或執行 `set constraints all immediate`（資料庫測試都這樣做）。
- 規則代碼：造成改變的 function 在交易內呼叫 `sgn_internal.note_projection_rule(p_case_id bigint, p_rule_code text)`，投影產生事件時把它當作事件的 `rule_code`。沒有呼叫時事件的 `rule_code` 是 null，不影響其他行為。這是本模組對核心唯一的「請配合呼叫」，而且漏掉只會少一個欄位。
- 兩件事不是欄位改變，觸發程序接不到，仍由核心呼叫：負責人離職或調職開始寬限期時呼叫 `sgn_internal.project_principal(p_principal_id, 'owner_at_risk', {"grace_until": …})`；寬限期解除時呼叫 `project_principal(p_principal_id, 'owner_risk_cleared', '{}')`。漏掉的後果是少一個事件與少一個快取時間的上限，不影響判定結果。
- 時間造成的改變（到期、被授權者結束日到了、成員期間結束）不會觸發任何東西。判定在每次呼叫時自己檢查時間（5.3），使用方依各筆的時間欄位自行生效與失效（6.4）；另外由排程 `job_integration_consistency` 把儲存的狀態補齊（15.4）。

一致性檢查（規則 `K-INT-CONSISTENCY`）：排程 `job_integration_consistency` 對每一張「有未結束的權限項目」或「`grant` 是 `active`」的申請單，比較 `sgn.entitlement` 與 3.4 的推導結果。不一致時立即重投影，寫一筆稽核事件（動作 `integration.projection_repaired`，內容是申請單號與修正前後的狀態），並通知稽核角色。正常情況下這個工作永遠找不到差異；找到就代表有人繞過觸發程序改了資料，或觸發程序被停用。

migration 的順序要求：定義投影 function 與觸發程序的檔案，必須排在建立核心資料表與基礎函式的檔案之後（見第 17 節）。架構測試檢查上表六個觸發程序都存在而且是啟用的。

## 3. 通用模型

### 3.1 五個元素

| 元素 | 結構 | 說明 |
|---|---|---|
| 主體（subject） | `{"type", "id", "properties"}` | `type` 是 `person`（人）或 `principal`（被授權者：團隊、專案、agent）。`id` 是呼叫方認得的外部識別碼（見 3.2） |
| 資源（resource） | `{"type", "id", "properties"}` | 由流程包定義。`type` 符合 `^[a-z][a-z0-9_]{0,63}$`；`id` 是 1 到 512 個字元的字串，不含控制字元 |
| 動作（action） | `{"name", "properties"}` | 由流程包定義。`name` 符合 `^[a-z][a-z0-9_]{0,63}$` |
| 限制條件（constraints） | JSON 物件 | 核准時附帶的範圍限制。核心不解讀內容，只保存、回傳，並交給流程包的 `evaluate_constraints` 判定 |
| 情境（context） | JSON 物件 | 呼叫方描述這一次存取的範圍或環境。核心不解讀，原樣交給 `evaluate_constraints` |

一筆**權限項目**（`entitlement`）＝「某主體，對某資源，可以做某些動作，受某些限制條件約束，在某段時間內有效」，並且一定指向核准它的申請單。

對外所說的「授權」是指一張申請單核准出來的一組權限項目。有 `grant` 紀錄時附上 `grant_id`；流程沒有持續性授權時 `grant_id` 是 null，以申請單號（`case_no`）識別。

### 3.2 主體的識別

其他系統不認得本平台的內部 id，所以每個 `api_client` 登記一個身分來源（`identity_provider`），代表「這個系統用哪一種帳號識別人與被授權者」。

- `person`：`id` 是 `sgn.person_identity` 中該 provider 的 `external_id`。
- `principal`：`id` 是 `sgn.principal_identity` 中該 provider 的 `external_id`。這張表由本模組新增，結構與 `person_identity` 對稱。
- 保留的 provider `sgn`：`id` 是內部 id 的十進位字串。
- 每個 `api_client` 有一份可用的身分來源清單 `allowed_providers`，預設只有自己的 `identity_provider`。請求可以在 `properties.provider`（或查詢參數 `subject_provider`）指定清單內的其他 provider；指定清單以外的 provider 時，主體一律解析不到，結果與主體不存在完全相同。`sgn` 要列入清單，必須在登記時明確勾選並填原因（見 4.1），因為內部 id 是連續整數，可以被走訪。
- 回應與事件裡的主體，一律用呼叫方的 `identity_provider` 表示。該主體在這個 provider 沒有對應時，用不可逆的代號：

```json
{"type": "principal", "id": "anon-5d0c9a41f2b7e8c36a1d4f9b0e27c853", "properties": {"provider": "sgn_anon", "kind": "team"}}
```

  代號是 `'anon-' || 左 32 個十六進位字元( sha256( api_client.subject_salt || subject_kind || ':' || 內部 id ) )`。同一個呼叫方看到同一個主體的代號永遠相同（可以用來去重），不同呼叫方的代號不同，也無法推回內部 id。`sgn_anon` 不能用在請求裡。`allowed_providers` 包含 `sgn` 的呼叫方，沒有對應時改用 `sgn` 的內部 id。
- 被授權者另外帶 `properties.kind`（`team`、`project`、`agent`）。

**外部識別碼的對應由誰維護**（規則 `K-INT-IDENTITY`）。使用方是靠外部識別碼認主體的：把一個被授權者綁到使用方那邊另一個群組，等於把核准的權限轉給那個群組。所以：

- `person_identity` 屬於核心，由人員與組織 port 同步。
- `principal_identity` 只有兩個寫入來源：(1) 人員與組織 port 的同步（後端呼叫 `sgn_internal.set_principal_identity`，`source = 'sync'`）；(2) 系統管理員提出、經第二人覆核的變更申請（4.9；`source = 'change_request'`）。被授權者的負責人不能自己設定或取代對應。
- 覆核人不得是該被授權者的負責人或有效成員，也不得是提出人。
- 每一次建立、取代、移除，都在同一個交易內寫稽核事件（帶 provider、新舊 `external_id`、來源），並發出 `sgn.principal.identity_changed` 事件（7.1），使用方收到後必須丟掉以舊識別碼保存的權限與快取。
- 取代或移除既有對應時，以舊 `external_id` 或這個被授權者為主體的未結案對帳發現，全部標記為「不得由批次自動結案」（8.7），必須經獨立確認。
- `(provider, external_id)` 唯一。要把一個已被使用的識別碼改綁到另一個被授權者，必須先移除原本的對應（另一筆變更申請）。

主體與授權的關係：

| 流程類型的 `uses_principal` | 權限項目的主體 |
|---|---|
| 是 | 申請單的被授權者（`principal`） |
| 否 | 申請人（`person`） |

人透過成員身分取得被授權者的權限：判定與查詢一個 `person` 時，除了直接以他為主體的權限項目，也包含他目前是有效成員的所有被授權者的權限項目。回應的 `subject` 是實際持有權限的被授權者，並以 `inherited` 標明這是透過成員身分取得的。成員關係由 `sgn_internal.subject_principals` 這一個入口解析，它只認「在職的人、生效期間涵蓋指定時間的成員列、狀態有效且結束日未到的被授權者」。

成員名單以本平台的 `principal_member` 為準。使用方自己的身分來源（例如 LDAP 群組）與它不一致時，判定與對帳都依 `principal_member`；以人為單位設定權限的使用方，用 6.5 的成員端點與 `sgn.principal.membership_changed` 事件維護本地的名單。

### 3.3 流程包怎麼對應：兩個 hook

**`describe_entitlements(p_case_id bigint) returns jsonb`**

回傳這張單目前內容版本核准的權限項目陣列。每個元素：

| 鍵 | 必填 | 說明 |
|---|---|---|
| `resource_type` | 是 | 資源類型 |
| `resource_id` | 是 | 資源識別碼 |
| `actions` | 是 | 字串陣列，至少一個 |
| `constraints` | 是 | 物件；沒有限制時是 `{}` |
| `effective_during` | 否 | `active`（預設）或 `fulfilment`，見 3.4 |
| `scope_ref` | 否 | 這個資源所屬的範圍代碼（與 `stage_scopes` 回傳的代碼同一套）。定期複查要找「範圍角色的持有人」時使用 |

規定：

- 同一張單內，(`resource_type`, `resource_id`) 不得重複。重複時投影丟出 `entitlement_duplicate_resource`，該次狀態轉移失敗。
- 資源的粒度要等於使用方實際擋存取的最小單位。判定只做完全相同的 (`resource_type`, `resource_id`) 比對，沒有階層或萬用字元。
- 流程類型的選項 `has_validity` 為否時，不得回傳 `effective_during = active`（這種流程核准後直接完成，沒有持續有效的期間，見 3.4）。違反時投影丟出 `entitlement_hook_invalid`。
- function 必須是 `stable`，不得寫入任何資料表。
- 核心只在投影時呼叫它；判定時不呼叫。

`effective_during` 與 `scope_ref` 是本文件對骨幹回傳結構的補充，兩者都選填，不填時行為與骨幹原本的定義相同（見附錄 A）。

**`evaluate_constraints(p_constraints jsonb, p_context jsonb) returns boolean`**

核心在兩種場合呼叫，以 `p_context.mode` 區分。`p_context` 的完整結構：

```json
{
  "mode": "check",
  "strict": true,
  "at": "2026-11-19T02:15:00Z",
  "subject": {"type": "principal", "id": "17"},
  "action": {"name": "read", "properties": {}},
  "resource": {"type": "data_field", "id": "sales_order.amount", "properties": {}},
  "context": {},
  "usage": [],
  "approved_union": null
}
```

| 鍵 | 內容 |
|---|---|
| `mode` | `check`（權限判定）或 `reconcile`（對帳） |
| `strict` | 布林。`check` 模式下取自呼叫方的 `constraint_mode`（4.1）：`strict` 為 true，`advisory` 為 false。`reconcile` 模式固定為 true |
| `at` | 判定時間（`check`）或批次的 `observed_at`（`reconcile`） |
| `subject` | 持有這筆權限項目的主體，用內部 id（provider `sgn`） |
| `action`、`resource` | 請求或回報的動作與資源 |
| `context` | `check`：呼叫方在請求裡給的 `context`，原樣傳入。`reconcile`：其他系統回報的那一筆實際權限的 `constraints` |
| `usage` | 陣列。這筆權限項目先前回報過的實際使用（5.7），依回報時間排序，每個元素是 `{"context": {...}, "quantity": 整數, "occurred_at": 時間}`；沒有時是 `[]`。`reconcile` 模式固定是 `[]` |
| `approved_union` | 只在 `reconcile` 的聯集比對出現（8.5）：陣列，內容是同一主體、同一資源、同一動作在當時有效的**全部**權限項目的 `constraints`。其他時候是 null |

流程包要回答：

| 情況 | 回 true 的條件 |
|---|---|
| `check`，`strict` 為 true | 這次存取完全落在限制條件之內，**而且** `p_constraints` 的每一個限制面向都能從 `context`（必要時加上 `usage`）判定。任何一個核准的限制面向在 `context` 裡沒有出現，就回 false |
| `check`，`strict` 為 false | 這次存取落在限制條件之內。`context` 沒有提到的面向怎麼處理，由流程包決定並寫在自己的契約裡 |
| `reconcile`，`approved_union` 是 null | 實際設定的範圍完全落在 `p_constraints` 之內。回報沒有提到的面向，一律視為「沒有限制」 |
| `reconcile`，`approved_union` 是陣列 | 實際設定的範圍完全落在陣列中所有限制條件的聯集之內。流程包不支援聯集比對時回 false |

數量類的限制（例如「最多 2 份」）：流程包以 `usage` 中先前回報的用量加上這次請求的數量判定。使用方沒有回報用量時，`usage` 是空的，這類限制就只對單次請求有效（見 5.7）。

function 必須是 `stable`，不得寫入資料表，不得丟出例外（無法判定就回 false），而且看不懂的限制條件鍵必須回 false。

核心的呼叫規則（`sgn_internal.call_evaluate_constraints`）：

- `constraints` 是 `{}`：不呼叫 hook，視為符合。
- `constraints` 不是 `{}`，而流程類型沒有登記這個 hook：視為不符合（無法驗證就拒絕）。
- hook 丟出例外：視為不符合，並記下錯誤。

### 3.4 權限項目什麼時候有效

每一筆權限項目有三種狀態：`pending`（已核准，尚未生效）、`active`（有效）、`ended`（已結束）。狀態由主體、申請單與 `grant` 的狀態推導。推導依下面的順序，取第一個成立的。

**第一步：主體是否還有效**（兩種 `effective_during` 都適用）

| 情況 | 權限項目 |
|---|---|
| 申請單在 `draft`、`in_approval`、`returned` | 沒有權限項目（既有未結束的改為 `ended`，原因 `cancelled`；只會發生在已核准的單被退回重簽時） |
| 主體是人，而他不在職 | `ended`，原因 `subject_inactive` |
| 主體是被授權者，而它的狀態不是有效 | `ended`，原因 `subject_inactive` |

因 `subject_inactive` 結束的項目不會自動恢復：這張單的同一個資源已有一筆原因為 `subject_inactive` 的已結束項目時，之後的投影不再為它新增項目（人復職、被授權者重新啟用，都要重新申請）。

**第二步，`effective_during = active`**（持續性的授權；預設）

| 情況 | 權限項目 |
|---|---|
| 有 `grant`，`grant.status = active` | `active`；有效期間取 `grant` 的有效起迄 |
| 有 `grant`，`grant.status = expired` | `ended`，原因 `expired` |
| 有 `grant`，`grant.status = revoked` | `ended`，原因 `revoked` |
| 沒有 `grant`，申請單在 `pending_fulfilment` 或 `verifying` | `pending` |
| 沒有 `grant`，申請單在 `active` | `active`；`effective_from` 是申請單進入 `active` 的時間，`effective_until` 是 null |
| 沒有 `grant`，申請單在 `expired` | `ended`，原因 `expired` |
| 沒有 `grant`，申請單在 `revoked` | `ended`，原因 `revoked` |
| 沒有 `grant`，申請單在 `completed` | `ended`，原因 `completed`（`has_validity` 為否的流程不該走到這一列，見 3.3 的規定） |
| 申請單在 `cancelled`（不論有沒有 `grant`） | `ended`，原因 `cancelled` |

**第二步，`effective_during = fulfilment`**（一次性的許可：核准後到執行完成之間有效）

| 情況 | 權限項目 |
|---|---|
| 申請單在 `pending_fulfilment` | `active`；`effective_from` 是進入該狀態的時間；`effective_until` 是 `effective_from` 加上參數 `integration.fulfilment_permit_max_hours`（可依流程類型、級別設定） |
| 申請單在 `verifying`、`completed`、`active` | `ended`，原因 `consumed` |
| 申請單在 `cancelled`、`revoked`、`expired` | `ended`，原因同申請單狀態 |

一次性許可一定有結束時間：核准後一直沒有人標記完成，超過 `integration.fulfilment_permit_max_hours` 判定就拒絕（原因 `ended`）。驗證失敗退回執行（`verifying` → `pending_fulfilment`）時，會產生一筆新的權限項目與新的期限。

同一張單裡，上一次有、這一次 `describe_entitlements` 沒有回傳的項目：`ended`，原因 `removed`。

**有效期間的算法**

- `grant` 的有效起迄是日期（含頭尾）。`effective_from` 取起日當天 00:00，`effective_until` 取迄日**次日** 00:00，時區是參數 `system.business_timezone`：

```sql
effective_from  := (valid_from::timestamp)       at time zone sgn_internal.setting('system.business_timezone');
effective_until := ((valid_to + 1)::timestamp)   at time zone sgn_internal.setting('system.business_timezone');
```

- 主體是被授權者而它有結束日時，`effective_until` 取「上面的值」與「結束日次日 00:00（同一個時區）」較早的那一個。所以被授權者的結束日一到，判定就拒絕，不用等核心的排程處理。
- 判定時另外檢查時間：`active` 的項目還必須符合 `effective_from <= 現在`，而且 `effective_until` 是 null 或 `現在 < effective_until`。所以到期時間一到判定就拒絕，不用等排程把 `grant` 改成 `expired`。
- 儲存的 `status` 只反映申請單與 `grant` 的狀態，不隨時間自動改變：起始時間還沒到的項目，`status` 可能已經是 `active`；到期時間已過而排程還沒執行時，`status` 也還是 `active`。對外的每一筆都另外帶 `effective_now`（現在是否真的有效），使用方要以時間欄位為準（6.4）。

### 3.5 例子一：資料授權

本節的例子取自資料授權流程包契約（`02-pack-data-access.md`）§5.13 的範例 1，也就是它的驗收案例 1；資源類型、動作名稱與限制條件的鍵都以該契約為準。

申請內容（摘要）：申請人何宗翰；被授權者是團隊「通路業務組」（負責人劉俊傑）；主題包「銷售訂單」（`sales_order`）的 `order_no`、`customer_id`、`amount`、`order_date` 四個欄位，以及「客戶主檔」的三個欄位；列條件「區域 屬於 中區、北區」；資料期間 2025-01-01 到 2026-12-31；不可匯出；授權起迄 2026-11-16 到 2027-05-15；單號 `DA-2026-0004`。

流程包的 `describe_entitlements` 回傳（每個欄位一筆，共七筆，只列兩筆）：

```json
[
  {
    "resource_type": "data_field",
    "resource_id": "sales_order.amount",
    "actions": ["read"],
    "constraints": {
      "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
      "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}
    },
    "scope_ref": "sales_order"
  },
  {
    "resource_type": "data_field",
    "resource_id": "sales_order.order_date",
    "actions": ["read"],
    "constraints": {
      "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
      "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}
    },
    "scope_ref": "sales_order"
  }
]
```

對應方式：

| 申請單欄位 | 通用模型 |
|---|---|
| 被授權者 | 主體 `{"type": "principal"}`；團隊成員以 `person` 查詢時透過成員身分取得 |
| 主題包 → 欄位 | 資源 `data_field`，`id` 是「主題包代碼.欄位代碼」；`scope_ref` 是主題包代碼 |
| 查看／匯出 | 動作 `read`；可匯出時 `actions` 是 `["read", "export"]` |
| 列條件、資料期間 | 限制條件 `row_filter`、`data_period` |
| 授權起迄 | 權限項目的 `effective_from`、`effective_until`（來自 `grant`） |
| 使用情境 | 不進權限項目（它是核准的理由，不是存取的範圍） |

報表系統問「何宗翰（團隊成員）現在能不能讀 2025 年 3 月北區的訂單金額」：

```json
{
  "subject": {"type": "person", "id": "p08"},
  "action": {"name": "read"},
  "resource": {"type": "data_field", "id": "sales_order.amount"},
  "context": {
    "row_filter": [{"filter": "region", "op": "in", "values": ["north"]}],
    "data_period": {"from": "2025-03-01", "to": "2025-03-31"}
  }
}
```

流程包的 `evaluate_constraints` 在 `check` 模式下判定「請求的範圍是否是核准範圍的子集」：區域 {north} ⊆ {central, north}，期間在核准的期間內，回 true。

請求沒有帶 `row_filter` 時：

- 呼叫方是 `strict`（預設）：`p_context.strict` 為 true，核准的列條件沒有出現在請求裡，回 false；核心回 `reason: constraint_context_missing`，並在 `basis` 附上完整的限制條件，讓使用方知道要補什麼。
- 呼叫方登記為 `advisory`：`strict` 為 false，這個面向不檢查，回 true；使用方必須依回應裡的 `constraints` 自己套用這個條件。

對帳時，執行系統回報「角色 channel-sales 對 `sales_order.amount` 有 `read`，列條件是區域 in（central、north、south）」。`reconcile` 模式下 {central, north, south} ⊄ {central, north}，回 false，產生「超出核准範圍」的發現。回報裡完全沒有列條件時，視為沒有限制，同樣是超出。

### 3.6 例子二：合約用印（一次性許可）

這個例子說明「核准之後、執行之前」的一次性許可。同一種模型也適用於第一版的其他流程：部署工具在上線前問「這個版本核准了嗎」、付款系統在變更前問「這個供應商帳號的變更核准了嗎」。

合約用印流程包目前的契約（`03-pack-seal.md` 第 5.9 節）沒有登記這兩個 hook。本文件要求它登記，回傳的內容固定如下（列在附錄 D 第 1 項，交給該契約的作者）；在它完成之前，18.2 的情境 12 無法通過。

申請內容（摘要）：申請人吳家豪；合約「年度審計委任合約」，對象「正大聯合會計師事務所」；印鑑種類 `contract_seal`（合約專用章）；用印份數 `copies` = 2；合約檔案 `contract_files` 一份，SHA-256 是 `9f2c…e1`。

流程包的 `describe_entitlements` 回傳一筆：

```json
[
  {
    "resource_type": "company_seal",
    "resource_id": "contract_seal",
    "actions": ["affix"],
    "constraints": {
      "document_sha256": ["9f2c41d0a7b35e6c8f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6fe1"],
      "max_copies": 2
    },
    "effective_during": "fulfilment"
  }
]
```

對應方式：

| 申請單欄位（`03-pack-seal.md` 第 2 節的 key） | 通用模型 |
|---|---|
| 申請人 | 主體 `{"type": "person"}`（這個流程不使用被授權者） |
| `seal_kind` | 資源 `company_seal`，`id` 是印鑑種類的代碼 |
| 用印 | 動作 `affix` |
| `contract_files` 每個元素的 `sha256`（去重、由小到大） | 限制條件 `document_sha256`（陣列） |
| `copies` | 限制條件 `max_copies`（整數） |
| 有效時間 | `effective_during = fulfilment`：核准後到印鑑管理人標記完成之間有效，而且不超過 `integration.fulfilment_permit_max_hours` |

印鑑保管設備或電子用印系統在蓋章前問：

```json
{
  "subject": {"type": "person", "id": "p12"},
  "action": {"name": "affix"},
  "resource": {"type": "company_seal", "id": "contract_seal"},
  "context": {
    "document_sha256": "9f2c41d0a7b35e6c8f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6fe1",
    "copies": 2
  }
}
```

流程包的 `evaluate_constraints`（`check` 模式）回 true 的條件，三項都要成立：

1. `context.document_sha256` 是字串，而且在 `p_constraints.document_sha256` 裡。
2. `context.copies` 是 1 以上的整數。
3. `usage` 中每個元素的 `quantity` 加總，加上 `context.copies`，不超過 `p_constraints.max_copies`。

`context` 缺少 `document_sha256` 或 `copies` 時一律回 false，不論 `strict` 是什麼：「蓋在哪一份文件上、蓋幾份」正是核准的內容。`reconcile` 模式一律回 false（一次性許可不參與對帳，見 8.1）。

蓋完之後，設備以 5.7 的端點回報實際使用（`quantity` 是實際蓋的份數）。之後再問時，累計份數已達上限，判定拒絕。設備沒有回報用量時，`max_copies` 只限制單次請求的份數，累計要由使用方自己以 `basis[].entitlement_id` 為鍵計數；這一點寫在 5.7 與附錄 C。

同一套核心程式處理這兩個例子，差別只在兩個 hook 的實作與 `effective_during` 的值。

### 3.7 共通的表示方式

| 項目 | 規定 |
|---|---|
| 時間 | RFC 3339、UTC、以 `Z` 結尾、精確到秒，例如 `2026-11-19T02:15:00Z`。由資料庫以 `to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` 產生 |
| 用來算雜湊的時間 | 一律 UTC、精確到微秒：`to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`。不得直接把 `timestamptz` 放進 `jsonb_build_object`（輸出會隨連線的時區設定改變） |
| 對外的識別碼 | `entitlement_id`、`grant_id`、`run_id`、`finding_id`、`checkpoint_id`、`item_id` 一律是字串（內部 id 的十進位表示）。使用方不得假設它們連續或可以推算 |
| 序號與計數 | 數字。事件的 `sequence` 例外：依 CloudEvents 的擴充規格是補零的字串 |
| 雜湊 | 小寫十六進位字串 |
| 游標 | 不透明的字串，只能原樣帶回 |
| 沒有值 | 欄位仍然出現，值是 null；清單是空陣列 |
| 來自其他系統的文字 | `properties`、回報的 `subject.id`、`item_key` 等由其他系統提供的字串，在畫面、通知信與匯出檔中一律當純文字處理，不解讀為 HTML 或公式；CSV 匯出時，開頭是 `=`、`+`、`-`、`@`、Tab 或換行的儲存格前面加一個單引號。這一條列入畫面契約的驗收條件 |

## 4. 系統身分：`api_client`

### 4.1 登記

呼叫整合介面的每一個系統，都要先登記成一個 `api_client`。登記與任何擴大權限的修改都是「變更申請」：由系統管理員（角色 `sys_admin`）提出、另一位覆核後才生效（4.9）。登記、修改、停用都要填原因，並寫入稽核事件。

| 欄位 | 說明 |
|---|---|
| `code` | 系統代碼，同時是 OAuth 的 `client_id`。符合 `^[a-z][a-z0-9-]{2,47}$`，建立後不可修改 |
| `name`、`description` | 名稱與用途 |
| `owner_person_id` | 這個系統的負責人，必須是在職的人，而且不得是提出登記的人。對帳發現與停用通知都找他；密鑰只有他領得到（4.2） |
| `identity_provider` | 這個系統用哪個身分來源識別主體（見 3.2） |
| `allowed_providers` | 請求可以指定的身分來源清單。預設只有 `identity_provider`。要包含 `sgn` 必須另外填 `provider_sgn_reason` |
| `scopes` | 可以使用的能力（見 4.4） |
| 可見範圍 | 可以看到哪些流程類型、哪些資源（見 4.5） |
| `allowed_source_cidrs` | 允許的來源位址（CIDR 陣列），必填，至少一筆（見 4.10） |
| `token_binding` | `ip`（預設）或 `cidr`（見 4.10） |
| `constraint_mode` | `strict`（預設）或 `advisory`（見下） |
| `allowed_webhook_origins` | 允許的 webhook 網址來源（scheme＋host＋port），例如 `https://bi.example.com` |
| `upload_enabled` | 是否允許以檔案上傳的方式替這個系統對帳（8.9）。預設否 |

`constraint_mode`（規則 `K-INT-CONSTRAINT-MODE`）決定判定時怎麼處理「請求沒有提到的限制面向」：

| 值 | 行為 | 登記條件 |
|---|---|---|
| `strict` | 核准的任何一個限制面向沒有出現在請求的 `context` 裡，判定就拒絕（`constraint_context_missing`）。只看 `decision` 的標準 AuthZEN 使用方，接上來就是安全的 | 無 |
| `advisory` | 請求沒有提到的面向由流程包決定是否檢查；使用方必須自己套用回應裡的 `basis[].constraints` | 必須填 `constraint_mode_reason`（說明這個系統怎麼套用回傳的限制）；而且必須納入對帳：`scopes` 包含 `reconciliation.write`，或 `upload_enabled` 為 true。兩者都沒有時登記被拒（`api_client_advisory_requires_reconciliation`） |

登記時的其他檢查：

- `audit.read_all` 必須搭配 `audit.read`；登記或新增 `audit.read_all` 的變更申請另外需要稽核角色會簽（4.9）。
- `scopes` 包含 `audit.read` 或 `reviews.read`，而可見範圍有任何一列帶 `resource_type` 或 `resource_id_prefix` 時，`p_data` 必須帶 `"confirm_limited_audit_scope": true`，表示提出人知道這個系統只會取得遮蔽後的稽核與複查輸出（10.2、9.6）；這個確認記入稽核事件。沒有帶回 `integration_invalid_request`。
- `scopes` 包含 `reconciliation.write` 時，畫面與稽核事件都要顯示「這個系統可以讀到宣告範圍內的授權摘要」（見 4.4 的說明）。

負責人不在職時（`K-INT-CLIENT-OWNER`）：排程通知他的直屬主管改派，寬限期是參數 `integration.client_owner_grace_days`；逾期未改派，狀態改為 `suspended`。這和授權的 `K-OWNER-CONTINUITY` 是同一個原則：沒人負責就失效。

### 4.2 憑證（client secret）

- 建立憑證是變更申請（4.9），提出人可以是系統管理員或該系統的負責人。覆核通過後產生一筆「待領取」的憑證，並通知負責人。
- 密鑰只有負責人領得到：負責人登入後呼叫 `api_client_credential_claim`，資料庫這時才以 `pgcrypto` 的 `gen_random_bytes(32)` 產生密鑰（格式是 `sgn_cs_` 加上 43 個 base64url 字元），回傳一次，並寫稽核事件。系統管理員從頭到尾看不到原文。資料庫只保存它的 SHA-256 與最後 4 個字元（供辨識）。
- 待領取的憑證超過 `integration.credential_claim_hours` 沒有領取，由排程撤銷。
- 密鑰是 256 位元的隨機值，不是人設定的密碼，所以用單次 SHA-256 保存即可，不需要慢速雜湊。
- 每個憑證都有到期日，不得超過 `integration.credential_max_age_days`。到期前 `integration.credential_remind_before_days` 天起，排程每週通知負責人一次（`K-INT-CRED-EXPIRE`）。到期後不能再換發 token。
- 每個 `api_client` 同時有效（含待領取）的憑證不超過 `integration.credential_max_active` 個。
- 輪替：建立新憑證 → 負責人領取 → 使用方換上新密鑰 → 撤銷舊憑證。兩者並存期間都能用。
- 撤銷憑證不需要覆核（收緊的動作一個人就能做）。撤銷時，由它換發且尚未過期的 token 同時失效。

### 4.3 換發 token

採用 OAuth 2.0 client credentials（RFC 6749 第 4.4 節），client 驗證用 HTTP Basic。

```http
POST /integration/v1/oauth/token HTTP/1.1
Host: sgn.example.com
Authorization: Basic YmktcG9ydGFsOnNnbl9jc18uLi4=
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=check%20grants.read
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "access_token": "sgn_at_TRVmodffQqhRdFbWDqBu0oTlNc_kyVaqbuFy2835Rfc",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "check grants.read"
}
```

規則：

- `scope` 省略時，發給該 `api_client` 的全部 scope。要求的 scope 有任何一個不在登記範圍內，回 `invalid_scope`。
- token 是不透明的隨機值（`sgn_at_` 加上 43 個 base64url 字元），由資料庫產生，只保存 SHA-256。有效時間是 `integration.access_token_ttl_seconds`。不發 refresh token；過期就重新換發。
- token 記下換發時的來源位址，之後的每次呼叫都依 4.10 檢查。
- 後端在呼叫資料庫之前，先把收到的密鑰與 token 做 SHA-256，資料庫的參數裡只會出現雜湊值。
- 錯誤依 RFC 6749 第 5.2 節回應，內容是 `{"error": "...", "error_description": "..."}`：

| 情況 | HTTP | `error` |
|---|---|---|
| 沒有 Basic 驗證、`client_id` 不存在、密鑰錯誤、憑證過期、已撤銷或尚未領取、`api_client` 不是 `active`、來源位址不在允許清單內 | 401，並帶 `WWW-Authenticate: Basic realm="sgn-integration"` | `invalid_client` |
| `grant_type` 不是 `client_credentials` | 400 | `unsupported_grant_type` |
| 參數缺少、重複或格式錯誤 | 400 | `invalid_request` |
| 要求的 scope 超出登記範圍 | 400 | `invalid_scope` |
| **密鑰正確**，但這個系統換發太頻繁（`integration.token_rate_limit_per_minute`） | 429，並帶 `Retry-After` | `invalid_request`，`error_description` 是 `rate_limited` |

`invalid_client` 的各種原因對外完全相同，實際原因只寫進呼叫紀錄的 `internal_reason`。

失敗與成功分開計數（規則 `K-INT-AUTH-ALERT`）。處理順序固定是「先驗證，再決定套用哪一個計數」：

1. 驗證 `client_id`、密鑰、憑證狀態、系統狀態、來源位址。
2. 任何一項不通過：
   - 在 `sgn.api_auth_failure_counter` 累加兩個鍵：`('client', sha256(收到的 client_id 字串))` 與 `('ip', sha256(來源位址的文字))`。這張表的鍵是雜湊，不引用 `api_client`，所以代碼存在與不存在的處理完全相同。
   - 一律回相同的 401 `invalid_client`。不論失敗幾次，都不會變成 429，也不會影響這個系統以正確密鑰換發。
   - 呼叫紀錄：同一個來源位址在同一分鐘內的失敗，只有前 `integration.unauth_log_per_ip_per_minute` 次各寫一筆；超過的只累加計數（次數仍在 `api_auth_failure_counter`，不會遺失）。紀錄的 `internal_reason` 寫實際原因（`client_unknown`、`secret_mismatch`、`credential_expired`、`credential_revoked`、`credential_unclaimed`、`client_not_active`、`source_not_allowed`）；代碼對應到存在的系統時填 `api_client_id`。這些只在內部的紀錄裡，不影響對外的回應。
   - 代碼對應到存在的 `api_client`，而 `client` 鍵在這一分鐘的次數達到 `integration.auth_failure_alert_per_minute`：通知該系統的負責人與系統管理員（同一個系統每小時最多一次），寫一筆稽核事件（動作 `integration.auth_failure_alert`），並顯示在整合狀態。
3. 全部通過：累加 `sgn.api_rate_counter` 的 `token` 計數（鍵是 `api_client`）。超過 `integration.token_rate_limit_per_minute` 回 429；否則發 token。

所以只知道系統代碼、不知道密鑰的人，無法讓正牌系統換不到 token，也無法從回應分辨代碼存不存在。

### 4.4 可用範圍（scope）

| scope | 可以做的事 |
|---|---|
| `check` | 權限判定 |
| `grants.read` | 授權查詢、被授權者的成員名單 |
| `usage.write` | 回報權限項目的實際使用（5.7） |
| `events.read` | 讀取事件串流（授權與主體的事件） |
| `webhooks.manage` | 管理自己的 webhook 訂閱 |
| `reconciliation.write` | 回報實際權限、讀取自己的對帳結果與發現 |
| `reviews.read` | 讀取定期複查的結果 |
| `audit.read` | 讀取可見申請單的稽核事件（遮蔽後的版本，見 10.2） |
| `audit.read_all` | 讀取全部稽核事件與整合介面的呼叫紀錄（給 SIEM、GRC；等同稽核角色的檢視範圍）。它只擴大 `audit.read` 的範圍，所以必須與 `audit.read` 一起登記 |
| `evidence.read` | 讀取鏈頭與檢查點 |

`reconciliation.write` 隱含對宣告範圍的讀取：對帳的結果會告訴回報方「哪些權限有核准、哪些沒有」。為了不讓它變成沒有管制的查詢介面，發現的明細依呼叫方有沒有 `grants.read` 分兩種輸出（8.6）：沒有 `grants.read` 的系統只拿到 `missing` 的筆數與不含核准內容的發現；完整的明細由負責人在本站的畫面查看。

每個對外 function 需要哪個 scope，登記在資料表 `sgn.api_function_scope`，這是唯一來源；路由表與參考文件由它產生。

### 4.5 可見範圍

`sgn.api_client_visibility` 的每一列是一條允許規則：

| 欄位 | 意義 |
|---|---|
| `process_type_id` | 可見的流程類型（必填） |
| `resource_type` | 只看這個資源類型；null 表示該流程類型的全部資源 |
| `resource_id_prefix` | 只看 `resource_id` 以這段文字開頭的資源；null 表示不限 |

一筆權限項目對某個 `api_client` 可見，條件是至少有一列規則符合：流程類型相同，`resource_type` 是 null 或相同，`resource_id_prefix` 是 null 或是 `resource_id` 的開頭（以 `starts_with` 比對，不是樣式比對）。

一張申請單對某個 `api_client` 可見，條件是它至少有一筆權限項目（不論狀態）對這個 `api_client` 可見。沒有任何權限項目的申請單，對所有沒有 `audit.read_all` 的呼叫方都不可見。

主體沒有獨立的可見規則：一個主體是否可見，取決於它有沒有可見的權限項目。

「整個流程類型可見」是指存在一列規則，流程類型相同而 `resource_type` 與 `resource_id_prefix` 都是 null。

規則 `K-INT-VISIBILITY`：所有查詢、判定、事件、對帳、複查、稽核輸出都先套用可見範圍。範圍以外的東西，回應與「不存在」完全相同。

**可見範圍或身分來源改變之後**（規則 `K-INT-SYNC-EPOCH`）：`api_client` 有一個整數 `sync_epoch`。`api_client_visibility` 的任何增減、`identity_provider` 或 `allowed_providers` 的改變，都把它加一，並發出只給這個呼叫方的事件 `sgn.client.visibility_changed`。所有游標（授權查詢的 `since`、`page_token`，事件串流的 `after`）都內含發出當時的 `sync_epoch`；帶著舊值來的請求回 409 `integration_resync_required`，使用方必須丟掉本地保存的權限，重做完整快照（6.4）。

### 4.6 暫停與停用

| 狀態 | 意義 | 效果 |
|---|---|---|
| `active` | 正常 | — |
| `suspended` | 暫停，可恢復。由系統管理員設定，或負責人寬限期逾期時由排程設定 | 所有 token 立即無效；不能換發 token；webhook 暫停推送（保留進度） |
| `disabled` | 永久停用，不可恢復 | 同上；另外撤銷所有憑證，webhook 訂閱改為 `disabled` |

狀態在每次呼叫時檢查，所以暫停與停用是立即生效，不受 token 的有效時間影響。暫停與停用是收緊的動作，一位系統管理員就能做；從 `suspended` 恢復成 `active` 也只需要一位（恢復的是先前已覆核過的設定）。

### 4.7 每次呼叫的紀錄

規則 `K-INT-CALL-LOG`：對 `/integration/v1/` 的每一次通過驗證的呼叫，不論成功或失敗，都在 `sgn.api_call_log` 留一筆。

- 成功的呼叫：由被呼叫的 `api` function 在同一個交易內寫入（`sgn_internal.log_api_call`）。
- 失敗的呼叫（function 丟出錯誤，交易已回復）：由後端另外呼叫 `api.integration_record_failure`，在獨立的交易裡寫入並累加失敗計數（4.8）。它會重新判斷失敗的實際原因（token 不存在、過期、系統不是 `active`、來源位址不符等），寫進 `internal_reason`；這個欄位不對外輸出。
- 沒有通過驗證的呼叫（回 401 的）與 429：為了不讓無效請求灌爆紀錄表，同一個來源位址（401 時）或同一個 `api_client`（429 時）在同一分鐘內，只有前 `integration.unauth_log_per_ip_per_minute` 次各寫一筆，超過的只累加計數。「每次呼叫都留紀錄」的保證適用於通過驗證的呼叫；沒有通過驗證的，保證的是次數不遺失。
- 記錄的內容：時間、`api_client`、token、請求識別碼、function 名稱、HTTP 狀態、錯誤代碼、內部原因、耗時、來源 IP、筆數、摘要。
- 摘要（`summary`）依端點不同：權限判定記每一筆的主體、動作、資源、結果、原因與依據的權限項目 id；查詢記篩選條件與回傳筆數；對帳記批次與筆數。情境（`context`）不記原文，只記 SHA-256，因為裡面可能有業務資料。
- 這張表只增不改。

**封存**。排程 `job_integration_call_log_seal` 與檢查點同一個節奏（`evidence.checkpoint_interval_minutes`），排在 `job_evidence_checkpoint` 之前執行，所以每個檢查點都涵蓋在它之前封存的呼叫紀錄。一次封存涵蓋一段連續的 id 範圍，分兩個階段、兩個交易：

1. 劃定範圍：`lock table sgn.api_call_log in share row exclusive mode`（`lock_timeout` 5 秒，拿不到就等下一輪）。拿到鎖代表所有進行中的寫入都已提交，這時讀出最大的 id，寫一列 `api_call_log_seal`（`first_id` 是上一段的 `last_id + 1`，`last_id` 是剛讀到的最大 id，`digest_sha256` 是 null），然後提交、放掉鎖。沒有新的紀錄時不寫。
2. 計算雜湊：下一次呼叫時，對 `digest_sha256` 是 null 的每一段計算雜湊、填入筆數，並寫一筆稽核事件（動作 `integration.call_log_sealed`，內容是這一段的 `first_id`、`last_id`、筆數與雜湊）。之後這一段有任何增、刪、改，都能從稽核鏈查出。

一段的雜湊：

```sql
select count(*),
       digest(coalesce(string_agg(
           jsonb_build_object(
               'id', id,
               'called_at', to_char(called_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'api_client_id', api_client_id,
               'api_access_token_id', api_access_token_id,
               'function_name', function_name,
               'http_status', http_status,
               'error_code', error_code,
               'internal_reason', internal_reason,
               'request_id', request_id,
               'ip', host(ip),
               'item_count', item_count,
               'duration_ms', duration_ms,
               'summary_sha256', encode(digest(summary::text, 'sha256'), 'hex')
           )::text, E'\n' order by id), ''), 'sha256')
  from sgn.api_call_log
 where id between p_first_id and p_last_id;
```

範圍以 id 劃定，不用日期，所以結果與連線的時區設定無關；時間欄位以 3.7 規定的 UTC 文字進入雜湊。

超過 `integration.call_log_retention_days` 的紀錄以「段」為單位刪除：一段裡最晚的 `called_at` 也超過保存天數、而且雜湊已算出時，整段刪除並在該列填 `purged_at`，同時寫稽核事件（動作 `integration.call_log_purged`）。

尚未封存的空窗最長是一個檢查點間隔加一輪排程。這段期間的紀錄如果被有資料表擁有者權限的人刪改，無法由雜湊偵測；這一點列在 10.5 的限制裡。

### 4.8 速率限制

規則 `K-INT-RATE-LIMIT`。計數都在資料庫，多個後端執行個體共用。

| 計數（`api_rate_counter.bucket`） | 鍵與視窗 | 上限（參數） | 在哪裡累加 | 超過時 |
|---|---|---|---|---|
| `api` | `api_client`，一分鐘 | `integration.rate_limit_per_minute`（可用 `scope_ref` 值 `api_client:<code>` 對個別系統設定） | 成功的呼叫：`authenticate_client`，與業務邏輯同一個交易。失敗的呼叫：`integration_record_failure`，獨立的交易 | 429 `integration_rate_limited` |
| `error` | `api_client`，一分鐘 | `integration.error_limit_per_minute`（同上，可對個別系統設定） | `integration_record_failure`：HTTP 狀態是 400 到 499、而且不是 401 與 429 的失敗（也就是通過驗證之後才失敗的請求） | 429 `integration_rate_limited`，直到下一個視窗 |
| `throttled` | `api_client`，一分鐘 | 無（只用來決定要不要寫呼叫紀錄，見 4.7） | `integration_record_failure`：429 | — |
| `token` | `api_client`，一分鐘 | `integration.token_rate_limit_per_minute` | `integration_token_issue`，只有密鑰正確時（4.3） | 429 |
| `webhook_manage` | `api_client`，一小時 | `integration.webhook_manage_limit_per_hour` | `integration_webhook_create`、`_update`、`_delete`、`_rotate_secret`、`_ping` | 429 `integration_rate_limited` |
| `recon_run` | `api_client`，一天（UTC） | `reconciliation.max_runs_per_day` | `integration_reconciliation_run_create`、`reconciliation_run_upload` | 429 `reconciliation_run_limit` |

- 視窗固定，起點是整分鐘（或整點、UTC 的零時）。超過上限時後端加上 `Retry-After`，值是到下一個視窗的秒數。
- 批次判定的一次呼叫算一次，不論裡面有幾筆。
- **失敗的請求也計數。** 業務 function 丟錯時，它所在的交易會回復，連同那一次的 `api` 計數；所以後端在回應任何 4xx、5xx 之後呼叫的 `integration_record_failure` 會在自己的交易裡補上 `api` 計數，並累加 `error` 計數（各種狀態碼的處理見 13.2）。`authenticate_client` 在每次呼叫開始時同時檢查 `api` 與 `error` 兩個計數。持有 token 的人用 404 探測 id、或反覆上傳一定會失敗的大量對帳資料，會在 `integration.error_limit_per_minute` 次之後被擋下。
- `error` 計數第一次達到上限時（每個系統每小時最多一次）：通知負責人、寫稽核事件（動作 `integration.error_limit_reached`），並顯示在整合狀態。
- 沒有通過驗證的請求（401）不計入任何 `api_client` 的 `api` 與 `error` 計數，即使它帶的 token 找得到對應的系統：否則拿到 token 的人可以從別的位址亂試，讓正牌系統被限流。這類請求由後端對 `/integration/v1/` 的全部請求（包含 token 端點）套用依來源 IP 的限制；失敗次數記在 `api_auth_failure_counter`（4.3、13.2）。

### 4.9 變更申請：兩個人才能完成的管理動作

規則 `K-INT-DUAL-CONTROL`。下列動作不能由一個人完成：提出人建立一筆變更申請（`sgn.integration_change_request`），由另一個人覆核；覆核通過的同一個交易裡才真正套用。

| 種類（`kind`） | 什麼時候需要覆核 | 誰可以提出 | 覆核人的額外限制（都另外要求：有 `sys_admin` 角色、不是提出人） |
|---|---|---|---|
| `api_client_create` | 一律 | `sys_admin` | 不得是這個系統的負責人。`scopes` 含 `audit.read_all` 時另外需要會簽 |
| `api_client_update` | 修改內容有任何一項是擴大：新增 scope、新增或放寬可見規則、新增來源位址、新增 `allowed_providers`、新增 webhook 來源、改 `identity_provider`、改負責人、`constraint_mode` 改成 `advisory`、`token_binding` 改成 `cidr`、`upload_enabled` 改成 true。只有收緊或只改名稱說明時，立即套用，不需要覆核 | `sys_admin` | 不得是這個系統目前或新的負責人。新增 `audit.read_all` 時另外需要會簽 |
| `api_client_credential_create` | 一律 | `sys_admin`、該系統的負責人 | — |
| `principal_identity_set`、`principal_identity_remove` | 一律 | `sys_admin` | 不得是該被授權者的負責人或有效成員 |
| `access_review_campaign_cancel` | 這一輪複查的狀態是 `open` 時（`scheduled` 的可以直接取消） | `sys_admin` | 見下 |

共通規定：

- 提出人不得覆核自己的申請（`change_request_self_approval`）。
- `api_client_create` 與改負責人的 `api_client_update`：負責人不得是提出人。
- `access_review_campaign_cancel`：提出人與覆核人都不得是這一輪範圍內任何一筆授權的申請人、主體本人、主體的有效成員或被授權者的負責人（`change_request_approver_not_independent`）。
- 會簽：`audit.read_all` 等於把全部稽核資料交給一個系統，所以除了覆核，還要一位稽核角色的持有人會簽（不得是提出人或覆核人）。兩者都完成才套用。會簽只表示同意輸出，不改變任何業務資料（與 `K-AUDITOR-READONLY` 的關係見附錄 A 第 17 項）。
- 提出時就檢查內容是否合法（代碼是否已被使用、負責人是否在職等）；套用時再檢查一次，不合法就丟錯，申請維持 `pending`。
- 提出時計算影響並存進申請（`impact`）：例如新增可見規則會多看到幾筆權限項目；`principal_identity_set` 要取代的舊值、這個外部識別碼目前出現在幾筆未結案的對帳發現裡。覆核人看著這份影響做決定。
- 申請的狀態：`pending`（等覆核或會簽）、`approved`（已套用）、`rejected`、`withdrawn`（提出人撤回）、`expired`（超過 `integration.change_request_expire_days` 天沒有完成，由排程處理）。
- 提出、覆核、會簽、駁回、撤回、逾期：各一筆稽核事件。套用時另外寫該動作本身的稽核事件（例如系統登記），actor 是覆核人，變更內容帶提出人與申請 id。

系統管理員只有一位時，這些動作無法完成。部署時必須至少指派兩位；整合狀態在只有一位時顯示警告。

這個機制與待納入的增修 A10（設定變更走簽核）是同一個原則。A10 進入核心後，本節的資料表與 function 由核心的設定變更申請單取代，上表的限制原樣保留（附錄 D）。

### 4.10 來源限制與 token 綁定

規則 `K-INT-CLIENT-SOURCE`。密鑰與 token 都是持有就能用的東西，所以另外限制「從哪裡來」。

- 每個 `api_client` 必須登記 `allowed_source_cidrs`。不想限制時要明確填 `0.0.0.0/0`（與 `::/0`），並填 `source_any_reason`；`scopes` 含 `audit.read_all` 或 `reconciliation.write` 的系統不得使用這兩個值（`api_client_source_required`）。
- 換發 token 與之後的每一次呼叫，來源位址都必須落在清單內。不在清單內時，token 端點回與其他失敗相同的 `invalid_client`，其他端點回與其他失敗相同的 `integration_invalid_token`；實際原因（`source_not_allowed`）只寫進 `internal_reason`。
- token 綁定：`token_binding = 'ip'`（預設）時，每次呼叫的來源位址必須等於換發這個 token 時的位址（`api_access_token.issued_ip`）；不同就回 `integration_invalid_token`（內部原因 `token_ip_mismatch`）。使用方有多個出口位址（例如叢集經過一組 NAT）時登記為 `cidr`，只檢查清單，不要求同一個位址。
- 來源位址的取得方式固定：後端的部署設定 `TRUSTED_PROXY_CIDRS` 列出反向代理的位址。連線的對端在這份清單內時，取 `X-Forwarded-For` 由右往左第一個不在清單內的位址；對端不在清單內時，直接用對端位址，忽略任何標頭。取不到合法的位址時視為驗證失敗。
- 新的來源：每次換發 token 時，把（`api_client`、來源位址）記進 `sgn.api_client_source_seen`。第一次出現的位址會通知負責人，寫稽核事件（動作 `integration.new_source_seen`），並顯示在整合狀態。
- 憑證綁定（mTLS，RFC 8705）列在 1.3 的選用項目；第一版以來源限制加上位址綁定處理。

## 5. 權限判定（`check`）

### 5.1 端點

依 AuthZEN Authorization API 1.0。PDP 識別碼是參數 `integration.issuer` 的值（例如 `https://sgn.example.com/integration/v1`）。

| 用途 | 方法與路徑 | scope |
|---|---|---|
| 單筆判定 | `POST /integration/v1/access/v1/evaluation` | `check` |
| 批次判定 | `POST /integration/v1/access/v1/evaluations` | `check` |
| 回報實際使用（5.7） | `POST /integration/v1/grants/{entitlement_id}/usage` | `usage.write` |
| 中繼資料 | `GET /.well-known/authzen-configuration/integration/v1` | 不需驗證 |

中繼資料的網址依規格產生：把 `/.well-known/authzen-configuration` 插在主機與路徑之間。內容：

```json
{
  "policy_decision_point": "https://sgn.example.com/integration/v1",
  "access_evaluation_endpoint": "https://sgn.example.com/integration/v1/access/v1/evaluation",
  "access_evaluations_endpoint": "https://sgn.example.com/integration/v1/access/v1/evaluations"
}
```

### 5.2 單筆請求與回應

```http
POST /integration/v1/access/v1/evaluation HTTP/1.1
Host: sgn.example.com
Authorization: Bearer sgn_at_TRVmodff...
Content-Type: application/json
X-Request-ID: bfe9eb29-ab87-4ca3-be83-a1d5d8305716

{
  "subject": {"type": "person", "id": "p08"},
  "action": {"name": "read"},
  "resource": {"type": "data_field", "id": "sales_order.amount"},
  "context": {
    "row_filter": [{"filter": "region", "op": "in", "values": ["north"]}],
    "data_period": {"from": "2025-03-01", "to": "2025-03-31"}
  }
}
```

允許：

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
X-Request-ID: bfe9eb29-ab87-4ca3-be83-a1d5d8305716

{
  "decision": true,
  "context": {
    "reason": "granted",
    "decision_id": "918273:0",
    "evaluated_at": "2026-11-19T02:15:00Z",
    "ttl_seconds": 60,
    "basis": [
      {
        "entitlement_id": "8812",
        "revision": 1,
        "status": "active",
        "grant_id": "431",
        "case_no": "DA-2026-0004",
        "process_type": "data_access",
        "tier": "L3",
        "subject": {"type": "principal", "id": "channel-sales", "properties": {"kind": "team", "provider": "ldap"}},
        "inherited": true,
        "actions": ["read"],
        "valid_from": "2026-11-15T16:00:00Z",
        "valid_until": "2027-05-15T16:00:00Z",
        "constraints": {
          "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
          "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}
        }
      }
    ]
  }
}
```

找不到授權：

```json
{
  "decision": false,
  "context": {
    "reason": "no_entitlement",
    "decision_id": "918274:0",
    "evaluated_at": "2026-11-19T02:15:03Z",
    "ttl_seconds": 30
  }
}
```

回應 `context` 的欄位：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `reason` | 字串 | 見下表 |
| `decision_id` | 字串 | 「呼叫紀錄 id:第幾筆」，可以對回 `sgn.api_call_log` |
| `evaluated_at` | RFC 3339 時間 | 判定時間（平台時間） |
| `ttl_seconds` | 整數 | 這個結果最多可以快取幾秒（見 5.5） |
| `basis` | 陣列 | 依據的權限項目，最多 10 筆，依 `entitlement_id` 排序；超過時另帶 `"basis_truncated": true`。`reason` 是 `no_entitlement` 時沒有這個欄位 |

`basis` 每一筆的欄位：`entitlement_id`、`revision`、`status`、`grant_id`（可為 null）、`case_no`、`process_type`、`tier`、`subject`（持有這筆權限的主體）、`inherited`（請求的主體是人、而權限是透過成員身分從被授權者取得時為 true）、`actions`、`valid_from`、`valid_until`（可為 null）、`constraints`；已結束的另帶 `ended_at`、`end_reason`。

`reason` 的值：

| `decision` | `reason` | 意義 | `basis` 的內容 |
|---|---|---|---|
| true | `granted` | 有有效的權限項目，而且情境符合它的限制條件 | 所有符合的項目 |
| false | `constraint_context_missing` | 有有效的權限項目，請求沒有違反限制，但有核准的限制面向沒有出現在請求的 `context` 裡。只會出現在 `constraint_mode` 是 `strict` 的呼叫方 | 那些項目（帶完整的 `constraints`，使用方據此補上情境再問一次） |
| false | `constraint_not_satisfied` | 有有效的權限項目，但情境不符合限制條件（含數量類限制的累計已用完） | 那些有效但不符合的項目 |
| false | `not_yet_effective` | 有權限項目，但還在 `pending`，或起始時間未到 | 那些項目 |
| false | `ended` | 曾經有，但已在 `integration.check_ended_lookback_days` 天內結束 | 最近結束的那一筆 |
| false | `no_entitlement` | 以上皆非 | 無 |

使用方必須處理的事（規則 `K-INT-CHECK-BASIS`）：

- `strict` 的呼叫方（預設）：只看 `decision` 就夠了。判定已經確認每一個核准的限制面向都被請求的 `context` 涵蓋。
- `advisory` 的呼叫方：`decision` 是 true 時，`basis[].constraints` 是核准的完整限制；請求的 `context` 沒有涵蓋的面向，使用方必須依這份限制自行套用。這類系統必須納入對帳（4.1）。
- 數量類的限制（例如「最多 2 份」）：判定依已回報的用量加上這次請求的數量。使用方有回報用量（5.7）時，累計由平台把關；沒有回報時，判定只檢查單次請求的數量，累計要由使用方以 `basis[].entitlement_id` 為鍵自行計數。
- 依 AuthZEN，使用方看不懂回應的 `context` 時可以選擇拒絕。
- 這個介面只回答「核准了什麼」；實際擋下存取的是使用方自己（骨幹第 11 節）。

### 5.3 判定演算法

規則 `K-INT-CHECK`。實作在 `sgn_internal.evaluate_access`，單筆與批次共用。判定時間一律是平台的現在時間；請求的 `context.time` 不會改變判定時點，只會原樣傳給流程包。

1. 解析主體（`sgn_internal.resolve_subject`）。provider 取 `subject.properties.provider`，沒有就取 `api_client.identity_provider`；provider 不在 `api_client.allowed_providers` 裡，視為找不到。只認在職的人、狀態有效而且結束日未到的被授權者。找不到 → 結果是 `no_entitlement`。
2. 展開主體集合 S。主體是 `principal`：S 只有它自己。主體是 `person`：S 是他自己，加上他**現在**是有效成員的每一個被授權者（`subject_principals(人, 現在)`）。
3. 取候選項目 C：`sgn.entitlement` 中主體屬於 S、`resource_type` 與 `resource_id` 完全相同、`actions` 包含 `action.name`、而且對這個 `api_client` 可見的項目。
4. 取有效項目 E：C 中同時符合下列條件的項目。
   - `status = 'active'`、`effective_from <= 現在`、`effective_until` 是 null 或 `現在 < effective_until`。
   - `grant_id` 不是 null 時，以主鍵查 `sgn."grant"`，`status` 必須是 `active`。
   - 主體是被授權者時，以主鍵查 `sgn.principal`，狀態必須有效，而且結束日是 null 或還沒過；主體是人時，他必須在職。

   後兩項是對投影的複核：正常情況下投影已經把這些項目改成 `ended`，這裡不會擋到任何東西。真的擋到時（權限項目是 `active` 而 `grant` 或主體已經不是），這一筆當作已結束處理，並在呼叫紀錄的摘要記下 `"stale_projection": [權限項目 id…]`；`job_integration_consistency` 會修正並通知稽核（2.2）。
5. 對 E 的每一筆呼叫 `sgn_internal.call_evaluate_constraints`：`mode` 是 `check`；`strict` 依呼叫方的 `constraint_mode`；`usage` 是這筆權限項目已回報的用量（`usage_count` 是 0 時不查詢，直接給 `[]`）。通過的集合是 P。
6. 決定結果，依序取第一個成立的：
   - P 不是空的 → true，`granted`。
   - E 不是空的，呼叫方是 `strict`，而且 E 中有任何一筆以 `strict = false` 再呼叫一次會通過 → false，`constraint_context_missing`。
   - E 不是空的 → false，`constraint_not_satisfied`。
   - C 中有 `pending`，或有 `active` 但 `effective_from > 現在` → false，`not_yet_effective`。
   - C 中有結束時間在回溯天數內的項目（`ended`，或 `active` 但 `effective_until <= 現在`，或第 4 步被複核擋下的）→ false，`ended`。
   - 其他 → false，`no_entitlement`。

多筆授權不合併：每一筆權限項目各自判定，只要有一筆完整符合就允許。兩筆授權各涵蓋一部分範圍時，使用方要把請求拆成各自的範圍分別判定，或改用授權查詢取得全部限制後自行計算。

主體不存在、主體的 provider 不在允許清單、資源不在可見範圍、沒有授權，四種情況的回應完全相同（`no_entitlement`、相同的 `ttl_seconds`），呼叫方無法分辨（見第 16 節）。

### 5.4 批次請求與回應

```json
{
  "subject": {"type": "person", "id": "p08"},
  "action": {"name": "read"},
  "context": {"data_period": {"from": "2025-03-01", "to": "2025-03-31"}},
  "options": {"evaluations_semantic": "execute_all"},
  "evaluations": [
    {"resource": {"type": "data_field", "id": "sales_order.amount"}},
    {"resource": {"type": "data_field", "id": "sales_order.order_date"}},
    {"resource": {"type": "data_field", "id": "sales_order.customer_id"}, "action": {"name": "export"}}
  ]
}
```

```json
{
  "evaluations": [
    {
      "decision": true,
      "context": {
        "reason": "granted",
        "decision_id": "918280:0",
        "evaluated_at": "2026-11-19T02:16:00Z",
        "ttl_seconds": 60,
        "basis": [
          {
            "entitlement_id": "8812",
            "revision": 1,
            "status": "active",
            "grant_id": "431",
            "case_no": "DA-2026-0004",
            "process_type": "data_access",
            "tier": "L3",
            "subject": {
              "type": "principal",
              "id": "channel-sales",
              "properties": {
                "kind": "team",
                "provider": "ldap"
              }
            },
            "inherited": true,
            "actions": [
              "read"
            ],
            "valid_from": "2026-11-15T16:00:00Z",
            "valid_until": "2027-05-15T16:00:00Z",
            "constraints": {
              "row_filter": [
                {
                  "filter": "region",
                  "op": "in",
                  "values": [
                    "central",
                    "north"
                  ]
                }
              ],
              "data_period": {
                "field": "order_date",
                "from": "2025-01-01",
                "to": "2026-12-31"
              }
            }
          }
        ]
      }
    },
    {
      "decision": true,
      "context": {
        "reason": "granted",
        "decision_id": "918280:1",
        "evaluated_at": "2026-11-19T02:16:00Z",
        "ttl_seconds": 60,
        "basis": [
          {
            "entitlement_id": "8813",
            "revision": 1,
            "status": "active",
            "grant_id": "431",
            "case_no": "DA-2026-0004",
            "process_type": "data_access",
            "tier": "L3",
            "subject": {
              "type": "principal",
              "id": "channel-sales",
              "properties": {
                "kind": "team",
                "provider": "ldap"
              }
            },
            "inherited": true,
            "actions": [
              "read"
            ],
            "valid_from": "2026-11-15T16:00:00Z",
            "valid_until": "2027-05-15T16:00:00Z",
            "constraints": {
              "row_filter": [
                {
                  "filter": "region",
                  "op": "in",
                  "values": [
                    "central",
                    "north"
                  ]
                }
              ],
              "data_period": {
                "field": "order_date",
                "from": "2025-01-01",
                "to": "2026-12-31"
              }
            }
          }
        ]
      }
    },
    {
      "decision": false,
      "context": {
        "reason": "no_entitlement",
        "decision_id": "918280:2",
        "evaluated_at": "2026-11-19T02:16:00Z",
        "ttl_seconds": 30
      }
    }
  ]
}
```

規則：

- 頂層的 `subject`、`action`、`resource`、`context` 是預設值；每一筆 `evaluations` 裡的同名鍵會整個取代預設值（不做合併）。合併之後每一筆都必須有 `subject`、`action`、`resource`，否則整個請求回 400。
- `evaluations` 不存在或是空陣列時，行為與單筆判定相同，回應也是單筆的格式。
- 筆數上限是 `integration.check_max_evaluations`，超過回 400（`integration_too_many_evaluations`）。
- `options.evaluations_semantic`：
  - `execute_all`（預設）：全部判定，回應的順序與請求相同。
  - `deny_on_first_deny`：依序判定，遇到第一個 false 就停，回應只包含到那一筆為止。
  - `permit_on_first_permit`：依序判定，遇到第一個 true 就停，回應只包含到那一筆為止。
  - 其他值回 400。`options` 的其他鍵忽略。
- 回應不帶頂層的 `decision`。
- 整個請求格式錯誤是 400；個別判定沒有「錯誤」這種結果，只有 true 或 false。

### 5.5 快取與有效時間

`ttl_seconds` 的算法：

| 結果 | `ttl_seconds` |
|---|---|
| true | 下列各值中最小的（每一項都是「距離現在的秒數」，沒有值的略過；結果小於 0 取 0）：<br>(1) 參數 `integration.decision_ttl_seconds`；<br>(2) `basis` 每一筆的 `valid_until`（已含被授權者的結束日，見 3.4）；<br>(3) `basis` 中 `inherited` 為 true 的每一筆：請求的人在該被授權者的成員期間的迄；<br>(4) `basis` 每一筆的 `revoke_risk_at`：這筆授權已知會被自動撤銷的最早時間（複查決定縮小後的追蹤期限、負責人寬限期的期限；見 11.5） |
| true，而且 `basis` 有任何一筆是 `effective_during = fulfilment` | 0（一次性的許可，每次都要重新判定） |
| false，`not_yet_effective` | `integration.deny_ttl_seconds` 與「最早的起始時間距離現在的秒數」取小的 |
| 其他 false | `integration.deny_ttl_seconds` |

`integration.decision_ttl_seconds` 的上限是 300 秒。

給使用方的指引：

- 快取的鍵必須包含完整的請求（主體、動作、資源、情境）。不得超過 `ttl_seconds`；值是 0 時不得快取。
- 回應帶 `Cache-Control: no-store`，中間的代理不得快取。
- 有訂閱事件的系統：收到某個主體或資源的 `sgn.grant.*`、`sgn.principal.*`、`sgn.person.*` 事件時，立即清掉相關的快取；收到 `sgn.client.visibility_changed` 時清掉全部。這樣撤銷可以在幾秒內反映。
- 沒有訂閱事件的系統：撤銷最慢在 `ttl_seconds` 之後反映。參數的預設值（60 秒）就是這個最壞情況的一般值，上限 300 秒；需要更短就調低參數。
- 平台不可用時怎麼辦由使用方決定並寫進自己的設計。建議：快取過期後拒絕存取（預設拒絕），不要沿用過期的允許結果。

### 5.6 效能

要求（在資料庫 function 內量測；資料量：20 萬筆未結束的權限項目、2 萬個被授權者、5 千人）：

| 項目 | 要求 |
|---|---|
| 單筆判定 | p95 不超過 50 毫秒 |
| 100 筆的批次判定 | p95 不超過 500 毫秒 |

做法：

- 判定以 `sgn.entitlement` 找候選。這張表由投影在狀態改變的當下整理好（規則 `K-INT-PROJECT`）；判定時不呼叫 `describe_entitlements`，不讀申請單內容，不重算任何東西。對 `grant` 與主體的複核（5.3 第 4 步）只對已經通過其他條件的少數候選做主鍵查詢。
- 索引：主體＋資源（`entitlement_principal_idx`、`entitlement_person_idx`）、身分對應（`person_identity`、`principal_identity` 的 `(provider, external_id)`）、成員（`principal_member` 的 `person_id`）、token 雜湊。
- 限制條件是 `{}` 時不呼叫流程包。有限制條件時每筆候選呼叫一次 `evaluate_constraints`（`strict` 的呼叫方在被拒時多一次）；這個 function 被要求是 `stable` 且不寫資料。
- 批次判定在一次 function 呼叫內完成，相同的主體只解析一次。
- 每次呼叫的寫入只有兩筆：速率計數與呼叫紀錄。
- 架構測試用 `explain` 確認判定的查詢沒有對 `sgn.entitlement` 做循序掃描。`tools/bench-integration-check.sh` 產生上述資料量並量測，結果寫進交接紀錄。

### 5.7 回報實際使用（`usage`）

規則 `K-INT-USAGE`。判定是無狀態的：它不知道使用方問完之後有沒有真的做。對數量類的限制（一次性許可的份數、次數），使用方在實際使用之後回報，平台才能把關累計。這個端點是選用的；不回報的系統適用 5.2 的說明（只檢查單次請求）。

```http
POST /integration/v1/grants/8830/usage HTTP/1.1
Authorization: Bearer sgn_at_TRVmodff...
Content-Type: application/json

{
  "usage_key": "seal-device-7:20261119-0012",
  "decision_id": "918301:0",
  "context": {
    "document_sha256": "9f2c41d0a7b35e6c8f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6fe1",
    "copies": 2
  },
  "quantity": 2,
  "occurred_at": "2026-11-19T03:10:00Z"
}
```

```json
{
  "usage_id": "55",
  "entitlement_id": "8830",
  "usage_key": "seal-device-7:20261119-0012",
  "quantity": 2,
  "total_quantity": 2,
  "usage_count": 1,
  "within_approval": true,
  "recorded_at": "2026-11-19T03:10:02Z"
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `usage_key` | 是 | 使用方自己的唯一鍵，1 到 128 個字元，不含控制字元。同一筆權限項目用相同的鍵再送一次，回 200 與原本的紀錄，不重複記錄；鍵相同而內容不同回 409（`usage_key_conflict`） |
| `decision_id` | 否 | 這次使用依據的判定（5.2 的 `decision_id`）。格式必須是 `^[0-9]+:[0-9]+$` |
| `context` | 是 | 實際使用的情境，結構與判定請求的 `context` 相同。限制同 16.5 |
| `quantity` | 否 | 這次使用的數量，1 到 1,000,000 的整數，預設 1 |
| `occurred_at` | 是 | 實際使用的時間。不得晚於現在，不得早於這筆權限項目的 `effective_from` |

規則：

- 權限項目必須對呼叫方可見，否則回 404。它必須現在有效，或在 `integration.usage_late_hours` 小時內才結束（設備晚一點回報是正常的）；否則回 409（`usage_entitlement_not_active`）。
- 紀錄只增不改，存在 `sgn.entitlement_usage`；每筆權限項目最多 `integration.usage_max_per_entitlement` 筆，超過回 409（`usage_limit_reached`）。
- 每一筆回報寫一筆稽核事件（動作 `integration.usage_reported`，帶申請單、權限項目 id、數量、`context` 的 SHA-256、回報的系統代碼）。
- 記錄之後，核心以這次的 `context` 與「這一筆之前」的用量呼叫一次 `evaluate_constraints`（`check` 模式、`strict` 為 true）。結果寫在 `within_approval`。是 false 時代表實際使用超出核准（例如核准 2 份、已經蓋了 3 份）：紀錄照樣保存，另外寫一筆稽核事件（動作 `integration.usage_exceeded`）、通知稽核角色與申請單的申請人，並列在整合狀態的例外。回報本身不會因此被拒，因為事情已經發生。
- 之後對這筆權限項目的判定，`p_context.usage` 會帶上全部已回報的用量。

## 6. 授權查詢（`grants`）

### 6.1 端點

| 用途 | 方法與路徑 | scope |
|---|---|---|
| 查詢清單 | `GET /integration/v1/grants` | `grants.read` |
| 取得單筆 | `GET /integration/v1/grants/{entitlement_id}` | `grants.read` |
| 被授權者的成員名單 | `GET /integration/v1/principals/{subject_id}/members` | `grants.read` |

清單的每一筆是一筆權限項目，並帶著所屬的授權與申請單資訊。同一張申請單的項目有相同的 `case_no`。

### 6.2 查詢參數

| 參數 | 說明 |
|---|---|
| `subject_type`、`subject_id` | 依主體查。兩個要一起給。`subject_provider` 選填，覆寫預設的身分來源（必須在 `allowed_providers` 內，否則當作主體不存在） |
| `include_inherited` | 主體是 `person` 時，是否包含透過成員身分取得的項目。預設 `true` |
| `resource_type` | 依資源類型查 |
| `resource_id` | 依資源查（完全相同）。必須同時給 `resource_type` |
| `resource_id_prefix` | 依資源識別碼的開頭查。必須同時給 `resource_type`；不可與 `resource_id` 並用 |
| `process_type` | 依流程類型代碼查 |
| `status` | 依**儲存的狀態**篩選：`pending`、`active`、`ended`，可用逗號給多個。預設：沒有 `since` 時是 `active`；有 `since` 時是全部 |
| `effective_at` | 另外依時間篩選：只回 `effective_from <= 指定時間`、而且 `effective_until` 是 null 或 `指定時間 < effective_until` 的項目。值是 RFC 3339 時間，或 `none`（不依時間篩選）。預設：沒有 `since` 時是現在；有 `since` 時是 `none`。`status` 包含 `pending` 或 `ended` 時必須明確給 `none`，否則回 400 |
| `expand` | 給 `members` 時，主體是被授權者的每一筆另外帶 `members`（格式同 6.5，最多 `integration.page_size_max` 人，超過時帶 `"members_truncated": true`，要用 6.5 的端點取完整名單） |
| `since` | 增量同步的游標（見 6.4） |
| `page_token` | 快照分頁的游標（見 6.3）。不可與 `since` 並用 |
| `limit` | 每頁筆數。預設 `integration.page_size_default`，上限 `integration.page_size_max` |

所有條件是「且」的關係。結果一律先套用可見範圍。主體不存在時回空清單，不回錯誤。

預設的查詢（什麼參數都不給）回答的是「現在真的有效的權限」：儲存的狀態是 `active`，而且現在落在有效期間內。起始日還沒到的授權、到期時間已過而排程還沒處理的授權，都不在裡面。

### 6.3 回應與分頁

```json
{
  "items": [
    {
      "entitlement_id": "8812",
      "revision": 1,
      "status": "active",
      "effective_now": true,
      "grant_id": "431",
      "case_no": "DA-2026-0004",
      "source_case_no": null,
      "process_type": "data_access",
      "tier": "L3",
      "subject": {"type": "principal", "id": "channel-sales", "properties": {"kind": "team", "provider": "ldap"}},
      "inherited": false,
      "owner": {"type": "person", "id": "p07", "properties": {"provider": "ldap"}},
      "resource": {"type": "data_field", "id": "sales_order.amount"},
      "actions": ["read"],
      "constraints": {
        "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
        "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}
      },
      "effective_during": "active",
      "valid_from": "2026-11-15T16:00:00Z",
      "valid_until": "2027-05-15T16:00:00Z",
      "ended_at": null,
      "end_reason": null,
      "updated_at": "2026-11-16T01:00:12Z"
    }
  ],
  "next_page_token": null,
  "sync_cursor": "e1.1042-9223372036854775807"
}
```

| 欄位 | 說明 |
|---|---|
| `status` | 儲存的狀態（3.4）。它不隨時間自動改變 |
| `effective_now` | 產生回應的當下是否真的有效：`status` 是 `active`，而且現在落在 `valid_from` 與 `valid_until` 之間 |
| `subject` | 權限項目的主體（被授權者或人） |
| `inherited` | 以 `person` 查詢、而且這一筆是透過成員身分從被授權者取得時為 true；此時 `subject` 是那個被授權者 |
| `owner` | 被授權者的負責人；主體是人時為 null |
| `source_case_no` | 這張單的來源單（續期、變更），沒有時為 null |
| `effective_during` | `active` 或 `fulfilment`（3.4） |
| `valid_from`、`valid_until` | 權限項目的 `effective_from`、`effective_until`。`valid_until` 已經考慮被授權者的結束日 |
| `next_page_token` | 還有下一頁時是不透明字串，沒有時是 null |
| `sync_cursor` | 這次查詢當下的同步位置。做完整快照的系統記下**第一頁**的值，之後用它當 `since` |

快照分頁依 `entitlement_id` 由小到大。分頁期間資料可能改變，所以某一筆可能重複或在快照中漏掉；這些改變的同步序號一定大於第一頁的 `sync_cursor`，之後的增量同步會補上。

游標是不透明的字串，使用方不得解析或自行組合。游標格式錯誤回 400（`integration_cursor_invalid`）；游標是在可見範圍或身分來源改變之前發出的，回 409（`integration_resync_required`，見 4.5）。

### 6.4 增量同步

每一筆權限項目有一個同步序號（`sync_seq`），等於最後一次改變它的事件的序號。事件序號與交易提交的順序一致（見 7.4），所以不會出現「序號較小的改變比較晚才看得到」的情況。

會推進同步序號的改變（也就是增量同步保證會送到的改變）：

| 改變 | 推進哪些項目 |
|---|---|
| 權限項目的狀態、動作、限制條件、有效期間、所屬 `grant` 改變 | 該項目 |
| 被授權者的負責人改變（`owner` 欄位） | 該被授權者所有未結束的項目 |
| 主體的外部識別碼改變（`subject` 欄位） | 以它為主體的所有未結束的項目 |
| 主體失效（人離職、被授權者結束） | 以它為主體的項目（狀態變成 `ended`，原因 `subject_inactive`） |

不會推進同步序號、要由使用方自己處理的事：

| 事情 | 使用方要做什麼 |
|---|---|
| 時間到了（起始時間到、到期時間到） | **本地必須依每一筆的 `valid_from`、`valid_until` 自行生效與失效，不得等事件或下一次同步。** 排程之後會把儲存的狀態改成 `ended` 並發出 `sgn.grant.expired`，但那可能晚於 `valid_until` |
| 成員加入、移除、成員期間到期 | 以人為單位設定權限的系統，用 6.5 取得名單，之後依 `sgn.principal.membership_changed` 事件維護，並依每位成員的 `valid_until` 自行移除 |
| 可見範圍或身分來源改變 | 收到 409 `integration_resync_required`（或事件 `sgn.client.visibility_changed`）時，丟掉本地保存的全部權限，重做完整快照 |

`GET /integration/v1/grants?since=<游標>`：回傳同步序號在游標之後的項目，依（同步序號、`entitlement_id`）排序，包含已結束的項目。回應的格式相同，但 `next_page_token` 一律是 null，另外有：

| 欄位 | 說明 |
|---|---|
| `next_since` | 下一次要帶的游標 |
| `has_more` | 是否還有更多（true 時立刻再查一次） |

使用方必須遵守的同步流程：

1. 第一次：不帶 `since`，以 `status=pending,active&effective_at=none` 做完整快照（這樣起始日在未來的授權也會進來），記下第一頁的 `sync_cursor`。需要成員名單的系統，對快照中每一個被授權者呼叫 6.5，或在快照時帶 `expand=members`。
2. 之後定期（或收到事件時）：帶 `since` 查到 `has_more` 是 false 為止，保存最後的 `next_since`。
3. 每一筆以 `entitlement_id` 為鍵覆蓋本地的資料；`status` 是 `ended` 的就移除對應的權限。
4. 本地放行存取的條件是「`status` 是 `active`，而且現在落在 `valid_from` 與 `valid_until` 之間」，每次放行時以自己的時鐘檢查。
5. 任何一次查詢回 409 `integration_resync_required`：清空本地的權限，回到第 1 步。
6. 第一次看到某個被授權者（快照或增量同步中出現新的 `subject`）時，取一次它的成員名單。

### 6.5 被授權者的成員名單

```http
GET /integration/v1/principals/channel-sales/members HTTP/1.1
Authorization: Bearer sgn_at_TRVmodff...
```

```json
{
  "principal": {"type": "principal", "id": "channel-sales", "properties": {"kind": "team", "provider": "ldap"}},
  "owner": {"type": "person", "id": "p07", "properties": {"provider": "ldap"}},
  "members": [
    {"member": {"type": "person", "id": "p07", "properties": {"provider": "ldap"}}, "valid_from": "2025-01-01T00:00:00Z", "valid_until": null},
    {"member": {"type": "person", "id": "p08", "properties": {"provider": "ldap"}}, "valid_from": "2025-03-01T00:00:00Z", "valid_until": null}
  ],
  "unmapped_count": 0,
  "next_page_token": null,
  "events_cursor": "e1.1042"
}
```

| 項目 | 規定 |
|---|---|
| 路徑的 `subject_id` | 被授權者在呼叫方身分來源的識別碼。查詢參數 `subject_provider` 可以指定 `allowed_providers` 內的其他來源 |
| 誰可以查 | 這個被授權者目前有 `pending` 或 `active` 的可見權限項目，或有在 `integration.check_ended_lookback_days` 天內結束的可見項目。否則回 404（與不存在相同） |
| `members` | 現在有效的成員（在職、成員期間涵蓋現在），依成員的內部 id 排序。`valid_until` 是成員期間的迄（沒有就是 null）；使用方要在那個時間自行移除 |
| `unmapped_count` | 在呼叫方的身分來源沒有對應的成員人數。這些人不列在 `members` 裡（不改用其他識別碼輸出） |
| 分頁 | `limit`、`page_token`，規則同 6.3 |
| `events_cursor` | 產生回應當下的事件位置；之後從這個位置讀事件串流，就不會漏掉名單之後的成員異動 |

被授權者剛建立時還沒有任何權限項目，所以沒有呼叫方看得到它的成員事件；使用方是在第一次看到以它為主體的權限項目時，用這個端點取得當時的完整名單。

## 7. 事件（`events`、`webhook_subscription`）

### 7.1 事件類型

事件類型登記在資料表 `sgn.integration_event_type`，這是唯一來源。

| 類型 | 什麼時候發生 | 需要的 scope |
|---|---|---|
| `sgn.grant.approved` | 申請單核准，權限項目建立但尚未生效（`pending`） | `events.read` |
| `sgn.grant.activated` | 授權的狀態成為有效。**實際起始時間看 `valid_from`**：它可能在未來，使用方不得因為收到這個事件就立刻放行 | `events.read` |
| `sgn.grant.changed` | 生效中或待生效的授權，內容或有效期間改變。`change_class` 是 `narrowed`（縮小）、`widened`（擴大）或 `modified`（無法歸類）。負責人或識別碼的改變另有 `sgn.principal.*`、`sgn.person.*` 事件，不發這個事件 | `events.read` |
| `sgn.grant.expiring` | 即將到期：距離到期日剩下 `validity.remind_before_days` 天 | `events.read` |
| `sgn.grant.expired` | 到期失效（排程把授權改成到期時發出；可能晚於 `valid_until`，見 6.4） | `events.read` |
| `sgn.grant.revoked` | 撤銷 | `events.read` |
| `sgn.grant.ended` | 其他原因結束：一次性許可已使用（`consumed`）、取消（`cancelled`）、完成（`completed`）、主體失效（`subject_inactive`） | `events.read` |
| `sgn.principal.owner_changed` | 被授權者的負責人改變 | `events.read` |
| `sgn.principal.owner_at_risk` | 負責人離職或調職，寬限期開始；逾期未改派，授權會被撤銷 | `events.read` |
| `sgn.principal.membership_changed` | 被授權者的成員加入或移除（含成員離職） | `events.read` |
| `sgn.principal.identity_changed` | 被授權者的外部識別碼建立、取代或移除 | `events.read` |
| `sgn.person.identity_changed` | 人的外部識別碼改變 | `events.read` |
| `sgn.client.visibility_changed` | 這個呼叫方自己的可見範圍或身分來源改變；本地的權限必須重做快照（4.5） | `events.read` |
| `sgn.reconciliation.run_completed` | 這個系統的一個對帳批次比對完成（或被標記為需要人工檢視） | `reconciliation.write` |
| `sgn.reconciliation.finding_opened` | 這個系統的對帳產生新的發現 | `reconciliation.write` |
| `sgn.reconciliation.finding_closed` | 發現結案 | `reconciliation.write` |
| `sgn.review.campaign_opened` | 一輪定期複查開始 | `reviews.read` |
| `sgn.review.campaign_closed` | 一輪定期複查結束或取消 | `reviews.read` |
| `sgn.evidence.checkpoint` | 產生新的稽核鏈檢查點並完成簽章 | `evidence.read` |
| `sgn.webhook.ping` | webhook 的連線測試（只會出現在 webhook，不在串流裡） | `webhooks.manage` |

時間造成的生效與失效沒有即時的事件：起始時間到了、到期時間到了、成員期間到了，都不會在那一刻發事件。使用方必須依各筆資料的時間欄位自行處理（6.4）。

`change_class` 的判定（以權限項目層級比較前後兩次投影）：

| 情況 | `change_class` |
|---|---|
| 沒有新增的項目；每一筆留下來的項目，動作是原本的子集、限制條件相同；有效期間沒有延後或延長 | `narrowed` |
| 沒有移除的項目；每一筆原有的項目，動作是原本的超集、限制條件相同；有效期間沒有縮短 | `widened` |
| 其他（包含限制條件的內容改變） | `modified` |

不論哪一種，事件都帶著改變之後的完整狀態，使用方直接覆蓋即可，不需要依 `change_class` 做不同處理。

### 7.2 事件格式

每個事件是一個 CloudEvents 1.0.2 的 JSON 事件：

```json
{
  "specversion": "1.0",
  "id": "evt-1042",
  "source": "https://sgn.example.com/integration/v1",
  "type": "sgn.grant.revoked",
  "time": "2026-11-19T02:15:00Z",
  "subject": "case/DA-2026-0004",
  "datacontenttype": "application/json",
  "sequence": "00000000000000001042",
  "data": {
    "case_no": "DA-2026-0004",
    "grant_id": "431",
    "process_type": "data_access",
    "tier": "L3",
    "status": "ended",
    "subject": {"type": "principal", "id": "channel-sales", "properties": {"kind": "team", "provider": "ldap"}},
    "owner": {"type": "person", "id": "p07", "properties": {"provider": "ldap"}},
    "rule_code": "K-REVOKE",
    "change_class": null,
    "valid_from": "2026-11-15T16:00:00Z",
    "valid_until": "2027-05-15T16:00:00Z",
    "entitlements": [
      {
        "entitlement_id": "8812",
        "revision": 1,
        "status": "ended",
        "end_reason": "revoked",
        "ended_at": "2026-11-19T02:15:00Z",
        "effective_during": "active",
        "valid_from": "2026-11-15T16:00:00Z",
        "valid_until": "2027-05-15T16:00:00Z",
        "resource": {"type": "data_field", "id": "sales_order.amount"},
        "actions": ["read"],
        "constraints": {
          "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
          "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}
        }
      }
    ]
  }
}
```

| 屬性 | 值 |
|---|---|
| `specversion` | 固定 `"1.0"` |
| `id` | `evt-` 加上事件序號。同一個事件不論重送幾次、送給誰，`id` 都相同 |
| `source` | 參數 `integration.issuer` 的值 |
| `type` | 7.1 的類型 |
| `time` | 事件發生的時間（平台時間） |
| `subject` | `case/<申請單號>`、`principal/<識別碼>`、`person/<識別碼>`、`client/<系統代碼>`、`run/<id>`、`finding/<id>`、`review/<複查編號>`、`checkpoint/<id>`。主體的識別碼依 3.2 以呼叫方的身分來源表示，沒有對應時是 `anon-…` 的代號；不輸出內部 id |
| `sequence` | CloudEvents 的 sequence 擴充屬性：事件序號補零到 20 位數的字串，可以直接用字串比大小 |
| `data` | 依類型，見下 |

`data` 的內容：

| 類型 | `data` |
|---|---|
| `sgn.grant.*` | 如上例。`entitlements` 是這張申請單在改變之後、這個呼叫方可見的**全部**權限項目與各自的狀態；每一筆另帶 `effective_during`、`valid_from`、`valid_until`。`sgn.grant.expiring` 另帶 `expires_at`、`days_left` |
| `sgn.principal.owner_changed` | `{"principal": 主體, "old_owner": 主體或 null, "new_owner": 主體, "rule_code"}` |
| `sgn.principal.owner_at_risk` | `{"principal": 主體, "owner": 主體, "grace_until": 時間, "rule_code": "K-OWNER-CONTINUITY"}` |
| `sgn.principal.membership_changed` | `{"principal": 主體, "added": [{"member": 主體, "valid_from", "valid_until"}…], "removed": [主體…], "unmapped_count": 整數, "reason": "member_added" \| "member_removed" \| "person_inactive"}` |
| `sgn.principal.identity_changed` | `{"principal": 新的主體表示, "previous": 舊的主體表示或 null}`。新的對應被移除時，`principal` 是 `anon-…` 的代號 |
| `sgn.person.identity_changed` | `{"person": 新的主體表示, "previous": 舊的主體表示或 null}` |
| `sgn.client.visibility_changed` | `{"client": 系統代碼, "sync_epoch": 新的值}` |
| `sgn.reconciliation.run_completed` | 8.2 的批次（含 `summary`） |
| `sgn.reconciliation.finding_opened`、`finding_closed` | 與 8.6 的發現相同的結構 |
| `sgn.review.campaign_opened`、`campaign_closed` | `{"review_no", "process_type", "status", "starts_at", "due_at", "item_count", "summary"}`，`summary` 見 9.6 |
| `sgn.evidence.checkpoint` | 與 10.4 的檢查點相同的結構 |
| `sgn.webhook.ping` | `{"endpoint_id", "message": "ping"}` |

事件內容依呼叫方產生：主體用呼叫方的身分來源表示；`entitlements` 只包含呼叫方可見的項目。

誰收得到（`K-INT-VISIBILITY`）：

| 事件 | 送給 |
|---|---|
| `sgn.grant.*` | 至少有一筆權限項目可見的呼叫方 |
| `sgn.principal.*` | 該被授權者**目前**有 `pending` 或 `active` 的可見權限項目，或有在 `integration.check_ended_lookback_days` 天內結束的可見項目的呼叫方。只在多年前看過一筆早已結束的項目，不會繼續收到這個團隊的人事異動 |
| `sgn.principal.identity_changed`、`sgn.person.identity_changed` | 同上，而且改變的 provider 是這個呼叫方的 `identity_provider`。人的事件：這個人是可見權限項目的主體，或是符合上一列條件的被授權者的成員或負責人 |
| `sgn.client.visibility_changed`、`sgn.reconciliation.*` | 只有該呼叫方自己 |
| `sgn.review.*` | 流程類型可見的呼叫方 |
| `sgn.evidence.checkpoint` | 有 `evidence.read` 的呼叫方 |

`membership_changed` 的 `added`、`removed` 中，在呼叫方的身分來源沒有對應的人直接省略（不改用其他識別碼），人數寫在 `unmapped_count`；省略之後兩個陣列都是空的而 `unmapped_count` 也是 0 時，這個呼叫方不會收到這個事件。

撤銷原因是使用者填寫的文字，可能含有個人資料，事件裡只帶規則代碼，不帶原因的文字。

事件是通知，不是授權的依據。使用方在**放寬**存取之前，應該以權限判定或授權查詢再確認一次；**收緊**存取可以直接依事件處理。

### 7.3 事件串流（可重播）

```http
GET /integration/v1/events?after=e1.1040&limit=100&types=sgn.grant.revoked,sgn.grant.expired HTTP/1.1
Authorization: Bearer sgn_at_TRVmodff...
```

```json
{
  "events": [
    {
      "specversion": "1.0",
      "id": "evt-1042",
      "source": "https://sgn.example.com/integration/v1",
      "type": "sgn.grant.revoked",
      "time": "2026-11-19T02:15:00Z",
      "subject": "case/DA-2026-0004",
      "datacontenttype": "application/json",
      "sequence": "00000000000000001042",
      "data": {
        "case_no": "DA-2026-0004",
        "grant_id": "431",
        "process_type": "data_access",
        "tier": "L3",
        "status": "ended",
        "subject": {
          "type": "principal",
          "id": "channel-sales",
          "properties": {
            "kind": "team",
            "provider": "ldap"
          }
        },
        "owner": {
          "type": "person",
          "id": "p07",
          "properties": {
            "provider": "ldap"
          }
        },
        "rule_code": "K-REVOKE",
        "change_class": null,
        "valid_from": "2026-11-15T16:00:00Z",
        "valid_until": "2027-05-15T16:00:00Z",
        "entitlements": [
          {
            "entitlement_id": "8812",
            "revision": 1,
            "status": "ended",
            "end_reason": "revoked",
            "ended_at": "2026-11-19T02:15:00Z",
            "effective_during": "active",
            "valid_from": "2026-11-15T16:00:00Z",
            "valid_until": "2027-05-15T16:00:00Z",
            "resource": {
              "type": "data_field",
              "id": "sales_order.amount"
            },
            "actions": [
              "read"
            ],
            "constraints": {
              "row_filter": [
                {
                  "filter": "region",
                  "op": "in",
                  "values": [
                    "central",
                    "north"
                  ]
                }
              ],
              "data_period": {
                "field": "order_date",
                "from": "2025-01-01",
                "to": "2026-12-31"
              }
            }
          }
        ]
      }
    }
  ],
  "next_cursor": "e1.1057",
  "has_more": false
}
```

| 參數 | 說明 |
|---|---|
| `after` | 游標（上一次的 `next_cursor`，或 6.5 的 `events_cursor`）：回傳在它之後的事件。省略時從最早的事件開始。特殊值 `tail`：不回事件，只回目前最新位置的游標 |
| `types` | 只要這些類型，逗號分隔。省略時是呼叫方的 scope 允許的全部類型 |
| `limit` | 預設 `integration.page_size_default`，上限 `integration.page_size_max` |

規則：

- `next_cursor` 是這次掃描到的位置。即使 `events` 是空的（掃過的事件都不可見或不符合類型），游標也會前進；使用方每次都要保存它。
- 游標是不透明的字串（內含 `sync_epoch` 與事件序號），不等於事件的 `sequence`。格式錯誤回 400（`integration_cursor_invalid`）。游標指向的位置超過目前最新的事件時，回空陣列，`next_cursor` 是目前最新的位置，`has_more` 是 false。
- 游標是在可見範圍或身分來源改變之前發出的：回 409（`integration_resync_required`）。使用方重做完整快照（6.4），再以 `after=tail` 取得新的游標。
- 事件永久保留，任何時候都可以從任何游標重播。重播時的內容依呼叫方**現在**的可見範圍與身分來源產生。
- 需要 scope `events.read`；其他類別的事件另外需要 7.1 所列的 scope，沒有該 scope 的類型不會出現（不回錯誤）。
- 建議的輪詢間隔不低於 5 秒；`has_more` 是 true 時可以立即再讀。

### 7.4 順序與送達保證

規則 `K-INT-EVENT-ORDER`：

- **全域順序**：事件序號嚴格遞增，而且與交易提交的順序一致。做法：`sgn_internal.emit_integration_event` 在取序號之前，先取得一個交易層級的 advisory lock（`pg_advisory_xact_lock`，固定的鍵），鎖到交易結束才釋放。所以任何時候讀到的最大序號之前，不會再有較小的序號出現；同一張申請單的事件一定依發生順序排列。序號可能跳號（交易回復），不影響順序。
- **至少一次**：串流可以重讀；webhook 在沒有收到成功回應時會重送。使用方必須以事件的 `id` 去重。
- **webhook 依序**：每個訂閱一次只送一個事件，前一個成功之後才送下一個。前一個還在重試時，後面的事件等待。
- **不保證恰好一次**，也不保證 webhook 與串流之間的先後。

取鎖的代價是：會產生事件的交易在取鎖之後彼此排隊。所以鎖只能在交易的最後片刻持有：

- 授權的事件由延後到提交時才執行的觸發程序發出（2.2），鎖從提交前的投影開始，到提交結束。簽核、執行、撤銷的主要工作都在取鎖之前做完。
- 其他會發事件的 function（對帳、複查、檢查點）必須把 `emit_integration_event` 放在交易的最後；取鎖之後，同一個交易不得再做對帳比對、不得等待任何外部資源。對帳的比對與發現的產生分成不同的交易（8.5）。
- 對帳的 `open_items`、`open_missing`、`close` 階段每個交易最多處理 `reconciliation.findings_batch_size` 筆發現，所以每次持有鎖的時間有上限。

### 7.5 webhook 訂閱

管理端點（scope 都是 `webhooks.manage`；只能管理自己的訂閱）：

| 用途 | 方法與路徑 |
|---|---|
| 列出 | `GET /integration/v1/webhooks` |
| 建立 | `POST /integration/v1/webhooks` |
| 取得 | `GET /integration/v1/webhooks/{endpoint_id}` |
| 修改（事件類型、說明、暫停與恢復） | `PATCH /integration/v1/webhooks/{endpoint_id}` |
| 刪除 | `DELETE /integration/v1/webhooks/{endpoint_id}` |
| 輪替簽章密鑰 | `POST /integration/v1/webhooks/{endpoint_id}/rotate-secret` |
| 送出測試事件 | `POST /integration/v1/webhooks/{endpoint_id}/ping` |

建立：

```json
{
  "url": "https://bi.example.com/hooks/sgn",
  "event_types": ["sgn.grant.activated", "sgn.grant.changed", "sgn.grant.expired", "sgn.grant.revoked", "sgn.grant.ended"],
  "description": "報表入口網站的權限同步"
}
```

```json
{
  "endpoint_id": "ep_2fVZdC8Kx9TR4ZoCqHWt3NnL",
  "url": "https://bi.example.com/hooks/sgn",
  "event_types": ["sgn.grant.activated", "sgn.grant.changed", "sgn.grant.expired", "sgn.grant.revoked", "sgn.grant.ended"],
  "description": "報表入口網站的權限同步",
  "status": "pending_verification",
  "status_reason": null,
  "secret": "whsec_l5QFIoC5OcwlC0gcYIxhc+WT5NNPY+gsDu3Whj7HTrU=",
  "created_at": "2026-11-19T02:00:00Z",
  "last_success_at": null,
  "last_failure_at": null
}
```

規則：

- `url` 必須是 `https`（參數 `integration.webhook_allow_http` 為 true 時才允許 `http`，只給測試環境），長度不超過 2000，不得帶帳號密碼與 fragment；它的來源必須在該 `api_client` 的 `allowed_webhook_origins` 之內，否則回 `webhook_origin_not_allowed`。
- `event_types` 的每一個都要存在於 `sgn.integration_event_type`，而且呼叫方有對應的 scope。空陣列代表「呼叫方可以收到的全部類型」。
- 每個 `api_client` 的訂閱數上限是 `integration.webhook_max_per_client`（`webhook_subscription_limit`）。
- 建立、修改、刪除、輪替密鑰、ping 合計，每個 `api_client` 每小時不超過 `integration.webhook_manage_limit_per_hour` 次，超過回 429（`integration_rate_limited`）。這些動作每一次都寫稽核事件，上限是為了不讓它們灌滿稽核鏈。
- `secret` 只在建立與輪替的回應出現。它不存在資料庫裡：後端用部署設定的主金鑰推導，`secret = HMAC-SHA256(主金鑰, "sgn-webhook-v1:" + endpoint_id + ":" + secret_version)`，取 32 個位元組，以 `whsec_` 加 base64 表示。資料庫只保存 `secret_version`。
- 新訂閱的狀態是 `pending_verification`。平台先送一個 `sgn.webhook.ping`；收到 2xx 才改為 `enabled`，並從建立當下之後的事件開始推送。
- 輪替密鑰：`secret_version` 加一。之後的 `integration.webhook_secret_overlap_hours` 小時內，每次推送同時帶新舊兩把密鑰的 `v1` 簽章。
- 刪除是軟刪除（保留送達紀錄）。已刪除的訂閱對所有端點都是 404。

訂閱的狀態：

| 狀態 | 意義 |
|---|---|
| `pending_verification` | 等 ping 成功 |
| `enabled` | 推送中 |
| `paused` | 呼叫方或系統管理員暫停 |
| `disabled` | 被停用（原因見 `status_reason`）。要恢復必須明確改回 `enabled` |

`PATCH` 修改 `status` 時允許的轉移（表中沒有列的組合一律回 409 `webhook_status_invalid`；目前狀態與要求的狀態相同時回 200，不做事）：

| 目前 | 要求 | 結果 |
|---|---|---|
| `enabled` | `paused` | 暫停推送並保留進度 |
| `paused` | `enabled` | 恢復推送。可以給 `resume_from`：`cursor`（預設，從上次成功的位置接著送，不漏事件）或 `tail`（跳到最新，漏掉的部分自己用串流或授權查詢補） |
| `disabled` | `enabled` | 狀態先變成 `pending_verification` 並重新送 ping；ping 成功後才是 `enabled`，再依 `resume_from` 決定從哪裡送 |

`pending_verification` 只能靠 ping 成功變成 `enabled`，不能用 `PATCH` 改。`disabled` 不能用 `PATCH` 設定（要停用就刪除，或由系統管理員處理）。

其他兩個動作對各狀態的結果：

| 動作 | `pending_verification` | `enabled` | `paused` | `disabled` |
|---|---|---|---|---|
| `rotate-secret` | 可以 | 可以 | 可以 | 可以 |
| `ping` | 重新送一次驗證用的 ping | 送 ping，不影響事件的進度 | 送 ping，狀態不變 | 409 `webhook_status_invalid`（先用 `PATCH` 改回 `enabled`） |

### 7.6 webhook 推送

每次推送是一個 HTTP POST，內容是一個 CloudEvents JSON 事件（structured mode），標頭依 Standard Webhooks：

```http
POST /hooks/sgn HTTP/1.1
Host: bi.example.com
Content-Type: application/cloudevents+json; charset=utf-8
User-Agent: sgn-webhook/1
webhook-id: evt-1042
webhook-timestamp: 1795054500
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4= v2a,kG9XaxZjAEpKB8KeQQb5G1Xp73YH5Rf5gxoWe7cg1kYMiyspdtZXe9w+dAwKeOurAwxfqmlOG/QR4m9s37DzAg==

{"specversion":"1.0","id":"evt-1042","source":"https://sgn.example.com/integration/v1","type":"sgn.grant.revoked", ...}
```

| 標頭 | 值 |
|---|---|
| `webhook-id` | 事件的 `id`。重送時不變。ping 是 `ping-<endpoint_id>-<第幾次>` |
| `webhook-timestamp` | 這一次嘗試的時間，Unix 秒。每次重送都更新 |
| `webhook-signature` | 以空白分隔的多個簽章 |

簽章（位元組完全以送出的內容為準，不得重新序列化）：

```
v1  = base64( HMAC-SHA256( key = whsec_ 之後 base64 解碼的位元組,
                           msg = webhook-id + "." + webhook-timestamp + "." + body ) )

v2a = base64( ed25519_sign( 平台私鑰,
                            SHA-256( endpoint_id + "." + webhook-id + "." + webhook-timestamp + "." + body ) ) )
```

- `v1` 一定有；密鑰輪替的重疊期間有兩個 `v1`。
- `v2a` 一定有，用平台目前的簽章金鑰。公鑰在 `GET /integration/v1/jwks.json`（見 10.4）。
- 使用方只要驗證其中一種成功即可。建議驗 `v2a`：它不依賴共用密鑰，而且簽章內容包含 `endpoint_id`，送給別的訂閱的事件無法拿來重放。
- 使用方要檢查 `webhook-timestamp` 與自己的時間相差不超過 5 分鐘，並以 `webhook-id` 去重。

回應的處理：

| 回應 | 處理 |
|---|---|
| 2xx | 成功，送下一個事件 |
| `410 Gone` | 立即停用訂閱（`status_reason = 'gone'`），不再重試 |
| 3xx | 失敗。不跟隨轉址 |
| 429、502、503、504 | 失敗；有 `Retry-After` 時，下一次嘗試不早於它指定的時間（上限同重試間隔的上限） |
| 其他狀態碼、逾時（`integration.webhook_timeout_seconds`）、連線錯誤、TLS 驗證失敗 | 失敗 |

重試（規則 `K-INT-WEBHOOK-DISABLE`）：

- 同一個事件最多嘗試 `integration.webhook_max_attempts` 次。第 k 次失敗後，等待 `min(上限, 基數 × 倍數^(k−1))` 秒，再乘上 0.9 到 1.1 之間的隨機值。預設（基數 5 秒、倍數 6、上限 86400 秒、10 次）的等待時間約為 5 秒、30 秒、3 分鐘、18 分鐘、1 小時 48 分、10 小時 48 分、24 小時、24 小時、24 小時，全程約三天半。
- 嘗試次數用盡：停用訂閱（`status_reason = 'delivery_exhausted'`），寫稽核事件，並通知 `api_client` 的負責人與系統管理員。進度停在失敗的那個事件，恢復時可以選擇從那裡接著送。
- 其他會停用訂閱的情況：`api_client` 被永久停用；系統管理員把訂閱網址的來源從 `allowed_webhook_origins` 移除。
- 每一次嘗試都記在 `sgn.webhook_attempt`。失敗時只記錯誤的種類（`error_kind`：`timeout`、`tls`、`connect`、`dns`、`blocked_address`、`http_status`、`other`）與狀態碼，不保存對方回應的任何內容。

推送由後端的 worker 執行（與寄信的 worker 相同的模式）：向資料庫領取要送的事件、簽章、送出、回報結果。重試的時間與停用的判斷都在資料庫的 function 裡。

worker 連線的規定（防止訂閱網址被用來打平台內部的服務）：

1. 每一次嘗試（含重試）都重新解析主機名稱一次，取得位址清單。
2. 清單中任何一個位址落在禁止範圍，這次嘗試直接失敗（`error_kind = 'blocked_address'`），不連線。禁止範圍：loopback（`127.0.0.0/8`、`::1`）、link-local（`169.254.0.0/16`、`fe80::/10`）、未指定位址（`0.0.0.0/8`、`::`）、多播（`224.0.0.0/4`、`ff00::/8`）、IPv4-mapped IPv6（`::ffff:0:0/96`，先換回 IPv4 再依上列範圍檢查）、部署設定 `WEBHOOK_BLOCKED_CIDRS` 列出的平台內部網段。部署設定 `WEBHOOK_ALLOW_PRIVATE` 為 false（預設）時，私有位址（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`fc00::/7`）也禁止；使用方在公司內網時由部署設定為 true，並用 `WEBHOOK_BLOCKED_CIDRS` 排除平台自己的網段。
3. 用第 1 步解析到的位址連線，不再解析第二次（網域在檢查之後改指別處也沒有用）。TLS 的 SNI 與憑證驗證仍用原本的主機名稱。
4. 不跟隨轉址；不使用系統的 proxy 設定以外的任何中繼。
5. `integration.webhook_allow_http` 為 true 的測試環境，第 2 步只保留未指定位址與多播兩項。

## 8. 對帳（`reconciliation_run`、`reconciliation_finding`）

### 8.1 流程

其他系統定期把「自己實際設定的權限」回報給平台，平台與核准的權限項目比對。回報有兩條路，比對與發現的處理完全共用：

- 有 API 的系統：以本節的端點回報（8.2 到 8.4）。
- 沒有 API 的系統：由該系統的負責人匯出權限清單，在本站上傳檔案（8.9）。

```
建立批次（collecting）→ 分批上傳實際權限 → 宣告完成（comparing）→ 排程分段比對 → completed
                                                                  ↘ needs_review（新發現異常多，等人工檢視）→ comparing 或 discarded
```

| 步驟 | 方法與路徑 | scope |
|---|---|---|
| 建立批次 | `POST /integration/v1/reconciliation/runs` | `reconciliation.write` |
| 上傳項目 | `POST /integration/v1/reconciliation/runs/{run_id}/items` | `reconciliation.write` |
| 宣告完成 | `POST /integration/v1/reconciliation/runs/{run_id}/complete` | `reconciliation.write` |
| 查批次狀態與結果 | `GET /integration/v1/reconciliation/runs/{run_id}` | `reconciliation.write` |
| 查自己的發現 | `GET /integration/v1/reconciliation/findings` | `reconciliation.write` |

每個批次是某個範圍的**完整快照**：範圍內沒有回報的權限，就代表該系統沒有設定。

批次的狀態：

| 狀態 | 意義 |
|---|---|
| `collecting` | 接受上傳 |
| `comparing` | 已宣告完成，排程比對中 |
| `completed` | 比對完成 |
| `needs_review` | 這個批次會產生的新發現超過上限，暫停，等系統管理員檢視（8.5） |
| `discarded` | 系統管理員檢視後判定這個批次的資料不可信，作廢。不算一次完成的對帳 |
| `abandoned` | 逾時未完成，或被同一個範圍的新批次取代 |

對帳只涵蓋持續性的權限。`effective_during = fulfilment` 的權限項目（一次性許可）不參與：回報的項目不會與它們比對，它們也不會產生 `missing`。一次性許可的把關靠判定時的期限與用量回報（3.4、5.7）。

### 8.2 建立批次

```json
{
  "process_type": "data_access",
  "resource_type": "data_field",
  "resource_id_prefix": "sales_order.",
  "observed_at": "2026-11-19T01:00:00Z"
}
```

```json
{
  "run_id": "205",
  "status": "collecting",
  "origin": "api",
  "process_type": "data_access",
  "resource_type": "data_field",
  "resource_id_prefix": "sales_order.",
  "observed_at": "2026-11-19T01:00:00Z",
  "item_count": 0,
  "created_at": "2026-11-19T01:02:11Z",
  "completed_at": null,
  "superseded_by": null,
  "summary": null
}
```

規則：

- `process_type` 必填。`resource_type`、`resource_id_prefix` 選填，用來宣告這次快照涵蓋的範圍；`resource_id_prefix` 必須搭配 `resource_type`。
- 宣告的範圍必須完全落在呼叫方的可見範圍內：存在一列可見規則，流程類型相同，規則的 `resource_type` 是 null 或與宣告的相同，規則的 `resource_id_prefix` 是 null 或是宣告的 `resource_id_prefix` 的開頭。否則回 403（`integration_scope_not_visible`）。
- `observed_at` 是該系統讀取自己權限設定的時間。它必須同時符合三個條件，否則回 400（`integration_invalid_request`，`message` 帶允許的最早時間）：
  - 不晚於現在；
  - 不早於現在減去 `reconciliation.observed_max_age_minutes`（回報的必須是剛讀到的狀態，不能拿舊的快照來讓剛撤銷的權限看起來還在容許時間內）；
  - 不早於同一個呼叫方、同一個宣告範圍上一個 `completed` 批次的 `observed_at`。
- 數量上限：每個 `api_client` 每天（UTC）最多建立 `reconciliation.max_runs_per_day` 個批次；同時處於 `collecting`、`comparing`、`needs_review` 的批次最多 `reconciliation.max_open_runs` 個。超過回 429（`reconciliation_run_limit`）。
- 同一個呼叫方、同一個範圍已有 `collecting` 的批次時，舊的批次改為 `abandoned`，並在 `superseded_by` 記下新批次的 id。
- 超過 `reconciliation.collect_timeout_hours` 仍未宣告完成的批次，由排程改為 `abandoned`。

### 8.3 上傳項目

```json
{
  "items": [
    {
      "item_key": "grp_channel_sales|sales_order.amount|read|8812",
      "subject": {"type": "principal", "id": "channel-sales"},
      "resource": {"type": "data_field", "id": "sales_order.amount"},
      "action": {"name": "read"},
      "entitlement_id": "8812",
      "constraints": {
        "row_filter": [{"filter": "region", "op": "in", "values": ["central", "north", "south"]}],
        "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}
      },
      "properties": {"db_role": "grp_channel_sales", "policy": "rls_sales_order_17"}
    }
  ]
}
```

```json
{"accepted": 1, "item_count": 1}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `subject`、`resource`、`action` | 是 | 與權限判定相同的結構。一筆只有一個動作 |
| `constraints` | 否 | 該系統實際設定的限制，用流程包定義的同一套鍵。省略等於 `{}`，代表沒有任何限制 |
| `entitlement_id` | 否 | 這條設定是依哪一筆權限項目套用的（執行系統通常知道，因為設定是依交付內容做的）。有給時只與這一筆比對 |
| `item_key` | 否 | 該系統自己的唯一鍵，1 到 256 個字元，不含控制字元。省略時由平台算出：`encode(sha256(jsonb_build_array(subject.type, provider, subject.id, resource.type, resource.id, action.name, entitlement_id)::text), 'hex')`。同一批次內相同的鍵，後送的取代先送的（重送安全） |
| `properties` | 否 | 該系統自己的參考資訊（角色名稱、規則編號），原樣保存在證據裡，不參與比對。序列化後不超過 4 KB |

規則：

- 一次請求最多 `reconciliation.items_per_request_max` 筆；一個批次最多 `reconciliation.max_items` 筆（`reconciliation_too_many_items`）。
- 每一筆的資源必須落在批次宣告的範圍內，否則整個請求回 400（`reconciliation_item_out_of_scope`）。
- 批次不是 `collecting` 時回 409（`reconciliation_run_not_collecting`）。批次是被新批次取代的，呼叫方以「查批次狀態」取得 `status: "abandoned"` 與 `superseded_by`。
- **實際設定是多筆核准合併而成時，回報方必須依來源拆開。** 例如同一個團隊對同一個欄位有兩張有效的申請單，一張核准北區、一張核准南區，資料庫裡的列層級安全是一條「北區或南區」的規則。回報方要送兩筆，各帶 `entitlement_id` 與該筆核准對應的限制條件。無法拆分的系統不帶 `entitlement_id`，平台改用聯集比對（8.5），但流程包不支援聯集比對時會被判為超出核准範圍。

### 8.4 宣告完成

```json
{"item_count": 1}
```

- `item_count` 必須等於平台已收到的筆數，否則回 409（`reconciliation_item_count_mismatch`）。這是為了發現漏送的批次。
- 0 筆是合法的快照，代表該系統在這個範圍內沒有任何權限。0 筆的批次會列入該系統的對帳統計（8.8）。
- 成功後狀態改為 `comparing`，回 202 與批次內容。比對由排程執行；呼叫方用「查批次狀態」輪詢，或等 `sgn.reconciliation.run_completed` 事件。

### 8.5 比對演算法

規則 `K-INT-RECON-COMPARE`。令 T 是批次的 `observed_at`，G 是參數 `reconciliation.grace_minutes`（容許兩邊的時間差與作業中的變更）。

**分段執行。** 一個批次可能有幾十萬筆，比對不能在一個交易裡做完，也不能在持有事件鎖（7.4）的時候做。`sgn_internal.compare_reconciliation_step(p_run_id)` 每呼叫一次只做一小段，並把進度記在批次上（`compare_phase`、`compare_cursor`）。排程 `job_reconciliation` 每次呼叫對每個 `comparing` 的批次各做一段，還有工作沒做完時回傳 `{"more": true}`，排程入口立即再呼叫（每次呼叫是獨立的交易，見 15.4）。

| 階段（`compare_phase`） | 每一段做什麼 | 會不會發事件 |
|---|---|---|
| `items` | 依 id 取 `reconciliation.compare_batch_size` 筆回報項目，做第一步的逐筆判定，把結果寫回項目 | 不會。這個階段會呼叫流程包的 hook |
| `count` | 一段做完：算出這個批次會新增幾筆發現（第一步的結果加上第二步的 `missing`，扣掉已有相同指紋的未結案發現）。超過上限就走「異常批次」（見下），否則進下一階段 | 異常時發一個 |
| `open_items` | 每段依回報項目的 id 處理 `reconciliation.findings_batch_size` 筆結果是 `exceeds_approved`、`ended_still_present`、`unapproved` 的項目：建立或更新發現（第三步） | 每筆新發現一個，放在交易的最後 |
| `open_missing` | 每段依權限項目的 id 處理 `reconciliation.findings_batch_size` 筆範圍內的權限項目：建立或更新 `missing` 的發現（第二步、第三步） | 同上 |
| `close` | 每段依發現的 id 處理 `reconciliation.findings_batch_size` 筆：這次沒有再出現的既有發現（第三步） | 每筆結案一個 |
| `finalize` | 一段做完：統計、稽核事件、摘要通知、`sgn.reconciliation.run_completed`，狀態改為 `completed` | 一個 |

**第一步：逐筆判定回報的項目。**

1. 解析主體（`resolve_subject`，身分來源是回報方的 `identity_provider`）。解析不出來，或解析到的人不在職、被授權者已結束 → 結果 `unapproved`，並標記 `subject_unresolved`。
2. 展開主體集合 S：與 5.3 相同，但成員關係取 **T 當時**的（`subject_principals(人, T)`）。
3. 取候選 C：
   - 項目沒有 `entitlement_id`：該流程類型、`effective_during = 'active'` 的權限項目中，主體屬於 S、資源相同、`actions` 包含回報的動作。
   - 項目有 `entitlement_id`：只取那一筆，而且它必須符合上面全部條件並對回報方可見。不符合時 C 是空的，另外標記 `entitlement_mismatch`。
4. 取 T 當時有效的 A：C 中 `status = 'active'`、`effective_from <= T`、`effective_until` 是 null 或 `T < effective_until`。
5. 依序取第一個成立的結果：

| # | 條件 | 結果 |
|---|---|---|
| 1 | A 中有一筆，以 `reconcile` 模式呼叫 `evaluate_constraints`（`context` 是回報的 `constraints`，`approved_union` 是 null）回 true | `covered`（有核准，而且在範圍內）。記下對上的那一筆 |
| 2 | A 有兩筆以上，項目沒有 `entitlement_id`，而且以聯集模式呼叫一次回 true：`p_constraints` 是 A 中 id 最小那一筆的限制條件，`approved_union` 是 A 全部的限制條件 | `covered`，標記 `matched_union`（實際設定落在多筆核准合起來的範圍內） |
| 3 | A 不是空的，而且 A 中有任何一筆的 `updated_at` 不早於 T − G（核准的動作或限制條件在容許時間內剛改過，回報的可能是舊範圍） | `tolerated` |
| 4 | A 不是空的 | `exceeds_approved`（有核准，但實際設定超出核准範圍） |
| 5 | C 中有 `pending` 的；或起始時間晚於 T 但不晚於 T + G 的；或結束時間不早於 T − G 的（包含在 T 之後才結束的） | `tolerated`（作業中的時間差，不算發現） |
| 6 | 回報的主體是人，而他在 T − G 到 T + G 之間的任何時間，曾是某個被授權者的有效成員，且該被授權者有一筆資源相同、動作相同、在這段時間內有效的權限項目（成員剛加入或剛被移除） | `tolerated` |
| 7 | C 中有任何已結束的項目（結束時間早於 T − G） | `ended_still_present`（已到期或已撤銷，權限仍然存在） |
| 8 | 其他 | `unapproved`（沒有核准卻存在） |

**第二步：找出核准了卻沒設定的。**

對批次範圍內的每一筆權限項目 e，條件是 `status = 'active'`、`effective_during = 'active'`、T 當時有效、而且 `effective_from <= T − G`；對 e 的每一個動作 a：如果沒有任何一筆結果是 `covered` 或 `exceeds_approved` 的回報項目同時符合「資源相同、動作是 a、e 的主體屬於該項目的主體集合 S」，就產生一筆 `missing`。

被授權者是團隊而該系統以人為單位設定權限時，只要有一位成員的設定對得上，就不算 `missing`；平台不檢查每一位成員是否都設定了。

**異常批次**（規則 `K-INT-RECON-ANOMALY`）。`count` 階段算出的新發現數超過 `reconciliation.max_new_findings_per_run`，而且這個批次沒有被人工放行過時：

- 不逐筆建立發現，也不結案任何既有的發現。
- 建立一筆類型為 `run_anomalous` 的發現（高嚴重度），`detail` 是各類結果的筆數；指派給回報系統的負責人。
- 批次的狀態改為 `needs_review`，通知負責人與系統管理員，發出一個 `sgn.reconciliation.run_completed` 事件（`status` 是 `needs_review`）。
- 系統管理員（不得是該系統的負責人）檢視後以 `reconciliation_run_review` 決定：`accept`（資料可信，偏差真的這麼多）→ 批次回到 `comparing`，從 `open_items` 階段繼續，不再套用上限；`discard`（回報的資料有問題）→ 批次改為 `discarded`。兩種決定都要填說明，都會結案那筆 `run_anomalous` 的發現（原因 `run_reviewed`），並寫稽核事件。

這條規則的目的：一個有 `reconciliation.write` 的系統（或拿到它 token 的人）送出大量捏造的項目時，不會變成幾十萬筆發現、通知與稽核事件。

**第三步：產生、更新、結案發現。**

每一筆發現有一個指紋。輸入用 JSON 陣列編碼，各欄位之間不會互相混淆：

```sql
fingerprint := digest(jsonb_build_array(
                   p_api_client_id,        -- bigint
                   p_kind::text,
                   p_subject_key,          -- jsonb：["person", <id>]、["principal", <id>]，解析不出來時 ["unresolved"]
                   p_resource_type,
                   p_resource_id,
                   p_action,
                   p_entitlement_id        -- bigint 或 null
               )::text, 'sha256');
```

- 主體解析不出來時，指紋不含回報的識別碼：同一個資源、同一個動作上所有解析不出來的回報合成一筆發現，回報的識別碼列在 `detail.reported_subjects`（最多 50 個，另帶總數）。所以每一批換一個假的識別碼，不會讓發現重新開始計時。
- `p_entitlement_id`：`exceeds_approved` 取對不上的那一筆（項目有 `entitlement_id` 時取它，否則取 A 中 id 最小的）；`ended_still_present` 取 C 中最晚結束的那一筆；`missing` 取 e；`unapproved` 是 null。

`open_items` 與 `open_missing` 階段，對每一筆要成立的發現：

1. 已有相同指紋、未結案（`open`、`acknowledged`、`pending_verification`）的發現：更新「最後出現的批次」與出現次數。原本是 `pending_verification` 的改回 `open`（它又出現了），期限沿用原本的。
2. 沒有相同指紋，但同一個回報系統、同一種類型、同一個（`resource_type`、`resource_id`、`action`）有一筆未結案、而且這個批次沒有再出現的發現：視為同一件事的延續（只是主體或對應的權限項目變了）。建立新的發現，但 `opened_at`、`due_at`、`escalated_at`、升級對象都沿用舊的那一筆，`continued_from_finding_id` 指向它；舊的那一筆以原因 `superseded` 結案。有多筆符合時取 `opened_at` 最早的。這樣換一個主體回報，不會讓逾期升級重新計時。
3. 都沒有：建立新的發現（狀態 `open`），指派、設定期限、發出 `sgn.reconciliation.finding_opened`。

`close` 階段，對該呼叫方在同一流程類型、資源落在這次批次範圍內、這次沒有再出現的每一筆未結案發現：

| 發現 | 處理 |
|---|---|
| 低嚴重度（`missing`），而且沒有被標記為不得自動結案 | 結案（`resolved`，原因 `resolved_by_run`），記下是哪一個批次證實的，發出 `sgn.reconciliation.finding_closed` |
| 高嚴重度，或被標記為不得自動結案（3.2） | 改為 `pending_verification`，記下是哪一個批次回報它消失了，設定確認期限（`reconciliation.verification_due_workdays`）。要等獨立確認才結案（8.7） |

回報方是被追究的一方，所以高嚴重度的發現不能只靠它自己的下一次回報結案：不回報那一筆、或送 0 筆，都只會讓發現進入等待確認。

發現的每一次變動（建立、再次出現、延續、進入等待確認、結案）都在 `sgn.reconciliation_finding_history` 加一列，帶批次 id。

**第四步：留下批次的證據**（`finalize`）。

- 寫一筆稽核事件（動作 `reconciliation.run_completed`），內容：各結果的筆數、`missing` 的筆數、新增／延續／等待確認／結案的發現數、回報項目的雜湊、這個批次造成的發現變動的雜湊。對帳的稽核事件以批次為單位，不是每筆發現一筆；逐筆的歷程在 `reconciliation_finding_history`，由這裡的雜湊保護。

```sql
-- 回報項目的雜湊（存入 reconciliation_run.items_sha256）
select digest(coalesce(string_agg(
           jsonb_build_object(
               'item_key', item_key,
               'subject', jsonb_build_array(subject_type, subject_provider, subject_external_id),
               'resource', jsonb_build_array(resource_type, resource_id),
               'action', action,
               'entitlement_id', reported_entitlement_id,
               'constraints', constraints,
               'properties', properties
           )::text, E'\n' order by item_key collate "C"), ''), 'sha256')
  from sgn.reconciliation_item where run_id = p_run_id;

-- 發現變動的雜湊（存入 reconciliation_run.findings_sha256）
select digest(coalesce(string_agg(
           jsonb_build_object(
               'history_id', h.id, 'finding_id', h.finding_id, 'event', h.event,
               'fingerprint', encode(f.fingerprint, 'hex')
           )::text, E'\n' order by h.id), ''), 'sha256')
  from sgn.reconciliation_finding_history h
  join sgn.reconciliation_finding f on f.id = h.finding_id
 where h.run_id = p_run_id;
```

- 通知以批次為單位：回報系統的負責人收到一封摘要（新增幾筆、各類型幾筆、連結）；`exceeds_approved` 與 `ended_still_present` 涉及的被授權者負責人，每人一封摘要；有發現進入等待確認時，可以確認的人收到一封摘要。不逐筆寄信。

### 8.6 發現的類型與結構

| 類型（`kind`） | 意義 | 嚴重度 |
|---|---|---|
| `unapproved` | 沒有核准卻存在 | `high` |
| `ended_still_present` | 已到期或已撤銷，權限仍然存在 | `high` |
| `exceeds_approved` | 有核准，但實際設定超出核准範圍 | `high` |
| `missing` | 核准了卻沒有設定 | `low` |
| `run_anomalous` | 一個批次會產生的新發現超過上限，整批等待人工檢視 | `high` |

```json
{
  "finding_id": "77",
  "kind": "exceeds_approved",
  "severity": "high",
  "status": "open",
  "process_type": "data_access",
  "subject": {"type": "principal", "id": "channel-sales", "properties": {"kind": "team", "provider": "ldap"}},
  "resource": {"type": "data_field", "id": "sales_order.amount"},
  "action": {"name": "read"},
  "entitlement_id": "8812",
  "case_no": "DA-2026-0004",
  "first_run_id": "205",
  "last_seen_run_id": "205",
  "seen_count": 1,
  "continued_from_finding_id": null,
  "opened_at": "2026-11-19T01:05:00Z",
  "due_at": "2026-11-23T01:05:00Z",
  "verification_due_at": null,
  "closed_at": null,
  "close_reason": null,
  "detail": {
    "item_key": "grp_channel_sales|sales_order.amount|read|8812",
    "reported_constraints": {"row_filter": [{"filter": "region", "op": "in", "values": ["central", "north", "south"]}], "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}},
    "approved_constraints": {"row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}], "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}},
    "properties": {"db_role": "grp_channel_sales", "policy": "rls_sales_order_17"}
  }
}
```

主體解析不出來時，`subject` 是 null，另帶 `"subject_unresolved": true`，回報的識別碼在 `detail.reported_subjects`。

給其他系統的輸出，依呼叫方有沒有 `grants.read` 分兩種（4.4）：

| 內容 | 有 `grants.read` | 沒有 `grants.read` |
|---|---|---|
| `missing` 的發現 | 逐筆列出，並發出事件 | 不列出、不發事件；只在批次的 `summary.missing` 給筆數 |
| `entitlement_id`、`case_no`、`detail.approved_constraints` | 輸出 | 一律是 null（`approved_constraints` 不出現） |
| 其他欄位（回報方自己送來的內容、狀態、期限） | 輸出 | 輸出 |

給人的畫面（負責人、系統管理員、稽核）不受這個限制。

### 8.7 發現的處理流程

| 項目 | 規則 |
|---|---|
| 指派給誰（`K-INT-RECON-ASSIGN`） | 回報系統（`api_client`）的負責人。他負責讓系統的實際設定回到核准的範圍，或讓缺少的設定補上。`exceeds_approved` 與 `ended_still_present` 另外通知該授權的被授權者負責人 |
| 時限 | 高嚴重度：`reconciliation.finding_due_workdays_high` 個工作天；低嚴重度：`reconciliation.finding_due_workdays_low` 個工作天。延續的發現沿用原本的期限（8.5） |
| 回應 | 負責人可以填寫處理說明（`acknowledged`）。這不會停止計時，也不算結案 |
| 逾期（`K-INT-RECON-SLA`） | 到期仍是 `open` 或 `acknowledged`：升級給負責人的直屬主管，並通知稽核角色。升級只做一次，之後這筆發現持續列在整合狀態與證據輸出裡，直到結案 |
| 獨立確認（`K-INT-RECON-VERIFY`） | `pending_verification` 的發現，由獨立的人查看實際系統後確認：`confirmed`（確實已處理）→ 結案（`resolved`，原因 `verified`）；`rejected`（還在）→ 改回 `open`，期限沿用原本的。可以確認的人：系統管理員；或參數 `reconciliation.verifier_role` 有設定時，該角色在這筆權限項目的 `scope_ref` 範圍的持有人（例如資料擁有者）。確認的人不得是這筆發現的負責人、升級對象、回報系統的負責人，也不得是造成它進入等待確認的那個批次的上傳人。確認必須填說明。超過 `verification_due_at` 沒有人確認：通知稽核角色一次，並持續列在整合狀態的例外 |
| 結案（`K-INT-RECON-CLOSE`） | 只有三種方式。**一、由批次的證據結案**：只適用低嚴重度、而且沒有被標記為不得自動結案的發現。**二、獨立確認**：高嚴重度的發現在回報方的批次顯示它消失之後，經上一列的確認。**三、人工排除**：系統管理員判定是回報或對應錯誤，選擇原因（`mapping_error`、`duplicate`、`system_retired`）並填寫說明；排除的人不得是這筆發現的負責人、回報系統的負責人，或任何一個回報過這筆發現的批次的上傳人。沒有「接受風險」這個選項：要保留多出來的權限，就去申請並取得核准 |
| 系統沒有回報（`K-INT-RECON-OVERDUE`） | 應該對帳的 `api_client`（有 `reconciliation.write`，或 `upload_enabled` 為 true），超過 `reconciliation.expected_interval_days` 沒有任何 `completed` 的批次：通知負責人，寫稽核事件，並顯示在整合狀態 |

發現的狀態：`open`（待處理）、`acknowledged`（已回應）、`pending_verification`（回報方的批次顯示已消失，等獨立確認）、`resolved`（結案）、`dismissed`（人工排除）。

結案原因（`close_reason`）：`resolved_by_run`、`verified`、`superseded`（由延續的發現取代）、`run_reviewed`（異常批次已檢視）、`mapping_error`、`duplicate`、`system_retired`。

### 8.8 如何成為稽核證據

- 每個批次：一筆稽核事件，帶結果統計、回報內容的雜湊、發現變動的雜湊。回報的原始項目保存 `reconciliation.item_retention_days` 天，可以用雜湊核對。
- 每筆發現由批次造成的變動：記在 `reconciliation_finding_history`（只增不改），由批次稽核事件裡的雜湊保護。
- 每筆發現由人做的動作（回應、確認、排除）與排程的升級：各一筆稽核事件，帶規則代碼。
- 每個回報系統的對帳統計（由 `integration_status` 與稽核資料包輸出，期間預設最近 90 天）：完成的批次數、0 筆的批次數、作廢與需要人工檢視的批次數、主體解析失敗的比例、各類發現的新增數、各種結案原因的筆數、高嚴重度發現從建立到結案的天數中位數、目前逾期與等待確認的筆數。0 筆批次偏多、解析失敗比例偏高、或「回報後消失」的比例偏高，都是回報不實的徵兆，稽核可以直接看到。
- 稽核可以回答三個問題：這個系統有沒有定期對帳（批次紀錄與 `K-INT-RECON-OVERDUE`）；對帳發現了什麼（發現清單）；發現有沒有在時限內處理、由誰確認、怎麼結案（發現的歷程）。
- 稽核查詢畫面與證據輸出都能依 `api_client`、期間、類型取得上述資料。

### 8.9 以檔案上傳對帳

規則 `K-INT-RECON-UPLOAD`。沒有 API 的系統（例如外購的套裝軟體、由廠商維運的雲端服務）一樣要對帳：系統的負責人從該系統匯出目前的權限清單，在本站上傳。上傳產生的批次與 API 的批次是同一種東西，比對、發現、期限、結案、證據完全相同，只差在批次記下了上傳人與檔案的雜湊。

- 這個系統同樣登記成一個 `api_client`（代表「一個被對帳的系統」），`upload_enabled` 為 true。它可以沒有任何憑證與 scope。
- 給人的端點 `POST /reconciliation/runs/upload`（14.2），對應 `api.reconciliation_run_upload`。只有該系統的負責人可以上傳。
- 檔案是 UTF-8 的 CSV，第一列是欄位名稱，欄位固定：

```
subject_type,subject_id,resource_type,resource_id,action,constraints,entitlement_id,item_key,properties
principal,channel-sales,data_field,sales_order.amount,read,"{""row_filter"":[{""filter"":""region"",""op"":""in"",""values"":[""central"",""north""]}]}",8812,,
```

  `constraints` 與 `properties` 是 JSON 文字，可以留空（等於 `{}`）；`entitlement_id`、`item_key` 可以留空。主體的識別碼以該系統的 `identity_provider` 解讀。
- 後端只做機制：計算原始檔案位元組的 SHA-256、把 CSV 轉成 8.3 的 `items` 陣列，然後呼叫 function。欄位不合規定時整個檔案被拒（`reconciliation_upload_invalid`），訊息帶第幾列、哪個欄位。檔案大小上限 20 MB，筆數上限 `reconciliation.max_items`。
- 上傳時要填：宣告的範圍（同 8.2）、`observed_at`（匯出清單的時間，不得早於現在減去 `reconciliation.upload_observed_max_age_hours`，其餘條件同 8.2）、說明（清單是怎麼匯出的）。
- function 在一個交易內建立批次（`origin = 'upload'`，記下 `uploaded_by`、`file_sha256`、說明）、寫入全部項目，並直接把狀態設為 `comparing`。之後與 API 的批次相同。
- 每天的批次數上限、異常批次的規則同樣適用。
- 上傳人是被追究的一方，所以他不能確認或排除這個系統的發現（8.7）。

人工執行之後由未參與的人獨立驗證，屬於核心的驗證步驟（待納入的增修 A7），不在本文件；它與本節共用同一種證據格式（稽核事件加雜湊）。

## 9. 定期複查（`access_review_campaign`、`access_review_item`）

### 9.1 建立一輪複查

由系統管理員建立，或由排程依參數自動建立。

| 欄位 | 說明 |
|---|---|
| `name` | 名稱 |
| `process_type` | 複查哪一種流程的授權（必填） |
| 範圍 | 選填的篩選：級別、`resource_type`、`resource_id_prefix`、被授權者類型。都不填就是該流程類型全部生效中的授權 |
| `reviewer_kind` | 複查人怎麼決定：`principal_owner`（被授權者的負責人）、`applicant_manager`（申請人的直屬主管）、`role_holder`（指定角色的持有人，搭配 `reviewer_role`；角色帶範圍時，以權限項目的 `scope_ref` 找該範圍的持有人） |
| `starts_at`、`due_at` | 開始時間與期限。`due_at` 預設是開始後 `review.duration_days` 天 |
| `no_response_action` | 不回應的處理：`revoke` 或 `escalate_only`。預設取參數 `review.no_response_action` |

規則：

- 流程類型的選項 `uses_principal` 為否時，不能選 `principal_owner`。
- 流程類型的選項 `revocable_after_fulfilment` 為否時，`no_response_action` 只能是 `escalate_only`，複查決定也不能選撤銷。
- 手動建立時把 `no_response_action` 設得比參數寬鬆（參數是 `revoke` 而選了 `escalate_only`）：這一輪標記為 `loosened`，建立的原因必填（本來就必填），建立時通知稽核角色，稽核事件帶規則代碼 `K-INT-REVIEW-NO-RESPONSE`，而且這一輪結束時列在稽核資料包的例外清單。
- 自動建立（`K-INT-REVIEW-SCHEDULE`）：參數 `review.interval_months` 大於 0 的流程類型，距離上一輪的開始時間滿這個月數時，排程建立新的一輪：範圍是全部，`reviewer_kind` 在 `uses_principal` 為是時取 `principal_owner`，否則取 `applicant_manager`；`no_response_action` 取參數值。
- 複查編號（`review_no`）的格式是 `AR-<西元年>-<四位流水號>`。

一輪複查的狀態：`scheduled`（尚未開始）、`open`（進行中）、`closed`（已結束）、`cancelled`（已取消）。

### 9.2 開始：產生複查工作

到了 `starts_at`，排程把範圍內所有 `grant.status = 'active'` 的授權各產生複查工作：

- `reviewer_kind` 是 `principal_owner` 或 `applicant_manager`：每筆授權一件工作。
- `reviewer_kind` 是 `role_holder` 而且角色帶範圍：每筆授權、每個不同的 `scope_ref` 各一件工作，工作只顯示該範圍的權限項目。

每件工作保存當時權限項目的快照與雜湊（`sgn_internal.review_snapshot`，算法見 12.4）。

**複查人的職責分離**（規則 `K-INT-REVIEW-SOD`）。複查人不得是下列任何一種人：

1. 這筆授權的申請人；
2. 權限項目的主體本人；
3. 主體是被授權者時，它的有效成員（以 `sgn_internal.subject_principals` 判定）。團隊的負責人如果自己也是成員，他實際上持有這些權限，不能自己確認自己的權限可以繼續保留。

這條規則適用於所有可能做決定的人：解析出來的複查人、他的代理人、升級後的主管、接手的系統管理員群組成員。檢查兩次：指派時，以及做決定時（指派之後才成為成員的人，決定時會被擋下，回 `review_item_not_reviewer`）。

解析出來的人違反時，改由他的直屬主管複查；主管也違反就再往上；找不到上一層時，工作不指定個人，由系統管理員群組中不違反這條規則的任何一位處理。改派的原因記在工作上並寫稽核事件。

**負責人的需求確認**（選用，不是決定）。負責人因為是成員而不能複查時，他仍然最清楚團隊還需不需要這些權限。所以被授權者的負責人可以在工作還是 `pending` 時，以 `access_review_item_attest` 填一筆「仍需要／不再需要」與說明。這筆確認與複查決定分開記錄、各自寫稽核事件，顯示給複查人參考；它不會讓工作結束，複查人也可以做出不同的決定。

需要更高的獨立性時，選 `role_holder` 讓擁有者複查。

範圍內沒有任何授權時，這一輪直接結束，結果是 0 件。

### 9.3 複查決定

規則 `K-INT-REVIEW-DECIDE`。可以做決定的人：工作的複查人、他目前有效的代理人（適用 `K-DELEGATE`，代理人同樣受 `K-INT-REVIEW-SOD` 限制，紀錄寫明誰代誰）。用手機做決定時適用 `K-MOBILE-MFA`。

做決定時要帶上畫面顯示的權限項目雜湊。它與目前的實際內容不同時（授權在這期間改變了），回 409（`review_item_changed`），複查人要重新看過再決定。這與 `K-VERSION-BOUND` 是同一個原則：決定綁定當時看到的內容。

| 決定 | 必填 | 結果 |
|---|---|---|
| `maintain`（維持） | 見下 | 授權不變。可以批次處理多件，每件各留一筆紀錄 |
| `reduce`（縮小） | 說明，以及結構化的縮小內容 `reduce_spec` | 通知被授權者的負責人與申請人，在 `review.reduce_followup_workdays` 個工作天內照 `reduce_spec` 把授權縮小（走核心的縮小流程）。追蹤見下（`K-INT-REVIEW-REDUCE`） |
| `revoke`（撤銷） | 原因 | 立即撤銷整筆授權（`K-INT-REVIEW-REVOKE`），走核心唯一的撤銷入口，之後的事件、通知、執行系統的處理都與一般撤銷相同 |

`maintain` 什麼時候要填說明：參數 `review.maintain_note_required`（可依流程類型、級別設定）為 true，或這筆授權的起始日距今超過 `review.maintain_note_after_months` 個月（0 表示不啟用）。需要說明的工作，沒有說明時回 `review_note_required`；批次處理時，同一段說明套用到整批，整批中只要有一件需要說明而沒有給，整批失敗。

`reduce_spec` 的結構：

```json
{
  "items": [
    {"entitlement_id": "8812", "remove": true},
    {"entitlement_id": "8813", "remove_actions": ["export"]},
    {"entitlement_id": "8814", "tighten": "列條件只保留北區"}
  ]
}
```

- `items` 至少一個元素。每個元素的 `entitlement_id` 必須在這件工作的快照裡，而且恰好帶 `remove`（整筆拿掉）、`remove_actions`（拿掉這些動作；必須是該項目現有動作的非空子集，而且不是全部）、`tighten`（限制條件要改得更嚴；值是 1 到 500 個字元的說明）三者之一。不合格回 `review_reduce_spec_invalid`。

縮小之後的追蹤（`followup_status`）：

1. 決定之後是 `pending`，期限 `followup_due_at`。同時把這個期限寫進該授權各權限項目的 `revoke_risk_at`（判定的快取時間不會超過它，見 5.5）。
2. 這張申請單每一次投影之後（12.5），逐項核對 `reduce_spec`：`remove` 的那一筆已經結束；`remove_actions` 列出的動作都不在該筆的 `actions` 裡（或該筆已結束）；`tighten` 的那一筆的限制條件雜湊與快照不同（或該筆已結束）。
3. 全部符合，而且沒有 `tighten` 的元素：追蹤改為 `done`。只移除一個無關的欄位或動作不會通過核對。
4. 全部符合，而且有 `tighten` 的元素：限制條件「有改」不代表「改得對」，所以追蹤改為 `pending_confirmation`，通知原本做決定的人看前後差異，以 `access_review_followup_confirm` 確認。確認符合 → `done`；不符合 → 回到 `pending`，期限不變。原本做決定的人已不在職，或現在違反 `K-INT-REVIEW-SOD` 時，由他的直屬主管確認（同樣套用 `K-INT-REVIEW-SOD`）。
5. 整筆授權結束（撤銷、到期）：追蹤改為 `done`。
6. 到了 `followup_due_at` 仍不是 `done`（包含還在 `pending_confirmation`）：自動撤銷該授權，追蹤改為 `overdue_revoked`，稽核事件的規則代碼是 `K-INT-REVIEW-REDUCE`。期限前 `review.remind_before_days` 天提醒負責人、申請人與待確認的人各一次。

已經決定的工作不能再改。授權在決定之前就到期或被撤銷的，工作改為 `not_applicable`。

### 9.4 不回應的處理

規則 `K-INT-REVIEW-NO-RESPONSE`：

1. 期限前 `review.remind_before_days` 天：提醒一次。
2. 到期仍未決定：工作升級給複查人的直屬主管（重新套用 `K-INT-REVIEW-SOD`），原複查人不能再決定；新的期限是原期限加 `review.escalation_workdays` 個工作天。
3. 升級後仍未決定：
   - `no_response_action = revoke`：自動撤銷該授權，工作狀態 `auto_revoked`。稽核事件的 actor 是系統，規則代碼 `K-INT-REVIEW-NO-RESPONSE`。
   - `no_response_action = escalate_only`：工作狀態 `unanswered`，通知稽核角色與系統管理員，並列在複查結果的例外清單。

預設是撤銷，與資料授權的原則「一律從嚴」「沒人負責就失效」一致。

### 9.5 複查工作的狀態

| 狀態 | 意義 |
|---|---|
| `pending` | 等待決定 |
| `decided` | 已決定（`maintain`、`reduce`、`revoke`） |
| `auto_revoked` | 不回應，已自動撤銷 |
| `unanswered` | 不回應，只升級不撤銷 |
| `not_applicable` | 決定前授權已結束 |
| `cancelled` | 這一輪複查被取消時還沒有決定 |

`reduce` 的後續追蹤（`followup_status`）：`none`、`pending`、`pending_confirmation`、`done`、`overdue_revoked`。

### 9.6 結束、取消與證據

所有工作都不是 `pending` 時，這一輪改為 `closed`，並寫一筆稽核事件（動作 `review.campaign_closed`），內容：

```json
{
  "review_no": "AR-2026-0003",
  "summary": {
    "total": 42, "maintain": 35, "reduce": 2, "revoke": 3,
    "auto_revoked": 1, "unanswered": 0, "not_applicable": 1, "cancelled": 0,
    "reassigned_for_sod": 4, "escalated": 2
  },
  "result_sha256": "5c1f…"
}
```

`result_sha256` 的算法（`decided_at` 依 3.7「用來算雜湊的時間」的格式，沒有值時是 JSON 的 null）：

```sql
select digest(coalesce(string_agg(
           jsonb_build_object(
               'item_id', id,
               'grant_id', grant_id,
               'scope_ref', scope_ref,
               'reviewer', reviewer_person_id,
               'status', status::text,
               'decision', decision::text,
               'decided_by', decided_by,
               'decided_on_behalf_of', decided_on_behalf_of,
               'decided_at', to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'snapshot_sha256', encode(snapshot_sha256, 'hex')
           )::text, E'\n' order by id), ''), 'sha256')
  from sgn.access_review_item
 where campaign_id = p_campaign_id;
```

**取消**（規則 `K-INT-REVIEW-CANCEL`）。取消一輪進行中的複查，會讓還沒決定的工作不經過「不回應就撤銷」而直接消失，所以：

- `scheduled` 的複查（還沒產生工作）：一位系統管理員可以取消，必須填原因。
- `open` 的複查：必須走變更申請（4.9），提出人與覆核人都不得是範圍內任何一筆授權的申請人、主體本人、主體的有效成員或被授權者的負責人。
- 取消時已做的決定保留並照常生效（含縮小的後續追蹤）；還是 `pending` 的工作改為 `cancelled`，每一件各寫一筆稽核事件（帶授權與原複查人），並列入稽核資料包的例外清單；通知稽核角色。
- 取消的那一輪不算一次完成的複查：`K-INT-REVIEW-SCHEDULE` 計算下一輪的時間時，以上一輪 `closed` 的複查為準。

成為證據的方式：

- 建立、開始、每一次改派、負責人的需求確認、每一個決定、每一次自動撤銷、後續追蹤的確認、完成或逾期、結束、取消：各一筆稽核事件，帶規則代碼。
- 稽核可以回答：有沒有定期複查（各輪的紀錄）；每筆授權由誰、何時、看著什麼內容、做了什麼決定；複查人是否獨立（改派紀錄）；不回應的怎麼處理；有沒有被取消或放寬（例外清單）。
- 其他系統（IGA、GRC）可以用 `GET /integration/v1/reviews/campaigns` 與 `GET /integration/v1/reviews/campaigns/{review_no}` 取得各輪的結果與每件工作的決定（scope `reviews.read`）。可見範圍的套用方式：
  - 只看得到流程類型在可見範圍內的複查。
  - 工作明細（`items`）只列「該授權至少有一筆權限項目對呼叫方可見」的工作。
  - `summary` 與 `result_sha256` 涵蓋整輪。呼叫方不是「整個流程類型可見」（4.5）時，這兩個欄位是 null，另帶 `"redacted": true`。

## 10. 證據輸出（`evidence`、`audit_feed`）

### 10.1 端點

| 用途 | 方法與路徑 | scope |
|---|---|---|
| 稽核事件（游標分頁） | `GET /integration/v1/audit/events` | `audit.read` 或 `audit.read_all` |
| 整合介面的呼叫紀錄（游標分頁） | `GET /integration/v1/audit/calls` | `audit.read_all` |
| 雜湊鏈骨架（只有序號與雜湊） | `GET /integration/v1/evidence/chain` | `evidence.read` |
| 鏈頭 | `GET /integration/v1/evidence/chain-head` | `evidence.read` |
| 檢查點清單 | `GET /integration/v1/evidence/checkpoints` | `evidence.read` |
| 單一檢查點 | `GET /integration/v1/evidence/checkpoints/{checkpoint_id}` | `evidence.read` |
| 公開金鑰 | `GET /integration/v1/jwks.json` | 不需驗證 |

### 10.2 稽核事件的原生格式

```http
GET /integration/v1/audit/events?after=20417&limit=500 HTTP/1.1
Authorization: Bearer sgn_at_TRVmodff...
```

有 `audit.read_all` 的呼叫方看到的內容：

```json
{
  "items": [
    {
      "seq": 20418,
      "time": "2026-11-19T02:15:00Z",
      "action": "grant.revoked",
      "actor": {"type": "person", "id": "p07", "properties": {"provider": "ldap"}},
      "actor_role": "principal_owner",
      "on_behalf_of": null,
      "case_no": "DA-2026-0004",
      "process_type": "data_access",
      "rule_code": "K-REVOKE",
      "policy_version": 3,
      "settings": {},
      "changes": {"reason": "專案提前結束"},
      "ip": "10.20.3.44",
      "device": "desktop",
      "mfa": false,
      "prev_hash": "a41c…",
      "hash": "7be2…",
      "canonical": "…",
      "redacted": false
    }
  ],
  "next_cursor": "20418",
  "has_more": false
}
```

只有 `audit.read` 的呼叫方，同一筆事件是：

```json
{
  "seq": 20418,
  "time": "2026-11-19T02:15:00Z",
  "action": "grant.revoked",
  "actor": {"type": "person", "id": "p07", "properties": {"provider": "ldap"}},
  "actor_role": "principal_owner",
  "on_behalf_of": null,
  "case_no": "DA-2026-0004",
  "process_type": "data_access",
  "rule_code": "K-REVOKE",
  "policy_version": 3,
  "settings": null,
  "changes": {},
  "ip": null,
  "device": "desktop",
  "mfa": false,
  "prev_hash": "a41c…",
  "hash": "7be2…",
  "canonical": null,
  "redacted": true
}
```

| 參數 | 說明 |
|---|---|
| `after` | 游標（上一次的 `next_cursor`）。省略時從第一筆開始 |
| `limit` | 預設 `integration.page_size_default`，上限 `evidence.audit_page_size_max` |
| `case_no` | 只要某一張申請單的事件 |
| `format` | `native`（預設）或 `ocsf`（見 10.3） |

規則：

- 欄位直接對應 `sgn.audit_event`（骨幹第 2 節）。`action` 的代碼由核心與流程包定義；上例的值只是示意。
- `actor` 是人時用呼叫方的身分來源表示（沒有對應時用 3.2 的代號）；系統自動執行的是 `{"type": "system"}`；由其他系統觸發的是 `{"type": "api_client", "id": "<代碼>"}`。
- `canonical` 是計算這一筆雜湊時實際使用的文字，由核心提供。有了它，驗證的人不需要自己重做欄位的正規化。
- **`audit.read_all`**：全部事件，完整內容。兩個 scope 都有時以它為準。
- **`audit.read`**（`K-INT-VISIBILITY`）：
  - 只回傳「有申請單，而且那張申請單對呼叫方可見」的事件。申請單可見的定義在 4.5：它至少有一筆權限項目（不論狀態）通過 `client_can_see`。所以可見範圍限制在某個資源前綴的系統，讀不到同一流程類型下其他資源的申請單事件；沒有任何權限項目的申請單（例如還在簽核中就被駁回的）也讀不到。
  - 內容一律遮蔽：`changes` 只保留資料表 `sgn.audit_export_key` 列出的鍵（依稽核動作代碼登記，只允許規則代碼、狀態前後值這類不含自由文字的鍵；沒有登記的動作，`changes` 是 `{}`）；`settings`、`ip`、`canonical` 一律是 null。有任何內容被拿掉時 `redacted` 是 true。撤銷原因、複查說明、簽核意見這類自由文字可能含有申請內容與個人資料，不會出現。
  - 不輸出 `canonical`，所以這類呼叫方不能自己重算每一筆的雜湊；它們用 `evidence/chain` 的骨架驗證鏈的連續性與檢查點（10.5）。
  - 流程類型宣告內容保密（待納入的增修 A3）的申請單，事件只給 `audit.read_all`。
- 事件在 `audit.retention_years` 年內可讀。超過保存年限的區段被清除之後怎麼驗證，見 10.5。

`sgn.audit_export_key` 的內容在核心的稽核動作代碼與 `changes` 的鍵定案後，由本模組的 migration 填入；每一列都要經過審查，確認該鍵不會帶出自由文字。

### 10.3 給 SIEM 的格式：OCSF 1.9.0

`format=ocsf` 時，`items` 的每一筆是一個 OCSF 事件。對應規則在資料表 `sgn.audit_ocsf_map`（稽核動作代碼 → 類別與活動），沒有列在表裡的動作一律對應到 Entity Management 的 Other。

| 稽核動作 | OCSF 類別 | `activity_id` | `type_uid` |
|---|---|---|---|
| 授權生效 | 3005 User Access Management | 1 Assign Privileges | 300501 |
| 授權到期、撤銷 | 3005 User Access Management | 2 Revoke Privileges | 300502 |
| 申請單建立 | 3004 Entity Management | 1 Create | 300401 |
| 申請單內容或狀態改變、簽核決定 | 3004 Entity Management | 3 Update | 300403 |
| 其他 | 3004 Entity Management | 99 Other | 300499 |

對應表的實際動作代碼，在核心的動作代碼定案後由本模組的 migration 填入。

```json
{
  "class_uid": 3005,
  "category_uid": 3,
  "activity_id": 2,
  "type_uid": 300502,
  "severity_id": 1,
  "time": 1795054500000,
  "message": "grant.revoked DA-2026-0004",
  "status_id": 1,
  "metadata": {
    "version": "1.9.0",
    "product": {"name": "sgn", "vendor_name": "sgn"},
    "uid": "20418",
    "sequence": 20418,
    "event_code": "grant.revoked",
    "log_name": "sgn.audit_event"
  },
  "actor": {"user": {"uid": "p07", "type_id": 1, "type": "User"}},
  "src_endpoint": {"ip": "10.20.3.44"},
  "user": {"uid": "channel-sales", "type_id": 99, "type": "team"},
  "privileges": ["read"],
  "resources": [
    {"uid": "sales_order.amount", "type": "data_field"},
    {"uid": "sales_order.order_date", "type": "data_field"}
  ],
  "unmapped": {
    "case_no": "DA-2026-0004",
    "process_type": "data_access",
    "rule_code": "K-REVOKE",
    "device": "desktop",
    "mfa": false,
    "prev_hash": "a41c…",
    "hash": "7be2…"
  }
}
```

欄位對應：

| OCSF 屬性 | 來源 |
|---|---|
| `time` | 稽核事件的時間，毫秒的 UTC epoch |
| `metadata.version` | 固定 `"1.9.0"` |
| `metadata.product.name` | 固定 `"sgn"` |
| `metadata.uid`、`metadata.sequence` | 稽核事件的序號 |
| `metadata.event_code` | 稽核動作代碼 |
| `severity_id` | 對應表的值；預設 1（Informational） |
| `status_id` | 固定 1（Success）。稽核事件只記錄已發生的事 |
| `actor`（actor 是人） | `actor.user = {"uid": 外部識別碼, "type_id": 1, "type": "User"}` |
| `actor`（actor 是其他系統） | `actor.app_name` 與 `actor.app_uid` 都是該 `api_client` 的代碼；不輸出 `actor.user` |
| `actor`（系統自動執行） | `actor.app_name = "sgn"`、`actor.app_uid = "sgn"` |
| `src_endpoint.ip` | 稽核事件的來源 IP。沒有 IP（系統自動執行）或呼叫方只有 `audit.read` 時，不輸出 `src_endpoint` |
| `user`（3005） | 這張申請單權限項目的主體。主體是人：`{"uid": 外部識別碼, "type_id": 1, "type": "User"}`。主體是被授權者：`{"uid": 外部識別碼, "type_id": 99, "type": "team" \| "project" \| "agent"}`（OCSF 規定 `type` 是 `type_id` 的名稱；自訂的種類用 99 Other 加上自己的名稱） |
| `privileges`（3005） | 這張申請單所有權限項目的動作（去重） |
| `resources`（3005） | 這張申請單的權限項目：`uid` 是 `resource_id`，`type` 是 `resource_type`。只列呼叫方可見的 |
| `entity`（3004） | `{"uid": 申請單號或被改變物件的 id, "type": "case" 或物件種類}` |
| `unmapped` | 申請單號、流程類型、規則代碼、裝置、MFA、前後雜湊，以及 `changes`（只有 `audit.read` 的呼叫方拿到的是 10.2 遮蔽後的 `changes`） |

原生格式是完整的來源；OCSF 格式是為了讓 SIEM 不用寫對應規則就能收進來。兩者的游標相同，可以互換。

**呼叫紀錄**。判定的紀錄（誰問了什麼、被拒絕幾次）只存在 `sgn.api_call_log`，偵測探測行為需要它，所以另外提供 `GET /integration/v1/audit/calls`（scope `audit.read_all`；參數 `after`、`limit`、`format`，規則同 10.2）。

原生格式的每一筆：

```json
{
  "call_id": "918273",
  "called_at": "2026-11-19T02:15:00Z",
  "client": "bi-portal",
  "function": "integration_check",
  "http_status": 200,
  "error_code": null,
  "internal_reason": null,
  "request_id": "bfe9eb29-ab87-4ca3-be83-a1d5d8305716",
  "ip": "10.30.1.15",
  "duration_ms": 12,
  "item_count": 1,
  "summary": {
    "evaluations": [
      {
        "subject": {"type": "person", "id": "p08", "properties": {"provider": "ldap"}},
        "action": "read",
        "resource": {"type": "data_field", "id": "sales_order.amount"},
        "decision": true,
        "reason": "granted",
        "basis": ["8812"],
        "context_sha256": "c0a1…"
      }
    ]
  }
}
```

`summary` 裡的主體在資料庫以內部 id 保存，輸出時依呼叫方的身分來源表示。沒有通過驗證的呼叫，`client` 是 null。

`format=ocsf` 時對應到 6003 API Activity（`category_uid` 6）：

| OCSF 屬性 | 來源 |
|---|---|
| `class_uid`、`category_uid` | 6003、6 |
| `activity_id` | 依 function：判定、查詢、列表是 2（Read）；建立訂閱、建立批次、上傳項目、回報用量是 1（Create）；修改訂閱、輪替密鑰、宣告完成是 3（Update）；刪除訂閱是 4（Delete）；換發 token 與其他是 99（Other）。對應寫在 `sgn.api_function_scope` 的欄位 `ocsf_activity_id` |
| `type_uid` | `600300 + activity_id` |
| `time` | `called_at`，毫秒的 UTC epoch |
| `severity_id` | HTTP 狀態小於 400 是 1；401、403、429 是 3（Medium）；其他是 2（Low） |
| `status_id` | HTTP 狀態小於 400 是 1（Success），否則 2（Failure）；`status_code` 是 HTTP 狀態的文字，`status_detail` 是 `error_code` |
| `actor` | `actor.app_name` 與 `actor.app_uid` 是 `api_client` 的代碼；沒有通過驗證時兩者都是 `"unauthenticated"` |
| `api` | `{"operation": function 名稱, "request": {"uid": request_id}, "response": {"code": HTTP 狀態}}` |
| `src_endpoint.ip` | 來源 IP |
| `metadata` | `version`、`product` 同上；`uid` 是呼叫紀錄的 id；`log_name` 是 `"sgn.api_call_log"` |
| `unmapped` | `duration_ms`、`item_count`、`internal_reason`、`summary` |

這兩種 OCSF 對應在導入前要對實際接收的 SIEM 產品驗證一次（見 1.1 最後一段）。OCSF 的 `cloud`、`osint` 等屬性屬於特定 profile，本平台不宣告這些 profile，所以不輸出。

### 10.4 鏈頭與檢查點

雜湊鏈本身由核心維護（`K-AUDIT-CHAIN`）。本模組在它上面加三樣東西，讓不信任本平台的第三方也能驗證紀錄沒有被改過。

**鏈頭**：目前最後一筆稽核事件的序號與雜湊。

```json
{"seq": 20418, "hash": "7be2…", "time": "2026-11-19T02:15:00Z", "latest_checkpoint_id": "312"}
```

**檢查點**（規則 `K-INT-CHECKPOINT`）：排程每隔 `evidence.checkpoint_interval_minutes` 分鐘，在鏈頭有前進時記下當時的鏈頭，並指向前一個檢查點。後端用平台的簽章金鑰簽章。

```json
{
  "checkpoint_id": "312",
  "audit_seq": 20400,
  "audit_hash": "19d0…",
  "event_count": 57,
  "previous": {"checkpoint_id": "311", "audit_seq": 20343, "audit_hash": "c7aa…"},
  "created_at": "2026-11-19T02:00:00Z",
  "payload": "{\"iss\": \"https://sgn.example.com/integration/v1\", \"audit_seq\": 20400, \"audit_hash\": \"19d0…\", \"created_at\": \"2026-11-19T02:00:00Z\", \"event_count\": 57, \"checkpoint_id\": 312, \"previous_audit_seq\": 20343, \"previous_audit_hash\": \"c7aa…\"}",
  "signature_jws": "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoic2duLTIwMjYtMDEiLCJ0eXAiOiJzZ24tY2hlY2twb2ludCtqd3MifQ.…",
  "signing_key_id": "sgn-2026-01",
  "signed_at": "2026-11-19T02:00:02Z",
  "tsa_token": null
}
```

- `event_count` 是**實際數出來的筆數**：`select count(*) from sgn.audit_event where 序號 > 前一個檢查點的 audit_seq and 序號 <= 這個檢查點的 audit_seq`。它不是兩個序號相減；稽核事件的序號是否連續不跳號，由核心決定（附錄 A 第 6 項），本模組不依賴這一點。
- `payload` 是資料庫產生的 JSON 文字（`jsonb_build_object(...)::text`）。簽章簽的是這段文字的位元組，不做任何正規化；驗證的人從 JWS 裡取出內容即可。
- `signature_jws` 是 JWS compact 格式：標頭 `{"alg": "Ed25519", "kid": "<金鑰代號>", "typ": "sgn-checkpoint+jws"}`，內容是 `payload`。
- `tsa_token`：有設定時間戳記服務時，是對 `signature_jws` 的位元組做 SHA-256 後取得的 RFC 3161 時間戳記（DER，以 base64 表示）；沒有設定就是 null。
- 簽完之後發出 `sgn.evidence.checkpoint` 事件，訂閱的 SIEM、GRC 系統會收到並保存在自己那邊。
- `evidence.checkpoint_mail_enabled` 為 true 時，排程每天把最新的已簽章檢查點寄給稽核角色的每一位持有人。
- 檢查點不寫進稽核鏈（否則每個檢查點都會讓鏈頭前進，產生下一個檢查點）。檢查點表本身只增不改。
- 呼叫紀錄的封存排在檢查點之前（4.7），所以每個檢查點都涵蓋在它之前封存的呼叫紀錄。

**簽章停擺的警示**（規則 `K-INT-CHECKPOINT-STALE`）。檢查點靠後端的 worker 簽章並送出；worker 停掉時，鏈頭繼續前進，卻沒有新的檢查點到平台以外。排程每一輪檢查：鏈頭的序號大於最新一個**已簽章**檢查點的 `audit_seq`，而且那個檢查點的 `signed_at`（沒有任何已簽章檢查點時，取第一筆稽核事件的時間）距今超過 `evidence.checkpoint_stale_intervals` 個檢查點間隔。成立時：通知稽核角色與系統管理員，寫一筆稽核事件（動作 `evidence.checkpoint_stale`，內容是未被涵蓋的事件數與時間長度），並顯示在整合狀態。同一次停擺每 24 小時提醒一次，恢復簽章時再寫一筆稽核事件（動作 `evidence.checkpoint_resumed`）。

**公開金鑰**：

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "kid": "sgn-2026-01",
      "use": "sig",
      "alg": "Ed25519",
      "x": "uWKK13PfwqyOgrqT0OrWKcS2uVD7e89-oUKnkoPjx7w",
      "sgn_whpk": "whpk_uWKK13PfwqyOgrqT0OrWKcS2uVD7e89+oUKnkoPjx7w="
    }
  ]
}
```

金鑰由後端從部署設定讀取，資料庫不保存私鑰。設定可以列多把：第一把用來簽章，全部都發布。換金鑰時先把新的加在後面（先發布），下一次部署再移到第一把；舊的公鑰不移除，才能驗證以前的檢查點。`sgn_whpk` 是同一把公鑰以 Standard Webhooks 的格式表示，給 webhook 的 `v2a` 驗證用。

### 10.5 第三方怎麼驗證

驗證的人需要三樣東西，都可以在不信任平台的前提下取得或保存：

| 東西 | 來源 |
|---|---|
| 一個或多個**過去保存在平台以外**的檢查點 | SIEM 或 GRC 收到的 `sgn.evidence.checkpoint` 事件、稽核人員信箱裡的每日檢查點信件、或帶有外部時間戳記的檢查點 |
| 平台當時的公開金鑰 | 當時從 `jwks.json` 取得並自行保存 |
| 現在匯出的稽核事件 | `GET /integration/v1/audit/events`（或只取 `GET /integration/v1/evidence/chain` 的骨架） |

驗證步驟（獨立工具 `tools/verify-audit-chain`，不連線到平台，只讀匯出的檔案）：

1. 驗檢查點的簽章：用自己保存的公鑰驗 `signature_jws`。有 `tsa_token` 時，用時間戳記服務的憑證驗它，確認檢查點在那個時間之前就存在。
2. 驗鏈的連續性：匯出的事件依序號排列，每一筆的 `prev_hash` 等於前一筆的 `hash`。連續性只看雜湊的連結，不要求序號是連續的整數。
3. 驗每一筆的內容：依核心定義的雜湊公式，用 `prev_hash` 與 `canonical` 重算，結果等於 `hash`；並確認 `canonical` 的內容與該筆顯示的欄位一致。
4. 對上檢查點：匯出的事件中，序號等於檢查點 `audit_seq` 的那一筆，它的 `hash` 等於檢查點的 `audit_hash`。每個保存的檢查點都要對得上。
5. 驗檢查點之間的連結：後一個檢查點的 `previous_audit_seq`、`previous_audit_hash` 等於前一個檢查點的值；兩個相鄰檢查點之間匯出的事件筆數等於後一個檢查點的 `event_count`（少了代表有事件被刪除，而且刪除的人同時改了後面每一筆的雜湊，這會在步驟 4 被抓到；筆數是第二道確認）。
6. 起點：沒有被清除過的鏈，從第一筆事件開始驗。超過 `audit.retention_years` 的區段被清除之後，以「清除前最後一個檢查點」作為起點：清除動作本身是一筆稽核事件（由核心寫入），內容帶被清除區段的首尾序號與首尾雜湊；驗證工具確認這筆事件記載的尾端雜湊等於起點檢查點的 `audit_hash`，然後從起點之後的第一筆事件開始做步驟 2 到 5。
7. 輸出警告：最後一個外部檢查點之後還有多少筆事件、涵蓋多長的時間。這一段還沒有被平台以外保存的檢查點涵蓋。超過兩個檢查點間隔時，工具以醒目的方式標示（代表簽章或送出可能停擺過）。

能偵測與不能偵測的範圍，照實說明：

| 情況 | 結果 |
|---|---|
| 修改、刪除、插入任何一筆已被外部檢查點涵蓋的事件 | 步驟 3、4 或 5 失敗 |
| 平台方重寫整條鏈並重新簽出一套新的檢查點 | 與第三方手上既有的檢查點對不上（步驟 4）。有外部時間戳記時，新檢查點也無法取得過去的時間 |
| 只有 `audit.read` 的呼叫方（看不到全部事件，也拿不到 `canonical`） | 用 `evidence/chain` 的骨架做步驟 2、4、5；不能做步驟 3 |
| 最後一個外部檢查點之後、下一個檢查點之前的事件 | 尚未被外部保存的檢查點涵蓋。這段空窗正常時最長是一個檢查點間隔（預設 60 分鐘）；簽章停擺時會變長，由 `K-INT-CHECKPOINT-STALE` 通知稽核，驗證工具也會警告（步驟 7） |
| 尚未封存的呼叫紀錄被有資料表擁有者權限的人刪改 | 無法偵測。空窗最長是一個檢查點間隔加一輪排程（4.7） |
| 事件在寫入當下就是假的 | 雜湊鏈無法偵測；這要靠職責分離、對帳與複查 |

雜湊公式與 `canonical` 的定義屬於核心（見附錄 A 第 6 項）。本文件保證的是：匯出的欄位足以重算，而且檢查點會持續送到平台以外。

## 11. 資料表（schema `sgn`）

共 29 張表。所有時間欄位由 function 以 ⟨`sgn_internal.now()`⟩ 寫入，不用欄位預設值，假時鐘才能生效。`sgn_app` 對這些表沒有任何權限。

### 11.1 列舉型別

```sql
create type sgn.subject_kind              as enum ('person', 'principal');
create type sgn.api_client_status         as enum ('active', 'suspended', 'disabled');
create type sgn.constraint_mode           as enum ('strict', 'advisory');
create type sgn.token_binding             as enum ('ip', 'cidr');
create type sgn.entitlement_status        as enum ('pending', 'active', 'ended');
create type sgn.entitlement_phase         as enum ('active', 'fulfilment');
create type sgn.entitlement_end_reason    as enum ('expired', 'revoked', 'consumed', 'completed', 'cancelled', 'removed', 'subject_inactive');
create type sgn.webhook_status            as enum ('pending_verification', 'enabled', 'paused', 'disabled');
create type sgn.reconciliation_run_status as enum ('collecting', 'comparing', 'completed', 'needs_review', 'discarded', 'abandoned');
create type sgn.reconciliation_run_origin as enum ('api', 'upload');
create type sgn.reconciliation_item_result as enum ('covered', 'tolerated', 'exceeds_approved', 'ended_still_present', 'unapproved');
create type sgn.finding_kind              as enum ('unapproved', 'ended_still_present', 'exceeds_approved', 'missing', 'run_anomalous');
create type sgn.finding_severity          as enum ('high', 'low');
create type sgn.finding_status            as enum ('open', 'acknowledged', 'pending_verification', 'resolved', 'dismissed');
create type sgn.review_campaign_status    as enum ('scheduled', 'open', 'closed', 'cancelled');
create type sgn.review_reviewer_kind      as enum ('principal_owner', 'applicant_manager', 'role_holder');
create type sgn.review_no_response_action as enum ('revoke', 'escalate_only');
create type sgn.review_item_status        as enum ('pending', 'decided', 'auto_revoked', 'unanswered', 'not_applicable', 'cancelled');
create type sgn.review_decision           as enum ('maintain', 'reduce', 'revoke');
create type sgn.review_followup_status    as enum ('none', 'pending', 'pending_confirmation', 'done', 'overdue_revoked');
create type sgn.change_request_kind       as enum ('api_client_create', 'api_client_update', 'api_client_credential_create',
                                                   'principal_identity_set', 'principal_identity_remove',
                                                   'access_review_campaign_cancel');
create type sgn.change_request_status     as enum ('pending', 'approved', 'rejected', 'withdrawn', 'expired');
```

### 11.2 主體識別

```sql
create table sgn.principal_identity (
    id            bigint generated always as identity primary key,
    principal_id  bigint not null references sgn.principal (id),
    provider      text   not null check (provider ~ '^[a-z][a-z0-9_]{0,31}$' and provider not in ('sgn', 'sgn_anon')),
    external_id   text   not null check (length(external_id) between 1 and 256 and external_id !~ '[[:cntrl:]]'),
    source        text   not null check (source in ('sync', 'change_request')),
    change_request_id bigint,                                      -- source = 'change_request' 時必填；外鍵在 11.10 建立後補上
    created_at    timestamptz not null,
    updated_at    timestamptz not null,
    unique (provider, external_id),
    unique (principal_id, provider),
    check ((source = 'change_request') = (change_request_id is not null))
);
```

這張表只能由 `sgn_internal.set_principal_identity` 與 `sgn_internal.remove_principal_identity` 寫入（12.2）；新舊值的歷程在稽核事件裡。

### 11.3 系統身分

```sql
create table sgn.api_scope (
    code         text primary key check (code ~ '^[a-z][a-z0-9_.]{0,47}$'),
    description  text not null
);

create table sgn.api_function_scope (
    function_name     text primary key,                           -- schema api 內的 function 名稱
    scope_code        text not null references sgn.api_scope (code),
    ocsf_activity_id  integer not null check (ocsf_activity_id in (1, 2, 3, 4, 99))   -- 10.3 的呼叫紀錄對應；沒有列在這張表的 function 一律 99
);

create table sgn.api_client (
    id                       bigint generated always as identity primary key,
    code                     text   not null unique check (code ~ '^[a-z][a-z0-9-]{2,47}$'),
    name                     text   not null check (length(name) between 1 and 100),
    description              text   not null default '',
    owner_person_id          bigint not null references sgn.person (id),
    identity_provider        text   not null check (identity_provider ~ '^[a-z][a-z0-9_]{0,31}$' and identity_provider <> 'sgn_anon'),
    allowed_providers        text[] not null,                     -- 一定包含 identity_provider
    provider_sgn_reason      text,                                -- allowed_providers 含 'sgn' 時必填
    scopes                   text[] not null default '{}',
    constraint_mode          sgn.constraint_mode not null default 'strict',
    constraint_mode_reason   text,                                -- advisory 時必填
    allowed_source_cidrs     cidr[] not null check (cardinality(allowed_source_cidrs) >= 1),
    source_any_reason        text,                                -- 清單含 0.0.0.0/0 或 ::/0 時必填
    token_binding            sgn.token_binding not null default 'ip',
    allowed_webhook_origins  text[] not null default '{}',
    upload_enabled           boolean not null default false,
    sync_epoch               integer not null default 1,
    subject_salt             bytea  not null check (octet_length(subject_salt) = 16),   -- 建立時 gen_random_bytes(16)，不可修改
    status                   sgn.api_client_status not null default 'active',
    status_reason            text,
    status_changed_at        timestamptz not null,
    owner_grace_until        timestamptz,                         -- 負責人不在職時的寬限期限；正常時為 null
    auth_alerted_at          timestamptz,                         -- 最近一次驗證失敗示警的時間
    error_alerted_at         timestamptz,                         -- 最近一次失敗上限示警的時間
    created_by               bigint not null references sgn.person (id),   -- 變更申請的提出人
    approved_by              bigint not null references sgn.person (id),   -- 變更申請的覆核人
    created_at               timestamptz not null,
    updated_at               timestamptz not null,
    check (identity_provider = any (allowed_providers)),
    check (not ('sgn' = any (allowed_providers)) or provider_sgn_reason is not null),
    check (constraint_mode = 'strict' or constraint_mode_reason is not null),
    check (created_by <> approved_by)
);

create table sgn.api_client_visibility (
    id                  bigint generated always as identity primary key,
    api_client_id       bigint not null references sgn.api_client (id),
    process_type_id     bigint not null references sgn.process_type (id),
    resource_type       text   check (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
    resource_id_prefix  text   check (length(resource_id_prefix) between 1 and 512),
    check (resource_id_prefix is null or resource_type is not null),
    unique nulls not distinct (api_client_id, process_type_id, resource_type, resource_id_prefix)
);

create table sgn.api_client_credential (
    id                 bigint generated always as identity primary key,
    api_client_id      bigint not null references sgn.api_client (id),
    secret_sha256      bytea  unique check (octet_length(secret_sha256) = 32),   -- 領取之前為 null
    secret_hint        text   check (length(secret_hint) = 4),                   -- 密鑰最後 4 個字元
    change_request_id  bigint not null,                                          -- 外鍵在 11.10 建立後補上
    created_at         timestamptz not null,
    claim_expires_at   timestamptz not null,
    claimed_at         timestamptz,
    claimed_by         bigint references sgn.person (id),
    expires_at         timestamptz not null,
    revoked_at         timestamptz,
    revoked_by         bigint references sgn.person (id),                        -- 排程撤銷時為 null
    last_used_at       timestamptz,                                              -- 只在換發 token 時更新
    reminded_at        timestamptz,
    check ((secret_sha256 is null) = (claimed_at is null)),
    check ((secret_sha256 is null) = (secret_hint is null))
);
create index api_client_credential_client_idx on sgn.api_client_credential (api_client_id);

create table sgn.api_access_token (
    id                        bigint generated always as identity primary key,
    api_client_id             bigint not null references sgn.api_client (id),
    api_client_credential_id  bigint not null references sgn.api_client_credential (id),
    token_sha256              bytea  not null unique check (octet_length(token_sha256) = 32),
    scopes                    text[] not null,
    issued_at                 timestamptz not null,
    expires_at                timestamptz not null,
    issued_ip                 inet   not null
);
create index api_access_token_expires_idx on sgn.api_access_token (expires_at);

create table sgn.api_rate_counter (
    api_client_id  bigint not null references sgn.api_client (id),
    bucket         text   not null check (bucket in ('api', 'error', 'throttled', 'token', 'webhook_manage', 'recon_run')),
    window_start   timestamptz not null,                              -- 視窗起點：整分鐘；webhook_manage 是整點；recon_run 是 UTC 的零時
    hits           integer not null,
    primary key (api_client_id, bucket, window_start)
);

-- 驗證失敗的計數。鍵是雜湊，不引用 api_client：代碼存在與否的處理完全相同（4.3）
create table sgn.api_auth_failure_counter (
    key_kind      text   not null check (key_kind in ('client', 'ip')),
    key_sha256    bytea  not null check (octet_length(key_sha256) = 32),
    window_start  timestamptz not null,                               -- 整分鐘
    hits          integer not null,
    primary key (key_kind, key_sha256, window_start)
);

create table sgn.api_client_source_seen (
    api_client_id  bigint not null references sgn.api_client (id),
    ip             inet   not null,
    first_seen_at  timestamptz not null,
    last_seen_at   timestamptz not null,
    primary key (api_client_id, ip)
);

-- 每個系統每天（UTC）的統計，由 job_integration_client_hygiene 從呼叫紀錄彙整
create table sgn.api_client_daily_stat (
    api_client_id      bigint not null references sgn.api_client (id),
    day                date   not null,
    calls              integer not null default 0,
    errors             integer not null default 0,                    -- HTTP 狀態 400 以上
    evaluations        integer not null default 0,                    -- 判定的筆數
    no_entitlement     integer not null default 0,                    -- 其中 reason = no_entitlement 的筆數
    distinct_subjects  integer not null default 0,                    -- 判定與授權查詢中出現的不同主體數
    subjects_alerted_at timestamptz,
    primary key (api_client_id, day)
);
```

### 11.4 呼叫紀錄

```sql
create table sgn.api_call_log (
    id                   bigint generated always as identity primary key,
    called_at            timestamptz not null,
    api_client_id        bigint references sgn.api_client (id),       -- 驗證失敗時為 null
    api_access_token_id  bigint,
    request_id           text   not null check (request_id ~ '^[A-Za-z0-9._-]{1,64}$'),
    function_name        text   not null,
    http_status          integer not null,
    error_code           text,
    internal_reason      text,                                        -- 失敗的實際原因；不對沒有 audit.read_all 的呼叫方輸出
    duration_ms          integer,
    ip                   inet,
    item_count           integer,
    summary              jsonb  not null default '{}'::jsonb
);
create index api_call_log_called_idx on sgn.api_call_log (called_at);
create index api_call_log_client_idx on sgn.api_call_log (api_client_id, called_at);
create index api_call_log_request_idx on sgn.api_call_log (request_id);

-- 一列是一段連續的 id 範圍（4.7）
create table sgn.api_call_log_seal (
    id             bigint generated always as identity primary key,
    first_id       bigint not null unique,
    last_id        bigint not null,
    row_count      bigint,                                            -- 第二階段填入
    digest_sha256  bytea,                                             -- 第二階段填入
    marked_at      timestamptz not null,
    sealed_at      timestamptz,
    purged_at      timestamptz,
    check (last_id >= first_id),
    check ((digest_sha256 is null) = (sealed_at is null))
);
```

`api_call_log` 擋下 `UPDATE` 與 `TRUNCATE`。`DELETE` 只有在交易內設定了 `sgn.call_log_purge = 'on'` 時放行，而且只有 `sgn_internal.job_integration_call_log_seal` 會設定它；被刪除的列必須落在一段 `sealed_at` 有值的範圍裡。`api_call_log_seal` 擋下 `DELETE` 與 `TRUNCATE`；`UPDATE` 只允許把 `row_count`、`digest_sha256`、`sealed_at` 從 null 填成有值一次，以及填 `purged_at`。

### 11.5 權限項目、用量與事件

```sql
create table sgn.entitlement (
    id                    bigint generated always as identity primary key,
    case_id               bigint not null references sgn."case" (id),
    grant_id              bigint references sgn."grant" (id),
    process_type_id       bigint not null references sgn.process_type (id),
    subject_kind          sgn.subject_kind not null,
    subject_person_id     bigint references sgn.person (id),
    subject_principal_id  bigint references sgn.principal (id),
    resource_type         text   not null check (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
    resource_id           text   not null check (length(resource_id) between 1 and 512),
    actions               text[] not null check (cardinality(actions) >= 1),
    constraints           jsonb  not null default '{}'::jsonb check (jsonb_typeof(constraints) = 'object'),
    constraints_sha256    bytea  not null,                        -- digest(constraints::text, 'sha256')
    scope_ref             text,
    effective_during      sgn.entitlement_phase not null default 'active',
    status                sgn.entitlement_status not null,
    effective_from        timestamptz,
    effective_until       timestamptz,
    ended_at              timestamptz,
    end_reason            sgn.entitlement_end_reason,
    revoke_risk_at        timestamptz,                            -- 已知會被自動撤銷的最早時間（5.5）；沒有時為 null
    usage_count           integer not null default 0,             -- entitlement_usage 的筆數
    content_version_no    integer not null,                       -- 這筆項目來自申請單的哪一個內容版本
    revision              integer not null default 1,             -- 動作或限制條件每改一次加一
    sync_seq              bigint  not null,                       -- 最後一次改變它的事件序號
    created_at            timestamptz not null,
    updated_at            timestamptz not null,                   -- 動作、限制條件、scope_ref 最後一次改變的時間
    check ((subject_kind = 'person') = (subject_person_id is not null)),
    check ((subject_kind = 'principal') = (subject_principal_id is not null)),
    check ((status = 'ended') = (ended_at is not null)),
    check ((status = 'ended') = (end_reason is not null)),
    check (effective_during = 'active' or status <> 'active' or effective_until is not null)   -- 一次性許可一定有結束時間
);
create unique index entitlement_case_resource_uq
    on sgn.entitlement (case_id, resource_type, resource_id) where status <> 'ended';
create index entitlement_principal_idx
    on sgn.entitlement (subject_principal_id, resource_type, resource_id) where subject_principal_id is not null;
create index entitlement_person_idx
    on sgn.entitlement (subject_person_id, resource_type, resource_id) where subject_person_id is not null;
create index entitlement_resource_idx
    on sgn.entitlement (process_type_id, resource_type, resource_id text_pattern_ops);
create index entitlement_sync_idx   on sgn.entitlement (sync_seq, id);
create index entitlement_case_idx   on sgn.entitlement (case_id);
create index entitlement_grant_idx  on sgn.entitlement (grant_id) where grant_id is not null;
create index entitlement_expiry_idx on sgn.entitlement (effective_until) where status = 'active';

create table sgn.entitlement_usage (
    id               bigint generated always as identity primary key,
    entitlement_id   bigint not null references sgn.entitlement (id),
    api_client_id    bigint not null references sgn.api_client (id),
    usage_key        text   not null check (length(usage_key) between 1 and 128 and usage_key !~ '[[:cntrl:]]'),
    decision_id      text   check (decision_id ~ '^[0-9]+:[0-9]+$'),
    context          jsonb  not null check (jsonb_typeof(context) = 'object'),
    context_sha256   bytea  not null,
    quantity         integer not null check (quantity between 1 and 1000000),
    occurred_at      timestamptz not null,
    recorded_at      timestamptz not null,
    within_approval  boolean not null,
    unique (entitlement_id, usage_key)
);

create table sgn.integration_event_type (
    code            text primary key check (code ~ '^sgn\.[a-z_]+\.[a-z_]+$'),
    category        text not null check (category in ('grant', 'principal', 'person', 'client', 'reconciliation', 'review', 'evidence', 'webhook')),
    required_scope  text not null references sgn.api_scope (code),
    description     text not null
);

create sequence sgn.integration_event_seq;

create table sgn.integration_event (
    seq              bigint primary key,                          -- 取鎖後由 integration_event_seq 取得
    event_type       text   not null references sgn.integration_event_type (code),
    occurred_at      timestamptz not null,
    process_type_id  bigint references sgn.process_type (id),
    case_id          bigint references sgn."case" (id),
    grant_id         bigint references sgn."grant" (id),
    principal_id     bigint references sgn.principal (id),
    person_id        bigint references sgn.person (id),
    api_client_id    bigint references sgn.api_client (id),       -- 有值時只有這個呼叫方看得到
    ref_id           bigint,                                      -- 批次、發現、複查、檢查點的 id（依類型）
    rule_code        text,
    data             jsonb  not null
);
create index integration_event_case_idx on sgn.integration_event (case_id) where case_id is not null;
create index integration_event_type_idx on sgn.integration_event (event_type, seq);
```

`entitlement_usage` 與 `integration_event` 擋下 `UPDATE`、`DELETE`、`TRUNCATE`。

`integration_event.data` 以內部形式保存：主體是 `{"kind", "person_id", "principal_id"}`，權限項目包含該申請單的全部項目；對外輸出時由 `sgn_internal.render_integration_event` 依呼叫方轉換與過濾，CloudEvents 的 `subject` 也在這時依 7.2 產生（資料表不保存它，因為主體的識別碼因呼叫方而異）。`expiring` 事件的去重靠 `(case_id, event_type)` 的查詢：同一張單、同一個到期日只發一次（到期日記在 `data.expires_at`）。

### 11.6 webhook

```sql
create table sgn.webhook_subscription (
    id                           bigint generated always as identity primary key,
    endpoint_id                  text   not null unique check (endpoint_id ~ '^ep_[A-Za-z0-9]{24}$'),
    api_client_id                bigint not null references sgn.api_client (id),
    url                          text   not null check (length(url) between 1 and 2000),
    description                  text   not null default '',
    event_types                  text[] not null default '{}',     -- 空陣列＝可收到的全部類型
    status                       sgn.webhook_status not null default 'pending_verification',
    status_reason                text,
    resume_from                  text   check (resume_from in ('cursor', 'tail')),   -- 從 disabled 恢復、等 ping 成功時暫存
    secret_version               integer not null default 1,
    previous_secret_valid_until  timestamptz,                      -- 輪替重疊期；過了就只簽新的
    delivered_seq                bigint  not null,                 -- 已送達或已略過的最後事件序號
    ping_pending                 boolean not null default true,
    ping_count                   integer not null default 0,
    attempt_count                integer not null default 0,       -- 目前這個事件已失敗的次數
    next_attempt_at              timestamptz,
    lease_until                  timestamptz,                      -- worker 領取後的租約
    last_success_at              timestamptz,
    last_failure_at              timestamptz,
    created_at                   timestamptz not null,
    updated_at                   timestamptz not null,
    deleted_at                   timestamptz
);
create index webhook_subscription_client_idx on sgn.webhook_subscription (api_client_id) where deleted_at is null;
create index webhook_subscription_due_idx
    on sgn.webhook_subscription (next_attempt_at) where status in ('pending_verification', 'enabled') and deleted_at is null;

create table sgn.webhook_attempt (
    id               bigint generated always as identity primary key,
    subscription_id  bigint not null references sgn.webhook_subscription (id),
    webhook_id       text   not null,                              -- 送出的 webhook-id 標頭
    event_seq        bigint,                                       -- ping 為 null
    attempt_no       integer not null,
    attempted_at     timestamptz not null,
    http_status      integer,
    error_kind       text   check (error_kind in ('timeout', 'tls', 'connect', 'dns', 'blocked_address', 'http_status', 'other')),
    duration_ms      integer,
    succeeded        boolean not null,
    check (succeeded = (error_kind is null))
);
create index webhook_attempt_subscription_idx on sgn.webhook_attempt (subscription_id, attempted_at);
```

`webhook_attempt` 只增不改。它不保存對方回應的任何內容。

### 11.7 對帳

```sql
create table sgn.reconciliation_run (
    id                    bigint generated always as identity primary key,
    api_client_id         bigint not null references sgn.api_client (id),
    process_type_id       bigint not null references sgn.process_type (id),
    resource_type         text,
    resource_id_prefix    text,
    observed_at           timestamptz not null,
    origin                sgn.reconciliation_run_origin not null,
    uploaded_by           bigint references sgn.person (id),         -- origin = 'upload' 時必填
    file_sha256           bytea,                                     -- origin = 'upload' 時必填
    upload_note           text,
    status                sgn.reconciliation_run_status not null default 'collecting',
    compare_phase         text   check (compare_phase in ('items', 'count', 'open_items', 'open_missing', 'close', 'finalize')),
    compare_cursor        bigint not null default 0,                    -- 目前階段已處理到的 id；換階段時歸零
    anomaly_accepted      boolean not null default false,
    reviewed_by           bigint references sgn.person (id),
    reviewed_at           timestamptz,
    review_note           text,
    superseded_by_run_id  bigint references sgn.reconciliation_run (id),
    item_count            integer not null default 0,
    items_sha256          bytea,
    findings_sha256       bytea,
    summary               jsonb,
    created_at            timestamptz not null,
    completed_at          timestamptz,                               -- 比對完成的時間
    check (resource_id_prefix is null or resource_type is not null),
    check ((origin = 'upload') = (uploaded_by is not null)),
    check ((origin = 'upload') = (file_sha256 is not null))
);
create index reconciliation_run_client_idx on sgn.reconciliation_run (api_client_id, created_at);
create index reconciliation_run_status_idx on sgn.reconciliation_run (status) where status in ('collecting', 'comparing', 'needs_review');

create table sgn.reconciliation_item (
    id                       bigint generated always as identity primary key,
    run_id                   bigint not null references sgn.reconciliation_run (id),
    item_key                 text   not null check (length(item_key) between 1 and 256 and item_key !~ '[[:cntrl:]]'),
    subject_type             text   not null check (subject_type in ('person', 'principal')),
    subject_provider         text   not null,
    subject_external_id      text   not null check (length(subject_external_id) between 1 and 256 and subject_external_id !~ '[[:cntrl:]]'),
    subject_person_id        bigint references sgn.person (id),      -- 解析結果；解析不出來時兩者皆為 null
    subject_principal_id     bigint references sgn.principal (id),
    resource_type            text   not null,
    resource_id              text   not null,
    action                   text   not null,
    reported_entitlement_id  text   check (reported_entitlement_id ~ '^[0-9]{1,18}$'),   -- 回報方給的 entitlement_id
    constraints              jsonb  not null default '{}'::jsonb,
    properties               jsonb  not null default '{}'::jsonb,
    result                   sgn.reconciliation_item_result,         -- 比對後填入
    flags                    text[] not null default '{}',           -- subject_unresolved、entitlement_mismatch、matched_union
    matched_entitlement_id   bigint references sgn.entitlement (id),
    unique (run_id, item_key)
);
create index reconciliation_item_lookup_idx on sgn.reconciliation_item (run_id, resource_type, resource_id, action);

create table sgn.reconciliation_finding (
    id                         bigint generated always as identity primary key,
    fingerprint                bytea  not null,
    api_client_id              bigint not null references sgn.api_client (id),
    process_type_id            bigint not null references sgn.process_type (id),
    kind                       sgn.finding_kind not null,
    severity                   sgn.finding_severity not null,
    status                     sgn.finding_status not null default 'open',
    subject_person_id          bigint references sgn.person (id),
    subject_principal_id       bigint references sgn.principal (id),
    resource_type              text,                                   -- run_anomalous 時三者皆為 null
    resource_id                text,
    action                     text,
    entitlement_id             bigint references sgn.entitlement (id),
    first_run_id               bigint not null references sgn.reconciliation_run (id),
    last_seen_run_id           bigint not null references sgn.reconciliation_run (id),
    seen_count                 integer not null default 1,
    continued_from_finding_id  bigint references sgn.reconciliation_finding (id),
    auto_close_blocked         boolean not null default false,         -- 主體的外部識別碼改過（3.2）
    detail                     jsonb  not null default '{}'::jsonb,
    assignee_person_id         bigint not null references sgn.person (id),
    opened_at                  timestamptz not null,
    due_at                     timestamptz not null,
    acknowledged_at            timestamptz,
    acknowledged_by            bigint references sgn.person (id),
    response_note              text,
    escalated_at               timestamptz,
    escalated_to_person_id     bigint references sgn.person (id),
    absent_run_id              bigint references sgn.reconciliation_run (id),   -- 哪一個批次回報它消失了
    verification_due_at        timestamptz,
    verification_alerted_at    timestamptz,
    verified_by                bigint references sgn.person (id),
    verified_at                timestamptz,
    verification_note          text,
    closed_at                  timestamptz,
    closed_by                  bigint references sgn.person (id),      -- 由批次結案時為 null
    close_reason               text check (close_reason in ('resolved_by_run', 'verified', 'superseded', 'run_reviewed',
                                                            'mapping_error', 'duplicate', 'system_retired')),
    close_note                 text,
    resolved_by_run_id         bigint references sgn.reconciliation_run (id),
    check ((status in ('resolved', 'dismissed')) = (closed_at is not null)),
    check ((kind = 'run_anomalous') = (resource_type is null))
);
create unique index reconciliation_finding_open_uq
    on sgn.reconciliation_finding (fingerprint) where status in ('open', 'acknowledged', 'pending_verification');
create index reconciliation_finding_client_idx on sgn.reconciliation_finding (api_client_id, status);
create index reconciliation_finding_resource_idx
    on sgn.reconciliation_finding (api_client_id, kind, resource_type, resource_id, action)
    where status in ('open', 'acknowledged', 'pending_verification');
create index reconciliation_finding_assignee_idx on sgn.reconciliation_finding (assignee_person_id) where status in ('open', 'acknowledged');
create index reconciliation_finding_due_idx on sgn.reconciliation_finding (due_at) where status in ('open', 'acknowledged');

create table sgn.reconciliation_finding_history (
    id               bigint generated always as identity primary key,
    finding_id       bigint not null references sgn.reconciliation_finding (id),
    run_id           bigint references sgn.reconciliation_run (id),      -- 由批次造成的變動才有
    event            text   not null check (event in ('opened', 'seen', 'continued', 'reopened', 'pending_verification',
                                                      'resolved', 'superseded', 'acknowledged', 'escalated',
                                                      'verified', 'verification_rejected', 'dismissed',
                                                      'run_reviewed', 'auto_close_blocked')),
    actor_person_id  bigint references sgn.person (id),                  -- 排程造成的為 null
    note             text,
    created_at       timestamptz not null
);
create index reconciliation_finding_history_finding_idx on sgn.reconciliation_finding_history (finding_id, id);
create index reconciliation_finding_history_run_idx on sgn.reconciliation_finding_history (run_id) where run_id is not null;
```

`reconciliation_finding_history` 擋下 `UPDATE`、`DELETE`、`TRUNCATE`。解析不出主體的發現，兩個主體欄位都是 null，回報的識別碼在 `detail.reported_subjects`。

### 11.8 定期複查

```sql
create sequence sgn.access_review_no_seq;

create table sgn.access_review_campaign (
    id                  bigint generated always as identity primary key,
    review_no           text   not null unique,                     -- AR-<年>-<四位流水號>
    name                text   not null check (length(name) between 1 and 100),
    process_type_id     bigint not null references sgn.process_type (id),
    tier_code           text,
    resource_type       text,
    resource_id_prefix  text,
    principal_kind      text,
    reviewer_kind       sgn.review_reviewer_kind not null,
    reviewer_role_id    bigint references sgn.role (id),
    starts_at           timestamptz not null,
    due_at              timestamptz not null,
    no_response_action  sgn.review_no_response_action not null,
    loosened            boolean not null default false,              -- 不回應的處理比參數寬鬆（9.1）
    status              sgn.review_campaign_status not null default 'scheduled',
    origin              text   not null check (origin in ('manual', 'scheduled')),
    created_by          bigint references sgn.person (id),           -- 排程建立時為 null
    created_reason      text,
    created_at          timestamptz not null,
    opened_at           timestamptz,
    closed_at           timestamptz,
    cancelled_by        bigint references sgn.person (id),           -- open 時取消：變更申請的提出人
    cancel_approved_by  bigint references sgn.person (id),           -- open 時取消：覆核人
    cancel_reason       text,
    summary             jsonb,
    result_sha256       bytea,
    check (due_at > starts_at),
    check ((reviewer_kind = 'role_holder') = (reviewer_role_id is not null)),
    check (resource_id_prefix is null or resource_type is not null)
);
create index access_review_campaign_type_idx on sgn.access_review_campaign (process_type_id, starts_at);

create table sgn.access_review_item (
    id                           bigint generated always as identity primary key,
    campaign_id                  bigint not null references sgn.access_review_campaign (id),
    grant_id                     bigint not null references sgn."grant" (id),
    case_id                      bigint not null references sgn."case" (id),
    scope_ref                    text,
    reviewer_person_id           bigint references sgn.person (id),  -- null＝系統管理員群組處理
    original_reviewer_person_id  bigint references sgn.person (id),
    reassign_reason              text check (reassign_reason in ('sod', 'escalated')),
    due_at                       timestamptz not null,
    status                       sgn.review_item_status not null default 'pending',
    decision                     sgn.review_decision,
    decision_note                text,
    reduce_spec                  jsonb,                              -- decision = 'reduce' 時必填（9.3）
    decided_by                   bigint references sgn.person (id),
    decided_on_behalf_of         bigint references sgn.person (id),  -- 代理時，被代理的人
    decided_at                   timestamptz,
    entitlement_snapshot         jsonb  not null,
    snapshot_sha256              bytea  not null,
    attested_by                  bigint references sgn.person (id),  -- 負責人的需求確認（9.2）
    attested_at                  timestamptz,
    attest_still_needed          boolean,
    attest_note                  text,
    reminded_at                  timestamptz,
    escalated_at                 timestamptz,
    followup_status              sgn.review_followup_status not null default 'none',
    followup_due_at              timestamptz,
    followup_reminded_at         timestamptz,
    followup_confirmed_by        bigint references sgn.person (id),
    followup_confirm_note        text,
    followup_closed_at           timestamptz,
    unique nulls not distinct (campaign_id, grant_id, scope_ref),
    check ((status = 'decided') = (decision is not null)),
    check ((decision is not distinct from 'reduce'::sgn.review_decision) = (reduce_spec is not null))
);
create index access_review_item_reviewer_idx on sgn.access_review_item (reviewer_person_id) where status = 'pending';
create index access_review_item_grant_idx on sgn.access_review_item (grant_id);
create index access_review_item_followup_idx on sgn.access_review_item (followup_due_at)
    where followup_status in ('pending', 'pending_confirmation');
```

### 11.9 證據

```sql
create table sgn.evidence_checkpoint (
    id                   bigint generated always as identity primary key,
    audit_seq            bigint not null unique,
    audit_hash           text   not null,
    event_count          bigint not null,                            -- 自上一個檢查點以來實際數出來的事件筆數
    previous_id          bigint references sgn.evidence_checkpoint (id),
    previous_audit_seq   bigint,
    previous_audit_hash  text,
    created_at           timestamptz not null,
    payload              text   not null,                            -- 被簽章的 JSON 文字
    signature_jws        text,
    signing_key_id       text,
    signed_at            timestamptz,
    tsa_token            bytea,
    lease_until          timestamptz,
    mailed_at            timestamptz
);
create index evidence_checkpoint_unsigned_idx on sgn.evidence_checkpoint (id) where signature_jws is null;

create table sgn.audit_ocsf_map (
    action        text primary key,                                  -- 稽核動作代碼
    class_uid     integer not null check (class_uid in (3004, 3005)),
    activity_id   integer not null,
    severity_id   integer not null default 1 check (severity_id between 0 and 6)
);

-- audit.read 的呼叫方可以看到 changes 的哪些鍵（10.2）。沒有列在這裡的鍵一律拿掉
create table sgn.audit_export_key (
    action  text not null,                                           -- 稽核動作代碼
    key     text not null,                                           -- changes 最上層的鍵
    note    text not null,                                           -- 為什麼這個鍵不含自由文字或個人資料
    primary key (action, key)
);
```

`evidence_checkpoint` 擋下 `DELETE` 與 `TRUNCATE`。`UPDATE` 只允許把 `signature_jws`、`signing_key_id`、`signed_at`、`tsa_token` 從 null 填成有值一次，以及更新 `lease_until`、`mailed_at`；其他欄位不可變。

### 11.10 變更申請

```sql
create table sgn.integration_change_request (
    id                    bigint generated always as identity primary key,
    kind                  sgn.change_request_kind not null,
    target_id             bigint,                                    -- api_client、principal 或 access_review_campaign 的 id；api_client_create 時為 null
    payload               jsonb  not null,                           -- 要套用的內容
    impact                jsonb  not null default '{}'::jsonb,       -- 提出時算出的影響（4.9）
    reason                text   not null check (length(reason) between 1 and 2000),
    status                sgn.change_request_status not null default 'pending',
    proposed_by           bigint not null references sgn.person (id),
    proposed_at           timestamptz not null,
    approved_by           bigint references sgn.person (id),
    approved_at           timestamptz,
    countersign_required  boolean not null default false,
    countersigned_by      bigint references sgn.person (id),
    countersigned_at      timestamptz,
    decided_note          text,
    decided_at            timestamptz,                               -- 套用、駁回、撤回或逾期的時間
    expires_at            timestamptz not null,
    result_id             bigint,                                    -- 套用後產生的東西的 id（例如新的 api_client）
    check (approved_by is null or approved_by <> proposed_by),
    check (countersigned_by is null or (countersigned_by <> proposed_by and countersigned_by <> approved_by))
);
create index integration_change_request_pending_idx on sgn.integration_change_request (kind, target_id) where status = 'pending';

alter table sgn.principal_identity
    add constraint principal_identity_change_request_fk foreign key (change_request_id) references sgn.integration_change_request (id);
alter table sgn.api_client_credential
    add constraint api_client_credential_change_request_fk foreign key (change_request_id) references sgn.integration_change_request (id);
```

`integration_change_request` 擋下 `DELETE` 與 `TRUNCATE`；`payload`、`reason`、`kind`、`target_id`、`proposed_by` 建立後不可變。同一個（`kind`、`target_id`）同時只能有一筆 `pending` 的申請（`api_client_create` 以 `payload.code` 判斷），重複提出回 `change_request_duplicate`。

## 12. 內部函式（schema `sgn_internal`）

兩個複合型別：

```sql
create type sgn_internal.client_context as (
    api_client_id      bigint,
    code               text,
    identity_provider  text,
    allowed_providers  text[],
    constraint_mode    sgn.constraint_mode,
    sync_epoch         integer,
    scopes             text[],        -- token 的 scope 與 api_client 目前 scope 的交集
    token_id           bigint
);

create type sgn_internal.subject_ref as (
    kind          sgn.subject_kind,
    person_id     bigint,
    principal_id  bigint
);
```

### 12.1 投影與事件

| 簽章 | 行為 |
|---|---|
| `project_case(p_case_id bigint, p_rule_code text default null) returns void` | 見 12.5 |
| `note_projection_rule(p_case_id bigint, p_rule_code text) returns void` | 把（申請單、規則代碼）記在交易層級的設定 `sgn.projection_rules`（JSON 物件的文字，鍵是申請單 id）。`project_case` 沒有收到 `p_rule_code` 時從這裡取 |
| `project_principal(p_principal_id bigint, p_event text, p_detail jsonb default '{}') returns void` | `p_event` 與行為見下表 |
| `project_person(p_person_id bigint) returns void` | 人的在職狀態改變時：(1) 對每一張「有未結束的權限項目以他為主體」的申請單呼叫 `project_case`（他不在職時這些項目依 3.4 變成 `ended`，原因 `subject_inactive`，事件是 `sgn.grant.ended`）；(2) 他變成不在職時，對他是有效成員的每一個被授權者發出 `sgn.principal.membership_changed`（`removed` 是他，`reason` 是 `person_inactive`） |
| `project_person_identity(p_person_id bigint, p_provider text, p_old_external_id text, p_new_external_id text) returns void` | 發出 `sgn.person.identity_changed`，並把以他為主體的未結束權限項目的 `sync_seq` 設為這個事件的序號 |
| `integration_case_projection_trigger()`、`integration_grant_projection_trigger()`、`integration_person_projection_trigger()`、`integration_person_identity_trigger()`、`integration_principal_projection_trigger()`、`integration_member_projection_trigger()`，都 `returns trigger` | 2.2 的六個觸發函式。只做轉呼叫，不含判斷 |
| `call_describe_entitlements(p_case_id bigint) returns jsonb` | 呼叫流程類型登記的 hook；沒有登記回 `[]`。檢查每個元素的鍵、型別、格式、(`resource_type`, `resource_id`) 不重複，以及 `has_validity` 為否時不得有 `effective_during = active`；不合格丟 `entitlement_hook_invalid` 或 `entitlement_duplicate_resource` |
| `call_evaluate_constraints(p_process_type_id bigint, p_constraints jsonb, p_context jsonb) returns boolean` | 依 3.3 的呼叫規則。hook 丟出的例外在這裡攔下並回 false |
| `emit_integration_event(p_event_type text, p_data jsonb, p_process_type_id bigint default null, p_case_id bigint default null, p_grant_id bigint default null, p_principal_id bigint default null, p_person_id bigint default null, p_api_client_id bigint default null, p_ref_id bigint default null, p_rule_code text default null) returns bigint` | 取 advisory lock（`pg_advisory_xact_lock(sgn_internal.integration_event_lock_key())`）→ 取序號 → 寫入 `sgn.integration_event` → 回傳序號。這是產生事件的唯一入口 |
| `integration_event_lock_key() returns bigint` | `immutable`，回固定值 `5058301` |
| `integration_forbid_change() returns trigger` | 只增不改的資料表共用的觸發函式 |

`project_principal` 的事件：

| `p_event` | 誰呼叫 | `p_detail` | 行為 |
|---|---|---|---|
| `owner_changed` | 觸發程序 | `old_owner_person_id`、`new_owner_person_id` | 發出 `sgn.principal.owner_changed`；把該被授權者所有未結束權限項目的 `sync_seq` 設為事件的序號，並清掉它們因負責人寬限期設定的 `revoke_risk_at`（重新取「複查追蹤期限」作為值，沒有就是 null） |
| `owner_at_risk` | 核心 | `grace_until` | 發出 `sgn.principal.owner_at_risk`；把該被授權者所有未結束權限項目的 `revoke_risk_at` 設為「原值」與 `grace_until` 較早的那一個 |
| `owner_risk_cleared` | 核心 | — | 不發事件；重算 `revoke_risk_at`（同 `owner_changed`） |
| `member_added`、`member_removed` | 觸發程序 | `person_id`、`valid_from`、`valid_until` | 發出 `sgn.principal.membership_changed` |
| `identity_changed` | `set_principal_identity`、`remove_principal_identity` | `provider`、`old_external_id`、`new_external_id` | 發出 `sgn.principal.identity_changed`；把該被授權者所有未結束權限項目的 `sync_seq` 設為事件的序號；把以這個被授權者為主體的未結案對帳發現標記 `auto_close_blocked` 並寫歷程 |

### 12.2 主體、身分對應與可見範圍

| 簽章 | 行為 |
|---|---|
| `resolve_subject(p_default_provider text, p_allowed_providers text[], p_subject jsonb) returns sgn_internal.subject_ref` | provider 取 `p_subject.properties.provider`，沒有就取 `p_default_provider`。provider 不在 `p_allowed_providers` 裡回 null。provider 是 `sgn` 時以內部 id 查；否則查 `person_identity` 或 `principal_identity`。找不到回 null。只回在職的人、狀態有效且結束日未到的被授權者 |
| `subject_principals(p_person_id bigint, p_at timestamptz) returns setof bigint` | 這個人在 `p_at` 是有效成員的被授權者（人在職、成員期間涵蓋 `p_at`、被授權者狀態有效且結束日未到）。成員關係的唯一解析入口 |
| `subject_principals_between(p_person_id bigint, p_from timestamptz, p_to timestamptz) returns setof bigint` | 這個人在這段時間內任何時刻曾是成員的被授權者（成員期間與這段時間有重疊）。只給對帳的容許規則用（8.5 第 6 列） |
| `member_valid_until(p_person_id bigint, p_principal_id bigint, p_at timestamptz) returns timestamptz` | 這個人在 `p_at` 有效的成員期間的迄；沒有迄回 null。給 `ttl_seconds` 用（5.5） |
| `subject_is_valid(p_subject sgn_internal.subject_ref, p_at timestamptz) returns boolean` | 人：在職。被授權者：狀態有效，而且結束日是 null 或 `p_at` 早於結束日次日 00:00（`system.business_timezone`）。3.4 第一步與 5.3 第 4 步共用 |
| `render_subject(p_ctx sgn_internal.client_context, p_kind sgn.subject_kind, p_person_id bigint, p_principal_id bigint) returns jsonb` | 依 3.2 輸出 `{"type", "id", "properties"}`：用呼叫方的 `identity_provider`；沒有對應時，`allowed_providers` 含 `sgn` 就用內部 id，否則用 `anon-` 的代號 |
| `client_can_see(p_api_client_id bigint, p_process_type_id bigint, p_resource_type text, p_resource_id text) returns boolean` | 依 4.5。`stable`。集合查詢直接與 `api_client_visibility` join，條件必須與這個 function 相同 |
| `client_can_see_case(p_api_client_id bigint, p_case_id bigint) returns boolean` | 這張申請單至少有一筆權限項目（不論狀態）通過 `client_can_see` |
| `client_sees_whole_process(p_api_client_id bigint, p_process_type_id bigint) returns boolean` | 4.5 的「整個流程類型可見」 |
| `client_sees_principal(p_api_client_id bigint, p_principal_id bigint) returns boolean` | 該被授權者有 `pending` 或 `active` 的可見權限項目，或有在 `integration.check_ended_lookback_days` 天內結束的可見項目。`sgn.principal.*` 事件與成員端點共用 |
| `set_principal_identity(p_principal_id bigint, p_provider text, p_external_id text, p_source text, p_change_request_id bigint, p_actor bigint) returns void` | 建立或取代對應（`K-INT-IDENTITY`）。`(provider, external_id)` 已對應到別的被授權者時丟 `principal_identity_taken`。同一個交易內寫稽核事件（新舊值、來源）並呼叫 `project_principal(…, 'identity_changed', …)`；取代時另外把「主體解析不出來、回報的識別碼等於舊值或新值」的未結案對帳發現標記 `auto_close_blocked`。值沒有改變時不做任何事。`p_source = 'sync'` 由人員與組織 port 的同步呼叫（`p_actor` 是 null） |
| `remove_principal_identity(p_principal_id bigint, p_provider text, p_source text, p_change_request_id bigint, p_actor bigint) returns void` | 移除對應；其餘同上 |
| `integration_admin_role() returns text`、`integration_auditor_role() returns text` | 2.1 |

### 12.3 驗證、紀錄、判定

| 簽章 | 行為 |
|---|---|
| `authenticate_client(p_token_sha256 bytea, p_function_name text, p_ip text) returns sgn_internal.client_context` | 依序：(1) 找未過期的 token，找不到丟 `integration_invalid_token`；(2) `api_client.status` 必須是 `active`，換發它的憑證必須未撤銷，否則丟 `integration_invalid_token`；(3) `p_ip` 必須是合法的位址、落在 `allowed_source_cidrs` 內，而且 `token_binding = 'ip'` 時等於 token 的 `issued_ip`，否則丟 `integration_invalid_token`；(4) 從 `api_function_scope` 取這個 function 需要的 scope，必須同時在 token 與 `api_client` 目前的 scope 裡，否則丟 `integration_insufficient_scope`；(5) 這個視窗的 `error` 計數已達上限，丟 `integration_rate_limited`；(6) 累加 `api` 計數，超過丟 `integration_rate_limited`。這是整合介面驗證與授權的唯一入口 |
| `explain_auth_failure(p_token_sha256 bytea, p_function_name text, p_ip text) returns text` | 不改變任何狀態，重做上面的 (1) 到 (4)，回傳第一個不通過的原因代碼：`token_unknown`、`token_expired`、`client_not_active`、`credential_revoked`、`source_not_allowed`、`token_ip_mismatch`、`scope_missing`；都通過回 null。給 `integration_record_failure` 寫 `internal_reason` |
| `count_rate(p_api_client_id bigint, p_bucket text) returns integer` | 依 4.8 的視窗把該計數加一（`insert … on conflict do update`），回傳加完之後的值 |
| `log_api_call(p_ctx sgn_internal.client_context, p_function_name text, p_request_id text, p_ip text, p_http_status integer, p_item_count integer, p_summary jsonb) returns bigint` | 寫入 `api_call_log`，回傳 id。`duration_ms` 取 `clock_timestamp() - statement_timestamp()`。`p_request_id` 不符合 `^[A-Za-z0-9._-]{1,64}$` 時丟 `integration_invalid_request`（後端已先過濾，這裡是第二道） |
| `validate_access_request(p_body jsonb, p_batch boolean) returns void` | 依第 16 節的輸入規則檢查；不合格丟 `integration_invalid_request`（說明帶 JSON 路徑）或 `integration_too_many_evaluations` |
| `evaluate_access(p_ctx sgn_internal.client_context, p_subject jsonb, p_action jsonb, p_resource jsonb, p_context jsonb, p_at timestamptz) returns jsonb` | 依 5.3，回傳 `{"decision", "context"}`（不含 `decision_id`，由呼叫它的 function 補上） |
| `render_entitlement(p_ctx sgn_internal.client_context, p_entitlement sgn.entitlement, p_inherited boolean default false) returns jsonb` | 6.3 的單筆格式 |
| `render_integration_event(p_ctx sgn_internal.client_context, p_event sgn.integration_event) returns jsonb` | 7.2 的 CloudEvents 格式；對這個呼叫方不可見時回 null |
| `encode_sync_cursor(p_ctx sgn_internal.client_context, p_seq bigint, p_id bigint) returns text`、`decode_sync_cursor(p_ctx sgn_internal.client_context, p_cursor text, out seq bigint, out id bigint)` | 格式 `e<sync_epoch>.<seq>-<id>`。格式錯誤丟 `integration_cursor_invalid`；`sync_epoch` 與 `p_ctx.sync_epoch` 不同丟 `integration_resync_required` |
| `encode_event_cursor(p_ctx sgn_internal.client_context, p_seq bigint) returns text`、`decode_event_cursor(p_ctx sgn_internal.client_context, p_cursor text) returns bigint` | 格式 `e<sync_epoch>.<seq>`；錯誤處理同上 |
| `bump_sync_epoch(p_api_client_id bigint) returns void` | `sync_epoch` 加一，並發出只給這個呼叫方的 `sgn.client.visibility_changed`（`K-INT-SYNC-EPOCH`） |

### 12.4 webhook、對帳、複查、變更申請、證據、排程

| 簽章 | 行為 |
|---|---|
| `webhook_next_event(p_subscription_id bigint) returns jsonb` | 找出這個訂閱下一個要送的事件（序號大於 `delivered_seq`、類型符合、對呼叫方可見），回傳轉換後的事件；掃過而不符合的事件直接把 `delivered_seq` 往前推。沒有事件回 null |
| `webhook_retry_delay(p_attempt_no integer) returns interval` | 依 7.6 的公式與參數 |
| `disable_webhook_subscription(p_subscription_id bigint, p_reason text) returns void` | 改狀態、寫稽核事件、通知負責人與系統管理員 |
| `compare_reconciliation_step(p_run_id bigint) returns boolean` | 依 8.5 做一段；這個批次還有工作沒做完回 true |
| `finding_fingerprint(p_api_client_id bigint, p_kind sgn.finding_kind, p_subject_key jsonb, p_resource_type text, p_resource_id text, p_action text, p_entitlement_id bigint) returns bytea` | 8.5 第三步的 SQL。`immutable` |
| `open_access_review_campaign(p_campaign_id bigint) returns void` | 依 9.2 產生工作、通知複查人、發出事件 |
| `review_sod_violation(p_person_id bigint, p_grant_id bigint) returns boolean` | `K-INT-REVIEW-SOD` 的唯一判斷：這個人是該授權的申請人、主體本人、或主體（被授權者）現在的有效成員時回 true |
| `resolve_review_reviewer(p_campaign_id bigint, p_grant_id bigint, p_scope_ref text) returns bigint` | 依 `reviewer_kind` 找人；`review_sod_violation` 為 true 就往上找直屬主管；回 null 代表交給系統管理員群組 |
| `review_snapshot(p_grant_id bigint, p_scope_ref text) returns jsonb` | 回 `{"entitlements": [...], "sha256": "<hex>"}`，算法見下 |
| `check_review_followup(p_case_id bigint) returns void` | 9.3 的追蹤核對（第 2 到 5 點）。由 `project_case` 在每次投影有改變時呼叫。追蹤變成 `done` 時，重算該授權各權限項目的 `revoke_risk_at`（只剩負責人寬限期的期限，沒有就是 null） |
| `close_access_review_campaign_if_done(p_campaign_id bigint) returns void` | 依 9.6 |
| `validate_change_request(p_kind sgn.change_request_kind, p_target_id bigint, p_payload jsonb, p_actor bigint) returns jsonb` | 檢查內容是否合法（不合法丟對應的錯誤），並回傳 `impact`。提出與套用時都呼叫 |
| `change_request_needs_approval(p_kind sgn.change_request_kind, p_target_id bigint, p_payload jsonb) returns boolean` | 4.9 表中「什麼時候需要覆核」的唯一判斷 |
| `apply_change_request(p_request_id bigint) returns bigint` | 依 `kind` 套用 `payload`、寫該動作的稽核事件、回傳 `result_id`。只由覆核（或不需要覆核時由提出）的 function 呼叫 |
| `audit_event_to_native(p_ctx sgn_internal.client_context, p_seq bigint) returns jsonb` | 10.2 的格式（依 scope 決定是否遮蔽）；不可見回 null |
| `audit_event_to_ocsf(p_ctx sgn_internal.client_context, p_seq bigint) returns jsonb` | 10.3 的格式；不可見回 null |
| `call_log_to_native(p_ctx sgn_internal.client_context, p_id bigint) returns jsonb`、`call_log_to_ocsf(p_ctx sgn_internal.client_context, p_id bigint) returns jsonb` | 10.3 的呼叫紀錄格式 |
| `job_integration_consistency() returns jsonb` | 見 15.4 |
| `job_integration_expiring() returns jsonb` | 見 15.4 |
| `job_integration_client_hygiene() returns jsonb` | 見 15.4 |
| `job_integration_call_log_seal() returns jsonb` | 見 15.4 |
| `job_reconciliation() returns jsonb` | 見 15.4 |
| `job_access_review() returns jsonb` | 見 15.4 |
| `job_evidence_checkpoint() returns jsonb` | 見 15.4 |

`review_snapshot` 的算法（`p_scope_ref` 是 null 時不篩選範圍）：

```sql
select coalesce(jsonb_agg(jsonb_build_object(
           'entitlement_id', e.id,
           'revision', e.revision,
           'resource_type', e.resource_type,
           'resource_id', e.resource_id,
           'actions', to_jsonb(e.actions),
           'constraints', e.constraints,
           'effective_from', to_char(e.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'effective_until', to_char(e.effective_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       ) order by e.id), '[]'::jsonb)
  into v_entitlements
  from sgn.entitlement e
 where e.grant_id = p_grant_id
   and e.status <> 'ended'
   and (p_scope_ref is null or e.scope_ref = p_scope_ref);

v_sha256 := encode(digest(v_entitlements::text, 'sha256'), 'hex');
```

### 12.5 `project_case` 的步驟

規則 `K-INT-PROJECT`。

1. 鎖住這張申請單既有的權限項目（`select … for update`），避免同一張單的兩次投影交錯。
2. 讀申請單狀態、`grant`（如果有）、流程類型的選項，決定主體：流程類型 `uses_principal` 為是取申請單的被授權者，否則取申請人。
3. 申請單在 `draft`、`in_approval`、`returned`：既有未結束的項目全部改為 `ended`（原因 `cancelled`），跳到第 7 步。
4. 主體無效（`subject_is_valid` 為 false）：既有未結束的項目全部改為 `ended`（原因 `subject_inactive`），跳到第 7 步。這時不呼叫 hook。
5. 呼叫 `call_describe_entitlements`，得到目標清單；依 3.4 第二步算出每一筆目標項目的狀態與有效期間。
6. 與既有未結束的項目比對，鍵是 (`resource_type`, `resource_id`)：
   - 目標有、既有沒有：新增。例外：這張單的同一個資源已有一筆原因為 `subject_inactive` 的已結束項目時不新增（3.4）。
   - 既有有、目標沒有：改為 `ended`，原因 `removed`。
   - 兩邊都有：動作、限制條件或 `scope_ref` 不同就更新、把 `revision` 加一、更新 `updated_at`；狀態、有效期間、`grant_id` 不同就更新。
   - 目標狀態是 `ended`：既有的改為 `ended` 並填原因；既有沒有就不新增。
7. 沒有任何改變就結束，不發事件。
8. 有改變：依「這張單整體」的前後狀態決定事件類型。整體狀態的定義：有任何一筆 `active` 就是 `active`；否則有任何一筆 `pending` 就是 `pending`；否則是 `ended`（沒有項目也算 `ended`）。

| 前 → 後 | 事件 |
|---|---|
| `pending` 或 `ended`（或沒有）→ `active` | `sgn.grant.activated` |
| `ended`（或沒有）→ `pending` | `sgn.grant.approved` |
| `active` → `pending`（例如執行內容被退回重做而 `grant` 尚未建立） | `sgn.grant.changed`，`change_class` 是 `narrowed` |
| 狀態相同（`active` 或 `pending`），項目有改變 | `sgn.grant.changed`，並依 7.1 算出 `change_class` |
| → `ended`，全部項目的原因都是 `expired` | `sgn.grant.expired` |
| → `ended`，全部項目的原因都是 `revoked` | `sgn.grant.revoked` |
| → `ended`，其他（含 `subject_inactive`） | `sgn.grant.ended` |

   上表涵蓋三種整體狀態的全部九種前後組合（`ended` → `ended` 而項目有改變時不發事件，只更新資料）。

9. 呼叫 `emit_integration_event`，把回傳的序號寫進這次所有被改變項目的 `sync_seq`。事件的 `rule_code` 取 `p_rule_code`，沒有就取 `note_projection_rule` 記下的值。新增的項目如果屬於一筆有 `followup_status = 'pending'` 複查工作的授權，`revoke_risk_at` 設為該工作的 `followup_due_at`；被授權者正在負責人寬限期內時，再與寬限期限取較早的。
10. 這張單有複查工作的後續追蹤是 `pending` 或 `pending_confirmation`：呼叫 `check_review_followup`。這張單有 `pending` 的複查工作而整體狀態變成 `ended`：工作改為 `not_applicable`。

`project_case` 不寫稽核事件：造成改變的那個動作已經由核心寫過了。例外是 `job_integration_consistency` 發現不一致而重投影時，由那個工作寫稽核事件（2.2）。

## 13. 對外 function（schema `api`）

共 75 個。全部符合工程規範的架構測試：`SECURITY DEFINER`、固定 `search_path`、第一個參數是 `p_actor`、有 `COMMENT`。

三種呼叫者：

| 類別 | `p_actor` | 身分怎麼確認 |
|---|---|---|
| 其他系統（30 個） | 一律傳 null；傳了非 null 丟 `integration_invalid_request` | 第二個參數 `p_token_sha256`，由 `sgn_internal.authenticate_client` 驗證 |
| 後端自己（6 個） | 後端的系統身分（比照核心對寄信佇列 function 的規定） | 只供後端的 worker、錯誤處理與身分同步使用，不對應任何路由 |
| 人（39 個） | 登入者 | 核心的角色檢查 |

給其他系統的 function，除了兩個公開的中繼資料 function 與 token 換發，最後兩個參數固定是 `p_request_id text`（請求識別碼）與 `p_ip text`（來源 IP，取得方式見 4.10），而且都依同一個骨架執行：

```
1. v_ctx := sgn_internal.authenticate_client(p_token_sha256, '<自己的名稱>', p_ip);
2. 檢查輸入；
3. 執行；
4. perform sgn_internal.log_api_call(v_ctx, '<自己的名稱>', p_request_id, p_ip, <HTTP 狀態>, <筆數>, <摘要>);
5. 回傳 jsonb。
```

架構測試會檢查這 27 個 function 的原始碼都呼叫了 `authenticate_client` 與 `log_api_call`，而且在 `sgn.api_function_scope` 有一列。

### 13.1 給其他系統的 function

下表省略每個簽章開頭的 `p_actor bigint, p_token_sha256 bytea` 與結尾的 `p_request_id text, p_ip text`；回傳型別除註明外都是 `jsonb`。

| function | 中間的參數 | scope | 行為 |
|---|---|---|---|
| `integration_check` | `p_body jsonb` | `check` | 5.2、5.3 |
| `integration_check_batch` | `p_body jsonb` | `check` | 5.4 |
| `integration_usage_report` | `p_entitlement_id text, p_body jsonb` | `usage.write` | 5.7 |
| `integration_grants_list` | `p_query jsonb` | `grants.read` | 6.2 到 6.4 |
| `integration_grant_get` | `p_entitlement_id text` | `grants.read` | 單筆；不存在或不可見丟 `integration_not_found` |
| `integration_principal_members` | `p_subject_id text, p_query jsonb` | `grants.read` | 6.5。參數 `subject_provider`、`page_token`、`limit` |
| `integration_events_list` | `p_query jsonb` | `events.read` | 7.3 |
| `integration_webhook_list` | — | `webhooks.manage` | 自己未刪除的訂閱 |
| `integration_webhook_create` | `p_body jsonb` | `webhooks.manage` | 7.5。回傳內容另帶 `secret_version`，由後端換成 `secret` |
| `integration_webhook_get` | `p_endpoint_id text` | `webhooks.manage` | 單筆 |
| `integration_webhook_update` | `p_endpoint_id text, p_body jsonb` | `webhooks.manage` | 可改 `event_types`、`description`、`status`（`enabled`、`paused`）、`resume_from`；狀態轉移依 7.5 的表。網址不可改（要換網址就刪除重建） |
| `integration_webhook_delete` | `p_endpoint_id text` | `webhooks.manage` | 軟刪除。回傳 `void` |
| `integration_webhook_rotate_secret` | `p_endpoint_id text` | `webhooks.manage` | `secret_version` 加一並設定重疊期。回傳內容帶 `secret_version`，由後端換成 `secret` |
| `integration_webhook_ping` | `p_endpoint_id text` | `webhooks.manage` | 設定 `ping_pending`，由 worker 送出。回傳訂閱內容。`disabled` 的訂閱丟 `webhook_status_invalid` |
| `integration_reconciliation_run_create` | `p_body jsonb` | `reconciliation.write` | 8.2 |
| `integration_reconciliation_items_add` | `p_run_id text, p_body jsonb` | `reconciliation.write` | 8.3 |
| `integration_reconciliation_run_complete` | `p_run_id text, p_body jsonb` | `reconciliation.write` | 8.4 |
| `integration_reconciliation_run_get` | `p_run_id text` | `reconciliation.write` | 只能看自己的批次。`completed` 時 `summary` 有值 |
| `integration_reconciliation_findings_list` | `p_query jsonb` | `reconciliation.write` | 只能看自己的發現，輸出依 8.6 的兩種版本。參數：`status`（預設 `open,acknowledged,pending_verification`）、`kind`、`run_id`、`page_token`、`limit` |
| `integration_reviews_list` | `p_query jsonb` | `reviews.read` | 可見流程類型的各輪複查（不含工作明細）。參數：`process_type`、`status`、`page_token`、`limit` |
| `integration_review_get` | `p_review_no text` | `reviews.read` | 一輪複查與可見的工作（9.6） |
| `integration_audit_events_list` | `p_query jsonb` | `audit.read` | 10.2、10.3。呼叫方有 `audit.read_all` 時回全部、不遮蔽 |
| `integration_audit_calls_list` | `p_query jsonb` | `audit.read_all` | 10.3 的呼叫紀錄 |
| `integration_evidence_chain` | `p_query jsonb` | `evidence.read` | 雜湊鏈骨架：`{"items": [{"seq", "prev_hash", "hash"}], "next_cursor", "has_more"}`。參數 `after`、`limit` |
| `integration_evidence_chain_head` | — | `evidence.read` | 10.4 |
| `integration_evidence_checkpoints_list` | `p_query jsonb` | `evidence.read` | 已簽章的檢查點，依 id 遞增。參數 `after`（檢查點 id）、`limit` |
| `integration_evidence_checkpoint_get` | `p_checkpoint_id text` | `evidence.read` | 單筆 |

另外三個不走上述骨架：

```sql
api.integration_token_issue(
    p_actor bigint, p_client_code text, p_secret_sha256 bytea,
    p_grant_type text, p_scope text, p_request_id text, p_ip text) returns jsonb
```

回傳 `{"http_status": 200, "body": {…}}` 或 `{"http_status": 400|401|429, "body": {"error": "…", "error_description": "…"}}`。失敗時不丟例外：失敗的嘗試要計數並留紀錄，丟例外會讓交易回復。處理順序與兩種計數見 4.3；來源位址的檢查見 4.10。成功時另外更新憑證的 `last_used_at` 與 `api_client_source_seen`。

```sql
api.integration_authzen_metadata(p_actor bigint) returns jsonb    -- 5.1 的中繼資料；公開
api.integration_discovery(p_actor bigint) returns jsonb           -- 平台的整合資訊；公開
```

`integration_discovery` 的內容：

```json
{
  "issuer": "https://sgn.example.com/integration/v1",
  "api_version": "1",
  "token_endpoint": "https://sgn.example.com/integration/v1/oauth/token",
  "jwks_uri": "https://sgn.example.com/integration/v1/jwks.json",
  "authzen_configuration": "https://sgn.example.com/.well-known/authzen-configuration/integration/v1",
  "scopes_supported": [
    "check",
    "grants.read",
    "usage.write",
    "events.read",
    "webhooks.manage",
    "reconciliation.write",
    "reviews.read",
    "audit.read",
    "audit.read_all",
    "evidence.read"
  ],
  "event_types_supported": [
    "sgn.grant.approved",
    "sgn.grant.activated",
    "sgn.grant.changed",
    "sgn.grant.expiring",
    "sgn.grant.expired",
    "sgn.grant.revoked",
    "sgn.grant.ended",
    "sgn.principal.owner_changed",
    "sgn.principal.owner_at_risk",
    "sgn.principal.membership_changed",
    "sgn.principal.identity_changed",
    "sgn.person.identity_changed",
    "sgn.client.visibility_changed",
    "sgn.reconciliation.run_completed",
    "sgn.reconciliation.finding_opened",
    "sgn.reconciliation.finding_closed",
    "sgn.review.campaign_opened",
    "sgn.review.campaign_closed",
    "sgn.evidence.checkpoint",
    "sgn.webhook.ping"
  ],
  "cloudevents_specversion": "1.0",
  "ocsf_version": "1.9.0"
}
```

所有網址由參數 `integration.issuer` 推導；參數是空字串時，這兩個 function 與所有需要驗證的整合 function 都丟 `integration_not_configured`。`scopes_supported` 與 `event_types_supported` 讀自資料表。

### 13.2 只給後端使用的 function

| 簽章 | 用途 |
|---|---|
| `integration_record_failure(p_actor bigint, p_token_sha256 bytea, p_function_name text, p_http_status integer, p_error_code text, p_request_id text, p_ip text, p_duration_ms integer) returns void` | 整合端點回應 4xx、5xx 時，後端呼叫它（獨立的交易）。處理見下 |
| `integration_principal_identity_sync(p_actor bigint, p_items jsonb) returns jsonb` | 人員與組織 port 同步被授權者的外部識別碼。`p_items` 是 `[{"principal_id", "provider", "external_id"}]`（`external_id` 為 null 表示移除）；逐筆呼叫 `set_principal_identity` 或 `remove_principal_identity`（`source = 'sync'`）。回傳各筆的結果（`unchanged`、`set`、`removed`、`conflict`）；`conflict`（識別碼已對應到別的被授權者）不套用、寫稽核事件並通知系統管理員 |
| `integration_webhook_claim(p_actor bigint, p_limit integer) returns jsonb` | 領取要送的 webhook（見下） |
| `integration_webhook_report(p_actor bigint, p_subscription_id bigint, p_webhook_id text, p_event_seq bigint, p_http_status integer, p_error_kind text, p_retry_after_seconds integer, p_duration_ms integer) returns void` | 回報一次嘗試的結果（見下） |
| `evidence_checkpoint_claim(p_actor bigint, p_limit integer) returns jsonb` | 領取尚未簽章的檢查點：`[{"checkpoint_id", "payload"}]`，並設定租約 |
| `evidence_checkpoint_attach(p_actor bigint, p_checkpoint_id bigint, p_signature_jws text, p_signing_key_id text, p_tsa_token bytea) returns void` | 寫入簽章，然後發出 `sgn.evidence.checkpoint` 事件。已有簽章時不做任何事 |

`integration_record_failure` 的處理：

1. 以 token 的雜湊找 `api_access_token`（包含已過期的），取得 `api_client`；找不到就是 null。
2. `p_http_status` 是 401 或 403 時，`internal_reason` 取 `sgn_internal.explain_auth_failure` 的結果。
3. 計數與是否寫呼叫紀錄：

| 情況 | 計數 | 寫呼叫紀錄 |
|---|---|---|
| 401（沒有通過驗證；不論 token 找不找得到） | `api_auth_failure_counter` 的 `('ip', sha256(p_ip))`；找得到 `api_client` 時另外累加 `('client', sha256(該系統的代碼))`，並依 4.3 的門檻示警。**不**累加該系統的 `api` 或 `error` 計數：拿著偷來的 token 從別的位址亂試的人，不能讓正牌系統被限流 | 同一個來源位址這一分鐘的次數不超過 `integration.unauth_log_per_ip_per_minute` 時才寫 |
| 429 | `throttled` | 這一分鐘的 `throttled` 次數不超過 `integration.unauth_log_per_ip_per_minute` 時才寫 |
| 其他 400 到 499 | `api` 與 `error`。`error` 這一次剛好達到上限、而且 `error_alerted_at` 是 null 或超過一小時：通知負責人、寫稽核事件（`integration.error_limit_reached`）、更新 `error_alerted_at` | 一律寫 |
| 500 以上 | `api` | 一律寫 |

`integration_webhook_claim` 選出符合下列條件的訂閱（`for update skip locked`，最多 `p_limit` 個）：未刪除；`api_client` 是 `active`；狀態是 `enabled`，或是 `pending_verification` 且 `ping_pending`；`next_attempt_at` 是 null 或已到；`lease_until` 是 null 或已過。對每一個：`ping_pending` 為 true 就送 ping，否則取 `sgn_internal.webhook_next_event`；沒有東西要送就略過。把 `lease_until` 設為現在加上逾時秒數再加 30 秒。回傳：

```json
[
  {
    "subscription_id": 12,
    "endpoint_id": "ep_2fVZdC8Kx9TR4ZoCqHWt3NnL",
    "url": "https://bi.example.com/hooks/sgn",
    "webhook_id": "evt-1042",
    "event_seq": 1042,
    "attempt_no": 1,
    "secret_versions": [3, 2],
    "timeout_seconds": 15,
    "body": "{\"id\": \"evt-1042\", \"data\": {…}, \"time\": \"2026-11-19T02:15:00Z\", \"type\": \"sgn.grant.revoked\", …}"
  }
]
```

`body` 是要送出的確切文字；後端不得重新序列化，直接用它簽章與送出。`secret_versions` 是要用來簽 `v1` 的版本（重疊期間有兩個）。ping 的 `event_seq` 是 null。

`integration_webhook_report` 的處理：

1. 寫一筆 `webhook_attempt`（`p_error_kind` 必須是 11.6 列出的值或 null）。
2. `p_event_seq` 與訂閱目前等待的事件不同（已被別的回報處理）：到此為止。
3. `p_http_status` 在 200 到 299：ping 就清掉 `ping_pending`，並把 `pending_verification` 改為 `enabled`（訂閱有暫存的 `resume_from = 'tail'` 時，同時把 `delivered_seq` 推到目前最新的事件，然後清掉暫存）；事件就把 `delivered_seq` 設為 `p_event_seq`。清掉 `attempt_count`、`next_attempt_at`、`lease_until`，更新 `last_success_at`。
4. `p_http_status` 是 410：`disable_webhook_subscription(…, 'gone')`。
5. 其他：`attempt_count` 加一。達到 `integration.webhook_max_attempts` 就 `disable_webhook_subscription(…, 'delivery_exhausted')`；否則 `next_attempt_at` 設為現在加上 `webhook_retry_delay(attempt_count)`，有 `p_retry_after_seconds` 時取兩者較晚的（上限是重試間隔的上限）。清掉 `lease_until`，更新 `last_failure_at`。

### 13.3 給人使用的 function

回傳物件都帶 `allowed_actions`（登入者對這筆資料可以做的動作），前端依它顯示按鈕。表中的 `sys_admin`、`auditor` 是 2.1 兩個 function 回傳的角色。

需要覆核的動作（4.9）回傳 `{"change_request": {…}, "applied": false}`；不需要覆核而立即套用的回傳 `{"change_request": {…}, "applied": true, "result": {…}}`。

| 簽章 | 誰可以呼叫 | 行為與規則 |
|---|---|---|
| `api_client_list(p_actor bigint) returns jsonb` | `sys_admin`、`auditor` | 全部 `api_client` 的摘要 |
| `api_client_get(p_actor bigint, p_client_id bigint) returns jsonb` | `sys_admin`、`auditor`、該系統的負責人 | 含可見範圍、來源位址、憑證（只有 `secret_hint`、狀態與日期）、訂閱數、進行中的變更申請 |
| `api_client_create(p_actor bigint, p_data jsonb, p_reason text) returns jsonb` | `sys_admin` | 提出登記的變更申請（一律需要覆核）。`p_data`：`code`、`name`、`description`、`owner_person_id`、`identity_provider`、`allowed_providers`、`provider_sgn_reason`、`scopes`、`visibility`（`[{"process_type", "resource_type", "resource_id_prefix"}]`）、`allowed_source_cidrs`、`source_any_reason`、`token_binding`、`constraint_mode`、`constraint_mode_reason`、`allowed_webhook_origins`、`upload_enabled`、`confirm_limited_audit_scope`。檢查依 4.1、4.10：代碼未被使用；負責人在職而且不是提出人；scope 都存在；`audit.read_all` 必須搭配 `audit.read`；`visibility` 至少一列（scope 只包含 `evidence.read`、`audit.read`、`audit.read_all` 時可以沒有）；來源位址與 `advisory` 的條件。`K-INT-CLIENT-AUTH`、`K-INT-DUAL-CONTROL` |
| `api_client_update(p_actor bigint, p_client_id bigint, p_data jsonb, p_reason text) returns jsonb` | `sys_admin` | 可改 `code` 以外的欄位；`visibility` 整組取代。只有收緊時立即套用，否則成為變更申請（4.9 的判斷）。套用時：縮小 scope 立即生效（下一次呼叫就檢查）；從 `allowed_webhook_origins` 移除的來源，對應的訂閱被停用；可見範圍、`identity_provider` 或 `allowed_providers` 有改變時呼叫 `bump_sync_epoch` |
| `api_client_set_status(p_actor bigint, p_client_id bigint, p_status text, p_reason text) returns jsonb` | `sys_admin` | `active` ↔ `suspended`；任何狀態 → `disabled`；`disabled` 不能再改。效果見 4.6 |
| `api_client_credential_create(p_actor bigint, p_client_id bigint, p_expires_at timestamptz, p_reason text) returns jsonb` | `sys_admin`、該系統的負責人 | 提出建立憑證的變更申請（一律需要覆核）。檢查到期日上限與有效憑證數上限。套用時建立一筆待領取的憑證並通知負責人。`K-INT-CRED-EXPIRE` |
| `api_client_credential_claim(p_actor bigint, p_credential_id bigint) returns jsonb` | 只有該系統的負責人（`credential_claim_not_owner`） | 產生密鑰並回傳 `{"credential_id", "client_id", "client_secret", "secret_hint", "expires_at"}`；`client_secret` 只出現這一次。已領取丟 `credential_already_claimed`；超過領取期限或已撤銷丟 `credential_not_claimable`。寫稽核事件 |
| `api_client_credential_revoke(p_actor bigint, p_credential_id bigint, p_reason text) returns void` | `sys_admin`、該系統的負責人 | 撤銷憑證與由它換發的 token |
| `integration_change_request_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor`；其他人只看自己提出的 | 篩選：`status`、`kind` |
| `integration_change_request_get(p_actor bigint, p_request_id bigint) returns jsonb` | 同上 | 含 `payload`、`impact`、與目前設定的差異、各步驟的人與時間 |
| `integration_change_request_approve(p_actor bigint, p_request_id bigint, p_note text) returns jsonb` | 依 4.9：覆核人要有 `sys_admin`；會簽人要有 `auditor` | 登入者符合覆核人的條件、而且還沒有人覆核：記為覆核。登入者有 `auditor`、申請需要會簽而還沒有會簽：記為會簽。兩者（需要時）都完成的那一次，在同一個交易內呼叫 `apply_change_request`。不符合任何一種丟 `change_request_self_approval` 或 `change_request_approver_not_independent` |
| `integration_change_request_reject(p_actor bigint, p_request_id bigint, p_note text) returns jsonb` | 可以覆核或會簽的人 | 說明必填。狀態改為 `rejected` |
| `integration_change_request_withdraw(p_actor bigint, p_request_id bigint, p_note text) returns jsonb` | 提出人 | 狀態改為 `withdrawn` |
| `api_call_log_search(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor` | 篩選：`api_client`、期間、function、狀態碼、`request_id` |
| `integration_status(p_actor bigint) returns jsonb` | `sys_admin`、`auditor` | 設定頁「整合狀態」的資料，內容見下 |
| `webhook_subscription_list(p_actor bigint, p_client_id bigint) returns jsonb` | `sys_admin`、`auditor`、該系統的負責人 | 含最近 20 次嘗試 |
| `webhook_subscription_set_status(p_actor bigint, p_subscription_id bigint, p_status text, p_reason text) returns jsonb` | `sys_admin` | `paused`、`disabled`，以及把 `paused` 改回 `enabled`。把 `disabled` 改回 `enabled` 只能由該系統自己以 7.5 的端點做（要重新驗證） |
| `principal_identity_set(p_actor bigint, p_principal_id bigint, p_provider text, p_external_id text, p_reason text) returns jsonb` | `sys_admin` | 提出變更申請（一律需要覆核；覆核人不得是該被授權者的負責人或成員）。`impact` 帶要取代的舊值、該識別碼目前是否已對應到別的被授權者、相關的未結案對帳發現數。套用時呼叫 `set_principal_identity`。`K-INT-IDENTITY` |
| `principal_identity_remove(p_actor bigint, p_principal_id bigint, p_provider text, p_reason text) returns jsonb` | `sys_admin` | 同上，套用時呼叫 `remove_principal_identity` |
| `reconciliation_run_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor`；負責人只看自己系統的 | |
| `reconciliation_run_get(p_actor bigint, p_run_id bigint) returns jsonb` | 同上 | 含統計、回報內容的雜湊、上傳人與檔案雜湊、產生與結案的發現 |
| `reconciliation_run_upload(p_actor bigint, p_api_client_id bigint, p_scope jsonb, p_observed_at timestamptz, p_items jsonb, p_file_sha256 text, p_reason text) returns jsonb` | 該系統的負責人，而且該系統 `upload_enabled`（否則 `reconciliation_upload_not_allowed`） | 8.9。`p_scope` 是 `{"process_type", "resource_type", "resource_id_prefix"}`。`K-INT-RECON-UPLOAD` |
| `reconciliation_run_review(p_actor bigint, p_run_id bigint, p_decision text, p_note text) returns jsonb` | `sys_admin`，而且不是該系統的負責人、不是這個批次的上傳人 | 8.5 的異常批次。`p_decision` 是 `accept` 或 `discard`；說明必填；批次不是 `needs_review` 丟 `reconciliation_run_not_reviewable`。`K-INT-RECON-ANOMALY` |
| `reconciliation_finding_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor`；負責人與升級對象只看指派給自己的；可以確認的人另外看得到等待自己確認的 | 首頁「待我處理」會用到 |
| `reconciliation_finding_get(p_actor bigint, p_finding_id bigint) returns jsonb` | 同上 | 含歷程 |
| `reconciliation_finding_acknowledge(p_actor bigint, p_finding_id bigint, p_note text) returns jsonb` | 負責人、升級對象 | 填寫處理說明，狀態改為 `acknowledged`。說明必填 |
| `reconciliation_finding_verify(p_actor bigint, p_finding_id bigint, p_result text, p_note text) returns jsonb` | 8.7「獨立確認」列出的人 | `p_result` 是 `confirmed` 或 `rejected`；說明必填。發現不是 `pending_verification` 丟 `finding_not_pending_verification`；登入者不獨立丟 `finding_verifier_not_independent`。`K-INT-RECON-VERIFY` |
| `reconciliation_finding_dismiss(p_actor bigint, p_finding_id bigint, p_reason_code text, p_note text) returns jsonb` | `sys_admin`，而且符合 8.7「人工排除」的獨立條件 | `K-INT-RECON-CLOSE` |
| `access_review_campaign_create(p_actor bigint, p_data jsonb, p_reason text) returns jsonb` | `sys_admin` | 9.1。`starts_at` 已到就立即開始 |
| `access_review_campaign_cancel(p_actor bigint, p_campaign_id bigint, p_reason text) returns jsonb` | `sys_admin` | 9.6。`scheduled` 的立即取消；`open` 的成為變更申請。`K-INT-REVIEW-CANCEL` |
| `access_review_campaign_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor` | |
| `access_review_campaign_get(p_actor bigint, p_campaign_id bigint) returns jsonb` | `sys_admin`、`auditor` | 含統計與全部工作 |
| `access_review_item_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | 任何登入者 | 預設列出「等我處理」的工作：我是複查人、我是複查人目前的代理人、工作交給系統管理員群組而我是 `sys_admin` 且不違反職責分離、或後續追蹤等我確認。`sys_admin`、`auditor` 可以依一輪複查篩選全部。被授權者的負責人另外看得到自己可以填需求確認的工作 |
| `access_review_item_get(p_actor bigint, p_item_id bigint) returns jsonb` | 可以決定這件工作的人、該被授權者的負責人、`sys_admin`、`auditor` | 含授權摘要、目前的權限項目、`snapshot_sha256`、負責人的需求確認、前次複查的決定、是否必須填說明 |
| `access_review_item_attest(p_actor bigint, p_item_id bigint, p_still_needed boolean, p_note text) returns jsonb` | 該授權的被授權者負責人 | 9.2 的需求確認。工作必須是 `pending`；說明必填；可以重填，每次各寫一筆稽核事件 |
| `access_review_item_decide(p_actor bigint, p_item_id bigint, p_decision text, p_note text, p_reduce_spec jsonb, p_snapshot_sha256 text, p_ip text, p_device text) returns jsonb` | 可以決定這件工作的人（做決定時再檢查一次 `review_sod_violation`） | 9.3。`p_reduce_spec` 只在 `reduce` 時給 |
| `access_review_item_decide_batch(p_actor bigint, p_items jsonb, p_note text, p_ip text, p_device text) returns jsonb` | 同上 | `p_items` 是 `[{"item_id", "snapshot_sha256"}]`；決定固定是 `maintain`。逐件檢查（含是否必須填說明），每件各留一筆稽核事件；任何一件不合格，整批失敗 |
| `access_review_followup_confirm(p_actor bigint, p_item_id bigint, p_accept boolean, p_note text) returns jsonb` | 原本做決定的人；他不在職或違反職責分離時是他的直屬主管 | 9.3 第 4 點。追蹤不是 `pending_confirmation` 丟 `review_followup_not_pending_confirmation`；說明必填 |
| `evidence_checkpoint_list(p_actor bigint, p_page jsonb) returns jsonb` | `sys_admin`、`auditor` | 稽核查詢畫面「雜湊鏈驗證」顯示檢查點與簽章狀態 |

`integration_status` 的內容：

- 每個系統：狀態、負責人、憑證到期日、待領取的憑證、最後呼叫時間、近 24 小時的呼叫數與錯誤數、`no_entitlement` 的比例、今天查詢的不同主體數（超過 `integration.distinct_subjects_alert_per_day` 時標示，並在第一次超過時通知系統管理員、寫稽核事件）、驗證失敗示警、失敗上限示警、近 30 天第一次出現的來源位址、`constraint_mode`、訂閱狀態、最後完成的對帳與是否逾期、8.8 的對帳統計、未結案與等待確認的發現數。
- 全域：最新檢查點、尚未簽章的檢查點數、簽章是否停擺（10.4）、尚未封存的呼叫紀錄筆數、等待覆核的變更申請數、最近一次投影不一致的時間（2.2）、用量超出核准的筆數（5.7）、系統管理員是否只有一位（4.9）。

## 14. REST 端點

### 14.1 給其他系統的端點

共 31 個。路徑固定，不加本站的 `/api` 前綴。除註明外：請求與回應都是 `application/json`；需要 `Authorization: Bearer <token>`；回應帶 `Cache-Control: no-store` 與 `X-Request-ID`。

`X-Request-ID`：請求帶的值符合 `^[A-Za-z0-9._-]{1,64}$` 時原樣回傳並寫進呼叫紀錄；沒有帶、或不符合這個格式時，後端捨棄它並自己產生一個（UUID）。不符合格式的值不會出現在回應、紀錄或任何匯出裡。

| # | 方法與路徑 | function | scope | 成功 | 請求與回應 |
|---|---|---|---|---|---|
| 1 | `POST /integration/v1/oauth/token` | `integration_token_issue` | —（Basic 驗證） | 200 | 4.3。請求是 `application/x-www-form-urlencoded` |
| 2 | `GET /.well-known/authzen-configuration/integration/v1` | `integration_authzen_metadata` | 公開 | 200 | 5.1。帶 `Cache-Control: max-age=3600` |
| 3 | `GET /integration/v1` | `integration_discovery` | 公開 | 200 | 13.1。帶 `Cache-Control: max-age=3600` |
| 4 | `GET /integration/v1/jwks.json` | 無（後端從部署設定產生） | 公開 | 200 | 10.4。帶 `Cache-Control: max-age=3600` |
| 5 | `POST /integration/v1/access/v1/evaluation` | `integration_check` | `check` | 200 | 5.2 |
| 6 | `POST /integration/v1/access/v1/evaluations` | `integration_check_batch` | `check` | 200 | 5.4 |
| 7 | `POST /integration/v1/grants/{entitlement_id}/usage` | `integration_usage_report` | `usage.write` | 201（相同的 `usage_key` 重送是 200） | 5.7 |
| 8 | `GET /integration/v1/grants` | `integration_grants_list` | `grants.read` | 200 | 6.2 到 6.4 |
| 9 | `GET /integration/v1/grants/{entitlement_id}` | `integration_grant_get` | `grants.read` | 200 | 6.3 的單筆 |
| 10 | `GET /integration/v1/principals/{subject_id}/members` | `integration_principal_members` | `grants.read` | 200 | 6.5 |
| 11 | `GET /integration/v1/events` | `integration_events_list` | `events.read` | 200 | 7.3 |
| 12 | `GET /integration/v1/webhooks` | `integration_webhook_list` | `webhooks.manage` | 200 | `{"items": [訂閱…]}`（不含 `secret`） |
| 13 | `POST /integration/v1/webhooks` | `integration_webhook_create` | `webhooks.manage` | 201 | 7.5 |
| 14 | `GET /integration/v1/webhooks/{endpoint_id}` | `integration_webhook_get` | `webhooks.manage` | 200 | 訂閱（不含 `secret`） |
| 15 | `PATCH /integration/v1/webhooks/{endpoint_id}` | `integration_webhook_update` | `webhooks.manage` | 200 | 請求：`event_types`、`description`、`status`、`resume_from` 的任意組合。回應：訂閱 |
| 16 | `DELETE /integration/v1/webhooks/{endpoint_id}` | `integration_webhook_delete` | `webhooks.manage` | 204 | — |
| 17 | `POST /integration/v1/webhooks/{endpoint_id}/rotate-secret` | `integration_webhook_rotate_secret` | `webhooks.manage` | 200 | 回應：訂閱加 `secret` |
| 18 | `POST /integration/v1/webhooks/{endpoint_id}/ping` | `integration_webhook_ping` | `webhooks.manage` | 202 | 回應：訂閱 |
| 19 | `POST /integration/v1/reconciliation/runs` | `integration_reconciliation_run_create` | `reconciliation.write` | 201 | 8.2 |
| 20 | `POST /integration/v1/reconciliation/runs/{run_id}/items` | `integration_reconciliation_items_add` | `reconciliation.write` | 200 | 8.3。請求內容上限 2 MB |
| 21 | `POST /integration/v1/reconciliation/runs/{run_id}/complete` | `integration_reconciliation_run_complete` | `reconciliation.write` | 202 | 8.4 |
| 22 | `GET /integration/v1/reconciliation/runs/{run_id}` | `integration_reconciliation_run_get` | `reconciliation.write` | 200 | 8.2 的批次；`summary` 是 `{"items": {"covered", "tolerated", "exceeds_approved", "ended_still_present", "unapproved"}, "missing", "subject_unresolved", "findings_opened", "findings_continued", "findings_pending_verification", "findings_resolved", "anomalous"}` |
| 23 | `GET /integration/v1/reconciliation/findings` | `integration_reconciliation_findings_list` | `reconciliation.write` | 200 | `{"items": [8.6 的發現…], "next_page_token"}` |
| 24 | `GET /integration/v1/reviews/campaigns` | `integration_reviews_list` | `reviews.read` | 200 | `{"items": [{"review_no", "name", "process_type", "status", "starts_at", "due_at", "item_count", "summary", "redacted"}], "next_page_token"}` |
| 25 | `GET /integration/v1/reviews/campaigns/{review_no}` | `integration_review_get` | `reviews.read` | 200 | 上列欄位，加 `reviewer_kind`、`no_response_action`、`loosened`、`result_sha256`、`items`：`[{"item_id", "grant_id", "case_no", "subject", "scope_ref", "reviewer", "status", "decision", "decided_by", "decided_on_behalf_of", "decided_at", "reassign_reason", "followup_status", "snapshot_sha256"}]` |
| 26 | `GET /integration/v1/audit/events` | `integration_audit_events_list` | `audit.read` | 200 | 10.2、10.3 |
| 27 | `GET /integration/v1/audit/calls` | `integration_audit_calls_list` | `audit.read_all` | 200 | 10.3：`{"items": […], "next_cursor", "has_more"}` |
| 28 | `GET /integration/v1/evidence/chain` | `integration_evidence_chain` | `evidence.read` | 200 | 13.1 |
| 29 | `GET /integration/v1/evidence/chain-head` | `integration_evidence_chain_head` | `evidence.read` | 200 | 10.4 |
| 30 | `GET /integration/v1/evidence/checkpoints` | `integration_evidence_checkpoints_list` | `evidence.read` | 200 | `{"items": [10.4 的檢查點…], "next_cursor", "has_more"}` |
| 31 | `GET /integration/v1/evidence/checkpoints/{checkpoint_id}` | `integration_evidence_checkpoint_get` | `evidence.read` | 200 | 10.4 的檢查點 |

所有需要 token 的端點共通的錯誤（內容是 `{"code", "message"}`）：

| HTTP | `code` | 情況 | 額外的標頭 |
|---|---|---|---|
| 400 | `integration_invalid_request` | 內容不是合法的 JSON 物件、欄位缺少或格式不符 | — |
| 401 | `integration_invalid_token` | 沒有 token、token 不存在或過期、`api_client` 不是 `active`、來源位址不被允許或與 token 綁定的位址不同（各種原因對外相同） | `WWW-Authenticate: Bearer realm="sgn-integration", error="invalid_token"` |
| 403 | `integration_insufficient_scope` | token 沒有這個端點需要的 scope | `WWW-Authenticate: Bearer realm="sgn-integration", error="insufficient_scope", scope="<需要的 scope>"` |
| 404 | `integration_not_found` | 指定的東西不存在，或不在可見範圍（兩者不區分） | — |
| 413 | `payload_too_large` | 請求內容超過上限（預設 256 KB；上傳對帳項目 2 MB） | — |
| 429 | `integration_rate_limited` | 超過速率限制（呼叫數、失敗數或 webhook 管理次數，見 4.8） | `Retry-After` |
| 503 | `integration_not_configured` | 參數 `integration.issuer` 尚未設定 | — |

個別端點另外的錯誤：

| `code` | HTTP | 端點 | 情況 |
|---|---|---|---|
| `integration_too_many_evaluations` | 400 | #6 | 筆數超過上限 |
| `integration_cursor_invalid` | 400 | #8、#10、#11、#23、#24、#26、#27、#28、#30 | 游標格式錯誤 |
| `integration_resync_required` | 409 | #8、#10、#11 | 游標是在可見範圍或身分來源改變之前發出的（4.5） |
| `usage_key_conflict` | 409 | #7 | 相同的 `usage_key`，內容不同 |
| `usage_entitlement_not_active` | 409 | #7 | 權限項目已結束超過容許的時間，或尚未生效 |
| `usage_limit_reached` | 409 | #7 | 這筆權限項目的用量紀錄已達上限 |
| `webhook_origin_not_allowed` | 400 | #13 | 網址的來源不在允許清單 |
| `webhook_subscription_limit` | 409 | #13 | 訂閱數已達上限 |
| `webhook_status_invalid` | 409 | #15、#18 | 不允許的狀態轉移（7.5 的表）；對 `disabled` 的訂閱送 ping |
| `integration_scope_not_visible` | 403 | #19 | 宣告的範圍超出可見範圍 |
| `integration_invalid_request` | 400 | #19 | `observed_at` 不在允許的範圍；`message` 帶允許的最早時間 |
| `reconciliation_run_limit` | 429 | #19 | 超過每天的批次數或進行中的批次數；帶 `Retry-After`（進行中的批次數超過時是 60） |
| `reconciliation_item_out_of_scope` | 400 | #20 | 有項目超出批次宣告的範圍 |
| `reconciliation_too_many_items` | 400 | #20 | 超過單次或整個批次的筆數上限 |
| `reconciliation_run_not_collecting` | 409 | #20、#21 | 批次已不是 `collecting`（含被新批次取代而成為 `abandoned`；以 #22 查 `status` 與 `superseded_by`） |
| `reconciliation_item_count_mismatch` | 409 | #21 | 宣告的筆數與收到的不同 |

已刪除的訂閱對 #14 到 #18 都是 404。#11 的 `after` 超過目前最新位置時回 200 與空陣列（7.3）。

後端為這些端點需要的機制（都只是機制，不含業務判斷）：

- 路由表的每一列多三個欄位：`auth: 'client'`（從標頭取出 token、做 SHA-256、當作第二個參數；`p_actor` 傳 null；結尾補上請求識別碼與來源 IP）、`bodyLimit`、`decorate`（只有 #13 與 #17 是 `'webhook_secret'`：把回應的 `secret_version` 換成推導出來的 `secret`）。
- 來源 IP 依 4.10 的規則取得（部署設定 `TRUSTED_PROXY_CIDRS`），所有整合端點共用同一個函式。
- 請求識別碼依上面的規則驗證或產生。
- 整合端點的錯誤處理：回應任何 4xx、5xx 之後，以獨立的交易呼叫 `integration_record_failure`；401、403 加上 `WWW-Authenticate`；429 加上 `Retry-After`（到下一個視窗的秒數）。
- #1 是專屬的 handler：解析 Basic 標頭與表單、把密鑰做 SHA-256、呼叫 function、依回傳的 `http_status` 回應，401 時加上 `WWW-Authenticate: Basic realm="sgn-integration"`。
- #4 由後端直接產生。
- 兩個 worker：webhook 推送（連線規定見 7.6）、檢查點簽章。兩個 port：`Signer`（Ed25519 簽章與公鑰輸出、webhook 密鑰推導）、`TimestampAuthority`（RFC 3161；沒有設定時不啟用）。各有一個模擬 adapter 與合約測試。
- 人員與組織 port 的同步在取得被授權者的外部識別碼之後呼叫 `integration_principal_identity_sync`。
- 排程入口呼叫 15.4 的工作時，每一個工作、每一次呼叫各用一個交易；工作回傳 `{"more": true}` 時立即再呼叫同一個工作，一輪最多 `integration.job_repeat_max` 次。
- 部署設定（定義在 `api/src/config.ts`）：簽章私鑰清單、webhook 主金鑰、時間戳記服務網址、兩個 worker 的開關與間隔、`TRUSTED_PROXY_CIDRS`、`WEBHOOK_BLOCKED_CIDRS`、`WEBHOOK_ALLOW_PRIVATE`。

### 14.2 給人使用的端點

共 39 個，每個對應 13.3 的一個 function。路徑加本站的 API 前綴，以登入的工作階段驗證，角色在 function 裡檢查。

| 方法與路徑 | function |
|---|---|
| `GET /integration/clients` | `api_client_list` |
| `GET /integration/clients/:id` | `api_client_get` |
| `POST /integration/clients` | `api_client_create` |
| `PATCH /integration/clients/:id` | `api_client_update` |
| `POST /integration/clients/:id/status` | `api_client_set_status` |
| `POST /integration/clients/:id/credentials` | `api_client_credential_create` |
| `POST /integration/credentials/:id/claim` | `api_client_credential_claim` |
| `POST /integration/credentials/:id/revoke` | `api_client_credential_revoke` |
| `GET /integration/change-requests` | `integration_change_request_list` |
| `GET /integration/change-requests/:id` | `integration_change_request_get` |
| `POST /integration/change-requests/:id/approve`（需要 MFA，條件同簽核決定） | `integration_change_request_approve` |
| `POST /integration/change-requests/:id/reject` | `integration_change_request_reject` |
| `POST /integration/change-requests/:id/withdraw` | `integration_change_request_withdraw` |
| `GET /integration/call-log` | `api_call_log_search` |
| `GET /integration/status` | `integration_status` |
| `GET /integration/clients/:id/webhooks` | `webhook_subscription_list` |
| `POST /integration/webhooks/:id/status` | `webhook_subscription_set_status` |
| `PUT /principals/:id/identities/:provider` | `principal_identity_set` |
| `DELETE /principals/:id/identities/:provider` | `principal_identity_remove` |
| `GET /reconciliation/runs` | `reconciliation_run_list` |
| `GET /reconciliation/runs/:id` | `reconciliation_run_get` |
| `POST /reconciliation/runs/upload`（`multipart/form-data`；檔案上限 20 MB；後端依 8.9 轉換） | `reconciliation_run_upload` |
| `POST /reconciliation/runs/:id/review` | `reconciliation_run_review` |
| `GET /reconciliation/findings` | `reconciliation_finding_list` |
| `GET /reconciliation/findings/:id` | `reconciliation_finding_get` |
| `POST /reconciliation/findings/:id/acknowledge` | `reconciliation_finding_acknowledge` |
| `POST /reconciliation/findings/:id/verify` | `reconciliation_finding_verify` |
| `POST /reconciliation/findings/:id/dismiss` | `reconciliation_finding_dismiss` |
| `POST /access-reviews/campaigns` | `access_review_campaign_create` |
| `POST /access-reviews/campaigns/:id/cancel` | `access_review_campaign_cancel` |
| `GET /access-reviews/campaigns` | `access_review_campaign_list` |
| `GET /access-reviews/campaigns/:id` | `access_review_campaign_get` |
| `GET /access-reviews/items` | `access_review_item_list` |
| `GET /access-reviews/items/:id` | `access_review_item_get` |
| `POST /access-reviews/items/:id/attest` | `access_review_item_attest` |
| `POST /access-reviews/items/:id/decide`（需要 MFA，條件同簽核決定） | `access_review_item_decide` |
| `POST /access-reviews/items/decide-batch`（需要 MFA，條件同簽核決定） | `access_review_item_decide_batch` |
| `POST /access-reviews/items/:id/followup-confirm` | `access_review_followup_confirm` |
| `GET /evidence/checkpoints` | `evidence_checkpoint_list` |

這些端點的畫面（設定頁的整合狀態、系統管理與變更申請、首頁的複查工作與對帳發現、對帳檔案上傳、稽核查詢的檢查點）由畫面契約定義；本文件只固定資料與規則。畫面契約的驗收條件要包含 3.7 最後一列（來自其他系統的文字一律當純文字，CSV 匯出要跳脫）。

## 15. 規則、錯誤、參數、排程

### 15.1 規則代碼

全部登記在 `sgn.rule`，所屬流程包為空（核心規則）。每一條至少一個資料庫測試，測試名稱包含代碼。

| 代碼 | 規則 |
|---|---|
| `K-INT-CLIENT-AUTH` | 整合介面只接受登記過、啟用中的 `api_client`，以未過期的 token 呼叫；每次呼叫都檢查狀態與 scope。登記、修改、停用要填原因並留紀錄 |
| `K-INT-CLIENT-OWNER` | 每個 `api_client` 隨時要有在職的負責人；負責人異動給寬限期改派，逾期暫停 |
| `K-INT-CLIENT-SOURCE` | 換發 token 與每次呼叫的來源位址必須在登記的清單內；token 綁定換發時的位址；新的來源位址通知負責人 |
| `K-INT-CRED-EXPIRE` | 憑證一定有到期日，不得超過上限；到期前提醒，到期失效；密鑰只有系統的負責人領得到 |
| `K-INT-DUAL-CONTROL` | 登記系統、擴大系統的權限、建立憑證、改被授權者的外部識別碼、取消進行中的複查，都要由提出人以外、與對象沒有利害關係的人覆核；`audit.read_all` 另需稽核角色會簽 |
| `K-INT-IDENTITY` | 被授權者的外部識別碼只能由身分同步或經覆核的變更申請寫入；每次改變都留紀錄、發事件，並阻止相關的對帳發現自動結案 |
| `K-INT-VISIBILITY` | 呼叫方只能取得可見範圍內的資料；範圍外與不存在的回應相同 |
| `K-INT-SYNC-EPOCH` | 可見範圍或身分來源改變後，舊的游標一律失效，使用方必須重做快照 |
| `K-INT-CALL-LOG` | 每次已驗證的呼叫都留紀錄；紀錄只增不改；每個檢查點之前把紀錄的雜湊寫入稽核鏈 |
| `K-INT-RATE-LIMIT` | 每個 `api_client` 的呼叫數、失敗數、管理動作數都有上限；失敗的請求也計數 |
| `K-INT-AUTH-ALERT` | 驗證失敗與成功分開計數；失敗不影響正確憑證的使用；連續失敗達門檻時通知負責人 |
| `K-INT-PROJECT` | 權限項目由核心資料表上的觸發程序在同一個交易內同步；判定與查詢只讀整理好的權限項目 |
| `K-INT-CONSISTENCY` | 排程持續比對權限項目與申請單、授權、主體的狀態；不一致時立即修正、留紀錄並通知稽核 |
| `K-INT-CHECK` | 判定預設拒絕：找不到有效的權限項目就拒絕；限制條件無法驗證就拒絕；到期時間一到就拒絕；授權或主體已失效就拒絕 |
| `K-INT-CHECK-BASIS` | 每個判定結果都附原因；允許的結果一定附依據的權限項目、申請單與完整的限制條件 |
| `K-INT-CONSTRAINT-MODE` | 預設嚴格：核准的限制面向沒有出現在請求裡就拒絕；只有登記為 `advisory` 並納入對帳的系統例外 |
| `K-INT-USAGE` | 使用方回報的實際使用只增不改、留紀錄，並納入之後的判定；超出核准的使用列為例外 |
| `K-INT-EVENT-ORDER` | 事件序號與提交順序一致；至少送達一次；每個訂閱依序推送；事件的鎖只在交易的最後持有 |
| `K-INT-EXPIRING` | 授權到期前依參數發出即將到期的事件，同一個到期日只發一次 |
| `K-INT-WEBHOOK-DISABLE` | 重試用盡、收到 410、來源不再被允許、或系統被停用時，停用訂閱並通知 |
| `K-INT-RECON-COMPARE` | 對帳依固定的演算法分段比對，產生發現；每個批次留下統計與雜湊 |
| `K-INT-RECON-ANOMALY` | 一個批次的新發現超過上限時整批暫停，由非負責人檢視後放行或作廢；批次數有上限 |
| `K-INT-RECON-ASSIGN` | 發現指派給回報系統的負責人，依嚴重度設定期限；換主體回報不會重新計時 |
| `K-INT-RECON-SLA` | 發現逾期升級給負責人的直屬主管並通知稽核 |
| `K-INT-RECON-VERIFY` | 高嚴重度的發現在回報方表示已消失之後，要由獨立的人確認才結案 |
| `K-INT-RECON-CLOSE` | 發現只能由批次的證據（限低嚴重度）、獨立確認、或由無利害關係的系統管理員以指定原因排除 |
| `K-INT-RECON-OVERDUE` | 應回報的系統逾期沒有完成對帳，通知負責人並留紀錄 |
| `K-INT-RECON-UPLOAD` | 沒有 API 的系統由負責人上傳權限清單對帳；批次記下上傳人與檔案雜湊，其餘與 API 的批次相同 |
| `K-INT-REVIEW-SCHEDULE` | 依參數定期建立複查 |
| `K-INT-REVIEW-SOD` | 複查人不得是該授權的申請人、主體本人或主體的成員；違反時改由上一層主管 |
| `K-INT-REVIEW-DECIDE` | 複查決定綁定當時的權限項目內容；決定後不可更改；代理與手機 MFA 的規則同簽核 |
| `K-INT-REVIEW-REVOKE` | 複查決定撤銷時，立即撤銷整筆授權 |
| `K-INT-REVIEW-REDUCE` | 複查決定縮小時要指明縮小什麼；期限內沒有照做並經確認，就自動撤銷 |
| `K-INT-REVIEW-NO-RESPONSE` | 複查不回應：提醒、升級；仍不回應時依設定自動撤銷或列為例外；放寬設定要留紀錄並通知稽核 |
| `K-INT-REVIEW-CANCEL` | 取消進行中的複查要經無利害關係的第二人覆核；未決定的工作逐件留紀錄並列為例外 |
| `K-INT-CHECKPOINT` | 定期產生稽核鏈的檢查點並簽章，送到平台以外保存 |
| `K-INT-CHECKPOINT-STALE` | 鏈頭前進而超過兩個間隔沒有新的已簽章檢查點時，通知稽核並留紀錄 |

### 15.2 錯誤代碼

全部登記在 `sgn.error_catalog`。SQLSTATE 依核心對各 HTTP 狀態的配置規則指派。

| 代碼 | HTTP | 訊息 |
|---|---|---|
| `integration_invalid_request` | 400 | 請求格式不正確 |
| `integration_too_many_evaluations` | 400 | 一次判定的筆數超過上限 |
| `integration_cursor_invalid` | 400 | 游標不正確 |
| `integration_resync_required` | 409 | 可見範圍或身分來源已改變，請重新做完整同步 |
| `integration_invalid_token` | 401 | 驗證失敗 |
| `integration_insufficient_scope` | 403 | 這個系統沒有使用這項功能的權限 |
| `integration_scope_not_visible` | 403 | 宣告的範圍超出這個系統的可見範圍 |
| `integration_not_found` | 404 | 找不到指定的資料 |
| `integration_rate_limited` | 429 | 呼叫太頻繁，請稍後再試 |
| `integration_not_configured` | 503 | 整合介面尚未設定 |
| `entitlement_hook_invalid` | 500 | 流程包回傳的權限描述格式不正確 |
| `entitlement_duplicate_resource` | 500 | 流程包回傳的權限描述有重複的資源 |
| `usage_key_conflict` | 409 | 這個回報鍵已經用於不同的內容 |
| `usage_entitlement_not_active` | 409 | 這筆權限目前不接受使用回報 |
| `usage_limit_reached` | 409 | 這筆權限的使用回報筆數已達上限 |
| `webhook_origin_not_allowed` | 400 | 這個網址的來源不在允許清單內 |
| `webhook_subscription_limit` | 409 | 訂閱數已達上限 |
| `webhook_status_invalid` | 409 | 目前的狀態不能做這個變更 |
| `reconciliation_item_out_of_scope` | 400 | 有項目超出這個批次宣告的範圍 |
| `reconciliation_too_many_items` | 400 | 項目數超過上限 |
| `reconciliation_run_not_collecting` | 409 | 這個批次已經不能再上傳 |
| `reconciliation_item_count_mismatch` | 409 | 宣告的筆數與收到的筆數不同 |
| `reconciliation_run_limit` | 429 | 對帳批次數已達上限，請稍後再試 |
| `reconciliation_run_not_reviewable` | 409 | 這個批次目前不需要檢視 |
| `reconciliation_upload_not_allowed` | 403 | 只有這個系統的負責人可以上傳，而且系統必須開啟檔案上傳 |
| `reconciliation_upload_invalid` | 400 | 上傳的清單格式不正確 |
| `api_client_not_found` | 404 | 找不到這個系統 |
| `api_client_code_taken` | 409 | 這個系統代碼已被使用 |
| `api_client_owner_inactive` | 409 | 負責人必須是在職人員 |
| `api_client_owner_is_proposer` | 409 | 負責人不能是提出登記的人 |
| `api_client_scope_unknown` | 400 | 有不存在的可用範圍 |
| `api_client_status_invalid` | 409 | 目前的狀態不能做這個變更 |
| `api_client_source_required` | 400 | 請登記允許的來源位址；這個系統的權限不允許不限來源 |
| `api_client_advisory_requires_reconciliation` | 400 | 自行套用限制條件的系統必須納入對帳 |
| `api_client_credential_limit` | 409 | 有效的憑證數已達上限 |
| `api_client_credential_expiry_invalid` | 400 | 到期日超過允許的上限 |
| `credential_claim_not_owner` | 403 | 只有這個系統的負責人可以領取密鑰 |
| `credential_already_claimed` | 409 | 這個密鑰已經領取過 |
| `credential_not_claimable` | 409 | 這個憑證已撤銷或超過領取期限 |
| `integration_reason_required` | 400 | 請填寫原因 |
| `change_request_not_found` | 404 | 找不到這筆變更申請 |
| `change_request_status_invalid` | 409 | 這筆變更申請已經結束 |
| `change_request_duplicate` | 409 | 同一個對象已有等待覆核的變更申請 |
| `change_request_self_approval` | 403 | 不能覆核自己提出的變更申請 |
| `change_request_approver_not_independent` | 403 | 你與這筆變更的對象有關，不能覆核 |
| `principal_identity_taken` | 409 | 這個外部識別碼已對應到其他被授權者 |
| `finding_not_found` | 404 | 找不到這筆對帳發現 |
| `finding_not_assignee` | 403 | 只有負責人可以回應這筆發現 |
| `finding_dismiss_by_assignee` | 403 | 與這筆發現有關的人不能排除它 |
| `finding_already_closed` | 409 | 這筆發現已結案 |
| `finding_not_pending_verification` | 409 | 這筆發現目前不需要確認 |
| `finding_verifier_not_independent` | 403 | 你與這筆發現有關，不能確認 |
| `review_campaign_not_found` | 404 | 找不到這一輪複查 |
| `review_campaign_invalid` | 400 | 複查的設定不正確 |
| `review_campaign_status_invalid` | 409 | 目前的狀態不能做這個變更 |
| `review_item_not_found` | 404 | 找不到這件複查工作 |
| `review_item_not_reviewer` | 403 | 你不能決定這件複查工作 |
| `review_item_already_decided` | 409 | 這件工作已經決定 |
| `review_item_changed` | 409 | 授權內容已改變，請重新檢視後再決定 |
| `review_note_required` | 400 | 請填寫說明 |
| `review_reduce_spec_invalid` | 400 | 請指明要縮小的項目 |
| `review_revoke_not_allowed` | 409 | 這種流程的授權不能撤銷 |
| `review_attest_not_owner` | 403 | 只有被授權者的負責人可以填寫需求確認 |
| `review_followup_not_pending_confirmation` | 409 | 這件工作目前不需要確認 |

### 15.3 參數

全部登記在 `sgn.setting_definition`，所屬流程包為空。

| key | 型別與單位 | 預設 | 允許範圍 | 可依什麼設定不同的值 |
|---|---|---|---|---|
| `integration.issuer` | 文字（網址） | 空字串 | `https` 網址，無查詢字串與 fragment，結尾無 `/` | — |
| `integration.access_token_ttl_seconds` | 整數，秒 | 600 | 60–3600 | — |
| `integration.credential_max_age_days` | 整數，天 | 365 | 30–730 | — |
| `integration.credential_remind_before_days` | 整數，天 | 30 | 1–90 | — |
| `integration.credential_max_active` | 整數 | 2 | 1–3 | — |
| `integration.credential_claim_hours` | 整數，小時 | 72 | 1–336 | — |
| `integration.client_owner_grace_days` | 整數，天 | 14 | 1–60 | — |
| `integration.change_request_expire_days` | 整數，天 | 14 | 1–60 | — |
| `integration.rate_limit_per_minute` | 整數 | 600 | 1–6000 | `scope_ref`（`api_client:<code>`） |
| `integration.error_limit_per_minute` | 整數 | 60 | 1–6000 | `scope_ref`（`api_client:<code>`） |
| `integration.token_rate_limit_per_minute` | 整數（只計密鑰正確的換發） | 10 | 1–60 | — |
| `integration.auth_failure_alert_per_minute` | 整數 | 20 | 1–1000 | — |
| `integration.unauth_log_per_ip_per_minute` | 整數 | 10 | 1–100 | — |
| `integration.distinct_subjects_alert_per_day` | 整數 | 2000 | 1–1000000 | `scope_ref`（`api_client:<code>`） |
| `integration.check_max_evaluations` | 整數 | 100 | 1–500 | — |
| `integration.decision_ttl_seconds` | 整數，秒 | 60 | 0–300 | 流程類型 |
| `integration.deny_ttl_seconds` | 整數，秒 | 30 | 0–300 | — |
| `integration.check_ended_lookback_days` | 整數，天 | 30 | 0–365 | — |
| `integration.fulfilment_permit_max_hours` | 整數，小時 | 72 | 1–720 | 流程類型、級別 |
| `integration.usage_max_per_entitlement` | 整數 | 100 | 1–1000 | 流程類型 |
| `integration.usage_late_hours` | 整數，小時 | 24 | 0–168 | — |
| `integration.page_size_default` | 整數 | 100 | 1–500 | — |
| `integration.page_size_max` | 整數 | 500 | 1–1000 | — |
| `integration.call_log_retention_days` | 整數，天 | 400 | 30–3650 | — |
| `integration.job_repeat_max` | 整數 | 20 | 1–200 | — |
| `integration.webhook_max_per_client` | 整數 | 5 | 1–20 | — |
| `integration.webhook_manage_limit_per_hour` | 整數 | 20 | 1–200 | — |
| `integration.webhook_allow_http` | 布林 | false | — | — |
| `integration.webhook_timeout_seconds` | 整數，秒 | 15 | 5–30 | — |
| `integration.webhook_max_attempts` | 整數 | 10 | 1–20 | — |
| `integration.webhook_retry_base_seconds` | 整數，秒 | 5 | 1–600 | — |
| `integration.webhook_retry_factor` | 整數 | 6 | 2–10 | — |
| `integration.webhook_retry_cap_seconds` | 整數，秒 | 86400 | 60–86400 | — |
| `integration.webhook_secret_overlap_hours` | 整數，小時 | 24 | 1–168 | — |
| `reconciliation.expected_interval_days` | 整數，天 | 7 | 1–90 | `scope_ref`（`api_client:<code>`） |
| `reconciliation.grace_minutes` | 整數，分鐘 | 60 | 0–1440 | 流程類型 |
| `reconciliation.observed_max_age_minutes` | 整數，分鐘 | 60 | 5–1440 | — |
| `reconciliation.upload_observed_max_age_hours` | 整數，小時 | 24 | 1–168 | — |
| `reconciliation.collect_timeout_hours` | 整數，小時 | 24 | 1–72 | — |
| `reconciliation.max_items` | 整數 | 200000 | 1–1000000 | — |
| `reconciliation.items_per_request_max` | 整數 | 1000 | 1–5000 | — |
| `reconciliation.max_runs_per_day` | 整數 | 24 | 1–288 | `scope_ref`（`api_client:<code>`） |
| `reconciliation.max_open_runs` | 整數 | 2 | 1–10 | — |
| `reconciliation.max_new_findings_per_run` | 整數 | 200 | 1–100000 | `scope_ref`（`api_client:<code>`） |
| `reconciliation.compare_batch_size` | 整數 | 500 | 50–5000 | — |
| `reconciliation.findings_batch_size` | 整數 | 50 | 10–200 | — |
| `reconciliation.item_retention_days` | 整數，天 | 400 | 30–3650 | — |
| `reconciliation.finding_due_workdays_high` | 整數，工作天 | 2 | 1–30 | 流程類型 |
| `reconciliation.finding_due_workdays_low` | 整數，工作天 | 5 | 1–60 | 流程類型 |
| `reconciliation.verification_due_workdays` | 整數，工作天 | 5 | 1–30 | 流程類型 |
| `reconciliation.verifier_role` | 文字（角色代碼；空字串表示只有系統管理員可以確認） | 空字串 | 存在的範圍角色代碼 | 流程類型 |
| `review.interval_months` | 整數，月（0 表示不自動建立） | 0 | 0–24 | 流程類型 |
| `review.duration_days` | 整數，天 | 14 | 3–60 | 流程類型 |
| `review.remind_before_days` | 整數，天 | 3 | 1–14 | — |
| `review.escalation_workdays` | 整數，工作天 | 5 | 1–20 | 流程類型 |
| `review.no_response_action` | 列舉 `revoke`／`escalate_only` | `revoke` | — | 流程類型 |
| `review.reduce_followup_workdays` | 整數，工作天 | 10 | 1–30 | 流程類型 |
| `review.maintain_note_required` | 布林 | false | — | 流程類型、級別 |
| `review.maintain_note_after_months` | 整數，月（0 表示不啟用） | 12 | 0–120 | 流程類型 |
| `evidence.checkpoint_interval_minutes` | 整數，分鐘 | 60 | 5–1440 | — |
| `evidence.checkpoint_stale_intervals` | 整數 | 2 | 1–24 | — |
| `evidence.checkpoint_mail_enabled` | 布林 | true | — | — |
| `evidence.audit_page_size_max` | 整數 | 1000 | 100–5000 | — |

`integration.decision_ttl_seconds` 與 `integration.deny_ttl_seconds` 的上限是 300 秒：撤銷之後，沒有訂閱事件的系統最久五分鐘內會反映。

沿用核心的參數：`validity.remind_before_days`（即將到期事件的天數）、`audit.retention_years`、⟨`system.business_timezone`⟩（2.1）。

每個規則做決定時用到的參數值，照工程規範記進該筆稽核事件的參數快照。

### 15.4 排程工作

七個工作由核心的排程入口每一輪依下表的順序呼叫，各自決定這一輪要不要做事，執行結果寫入 `scheduler_run`。每個工作的每一次呼叫是一個獨立的交易；工作回傳的 jsonb 帶 `"more": true` 時，排程入口立即再呼叫同一個工作（一輪最多 `integration.job_repeat_max` 次）。後端的兩個 worker 不在此列。

| 順序 | function | 內容 | 規則 |
|---|---|---|---|
| 1 | `job_integration_consistency` | (1) 時間造成的改變：被授權者的結束日已到而權限項目還沒結束的申請單，呼叫 `project_case`（這是正常情況，不示警；項目改為 `ended`，原因 `subject_inactive`，並發出 `sgn.grant.ended`）。一次性許可逾時不改儲存的狀態：判定已經依 `effective_until` 拒絕，申請單往下走時才會變成 `ended`。(2) 以集合查詢找出不一致：權限項目未結束而 `grant` 不是 `active`、申請單已在結束的狀態、或主體已失效；`grant` 是 `active` 而該申請單沒有任何未結束的權限項目（流程類型有登記 `describe_entitlements`，而且不是因 `subject_inactive` 結束）；權限項目的有效期間與 `grant`、被授權者結束日推導的不同。找到的每一張單：重投影、寫稽核事件（`integration.projection_repaired`）、通知稽核角色（同一輪合併成一則通知）。每次呼叫最多處理 500 張單，還有就回 `more` | `K-INT-CONSISTENCY`、`K-INT-PROJECT` |
| 2 | `job_integration_expiring` | 找出 `active` 而且 `effective_until` 在 `validity.remind_before_days` 天內的權限項目；以申請單為單位，同一個到期日還沒發過就發 `sgn.grant.expiring` | `K-INT-EXPIRING` |
| 3 | `job_integration_client_hygiene` | (1) 負責人不在職的 `api_client`：第一次發現時設定寬限期限並通知其主管；逾期改為 `suspended`。(2) 憑證到期提醒；撤銷逾期未領取的憑證。(3) 逾期的變更申請改為 `expired`。(4) 刪除過期超過一天的 token。(5) 刪除一天以前的速率計數與驗證失敗計數。(6) 每小時一次：從呼叫紀錄彙整當天的 `api_client_daily_stat`，不同主體數第一次超過門檻時通知系統管理員並寫稽核事件。(7) 系統管理員只有一位時，每天通知稽核角色一次 | `K-INT-CLIENT-OWNER`、`K-INT-CRED-EXPIRE`、`K-INT-DUAL-CONTROL` |
| 4 | `job_reconciliation` | (1) 對每個 `comparing` 的批次呼叫一次 `compare_reconciliation_step`；任何一個還沒做完就回 `more`。(2) 逾時的 `collecting` 批次改為 `abandoned`。(3) 逾期的發現升級。(4) 超過確認期限的 `pending_verification` 發現通知稽核一次。(5) 逾期未對帳的系統通知負責人（每個間隔一次）。(6) 刪除超過保存天數的回報項目 | `K-INT-RECON-COMPARE`、`K-INT-RECON-SLA`、`K-INT-RECON-VERIFY`、`K-INT-RECON-OVERDUE` |
| 5 | `job_access_review` | (1) 依 `review.interval_months` 建立新的一輪。(2) 開始已到 `starts_at` 的複查。(3) 提醒。(4) 逾期升級。(5) 升級後仍不回應的處理。(6) `reduce` 後續追蹤的提醒；逾期的自動撤銷。(7) 結束已完成的複查 | `K-INT-REVIEW-SCHEDULE`、`K-INT-REVIEW-NO-RESPONSE`、`K-INT-REVIEW-REDUCE` |
| 6 | `job_integration_call_log_seal` | 依 4.7 的兩個階段：先替尚未計算的段算出雜湊並寫稽核事件；距離上一段已滿一個檢查點間隔時劃定新的一段，並回 `more`（下一次呼叫就會算它的雜湊）。刪除超過保存天數且已封存的段（寫稽核事件） | `K-INT-CALL-LOG` |
| 7 | `job_evidence_checkpoint` | (1) 距離上一個檢查點已滿間隔、而且鏈頭有前進：建立新的檢查點（未簽章）。(2) 每天一次把最新的已簽章檢查點寄給稽核角色。(3) 檢查簽章是否停擺（10.4） | `K-INT-CHECKPOINT`、`K-INT-CHECKPOINT-STALE` |

每個工作都可以重複執行而不產生重複的結果；測試直接呼叫這些 function 並搭配假時鐘。

## 16. 安全設計

### 16.1 驗證與授權

| 項目 | 設計 |
|---|---|
| 傳輸 | 只接受 TLS。正式環境由反向代理終止 TLS；後端在正式環境拒絕非 HTTPS 的整合請求 |
| 身分 | OAuth 2.0 client credentials。密鑰只出現在 token 端點；其他呼叫只帶短效 token |
| 來源 | 每個系統登記允許的來源位址；換發與每次呼叫都檢查。token 綁定換發時的位址（4.10）。密鑰或 token 外洩到別的網路位置時不能使用 |
| 密鑰與 token 的保存 | 資料庫只有 SHA-256。後端在進資料庫之前就做雜湊，所以資料庫的參數、記錄檔都不會出現原文。後端的記錄檔要遮蔽 `Authorization` 標頭。密鑰只有系統的負責人領得到一次，系統管理員看不到 |
| 檢查的位置 | 驗證、狀態、來源、scope、速率全部在 `sgn_internal.authenticate_client` 這一個入口，每次呼叫都執行。後端不快取驗證結果，所以暫停與縮小 scope 立即生效 |
| 兩層授權 | scope 決定「能用哪些功能」，可見範圍決定「能看到哪些資料」。兩者都通過才有結果 |
| 管理動作 | 登記、擴大權限、發憑證、改被授權者的外部識別碼、取消進行中的複查，都要兩個人（4.9）。收緊的動作（停用、撤銷憑證、縮小範圍）一個人就能做。全部要填原因並寫入稽核鏈 |
| 人與系統分開 | 給其他系統的 function 不接受人的身分（`p_actor` 必須是 null）；給人的 function 不接受 token。一個 token 永遠不能做簽核、複查決定或任何管理動作 |

### 16.2 防重放

| 對象 | 做法 |
|---|---|
| 呼叫平台的請求 | TLS 加上短效 token（預設 10 分鐘），而且 token 只能從換發它的位址使用。token 外洩的影響限於它的 scope、可見範圍、來源位址與剩餘時間；撤銷憑證或暫停系統可以立即使它失效 |
| webhook | 簽章涵蓋 `webhook-id`、`webhook-timestamp` 與內容；使用方檢查時間差不超過 5 分鐘並以 `webhook-id` 去重。`v2a` 的簽章內容含 `endpoint_id`，送給甲的事件不能重放給乙 |
| 事件 | 序號嚴格遞增。使用方記住已處理的最大序號，較舊的事件可以直接略過 |
| 對帳上傳 | `item_key` 讓重送不會重複；宣告完成時核對筆數；`observed_at` 不能回填到舊的時間 |
| 用量回報 | `usage_key` 讓重送不會重複 |
| 複查決定 | 帶內容雜湊；已決定的工作不能再決定 |

### 16.3 資訊最小揭露

- 所有輸出先套用可見範圍（`K-INT-VISIBILITY`）。一張申請單只有部分權限項目可見時，只輸出可見的部分；稽核事件與複查結果以「申請單至少有一筆可見的權限項目」為條件。
- 主體只以呼叫方自己的身分來源的識別碼表示；沒有對應時用不可逆的代號，不輸出內部 id（3.2）。不輸出姓名、email、部門。被授權者的負責人也只輸出識別碼。
- 呼叫方只能用登記給它的身分來源查詢主體（`allowed_providers`）。
- 不輸出申請內容本身（使用情境、說明、附件），只輸出權限項目。
- 撤銷原因、複查說明、簽核意見等自由文字不放進事件與授權查詢，也不給只有 `audit.read` 的呼叫方；它們只給 `audit.read_all`，而登記這個 scope 需要稽核角色會簽。
- 只有 `reconciliation.write` 的系統拿不到核准的限制條件與未設定的授權清單（8.6）。
- `sgn.principal.*` 事件與成員名單只給目前（或最近）看得到該被授權者權限的呼叫方；沒有對應識別碼的成員直接省略。
- 呼叫紀錄不保存 `context` 的原文，只保存雜湊。
- webhook 的回應內容完全不保存，只記狀態碼與錯誤的種類。

### 16.4 防列舉與濫用

| 可能的探測或濫用 | 對策 |
|---|---|
| 猜主體是否存在 | 主體不存在、身分來源不被允許、沒有可見的授權、資源不在可見範圍，判定結果完全相同（`no_entitlement`、相同的 `ttl_seconds`）；授權查詢一律回空清單 |
| 以內部 id 走訪全部主體 | 內部 id（provider `sgn`）只有明確登記的系統可以用；其他系統指定 `sgn` 時主體一律解析不到。輸出不帶內部 id。每個系統每天查詢的不同主體數列在整合狀態，超過門檻示警 |
| 猜 id（權限項目、批次、檢查點） | 不存在與不可見都是 404（`integration_not_found`），訊息相同。404 是失敗，計入該系統的失敗上限（預設每分鐘 60 次），超過就回 429 |
| 猜系統代碼與密鑰 | token 端點的所有驗證失敗都是相同的 401 `invalid_client`，不論失敗幾次；代碼存在與否的計數方式相同（鍵是雜湊，不引用系統）。未驗證的請求另有依來源 IP 的限制 |
| 用錯誤的密鑰讓正牌系統換不到 token | 做不到：失敗與成功分開計數，密鑰正確的換發只受自己的計數限制（4.3） |
| 用偷來的 token 從別處亂試，讓正牌系統被限流 | 做不到：401 不計入該系統的呼叫數與失敗數（13.2） |
| 反覆上傳一定會失敗的大量資料 | 失敗計入失敗上限；請求大小有上限；每天的批次數有上限 |
| 用捏造的對帳資料產生大量發現、通知與稽核事件 | 單一批次的新發現超過上限就整批暫停（`K-INT-RECON-ANOMALY`）；通知以批次為單位；對帳的稽核事件以批次為單位；比對分段執行，不佔住事件的鎖 |
| 用管理端點灌滿稽核鏈 | webhook 管理動作每小時有上限 |
| 大量嘗試 | 速率限制；每次呼叫都留紀錄；整合狀態頁顯示每個系統 `no_entitlement` 的比例與 4xx 數量；呼叫紀錄可以送進 SIEM（10.3） |

已知的限制：主體不存在時判定會提早結束，回應時間可能比「存在但沒有授權」略短。第一版不做等時處理，以速率限制與紀錄作為補償。

### 16.5 輸入驗證

所有檢查在資料庫的 function 裡做，後端只擋大小、JSON 語法與請求識別碼的格式。

| 項目 | 限制 |
|---|---|
| 請求內容大小 | 256 KB；上傳對帳項目 2 MB；給人的檔案上傳 20 MB |
| `X-Request-ID` | 必須符合 `^[A-Za-z0-9._-]{1,64}$`；不符合就捨棄，由後端產生（14.1） |
| 頂層 | 必須是 JSON 物件。不認得的鍵一律忽略（AuthZEN 的要求） |
| `subject.type` | `person` 或 `principal` |
| `subject.id` | 1 到 256 個字元，不含控制字元 |
| `properties.provider` | `^[a-z][a-z0-9_]{0,31}$`；而且要在呼叫方的 `allowed_providers` 內，否則主體視為不存在 |
| `resource.type`、`action.name` | `^[a-z][a-z0-9_]{0,63}$` |
| `resource.id` | 1 到 512 個字元，不含控制字元 |
| `item_key`、`usage_key` | 1 到 256（`usage_key` 是 128）個字元，不含控制字元 |
| `context`、`constraints` | 物件；序列化後不超過 16 KB；巢狀不超過 8 層 |
| `properties` | 物件；序列化後不超過 4 KB |
| `evaluations` | 不超過 `integration.check_max_evaluations` 筆 |
| 查詢參數 | 不認得的參數忽略；認得的參數格式不符回 400 |
| `limit` | 1 到上限；超過上限時取上限，不回錯誤 |
| 路徑中的 id | 不是合法的數字或格式時回 404，不回 400 |
| webhook 網址 | 見 7.5；worker 連線的規定見 7.6（解析一次並固定用那個位址連線、禁止的位址範圍、每次重試重新檢查、不跟隨轉址） |
| 來源位址 | 只信任部署設定列出的反向代理所加的標頭（4.10） |

「控制字元」指 Unicode 類別 Cc（含換行、Tab、NUL）；以 `!~ '[[:cntrl:]]'` 檢查。

流程包的 hook 只會收到已通過上述檢查的資料。核心以 `regprocedure` 呼叫 hook，函式名稱來自登記時已驗證的 `process_type`，不拼接任何外部輸入。

來自其他系統的字串（`properties`、回報的識別碼、`item_key`）在畫面、信件與匯出檔一律當純文字處理（3.7）。

### 16.6 稽核

| 事情 | 記在哪裡 |
|---|---|
| 變更申請的提出、覆核、會簽、駁回、撤回、逾期；系統的登記、修改、暫停、停用；憑證的建立、領取、撤銷；可見範圍的改變 | 稽核事件（雜湊鏈） |
| 被授權者外部識別碼的設定、取代與移除（含新舊值與來源） | 稽核事件 |
| webhook 訂閱的建立、修改、刪除、自動停用 | 稽核事件 |
| 對帳批次完成（含回報內容與發現變動的雜湊）、異常批次的檢視、人對發現做的每個動作、排程的升級 | 稽核事件 |
| 發現由批次造成的逐筆變動 | `reconciliation_finding_history`，由批次稽核事件裡的雜湊保護 |
| 複查的每一步（含需求確認、後續追蹤的確認、取消時每一件未決定的工作） | 稽核事件 |
| 用量回報、用量超出核准 | 稽核事件 |
| 投影不一致的修正、檢查點簽章停擺與恢復、驗證失敗示警、失敗上限示警、新的來源位址 | 稽核事件 |
| 每一次已驗證的呼叫（含每一筆判定的結果與依據） | 呼叫紀錄；每個檢查點之前把雜湊寫入稽核事件 |
| 每一次 webhook 嘗試 | `webhook_attempt` |

由其他系統觸發的稽核事件（訂閱管理、對帳批次、用量回報），actor 記為系統，變更內容帶 `api_client` 的代碼（見附錄 A 第 4 項）。

### 16.7 其他

- 金鑰：簽章私鑰與 webhook 主金鑰只在後端的部署設定裡，不進資料庫、不進 repo。開發與測試環境用 `sim/` 產生的金鑰。
- 流程包的 hook 出錯不會放行：`evaluate_constraints` 的例外視為不符合；`describe_entitlements` 的格式錯誤會讓狀態轉移失敗，而不是悄悄產生錯誤的權限項目。
- 投影不靠呼叫方自律：由觸發程序驅動，判定時再複核一次授權與主體的狀態，排程持續比對（2.2、5.3）。
- 平台只回答核准了什麼。使用方被入侵或不照判定結果執行，要靠對帳發現；而對帳的回報方不能自己結掉高嚴重度的發現（8.7）。

## 17. migration 檔案與測試

### 17.1 migration 檔案

都在 `db/kernel/` 下，檔名前綴的編號依核心的編號規則；下表是相對順序。

| 順序 | 檔案 | 內容 |
|---|---|---|
| 核心資料表與基礎函式（現在時間、參數、錯誤、稽核寫入、通知、找主管）之後 | `integration_schema.sql` | 11.1 的型別、29 張資料表、兩個序列、只增不改的觸發程序；種子：`api_scope`、`integration_event_type`、15.1 的規則、15.2 的錯誤、15.3 的參數 |
| 緊接其後 | `integration_projection.sql` | 12.1、12.2 的 function（投影、事件、主體、身分對應、可見範圍）、`check_review_followup`（`project_case` 會呼叫它，所以放在同一個檔案），以及掛在核心資料表上的六個觸發程序（2.2） |
| 生命週期 function 之後 | `integration_clients.sql` | `authenticate_client`、`explain_auth_failure`、`count_rate`、`log_api_call`；系統管理、變更申請、憑證、token、中繼資料、呼叫紀錄的 function；`job_integration_client_hygiene`、`job_integration_call_log_seal` |
| | `integration_access.sql` | `validate_access_request`、`evaluate_access`、`render_entitlement`、游標的編碼與解碼；判定、用量回報、授權查詢、成員名單的 function；`job_integration_consistency` |
| | `integration_events.sql` | `render_integration_event`、事件串流、webhook 的 function（含給 worker 的兩個）；`job_integration_expiring` |
| | `integration_reconciliation.sql` | 對帳的 function（含檔案上傳、異常批次的檢視、獨立確認）；`job_reconciliation` |
| | `integration_review.sql` | 複查的其餘 function；`job_access_review` |
| | `integration_evidence.sql` | 稽核輸出、呼叫紀錄輸出、鏈頭、檢查點的 function；`audit_ocsf_map`、`audit_export_key` 的種子；`job_evidence_checkpoint` |

投影的 function 會被觸發程序呼叫，而觸發程序在生命週期 function 執行時才會觸發，所以 `integration_projection.sql` 只需要排在核心資料表之後；`revoke_grant` 等核心入口由後面的檔案呼叫。

每個檔案在自己定義 function 的同時，寫入對應的 `api_function_scope` 列。核心的排程入口要能呼叫到七個工作 function，所以它的檔案排在這些檔案之後，或以登記表的方式呼叫（依核心的排程機制）。

邊界檢查：這八個檔案不得出現任何流程包的代號。

### 17.2 資料庫測試

放在 `db/tests/kernel/`。測試用的流程類型由測試自己建立（一個使用被授權者與有效期間、一個不使用而且以一次性許可描述權限），並以測試專用的 schema 實作兩個 hook（支援 `strict`、`usage`、`approved_union`）；不依賴任何流程包。需要在交易中途看到投影結果的測試先執行 `set constraints all immediate`。

| 規則 | 測試（每一列至少一個測試，名稱包含規則代碼） |
|---|---|
| `K-INT-CLIENT-AUTH` | 未登記、暫停、停用的系統被拒；過期的 token 被拒；憑證撤銷後它換發的 token 立即被拒；缺 scope 回 403；縮小 scope 後舊 token 立即受限；token 端點各種失敗都回相同的 `invalid_client`；非系統管理員不能提出登記；登記缺原因被拒；`p_actor` 非 null 被拒 |
| `K-INT-CLIENT-OWNER` | 負責人離職 → 設定寬限期並通知 → 逾期暫停；期限內改派則清除 |
| `K-INT-CLIENT-SOURCE` | 清單外的位址換發被拒（回應與密鑰錯誤相同，內部原因不同）；清單外的位址使用 token 被拒；`ip` 綁定時換一個清單內的位址使用 token 被拒，`cidr` 綁定時可以；不限來源而沒有原因被拒；有 `audit.read_all` 或 `reconciliation.write` 的系統不能不限來源；新的來源位址通知負責人一次 |
| `K-INT-CRED-EXPIRE` | 到期日超過上限被拒；超過有效憑證數被拒；到期前提醒；到期後不能換發；只有負責人能領取；領取兩次被拒；逾期未領取被撤銷；未領取的憑證不能換發 |
| `K-INT-DUAL-CONTROL` | 每一種變更申請：提出人不能覆核自己的；覆核前不生效、覆核後生效；只收緊的修改立即生效；`audit.read_all` 沒有會簽不生效；負責人等於提出人被拒；覆核人是系統負責人被拒；逾期的申請失效；同一對象重複提出被拒 |
| `K-INT-IDENTITY` | 被授權者的負責人不能設定對應；覆核人是該被授權者的負責人或成員時被拒；識別碼已被別的被授權者使用時被拒；設定、取代、移除各寫稽核事件（新舊值）並發出事件；取代後相關的未結案發現不會被批次自動結案；同步來源的寫入不需要覆核、值沒變不發事件 |
| `K-INT-VISIBILITY` | 流程類型不可見、資源類型不可見、前綴不符，判定都與不存在相同；授權查詢、事件、成員名單同樣過濾；一張單部分可見時只輸出可見的項目；單筆查詢不可見回 404；**稽核輸出：前綴不符的申請單事件不出現、沒有權限項目的申請單事件不出現、只有 `audit.read` 時 `changes` 只剩白名單鍵而 `settings`、`ip`、`canonical` 是 null**；**複查輸出：沒有可見項目的工作不出現、不是整個流程類型可見時 `summary` 是 null**；`sgn.principal.*` 事件不送給只看過早已結束項目的呼叫方；成員沒有對應識別碼時被省略；身分來源不在允許清單時主體解析不到；沒有對應時輸出代號而不是內部 id |
| `K-INT-SYNC-EPOCH` | 可見範圍改變後舊的 `since`、`page_token`、事件游標都回 409；重新快照後的游標可用；改變時發出只給該呼叫方的事件 |
| `K-INT-CALL-LOG` | 成功的呼叫有一筆紀錄且內容正確；`record_failure` 補上失敗的紀錄與內部原因；紀錄表擋下 `UPDATE`、`DELETE`、`TRUNCATE`；封存的雜湊可以重算，而且與連線的 `TimeZone` 設定無關（以兩種時區各算一次）；改動一筆的 `ip` 或 `api_access_token_id` 後雜湊對不上；未封存的不會被刪；同一來源超過門檻的未驗證失敗不再寫紀錄但計數仍在 |
| `K-INT-RATE-LIMIT` | 超過上限回 429；下一個視窗恢復；個別系統的上限生效；批次判定算一次；**連續 404 達到失敗上限後回 429**；失敗上限示警一小時內只發一次；401 不計入系統的計數；webhook 管理動作每小時的上限 |
| `K-INT-AUTH-ALERT` | 連續錯誤密鑰之後，正確密鑰仍能換發；錯誤密鑰不論幾次都回 401；不存在的代碼與存在的代碼回應相同、計數方式相同；達門檻時通知負責人一次 |
| `K-INT-PROJECT` | 3.4 三張表的每一列；直接 `update` `grant` 的狀態（不經核心的 function）後權限項目跟著結束；重複投影不產生重複的事件；hook 回傳重複資源時交易失敗；hook 格式錯誤時失敗；`has_validity` 為否而回傳 `effective_during = active` 時失敗；內容縮小、擴大、修改分別得到正確的 `change_class`；12.5 事件表的每一列；`sync_seq` 等於事件序號；沒有登記 hook 的流程類型不產生權限項目；人離職後以他為主體的項目結束且復職不恢復；被授權者結束日反映在 `effective_until`；一次性許可有結束時間；六個觸發程序存在且啟用 |
| `K-INT-CONSISTENCY` | 停用觸發程序後改 `grant` 狀態 → 排程發現、重投影、寫稽核事件、通知稽核；一致時不做事；被授權者結束日到了由排程投影而不示警 |
| `K-INT-CHECK` | 六種 `reason` 各一；到期時間已過但排程尚未執行時拒絕；**權限項目是 `active` 而 `grant` 已被直接改成 `revoked`（觸發程序停用）時拒絕並記下 `stale_projection`**；被授權者結束日已到時拒絕；起始時間未到時拒絕；人透過成員身分取得、移除成員後失去；離職的人解析不到；有限制條件但沒有登記 hook 時拒絕；hook 丟例外時拒絕；多筆授權其中一筆符合即允許；`context.time` 不影響判定；批次的三種語意；預設值的取代規則；筆數超過上限回 400 |
| `K-INT-CHECK-BASIS` | 允許的結果帶 `basis` 與完整的 `constraints`；`decision_id` 對得回呼叫紀錄；`ttl_seconds`：參數、`valid_until`、成員期間的迄、`revoke_risk_at`（複查追蹤期限、負責人寬限期）各自成為最小值的情況；拒絕的兩種算法；一次性許可是 0 |
| `K-INT-CONSTRAINT-MODE` | `strict` 的系統少帶一個限制面向得到 `constraint_context_missing` 且 `basis` 帶完整限制；補上後允許；`advisory` 的系統同一請求允許；`advisory` 沒有原因或沒有納入對帳時登記被拒 |
| `K-INT-USAGE` | 回報後累計超過上限的判定被拒；相同 `usage_key` 重送不重複；鍵相同內容不同回 409；超出核准的回報被記錄並示警；已結束超過容許時間的被拒；筆數上限；紀錄表只增不改 |
| `K-INT-EVENT-ORDER` | 兩個並行交易的事件序號與提交順序一致（以兩條連線測試）；串流的游標在沒有可見事件時仍前進；`after` 超過最新位置回空陣列；`types` 篩選；沒有對應 scope 的類型不出現；webhook 前一個未成功時不送下一個 |
| `K-INT-EXPIRING` | 進入提醒天數時發一次；重複執行不重發；續期產生新的到期日後再發一次 |
| `K-INT-WEBHOOK-DISABLE` | 來源不在允許清單被拒；ping 成功才啟用；7.5 轉移表的每一列與不允許的轉移；對 `disabled` 的訂閱送 ping 回 409；已刪除的訂閱回 404；失敗後的等待時間符合公式的範圍；`Retry-After` 生效；重試用盡停用並通知；410 立即停用；從停用恢復時 `cursor` 與 `tail` 的差別；輪替密鑰後重疊期間回傳兩個版本；移除允許的來源後訂閱被停用；嘗試紀錄只接受列出的錯誤種類 |
| `K-INT-RECON-COMPARE` | 8.5 結果表的八列各一；`missing`；一次性許可不參與；主體解析不出來；離職的人視為解析不出來；以人回報而授權給團隊時算對得上；成員在容許時間內剛被移除時是 `tolerated`；核准範圍在容許時間內剛縮小時是 `tolerated`；回報沒有限制條件而核准有限制時是超出；**兩張單各涵蓋一部分：依 `entitlement_id` 拆開回報時兩筆都 `covered`；不拆開時走聯集比對**；`entitlement_id` 不存在時是 `unapproved`；範圍外的項目被拒；筆數不符被拒；`observed_at` 太舊或早於上一個批次被拒；分段執行的結果與一次做完相同；指紋對含有 `\|` 與 `:` 的識別碼不會碰撞；批次的稽核事件帶正確的兩個雜湊 |
| `K-INT-RECON-ANOMALY` | 新發現超過上限時只建立一筆彙總發現、不結案既有發現、批次進入 `needs_review`；放行後逐筆建立；作廢後不算完成的對帳；負責人與上傳人不能檢視；每天的批次數與進行中批次數的上限 |
| `K-INT-RECON-ASSIGN` | 指派給系統負責人；期限依嚴重度與工作天計算；相同指紋不重複建立；同一資源換主體回報時沿用原本的建立時間、期限與升級狀態；解析不出來的主體每批換識別碼仍是同一筆發現；通知以批次為單位各一封 |
| `K-INT-RECON-SLA` | 逾期升級給主管並通知稽核；只升級一次 |
| `K-INT-RECON-VERIFY` | 高嚴重度的發現在後續批次消失時進入 `pending_verification` 而不是結案；0 筆的批次同樣如此；確認後結案、否決後回到 `open` 並沿用期限；負責人、系統負責人、上傳人不能確認；再次出現時回到 `open`；逾期未確認通知稽核一次 |
| `K-INT-RECON-CLOSE` | 低嚴重度的發現在後續批次不再出現時自動結案；被標記不得自動結案的不會；批次範圍沒有涵蓋的發現不會被動到；與發現有關的人不能排除；無關的系統管理員可以排除且必須選原因 |
| `K-INT-RECON-OVERDUE` | 超過間隔沒有完成的批次時通知一次；只開啟檔案上傳的系統同樣適用 |
| `K-INT-RECON-UPLOAD` | 只有系統負責人能上傳；系統沒有開啟上傳時被拒；批次記下上傳人與檔案雜湊；之後的比對結果與相同內容的 API 批次相同；上傳人不能確認或排除該系統的發現 |
| `K-INT-REVIEW-SCHEDULE` | 參數為 0 不建立；滿月數建立一次；重複執行不重複建立；被取消的那一輪不算 |
| `K-INT-REVIEW-SOD` | 複查人是申請人時改由主管；**複查人是團隊成員（含身為成員的負責人）時改派**；主管也違反時再往上；找不到上一層時交給系統管理員群組；代理人違反時不能決定；指派後才成為成員的人決定時被拒；負責人的需求確認與決定分開記錄 |
| `K-INT-REVIEW-DECIDE` | 三種決定；雜湊不符回 409；已決定不能再決定；非複查人被拒；代理人決定時記下代誰；批次維持每件各一筆稽核事件；需要說明的工作沒有說明時單件與整批都被拒；`reduce` 沒有 `reduce_spec` 或內容不合格被拒；`revoke` 缺原因被拒 |
| `K-INT-REVIEW-REVOKE` | 決定撤銷後授權立即撤銷、權限項目結束、發出事件 |
| `K-INT-REVIEW-REDUCE` | 照 `reduce_spec` 移除 → 追蹤完成；只移除無關的項目 → 追蹤不變；有 `tighten` 時進入待確認，確認後完成、否決後回到 `pending`；逾期（含待確認中）→ 自動撤銷 |
| `K-INT-REVIEW-NO-RESPONSE` | 提醒；到期升級且原複查人不能再決定；升級後仍不回應時兩種處理各一；決定前授權已結束的工作改為 `not_applicable`；全部完成後結束並寫入正確的統計與雜湊（依 9.6 的 SQL 重算相同）；手動建立時放寬設定會標記並通知稽核 |
| `K-INT-REVIEW-CANCEL` | `scheduled` 的可以直接取消；`open` 的沒有覆核不會取消；提出人或覆核人與範圍內的授權有關時被拒；取消後未決定的工作各有一筆稽核事件、已做的決定保留 |
| `K-INT-CHECKPOINT` | 鏈頭沒有前進時不產生；產生的檢查點指向前一個；`event_count` 是實際筆數；簽章只能寫入一次；其他欄位不可改；簽章後發出事件；依 10.5 的步驟對種子資料驗證成功，改動一筆稽核事件後驗證失敗 |
| `K-INT-CHECKPOINT-STALE` | 鏈頭前進而超過門檻沒有已簽章的檢查點時通知稽核並寫稽核事件；24 小時內不重複；恢復簽章後寫恢復的事件 |

架構與契約測試：

- 給其他系統的 27 個 function 都呼叫 `authenticate_client` 與 `log_api_call`，而且在 `api_function_scope` 有一列；`api_function_scope` 沒有多餘的列。
- 本文件的 29 張表 `sgn_app` 都沒有權限；標示為只增不改的表擋下對應的操作。
- 2.2 的六個觸發程序存在、啟用，而且是延後的 constraint trigger。
- 判定的查詢計畫沒有對 `sgn.entitlement` 做循序掃描。
- `integration_event_type`、`api_scope` 的內容與 7.1、4.4 一致（由產生器輸出成 TypeScript 與參考文件）。
- 路由表的每個整合端點都對應到存在的 function，參數相符；13.2 的六個 function 列為只供後端使用。
- `integration_authzen_metadata` 的 `policy_decision_point` 等於參數值，各端點網址以它開頭。
- 本模組的 SQL 沒有直接比對角色代碼的字串，只透過 `integration_admin_role()` 與 `integration_auditor_role()`。

### 17.3 後端測試

- token handler：Basic 標頭的各種錯誤、表單解析、依 `http_status` 回應、`WWW-Authenticate`。
- `auth: 'client'`：沒有標頭、格式錯誤、雜湊後傳入；錯誤時以獨立的交易呼叫 `record_failure`；429 的 `Retry-After`。
- `X-Request-ID`：合格的原樣回傳；含換行、超過 64 個字元、含不允許字元的被捨棄並改用自動產生的值，原值不出現在回應與紀錄。
- 來源位址：對端不在 `TRUSTED_PROXY_CIDRS` 時忽略 `X-Forwarded-For`；對端在清單內時取由右往左第一個不在清單內的位址；偽造的多段標頭取到正確的位址。
- webhook worker：`v1` 與 `v2a` 簽章以 Standard Webhooks 規格裡的範例向量驗證；送出的內容與領取到的 `body` 逐位元組相同；不跟隨轉址；逾時；回報的參數只有錯誤種類；解析到 loopback、link-local、未指定位址、IPv4-mapped、設定的內部網段時不連線並回報 `blocked_address`；以會輪流回不同位址的假 DNS 測試：連線用的是檢查過的那個位址。
- `Signer` 與 `TimestampAuthority` 的合約測試；`jwks.json` 的內容；檢查點簽章可以用 `jose` 驗證。
- 對帳檔案上傳：CSV 的轉換、欄位錯誤時回報列與欄、檔案雜湊的計算。
- 排程入口：每個工作各自一個交易；回 `more` 時再呼叫，不超過上限。
- `tools/verify-audit-chain`：對正確的匯出檔通過；改動事件、刪除事件、改動檢查點各自失敗；序號有跳號但雜湊連結正確時通過；有清除區段時從清除前的檢查點開始驗；最後一個檢查點之後的事件數與時間長度出現在警告裡。

## 18. 模擬環境：示範用的使用方系統

骨幹第 12 節規定 `sim/` 要有一個「使用權限的其他系統」。它的目的是用真實的協定走完整合介面的每一條路徑；整合測試與端對端測試都對著它跑。

### 18.1 `sim/consumer`：報表入口網站

一個獨立的小型服務，有自己的資料庫，裡面有「本地權限表」（主體、資源、動作、限制條件、來源的 `entitlement_id`、`valid_from`、`valid_until`）與「本地成員表」（被授權者、成員、`valid_until`）。它代表任何一個自己保存權限設定的系統。

它以一般使用方的身分使用整合介面，不讀平台的資料庫，也不使用平台的內部 function。

| 行為 | 使用的介面 |
|---|---|
| 啟動時讀 `GET /integration/v1` 與 AuthZEN 中繼資料取得各端點 | 中繼資料 |
| 換發 token，過期前自動重新換發 | token 端點 |
| 有人讀報表時，先問平台能不能讀（並依 `ttl_seconds` 快取）。可以切換成「只看 `decision`」的模式，模擬標準的 AuthZEN 使用方 | 單筆與批次判定 |
| 第一次啟動做完整快照（含起始日在未來的授權與成員名單），之後增量同步；本地依 `valid_from`、`valid_until` 自行生效與失效；收到 409 `integration_resync_required` 就清空重做 | 授權查詢、成員名單 |
| 接收 webhook：驗 `v1` 與 `v2a`、檢查時間、去重、更新本地權限表與成員表、清快取 | webhook |
| 重新啟動後從上次的游標補讀事件 | 事件串流 |
| 把本地權限表整份回報（每筆帶來源的 `entitlement_id`） | 對帳 |
| 取稽核事件、呼叫紀錄與檢查點，執行驗證工具 | 證據輸出 |

對外的端點：

| 端點 | 用途 |
|---|---|
| `GET /healthz` | 健康檢查 |
| `GET /reports/:resource_id?as=<人的識別碼>&…` | 模擬使用者讀資料。回 200 或 403，並帶判定的依據 |
| `POST /hooks/sgn` | webhook 接收端 |
| `POST /seal-device/affix` | 模擬電子用印設備：收到申請人與文件，算出文件雜湊後問平台能不能蓋；允許時「蓋章」並回報用量 |
| `POST /control/sync` | 立即做一次同步（完整或增量） |
| `POST /control/replay` | 從指定的游標重讀事件 |
| `POST /control/reconcile` | 立即回報一次對帳，回傳批次結果。可以指定「不帶 `entitlement_id`」「送 0 筆」「把某一筆的主體換成不存在的識別碼」 |
| `POST /control/export-csv` | 把本地權限表匯出成 8.9 的 CSV（給檔案上傳的情境用） |
| `POST /control/drift` | 製造偏差：加一筆沒核准的權限、放寬一筆的限制條件、刪掉一筆、忽略下一個撤銷事件 |
| `POST /control/webhook-behavior` | 讓接收端在接下來 N 次回 500、回 410、或延遲回應 |
| `POST /control/probe` | 連續以不存在的 id 呼叫單筆查詢 N 次，回傳各次的狀態碼 |
| `POST /control/verify-chain` | 匯出稽核事件與檢查點並執行驗證工具 |
| `GET /control/state` | 本地權限表、成員表、收到的事件、游標、快取 |

`/control/*` 只給測試使用。

腳本：`sim/consumer/start.sh`、`sim/consumer/stop.sh`（骨幹第 12 節的要求），以及 `sim/consumer/register.sh`：以兩位系統管理員的身分走完 14.2 的變更申請（一位提出、一位覆核）登記 `api_client`（代碼 `sim-report-portal`，身分來源是模擬 LDAP，來源位址是模擬環境的位址）、設定可見範圍與 webhook 來源、建立憑證，再以負責人的身分領取密鑰，寫進這個服務的設定。

需要的種子（附錄 D 第 5 項）：`sys_admin` 至少兩位；被授權者在模擬 LDAP 的群組識別碼（例如通路業務組是 `channel-sales`）由人員與組織 port 同步成 `principal_identity`。

資料授權的執行系統模擬器（DC）也登記成另一個 `api_client`，回報它從資料庫讀出的真實欄位權限與列層級安全設定（它知道每條規則是依哪一筆核准套用的，所以帶 `entitlement_id`）。這樣對帳比對的是真的權限，不是另一份名單。

另外登記一個只開啟檔案上傳、沒有憑證的 `api_client`（代碼 `sim-hr-suite`），代表沒有 API 的外購系統。

### 18.2 要驗證的情境

每個情境是一個端對端測試。人員與被授權者用 [seed-directory.md](seed-directory.md) 的名單。

| # | 情境 | 預期 | 規則 |
|---|---|---|---|
| 1 | 申請單核准、執行、驗證完成 | 使用方收到 `sgn.grant.activated`，本地權限表出現對應的項目；到了起始日，團隊成員讀報表得到 200，非成員得到 403 | `K-INT-PROJECT`、`K-INT-CHECK` |
| 2 | 讀取超出列條件的範圍 | 403，原因 `constraint_not_satisfied`，依據帶核准的限制條件 | `K-INT-CHECK-BASIS` |
| 3 | 負責人撤銷授權 | 幾秒內收到 `sgn.grant.revoked`，快取被清，下一次讀取 403 | `K-INT-EVENT-ORDER` |
| 4 | 使用方停機期間發生三個事件，再啟動 | 從游標補讀，三個事件依序處理，本地權限表與授權查詢的結果一致 | `K-INT-EVENT-ORDER` |
| 5 | 接收端連續回 500 | 依間隔重試（用假時鐘推進）；恢復後依序補送；`webhook-id` 不變 | `K-INT-WEBHOOK-DISABLE` |
| 6 | 接收端回 410 | 訂閱被停用，負責人收到通知信（從模擬 SMTP 讀取） | `K-INT-WEBHOOK-DISABLE` |
| 7 | 竄改 webhook 內容後重送給接收端 | 接收端驗章失敗，拒收 | 16.2 |
| 8 | 製造四種偏差後回報對帳 | 產生四種發現，各自指派給系統負責人，負責人收到一封摘要。修正後再回報：`missing` 自動結案；三種高嚴重度的發現進入等待確認，由另一位系統管理員確認後結案 | `K-INT-RECON-COMPARE`、`K-INT-RECON-VERIFY`、`K-INT-RECON-CLOSE` |
| 9 | 忽略撤銷事件後回報對帳 | `ended_still_present` | `K-INT-RECON-COMPARE` |
| 10 | 授權到期（假時鐘推進，排程尚未執行） | 判定立即拒絕；使用方本地依 `valid_until` 已自行失效；授權查詢的預設結果不再包含它；排程執行後收到 `sgn.grant.expired` | `K-INT-CHECK` |
| 11 | 把成員移出團隊 | 收到 `sgn.principal.membership_changed`，本地成員表更新；該成員下一次讀取 403 | `K-INT-CHECK` |
| 12 | 用印申請核准後、用印前（需要合約用印流程包登記兩個 hook，見附錄 D 第 1 項） | 用印設備以正確的文件得到允許並回報用量；再問一次因累計份數已達上限被拒；換一份文件被拒；標記完成後再問被拒 | `K-INT-CHECK`、`K-INT-PROJECT`、`K-INT-USAGE` |
| 13 | 建立一輪複查，複查人決定撤銷 | 授權被撤銷，使用方收到事件；複查結果可以從整合端點取得 | `K-INT-REVIEW-REVOKE` |
| 14 | 複查人就是申請人；另一筆的複查人（負責人）是團隊成員 | 兩件工作都改派給上一層主管；負責人可以填需求確認但不能決定 | `K-INT-REVIEW-SOD` |
| 15 | 取得檢查點與稽核事件並驗證；之後直接改資料庫裡的一筆稽核事件再驗證 | 第一次通過，第二次失敗並指出是哪一筆 | `K-INT-CHECKPOINT` |
| 16 | 以沒有該 scope 的 token、過期的 token、可見範圍外的資源呼叫 | 403、401、與不存在相同的結果 | `K-INT-CLIENT-AUTH`、`K-INT-VISIBILITY` |
| 17 | 暫停使用方的 `api_client` | 進行中的 token 立即被拒；webhook 停止推送；恢復後從原進度繼續 | `K-INT-CLIENT-AUTH` |
| 18 | 起始日在未來的授權已完成執行與確認 | 使用方收到 `sgn.grant.activated`（`valid_from` 在未來），本地有這一筆但不放行；起始日之前讀取得到 403（`not_yet_effective`）；假時鐘推到起始日後得到 200，期間沒有新的事件 | `K-INT-CHECK`、6.4 |
| 19 | 只看 `decision` 的使用方，請求不帶列條件 | 403，原因 `constraint_context_missing`；補上列條件後 200 | `K-INT-CONSTRAINT-MODE` |
| 20 | 同一個團隊對同一個欄位有兩張有效的申請單，各核准不同的區域 | DC 模擬器依 `entitlement_id` 拆成兩筆回報，兩筆都是 `covered`，沒有發現 | `K-INT-RECON-COMPARE` |
| 21 | 連續以不存在的 id 查詢 | 達到失敗上限後得到 429；負責人收到通知；正常的呼叫在下一分鐘恢復 | `K-INT-RATE-LIMIT` |
| 22 | 以錯誤的密鑰對使用方的代碼連續換發 token | 全部是 401；使用方以正確的密鑰仍然換得到 token；負責人收到示警 | `K-INT-AUTH-ALERT` |
| 23 | 一位系統管理員提出擴大使用方的可見範圍 | 覆核之前不生效；自己覆核被拒；另一位覆核後生效，使用方的下一次增量同步得到 409，重做快照後看到新範圍的授權 | `K-INT-DUAL-CONTROL`、`K-INT-SYNC-EPOCH` |
| 24 | 被授權者的負責人嘗試把團隊的外部識別碼改成另一個群組；之後由系統管理員提出、另一位覆核 | 前者被拒；後者生效，使用方收到 `sgn.principal.identity_changed`，以舊識別碼的判定變成拒絕 | `K-INT-IDENTITY` |
| 25 | 在模擬 LDAP 讓一位成員離職（`sim/ldap/change.sh offboard`），同步後 | 他的判定變成拒絕；使用方收到成員移除的事件；以他個人為主體的授權收到 `sgn.grant.ended`（`subject_inactive`）；對帳回報他仍有權限時是 `unapproved` | `K-INT-PROJECT`、`K-INT-RECON-COMPARE` |
| 26 | 回報一個含大量捏造項目的對帳批次 | 只產生一筆彙總發現，批次等待檢視；期間核准與撤銷照常完成；系統管理員作廢後沒有留下逐筆的發現 | `K-INT-RECON-ANOMALY` |
| 27 | 以 `sim-hr-suite` 的負責人身分上傳 CSV 權限清單（含一筆沒核准的權限） | 產生批次與一筆 `unapproved`；批次記下上傳人與檔案雜湊；上傳人不能確認或排除 | `K-INT-RECON-UPLOAD` |
| 28 | 直接在資料庫把一筆 `grant` 改成 `revoked`（不經平台的 function） | 權限項目隨交易結束、使用方收到事件、判定拒絕 | `K-INT-PROJECT` |
| 29 | 停掉檢查點簽章的 worker，繼續產生稽核事件，推進假時鐘 | 稽核角色收到簽章停擺的通知；驗證工具的警告顯示未涵蓋的事件數 | `K-INT-CHECKPOINT-STALE` |

情境 12 用合約用印流程包，其他用資料授權流程包；兩者走的是同一套核心程式。

## 附錄 A　骨幹修改建議

本文件沒有修改骨幹。下列各項是本文件的設計需要、而骨幹目前沒有寫或寫法不同的地方。

| # | 骨幹位置 | 建議 | 本文件目前的處理 |
|---|---|---|---|
| 1 | 第 6、11 節 | 明定整理好的權限表由整合模組掛在 `case`、`grant`、`person`、`person_identity`、`principal`、`principal_member` 上的觸發程序維護；核心只需要在造成改變的 function 裡呼叫 `sgn_internal.note_projection_rule`（選用），以及在負責人寬限期開始與解除時呼叫 `sgn_internal.project_principal` | 2.2 |
| 2 | 第 11 節 `describe_entitlements` | 回傳元素增加兩個選填鍵：`effective_during`（`active`／`fulfilment`）、`scope_ref`；明定同一張單內資源不得重複、function 必須是 `stable`、`has_validity` 為否的流程不得回傳 `effective_during = active` | 3.3、3.4 |
| 3 | 第 11 節 `evaluate_constraints` | 明定 `p_context` 的結構：`mode`（`check`／`reconcile`）、`strict`、`at`、`subject`、`action`、`resource`、`context`、`usage`、`approved_union`；明定 `strict` 為 true 時，任何核准的限制面向沒有出現在情境裡就回 false；預設行為補上「有限制條件而沒有登記 hook 時回 false」 | 3.3 |
| 4 | 第 2 節 `audit_event` | 增加 actor 的種類（人、系統、其他系統）與 `api_client` 的欄位，讓由其他系統觸發的動作可以直接篩選 | actor 記為系統，`api_client` 的代碼放在變更內容裡 |
| 5 | 第 2 節 核心實體 | 加入 `principal_identity`（與 `person_identity` 對稱，只能由同步或經覆核的變更寫入），以及本文件的整合相關資料表 | 由本模組的 migration 建立 |
| 6 | 第 2、5 節 稽核鏈 | 在核心契約明定：(a) 雜湊的輸入文字（`canonical`）與公式，並提供取得每一筆 `canonical` 的方式；(b) 稽核事件的序號是否保證連續不跳號（一般的 sequence 會因交易回復而跳號）；(c) 超過保存年限清除舊事件時，清除動作本身寫一筆稽核事件，帶被清除區段的首尾序號與雜湊 | 10.4、10.5 不依賴序號連續：`event_count` 是實際筆數，連續性只看雜湊的連結；以清除前的檢查點作為驗證起點 |
| 7 | 第 1 節 命名 | `case` 與 `grant` 是 SQL 保留字，資料表名稱要一律加雙引號，或改名 | DDL 一律加雙引號 |
| 8 | 第 2、4 節 `grant` | 明定 `grant` 紀錄在哪一個狀態轉移建立、哪些流程類型會有（`has_validity` 為是的流程是否一定有）；明定授權起迄是日期（含頭尾） | 3.4 的表涵蓋有與沒有 `grant` 的全部情況；`has_validity` 為否的流程只能用一次性許可 |
| 9 | 第 5 節 | 核心需要一個「以指定的規則代碼、由系統或指定的人撤銷授權」的內部入口；以及「把生效中的授權縮小」的入口（複查決定為縮小時使用） | 2.1 列為依賴；沒有縮小入口時，縮小只能靠重新申請加上逾期自動撤銷 |
| 10 | 第 5 節 | `K-DELEGATE`、`K-MOBILE-MFA` 的適用範圍加上複查決定與變更申請的覆核 | 9.3、14.2 已如此規定 |
| 11 | 第 8 節 | 參數前綴增加 `integration.`、`reconciliation.`、`review.`、`evidence.`；`scope_ref` 適用範圍的值用 `api_client:<code>` 表示個別系統 | 15.3 |
| 12 | 第 10 節 | 通用畫面增加：複查工作（清單、決定、需求確認、追蹤確認）、對帳發現（清單、回應、確認）、對帳檔案上傳、整合系統管理與變更申請 | 14.2 提供資料與規則，畫面由畫面契約定義 |
| 13 | 第 11 節 命名 | `events` 的資料表是 `integration_event`；`evidence` 的資料表是 `evidence_checkpoint`；`audit_feed` 是端點 `/integration/v1/audit/events` 與 `/integration/v1/audit/calls`，沒有獨立的資料表 | 依本文件 |
| 14 | 工程規範第 2 節 | 路由表增加 `auth: 'client'`、`bodyLimit`、`decorate`；對外 port 增加 `Signer`、`TimestampAuthority`；整合端點不加 `/api` 前綴；部署設定增加 `TRUSTED_PROXY_CIDRS`（來源位址只信任列出的反向代理）、`WEBHOOK_BLOCKED_CIDRS`、`WEBHOOK_ALLOW_PRIVATE`；人員與組織 port 的同步範圍加上被授權者的外部識別碼 | 14.1 |
| 15 | 第 8 節 | 增加核心參數 `system.business_timezone`（IANA 時區名稱，預設 `Asia/Taipei`）：所有「日期轉成時間」（授權起迄、被授權者結束日、到期判斷）一律用它，不用資料庫或連線的時區 | 2.1、3.4；骨幹納入前由本模組登記 |
| 16 | 第 11 節 能力表 | 增列：一次性許可（核准後到執行完成之間有效，一定有期限）屬於權限判定的範圍；用量回報（`usage`）；被授權者的成員名單；檔案上傳對帳。並明定時間造成的生效與失效不發即時事件，由使用方依時間欄位處理 | 3.4、5.7、6.5、8.9、6.4 |
| 17 | 第 5 節 `K-AUDITOR-READONLY` | 明定稽核角色可以「會簽」把稽核資料輸出給其他系統的變更申請（不改變業務資料）；或指定另一個角色負責會簽 | 4.9 以稽核角色會簽 `audit.read_all` |
| 18 | 第 5 節、待納入的增修 A10 | 設定變更申請單納入核心後，取代本文件 4.9 的變更申請；4.9 表中的獨立性限制原樣保留 | 4.9、11.10 由本模組自己實作 |
| 19 | 第 2、4 節 | 明定：人的在職狀態、被授權者的狀態與結束日是可以被觸發程序觀察的欄位；`principal_member` 在成員被移除時保留該列並填上迄；`case` 有「進入目前狀態的時間」；人離職或被授權者結束時核心應撤銷相關授權（`K-OWNER-CONTINUITY` 只寫了被授權者結束） | 2.1 列為假設；3.4 以 `subject_inactive` 讓權限項目先失效，不等核心撤銷 |
| 20 | 第 2 節 `scheduler_run`、排程入口 | 明定排程入口對每個工作的每一次呼叫各用一個交易，工作可以回傳「還有」要求立即再呼叫 | 15.4 |
| 21 | 第 3 節、待納入的增修 A11 | 宣告式流程定義增加 `entitlements` 宣告，讓不寫 hook 的流程也能產生權限項目與判定。建議的結構見下 | 本文件只定義 hook 的路徑；合約用印在 A11 之前以 hook 實作（附錄 D 第 1 項） |
| 22 | 第 12 節 | 示範用的使用方系統同時扮演報表入口網站與電子用印設備；DC 模擬器登記成 `api_client` 並回報對帳；另有一個只用檔案上傳的系統 | 18.1 |

第 21 項建議的宣告結構（放在流程定義裡；核心提供通用的產生與比對，不需要 hook）：

```json
{
  "entitlements": [
    {
      "resource_type": "company_seal",
      "resource_id_from": "seal_kind",
      "actions": ["affix"],
      "effective_during": "fulfilment",
      "scope_ref_from": null,
      "constraints": [
        {"key": "document_sha256", "from": "contract_files[].sha256", "match": "one_of", "context_key": "document_sha256", "required": true},
        {"key": "max_copies", "from": "copies", "match": "max_total", "context_key": "copies", "required": true}
      ]
    }
  ]
}
```

| `match` | `check` 模式回 true 的條件 | `reconcile` 模式回 true 的條件 |
|---|---|---|
| `equals` | 情境的值等於核准的值 | 回報的值等於核准的值 |
| `one_of` | 情境的值在核准的陣列裡 | 回報的陣列是核准陣列的子集 |
| `subset` | 情境的陣列是核准陣列的子集 | 同左 |
| `max` | 情境的數值不超過核准的值 | 回報的數值不超過核准的值 |
| `max_total` | 已回報用量的 `quantity` 加總，加上情境的數值，不超過核准的值 | 一律 false |

`required` 為 true 的限制，情境沒有對應的鍵時一律回 false；為 false 的限制，只有在 `strict` 時才因缺少而回 false。

## 附錄 B　查證來源

| 標準 | 來源 |
|---|---|
| AuthZEN Authorization API 1.0 | <https://openid.net/specs/authorization-api-1_0-final.html>；核准公告 <https://openid.net/authorization-api-1-0-final-specification-approved/> |
| Shared Signals Framework 1.0 | <https://openid.net/specs/openid-sharedsignals-framework-1_0-final.html> |
| CAEP 1.0 | <https://openid.net/specs/openid-caep-1_0-final.html> |
| SCIM | <https://www.rfc-editor.org/rfc/rfc7643>、<https://www.rfc-editor.org/rfc/rfc7644>、<https://www.rfc-editor.org/rfc/rfc9865>、<https://www.rfc-editor.org/rfc/rfc9967> |
| CloudEvents 1.0.2 | <https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md>、同一標籤下的 `bindings/http-protocol-binding.md`、`formats/json-format.md`；sequence 擴充 <https://github.com/cloudevents/spec/blob/main/cloudevents/extensions/sequence.md> |
| Standard Webhooks 1.0.0 | <https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md> |
| OAuth 2.0 | <https://www.rfc-editor.org/rfc/rfc6749>（第 4.4、5.1、5.2 節）、<https://www.rfc-editor.org/rfc/rfc6750>、<https://www.rfc-editor.org/rfc/rfc9700>；憑證綁定（選用）<https://www.rfc-editor.org/rfc/rfc8705> |
| OCSF 1.9.0 | <https://schema.ocsf.io/>（類別 `user_access`、`entity_management`、`api_activity`；物件 `metadata`、`user`、`resource_details`、`managed_entity`、`actor`、`api`）。2026-11-19 修訂時另外查了 <https://schema.ocsf.io/api/1.9.0/classes/api_activity> 與 <https://schema.ocsf.io/api/1.9.0/objects/user> |
| JOSE | <https://www.rfc-editor.org/rfc/rfc8037>、<https://www.rfc-editor.org/rfc/rfc9864> |
| RFC 3161 | <https://www.rfc-editor.org/rfc/rfc3161> |

## 附錄 C　尚待確認的設計點與已知限制

| # | 設計點 | 目前的選擇 | 為什麼沒把握，或限制是什麼 |
|---|---|---|---|
| 1 | 請求沒有提到的限制面向 | 預設嚴格（缺面向就拒絕），由流程包依 `p_context.strict` 判定；被拒時核心以 `strict = false` 再問一次來分辨「缺情境」與「不符合」 | 流程包的 hook 沒有照 `strict` 實作時，嚴格模式形同虛設。附錄 D 第 2 項要求資料授權流程包配合；核心的測試只能用測試專用的 hook 驗證 |
| 2 | 資料授權的資源粒度 | 例子用「欄位」當資源 | 一張單可能產生幾十筆權限項目，而且這是資料授權流程包契約的決定；若改成「主題包」當資源，多筆授權各涵蓋部分欄位時無法以單次判定合併 |
| 3 | 事件序號用 advisory lock 保證順序 | 鎖只在提交前的片刻持有（延後的觸發程序），對帳分段執行 | 核心的稽核鏈如果也有自己的鎖，兩把鎖的取得順序必須固定，否則可能死結：稽核寫入在交易中途，事件的鎖在提交時，順序是「先稽核、後事件」，所有路徑都要遵守。尖峰時（例如批次核准續期）的等待時間需要實測 |
| 4 | 投影延後到提交時執行 | `constraint trigger`、`initially deferred` | 同一個交易裡在提交之前讀 `sgn.entitlement` 會讀到舊的狀態。需要的地方要明確呼叫 `project_case` 或 `set constraints all immediate`；核心的 function 如果有這種讀法要逐一確認 |
| 5 | 每次判定都寫速率計數與呼叫紀錄 | 兩筆寫入；紀錄表不分割，逾期以「段」為單位刪除 | 判定量很大時（執行系統每次查詢都問），紀錄表的成長與刪除成本可能需要改成按月分割 |
| 6 | 複查決定為縮小、以及對生效中授權的任何修改 | 依賴核心提供縮小的入口 | 骨幹只定義了簽核過程中的縮小，沒有定義生效之後的縮小；核心如果不提供，這個決定實際上等於「限期重新申請，否則撤銷」 |
| 7 | 數量類限制的累計 | 靠使用方回報用量（5.7）；不回報時只檢查單次請求 | 平台無法強迫使用方回報。兩台設備同時各問一次、各蓋 2 份，在任何一台回報之前都會得到允許；要完全防止需要「先預留、再確認」的兩段式協定，第一版不做。超出核准的使用會在回報時被記錄並示警 |
| 8 | 兩個人才能完成的管理動作 | 4.9 的變更申請 | 小型部署可能只有一位系統管理員，這時無法登記任何系統。這是刻意的（一個人不該能替自己開一個讀全部稽核資料的入口），但導入時要先確認人力；A10、A20 定案後角色會重新劃分 |
| 9 | 高嚴重度發現的獨立確認 | 由系統管理員或資源範圍的角色持有人確認 | 確認的人要能實際查看那個系統的設定；不歸資訊單位管的系統（A16）要等受管系統的角色定案，才能指定合適的人 |
| 10 | token 綁定來源位址 | 預設綁定單一位址 | 使用方在會換出口位址的環境（容器平台、雲端 NAT）要登記為 `cidr`，保護力下降為「只限網段」。需要更強的綁定時用 mTLS（1.3） |
| 11 | OCSF 的兩種對應 | 3005／3004 與 6003 | 欄位依 schema 查證過，但沒有對實際的 SIEM 產品驗證（1.1） |
| 12 | 失敗上限的副作用 | 每個系統每分鐘 60 次失敗後限流 | 設計有瑕疵的使用方（例如把 404 當成正常流程大量查詢）會把自己限流。門檻可以對個別系統調整 |

## 附錄 D　對其他契約的要求，以及待納入增修的相依

本文件只能固定自己的範圍。下列各項需要其他文件配合；在它們完成之前，標示的功能或測試無法通過。前三項同時應該登記進 [pending-amendments.md](pending-amendments.md)（本次修訂沒有改那份文件）。

| # | 對象 | 要求 | 影響 |
|---|---|---|---|
| 1 | `03-pack-seal.md`（合約用印） | 登記 `describe_entitlements` 與 `evaluate_constraints`，內容固定如 3.6：一筆權限項目，`resource_type` 是 `company_seal`、`resource_id` 是 `seal_kind` 的值、`actions` 是 `["affix"]`、`constraints` 是 `{"document_sha256": [contract_files 各元素的 sha256，去重排序], "max_copies": copies}`、`effective_during` 是 `fulfilment`；判定規則是 3.6 列的三個條件，`reconcile` 模式一律 false。該契約第 5.9 節與第 1 節「沒有登記的 hook」要跟著改。A11（完全宣告、不寫 hook）成立時，改用附錄 A 第 21 項的宣告，內容相同 | 情境 12；「通用模型不綁資料授權」的證明 |
| 2 | `02-pack-data-access.md`（資料授權）§5.14 | `evaluate_constraints` 依 `p_context.strict` 處理缺少的面向：`strict` 為 true 時，`p_constraints` 有 `row_filter` 而 `context` 沒有、或有 `data_period` 而 `context` 沒有，回 false；`strict` 為 false 時維持現行行為。支援 `approved_union`：回報的列條件與期間落在陣列中各限制條件的聯集內時回 true（做不到就回 false，並在契約註明不支援）。`usage` 鍵忽略。該節的範例 4 要分成 `strict` 為 true 與 false 兩種 | 情境 19、20；`K-INT-CONSTRAINT-MODE` |
| 3 | `04-screens`（畫面契約） | 新增或調整的畫面：變更申請的提出與覆核、密鑰領取、對帳檔案上傳、異常批次的檢視、發現的獨立確認、複查的需求確認與追蹤確認、整合狀態的新項目；驗收條件加入 3.7 最後一列（外來文字當純文字、CSV 跳脫） | 14.2 的端點沒有畫面就無法使用 |
| 4 | `01-kernel.md`（核心） | 附錄 A 的各項；特別是第 1、6、8、9、15、19、20 項 | 投影、驗證、時區、排程 |
| 5 | `seed-directory.md` 與 `sim/` | `sys_admin` 至少兩位（目前只有謝明哲一位）；被授權者在模擬 LDAP 的群組識別碼（本文件的例子假設通路業務組是 `channel-sales`）；人員的 LDAP 識別碼就是代號（`p01`…） | 18.1 的登記腳本與全部端對端情境 |

待納入的增修對本文件的影響（骨幹更新後照下表修改；在那之前本文件的行為如正文所述）：

| 增修 | 本文件要改的地方 |
|---|---|
| A3 申請單保密 | 10.2 已寫明保密流程類型的事件只給 `audit.read_all`；選項的名稱定案後，在 `audit_event_to_native` 引用它。事件與授權查詢是否輸出保密申請單的權限項目，維持輸出（權限項目不是申請內容） |
| A7 人工的獨立驗證 | 8.7 的獨立確認可以改用核心的獨立驗證機制；8.9 最後一段 |
| A10 設定變更走簽核 | 4.9、11.10、13.3 的變更申請改由核心的設定變更申請單承載；`integration_change_request` 資料表與五個 function 移除，獨立性限制改成該申請單的檢查 |
| A12 集團多公司 | `api_client` 增加所屬公司；`api_client_visibility` 增加公司別的維度（null 表示不限）；`client_can_see` 多比對一個欄位；`reconciliation_run` 的範圍、複查的範圍、整合狀態都加上公司別 |
| A16 受管系統 | `api_client` 增加 `resource_system_id`（一個受管系統可以有多個 `api_client`，例如執行系統與報表系統）；可見範圍與對帳批次可以直接以受管系統宣告，取代 `resource_id_prefix` 的慣例；`K-INT-RECON-ASSIGN` 的指派對象、8.9 的上傳人、8.7 可以確認的人，都改為該受管系統的管理人角色（可以是業務單位或有保證人的外部廠商人員）；整合方式（api／file／manual）取代 `upload_enabled` |
| A19 機密欄位 | `describe_entitlements` 只能使用非機密欄位或加密前算出的衍生值；本文件的資料表不保存機密欄位 |
| A20 平台管理角色分離 | 只改 `integration_admin_role()` 與 `integration_auditor_role()`（2.1）。技術維運不得持有 `integration_admin_role()` 的角色；流程管理依公司別、流程類型、受管系統委派時，13.3 的檢查加上範圍 |
| A21 檔案與人工的整合方式 | 檔案上傳對帳已納入（8.9）。人工執行後的獨立驗證屬於核心（A7） |
