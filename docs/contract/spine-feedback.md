# 流程包作者對骨幹的回饋

兩位流程包契約作者依舊骨幹撰寫時回報的骨幹修改建議、對核心的需求與規則缺漏。改寫骨幹時逐項處理。


---

# 合約用印流程包契約：回報

## 1. 檔案
- `/home/user/req/docs/contract/03-pack-seal.md`（新增，約 1,110 行）
- `/home/user/req/docs/packs/seal/acceptance-cases.md`（新增，約 205 行）
- 沒有改其他檔案，沒有 commit / push。（兩個檔案目前在 git 顯示為已追蹤，是別人的 wip commit 帶進去的。）
- 驗證：只做了文件內部的一致性檢查（腳本比對規則代碼、測試名稱與數量、JSON 區塊可解析）；repo 還沒有資料庫，演算法沒有實際執行過。
- 撰寫期間骨幹新增了第 11、12 節，已納入：`describe_entitlements`、`evaluate_constraints` 不登記；驗收使用 `sim/`。

## 2. 數量統計
- 表單欄位 8；級別 2；關卡 4（簽核 3＋執行 1）；人工檢查項目 6；登記角色 3
- 流程包物件：代碼表 2（共 7 列）、讀取用 view 1、工具 function 7
- hook：實作 8（`normalize_content`、`validate_content`、`classify_tier`、`compare_content`、`diff_content`、`summarize_content`、`find_overlaps`、`build_fulfilment`）；用核心預設 6
- hook 範例 56 組（normalize 5、validate 5、classify 8、compare 18、diff 6、summarize 4、overlaps 6、fulfilment 4）
- 專屬對外 function 0；前端專屬元件 0；後端 adapter 0
- 專屬參數 1（`seal.major_amount_threshold`）＋釘住 1 個核心參數的流程類型值（`confirmation.due_workdays` = 5）
- 規則代碼 10；錯誤代碼 2；通知範本 3
- 規則對照表 54 列（rules.md 每段、每列、每個預設值各一列）
- migration 6 檔；測試 8 檔、79 個（每個規則代碼都有測試）
- 依賴核心但骨幹未定名的項目 16（契約第 0.2 節 D-1～D-16，各自集中在一個位置）
- 驗收案例 3 個、41 步（9＋14＋18），另有 6 項總檢查；種子：歷史申請單 2 張、測試檔案 4 個

## 3. 骨幹修改建議
| # | 位置 | 原因 | 建議寫法 |
|---|---|---|---|
| S-1 | 第 2 節 `policy_stage`、第 7 節 | 骨幹沒有地方宣告「誰執行」。合約用印的執行人（印鑑管理人）不是任何簽核關的角色 | `policy_stage` 加「階段」欄位 `phase`：`approval` 或 `fulfilment`。執行關沿用 resolver、認領、職責分離、代理、催辦、升級、檢查清單 |
| S-2 | 第 2 節 `fulfilment`、第 6 節 `build_fulfilment` | 「填實際份數」需要結構化的完成回報；沒有前端專屬元件時，通用畫面需要知道怎麼顯示執行內容 | 定義通用格式 `format = "manual_task"`：`title`、`facts`、`attachments`、`result_schema`（屬性同表單定義）。核心依 `result_schema` 收集、檢查、保存完成回報，並寫進稽核事件 |
| S-3 | 第 4 節轉移、第 3 節選項 | 「任何未生效的狀態 → cancelled」和 `revocable_after_fulfilment = false` 在 `verifying` 衝突；誰能取消也沒寫 | 明寫：此選項為 false 時，執行完成後取消與撤銷都拒絕。補上取消的名單（是否和 `K-REVOKE` 相同） |
| S-4 | 第 6 節 `find_overlaps` | 簽章沒有申請人；`p_case_id` 是 null 就無法判斷「同一申請人」 | 明寫 `p_case_id` 一定是已存檔的申請單（草稿先存檔再檢查），或加 `p_actor`。同時寫明 hook 的呼叫順序 |
| S-5 | 第 10 節欄位型別 | `money`、`attachment` 在內容 JSON 的形狀沒定義；`compare_content` 要靠 `sha256` 判斷換檔案 | `money`＝整數（最小幣別單位）；`attachment`＝陣列，元素含 `attachment_id`、`file_name`、`sha256`。並列出表單定義的屬性（`required`、`summary`、`reducible`、`options`、`min`、`max`、`max_length`、`min_items`） |
| S-6 | 第 2 節 `policy_stage` 適用條件 | 格式未定義 | `null`＝全部級別；`{"tier_in": [...]}` |
| S-7 | 第 6 節、`audit_event` | hook 只回傳結果，稽核事件無法引用流程包的規則代碼（例如 `SEAL-TIER`） | 登記流程類型時帶 `hook_rules`（hook → 規則代碼）；稽核事件可同時記核心與流程包的代碼 |
| S-8 | 第 8 節參數、第 3 節選項 | 確認逾期「只催辦」之後多久再催沒有參數；確認畫面的文字沒有地方指定 | 加 `confirmation.remind_every_workdays`；流程類型加 `confirmation_prompt` |
| S-9 | 第 5 節 `K-CHANGE-*` | 新版本的級別改變時怎麼處理沒寫 | 每個新版本重新分級；級別升高一律視為擴大；級別降低時未開始的關卡重新套用適用條件 |

