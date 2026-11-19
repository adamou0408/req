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