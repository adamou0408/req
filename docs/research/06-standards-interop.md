# 06 互通標準與防竄改技術

調查日期：2026-11-19。對象：稽核級簽核平台的對外整合介面（[contract/00-spine.md](../contract/00-spine.md) 第 11 節的 `check`、`grants`、`events`、對帳、複查、證據輸出）。

閱讀方式：

- 句尾有來源編號 `[n]` 的是**來源直接寫的事實**；引號內是原文。
- 以「**推論：**」開頭的是我根據事實做的判斷，不是來源的說法。
- 以「**查不到：**」開頭的是找過但沒有可靠來源的事項，集中列在第 4 節。
- 標示「（搜尋摘要）」的事實只在搜尋結果摘要看到，沒有打開原文逐字核對，引用前要再確認。
- 表格中標題寫「（推論）」的欄位，以及「適合度」「理由」「風險與緩解」欄，是我的判斷。

---

## 1. 重點結論

1. OpenID AuthZEN **Authorization API 1.0 已於 2026-01-12 成為 Final Specification**，定義「執行點問、判定點答」的 `subject／action／resource／context → decision` 介面，是候選標準中最貼近 spine 第 11 節 `check` 的已定稿協定 [1][2]。
2. OPA、Cedar、OpenFGA 是判定引擎或政策語言，各自的 API 互不相容；它們之間的共同對外介面正是 AuthZEN（OpenFGA、Keycloak 目前是實驗性支援）[9][10][13][15]。
3. Shared Signals Framework 1.0、CAEP 1.0、RISC 1.0 已於 2025-09 定稿，但 CAEP 的 8 種事件**沒有「授權或權限變更」專用事件**，而且 Okta 發送方與 SailPoint 接收方都只支援 session-revoked 與 credential-change 兩種 [20][22][24][27]。
4. SSF 的輪詢傳遞在接收方確認後，發送方就「released from any obligation to retain the SET」，所以**它不是可重播的事件串流**；spine 要求的重播能力必須自己提供 [29]。
5. SCIM 2.0 的 `entitlements`、`roles` 屬性「No vocabulary or syntax is specified」，沒有期限與核准依據欄位，擴充草案也只是唯讀目錄；它不適合當授權的正式表達，只適合當往下游佈建群組或角色的選配通道 [35][38]。
6. 機器對機器驗證的現行最佳實務是 OAuth 2.0 client credentials 加上非對稱的 client 驗證（mTLS 或簽章 JWT）；OWASP 明文寫不可只靠 API key 保護高價值資源 [39][40][44]。
7. 查到的稽核與法規框架**都沒有指定「雜湊鏈」這項技術**；它們要求的是結果：限制修改、另存到難以修改的位置、變更會被偵測並告警、保留期限、可匯出 [58][59][60]。
8. 只放在資料庫內的雜湊鏈擋不住資料表擁有者或 superuser（可以停用 trigger、繞過 RLS）；Microsoft 的 ledger 文件明講摘要必須存到資料庫外的防竄改儲存，否則攻擊者可以整條重算 [54][56][57]。
9. 現成防竄改方案都有供應風險：Amazon QLDB 已於 2025-07-31 終止、Trillian 進入維護模式、immudb 授權改為 BSL 1.1、Rekor v2 只收軟體簽章用的兩種項目 [49][51][52][53]。
10. 定期複查與對帳**查不到跨廠商的標準 API**；Microsoft、SailPoint、Okta 都是「活動 → 項目 → 決定 → 套用」的專屬 REST API，法規推力來自 PCI DSS 7.2.4（至少每六個月複查一次）等條文 [58][69][70][71][73]。

---

## 2. 詳細內容

### 2.1 授權判定的標準

#### 2.1.1 OpenID AuthZEN Authorization API 1.0

| 項目 | 內容 | 來源 |
|---|---|---|
| 版本與狀態 | Authorization API 1.0，Final，Standards Track；文件日期 2026-01-11，2026-01-12 公告核准。Final Specification「not subject to further revision」，並給實作者智慧財產權保護 | [1][2] |
| 表決 | 贊成 81、反對 1、棄權 25；378 個會員中 107 票（28.3%，門檻 20%） | [2] |
| 編者 | O. Gazitt（Aserto）、D. Brossard（Axiomatics）、A. Tulshibagwale（SGNL） | [1] |
| 前身 | 第一版 Implementer's Draft 於 2024-11 核准 | [3] |
| 範圍 | 只定義執行點（PEP）與判定點（PDP）之間的介面：「The standard defines only the interface between a Policy Enforcement Point (PEP) and a Policy Decision Point (PDP)」 | [7] |

端點與格式（章節編號為規格原文）：

| API | 預設路徑 | 請求 | 回應 | 章節 |
|---|---|---|---|---|
| Access Evaluation | `/access/v1/evaluation` | `subject`、`action`、`resource` 必填，`context` 選填 | `decision`（boolean，必填）＋ `context`（選填） | §6、§10.1 [1] |
| Access Evaluations（批次） | `/access/v1/evaluations` | `evaluations` 陣列，可在最上層給預設的 subject／action／resource／context；`options.evaluations_semantic` 可為 `execute_all`（預設）、`deny_on_first_deny`、`permit_on_first_permit` | 每筆一個 decision；單筆錯誤寫在該筆的 `context` | §7 [1] |
| Subject Search | `/access/v1/search/subject` | 省略 subject 的 `id` | `results` 陣列，選填 `page`、`context` | §8.4 [1] |
| Resource Search | `/access/v1/search/resource` | 省略 resource 的 `id` | 同上 | §8.5 [1] |
| Action Search | `/access/v1/search/action` | 省略 action | 同上 | §8.6 [1] |
| Metadata | `/.well-known/authzen-configuration` | GET | 列出各端點的 URL；可用簽章 JWT | §9 [1] |

資料模型與行為：

- Subject 與 Resource 需要 `type` 與 `id`，`properties` 選填；Action 需要 `name`；Context 是自由格式物件（§5.1–§5.4）[1]。
- 規格的範例請求：subject `{"type":"user","id":"alice@example.com"}`、resource `{"type":"account","id":"123"}`、action `{"name":"can_read"}`、context 帶時間（§6.1.1）[1]。
- 拒絕不是 HTTP 錯誤：回 200 加 `decision: false`。400／401／403／500 才是錯誤（§10.1.2）[1]。
- 回應的 `context`「can convey additional information that can be used by the PEP as part of the decision enforcement process」，規格列的例子包含決定的理由、Advices、Obligations、畫面提示、升級驗證指示（§5.5）[1]。
- Resource Search「returns all resources of a given type that are permitted according to the provided Action」；搜尋結果拿去做 Access Evaluation「SHOULD result in a decision true」但不保證（§8.1、§8.5）。分頁用不透明的 `next_token`（§8.2）[1]。
- `X-Request-ID` 為選用；PEP 送了，PDP 必須原值回傳（§10.1.3）[1]。
- 安全：連線必須保護（例如 TLS，§11.1）；§2 說 API 本身的驗證不在規格範圍，但 RECOMMENDED 用 OAuth 2.0；§11.2 說 PDP SHOULD 驗證呼叫方，列出 mutual TLS、OAuth、API key 三種、不在其中指定；模型假設 PDP 信任 PEP：「The architecture of this model assumes the PDP must trust the PEP」（§11.4）[1]。
- 判定結果簽章：§11.6「The PDP MAY choose to sign its authorization response」，並說明 TLS 在有代理或閘道的路徑上無法保證端到端完整性、簽章可提供不可否認性；但規格**沒有**定義簽章格式 [1]。（查證更正：原文寫「只有 metadata 可簽章」，與 §11.6 不符。）
- 規格**沒有**定義判定結果的有效時間或快取規則；唯一的快取指引是 metadata（§11.9）[1]。

誰已支援：

| 實作 | 狀態 | 來源 |
|---|---|---|
| 2024-05 互通測試通過者 | 3Edges、Aserto、Axiomatics、Cerbos、Permit.io、Rock Solid Knowledge、SGNL、Strata Identity、Thales，共 9 家 | [8] |
| 2025-12 Gartner IAM Summit 展示 | 判定平台：Axiomatics、EmpowerID、Cerbos、SGNL、WSO2、Topaz；身分提供者：EmpowerID、Gluu、Curity、Thales。文中另稱互通計畫還有 9 個判定點與 9 個身分提供者（未列名） | [6] |
| OpenFGA | 實驗性，要用 `--experimentals=authzen` 開啟；支援 evaluation、evaluations、三種 search 與 metadata，路徑都掛在 store 底下（`/stores/{store_id}/access/v1/...`、`/.well-known/authzen-configuration/{store_id}`），不是規格的預設路徑。限制：不支援分頁（`page` 收下但忽略）、成功回應不填 `context`、回應有 `X-Request-ID` 但不回傳呼叫方送來的值、contextual tuples 沒有對應、不提供 `signed_metadata` | [9] |
| Keycloak | 26.7.0 起實驗性支援，作為 PDP 提供 Evaluation、Evaluations 與 metadata；呼叫方用 OAuth2 client credentials 取得 token（2026-05-20 公告） | [10] |
| OPA | 查不到官方支援聲明；只有社群外掛（opa-authzen-plugin），作者稱 OPA 社群傾向先做外掛、不進核心，批次端點仍在開發中（搜尋摘要，見第 4 節） | [84] |

工作組仍在發展的草案（都還不是定稿）[3]：

| 草案 | 日期 | 與本平台的關係 |
|---|---|---|
| **AuthZEN Access Request and Approval Profile（ARAP）Draft 1** | 2026-11-06 | 直接相關，見下 |
| AuthZEN Profile for Obligations Draft 1 | 2026-07-03 | 判定附帶「必須執行的指示」。定義為「A mandatory instruction, expressed as a JSON object, that a PDP returns to a PEP alongside an authorization decision」，放在 `context.obligations`；已定型別只有 `step-up`、`notification`、`session_termination`、`custom` [5] |
| COAZ Framework 1.0、COAZ-MCP Binding 1.0 | 工作組草案 | AI 代理呼叫工具前的授權，與本平台第一版無關 [3][7] |

ARAP 草案把「被拒絕 → 提出申請 → 等待核准 → 重新判定」標準化 [4]：

1. PEP 送 Access Evaluation。
2. PDP 回 `decision=false`，並在 `context.access_request` 告知可以申請（含 `endpoint`、`template`、`expires_at`）。
3. PEP 向 Access Request Service 送出申請（必填 `subject`、`resource`、`action`、`denial`；`denial` 內必填 `expires_at`，並須帶 `evaluation_id` 或 `binding_token` 其中之一；選填 `requested_access.requested_until`、`emergency`、`callback`）。
4. 服務回傳工作代號（`id`、`status`、`status_endpoint`）。狀態值：`pending`、`approved`、`denied`、`expired`、`cancelled`、`failed`；批次工作另有 `partial`（由 BULK 配套規格定義）；實作可自行增加狀態值。
5. PEP 輪詢或收回呼。
6. PEP 重新送 Access Evaluation。

草案的不變條件：摘要寫「a denied decision remains a denial and MUST NOT be treated as access」，§1.2「A requestable denial is still a denial.」，§7.2「Approval does not by itself grant access」；核准結果以 `result.mode: "reevaluate"`（基本規格唯一的模式）與 `approval` 表達，`approval` 必填 `id`、`approved_until`，`approved_at`、`state` 選填；PEP 重新判定時把它放在 `context.approval` [4]。