## 4. 對核心的需求（骨幹沒寫到）
- N-1 登記入口的名稱與參數：流程類型、級別、路徑、角色（可重複登記）、參數定義與流程類型範圍的初始值、規則、錯誤、通知範本。
- N-2 給流程包的穩定讀取介面：申請人、狀態、目前版本內容、執行結果。契約暫用 view `pack_seal.seal_case` 直接讀 `sgn.case`、`sgn.case_version`、`sgn.fulfilment`，欄位名稱是假定的。
- N-3 `sgn_internal.setting` 與 `raise_error` 的正式簽章；hook 回傳的錯誤訊息怎麼從 `error_catalog` 讀；流程包的 SQLSTATE 配號。
- N-4～N-7 對應 S-5、S-6、S-1、S-2。
- N-8 對應 S-4。
- N-9 對應 S-7、S-8；另需通知的事件代碼與範本變數（契約假定 `fulfilment_ready`、`fulfilment_completed`、`confirmation_reminder`）。
- N-10 對應 S-3、S-9。
- N-11 分級時的參數快照要包含流程包的參數（`classify_tier` 只回傳級別，核心不知道它讀了哪個參數）。
- N-12 群組認領關卡在套用職責分離後沒有任何合格成員時的處理。種子資料就會發生：葉佳蓉申請時法務關無人可認領；游志明申請時用印關無人可認領。
- N-13 執行關也要套用 `K-SOD-APPLICANT`（申請人不能替自己的單用印）；未認領的群組工作逾時怎麼催辦與升級。
- 結論：除了以上通用能力，合約用印不需要任何核心專屬修改，也不需要前端元件、後端 adapter、專屬對外 function。

## 5. rules.md 的缺漏（未修改規則；契約附錄 A 有完整 10 項）
- 「其他（需說明）」沒說寫在哪：契約用既有的「說明」欄位，維持八欄。
- 「說明」是否必填沒寫：契約定為選填，類型為「其他」時必填。
- 實際用印份數的範圍沒寫：契約限制在 1 到核准份數（比規則嚴）。
- 級別依申請人自填的金額判定，但沒有人負責核對金額與檔案一致：契約在法務關加了一項人工檢查。
- 印鑑管理人發現紙本與核准檔案不符時怎麼辦、能不能取消沒寫；rules.md 的取消名單沒有執行人，`K-REVOKE` 有。
- 重複檢查只看同一申請人、不限時間：不同申請人送同一份合約不會被發現。
- 外幣與含稅未稅沒寫。

## 6. 最沒把握的設計點
1. **執行關與完成回報的宣告方式**（S-1、S-2）。整個「認領、用印、填實際份數、逾時催辦升級」都建立在這兩項假定上；核心若採別的做法，契約第 3 節的 `sealing` 關與第 8.1 節要搬位置。
2. **和待納入增修 A11 的方向不同**。`pending-amendments.md` A11（決策 D14）要合約用印「完全宣告、不寫 hook」，但本次任務指定以 hook 實作，骨幹也還沒有宣告式的介面。我照任務與目前骨幹寫成 8 個 hook，並在附錄 B 列出每個 hook 改成宣告時需要的表達能力。總修訂時這份契約第 5 節要重寫。
3. **代碼表加產生式表單定義**。印鑑種類與合約類型放在流程包的代碼表，`form_schema` 由 function 產生。好處是分級不寫死 `company_seal`；代價是多一層，而且改成宣告式後可能整個不需要。
4. **縮小造成級別下降**。金額調降到門檻以下時，契約假定未開始的財務長關直接略過。這符合規則字面，但等於申請人能用一次縮小免掉一關，需要規則負責人確認。
5. **重複比對的鬆緊**。比對鍵忽略全形半形、大小寫與空白，其他差異（公司名稱寫法、錯字）不算重複；狀態採排除法（草稿與已取消以外都算）。誤判的代價只是多填一次原因，所以偏寬，但這是我的選擇，不是規則寫的。

---

# 資料授權流程包契約：回報

兩份文件都已寫完，沒有 commit 或 push。沒有修改 rules.md 與骨幹。文件只做過結構檢查（JSON 區塊可解析、表格欄數一致、章節引用與代碼互相對得上），沒有可執行的東西可以跑。

## 檔案

- `/home/user/req/docs/contract/02-pack-data-access.md`（2,769 行）
- `/home/user/req/docs/packs/data-access/acceptance-cases.md`（412 行）

兩件要先知道的事：

- **骨幹在我撰寫途中更新過**（commit `b83d9499`，新增第 11 節對外整合介面、第 12 節模擬環境）。契約已跟上：多實作 `describe_entitlements`、`evaluate_constraints` 兩個 hook；DC adapter 改成 `manual`、`http`（連 `sim/` 的 DC 模擬器或真實 DC）、`mock`（只用在單元測試）三種。
- **另一個背景作業的 commit `4d078906` 把契約當時的版本一併收了進去**。之後我只改了一行（種子檔路徑），目前是未 commit 的修改；`acceptance-cases.md` 是未追蹤的新檔。

為了讓核心只對照一套假設，登記格式盡量和 `03-pack-seal.md` 相同（`phase`、`mode`、`applies_when`、`reducible`、`hook_rules`、`sgn_internal.setting(p_key, p_scope jsonb)`）。`pending-amendments.md` 的增修沒有納入，契約附錄 B 列出之後會影響的段落。

