# 03 競品調查：身分治理、存取申請、資料存取治理

查閱日期：2026-11-19。對照基準：[platform-vision.md](../platform-vision.md) 的四個稽核問題，與 [contract/00-spine.md](../contract/00-spine.md) 第 11 節的對外整合介面。

**閱讀方式**

- 每個事實後面的 `[n]` 對應第 5 節的來源編號。
- 標記：**【事實】** 來源直接寫的；**【推論】** 由事實推得、來源沒有直接寫；**【查不到】** 查過但沒有找到依據。
- 第 5 節的「取得方式」欄：「直接開啟」表示本次調查讀了該頁原文；「搜尋摘要」表示只取得搜尋引擎回傳的摘要與連結，沒有逐頁核對，引用時可信度較低。
- 價格一律是廠商公開頁面或第三方列出的美元標價，不含折扣；實際合約價會不同。

---

## 1. 重點結論

1. 查到的產品裡，沒有一個同時回答四個稽核問題；「核准綁定內容版本」與「執行後驗證」兩項，在所有查到的官方文件中都沒有對應功能。[7][34][35][36]
2. 申請時的職責分離大多是可關閉、可繞過的設定：SailPoint 在簽核人就是申請人時可自動核准，Zluri 只提示不擋，Snowflake Multi-party Approval 預設把申請人自己的核准算進門檻，Okta 文件自承多張申請同時送出時檢查會漏，且指定特定使用者為核准人時允許自我核准。[10][19][31][37][61]
3. 核准後內容可以被改而不重簽：Microsoft Entra 的 access package 可「隨時」增減資源，已核准的人自動取得新權限；Snowflake 的核准人可以授予和申請不同的角色。[7][35]
4. 紀錄防竄改幾乎沒有產品在文件中說明機制：Entra 稽核紀錄預設只留 30 天、Immuta 預設 7 天，都要自行匯出；只查到 EmpowerID（2026-08 白皮書）與 BeyondTrust Entitle 宣稱有雜湊鏈或簽章紀錄。[5][33][45][57]
5. 資料平台原生的申請核准功能很薄：Databricks 是單步、文件未提授權期限、平台外的核准不會匯回，且至查閱日仍為 Public Preview；Snowflake 的核准流程只到 listing 與角色層級；查到支援欄位層級申請的只有 Immuta（masking exception）。[32][34][35][36]
6. 公開標價的只有 Microsoft（Entra ID Governance 每人每月 7 美元，另需 P1）、Okta（套裝每人每月 6／14／17 美元，年約最低 1,500 美元）與 ManageEngine（每網域每年 595 美元起）；SailPoint、Saviynt、One Identity、C1、Lumos、Zluri、Opal、Immuta 都要詢價。[4][18][24][28][31][54]
7. 需要地端部署的中型企業選擇正在變少：Microsoft Identity Manager 2016 支援到 2029-01-09 為止，新一代產品（C1、Lumos、Zluri、Okta、Entra）都是雲端服務；查到文件寫明可自架的是 One Identity Manager、SailPoint IdentityIQ、Opal（含 airgapped）、Teleport、Immuta；midPoint 為開源軟體。[23][26][33][43][55][56]
8. 使用者最痛的是人工作業與整合：84% 的組織主要靠人工做存取複查與開通（Zilla，2025，n=300），83% 說與既有 IGA 整合困難是自動化的最大障礙；近 60% 認為現有 IGA 的總持有成本過高（Omada，2025，n>500）。[46][47]
9. 2025–2026 市場正在圍繞 AI agent 與非人類身分重組：Palo Alto Networks 併 CyberArk（2026-02-11 完成）、ServiceNow 併 Veza（2026-03-02 完成）、Microsoft Entra Agent ID 與 Agent 365、Okta for AI Agents、SailPoint Agentic Fabric 都在 2026 年上市。[9][16][21][30][44]
10. 繁體中文與台灣在地支援：SailPoint Identity Security Cloud 列有 zh-TW、在台有 4 家合作夥伴；Okta 只有終端使用者介面有繁體中文，管理介面沒有；其餘產品的繁體中文與在台支援查不到公開依據。[13][14][20]

---

## 2. 詳細內容

### 2.1 身分治理與存取申請（IGA）

#### 2.1.1 定位、部署、價格、語言

| 產品 | 定位與客群 | 部署 | 公開價格 | 繁體中文／台灣 |
|---|---|---|---|---|
| Microsoft Entra ID Governance | 【事實】Entra ID P1／P2 客戶的進階治理加購；含 entitlement management、access reviews、PIM、lifecycle workflows [3] | 【事實】雲端服務；地端應用程式靠 provisioning agent 連回 Entra 租戶 [3][60]。【推論】完全離線的環境無法使用 | 【事實】Entra ID Governance 每人每月 7.00 美元（年繳）；P1 7.00、P2 10.00、Entra Suite 12.00；Governance 需租戶內另有含 `AAD_PREMIUM` 或 `AAD_PREMIUM_P2` 服務方案的訂閱（例如 P1、M365 E3）[3]。訪客另以每月活躍使用者計費 [3]。【事實】Microsoft 表示 P2 不會再新增任何 IGA 功能，新功能只進 Governance [3] | 【查不到】本次未取得 My Access 的語言清單 |
| SailPoint Identity Security Cloud（2026 起文件稱 Human Fabric） | 【事實】企業級 IGA [11] | 【事實】雲端服務（官方文件歸在 SaaS 文件集）[10] | 【查不到】無公開標價 | 【事實】支援 22 種語言，含 `Chinese (Traditional) \| 'zh-TW'` [13]；台灣合作夥伴：中飛科技（代理）、頤合資訊、凱信資訊、凌羣電腦 [14] |
| SailPoint IdentityIQ | 【事實】地端版 IGA；SailPoint 有 IdentityIQ 的 End of Life Policy 與往雲端遷移的工具 [17] | 地端 | 【查不到】 | 同上合作夥伴 [14]；【查不到】IdentityIQ 的確切終止支援日期（政策放在客戶入口網站，未公開）[17] |
| Saviynt Identity Cloud | 【事實】IGA 加應用程式層 SoD（SAP、Oracle、Workday 等內建規則集）[22] | 【事實】AWS Marketplace 列為 SaaS [22]。【查不到】是否仍有純地端版 | 【查不到】無公開標價；第三方文章舉例 5,000 人年約 12 萬美元（約每人每年 24 美元），未經證實 [22] | 【查不到】 |
| Okta Identity Governance | 【事實】Okta Workforce Identity 的加購，含 Access Governance、Lifecycle Management、Workflows [18] | 【推論】雲端服務（定價頁僅列訂閱方案）[18] | 【事實】年約最低 1,500 美元 [18]；套裝 Starter 6、Core Essentials 14、Essentials 17 美元／人／月，Professional 與 Enterprise 詢價（搜尋摘要）[18]。【查不到】治理單獨加購價 | 【事實】終端使用者介面有「繁體中文」；Admin Console 只有英、法、日文 [20] |
| One Identity Manager | 【事實】IGA；有地端版（版號 8.x–9.2）與代管版 Identity Manager On Demand – Starling Edition [23] | 地端或代管 [23] | 【查不到】無公開標價；使用者評論提到每授權每月約 6–7 美元，未經證實 [23] | 【事實】預設語言英文與德文；語言包含「Chinese」，未註明繁簡，且只影響 Web 介面 [23] |
| C1（原 ConductorOne，網域已轉到 c1.ai） | 【事實】模組：C1 Access（申請、JIT）、C1 Comply（複查、SoD、證據）、C1 Lifecycle，另有 MCP Gateway、LLM Gateway、Vault、Agents [24] | 【事實】雲端；「Advanced」級才有地端整合與連線 [24] | 【事實】不列價格，「Exact pricing scoped with you」；預設以 1,000 個受管身分起算 [24] | 【查不到】 |
| Opal | 【事實】存取申請、存取複查、風險中心；可由 Slack、Teams、CLI、MCP server 申請 [26] | 【事實】Opal Cloud；自架於 AWS EKS 或 GKE（Helm 或 KOTS）；支援 airgapped [26] | 【查不到】一般方案無標價；官網橫幅寫 Opal Zero 首年 3 萬美元，條款未核實 [27] | 【查不到】 |
| Lumos | 【事實】存取申請（AppStore）、存取複查、生命週期管理 [28] | 【查不到】（僅見雲端服務描述） | 【事實】定價頁沒有任何價格，只能預約展示 [28] | 【查不到】 |
| Veza | 【事實】Access Graph 加上 Access Requests、Access Reviews、Lifecycle Management [29]；2026-03-02 被 ServiceNow 收購完成 [30] | 【查不到】Access Hub 的地端部署文件 | 【查不到】 | 【查不到】 |
| Zluri | 【事實】IGA 模組：Access Requests、Access Reviews、Segregation of Duties；另有 SaaS 管理 [31] | 【查不到】 | 【事實】定價頁沒有價格 [31] | 【查不到】 |