**推論：** ARAP 描述的 Access Request Service 就是本平台在做的事（收申請、跑簽核、產生有期限的核准）。它才發布 13 天、只有一位作者 [4]，查不到任何實作紀錄，現在不能依賴；但本平台的 `check` 拒絕回應與申請單狀態若一開始就留出對應欄位，之後接上的成本很低。

#### 2.1.2 XACML

| 項目 | 內容 | 來源 |
|---|---|---|
| 現行版本 | XACML 3.0 為 OASIS Standard（2013-01-22），Errata 01（2017-07-12）（搜尋摘要） | [12] |
| JSON／REST | JSON Profile of XACML 3.0 Version 1.1 為 OASIS Standard（2019-06-20）；媒體型別 `application/xacml+json` | [11] |
| 請求格式 | `Request` 物件，內含 AccessSubject、Action、Resource、Environment 等類別，每個類別是 Attribute 陣列（`AttributeId`、`Value`、選填 `DataType`） | [11] |
| 回應格式 | `Response` 是 Result 陣列；`Decision` 四個值：Permit、Deny、NotApplicable、Indeterminate；可附 Status、Obligations、AssociatedAdvice | [11] |
| 下一代 | 技術委員會改以「XACML Next Gen／ACAL」為名，計畫提供 JSON 與 YAML 表示法；XACML 4.0 XML 表示法的 Committee Specification Draft 01 日期為 2026-02-18（搜尋摘要） | [12] |

**推論：** XACML 是完整的「政策語言＋請求協定」，本平台只需要協定那一半；它的屬性類別模型比 AuthZEN 冗長，四值判定也超出 spine 的「允許或拒絕」。XACML 陣營的主要廠商 Axiomatics 是 AuthZEN 規格的共同編者 [1]，新整合往 AuthZEN 走的方向明確。

#### 2.1.3 OPA／Rego、AWS Cedar、OpenFGA／Zanzibar

| | OPA／Rego | AWS Cedar | OpenFGA／Zanzibar |
|---|---|---|---|
| 性質 | 通用政策引擎＋ Rego 語言 [13] | 政策語言＋ SDK；Amazon Verified Permissions 以它為基礎 [16] | 仿 Zanzibar、以關係為基礎的授權系統 [9][18] |
| 治理 | CNCF Graduated（2021-01-29）（搜尋摘要）[14] | CNCF Sandbox（2026-01 報導）；採用者有 Cloudflare、MongoDB、StrongDM、Cloudinary（次級來源）[16] | CNCF Incubating（2025-10-28 生效，2025-11-11 公告）（搜尋摘要）[18] |
| 判定 API | `POST /v1/data/{path}`，請求 `{"input": …}`，回應 `{"result": …}`；輸入與輸出的形狀由政策決定，沒有固定結構 [13] | `IsAuthorized`：`principal`、`action`、`resource`、`context`、`entities`、`policyStoreId` → `decision`（`ALLOW`／`DENY`）、`determiningPolicies`、`errors`；範例用 AWS SigV4 簽章 [15] | 原生 Check、BatchCheck、ListObjects、ListUsers；AuthZEN 端點對應到這些 [9] |
| 判定紀錄 | 開啟 decision logging 時回應帶 `decision_id`，並出現在決策紀錄事件 [13] | 回應列出決定性的政策 [15] | 文件未述 |
| 規模參考 | — | — | Zanzibar 論文（USENIX ATC 2019）：「scales to trillions of access control lists and millions of authorization requests per second」、第 95 百分位延遲低於 10 毫秒 [17] |

**推論（共同點）：** 這三者解決的是「政策或關係怎麼寫、怎麼算」。本平台的判定依據不是政策，而是「有效的已核准授權」加上流程包的 `evaluate_constraints`，資料量是一家公司的授權筆數，用 PostgreSQL 查詢就能回答。把任何一個引擎嵌進核心，等於多一個要維運的元件與第二份真相，違反工程規範的單一真相來源。

#### 2.1.4 比較與選擇

| 準則 | AuthZEN 1.0 | XACML 3.0 JSON Profile | OPA Data API | Cedar／AVP | OpenFGA 原生 API |
|---|---|---|---|---|---|
| 是與廠商無關的線上協定 | 是 [1] | 是 [11] | 否，形狀由政策決定 [13] | 否，AWS 專屬 [15] | 否，產品專屬 [9] |
| 標準狀態 | OpenID Final（2026-01）[2] | OASIS Standard（2019）[11] | 無 | 無 | 無 |
| 請求模型與 spine `check` 的對應 | 直接對應：主體、資源、動作、情境 [1] | 要包成屬性類別 [11] | 自訂 | 接近，但綁 policy store [15] | 要轉成關係三元組 |
| 回應可帶依據（授權、申請單） | 可，放 `context` [1] | 可，放 Advice／Obligations [11] | 自訂 | 只有政策代號 [15] | 不填 `context` [9] |
| 批次判定 | 有 [1] | 本次未查 | 自訂 | 本次未查 | 有 BatchCheck [9] |
| 「列出某人能用什麼」 | Search API [1] | 無對應 | 自訂 | 無對應 | ListObjects／ListUsers [9] |
| 已有多家獨立實作互通 | 是，多家判定點與身分提供者參與互通展示 [6][8] | 僅 XACML 產品 | OPA 生態 | AWS 生態 | OpenFGA SDK |

**推論（結論）：** `check` 採用 AuthZEN Authorization API 1.0；`grants` 的「列出」需求用 AuthZEN Search API 涵蓋一部分，其餘（授權的限制條件、有效期間、申請單連結）用平台自己的 REST 資源補足。理由：

1. 它是唯一把「問一個是非題」獨立成協定、又已定稿的標準，其他系統不必為本平台寫專屬程式（spine 第 11 節的規定）。
2. 主體、資源、動作、情境四個欄位與 `describe_entitlements`、`evaluate_constraints(p_constraints, p_context)` 的結構一對一。
3. 回應的 `context` 可以放「依據的授權與申請單」，滿足 spine 對 `check` 的要求，不違反規格。

**推論（要自己補的缺口）：**

- 規格假設 PDP 信任 PEP（§11.4），主體是呼叫方宣稱的。`check` 會洩漏「誰對什麼有權限」，所以每個 `api_client` 可詢問的資源型別要用範圍限制。
- 規格沒有判定的有效時間。回應要在 `context` 帶授權到期時間，並明講「撤銷靠事件通知，不靠快取過期」。
- 其他系統把 `check` 放在自己的存取路徑上，本平台停機就等於它們停機。文件要規定呼叫方連不上時一律視為拒絕，並提供事件串流讓它們可以改成本地快取。

### 2.2 持續把關的標準

#### 2.2.1 Shared Signals Framework、CAEP、RISC

| 規格 | 版本與狀態 | 內容 | 來源 |
|---|---|---|---|
| OpenID Shared Signals Framework（SSF） | 1.0 Final，文件日期 2025-08-29；工作組頁面記載「Three Shared Signals Final Specifications Approved」為 2025-09-02 [75]，2025-09-16 新聞稿公告 | 事件的包裝、串流管理 API、傳遞方式、發送方 metadata | [19][22][23] |
| OpenID Continuous Access Evaluation Profile（CAEP） | 1.0 Final，2025-08-29 | 工作階段與存取層級的 8 種事件 | [20] |
| OpenID RISC Profile | 1.0 Final，2025-08-29 | 帳號層級的風險事件 | [21] |
| CAEP Interoperability Profile | 1.0 Implementer's Draft | 互通測試用的最小子集 | [23] |

SSF 的機制 [19]：

- 事件是 Security Event Token（SET，RFC 8417）：一種 JWT，必須帶 `iss`、`iat`、`jti`，事件放在以 URI 為鍵的 `events` [28]。SSF 另規定 `typ` 為 `secevent+jwt`、不得有 `sub` 與 `exp`、主體放 `sub_id`、簽章金鑰由 `jwks_uri` 取得（§4.1）。
- 主體可以是複合的（`"format": "complex"`），成員有 `user`、`device`、`session`、`application`、`tenant`、`org_unit`、`group`（§3.3）。
- 發送方 metadata 在 `/.well-known/ssf-configuration`（§7.2）。
- 傳遞方式兩種：推送 `urn:ietf:rfc:8935`、輪詢 `urn:ietf:rfc:8936`（§6.1）。
- 串流管理 API：建立、讀取、更新、刪除串流；讀寫狀態（`enabled`／`paused`／`disabled`）；加入或移除主體；觸發驗證事件（§8）。管理端點「MUST use standard HTTP authentication and authorization schemes」。
- 暫停時發送方 SHOULD 保留事件、MAY 丟棄；停用時不保留（§8.1.2.1）。
- RFC 8417 §1：「Security events are not commands issued between parties.」事件是事實陳述，接收方自己決定怎麼反應 [28]。

事件類型：

| 規格 | 事件（URI 前綴省略） | 來源 |
|---|---|---|
| CAEP（8 種） | `session-revoked`、`token-claims-change`、`credential-change`、`assurance-level-change`、`device-compliance-change`、`session-established`、`session-presented`、`risk-level-change`；共用選填欄位 `event_timestamp`、`initiating_entity`（`admin`／`user`／`policy`／`system`）、`reason_admin`、`reason_user` | [20] |
| RISC（14 種） | `account-credential-change-required`、`account-purged`、`account-disabled`、`account-enabled`、`identifier-changed`、`identifier-recycled`、`credential-compromise`、`opt-in`、三種 opt-out、`recovery-activated`、`recovery-information-changed`、`sessions-revoked`（已淘汰，改用 CAEP 的 session-revoked） | [21] |
| SSF 本身 | `verification`、`stream-updated` | [19] |

CAEP **沒有**授權、權限或角色變更的專用事件；最接近的是 `token-claims-change`：「Token Claims Change signals that a claim in a token, identified by the subject claim, has changed」，其範例用了 `role` claim，但規格沒有定義角色或權限的語意 [20]。

誰已支援：

| 產品 | 角色 | 支援的事件 | 來源 |
|---|---|---|---|
| Okta | 發送方 | 只有 CAEP Session Revoked 與 Credential Change 兩種；文件連到的是 SSF 1.0 ID3、CAEP 1.0 ID2 草案 | [24] |
| Okta | 接收方 | Identity Threat Protection 可接收第三方事件；支援清單未查到 | [24] |
| SailPoint | 接收方 | CAEP Session Revoked 與 Credential Change（2026-04-08 公告） | [27] |
| Google | 發送方（Cross-Account Protection） | RISC 的 `sessions-revoked`、`account-disabled`、`account-enabled`、`account-credential-change-required`，加上 OAuth 的 `tokens-revoked`、`token-revoked`；只有推送。文件警告「if your receiver is down for an extended period of time you may permanently miss some events」 | [26] |
| Apple | 接收方 | Apple Business 與自訂身分提供者做聯合驗證時，要求提供 SSF 設定網址，並授與 `ssf.manage`、`ssf.read`（頁面日期 2026-04-14） | [25] |
| 新聞稿點名 | — | 「Apple, IBM, Okta, and others, have already adopted these protocols」 | [22] |