## 數量統計

| 項目 | 數量 |
|---|---|
| hook | 14 個全部實作，範例共 85 組，每個至少 4 組且含邊界 |
| 資料表 | 7 張（目錄 4、同步紀錄、使用情境分類、`dc_rule`），另有 3 個 enum 型別 |
| 對外 function（`api.data_access_*`） | 10 個 |
| 路徑關卡 | 5 關：4 個簽核關加 1 個執行關 `dc_apply` |
| 流程包參數 | 3 個定義；另在核心參數上登記 8 個值 |
| 規則代碼（`DA-*`） | 25 個 |
| 錯誤代碼 | 26 個 |
| 提示、檢查結果、文字片段代碼 | 56 個 |
| 通知範本 | 3 個 |
| 規則對照表 | 84 列，rules.md 每一條、每個表格列、7 個預設值都有 |
| 具名測試 | 86 個 |
| migration 檔 | 13 個 |
| 測試檔 | 20 個，最少 256 個案例 |
| 驗收案例 | 5 個，共 74 步 |
| 種子資料 | 4 個主題包（26 個欄位、5 個列條件欄位）、5 筆既有授權、1 個標準範本 |

## 骨幹修改建議

1. **第 3 節或 `process_type`：登記 `hook_rules`。** 核心寫稽核事件時無從得知流程包的規則代碼（例如級別判定要附 `DA-TIER-MAX`）。建議登記「hook 名稱 → 規則代碼陣列」，核心一併記下。合約用印也提了同樣的需求。
2. **第 2 節 `policy_stage`：固定格式。** 模式的值、適用條件的格式、時限參數的鍵、檢查清單元素、執行人的宣告方式都沒有定義。建議寫法：`mode: sequential|parallel`、`applies_when: null | {"tier_in": [...]}`、`sla: {"remind","escalate"}`、`checklist: [{"code","label","required"}]`、`phase: approval|fulfilment`。
3. **第 5 節 `K-SOD-DISTINCT`、`K-CLAIM`：註明只適用於簽核關。** rules.md 要 MIS 同一人做合規檢查與執行設定。建議執行關可用 `continue_from_stage` 宣告由某簽核關的核准人接續。
4. **第 10 節：定義表單定義的屬性。** 至少要有 `key`、`type`、`label`、`help`、`required`、`summary`、`reducible`、`max_length`；本流程包另外需要 `options_source`（選項由對外 function 即時提供）、`enabled_setting`（依布林參數顯示或隱藏）、布林欄位的 `true_label`、`false_label`、`default`。`date_range` 的值建議固定為 `{"from","to"}`。
5. **第 6 節：寫明被授權者與授權起迄不在內容裡。** 建議加一句：這兩項的縮小或擴大由核心判定，再和 `compare_content` 的結果取較嚴重者。
6. **第 6 節：寫明 hook 的呼叫保證。** 寫入任何版本前先 `normalize_content`；每個新版本重新 `classify_tier`，級別升高視為擴大；`find_overlaps` 的 `p_case_id` 不為 null（草稿先存檔）。
7. **第 6 節 `on_grant_event`：定義事件值與時點。** 建議 `activated`（執行完成、建立 grant 時）、`expired`、`revoked`（含確認逾期、寬限期逾期、被授權者結束）。
8. **第 6 節 `automated_checks`：定義 `fail` 的效果。** 目前只寫「顯示」。建議有 `fail` 時擋下核准，只能退回。
9. **第 6 節小格式。** `validate_content` 的 `path` 寫法（建議 `scope[0].row_filters[1].values`）；`summarize_content` 的 `emphasis` 型別（建議布林）。
10. **第 5 節：補規則代碼。** rules.md 有、骨幹沒有代碼的規則：一鍵續期、沿用前案或範本、被授權者的建立規則（只能是團隊、專案、agent；專案要有負責人與結束日；相似名稱提示）。
11. **第 5 節 `K-BATCH`：加上「有重疊警示的單不能批次」。** rules.md 有這個條件，目前的文字沒有。
12. **第 8 節：定義級別範圍的 `scope_ref` 寫法。** 我假設是 `data_access:L4`。
13. **第 2 節 `error_catalog`：允許登記不是錯誤的訊息。** 提示、檢查結果、文字片段也要單一來源，需要 SQLSTATE 與 HTTP 狀態可為 null，或另設訊息目錄。
14. **`process_type`：單號前綴。** 建議加 `case_no_prefix`，並定義單號格式。
15. **`seed-directory.md`：補種子人員的身分。** 目錄匯入要用 `person_identity` 對應擁有者，我假設 `provider = seed`、`external_id = p09`。
16. **`05-integration.md` 的資料授權例子要對齊。** 列條件的鍵是 `filter`（不是 `field`）；資源識別碼是 `sales_order.amount`；列條件欄位（例如 `region`）不是可申請的欄位。

## 對核心的需求

契約 §0.3 有完整的假設簽章（D1–D12）與行為前提（B1–B9）。骨幹沒寫到、但本流程包需要的：