#### 2.1.2 申請、核准、職責分離

| 產品 | 核准流程 | 申請人能否簽自己的單 | 職責分離（SoD） |
|---|---|---|---|
| Entra | 【事實】最多三階；每階「只要其中一位」核准；逾期自動拒絕；可設替代簽核人，但逾時至少要 4 天才能轉送 [1]。【事實】文件只「建議」各階與替代簽核人列不同的人（「Ensure that you list different sets of people」），不是系統強制 [1] | 【事實】「Approvers aren't able to approve their own access package requests.」[1] | 【事實】在 access package 上標記不相容的 access package 或群組；有衝突時使用者不能申請，「nor can an administrator make a new assignment that would be incompatible」。關係是單向的，要兩邊各設一次 [6]。【推論】粒度是整包權限，不是單一 entitlement；例外要另建一個合併的 access package [6] |
| SailPoint ISC | 【事實】依序升級的簽核鏈；預設 90 天無動作逾時（上限 90 天）；簽核人可轉派 [10] | 【事實】簽核鏈上若有人就是申請人，「that step may be automatically approved if the `autoApprove` field is set to do so」[10] | 【事實】兩個全域開關可讓系統「automatically cancel access requests with SoD conflicts」，也可逐條政策設定 [11]；違規清單與報表 [11] |
| Okta | 【事實】approval sequence 由依序的核准任務組成；文件未寫階數上限 [61] | 【事實】依核准人類型而不同：核准人是群組、群組擁有者、主管或代理人時，系統不會把任務指派給申請人本人，任務改為「unassigned」；但若管理員把某個特定使用者設為核准人，而他剛好就是申請人，「self-attestation is allowed」[61]。在 sequence 中則自動轉給下一位核准人，沒有人可轉時留待人工指派 [61] | 【事實】規則可設為允許、附條件允許、或封鎖；分 entitlement 規則與 group 規則 [19]。【事實】限制：衝突只在送出當下比對既有權限，短時間送多張或有多張未結申請時，「warnings won't appear to requesters or prevent them from requesting access to conflicting entitlements」，文件建議簽核前人工檢查 [19] |
| Saviynt | 【事實】可依風險自動拒絕、標記或加簽（廠商資料）[22] | 【查不到】 | 【事實】申請時做預防式 SoD 分析（廠商資料）[22]。【事實】2023 年社群討論：設定「高風險需填補償控制」後簽核人仍可不填就核准，版主確認為已知問題；現況未核實（論壇性質）[22] |
| One Identity Manager | 【事實】簽核流程可加入「compliance check」關卡，結果寫入簽核歷程；違規的申請只能走例外核准，由規則指定的例外核准人決定 [23] | 【事實】以參數 `QER \| ITShop \| PersonOrderedNoDecide`、`PersonInsertedNoDecide` 禁止下單人或建立人核准自己的申請；可逐流程設例外，且不適用於中央核准人群組 [23] | 【事實】合規規則加例外核准；可設定例外核准人不得核准自己的申請 [23] |
| C1 | 【事實】政策由依序步驟組成；簽核人可以是使用者、群組、主管、擁有者、CEL 運算式、webhook 或 AI agent [25] | 【事實】每個步驟有選項控制「a reviewer can complete a review that they are the subject of」；另有「Require distinct approvers」，啟用後前面簽過的人「cannot approve this step」[25] | 【事實】C1 Comply 列有 SoD [24]。【查不到】申請時是擋還是提示 |
| Opal | 【事實】管理員設定核准流程；可指派服務帳號或外部自動化為審核者，用 API 核准或拒絕 [26][27] | 【查不到】 | 【查不到】 |
| Lumos | 【事實】多階核准、break-glass、依職務或值班狀態預先核准（廠商資料）[28] | 【查不到】 | 【查不到】 |
| Veza | 【事實】主管、管理員、指定核准人；「multi-party, multi-level approval workflows prior to fulfillment」；可轉派、退回補件、依政策自動核准 [29] | 【查不到】 | 【查不到】申請當下的 SoD 檢查 |
| Zluri | 【事實】每個應用程式可設單一、依序多階、或群組（任一或全部）核准（廠商部落格）[31] | 【查不到】 | 【事實】SoD 只提示不擋：「Zluri shows the conflict as context. Approvers approve or reject as they judge appropriate.」需另購 SoD 模組並手動開啟 [31] |

#### 2.1.3 有期限的存取、定期複查、偵測未經核准的變更

| 產品 | 有期限／JIT | 定期複查 | 偵測未經核准的權限（對帳） |
|---|---|---|---|
| Entra | 【事實】到期可設日期、天數（0–3660）、小時或永不；可允許延長並要求延長也須核准；允許延長時，到期前 14 天與 1 天寄信提醒 [2] | 【事實】可單階或最多三階；審核人可選群組擁有者、指定人員、主管，或「Users review their own access」；無人回應時可設不變、移除、核准或採系統建議；可要求填理由 [8] | 【事實】Azure Monitor 活頁簿「Application role assignment activity」可列出不是由 entitlement management 產生的角色指派 [6]。【推論】要另外把稽核事件送到 Azure Monitor，屬於報表而不是自動處置 |
| SailPoint ISC | 【查不到】本次取得的頁面只提到 sunset date 提醒信 [10] | 【事實】certification campaign（搜尋摘要）[11] | 【事實】Native Change Detection：「detects when accounts have been created, updated, or deleted out-of-band」，在 aggregation 時比對；可觸發事件、用範本流程自動撤銷並通知來源擁有者 [12] |
| Okta | 【查不到】 | 【事實】Access Certifications 可複查並處理有 SoD 衝突的既有權限 [19] | 【查不到】 |
| One Identity Manager | 【查不到】 | 【事實】attestation 可排程或隨時發動，對象包含權限、申請與例外核准 [23] | 【查不到】 |
| C1 | 【事實】授權可設期間上限（Terraform 以秒數字串設定）；到期後回到可申請狀態（搜尋摘要）[25] | 【事實】C1 Comply 含 access reviews、evidence、remediation [24] | 【查不到】 |
| Veza | 【事實】「Enforced auto-expiration」；申請人可在政策範圍內自訂到期時間 [29] | 【事實】Access Reviews 產品（搜尋摘要）[29] | 【查不到】 |
| Zluri | 【事實】申請表單帶期間（永久或有期限）；屬授權層級的期限，不是連線層級的即時提權（廠商部落格）[31] | 【事實】多階複查，每階要不同的主要審核人（廠商部落格）[31] | 【查不到】 |
| Lumos | 【事實】時間到自動收回（廠商資料）[28] | 【事實】可只複查上次以來的變動（廠商資料）[28] | 【查不到】 |

#### 2.1.4 證據、稽核紀錄、對外 API

| 產品 | 稽核紀錄的保存與防竄改 | 對外 API |
|---|---|---|
| Entra | 【事實】稽核紀錄 Free 7 天、P1 與 P2 都是 30 天；要更久須送到 Azure 儲存體或用 Purview Audit (Premium) [5]。【查不到】雜湊鏈或可驗證匯出 | 【事實】Microsoft Graph 可設定不相容關係、資源角色、建立 access review（`EntitlementManagement.ReadWrite.All`、`AccessReview.ReadWrite.All`）[6][7][8] |
| SailPoint ISC | 【事實】SoD 政策的建立、更新、刪除會產生稽核事件；native change 有稽核事件可查 [11][12]。【查不到】防竄改機制 | 【事實】approval config API、Forward Access Request API、Native Change Detection API、事件觸發 [10][12] |
| Okta | 【事實】Past Access Requests (Conditions) 報表可看有 SoD 衝突的申請 [19]。【查不到】防竄改機制 | 【事實】Okta Support 文章提到 Identity Governance API 仍為 beta（搜尋摘要）[19] |
| C1 | 【事實】工作項有 audit log，API 可列出某工作的 audit trail 事件；政策規則可匯出 CSV [25]。【查不到】防竄改機制 | 【事實】REST API、Terraform [25] |
| Opal | 【事實】可把事件串流到 DataDog、SumoLogic 等；官網稱每個存取變更與管理動作都可匯出到 SIEM 或 S3 [26][27]。【查不到】防竄改機制 | 【事實】REST API、Terraform、MCP server [26] |
| Veza | 【查不到】資料表未描述稽核紀錄機制 [29] | 【查不到】 |
| EmpowerID（補充：唯一查到宣稱雜湊鏈的 IGA 廠商） | 【事實】2026-08 白皮書：「Alterations break hash chains; truncation fails checkpoints — when the verifier is actually run」（白皮書自己註明：要有人實際執行驗證才有效）「Exported records verify against published keys without trusting the vendor console」；同頁聲明核准與存取複查程序「remain the customer's」[57]。屬廠商宣稱，未獨立驗證 | 【查不到】 |

