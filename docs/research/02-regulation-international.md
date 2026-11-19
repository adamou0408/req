# 02 國際法規、框架與稽核實務

- 查閱日期：2026-11-19
- 目的：找出哪些需求是法規或稽核逼出來的，作為判斷產品終極目標的依據。
- 讀法：
  - 帶來源編號（例如 [S16]）的句子是來源直接寫的事實；引號內是原文。
  - 標「【推論】」的是本文作者的判斷，不是來源的說法。
  - 標「【未核對原文】」的是只拿到二手摘要、沒有拿到標準原文的內容。
  - 查不到的事項集中在第 4 節。
- 取材限制：ISO 與 AICPA 的原文需付費或登入，本文對這兩者只能引二手來源，已逐處標明。初稿後段網頁搜尋額度用完；2026-11-19 已由獨立查證者重新搜尋並逐項核對原文（見第 6 節）。

## 1. 重點結論

1. 各框架對存取治理的要求可以收斂成同一組控制目標：授予前經核准、最小權限、職責分離、異動與離職即時收回、定期複查、特權另管、紀錄可歸責且受保護；差別只在頻率與強度 [S2][S10][S14][S16][S19][S21]。
2. 稽核人員不只看「有沒有核准紀錄」，還要先證明拿來當證據的報表本身完整且正確（IPE）；PCAOB 2021、2022 兩個檢查年度各有約 17% 的 comment form 含這類缺失 [S2][S3]。
3. 存取權管理是 SOX 範圍內持續上升的缺失來源：KPMG 統計的重大缺失根因中，涉及「IT、軟體、安全與存取」的比例從 2021 年的 31% 升到 2025 年的 58%（原圖附註寫分母是 2021–2025 合計 1,176 份報告，各年比例怎麼算原文沒有說明）；2026 年 2 月 KPMG 對 2,900 多位稽核與風險主管的調查，存取權複查缺失排 IT 範疇第一（36%） [S4][S6]。
4. 定期複查已經有寫明數字的強制頻率：PCI DSS 7.2.4 至少每六個月；DORA 的 RTS 第 21 條 (e)(iv) 要求存取權「update」至少每年、支援關鍵或重要功能的系統至少每 6 個月（原文用「更新」而非「複查」，複查角色另見 (e)(i)）；ISO、NIST、NIS2、SOC 2、SOX 則是「定期」或「組織自訂」 [S16][S21][S10][S19]。
5. 複查要留下的不是「做過」，而是「管理階層確認仍適當」加上「不適當的已處理」這兩項證據 [S16][S19][S10]。
6. 服務帳號與系統帳號已被納入和人員同等的治理：PCI DSS 7.2.5、7.2.5.1、8.6.1 自 2025-03-31 起強制；DORA 的 RTS 第 20 條把「natural persons and systems」並列 [S16][S21]。
7. AI agent 目前沒有查到任何強制法條直接規定「每個 agent 要有負責人、權限要經核准」；但新加坡 IMDA、NIST NCCoE、OWASP 的指引方向一致，EU AI Act 第 14、26 條只對高風險 AI 系統要求指派有權限的自然人監督，且依 2026-07-24 刊登公報的 Regulation (EU) 2026/1744，Annex III 類高風險系統的適用日已延到 2027-12-02；台灣金管會 2026-10-13 發布的代理 AI 文件仍在 30 天徵詢階段 [S33][S27][S30][S31][S22][S40][S42]。
8. 防竄改紀錄的規範已從「只能 WORM」放寬為「WORM 或完整的時間戳稽核軌跡」（SEC 17a-4，2023-05-03 起）；NIST、PCI DSS、DORA 都要求防修改並能偵測修改 [S34][S35][S10][S16][S21]。
9. NIST 的零信任架構把「做決定」和「執行決定」拆成兩個元件，並要求每次存取前都強制判定；SP 800-53 的 AC-24 明文允許決策與執行由不同實體負責，這是平台對外提供判定介面的規範依據 [S12][S10]。
10. 「能證明」本身是法定義務：GDPR 第 5(2) 條要求控管者能證明合規，NIS2 第 20(1) 條要求管理階層核准資安措施並可被追究責任 [S17][S18]。

## 2. 詳細內容

### 2.1 SOX 404 與 ITGC

#### 法條與準則的層次

| 層次 | 內容 | 來源 |
|---|---|---|
| 法律 | SOX §404(a)：年報須含內控報告，要「state the responsibility of management for establishing and maintaining an adequate internal control structure and procedures for financial reporting」，並評估其有效性。§404(b)：簽證會計師須「attest to, and report on, the assessment made by the management of the issuer」 | [S1] |
| 稽核準則 | PCAOB AS 2201（內控稽核）、AS 2110（風險辨識）、AS 1105（證據）、AS 2315（抽樣） | [S2] |
| 實務名詞 | 「ITGC」三個領域出現在 AS 2201.B29：「general controls over program changes, access to programs, and computer operations」 | [S2] |

SOX 法條本身沒有列出存取控制或職責分離的要求；這些要求來自稽核準則對 IT 風險的描述，以及稽核人員據此設計的測試 [S1][S2]。

#### 準則點名的 IT 風險（AS 2110 附錄 B，.B4）

原文列舉的風險中，與本平台直接相關的有 [S2]：

- 「Unauthorized access to data that might result in destruction of data or improper changes to data, including the recording of unauthorized or non-existent transactions」
- 「The possibility of IT personnel gaining access privileges beyond those necessary to perform their assigned duties, thereby breaking down segregation of duties」
- 「Unauthorized changes to data in master files」
- 「Unauthorized changes to systems or programs」
- 「Inappropriate manual intervention」

#### 稽核人員怎麼測試

| 準則要求 | 原文 | 對平台的意義 |
|---|---|---|
| 設計有效性（AS 2201.42） | 控制要由「persons possessing the necessary authority and competence」執行才算有效 | 簽核人的資格（是不是該資源的負責人、是不是主管）要可查 |
| 執行有效性（AS 2201.44） | 要判定「whether the person performing the control possesses the necessary authority and competence to perform the control effectively」 | 每筆簽核要記下簽核人當時的角色與取得資格的依據 |
| 證據強度（AS 2201.50） | 由弱到強：「inquiry, observation, inspection of relevant documentation, and re-performance of a control」；且「Inquiry alone does not provide sufficient evidence」 | 稽核會要求重新執行：拿同一筆輸入，看結果是否相同。規則、參數、流程版本都要保留 |
| 風險與證據量（AS 2201.46–.47） | 控制的風險越高，要取得的證據越多；風險因素包含控制是否依賴 ITGC、是人工還是自動 | 自動化控制在 ITGC 有效時風險較低 |
| 自動化控制的基準測試（AS 2201.B28–.B29） | 全自動的應用控制「generally not subject to breakdowns due to human failure」；若程式變更、程式存取、電腦作業三項一般控制有效，且控制自上次測試後沒有變更，稽核人員可以不重做前一年的測試 | 把職責分離做成引擎強制，並能證明規則沒被改過，可以減少每年的測試量 |
| 抽樣（AS 2315.32） | 「For many tests of controls, sampling does not apply」；「Sampling generally is not applicable to tests of controls that depend primarily on appropriate segregation of duties or that otherwise provide no documentary evidence of performance」 | 【推論】職責分離的測試不靠抽單，稽核會改用觀察、詢問或檢查設定；平台要讓「規則設定與版本」本身可以被檢查 |

【推論】上表合起來的意思是：把職責分離、版本綁定這類規則做成「設定繞不過去」的自動化控制，稽核成本最低；但前提是平台要能證明規則本身的變更受控（對應 AS 2201.B29 的 program changes）。

#### IPE：證據本身也要被驗證

- AS 1105.10：使用公司產生的資訊當證據時，稽核人員應「Test the accuracy and completeness of the information, or test the controls over the accuracy and completeness of that information」，並「Evaluate whether the information is sufficiently precise and detailed for purposes of the audit」 [S2]。
- AS 1105.08：「The reliability of information generated internally by the company is increased when the company's controls over that information are effective」；原始文件比轉換過的電子檔可靠，後者的可靠度「depends on the controls over the conversion and maintenance of those documents」 [S2]。
- PCAOB 2024 年 4 月的檢查觀察：2021、2022 兩個檢查年度各約 17% 的 comment form 含有「did not perform sufficient procedures to test (or sufficiently test controls over) the accuracy and completeness of IPC or other data and reports」的缺失 [S3]。
- 同一份文件引用 Staff Practice Alert 11：控制如果使用系統產生的報表，「the effectiveness of the control depends in part on the controls over the accuracy and completeness of the system-generated data or reports」 [S3]。
- KPMG 的重大缺失研究也把「proper documentation of completeness and accuracy of Information Produced by the Entity (IPE)」列為財務結帳領域被點名的問題 [S4]。

【推論】平台匯出的每一份清單（授權清單、複查清單、對帳結果）都會被當成 IPE。稽核會問：這份清單是怎麼產生的、條件是什麼、有沒有漏。平台應在產生清單時就把產生條件、筆數、時間、雜湊一起封存。

#### 缺失統計

| 數字 | 內容 | 來源與年份 |
|---|---|---|
| 7%（238 / 3,307） | FY'25 年報中揭露重大缺失的公司比例 | KPMG 2025 study，資料來自 Audit Analytics，截至 2025-06-30 [S4] |
| 31% → 40% → 52% → 54% → 58% | 根因涉及「IT, software, security, and access issues」的比例，2021 至 2025。原圖附註：「Percentages are calculated by dividing the number of companies with MWs in a category by total number of reports between 2021 and 2025 (1,176)」；逐年比例的分母原文沒有另外說明 | 同上 [S4] |
| 37%（前一年 30%） | 2025 年重大缺失落在「Systems」流程領域的比例 | 同上 [S4] |
| 原文描述 | Systems 領域「A vast majority reported issues in managing user access, including inappropriate access rights, failure to timely manage terminated users, and inadequate access reviews」，另有「lack of enforcement of proper SOD」 | 同上 [S4] |
| 36% | IT 範疇的 SOX 問題中選「User access review deficiencies」的比例，排第一；第二是「Key report/IPE deficiencies」28% | KPMG 2026 年 2 月網路研討會即時調查，受訪者 2,900 多位稽核與風險主管 [S6] |
| 首次排第一 | IT 問題首次成為會計師出具否定內控意見時最常被引用的問題 | KPMG 2024 年 4 月轉述 Ideagen Audit Analytics《SOX 404 Disclosures: A 19-Year Review 2004–2022》 [S5] |

