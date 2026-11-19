# 04　競品調查：簽核／BPM／GRC（含台灣在地產品）

查閱日期：2026-11-19。來源編號見第 5 節。

讀法說明：

- **【事實】** 來源直接寫的內容。引號內是原文。
- **【推論】** 由事實推得，來源沒有直接寫。
- **【查不到】** 這次沒找到一手來源，不代表功能不存在。
- 標「僅搜尋摘要」的來源，表示原文打不開（403）或搜尋額度用完，只看到搜尋工具的摘要，可信度較低。
- 四個稽核問題沿用 [platform-vision.md](../platform-vision.md) 的編號：Q1 誰決定、有沒有資格（職責分離）；Q2 核准內容與執行內容是否同一份；Q3 核准後有沒有照做、現在是否仍有效；Q4 紀錄能不能相信。

---

## 1. 重點結論

1. 台灣主流簽核產品把「申請者可設為簽核角色」「找不到簽核者就自動跳關」「負責人可把已通過的單據改回簽核中」做成正式功能，職責分離靠設計者設定，引擎不擋。[5][6][7]
2. 國際工具也不預設禁止自簽：Jira Service Management 的「禁止 reporter 核准自己的請求」需求從 2017 年開到現在未解決；Zoho Creator 文件直接描述申請人與核准人是同一人的情況；Camunda 的排除名單需求仍是 Open。[20][30][35]
3. 核准後的內容可由管理角色修改，文件沒有提到要重簽：Kissflow 的 Process Admin 可在流程完成後編輯任何項目；鼎新客戶案例中，已核准單據要改得由 IT 進後台。[26][27][2]
4. 紀錄的可信度靠權限與保存期設定，不靠防竄改設計：UOF X 活動日誌最長保留 12 個月、到期自動刪除不可還原；Teams Approvals 存在不支援備份的 Dataverse 預設環境，資料層稽核要另外啟用；Power Automate 執行紀錄保留 30 天；Pipefy 歷史 180 天。這次查到的官方文件沒有一家宣稱雜湊鏈或只增不改。[9][22][24][33]
5. 代理、轉派、管理者介入是稽核盲點：Nintex 手動轉派核准工作後，追蹤畫面看不到原受派人與轉派人（2026-02 夥伴回報，原廠確認需另提需求）；ServiceNow 核准紀錄被移除後不會進還原模組（2013 年原廠員工回覆）。[34][38]
6. 「核准之後還有效嗎」只有 IGA 類產品在處理，而且只限存取權：Entra、Opal、C1 提供限時授權、到期自動移除、定期複查；這次查到的簽核／BPM 產品文件都沒有有效期的概念。[40][42][44]
7. IGA 產品多數把「不得核准自己的申請」做成預設（Entra、Opal），但不一致：Okta 指定特定使用者為核准人時允許自簽，SailPoint IdentityIQ 8.4 沒有全域開關。[39][41][42][43]
8. GRC 與合規自動化產品不產生核准，只收集別的系統產生的證據：ServiceNow 的證據是受指派者上傳的附件或網址；Hyperproof 從 GitHub 等系統抓 proof；Drata 不會拉進直接建在外部系統的 ticket；Secureframe 靠 Indent 匯入核准證據。Vanta 自己做了 access request，但核准不會實際授權，也還沒接上複查與離職流程。[45][47][48][49][50]
9. 用 Slack、Teams、email 簽核的問題在紀錄層：Slack 成員預設可編輯、刪除自己的訊息，刪除是永久的；Audit Logs API 只有 Enterprise 方案有，而且不含訊息內容。[52][53]
10. 三個相鄰市場 2025 年規模：workflow automation 約 238 億美元、IGA 約 93 億美元、GRC 軟體約 65 億美元；IGA 的預估成長率最高（約 15%）。各家研究機構範圍定義差異大。[54][55][56]

---

## 2. 詳細內容

### 2.1 台灣常見的電子簽核與 BPM 產品

#### 2.1.1 基本資料

| 產品（廠商） | 定位與客群 | 部署 | 價格 | 來源 |
|---|---|---|---|---|
| EasyFlow（鼎新數智；頁面主推 AiGP 版，客戶案例出現 EasyFlow GP） | 【事實】BPM／電子簽核，可與鼎新 ERP、HRM 整合；內建 164 張表單，含「17 張 ISO 27001 常用表單」。頁面只給公司層級數字「50,000多家企業e化成功案例」，沒有 EasyFlow 自己的客戶數。 | 【查不到】產品頁沒寫雲端或地端 | 【查不到】不公開，頁面只有諮詢表單 | [1][3] |
| Agentflow（華苓科技） | 【事實】「Agentflow用戶涵蓋高科技、製造、金融、服務、營建...等產業」。同一頁寫「超過 2000 家企業導入」，另一段寫「1600多家企業客戶」，兩個數字不一致。 | 【事實】「採用 Java 跨平台架構」；產品線另列「Agentflow 智雲版」（雲端）。地端或雲端的授權方式【查不到】 | 【查不到】 | [4] |
| UOF X（一等一科技） | 【事實】雲端辦公平台，含 BPM、EIP、文件管理；支援「本地端AD / Microsoft Entra ID 驗證」；通過 ISO 27001。客戶數【查不到】 | 【事實】官方稱「雲端辦公室」。【推論】後台活動日誌列有「編輯資料庫連線設定」「安裝新版本」「切換為Active環境」等事件，表示也有客戶自管的安裝形態。 | 【查不到】 | [10][13] |
| nuBPM（NUEIP 人易科技） | 【事實】雲端 BPM 電子表單，與自家人資系統 nuHRM 搭配；比較表自稱「符合大型企業稽核需求。完整簽核歷程，責任歸屬清楚」 | 【推論】SaaS（官方只提供線上服務與 API） | 【查不到】官方價格頁（中、英文）目前不列價格，只有諮詢表單。搜尋摘要曾顯示「nuBPM NT$100／50 每人每月」，原文無法確認。 | [14][15][16] |
| Tracko、Vital BizForm（叡揚資訊） | 【事實】Tracko 客群為「公部門、壽險業、金融業、教育單位與一般企業」，功能是建表、資料收集、週期通知、自訂簽核流程與派工；金融業用途列有「稽核缺失追蹤」。Vital BizForm 為雲端智慧表單（僅搜尋摘要）。 | 【查不到】 | 【查不到】 | [17][18] |
| 逐鹿數位 BPM（原明基逐鹿） | 僅搜尋摘要：2023 年有客戶為準備 IPO 導入，報導標題稱「稽核效率躍升 9 成」。原文 403 打不開，數字無法查證。 | 【查不到】 | 【查不到】 | [19] |

題目列的「叡揚 e-Flow」：【查不到】叡揚有叫這個名字的產品。叡揚官網查到的簽核相關產品是 Tracko 與 Vital BizForm。「Vital 系列」即叡揚的 Vital／Vitals 產品線。