【推論】查到的 IGA 產品都是把核准結果「寫進」目標系統（開通帳號、加入群組），沒有查到任何一個提供「其他系統即時來問：這個主體現在能不能做這件事」的判定介面。這是本平台第 11 節 `check` 與現有產品在結構上的差別。

### 2.2 資料存取治理

| 產品 | 申請的粒度 | 核准方式 | 期限 | 核准與實際設定的關係 | 紀錄 | 部署與現況 |
|---|---|---|---|---|---|---|
| Immuta（Request app） | 【事實】資料庫、schema、資料表、整個 data product，或「a masking exception to view unmasked data within specific columns」[32] | 【事實】審核流程可分支；人工審核可設 Any 或 All；審核人來自指定使用者、群組、屬性、權限或目錄擁有者（目錄擁有者目前只支援 Atlan）[32]。【查不到】是否禁止自己核准自己 | 【事實】可要求核准的存取必須是暫時的並設最長期間；多位審核人選不同期間時取最短 [32] | 【事實】核准後自動開通或解除該欄位的遮罩 [32]。【事實】判定用的是當下的資格，之後資格被移除不會撤銷已給的存取 [32] | 【事實】「By default, Immuta audit logs expire after 7 days」；事件存在客戶設定的 Elasticsearch 或 OpenSearch，供客戶自行匯出 [33]。【未查證】匯出到 S3 或 ADLS Gen2 的細節（UAM 頁未寫，原稿依搜尋摘要）。【查不到】防竄改機制 | 【事實】SaaS（北美與歐洲區域）與自架（Kubernetes 1.29–1.35、PostgreSQL 15+；版本 2026.1）（搜尋摘要）[33]。部分文件頁註明 Marketplace app 為 private preview [33] |
| Databricks Unity Catalog — Request for Access | 【事實】Unity Catalog 物件上的權限（如 SELECT），可替自己、服務主體、他人或群組申請；文件未提列或欄層級 [34] | 【事實】申請送到設定的目的地（email、Slack 等，各上限 5 個）；審核者接受時是把主體加入群組或直接授權；「any user who opens the review link and signs in to the workspace can decline it」[34]。【事實】核准時會檢查審核者權限 [34]。【事實】2025-08-20 以 Public Preview 發表；Azure Databricks 文件頁仍標 Public Preview，未查到 GA 公告 [34] | 【事實】文件未提授權期限；未處理的申請 7 天過期，email 目的地在第 3 天提醒 [34] | 【事實】審核者選擇「加入群組」或「直接授權」[34]。【已更正】原稿寫「授出的內容不受申請內容約束」，文件並未這樣寫，只是沒有說明授出內容必須等於申請內容；改列【推論】：文件未描述兩者的一致性檢查。【事實】在 Databricks 外完成的核准不會匯入，顯示為「Managed externally」[34] | 【事實】申請保留 365 天；事件寫入 audit log [34] | 雲端（平台原生功能） |
| Snowflake — organizational listing 的 request approval workflow | 【事實】listing 層級，綁角色；「cannot be used to grant access to roles and users」；文件未提列或欄 [35] | 【事實】單一決定（Grant 或 Deny）；核准人須對該 listing 有 OWNERSHIP 或 MODIFY [35]。2025-05-30 GA [35] | 【事實】文件未提期限 [35] | 【事實】核准人可以授予和申請不同的角色 [35]。【事實】走外部流程時，Snowflake 不會把外部工單系統的核准同步回來（搜尋摘要）[35] | 【事實】Provider Studio 的 Resolved requests；`OBJECT_ACCESS_REQUEST_HISTORY` 可查（搜尋摘要）[35] | 雲端 |
| Snowflake — Request Access in Workspaces | 【事實】由 SQL 權限錯誤觸發；只能申請 account role，建議的角色僅供參考 [36] | 【事實】由 ACCOUNTADMIN 或 SECURITYADMIN 審核 [36] | 【事實】可設結束時間，但只適用「角色授予使用者」；授予既有角色時不能帶期限，且會讓持有該角色的所有人都得到權限 [36] | 【事實】審核者自行決定授什麼 [36] | 【事實】History 檢視；文件未描述稽核紀錄 [36] | 雲端 |
| Snowflake — Multi-party Approval（管理操作，不是資料存取） | 【事實】停用 MFA、授予或撤銷管理角色、變更網路或驗證政策等 [37] | 【事實】最低核准數預設 2（1–20）；申請人自己的核准是否計入門檻，預設為 true [37] | 【事實】申請有效 1–14 天（預設 3）；核准後 3 天內可執行一次 [37] | 【事實】核准的操作只能執行一次 [37] | 【事實】`MULTI_PARTY_APPROVAL_REQUESTS` 等檢視 [37] | 【事實】需 Business Critical 以上版本 [37] |
| Satori | 【事實】資料集層級的自助申請；可核准暫時或永久存取（廠商資料，多為 2021 年）[38] | 【事實】由資料所屬單位核准；可設定免核准的對象 [38] | 【事實】JIT 與時間到自動失效 [38] | 【查不到】 | 【事實】每筆申請、核准、拒絕都留紀錄（廠商資料）[38] | 【事實】2025 年被 Commvault 收購並完成交割 [38] |
| Privacera（2026-03-09 起為 Trust3 AI by Privacera） | 【查不到】現行產品的申請核准文件 | 【事實】2023 年的 Governed Data Stewardship 是把申請經 API 轉給服務管理系統與資料管理員（新聞稿）[39] | 【查不到】 | 【查不到】 | 【查不到】 | 【事實】重新定位為 AI agent 治理平台 [39] |
| Collibra | 【事實】資料目錄中的資產，透過 Data Basket 申請 [40] | 【事實】Request Assets Access 流程：所有資料擁有者都要核准，任一人拒絕即拒絕；核准後交給技術管理員去提供資料 [40] | 【查不到】 | 【事實】核准與開通是分開的人工作業；可由流程呼叫外部 API 開通 [40] | 【事實】每次申請建立一個 Data Usage 資產 [40] | 【查不到】Collibra Protect 在此流程的角色 |
| BigID | 【事實】定位是找出過度授權並撤銷，不是申請核准 [41] | 【查不到】正式的申請核准流程 | — | — | 【查不到】 | 【查不到】地端部署 |
| ALTR | 【事實】Snowflake 上的資料存取申請 [42] | 【事實】核准時自動建立 access management policy；撤銷就是刪除該 policy [42] | 【查不到】 | 【事實】核准即產生政策，由同一系統執行 [42] | 【事實】Access Requests audit log 記錄申請內容、決定與時間 [42]。【查不到】防竄改機制 | 雲端 |

【推論】資料平台的原生功能解決的是「怎麼把申請送到擁有者手上」，核准人資格、內容版本、期限、對帳都留給使用者自己處理。本平台的 `data_access` 流程包若能把核准結果用通用介面交給這些平台執行，並把實際設定對回來，正好補上這一段。

### 2.3 特權存取（簡述）

| 產品 | 核准 | 期限 | 紀錄 | 備註 |
|---|---|---|---|---|
| Teleport | 【事實】「users cannot approve their own requests」；可設核准與拒絕門檻，例如需兩位審核者（dual authorization）[43] | 【事實】提權有時間限制 [43] | 【事實】事件可存 DynamoDB 等，連線錄影存 S3；文件要求 S3 開啟 versioning，使錄影不能被永久竄改或刪除（搜尋摘要）[43]。【查不到】事件紀錄本身的完整性驗證 | 【事實】Access Requests 屬 Teleport Enterprise；計價以每月活躍使用者為主，自架、混合、雲端皆可（搜尋摘要）[43] |
| CyberArk（2026 起品牌為 Palo Alto Networks Idira） | 【事實】Master Policy 強制 dual control 時須先提出申請，需幾位確認者由 Master Policy 定義（大學知識庫，第二手）[44] | 【查不到】 | 【事實】廠商資料稱稽核紀錄與連線錄影存放在「tamper-proof vault」[44]。【查不到】技術機制 | 【事實】Palo Alto Networks 於 2026-02-11 宣布完成收購 [44] |
| BeyondTrust（Entitle、Password Safe） | 【事實】Entitle 的核准流程可依核准人、資源擁有者、直屬主管、值班表或 Jira 工單決定 [45] | 【事實】預設為暫時存取，管理員設最長期間 [45] | 【事實】產品頁稱提供「signed audit logs」[45]。【查不到】簽章機制的文件 | 【查不到】Password Safe 的核准設定文件 |