KPMG 列出導致否定內控意見的 IT 問題，第一項是「Weak access controls over system administration」，內容包含「lack of segregation of duties, excessive user privileges, weak password policies for shared service or vendor accounts, inadequate user access monitoring, and untimely access removal when employees or contractors are terminated or transferred」 [S5]。

注意：[S4] 的百分比分母不同（有的是揭露重大缺失的公司數，有的是五年合計報告數 1,176），引用時要看原圖的註記 [S4]。

### 2.2 ISO/IEC 27001:2022 附錄 A

【未核對原文】ISO/IEC 27001:2022 與 27002:2022 需付費，本節的控制編號與主題取自公開的對照表 [S8]，要點取自顧問公司對 27002:2022 的摘要 [S9]，不是標準原文。附錄 A 的控制敘述很短，實作指引在 27002。

| 編號 | 主題（[S8] 的描述） | 要點（[S9] 的摘要） |
|---|---|---|
| 5.3 | Segregation of duties between conflicting roles | 目的是「reduce the risk of fraud, error and bypassing of information security controls」；應分離的活動舉例：「initiating, approving and executing a change」、「requesting, approving and implementing access rights」；無法分離時用「activities monitoring, audit trails and management supervision」補償 |
| 5.15 | Access control policy and rules | 依業務與資安需求訂定實體與邏輯存取規則（[S9] 未取得此頁，僅有 [S8] 的主題） |
| 5.16 | Identity management from creation to removal | 身分從建立到移除的生命週期（僅 [S8]） |
| 5.18 | Managing access rights, including regular reviews | 資產擁有者要授權；核准與實作可由不同人擔任；每個識別碼的存取權要記在集中的存取管理系統；存取權要「reviewed and verified regularly」，職務異動、升降、離職時要重新評估；不再需要時「revoked immediately」。[S9] 指出 2013 年版對特權要更頻繁複查的要求沒有延續到 2022 年版 |
| 8.2 | Limiting and controlling privileged access rights | 要有明確的特權授權流程並記錄每一筆已授予的特權；特權要有到期日；定期稽核；緊急（break glass）存取限時；所有特權活動留紀錄 |
| 8.3 | Restricting access to information under access control rules | 依存取規則限制資訊存取（僅 [S8]） |
| 8.15 | Event logging, with logs kept safe and reviewed | 紀錄應含使用者識別、活動、時間戳、裝置與位置、網路位址；使用者不論權限高低都不能刪改自己的紀錄；保護方法列出「cryptographic hashing, append-only recording, read-only recording, and public transparency files」 |
| 8.16 | Monitoring networks and systems for unusual behaviour | 監控異常（僅 [S8]） |
| 8.17 | Clock synchronisation to a trusted time source | 紀錄要連到同一個同步的時間來源 |
| 5.28 | Collecting and preserving evidence of security events | 蒐集與保存事件證據（僅 [S8]） |
| 5.33 | Protection of records against loss and misuse | 保護紀錄免於遺失與濫用（僅 [S8]） |
| 8.32 | Change management for IT systems and services | 變更管理（僅 [S8]） |

[S8] 同時給出與 NIST SP 800-53 的對應：5.3 對 AC-5，5.18 對 AC-2，8.2 對 AC-6、AC-2、CM-5，8.15 對 AU-2、AU-3、AU-6、AU-9、AU-11、AU-12，8.17 對 AU-8 [S8]。

ISO 27001 對複查頻率沒有固定數字，只要求定期 [S9]【未核對原文】。

### 2.3 NIST SP 800-53 Rev.5 的 AC、AU，以及零信任與持續授權

版本：引文取自 2020 年 9 月發布、含 2020-12-10 更新的 PDF [S10]。NIST 於 2025-08-27 發布 Release 5.2.0，公告列出的變更在 SA、SI 家族，AC、AU 只列了 AU-02、AU-03 的「Related Controls」更新 [S11]。

#### AC（存取控制）

| 控制 | 原文重點 | 來源 |
|---|---|---|
| AC-2 帳號管理 | (b)「Assign account managers」；(e)「Require approvals by [organization-defined personnel or roles] for requests to create accounts」；(g)「Monitor the use of accounts」；(h) 帳號不再需要、人員離職或調動、使用需求改變時，在組織定義的時間內通知帳號管理人；(i) 授權依據「A valid access authorization」「Intended system usage」；(j)「Review accounts for compliance with account management requirements [organization-defined frequency]」 | [S10] |
| AC-2 的說明 | 帳號類型的例子：「individual, shared, group, system, guest, anonymous, emergency, developer, temporary, and service」 | [S10] |
| AC-2(1) | 以自動化機制管理系統帳號，包含異動時通知帳號管理人 | [S10] |
| AC-2(3) 停用帳號 | 帳號在下列情況於組織定義的時間內停用：「(a) Have expired; (b) Are no longer associated with a user or individual; (c) Are in violation of organizational policy; or (d) Have been inactive for [organization-defined time period]」 | [S10] |
| AC-3(2) 雙重授權 | 「Enforce dual authorization for [organization-defined privileged commands and/or other organization-defined actions]」；說明：為降低共謀風險，組織應考慮輪替 | [S10] |
| AC-5 職責分離 | 「a. Identify and document [organization-defined duties of individuals requiring separation]; and b. Define system access authorizations to support separation of duties」；說明：職責分離的違反可能跨系統與應用領域，組織要從整體來看 | [S10] |
| AC-6 最小權限 | 只允許完成任務所需的授權存取，適用於使用者，也適用於「processes acting on behalf of users」 | [S10] |
| AC-6(7) 權限複查 | 「(a) Review [organization-defined frequency] the privileges assigned to [organization-defined roles or classes of users] to validate the need for such privileges; and (b) Reassign or remove privileges, if necessary」 | [S10] |
| AC-6(9) | 「Log the execution of privileged functions」 | [S10] |
| AC-24 存取控制決策 | 確保存取控制決策「are applied to each access request prior to access enforcement」；說明：「While it is common to have access control decisions and access enforcement implemented by the same entity, it is not required」 | [S10] |
| AC-24(1) | 把存取授權資訊傳送給「systems that enforce access control decisions」 | [S10] |
| IA-9 | 對系統服務與應用程式做唯一識別與驗證 | [S10] |

#### AU（稽核與可歸責）

| 控制 | 原文重點 | 來源 |
|---|---|---|
| AU-3 紀錄內容 | 要能確立：「a. What type of event occurred; b. When the event occurred; c. Where the event occurred; d. Source of the event; e. Outcome of the event; and f. Identity of any individuals, subjects, or objects/entities associated with the event」 | [S10] |
| AU-9 紀錄保護 | 「a. Protect audit information and audit logging tools from unauthorized access, modification, and deletion; and b. Alert [organization-defined personnel or roles] upon detection of unauthorized access, modification, or deletion of audit information」 | [S10] |
| AU-9(1) | 「Write audit trails to hardware-enforced, write-once media」（選用的增強項） | [S10] |
| AU-9(2) | 依組織定義的頻率，把稽核紀錄存到「a repository that is part of a physically different system or system component than the system or component being audited」（選用的增強項） | [S10] |
| AU-9(3) | 「Implement cryptographic mechanisms to protect the integrity of audit information and audit tools」 | [S10] |
| AU-9(4) | 只授權特權使用者中的一部分管理稽核紀錄功能；說明指出被稽核的特權使用者本身可能影響稽核資訊的可靠性 | [S10] |
| AU-10 不可否認 | 「Provide irrefutable evidence that an individual (or process acting on behalf of an individual) has performed [organization-defined actions]」；說明舉的例子包含「approving a procurement request」 | [S10] |
| AU-11 保存 | 保存期間由組織依紀錄保存政策訂定，用來支援事後調查並符合法規要求 | [S10] |

SP 800-53 對複查頻率、保存期間都留給組織定義，沒有固定數字 [S10]。

#### 零信任（SP 800-207，2020 年 8 月）

| 原則 | 原文 | 來源 |
|---|---|---|
| 原則 3 | 「Access to individual enterprise resources is granted on a per-session basis」；「authentication and authorization to one resource will not automatically grant access to a different resource」 | [S12] |
| 原則 4 | 「Access to resources is determined by dynamic policy」；用戶端身分包含「the user account (or service identity)」 | [S12] |
| 原則 6 | 「All resource authentication and authorization are dynamic and strictly enforced before access is allowed. This is a constant cycle of obtaining access, scanning and assessing threats, adapting, and continually reevaluating trust」 | [S12] |
| 元件 | Policy engine「makes and logs the decision (as approved, or denied)」；policy administrator 執行決定，若先前的核准被撤回，就通知 PEP 關閉連線；PEP 負責「enabling, monitoring, and eventually terminating connections between a subject and an enterprise resource」 | [S12] |

【推論】對應到本平台：平台是決策與紀錄的一方（做決定並留下決定的紀錄），各系統是執行的一方。撤銷要能通知到執行方，這是 SP 800-207 明寫的行為，不是加分項。

#### 持續授權

- SP 800-37 Rev.2 主張用自動化支援「ongoing authorization approaches—together facilitating a real-time or near real-time risk-based decision-making process for senior leaders」 [S13]。
- SP 800-53 的 CA-6(e) 要求「Update the authorizations [organization-defined frequency]」；CA-7 要求建立系統層級的持續監控，包含要監控的指標、監控與評估的頻率、對分析結果的回應 [S10]。
- 注意：這裡的 authorization 指「系統獲准上線運作」，不是使用者的存取授權 [S10][S13]。【推論】兩者的共同概念是：核准不是一次性的，要靠持續的監控資料維持有效。

### 2.4 SOC 2（CC6 系列）與 PCI DSS v4.0.1（要求 7、8、10）

#### SOC 2