- **基礎入口**：`now()` 與 `today()`（支援假時鐘）、`setting`、`raise_error` 與 `error_message`（要能帶參數）、授權檢查（`require_role`、`has_role`、`is_system_actor`、`require_active_person`）、`write_audit`（申請單可為 null）、`enqueue_notification`。
- **登記入口**：`register_role`、`register_setting_definition`、`register_setting_value`、`register_rule`、`register_error`、`register_notification_template`、`register_process_type`、`register_approval_policy`，全部要可重複執行。
- **依範圍的角色指派同步**：`sync_scoped_role_assignments`。目錄同步靠它寫入 `data_owner` 的指派，流程包不能直接寫 `role_assignment`。
- **範本登記**：`save_case_template`、`retire_case_template`。
- **驗證的執行入口**：`api.verification_pending`、`api.verification_report`，由核心比對 expected 與 actual。adapter 回 `unsupported` 時，要有「MIS 逐項記錄結果並附證據」的替代流程（open-questions M3）。
- **`scoped_role` 的行為**：同一人擁有多個範圍只產生一件工作；某範圍找不到持有人時要有明確結果（我在 `validate_content` 先擋）。
- **續期**：授權起日預設為來源授權迄日的隔天；`case.source_kind` 要能分辨續期、沿用前案、範本。
- **自動檢查**：核心自己加上與領域無關的三項（被授權者有在職負責人、每關不同人、期間在上限內）。
- **授權總覽**：要能依範圍（主題包）篩選，資料擁有者才看得到自己主題包的授權。
- **核心欄位名稱**：`case`、`case_version`、`grant`、`principal`、`fulfilment`、`person_identity`、`person`、`case_template` 的欄位。我集中在 7 個「核心存取」function（契約 §4.3），名稱不同只改那裡。
- **被授權者的外部識別碼**：自動交付規則給 DC 時需要（AD 群組、服務帳號）；`05-integration` 已提出 `principal_identity`，交付內容可沿用。

## 最沒把握的設計點

1. **撤銷後怎麼撤回 DC 規則。** rules.md 沒寫，我新增了 `DA-DC-WITHDRAW`：`dc_rule` 帳、通知 MIS、標記已撤回並留紀錄。它依賴 grant 在執行完成時建立、之後任何撤銷都觸發 `on_grant_event('revoked')`；核心若在申請人確認後才建立 grant，確認逾期的撤銷就不會觸發。它和第 11 節的對帳也有重疊，要一起定案。
2. **涵蓋判定只認「單獨一筆授權完全涵蓋」。** 多筆合起來才涵蓋一律算部分重疊。這樣安全但擋得少，因為 DC 是否會合併同一被授權者的多條規則還沒確認。續期時排除來源授權（只要迄日有往後延）也是我的決定。
3. **內容裡保存欄位分級的快照。** 這讓 `classify_tier` 只看內容、證據可自我說明，並用 `DA-E-NOT-NORMALIZED` 防偽造。代價是目錄調整分級後，簽核中的單任何修改都算擴大、要重簽。目錄調升分級時，已生效的授權只通知、不自動撤銷。
4. **MIS 同一人接續執行，以及匯出的解讀。** 「每關不同人」我解讀為只適用簽核關；待納入的 A17 會把這兩件事拆給不同角色，屆時要改。「L4 預設不可匯出」採較嚴的解讀（L4 不能申請匯出，系統管理員可用參數放寬）；簽核人不能直接把可匯出改成不可匯出，因為 rules.md 沒列。
5. **驗證案例與 DC 的介面。** 測試查詢帶 `as_of`（授權起日未到時用起日測），並要求 DC 能分辨「被擋下」和「本來沒資料」。DC 模擬器做得到，真實 DC 未必（M3）。我另外加了匯出與到期後兩種反例，超出任務列的四種。`http` adapter 的端點路徑是我假設的，要和 `sim/` 的作者對齊。

## rules.md 的缺漏

沒有發現互相矛盾的規則。契約附錄 A 列了 12 項缺漏與我採用的做法，需要規則負責人確認的主要是：

- 撤銷後 DC 規則的撤回（A-1）。
- 目錄調升分級後既有授權的處理（A-2）。
- 「L4 預設不可匯出」的解讀（A-3）。
- 資料期間是否必填（A-5）：我定為選到有期間欄位的主題包時，起迄都必填。
- 現任資料擁有者（當初不是簽核人）可否撤銷（A-7）：rules.md 的撤銷名單沒有，畫面草圖有撤銷按鈕；屬於 `K-REVOKE`，契約未處理。
- 兩張相同的申請同時簽核中不算重複（A-12）。

## 其他

- 共用暫存目錄裡我的草稿 `p1.md` 被另一個作業覆寫過，我已重寫並改放 `scratchpad/da02_work/`；成品不受影響。
- 驗收案例假設單號格式是「DA-年度-流水號」，種子的 5 筆授權佔用 `DA-2025-0001`、`0002` 與 `DA-2026-0001`–`0003`，所以每個案例的第一張單是 `DA-2026-0004`。格式不同時只影響文件裡的單號。

---

# 整合介面契約作者的回報（）

產出：`/home/user/req/docs/contract/05-integration.md`（約 3,000 行，新檔；未 commit、未改骨幹與其他檔案）。標準現況皆於 2026-11-19 以規格原文查證（來源列在文件附錄 B）。

## 一、採用的標準與理由