#### 2.1.2 對四個稽核問題的支援

UOF X 是唯一公開完整操作手冊的產品，所以證據最細。其他三家只有行銷頁，寫「查不到」的格子不能解讀成「沒有」。

| 稽核需求 | UOF X（一等一） | EasyFlow（鼎新） | Agentflow（華苓） | nuBPM（NUEIP） |
|---|---|---|---|---|
| **Q1 職責分離** | **沒有引擎層強制。**【事實】簽核站點「可指定該站的簽核人員，除了一般的 申請者、申請者主管、上一站直屬主管、指定人員 可設定外…」，申請者本身是可選的簽核角色 [7]。【事實】可設定「找不到簽核者」時自動跳關：「當系統無法找到下一站簽核者，例如人員被停用、部門組織異動或未設定簽核主管時，可自動跳過該站點」；而且「在[簽核歷程]中，不會顯示因找不到簽核者被[自動跳關]的簽核站點」，只在「詳細記錄」看得到 [5]。【事實】「相同簽核者重複簽核」可設定自動跳過 [5]。 | 【查不到】官方頁只寫「根據費用金額設定不同簽核層級管控」（客戶案例）[1] | 【查不到】官方頁只列「核決權限、簽核規則、代理人」為可設定項 [4] | 【查不到】官方頁沒提申請人不可自簽 [14] |
| **Q2 簽核後內容變更** | **部分。**【事實】送出後、下一位簽核前可「取回」修改，「系統會完整紀錄取回的歷程」[8]。【事實】負責人可看「欄位變更紀錄」，內容是「每個流程站點在送單時的資料紀錄」[6]。【事實】表單負責人可對簽核中、通過、否決的單據「變更單據狀態」；官方舉的情境是「表單已經結案，但最後一站的簽核者希望修改簽核決定，這時可以使用該功能將表單復原回『簽核中』狀態」，系統只發通知給簽過的人 [6]。縮小免簽、擴大重簽這類規則【查不到】。 | **部分。**【事實】客戶案例：「有同仁反應單據核准後無法修改，IT必須進後台去調整」；顧問建議改成另開表單「透過表單流程來記錄異動的歷程」[2]。【推論】系統內鎖住已核准單據，但實務上的修改跑到後台，離開了簽核紀錄。 | 【查不到】單據層。流程與表單「定義」有版本：「每次表單變更皆自動記錄版本差異」，但版本可「檢視、還原、刪除」[4] | 【查不到】單據層。流程定義有「隨著作業更動而自動更新的版本號碼」，可看歷史版本 [15] |
| **Q3 執行、驗證、存續** | **沒有。**【事實】「結案後流程」可在通過後自動起另一張表單或做文件歸檔 [12]。有效期、到期失效、撤銷、複查【查不到】。 | 【查不到】案例提到表單通過後回寫 ERP 權限（僅搜尋摘要） | 【查不到】 | 【查不到】官方頁只提到簽呈通過後更新員工資料（僅搜尋摘要） |
| **Q4 紀錄防竄改** | **沒有防竄改設計，且有保存上限。**【事實】活動日誌保留時間選項只有「3 個月、6 個月、9 個月、12 個月」；「系統會以排程方式，自動刪除超過保留期限的活動紀錄，一旦刪除，紀錄將無法再查詢或還原」；手冊自己提醒「若需配合外部稽核或資訊安全審查，請確認保留期限設定是否符合組織規範」[9]。【事實】由 SDK 異動時「『異動人員』會顯示為金鑰 Client 名稱」[9]。 | 【事實】宣稱「完整稽核軌跡記錄確保所有流程具備可追溯性」，沒有說明機制 [1] | 【事實】系統日誌「記錄使用者登入、登出與各項操作行為」，沒有說明能否修改或保存多久 [4] | 【事實】流程定義的異動可查「異動內容、異動人、異動時間」[15]。簽核紀錄的保護方式【查不到】 |
| **稽核報表** | 【事實】單據可「列印單據內容包含簽核歷程等資訊，方便高階主管查閱或會計稽核需要保存紙本檔案」[11]。自簽、跳關、管理者介入的例外報表【查不到】。 | 【事實】「當系統發生異常，都有紀錄提供資管稽核」[1] | 【事實】「9 大分類共 54 種報表」，內容是簽核耗時、部門工作量等效率指標 [4] | 【查不到】 |

叡揚的選型文章把防竄改歸給權限設定：依部門或職位設定填寫、編輯、查看權限，「能夠保障簽核過程的安全性，防止資料被篡改」[17]。【推論】這正是 platform-vision 所說「有權限的人就能改」的做法。

三個觀察（都是【推論】，依據上表）：

1. 這些產品的設計目標是「流程不要卡住」。自動跳關、三順位代理、負責人改狀態、指定簽核人員，都是為了讓單子走完。稽核要的是「不該過的不能過」，方向相反。
2. 稽核證據仍以列印紙本為預設做法 [11]，表示系統內的紀錄本身還沒被當成可直接提交的證據。
3. 台灣廠商 2025–2026 年的主打是 AI Agent 填單與預審（Agentflow、EasyFlow AiGP、UOF X 的頁面都以此為主軸）[1][4]，沒有一家以稽核可信度為訴求。

### 2.2 國際的簽核與流程工具