RFC 8936（輪詢）§2.2：「Once a SET has been acknowledged, the SET Transmitter is released from any obligation to retain the SET.」未確認的事件可以重送，但保留多久由部署決定，也可以在長期無人輪詢時丟棄 [29]。

**推論：**

- SSF 提供的是「簽章事件的包裝＋串流管理」，可以承載本平台自訂的事件 URI（SET 的 `events` 以 URI 為鍵，任何規範都能定義自己的事件）。但只懂 CAEP 的接收方會忽略不認得的事件。
- 本平台的核心事件是「授權生效、變更、到期、撤銷」。CAEP 沒有對應事件，硬套 `session-revoked` 語意不對：平台不擁有工作階段。能合理對應的只有「撤銷時，通知身分提供者或閘道去終止相關工作階段」這一種情境。
- spine 要求「推送與可重播的事件串流並存」。SSF 兩種傳遞方式都不是可重播的；可重播要用平台自己的游標式事件端點。

#### 2.2.2 與 webhook、CloudEvents、Standard Webhooks 的關係

這四者解決的層次不同：

| 層次 | SSF／SET | Standard Webhooks | CloudEvents | 一般 webhook |
|---|---|---|---|---|
| 事件包裝 | JWT，`events` 以 URI 為鍵 [28] | 建議 `type`、`timestamp`、`data` 三個欄位 [31] | 必填 `id`、`source`、`specversion`、`type`；選填 `time`、`subject`、`datacontenttype`、`dataschema` [33] | 各家自訂 |
| 簽章 | JWS，公鑰由 `jwks_uri` 發布 [19] | 標頭 `webhook-id`、`webhook-timestamp`、`webhook-signature`；`v1` 為 HMAC-SHA256，簽 `msg_id.timestamp.payload`；非對稱用 ed25519（`v2a`，簽章內容前面多加端點代號；舊的 `v1a` 已標為淘汰，「Producers should send `v2a` instead」） [31] | 核心規格不定義簽章 [33] | 各家自訂 |
| 重放防護 | `jti` 唯一 [28] | 驗證時間戳在容許範圍內「to prevent replay attacks」（規格未給具體秒數）；「Use the `webhook-id` header as an idempotency key」 [31] | 「Producers MUST ensure that `source` + `id` is unique for each distinct event」 [33] | 各家自訂 |
| 重試 | 規格未定 | 建議數天的指數退避；範例排程 5 秒、5 分、30 分、2 小時…到 24 小時；收到 `410 Gone` 停用端點 [31] | 不在範圍 | 各家自訂 |
| 訂閱管理 | 有標準 API [19] | 無 | 無 | 各家自訂 |
| 治理 | OpenID Foundation Final [22] | 社群專案；技術指導委員會成員來自 Zapier、Twilio、Lob、Mux、ngrok、Supabase、Svix、Kong [32] | CNCF Graduated（2024-01-25）[34] | — |
| 完整或精簡內容 | 未規定 | 討論兩者，指出「you can always make a thin one full, but not the other way around」 [31] | 未規定 | — |

另有 RFC 9967（SCIM Profile for Security Event Tokens，2026-05，Proposed Standard）：用 SET 表達 SCIM 資源的建立、修改、刪除、啟用、停用（`urn:ietf:params:scim:event:prov:patch:{notice|full}` 等），同樣走 RFC 8935／8936 [30]。

**推論：**

- 接收端最容易實作的是「HTTP POST ＋ HMAC 標頭」。Standard Webhooks 的三個標頭與簽章算法是現成的慣例，風險是它是社群規格而不是標準組織的標準。
- CloudEvents 只是欄位命名。事件內容採用它的 `id`、`source`、`type`、`time`、`subject` 幾乎沒有成本，換來與事件匯流排、SIEM 管線的相容。
- SSF 發送方適合放在第二階段：先用它服務「已經會收 SSF 的身分提供者與閘道」，事件用 CAEP 能對應的部分加上平台自訂 URI。

### 2.3 帳號與權限的佈建：SCIM 2.0

| 項目 | 內容 | 來源 |
|---|---|---|
| 核心 | RFC 7643（結構）、RFC 7644（協定） | [35][36] |
| `entitlements` | 「A list of entitlements for the user that represent a thing the user has.」「No vocabulary or syntax is specified」（RFC 7643 §4.1.2） | [35] |
| `roles` | 「No vocabulary or syntax is specified, although it is expected that a role value is a String or label representing a collection of entitlements」（§4.1.2） | [35] |
| `groups` | 在 User 上是唯讀；成員異動「MUST be applied via the "Group" Resource」（§4.1.2、§4.2） | [35] |
| 修改方式 | PATCH（§3.5.2，選用）、Bulk（§3.7，選用） | [36] |
| 變更通知 | 協定本身沒有；只能用 `meta.lastModified` 過濾。分頁無狀態：「clients MUST be prepared to handle inconsistent results」；被刪除的資源直接從查詢結果消失 | [36] |
| 驗證 | Bearer token「MAY be used」，但「This is not intended to imply that bearer tokens are preferred」；不建議 Basic | [36] |
| 擴充：游標分頁 | RFC 9865（2025-10，Proposed Standard） | [37] |
| 擴充：事件 | RFC 9967（2026-05，Proposed Standard），見 2.2.2 | [30] |
| 擴充：角色與權限目錄 | `draft-ietf-scim-roles-entitlements-01`（2025-10-16，2026-04-19 到期）：新增 `/Roles`、`/Entitlements` 兩種資源，所有屬性唯讀，只供探索；指派仍用 RFC 7643 的既有屬性；沒有期限、核准、理由欄位 | [38] |

**推論：SCIM 適不適合把核准的授權送給其他系統？**

| 需求 | SCIM 能否表達 |
|---|---|
| 把某人加入某群組或角色 | 能（Group 的 `members`、User 的 `roles`） |
| 授權的有效期間 | 不能，沒有欄位 |
| 依據哪張申請單、誰核准 | 不能，沒有欄位 |
| 欄位、列條件、資料期間等限制條件 | 不能；`entitlements` 是無語法的字串 |
| 到期自動失效 | 不能；要由送出方在到期時再送一次移除 |
| 目標系統回報實際狀態 | 只能由送出方來查（GET），沒有變更通知，刪除無痕跡 |

所以 SCIM 不能當授權的正式表達，本平台的 `grants` 必須有自己的結構。SCIM 的合理定位是**選配的對外連接器**：某個流程包核准的結果剛好等於「把人加進群組」時，用 SCIM PATCH 送給支援 SCIM 的目標系統，並在到期或撤銷時送移除。這屬於流程包「怎麼交付」的範圍，不是核心介面。本平台自己當 SCIM 服務端（讓身分提供者把人員推進來）在第一版沒有必要：人員來源已定為 LDAP（spine 第 12 節）。

### 2.4 登入與機器身分

| 技術 | 狀態 | 重點 | 來源 |
|---|---|---|---|
| OpenID Connect | Core 1.0 於 2024 年以 ISO/IEC 26131:2024 發布，共 9 份 OIDC 規格成為 ISO/IEC 標準（搜尋摘要） | 人員登入；spine 第 12 節已採用 | [45] |
| OAuth 2.0 client credentials | RFC 6749 §4.4（2012-10） | 「The client can request an access token using only its client credentials.」；回應「A refresh token SHOULD NOT be included.」 | [39] |
| OAuth 2.0 安全最佳實務 | RFC 9700／BCP 240（2025-01） | §2.5「It is RECOMMENDED to use asymmetric cryptography for client authentication」（mTLS 或簽章 JWT）；§2.2.1 資源伺服器 SHOULD 使用 sender-constrained token（mTLS 或 DPoP）；§2.3「access tokens SHOULD be audience-restricted to a specific resource server」，權限 SHOULD 限制到最小 | [40] |
| mTLS for OAuth | RFC 8705（2020-02） | 兩種 client 驗證：`tls_client_auth`（驗憑證鏈）、`self_signed_tls_client_auth`（比對登記的憑證）；token 可綁定憑證（`cnf` 的 `x5t#S256`） | [41] |
| SPIFFE | CNCF Graduated（2022-08-23） | 身分是 `spiffe://<trust domain>/<workload>`；憑證（X.509-SVID 或 JWT-SVID）短效並自動輪替；「your application need not co-deploy any authentication secrets with the workload」；建議優先用 X.509-SVID | [42][43] |
| API key | 無標準 | OWASP：「Require API keys for every request to the protected endpoint.」「Do not rely exclusively on API keys to protect sensitive, critical or high-value resources.」 | [44] |
| 應用程式帳號的管理 | PCI DSS v4.0.1 | 7.2.5：應用程式與系統帳號依最小權限指派；7.2.5.1：定期複查；8.6.3：密碼定期更換，並在懷疑或確認外洩時更換 | [58] |
| AuthZEN 的要求 | Authorization API 1.0 §11.2 | PDP 應驗證 PEP；列出 mTLS、OAuth、API key，建議 OAuth 2.0 | [1] |

**推論：**

- spine 寫「呼叫方是登記過的系統（`api_client`），有各自的金鑰與可用範圍」。「金鑰」應落實為 OAuth 2.0 client credentials：`api_client` 向平台的 token 端點換短效 access token，token 帶範圍與對象。這也是 Keycloak 的 AuthZEN 實作採用的方式 [10]，並且讓 `sim/` 的 OIDC 身分提供者可以直接當授權伺服器。
- client 驗證第一版至少支援 client secret，並支援簽章 JWT 或 mTLS 作為較高保證等級；長期有效的靜態 API key 只當過渡選項，要有雜湊儲存、到期日、輪替與範圍限制。
- SPIFFE 的 X.509-SVID 就是 X.509 憑證。平台支援 RFC 8705 的 mTLS 就能接受它，不需要另外為 SPIFFE 做事。
- `api_client` 本身是 PCI DSS 7.2.5.1 所說的應用程式帳號，應納入平台自己的定期複查。

### 2.5 防竄改紀錄

#### 2.5.1 技術

| 技術 | 能證明什麼 | 限制 | 來源 |
|---|---|---|---|
| 雜湊鏈 | 每筆含前一筆的雜湊，改任何一筆會讓後面全部對不上 | 稽核是線性的：以雜湊鏈為基礎的紀錄「require auditors examine every intermediate event between snapshots」；8,000 萬筆的鏈要證明一筆存在需要約 800 MB | [48] |
| Merkle tree／歷史樹 | 包含證明（某筆在紀錄裡）與一致性證明（新狀態延續舊狀態），大小為對數；同一例子只要 3 KB | 實作較複雜 | [46][48] |
| Certificate Transparency 式透明日誌 | RFC 9162（CT 2.0，2021-12，Experimental，取代 RFC 6962）：「Merkle consistency proofs prove the append-only property of the tree.」；樹頭由日誌簽章（Signed Tree Head，§4.10） | 日誌仍可對不同人給出不同版本，需要第三方交叉比對 | [46] |
| RFC 3161 時間戳記 | 可信第三方（TSA）證明某資料在某時間已存在；請求只送雜湊（`messageImprint`「SHOULD contain the hash of the datum to be time-stamped」），內容不外流 | 依賴 TSA 的可信度與憑證有效期 | [47] |
| 外部錨定 | 把鏈頭或樹根定期寫到平台管理者改不到的地方 | 兩次錨定之間的竄改只能在下一次錨定前重算；錨定頻率決定風險視窗（推論） | [54] |
| WORM 儲存 | 寫入後在保留期內無法改寫或刪除 | 只保護已寫出的副本 | [55] |