**必須採用**
- **OpenID AuthZEN Authorization API 1.0**（Final，2026-01 核准）：權限判定的請求、回應、路徑（`/access/v1/evaluation`、`/evaluations`）、中繼資料（`/.well-known/authzen-configuration/integration/v1`）、三種批次語意。理由：已定案，模型與骨幹第 11 節的主體／資源／動作／情境一致。風險：定案不到一年，產品支援尚不普遍。依據（授權 id、申請單號、限制條件）與 `ttl_seconds` 放在回應的 `context`，這部分規格留給實作自訂。
- **OAuth 2.0 client credentials（RFC 6749 §4.4）＋ Bearer（RFC 6750）**：自建 token 端點，短效不透明 token，資料庫只存 SHA-256。
- **CloudEvents 1.0.2（JSON、structured mode、`sequence` 擴充）**：事件串流與 webhook 共用同一種格式。
- **Standard Webhooks 1.0.0**：`webhook-id`／`webhook-timestamp`／`webhook-signature`，同時送 `v1`（HMAC）與 `v2a`（ed25519），重試與 410 停用。風險：它是社群規格；`v2a` 較新，函式庫支援可能落後；內容欄位用 CloudEvents 的 `time` 而非它建議的 `timestamp`。
- **OCSF 1.9.0**：稽核事件給 SIEM 的 `format=ocsf`，對應 3005 User Access Management 與 3004 Entity Management。風險：OCSF 沒有「簽核」類別，細節只能放 `unmapped`。
- **JWS／JWK（Ed25519，RFC 8037、RFC 9864）**：檢查點簽章與公鑰發布。

**選用（留位置，第一版不做）**：RFC 3161 外部時間戳記、AuthZEN Search API、SSF 1.0 發送端、改由公司 IdP 發 JWT、`private_key_jwt`／mTLS、Standard Webhooks endpoint verification 擴充。

**不採用**
- **CAEP 1.0**：查證後只有 8 種登入階段／憑證類事件，沒有「授權生效／撤銷」。
- **SCIM 2.0**（當授權或對帳格式）：RFC 7643 明寫 `entitlements` 無詞彙與語法，無法表達資源／動作／限制條件。
- syslog／CEF 推送、自訂簽章與事件信封。

**沒有查證到的**：各標準是否有認證測試、各廠牌 SIEM／IGA 實際支援的版本。

## 二、數量

- 資料表 **22**（另 17 個 enum、2 個 sequence、2 個複合型別）
- `sgn_internal` function **35**（含 6 個排程工作）
- `api` function **60**：給其他系統 27、只給後端 5、給人 28
- REST 端點 **56**：`/integration/v1/…` 與 well-known 共 28（其中 `jwks.json` 由後端直接產生、無 function）；給人的 28
- 規則代碼 `K-INT-*` **24**、錯誤代碼 **40**、參數 **40**、事件類型 16、scope 9
- 後端另需：2 個 worker（webhook 推送、檢查點簽章）、2 個 port（`Signer`、`TimestampAuthority`）、token 專屬 handler
- `sim/consumer` 的行為、控制端點與 17 個端對端情境已寫給實作者

## 三、骨幹修改建議（文件附錄 A，共 14 項；最需要先定的排前面）

1. **核心必須呼叫投影入口**：狀態轉移唯一入口呼叫 `sgn_internal.project_case(p_case_id, p_rule_code)`；被授權者負責人／成員異動呼叫 `sgn_internal.project_principal(...)`。migration 順序：投影檔必須在核心資料表之後、生命週期 function 之前。這是整個模組唯一需要 01-kernel 作者配合的接點。
2. **`describe_entitlements` 回傳增加兩個選填鍵**：`effective_during`（`active`／`fulfilment`，合約用印這種一次性許可需要）、`scope_ref`（複查找範圍角色持有人用）；並明定同一張單內資源不得重複、function 為 `stable`。
3. **`evaluate_constraints` 的 `p_context` 結構與 `mode`（`check`／`reconcile`）**；預設行為補上「有限制條件而沒登記 hook 時回 false」。
4. **`case`、`grant` 是 SQL 保留字**，資料表名要統一加雙引號或改名。
5. **稽核鏈的 `canonical` 文字與雜湊公式**要在 01-kernel 明定並可逐筆取得，否則第三方驗證無法重算。
6. **`audit_event` 增加 actor 種類與 `api_client` 欄位**（目前以「系統＋變更內容帶代碼」處理）。
7. **新增 `principal_identity`**（與 `person_identity` 對稱；目前由本模組 migration 建立）。
8. **沒有有效期間的流程是否建立 `grant` 紀錄**要明定（本契約兩種都能運作）。
9. **核心需提供**：以指定規則代碼撤銷授權的內部入口；「生效中授權的縮小」入口。
10. `K-DELEGATE`、`K-MOBILE-MFA` 適用範圍加上複查決定。
11. 參數前綴加 `integration.`、`reconciliation.`、`review.`、`evidence.`；`scope_ref` 用 `api_client:<code>` 表示個別系統。
12. 第 10 節通用畫面加：複查工作、對帳發現、整合系統管理。
13. 第 11 節命名對齊：`events` → 表 `integration_event`；`evidence` → 表 `evidence_checkpoint`；`audit_feed` 是端點、無獨立表。
14. 工程規範：路由表加 `auth: 'client'`、`bodyLimit`、`decorate`；port 清單加 `Signer`、`TimestampAuthority`；整合端點不加 `/api` 前綴。

另外，文件第 2.1 節列了 11 個以 ⟨⟩ 標示的核心入口暫用名稱（取時間、寫稽核、找主管、撤銷授權等），實際名稱要等 01-kernel 定案後對齊。OCSF 對應表的稽核動作代碼也要等核心的動作代碼定案才能填。