| 產品 | 核准人可否為申請人 | 核准後能否修改 | 紀錄能否被管理員更動、保存多久 | 來源 |
|---|---|---|---|---|
| ServiceNow（平台核准） | 【查不到】官方文件對預設行為的說明。【事實】社群有多則「如何禁止申請人核准自己的變更」提問（2012–2025 年），被採納的解法是自己在 Approval 資料表寫 business rule。【推論】不是預設行為，要客製。 | 【查不到】 | 【事實】移除核准人時核准紀錄會消失；原廠員工回覆：刪除「is not audited in such a way that they show up in the Restore Deleted Records module」，要到 sys_audit 查（2013 年，論壇性質，現況可能已變）。 | [37][38] |
| Jira Service Management | 【事實】可以。JSDSERVER-5231：「At the moment, a reporter can approve their own request if permission is given.」2017-07-06 建立，狀態 Gathering Interest，40 票，未解決。Cloud 版類似需求 JSDCLOUD-6678 以重複單關閉。 | 【查不到】 | 【查不到】 | [20][21] |
| Microsoft Power Automate／Teams Approvals | 【查不到】平台層禁止自簽的設定。 | 【查不到】 | 【事實】Approvals 存在預設 Dataverse 環境，「which doesn't support backups at this time」。【事實】更細的稽核要自行對 Approval、Approval Request、Approval Response 啟用；「Create, update, and delete operations are auditable events for Approval records」，也就是紀錄可被更新與刪除。【事實】流程等待核准超過期限會失敗，核准留在行動中心，「The requestor or environment admin then needs to manually delete these approvals」。【事實】執行時間上限與執行紀錄保留都是 30 天（known issues 頁寫 28 天，兩頁不一致）。 | [22][23][24] |
| Kissflow | 【查不到】 | 【事實】可以，由管理員改。「The Process Admin can edit a process form when it's in progress or even after it has completed all the workflow steps.」管理員還可重開已完成或已否決的項目、改派、批次刪除（30 天內可還原）、直接標記完成而「skipping all the future steps」。文件沒提到要重簽。 | 【事實】管理員編輯「will be recorded in the process audit log」；流程稽核日誌只有 Process Admin 能查。保存期限與能否刪改【查不到】。 | [26][27][28] |
| Nintex Automation Cloud | 【查不到】 | 【查不到】 | 【事實】手動轉派核准工作後，追蹤畫面沒有原受派人、轉派人、轉派時間（2026-02-27 夥伴回報）；原廠員工指出資料在 API 的 taskAssignments 裡，並請對方到 Ideas 提需求。同類需求 2024-09 已有人提過（論壇性質）。 | [34] |
| Camunda | 【事實】沒有內建。CAM-14479「Exclusion list for task assignment - 4 eyes principle」2022-03-22 建立，Open，未解決。論壇做法是自寫 task listener。 | 【查不到】 | 【事實】Camunda 7 的 user operation log 只在「performed in the context of a logged in user」且 history level 為 FULL 時記錄；可對紀錄加註解。能否刪除、清理策略的影響【查不到】。 | [35][36] |
| Pipefy | 【查不到】原生職責分離控制 | 【查不到】能否鎖定已核准欄位 | 【事實】「Up to 180 days of pipe history available」；CSV 匯出只含最近 30 天；設定變更只有 Pipe Admin 看得到。文件沒有說明紀錄如何防修改。 | [33] |
| Zoho Creator | 【事實】可以。「If the requester and approver are the same person, the approver can also recall the request」。 | 【事實】申請人可 recall 後修改再送。核准後的修改【查不到】。 | 【事實】申請人與核准人可看 approval history。保護方式【查不到】。 | [30][31] |

價格（只列官方頁讀得到的）：

| 產品 | 官方公開價格 | 來源 |
|---|---|---|
| Power Automate Premium | 每人每月 15 美元（年繳）；Process 每 bot 每月 150 美元 | [25] |
| Zoho Creator | 年繳每人每月 8／20／25 美元（Standard／Professional／Enterprise） | [32] |
| Kissflow | 不公開，需詢價；頁面說明為年約 | [29] |
| ServiceNow、Nintex、Camunda、Pipefy、Jira Service Management | 【查不到】官方頁讀不到或這次未查 | — |

### 2.3 存取權治理（IGA）與存取申請工具

題目沒有列這一類，但第一個流程包是資料授權，這類產品是最直接的替代品，所以補查。

| 產品 | 自簽 | 有效期與到期處理 | 複查 | 來源 |
|---|---|---|---|---|
| Microsoft Entra ID Governance（entitlement management） | 【事實】「Approvers aren't able to approve their own access package requests.」最多三階段核准；逾期未決自動拒絕。另有「不相容 access package」的職責分離檢查（僅搜尋摘要）。 | 【事實】policy 定義「how long they have access」；「ensure identities don't retain access indefinitely through time-limited assignments and recurring access reviews」。 | 【事實】有，定期 access review | [39][40][59] |
| Okta Access Requests | 【事實】視指派方式而定。群組、主管、代理、輪值：自簽被擋，工作留空待指派。指定「特定使用者」或「Requester」為核准人：「self-attestation is allowed」。沒有全域開關。 | 這次未查 | 這次未查 | [41] |
| Opal | 【事實】「No. Currently access requests can not be approved by the submitter.」系統也擋下「只有申請人自己能核准」的設定。 | 【事實】短期授權到期「Opal will automatically revoke your access」。但「Extended access does not need to be approved again」——展延不必重新核准。 | 這次未查 | [42] |
| C1（原 ConductorOne） | 【查不到】 | 【事實】JIT 授權自動到期；宣稱把「the request, decision, grant, and removal together」保存。入口含 web、Slack、Teams、MCP、API、CLI。政策內可自動核准。 | 這次未查 | [44] |
| SailPoint IdentityIQ 8.4 | 【事實】社群回覆：「IIQ 8.4 doesn't have a single global toggle for 'no self-approval'」，要用 Approval Assignment rule 自寫（論壇性質）。Identity Security Cloud 的官方說明【查不到】。 | 這次未查 | 這次未查 | [43] |

這一類的限制（【事實】加【推論】）：

- 【事實】Entra 能治理的資源是 Entra 群組、Teams、企業應用程式、SharePoint 網站、API 權限、SAP IAG 角色，需要 Entra ID Governance 或 Entra Suite 授權 [40]。【推論】資料庫層的資料授權、合約用印這類不是「把人加進群組」的決定，不在它的模型裡。
- 【推論】IGA 的核准對象是「某人取得某個權限」，內容固定，所以沒有「核准後內容被改」的版本問題，也不處理一般業務簽核。本平台要同時處理兩種。
- 【事實】Opal 的展延不需重新核准 [42]。【推論】有效期可以靠展延無限延長，這和「擴大要重簽」的原則相反，是可以做出差異的地方。

### 2.4 GRC 與合規自動化

| 產品 | 怎麼收集「核准證據」 | 自己有沒有簽核流程 | 來源 |
|---|---|---|---|
| ServiceNow IRM／Audit Management | 【事實】稽核人員發證據請求；「The assignee can either attach the requested evidence or provide a URL or location that contains the required evidence.」敏感證據可加核准人審核。另以 indicator 從平台資料表收集監控資料（僅搜尋摘要）。 | 【推論】IRM 本身不提供業務簽核；核准發生在同平台的 ITSM 或自建流程，再被引用為證據。 | [45] |
| Archer | 【事實】2025-11-19 發表持續控制監控：「automating evidence collection across critical IT environments」，並「automatically compares configuration and access data against controls requirements」，涵蓋 SOC 2、ISO 27001、NIST CSF、HIPAA、SOX ITGC。 | 【查不到】 | [46] |
| AuditBoard（2026-03-09 更名 Optro） | 【查不到】官方文件。廠商部落格只談到 PBC 請求要寫明是否需要 sign-off 與 review 的證據（僅搜尋摘要）。 | 【查不到】 | [51] |
| Hyperproof | 【事實】Hypersync 自動從外部系統抓 proof；文件舉例是從 GitHub 取得「approval details for all pull requests」。核准記錄在 GitHub，不在 Hyperproof。 | 沒有業務簽核（文件未提） | [47] |
| Vanta | 【事實】有自己的 access request：申請、指定核准人、Slack 通知與 `/vanta request access`。但「Approving an access request in Vanta doesn't create an account or grant permissions in the requested application」；管理員要在 Vanta 之外開權限，再回來標記已開通，而標記「doesn't change access in the application」。【事實】「We're actively building support to surface access requests during reviews and offboarding」——核准紀錄還沒接上複查與離職流程。有效期文件未提。 | 只有存取申請這一種 | [48] |
| Drata | 【事實】ticket 用來追蹤控制、測試、風險的補救工作。「Drata does not pull in tickets that were created directly in the external ticketing system.」 | 沒有業務簽核（文件未提） | [49] |
| Secureframe | 【事實】與 Indent 合作：「the access and change management control evidence generated in Indent can be easily filtered and imported into Secureframe」。核准流程在 Indent。 | 沒有（靠夥伴） | [50] |