Crosby 與 Wallach（USENIX Security 2009）對防竄改紀錄的定義是：不受信任的記錄者「kept honest by a number of auditors who will challenge the logger to prove its correct behavior」，並且「must regularly prove its correct behavior to auditors and clients」[48]。**推論：** 沒有人定期驗證的雜湊鏈，等於沒有防護。

法律效力的參考：eIDAS 第 41 條第 2 項規定合格電子時間戳記「shall enjoy the presumption of the accuracy of the date and the time it indicates and the integrity of the data to which the date and time are bound」（搜尋摘要；歐盟法規，對台灣不直接適用）[62]。

#### 2.5.2 現成方案

| 方案 | 現況 | 適合度（推論） | 來源 |
|---|---|---|---|
| Amazon QLDB | 2025-07-31 終止支援；AWS 建議遷移到 Aurora PostgreSQL，稽核功能以 pgAudit 等延伸套件取代（搜尋摘要） | 已不可用；是「把證據綁在單一代管服務」的反例 | [53] |
| Trillian（Google） | 「Trillian is in maintenance mode.」「We recommend that any new log operators first try Tessera.」需要 log server、log signer 與 MySQL／MariaDB | 不建議新採用 | [49] |
| Tessera | Go 函式庫，用來建立 tile 形式的透明日誌；自 Beta（v0.2.0）起稱可用於正式環境；儲存驅動為 GCP、AWS、POSIX；支援見證人（witness）協定；Apache 2.0 | 要另寫一個 Go 服務，並與 PostgreSQL 的交易分離；第一版過重 | [50] |
| Sigstore Rekor v2 | 2025-10-10 正式發布，後端改為 Tessera；只支援 `hashedrekord` 與 `dsse` 兩種項目，不存 attestation，不再回傳簽章時間戳記（要另找時間戳記機構） | 為軟體供應鏈設計的公開日誌，不是通用稽核紀錄庫 | [51] |
| immudb | 「immudb is licensed under the Business Source License 1.1.」；不可變的鍵值、文件、SQL 資料庫，帶 Merkle tree 與用戶端驗證，支援 PostgreSQL wire protocol 與 S3 儲存 | 是第二個資料庫；授權不是開源授權，採用前要法務確認 | [52] |
| SQL Server／Azure SQL ledger | 以 SHA-256 與 Merkle tree 串成區塊鏈；摘要可自動存到不可變的 Blob 儲存或 Azure Confidential Ledger | 只限 SQL Server 家族；設計值得借鏡 | [54] |
| 雲端不可變物件儲存（S3 Object Lock） | WORM 模型；compliance 模式下「a protected object version can't be overwritten or deleted by any user, including the root user in your AWS account」；governance 模式可由有特殊權限者繞過；經 Cohasset Associates 評估可用於受 SEC 17a-4、CFTC、FINRA 規範的環境 | 適合當外部錨定與證據包的存放處；地端可用相容 S3 Object Lock 的儲存（未逐一查證） | [55] |

#### 2.5.3 在 PostgreSQL 內自行實作

PostgreSQL 文件的相關事實：

- 「Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system when accessing a table. Table owners normally bypass row security as well」，但擁有者可用 `ALTER TABLE … FORCE ROW LEVEL SECURITY` 讓自己也受列安全限制 [56]。superuser 與 `BYPASSRLS` 角色則無法用此方式限制。（文件頁面的 current 已是 PostgreSQL 19，頁面公告 19 版於 2026-11-19 發布 [56]。）
- `ALTER TABLE … DISABLE TRIGGER`：「A disabled trigger is still known to the system, but is not executed when its triggering event occurs」；執行 `ALTER TABLE` 的條件是「You must own the table」[57]。
- trigger 是否觸發還受 `session_replication_role` 影響；設為 `ENABLE ALWAYS` 的 trigger 不受它影響 [57]。

Microsoft 的 ledger 文件把同樣的弱點講得很直接 [54]：

- 「an attacker or system administrator who has control of the machine can bypass all system checks and directly tamper with the data … Ledger can't prevent such attacks but guarantees that any tampering will be detected when the ledger data is verified.」
- 摘要必須放在資料庫外，因為能改摘要的攻擊者可以：竄改資料、重算雜湊、再改摘要讓它相符。

**推論：自行實作的優缺點**

| | 優點 | 缺點 |
|---|---|---|
| 交易一致性 | 稽核紀錄與業務異動在同一個交易，不會出現「事做了、紀錄沒寫」 | — |
| 維運 | 不增加元件；備份、還原、權限都沿用 PostgreSQL | 雜湊鏈寫入是序列化的，高併發時要設計（例如分鏈或批次封存） |
| 防護範圍 | 擋住應用程式層與一般資料庫角色 | 擋不住擁有者與 superuser；單靠資料庫內的鏈只能偵測「不重算的竄改」 |
| 驗證成本 | 簡單，稽核人員看得懂 | 線性；資料量大時要加檢查點（定期的 Merkle 根或鏈頭快照）[48] |
| 可攜性 | 證據跟著資料庫走，不綁雲端服務（對照 QLDB [53]） | 外部錨定與驗證工具要自己寫 |

**推論（建議做法）：** 維持 vision 文件既定的「PostgreSQL 內只增不改＋雜湊鏈」，並補上三件事，缺一不可：

1. **外部錨定**：定期把鏈頭（序號、雜湊、時間）寫到平台資料庫管理者無法修改的地方。至少一種：WORM 物件儲存；可加 RFC 3161 時間戳記；可同時寄送或推送給稽核單位保存。
2. **獨立驗證**：提供不依賴平台程式的驗證工具與公開的演算法說明，稽核人員拿匯出檔與錨定值就能自己重算。
3. **偵測與告警**：排程定期驗證整條鏈與錨定值，不符就告警（對應 PCI DSS 10.3.4、NIST AU-9 b）。

#### 2.5.4 稽核人員實際接受什麼

來源直接寫的要求：

| 框架 | 條文 | 原文重點 |
|---|---|---|
| PCI DSS v4.0.1（2024-06；截至 2026-11 仍是現行版本，PCI SSC 於 2026-06-03 至 07-20 對 v4.0.1 開放意見徵詢，作為下一版的依據，尚未公布新版日期（搜尋摘要）[80]）[58] | 10.3.1 | 「Read access to audit logs files is limited to those with a job-related need.」 |
| | 10.3.2 | 「Audit log files are protected to prevent modifications by individuals.」測試程序：以存取控制、實體隔離或網路隔離保護 |
| | 10.3.3 | 「…promptly backed up to a secure, central, internal log server(s) or other media that is difficult to modify.」 |
| | 10.3.4 | 「File integrity monitoring or change-detection mechanisms is used on audit logs to ensure that existing log data cannot be changed without generating alerts.」 |
| | 10.5.1 | 「Retain audit log history for at least 12 months, with at least the most recent three months immediately available for analysis.」 |
| | 10.2.2 | 每筆紀錄含使用者識別、事件類型、日期時間、成功或失敗、事件來源、受影響的資料或資源 |
| | 10.6.1 | 「System clocks and time are synchronized using time-synchronization technology.」 |
| NIST SP 800-53 Rev. 5 [59] | AU-9 | 「Protect audit information and audit logging tools from unauthorized access, modification, and deletion」，並在偵測到時告警 |
| | AU-9(1) | 「Write audit trails to hardware-enforced, write-once media.」 |
| | AU-9(2) | 稽核紀錄存到「a physically different system or system component than the system or component being audited」 |
| | AU-9(3) | 「Implement cryptographic mechanisms to protect the integrity of audit information and audit tools.」 |
| | AU-9(4) | 稽核功能的管理權只給特權使用者中的一部分人 |
| | AU-10 | 「Provide irrefutable evidence that an individual (or process acting on behalf of an individual) has performed」指定的動作；說明中舉例「approving a procurement request」 |
| | AU-3 | 紀錄要能確立事件類型、時間、地點、來源、結果、相關主體 |
| SEC Rule 17a-4(f)（2022 修正，2023-01-03 生效，2023-05-03 起適用）[60] | (f)(2)(i)(A) | 電子紀錄可用稽核軌跡方式保存：「complete time-stamped audit trail that includes」所有修改與刪除、建立／修改／刪除的日期時間、行為人身分、足以重建原始紀錄的資訊 |
| | (f)(2)(i)(B) | 或者「exclusively in a non-rewriteable, non-erasable format」（WORM） |
| | (f)(2)(iv) | 「Have the capacity to readily download and transfer copies of a record and its audit trail」，須同時提供人可讀格式與合理可用的電子格式 |
| PCAOB AS 1105 修正（適用於 2025-12-15 以後開始的會計年度）[61] | 新增 .10A | 查核人員評估公司以電子形式提供的外部資訊是否可靠時，要了解資訊來源與公司接收、保存、處理的流程，並且「testing the information to determine whether it has been modified by the company」或測試相關控制；必要時包含資訊科技一般控制與自動化應用控制 |

台灣在地參考（查證時補充）：

| 來源 | 條文 | 內容 |
|---|---|---|
| 電子簽章法（2024-05-15 修正；第 22 條「本法自公布日施行」）[81] | 第 4 條 | 「電子文件及電子簽章，符合本法規定者，在功能上等同於實體文件及簽章，不得僅因其電子形式而否認其法律效力。」 |
| | 第 2 條第 3 款 | 數位簽章「屬於電子簽章之一種」，以簽署人私密金鑰加密、可用公開金鑰驗證，「並具憑證機構簽發之憑證者」 |
| | 第 6 條 | 以數位簽章簽署、憑證由主管機關核定或許可的憑證機構簽發且在有效期間與使用範圍內者，「推定為本人親自簽名或蓋章」 |
| 上市上櫃公司資通安全管控指引（證交所；2024-09 修正對照表）（搜尋摘要）[82] | 第 23 條 | 建立監控措施，含身分驗證存取紀錄、重要資料異動、管理者行為等，「並針對日誌建立適當之保護機制」；查不到指引中存取權限覆核頻率或日誌保存年限的條文 |

**推論（台灣）：** 平台內的簽核（帳密＋MFA）屬於電子簽章法的「電子簽章」，有第 4 條的不得否認效力，但**不是**第 6 條有推定效力的「數位簽章」（需憑證機構簽發的憑證）。若客戶要求簽核具推定本人簽名的效力，要另外支援以憑證（例如工商憑證、自然人憑證）簽署，這不在本文件的互通標準範圍，建議交由法規調查文件確認是否需要。

**推論：**

- 沒有一個框架點名雜湊鏈、Merkle tree 或區塊鏈。稽核人員驗的是：誰能改（權限與職責分離）、改了會不會被發現（變更偵測與告警）、有沒有另一份放在改不到的地方（集中備份或 WORM）、留多久、能不能匯出給他們重做。
- 對照表：資料庫內的雜湊鏈 → AU-9(3)、10.3.4 的「變更偵測」；外部錨定與 WORM 副本 → 10.3.3、AU-9(1)、AU-9(2)、17a-4 的 WORM 選項；每筆記下規則、參數、流程版本 → 17a-4 的「足以重建原始紀錄」、AU-3；簽核綁定內容版本與 MFA → AU-10。
- AS 1105 的方向是「查核人員要自己確認資料沒被公司改過」。所以證據匯出必須讓查核人員**自己能驗**：匯出檔帶鏈欄位、附錨定值與驗證工具，而不是只給一張「已驗證」的畫面。
- 稽核人員也會回頭查資訊科技一般控制：誰是資料庫擁有者、誰能停用 trigger、變更怎麼核准。技術機制不能取代這些控制，只能縮小需要信任的範圍。