【未核對原文】AICPA 的 Trust Services Criteria 需登入才能下載。以下準則文字取自開源專案對 2017 年版準則的轉錄 [S14]，未能與 AICPA 原文逐字核對。

| 準則 | 文字（[S14] 的轉錄） |
|---|---|
| CC6.1 | 「The entity implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events to meet the entity's objectives」 |
| CC6.2 | 「Prior to issuing system credentials and granting system access, the entity registers and authorizes new internal and external users whose access is administered by the entity. For those users whose access is administered by the entity, user system credentials are removed when user access is no longer authorized」 |
| CC6.3 | 「The entity authorizes, modifies, or removes access to data, software, functions, and other protected information assets based on roles, responsibilities, or the system design and changes, giving consideration to the concepts of least privilege and segregation of duties, to meet the entity's objectives」 |
| CC8.1 | 「The entity authorizes, designs, develops or acquires, configures, documents, tests, approves, and implements changes to infrastructure, data, software, and procedures to meet its objectives」 |

2022 年修訂的 points of focus 沒有改準則本身；修訂後的指引強調「reviewing access credentials on a periodic basis for validity」，對象包含員工、承包商、廠商，並要找出不適當的系統或服務帳號 [S15]【二手來源】。SOC 2 沒有規定複查頻率的數字 [S14][S15]。

#### PCI DSS v4.0.1（2024 年 6 月）

版本狀態：v4.0.1 仍是現行版本。PCI SSC 在 2026-06-03 至 2026-07-20 對 v4.0.1 辦了公開徵詢，目的寫的是「help determine whether to revise, and what type of revisions are needed」；查閱日沒有看到下一版的發布日期 [S41]。【推論】條號在可見的將來不會變，但 2027 年後可能改版，控制對照表要記下引用的版本。

以下都是 Defined Approach Requirements 的原文 [S16]。標「2025-03-31 起強制」的是原文註記「This requirement is a best practice until 31 March 2025, after which it will be required」的要求。