小結（【推論】）：

1. GRC 產品站在「事後收證據」的位置。核准的品質（有沒有自簽、內容有沒有被改）取決於來源系統，GRC 不會也無法補強。
2. 證據常是人上傳的附件或網址 [45]，或是從來源系統定期抓的快照 [47]。兩者都不能證明「核准的那一份就是執行的那一份」。
3. 這些產品是本平台的下游而不是對手。它們需要一個能輸出可驗證核准紀錄的來源。Vanta 的做法顯示，GRC 廠商會往上游補一個簡單的申請流程，但目前只記錄、不執行、不對帳。
4. Archer 的持續控制監控拿「實際的設定與存取資料」比對「控制要求」[46]，和本平台的對帳功能（實際權限比對已核准範圍）概念接近。差別在它比對的是通用控制要求，不是逐筆核准。

### 2.5 以 Slack、Teams、email 做簽核

| 管道 | 事實 | 來源 |
|---|---|---|
| Slack 訊息 | 「By default, any member can edit their messages」「By default, any member can delete their messages」；owner 與 admin 可刪除成員在公開頻道的訊息；「Deleting a message is permanent」。 | [52] |
| Slack 稽核 | Audit Logs API「only available to Slack workspaces on an Enterprise plan」；「They do not enable monitoring of message content」。 | [53] |
| Teams Approvals | 有正式的核准物件與稽核事件（建立、核准、拒絕、取消、改派等，寫入 Microsoft Purview）。但資料在不支援備份的 Dataverse 預設環境；與聊天或頻道成員自動成為 viewer；電子簽章資料存在第三方（Adobe Sign、DocuSign）。 | [22] |
| Email | 【查不到】稽核準則對 email 核准的直接評價（PCAOB AS 1105 原文 403 打不開）。 | — |

問題整理（【推論】，依據上表與 2.3、2.4）：

1. **身分與資格**：聊天訊息只能證明某個帳號說了「OK」。它不能證明這個人當時有核准資格，也沒有機制擋下申請人自己回覆。
2. **內容綁定**：「OK」對應的是當時那串訊息。之後申請內容在別處被改，訊息不會跟著變。訊息本身也可被編輯或永久刪除 [52]。
3. **存續**：訊息沒有有效期，沒有撤銷，離職或調職後沒人會回頭處理。
4. **取證成本**：稽核時要靠截圖或匯出，而 Slack 的稽核 API 不含訊息內容，且限 Enterprise 方案 [53]。
5. **產業的解法是把聊天當操作介面**：Vanta、Opal、C1 都讓人在 Slack 裡申請與核准，但決定記在自己的系統裡 [42][44][48]。這是使用者已經習慣的形態。

### 2.6 缺口分析：四個稽核問題 × 各類產品

「有」表示官方文件寫明是預設或引擎行為。「部分」表示可設定、要客製，或只涵蓋特定範圍。「沒有」表示文件顯示做不到，或顯示相反的行為。

| | Q1 職責分離由引擎強制 | Q2 簽核綁定內容版本 | Q3 執行→驗證→存續閉環 | Q4 紀錄防竄改、記下規則與版本 | 第五件事：供其他系統查詢、通知、對帳 |
|---|---|---|---|---|---|
| **台灣簽核／BPM**（UOF X、EasyFlow、Agentflow、nuBPM） | **沒有**。申請者可為簽核角色；找不到人可跳關且不顯示在簽核歷程 [5][7] | **部分**。有欄位變更紀錄與取回歷程；負責人可把已通過改回簽核中 [6][8]；後台修改 [2] | **沒有**。只有結案後起單 [12] | **沒有**。日誌最長 12 個月自動刪除 [9]；流程定義有版本但可刪 [4] | **沒有**。有整合 API，但文件沒有把簽核結果定位成權限依據 |
| **國際簽核／低程式碼**（Power Automate、Kissflow、Nintex、Pipefy、Zoho Creator） | **沒有**。Zoho 明示可同一人 [30]；其餘【查不到】平台層禁止 | **沒有**。Kissflow 管理員可在完成後改內容 [27] | **沒有** | **沒有**。保存期 30 天至 180 天不等；紀錄可更新刪除 [22][24][33]；轉派不留痕 [34] | **沒有** |
| **ITSM**（ServiceNow、Jira Service Management） | **部分**。要自寫 business rule [37]；JSM 沒有選項 [20] | 【查不到】 | **部分**。變更管理有執行與結案階段；有效期與複查不是核准的屬性（【推論】） | **部分**。有稽核表，但核准紀錄刪除的可追性有疑問 [38] | **部分**。平台內可引用，跨系統要自建 |
| **流程引擎**（Camunda） | **沒有**內建 [35] | 要自建 | 要自建 | **部分**。操作日誌有前提條件 [36] | 要自建 |
| **IGA／存取申請**（Entra、Okta、Opal、C1、SailPoint） | **部分到有**。Entra、Opal 預設禁止；Okta、SailPoint 視設定 [39][41][42][43] | 不適用（核准對象是固定的權限項目）。Opal 展延免重簽 [42] | **有，但只限存取權**。限時、到期移除、複查 [40][42][44] | 【查不到】防竄改設計 | **部分**。對已串接的應用程式做開通與移除；不是通用的判定介面 |
| **GRC／合規自動化**（ServiceNow IRM、Archer、Optro、Hyperproof、Vanta、Drata、Secureframe） | 不適用（不做核准）。Vanta 的 access request 文件未提自簽 [48] | **沒有**。證據是附件、網址或快照 [45][47] | **部分**。持續監控能發現偏離 [46]，但不對應到逐筆核准；Vanta 核准不會實際授權 [48] | 不適用（保管別人的證據） | 反方向：它們是證據的接收端 |
| **Slack／Teams／email** | **沒有** | **沒有**。訊息可改可刪 [52] | **沒有** | **沒有** [52][53] | **沒有** |

【推論】沒有一類產品同時涵蓋四個問題。IGA 最接近，但只處理存取權這一個領域，而且紀錄可信度沒有說明。這次也沒有查到任何產品記錄「這筆核准依據哪條規則、當時的參數值、當時的流程版本」。

### 2.7 市場規模與趨勢

各研究機構的範圍定義不同，數字不能直接相加或比較。