### 2.6 稽核事件輸出給 SIEM／GRC 的格式

| 格式 | 性質與現況 | 優點（推論） | 缺點 | 來源 |
|---|---|---|---|---|
| OCSF | 開放結構描述；最新 1.9.0（2026-08-03），前一版 1.8.0（2026-03）。Identity & Access Management 類別有 3001 Account Change、3002 Authentication、3003 Authorize Session、3004 Entity Management、3005 User Access Management、3006 Group Management、3007 User Management、3008 Role Management。**3001 Account Change 與 3005 User Access Management 在 1.9.0 標為「DEPRECATED since v1.9.0」，改用 `user_management` 類別** [77]（查證更正：原文寫「標示 D、意義不明」） | 欄位語意固定，跨廠商；Amazon Security Lake 要求自訂來源「must adhere to the OCSF schema and an Apache Parquet format」 | 版本更新快（1.5.0 2025-04、1.6.0 2025-08、1.7.0 2025-11、1.8.0 2026-03、1.9.0 2026-08 [64]），而且會淘汰類別；沒有「簽核決定」的現成類別（推論，見第 4 節） | [63][64][65][77] |
| CEF | ArcSight 的文字格式，走 syslog；標頭欄位含 Device Vendor、Device Product、Device Version、DeviceEventClassID、Name、Severity，後接鍵值延伸欄位。Microsoft Sentinel 以 CommonSecurityLog 表接收 | 老牌 SIEM 普遍能收 | 欄位為網路安全設備設計，自訂資料只能塞進 `cs1`–`cs6` 等自訂欄位，巢狀結構會遺失 | [66] |
| syslog（RFC 5424） | Standards Track（2009-03）；HEADER ＋ STRUCTURED-DATA ＋ MSG；實作必須支援 TLS 傳輸（RFC 5425） | 到處都有 | 「The syslog protocol does not provide acknowledgment of message delivery.」；協定本身沒有機密性與重放偵測；訊息可能遺失 | [67] |
| JSON Lines | 每行一個 JSON 值、UTF-8、以 `\n` 結尾；副檔名 `.jsonl`；媒體型別「may be `application/jsonl`, but this is not yet standardized」 | 最簡單，任何工具都能讀；可逐行驗證雜湊 | 不是正式標準；沒有欄位語意 | [68] |

**推論：**

- 證據輸出的正本應該是平台自己的事件結構，以 JSON Lines 匯出，每行帶序號、前一筆雜湊、本筆雜湊，另附一份清單檔（範圍、筆數、鏈頭、錨定值）。只有這種格式能完整保留驗證資訊。
- `audit_feed` 用游標式的拉取 API 提供同一份內容，讓 SIEM 的收集器定期來拿；拉取比 syslog 推送可靠（有確認、可重拉）。
- OCSF 對應放在第二階段，做成從正本轉出的衍生格式，並在每筆標明 OCSF 版本。CEF 與 syslog 是有損轉換，客戶可以用自己的收集器從 JSON 轉，平台不必內建。

### 2.7 定期複查與對帳

#### 2.7.1 法規與控制要求

| 來源 | 條文 | 內容 |
|---|---|---|
| PCI DSS v4.0.1 [58] | 7.2.4 | 「All user accounts and related access privileges, including third-party/vendor accounts, are reviewed as follows: At least once every six months. To ensure user accounts and access remain appropriate based on job function. Any inappropriate access is addressed. Management acknowledges that access remains appropriate.」 |
| | 7.2.5.1 | 應用程式與系統帳號的存取要定期複查（頻率依風險分析），並由管理階層確認 |
| NIST SP 800-53 Rev. 5 [59] | AC-2 j | 「Review accounts for compliance with account management requirements [Assignment: organization-defined frequency]」 |
| | AC-2 e、i | 建立帳號需經指定人員核准；存取依有效的授權 |
| | AC-6(7) | 定期複查指派給各角色或使用者類別的權限，「Reassign or remove privileges, if necessary」 |
| | AC-5 | 識別並記錄需要分離的職責 |

#### 2.7.2 產品 API 的常見做法

查不到跨廠商的標準；以下是三家的專屬 API：

| | Microsoft Graph access reviews | SailPoint Identity Security Cloud | Okta Identity Governance |
|---|---|---|---|
| 資料模型 | `accessReviewScheduleDefinition`（排程定義）→ `accessReviewInstance`（一次執行）→ `accessReviewInstanceDecisionItem`（逐項決定）；另有 `accessReviewHistoryDefinition` 產生可下載的歷史資料 [69] | campaign → certification → access-review-items [71] | campaigns → reviews [73] |
| 決定 | 逐項更新或 `batchRecordDecisions`；可 `acceptRecommendations` [69] | `POST /certifications/{id}/decide`，核准或撤銷；另有 sign-off 步驟完成整份認證（搜尋摘要）[71] | 複查人核准或撤銷 [73] |
| 沒人回應 | `defaultDecisionEnabled` ＋ `defaultDecision`（`Approve`／`Deny`／`Recommendation`） [70] | 未查到 | 補救設定中有「Doesn't respond」的處理 [73] |
| 套用 | `autoApplyDecisionsEnabled`；為 false 時管理者手動 `applyDecisions`。文件警告兩個開關同時為 true 時「all access for the principals to the resource risks being revoked if the reviewers fail to respond」 [69][70] | 未查到 | 部分情況「You must remediate reviews manually」（例如透過群組規則取得的指派） [73] |
| 輔助決策 | `recommendationsEnabled`、`recommendationLookBackDuration`（預設 30 天未使用就建議拒絕） [70] | — | — |
| 其他 | `justificationRequiredOnApproval`、`recurrence`、`reminderNotificationsEnabled`、`sendReminder`、多階段 [69][70] | — | 多層複查 [73] |

對帳的常見做法：

- SailPoint 的 native change detection：偵測在產品之外（out-of-band）被建立、修改、刪除的帳號；做法是在彙整（aggregation）時「comparing previously stored data with newly read data」；可監看帳號操作與權限屬性（例如 `memberOf`）；每個異動帳號觸發一次事件，「for both correlated and uncorrelated accounts」；範本流程會撤銷新增的權限並寄摘要給來源系統負責人 [72]。
- SCIM 協定沒有變更通知，刪除也無痕跡（見 2.3）[36]。

**推論：**

- spine 的 `access_review_campaign`、`access_review_item` 與業界模型一致，不需要改名。要補齊的行為是：逐項決定與批次決定、沒人回應時的預設處理（升級或撤銷）、決定與套用分離、核准需填理由、整份活動的完成簽核，以及可下載的複查歷史（PCI DSS 7.2.4 的「Management acknowledges」需要留下證據）。
- 本平台的複查項目天然帶有「當初哪張單、誰核准、什麼理由、何時到期」，這是從目標系統反推權限的治理產品沒有的資料，應該在複查畫面與 API 直接呈現。
- 對帳的業界做法是「全量快照比對」。本平台由其他系統回報（spine 的 `reconciliation_run`），回報內容應該是某個時間點的完整清單，用與 `describe_entitlements` 相同的通用結構；差異分三類已在 spine 定義。沒有標準格式可採用，SCIM 的 User／Group 表示法只夠表達群組式權限。
- 對帳發現「沒核准卻存在」之後要能接上處置：通知資源負責人、開補申請單或要求移除，並留紀錄。

### 2.8 結論：對外介面採用哪些標準

| 能力（spine 命名） | 必須採用 | 建議採用 | 不採用 | 理由 | 風險與緩解 |
|---|---|---|---|---|---|
| 權限判定 `check` | AuthZEN Authorization API 1.0 的 Access Evaluation、Access Evaluations、metadata [1] | 依 ARAP 草案保留拒絕回應的 `context.access_request` 欄位 [4] | XACML、OPA／Cedar／OpenFGA 的原生 API | 已定稿、與引擎無關、結構與 spine 一對一 | 規格定稿未滿一年，生態仍在成長；不定義快取。緩解：回應帶到期時間，撤銷靠事件 |
| 授權查詢 `grants` | 平台自有 REST 資源（通用結構同 `describe_entitlements`） | AuthZEN Search（subject／resource／action）[1] | SCIM 作為正式表達 | Search 只回傳識別，不含限制條件與期限 | OpenFGA 等實作的 Search 尚不完整 [9]；呼叫方可能期待分頁 |
| 事件通知 `events`、`webhook_subscription` | 簽章 webhook（Standard Webhooks 的標頭與 HMAC-SHA256）[31]＋游標式可重播事件端點；事件欄位相容 CloudEvents 必填屬性 [33] | SSF 發送方（推送與輪詢），事件用 CAEP 可對應者加上平台自訂 URI [19][20] | RISC；把授權事件硬套成 CAEP session-revoked | CAEP 沒有授權事件；SSF 不可重播 | Standard Webhooks 是社群規格。緩解：簽章算法是通用的 HMAC，不被規格綁死 |
| 佈建 | — | 流程包層級的 SCIM 2.0 對外連接器（群組或角色式授權）[35][36] | 核心介面採用 SCIM；平台當 SCIM 服務端 | SCIM 無期限、依據、限制條件 | 目標系統的 SCIM 實作差異大 |
| 機器身分 `api_client` | OAuth 2.0 client credentials、TLS、範圍與對象限制、每次呼叫留紀錄 [39][40] | 簽章 JWT 或 mTLS 的 client 驗證；憑證綁定 token [40][41] | 以長期靜態 API key 為唯一方式；SPIFFE 專屬整合 | RFC 9700 與 OWASP 的建議 | 客戶端系統老舊只會帶固定金鑰。緩解：允許 API key 但強制到期、輪替、最小範圍 |
| 人員登入 | OpenID Connect（已在 spine 第 12 節）[45] | — | —（SAML 本次未調查） | 已是 ISO/IEC 標準 | — |
| 防竄改 | PostgreSQL 內只增不改＋雜湊鏈；外部錨定；獨立驗證工具；定期驗證與告警 | 錨定值加 RFC 3161 時間戳記 [47]；定期 Merkle 根檢查點 [48] | immudb、Trillian、Rekor、公有區塊鏈 | 稽核要求的是結果；交易一致性與可攜性優先 | 擁有者與 superuser 仍可在兩次錨定之間重算。緩解：縮短錨定間隔、資料庫權限分離並納入稽核 |
| 證據輸出 `evidence`、`audit_feed` | JSON Lines＋清單檔；游標式拉取 API [68] | OCSF 對應（標明版本）[63] | 內建 CEF、syslog 輸出 | 正本要保留驗證欄位；CEF／syslog 有損 | OCSF 改版頻繁；簽核事件的類別對應未定 |
| 定期複查、對帳 | 平台自有 REST API（查不到標準），模型對齊「活動 → 項目 → 決定 → 套用」 | 對帳可選擇由平台以 SCIM GET 主動拉取 | — | 沒有標準可採 | 每個回報系統都要寫一小段轉換 |