## 四、最沒把握的設計點

1. **請求沒提到的限制面向怎麼判**：目前由流程包決定，核心一律回傳完整限制條件要使用方自行套用。使用方若忽略就會超放。hook 只回布林，核心無法做「缺面向就拒絕」的嚴格模式。
2. **資料授權的資源粒度**：例子用「欄位」當資源（一張單會產生數十筆權限項目）。這其實是資料授權流程包契約的決定；若改用「主題包」，多筆授權各涵蓋部分欄位時無法單次判定。
3. **事件順序靠交易層級 advisory lock**：所有會產生事件的交易排隊。若核心稽核鏈也有自己的鎖，取鎖順序必須固定，否則可能死結；批次核准續期時的等待時間需實測。
4. **每次判定都寫速率計數與呼叫紀錄**：紀錄表未分割、逾期以刪除清理。執行系統若每次查詢都來問，可能要改按月分割。效能目標（單筆 p95 ≤ 50 ms、百筆批次 ≤ 500 ms）是設計值，尚未實測。
5. **複查決定「縮小」**：骨幹只定義簽核過程中的縮小。核心若不提供生效後的縮小入口，這個決定實際等於「限期重新申請，否則自動撤銷」。


---

# 整合介面契約作者的回報（）

# 修訂回報：docs/contract/05-integration.md

只改了 `/home/user/req/docs/contract/05-integration.md`（3,039 行 → 4,279 行），沒有 commit / push，沒有動骨幹與其他契約。
SQL 沒有執行過（repo 還沒有資料庫）；驗證只做了文件內部一致性的腳本比對，結果在最後一節。

## 1. 已修正數

40 項審查發現全部處理：2 項 blocker、18 項 major、20 項 minor 都已修進文件。其中 11 項是「採納問題、但做法與建議不同或只採一部分」，列在第 2 節。沒有整項不採納的。

主要改動（依文件章節）：

- **2.2 投影**：改由掛在 `case`、`grant`、`person`、`person_identity`、`principal`、`principal_member` 上的六個延後觸發程序驅動，不靠核心記得呼叫。判定時再以主鍵複核 `grant` 與主體狀態。新增排程 `job_integration_consistency`。
- **3.2 外部識別碼**（blocker）：`principal_identity` 只能由身分同步或「系統管理員提出、非負責人非成員覆核」的變更申請寫入。每次改變寫稽核事件（新舊值）、發 `sgn.principal.identity_changed`，並阻止相關對帳發現自動結案。
- **3.3、4.1 嚴格模式**：`api_client.constraint_mode` 預設 `strict`，缺限制面向回 `constraint_context_missing`。`advisory` 要填理由且必須納入對帳。
- **3.4 狀態表**：補齊沒有 `grant` 的各種情況；新增 `subject_inactive`（人離職、被授權者結束）；一次性許可一定有期限；日期轉時間改用 `system.business_timezone`。
- **3.6 合約用印**（blocker）：選 (a)，保留一次性許可，改用 03 的實際欄位（`seal_kind`、`copies`、`contract_files[].sha256`），並在附錄 D 寫死對 03 的要求。
- **4.x 系統身分**：
  - 4.3 token 換發的失敗與成功分開計數，失敗一律 401。
  - 4.7 呼叫紀錄改為每個檢查點前以 id 範圍封存，雜湊加入 `ip`、token、筆數，時間用 UTC 文字。
  - 4.8 失敗的請求也計數，新增每系統的失敗上限。
  - 4.9 新增變更申請（雙人覆核；`audit.read_all` 另需會簽；密鑰只有負責人領得到）。
  - 4.10 新增來源 CIDR 限制、token 綁定位址、`p_ip` 的取得規則。
- **5.x 判定**：`ttl_seconds` 納入成員期間、被授權者結束日、複查追蹤期限、負責人寬限期，上限降到 300 秒；新增 5.7 用量回報（`usage.write`）。
- **6.x 授權查詢**：`status` 定義為儲存的狀態；新增 `effective_at`、`effective_now`；同步流程寫成使用方必須遵守的規定；游標內含 `sync_epoch`（409 `integration_resync_required`）；新增 6.5 成員名單端點與 `expand=members`。
- **7.x 事件**：
  - 新增 `sgn.principal.identity_changed`、`sgn.person.identity_changed`、`sgn.client.visibility_changed`、`sgn.reconciliation.run_completed`。
  - `sgn.principal.*` 的可見條件收緊；CloudEvents 的 `subject` 不再帶內部 id。
  - webhook 補上狀態轉移表與每小時管理上限。
  - worker 固定用解析到的位址連線，明列禁止範圍，只記錯誤種類。
- **8.x 對帳**（幾乎重寫）：
  - 比對分段執行。
  - 異常批次（新發現超過上限）整批暫停，等人工檢視。
  - 高嚴重度發現要獨立確認才結案；換主體回報會沿用原期限。
  - 回報項目可帶 `entitlement_id`，另有聯集比對。
  - `observed_at` 不可回填；每日與進行中批次數有上限。
  - 指紋改用 JSON 陣列編碼。
  - 沒有 `grants.read` 的系統只拿到遮蔽版的發現。
  - 新增 8.9 檔案上傳對帳（A21）。