| 市場 | 數字 | 來源與年份 |
|---|---|---|
| Workflow automation | 2025 年 237.7 億美元；2026 年 260.1 億 → 2031 年 407.7 億，CAGR 9.41%。北美占 2025 年營收 34.22%；亞太成長最快（CAGR 9.92%）。範圍含軟體與相關服務。 | Mordor Intelligence [54] |
| Workflow automation（其他機構） | 2025 年多落在 240–260 億美元；CAGR 從約 9% 到 21% 都有。 | 僅搜尋摘要，未逐一開啟原文 |
| IGA | 2025 年 92.9 億美元；2026 年 107 億 → 2034 年 331 億，CAGR 15.16%。 | Fortune Business Insights，2026-11-02 更新 [55] |
| IGA（另一估計） | 2024 年 79.5 億美元 → 2033 年 271.1 億，CAGR 14.9%。 | Grand View Research，僅搜尋摘要 [58] |
| GRC 軟體（窄範圍） | 2025 年 65 億美元 → 2031 年 109 億。成長動因：地緣政治、AI 治理要求、法規分歧。 | Verdantix，2026-07-22 [56] |
| eGRC（含服務的寬範圍） | 2025 年 205.6 億美元 → 2030 年 399.9 億，CAGR 14.2%。 | MarketsandMarkets，原文 403，僅搜尋摘要 [57] |
| 台灣電子簽核／BPM 市場 | 【查不到】公開的市場規模數字。只有廠商自報的客戶數（華苓 1,600 或 2,000 多家 [4]）。 | — |

趨勢（事實與推論分開）：

- 【事實】台灣與國際的流程廠商都把 AI Agent 當主軸：Agentflow 產品頁以 AI Agent 與 RPA 為主要篇幅 [4]；EasyFlow AiGP 主打「AI 數智員工」[1]；C1 的申請入口列出 MCP，申請者含 workloads 與 agents [44]；Entra 把 agent ID 納入 access package [40]。
- 【推論】當申請者或執行者是 AI agent，「這件事現在能不能做」必須由機器即時查詢。這讓對外的判定介面從加分項變成必要條件。
- 【事實】GRC 產品朝持續控制監控走：Archer 2025-11 發表 [46]。ServiceNow 2026-11 宣布 agentic 持續控制監控（僅搜尋摘要）。
- 【推論】持續監控需要「應該是什麼」的權威來源才有東西可比。已核准且仍有效的授權清單正是這個來源。

### 2.8 結論：定位、切入點、差異化、可能的替代者

以下都是【推論】，依據列在各點後面。

**最接近的市場類別。** 沒有單一類別對得上。產品落在三個類別的交界：

| 相鄰類別 | 本平台拿它的什麼 | 本平台不是它的原因 |
|---|---|---|
| 電子簽核／BPM | 表單、路徑、代理、退回、加簽、手機核准 | 那一類以「流程走完」為目標；本平台以「不該過的不能過、過了能證明」為目標（2.1、2.2） |
| IGA 的存取申請與複查 | 禁止自簽、有效期、到期失效、複查、對帳 | IGA 只管存取權；本平台不綁領域（2.3） |
| GRC 的證據管理 | 證據輸出、可驗證 | GRC 收證據，不產生決定（2.4） |

對外說明時，最準確的一句話是：**可以直接當稽核證據、也可以直接當權限依據的簽核系統**。對資訊與資安人員，最容易懂的類比是「把 IGA 對存取權做的事，做到所有需要留證據的決定上」。

**最可能的切入點。**

1. 已有在地 BPM、但稽核時要補做人工比對的公司。依據：在地產品在 Q1、Q4 有具體缺口（結論 1、4），而且把紙本列印當稽核留存方式 [11]。
2. 從資料與系統權限的授權切入。依據：這個場景四個問題都成立，IGA 產品已證明企業願意為它付費（結論 6、10）；而國際 IGA 產品綁 Entra 或 Okta 生態，資料庫層授權不在它們的資源模型裡（2.3）。
3. 以「共存」而不是「取代」進場：一般請假、請款留在原 BPM，需要稽核級處理的流程才進本平台。依據：在地廠商的表單數量與 ERP 整合（EasyFlow 內建 164 張表單 [1]）短期追不上，也沒必要追。

**差異化。** 競品文件裡找不到、或明確做相反事情的地方：

1. 找不到合格簽核人時停下來，不跳關（對照 [5]）。
2. 管理者也不能繞過版本與重簽去改已核准的內容（對照 [6][27]）。
3. 紀錄只增不改、雜湊鏈、保存期不能由管理者縮短（對照 [9][22][33]）。
4. 每筆決定記下規則代碼、當時參數值、當時流程版本（這次沒查到任何競品有）。
5. 有效期、到期失效、撤銷、複查適用於任何流程，不限存取權（對照 2.3）。
6. 對外提供判定、事件、對帳介面，讓簽核結果成為權限依據（對照 [48]：Vanta 的核准不改變實際存取）。

**可能被誰取代。**

| 替代者 | 會在什麼情況下取代 | 本平台的防線 |
|---|---|---|
| Microsoft Entra ID Governance | 客戶的受控資源都能用 Entra 群組或應用程式角色表達，且已有 E5 或 Entra Suite 授權 | 非 Entra 資源（資料庫、地端系統、非存取類決定）；可驗證的紀錄；在地部署 |
| ServiceNow（ITSM 加 IRM） | 客戶已是 ServiceNow 大戶，願意付客製費用 | 四個問題開箱即有，不用寫 business rule [37]；成本 |
| 在地 BPM 廠商加上稽核功能 | 廠商把禁止自簽、紀錄鎖定做成開關。技術上不難 | 版本綁定、存續閉環、對外介面牽涉核心資料模型，不是加開關能補的；先佔住「稽核級」這個定位 |
| IGA 新創（C1、Opal、Lumos） | 客戶只在意雲端 SaaS 與基礎設施的存取 | 通用領域；台灣在地支援與法規對照 |
| GRC 廠商往上游做申請流程 | Vanta 已經做了 access request [48] | 目前只記錄、不執行、不對帳；本平台應主動當它們的證據來源，而不是競爭 |

---

## 3. 對產品的含意：需求清單

### 必須有