### 2.4 AI agent 與非人類身分：2025–2026 動向

| 時間 | 事件 | 來源 |
|---|---|---|
| 2025 | OWASP 發布 Non-Human Identities Top 10，第一名是 NHI1 Improper Offboarding（不再需要的服務帳號與金鑰沒有被移除）| [52] |
| 2025 下半年 | Commvault 收購 Satori Cyber 並完成交割 | [38] |
| 2026-01-27 | CSA 與 Oasis Security 調查（383 份回覆，2025 年 8–9 月線上問卷）：92% 對既有 IAM 管理 AI 與非人類身分風險沒有信心；78% 沒有建立 AI 身分的政策 | [51] |
| 2026-02-05 | NIST NCCoE 發布軟體與 AI agent 身分與授權概念文件，徵詢識別、授權、稽核與不可否認性；意見徵詢至 2026-04-02，預計產出 SP 1800 系列實務指引 | [53] |
| 2026-02-11 | Palo Alto Networks 完成收購 CyberArk | [44] |
| 2026-03-02 | ServiceNow 完成收購 Veza | [30] |
| 2026-03-09 | Privacera 改名 Trust3 AI，定位為 agentic governance 平台 | [39] |
| 2026-04 至 05 | Microsoft Entra Agent ID 正式上市；agent 身分須有人類 sponsor，可用 access package 取得群組、API 權限與 Entra 角色；Agent 365 每人每月 15 美元，Microsoft 365 E7 每人每月 99 美元 | [3][4][9] |
| 2026-04-29 | Okta for AI Agents 正式上市；Cross App Access 成為 MCP 的 Enterprise-Managed Authorization 擴充 | [21] |
| 2026-05-11 | SailPoint 發布 Agentic Fabric；10 月加入 agent kill switch 與 shadow AI 探索 | [16] |
| 2026-05 | Palo Alto Networks《2026 Identity Security Landscape》（2,930 位受訪者）：機器身分與人類身分平均 109:1 | [50] |
| 2026-09 | Opal 發布 Opal Zero（AI agent 的 JIT 存取治理） | [27] |
| 查閱當日 | C1 的定價頁已把 MCP Gateway、LLM Gateway、Vault、Agents 列為產品模組（上市日期未查到） | [24] |

【事實】Microsoft 的授權表顯示，agent 身分用的是同一套機制（access package、多階核准、到期），只是多了「sponsor」這個人類負責人角色，並另外計價 [3]。
【推論】主流廠商沒有為 agent 另造一套簽核，而是把 agent 當成另一種主體，套用既有的申請、核准、到期，再加上「一定要有人類負責人」。本平台的主體模型若一開始就容納非人類主體與負責人，就不必日後改核心。

### 2.5 缺口分析：對照四個稽核問題

判定標準（比照 platform-vision.md）：

- **Q1 誰決定且有資格**：職責分離由引擎強制，申請人不能簽自己的單，設定繞不過去。
- **Q2 內容一致**：簽核綁定內容版本，核准後變更會產生新版本，擴大要重簽。
- **Q3 驗證與存續**：執行後驗證、有效期自動失效、負責人、撤銷、對帳。
- **Q4 紀錄防竄改**：只增不改、雜湊鏈、記錄當時的規則與參數。

「有」表示文件顯示該項是預設且不可關閉；「部分」表示有相關功能但可關閉、有已知漏洞或只涵蓋一部分；「沒有」表示文件顯示相反的行為；「未查到」表示沒有找到依據。

| 產品 | Q1 誰決定且有資格 | Q2 內容一致 | Q3 驗證與存續 | Q4 紀錄防竄改 |
|---|---|---|---|---|
| Microsoft Entra ID Governance | **部分**：申請人不能核准自己的申請 [1]；不相容關係連管理員直接指派也擋 [6]；但每階任一人即可、未見「各階不同人」規則 [1]；複查可設「使用者審自己」[8] | **沒有**：access package 的資源可隨時變更，「Any identity with existing assignments ... will automatically become members」，不需重簽 [7] | **部分**：到期、延長須核准、複查 [2][8]；非經核准的指派要靠活頁簿報表 [6]；未見執行後驗證 | **沒有**：稽核紀錄預設 30 天，須自行匯出 [5]；未查到完整性驗證 |
| SailPoint Identity Security Cloud | **部分**：可全域封鎖 SoD 衝突的申請 [11]；但簽核人即申請人時可設自動核准 [10] | **未查到** | **部分**：native change detection 可偵測並自動撤銷平台外的變更 [12]；未見執行後驗證 | **未查到** |
| Okta Identity Governance | **部分**：SoD 可封鎖，但多張申請並行時檢查會漏 [19]；群組、主管、代理人型核准人不會被指派給申請人本人，但指定特定使用者為核准人時允許自我核准 [61] | **未查到** | **部分**：certification 可處理衝突 [19]；期限未查到 | **未查到** |
| Saviynt | **部分**：預防式 SoD（廠商資料）；論壇回報補償控制可被略過（2023）[22] | **未查到** | **未查到** | **未查到** |
| One Identity Manager | **部分**：以參數禁止下單人核准自己的申請，並有合規檢查關卡與例外核准人；但屬可設定項，可逐流程設例外 [23] | **未查到** | **部分**：attestation 涵蓋權限、申請、例外核准 [23] | **未查到** |
| C1（ConductorOne） | **部分**：有「Require distinct approvers」與自我審核開關，皆為選項 [25] | **未查到** | **部分**：授權期間上限、複查 [24][25] | **未查到**：有 audit trail API，未見完整性機制 [25] |
| Opal | **未查到** | **未查到** | **未查到**（官網提到 JIT 與複查，未取得文件細節）[26] | **未查到**：可串流到 SIEM 或 S3 [26][27] |
| Lumos | **未查到** | **未查到** | **部分**：時間到自動收回、複查（廠商資料）[28] | **未查到** |
| Veza | **部分**：多方多階核准 [29]；自我核准與申請時的 SoD 未查到 | **未查到** | **部分**：強制自動到期 [29] | **未查到** |
| Zluri | **部分**：SoD 只提示，簽核人可照樣核准 [31] | **未查到** | **部分**：授權層級的期限、多階複查（廠商部落格）[31] | **未查到** |
| Immuta | **部分**：Any 或 All 審核；未查到禁止自我核准 [32] | **部分**：核准後由同一系統自動套用 [32]；申請內容版本未查到 | **部分**：暫時核准與最長期間；但資格事後被移除不會撤銷 [32] | **沒有**：稽核紀錄預設 7 天過期，須匯出 [33] |
| Databricks Unity Catalog RFA | **沒有**：單步；任何開啟連結並登入的人都能拒絕；核准人就是通知目的地的收件者 [34] | **未查到（不利跡象）**：平台外的核准不匯入 [34]；授出內容是否須等於申請內容，文件未說明（原稿標「沒有」，查證後降級） | **沒有**：文件未提授權期限 [34] | **未查到**：申請保留 365 天、有 audit log [34] |
| Snowflake（listing 核准流程與 Workspaces 申請） | **部分**：須有特定權限才能核准；單一決定 [35][36] | **沒有**：核准人可授予不同角色；建議角色僅供參考 [35][36] | **部分**：只有「角色授予使用者」可帶期限 [36] | **未查到** |
| Satori | **未查到** | **未查到** | **部分**：JIT、自動失效（廠商資料）[38] | **未查到** |
| ALTR | **未查到** | **部分**：核准即自動建立政策 [42] | **未查到** | **未查到** [42] |
| Collibra | **部分**：所有資料擁有者都要核准 [40] | **沒有**：核准後由技術管理員另行人工提供 [40] | **未查到** | **未查到** |
| Teleport（特權存取） | **有（限其範圍）**：不能核准自己的申請、可設雙人門檻 [43] | **未查到** | **部分**：有時限的提權 [43] | **部分**：錄影靠 S3 versioning；事件紀錄完整性未查到 [43] |
| CyberArk（特權存取） | **部分**：dual control，確認人數由政策定義（第二手來源）[44] | **未查到** | **未查到** | **部分**：廠商稱「tamper-proof vault」，機制未查到 [44] |
| BeyondTrust Entitle（特權存取） | **未查到** | **未查到** | **部分**：預設暫時存取、最長期間 [45] | **部分**：廠商稱「signed audit logs」，機制未查到 [45] |

**跨產品觀察**

