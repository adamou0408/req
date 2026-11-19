# 對外整合介面契約：讓其他系統參考、調用並持續把關權限

這份文件定義骨幹第 11 節六項能力的完整契約：權限判定（`check`）、授權查詢（`grants`）、事件（`events`、`webhook_subscription`）、對帳（`reconciliation_run`、`reconciliation_finding`）、定期複查（`access_review_campaign`、`access_review_item`）、證據輸出（`evidence`、`audit_feed`）。

命名、實體、狀態、hook 以 [00-spine.md](00-spine.md) 為準。本文件屬於核心：不得出現任何流程包的代號（範例除外，範例只出現在文件裡，不進 `db/kernel`）。

閱讀順序：第 1 節是採用哪些標準；第 2 節是本模組與核心其他部分的接點；第 3 節是通用模型；第 4 到 10 節逐項說明行為；第 11 到 15 節是實作清單（DDL、function、端點、代碼、參數、排程）；第 16 到 18 節是安全、檔案切分、測試與模擬環境。

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
| OCSF | 1.9.0（schema.ocsf.io 目前的預設版本；1.10.0 開發中） | 給 SIEM 的輸出格式：類別 3005 User Access Management、3004 Entity Management |
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

沒有查證的部分：各標準的認證測試（conformance suite）是否存在與涵蓋範圍；各廠牌 SIEM、IGA 產品實際支援到哪個版本。導入時要對實際對接的產品再確認。

### 1.2 必須採用

| 標準 | 用在哪裡 | 理由 | 風險與處理 |
|---|---|---|---|
| AuthZEN Authorization API 1.0 | 權限判定的請求、回應、路徑、中繼資料 | 已是定案的最終規格；模型（主體、資源、動作、情境）與骨幹第 11 節的通用結構一致；支援 AuthZEN 的閘道與應用程式不用為本平台寫專屬程式 | 規格定案不到一年，產品支援還不普遍。處理：介面本身就是簡單的 JSON POST，不支援 AuthZEN 的系統照文件呼叫即可 |
| OAuth 2.0 client credentials（RFC 6749 4.4）＋ Bearer（RFC 6750） | 系統身分的驗證 | 機器對機器最普遍的做法；token 短效，密鑰不隨每次呼叫傳送 | 自建 token 端點要自己顧安全。處理：見第 4 節與第 16 節；之後可改接公司的身分提供者（見 1.3） |
| CloudEvents 1.0.2（JSON 格式） | 事件串流與 webhook 的事件格式 | 事件匯流排、閘道、SIEM 收集器普遍認得；推送與拉取用同一種格式 | `type` 建議以反向網域開頭，本平台沒有固定網域，用 `sgn.` 開頭。屬於 SHOULD，不影響相容 |
| Standard Webhooks 1.0.0 | webhook 的標頭、簽章、重試、停用條件 | 各語言有現成的驗證函式庫；簽章涵蓋 id、時間與內容，能防重放 | 不是標準組織的規格。內容欄位用 CloudEvents 的 `time`，不是它建議的 `timestamp`；驗證函式庫只看標頭與原始內容，不受影響。`v2a` 是規格較新的部分，函式庫支援可能落後，所以同時送 `v1` 與 `v2a` |
| OCSF 1.9.0 | 稽核事件給 SIEM 的輸出格式（`format=ocsf`） | 主要 SIEM 與資安資料湖的共通格式 | OCSF 沒有「簽核」的類別，只能對應到 3005 與 3004，細節放在 `unmapped`。平台原生格式仍是完整來源 |
| JWS／JWK（Ed25519） | 檢查點簽章、公開金鑰發布 | 第三方用任何 JOSE 函式庫都能驗 | RFC 9864 剛把演算法代號從 `EdDSA` 改成 `Ed25519`。本平台簽章用 `Ed25519`；驗證工具兩個代號都接受 |

### 1.3 選用（介面已留位置，第一版不實作）

| 項目 | 做法 | 為什麼不放第一版 |
|---|---|---|
| RFC 3161 外部時間戳記 | 設定了時間戳記服務的網址才啟用；檢查點多一個 `tsa_token` | 需要公司有可用的時間戳記服務；沒有它，檢查點簽章與對外寄送仍然成立 |
| AuthZEN Search API（subject、resource、action 三個搜尋） | 之後加在 `/access/v1/search/*`；中繼資料目前不列這三個端點，依規格代表不支援 | `grants` 查詢已涵蓋需求，而且回的資訊更多 |
| SSF 1.0 發送端（以 SET 傳送事件） | 之後可以把同一批事件用自訂的事件類型 URI 包成 SET | 接收端多半是身分提供者，只認 CAEP、RISC 的事件類型；本平台的事件不屬於這些類型 |
| 改由公司的身分提供者發 token（JWT，RFC 9068） | `api_client` 對應到身分提供者的 client | 身分提供者尚未確認 |
| `private_key_jwt`（RFC 7523）、mTLS（RFC 8705）的 client 驗證 | `api_client_credential` 之後加憑證種類 | 第一版先求能上線；密鑰只在 token 端點出現一次 |
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
| 檢查人的角色 | ⟨`sgn_internal.require_role(p_actor, 角色代碼)`⟩ | 用到 `sys_admin`、`auditor` |
| 找直屬主管 | ⟨`sgn_internal.resolve_manager(p_person_id)`⟩ | 骨幹第 7 節的升級規則：找不到上一層時交給系統管理員群組 |
| 找範圍角色的持有人 | ⟨`sgn_internal.resolve_scoped_role(角色, scope_ref)`⟩ | 複查對象是「擁有者」時使用 |
| 找有效的代理人 | ⟨`sgn_internal.resolve_delegate(p_person_id)`⟩ | 複查工作適用 `K-DELEGATE` |
| 寫通知 | ⟨`sgn_internal.enqueue_notification(事件代碼, 收件人, 內容)`⟩ | 寫入 `notification_outbox` |
| 計算工作天 | ⟨`sgn_internal.add_workdays(時間, 天數)`⟩ | 依 `calendar_holiday` |
| 撤銷授權 | ⟨`sgn_internal.revoke_grant(p_grant_id, p_actor, p_reason, p_rule_code)`⟩ | 複查與逾期處理要以自己的規則代碼撤銷；走核心唯一的狀態轉移入口 |

本模組假設的核心欄位（只列用到的）：

| 資料表 | 欄位 |
|---|---|
| `sgn.person` | `id bigint`、狀態（是否在職） |
| `sgn.person_identity` | `provider text`、`external_id text`、`person_id` |
| `sgn.principal` | `id bigint`、類型（`team`／`project`／`agent`）、名稱、負責人的 `person_id`、狀態 |
| `sgn.principal_member` | `principal_id`、`person_id`、生效期間 |
| `sgn.process_type` | `id bigint`、`code text`、選項、hook 函式名稱 |
| `sgn."case"` | `id bigint`、單號、流程類型、申請人、被授權者、級別、狀態、目前版本、來源單 |
| `sgn."grant"` | `id bigint`、申請單、被授權者、有效起迄、狀態 |
| `sgn.audit_event` | 序號、時間、actor、動作、申請單、規則代碼、參數快照、路徑版本、變更內容、前一筆雜湊、本筆雜湊 |

`case` 與 `grant` 是 SQL 保留字，本文件的 DDL 一律加雙引號。

### 2.2 核心必須呼叫的投影入口

整理好的權限表（`sgn.entitlement`）與事件，由下面兩個入口在**同一個交易**裡更新。核心在這些時機呼叫它們；這是本模組唯一要求核心配合的地方。

| 入口 | 核心在什麼時候呼叫 |
|---|---|
| `sgn_internal.project_case(p_case_id bigint, p_rule_code text default null)` | 每一次申請單狀態轉移完成之後（狀態轉移的唯一入口裡呼叫一次即可）；`grant` 建立、狀態改變、有效起迄改變之後；生效中的申請單內容版本改變之後。`p_rule_code` 傳造成這次改變的規則代碼（例如 `K-EXPIRE`、`K-REVOKE`） |
| `sgn_internal.project_principal(p_principal_id bigint, p_event text, p_detail jsonb default '{}')` | 被授權者的負責人改變（`owner_changed`）、負責人離職或調職開始寬限期（`owner_at_risk`）、成員加入或移除（`member_added`、`member_removed`）之後 |

`project_case` 依「目前的狀態」重新整理，不依賴呼叫的次數與順序；沒有改變時不產生事件，所以多呼叫幾次是安全的。`project_principal` 每呼叫一次就產生一個事件，核心對每一次異動只呼叫一次。

migration 的順序要求：定義這兩個入口的檔案，必須排在建立核心資料表的檔案之後、定義申請單與授權生命週期 function 的檔案之前（見第 17 節）。

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
- 保留的 provider `sgn`：`id` 是內部 id 的十進位字串。任何呼叫方都可以在 `properties.provider` 指定 `sgn` 或其他 provider 來覆寫預設。
- 回應與事件裡的主體，用呼叫方的 provider 表示；該主體在這個 provider 沒有對應時，改用 `sgn` 並在 `properties.provider` 標明。被授權者另外帶 `properties.kind`（`team`、`project`、`agent`）。

主體與授權的關係：

| 流程類型的 `uses_principal` | 權限項目的主體 |
|---|---|
| 是 | 申請單的被授權者（`principal`） |
| 否 | 申請人（`person`） |

人透過成員身分取得被授權者的權限：判定與查詢一個 `person` 時，除了直接以他為主體的權限項目，也包含他目前是有效成員的所有被授權者的權限項目。回應的 `subject` 是實際持有權限的被授權者，並以 `inherited` 標明這是透過成員身分取得的。成員關係由 `sgn_internal.subject_principals` 這一個入口解析。

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
- function 必須是 `stable`，不得寫入任何資料表。
- 核心只在投影時呼叫它；判定時不呼叫。

`effective_during` 與 `scope_ref` 是本文件對骨幹回傳結構的補充，兩者都選填，不填時行為與骨幹原本的定義相同（見附錄 A）。

**`evaluate_constraints(p_constraints jsonb, p_context jsonb) returns boolean`**

核心在兩種場合呼叫，以 `p_context.mode` 區分：

```json
{
  "mode": "check",
  "at": "2026-11-19T02:15:00Z",
  "subject": {"type": "principal", "id": "17"},
  "action": {"name": "read", "properties": {}},
  "resource": {"type": "data_field", "id": "sales_orders.amount", "properties": {}},
  "context": {}
}
```

| `mode` | 什麼時候 | `context` 的內容 | 流程包要回答 |
|---|---|---|---|
| `check` | 權限判定 | 呼叫方在請求裡給的 `context`，原樣傳入 | 這次存取是否落在限制條件之內。請求沒有提到的面向怎麼處理，由流程包決定並寫在自己的契約裡 |
| `reconcile` | 對帳 | 其他系統回報的那一筆實際權限的 `constraints` | 實際設定的範圍是否完全落在核准的限制條件之內。回報沒有提到的面向，一律視為「沒有限制」 |

`p_context.subject` 用內部 id（provider `sgn`）。function 必須是 `stable`，不得寫入資料表，不得丟出例外（無法判定就回 false）。

核心的呼叫規則（`sgn_internal.call_evaluate_constraints`）：

- `constraints` 是 `{}`：不呼叫 hook，視為符合。
- `constraints` 不是 `{}`，而流程類型沒有登記這個 hook：視為不符合（無法驗證就拒絕）。
- hook 丟出例外：視為不符合，並記下錯誤。

### 3.4 權限項目什麼時候有效

每一筆權限項目有三種狀態：`pending`（已核准，尚未生效）、`active`（有效）、`ended`（已結束）。狀態由申請單與 `grant` 的狀態推導，推導規則依 `effective_during`：

**`effective_during = active`**（持續性的授權；預設）

| 情況 | 權限項目 |
|---|---|
| 申請單有 `grant` 且 `grant.status = active` | `active`；有效期間取 `grant` 的有效起迄 |
| `grant.status = expired` | `ended`，原因 `expired` |
| `grant.status = revoked` | `ended`，原因 `revoked` |
| 還沒有 `grant`，申請單在 `pending_fulfilment` 或 `verifying` | `pending` |
| 還沒有 `grant`，申請單在 `completed` | `ended`，原因 `completed` |
| 申請單在 `cancelled` | `ended`，原因 `cancelled` |
| 申請單在 `draft`、`in_approval`、`returned` | 沒有權限項目 |

**`effective_during = fulfilment`**（一次性的許可：核准後到執行完成之間有效）

| 情況 | 權限項目 |
|---|---|
| 申請單在 `pending_fulfilment` | `active`；起始時間是進入該狀態的時間，沒有結束時間 |
| 申請單在 `verifying`、`completed`、`active` | `ended`，原因 `consumed` |
| 申請單在 `cancelled`、`revoked`、`expired` | `ended`，原因同申請單狀態 |
| 申請單在 `draft`、`in_approval`、`returned` | 沒有權限項目 |

同一張單裡，上一次有、這一次 `describe_entitlements` 沒有回傳的項目：`ended`，原因 `removed`。

判定時另外檢查時間：`active` 的項目還必須符合 `effective_from <= 現在`，而且 `effective_until` 是 null 或 `現在 < effective_until`。所以到期時間一到判定就拒絕，不用等排程把 `grant` 改成 `expired`。

`grant` 的有效迄日如果是日期（不含時間），`effective_until` 取迄日次日的 00:00（資料庫時區）；起日取當日 00:00。

### 3.5 例子一：資料授權

申請內容（摘要）：被授權者是團隊「業務分析部」；主題包「銷售訂單」的 `order_id`、`order_date`、`region`、`amount` 四個欄位；列條件「區域 in（北、中）」；資料期間 2024 年；不可匯出；授權起迄 2026-11-10 到 2027-05-09。

流程包的 `describe_entitlements` 回傳（每個欄位一筆，四筆只列兩筆）：

```json
[
  {
    "resource_type": "data_field",
    "resource_id": "sales_orders.amount",
    "actions": ["read"],
    "constraints": {
      "row_filter": [{"field": "region", "op": "in", "values": ["北", "中"]}],
      "data_period": {"field": "order_date", "from": "2024-01-01", "to": "2024-12-31"}
    },
    "scope_ref": "sales_orders"
  },
  {
    "resource_type": "data_field",
    "resource_id": "sales_orders.region",
    "actions": ["read"],
    "constraints": {
      "row_filter": [{"field": "region", "op": "in", "values": ["北", "中"]}],
      "data_period": {"field": "order_date", "from": "2024-01-01", "to": "2024-12-31"}
    },
    "scope_ref": "sales_orders"
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

報表系統問「林怡君（團隊成員）現在能不能讀 2024 年 3 月北區的訂單金額」：

```json
{
  "subject": {"type": "person", "id": "p04"},
  "action": {"name": "read"},
  "resource": {"type": "data_field", "id": "sales_orders.amount"},
  "context": {
    "row_filter": [{"field": "region", "op": "in", "values": ["北"]}],
    "data_period": {"from": "2024-03-01", "to": "2024-03-31"}
  }
}
```

流程包的 `evaluate_constraints` 在 `check` 模式下判定「請求的範圍是否是核准範圍的子集」：區域 {北} ⊆ {北, 中}，期間在 2024 年內，回 true。請求沒有帶 `row_filter` 時，資料授權的做法是該面向不檢查，並由回應裡的 `constraints` 告訴使用方必須自己套用這個條件。

對帳時，執行系統回報「角色 sales-analysis 對 `sales_orders.amount` 有 `read`，列條件是區域 in（北、中、南）」。`reconcile` 模式下 {北, 中, 南} ⊄ {北, 中}，回 false，產生「超出核准範圍」的發現。回報裡完全沒有列條件時，視為沒有限制，同樣是超出。

資料授權使用的資源類型、動作名稱與限制條件的鍵，以資料授權流程包的契約為準；這裡的例子說明整合介面假設的對應方式。

### 3.6 例子二：合約用印

申請內容（摘要）：申請人吳家豪；合約「年度審計委任合約」，對象「正大聯合會計師事務所」；合約專用章；用印 2 份；合約檔案的 SHA-256 是 `9f2c…e1`。

流程包的 `describe_entitlements` 回傳：

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

| 申請單欄位 | 通用模型 |
|---|---|
| 申請人 | 主體 `{"type": "person"}`（這個流程不使用被授權者） |
| 印鑑種類 | 資源 `company_seal`，`id` 是印鑑代碼 |
| 用印 | 動作 `affix` |
| 合約檔案、用印份數 | 限制條件 `document_sha256`、`max_copies` |
| 有效時間 | `effective_during = fulfilment`：核准後到印鑑管理人標記完成之間有效；標記完成後 `ended`，原因 `consumed` |

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

流程包的 `evaluate_constraints` 判定：文件雜湊在核准清單內，而且份數不超過 2，回 true。這個流程對缺少情境的處理和資料授權不同：請求沒有帶 `document_sha256` 一律回 false，因為「蓋在哪一份文件上」正是核准的內容。

同一套核心程式處理這兩個例子，差別只在兩個 hook 的實作與 `effective_during` 的值。

### 3.7 共通的表示方式

| 項目 | 規定 |
|---|---|
| 時間 | RFC 3339、UTC、以 `Z` 結尾、精確到秒，例如 `2026-11-19T02:15:00Z`。由資料庫以 `to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` 產生 |
| 對外的識別碼 | `entitlement_id`、`grant_id`、`run_id`、`finding_id`、`checkpoint_id`、`item_id` 一律是字串（內部 id 的十進位表示）。使用方不得假設它們連續或可以推算 |
| 序號與計數 | 數字。事件的 `sequence` 例外：依 CloudEvents 的擴充規格是補零的字串 |
| 雜湊 | 小寫十六進位字串 |
| 游標 | 不透明的字串，只能原樣帶回 |
| 沒有值 | 欄位仍然出現，值是 null；清單是空陣列 |

## 4. 系統身分：`api_client`

### 4.1 登記

呼叫整合介面的每一個系統，都要先由系統管理員（角色 `sys_admin`）登記成一個 `api_client`。登記、修改、停用都要填原因，並寫入稽核事件。

| 欄位 | 說明 |
|---|---|
| `code` | 系統代碼，同時是 OAuth 的 `client_id`。符合 `^[a-z][a-z0-9-]{2,47}$`，建立後不可修改 |
| `name`、`description` | 名稱與用途 |
| `owner_person_id` | 這個系統的負責人，必須是在職的人。對帳發現與停用通知都找他 |
| `identity_provider` | 這個系統用哪個身分來源識別主體（見 3.2） |
| `scopes` | 可以使用的能力（見 4.4） |
| 可見範圍 | 可以看到哪些流程類型、哪些資源（見 4.5） |
| `allowed_webhook_origins` | 允許的 webhook 網址來源（scheme＋host＋port），例如 `https://bi.example.com` |

負責人不在職時（`K-INT-CLIENT-OWNER`）：排程通知他的直屬主管改派，寬限期是參數 `integration.client_owner_grace_days`；逾期未改派，狀態改為 `suspended`。這和授權的 `K-OWNER-CONTINUITY` 是同一個原則：沒人負責就失效。

### 4.2 憑證（client secret）

- 由資料庫以 `pgcrypto` 的 `gen_random_bytes(32)` 產生，格式是 `sgn_cs_` 加上 43 個 base64url 字元。只在建立時回傳一次；資料庫只保存它的 SHA-256 與最後 4 個字元（供辨識）。
- 密鑰是 256 位元的隨機值，不是人設定的密碼，所以用單次 SHA-256 保存即可，不需要慢速雜湊。
- 每個憑證都有到期日，不得超過 `integration.credential_max_age_days`。到期前 `integration.credential_remind_before_days` 天起，排程每週通知負責人一次（`K-INT-CRED-EXPIRE`）。到期後不能再換發 token。
- 每個 `api_client` 同時有效的憑證不超過 `integration.credential_max_active` 個。
- 輪替：建立新憑證 → 使用方換上新密鑰 → 撤銷舊憑證。兩者並存期間都能用。
- 撤銷憑證時，由它換發且尚未過期的 token 同時失效。

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
- 後端在呼叫資料庫之前，先把收到的密鑰與 token 做 SHA-256，資料庫的參數裡只會出現雜湊值。
- 錯誤依 RFC 6749 第 5.2 節回應，內容是 `{"error": "...", "error_description": "..."}`：