---

## 3. 對產品的含意：需求清單

### 3.1 必須有

| # | 需求 | 依據 |
|---|---|---|
| M1 | `check` 實作 AuthZEN Authorization API 1.0 的 `/access/v1/evaluation` 與 `/access/v1/evaluations`，並提供 `/.well-known/authzen-configuration`；拒絕回 200 加 `decision:false` | 結論 1；2.1.1 |
| M2 | `check` 的回應 `context` 帶：依據的授權代號與申請單代號、拒絕理由代碼、授權到期時間；`X-Request-ID` 原值回傳 | 結論 1；2.1.4 缺口；spine §11 |
| M3 | 每個 `api_client` 可詢問的資源型別與動作以範圍限制；每次判定寫入稽核紀錄（誰問、問什麼、答什麼、依據） | 2.1.1（PDP 信任 PEP）；結論 6；PCI DSS 10.2.2 |
| M4 | `grants` 用平台自有結構，欄位至少含主體、資源、動作、限制條件、有效期間、狀態、來源申請單；與 `describe_entitlements` 同構 | 結論 5；2.3 |
| M5 | 事件通知：HMAC 簽章的 webhook（`webhook-id`、`webhook-timestamp`、`webhook-signature`）、指數退避重試、事件代號可當冪等鍵、金鑰可輪替 | 2.2.2；結論 3 |
| M6 | 事件另提供游標式拉取端點，可從任一位置重播；保留期間不短於稽核紀錄保留期間 | 結論 4；spine §11 |
| M7 | 事件內容含唯一 `id`、`source`、`type`、`time`、`subject`，並標明內容結構版本 | 2.2.2（CloudEvents） |
| M8 | `api_client` 以 OAuth 2.0 client credentials 取得短效、限定對象與範圍的 access token；全程 TLS | 結論 6；2.4 |
| M9 | `api_client` 的憑證有到期日、可輪替、可立即停用；`api_client` 本身納入定期複查 | PCI DSS 7.2.5.1、8.6.3；2.4 |
| M10 | 稽核紀錄的鏈頭定期寫到平台資料庫管理者無法修改的外部位置（至少支援 WORM 物件儲存） | 結論 7、8；2.5.3 |
| M11 | 提供獨立於平台的驗證工具與公開的雜湊演算法說明；輸入為匯出檔與錨定值 | 結論 7；2.5.4（AS 1105 .10A） |
| M12 | 排程驗證整條鏈與錨定值，不符即告警並留紀錄 | PCI DSS 10.3.4；NIST AU-9 b |
| M13 | 稽核紀錄資料表的擁有者角色與應用程式角色分離；有列安全政策的表設 `FORCE ROW LEVEL SECURITY`；防改寫的 trigger 設為不受 `session_replication_role` 影響；停用 trigger 或變更擁有者屬於要被記錄與複查的特權操作 | 結論 8；2.5.3 |
| M14 | 證據匯出為 JSON Lines（每行含序號、前一筆雜湊、本筆雜湊）加清單檔（範圍、筆數、鏈頭、錨定值）；同時提供人可讀版本 | 2.6；SEC 17a-4(f)(2)(iv) |
| M15 | `audit_feed` 以游標式拉取 API 提供，內容與匯出檔相同 | 2.6 |
| M16 | 定期複查：逐項與批次決定、撤銷需即時生效並發事件、核准可要求填理由、沒人回應的處理（升級或撤銷）可設定、整份活動完成時由負責人簽核、可下載歷史 | 結論 10；2.7；PCI DSS 7.2.4 |
| M17 | 複查週期可設定，預設不長於六個月 | PCI DSS 7.2.4 |
| M18 | 對帳：接收某時間點的完整權限清單（與 `grants` 同構），產出三類差異，每筆差異可指派、處置並留紀錄 | 結論 10；2.7.2；spine §11 |
| M19 | 稽核紀錄保留至少 12 個月，最近 3 個月可立即查詢（可用參數調長） | PCI DSS 10.5.1 |
| M20 | 所有對外時間用 UTC 與 RFC 3339；部署文件要求時間同步 | PCI DSS 10.6.1 |

### 3.2 應該有

| # | 需求 | 依據 |
|---|---|---|
| S1 | AuthZEN Search API（subject、resource、action），支援 `next_token` 分頁 | 2.1.1；2.8 |
| S2 | `check` 被拒且該資源可申請時，回應帶 `context.access_request`（申請入口、適用流程、到期時間）；申請單狀態可對應 ARAP 的六種狀態 | 2.1.1（ARAP）；結論 1 |
| S3 | SSF 發送方：`/.well-known/ssf-configuration`、串流管理 API、推送與輪詢；撤銷時對支援的接收方送出可對應的 CAEP 事件，其餘用平台自訂事件 URI | 結論 3；2.2.1 |
| S4 | client 驗證支援簽章 JWT 或 mTLS；可選擇把 token 綁定憑證 | 結論 6；RFC 9700 §2.5 |
| S5 | 錨定值附 RFC 3161 時間戳記（時間戳記機構可設定） | 2.5.1 |
| S6 | 定期產生 Merkle 根或鏈頭檢查點，讓驗證可以分段進行 | 2.5.1 [48] |
| S7 | 從正本轉出 OCSF 格式的衍生輸出，標明 OCSF 版本 | 2.6 |
| S8 | 複查時顯示該授權的使用情況（由目標系統回報或由 `check` 紀錄推得），作為保留或撤銷的建議依據 | 2.7.2（Microsoft 的 recommendation） |
| S9 | 流程包可選用 SCIM 2.0 對外連接器，把群組或角色式的核准結果送出，到期或撤銷時送移除 | 結論 5；2.3 |
| S10 | `sim/` 的示範系統實作為 AuthZEN 的執行點，並用公開的 AuthZEN 互通情境驗證平台的判定端點 | 2.1.1 [9]；spine §12 |
| S11 | webhook 支援非對稱簽章（ed25519），讓接收方不必保管共用密鑰 | 2.2.2 [31] |

### 3.3 可以不做

| # | 項目 | 理由 |
|---|---|---|
| N1 | XACML 請求協定或政策語言 | 2.1.2；新整合往 AuthZEN 走 |
| N2 | 在核心內嵌 OPA、Cedar 或 OpenFGA | 2.1.3；判定依據是授權不是政策，嵌入會產生第二份真相 |
| N3 | Zanzibar 等級的延展性設計 | 2.1.3；資料量是單一公司的授權筆數 |
| N4 | RISC 事件 | 2.2.1；RISC 是帳號層級事件，帳號不歸本平台管 |
| N5 | 平台當 SCIM 服務端接收人員 | 2.3；人員來源已定為 LDAP |
| N6 | SPIFFE 專屬整合 | 2.4；支援 mTLS 即可接受 X.509-SVID |
| N7 | immudb、Trillian、Tessera、Rekor、公有區塊鏈 | 結論 9；2.5.2 |
| N8 | 內建 CEF 或 syslog 輸出 | 2.6；有損且無送達確認，可由客戶的收集器轉換 |
| N9 | AuthZEN Obligations、COAZ | 2.1.1；仍是草案，第一版沒有對應需求 |
| N10 | 判定結果的簽章（簽章 JWT 形式的 decision） | AuthZEN 1.0 §11.6 允許 PDP「MAY」簽章判定回應，但沒有定義格式 [1]，做了也沒有互通對象；第一版以 TLS 加呼叫紀錄為準，若客戶的 PEP 與平台之間有代理或閘道再評估（推論）。（查證更正：原文寫「規格只有 metadata 可簽章」） |

---

## 4. 不確定或查不到的事項

| # | 事項 | 狀況 |
|---|---|---|
| U1 | OPA 是否官方支援 AuthZEN | 查不到官方聲明。只有社群外掛與個人文章稱 2026-04 時單筆判定情境通過、批次端點未實作，未採信 [84] |
| U2 | AuthZEN 的一致性認證計畫 | 2026-07 的文章提到「conformance certification program」[7]；工作組簡報稱已定義 PDP 的一致性認證設定檔，且認證只驗協定一致、不驗判定正確（搜尋摘要）[83]。查不到已通過認證的名單 |
| U3 | AuthZEN 互通計畫 2026 年的完整參與名單 | 查不到；Keycloak 文章稱「over a dozen independently-developed PDPs」，是廠商說法 [10] |
| U4 | Microsoft Entra 是否對第三方提供 SSF 串流、支援哪些事件 | 查不到 Microsoft 官方文件 |
| U5 | Okta 作為 SSF 接收方支援的事件清單、發送方的傳遞方式與發布狀態 | 文件未寫 [24] |
| U6 | SailPoint 是否有 SSF 發送方 | 公告只談接收方 [27]；開發者文件頁面回 404 |
| U7 | `draft-ietf-scim-roles-entitlements` 在 -01（2026-04-19 到期）之後的狀態 | 查不到更新版本或 RFC；另有個人草案 `draft-poreddy-scim-role-assignment` 僅見標題 |
| U8 | Standard Webhooks 建議的時間戳容許秒數 | 規格原文沒有具體數字 [31]；次級來源說 300 秒，未採信 |
| U9 | CEF 規格原文（標頭格式行、跳脫規則） | OpenText／Micro Focus 的文件回 403，未能讀到原文；2.6 的欄位名稱來自 Microsoft 的對應表 [66] |
| U10 | 簽核決定、授權生效／撤銷應對應 OCSF 哪個類別 | 「D」已查明是淘汰（見 2.6）[77]；對應仍要在實作時逐一比對，可能要用擴充 |
| U11 | OCSF 的治理與標準化進度 | 2024-11 加入 Linux Foundation；AWS 部落格稱 2025-12 ITU 成員國支持送批、目標 2026-06 正式通過；但 ITU 2026-08-25 的文件仍稱 X.icd-schemas 為「new draft」，是否已通過查不到（搜尋摘要）[78][79] |
| U12 | PCAOB AS 1105 第 .08、.10、.10A 段的逐字條文 | PCAOB 網站回 403；2.5.4 的內容來自 SEC 在聯邦公報的公告前言 [61]。另有搜尋摘要稱審計品質中心曾請求延後 .10A 生效，結果不明 |
| U13 | ISO/IEC 27001:2022 附錄 A（例如 8.15 記錄、5.18 存取權限）的條文 | 付費標準，未取得原文，本文件不引用 |
| U14 | SOC 2（AICPA Trust Services Criteria）對紀錄完整性與存取複查的原文 | 本次未查 |
| U15 | 台灣的法規與主管機關對稽核紀錄防竄改、時間戳記、存取複查的具體要求 | 查證時補了電子簽章法與上市櫃資安管控指引第 23 條（2.5.4）；指引中的存取權限覆核頻率、日誌保存年限，以及金管會對金融業的具體條文，本次查不到原文；eIDAS 的引用僅供參考，不適用於台灣 |
| U16 | 「稽核人員實際接受什麼」的實證資料（調查、訪談） | 查不到有方法說明的調查；2.5.4 的結論是從條文推論，不是稽核人員的說法 |
| U17 | Amazon QLDB 終止、XACML 3.0 與 ACAL 的日期、OPA 與 OpenFGA 的 CNCF 日期、OIDC 的 ISO 編號、eIDAS 第 41 條、SailPoint 與 Okta 的 API 路徑 | 只在搜尋結果摘要看到，未打開原文逐字核對（文中已標示） |
| U18 | Cedar 加入 CNCF 的官方公告內容 | AWS 部落格頁面只讀到導覽列；日期與採用者來自 InfoQ 的報導 [16] |
| U19 | 地端可用、支援 Object Lock 的 S3 相容儲存有哪些、是否經過類似 Cohasset 的評估 | 本次未查 |
| U20 | 引文的精確度 | PCI DSS、NIST SP 800-53、Crosby 與 Wallach 論文的引文是我直接從 PDF 文字擷取；其餘引文經由網頁擷取工具取得，正式對外引用前應回原文核對 |