- 【事實】Q2 這一欄沒有任何產品被標為「有」；文件明確顯示反例的有兩個（Entra 的 access package 變更自動套用到既有指派、Snowflake 核准人可改授不同角色）[7][35]；Databricks 只確認平台外的核准不會匯入 [34]。
- 【事實】Q3 的「執行後驗證」（核准後實際測一次設定是否與核准相符）在所有查到的文件中都沒有出現。最接近的是 SailPoint 的 native change detection（事後偵測平台外的變更）[12] 與 Entra 的活頁簿報表 [6]。
- 【事實】Q4 沒有任何主流 IGA 或資料治理產品在公開文件中說明雜湊鏈或可獨立驗證的匯出；只有 EmpowerID 的白皮書與 BeyondTrust Entitle 的產品頁有這類宣稱 [45][57]。
- 【推論】市場把這四件事拆給不同產品：IGA 管「誰能申請、誰核准、多久複查」，資料平台管「怎麼授權」，SIEM 或儲存體管「紀錄保存」。稽核要的是把四件事串成同一條證據鏈，這段銜接目前要使用者自己做。

### 2.6 中型企業（數百到數千人）且需要地端部署：選擇與痛點

#### 可選產品

| 產品 | 地端可行性 | 對中型企業的問題 |
|---|---|---|
| One Identity Manager | 【事實】有地端版 [23] | 【查不到】公開價格；【事實】預設語言英、德文，中文語言包只影響 Web 介面 [23] |
| SailPoint IdentityIQ | 【事實】地端版；台灣有 4 家合作夥伴 [14] | 【事實】廠商有終止支援政策並主推遷往雲端，2026-06 推出免費的遷移工具 [17]；【查不到】確切終止日期與價格 |
| Evolveum midPoint | 【事實】開源；含申請核准、存取認證、SoD（廠商資料表與 KuppingerCole 評述）[55]。【推論】開源軟體可自行部署在地端 | 【事實】官方不公開訂閱價，須洽廠商或夥伴 [55]；【推論】需要自有的導入與維運人力 |
| ManageEngine ADManager Plus | 【事實】授權以 XML 檔交付、依網域計價（Standard 595 美元起、Professional 795 美元起，年繳）；Professional 版才有 Workflow；存取認證與風險評估在 Governance, Risk and Compliance 加購（495 美元）[54]。【查不到】定價頁未寫明部署方式 | 【推論】以 Active Directory 為中心，不是通用的申請核准平台 |
| Opal（自架） | 【事實】EKS 或 GKE，支援 airgapped [26] | 【推論】需要 Kubernetes 維運能力；【查不到】價格與繁體中文 |
| Microsoft Identity Manager 2016 | 【事實】地端 | 【事實】支援終止日 2029-01-09（由 2026-01-13 延後），主流支援已於 2021-01 結束 [56] |
| Immuta（自架，資料存取） | 【事實】Kubernetes 自架 [33] | 【推論】只涵蓋資料存取；Request app 部分仍在 preview [33] |
| Teleport（自架，特權存取） | 【事實】自架可用 [43] | 【推論】只涵蓋基礎設施存取 |
| Microsoft Entra ID Governance、Okta、C1、Lumos、Zluri、Saviynt | 【事實】雲端服務，地端系統靠代理程式或連接器連回雲端 [3][24] | 【推論】治理資料與稽核紀錄存放在廠商雲端，不符合「必須地端」的要求 |

#### 痛點（有調查數據者）

| 痛點 | 數據 | 來源性質 |
|---|---|---|
| 人工作業 | 84% 主要靠人工做存取複查與開通；不到 6% 完全自動化 | Zilla Security《2025 State of IGA》，300 位身分管理主管，廠商調查 [46] |
| 整合困難 | 83% 說與既有 IGA 系統整合困難是自動化的最大障礙 | 同上 [46] |
| 角色難維護 | 90% 無法準確定義與維護角色 | 同上 [46] |
| 過度授權 | 超過 52% 的組織表示稽核時複查的權限有超過 11% 是多餘、無主或過量的 | 同上 [46] |
| 成本 | 近 60% 認為現有 IGA 的主要缺點是總持有成本過高；超過一半把耗時的人工流程列為投資 IGA 的第一或第二原因；近四成尚未導入 SaaS 型 IGA | Omada《State of IGA 2025》，500 多位 IT 與業務主管，廠商調查 [47] |
| 複查沒有業務單位參與 | 81% 以人工做存取複查；41% 由 IT 自己做、沒有業務使用者參與 | Netwrix，590 位 IT 人員，2022 年（資料較舊）[49] |
| 管理層看到的與實際不符 | 儀表板顯示複查準時完成、稽核發現已處理，但身分問題仍出現在事故調查與稽核報告中 | Omada《State of Identity Governance 2026》，近 600 位受訪者；IDSA 部落格轉述，沒有對應的百分比 [48] |
| 導入與維運人力 | 專業服務約為首年授權費的 30%–60%；中型組織養不起 2 名以上全職人員維護平台 | Zluri 部落格（競品廠商的行銷文章，僅作佐證）[58] |

【事實】Gartner 2026-03 的研究摘要把「light IGA」描述為部署快、負擔低，但缺少完整治理能力，建議先盤點所有合規與治理需求再選 [59]。
【推論】中型且需地端的公司處在一個空檔：完整的 IGA（One Identity、IdentityIQ）對這個規模偏重且價格不透明，輕量的新產品又幾乎都是雲端。這些公司的現況多半是簽核系統加上試算表，正是 platform-vision.md 開頭描述的問題。

【事實】台灣在地監理動向：金管會 2025-12-30 發布「金融資安韌性發展藍圖」，為期 4 年、4 大構面 29 項措施，零信任架構列在「全域防護」構面 [62]。經濟日報報導零信任預計約 4 年逐步落地為「自律規範，並非強制規定」[62]；iThome 另以「從鼓勵轉為必備」形容，並列出系統維運管理、應用系統管理等六個優先導入場域（搜尋摘要，原頁回應 403，未逐頁核對）[62]。兩家媒體說法有落差，以「監理方向明確、尚無強制時程」理解較穩妥。【推論】零信任的「最小權限、持續驗證」會讓金融業客戶更常被問到「權限是否經核准、是否仍需要」，對本平台是需求面的順風，但不能當作法規強制依據寫進銷售文件。

【查不到】台灣中型企業身分治理現況的公開數據。SailPoint 有一份台灣調查（2023-12-27 發布，調查台灣千大企業中 200 家大型企業的資安部門），但公開頁面沒有揭露數字，要下載報告，且對象是大型企業 [15]。

---

## 3. 對產品的含意

### 必須有

| # | 需求 | 依據 |
|---|---|---|
| M1 | 職責分離由引擎強制，不提供關閉選項：申請人不能簽自己的單、各關不同人；多張申請同時在途時也要正確比對（把在途申請算進去）。 | 結論 2；Q1 欄沒有一個通用產品做到預設且不可關 [10][19][31][37] |
| M2 | 簽核綁定內容版本：核准後任何修改都產生新版本，擴大範圍必須重簽；被包裝成「角色」或「套件」的權限，內容變動要視為既有授權的變更。 | 結論 3；Entra 與 Snowflake 的反例 [7][35] |
| M3 | 授權預設有期限、有負責人、可撤銷；到期自動失效，並通知下游系統。 | 結論 5；Databricks 與 Snowflake 原生功能缺期限 [34][35][36] |
| M4 | 執行後驗證：核准的內容交付執行後，實際測試設定是否與核准相符，結果留紀錄。 | 結論 1；所有查到的文件都沒有這一步，是最清楚的差異點 |
| M5 | 稽核紀錄只增不改、雜湊鏈串接、匯出後可由第三方獨立驗證；保存期間由客戶決定，不依賴外部儲存服務。 | 結論 4；Entra 30 天、Immuta 7 天 [5][33] |
| M6 | 對帳介面：下游系統回報實際權限，平台找出「沒核准卻存在」「超出核准範圍」「核准了卻沒設定」。 | 結論 5；Databricks 與 Snowflake 都不會把平台外的核准或設定同步回來 [34][35]；SailPoint 的 native change detection 證明這是既有需求 [12] |
| M7 | 通用的判定與查詢介面（`check`、`grants`、事件通知），讓下游系統把本平台當作「現在誰可以做什麼」的依據。 | 2.1.4 的推論：查到的產品都是寫入式開通，沒有即時判定介面 |
| M8 | 權限描述要能表達欄位與列層級的限制條件，且與領域無關。 | 結論 5；只有 Immuta 支援欄位層級申請 [32] |
| M9 | 可完全地端部署，不需連到廠商雲端；介面與通知為繁體中文。 | 結論 7、10 [13][20][56] |
| M10 | 主體模型容納非人類身分（服務帳號、AI agent），且每個非人類主體必須有人類負責人；負責人異動或離職時，授權進入待確認或失效。 | 結論 9；Microsoft 的 sponsor 模型 [3][9]；OWASP NHI1 [52] |

### 應該有