| # | 需求 | 依據 |
|---|---|---|
| M1 | **職責分離由引擎強制，流程設定繞不過。** 申請人不能簽自己的單；同一張單各關不同人；代理人、被轉派人、加簽人同樣受限。違反時擋下，不是事後報表。 | 結論 1、2、7。UOF X 允許申請者為簽核角色 [7]；JSM 八年未解 [20]；Entra 與 Opal 證明「預設禁止」是做得到且被市場接受的 [39][42] |
| M2 | **找不到合格簽核人時停住並升級，不可自動跳關。** 所有被略過、改派、代簽的關卡都要出現在主要的簽核歷程，不能藏在次要畫面。 | 結論 1。UOF X 的跳關站點不顯示在簽核歷程 [5]。Okta 的做法是把工作留空待指派，可參考 [41] |
| M3 | **簽核綁定內容版本；任何人（含管理者、表單負責人、後台）修改已核准內容都產生新版本並依規則重簽。** 不提供「把已通過改回簽核中」這種不留決定理由的後門。 | 結論 3。Kissflow 管理員完成後可改 [27]；UOF X 變更單據狀態 [6]；鼎新案例 IT 進後台 [2] |
| M4 | **紀錄只增不改、雜湊鏈串接、可由第三方獨立驗證；保存期不能由管理者設定為自動清除。** 透過 API 或服務帳號的操作要記到實際的人或明確的系統身分。 | 結論 4。UOF X 最長 12 個月自動刪除、SDK 異動只顯示 Client 名稱 [9]；Dataverse 可更新刪除 [22]；Power Automate 30 天 [24]；Pipefy 180 天 [33] |
| M5 | **代理、轉派、管理者介入全部進同一條稽核鏈**，記下原受派人、動作人、時間、理由。 | 結論 5。Nintex 轉派不留痕 [34]；ServiceNow 核准紀錄刪除 [38] |
| M6 | **每筆決定記下規則代碼、當時參數值、當時流程版本。** | 2.6：這次沒查到競品有；流程定義版本在 Agentflow 可被刪除 [4]，所以版本本身也要受保護 |
| M7 | **存續是核心能力，適用所有流程：有效期、到期自動失效、隨時撤銷、定期複查、負責人異動時處理。展延視為擴大，要重新核准。** | 結論 6。簽核／BPM 類沒有；IGA 類有但限存取權 [40][44]；Opal 展延免核准是反例 [42] |
| M8 | **對外介面：查詢與判定、事件通知、對帳。** 核准必須能變成實際權限的依據，並能發現「沒核准卻存在」的權限。 | 結論 8。Vanta 核准不改變實際存取、開通靠人工回報 [48]；Archer 以實際存取資料比對控制要求 [46]；AI agent 成為申請者後需要機器可查的判定（2.7） |
| M9 | **證據輸出給 GRC 與 SIEM，格式穩定、可驗證。** 以 API 推送或可拉取，不依賴人工上傳。 | 結論 8。GRC 的證據來源是附件、網址、快照 [45][47]；Drata 不拉外部直接建立的 ticket [49]，所以要主動送 |
| M10 | **稽核例外報表開箱即有：** 自簽嘗試、被擋的職責分離違規、逾期未決、管理者介入、到期未處理、對帳差異。 | 2.1.2：在地產品的報表是效率指標 [4]，稽核仍靠列印紙本 [11] |

### 應該有

| # | 需求 | 依據 |
|---|---|---|
| S1 | **在地市場的基本簽核功能要齊：** 會簽、串簽、加簽、退回、取回、催辦、多順位代理、批次、手機核准。缺了會在第一輪評選被刷掉。 | 2.1：四家在地產品都有 [4][5][8][14] |
| S2 | **Slack、Teams、email 當通知與操作入口，決定寫回平台。** 聊天訊息本身不是紀錄。 | 結論 9；2.5 第 5 點：Vanta、Opal、C1 都這樣做 [42][44][48] |
| S3 | **與既有 BPM 共存的整合方式：** 讓在地 BPM 的某一關呼叫本平台做稽核級核准，或由本平台接收其結果並補上版本與紀錄。 | 2.8 切入點 3 |
| S4 | **目錄整合：LDAP／AD／Entra ID。** 人員停用、調職要即時反映到簽核資格與存續。 | UOF X 支援 AD 與 Entra ID 驗證 [13]；UOF X 把「人員被停用、部門組織異動」當成跳關理由 [5]，本平台要當成升級與失效的觸發 |
| S5 | **流程定義的版本管理與差異比對，且版本不可刪除。** | Agentflow 有 Git 版本管理但可刪除 [4]；nuBPM 有版本號 [15] |
| S6 | **送出前模擬路徑：** 讓申請人與設計者先看到會經過哪些人、哪裡會卡住。 | UOF X 預覽流程與模擬 [7][11]；nuBPM 模擬 [15]。這是在地使用者已習慣的功能 |
| S7 | **多階段核准的逾時處理要明確：** 逾期自動拒絕或升級，不能默默通過。 | Entra 逾期自動拒絕 [39]；Power Automate 逾時後留下孤兒核准 [23] |
| S8 | **對照表與說帖：** 逐項列出本平台與在地 BPM、IGA、GRC 的差異，附本文件的來源。 | 2.8：定位落在類別交界，買方需要被教育 |

### 可以不做

| # | 項目 | 依據 |
|---|---|---|
| N1 | 拖拉式流程設計器 | 所有競品都有，不是差異點；流程是控管規則，變更本來就該走有紀錄的升版（platform-vision 既定範圍）。風險：在地買方習慣看到設計器，S6 的模擬與檢視畫面要夠好才能補上 |
| N2 | 大量內建表單範本 | EasyFlow 內建 164 張 [1]，追不上也不必追（2.8 切入點 3） |
| N3 | 電子簽章、對外簽署 | UOF X 與 Teams Approvals 都是串接第三方 [22]；整合即可 |
| N4 | GRC 的控制庫、框架對照、風險評分 | 屬於下游 GRC 產品（2.4）；本平台只要輸出證據 |
| N5 | 數百個 SaaS 的自動開通連接器 | 這是 IGA 廠商的主戰場（2.3）；本平台提供通用介面，由各系統或既有 IGA 接上 |
| N6 | AI Agent 填單、AI 預審 | 在地與國際廠商都在做 [1][4]，不構成差異。但 M8 的判定介面要能服務 agent |
| N7 | EIP、公告、出勤、人資模組 | 在地產品的捆綁項目 [13][14]，與稽核定位無關 |

---

## 4. 不確定或查不到的事項