- **9.x 複查**：職責分離加上「主體的成員」；負責人改為可填需求確認但不能決定；`reduce` 要給結構化的 `reduce_spec` 並逐項核對，`tighten` 另需確認；取消進行中的複查要雙人覆核；`result_sha256` 與快照雜湊給出 SQL。
- **10.x 證據**：
  - `audit.read` 以「申請單至少有一筆可見權限項目」為條件，內容遮蔽。
  - OCSF 修正 `user.type_id`、`src_endpoint.ip`、`actor.app_*`。
  - 新增 `GET /integration/v1/audit/calls`（OCSF 6003）。
  - `event_count` 改為實際筆數；驗證不依賴序號連續，並補上保存年限清除後的起點。
  - 新增簽章停擺警示。
- **11–18、附錄**：DDL、function、端點、規則、錯誤、參數、排程、測試、情境全部同步；新增附錄 D（對其他契約的要求與待納入增修的相依）。

修訂後的規模：

| 項目 | 修訂前 | 修訂後 |
|---|---|---|
| 資料表 | 22 | 29 |
| `api` function | 60 | 75（系統 30、後端 6、人 39） |
| 端點 | 28＋28 | 31＋39 |
| 規則代碼 | 24 | 37 |
| 錯誤代碼 | 39 | 65 |
| 參數 | 39 | 64 |
| 排程工作 | 6 | 7 |
| 端對端情境 | 17 | 29 |

## 2. 未採納與理由

沒有整項不採納的。下列是做法與建議不同、或只採納一部分的地方：

- **速率計數（4.8）**：沒有採「業務 function 之前先以獨立交易驗證並計數」，因為每次呼叫會多一趟往返與一個寫入交易。改由 `integration_record_failure`（本來就是獨立交易）補計 `api` 與新的 `error` 計數；連續 404 會被限流。
- **401 不計入系統的計數（13.2）**：這是我自己加的偏離。若 401 也計入，拿到 token 的人從別的位址亂試，就能讓正牌系統被限流。401 改記在不引用 `api_client` 的失敗計數並示警。
- **token 換發失敗（4.3）**：兩份審查建議不同（回相同的 401 或相同的 429），採「失敗一律 401、永不變 429」，只有密鑰正確時才可能 429。
- **來源限制（4.10）**：採 CIDR 加 token 綁定位址；mTLS／RFC 8705 留在 1.3 的選用項目，沒有做成高權限 scope 的必要條件。
- **`audit.read` 的遮蔽（10.2）**：兩份建議不同（白名單鍵或整個設為 null），合併為：`changes` 只留白名單表 `sgn.audit_export_key` 的鍵，`settings`、`ip`、`canonical` 一律 null。白名單內容要等核心的稽核動作代碼定案才能填。
- **高嚴重度發現的確認（8.7）**：只採「非負責人的人獨立確認」。沒有採「另一個 `api_client` 的批次確認」，因為發現以回報系統為單位，別的系統的批次說明不了這個系統的實際設定。
- **`ttl_seconds`（5.5）**：採「上限降到 300」，沒有採「超過 300 時要求有 webhook 訂閱」。
- **用量端點的路徑（5.7）**：兩份建議的路徑不同，採 `POST /integration/v1/grants/{entitlement_id}/usage`。兩段式預留沒有做，列在附錄 C。
- **被取代批次的 409 回應（8.3）**：沒有在錯誤內容加 `status`、`superseded_by`，因為 `raise_error(代碼)` 只收代碼。改為呼叫方以查批次端點取得這兩個欄位。
- **A16、A12（附錄 D）**：`resource_system_id` 與公司別維度沒有進 DDL，因為骨幹還沒有這兩個實體；確切要改的欄位寫在附錄 D。A20 以兩個回傳角色代碼的 function 隔離，之後只改這兩處。
- **事件數上限**：我一度加了「單一交易事件數上限」，後來移除。它會讓核心的大批次核准整筆失敗，而對帳已由每段筆數限制。

## 3. 骨幹修改建議（彙整；完整 22 項在文件附錄 A）

- **第 2、4 節**
  - 明定 `grant` 在哪個轉移建立、哪些流程類型會有、起迄是含頭尾的日期。
  - 人的在職狀態、被授權者的狀態與結束日要是可被觸發程序觀察的欄位。
  - `principal_member` 移除成員時保留該列並填迄；`case` 要有「進入目前狀態的時間」。
  - 加入 `principal_identity` 與整合相關資料表。
  - `audit_event` 增加 actor 種類與 `api_client` 欄位。
- **第 5 節**
  - 人離職時核心應撤銷相關授權（`K-OWNER-CONTINUITY` 只寫了被授權者結束）。
  - 提供「以指定規則代碼撤銷」與「生效後縮小」的入口。
  - `K-DELEGATE`、`K-MOBILE-MFA` 適用於複查決定與變更申請的覆核。
  - `K-AUDITOR-READONLY` 是否允許稽核角色會簽。
  - A10 進核心後取代本文件 4.9。
- **第 6、11 節**
  - 投影由整合模組的觸發程序維護；核心只需（選用）呼叫 `note_projection_rule`，以及在負責人寬限期開始與解除時呼叫 `project_principal`。
  - `describe_entitlements` 增加 `effective_during`、`scope_ref`，並規定 `has_validity` 為否不得回 `active`。
  - `evaluate_constraints` 的 `p_context` 定義 `mode`、`strict`、`usage`、`approved_union`；沒有登記 hook 而有限制條件時回 false。
  - 能力表增列一次性許可、用量回報、成員名單、檔案上傳對帳，並明定時間造成的生效與失效不發即時事件。