| # | 需求 | 依據 |
|---|---|---|
| S1 | 定期複查：無人回應時預設升級或撤銷（不是預設保留）；必填理由；禁止審自己的權限。 | Entra 把「無回應」與「使用者審自己」做成選項 [8]；41% 的複查沒有業務參與 [49] |
| S2 | 職責分離衝突在申請時就讓申請人與簽核人看到；例外要走獨立的例外核准人，且有較短的有效期並列入複查。 | One Identity 的例外核准 [23]；Entra 建議以較短到期與較頻繁複查處理例外 [6] |
| S3 | 緊急或短時效授權：以小時計的有效期、雙人核准、事後強制複查。 | Teleport、CyberArk 的 dual authorization [43][44]；Entra 支援以小時到期 [2] |
| S4 | 與既有 IGA 並存：把 Entra、Okta、SailPoint 等當作執行端或人員來源，透過它們的 API 開通，再用對帳核對。 | 83% 說整合是最大障礙 [46]；這些產品都有 API [6][10][25] |
| S5 | 證據包：一張申請單從申請到撤銷的完整鏈條可一次匯出，附驗證方式；另提供事件串流給 SIEM。 | 結論 4；Opal、Entra 都以匯出到 SIEM 為主要方式 [5][26] |
| S6 | 價格公開、計價單位簡單。 | 結論 6；多數競品不公開價格 [24][28][31]；近 60% 抱怨總持有成本 [47] |
| S7 | 導入不需要專職平台工程師：流程包以資料描述，附模擬環境與範例整合。 | 2.6 的痛點 [46][47][58] |
| S8 | 對帳發現的未核准權限，可設定自動處置（通知負責人、開補單、或要求下游撤銷）。 | SailPoint 的自動撤銷流程範本 [12] |

### 可以不做

| # | 不做的項目 | 理由 |
|---|---|---|
| C1 | 完整的身分生命週期（到職、調動、離職的自動開通）與大量現成連接器。 | 既有 IGA 的主場；以 S4 並存即可 [3][11] |
| C2 | 角色探勘、機器學習的核准建議、以 AI agent 當審核者。 | 與「決定可問責」的定位相衝；競品已在做 [3][25] |
| C3 | 密碼保管、連線側錄、連線層級的即時提權。 | PAM 產品的範圍 [43][44][45] |
| C4 | 資料探索與分類、過度授權掃描。 | BigID、Immuta 的範圍 [32][41] |
| C5 | SaaS 授權與費用管理。 | Zluri、Lumos 的附帶功能 [28][31] |
| C6 | MCP Gateway、LLM Gateway、agent 行為監控。 | 2026 年各家剛推出，標準未定 [16][21][24]；本平台只需把 agent 當主體（M10） |
| C7 | 拖拉式流程設計器。 | 已列為第一版範圍外；流程屬控管規則，變更應走有紀錄的升版 |

---

## 4. 不確定或查不到的事項

**查不到**

1. 各 IGA 產品（SailPoint、Okta、Saviynt、C1、Opal、Lumos、Veza、Zluri）稽核紀錄的防竄改機制。未找到任何官方文件說明；不代表沒有，可能只是不公開。
2. SailPoint、Saviynt、One Identity、C1、Lumos、Zluri、Opal、Veza、Immuta、Evolveum 的價格。皆須詢價；文中的第三方數字未經證實。
3. Okta Identity Governance 單獨加購的價格、核准階數、是否禁止自我核准。
4. SailPoint IdentityIQ 的終止支援日期（政策在客戶入口網站 Compass）。
5. Saviynt 是否仍提供純地端版本；是否禁止自我核准。
6. One Identity Manager 語言包的中文是繁體還是簡體；在台灣的代理與支援。
7. Microsoft Entra My Access 入口的語言清單；Entra、Okta、Saviynt、One Identity、C1、Opal、Lumos、Zluri、Immuta 在台灣的在地支援。
8. Veza Access Hub 的地端部署文件；被 ServiceNow 收購後的獨立銷售方式。
9. Privacera（Trust3 AI）現行產品的申請核准功能文件。
10. Collibra Protect 與申請流程的關係；BigID 是否有正式的申請核准流程與地端部署。
11. CyberArk dual control 的官方文件原文（只取得大學知識庫的轉述）；CyberArk 與 BeyondTrust 稽核紀錄防竄改的技術機制。
12. 台灣中型企業身分治理與權限申請現況的調查數據。
13. 存取複查中「橡皮圖章」比例或審核者耗時的可靠調查數字。
14. Gartner《2026 Market Guide for IGA》（2026-08-28）與《Peer Lessons Learned for IGA Solution Implementation》（2026-04）的內文與導入失敗率，須有 Gartner 帳號。

**不確定**

1. Okta 套裝價格（6／14／17 美元）、Agent 365 價格（15 美元）、Teleport 的計價方式，都只取得搜尋摘要，未逐頁核對。（Databricks RFA 的 Public Preview 狀態與 Immuta 稽核紀錄 7 天已於查證時以原頁確認，見第 6 節。）
2. 第 5 節標為「搜尋摘要」的來源，其引句可能經過改寫，引用前應回到原頁確認。
3. 2.5 表中「未查到」多數出於文件未涵蓋，而非產品確定沒有；用於對外比較前，應向廠商查證或實測。
4. 廠商調查（Zilla、Omada、Palo Alto Networks、CSA 與 Oasis）的樣本以北美與歐洲大型組織為主，未必代表台灣中型企業。
5. Saviynt「補償控制可被略過」是 2023 年的論壇回報，現行版本是否已修正未知。
6. 多數雲端文件頁面持續更新；本文反映 2026-11-19 當天的內容。Snowflake Workspaces 申請與 Multi-party Approval 的頁面未標示 preview 或 GA。

---

## 5. 來源

查閱日期皆為 2026-11-19。