1. **台灣產品的價格帶。** 四家都不公開。NUEIP 的「NT$100／50 每人每月」只在搜尋摘要出現，官方頁現在不列價格 [16]。UOF 的「每人每月 300 元」是 2011 年報導（僅搜尋摘要），不可用。要實際詢價。
2. **鼎新 EasyFlow、華苓 Agentflow、NUEIP nuBPM 的實際行為。** 沒有公開手冊。「能否禁止自簽」「核准後能否修改」「紀錄保存與保護方式」都只能標查不到。2.1.2 的結論主要立基於 UOF X 一家的手冊，推到整個類別是推論。建議取得試用環境實測。
3. **「叡揚 e-Flow」這個產品名。** 叡揚官網查不到。搜尋摘要顯示富士軟片台灣有名為 E-Flow 的文管簽核方案，未開啟原文確認。
4. **逐鹿數位 BPM、新人類 FlowMaster、凌群、Vital BizForm 的細節。** 原文 403 或只有 2011–2012 年的論壇資料。
5. **ServiceNow 的官方預設行為。** 「申請人預設能否核准自己的請求」沒找到官方文件明文，只有社群提問（推論為預設不擋）。核准紀錄刪除不可還原的說法是 2013 年的回覆，現行版本可能已改。IRM 定價頁 403。
6. **Power Automate 是否有平台層的禁止自簽設定。** 沒找到。另外官方兩頁對等待期限的寫法不一致（28 天 [23]、30 天 [24]）。
7. **Kissflow、Nintex、Pipefy 能否禁止自簽。** 官方文件沒提。
8. **SailPoint Identity Security Cloud、Saviynt 的官方說明。** 搜尋額度用完，只有 IdentityIQ 8.4 的社群回覆 [43]。Okta 的有效期與複查、Lumos 也未查。
9. **AuditBoard（Optro）收集核准證據的官方文件。** 沒找到；更名一事只有搜尋摘要 [51]。
10. **稽核準則對 email、聊天訊息、截圖作為核准證據的直接評價。** PCAOB AS 1105 原文 403。2.5 的問題整理是推論，建議與法規調查（本目錄其他文件）對照。
11. **Jira Service Management、Camunda、Pipefy、Nintex 的官方價格。** 官方頁內容被截斷或未查。第三方文章有數字但彼此不一致，未採用。
12. **台灣電子簽核／BPM 的市場規模、各廠市占。** 沒有公開數字。
13. **有沒有任何競品採用雜湊鏈或只增不改的紀錄。** 這次查到的官方文件都沒提，但沒提不等於沒有。這是差異化主張的核心，對外宣稱前應再查一次（特別是 ServiceNow、SailPoint、Saviynt）。
14. **市場數字的品質。** 第 2.7 節的數字來自商業研究機構的公開摘要頁，方法說明不完整；[57][58] 只有搜尋摘要。只適合用來說明量級。

本次搜尋工具額度在調查後段用完，第 8、9、11 項受此影響。

---

## 5. 來源

查閱日期均為 2026-11-19。

### 台灣產品

| # | 標題 | 網址 | 備註 |
|---|---|---|---|
| 1 | 鼎新數智〈鼎新EasyFlow：運用BPM開啟企業智慧流程〉 | https://www.digiwin.com.tw/software/BPM/BPM | 廠商產品頁 |
| 2 | 鼎新數智 客戶案例〈全貿實業─有效提升產品交期 提高客戶滿意度〉 | https://www.digiwin.com.tw/case/766.html | 廠商案例 |
| 3 | 鼎新數智 客戶案例〈合勤控股落實BPM精神〉 | https://www.digiwin.com.tw/case/1553.html | 廠商案例 |
| 4 | 華苓科技 Agentflow 產品頁 | https://www.flowring.com/product/agentflow/ | 廠商產品頁 |
| 5 | 一等一科技 UOF X 使用手冊 v2026R2.132〈表單簽核規則〉 | https://docs.uof.tw/operationdoc/v2026R2.132/bpm/bpm-sign-rule/ | 官方手冊 |
| 6 | 同上〈單據管理〉 | https://docs.uof.tw/operationdoc/v2026R2.132/bpm/form-mgmt/ | 官方手冊 |
| 7 | 同上〈流程設計〉 | https://docs.uof.tw/operationdoc/v2026R2.132/bpm/bpm-flow/ | 官方手冊 |
| 8 | 同上〈表單權限與發佈設定〉 | https://docs.uof.tw/operationdoc/v2026R2.132/bpm/bpm-permissions-release/ | 官方手冊 |
| 9 | 同上〈活動日誌〉 | https://docs.uof.tw/operationdoc/v2026R2.132/base/system-setting/activitylog/ | 官方手冊 |
| 10 | 同上〈後台活動日誌〉 | https://docs.uof.tw/operationdoc/v2026R2.132/base/activitylog/backend-activitylog/ | 官方手冊 |
| 11 | 同上〈表單簽核〉 | https://docs.uof.tw/operationdoc/v2026R2.132/bpm/bpm-from-approving/ | 官方手冊 |
| 12 | 同上〈結案後流程〉 | https://docs.uof.tw/operationdoc/v2026R2.132/bpm/bpm-flow-after-closure/ | 官方手冊 |
| 13 | 一等一科技 產品頁（BPM 工作流程；UOF X） | https://www.edetw.com/bpm/ 、 https://www.edetw.com/uofx-about/ | 廠商產品頁 |
| 14 | NUEIP nuBPM〈BPM流程管理與電子簽核系統〉 | https://www.nueip.com/nubpm/process-design | 廠商產品頁 |
| 15 | NUEIP nuBPM〈多簽核權限數位化流程有保障〉 | https://www.nueip.com/nubpm/project-management | 廠商產品頁 |
| 16 | NUEIP 價格頁 | https://www.nueip.com/pricing 、 https://nueip.com/en/pricing | 頁面不列價格 |
| 17 | 叡揚資訊〈電子簽核是什麼？3分鐘了解簽核系統挑選重點〉 | https://www.gss.com.tw/e-forum/user-tell/3766-3 | 廠商文章 |
| 18 | 叡揚資訊 Tracko 多源智慧追蹤平台 | https://www.gss.com.tw/tracko | 廠商產品頁 |
| 19 | INSIDE〈安葆電能部署逐鹿數位 BPM…〉 | https://www.inside.com.tw/article/35073-MetaGuru | 403，僅搜尋摘要；案例報導 |

### 國際簽核與流程工具