---

## 5. 來源

查閱日期均為 2026-11-19。

| # | 標題 | 網址 |
|---|---|---|
| 1 | OpenID Foundation, *Authorization API 1.0*（Final，2026-01） | https://openid.net/specs/authorization-api-1_0-final.html |
| 2 | OpenID Foundation, "Authorization API 1.0 Final Specification Approved"（2026-01-12） | https://openid.net/authorization-api-1-0-final-specification-approved/ |
| 3 | OpenID Foundation, AuthZEN Working Group – Specifications | https://openid.net/wg/authzen/specifications/ |
| 4 | OpenID AuthZEN WG, *AuthZEN Access Request and Approval Profile*, Draft 1（2026-11-06） | https://openid.github.io/authzen/authzen-access-request-approval-profile-1_0.html |
| 5 | OpenID AuthZEN WG, *AuthZEN Profile for Obligations*, Draft 1（2026-07-03） | https://openid.github.io/authzen/authzen-obligations-profile-1_0.html |
| 6 | OpenID Foundation, "AuthZEN shows enterprise readiness at Gartner IAM Summit"（2025-12-22） | https://openid.net/authzen-shows-enterprise-readiness-at-gartner-iam-summit/ |
| 7 | OpenID Foundation, "AuthZEN at Identiverse 2026: Authorization in the agent era"（2026-07-14） | https://openid.net/authzen-at-identiverse-2026-authorization-in-the-agent-era/ |
| 8 | OpenID Foundation, "AuthZEN Work Group Announces Authorization Interop Results"（2024-05） | https://openid.net/authorization-interop-results/ |
| 9 | OpenFGA 文件, "AuthZEN" | https://openfga.dev/docs/interacting/authzen |
| 10 | Keycloak, "Keycloak experimental AuthZEN Support"（2026-05-20） | https://www.keycloak.org/2026/05/authzen-as-experimental-feature |
| 11 | OASIS, *JSON Profile of XACML 3.0 Version 1.1*（OASIS Standard，2019-06-20） | https://docs.oasis-open.org/xacml/xacml-json-http/v1.1/xacml-json-http-v1.1.html |
| 12 | OASIS XACML TC（XACML 3.0 狀態；ACAL／XACML 4.0 CSD01）（搜尋摘要） | https://www.oasis-open.org/tc-xacml ；https://docs.oasis-open.org/xacml/acal/xacml/core/v4.0/csd01/acal-core-xml-v4.0-csd01.html |
| 13 | Open Policy Agent 文件, "REST API" | https://www.openpolicyagent.org/docs/latest/rest-api/ |
| 14 | CNCF, "Cloud Native Computing Foundation Announces Open Policy Agent Graduation"（2021-02-04）（搜尋摘要） | https://cncf.io/announcements/2021/02/04/cloud-native-computing-foundation-announces-open-policy-agent-graduation/ |
| 15 | AWS, Amazon Verified Permissions API Reference, "IsAuthorized" | https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_IsAuthorized.html |
| 16 | InfoQ, "Cedar Joins CNCF Sandbox"（2026-01-27，新聞報導）；AWS Open Source Blog 同題文章（內文未讀到） | https://www.infoq.com/news/2026/01/cedar-joins-cncf-sandbox ；https://aws.amazon.com/blogs/opensource/cedar-joins-cncf-as-a-sandbox-project |
| 17 | Google Research, "Zanzibar: Google's Consistent, Global Authorization System"（USENIX ATC 2019） | https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/ |
| 18 | CNCF, "OpenFGA becomes a CNCF incubating project"（2025-11-11）（搜尋摘要） | https://www.cncf.io/blog/2025/11/11/openfga-becomes-a-cncf-incubating-project/ |
| 19 | OpenID Foundation, *OpenID Shared Signals Framework Specification 1.0*（Final，2025-08-29） | https://openid.net/specs/openid-sharedsignals-framework-1_0-final.html |
| 20 | OpenID Foundation, *OpenID Continuous Access Evaluation Profile 1.0*（Final，2025-08-29） | https://openid.net/specs/openid-caep-1_0-final.html |
| 21 | OpenID Foundation, *OpenID RISC Profile Specification 1.0*（Final，2025-08-29） | https://openid.net/specs/openid-risc-1_0-final.html |
| 22 | OpenID Foundation 新聞稿, "OpenID Foundation finalizes global standards for real-time identity security"（2025-09-16） | https://openid.net/press-release-openid-foundation-finalizes-global-standards-for-real-time-identity-security/ |
| 23 | OpenID Foundation, Shared Signals Working Group – Specifications | https://openid.net/wg/sharedsignals/specifications/ |
| 24 | Okta Developer, "SSF Transmitter SET payload structures"；Okta Help, "Shared Signals Framework" | https://developer.okta.com/docs/reference/ssf-transmitter-sets/ ；https://help.okta.com/oie/en-us/content/topics/itp/shared-signals.htm |
| 25 | Apple Support, "Use federated authentication with your identity provider in Apple Business"（2026-04-14） | https://support.apple.com/guide/business/axmfcab66783/web |
| 26 | Google for Developers, "Protect user accounts with Cross-Account Protection" | https://developers.google.com/identity/protocols/risc |
| 27 | SailPoint Community, "Enhancement: Shared Signals Framework Receiver New Event Types"（2026-04-08） | https://community.sailpoint.com/blog/Enhancement-Shared-Signals-Framework-Receiver-New-Event-Types |
| 28 | IETF, RFC 8417 *Security Event Token (SET)*（2018-07） | https://www.rfc-editor.org/rfc/rfc8417.html |
| 29 | IETF, RFC 8936 *Poll-Based Security Event Token (SET) Delivery Using HTTP*（2020-11） | https://www.rfc-editor.org/rfc/rfc8936.html |
| 30 | IETF, RFC 9967 *SCIM Profile for Security Event Tokens*（2026-05） | https://datatracker.ietf.org/doc/html/rfc9967 |
| 31 | Standard Webhooks 規格 | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md |
| 32 | Standard Webhooks 網站（技術指導委員會、相容實作） | https://www.standardwebhooks.com/ |
| 33 | CloudEvents 規格（1.0.3-wip；`specversion` 為 1.0） | https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md |
| 34 | CNCF, CloudEvents 專案頁 | https://www.cncf.io/projects/cloudevents/ |
| 35 | IETF, RFC 7643 *SCIM: Core Schema*（2015-09） | https://datatracker.ietf.org/doc/html/rfc7643 |
| 36 | IETF, RFC 7644 *SCIM: Protocol*（2015-09） | https://www.rfc-editor.org/rfc/rfc7644.html |
| 37 | IETF, RFC 9865 *Cursor-Based Pagination of SCIM Resources*（2025-10）（搜尋摘要） | https://www.rfc-editor.org/rfc/rfc9865 |
| 38 | IETF, *SCIM Roles and Entitlements Extension*, draft-ietf-scim-roles-entitlements-01（2025-10-16） | https://www.ietf.org/archive/id/draft-ietf-scim-roles-entitlements-01.html |
| 39 | IETF, RFC 6749 *The OAuth 2.0 Authorization Framework*（2012-10） | https://www.rfc-editor.org/rfc/rfc6749.html |
| 40 | IETF, RFC 9700／BCP 240 *Best Current Practice for OAuth 2.0 Security*（2025-01） | https://www.rfc-editor.org/rfc/rfc9700.html |
| 41 | IETF, RFC 8705 *OAuth 2.0 Mutual-TLS Client Authentication and Certificate-Bound Access Tokens*（2020-02） | https://www.rfc-editor.org/rfc/rfc8705.html |
| 42 | SPIFFE 文件, "SPIFFE Concepts" | https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/ |
| 43 | CNCF, SPIFFE 專案頁 | https://www.cncf.io/projects/spiffe/ |
| 44 | OWASP Cheat Sheet Series, "REST Security Cheat Sheet" | https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html |
| 45 | OpenID Foundation, "10 Years On: OpenID Connect Published as an ISO/IEC Spec"（2024-10-07）（搜尋摘要） | https://www.openid.net/10-years-on-openidconnect-published-as-iso-spec/ |
| 46 | IETF, RFC 9162 *Certificate Transparency Version 2.0*（2021-12，Experimental） | https://www.rfc-editor.org/rfc/rfc9162.html |
| 47 | IETF, RFC 3161 *Internet X.509 PKI Time-Stamp Protocol (TSP)*（2001-08） | https://www.rfc-editor.org/rfc/rfc3161.html |
| 48 | S. A. Crosby, D. S. Wallach, "Efficient Data Structures for Tamper-Evident Logging", USENIX Security 2009 | https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf |
| 49 | google/trillian README | https://github.com/google/trillian |
| 50 | transparency-dev/tessera README | https://github.com/transparency-dev/tessera |
| 51 | Sigstore Blog, "Rekor v2 GA – Cheaper to run, simpler to maintain"（2025-10-10） | https://blog.sigstore.dev/rekor-v2-ga/ |
| 52 | codenotary/immudb README | https://github.com/codenotary/immudb |
| 53 | AWS, QLDB 終止支援與遷移到 Aurora PostgreSQL（搜尋摘要） | https://aws.amazon.com/blogs/database/migrate-an-amazon-qldb-ledger-to-amazon-aurora-postgresql/ ；https://www.infoq.com/news/2024/07/aws-kill-qldb |
| 54 | Microsoft Learn, "Ledger overview"（SQL Server／Azure SQL；文件日期 2025-08-07） | https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-overview |
| 55 | AWS, Amazon S3 User Guide, "Locking objects with Object Lock" | https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html |
| 56 | PostgreSQL 文件（current，顯示為第 19 版）, "Row Security Policies" | https://www.postgresql.org/docs/current/ddl-rowsecurity.html |
| 57 | PostgreSQL 文件（current）, "ALTER TABLE" | https://www.postgresql.org/docs/current/sql-altertable.html |
| 58 | PCI Security Standards Council, *PCI DSS: Requirements and Testing Procedures*, v4.0.1（2024-06）。官方下載處為 PCI SSC 文件庫；本次讀取的是公開鏡像 | https://www.pcisecuritystandards.org/document_library/ ；https://www.middlebury.edu/sites/default/files/2025-01/PCI-DSS-v4_0_1.pdf |
| 59 | NIST, SP 800-53 Rev. 5 *Security and Privacy Controls for Information Systems and Organizations*（2020-09，含 2020-12-10 更新） | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf |
| 60 | SEC, "Electronic Recordkeeping Requirements for Broker-Dealers…"，87 FR 66412（2022-11-03），17 CFR 240.17a-4(f) | https://www.govinfo.gov/content/pkg/FR-2022-11-03/html/2022-22670.htm |
| 61 | SEC, PCAOB 修正 AS 1105 等準則之公告（聯邦公報 2024-07-02） | https://www.govinfo.gov/content/pkg/FR-2024-07-02/html/2024-14488.htm |
| 62 | Regulation (EU) No 910/2014（eIDAS）第 41 條（搜尋摘要；讀到的是英國保留法版本） | https://www.legislation.gov.uk/eur/2014/910/article/41 |
| 63 | OCSF Schema Browser（v1.9.0） | https://schema.ocsf.io/ |
| 64 | ocsf/ocsf-schema Releases | https://github.com/ocsf/ocsf-schema/releases |
| 65 | AWS, Amazon Security Lake User Guide, "Open Cybersecurity Schema Framework (OCSF) in Security Lake" | https://docs.aws.amazon.com/security-lake/latest/userguide/open-cybersecurity-schema-framework.html |
| 66 | Microsoft Learn, "Common Event Format (CEF) key and CommonSecurityLog field mapping" | https://learn.microsoft.com/en-us/azure/sentinel/cef-name-mapping |
| 67 | IETF, RFC 5424 *The Syslog Protocol*（2009-03） | https://www.rfc-editor.org/rfc/rfc5424.html |
| 68 | JSON Lines | https://jsonlines.org/ |
| 69 | Microsoft Learn, "Overview of access reviews APIs"（Microsoft Graph v1.0） | https://learn.microsoft.com/en-us/graph/api/resources/accessreviewsv2-overview |
| 70 | Microsoft Learn, "accessReviewScheduleSettings resource type" | https://learn.microsoft.com/en-us/graph/api/resources/accessreviewschedulesettings |
| 71 | SailPoint Developer, Certifications API（搜尋摘要） | https://developer.sailpoint.com/docs/api/v3/certifications ；https://developer.sailpoint.com/docs/api/v3/make-identity-decision |
| 72 | SailPoint 文件, "Managing Native Change Detection" | https://documentation.sailpoint.com/saas/help/sources/native_change_detection.html |
| 73 | Okta, Identity Governance API – Campaigns（搜尋摘要）；Okta Help, "Understand remediation" | https://developer.okta.com/docs/api/iga/openapi/governance.api/tag/Campaigns/ ；https://help.okta.com/oie/en-us/content/topics/identity-governance/access-certification/remediation.htm |
| 74 | 本 repo：`docs/platform-vision.md`、`docs/contract/00-spine.md` 第 11、12 節 | — |
| 75 | OpenID Foundation, Shared Signals Working Group – Overview（新聞列表） | https://openid.net/wg/sharedsignals/ |
| 77 | OCSF Schema Browser v1.9.0, "Account Change"、"User Access Management" 類別頁 | https://schema.ocsf.io/1.9.0/classes/account_change ；https://schema.ocsf.io/1.9.0/classes/user_access |
| 78 | AWS Open Source Blog, "OCSF achieves ITU support…"（2026-03）（搜尋摘要） | https://aws.amazon.com/blogs/opensource/ocsf-achieves-itu-support-powering-ai-ready-security-operations |
| 79 | ITU-T SG17 contribution T25-SG17-C-0764（2026-08-25）（搜尋摘要） | https://www.itu.int/md/T25-SG17-C-0764/ |
| 80 | PCI SSC, RFC instructions PCI DSS v4.0.1（2026-06）（搜尋摘要） | https://www.pcisecuritystandards.org/rfc_instructions_pci-dss-v4-0-1-june2026/ |
| 81 | 全國法規資料庫，電子簽章法（2024-05-15 修正） | https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0080037 |
| 82 | 臺灣證券交易所，上市上櫃公司資通安全管控指引（修正條文對照表，113-09-10）（搜尋摘要；原檔下載被導向列表頁，未讀到全文） | https://dsp.twse.com.tw/public/static/downloads/listedCompany/上市上櫃公司資通安全管控指引(修正條文對照表)_Final_20240916092203.docx |
| 83 | AuthZEN 工作組簡報（Google Slides，搜尋摘要） | https://docs.google.com/presentation/d/1Bu8VHMTu_j26EBXS6FyJmBDAQep62bm5/htmlpresent |
| 84 | DEV Community, "I built an OPA plugin that turns it into an AuthZEN-compatible PDP"（個人文章，搜尋摘要） | https://dev.to/kanywst/i-built-an-opa-plugin-that-turns-it-into-an-authzen-compatible-pdp-i81 |