| 情況 | HTTP | `error` |
|---|---|---|
| 沒有 Basic 驗證、`client_id` 不存在、密鑰錯誤、憑證過期或已撤銷、`api_client` 不是 `active` | 401，並帶 `WWW-Authenticate: Basic realm="sgn-integration"` | `invalid_client` |
| `grant_type` 不是 `client_credentials` | 400 | `unsupported_grant_type` |
| 參數缺少、重複或格式錯誤 | 400 | `invalid_request` |
| 要求的 scope 超出登記範圍 | 400 | `invalid_scope` |
| 換發太頻繁（`integration.token_rate_limit_per_minute`） | 429，並帶 `Retry-After` | `invalid_request`，`error_description` 是 `rate_limited` |

`invalid_client` 的各種原因對外完全相同，實際原因只寫進呼叫紀錄。

### 4.4 可用範圍（scope）

| scope | 可以做的事 |
|---|---|
| `check` | 權限判定 |
| `grants.read` | 授權查詢 |
| `events.read` | 讀取事件串流（授權與被授權者的事件） |
| `webhooks.manage` | 管理自己的 webhook 訂閱 |
| `reconciliation.write` | 回報實際權限、讀取自己的對帳結果與發現 |
| `reviews.read` | 讀取定期複查的結果 |
| `audit.read` | 讀取可見流程類型的稽核事件 |
| `audit.read_all` | 讀取全部稽核事件（給 SIEM、GRC；等同稽核角色的檢視範圍）。它只擴大 `audit.read` 的範圍，所以必須與 `audit.read` 一起登記 |
| `evidence.read` | 讀取鏈頭與檢查點 |

每個對外 function 需要哪個 scope，登記在資料表 `sgn.api_function_scope`，這是唯一來源；路由表與參考文件由它產生。

### 4.5 可見範圍

`sgn.api_client_visibility` 的每一列是一條允許規則：

| 欄位 | 意義 |
|---|---|
| `process_type_id` | 可見的流程類型（必填） |
| `resource_type` | 只看這個資源類型；null 表示該流程類型的全部資源 |
| `resource_id_prefix` | 只看 `resource_id` 以這段文字開頭的資源；null 表示不限 |

一筆權限項目對某個 `api_client` 可見，條件是至少有一列規則符合：流程類型相同，`resource_type` 是 null 或相同，`resource_id_prefix` 是 null 或是 `resource_id` 的開頭（以 `starts_with` 比對，不是樣式比對）。

主體沒有獨立的可見規則：一個主體是否可見，取決於它有沒有可見的權限項目。

規則 `K-INT-VISIBILITY`：所有查詢、判定、事件、對帳、稽核輸出都先套用可見範圍。範圍以外的東西，回應與「不存在」完全相同。

### 4.6 暫停與停用

| 狀態 | 意義 | 效果 |
|---|---|---|
| `active` | 正常 | — |
| `suspended` | 暫停，可恢復。由系統管理員設定，或負責人寬限期逾期時由排程設定 | 所有 token 立即無效；不能換發 token；webhook 暫停推送（保留進度） |
| `disabled` | 永久停用，不可恢復 | 同上；另外撤銷所有憑證，webhook 訂閱改為 `disabled` |

狀態在每次呼叫時檢查，所以暫停與停用是立即生效，不受 token 的有效時間影響。

### 4.7 每次呼叫的紀錄

規則 `K-INT-CALL-LOG`：對 `/integration/v1/` 的每一次呼叫，不論成功或失敗，都在 `sgn.api_call_log` 留一筆。

- 成功的呼叫：由被呼叫的 `api` function 在同一個交易內寫入（`sgn_internal.log_api_call`）。
- 失敗的呼叫（function 丟出錯誤，交易已回復）：由後端另外呼叫 `api.integration_record_failure` 寫入。
- 記錄的內容：時間、`api_client`、token、請求識別碼、function 名稱、HTTP 狀態、錯誤代碼、耗時、來源 IP、筆數、摘要。
- 摘要（`summary`）依端點不同：權限判定記每一筆的主體、動作、資源、結果、原因與依據的權限項目 id；查詢記篩選條件與回傳筆數；對帳記批次與筆數。情境（`context`）不記原文，只記 SHA-256，因為裡面可能有業務資料。
- 這張表只增不改。排程每天把前一天的紀錄算出摘要雜湊，寫成一筆稽核事件（動作 `integration.call_log_sealed`），之後任何竄改都能從稽核鏈查出。超過 `integration.call_log_retention_days` 而且已封存的紀錄由排程刪除，刪除也寫稽核事件。

每日摘要雜湊的算法：

```sql
select encode(digest(string_agg(
           jsonb_build_object(
               'id', id, 'called_at', called_at, 'api_client_id', api_client_id,
               'function_name', function_name, 'http_status', http_status,
               'error_code', error_code, 'request_id', request_id,
               'summary_sha256', encode(digest(summary::text, 'sha256'), 'hex')
           )::text, E'\n' order by id), 'sha256'), 'hex')
  from sgn.api_call_log
 where called_at >= p_day and called_at < p_day + interval '1 day';
```

### 4.8 速率限制

規則 `K-INT-RATE-LIMIT`：

- 每個 `api_client` 每分鐘的呼叫數上限是 `integration.rate_limit_per_minute`，可以用適用範圍 `scope_ref`（值為 `api_client:<code>`）對個別系統設定不同的值。
- 以固定的一分鐘視窗計數（視窗起點是整分鐘）。計數在 `sgn.api_rate_counter`，由 `sgn_internal.authenticate_client` 在驗證 token 的同一步累加，所以多個後端執行個體共用同一個計數。
- 超過上限回 429、錯誤代碼 `integration_rate_limited`，後端加上 `Retry-After`，值是到下一個整分鐘的秒數。
- 批次判定的一次呼叫算一次，不論裡面有幾筆。
- 資料庫的計數在請求失敗時會隨交易回復，所以失敗的請求（驗證失敗、格式錯誤）不會被它計入。這一部分由後端負責：後端對 `/integration/v1/` 的全部請求（包含 token 端點）套用既有的依來源 IP 限制，避免用無效請求灌爆紀錄表。

## 5. 權限判定（`check`）

### 5.1 端點

依 AuthZEN Authorization API 1.0。PDP 識別碼是參數 `integration.issuer` 的值（例如 `https://sgn.example.com/integration/v1`）。