| # | 標題 | 網址 | 取得方式 |
|---|---|---|---|
| 1 | Microsoft Learn — Change approval settings for an access package in entitlement management（ms.date 2025-06-26，更新 2026-04-09） | https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-approval-policy | 直接開啟 |
| 2 | Microsoft Learn — Change lifecycle settings for an access package（更新 2026-04-09） | https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-lifecycle-policy | 直接開啟 |
| 3 | Microsoft Learn — Microsoft Entra ID Governance licensing fundamentals（ms.date 2026-07-29，更新 2026-11-17） | https://learn.microsoft.com/en-us/entra/id-governance/licensing-fundamentals | 直接開啟 |
| 4 | Microsoft — Microsoft Entra plans and pricing（en-us） | https://www.microsoft.com/en-us/security/business/microsoft-entra-pricing | 直接開啟 |
| 5 | Microsoft Learn — Microsoft Entra data retention（ms.date 2026-01-06） | https://learn.microsoft.com/en-us/entra/identity/monitoring-health/reference-reports-data-retention | 直接開啟 |
| 6 | Microsoft Learn — Configure separation of duties for an access package（更新 2026-04-09） | https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-incompatible | 直接開啟 |
| 7 | Microsoft Learn — Change resource roles for an access package（更新 2026-10-06） | https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-resources | 直接開啟 |
| 8 | Microsoft Learn — Create an access review of groups and applications（ms.date 2026-03-12） | https://learn.microsoft.com/en-us/entra/id-governance/create-access-review | 直接開啟 |
| 9 | Microsoft Learn — What's new in Microsoft Entra Agent ID；Microsoft Entra Agent ID 產品頁；Redmond Magazine〈Microsoft Agent 365 goes live as company unveils E7 suite〉（2026-05-01） | https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id ；https://www.microsoft.com/en-sg/security/business/identity-access/microsoft-entra-agent-id ；https://redmondmag.com/articles/2026/05/01/microsoft-agent-365-goes-live-as-company-unveils-e7-suite.aspx | 搜尋摘要 |
| 10 | SailPoint Identity Security Cloud 文件 — 存取申請的 approval settings | https://documentation.sailpoint.com/saas/help/requests/config_approval_settings.html | 直接開啟 |
| 11 | SailPoint 文件 — Separation of Duties；Preventing Policy Violations；SailPoint 社群 FAQ〈How can we leverage SoD and governance policies〉 | https://documentation.sailpoint.com/saas/help/sod/index.html ；https://documentation.sailpoint.com/saas/help/sod/prevent-violations.html ；https://community.sailpoint.com/t5/Customer-Success-Engineering-FAQ/How-can-we-leverage-SoD-and-governance-policies-in-IdentityNow/ta-p/237066 | 前兩頁直接開啟；社群 FAQ 為搜尋摘要 |
| 12 | SailPoint 文件 — Managing Native Change Detection | https://documentation.sailpoint.com/saas/help/sources/native_change_detection.html | 直接開啟 |
| 13 | SailPoint 文件 — Supported languages | https://documentation.sailpoint.com/saas/user-help/getting_started/supported_languages.html | 直接開啟 |
| 14 | SailPoint — 尋找合作夥伴（繁體中文頁） | https://www.sailpoint.com/zh-hant/partners/find-partner | 直接開啟 |
| 15 | SailPoint — 台灣身分治理調查報告頁（2023-12-27） | https://www.sailpoint.com/zh-hant/identity-library/state-of-identity-taiwan | 直接開啟（僅摘要頁，報告本文未取得） |
| 16 | SailPoint 新聞稿〈SailPoint Launches Agentic Fabric〉（2026-05-11）；Help Net Security（2026-05-11、2026-10-06） | https://www.sailpoint.com/press-releases/sailpoint-launches-agentic-fabric ；https://www.helpnetsecurity.com/2026/05/11/sailpoint-agentic-fabric-expands-identity-governance-to-autonomous-ai-agents/ ；https://helpnetsecurity.com/2026/10/06/sailpoint-agentic-fabric-innovation | 搜尋摘要 |
| 17 | SailPoint 社群〈From SailPoint Agentic Fabric to Navigate 2026: here's what's new〉；IT Brief〈SailPoint launches AI tool to speed identity cloud migration〉；SailPoint〈Modernize your identity solution〉 | https://community.sailpoint.com/t5/Customer-Success-Updates/From-SailPoint-Agentic-Fabric-to-Navigate-2026-here-s-what-s-new/ba-p/280575 ；https://itbrief.com.au/story/sailpoint-launches-ai-tool-to-speed-identity-cloud-migration ；https://www.sailpoint.com/solutions/migrate-cloud/ | 搜尋摘要 |
| 18 | Okta — Plans & pricing | https://www.okta.com/pricing/ | 直接開啟（年約下限與 OIG 內容）；套裝價格為搜尋摘要 |
| 19 | Okta Help — Separation of duties；Okta Support〈OIG access requests and workflows: checking SoD in an access request〉；Okta〈Identity Governance FAQs〉 | https://help.okta.com/oie/en-us/content/topics/identity-governance/sd/separation-of-duties.htm ；https://support.okta.com/help/s/article/oig-access-requests-and-workflows-checking-sod-in-an-access-request ；https://support.okta.com/help/s/article/Identity-Governance-FAQs | 第一頁直接開啟；其餘搜尋摘要 |
| 20 | Okta Help — Supported display languages | https://help.okta.com/oie/en-us/content/topics/reference/ref-supported-languages.htm | 直接開啟 |
| 21 | Okta〈Okta for AI Agents is now generally available〉（2026-04-29）；Okta 新聞稿〈Okta brings first-class identity to AI agents with Agent SSO〉；Oktane 2026 Announcements（2026-09） | https://www.okta.com/es-es/blog/ai/okta-for-ai-agents-general-availability/ ；https://okta.com/newsroom/press-releases/okta-brings-first-class-identity-to-ai-agents-with-agent-sso/ ；https://s205.q4cdn.com/566291348/files/doc_events/2026/Sep/23/Okta-Oktane-2026-Announcements.pdf | 搜尋摘要 |
| 22 | Saviynt〈Managing access requests and segregation of duties compliance〉；Saviynt Segregation of Duties 方案頁；Saviynt 論壇〈Not able to mandate mitigation control in approval workflow〉（2023，論壇）；AWS Marketplace — Saviynt Identity Cloud；Zluri〈Saviynt Pricing〉（競品部落格） | https://saviynt.com/blog/managing-access-requests-and-segregation-of-duties-compliance ；https://saviynt.com/solutions/segregation-of-duties ；https://forums.saviynt.com/t5/application-access-governance/not-able-to-mandate-mitigaition-control-in-approval-workflow/m-p/31317 ；https://aws.amazon.com/marketplace/pp/prodview-tial4xle4qu54 ；https://www.zluri.com/eye-on-identity/saviynt-pricing-cost-iga-platform-evaluation | 搜尋摘要 |
| 23 | One Identity — Identity Manager IT Shop Administration Guide（8.1.4–9.2 與 On Demand Starling Edition）；Language Pack Guide（9.0 LTS）；PeerSpot 使用者評論（評論性質） | https://support.oneidentity.com/technical-documents/identity-manager/9.0%20lts/it-shop-administration-guide/32 ；https://support.oneidentity.com/technical-documents/identity-manager/9.2/it-shop-administration-guide/29 ；https://support.oneidentity.com/technical-documents/identity-manager/9.0%20lts/language-pack-guide ；https://www.peerspot.com/questions/what-is-your-experience-regarding-pricing-and-costs-for-one-identity-manager | 搜尋摘要（直接開啟回應 403） |
| 24 | C1（原 ConductorOne）— Pricing（conductorone.com 301 轉址到 c1.ai） | https://www.c1.ai/pricing/ | 直接開啟 |
| 25 | C1 文件 — Policies；Policy 與 Task API reference；Terraform best practices | https://www.c1.ai/docs/product/admin/policies ；https://www.c1.ai/docs/api-reference/policy/get.md ；https://www.c1.ai/docs/developer/terraform-best-practices.md | Policies 直接開啟；其餘搜尋摘要 |
| 26 | Opal 文件 — Opal architecture | https://docs.opal.dev/docs/opal-architecture.md | 直接開啟 |
| 27 | Opal 官網與功能發布頁；Opal Zero 新聞稿（2026-09-16） | https://opal.dev ；https://opal.dev/feature-releases ；https://www.cybersecuritydive.com/press-release/20260916-opal-security-launches-opal-zero-to-make-least-privilege-a-reality-for-ente-1/ | 搜尋摘要 |
| 28 | Lumos — Pricing；Lumos 產品與部落格頁（廠商資料） | https://www.lumos.com/pricing ；https://www.lumos.com/products/appstore ；https://lumos.com/it-compliance | Pricing 直接開啟；其餘搜尋摘要 |
| 29 | Veza — Access Requests Data Sheet（2025-03，PDF）；Veza Access Hub 產品頁 | https://veza.com/wp-content/uploads/2025/04/Access-Requests-Veza-Mar-2025.pdf ；https://veza.com/product/access-hub/ | PDF 下載後轉文字閱讀；產品頁為搜尋摘要 |
| 30 | ServiceNow 新聞稿〈ServiceNow to Expand Security Portfolio With Acquisition of Veza〉；ServiceNow Form 8-K（FY2026 Q1） | https://newsroom.servicenow.com/press-releases/details/2025/ServiceNow-to-Expand-Security-Portfolio-With-Acquisition-of-Vezas-Leading-AI-native-Identity-Security-Platform/ ；https://www.sec.gov/Archives/edgar/data/0001373715/000137371526000054/erq1fy26.htm | 搜尋摘要 |
| 31 | Zluri — Pricing；Zluri Help — SoD Violation Insights in Access Requests；Zluri 部落格（廠商資料） | https://www.zluri.com/pricing ；https://help.zluri.com/docs/sod-violation-insights-in-access-requests ；https://www.zluri.com/blog/access-request-management ；https://www.zluri.com/blog/just-in-time-access-in-zluri | 前兩頁直接開啟；部落格為搜尋摘要 |
| 32 | Immuta 文件 — Request: Introduction；Review flows | https://documentation.immuta.com/saas/request/introduction ；https://documentation.immuta.com/SaaS/request/review-access-requests/reference-guides/request-forms/review-flows | 直接開啟 |
| 33 | Immuta 文件 — Deployment options；Self-hosted Immuta；Universal Audit Model (UAM)；Getting Started with Marketplace | https://documentation.immuta.com/saas/configuration/application-configuration/reference-guides/deployment-options ；https://documentation.immuta.com/knowledge-base/LmMmmLqSszWn8sdGe7gH/self-hosted-immuta ；https://documentation.immuta.com/2026.1/governance/detect-your-activity/audit/reference-guides/universal-audit-model-uam ；https://documentation.immuta.com/saas/knowledge-base/implementation/marketplace/getting-started-with-marketplace | 搜尋摘要 |
| 34 | Databricks 文件 — Access requests（GCP 版）；Manage access request destinations（AWS 版） | https://docs.databricks.com/gcp/en/data-governance/unity-catalog/manage-privileges/access-requests ；https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-request-destinations | 第一頁直接開啟；第二頁搜尋摘要 |
| 35 | Snowflake 文件 — Manage the request approval workflow；Request access workflow for organizational listings；Release note 2025-05-30（GA） | https://docs.snowflake.com/en/user-guide/collaboration/listings/organizational/request-approval-workflow ；https://docs.snowflake.com/en/user-guide/collaboration/listings/organizational/request-access-workflow ；https://docs.snowflake.com/en/release-notes/2025/other/2025-05-30-raw | 第一頁直接開啟；其餘搜尋摘要 |
| 36 | Snowflake 文件 — Request Access in Workspaces | https://docs.snowflake.com/user-guide/access-requests-workspaces | 直接開啟 |
| 37 | Snowflake 文件 — Multi-party Approval | https://docs.snowflake.com/en/user-guide/multi-party-approval | 直接開啟 |
| 38 | Satori 文件與新聞稿（self-service data access，2021）；Commvault〈Commvault Closes Acquisition of Satori〉；Commvault Form 8-K（FY2026 Q2） | https://satoricyber.com/docs/usecases/self-service/ ；https://www.helpnetsecurity.com/2021/06/04/satori-self-service-data-access/ ；https://www.commvault.com/blogs/commvault-closes-acquisition-of-satori ；https://www.sec.gov/Archives/edgar/data/1169561/000116956125000083/q2fy26pressrelease.htm | 搜尋摘要 |
| 39 | Privacera 新聞稿〈Meet Trust3 AI〉（2026-03-09）；Help Net Security〈Privacera Governed Data Stewardship〉（2023） | https://privacera.com/newsroom/press-releases/meet-trust3-ai/ ；https://www.helpnetsecurity.com/?p=270331 | 搜尋摘要 |
| 40 | Collibra Developer — Request Assets Access workflow；Collibra 文件 — Requesting access to data via the data basket；AWS 部落格〈Automate data sharing with Collibra and AWS Lake Formation〉 | https://developer.collibra.com/workflows/out-of-the-box-workflows-walk-throughs/request-assets-access ；https://docs.collibra.com/Content/Catalog/DataSets/ta_request-access-to-data-set.htm ；https://aws.amazon.com/blogs/apn/automate-data-sharing-with-collibra-and-aws-lake-formation | 搜尋摘要 |
| 41 | BigID — Access Intelligence；Data Access Governance；Remediation（廠商資料） | https://bigid.com/access-intelligence/ ；https://bigid.com/data-access-governance/ ；https://bigid.com/remediation/ | 搜尋摘要 |
| 42 | ALTR 文件 — Manage access requests；ALTR 部落格〈How ALTR Is Streamlining Data Access Requests in Snowflake〉 | https://docs.altr.com/en/manage-access-requests.html ；https://altr.com/blog/data-access-requests-in-snowflake/ | 搜尋摘要 |
| 43 | Teleport 文件 — Access Requests；Dual Authorization；Storage backends；Teleport Pricing Guide（2026-06-16） | https://goteleport.com/docs/identity-governance/access-requests/ ；https://goteleport.com/docs/admin-guides/access-controls/guides/dual-authz ；https://goteleport.com/docs/reference/backends ；https://goteleport.com/_uploads/Teleport_Pricing_Guide_Rev_June_16_2026_5f41774f5e.pdf | Access Requests 直接開啟；其餘搜尋摘要 |
| 44 | Palo Alto Networks 新聞稿〈Completes Acquisition of CyberArk〉（2026-02-11）；Palo Alto Networks Idira 頁；University of Wisconsin KB — CyberArk dual control（第二手）；CyberArk datasheet〈The CyberArk Digital Vault: Built for Security〉 | https://paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-cyberark-to-secure-the-ai-era ；https://www.paloaltonetworks.com/idira ；https://kb.wisc.edu/security/115012 ；https://www.cyberark.com/resources/product-datasheets/the-cyberark-digital-vault-built-for-security | Idira 頁直接開啟；其餘搜尋摘要 |
| 45 | BeyondTrust 文件 — Entitle approval workflows；Entitle 產品頁 | https://docs.beyondtrust.com/entitle/docs/approval-workflows ；https://beyondtrust.com/products/entitle | 搜尋摘要 |
| 46 | Zilla Security《2025 State of IGA Report》新聞稿（DRJ 轉載，2025-01-16） | https://drj.com/industry_news/zilla-securitys-2025-state-of-iga-report-uncovers-widespread-challenges-in-identity-governance/ | 直接開啟 |
| 47 | Security Sales & Integration〈Omada State of Identity Governance Report Finds IGA Struggles Continue〉（2025） | https://www.securitysales.com/news/omada-identity-governance-report-2025/613155/ | 直接開啟 |
| 48 | Identity Defined Security Alliance 部落格〈The State of Identity Governance in 2026〉（2026-02-11；轉述 Omada 調查） | https://www.idsalliance.org/blog/the-state-of-identity-governance-in-2026-why-boards-think-access-is-under-control-when-it-isnt | 直接開啟 |
| 49 | Netwrix 新聞稿〈75% of organizations strengthen their cybersecurity posture by conducting regular access reviews〉（2022-07-11） | https://www.netwrix.com/netwrix_survey_75_percent_of_organizations_strengthen_their_cybersecurity_posture_by_conducting_regular_access_reviews.html | 搜尋摘要 |
| 50 | Help Net Security〈Machine identities outnumber humans 109 to 1〉（2026-05-14）；Palo Alto Networks《2026 Identity Security Landscape》 | https://www.helpnetsecurity.com/2026/05/14/2026-identity-security-landscape-report/ ；https://www.paloaltonetworks.com/idira/identity-security-landscape-report | 第一頁直接開啟；樣本數取自 Idira 頁 [44] |
| 51 | Cloud Security Alliance 新聞稿〈79% of IT Pros Feel Ill-Equipped to Prevent Attacks via NHI〉（2026-01-27） | https://cloudsecurityalliance.org/press-releases/2026/01/27/79-of-it-pros-feel-ill-equipped-to-prevent-attacks-via-nhi-csa-oasis-survey-finds | 搜尋摘要 |
| 52 | OWASP Non-Human Identities Top 10（2025） | https://owasp.org/projects/non-human-identities-top-10 | 搜尋摘要 |
| 53 | NIST NCCoE〈Accelerating the Adoption of Software and AI Agent Identity and Authorization〉概念文件（2026-02-05）；專案頁 | https://csrc.nist.gov/pubs/other/2026/02/05/accelerating-the-adoption-of-software-and-ai-agent/ipd ；https://www.nccoe.nist.gov/projects/software-and-ai-agent-identity-and-authorization | 搜尋摘要 |
| 54 | ManageEngine ADManager Plus — Pricing details | https://www.manageengine.com/products/ad-manager/pricing-details.html | 直接開啟 |
| 55 | Evolveum midPoint 產品頁與 4.10 datasheet；KuppingerCole Executive View（midPoint 4.8）；Fitgap 與 G2 的價格說明（第三方） | https://www.evolveum.com/midpoint ；https://evolveum.com/wp-content/uploads/midPoint-4-10-datasheet.pdf ；https://evolveum.com/wp-content/uploads/kuppingercole-evolveum-midpoint-4-8-executive-view.pdf ；https://us.fitgap.com/products/020205/midpoint-identity-and-access-management-system | 搜尋摘要 |
| 56 | Microsoft Learn — Microsoft Identity Manager（MIM 2016 news，更新 2026-11-17；寫明「extended from January 13, 2026 to January 9, 2029」）；Deprecated features and planning for the future | https://learn.microsoft.com/en-us/microsoft-identity-manager/microsoft-identity-manager-2016 ；https://learn.microsoft.com/en-us/microsoft-identity-manager/microsoft-identity-manager-2016-deprecated-features | 第一頁直接開啟（查證時）；第二頁直接開啟，但該頁未載終止日期 |
| 57 | EmpowerID 白皮書〈Continuous Evidence〉（2026-08；廠商宣稱） | https://empowerid.com/resources/white-papers/continuous-evidence | 直接開啟 |
| 58 | Zluri 部落格〈SailPoint alternatives〉系列（競品廠商行銷文章，僅作痛點佐證） | https://www.zluri.com/eye-on-identity/sailpoint-saviynt-alternatives-modern-iga-platform-switch ；https://www.zluri.com/eye-on-identity/lightweight-iga-mid-market-saas-alternative-sailpoint | 搜尋摘要 |
| 59 | Gartner 研究摘要頁：2026 Market Guide for Identity Governance and Administration（2026-08-28）；light IGA 相關研究（2026-03）。搜尋結果列出多個 Gartner 文件編號，哪一個編號對應哪一份未逐一確認 | https://www.gartner.com/en/documents/8321653 | 搜尋摘要（僅摘要，內文需付費） |
| 60 | Microsoft Learn — Microsoft Entra on-premises application identity provisioning architecture；What is the Microsoft Entra provisioning agent? | https://learn.microsoft.com/entra/identity/app-provisioning/on-premises-application-provisioning-architecture ；https://learn.microsoft.com/en-us/entra/identity/hybrid/cloud-sync/what-is-provisioning-agent | 搜尋摘要 |