| 要求 | 原文 | 備註 |
|---|---|---|
| 7.2.1 | 存取控制模型要依職務分類與功能授予存取，並採「The least privileges required」 | |
| 7.2.3 | 「Required privileges are approved by authorized personnel」；目標：「Access privileges cannot be granted to users without appropriate, documented authorization」 | 核准要有文件 |
| 7.2.4 | 「All user accounts and related access privileges, including third-party/vendor accounts, are reviewed as follows: At least once every six months. To ensure user accounts and access remain appropriate based on job function. Any inappropriate access is addressed. Management acknowledges that access remains appropriate」 | 2025-03-31 起強制 |
| 7.2.5 | 應用程式與系統帳號的權限「Based on the least privileges necessary for the operability of the system or application」，且存取限於確實需要的系統、應用程式或程序 | 2025-03-31 起強制 |
| 7.2.5.1 | 應用程式與系統帳號的存取要複查：「Periodically (at the frequency defined in the entity's targeted risk analysis…)」；不當存取要處理；「Management acknowledges that access remains appropriate」 | 2025-03-31 起強制；頻率由風險分析決定 |
| 8.2.1 | 「All users are assigned a unique ID before access to system components or cardholder data is allowed」 | |
| 8.2.2 | 共用或通用帳號只能例外使用：使用時間限於例外情況所需、有書面的業務理由、「Use is explicitly approved by management」、存取前確認個人身分、「Every action taken is attributable to an individual user」 | |
| 8.2.4 | 使用者 ID 與驗證因子的新增、刪除、修改要「Authorized with the appropriate approval」且「Implemented with only the privileges specified on the documented approval」 | 實際設定不得超出核准範圍 |
| 8.2.5 | 「Access for terminated users is immediately revoked」 | |
| 8.2.6 | 「Inactive user accounts are removed or disabled within 90 days of inactivity」 | |
| 8.6.1 | 系統或應用程式帳號若可互動登入：原則上禁止、例外時限時、有書面理由、管理階層明確核准、每個動作可歸責到個人 | 2025-03-31 起強制 |
| 10.2.1.2 | 稽核紀錄要包含有管理權限者的所有動作，「including any interactive use of application or system accounts」 | |
| 10.2.1.3 | 「Audit logs capture all access to audit logs」 | 讀取紀錄本身也要留紀錄 |
| 10.2.1.5 | 稽核紀錄要包含身分與驗證資料的變更，含建立帳號、提升權限、管理帳號的異動 | |
| 10.2.2 | 每筆事件要記：使用者識別、事件類型、日期與時間、成功或失敗、事件來源、受影響的資料或資源 | |
| 10.3.1 | 稽核紀錄的讀取權限於有職務需要的人 | |
| 10.3.2 | 「Audit log files are protected to prevent modifications by individuals」 | |
| 10.3.3 | 稽核紀錄要及時備份到「a secure, central, internal log server(s) or other media that is difficult to modify」 | |
| 10.3.4 | 用檔案完整性監控或變更偵測機制，確保「existing log data cannot be changed without generating alerts」 | 偵測修改 |
| 10.5.1 | 「Retain audit log history for at least 12 months, with at least the most recent three months immediately available for analysis」 | |
| 10.6.1、10.6.3 | 系統時鐘要同步；時間設定的變更要「logged, monitored, and reviewed」 | |

### 2.5 GDPR、NIS2、DORA

引文取自歐盟官方公報的原始版本，未比對合併版 [S17][S18][S19][S20][S21]。

#### GDPR（Regulation (EU) 2016/679）

| 條文 | 原文 | 與存取治理的關係 |
|---|---|---|
| 第 5(1)(f) 條 | 個資處理要確保「appropriate security of the personal data, including protection against unauthorised or unlawful processing」 | 未經授權的存取就是違反原則 |
| 第 5(2) 條 | 「The controller shall be responsible for, and be able to demonstrate compliance with, paragraph 1 ('accountability')」 | 要能提出證據 |
| 第 25(2) 條 | 預設只處理各特定目的所必要的個資，適用於「the amount of personal data collected, the extent of their processing, the period of their storage and their accessibility」；預設不得讓不特定多數人取得 | 預設最小權限、限期 |
| 第 32(1) 條 | 措施包含 (b)「the ability to ensure the ongoing confidentiality, integrity, availability and resilience of processing systems and services」、(d)「a process for regularly testing, assessing and evaluating the effectiveness of technical and organisational measures」 | 定期評估控制有效性 |
| 第 32(2) 條 | 評估安全等級時要考慮「unauthorised disclosure of, or access to personal data」的風險 | |
| 第 32(4) 條 | 控管者與處理者要確保在其授權下能接觸個資的自然人「does not process them except on instructions from the controller」 | 存取要有授權依據 |

GDPR 沒有寫出「存取權複查」或「紀錄保存期間」的具體數字 [S17]。

#### NIS2（Directive (EU) 2022/2555）與執行規則（Implementing Regulation (EU) 2024/2690）

- 第 20(1) 條：管理階層要「approve the cybersecurity risk-management measures」、監督其實施，並「can be held liable for infringements」 [S18]。
- 第 21(2) 條：措施至少包含 (i)「human resources security, access control policies and asset management」、(j) 多因子或持續驗證 [S18]。
- 執行規則 2024/2690 只適用於 DNS、雲端運算、資料中心、CDN、受管理服務、線上市集、搜尋引擎、社群平台、信任服務等特定類型的業者 [S19]。它的附錄把第 21(2) 條寫成具體要求：

| 附錄條號 | 原文 | 來源 |
|---|---|---|
| 11.1.2 | 存取控制政策要涵蓋人員的存取，也要「address access by network and information systems」 | [S19] |
| 11.2.2 | 「(a) assign and revoke access rights based on the principles of need-to-know, least privilege and separation of duties; (b) ensure that access rights are modified accordingly upon termination or change of employment; (c) ensure that access to network and information systems is authorised by the relevant persons; (d) … limiting access rights in scope and in duration; (e) maintain a register of access rights granted; (f) apply logging to the management of access rights」 | [S19] |
| 11.2.3 | 「The relevant entities shall review access rights at planned intervals and shall modify them based on organisational changes. The relevant entities shall document the results of the review including the necessary changes of access rights」 | [S19] |
| 11.3.3 | 特權帳號與系統管理帳號的存取權同樣要依計畫的間隔複查，並把結果與必要的變更記錄下來 | [S19] |
| 3.2.3 | 紀錄在適當時應包含 (b) 使用者的建立、修改、刪除與權限擴大、(e) 所有特權存取與管理帳號的活動、(k)「activation, stopping and pausing of the various logs」 | [S19] |
| 3.2.5 | 紀錄要保存並備份一段預先定義的期間，並「protect them from unauthorised access or changes」 | [S19] |
| 3.2.6 | 在可行範圍內所有系統要有同步的時間來源 | [S19] |

#### DORA（Regulation (EU) 2022/2554）與 RTS（Delegated Regulation (EU) 2024/1774）

DORA 自 2025-01-17 起適用 [S20]。

| 條文 | 原文 | 來源 |
|---|---|---|
| DORA 第 9(4)(c) 條 | 政策要把存取限於「what is required for legitimate and approved functions and activities only」，並建立處理存取權的政策、程序與控制，以「ensure a sound administration thereof」 | [S20] |
| DORA 第 9(4)(e) 條 | ICT 變更管理要確保所有變更「are recorded, tested, assessed, approved, implemented and verified in a controlled manner」 | [S20] |
| RTS 第 20(1) 條 | 身分管理要確保「the unique identification and authentication of natural persons and systems accessing the financial entities' information」 | [S21] |
| RTS 第 20(2) 條 | (a) 每位人員對應一個唯一身分與帳號；(b) 身分與帳號的生命週期管理；要保存所有身分指派的紀錄；可行時用自動化 | [S21] |
| RTS 第 21 條 (a) | 依「need-to-know, need-to-use and least privilege principles」指派存取權，含遠端與緊急存取 | [S21] |
| RTS 第 21 條 (b) | 職責分離要「prevent unjustified access to critical data or to prevent the allocation of combinations of access rights that may be used to circumvent controls」 | [S21] |
| RTS 第 21 條 (c) | 盡量限制通用與共用帳號，並確保「users are identifiable for the actions performed in the ICT systems at all times」 | [S21] |
| RTS 第 21 條 (e)(i)–(iii) | 指定授予、複查、撤銷存取權的角色與責任；特權、緊急、管理者存取採「need-to-use or an ad-hoc basis」；離職或不再需要時「without undue delay」收回 | [S21] |
| RTS 第 21 條 (e)(iv) | 「update of access rights where changes are necessary and at least once a year for all ICT systems, other than ICT systems supporting critical or important functions and at least every 6 months for ICT systems supporting critical or important functions」。注意：原文是「update」（更新），條文本身沒有出現「review」；把它當成複查頻率是一般解讀，屬【推論】。(e) 的對象是「user and generic accounts, including generic administrator accounts」 | [S21] |
| RTS 第 12(2) 條 | 紀錄要涵蓋「logical and physical access control… and identity management」與變更管理；(d)「measures to protect logging systems and log information against tampering, deletion, and unauthorised access at rest, in transit, and, where relevant, in use」；(e) 偵測紀錄系統失效；(f) 各系統時鐘對「a documented reliable reference time source」同步 | [S21] |

### 2.6 AI agent 與非人類身分的治理

| 來源 | 性質與狀態 | 與「負責人、核准、紀錄」有關的內容 |
|---|---|---|
| PCI DSS v4.0.1 的 7.2.5、7.2.5.1、8.6.1 | 產業標準，2025-03-31 起強制（持卡人資料環境內） | 系統與應用程式帳號要最小權限、定期複查並由管理階層確認；互動使用要管理階層明確核准並可歸責到個人 [S16] |
| DORA RTS 第 20(1) 條 | 歐盟法規，對金融業強制 | 「natural persons and systems」都要有唯一識別與驗證 [S21] |
| NIS2 執行規則 11.1.2(b) | 歐盟法規，對特定數位業者強制 | 存取控制政策要涵蓋系統對系統的存取 [S19] |
| NIST SP 800-53 的 AC-2、AC-6、IA-9 | 美國聯邦標準 | 帳號類型含 service；最小權限適用於代表使用者行動的程序；服務要唯一識別與驗證 [S10] |
| EU AI Act（Regulation (EU) 2024/1689）第 12、14、19、26 條 | 歐盟法規；只適用高風險 AI 系統。Regulation (EU) 2026/1744（Digital Omnibus on AI，2026-07-08 簽署、2026-07-24 刊登公報、刊登後第三日生效）把第三章第 1–3 節的適用日改為：Annex III 類 2027-12-02、Article 6(1)／Annex I 類 2028-08-02 [S40]。該修正案的修正點清單沒有第 12、14、19、26 條，下列引文仍是現行文字 [S40] | 第 12(1) 條：高風險系統要能自動記錄事件。第 14(4) 條：監督者要能 (d) 決定不使用或推翻輸出、(e) 中止系統。第 26(2) 條：「Deployers shall assign human oversight to natural persons who have the necessary competence, training and authority」。第 26(6) 條：部署者保存系統自動產生的紀錄「at least six months」 [S22] |
| NIST AI RMF 1.0（2023 年 1 月） | 自願性框架 | GOVERN 1.6：有機制盤點 AI 系統。GOVERN 2.1：角色、責任與溝通管道要有文件。GOVERN 3.2：要有政策界定「roles and responsibilities for human-AI configurations and oversight of AI systems」。MANAGE 2.4：要有機制並指派責任來「supersede, disengage, or deactivate AI systems」 [S26] |
| NIST NCCoE《Accelerating the Adoption of Software and AI Agent Identity and Authorization》 | 概念文件草案，2026 年 2 月；徵求意見至 2026-04-02；意見彙整頁寫「over 600 responses」（圖說 614 份）；下一步是發布專案說明草案，第一階段做企業情境，未給日期 [S27][S28] | 探討範圍包含：讓存取管理系統能「distinguish between agent and human identities」；「Link specific user identities to AI agents or software systems to support effective delegation controls and maintain accountability」；徵詢的問題包含「How do we bind agent identity with human identity to support "human-in-the-loop" authorizations?」與「How can we ensure that agents log their actions and intent in a tamper-proof and verifiable manner?」 [S27] |
| NIST SP 800-53 的 AI 控制覆蓋專案（COSAiS，專案頁顯示 2026-10-20 更名為 COSIS） | 規劃中；列有單一 agent 與多 agent 兩個使用情境。專案頁寫明 2026-10-20 依 2026-09-29 的行政命令更名，「Previously issued documents and publications have not been altered」。已發布的只有 2025-08-14 概念文件與 2026-01-08 預測式 AI 的註解大綱；agent 兩份未見草案 [S29] | 尚無可引用的控制條文 |
| OWASP Non-Human Identities Top 10（2025） | 社群指引 | NHI1 Improper Offboarding：服務帳號與金鑰不再需要時沒有停用或移除。NHI5 Overprivileged NHI。NHI7 Long-Lived Secrets。NHI10 Human Use of NHI：造成「lack of auditing and accountability due to indistinguishable activity between humans and automation」 [S30] |
| OWASP Top 10 for Agentic Applications 2026（2025-12-09 發布） | 社群指引 | ASI03 Identity & Privilege Abuse；ASI09 Human-Agent Trust Exploitation；ASI10 Rogue Agents [S31] |
| OWASP LLM06:2025 Excessive Agency | 社群指引 | 緩解措施：「Utilise human-in-the-loop control to require a human to approve high-impact actions before they are taken」；「Implement authorization in downstream systems rather than relying on an LLM to decide if an action is allowed or not」；記錄並監控延伸功能與下游系統的活動 [S32] |
| 新加坡 IMDA《Model AI Governance Framework for Agentic AI》v1.5（2026-05-20，2026-06-05 更新） | 政府發布的自願性框架 | Agent 的身分應該「tied to a supervising agent, a human user, or an organisational department for accountability and tracking」；以何種身分行動（自主或代表某人）要記錄以供稽核；「all agent identities (and their attendant permissions) should be issued from and tracked by a centralised system」；授權應「scoped, time- or session-bound, non-transferable, and follow the principle of least privilege by default」；「the human user should not be able to set permissions for the agent greater than what the human user is himself authorised to do」；「Such delegations of authority should be clearly recorded」；「As deployers, organisations and humans remain accountable for the decisions and actions of agents」 [S33] |

| 台灣金管會《金融業運用代理AI安全諮詢文件》 | 2026-10-13 發布，徵詢 30 天；諮詢文件，不是法規 [S42] | 依「資料敏感度、動作影響與能力邊界」對應用場景分級；要確認代理 AI 可取得的資料、可用的工具與可執行的行為範圍；失靈時要能停止或轉人工；保留軌跡供事後查證；金管會說法是把代理 AI「視為數位員工」來規範資料取得與系統權限 [S42]【新聞轉述，未取得文件原文】。台灣法規的條文另見 [01-regulation-taiwan.md](01-regulation-taiwan.md) |

結論：

- 事實：在本次查到的來源中，沒有任何強制法條直接寫「每個 AI agent 要有負責人、權限要經核准」。寫得最直接的是 IMDA 的框架，屬自願性質 [S33]。
- 事實：對「非人類帳號」已經有強制要求的是 PCI DSS 與 DORA [S16][S21]。
- 【推論】AI agent 在企業系統裡會以服務帳號、API 金鑰或 OAuth 用戶端的形式存在，因此已經落在 PCI DSS 7.2.5 與 DORA RTS 第 20 條這類「系統帳號」規定的範圍內。平台把 agent 當成一種主體、要求有在職的人類負責人，等於用現有的強制規定就能說明必要性，不需要等 AI 專法。
- 【推論】EU AI Act 管的是 AI 系統的提供者與部署者的義務，不是 agent 在公司內的存取權；它對本平台的直接影響有限，但第 26(2) 條「指派有權限的自然人」的寫法與本平台的負責人概念一致。

### 2.7 防竄改紀錄

| 來源 | 原文 | 適用對象 |
|---|---|---|
| SEC Rule 17a-4(f)(2)(i)(A) | 電子紀錄系統要保存紀錄並「maintains a complete time-stamped audit trail that includes: (1) All modifications to and deletions of the record or any part thereof; (2) The date and time of actions that create, modify, or delete the record; (3) If applicable, the identity of the individual creating, modifying, or deleting the record; and (4) Any other information needed to maintain an audit trail of the record in a way that maintains security, signatures, and data to ensure the authenticity and reliability of the record and will permit re-creation of the original record if it is modified or deleted」 | 美國證券經紀自營商 [S34] |
| SEC Rule 17a-4(f)(2)(i)(B) | 或者「Preserve the records exclusively in a non-rewriteable, non-erasable format」 | 同上；(A)、(B) 擇一 [S34] |
| SEC Rule 17a-4(f)(2)(ii) | 「Verify automatically the completeness and accuracy of the processes for storing and retaining records electronically」 | 同上 [S34] |
| SEC Rule 17a-4(f)(2)(iv) | 要能下載並傳送紀錄與其稽核軌跡，「in both a human readable format and in a reasonably usable electronic format」 | 同上 [S34] |
| SEC 修正案 | 稽核軌跡替代方案由 2022 年修正案加入；17a-4 修正的遵循日是 2023-05-03 | [S35] |
| 21 CFR 11.10(e) | 「Use of secure, computer-generated, time-stamped audit trails to independently record the date and time of operator entries and actions that create, modify, or delete electronic records. Record changes shall not obscure previously recorded information」；稽核軌跡的保存期間至少和電子紀錄一樣長 | 美國 FDA 管轄的電子紀錄 [S36] |
| 21 CFR 11.10(b)、(g) | 要能產生人可讀與電子兩種形式的正確完整副本；用權限檢查確保只有被授權的人能簽署或修改紀錄 | 同上 [S36] |
| NIST AU-9、AU-9(3) | 保護稽核資訊不被未授權存取、修改、刪除，偵測到時要告警；用密碼機制保護完整性 | 美國聯邦系統 [S10] |
| PCI DSS 10.3.2、10.3.4 | 防止個人修改稽核紀錄；既有紀錄被改動時要產生告警 | 持卡人資料環境 [S16] |
| DORA RTS 第 12(2)(d) 條 | 保護紀錄系統與紀錄「against tampering, deletion, and unauthorised access」 | 歐盟金融業 [S21] |
| NIS2 執行規則 3.2.5 | 保護紀錄不被未授權存取或變更 | 歐盟特定數位業者 [S19] |
| ISO/IEC 27002:2022 8.15 | 保護方法包含雜湊、只增、唯讀、公開透明檔 | 【未核對原文】[S9] |
| eIDAS 第 42(1) 條 | 合格電子時戳要「binds the date and time to data in such a manner as to reasonably preclude the possibility of the data being changed undetectably」、以連結 UTC 的準確時間來源為基礎、由合格信任服務提供者簽章或封緘 | 歐盟 [S37] |
| eIDAS 第 41(2) 條 | 合格電子時戳「shall enjoy the presumption of the accuracy of the date and the time it indicates and the integrity of the data to which the date and time are bound」 | 歐盟 [S37] |
| RFC 3161 | 定義時戳協定（Time-Stamp Protocol），IETF 標準軌，2001 年 8 月 | 技術標準 [S38] |

重點：

- 事實：SEC 現行規則接受「完整時間戳稽核軌跡」作為 WORM 的替代方案，兩者擇一 [S34][S35]。
- 事實：SEC 的稽核軌跡要求不只是「不能改」，還要「能重建被修改或刪除前的原始紀錄」，並且能以人可讀與機器可用兩種格式交付 [S34]。
- 事實：各框架都要求能偵測修改並告警（NIST AU-9(b)、PCI 10.3.4） [S10][S16]。
- 【推論】只增不改加雜湊鏈符合「防修改、可偵測」的方向。但如果資料庫管理員能同時重寫整條鏈，雜湊鏈就失去證明力；NIST AU-9(4) 的說明點出被稽核的特權使用者會影響稽核資訊的可靠性 [S10]。所以鏈頭需要定期放到平台管理員改不到的地方（獨立儲存或外部時戳）。
- 【推論】在歐盟，用合格電子時戳錨定鏈頭可以取得第 41(2) 條的法律推定；這是加分項，不是查到的強制要求。

### 2.8 存取權定期複查

#### 法規依據與頻率

| 框架 | 條文 | 頻率 | 條文要求留下的證據 |
|---|---|---|---|
| PCI DSS v4.0.1 | 7.2.4 | 至少每六個月 | 管理階層確認仍適當；不當存取已處理 [S16] |
| PCI DSS v4.0.1 | 7.2.5.1（系統與應用程式帳號） | 依目標式風險分析（12.3.1）決定 | 同上 [S16] |
| DORA RTS | 第 21 條 (e)(iv) | 存取權「update」至少每年；支援關鍵或重要功能的系統至少每 6 個月（原文用「更新」，當作複查頻率是【推論】） | 第 21 條 (e)(i) 要求指定「granting, reviewing, and revoking」的角色與責任 [S21] |
| NIS2 執行規則 | 11.2.3、11.3.3 | 「at planned intervals」，並隨組織變動調整 | 「document the results of the review including the necessary changes of access rights」 [S19] |
| NIST SP 800-53 | AC-2(j)、AC-6(7) | 組織定義 | AC-6(7)(b)：必要時重新指派或移除權限 [S10] |
| ISO/IEC 27002:2022 | 5.18、8.2 | 定期，無固定數字 | 【未核對原文】[S9] |
| SOC 2 | CC6.2、CC6.3 及其 points of focus | 定期，無固定數字 | 【未核對原文】[S14][S15] |
| SOX／PCAOB | 無條文直接規定複查 | 無 | 稽核人員依 AS 2201 測試公司自己設計的複查控制 [S2] |
| GDPR | 第 32(1)(d) 條 | 「regularly」評估措施有效性；未點名存取複查 | [S17] |

實務頻率：會計師事務所的實務文章寫「User access reviews usually range from quarterly, semiannual to annual」，並說多數稽核人員允許季後 15 天內完成 [S7]【從業者文章，非準則】。

#### 稽核人員對複查的期待與常見缺失

以下取自會計師事務所的實務文章 [S7]【從業者文章】，並與 [S4][S5] 的缺失描述對照：

| 稽核人員的期待 | 對應的常見缺失 |
|---|---|
| 保留原始的權限報表與產生報表的參數，讓稽核人員能評估報表的完整性與正確性（IPE） [S7] | 複查用的清單來源不明、無法證明沒有漏 [S3][S4] |
| 逐筆檢查到個別存取的層級，「The reviewer should not just sign off on a cover page template」 [S7] | 只簽封面、整批核准 |
| 「Users are not permitted to review their own access」；複查人自己也有權限時需要第二位複查人 [S7] | 自己複查自己 |
| 複查人要有適當的能力與權限，不能「rubber stamp」 [S7] | 橡皮圖章式核准 |
| 複查範圍要包含角色內的權限是否適當與職責分離的評估 [S7] | 只看人在不在，不看權限內容 |
| 每一筆要標示適當與否；不適當的要寫原因，並走公司的權限變更流程處理 [S7] | 找出問題但沒有後續移除的證據 |
| 複查在期間內完成 [S7] | 逾期完成 |
| 離職與調動人員的權限及時收回 | 「failure to timely manage terminated users」「untimely access removal」 [S4][S5] |

### 2.9 共同點：控制目標 → 需要的證據

「平台現況」欄對照的是 [contract/00-spine.md](../contract/00-spine.md) 第 5 節的規則代碼與第 11 節的介面；「缺口」是【推論】。

| # | 控制目標 | 各框架的依據 | 稽核需要的證據 | 平台現況與缺口 |
|---|---|---|---|---|
| 1 | 授予前經有權者核准，核准有文件 | PCI 7.2.3、8.2.4；NIST AC-2(e)(i)；CC6.2；NIS2 IR 11.2.2(c)；DORA 9(4)(c) [S16][S10][S14][S19][S20] | 每筆權限對應到一張核准紀錄；核准時間早於生效時間；核准人當時的身分與資格 | 已有 `K-FULFIL`、版本綁定。缺口：證據匯出要直接列出「核准時間、執行時間、核准人資格依據」 |
| 2 | 職責分離：申請、核准、執行不同人；不能自己核准自己 | AS 2110.B4；AC-5；ISO 5.3；CC6.3；DORA RTS 21(b)；NIS2 IR 11.2.2(a) [S2][S10][S9][S14][S21][S19] | 規則的設定與版本；規則擋下違反的紀錄；規則沒被繞過的證明（AS 2315.32：不靠抽樣） | 已有 `K-SOD-APPLICANT`、`K-SOD-DISTINCT`、`K-CLAIM`。缺口：複查時不得複查自己的授權（見 2.8） |
| 3 | 最小權限；實際設定不超出核准範圍 | PCI 7.2.1、8.2.4；AC-6；CC6.3；DORA RTS 21(a)；GDPR 25(2) [S16][S10][S14][S21][S17] | 核准的範圍與實際設定的比對結果；差異的處理紀錄 | 已有對帳（`reconciliation_run`）。缺口：對帳用的各系統回報清單要當 IPE 封存 |
| 4 | 異動、離職、不再需要時及時收回 | PCI 8.2.5、8.2.6；AC-2(h)、AC-2(3)；CC6.2；DORA RTS 21(e)(iii)；NIS2 IR 11.2.2(b) [S16][S10][S14][S21][S19] | 人事異動清單與撤銷紀錄的比對；從異動到撤銷的時間 | 已有 `K-OWNER-CONTINUITY`、`K-EXPIRE`、`K-REVOKE`。缺口：要能算出並匯出「異動到撤銷」的時效 |
| 5 | 定期複查，管理階層確認，不當的已處理 | PCI 7.2.4；DORA RTS 21(e)(iv)；NIS2 IR 11.2.3；AC-2(j)、AC-6(7) [S16][S21][S19][S10] | 複查當時的完整清單與產生條件；逐筆決定、決定人、時間；撤銷決定的執行結果；整體確認 | 已規劃 `access_review_campaign`。缺口：清單快照與產生條件、完成期限、未回應的處理都要成為證據的一部分 |
| 6 | 特權與緊急存取另行核准、限時、全程留紀錄 | ISO 8.2；PCI 8.2.2；AC-6(9)；DORA RTS 21(e)(ii)；NIS2 IR 11.3 [S9][S16][S10][S21][S19] | 特權清單；每次使用的核准、起訖時間、活動紀錄 | 已有 `K-VALIDITY-MAX`、`K-EXPIRE`。平台只管核准與有效期；使用過程的紀錄在各系統 |
| 7 | 非人類身分有負責人、經核准、定期複查 | PCI 7.2.5、7.2.5.1、8.6.1；DORA RTS 20(1)；NIS2 IR 11.1.2(b)；IMDA（自願） [S16][S21][S19][S33] | 非人類主體清單；每個主體的人類負責人；核准與複查紀錄 | 已有負責人概念。缺口：主體類型要明確支援服務帳號與 agent，並記錄代誰行動 |
| 8 | 可歸責：每個動作對應到唯一的個人 | PCI 8.2.1、8.2.2；DORA RTS 21(c)；AU-10；21 CFR 11.10(j) [S16][S21][S10][S36] | 唯一身分；代理、代簽關係的紀錄；高風險動作的再驗證 | 已有 `K-DELEGATE`、`K-MOBILE-MFA` |
| 9 | 紀錄內容完整 | AU-3；PCI 10.2.2；NIS2 IR 3.2.3 [S10][S16][S19] | 每筆含：誰、何時、事件類型、對象、結果、來源 | 已有：依據的規則、參數值、流程版本。需確認欄位涵蓋 AU-3 的六項 |
| 10 | 紀錄防竄改，修改可被偵測並告警；讀取紀錄也留紀錄 | AU-9、AU-9(3)(4)；PCI 10.2.1.3、10.3.1–10.3.4；DORA RTS 12(2)(d)；SEC 17a-4(f)(2)(i)(A)；21 CFR 11.10(e) [S10][S16][S21][S34][S36] | 完整性驗證的結果；管理員無法改刪的證明；偵測到異常時的告警紀錄 | 已有 `K-AUDIT-APPEND`、`K-AUDIT-CHAIN`。缺口：鏈頭的外部錨定；驗證失敗的告警；對稽核紀錄的讀取紀錄 |
| 11 | 時間可信 | PCI 10.6.1、10.6.3；DORA RTS 12(2)(f)；NIS2 IR 3.2.6；ISO 8.17 [S16][S21][S19][S9] | 時間來源的設定；時間設定變更的紀錄 | 缺口：未見於 spine；需要明確的時間來源與漂移偵測 |
| 12 | 保存期間足夠，且能以人可讀與機器可用的格式提出 | PCI 10.5.1（12 個月，近 3 個月立即可用）；AU-11；SEC 17a-4(f)(2)(iv)；21 CFR 11.10(b) [S16][S10][S34][S36] | 保存政策；匯出檔與其驗證方式 | 已規劃 `evidence`、`audit_feed`。缺口：保存期間要可設定並有下限 |
| 13 | 證據本身完整且正確（IPE） | AS 1105.08、.10 [S2][S3] | 報表的產生條件、來源、筆數；產生報表的程式受變更控制 | 缺口：每份匯出要附產生條件、筆數、雜湊與產生時的平台版本 |
| 14 | 控制規則本身的變更受控 | AS 2201.B29；DORA 9(4)(e)；CC8.1 [S2][S20][S14] | 流程定義、參數、規則的變更紀錄：誰、何時、為什麼、誰核准 | 已有 `K-SETTING-ADMIN`、流程只能由升版變更。缺口：參數變更目前只需一人，見第 3 節 |
| 15 | 授權不是一次性的：每次存取前判定，撤銷立即生效 | SP 800-207 原則 3、4、6；AC-24；CA-7 [S12][S10] | 每次判定的紀錄與依據；撤銷到各系統停止存取的時間 | 已規劃 `check`、`events`。缺口：判定紀錄的保存量與保存期間 |

## 3. 對產品的含意

產品的終極目標可以用一句話表述：**讓公司隨時能向稽核人員證明「現在每一個權限都有人核准過、有人負責、仍然需要，而且這份證明本身是可信的」**。依據是結論 1、2、5、10。

### 必須有

| # | 需求 | 依據 |
|---|---|---|
| M1 | 每筆權限都能追到一張核准紀錄，且證據能顯示核准早於生效、核准人當時的資格 | 結論 1；PCI 7.2.3、8.2.4；AC-2(e)(i)；AS 2201.44 [S16][S10][S2] |
| M2 | 職責分離由引擎強制、設定無法關閉；能匯出規則版本與「違反被擋下」的紀錄 | 結論 1；AS 2315.32；AC-5；DORA RTS 21(b) [S2][S10][S21] |
| M3 | 定期複查：頻率可依資源等級設定，設定值要能做到至少每 6 個月；產出逐筆決定、整體確認、撤銷決定的執行結果 | 結論 4、5；PCI 7.2.4；DORA RTS 21(e)(iv)；NIS2 IR 11.2.3 [S16][S21][S19] |
| M4 | 複查人不能複查自己的授權；複查逾期要升級或撤銷，不能默認通過 | 結論 3、5；[S7]；PCI 7.2.4「Any inappropriate access is addressed」 [S16] |
| M5 | 所有匯出的清單都附產生條件、產生時間、筆數與雜湊；複查開始時封存當時的完整清單 | 結論 2；AS 1105.10；[S3][S2] |
| M6 | 對帳：各系統回報實際設定，平台找出「沒核准卻存在」與「超出核准範圍」；回報的原始清單要封存 | 結論 1、2；PCI 8.2.4；NIS2 IR 11.2.2(e)；AS 1105.10 [S16][S19][S2] |
| M7 | 人事異動與離職觸發收回，並能量測從異動到撤銷的時間 | 結論 3；PCI 8.2.5；DORA RTS 21(e)(iii)；[S4][S5] |
| M8 | 非人類主體（服務帳號、AI agent）與人員走同一套核准、有效期、複查；每個非人類主體必須有在職的人類負責人 | 結論 6、7；PCI 7.2.5、7.2.5.1、8.6.1；DORA RTS 20(1) [S16][S21] |
| M9 | 稽核紀錄欄位涵蓋：誰（含代理關係）、何時、事件類型、對象、結果、來源、依據的規則與版本 | AU-3；PCI 10.2.2 [S10][S16] |
| M10 | 稽核紀錄只增不改、可驗證；平台管理員不能改刪；驗證失敗要告警；讀取稽核紀錄也要留紀錄 | 結論 8；AU-9；PCI 10.2.1.3、10.3.2、10.3.4；DORA RTS 12(2)(d) [S10][S16][S21] |
| M11 | 鏈頭定期存到平台管理員改不到的位置（最低限度：獨立的儲存與獨立的權限） | 結論 8；AU-9(2)、AU-9(4)；PCI 10.3.3 [S10][S16] |
| M12 | 證據匯出同時提供人可讀與機器可讀格式，並附獨立的驗證方法；保存期間可設定，下限不低於 12 個月 | 結論 8、10；SEC 17a-4(f)(2)(iv)；21 CFR 11.10(b)；PCI 10.5.1 [S34][S36][S16] |
| M13 | 判定介面在每次被呼叫時依當下有效的授權回答，並記錄每次判定與依據；撤銷後的判定立即改變，並發出事件通知 | 結論 9；SP 800-207 原則 6 與 policy engine 的定義；AC-24 [S12][S10] |
| M14 | 授權登記冊：隨時可列出某主體或某資源目前所有有效授權 | NIS2 IR 11.2.2(e)；AC-2(d) [S19][S10] |
| M15 | 流程定義、參數、規則的每次變更都留下誰、何時、原因；變更前後的版本都保留，讓稽核能重新執行當時的判定 | 結論 1；AS 2201.50、.B29；DORA 9(4)(e) [S2][S20] |
| M16 | 時間來源明確並同步；時間設定的變更留紀錄 | PCI 10.6.1、10.6.3；DORA RTS 12(2)(f) [S16][S21] |

### 應該有

| # | 需求 | 依據 |
|---|---|---|
| S1 | 內建控制對照表：每條核心規則對應到各框架的條文，證據包可依框架輸出 | 【推論】來自 2.9 的對照表；沒有法規強制，但可直接減少稽核溝通成本 |
| S2 | 用外部時戳（RFC 3161；歐盟客戶用合格電子時戳）錨定雜湊鏈 | 結論 8；eIDAS 第 41(2)、42(1) 條 [S37][S38] |
| S3 | Agent 專用的紀錄：以何種身分行動（自主或代表某人）、委派鏈；agent 的權限不得超過授權它的人 | 結論 7；[S33][S27] |
| S4 | 複查品質的防呆：偵測整批核准與過短的審閱時間、依風險排序、顯示上次使用時間 | 結論 3；[S7]；IMDA「auditing the effectiveness of human approvals」 [S33] |
| S5 | 關鍵參數與稽核設定的變更需要第二人核准 | AC-3(2)、AU-9(5)（選用的增強項） [S10] |
| S6 | 複查頻率採風險式設定，並保留訂定頻率的理由 | PCI 7.2.5.1 與 12.3.1 [S16] |
| S7 | 持續監控指標：異動到撤銷的時效、複查完成率、逾期數、對帳差異數與處理時間 | CA-7(a)；NIS2 第 20(1) 條的管理階層監督 [S10][S18] |
| S8 | 特權與緊急授權的專用路徑：更短的有效期上限、事後強制複核 | ISO 8.2；DORA RTS 21(e)(ii)；PCI 8.2.2 [S9][S21][S16] |
| S9 | 模擬環境能重現稽核會測的情境：離職未收回、沒核准卻存在的權限、複查人複查自己、稽核紀錄被直接改動、時鐘漂移 | 【推論】AS 2201.50 的 re-performance；這些正是 [S4][S7] 列出的缺失 |

### 可以不做

| # | 不做的項目 | 理由 |
|---|---|---|
| N1 | 硬體 WORM 或專用的不可覆寫儲存 | SEC 自 2023-05-03 起接受稽核軌跡替代方案；NIST AU-9(1) 是選用的增強項 [S34][S35][S10]。需要時由部署環境的儲存層提供 |
| N2 | 平台自己攔截流量、擔任執行點 | SP 800-207 的執行點在資源一側；AC-24 允許決策與執行分離 [S12][S10]。spine 第 11 節已定「實際擋下存取的仍是各系統自己」 |
| N3 | EU AI Act 高風險系統的合規功能（技術文件、符合性評鑑、系統運作紀錄） | 平台不是 AI 系統的提供者；高風險義務已依 Regulation (EU) 2026/1744 延到 2027-12-02（Annex III 類）與 2028-08-02（Annex I 類） [S22][S40]。平台只需記錄 agent 的負責人與核准 |
| N4 | 紀錄的即時異常偵測與關聯分析 | PCI 10.4、NIS2 IR 3.2.4 要求檢視紀錄，但這是 SIEM 的職責 [S16][S19]。平台把事件送出即可 |
| N5 | 公開區塊鏈或分散式帳本 | 本次查到的所有條文都只要求「防修改、可偵測、可驗證」，沒有任何一條要求分散式帳本 [S10][S16][S21][S34] |
| N6 | 內建抽樣工具與固定樣本數 | 查不到準則規定固定樣本數（見第 4 節）；AS 2315.32 指出職責分離類控制不適用抽樣 [S2]。提供完整母體的匯出即可 |
| N7 | 為每個框架各做一套複查流程 | 2.8 顯示各框架對複查的要求可用同一流程加上不同頻率參數滿足 [S16][S21][S19][S10] |

## 4. 不確定或查不到的事項

| 項目 | 狀況 |
|---|---|
| ISO/IEC 27001:2022、27002:2022 原文 | 需付費，未取得。2.2 的編號與主題來自 [S8]，要點來自 [S9]，未逐字核對。5.15、5.16、8.3、8.16、5.28、5.33、8.32 只有主題，沒有取得要點 |
| ISO/IEC 27001:2022 的轉版期限與 2024 年修正 | 未查 |
| AICPA Trust Services Criteria 原文與 2022 年 points of focus 原文 | 需登入，未取得。CC6.1–6.3、CC8.1 的文字來自第三方轉錄 [S14]；points of focus 只有二手摘要 [S15] |
| PCAOB 網站的準則頁面 | 回應 403。改用 PCAOB 官方彙編 PDF（適用於 2024-12-15 以後開始的會計年度）[S2]。AS 2201 另有標示 2025-12-15 生效的版本，未比對差異；AS 1105.10A（外部電子資訊，2025-12-15 起）未取得原文 |
| PCI DSS v4.0.1 | PCI SSC 官方下載需同意授權條款；本文使用大學網站上的副本，文件內標示為 PCI SSC 2024 年 6 月版 [S16] |
| EU AI Act 數位綜合修正案 | 已解決（2026-11-19 查證）：正式編號 Regulation (EU) 2026/1744，2026-07-24 刊登公報，刊登後第三日生效；修正點清單不含第 12、14、19、26 條 [S40] |
| NIS2 的修正提案 | 搜尋結果顯示執委會 2026-01-20 提出 NIS2 簡化與對齊 Cybersecurity Act 的指令提案 COM(2026) 13，律師事務所評論認為主要改監理架構、不改實質資安義務；是否改動執行規則 2024/2690 未找到說明。只看過搜尋摘要，未開原文，正文未採用 |
| PCAOB 2025 年檢查結果（2026-10-22 Spotlight） | 搜尋摘要顯示整體缺失率下降，但未看到 ITGC 或使用者存取的分項，未開原文 |
| 台灣金管會代理 AI 諮詢文件原文 | 只取得新聞轉述 [S42]；L1–L4 等級定義與覆核門檻未核對 |
| eIDAS 第 41、42 條 | 引文為 2014 年原始版本；2024 年修正（Regulation (EU) 2024/1183）是否改動這兩條未核對 |
| GDPR、NIS2、DORA 及其下位規則 | 引文為公報原始版本，未比對合併版。NIS2 各會員國的轉置狀態未查 |
| NIST SP 800-53 的版本差異 | 引文來自 2020-12-10 更新版 PDF；Release 5.1.1 與 5.2.0 的完整變更清單未逐條比對，只看了 5.2.0 的公告摘要 [S11] |
| FedRAMP 對 AC-2(j) 的參數值 | 搜尋摘要顯示有二手來源寫「特權每月、非特權每六個月」[S39]，但同一批搜尋結果也顯示 fedramp.gov 2026 年參考頁寫的是組織定義。未開啟原文，未確認，本文正文不採用 |
| 稽核抽樣的固定樣本數（實務上常聽到的 25、40、60） | 查不到公開準則依據。AS 2201.46–.47 只說證據量依風險而定 [S2] |
| SOX 存取複查「每季」 | 只有從業者文章支持 [S7]，無條文依據 |
| NIST 的 AI agent 控制覆蓋文件 | 專案頁列有單一 agent 與多 agent 兩個使用情境，本次查閱未見發布。專案頁顯示 2026-10-20 因行政命令更名為 COSIS，只有該頁一處來源 [S29] |
| OWASP Top 10 for Agentic Applications 2026 的完整文件 | 未開啟 PDF；十項風險的名稱取自 OWASP 官方部落格文 [S31]，各項的說明與緩解措施未取得 |
| ISO/IEC 42001、Cloud Security Alliance 的 agent 身分框架、NIST SP 800-63-4 | 未查 |
| HIPAA、FINRA Rule 4511、CFTC Rule 1.31、新加坡 MAS、香港 HKMA 等其他監理要求 | 未查。SEC 17a-4 只適用證券經紀自營商，其他行業是否有等同的不可竄改要求未確認 |
| 各框架的官方對照表（例如 NIST 發布的 800-53 與 ISO 27001 對照） | 未取得官方版本；2.2 的對照來自第三方 [S8] |
| 網頁搜尋 | 初稿後段搜尋額度用完。獨立查證時（2026-11-19）已重新搜尋 12 次，結果見第 6 節 |

## 5. 來源

查閱日期一律為 2026-11-19。

| 編號 | 標題 | 網址 | 性質 |
|---|---|---|---|
| S1 | 15 U.S.C. §7262, Management assessment of internal controls（SOX §404），U.S. Code 2023 Edition | https://www.govinfo.gov/content/pkg/USCODE-2023-title15/html/USCODE-2023-title15-chap98-subchapIV-sec7262.htm | 一手 |
| S2 | PCAOB, Auditing Standards of the PCAOB（適用於 2024-12-15 以後開始的會計年度的彙編；含 AS 1105、AS 2110、AS 2201、AS 2315） | https://pcaobus.org/standards/auditing/documents/auditing_standards_audits_fybeginning_on_or_after_december_15_2024.pdf | 一手 |
| S3 | PCAOB, Spotlight: Inspection Observations Related to Auditor Use of Data and Reports（2024 年 4 月） | https://assets.pcaobus.org/pcaob-dev/docs/default-source/documents/data-and-reports-spotlight.pdf | 一手（幕僚觀點） |
| S4 | KPMG, Trends in material weaknesses — KPMG LLP 2025 study（© 2026；資料來源 Audit Analytics） | https://kpmg.com/kpmg-us/content/dam/kpmg/pdf/2026/trends-material-weaknesses.pdf | 有方法說明的研究 |
| S5 | KPMG, IT controls and ICFR — Audit Insights（2024 年 4 月） | https://advisory.kpmg.us/kpmg-us/content/dam/kpmg/pdf/2024/kpmg-importance-of-it-controls-in-icfr-final.pdf | 二手（轉述 Ideagen 研究） |
| S6 | KPMG, Mastering IT Scoping for SOX Compliance（© 2026；2026 年 2 月網路研討會調查，2,900 多位受訪者） | https://kpmg.com/kpmg-us/content/dam/kpmg/pdf/2026/mastering-it-scoping-for-sox-compliance.pdf | 調查（即時投票） |
| S7 | Schneider Downs, How can you understand and meet auditor expectations on complete user access reviews? | https://schneiderdowns.com/our-thoughts-on/user-access-reviews-tips-to-meet-auditor-expectations/ | 從業者文章 |
| S8 | Open Security Architecture, ISO/IEC 27002:2022（控制清單與 NIST SP 800-53 對照） | https://www.opensecurityarchitecture.org/frameworks/iso-27002-2022 | 二手 |
| S9 | ISMS.online, ISO 27002:2022 控制說明：5.3、5.18、8.2、8.15 | https://www.isms.online/iso-27002/control-5-3-segregation-of-duties/ ； https://www.isms.online/iso-27002/control-5-18-access-rights ； https://www.isms.online/iso-27002/control-8-2-privileged-access-rights ； https://www.isms.online/iso-27002/control-8-15-logging | 二手（廠商摘要） |
| S10 | NIST SP 800-53 Rev.5, Security and Privacy Controls for Information Systems and Organizations（2020 年 9 月，含 2020-12-10 更新） | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf | 一手 |
| S11 | NIST CSRC, SP 800-53 Rev.5 出版頁（含 2025-08-27 Release 5.2.0 的公告） | https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final | 一手 |
| S12 | NIST SP 800-207, Zero Trust Architecture（2020 年 8 月） | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf | 一手 |
| S13 | NIST SP 800-37 Rev.2, Risk Management Framework for Information Systems and Organizations（2018 年 12 月） | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-37r2.pdf | 一手 |
| S14 | strongDM comply 專案，TSC-2017.yml（AICPA 2017 Trust Services Criteria 的轉錄） | https://raw.githubusercontent.com/strongdm/comply/master/example/standards/TSC-2017.yml | 第三方轉錄 |
| S15 | Drata, Trust Services Criteria revised points of focus | https://drata.com/learn/soc-2/trust-services-criteria-revised-points | 二手（廠商摘要） |
| S16 | PCI Security Standards Council, PCI DSS: Requirements and Testing Procedures, Version 4.0.1（2024 年 6 月） | https://www.middlebury.edu/sites/default/files/2025-01/PCI-DSS-v4_0_1.pdf | 一手文件的副本 |
| S17 | Regulation (EU) 2016/679（GDPR） | https://publications.europa.eu/resource/celex/32016R0679 | 一手 |
| S18 | Directive (EU) 2022/2555（NIS2） | https://publications.europa.eu/resource/celex/32022L2555 | 一手 |
| S19 | Commission Implementing Regulation (EU) 2024/2690（NIS2 的技術與方法要求） | https://publications.europa.eu/resource/celex/32024R2690 | 一手 |
| S20 | Regulation (EU) 2022/2554（DORA） | https://publications.europa.eu/resource/celex/32022R2554 | 一手 |
| S21 | Commission Delegated Regulation (EU) 2024/1774（DORA 的 ICT 風險管理 RTS） | https://publications.europa.eu/resource/celex/32024R1774 | 一手 |
| S22 | Regulation (EU) 2024/1689（EU AI Act，2024 年公報原始版本） | https://publications.europa.eu/resource/celex/32024R1689 | 一手 |
| S23 | Council of the EU 新聞稿（EEAS 轉載）：Artificial Intelligence: Council gives final green light to simplify and streamline rules（2026-06-29） | https://eeas.europa.eu/delegations/chile/artificial-intelligence-council-gives-final-green-light-simplify-and-streamline-rules_en | 一手（新聞稿） |
| S24 | Orrick, EU AI Act Update: Digital Omnibus Finalizes 8 Compliance Changes（2026 年 7 月） | https://www.orrick.com/zh-CN/Insights/2026/07/EU-AI-Act-Update-Digital-Omnibus-Finalizes-8-Compliance-Changes | 二手（律師事務所） |
| S25 | Addleshaw Goddard, EU AI Act: AI Omnibus formally adopted（2026-07-01） | https://www.addleshawgoddard.com/en/insights/insights-briefings/2026/technology/eu-ai-act-ai-omnibus-formally-adopted/ | 二手（律師事務所；與 S23 的日期一致） |
| S26 | NIST AI 100-1, Artificial Intelligence Risk Management Framework (AI RMF 1.0)（2023 年 1 月） | https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf | 一手 |
| S27 | NIST NCCoE, Accelerating the Adoption of Software and AI Agent Identity and Authorization — Concept Paper（草案，2026 年 2 月） | https://www.nccoe.nist.gov/sites/default/files/2026-02/accelerating-the-adoption-of-software-and-ai-agent-identity-and-authorization-concept-paper.pdf | 一手（草案） |
| S28 | NIST NCCoE, 概念文件意見彙整 | https://pages.nist.gov/nccoe-ai-identity/summary-of-comments.html | 一手 |
| S29 | NIST CSRC, SP 800-53 Control Overlays 專案頁（COSAiS，頁面顯示已更名 COSIS） | https://csrc.nist.gov/projects/cosais | 一手 |
| S30 | OWASP Non-Human Identities Top 10 — 2025 | https://owasp.org/www-project-non-human-identities-top-10/2025/top-10-2025/ | 社群標準 |
| S31 | OWASP GenAI Security Project, OWASP Top 10 for Agentic Applications（2025-12-09） | https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/ ； https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ | 社群標準 |
| S32 | OWASP, LLM06:2025 Excessive Agency | https://genai.owasp.org/llmrisk/llm062025-excessive-agency/ | 社群標準 |
| S33 | IMDA（新加坡）, Model AI Governance Framework for Agentic AI, Version 1.5（2026-05-20 發布，2026-06-05 更新） | https://www.imda.gov.sg/-/media/imda/files/about/emerging-tech-and-research/artificial-intelligence/mgf-for-agentic-ai.pdf | 一手（自願性框架） |
| S34 | 17 CFR §240.17a-4(f)（eCFR 現行版本；條文內容由 eCFR 的 API 取得） | https://www.ecfr.gov/current/title-17/chapter-II/part-240/subpart-A/subject-group-ECFR9a2ae1d0cf1e5bb/section-240.17a-4 ； https://www.ecfr.gov/api/renderer/v1/content/enhanced/current/title-17?part=240&section=240.17a-4 | 一手 |
| S35 | SEC, Electronic Recordkeeping Requirements for Broker-Dealers…（Final rule，87 FR 66412，2022-11-03） | https://www.govinfo.gov/content/pkg/FR-2022-11-03/html/2022-22670.htm | 一手 |
| S36 | 21 CFR §11.10, Controls for closed systems（eCFR 現行版本；由 eCFR 的 API 取得） | https://www.ecfr.gov/api/renderer/v1/content/enhanced/current/title-21?part=11&section=11.10 | 一手 |
| S37 | Regulation (EU) No 910/2014（eIDAS，2014 年原始版本），第 3、41、42 條 | https://publications.europa.eu/resource/celex/32014R0910 | 一手 |
| S38 | RFC 3161, Internet X.509 Public Key Infrastructure Time-Stamp Protocol (TSP)（2001 年 8 月） | https://www.rfc-editor.org/rfc/rfc3161.txt | 一手 |
| S39 | Microsoft Learn, Configure identity access controls to meet FedRAMP High Impact level | https://learn.microsoft.com/en-us/entra/standards/fedramp-access-controls | 二手；只見於搜尋摘要，未開啟原文，正文未採用 |
| S40 | Regulation (EU) 2026/1744（Digital Omnibus on AI），OJ L 2026/1744，2026-07-24 | https://publications.europa.eu/resource/celex/32026R1744 | 一手 |
| S41 | PCI SSC, RFC Instructions: RFC for Currently Published PCI DSS v4.0.1（2026-06-03 至 07-20） | https://www.pcisecuritystandards.org/rfc_instructions_pci-dss-v4-0-1-june2026/ | 一手 |
| S42 | 中央社，盯新興風險 金管會發布金融業運用代理AI諮詢文件（2026-10-13） | https://cna.com.tw/news/afe/202610130306.aspx | 二手（新聞） |

## 6. 查證紀錄

- 查證日期：2026-11-19；查證者未參與初稿撰寫。
- 方法：直接開原文。PCI DSS、KPMG 兩份、PCAOB 準則彙編與 Spotlight、IMDA、NIST SP 800-53 是下載 PDF 後轉文字逐字比對；DORA RTS、NIS2 執行規則、AI Act 與 2026/1744 是由歐盟出版局取得 XHTML 全文比對；SEC 17a-4 由 eCFR API 取得。

### 逐項結果

| # | 論點 | 結果 |
|---|---|---|
| 1 | PCI DSS 7.2.4 至少每六個月、四項要素（含管理階層確認） | 已確認；文件封面為 v4.0.1、2024 年 6 月 [S16] |
| 2 | PCI 7.2.4、7.2.5、7.2.5.1、8.6.1 於 2025-03-31 前為 best practice | 已確認，四條的 Applicability Notes 都有此註記 [S16] |
| 3 | PCI 8.2.6 90 天、10.5.1 保存 12 個月（近 3 個月立即可用） | 已確認 [S16] |
| 4 | PCI DSS v4.0.1 仍是現行版本 | 已確認，另補 2026 年 RFC [S41] |
| 5 | DORA RTS 第 20(1) 條「natural persons and systems」 | 已確認 [S21] |
| 6 | DORA RTS 第 21 條 (e)(iv) 是「複查」頻率 | 已更正：原文是「update of access rights where changes are necessary and at least once a year…」，沒有「review」字樣；改寫為「更新」並把「當作複查頻率」標為【推論】（結論 4、2.5、2.8 三處） |
| 7 | DORA RTS 第 21 條 (b)、(c) 與第 12(2)(d) 條引文 | 已確認 [S21] |
| 8 | NIS2 執行規則 11.1.2(b)、11.2.2(a)–(f)、11.2.3 | 已確認 [S19] |
| 9 | KPMG：238／3,307（7%）、31%→58%、Systems 37%（前一年 30%） | 已確認數字；補上原圖附註的分母說明（1,176 份合計報告），結論 3 的「揭露重大缺失的公司中」改為較中性的寫法 [S4] |
| 10 | KPMG 2026 年 2 月調查：2,900 多位、使用者存取複查 36% 第一、IPE 28% 第二 | 已確認；原文稱 webcast [S6] |
| 11 | PCAOB：2021、2022 檢查年度各約 17% comment form 有 IPE 缺失 | 已確認 [S3] |
| 12 | AS 2315.32 職責分離不適用抽樣 | 已確認，補上完整句子；原表「看系統設定與規則」改標【推論】 [S2] |
| 13 | AS 2201.B28 自動化控制、AS 2201.50「Inquiry alone…」、AS 2110.B4 引文 | 已確認 [S2] |
| 14 | EU AI Act 第 26(2)、26(6) 條；高風險適用日延到 2027-12-02／2028-08-02 | 已確認，並由律師事務所二手來源升級為公報一手來源；確認第 12、14、19、26 條未被修正 [S22][S40] |
| 15 | SEC 17a-4(f)(2)(i)(A)/(B) 擇一、(iv) 兩種格式、遵循日 2023-05-03 | 已確認 [S34]；遵循日另與搜尋到的 SEC FAQ 一致 |
| 16 | NIST AC-24「it is not required」、AU-9(1)、AC-2 帳號類型；Release 5.2.0 為 2025-08-27 | 已確認 [S10][S11]；出版頁未提到更新的版本 |
| 17 | IMDA Agentic AI 框架 v1.5（2026-05-20，06-05 更新）與各引文 | 已確認，引文逐句在 PDF 中找到 [S33] |
| 18 | OWASP Agentic Top 10 發布日 2025-12-09、ASI03/09/10 名稱 | 已確認 [S31] |
| 19 | NIST COSAiS 更名 COSIS（2026-10-20）、agent 覆蓋文件未發布 | 已確認，補上更名依據與已發布文件清單 [S29] |
| 20 | NCCoE 概念文件收到 600 多份回應 | 已確認（614 份），補上下一步 [S28] |

統計：確認 19 項、更正 1 項（DORA RTS 21(e)(iv) 的用語），降級為【推論】1 處（AS 2315.32 的解讀），刪除 0 項。

### 補充搜尋（12 次）

| 角度 | 結果 | 處理 |
|---|---|---|
| 最新消息：AI Act 修正案正式刊登 | 找到並核對公報全文 | 補 [S40]，更新結論 7、2.6、N3、第 4 節 |
| 最新消息：PCI DSS 下一版 | 2026 年 RFC，無下一版日期 | 補 [S41] 於 2.4 |
| 最新消息：NIST agent 相關專案 | COSIS、NCCoE 進度 | 更新 2.6 |
| 台灣在地：金管會代理 AI 諮詢文件 | 2026-10-13 發布，僅取得新聞 | 補 2.6 一列，標二手 |
| 台灣在地：上市櫃公司資通安全管控指引 | 只確認 2024 年 9 月修訂、未取得存取覆核條文 | 不補；台灣條文由 01 號文件處理 |
| 反面證據：SOC 2 是否規定複查頻率 | 搜尋結果一致表示 AICPA 沒有固定頻率，「每季」來自廠商與實務 | 與 2.4、2.8 的寫法一致，不改 |
| 反面證據：NIS2 是否將被修改 | 有 2026 年修正提案，主要改監理架構 | 記入第 4 節，正文未採用 |
| 反面證據：PCAOB 2025 檢查結果是否改善 | 整體缺失率下降，未見 ITGC 分項 | 記入第 4 節 |

### 對產品最重要的結論

1. 「至少每 6 個月」是可直接寫進產品下限的強制數字（PCI 7.2.4 已強制；DORA 關鍵系統每 6 個月，但原文是「更新」）。
2. 複查證據要有「管理階層確認仍適當」與「不當存取已處理」兩項，PCI 原文逐字確認。
3. 稽核最大痛點仍是使用者存取複查與 IPE（KPMG 36%、28%；PCAOB 約 17%），匯出清單必須附產生條件與完整性證明。
4. AI agent 至今沒有強制法條要求負責人與核准；EU AI Act 高風險義務正式延到 2027-12-02，台灣金管會文件仍在徵詢。產品以「非人類帳號」的既有強制要求（PCI 7.2.5、DORA RTS 20）說明必要性即可。
5. SEC 17a-4 正式接受「完整時間戳稽核軌跡」替代 WORM，且要能重建原始紀錄並以人可讀與機器可用格式交付；不需要硬體 WORM 或區塊鏈。