---

## 6. 查證紀錄

查證日期 2026-11-19，由未參與撰寫的查證者執行。方法：挑出對產品決策影響最大的論點，逐一打開原始來源核對；PCI DSS 以 PDF 文字層核對。

### 6.1 逐項結果

| # | 論點 | 結果 | 來源 |
|---|---|---|---|
| 1 | AuthZEN Authorization API 1.0 為 Final；2026-01-12 公告；81／1／25 票，107／378，門檻 20% | 已確認 | [2] |
| 2 | 規格日期 2026-01-11、三位編者；預設路徑、`evaluations_semantic` 三值與預設 `execute_all`；拒絕回 200＋`decision:false`；`X-Request-ID` 原值回傳 | 已確認 | [1] |
| 3 | 「AuthZEN 只有 metadata 可簽章，沒有判定結果簽章」（N10） | **已更正**：§11.6 寫 PDP MAY 簽章判定回應，但未定義格式；已改 2.1.1 與 N10 | [1] |
| 4 | 「PDP 驗證呼叫方，建議 OAuth 2.0（§2、§11.2）」 | **已更正（精確化）**：OAuth 2.0 的 RECOMMENDED 在 §2；§11.2 只列三種做法不指定 | [1] |
| 5 | Keycloak 26.7.0 起實驗性支援，Evaluation、Evaluations、metadata，client credentials，2026-05-20 | 已確認（文中未提 Search） | [10] |
| 6 | OpenFGA AuthZEN 為實驗性、四項限制 | 已確認並補充：路徑掛在 store 底下、不回傳呼叫方的 `X-Request-ID`、不提供 `signed_metadata` | [9] |
| 7 | ARAP Draft 1、2026-11-06、單一作者、六種狀態、不變條件 | 已確認；**已更正**欄位細節：`approval` 必填 `id`、`approved_until`（`approved_at` 選填）；`denial` 內必填 `expires_at` 與 `evaluation_id`／`binding_token` 擇一；批次有 `partial` | [4] |
| 8 | CAEP 1.0 Final 2025-08-29，8 種事件，沒有授權變更專用事件；`token-claims-change` 定義 | 已確認；補上工作組頁面的核准日 2025-09-02 | [20][75] |
| 9 | Okta 發送方只支援 Session Revoked、Credential Change；連到 SSF ID3、CAEP ID2 | 已確認（傳遞方式文件未寫） | [24] |
| 10 | SailPoint 接收方只支援這兩種事件（2026-04-08）；公告未提發送方 | 已確認 | [27] |
| 11 | RFC 8936 §2.2「released from any obligation to retain the SET」；未確認事件可依部署條件丟棄 | 已確認 | [29] |
| 12 | RFC 7643 §4.1.2 `entitlements`、`roles`「No vocabulary or syntax is specified」；群組異動 MUST 經 Group 資源 | 已確認 | [35] |
| 13 | RFC 9967 為 2026-05 Proposed Standard | 已確認（datatracker） | [30] |
| 14 | RFC 9700／BCP 240（2025-01）§2.5、§2.2.1、§2.3 | 已確認 | [40] |
| 15 | Trillian 維護模式並建議 Tessera；immudb 為 BSL 1.1；Rekor v2 2025-10-10、只收兩種項目、無 attestation 儲存、不回傳簽章時間戳記、後端 Tessera | 已確認 | [49][51][52] |
| 16 | PCI DSS v4.0.1 7.2.4（至少每六個月）、7.2.5.1（依目標風險分析頻率）、10.3.4、10.5.1（12 個月、最近 3 個月可立即分析） | 已確認（PDF 文字層逐字比對）；補上 v4.0.1 仍為現行版本 | [58][80] |
| 17 | PostgreSQL：superuser、`BYPASSRLS` 繞過 RLS；擁有者通常也繞過 | 已確認；補上擁有者可用 `FORCE ROW LEVEL SECURITY` 自我限制，已加入 M13 | [56] |
| 18 | OCSF 最新 1.9.0（2026-08-03）、前一版 1.8.0（2026-03）；3001、3005 的「D」 | 日期已確認；**已更正**：「D」是淘汰，改用 `user_management` | [64][77] |
| 19 | Standard Webhooks 三個標頭、v1 HMAC 簽法、v2a ed25519、未給容許秒數、`410 Gone`、冪等鍵 | 已確認；補上 `v1a` 已淘汰 | [31] |
| 20 | Microsoft Graph：`defaultDecision` 三值、兩開關同時開啟的警告、`recommendationLookBackDuration` 預設 30 天 | 已確認（應用程式的複查最多 30 天） | [70] |
| 21 | Amazon QLDB 2025-07-31 終止 | 仍為搜尋摘要：AWS 開發者指南（在地化頁面摘要）寫「until end of support on 07/31/2025」，英文頁面回 404，未逐字核對；保留「（搜尋摘要）」標示 | [53] |

沒有刪除論點；無法確認者維持「（搜尋摘要）」或列在第 4 節。

### 6.2 補充搜尋（不同角度）

1. AuthZEN 最新消息與一致性認證：工作組簡報稱已定義 PDP 一致性認證設定檔（搜尋摘要），未見認證名單 → 更新 U2。
2. OPA 對 AuthZEN 的支援（反面證據）：仍只有社群外掛 → 更新 2.1.1 與 U1。
3. Microsoft Entra 是否提供 SSF：仍查不到官方文件 → U4 不變。
4. OCSF 的 ITU 標準化：2026-06 目標，但 2026-08 仍為草案 → 更新 U11。
5. PCI DSS 是否已有新版：v4.0.1 仍現行，2026 年中開放意見徵詢 → 補在 2.5.4。
6. 台灣：電子簽章法 2024 修正（全國法規資料庫原文）、上市櫃資安管控指引第 23 條（搜尋摘要）、金管會 2025-12 金融資安韌性發展藍圖與零信任轉為必備（新聞報導，未讀原文，未寫入正文）→ 新增 2.5.4「台灣在地參考」、更新 U15。

### 6.3 對產品影響最大的結論（查證後）

1. `check` 採 AuthZEN 1.0 仍成立；判定回應簽章是規格允許的選項（§11.6），但沒有格式，第一版不做。
2. 事件通知不能依賴 SSF／CAEP：沒有授權事件、主要廠商只收發兩種事件、輪詢確認後即可丟棄；必須自建可重播事件端點。
3. 雜湊鏈要搭配外部錨定與資料庫權限分離（含 `FORCE ROW LEVEL SECURITY`）才有意義；PCI DSS 10.3.4 要的是「改了會告警」。
4. OCSF 會淘汰類別（1.9.0 已淘汰 3001、3005），只能當衍生格式並標版本，正本用 JSON Lines。
5. 台灣的平台內簽核屬「電子簽章」而非有推定效力的「數位簽章」；若客戶需要推定效力，要另支援憑證簽署。