| 用途 | 方法與路徑 | scope |
|---|---|---|
| 單筆判定 | `POST /integration/v1/access/v1/evaluation` | `check` |
| 批次判定 | `POST /integration/v1/access/v1/evaluations` | `check` |
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
  "subject": {"type": "person", "id": "p04"},
  "action": {"name": "read"},
  "resource": {"type": "data_field", "id": "sales_orders.amount"},
  "context": {
    "row_filter": [{"field": "region", "op": "in", "values": ["北"]}],
    "data_period": {"from": "2024-03-01", "to": "2024-03-31"}
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
        "case_no": "DA-2026-0042",
        "process_type": "data_access",
        "tier": "L3",
        "subject": {"type": "principal", "id": "sales-analysis", "properties": {"kind": "team", "provider": "ldap"}},
        "inherited": true,
        "actions": ["read"],
        "valid_from": "2026-11-09T16:00:00Z",
        "valid_until": "2027-05-09T16:00:00Z",
        "constraints": {
          "row_filter": [{"field": "region", "op": "in", "values": ["北", "中"]}],
          "data_period": {"field": "order_date", "from": "2024-01-01", "to": "2024-12-31"}
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
| false | `constraint_not_satisfied` | 有有效的權限項目，但情境不符合限制條件 | 那些有效但不符合的項目 |
| false | `not_yet_effective` | 有權限項目，但還在 `pending`，或起始時間未到 | 那些項目 |
| false | `ended` | 曾經有，但已在 `integration.check_ended_lookback_days` 天內結束 | 最近結束的那一筆 |
| false | `no_entitlement` | 以上皆非 | 無 |

使用方必須處理的事（規則 `K-INT-CHECK-BASIS`）：

- `decision` 是 true 時，`basis[].constraints` 是核准的完整限制。請求的 `context` 沒有涵蓋的面向，使用方必須依這份限制自行套用。
- 依 AuthZEN，使用方看不懂回應的 `context` 時可以選擇拒絕。
- 這個介面只回答「核准了什麼」；實際擋下存取的是使用方自己（骨幹第 11 節）。

### 5.3 判定演算法

規則 `K-INT-CHECK`。實作在 `sgn_internal.evaluate_access`，單筆與批次共用。判定時間一律是平台的現在時間；請求的 `context.time` 不會改變判定時點，只會原樣傳給流程包。

1. 解析主體（`sgn_internal.resolve_subject`）。provider 取 `subject.properties.provider`，沒有就取 `api_client.identity_provider`。找不到對應的人或被授權者 → 結果是 `no_entitlement`。
2. 展開主體集合 S。主體是 `principal`：S 只有它自己。主體是 `person`：S 是他自己，加上他目前是有效成員的每一個被授權者。
3. 取候選項目 C：`sgn.entitlement` 中主體屬於 S、`resource_type` 與 `resource_id` 完全相同、`actions` 包含 `action.name`、而且對這個 `api_client` 可見的項目。
4. 取有效項目 E：C 中 `status = 'active'`、`effective_from <= 現在`、`effective_until` 是 null 或 `現在 < effective_until` 的項目。
5. 對 E 的每一筆呼叫 `sgn_internal.call_evaluate_constraints`（`mode` 是 `check`）。通過的集合是 P。
6. 決定結果，依序取第一個成立的：
   - P 不是空的 → true，`granted`。
   - E 不是空的 → false，`constraint_not_satisfied`。
   - C 中有 `pending`，或有 `active` 但 `effective_from > 現在` → false，`not_yet_effective`。
   - C 中有結束時間在回溯天數內的項目（`ended`，或 `active` 但 `effective_until <= 現在`）→ false，`ended`。
   - 其他 → false，`no_entitlement`。

多筆授權不合併：每一筆權限項目各自判定，只要有一筆完整符合就允許。兩筆授權各涵蓋一部分範圍時，使用方要把請求拆成各自的範圍分別判定，或改用授權查詢取得全部限制後自行計算。

主體不存在、資源不在可見範圍、沒有授權，三種情況的回應完全相同（`no_entitlement`、相同的 `ttl_seconds`），呼叫方無法分辨（見第 16 節）。

### 5.4 批次請求與回應

```json
{
  "subject": {"type": "person", "id": "p04"},
  "action": {"name": "read"},
  "context": {"data_period": {"from": "2024-03-01", "to": "2024-03-31"}},
  "options": {"evaluations_semantic": "execute_all"},
  "evaluations": [
    {"resource": {"type": "data_field", "id": "sales_orders.amount"}},
    {"resource": {"type": "data_field", "id": "sales_orders.region"}},
    {"resource": {"type": "data_field", "id": "sales_orders.customer_id"}, "action": {"name": "export"}}
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
            "case_no": "DA-2026-0042",
            "process_type": "data_access",
            "tier": "L3",
            "subject": {
              "type": "principal",
              "id": "sales-analysis",
              "properties": {
                "kind": "team",
                "provider": "ldap"
              }
            },
            "inherited": true,
            "actions": [
              "read"
            ],
            "valid_from": "2026-11-09T16:00:00Z",
            "valid_until": "2027-05-09T16:00:00Z",
            "constraints": {
              "row_filter": [
                {
                  "field": "region",
                  "op": "in",
                  "values": [
                    "北",
                    "中"
                  ]
                }
              ],
              "data_period": {
                "field": "order_date",
                "from": "2024-01-01",
                "to": "2024-12-31"
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
            "case_no": "DA-2026-0042",
            "process_type": "data_access",
            "tier": "L3",
            "subject": {
              "type": "principal",
              "id": "sales-analysis",
              "properties": {
                "kind": "team",
                "provider": "ldap"
              }
            },
            "inherited": true,
            "actions": [
              "read"
            ],
            "valid_from": "2026-11-09T16:00:00Z",
            "valid_until": "2027-05-09T16:00:00Z",
            "constraints": {
              "row_filter": [
                {
                  "field": "region",
                  "op": "in",
                  "values": [
                    "北",
                    "中"
                  ]
                }
              ],
              "data_period": {
                "field": "order_date",
                "from": "2024-01-01",
                "to": "2024-12-31"
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
| true | `integration.decision_ttl_seconds` 與「`basis` 中最早的 `valid_until` 距離現在的秒數」取小的 |
| true，而且 `basis` 有任何一筆是 `effective_during = fulfilment` | 0（一次性的許可，每次都要重新判定） |
| false，`not_yet_effective` | `integration.deny_ttl_seconds` 與「最早的起始時間距離現在的秒數」取小的 |
| 其他 false | `integration.deny_ttl_seconds` |

給使用方的指引：

- 快取的鍵必須包含完整的請求（主體、動作、資源、情境）。不得超過 `ttl_seconds`；值是 0 時不得快取。
- 回應帶 `Cache-Control: no-store`，中間的代理不得快取。
- 有訂閱事件的系統：收到某個主體或資源的 `sgn.grant.*`、`sgn.principal.membership_changed` 事件時，立即清掉相關的快取。這樣撤銷可以在幾秒內反映。
- 沒有訂閱事件的系統：撤銷最慢在 `ttl_seconds` 之後反映。參數的預設值（60 秒）就是這個最壞情況的上限；需要更短就調低參數。
- 平台不可用時怎麼辦由使用方決定並寫進自己的設計。建議：快取過期後拒絕存取（預設拒絕），不要沿用過期的允許結果。

### 5.6 效能

要求（在資料庫 function 內量測；資料量：20 萬筆未結束的權限項目、2 萬個被授權者、5 千人）：

| 項目 | 要求 |
|---|---|
| 單筆判定 | p95 不超過 50 毫秒 |
| 100 筆的批次判定 | p95 不超過 500 毫秒 |

做法：

- 判定只查 `sgn.entitlement`。這張表由投影在狀態改變的當下整理好（規則 `K-INT-PROJECT`）；判定時不呼叫 `describe_entitlements`，不讀申請單內容，不重算任何東西。
- 索引：主體＋資源（`entitlement_principal_idx`、`entitlement_person_idx`）、身分對應（`person_identity`、`principal_identity` 的 `(provider, external_id)`）、成員（`principal_member` 的 `person_id`）、token 雜湊。
- 限制條件是 `{}` 時不呼叫流程包。有限制條件時每筆候選呼叫一次 `evaluate_constraints`；這個 function 被要求是 `stable` 且不寫資料。
- 批次判定在一次 function 呼叫內完成，相同的主體只解析一次。
- 每次呼叫的寫入只有兩筆：速率計數與呼叫紀錄。
- 架構測試用 `explain` 確認判定的查詢沒有對 `sgn.entitlement` 做循序掃描。`tools/bench-integration-check.sh` 產生上述資料量並量測，結果寫進交接紀錄。

## 6. 授權查詢（`grants`）

### 6.1 端點

| 用途 | 方法與路徑 | scope |
|---|---|---|
| 查詢清單 | `GET /integration/v1/grants` | `grants.read` |
| 取得單筆 | `GET /integration/v1/grants/{entitlement_id}` | `grants.read` |

清單的每一筆是一筆權限項目，並帶著所屬的授權與申請單資訊。同一張申請單的項目有相同的 `case_no`。

### 6.2 查詢參數

| 參數 | 說明 |
|---|---|
| `subject_type`、`subject_id` | 依主體查。兩個要一起給。`subject_provider` 選填，覆寫預設的身分來源 |
| `include_inherited` | 主體是 `person` 時，是否包含透過成員身分取得的項目。預設 `true` |
| `resource_type` | 依資源類型查 |
| `resource_id` | 依資源查（完全相同）。必須同時給 `resource_type` |
| `resource_id_prefix` | 依資源識別碼的開頭查。必須同時給 `resource_type`；不可與 `resource_id` 並用 |
| `process_type` | 依流程類型代碼查 |
| `status` | `pending`、`active`、`ended`，可用逗號給多個。預設：沒有 `since` 時是 `active`；有 `since` 時是全部 |
| `since` | 增量同步的游標（見 6.4） |
| `page_token` | 快照分頁的游標（見 6.3）。不可與 `since` 並用 |
| `limit` | 每頁筆數。預設 `integration.page_size_default`，上限 `integration.page_size_max` |

所有條件是「且」的關係。結果一律先套用可見範圍。主體不存在時回空清單，不回錯誤。

### 6.3 回應與分頁

```json
{
  "items": [
    {
      "entitlement_id": "8812",
      "revision": 1,
      "status": "active",
      "grant_id": "431",
      "case_no": "DA-2026-0042",
      "source_case_no": null,
      "process_type": "data_access",
      "tier": "L3",
      "subject": {"type": "principal", "id": "sales-analysis", "properties": {"kind": "team", "provider": "ldap"}},
      "inherited": false,
      "owner": {"type": "person", "id": "p03", "properties": {"provider": "ldap"}},
      "resource": {"type": "data_field", "id": "sales_orders.amount"},
      "actions": ["read"],
      "constraints": {
        "row_filter": [{"field": "region", "op": "in", "values": ["北", "中"]}],
        "data_period": {"field": "order_date", "from": "2024-01-01", "to": "2024-12-31"}
      },
      "valid_from": "2026-11-09T16:00:00Z",
      "valid_until": "2027-05-09T16:00:00Z",
      "ended_at": null,
      "end_reason": null,
      "updated_at": "2026-11-10T03:21:44Z"
    }
  ],
  "next_page_token": null,
  "sync_cursor": "1042-9223372036854775807"
}
```

| 欄位 | 說明 |
|---|---|
| `subject` | 權限項目的主體（被授權者或人） |
| `inherited` | 以 `person` 查詢、而且這一筆是透過成員身分從被授權者取得時為 true；此時 `subject` 是那個被授權者 |
| `owner` | 被授權者的負責人；主體是人時為 null |
| `source_case_no` | 這張單的來源單（續期、變更），沒有時為 null |
| `next_page_token` | 還有下一頁時是不透明字串，沒有時是 null |
| `sync_cursor` | 這次查詢當下的同步位置。做完整快照的系統記下**第一頁**的值，之後用它當 `since` |

快照分頁依 `entitlement_id` 由小到大。分頁期間資料可能改變，所以某一筆可能重複或在快照中漏掉；這些改變的同步序號一定大於第一頁的 `sync_cursor`，之後的增量同步會補上。

游標是不透明的字串，使用方不得解析或自行組合。游標格式錯誤回 400（`integration_cursor_invalid`）。

### 6.4 增量同步

每一筆權限項目有一個同步序號（`sync_seq`），等於最後一次改變它的事件的序號。事件序號與交易提交的順序一致（見 7.4），所以不會出現「序號較小的改變比較晚才看得到」的情況。

`GET /integration/v1/grants?since=<游標>`：回傳同步序號在游標之後的項目，依（同步序號、`entitlement_id`）排序，包含已結束的項目。回應的格式相同，但 `next_page_token` 一律是 null，另外有：

| 欄位 | 說明 |
|---|---|
| `next_since` | 下一次要帶的游標 |
| `has_more` | 是否還有更多（true 時立刻再查一次） |

建議的同步流程：

1. 第一次：不帶 `since` 做完整快照，記下第一頁的 `sync_cursor`。
2. 之後定期（或收到事件時）：帶 `since` 查到 `has_more` 是 false 為止，保存最後的 `next_since`。
3. 每一筆以 `entitlement_id` 為鍵覆蓋本地的資料；`status` 是 `ended` 的就移除對應的權限。

成員異動不會改變權限項目本身，所以不會出現在增量同步裡。需要以人為單位維持權限的系統，要另外處理 `sgn.principal.membership_changed` 事件。

## 7. 事件（`events`、`webhook_subscription`）

### 7.1 事件類型

事件類型登記在資料表 `sgn.integration_event_type`，這是唯一來源。

| 類型 | 什麼時候發生 | 需要的 scope |
|---|---|---|
| `sgn.grant.approved` | 申請單核准，權限項目建立但尚未生效（`pending`） | `events.read` |
| `sgn.grant.activated` | 授權生效 | `events.read` |
| `sgn.grant.changed` | 生效中或待生效的授權，內容或有效期間改變。`change_class` 是 `narrowed`（縮小）、`widened`（擴大）或 `modified`（無法歸類） | `events.read` |
| `sgn.grant.expiring` | 即將到期：距離到期日剩下 `validity.remind_before_days` 天 | `events.read` |
| `sgn.grant.expired` | 到期失效 | `events.read` |
| `sgn.grant.revoked` | 撤銷 | `events.read` |
| `sgn.grant.ended` | 其他原因結束：一次性許可已使用（`consumed`）、取消（`cancelled`）、完成（`completed`） | `events.read` |
| `sgn.principal.owner_changed` | 被授權者的負責人改變 | `events.read` |
| `sgn.principal.owner_at_risk` | 負責人離職或調職，寬限期開始；逾期未改派，授權會被撤銷 | `events.read` |
| `sgn.principal.membership_changed` | 被授權者的成員加入或移除 | `events.read` |
| `sgn.reconciliation.finding_opened` | 這個系統的對帳產生新的發現 | `reconciliation.write` |
| `sgn.reconciliation.finding_closed` | 發現結案 | `reconciliation.write` |
| `sgn.review.campaign_opened` | 一輪定期複查開始 | `reviews.read` |
| `sgn.review.campaign_closed` | 一輪定期複查結束 | `reviews.read` |
| `sgn.evidence.checkpoint` | 產生新的稽核鏈檢查點並完成簽章 | `evidence.read` |
| `sgn.webhook.ping` | webhook 的連線測試（只會出現在 webhook，不在串流裡） | `webhooks.manage` |

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
  "subject": "case/DA-2026-0042",
  "datacontenttype": "application/json",
  "sequence": "00000000000000001042",
  "data": {
    "case_no": "DA-2026-0042",
    "grant_id": "431",
    "process_type": "data_access",
    "tier": "L3",
    "status": "ended",
    "subject": {"type": "principal", "id": "sales-analysis", "properties": {"kind": "team", "provider": "ldap"}},
    "owner": {"type": "person", "id": "p03", "properties": {"provider": "ldap"}},
    "rule_code": "K-REVOKE",
    "change_class": null,
    "valid_from": "2026-11-09T16:00:00Z",
    "valid_until": "2027-05-09T16:00:00Z",
    "entitlements": [
      {
        "entitlement_id": "8812",
        "revision": 1,
        "status": "ended",
        "end_reason": "revoked",
        "ended_at": "2026-11-19T02:15:00Z",
        "resource": {"type": "data_field", "id": "sales_orders.amount"},
        "actions": ["read"],
        "constraints": {
          "row_filter": [{"field": "region", "op": "in", "values": ["北", "中"]}],
          "data_period": {"field": "order_date", "from": "2024-01-01", "to": "2024-12-31"}
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
| `subject` | `case/<申請單號>`、`principal/<內部 id>`、`finding/<id>`、`review/<複查編號>`、`checkpoint/<id>` |
| `sequence` | CloudEvents 的 sequence 擴充屬性：事件序號補零到 20 位數的字串，可以直接用字串比大小 |
| `data` | 依類型，見下 |

`data` 的內容：

| 類型 | `data` |
|---|---|
| `sgn.grant.*` | 如上例。`entitlements` 是這張申請單在改變之後、這個呼叫方可見的**全部**權限項目與各自的狀態。`sgn.grant.expiring` 另帶 `expires_at`、`days_left` |
| `sgn.principal.owner_changed` | `{"principal": 主體, "old_owner": 主體或 null, "new_owner": 主體, "rule_code"}` |
| `sgn.principal.owner_at_risk` | `{"principal": 主體, "owner": 主體, "grace_until": 時間, "rule_code": "K-OWNER-CONTINUITY"}` |
| `sgn.principal.membership_changed` | `{"principal": 主體, "added": [主體…], "removed": [主體…]}` |
| `sgn.reconciliation.finding_opened`、`finding_closed` | 與 8.6 的發現相同的結構 |
| `sgn.review.campaign_opened`、`campaign_closed` | `{"review_no", "process_type", "status", "starts_at", "due_at", "item_count", "summary"}`，`summary` 見 9.6 |
| `sgn.evidence.checkpoint` | 與 10.4 的檢查點相同的結構 |
| `sgn.webhook.ping` | `{"endpoint_id", "message": "ping"}` |

事件內容依呼叫方產生：主體用呼叫方的身分來源表示；`entitlements` 只包含呼叫方可見的項目。一個 `sgn.grant.*` 事件如果沒有任何項目對呼叫方可見，這個呼叫方就不會收到它。`sgn.principal.*` 事件只送給看得到該被授權者任何一筆權限項目（不論狀態）的呼叫方。撤銷原因是使用者填寫的文字，可能含有個人資料，事件裡只帶規則代碼，不帶原因的文字。

事件是通知，不是授權的依據。使用方在**放寬**存取之前，應該以權限判定或授權查詢再確認一次；**收緊**存取可以直接依事件處理。

### 7.3 事件串流（可重播）

```http
GET /integration/v1/events?after=00000000000000001040&limit=100&types=sgn.grant.revoked,sgn.grant.expired HTTP/1.1
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
      "subject": "case/DA-2026-0042",
      "datacontenttype": "application/json",
      "sequence": "00000000000000001042",
      "data": {
        "case_no": "DA-2026-0042",
        "grant_id": "431",
        "process_type": "data_access",
        "tier": "L3",
        "status": "ended",
        "subject": {
          "type": "principal",
          "id": "sales-analysis",
          "properties": {
            "kind": "team",
            "provider": "ldap"
          }
        },
        "owner": {
          "type": "person",
          "id": "p03",
          "properties": {
            "provider": "ldap"
          }
        },
        "rule_code": "K-REVOKE",
        "change_class": null,
        "valid_from": "2026-11-09T16:00:00Z",
        "valid_until": "2027-05-09T16:00:00Z",
        "entitlements": [
          {
            "entitlement_id": "8812",
            "revision": 1,
            "status": "ended",
            "end_reason": "revoked",
            "ended_at": "2026-11-19T02:15:00Z",
            "resource": {
              "type": "data_field",
              "id": "sales_orders.amount"
            },
            "actions": [
              "read"
            ],
            "constraints": {
              "row_filter": [
                {
                  "field": "region",
                  "op": "in",
                  "values": [
                    "北",
                    "中"
                  ]
                }
              ],
              "data_period": {
                "field": "order_date",
                "from": "2024-01-01",
                "to": "2024-12-31"
              }
            }
          }
        ]
      }
    }
  ],
  "next_cursor": "00000000000000001057",
  "has_more": false
}
```

| 參數 | 說明 |
|---|---|
| `after` | 游標：回傳在它之後的事件。省略時從最早的事件開始。特殊值 `tail`：不回事件，只回目前最新位置的游標 |
| `types` | 只要這些類型，逗號分隔。省略時是呼叫方的 scope 允許的全部類型 |
| `limit` | 預設 `integration.page_size_default`，上限 `integration.page_size_max` |

規則：

- `next_cursor` 是這次掃描到的位置。即使 `events` 是空的（掃過的事件都不可見或不符合類型），游標也會前進；使用方每次都要保存它。
- 事件永久保留，任何時候都可以從任何游標重播。
- 需要 scope `events.read`；其他類別的事件另外需要 7.1 所列的 scope，沒有該 scope 的類型不會出現（不回錯誤）。
- 建議的輪詢間隔不低於 5 秒；`has_more` 是 true 時可以立即再讀。

### 7.4 順序與送達保證

規則 `K-INT-EVENT-ORDER`：

- **全域順序**：事件序號嚴格遞增，而且與交易提交的順序一致。做法：`sgn_internal.emit_integration_event` 在取序號之前，先取得一個交易層級的 advisory lock（`pg_advisory_xact_lock`，固定的鍵），鎖到交易結束才釋放。所以任何時候讀到的最大序號之前，不會再有較小的序號出現；同一張申請單的事件一定依發生順序排列。序號可能跳號（交易回復），不影響順序。
- **至少一次**：串流可以重讀；webhook 在沒有收到成功回應時會重送。使用方必須以事件的 `id` 去重。
- **webhook 依序**：每個訂閱一次只送一個事件，前一個成功之後才送下一個。前一個還在重試時，後面的事件等待。
- **不保證恰好一次**，也不保證 webhook 與串流之間的先後。

取鎖的代價是：會產生事件的交易彼此排隊。事件只在授權狀態改變時產生，數量遠少於判定與查詢，這個代價可以接受。

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
- 每個 `api_client` 的訂閱數上限是 `integration.webhook_max_per_client`。
- `secret` 只在建立與輪替的回應出現。它不存在資料庫裡：後端用部署設定的主金鑰推導，`secret = HMAC-SHA256(主金鑰, "sgn-webhook-v1:" + endpoint_id + ":" + secret_version)`，取 32 個位元組，以 `whsec_` 加 base64 表示。資料庫只保存 `secret_version`。
- 新訂閱的狀態是 `pending_verification`。平台先送一個 `sgn.webhook.ping`；收到 2xx 才改為 `enabled`，並從建立當下之後的事件開始推送。
- 輪替密鑰：`secret_version` 加一。之後的 `integration.webhook_secret_overlap_hours` 小時內，每次推送同時帶新舊兩把密鑰的 `v1` 簽章。
- 修改 `status`：`enabled` → `paused` 暫停推送並保留進度；`paused` 或 `disabled` → `enabled` 時可以給 `resume_from`：`cursor`（預設，從上次成功的位置接著送，不漏事件）或 `tail`（跳到最新，漏掉的部分自己用串流或授權查詢補）。從 `disabled` 恢復會重新送 ping 驗證。
- 刪除是軟刪除（保留送達紀錄）。

訂閱的狀態：

| 狀態 | 意義 |
|---|---|
| `pending_verification` | 等 ping 成功 |
| `enabled` | 推送中 |
| `paused` | 呼叫方或系統管理員暫停 |
| `disabled` | 被停用（原因見 `status_reason`）。要恢復必須明確改回 `enabled` |

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
- 每一次嘗試都記在 `sgn.webhook_attempt`。

推送由後端的 worker 執行（與寄信的 worker 相同的模式）：向資料庫領取要送的事件、簽章、送出、回報結果。重試的時間與停用的判斷都在資料庫的 function 裡。

## 8. 對帳（`reconciliation_run`、`reconciliation_finding`）

### 8.1 流程

其他系統定期把「自己實際設定的權限」回報給平台，平台與核准的權限項目比對。

```
建立批次（collecting）→ 分批上傳實際權限 → 宣告完成（comparing）→ 排程比對（completed）→ 產生或結案發現
```

| 步驟 | 方法與路徑 | scope |
|---|---|---|
| 建立批次 | `POST /integration/v1/reconciliation/runs` | `reconciliation.write` |
| 上傳項目 | `POST /integration/v1/reconciliation/runs/{run_id}/items` | `reconciliation.write` |
| 宣告完成 | `POST /integration/v1/reconciliation/runs/{run_id}/complete` | `reconciliation.write` |
| 查批次狀態與結果 | `GET /integration/v1/reconciliation/runs/{run_id}` | `reconciliation.write` |
| 查自己的發現 | `GET /integration/v1/reconciliation/findings` | `reconciliation.write` |

每個批次是某個範圍的**完整快照**：範圍內沒有回報的權限，就代表該系統沒有設定。

### 8.2 建立批次

```json
{
  "process_type": "data_access",
  "resource_type": "data_field",
  "resource_id_prefix": "sales_orders.",
  "observed_at": "2026-11-19T01:00:00Z"
}
```

```json
{
  "run_id": "205",
  "status": "collecting",
  "process_type": "data_access",
  "resource_type": "data_field",
  "resource_id_prefix": "sales_orders.",
  "observed_at": "2026-11-19T01:00:00Z",
  "item_count": 0,
  "created_at": "2026-11-19T01:02:11Z",
  "completed_at": null,
  "summary": null
}
```

規則：

- `process_type` 必填。`resource_type`、`resource_id_prefix` 選填，用來宣告這次快照涵蓋的範圍；`resource_id_prefix` 必須搭配 `resource_type`。
- 宣告的範圍必須完全落在呼叫方的可見範圍內：存在一列可見規則，流程類型相同，規則的 `resource_type` 是 null 或與宣告的相同，規則的 `resource_id_prefix` 是 null 或是宣告的 `resource_id_prefix` 的開頭。否則回 403（`integration_scope_not_visible`）。
- `observed_at` 是該系統讀取自己權限設定的時間，不得晚於現在，也不得早於現在減去 `reconciliation.collect_timeout_hours`。
- 同一個呼叫方、同一個範圍已有 `collecting` 的批次時，舊的批次改為 `abandoned`。
- 超過 `reconciliation.collect_timeout_hours` 仍未宣告完成的批次，由排程改為 `abandoned`。

### 8.3 上傳項目

```json
{
  "items": [
    {
      "item_key": "grp_sales_analysis|sales_orders.amount|read",
      "subject": {"type": "principal", "id": "sales-analysis"},
      "resource": {"type": "data_field", "id": "sales_orders.amount"},
      "action": {"name": "read"},
      "constraints": {
        "row_filter": [{"field": "region", "op": "in", "values": ["北", "中", "南"]}],
        "data_period": {"field": "order_date", "from": "2024-01-01", "to": "2024-12-31"}
      },
      "properties": {"db_role": "grp_sales_analysis", "policy": "rls_sales_orders_17"}
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
| `item_key` | 否 | 該系統自己的唯一鍵，1 到 256 個字元。省略時由平台以主體、資源、動作算出。同一批次內相同的鍵，後送的取代先送的（重送安全） |
| `properties` | 否 | 該系統自己的參考資訊（角色名稱、規則編號），原樣保存在證據裡，不參與比對。序列化後不超過 4 KB |

規則：

- 一次請求最多 `reconciliation.items_per_request_max` 筆；一個批次最多 `reconciliation.max_items` 筆。
- 每一筆的資源必須落在批次宣告的範圍內，否則整個請求回 400（`reconciliation_item_out_of_scope`）。
- 批次不是 `collecting` 時回 409（`reconciliation_run_not_collecting`）。

### 8.4 宣告完成

```json
{"item_count": 1}
```

- `item_count` 必須等於平台已收到的筆數，否則回 409（`reconciliation_item_count_mismatch`）。這是為了發現漏送的批次。
- 0 筆是合法的快照，代表該系統在這個範圍內沒有任何權限。
- 成功後狀態改為 `comparing`，回 202 與批次內容。比對由排程執行，完成後狀態是 `completed`；呼叫方用「查批次狀態」輪詢。

### 8.5 比對演算法

規則 `K-INT-RECON-COMPARE`。實作在 `sgn_internal.compare_reconciliation_run`。令 T 是批次的 `observed_at`，G 是參數 `reconciliation.grace_minutes`（容許兩邊的時間差與作業中的變更）。

**第一步：逐筆判定回報的項目。**

1. 解析主體。解析不出來 → 結果 `unapproved`，並標記 `subject_unresolved`。
2. 展開主體集合 S（與 5.3 相同：人包含他所屬的被授權者）。
3. 取候選 C：該流程類型的權限項目中，主體屬於 S、資源相同、`actions` 包含回報的動作。
4. 取 T 當時有效的 A：C 中 `status = 'active'`、`effective_from <= T`、`effective_until` 是 null 或 `T < effective_until`。
5. 依序取第一個成立的結果：

| 條件 | 結果 |
|---|---|
| A 中有一筆，以 `reconcile` 模式呼叫 `evaluate_constraints`（`context` 是回報的 `constraints`）回 true | `covered`（有核准，而且在範圍內） |
| A 不是空的 | `exceeds_approved`（有核准，但實際設定超出核准範圍） |
| C 中有 `pending` 的；或起始時間晚於 T 但不晚於 T + G 的；或結束時間不早於 T − G 的（包含在 T 之後才結束的） | `tolerated`（作業中的時間差，不算發現） |
| C 中有任何已結束的項目（結束時間早於 T − G） | `ended_still_present`（已到期或已撤銷，權限仍然存在） |
| 其他 | `unapproved`（沒有核准卻存在） |

**第二步：找出核准了卻沒設定的。**

對批次範圍內的每一筆權限項目 e，條件是 `status = 'active'`、`effective_during = 'active'`、T 當時有效、而且 `effective_from <= T − G`；對 e 的每一個動作 a：如果沒有任何一筆結果是 `covered` 或 `exceeds_approved` 的回報項目同時符合「資源相同、動作是 a、e 的主體屬於該項目的主體集合 S」，就產生一筆 `missing`。

被授權者是團隊而該系統以人為單位設定權限時，只要有一位成員的設定對得上，就不算 `missing`；平台不檢查每一位成員是否都設定了。

**第三步：產生、更新、結案發現。**

每一筆發現有一個指紋：

```
fingerprint = sha256( api_client_id | kind | 主體鍵 | resource_type | resource_id | action | entitlement_id 或空字串 )
主體鍵 = "person:<id>"、"principal:<id>"，或解析不出來時 "unresolved:<provider>:<回報的 id>"
```

- 已有相同指紋、未結案的發現：更新「最後出現的批次」與出現次數，不重複建立。
- 沒有：建立新的發現（狀態 `open`），指派、設定期限、通知、寫稽核事件、發出 `sgn.reconciliation.finding_opened`。
- 該呼叫方在同一流程類型、資源落在這次批次範圍內的未結案發現，這次沒有再出現：自動結案（`resolved`），記下是哪一個批次證實的，寫稽核事件，發出 `sgn.reconciliation.finding_closed`。

**第四步：留下批次的證據。** 寫一筆稽核事件（動作 `reconciliation.run_completed`），內容包含各結果的筆數、新增與結案的發現數，以及全部回報項目的 SHA-256（依 `item_key` 排序、每筆取 `jsonb::text`、以換行連接）。

### 8.6 發現的類型與結構

| 類型（`kind`） | 意義 | 嚴重度 |
|---|---|---|
| `unapproved` | 沒有核准卻存在 | `high` |
| `ended_still_present` | 已到期或已撤銷，權限仍然存在 | `high` |
| `exceeds_approved` | 有核准，但實際設定超出核准範圍 | `high` |
| `missing` | 核准了卻沒有設定 | `low` |

```json
{
  "finding_id": "77",
  "kind": "exceeds_approved",
  "severity": "high",
  "status": "open",
  "process_type": "data_access",
  "subject": {"type": "principal", "id": "sales-analysis", "properties": {"kind": "team", "provider": "ldap"}},
  "resource": {"type": "data_field", "id": "sales_orders.amount"},
  "action": {"name": "read"},
  "entitlement_id": "8812",
  "case_no": "DA-2026-0042",
  "first_run_id": "205",
  "last_seen_run_id": "205",
  "seen_count": 1,
  "opened_at": "2026-11-19T01:05:00Z",
  "due_at": "2026-11-23T01:05:00Z",
  "closed_at": null,
  "close_reason": null,
  "detail": {
    "item_key": "grp_sales_analysis|sales_orders.amount|read",
    "reported_constraints": {"row_filter": [{"field": "region", "op": "in", "values": ["北", "中", "南"]}], "data_period": {"field": "order_date", "from": "2024-01-01", "to": "2024-12-31"}},
    "approved_constraints": {"row_filter": [{"field": "region", "op": "in", "values": ["北", "中"]}], "data_period": {"field": "order_date", "from": "2024-01-01", "to": "2024-12-31"}},
    "properties": {"db_role": "grp_sales_analysis", "policy": "rls_sales_orders_17"}
  }
}
```

主體解析不出來時，`subject` 是回報的原值，並帶 `"subject_unresolved": true`。

### 8.7 發現的處理流程

| 項目 | 規則 |
|---|---|
| 指派給誰（`K-INT-RECON-ASSIGN`） | 回報系統（`api_client`）的負責人。他負責讓系統的實際設定回到核准的範圍，或讓缺少的設定補上。`exceeds_approved` 與 `ended_still_present` 另外通知該授權的被授權者負責人 |
| 時限 | 高嚴重度：`reconciliation.finding_due_workdays_high` 個工作天；低嚴重度：`reconciliation.finding_due_workdays_low` 個工作天 |
| 回應 | 負責人可以填寫處理說明（`acknowledged`）。這不會停止計時，也不算結案 |
| 逾期（`K-INT-RECON-SLA`） | 到期仍未結案：升級給負責人的直屬主管，並通知稽核角色。升級只做一次，之後這筆發現持續列在整合狀態與證據輸出裡，直到結案 |
| 結案（`K-INT-RECON-CLOSE`） | 只有兩種方式。**一、由證據結案**：之後的批次涵蓋這筆發現的資源，而且不再出現相同的情況（多的權限已移除、缺的已補上、或已經有新的核准涵蓋）。**二、人工排除**：系統管理員判定是回報或對應錯誤，選擇原因（`mapping_error`、`duplicate`、`system_retired`）並填寫說明；排除的人不得是這筆發現的負責人。沒有「接受風險」這個選項：要保留多出來的權限，就去申請並取得核准 |
| 系統沒有回報（`K-INT-RECON-OVERDUE`） | 有 `reconciliation.write` 的 `api_client`，超過 `reconciliation.expected_interval_days` 沒有任何完成的批次：通知負責人，寫稽核事件，並顯示在整合狀態 |

發現的狀態：`open`（待處理）、`acknowledged`（已回應）、`resolved`（由證據結案）、`dismissed`（人工排除）。

### 8.8 如何成為稽核證據

- 每個批次：一筆稽核事件，帶結果統計與回報內容的雜湊。回報的原始項目保存 `reconciliation.item_retention_days` 天，可以用雜湊核對。
- 每筆發現的建立、回應、升級、結案、排除：各一筆稽核事件，帶規則代碼。
- 稽核可以回答三個問題：這個系統有沒有定期對帳（批次紀錄與 `K-INT-RECON-OVERDUE`）；對帳發現了什麼（發現清單）；發現有沒有在時限內處理、怎麼結案（發現的歷程）。
- 稽核查詢畫面與證據輸出都能依 `api_client`、期間、類型取得上述資料。

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
- 自動建立（`K-INT-REVIEW-SCHEDULE`）：參數 `review.interval_months` 大於 0 的流程類型，距離上一輪的開始時間滿這個月數時，排程建立新的一輪：範圍是全部，`reviewer_kind` 在 `uses_principal` 為是時取 `principal_owner`，否則取 `applicant_manager`。
- 複查編號（`review_no`）的格式是 `AR-<西元年>-<四位流水號>`。

一輪複查的狀態：`scheduled`（尚未開始）、`open`（進行中）、`closed`（已結束）、`cancelled`（已取消）。

### 9.2 開始：產生複查工作

到了 `starts_at`，排程把範圍內所有 `grant.status = 'active'` 的授權各產生複查工作：

- `reviewer_kind` 是 `principal_owner` 或 `applicant_manager`：每筆授權一件工作。
- `reviewer_kind` 是 `role_holder` 而且角色帶範圍：每筆授權、每個不同的 `scope_ref` 各一件工作，工作只顯示該範圍的權限項目。

每件工作保存當時權限項目的快照與雜湊。

複查人的職責分離（規則 `K-INT-REVIEW-SOD`）：複查人不得是這筆授權的申請人，也不得是權限項目的主體本人。解析出來的人違反時，改由他的直屬主管複查；主管也違反就再往上；找不到上一層時，工作不指定個人，由系統管理員群組中不違反這條規則的任何一位處理。改派的原因記在工作上並寫稽核事件。

這條規則與 `K-SOD-APPLICANT` 是同一個原則：不能確認自己申請的、或自己持有的授權。被授權者的負責人如果只是該團隊的成員（不是申請人），仍然可以複查，因為他正是對這筆授權負責的人；需要更高的獨立性時，選 `role_holder` 讓擁有者複查。

範圍內沒有任何授權時，這一輪直接結束，結果是 0 件。

### 9.3 複查決定

規則 `K-INT-REVIEW-DECIDE`。可以做決定的人：工作的複查人、他目前有效的代理人（適用 `K-DELEGATE`，代理人同樣受 `K-INT-REVIEW-SOD` 限制，紀錄寫明誰代誰）。用手機做決定時適用 `K-MOBILE-MFA`。

做決定時要帶上畫面顯示的權限項目雜湊。它與目前的實際內容不同時（授權在這期間改變了），回 409（`review_item_changed`），複查人要重新看過再決定。這與 `K-VERSION-BOUND` 是同一個原則：決定綁定當時看到的內容。

| 決定 | 必填 | 結果 |
|---|---|---|
| `maintain`（維持） | — | 授權不變。可以批次處理多件，每件各留一筆紀錄 |
| `reduce`（縮小） | 說明要縮小什麼 | 通知被授權者的負責人與申請人，在 `review.reduce_followup_workdays` 個工作天內把授權縮小（走核心的縮小流程）。期限內授權縮小了（投影判定為 `narrowed`）或結束了，追蹤完成；逾期未縮小，自動撤銷（`K-INT-REVIEW-REDUCE`） |
| `revoke`（撤銷） | 原因 | 立即撤銷整筆授權（`K-INT-REVIEW-REVOKE`），走核心唯一的撤銷入口，之後的事件、通知、執行系統的處理都與一般撤銷相同 |

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

`reduce` 的後續追蹤（`followup_status`）：`none`、`pending`、`done`、`overdue_revoked`。

### 9.6 結束與證據

所有工作都不是 `pending` 時，這一輪改為 `closed`，並寫一筆稽核事件（動作 `review.campaign_closed`），內容：

```json
{
  "review_no": "AR-2026-0003",
  "summary": {
    "total": 42, "maintain": 35, "reduce": 2, "revoke": 3,
    "auto_revoked": 1, "unanswered": 0, "not_applicable": 1,
    "reassigned_for_sod": 4, "escalated": 2
  },
  "result_sha256": "5c1f…"
}
```

`result_sha256` 是所有工作的結果依工作 id 排序後的雜湊（每件取 id、授權 id、複查人、決定、決定人、決定時間、權限項目雜湊）。

成為證據的方式：

- 建立、開始、每一次改派、每一個決定、每一次自動撤銷、後續追蹤的完成或逾期、結束：各一筆稽核事件，帶規則代碼。
- 稽核可以回答：有沒有定期複查（各輪的紀錄）；每筆授權由誰、何時、看著什麼內容、做了什麼決定；複查人是否獨立（改派紀錄）；不回應的怎麼處理。
- 其他系統（IGA、GRC）可以用 `GET /integration/v1/reviews/campaigns` 與 `GET /integration/v1/reviews/campaigns/{review_no}` 取得各輪的結果與每件工作的決定（scope `reviews.read`，只看得到可見流程類型的複查）。

系統管理員可以在 `scheduled` 或 `open` 時取消一輪複查，必須填原因；已做的決定保留。

## 10. 證據輸出（`evidence`、`audit_feed`）

### 10.1 端點

| 用途 | 方法與路徑 | scope |
|---|---|---|
| 稽核事件（游標分頁） | `GET /integration/v1/audit/events` | `audit.read` 或 `audit.read_all` |
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

```json
{
  "items": [
    {
      "seq": 20418,
      "time": "2026-11-19T02:15:00Z",
      "action": "grant.revoked",
      "actor": {"type": "person", "id": "p03", "properties": {"provider": "ldap"}},
      "actor_role": "principal_owner",
      "on_behalf_of": null,
      "case_no": "DA-2026-0042",
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
      "canonical": "…"
    }
  ],
  "next_cursor": "20418",
  "has_more": false
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
- `actor` 是人時用呼叫方的身分來源表示；系統自動執行的是 `{"type": "system"}`；由其他系統觸發的是 `{"type": "api_client", "id": "<代碼>"}`。
- `canonical` 是計算這一筆雜湊時實際使用的文字，由核心提供。有了它，驗證的人不需要自己重做欄位的正規化。
- `audit.read`：只回傳有申請單、而且申請單的流程類型在可見範圍內的事件。`audit.read_all`：全部事件。兩者都有時以 `audit.read_all` 為準。
- 事件永久可讀（保存年限由 `audit.retention_years` 決定）。

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
  "message": "grant.revoked DA-2026-0042",
  "status_id": 1,
  "metadata": {
    "version": "1.9.0",
    "product": {"name": "sgn", "vendor_name": "sgn"},
    "uid": "20418",
    "sequence": 20418,
    "event_code": "grant.revoked",
    "log_name": "sgn.audit_event"
  },
  "actor": {"user": {"uid": "p03"}},
  "user": {"uid": "sales-analysis", "type": "team"},
  "privileges": ["read"],
  "resources": [
    {"uid": "sales_orders.amount", "type": "data_field"},
    {"uid": "sales_orders.region", "type": "data_field"}
  ],
  "unmapped": {
    "case_no": "DA-2026-0042",
    "process_type": "data_access",
    "rule_code": "K-REVOKE",
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
| `actor.user.uid` | actor 的外部識別碼；系統自動執行時改用 `actor.app_name = "sgn"` |
| `user`（3005） | 這張申請單權限項目的主體：`uid` 是外部識別碼，`type` 是 `person` 或被授權者的類型 |
| `privileges`（3005） | 這張申請單所有權限項目的動作（去重） |
| `resources`（3005） | 這張申請單的權限項目：`uid` 是 `resource_id`，`type` 是 `resource_type`。只列呼叫方可見的 |
| `entity`（3004） | `{"uid": 申請單號或被改變物件的 id, "type": "case" 或物件種類}` |
| `unmapped` | 申請單號、流程類型、規則代碼、前後雜湊，以及 `changes` |

原生格式是完整的來源；OCSF 格式是為了讓 SIEM 不用寫對應規則就能收進來。兩者的游標相同，可以互換。

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

- `payload` 是資料庫產生的 JSON 文字（`jsonb_build_object(...)::text`）。簽章簽的是這段文字的位元組，不做任何正規化；驗證的人從 JWS 裡取出內容即可。
- `signature_jws` 是 JWS compact 格式：標頭 `{"alg": "Ed25519", "kid": "<金鑰代號>", "typ": "sgn-checkpoint+jws"}`，內容是 `payload`。
- `tsa_token`：有設定時間戳記服務時，是對 `signature_jws` 的位元組做 SHA-256 後取得的 RFC 3161 時間戳記（DER，以 base64 表示）；沒有設定就是 null。
- 簽完之後發出 `sgn.evidence.checkpoint` 事件，訂閱的 SIEM、GRC 系統會收到並保存在自己那邊。
- `evidence.checkpoint_mail_enabled` 為 true 時，排程每天把最新的已簽章檢查點寄給稽核角色的每一位持有人。
- 檢查點不寫進稽核鏈（否則每個檢查點都會讓鏈頭前進，產生下一個檢查點）。檢查點表本身只增不改。

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
2. 驗鏈的連續性：匯出的事件依序號排列，每一筆的 `prev_hash` 等於前一筆的 `hash`，序號沒有缺漏。
3. 驗每一筆的內容：依核心定義的雜湊公式，用 `prev_hash` 與 `canonical` 重算，結果等於 `hash`；並確認 `canonical` 的內容與該筆顯示的欄位一致。
4. 對上檢查點：匯出的事件中，序號等於檢查點 `audit_seq` 的那一筆，它的 `hash` 等於檢查點的 `audit_hash`。每個保存的檢查點都要對得上。
5. 驗檢查點之間的連結：後一個檢查點的 `previous_audit_seq`、`previous_audit_hash` 等於前一個檢查點的值。

能偵測與不能偵測的範圍，照實說明：

| 情況 | 結果 |
|---|---|
| 修改、刪除、插入任何一筆已被外部檢查點涵蓋的事件 | 步驟 3 或 4 失敗 |
| 平台方重寫整條鏈並重新簽出一套新的檢查點 | 與第三方手上既有的檢查點對不上（步驟 4）。有外部時間戳記時，新檢查點也無法取得過去的時間 |
| 只有 `audit.read` 的呼叫方（看不到全部事件） | 用 `evidence/chain` 的骨架做步驟 2 與 4，對看得到的事件做步驟 3 |
| 最後一個外部檢查點之後、下一個檢查點之前的事件 | 尚未被外部保存的檢查點涵蓋。這段空窗最長是一個檢查點間隔（預設 60 分鐘） |
| 事件在寫入當下就是假的 | 雜湊鏈無法偵測；這要靠職責分離、對帳與複查 |

雜湊公式與 `canonical` 的定義屬於核心（見附錄 A 第 6 項）。本文件保證的是：匯出的欄位足以重算，而且檢查點會持續送到平台以外。

## 11. 資料表（schema `sgn`）

共 22 張表。所有時間欄位由 function 以 ⟨`sgn_internal.now()`⟩ 寫入，不用欄位預設值，假時鐘才能生效。`sgn_app` 對這些表沒有任何權限。

### 11.1 列舉型別

```sql
create type sgn.subject_kind              as enum ('person', 'principal');
create type sgn.api_client_status         as enum ('active', 'suspended', 'disabled');
create type sgn.entitlement_status        as enum ('pending', 'active', 'ended');
create type sgn.entitlement_phase         as enum ('active', 'fulfilment');
create type sgn.entitlement_end_reason    as enum ('expired', 'revoked', 'consumed', 'completed', 'cancelled', 'removed');
create type sgn.webhook_status            as enum ('pending_verification', 'enabled', 'paused', 'disabled');
create type sgn.reconciliation_run_status as enum ('collecting', 'comparing', 'completed', 'abandoned');
create type sgn.reconciliation_item_result as enum ('covered', 'tolerated', 'exceeds_approved', 'ended_still_present', 'unapproved');
create type sgn.finding_kind              as enum ('unapproved', 'ended_still_present', 'exceeds_approved', 'missing');
create type sgn.finding_severity          as enum ('high', 'low');
create type sgn.finding_status            as enum ('open', 'acknowledged', 'resolved', 'dismissed');
create type sgn.review_campaign_status    as enum ('scheduled', 'open', 'closed', 'cancelled');
create type sgn.review_reviewer_kind      as enum ('principal_owner', 'applicant_manager', 'role_holder');
create type sgn.review_no_response_action as enum ('revoke', 'escalate_only');
create type sgn.review_item_status        as enum ('pending', 'decided', 'auto_revoked', 'unanswered', 'not_applicable');
create type sgn.review_decision           as enum ('maintain', 'reduce', 'revoke');
create type sgn.review_followup_status    as enum ('none', 'pending', 'done', 'overdue_revoked');
```

### 11.2 主體識別

```sql
create table sgn.principal_identity (
    id            bigint generated always as identity primary key,
    principal_id  bigint not null references sgn.principal (id),
    provider      text   not null check (provider ~ '^[a-z][a-z0-9_]{0,31}$' and provider <> 'sgn'),
    external_id   text   not null check (length(external_id) between 1 and 256),
    created_by    bigint not null references sgn.person (id),
    created_at    timestamptz not null,
    unique (provider, external_id),
    unique (principal_id, provider)
);
```

### 11.3 系統身分

```sql
create table sgn.api_scope (
    code         text primary key check (code ~ '^[a-z][a-z0-9_.]{0,47}$'),
    description  text not null
);

create table sgn.api_function_scope (
    function_name  text primary key,                              -- schema api 內的 function 名稱
    scope_code     text not null references sgn.api_scope (code)
);

create table sgn.api_client (
    id                       bigint generated always as identity primary key,
    code                     text   not null unique check (code ~ '^[a-z][a-z0-9-]{2,47}$'),
    name                     text   not null check (length(name) between 1 and 100),
    description              text   not null default '',
    owner_person_id          bigint not null references sgn.person (id),
    identity_provider        text   not null check (identity_provider ~ '^[a-z][a-z0-9_]{0,31}$'),
    scopes                   text[] not null default '{}',
    allowed_webhook_origins  text[] not null default '{}',
    status                   sgn.api_client_status not null default 'active',
    status_reason            text,
    status_changed_at        timestamptz not null,
    owner_grace_until        timestamptz,                         -- 負責人不在職時的寬限期限；正常時為 null
    created_by               bigint not null references sgn.person (id),
    created_at               timestamptz not null,
    updated_at               timestamptz not null
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
    id             bigint generated always as identity primary key,
    api_client_id  bigint not null references sgn.api_client (id),
    secret_sha256  bytea  not null unique check (octet_length(secret_sha256) = 32),
    secret_hint    text   not null check (length(secret_hint) = 4),   -- 密鑰最後 4 個字元
    created_by     bigint not null references sgn.person (id),
    created_at     timestamptz not null,
    expires_at     timestamptz not null,
    revoked_at     timestamptz,
    revoked_by     bigint references sgn.person (id),
    last_used_at   timestamptz,                                       -- 只在換發 token 時更新
    reminded_at    timestamptz
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
    issued_ip                 inet
);
create index api_access_token_expires_idx on sgn.api_access_token (expires_at);

create table sgn.api_rate_counter (
    api_client_id  bigint not null references sgn.api_client (id),
    bucket         text   not null check (bucket in ('api', 'token')),
    window_start   timestamptz not null,                              -- 整分鐘
    hits           integer not null,
    primary key (api_client_id, bucket, window_start)
);
```

### 11.4 呼叫紀錄

```sql
create table sgn.api_call_log (
    id                   bigint generated always as identity primary key,
    called_at            timestamptz not null,
    api_client_id        bigint references sgn.api_client (id),       -- 驗證失敗時為 null
    api_access_token_id  bigint,
    request_id           text   not null,
    function_name        text   not null,
    http_status          integer not null,
    error_code           text,
    duration_ms          integer,
    ip                   inet,
    item_count           integer,
    summary              jsonb  not null default '{}'::jsonb
);
create index api_call_log_called_idx on sgn.api_call_log (called_at);
create index api_call_log_client_idx on sgn.api_call_log (api_client_id, called_at);
create index api_call_log_request_idx on sgn.api_call_log (request_id);

create table sgn.api_call_log_seal (
    day            date primary key,
    first_id       bigint,
    last_id        bigint,
    row_count      bigint not null,
    digest_sha256  bytea  not null,
    sealed_at      timestamptz not null,
    purged_at      timestamptz
);
```

`api_call_log` 擋下 `UPDATE` 與 `TRUNCATE`。`DELETE` 只有在交易內設定了 `sgn.call_log_purge = 'on'` 時放行，而且只有 `sgn_internal.job_integration_call_log_seal` 會設定它；被刪除的日期必須已在 `api_call_log_seal` 裡。

### 11.5 權限項目與事件

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
    constraints_sha256    bytea  not null,
    scope_ref             text,
    effective_during      sgn.entitlement_phase not null default 'active',
    status                sgn.entitlement_status not null,
    effective_from        timestamptz,
    effective_until       timestamptz,
    ended_at              timestamptz,
    end_reason            sgn.entitlement_end_reason,
    content_version_no    integer not null,                       -- 這筆項目來自申請單的哪一個內容版本
    revision              integer not null default 1,             -- 動作或限制條件每改一次加一
    sync_seq              bigint  not null,                       -- 最後一次改變它的事件序號
    created_at            timestamptz not null,
    updated_at            timestamptz not null,
    check ((subject_kind = 'person') = (subject_person_id is not null)),
    check ((subject_kind = 'principal') = (subject_principal_id is not null)),
    check ((status = 'ended') = (ended_at is not null)),
    check ((status = 'ended') = (end_reason is not null))
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

create table sgn.integration_event_type (
    code            text primary key check (code ~ '^sgn\.[a-z_]+\.[a-z_]+$'),
    category        text not null check (category in ('grant', 'principal', 'reconciliation', 'review', 'evidence', 'webhook')),
    required_scope  text not null references sgn.api_scope (code),
    description     text not null
);

create sequence sgn.integration_event_seq;

create table sgn.integration_event (
    seq              bigint primary key,                          -- 取鎖後由 integration_event_seq 取得
    event_type       text   not null references sgn.integration_event_type (code),
    occurred_at      timestamptz not null,
    subject_label    text   not null,                             -- CloudEvents 的 subject
    process_type_id  bigint references sgn.process_type (id),
    case_id          bigint references sgn."case" (id),
    grant_id         bigint references sgn."grant" (id),
    principal_id     bigint references sgn.principal (id),
    api_client_id    bigint references sgn.api_client (id),       -- 有值時只有這個呼叫方看得到
    rule_code        text,
    data             jsonb  not null
);
create index integration_event_case_idx on sgn.integration_event (case_id) where case_id is not null;
create index integration_event_type_idx on sgn.integration_event (event_type, seq);
```

`integration_event` 擋下 `UPDATE`、`DELETE`、`TRUNCATE`。`data` 以內部形式保存：主體是 `{"kind", "person_id", "principal_id"}`，權限項目包含該申請單的全部項目；對外輸出時由 `sgn_internal.render_integration_event` 依呼叫方轉換與過濾。`expiring` 事件的去重靠 `(case_id, event_type)` 的查詢：同一張單、同一個到期日只發一次（到期日記在 `data.expires_at`）。

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
    error            text,
    duration_ms      integer,
    succeeded        boolean not null
);
create index webhook_attempt_subscription_idx on sgn.webhook_attempt (subscription_id, attempted_at);
```

`webhook_attempt` 只增不改。

### 11.7 對帳

```sql
create table sgn.reconciliation_run (
    id                  bigint generated always as identity primary key,
    api_client_id       bigint not null references sgn.api_client (id),
    process_type_id     bigint not null references sgn.process_type (id),
    resource_type       text,
    resource_id_prefix  text,
    observed_at         timestamptz not null,
    status              sgn.reconciliation_run_status not null default 'collecting',
    item_count          integer not null default 0,
    items_sha256        bytea,
    summary             jsonb,
    created_at          timestamptz not null,
    completed_at        timestamptz,                               -- 比對完成的時間
    check (resource_id_prefix is null or resource_type is not null)
);
create index reconciliation_run_client_idx on sgn.reconciliation_run (api_client_id, created_at);
create index reconciliation_run_status_idx on sgn.reconciliation_run (status) where status in ('collecting', 'comparing');

create table sgn.reconciliation_item (
    id                      bigint generated always as identity primary key,
    run_id                  bigint not null references sgn.reconciliation_run (id),
    item_key                text   not null check (length(item_key) between 1 and 256),
    subject_type            text   not null check (subject_type in ('person', 'principal')),
    subject_provider        text   not null,
    subject_external_id     text   not null check (length(subject_external_id) between 1 and 256),
    subject_person_id       bigint references sgn.person (id),      -- 解析結果；解析不出來時兩者皆為 null
    subject_principal_id    bigint references sgn.principal (id),
    resource_type           text   not null,
    resource_id             text   not null,
    action                  text   not null,
    constraints             jsonb  not null default '{}'::jsonb,
    properties              jsonb  not null default '{}'::jsonb,
    result                  sgn.reconciliation_item_result,         -- 比對後填入
    matched_entitlement_id  bigint references sgn.entitlement (id),
    unique (run_id, item_key)
);
create index reconciliation_item_lookup_idx on sgn.reconciliation_item (run_id, resource_type, resource_id, action);

create table sgn.reconciliation_finding (
    id                       bigint generated always as identity primary key,
    fingerprint              bytea  not null,
    api_client_id            bigint not null references sgn.api_client (id),
    process_type_id          bigint not null references sgn.process_type (id),
    kind                     sgn.finding_kind not null,
    severity                 sgn.finding_severity not null,
    status                   sgn.finding_status not null default 'open',
    subject_person_id        bigint references sgn.person (id),
    subject_principal_id     bigint references sgn.principal (id),
    subject_provider         text,                                   -- 主體解析不出來時保存回報的原值
    subject_external_id      text,
    resource_type            text   not null,
    resource_id              text   not null,
    action                   text   not null,
    entitlement_id           bigint references sgn.entitlement (id),
    first_run_id             bigint not null references sgn.reconciliation_run (id),
    last_seen_run_id         bigint not null references sgn.reconciliation_run (id),
    seen_count               integer not null default 1,
    detail                   jsonb  not null default '{}'::jsonb,
    assignee_person_id       bigint not null references sgn.person (id),
    opened_at                timestamptz not null,
    due_at                   timestamptz not null,
    acknowledged_at          timestamptz,
    acknowledged_by          bigint references sgn.person (id),
    response_note            text,
    escalated_at             timestamptz,
    escalated_to_person_id   bigint references sgn.person (id),
    closed_at                timestamptz,
    closed_by                bigint references sgn.person (id),      -- 由證據結案時為 null
    close_reason             text check (close_reason in ('resolved_by_run', 'mapping_error', 'duplicate', 'system_retired')),
    close_note               text,
    resolved_by_run_id       bigint references sgn.reconciliation_run (id),
    check ((status in ('resolved', 'dismissed')) = (closed_at is not null))
);
create unique index reconciliation_finding_open_uq
    on sgn.reconciliation_finding (fingerprint) where status in ('open', 'acknowledged');
create index reconciliation_finding_client_idx on sgn.reconciliation_finding (api_client_id, status);
create index reconciliation_finding_assignee_idx on sgn.reconciliation_finding (assignee_person_id) where status in ('open', 'acknowledged');
create index reconciliation_finding_due_idx on sgn.reconciliation_finding (due_at) where status in ('open', 'acknowledged');
```

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
    status              sgn.review_campaign_status not null default 'scheduled',
    origin              text   not null check (origin in ('manual', 'scheduled')),
    created_by          bigint references sgn.person (id),           -- 排程建立時為 null
    created_reason      text,
    created_at          timestamptz not null,
    opened_at           timestamptz,
    closed_at           timestamptz,
    cancelled_by        bigint references sgn.person (id),
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
    decided_by                   bigint references sgn.person (id),
    decided_on_behalf_of         bigint references sgn.person (id),  -- 代理時，被代理的人
    decided_at                   timestamptz,
    entitlement_snapshot         jsonb  not null,
    snapshot_sha256              bytea  not null,
    reminded_at                  timestamptz,
    escalated_at                 timestamptz,
    followup_status              sgn.review_followup_status not null default 'none',
    followup_due_at              timestamptz,
    followup_closed_at           timestamptz,
    unique nulls not distinct (campaign_id, grant_id, scope_ref),
    check ((status = 'decided') = (decision is not null))
);
create index access_review_item_reviewer_idx on sgn.access_review_item (reviewer_person_id) where status = 'pending';
create index access_review_item_grant_idx on sgn.access_review_item (grant_id);
create index access_review_item_followup_idx on sgn.access_review_item (followup_due_at) where followup_status = 'pending';
```

### 11.9 證據

```sql
create table sgn.evidence_checkpoint (
    id                   bigint generated always as identity primary key,
    audit_seq            bigint not null unique,
    audit_hash           text   not null,
    event_count          bigint not null,                            -- 自上一個檢查點以來的事件數
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
```

`evidence_checkpoint` 擋下 `DELETE` 與 `TRUNCATE`。`UPDATE` 只允許把 `signature_jws`、`signing_key_id`、`signed_at`、`tsa_token` 從 null 填成有值一次，以及更新 `lease_until`、`mailed_at`；其他欄位不可變。

## 12. 內部函式（schema `sgn_internal`）

兩個複合型別：

```sql
create type sgn_internal.client_context as (
    api_client_id      bigint,
    code               text,
    identity_provider  text,
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
| `project_principal(p_principal_id bigint, p_event text, p_detail jsonb default '{}') returns void` | `p_event` 是 `owner_changed`、`owner_at_risk`、`member_added`、`member_removed` 之一。發出對應的 `sgn.principal.*` 事件。`p_detail`：`owner_changed` 帶 `old_owner_person_id`、`new_owner_person_id`；`owner_at_risk` 帶 `grace_until`；成員異動帶 `person_id` |
| `call_describe_entitlements(p_case_id bigint) returns jsonb` | 呼叫流程類型登記的 hook；沒有登記回 `[]`。檢查每個元素的鍵、型別、格式與 (`resource_type`, `resource_id`) 不重複；不合格丟 `entitlement_hook_invalid` 或 `entitlement_duplicate_resource` |
| `call_evaluate_constraints(p_process_type_id bigint, p_constraints jsonb, p_context jsonb) returns boolean` | 依 3.3 的呼叫規則。hook 丟出的例外在這裡攔下並回 false |
| `emit_integration_event(p_event_type text, p_subject_label text, p_data jsonb, p_process_type_id bigint default null, p_case_id bigint default null, p_grant_id bigint default null, p_principal_id bigint default null, p_api_client_id bigint default null, p_rule_code text default null) returns bigint` | 取 advisory lock（`pg_advisory_xact_lock(sgn_internal.integration_event_lock_key())`）→ 取序號 → 寫入 `sgn.integration_event` → 回傳序號。這是產生事件的唯一入口 |
| `integration_event_lock_key() returns bigint` | `immutable`，回固定值 `5058301` |
| `integration_forbid_change() returns trigger` | 只增不改的資料表共用的觸發函式 |

### 12.2 主體與可見範圍

| 簽章 | 行為 |
|---|---|
| `resolve_subject(p_default_provider text, p_subject jsonb) returns sgn_internal.subject_ref` | provider 取 `p_subject.properties.provider`，沒有就取 `p_default_provider`。provider 是 `sgn` 時以內部 id 查；否則查 `person_identity` 或 `principal_identity`。找不到回 null。只回在職的人、未結束的被授權者 |
| `subject_principals(p_person_id bigint, p_at timestamptz) returns setof bigint` | 這個人在 `p_at` 是有效成員的被授權者。成員關係的唯一解析入口 |
| `render_subject(p_provider text, p_kind sgn.subject_kind, p_person_id bigint, p_principal_id bigint) returns jsonb` | 依 3.2 輸出 `{"type", "id", "properties"}`；該 provider 沒有對應時改用 `sgn` |
| `client_can_see(p_api_client_id bigint, p_process_type_id bigint, p_resource_type text, p_resource_id text) returns boolean` | 依 4.5。`stable`。集合查詢直接與 `api_client_visibility` join，條件必須與這個 function 相同 |

### 12.3 驗證、紀錄、判定

| 簽章 | 行為 |
|---|---|
| `authenticate_client(p_token_sha256 bytea, p_function_name text) returns sgn_internal.client_context` | 依序：(1) 找未過期的 token，找不到丟 `integration_invalid_token`；(2) `api_client.status` 必須是 `active`，換發它的憑證必須未撤銷，否則丟 `integration_invalid_token`；(3) 從 `api_function_scope` 取這個 function 需要的 scope，必須同時在 token 與 `api_client` 目前的 scope 裡，否則丟 `integration_insufficient_scope`；(4) 累加速率計數，超過丟 `integration_rate_limited`。這是整合介面驗證與授權的唯一入口 |
| `log_api_call(p_ctx sgn_internal.client_context, p_function_name text, p_request_id text, p_ip text, p_http_status integer, p_item_count integer, p_summary jsonb) returns bigint` | 寫入 `api_call_log`，回傳 id。`duration_ms` 取 `clock_timestamp() - statement_timestamp()` |
| `validate_access_request(p_body jsonb, p_batch boolean) returns void` | 依第 16 節的輸入規則檢查；不合格丟 `integration_invalid_request`（說明帶 JSON 路徑）或 `integration_too_many_evaluations` |
| `evaluate_access(p_ctx sgn_internal.client_context, p_subject jsonb, p_action jsonb, p_resource jsonb, p_context jsonb, p_at timestamptz) returns jsonb` | 依 5.3，回傳 `{"decision", "context"}`（不含 `decision_id`，由呼叫它的 function 補上） |
| `render_entitlement(p_ctx sgn_internal.client_context, p_entitlement sgn.entitlement, p_inherited boolean default false) returns jsonb` | 6.3 的單筆格式 |
| `render_integration_event(p_ctx sgn_internal.client_context, p_event sgn.integration_event) returns jsonb` | 7.2 的 CloudEvents 格式；對這個呼叫方不可見時回 null |
| `decode_sync_cursor(p_cursor text, out seq bigint, out id bigint)` | 解析 `<seq>-<id>`；格式錯誤丟 `integration_cursor_invalid` |

### 12.4 webhook、對帳、複查、證據、排程

| 簽章 | 行為 |
|---|---|
| `webhook_next_event(p_subscription_id bigint) returns jsonb` | 找出這個訂閱下一個要送的事件（序號大於 `delivered_seq`、類型符合、對呼叫方可見），回傳轉換後的事件；掃過而不符合的事件直接把 `delivered_seq` 往前推。沒有事件回 null |
| `webhook_retry_delay(p_attempt_no integer) returns interval` | 依 7.6 的公式與參數 |
| `disable_webhook_subscription(p_subscription_id bigint, p_reason text) returns void` | 改狀態、寫稽核事件、通知負責人與系統管理員 |
| `compare_reconciliation_run(p_run_id bigint) returns void` | 依 8.5 |
| `finding_fingerprint(p_api_client_id bigint, p_kind sgn.finding_kind, p_subject_key text, p_resource_type text, p_resource_id text, p_action text, p_entitlement_id bigint) returns bytea` | 依 8.5 |
| `open_access_review_campaign(p_campaign_id bigint) returns void` | 依 9.2 產生工作、通知複查人、發出事件 |
| `resolve_review_reviewer(p_campaign_id bigint, p_grant_id bigint, p_scope_ref text) returns bigint` | 依 `reviewer_kind` 找人並套用 `K-INT-REVIEW-SOD`；回 null 代表交給系統管理員群組 |
| `review_snapshot(p_grant_id bigint, p_scope_ref text) returns jsonb` | 回 `{"entitlements": [...], "sha256": "<hex>"}`：該授權（該範圍）目前未結束的權限項目，依 id 排序 |
| `close_access_review_campaign_if_done(p_campaign_id bigint) returns void` | 依 9.6 |
| `audit_event_to_native(p_ctx sgn_internal.client_context, p_seq bigint) returns jsonb` | 10.2 的格式；不可見回 null |
| `audit_event_to_ocsf(p_ctx sgn_internal.client_context, p_seq bigint) returns jsonb` | 10.3 的格式；不可見回 null |
| `job_integration_expiring() returns jsonb` | 見 15.4 |
| `job_integration_client_hygiene() returns jsonb` | 見 15.4 |
| `job_integration_call_log_seal() returns jsonb` | 見 15.4 |
| `job_reconciliation() returns jsonb` | 見 15.4 |
| `job_access_review() returns jsonb` | 見 15.4 |
| `job_evidence_checkpoint() returns jsonb` | 見 15.4 |

### 12.5 `project_case` 的步驟

規則 `K-INT-PROJECT`。

1. 鎖住這張申請單既有的權限項目（`select … for update`），避免同一張單的兩次投影交錯。
2. 讀申請單狀態、`grant`（如果有）、流程類型的選項。
3. 申請單在 `draft`、`in_approval`、`returned`：既有未結束的項目全部改為 `ended`（原因 `cancelled`），跳到第 7 步。這種情況只會發生在已核准的單被退回重簽時。
4. 呼叫 `call_describe_entitlements`，得到目標清單。決定主體：流程類型 `uses_principal` 為是取申請單的被授權者，否則取申請人。
5. 依 3.4 算出每一筆目標項目的狀態與有效期間。
6. 與既有未結束的項目比對，鍵是 (`resource_type`, `resource_id`)：
   - 目標有、既有沒有：新增。
   - 既有有、目標沒有：改為 `ended`，原因 `removed`。
   - 兩邊都有：動作、限制條件或 `scope_ref` 不同就更新並把 `revision` 加一；狀態、有效期間、`grant_id` 不同就更新。
   - 目標狀態是 `ended`：既有的改為 `ended` 並填原因；既有沒有就不新增。
7. 沒有任何改變就結束，不發事件。
8. 有改變：依「這張單整體」的前後狀態決定事件類型。整體狀態的定義：有任何一筆 `active` 就是 `active`；否則有任何一筆 `pending` 就是 `pending`；否則是 `ended`（沒有項目也算 `ended`）。

| 前 → 後 | 事件 |
|---|---|
| 不是 `active` → `active` | `sgn.grant.activated` |
| `ended`（或沒有）→ `pending` | `sgn.grant.approved` |
| 狀態相同（`active` 或 `pending`），項目有改變 | `sgn.grant.changed`，並依 7.1 算出 `change_class` |
| → `ended`，全部項目的原因都是 `expired` | `sgn.grant.expired` |
| → `ended`，全部項目的原因都是 `revoked` | `sgn.grant.revoked` |
| → `ended`，其他 | `sgn.grant.ended` |

9. 呼叫 `emit_integration_event`，把回傳的序號寫進這次所有被改變項目的 `sync_seq`。事件的 `rule_code` 取 `p_rule_code`。
10. 這張單有複查工作的後續追蹤是 `pending`，而這次的 `change_class` 是 `narrowed` 或整體狀態變成 `ended`：把追蹤改為 `done` 並寫稽核事件。這張單有 `pending` 的複查工作而整體狀態變成 `ended`：工作改為 `not_applicable`。

`project_case` 不寫稽核事件：造成改變的那個動作已經由核心寫過了。

## 13. 對外 function（schema `api`）

共 60 個。全部符合工程規範的架構測試：`SECURITY DEFINER`、固定 `search_path`、第一個參數是 `p_actor`、有 `COMMENT`。

三種呼叫者：

| 類別 | `p_actor` | 身分怎麼確認 |
|---|---|---|
| 其他系統（27 個） | 一律傳 null；傳了非 null 丟 `integration_invalid_request` | 第二個參數 `p_token_sha256`，由 `sgn_internal.authenticate_client` 驗證 |
| 後端自己（5 個） | 後端的系統身分（比照核心對寄信佇列 function 的規定） | 只供後端的 worker 與錯誤處理使用，不對應任何路由 |
| 人（28 個） | 登入者 | 核心的角色檢查 |

給其他系統的 function，除了兩個公開的中繼資料 function 與 token 換發，最後兩個參數固定是 `p_request_id text`（請求識別碼）與 `p_ip text`（來源 IP），而且都依同一個骨架執行：

```
1. v_ctx := sgn_internal.authenticate_client(p_token_sha256, '<自己的名稱>');
2. 檢查輸入；
3. 執行；
4. perform sgn_internal.log_api_call(v_ctx, '<自己的名稱>', p_request_id, p_ip, <HTTP 狀態>, <筆數>, <摘要>);
5. 回傳 jsonb。
```

架構測試會檢查這 24 個 function 的原始碼都呼叫了 `authenticate_client` 與 `log_api_call`，而且在 `sgn.api_function_scope` 有一列。

### 13.1 給其他系統的 function

下表省略每個簽章開頭的 `p_actor bigint, p_token_sha256 bytea` 與結尾的 `p_request_id text, p_ip text`；回傳型別除註明外都是 `jsonb`。

| function | 中間的參數 | scope | 行為 |
|---|---|---|---|
| `integration_check` | `p_body jsonb` | `check` | 5.2、5.3 |
| `integration_check_batch` | `p_body jsonb` | `check` | 5.4 |
| `integration_grants_list` | `p_query jsonb` | `grants.read` | 6.2 到 6.4 |
| `integration_grant_get` | `p_entitlement_id text` | `grants.read` | 單筆；不存在或不可見丟 `integration_not_found` |
| `integration_events_list` | `p_query jsonb` | `events.read` | 7.3 |
| `integration_webhook_list` | — | `webhooks.manage` | 自己未刪除的訂閱 |
| `integration_webhook_create` | `p_body jsonb` | `webhooks.manage` | 7.5。回傳內容另帶 `secret_version`，由後端換成 `secret` |
| `integration_webhook_get` | `p_endpoint_id text` | `webhooks.manage` | 單筆 |
| `integration_webhook_update` | `p_endpoint_id text, p_body jsonb` | `webhooks.manage` | 可改 `event_types`、`description`、`status`（`enabled`、`paused`）、`resume_from`。網址不可改（要換網址就刪除重建） |
| `integration_webhook_delete` | `p_endpoint_id text` | `webhooks.manage` | 軟刪除。回傳 `void` |
| `integration_webhook_rotate_secret` | `p_endpoint_id text` | `webhooks.manage` | `secret_version` 加一並設定重疊期。回傳內容帶 `secret_version`，由後端換成 `secret` |
| `integration_webhook_ping` | `p_endpoint_id text` | `webhooks.manage` | 設定 `ping_pending`，由 worker 送出。回傳訂閱內容 |
| `integration_reconciliation_run_create` | `p_body jsonb` | `reconciliation.write` | 8.2 |
| `integration_reconciliation_items_add` | `p_run_id text, p_body jsonb` | `reconciliation.write` | 8.3 |
| `integration_reconciliation_run_complete` | `p_run_id text, p_body jsonb` | `reconciliation.write` | 8.4 |
| `integration_reconciliation_run_get` | `p_run_id text` | `reconciliation.write` | 只能看自己的批次。`completed` 時 `summary` 有值 |
| `integration_reconciliation_findings_list` | `p_query jsonb` | `reconciliation.write` | 只能看自己的發現。參數：`status`（預設 `open,acknowledged`）、`kind`、`run_id`、`page_token`、`limit` |
| `integration_reviews_list` | `p_query jsonb` | `reviews.read` | 可見流程類型的各輪複查（不含工作明細）。參數：`process_type`、`status`、`page_token`、`limit` |
| `integration_review_get` | `p_review_no text` | `reviews.read` | 一輪複查與每件工作的結果 |
| `integration_audit_events_list` | `p_query jsonb` | `audit.read` | 10.2、10.3。呼叫方有 `audit.read_all` 時回全部 |
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

回傳 `{"http_status": 200, "body": {…}}` 或 `{"http_status": 400|401|429, "body": {"error": "…", "error_description": "…"}}`。失敗時不丟例外，因為失敗的嘗試也要計數並留紀錄（丟例外會讓交易回復）。行為見 4.3。

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
| `integration_record_failure(p_actor bigint, p_token_sha256 bytea, p_function_name text, p_http_status integer, p_error_code text, p_request_id text, p_ip text, p_duration_ms integer) returns void` | 整合端點回應 4xx、5xx 時，後端呼叫它補一筆呼叫紀錄。token 找得到就記下 `api_client`，找不到就留 null。不驗證、不計數 |
| `integration_webhook_claim(p_actor bigint, p_limit integer) returns jsonb` | 領取要送的 webhook（見下） |
| `integration_webhook_report(p_actor bigint, p_subscription_id bigint, p_webhook_id text, p_event_seq bigint, p_http_status integer, p_error text, p_retry_after_seconds integer, p_duration_ms integer) returns void` | 回報一次嘗試的結果（見下） |
| `evidence_checkpoint_claim(p_actor bigint, p_limit integer) returns jsonb` | 領取尚未簽章的檢查點：`[{"checkpoint_id", "payload"}]`，並設定租約 |
| `evidence_checkpoint_attach(p_actor bigint, p_checkpoint_id bigint, p_signature_jws text, p_signing_key_id text, p_tsa_token bytea) returns void` | 寫入簽章，然後發出 `sgn.evidence.checkpoint` 事件。已有簽章時不做任何事 |

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

1. 寫一筆 `webhook_attempt`。
2. `p_event_seq` 與訂閱目前等待的事件不同（已被別的回報處理）：到此為止。
3. `p_http_status` 在 200 到 299：ping 就清掉 `ping_pending`，並把 `pending_verification` 改為 `enabled`；事件就把 `delivered_seq` 設為 `p_event_seq`。清掉 `attempt_count`、`next_attempt_at`、`lease_until`，更新 `last_success_at`。
4. `p_http_status` 是 410：`disable_webhook_subscription(…, 'gone')`。
5. 其他：`attempt_count` 加一。達到 `integration.webhook_max_attempts` 就 `disable_webhook_subscription(…, 'delivery_exhausted')`；否則 `next_attempt_at` 設為現在加上 `webhook_retry_delay(attempt_count)`，有 `p_retry_after_seconds` 時取兩者較晚的（上限是重試間隔的上限）。清掉 `lease_until`，更新 `last_failure_at`。

### 13.3 給人使用的 function

回傳物件都帶 `allowed_actions`（登入者對這筆資料可以做的動作），前端依它顯示按鈕。

| 簽章 | 誰可以呼叫 | 行為與規則 |
|---|---|---|
| `api_client_list(p_actor bigint) returns jsonb` | `sys_admin`、`auditor` | 全部 `api_client` 的摘要 |
| `api_client_get(p_actor bigint, p_client_id bigint) returns jsonb` | `sys_admin`、`auditor`、該系統的負責人 | 含可見範圍、憑證（只有 `secret_hint` 與日期）、訂閱數 |
| `api_client_create(p_actor bigint, p_data jsonb, p_reason text) returns jsonb` | `sys_admin` | `p_data`：`code`、`name`、`description`、`owner_person_id`、`identity_provider`、`scopes`、`visibility`（`[{"process_type", "resource_type", "resource_id_prefix"}]`）、`allowed_webhook_origins`。檢查：代碼未被使用；負責人在職；scope 都存在；`audit.read_all` 必須搭配 `audit.read`；`visibility` 至少一列（scope 只包含 `evidence.read`、`audit.read`、`audit.read_all` 時可以沒有）。`K-INT-CLIENT-AUTH` |
| `api_client_update(p_actor bigint, p_client_id bigint, p_data jsonb, p_reason text) returns jsonb` | `sys_admin` | 可改 `code` 以外的欄位；`visibility` 整組取代。縮小 scope 立即生效（下一次呼叫就檢查）。從 `allowed_webhook_origins` 移除的來源，對應的訂閱被停用 |
| `api_client_set_status(p_actor bigint, p_client_id bigint, p_status text, p_reason text) returns jsonb` | `sys_admin` | `active` ↔ `suspended`；任何狀態 → `disabled`；`disabled` 不能再改。效果見 4.6 |
| `api_client_credential_create(p_actor bigint, p_client_id bigint, p_expires_at timestamptz, p_reason text) returns jsonb` | `sys_admin` | 回傳 `{"credential_id", "client_id", "client_secret", "secret_hint", "expires_at"}`；`client_secret` 只出現這一次。檢查到期日上限與有效憑證數上限。`K-INT-CRED-EXPIRE` |
| `api_client_credential_revoke(p_actor bigint, p_credential_id bigint, p_reason text) returns void` | `sys_admin` | 撤銷憑證與由它換發的 token |
| `api_call_log_search(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor` | 篩選：`api_client`、期間、function、狀態碼、`request_id` |
| `integration_status(p_actor bigint) returns jsonb` | `sys_admin`、`auditor` | 設定頁「整合狀態」的資料：每個系統的狀態、憑證到期日、最後呼叫時間、近 24 小時的呼叫數與錯誤數、訂閱狀態、最後完成的對帳與是否逾期、未結案發現數；以及最新檢查點與尚未簽章的檢查點數 |
| `webhook_subscription_list(p_actor bigint, p_client_id bigint) returns jsonb` | `sys_admin`、`auditor`、該系統的負責人 | 含最近 20 次嘗試 |
| `webhook_subscription_set_status(p_actor bigint, p_subscription_id bigint, p_status text, p_reason text) returns jsonb` | `sys_admin` | `enabled`、`paused`、`disabled` |
| `principal_identity_set(p_actor bigint, p_principal_id bigint, p_provider text, p_external_id text, p_reason text) returns void` | `sys_admin`、該被授權者的負責人 | 每個被授權者每個 provider 一筆；已存在就取代。寫稽核事件 |
| `principal_identity_remove(p_actor bigint, p_principal_id bigint, p_provider text, p_reason text) returns void` | 同上 | |
| `reconciliation_run_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor`；負責人只看自己系統的 | |
| `reconciliation_run_get(p_actor bigint, p_run_id bigint) returns jsonb` | 同上 | 含統計、回報內容的雜湊、產生與結案的發現 |
| `reconciliation_finding_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor`；負責人與升級對象只看指派給自己的 | 首頁「待我處理」會用到 |
| `reconciliation_finding_get(p_actor bigint, p_finding_id bigint) returns jsonb` | 同上 | 含歷程 |
| `reconciliation_finding_acknowledge(p_actor bigint, p_finding_id bigint, p_note text) returns jsonb` | 負責人、升級對象 | 填寫處理說明，狀態改為 `acknowledged`。說明必填 |
| `reconciliation_finding_dismiss(p_actor bigint, p_finding_id bigint, p_reason_code text, p_note text) returns jsonb` | `sys_admin`，而且不是這筆發現的負責人 | `K-INT-RECON-CLOSE` |
| `access_review_campaign_create(p_actor bigint, p_data jsonb, p_reason text) returns jsonb` | `sys_admin` | 9.1。`starts_at` 已到就立即開始 |
| `access_review_campaign_cancel(p_actor bigint, p_campaign_id bigint, p_reason text) returns jsonb` | `sys_admin` | 9.6 |
| `access_review_campaign_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | `sys_admin`、`auditor` | |
| `access_review_campaign_get(p_actor bigint, p_campaign_id bigint) returns jsonb` | `sys_admin`、`auditor` | 含統計與全部工作 |
| `access_review_item_list(p_actor bigint, p_filter jsonb, p_page jsonb) returns jsonb` | 任何登入者 | 預設列出「等我決定」的工作：我是複查人、我是複查人目前的代理人，或工作交給系統管理員群組而我是 `sys_admin` 且不違反職責分離。`sys_admin`、`auditor` 可以依一輪複查篩選全部 |
| `access_review_item_get(p_actor bigint, p_item_id bigint) returns jsonb` | 可以決定這件工作的人、`sys_admin`、`auditor` | 含授權摘要、目前的權限項目、`snapshot_sha256`、前次複查的決定 |
| `access_review_item_decide(p_actor bigint, p_item_id bigint, p_decision text, p_note text, p_snapshot_sha256 text, p_ip text, p_device text) returns jsonb` | 可以決定這件工作的人 | 9.3 |
| `access_review_item_decide_batch(p_actor bigint, p_items jsonb, p_note text, p_ip text, p_device text) returns jsonb` | 同上 | `p_items` 是 `[{"item_id", "snapshot_sha256"}]`；決定固定是 `maintain`。逐件檢查，每件各留一筆稽核事件；任何一件不合格，整批失敗 |
| `evidence_checkpoint_list(p_actor bigint, p_page jsonb) returns jsonb` | `sys_admin`、`auditor` | 稽核查詢畫面「雜湊鏈驗證」顯示檢查點與簽章狀態 |

## 14. REST 端點

### 14.1 給其他系統的端點

共 28 個。路徑固定，不加本站的 `/api` 前綴。除註明外：請求與回應都是 `application/json`；需要 `Authorization: Bearer <token>`；回應帶 `Cache-Control: no-store` 與 `X-Request-ID`（請求有帶就原樣回傳，沒有帶就由後端產生）。

| # | 方法與路徑 | function | scope | 成功 | 請求與回應 |
|---|---|---|---|---|---|
| 1 | `POST /integration/v1/oauth/token` | `integration_token_issue` | —（Basic 驗證） | 200 | 4.3。請求是 `application/x-www-form-urlencoded` |
| 2 | `GET /.well-known/authzen-configuration/integration/v1` | `integration_authzen_metadata` | 公開 | 200 | 5.1。帶 `Cache-Control: max-age=3600` |
| 3 | `GET /integration/v1` | `integration_discovery` | 公開 | 200 | 13.1。帶 `Cache-Control: max-age=3600` |
| 4 | `GET /integration/v1/jwks.json` | 無（後端從部署設定產生） | 公開 | 200 | 10.4。帶 `Cache-Control: max-age=3600` |
| 5 | `POST /integration/v1/access/v1/evaluation` | `integration_check` | `check` | 200 | 5.2 |
| 6 | `POST /integration/v1/access/v1/evaluations` | `integration_check_batch` | `check` | 200 | 5.4 |
| 7 | `GET /integration/v1/grants` | `integration_grants_list` | `grants.read` | 200 | 6.2 到 6.4 |
| 8 | `GET /integration/v1/grants/{entitlement_id}` | `integration_grant_get` | `grants.read` | 200 | 6.3 的單筆 |
| 9 | `GET /integration/v1/events` | `integration_events_list` | `events.read` | 200 | 7.3 |
| 10 | `GET /integration/v1/webhooks` | `integration_webhook_list` | `webhooks.manage` | 200 | `{"items": [訂閱…]}`（不含 `secret`） |
| 11 | `POST /integration/v1/webhooks` | `integration_webhook_create` | `webhooks.manage` | 201 | 7.5 |
| 12 | `GET /integration/v1/webhooks/{endpoint_id}` | `integration_webhook_get` | `webhooks.manage` | 200 | 訂閱（不含 `secret`） |
| 13 | `PATCH /integration/v1/webhooks/{endpoint_id}` | `integration_webhook_update` | `webhooks.manage` | 200 | 請求：`event_types`、`description`、`status`、`resume_from` 的任意組合。回應：訂閱 |
| 14 | `DELETE /integration/v1/webhooks/{endpoint_id}` | `integration_webhook_delete` | `webhooks.manage` | 204 | — |
| 15 | `POST /integration/v1/webhooks/{endpoint_id}/rotate-secret` | `integration_webhook_rotate_secret` | `webhooks.manage` | 200 | 回應：訂閱加 `secret` |
| 16 | `POST /integration/v1/webhooks/{endpoint_id}/ping` | `integration_webhook_ping` | `webhooks.manage` | 202 | 回應：訂閱 |
| 17 | `POST /integration/v1/reconciliation/runs` | `integration_reconciliation_run_create` | `reconciliation.write` | 201 | 8.2 |
| 18 | `POST /integration/v1/reconciliation/runs/{run_id}/items` | `integration_reconciliation_items_add` | `reconciliation.write` | 200 | 8.3。請求內容上限 2 MB |
| 19 | `POST /integration/v1/reconciliation/runs/{run_id}/complete` | `integration_reconciliation_run_complete` | `reconciliation.write` | 202 | 8.4 |
| 20 | `GET /integration/v1/reconciliation/runs/{run_id}` | `integration_reconciliation_run_get` | `reconciliation.write` | 200 | 8.2 的批次；`summary` 是 `{"items": {"covered", "tolerated", "exceeds_approved", "ended_still_present", "unapproved"}, "missing", "findings_opened", "findings_resolved"}` |
| 21 | `GET /integration/v1/reconciliation/findings` | `integration_reconciliation_findings_list` | `reconciliation.write` | 200 | `{"items": [8.6 的發現…], "next_page_token"}` |
| 22 | `GET /integration/v1/reviews/campaigns` | `integration_reviews_list` | `reviews.read` | 200 | `{"items": [{"review_no", "name", "process_type", "status", "starts_at", "due_at", "item_count", "summary"}], "next_page_token"}` |
| 23 | `GET /integration/v1/reviews/campaigns/{review_no}` | `integration_review_get` | `reviews.read` | 200 | 上列欄位，加 `reviewer_kind`、`no_response_action`、`result_sha256`、`items`：`[{"item_id", "grant_id", "case_no", "subject", "scope_ref", "reviewer", "status", "decision", "decided_by", "decided_on_behalf_of", "decided_at", "reassign_reason", "followup_status", "snapshot_sha256"}]` |
| 24 | `GET /integration/v1/audit/events` | `integration_audit_events_list` | `audit.read` | 200 | 10.2、10.3 |
| 25 | `GET /integration/v1/evidence/chain` | `integration_evidence_chain` | `evidence.read` | 200 | 13.1 |
| 26 | `GET /integration/v1/evidence/chain-head` | `integration_evidence_chain_head` | `evidence.read` | 200 | 10.4 |
| 27 | `GET /integration/v1/evidence/checkpoints` | `integration_evidence_checkpoints_list` | `evidence.read` | 200 | `{"items": [10.4 的檢查點…], "next_cursor", "has_more"}` |
| 28 | `GET /integration/v1/evidence/checkpoints/{checkpoint_id}` | `integration_evidence_checkpoint_get` | `evidence.read` | 200 | 10.4 的檢查點 |

所有需要 token 的端點共通的錯誤（內容是 `{"code", "message"}`）：

| HTTP | `code` | 情況 | 額外的標頭 |
|---|---|---|---|
| 400 | `integration_invalid_request` | 內容不是合法的 JSON 物件、欄位缺少或格式不符 | — |
| 401 | `integration_invalid_token` | 沒有 token、token 不存在或過期、`api_client` 不是 `active` | `WWW-Authenticate: Bearer realm="sgn-integration", error="invalid_token"` |
| 403 | `integration_insufficient_scope` | token 沒有這個端點需要的 scope | `WWW-Authenticate: Bearer realm="sgn-integration", error="insufficient_scope", scope="<需要的 scope>"` |
| 404 | `integration_not_found` | 指定的東西不存在，或不在可見範圍（兩者不區分） | — |
| 413 | `payload_too_large` | 請求內容超過上限（預設 256 KB；上傳對帳項目 2 MB） | — |
| 429 | `integration_rate_limited` | 超過速率限制 | `Retry-After` |
| 503 | `integration_not_configured` | 參數 `integration.issuer` 尚未設定 | — |

個別端點另外的錯誤：`integration_too_many_evaluations`（400；#6）、`integration_cursor_invalid`（400；#7、#9、#21、#22、#24、#25、#27）、`webhook_origin_not_allowed`（400；#11）、`webhook_subscription_limit`（409；#11）、`integration_scope_not_visible`（403；#17）、`reconciliation_item_out_of_scope`（400；#18）、`reconciliation_too_many_items`（400；#18）、`reconciliation_run_not_collecting`（409；#18、#19）、`reconciliation_item_count_mismatch`（409；#19）。

後端為這些端點需要的機制（都只是機制，不含業務判斷）：

- 路由表的每一列多三個欄位：`auth: 'client'`（從標頭取出 token、做 SHA-256、當作第二個參數；`p_actor` 傳 null；結尾補上請求識別碼與來源 IP）、`bodyLimit`、`decorate`（只有 #11 與 #15 是 `'webhook_secret'`：把回應的 `secret_version` 換成推導出來的 `secret`）。
- 整合端點的錯誤處理：回應任何 4xx、5xx 之後呼叫 `integration_record_failure`；401、403 加上 `WWW-Authenticate`；429 加上 `Retry-After`（到下一個整分鐘的秒數）。
- #1 是專屬的 handler：解析 Basic 標頭與表單、把密鑰做 SHA-256、呼叫 function、依回傳的 `http_status` 回應，401 時加上 `WWW-Authenticate: Basic realm="sgn-integration"`。
- #4 由後端直接產生。
- 兩個 worker：webhook 推送、檢查點簽章。兩個 port：`Signer`（Ed25519 簽章與公鑰輸出、webhook 密鑰推導）、`TimestampAuthority`（RFC 3161；沒有設定時不啟用）。各有一個模擬 adapter 與合約測試。
- 部署設定（定義在 `api/src/config.ts`）：簽章私鑰清單、webhook 主金鑰、時間戳記服務網址、兩個 worker 的開關與間隔。

### 14.2 給人使用的端點

共 28 個，每個對應 13.3 的一個 function。路徑加本站的 API 前綴，以登入的工作階段驗證，角色在 function 裡檢查。

| 方法與路徑 | function |
|---|---|
| `GET /integration/clients` | `api_client_list` |
| `GET /integration/clients/:id` | `api_client_get` |
| `POST /integration/clients` | `api_client_create` |
| `PATCH /integration/clients/:id` | `api_client_update` |
| `POST /integration/clients/:id/status` | `api_client_set_status` |
| `POST /integration/clients/:id/credentials` | `api_client_credential_create` |
| `POST /integration/credentials/:id/revoke` | `api_client_credential_revoke` |
| `GET /integration/call-log` | `api_call_log_search` |
| `GET /integration/status` | `integration_status` |
| `GET /integration/clients/:id/webhooks` | `webhook_subscription_list` |
| `POST /integration/webhooks/:id/status` | `webhook_subscription_set_status` |
| `PUT /principals/:id/identities/:provider` | `principal_identity_set` |
| `DELETE /principals/:id/identities/:provider` | `principal_identity_remove` |
| `GET /reconciliation/runs` | `reconciliation_run_list` |
| `GET /reconciliation/runs/:id` | `reconciliation_run_get` |
| `GET /reconciliation/findings` | `reconciliation_finding_list` |
| `GET /reconciliation/findings/:id` | `reconciliation_finding_get` |
| `POST /reconciliation/findings/:id/acknowledge` | `reconciliation_finding_acknowledge` |
| `POST /reconciliation/findings/:id/dismiss` | `reconciliation_finding_dismiss` |
| `POST /access-reviews/campaigns` | `access_review_campaign_create` |
| `POST /access-reviews/campaigns/:id/cancel` | `access_review_campaign_cancel` |
| `GET /access-reviews/campaigns` | `access_review_campaign_list` |
| `GET /access-reviews/campaigns/:id` | `access_review_campaign_get` |
| `GET /access-reviews/items` | `access_review_item_list` |
| `GET /access-reviews/items/:id` | `access_review_item_get` |
| `POST /access-reviews/items/:id/decide`（需要 MFA，條件同簽核決定） | `access_review_item_decide` |
| `POST /access-reviews/items/decide-batch`（需要 MFA，條件同簽核決定） | `access_review_item_decide_batch` |
| `GET /evidence/checkpoints` | `evidence_checkpoint_list` |

這些端點的畫面（設定頁的整合狀態與系統管理、首頁的複查工作與對帳發現、稽核查詢的檢查點）由畫面契約定義；本文件只固定資料與規則。

## 15. 規則、錯誤、參數、排程

### 15.1 規則代碼

全部登記在 `sgn.rule`，所屬流程包為空（核心規則）。每一條至少一個資料庫測試，測試名稱包含代碼。

| 代碼 | 規則 |
|---|---|
| `K-INT-CLIENT-AUTH` | 整合介面只接受登記過、啟用中的 `api_client`，以未過期的 token 呼叫；每次呼叫都檢查狀態與 scope。登記、修改、停用只有系統管理員能做，要填原因並留紀錄 |
| `K-INT-CLIENT-OWNER` | 每個 `api_client` 隨時要有在職的負責人；負責人異動給寬限期改派，逾期暫停 |
| `K-INT-CRED-EXPIRE` | 憑證一定有到期日，不得超過上限；到期前提醒，到期失效 |
| `K-INT-VISIBILITY` | 呼叫方只能取得可見範圍內的資料；範圍外與不存在的回應相同 |
| `K-INT-CALL-LOG` | 每次呼叫都留紀錄；紀錄只增不改；每天的摘要雜湊寫入稽核鏈 |
| `K-INT-RATE-LIMIT` | 每個 `api_client` 每分鐘的呼叫數有上限 |
| `K-INT-PROJECT` | 權限項目與申請單、授權的狀態在同一個交易內同步；判定與查詢只讀整理好的權限項目 |
| `K-INT-CHECK` | 判定預設拒絕：找不到有效的權限項目就拒絕；限制條件無法驗證就拒絕；到期時間一到就拒絕 |
| `K-INT-CHECK-BASIS` | 每個判定結果都附原因；允許的結果一定附依據的權限項目、申請單與完整的限制條件 |
| `K-INT-EVENT-ORDER` | 事件序號與提交順序一致；至少送達一次；每個訂閱依序推送 |
| `K-INT-EXPIRING` | 授權到期前依參數發出即將到期的事件，同一個到期日只發一次 |
| `K-INT-WEBHOOK-DISABLE` | 重試用盡、收到 410、來源不再被允許、或系統被停用時，停用訂閱並通知 |
| `K-INT-RECON-COMPARE` | 對帳依固定的演算法比對，產生四種發現；每個批次留下統計與回報內容的雜湊 |
| `K-INT-RECON-ASSIGN` | 發現指派給回報系統的負責人，依嚴重度設定期限 |
| `K-INT-RECON-SLA` | 發現逾期升級給負責人的直屬主管並通知稽核 |
| `K-INT-RECON-CLOSE` | 發現只能由後續批次的證據結案，或由非負責人的系統管理員以指定原因排除 |
| `K-INT-RECON-OVERDUE` | 應回報的系統逾期沒有完成對帳，通知負責人並留紀錄 |
| `K-INT-REVIEW-SCHEDULE` | 依參數定期建立複查 |
| `K-INT-REVIEW-SOD` | 複查人不得是該授權的申請人或權限項目的主體本人；違反時改由上一層主管 |
| `K-INT-REVIEW-DECIDE` | 複查決定綁定當時的權限項目內容；決定後不可更改；代理與手機 MFA 的規則同簽核 |
| `K-INT-REVIEW-REVOKE` | 複查決定撤銷時，立即撤銷整筆授權 |
| `K-INT-REVIEW-REDUCE` | 複查決定縮小時，期限內未縮小就自動撤銷 |
| `K-INT-REVIEW-NO-RESPONSE` | 複查不回應：提醒、升級；仍不回應時依設定自動撤銷或列為例外 |
| `K-INT-CHECKPOINT` | 定期產生稽核鏈的檢查點並簽章，送到平台以外保存 |

### 15.2 錯誤代碼

全部登記在 `sgn.error_catalog`。SQLSTATE 依核心對各 HTTP 狀態的配置規則指派。

| 代碼 | HTTP | 訊息 |
|---|---|---|
| `integration_invalid_request` | 400 | 請求格式不正確 |
| `integration_too_many_evaluations` | 400 | 一次判定的筆數超過上限 |
| `integration_cursor_invalid` | 400 | 游標不正確 |
| `integration_invalid_token` | 401 | 驗證失敗 |
| `integration_insufficient_scope` | 403 | 這個系統沒有使用這項功能的權限 |
| `integration_scope_not_visible` | 403 | 宣告的範圍超出這個系統的可見範圍 |
| `integration_not_found` | 404 | 找不到指定的資料 |
| `integration_rate_limited` | 429 | 呼叫太頻繁，請稍後再試 |
| `integration_not_configured` | 503 | 整合介面尚未設定 |
| `entitlement_hook_invalid` | 500 | 流程包回傳的權限描述格式不正確 |
| `entitlement_duplicate_resource` | 500 | 流程包回傳的權限描述有重複的資源 |
| `webhook_origin_not_allowed` | 400 | 這個網址的來源不在允許清單內 |
| `webhook_subscription_limit` | 409 | 訂閱數已達上限 |
| `webhook_status_invalid` | 409 | 目前的狀態不能做這個變更 |
| `reconciliation_item_out_of_scope` | 400 | 有項目超出這個批次宣告的範圍 |
| `reconciliation_too_many_items` | 400 | 項目數超過上限 |
| `reconciliation_run_not_collecting` | 409 | 這個批次已經不能再上傳 |
| `reconciliation_item_count_mismatch` | 409 | 宣告的筆數與收到的筆數不同 |
| `api_client_not_found` | 404 | 找不到這個系統 |
| `api_client_code_taken` | 409 | 這個系統代碼已被使用 |
| `api_client_owner_inactive` | 409 | 負責人必須是在職人員 |
| `api_client_scope_unknown` | 400 | 有不存在的可用範圍 |
| `api_client_status_invalid` | 409 | 目前的狀態不能做這個變更 |
| `api_client_credential_limit` | 409 | 有效的憑證數已達上限 |
| `api_client_credential_expiry_invalid` | 400 | 到期日超過允許的上限 |
| `integration_reason_required` | 400 | 請填寫原因 |
| `principal_identity_taken` | 409 | 這個外部識別碼已對應到其他被授權者 |
| `finding_not_found` | 404 | 找不到這筆對帳發現 |
| `finding_not_assignee` | 403 | 只有負責人可以回應這筆發現 |
| `finding_dismiss_by_assignee` | 403 | 負責人不能排除自己負責的發現 |
| `finding_already_closed` | 409 | 這筆發現已結案 |
| `review_campaign_not_found` | 404 | 找不到這一輪複查 |
| `review_campaign_invalid` | 400 | 複查的設定不正確 |
| `review_campaign_status_invalid` | 409 | 目前的狀態不能做這個變更 |
| `review_item_not_found` | 404 | 找不到這件複查工作 |
| `review_item_not_reviewer` | 403 | 你不是這件工作的複查人 |
| `review_item_already_decided` | 409 | 這件工作已經決定 |
| `review_item_changed` | 409 | 授權內容已改變，請重新檢視後再決定 |
| `review_note_required` | 400 | 請填寫說明 |
| `review_revoke_not_allowed` | 409 | 這種流程的授權不能撤銷 |

### 15.3 參數

全部登記在 `sgn.setting_definition`，所屬流程包為空。

| key | 型別與單位 | 預設 | 允許範圍 | 可依什麼設定不同的值 |
|---|---|---|---|---|
| `integration.issuer` | 文字（網址） | 空字串 | `https` 網址，無查詢字串與 fragment，結尾無 `/` | — |
| `integration.access_token_ttl_seconds` | 整數，秒 | 600 | 60–3600 | — |
| `integration.credential_max_age_days` | 整數，天 | 365 | 30–730 | — |
| `integration.credential_remind_before_days` | 整數，天 | 30 | 1–90 | — |
| `integration.credential_max_active` | 整數 | 2 | 1–3 | — |
| `integration.client_owner_grace_days` | 整數，天 | 14 | 1–60 | — |
| `integration.rate_limit_per_minute` | 整數 | 600 | 1–6000 | `scope_ref`（`api_client:<code>`） |
| `integration.token_rate_limit_per_minute` | 整數 | 10 | 1–60 | — |
| `integration.check_max_evaluations` | 整數 | 100 | 1–500 | — |
| `integration.decision_ttl_seconds` | 整數，秒 | 60 | 0–3600 | 流程類型 |
| `integration.deny_ttl_seconds` | 整數，秒 | 30 | 0–600 | — |
| `integration.check_ended_lookback_days` | 整數，天 | 30 | 0–365 | — |
| `integration.page_size_default` | 整數 | 100 | 1–500 | — |
| `integration.page_size_max` | 整數 | 500 | 1–1000 | — |
| `integration.call_log_retention_days` | 整數，天 | 400 | 30–3650 | — |
| `integration.webhook_max_per_client` | 整數 | 5 | 1–20 | — |
| `integration.webhook_allow_http` | 布林 | false | — | — |
| `integration.webhook_timeout_seconds` | 整數，秒 | 15 | 5–30 | — |
| `integration.webhook_max_attempts` | 整數 | 10 | 1–20 | — |
| `integration.webhook_retry_base_seconds` | 整數，秒 | 5 | 1–600 | — |
| `integration.webhook_retry_factor` | 整數 | 6 | 2–10 | — |
| `integration.webhook_retry_cap_seconds` | 整數，秒 | 86400 | 60–86400 | — |
| `integration.webhook_secret_overlap_hours` | 整數，小時 | 24 | 1–168 | — |
| `reconciliation.expected_interval_days` | 整數，天 | 7 | 1–90 | `scope_ref`（`api_client:<code>`） |
| `reconciliation.grace_minutes` | 整數，分鐘 | 60 | 0–1440 | 流程類型 |
| `reconciliation.collect_timeout_hours` | 整數，小時 | 24 | 1–72 | — |
| `reconciliation.max_items` | 整數 | 200000 | 1–1000000 | — |
| `reconciliation.items_per_request_max` | 整數 | 1000 | 1–5000 | — |
| `reconciliation.item_retention_days` | 整數，天 | 400 | 30–3650 | — |
| `reconciliation.finding_due_workdays_high` | 整數，工作天 | 2 | 1–30 | 流程類型 |
| `reconciliation.finding_due_workdays_low` | 整數，工作天 | 5 | 1–60 | 流程類型 |
| `review.interval_months` | 整數，月（0 表示不自動建立） | 0 | 0–24 | 流程類型 |
| `review.duration_days` | 整數，天 | 14 | 3–60 | 流程類型 |
| `review.remind_before_days` | 整數，天 | 3 | 1–14 | — |
| `review.escalation_workdays` | 整數，工作天 | 5 | 1–20 | 流程類型 |
| `review.no_response_action` | 列舉 `revoke`／`escalate_only` | `revoke` | — | 流程類型 |
| `review.reduce_followup_workdays` | 整數，工作天 | 10 | 1–30 | 流程類型 |
| `evidence.checkpoint_interval_minutes` | 整數，分鐘 | 60 | 5–1440 | — |
| `evidence.checkpoint_mail_enabled` | 布林 | true | — | — |
| `evidence.audit_page_size_max` | 整數 | 1000 | 100–5000 | — |

沿用骨幹既有的參數：`validity.remind_before_days`（即將到期事件的天數）、`audit.retention_years`。

每個規則做決定時用到的參數值，照工程規範記進該筆稽核事件的參數快照。

### 15.4 排程工作

六個工作由核心的排程入口每一輪依序呼叫，各自決定這一輪要不要做事，執行結果寫入 `scheduler_run`。後端的兩個 worker 不在此列。

| function | 內容 | 規則 |
|---|---|---|
| `job_integration_expiring` | 找出 `active` 而且 `effective_until` 在 `validity.remind_before_days` 天內的權限項目；以申請單為單位，同一個到期日還沒發過就發 `sgn.grant.expiring` | `K-INT-EXPIRING` |
| `job_integration_client_hygiene` | (1) 負責人不在職的 `api_client`：第一次發現時設定寬限期限並通知其主管；逾期改為 `suspended`。(2) 憑證到期提醒。(3) 刪除過期超過一天的 token。(4) 刪除一小時以前的速率計數 | `K-INT-CLIENT-OWNER`、`K-INT-CRED-EXPIRE` |
| `job_integration_call_log_seal` | 每天一次：封存昨天以前尚未封存的每一天（寫 `api_call_log_seal` 與稽核事件）；刪除超過保存天數且已封存的紀錄（寫稽核事件） | `K-INT-CALL-LOG` |
| `job_reconciliation` | (1) 比對所有 `comparing` 的批次。(2) 逾時的 `collecting` 批次改為 `abandoned`。(3) 逾期的發現升級。(4) 逾期未對帳的系統通知負責人（每個間隔一次）。(5) 刪除超過保存天數的回報項目 | `K-INT-RECON-COMPARE`、`K-INT-RECON-SLA`、`K-INT-RECON-OVERDUE` |
| `job_access_review` | (1) 依 `review.interval_months` 建立新的一輪。(2) 開始已到 `starts_at` 的複查。(3) 提醒。(4) 逾期升級。(5) 升級後仍不回應的處理。(6) `reduce` 後續追蹤逾期的自動撤銷。(7) 結束已完成的複查 | `K-INT-REVIEW-SCHEDULE`、`K-INT-REVIEW-NO-RESPONSE`、`K-INT-REVIEW-REDUCE` |
| `job_evidence_checkpoint` | 距離上一個檢查點已滿間隔、而且鏈頭有前進：建立新的檢查點（未簽章）。每天一次把最新的已簽章檢查點寄給稽核角色 | `K-INT-CHECKPOINT` |

每個工作都可以重複執行而不產生重複的結果；測試直接呼叫這些 function 並搭配假時鐘。

## 16. 安全設計

### 16.1 驗證與授權

| 項目 | 設計 |
|---|---|
| 傳輸 | 只接受 TLS。正式環境由反向代理終止 TLS；後端在正式環境拒絕非 HTTPS 的整合請求 |
| 身分 | OAuth 2.0 client credentials。密鑰只出現在 token 端點；其他呼叫只帶短效 token |
| 密鑰與 token 的保存 | 資料庫只有 SHA-256。後端在進資料庫之前就做雜湊，所以資料庫的參數、記錄檔都不會出現原文。後端的記錄檔要遮蔽 `Authorization` 標頭 |
| 檢查的位置 | 驗證、狀態、scope、速率全部在 `sgn_internal.authenticate_client` 這一個入口，每次呼叫都執行。後端不快取驗證結果，所以暫停與縮小 scope 立即生效 |
| 兩層授權 | scope 決定「能用哪些功能」，可見範圍決定「能看到哪些資料」。兩者都通過才有結果 |
| 管理動作 | 登記、修改、停用、發憑證只有 `sys_admin` 能做，都要填原因並寫入稽核鏈 |
| 人與系統分開 | 給其他系統的 function 不接受人的身分（`p_actor` 必須是 null）；給人的 function 不接受 token。一個 token 永遠不能做簽核、複查決定或任何管理動作 |

### 16.2 防重放

| 對象 | 做法 |
|---|---|
| 呼叫平台的請求 | TLS 加上短效 token（預設 10 分鐘）。token 外洩的影響限於它的 scope、可見範圍與剩餘時間；撤銷憑證或暫停系統可以立即使它失效 |
| webhook | 簽章涵蓋 `webhook-id`、`webhook-timestamp` 與內容；使用方檢查時間差不超過 5 分鐘並以 `webhook-id` 去重。`v2a` 的簽章內容含 `endpoint_id`，送給甲的事件不能重放給乙 |
| 事件 | 序號嚴格遞增。使用方記住已處理的最大序號，較舊的事件可以直接略過 |
| 對帳上傳 | `item_key` 讓重送不會重複；宣告完成時核對筆數 |
| 複查決定 | 帶內容雜湊；已決定的工作不能再決定 |

### 16.3 資訊最小揭露

- 所有輸出先套用可見範圍（`K-INT-VISIBILITY`）。一張申請單只有部分權限項目可見時，只輸出可見的部分。
- 主體只以呼叫方自己的身分來源的識別碼表示。不輸出姓名、email、部門。被授權者的負責人也只輸出識別碼。
- 不輸出申請內容本身（使用情境、說明、附件），只輸出權限項目。
- 撤銷原因、複查說明等自由文字不放進事件與授權查詢；它們只出現在稽核輸出，而稽核輸出需要獨立的 scope。
- 呼叫紀錄不保存 `context` 的原文，只保存雜湊。
- webhook 的回應內容不保存，只記狀態碼與截短到 500 個字元的錯誤訊息。

### 16.4 防列舉

| 可能的探測 | 對策 |
|---|---|
| 猜主體是否存在 | 主體不存在、沒有可見的授權、資源不在可見範圍，三者的判定結果完全相同（`no_entitlement`、相同的 `ttl_seconds`）；授權查詢一律回空清單 |
| 猜 id | 不存在與不可見都是 404（`integration_not_found`），訊息相同 |
| 猜系統代碼與密鑰 | token 端點的所有驗證失敗都是相同的 `invalid_client`；每個系統有獨立的換發速率上限，未驗證的請求另有依來源 IP 的限制 |
| 大量嘗試 | 速率限制；每次呼叫都留紀錄；整合狀態頁顯示每個系統 `no_entitlement` 的比例與 4xx 數量，異常時可以看出來 |

已知的限制：主體不存在時判定會提早結束，回應時間可能比「存在但沒有授權」略短。第一版不做等時處理，以速率限制與紀錄作為補償。

### 16.5 輸入驗證

所有檢查在資料庫的 function 裡做，後端只擋大小與 JSON 語法。

| 項目 | 限制 |
|---|---|
| 請求內容大小 | 256 KB；上傳對帳項目 2 MB |
| 頂層 | 必須是 JSON 物件。不認得的鍵一律忽略（AuthZEN 的要求） |
| `subject.type` | `person` 或 `principal` |
| `subject.id` | 1 到 256 個字元，不含控制字元 |
| `properties.provider` | `^[a-z][a-z0-9_]{0,31}$` |
| `resource.type`、`action.name` | `^[a-z][a-z0-9_]{0,63}$` |
| `resource.id` | 1 到 512 個字元，不含控制字元 |
| `context`、`constraints` | 物件；序列化後不超過 16 KB；巢狀不超過 8 層 |
| `properties` | 物件；序列化後不超過 4 KB |
| `evaluations` | 不超過 `integration.check_max_evaluations` 筆 |
| 查詢參數 | 不認得的參數忽略；認得的參數格式不符回 400 |
| `limit` | 1 到上限；超過上限時取上限，不回錯誤 |
| 路徑中的 id | 不是合法的數字或格式時回 404，不回 400 |
| webhook 網址 | 見 7.5；另外，後端在送出前解析主機，解析結果是 loopback 或 link-local 位址時拒絕（`integration.webhook_allow_http` 為 true 的測試環境除外）；不跟隨轉址 |

流程包的 hook 只會收到已通過上述檢查的資料。核心以 `regprocedure` 呼叫 hook，函式名稱來自登記時已驗證的 `process_type`，不拼接任何外部輸入。

### 16.6 稽核

| 事情 | 記在哪裡 |
|---|---|
| 系統的登記、修改、暫停、停用、憑證的建立與撤銷、可見範圍的改變 | 稽核事件（雜湊鏈） |
| 被授權者外部識別碼的設定與移除 | 稽核事件 |
| webhook 訂閱的建立、修改、刪除、自動停用 | 稽核事件 |
| 對帳批次完成、發現的每一步 | 稽核事件 |
| 複查的每一步 | 稽核事件 |
| 每一次呼叫（含每一筆判定的結果與依據） | 呼叫紀錄；每日摘要雜湊寫入稽核事件 |
| 每一次 webhook 嘗試 | `webhook_attempt` |

由其他系統觸發的稽核事件（訂閱管理、對帳批次），actor 記為系統，變更內容帶 `api_client` 的代碼（見附錄 A 第 4 項）。

### 16.7 其他

- 金鑰：簽章私鑰與 webhook 主金鑰只在後端的部署設定裡，不進資料庫、不進 repo。開發與測試環境用 `sim/` 產生的金鑰。
- 流程包的 hook 出錯不會放行：`evaluate_constraints` 的例外視為不符合；`describe_entitlements` 的格式錯誤會讓狀態轉移失敗，而不是悄悄產生錯誤的權限項目。
- 平台只回答核准了什麼。使用方被入侵或不照判定結果執行，要靠對帳發現。

## 17. migration 檔案與測試

### 17.1 migration 檔案

都在 `db/kernel/` 下，檔名前綴的編號依核心的編號規則；下表是相對順序。

| 順序 | 檔案 | 內容 |
|---|---|---|
| 核心資料表之後 | `integration_schema.sql` | 11.1 的型別、22 張資料表、兩個序列、只增不改的觸發程序；種子：`api_scope`、`integration_event_type`、15.1 的規則、15.2 的錯誤、15.3 的參數 |
| 緊接其後；**在申請單與授權生命週期 function 之前** | `integration_projection.sql` | 12.1、12.2 的 function（投影、事件、主體、可見範圍） |
| 生命週期 function 之後 | `integration_clients.sql` | `authenticate_client`、`log_api_call`；系統管理、憑證、token、中繼資料、呼叫紀錄的 function；`job_integration_client_hygiene`、`job_integration_call_log_seal` |
| | `integration_access.sql` | `validate_access_request`、`evaluate_access`、`render_entitlement`、`decode_sync_cursor`；判定與授權查詢的 function |
| | `integration_events.sql` | `render_integration_event`、事件串流、webhook 的 function（含給 worker 的兩個）；`job_integration_expiring` |
| | `integration_reconciliation.sql` | 對帳的 function；`job_reconciliation` |
| | `integration_review.sql` | 複查的 function；`job_access_review` |
| | `integration_evidence.sql` | 稽核輸出、鏈頭、檢查點的 function；`audit_ocsf_map` 的種子；`job_evidence_checkpoint` |

每個檔案在自己定義 function 的同時，寫入對應的 `api_function_scope` 列。核心的排程入口要能呼叫到六個工作 function，所以它的檔案排在這些檔案之後，或以登記表的方式呼叫（依核心的排程機制）。

邊界檢查：這八個檔案不得出現任何流程包的代號。

### 17.2 資料庫測試

放在 `db/tests/kernel/`。測試用的流程類型由測試自己建立（一個使用被授權者與有效期間、一個不使用），並以測試專用的 schema 實作兩個 hook；不依賴任何流程包。

| 規則 | 測試（每一列至少一個測試，名稱包含規則代碼） |
|---|---|
| `K-INT-CLIENT-AUTH` | 未登記、暫停、停用的系統被拒；過期的 token 被拒；憑證撤銷後它換發的 token 立即被拒；缺 scope 回 403；縮小 scope 後舊 token 立即受限；token 端點各種失敗都回相同的 `invalid_client`；非系統管理員不能登記；登記缺原因被拒；`p_actor` 非 null 被拒 |
| `K-INT-CLIENT-OWNER` | 負責人離職 → 設定寬限期並通知 → 逾期暫停；期限內改派則清除 |
| `K-INT-CRED-EXPIRE` | 到期日超過上限被拒；超過有效憑證數被拒；到期前提醒；到期後不能換發 |
| `K-INT-VISIBILITY` | 流程類型不可見、資源類型不可見、前綴不符，判定都與不存在相同；授權查詢、事件、稽核輸出同樣過濾；一張單部分可見時只輸出可見的項目；單筆查詢不可見回 404 |
| `K-INT-CALL-LOG` | 成功的呼叫有一筆紀錄且內容正確；`record_failure` 補上失敗的紀錄；紀錄表擋下 `UPDATE`、`DELETE`、`TRUNCATE`；每日封存的雜湊可以重算；未封存的不會被刪；改動一筆後雜湊對不上 |
| `K-INT-RATE-LIMIT` | 超過上限回 429；下一個視窗恢復；個別系統的上限生效；批次判定算一次 |
| `K-INT-PROJECT` | 兩種 `effective_during` 的每一個狀態對應（3.4 的每一列）；重複呼叫不產生重複的事件；hook 回傳重複資源時狀態轉移失敗；hook 格式錯誤時失敗；內容縮小、擴大、修改分別得到正確的 `change_class`；`sync_seq` 等於事件序號；沒有登記 hook 的流程類型不產生權限項目 |
| `K-INT-CHECK` | 五種 `reason` 各一；到期時間已過但排程尚未執行時拒絕；人透過成員身分取得、移除成員後失去；有限制條件但沒有登記 hook 時拒絕；hook 丟例外時拒絕；多筆授權其中一筆符合即允許；`context.time` 不影響判定；批次的三種語意；預設值的取代規則；筆數超過上限回 400 |
| `K-INT-CHECK-BASIS` | 允許的結果帶 `basis` 與完整的 `constraints`；`decision_id` 對得回呼叫紀錄；`ttl_seconds` 的四種算法；一次性許可的 `ttl_seconds` 是 0 |
| `K-INT-EVENT-ORDER` | 兩個並行交易的事件序號與提交順序一致（以兩條連線測試）；串流的游標在沒有可見事件時仍前進；`types` 篩選；沒有對應 scope 的類型不出現；webhook 前一個未成功時不送下一個 |
| `K-INT-EXPIRING` | 進入提醒天數時發一次；重複執行不重發；續期產生新的到期日後再發一次 |
| `K-INT-WEBHOOK-DISABLE` | 來源不在允許清單被拒；ping 成功才啟用；失敗後的等待時間符合公式的範圍；`Retry-After` 生效；重試用盡停用並通知；410 立即停用；從停用恢復時 `cursor` 與 `tail` 的差別；輪替密鑰後重疊期間回傳兩個版本；移除允許的來源後訂閱被停用 |
| `K-INT-RECON-COMPARE` | 五種項目結果各一；`missing`；寬限時間內的新授權與剛結束的授權不算發現；主體解析不出來；以人回報而授權給團隊時算對得上；回報沒有限制條件而核准有限制時是超出；範圍外的項目被拒；筆數不符被拒；0 筆的快照讓範圍內全部有效項目成為 `missing`；批次的稽核事件帶正確的雜湊 |
| `K-INT-RECON-ASSIGN` | 指派給系統負責人；期限依嚴重度與工作天計算；相同指紋不重複建立 |
| `K-INT-RECON-SLA` | 逾期升級給主管並通知稽核；只升級一次 |
| `K-INT-RECON-CLOSE` | 後續批次不再出現時自動結案；批次範圍沒有涵蓋的發現不會被結案；負責人不能排除；非負責人的系統管理員可以排除且必須選原因 |
| `K-INT-RECON-OVERDUE` | 超過間隔沒有完成的批次時通知一次 |
| `K-INT-REVIEW-SCHEDULE` | 參數為 0 不建立；滿月數建立一次；重複執行不重複建立 |
| `K-INT-REVIEW-SOD` | 複查人是申請人時改由主管；主管也違反時再往上；找不到上一層時交給系統管理員群組；代理人違反時不能決定 |
| `K-INT-REVIEW-DECIDE` | 三種決定；雜湊不符回 409；已決定不能再決定；非複查人被拒；代理人決定時記下代誰；批次維持每件各一筆稽核事件；`reduce`、`revoke` 缺說明被拒 |
| `K-INT-REVIEW-REVOKE` | 決定撤銷後授權立即撤銷、權限項目結束、發出事件 |
| `K-INT-REVIEW-REDUCE` | 期限內縮小 → 追蹤完成；逾期 → 自動撤銷 |
| `K-INT-REVIEW-NO-RESPONSE` | 提醒；到期升級且原複查人不能再決定；升級後仍不回應時兩種處理各一；決定前授權已結束的工作改為 `not_applicable`；全部完成後結束並寫入正確的統計與雜湊 |
| `K-INT-CHECKPOINT` | 鏈頭沒有前進時不產生；產生的檢查點指向前一個；簽章只能寫入一次；其他欄位不可改；簽章後發出事件；依 10.5 的步驟對種子資料驗證成功，改動一筆稽核事件後驗證失敗 |

架構與契約測試：

- 給其他系統的 24 個 function 都呼叫 `authenticate_client` 與 `log_api_call`，而且在 `api_function_scope` 有一列；`api_function_scope` 沒有多餘的列。
- 本文件的 22 張表 `sgn_app` 都沒有權限；標示為只增不改的表擋下對應的操作。
- 判定的查詢計畫沒有對 `sgn.entitlement` 做循序掃描。
- `integration_event_type`、`api_scope` 的內容與 7.1、4.4 一致（由產生器輸出成 TypeScript 與參考文件）。
- 路由表的每個整合端點都對應到存在的 function，參數相符；13.2 的五個 function 列為只供後端使用。
- `integration_authzen_metadata` 的 `policy_decision_point` 等於參數值，各端點網址以它開頭。

### 17.3 後端測試

- token handler：Basic 標頭的各種錯誤、表單解析、依 `http_status` 回應、`WWW-Authenticate`。
- `auth: 'client'`：沒有標頭、格式錯誤、雜湊後傳入；`X-Request-ID` 原樣回傳與自動產生；錯誤時呼叫 `record_failure`；429 的 `Retry-After`。
- webhook worker：`v1` 與 `v2a` 簽章以 Standard Webhooks 規格裡的範例向量驗證；送出的內容與領取到的 `body` 逐位元組相同；不跟隨轉址；逾時；回報的參數。
- `Signer` 與 `TimestampAuthority` 的合約測試；`jwks.json` 的內容；檢查點簽章可以用 `jose` 驗證。
- `tools/verify-audit-chain`：對正確的匯出檔通過；改動事件、刪除事件、改動檢查點各自失敗。

## 18. 模擬環境：示範用的使用方系統

骨幹第 12 節規定 `sim/` 要有一個「使用權限的其他系統」。它的目的是用真實的協定走完整合介面的每一條路徑；整合測試與端對端測試都對著它跑。

### 18.1 `sim/consumer`：報表入口網站

一個獨立的小型服務，有自己的資料庫，裡面只有一張「本地權限表」（主體、資源、動作、限制條件、來源的 `entitlement_id`）。它代表任何一個自己保存權限設定的系統。

它以一般使用方的身分使用整合介面，不讀平台的資料庫，也不使用平台的內部 function。

| 行為 | 使用的介面 |
|---|---|
| 啟動時讀 `GET /integration/v1` 與 AuthZEN 中繼資料取得各端點 | 中繼資料 |
| 換發 token，過期前自動重新換發 | token 端點 |
| 有人讀報表時，先問平台能不能讀（並依 `ttl_seconds` 快取） | 單筆與批次判定 |
| 第一次啟動做完整快照，之後增量同步到本地權限表 | 授權查詢 |
| 接收 webhook：驗 `v1` 與 `v2a`、檢查時間、去重、更新本地權限表、清快取 | webhook |
| 重新啟動後從上次的游標補讀事件 | 事件串流 |
| 把本地權限表整份回報 | 對帳 |
| 取稽核事件與檢查點，執行驗證工具 | 證據輸出 |

對外的端點：

| 端點 | 用途 |
|---|---|
| `GET /healthz` | 健康檢查 |
| `GET /reports/:resource_id?as=<人的識別碼>&…` | 模擬使用者讀資料。回 200 或 403，並帶判定的依據 |
| `POST /hooks/sgn` | webhook 接收端 |
| `POST /seal-device/affix` | 模擬電子用印設備：收到申請人與文件，算出文件雜湊後問平台能不能蓋 |
| `POST /control/sync` | 立即做一次同步（完整或增量） |
| `POST /control/replay` | 從指定的游標重讀事件 |
| `POST /control/reconcile` | 立即回報一次對帳，回傳批次結果 |
| `POST /control/drift` | 製造偏差：加一筆沒核准的權限、放寬一筆的限制條件、刪掉一筆、忽略下一個撤銷事件 |
| `POST /control/webhook-behavior` | 讓接收端在接下來 N 次回 500、回 410、或延遲回應 |
| `POST /control/verify-chain` | 匯出稽核事件與檢查點並執行驗證工具 |
| `GET /control/state` | 本地權限表、收到的事件、游標、快取 |

`/control/*` 只給測試使用。

腳本：`sim/consumer/start.sh`、`sim/consumer/stop.sh`（骨幹第 12 節的要求），以及 `sim/consumer/register.sh`：以系統管理員的身分呼叫 14.2 的端點登記 `api_client`（代碼 `sim-report-portal`，身分來源是模擬 LDAP）、設定可見範圍與 webhook 來源、建立憑證，並把憑證寫進這個服務的設定。

資料授權的執行系統模擬器（DC）也登記成另一個 `api_client`，回報它從資料庫讀出的真實欄位權限與列層級安全設定。這樣對帳比對的是真的權限，不是另一份名單。

### 18.2 要驗證的情境

每個情境是一個端對端測試。人員與被授權者用 [seed-directory.md](seed-directory.md) 的名單。

| # | 情境 | 預期 | 規則 |
|---|---|---|---|
| 1 | 申請單核准、執行、驗證完成 | 使用方收到 `sgn.grant.activated`，本地權限表出現對應的項目；團隊成員讀報表得到 200，非成員得到 403 | `K-INT-PROJECT`、`K-INT-CHECK` |
| 2 | 讀取超出列條件的範圍 | 403，原因 `constraint_not_satisfied`，依據帶核准的限制條件 | `K-INT-CHECK-BASIS` |
| 3 | 負責人撤銷授權 | 幾秒內收到 `sgn.grant.revoked`，快取被清，下一次讀取 403 | `K-INT-EVENT-ORDER` |
| 4 | 使用方停機期間發生三個事件，再啟動 | 從游標補讀，三個事件依序處理，本地權限表與授權查詢的結果一致 | `K-INT-EVENT-ORDER` |
| 5 | 接收端連續回 500 | 依間隔重試（用假時鐘推進）；恢復後依序補送；`webhook-id` 不變 | `K-INT-WEBHOOK-DISABLE` |
| 6 | 接收端回 410 | 訂閱被停用，負責人收到通知信（從模擬 SMTP 讀取） | `K-INT-WEBHOOK-DISABLE` |
| 7 | 竄改 webhook 內容後重送給接收端 | 接收端驗章失敗，拒收 | 16.2 |
| 8 | 製造四種偏差後回報對帳 | 產生四種發現，各自指派給系統負責人；修正後再回報，發現自動結案 | `K-INT-RECON-COMPARE`、`K-INT-RECON-CLOSE` |
| 9 | 忽略撤銷事件後回報對帳 | `ended_still_present` | `K-INT-RECON-COMPARE` |
| 10 | 授權到期（假時鐘推進，排程尚未執行） | 判定立即拒絕；排程執行後收到 `sgn.grant.expired` | `K-INT-CHECK` |
| 11 | 把成員移出團隊 | 收到 `sgn.principal.membership_changed`；該成員下一次讀取 403 | `K-INT-CHECK` |
| 12 | 用印申請核准後、用印前 | 用印設備以正確的文件得到允許；換一份文件被拒；標記完成後再問被拒 | `K-INT-CHECK`、`K-INT-PROJECT` |
| 13 | 建立一輪複查，複查人決定撤銷 | 授權被撤銷，使用方收到事件；複查結果可以從整合端點取得 | `K-INT-REVIEW-REVOKE` |
| 14 | 複查人就是申請人 | 工作改派給他的主管 | `K-INT-REVIEW-SOD` |
| 15 | 取得檢查點與稽核事件並驗證；之後直接改資料庫裡的一筆稽核事件再驗證 | 第一次通過，第二次失敗並指出是哪一筆 | `K-INT-CHECKPOINT` |
| 16 | 以沒有該 scope 的 token、過期的 token、可見範圍外的資源呼叫 | 403、401、與不存在相同的結果 | `K-INT-CLIENT-AUTH`、`K-INT-VISIBILITY` |
| 17 | 暫停使用方的 `api_client` | 進行中的 token 立即被拒；webhook 停止推送；恢復後從原進度繼續 | `K-INT-CLIENT-AUTH` |

情境 12 用合約用印流程包，其他用資料授權流程包；兩者走的是同一套核心程式。

## 附錄 A　骨幹修改建議

本文件沒有修改骨幹。下列各項是本文件的設計需要、而骨幹目前沒有寫或寫法不同的地方。

| # | 骨幹位置 | 建議 | 本文件目前的處理 |
|---|---|---|---|
| 1 | 第 6、11 節 | 明定核心要在狀態轉移的唯一入口呼叫 `sgn_internal.project_case`，在被授權者的負責人與成員異動時呼叫 `sgn_internal.project_principal` | 2.2 定義了入口與呼叫時機 |
| 2 | 第 11 節 `describe_entitlements` | 回傳元素增加兩個選填鍵：`effective_during`（`active`／`fulfilment`）、`scope_ref`；明定同一張單內資源不得重複、function 必須是 `stable` | 3.3、3.4 |
| 3 | 第 11 節 `evaluate_constraints` | 明定 `p_context` 的結構與 `mode`（`check`／`reconcile`）；預設行為補上「有限制條件而沒有登記 hook 時回 false」 | 3.3 |
| 4 | 第 2 節 `audit_event` | 增加 actor 的種類（人、系統、其他系統）與 `api_client` 的欄位，讓由其他系統觸發的動作可以直接篩選 | actor 記為系統，`api_client` 的代碼放在變更內容裡 |
| 5 | 第 2 節 核心實體 | 加入 `principal_identity`（與 `person_identity` 對稱），以及本文件的整合相關資料表 | 由本模組的 migration 建立 |
| 6 | 第 2、5 節 稽核鏈 | 在核心契約明定雜湊的輸入文字（`canonical`）與公式，並提供取得每一筆 `canonical` 的方式。第三方驗證需要它 | 10.2、10.5 以「核心提供 `canonical`」為前提 |
| 7 | 第 1 節 命名 | `case` 與 `grant` 是 SQL 保留字，資料表名稱要一律加雙引號，或改名 | DDL 一律加雙引號 |
| 8 | 第 2、4 節 `grant` | 明定沒有有效期間的流程類型（例如合約用印）是否建立 `grant` 紀錄 | 兩種情況都能運作：`entitlement.grant_id` 可為 null |
| 9 | 第 5 節 | 核心需要一個「以指定的規則代碼、由系統或指定的人撤銷授權」的內部入口；以及「把生效中的授權縮小」的入口（複查決定為縮小時使用） | 2.1 列為依賴；沒有縮小入口時，縮小只能靠重新申請加上逾期自動撤銷 |
| 10 | 第 5 節 | `K-DELEGATE`、`K-MOBILE-MFA` 的適用範圍加上複查決定 | 9.3 已如此規定 |
| 11 | 第 8 節 | 參數前綴增加 `integration.`、`reconciliation.`、`review.`、`evidence.`；`scope_ref` 適用範圍的值用 `api_client:<code>` 表示個別系統 | 15.3 |
| 12 | 第 10 節 | 通用畫面增加：複查工作（清單與決定）、對帳發現（清單與回應）、整合系統管理 | 14.2 提供資料與規則，畫面由畫面契約定義 |
| 13 | 第 11 節 命名 | `events` 的資料表是 `integration_event`；`evidence` 的資料表是 `evidence_checkpoint`；`audit_feed` 是端點 `/integration/v1/audit/events`，沒有獨立的資料表 | 依本文件 |
| 14 | 工程規範第 2 節 | 路由表增加 `auth: 'client'`、`bodyLimit`、`decorate`；對外 port 增加 `Signer`、`TimestampAuthority`；整合端點不加 `/api` 前綴 | 14.1 |

## 附錄 B　查證來源

| 標準 | 來源 |
|---|---|
| AuthZEN Authorization API 1.0 | <https://openid.net/specs/authorization-api-1_0-final.html>；核准公告 <https://openid.net/authorization-api-1-0-final-specification-approved/> |
| Shared Signals Framework 1.0 | <https://openid.net/specs/openid-sharedsignals-framework-1_0-final.html> |
| CAEP 1.0 | <https://openid.net/specs/openid-caep-1_0-final.html> |
| SCIM | <https://www.rfc-editor.org/rfc/rfc7643>、<https://www.rfc-editor.org/rfc/rfc7644>、<https://www.rfc-editor.org/rfc/rfc9865>、<https://www.rfc-editor.org/rfc/rfc9967> |
| CloudEvents 1.0.2 | <https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md>、同一標籤下的 `bindings/http-protocol-binding.md`、`formats/json-format.md`；sequence 擴充 <https://github.com/cloudevents/spec/blob/main/cloudevents/extensions/sequence.md> |
| Standard Webhooks 1.0.0 | <https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md> |
| OAuth 2.0 | <https://www.rfc-editor.org/rfc/rfc6749>（第 4.4、5.1、5.2 節）、<https://www.rfc-editor.org/rfc/rfc6750>、<https://www.rfc-editor.org/rfc/rfc9700> |
| OCSF 1.9.0 | <https://schema.ocsf.io/>（類別 `user_access`、`entity_management`；物件 `metadata`、`user`、`resource_details`、`managed_entity`、`actor`） |
| JOSE | <https://www.rfc-editor.org/rfc/rfc8037>、<https://www.rfc-editor.org/rfc/rfc9864> |
| RFC 3161 | <https://www.rfc-editor.org/rfc/rfc3161> |

## 附錄 C　尚待確認的設計點

| # | 設計點 | 目前的選擇 | 為什麼沒把握 |
|---|---|---|---|
| 1 | 請求沒有提到的限制面向怎麼判 | 由流程包決定；核心一律回傳完整的限制條件，要求使用方自行套用 | 使用方如果忽略回傳的限制，會放行超出核准範圍的存取。替代做法是提供嚴格模式（缺面向就拒絕），但 hook 只回布林，核心無法知道哪些面向沒被檢查 |
| 2 | 資料授權的資源粒度 | 例子用「欄位」當資源 | 一張單可能產生幾十筆權限項目，而且這是資料授權流程包契約的決定；若改成「主題包」當資源，多筆授權各涵蓋部分欄位時無法以單次判定合併 |
| 3 | 事件序號用 advisory lock 保證順序 | 所有會產生事件的交易排隊 | 核心的稽核鏈如果也有自己的鎖，兩把鎖的取得順序必須固定，否則可能死結；尖峰時（例如批次核准續期）的等待時間需要實測 |
| 4 | 每次判定都寫速率計數與呼叫紀錄 | 兩筆寫入；紀錄表不分割，逾期以刪除清理 | 判定量很大時（執行系統每次查詢都問），紀錄表的成長與刪除成本可能需要改成按月分割 |
| 5 | 複查決定為縮小、以及對生效中授權的任何修改 | 依賴核心提供縮小的入口 | 骨幹只定義了簽核過程中的縮小，沒有定義生效之後的縮小；核心如果不提供，這個決定實際上等於「限期重新申請，否則撤銷」 |