- **第 3 節（A11）**：宣告式流程定義增加 `entitlements` 宣告，結構與五種比對方式的提案在附錄 A 第 21 項。
- **第 8 節**：新增核心參數 `system.business_timezone`；參數前綴增加 `integration.`、`reconciliation.`、`review.`、`evidence.`。
- **稽核鏈**：明定 `canonical` 與雜湊公式；序號是否保證連續；保存年限清除時寫一筆帶首尾序號與雜湊的稽核事件。
- **排程**：每個工作每次呼叫各一個交易，工作可回 `more` 要求立即再呼叫。
- **工程規範**：路由表增加 `auth: 'client'` 等欄位；部署設定增加 `TRUSTED_PROXY_CIDRS`、`WEBHOOK_BLOCKED_CIDRS`、`WEBHOOK_ALLOW_PRIVATE`；人員與組織 port 的同步範圍加上被授權者的外部識別碼。
- **第 10、12 節**：通用畫面增加變更申請、密鑰領取、對帳上傳與確認、複查的需求確認；`sim/` 的使用方同時扮演用印設備，另有一個只用檔案上傳的系統。

## 4. 仍需使用者決定的事項

1. **合約用印要不要對外提供判定。** 我選 (a)：保留一次性許可，要求 `03-pack-seal.md` 登記兩個 hook。理由是程式上線、供應商帳號變更也是同一種模型。這與 03 作者的決定及 A11（用印不寫 hook）相反；03 改好之前情境 12 不會通過。不同意就改 (b)：刪掉 3.6、`fulfilment`、5.7。
2. **雙人覆核需要至少兩位 `sys_admin`。** 種子名單只有謝明哲一位，這種情況下連一個系統都登記不了。請決定補誰，或等 A20。
3. **稽核角色會簽 `audit.read_all`** 與骨幹「稽核唯讀」有出入。要不要允許，或改由別的角色會簽。
4. **預設嚴格模式** 需要 `02-pack-data-access.md` §5.14 依 `p_context.strict` 實作（附錄 D 第 2 項）。02 沒改之前嚴格模式形同虛設。
5. **高嚴重度對帳發現要獨立確認才結案**，會增加系統管理員（或資料擁有者）的工作量。不歸資訊單位管的系統由誰確認，要等 A16。
6. **複查人不得是團隊成員**：身為成員的負責人不能複查自己團隊的授權，自動建立的複查多半會改派給他的主管。請確認這是要的行為。
7. **從嚴的自動處置**：複查縮小後，期限到仍未經確認就自動撤銷，包含確認人沒回應的情況；人離職後復職，權限不自動恢復。
8. **會影響使用方的預設值**：
   - token 預設綁定單一位址，雲端或容器環境要登記為 `cidr`。
   - 判定快取上限 300 秒。
   - 每系統每分鐘 60 次失敗即限流。
   - 一次性許可 72 小時。
   - 對帳 `observed_at` 最多回溯 60 分鐘，檔案上傳 24 小時。
   - 單批新發現超過 200 筆就暫停。
9. **`docs/reality-check/00-decisions.md` 在我修訂期間出現，沒有納入。** 我只看了總表的部分列。骨幹更新後要再對齊的至少有：
   - RA-01、RA-02：檢查點、錨定與雜湊正規化移到核心。
   - RA-03：讀取時比對 `row_hash`，與本文件「判定時複核加一致性排程」重疊。
   - RA-09：保存年限改 5 年。
   - RA-14：`K-MOBILE-MFA` 改名。
   - RA-33：設定變更母體含 `api_client`、webhook、可信代理清單。
   - RB-30：新 hook `describe_expected_state`，以及異動紀錄檔的對帳。
   - C-21：複查未回應「先升級再暫停」，本文件是撤銷。
   - C-43：`decision_log` 保存 3 年、可詢問範圍以受管系統限定。
   - C-46：寫入類 scope 必須用 `private_key_jwt`。
10. **`pending-amendments.md` 要補登記**（我不能改）：對 03 的 hook 要求、對 02 的 `strict`／`approved_union` 要求、畫面契約的新畫面，內容在附錄 D。

## 5. 一致性檢查結果

- 規則代碼：全文出現 37 個，15.1 的表 37 個，17.2 的測試表 37 個，三者相同。
- function 與端點：13.1 有 27 列加 3 個不走骨架的；13.2 有 6 列；13.3 有 39 列，與 14.2 的 39 個端點逐一對上；14.1 有 31 列。
- DDL 共 29 個 `create table`；文中引用的 `sgn.*` 資料表不是本文件建立的，就是核心的。
- 文中引用的 `sgn_internal.*` 都在第 12 節或 2.1 的核心入口清單。
- 事件類型：7.1 有 20 個，與 `integration_discovery` 的清單相同；scope 10 個，兩處相同。
- 文中引用的參數都在 15.3。
- 35 個 JSON 區塊可解析；表格欄數一致；程式碼圍欄成對。
- OCSF 6003 的必要屬性與 `user.type_id` 的值，這次另外查了 schema.ocsf.io；其餘標準沿用原文件的查證。