| # | 標題 | 網址 | 備註 |
|---|---|---|---|
| 20 | Atlassian JSDSERVER-5231 "Add option to prevent reporter approving their own request" | https://jira.atlassian.com/browse/JSDSERVER-5231 | 官方議題追蹤；2017-07-06 建立，2025-04-23 更新 |
| 21 | Atlassian JSDCLOUD-6678 "Prevent customers to add themselves as Approver" | https://jira.atlassian.com/browse/JSDCLOUD-6678 | 官方議題追蹤；Closed／Duplicate |
| 22 | Microsoft Learn "Manage the Approvals app in Microsoft Teams" | https://learn.microsoft.com/en-us/microsoftteams/approval-admin | 官方文件，ms.date 2026-04-14 |
| 23 | Microsoft Learn "Known issues"（Power Automate approvals） | https://learn.microsoft.com/en-us/power-automate/approvals-known-issues | 官方文件，ms.date 2026-04-29 |
| 24 | Microsoft Learn "Limits of automated, scheduled, and instant flows" | https://learn.microsoft.com/en-us/power-automate/limits-and-config | 官方文件，ms.date 2026-11-10 |
| 25 | Microsoft Power Automate pricing | https://www.microsoft.com/en-us/power-platform/products/power-automate/pricing/ | 官方定價頁 |
| 26 | Kissflow Community "Admin actions in a process" | https://community.kissflow.com/t/60h9qtj/admin-actions-in-a-process | 官方說明文章 |
| 27 | Kissflow Community "Product tip: How to edit a Kissflow process item after you have submitted it" | https://community.kissflow.com/t/83h4avh/product-tip-how-to-edit-a-kissflow-process-item-after-you-have-submitted-it | 官方說明文章 |
| 28 | Kissflow Community "Product tip: What are audit logs in Kissflow and how to use them" | https://community.kissflow.com/t/83h9qrp/product-tip-what-are-audit-logs-in-kissflow-and-how-to-use-them | 官方說明文章 |
| 29 | Kissflow Pricing | https://kissflow.com/pricing/ | 不列價格 |
| 30 | Zoho Creator Help "Approvals in live mode" | https://help.zoho.com/portal/en/kb/creator/developer-guide/workflows/approval-workflows/articles/approval-workflow-in-application-s-live-mode | 官方文件 |
| 31 | Zoho Creator Help "Understanding approval workflows" | https://help.zoho.com/portal/en/kb/creator/user-guide/process-automation/approval/articles/understand-approval-process | 官方文件 |
| 32 | Zoho Creator Pricing | https://www.zoho.com/creator/pricing.html | 官方定價頁 |
| 33 | Pipefy Help "Audit logs for pipes and cards" | https://help.pipefy.com/en/articles/15062678-audit-logs-for-pipes-and-cards | 官方文件 |
| 34 | Nintex Community "No audit trail on task delegation in NAC" | https://community.nintex.com/nintex-workflow-2/no-audit-trail-on-task-delegation-in-nac-73843 | 論壇；2026-02-27 夥伴發文，原廠員工回覆 |
| 35 | Camunda Jira CAM-14479 "Exclusion list for task assignment - 4 eyes principle" | https://jira.camunda.com/browse/CAM-14479 | 官方議題追蹤；2022-03-22 建立，Open |
| 36 | Camunda 7 Docs "User Operation Log" | https://docs.camunda.org/manual/latest/user-guide/process-engine/history/user-operation-log/ | 官方文件 |
| 37 | ServiceNow Community "Change Request, Change Requested by not allowed to approve…" | https://www.servicenow.com/community/itsm-forum/change-request-change-requested-by-not-allowed-to-approve-of-the/m-p/2861423 | 論壇；2024-03-13 |
| 38 | ServiceNow Community "Approval records disappear if you remove approvers…" | https://www.servicenow.com/community/itsm-forum/approval-records-disappear-if-you-remove-approvers-with-a/td-p/665552 | 論壇；2013-06-12，原廠員工回覆 |

### 存取權治理

| # | 標題 | 網址 | 備註 |
|---|---|---|---|
| 39 | Microsoft Learn "Change approval settings for an access package in entitlement management" | https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-approval-policy | 官方文件，ms.date 2025-06-26 |
| 40 | Microsoft Learn "What is entitlement management?" | https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-overview | 官方文件，ms.date 2024-11-25，2026-10-29 更新 |
| 41 | Okta Support "Access Request expected reviewer self-attestation behavior" | https://support.okta.com/help/s/article/access-request-expected-reviewer-self-attestation-behavior | 官方支援文章 |
| 42 | Opal Docs "End user FAQ" | https://docs.opal.dev/docs/end-user-faq | 官方文件 |
| 43 | SailPoint Developer Community "Prevent Managers Self approval access request" | https://developer.sailpoint.com/discuss/t/prevent-managers-self-approval-access-request/175731 | 論壇；2025-09-02；IdentityIQ 8.4 |
| 44 | C1（原 ConductorOne）Access Requests | https://www.c1.ai/products/access-requests | 廠商產品頁（conductorone.com 轉址） |
| 59 | Microsoft Learn "Configure separation of duties checks for an access package" | https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-incompatible | 官方文件；僅搜尋摘要 |

### GRC 與合規自動化

| # | 標題 | 網址 | 備註 |
|---|---|---|---|
| 45 | ServiceNow Docs "Evidence request workflow"（Audit Management） | https://www.servicenow.com/docs/r/governance-risk-compliance/audit-management/evidence-request-workflow.html | 官方文件 |
| 46 | Archer 新聞稿 "Archer Extends Archer Evolv Capabilities with Continuous Controls Monitoring…" | https://www.archerirm.com/press-releases/archer%C2%AE-extends-archer-evolv%E2%84%A2-capabilities-with-continuous-controls-monitoring-to-automate-it-control-assurance | 廠商新聞稿，2025-11-19 |
| 47 | Hyperproof Help "Hypersync overview" | https://intercom.help/hyperproofio/en/articles/14303894-hypersync-overview | 官方文件 |
| 48 | Vanta Help "Managing access requests in Vanta" | https://help.vanta.com/en/articles/11345423-managing-access-requests-in-vanta | 官方文件 |
| 49 | Drata Help "Create and manage tickets in Drata" | https://help.drata.com/en/articles/13688350-create-and-manage-tickets-in-drata | 官方文件 |
| 50 | Secureframe Blog "Secureframe + Indent Simplifies Compliance for Access Control Change Management" | https://secureframe.com/blog/indent-partnership | 廠商部落格；頁面無日期，搜尋摘要標示 2022 年 |
| 51 | Optro Blog "Meet Optro: AuditBoard Unveils New Identity as AI Transforms GRC" | https://optro.ai/blog/meet-optro-auditboard-unveils-new-identity-as-ai-transforms-grc | 僅搜尋摘要；2026-03-09 |

### Slack

| # | 標題 | 網址 | 備註 |
|---|---|---|---|
| 52 | Slack Help "Edit or delete messages" | https://slack.com/help/articles/202395258-Edit-or-delete-messages | 官方文件 |
| 53 | Slack Developer Docs "Audit Logs API" | https://docs.slack.dev/admins/audit-logs-api/ | 官方文件 |

### 市場規模

| # | 標題 | 網址 | 備註 |
|---|---|---|---|
| 54 | Mordor Intelligence "Workflow Automation Market Size and Share" | https://www.mordorintelligence.com/industry-reports/workflow-automation-market | 商業研究摘要頁；基準年 2025 |
| 55 | Fortune Business Insights "Identity Governance and Administration Market" | https://www.fortunebusinessinsights.com/identity-governance-and-administration-market-110229 | 商業研究摘要頁；2026-11-02 更新 |
| 56 | Verdantix 新聞稿 "Geopolitical Shocks And AI Risks Push GRC Software Market Towards $11 Billion…" | https://www.verdantix.com/insights/press-release/geopolitical-shocks-and-ai-risks-push-grc-software-market-towards--11-billion-as-legacy-risk-tools-struggle-to-keep-pace | 研究機構新聞稿，2026-07-22 |
| 57 | MarketsandMarkets "eGRC Market" 新聞稿 | https://www.marketsandmarkets.com/PressReleases/enterprise-governance-risk-compliance.asp | 403，僅搜尋摘要 |
| 58 | Grand View Research "Identity Governance and Administration Market"（經 MarketResearch.com 列表） | https://www.marketresearch.com/Grand-View-Research-v4060/Identity-Governance-Administration-Size-Share-42298019 | 僅搜尋摘要 |
