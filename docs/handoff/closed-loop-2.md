# 交接：閉環第二批——測試區與正式區、測試報告（closed-loop-2）

依據：`docs/decision-log.md` D93（環境）、D94（測試報告）、D95（第一批的複核）；沿用第一批 `docs/handoff/closed-loop-1.md` 的做法（hook 包裝、目錄版本綁定、逐位元組比對要簽的內容、只增不改的表）。契約：`docs/contract/02-pack-data-access.md` §8.1、§8.6–§8.8；使用方義務 `docs/contract/06-consumer-obligations.md`（2.11、3.4、6.4、9.5）。`docs/packs/data-access/rules.md` 沒有修改（新規則的條文草稿在 §5）。

## 1. 做了什麼

| 項目 | 狀態 | 實作 | 測試 |
|---|---|---|---|
| A1 環境欄位 | 完成 | `db/packs/data_access/150_environment.sql`（代碼表 `data_environment`、`normalize_environment`、`display_environment`、`compare_environment`） | `db/tests/packs/data_access/75-environment.test.mjs` DA-ENV-FIELD（兩個） |
| A2 級別逐欄逐區 | 完成 | `catalog_field_environment`；快照格式 `data_access_catalog/2`；`catalog_ref` 只看這張單那一區的標示；種子標示測試區的聯絡人電話、薪轉帳號已遮罩（L4 → L3）；sim/dc `catalog.ts`、`catalogVersion.ts` 同步；測試向量更新 | `75` DA-ENV-TIER；`60` DA-CATALOG-VERSION（新向量）；`sim/dc/tests/11-catalog-version` |
| A3 交付帶區、兩區真的分開 | 完成 | 規則的 `environment`；`check_delivery_zoned`（DA-ENV-MISMATCH）；sim/dc 同一個資料庫兩組 schema（`data`/`data_test`、`export`/`export_test`），規則角色只拿到那一區的欄位權限、policy、檢視表；已簽的套用與驗證結果帶 `environment`；mock（`api/src/dcMock.ts`）同樣 | `75` DA-ENV-MISMATCH；`sim/dc/tests/13-environment.test.ts`；`e2e` `system-zone` |
| A4 另一區查不到；對帳與使用紀錄分區 | 完成 | 驗證的查詢帶區、反例 `request:other_environment`（DA-ENV-VERIFY）；對帳限制條件帶區（DA-ENV-OVERLAP）；使用摘要 `usage_summary_batch/2` 每筆帶區（核心 `db/kernel/555_usage_detail.sql`，K-USAGE-DETAIL） | `75` DA-ENV-VERIFY、DA-ENV-OVERLAP、K-USAGE-DETAIL；`50` DA-VERIFY-CASES |
| A5 正式區要引用測試區單；測試區期限較短 | 完成 | 核心的送審複核 hook（`db/kernel/550_submission_review.sql`，K-SUBMIT-REVIEW）；`review_submission`（DA-ENV-TEST-BASIS、DA-TEST-EXCEPTION、DA-ENV-VALIDITY）；`api.data_access_test_bases`；參數 `data_access.environment_validity_max_months`（適用範圍 `environment`，測試區 3 個月） | `75` DA-ENV-TEST-BASIS、DA-TEST-EXCEPTION、DA-ENV-VALIDITY、K-SUBMIT-REVIEW |
| B1 七區塊的報告；使用紀錄到欄位層級 | 部分（列條件實際範圍沒有資料，報告照實寫「沒有回報」） | `db/packs/data_access/160_test_report.sql`（`test_report` 可重用、`normalize_reported`）；摘要 `/2` 的 `fields`、`client_versions`；sim/dc `/use` 記欄位與版本識別、`/usage-summaries` 逐欄彙總 | `80-test-report.test.mjs` DA-TEST-REPORT；`sim/dc/tests/13-environment` |
| B2 四種警示 | 完成（另加「版本變動」與「使用方沒有回報」） | `test_report_warnings`；門檻參數 `data_access.test_report_min_uses`（依級別，L3 10、L4 20） | `80` DA-TEST-REPORT-WARN |
| B3 送審凍結、雜湊進簽的內容、決定畫面顯示 | 完成 | 報告與雜湊在內容的 `test_report`（版本雜湊、顯示摘要涵蓋）；送審時重算，不同就擋下；相同就寫快照表 `test_report_snapshot`（只增不改）；畫面元件 `reportView`（`web/packs/data_access.js`） | `80` DA-TEST-REPORT；`e2e` `system-zone` |
| B4 沒有測試紀錄 | 完成 | 理由必填、送審後開例外（DA-TEST-EXCEPTION）；生效時開帶期限的例外 DA-TEST-REPORT-FOLLOWUP（核心 `db/kernel/560_grant_followup.sql`，K-GRANT-FOLLOWUP）；申請人在首頁產生上線後的使用報告（`api.data_access_usage_report`，`usage_report` 只增不改）才結案；逾期由既有的 K-EXCEPTION-FOLLOWUP 升級，不撤銷 | `80` DA-TEST-REPORT-FOLLOWUP K-GRANT-FOLLOWUP；`75` DA-TEST-EXCEPTION；`e2e` `system-zone` |
| B5 版本識別變動 | 完成 | 版本識別以使用紀錄裡使用方帶的為準（`tested_version`），沒有才用來源單上申請人填的；參數 `data_access.version_change_action`（L4 `block`＝擋下送審要重新測試，L3 `warn`） | `80` DA-TEST-VERSION |
| B6 可重用的元件與 function | 完成（續期、定期複查本身沒做） | `pack_data_access.test_report(來源單, 內容)`、`report_display`；畫面 `reportView`；上線後的使用報告就是第二個用處 | `80` |
| C 六個畫面問題 | 沒做 | — | — |
| 文件 | 完成 | 02 §8.1、§8.6、§8.7、§8.8；06 的 2.11、3.4、6.4、9.5；`sim/dc/README.md` | — |

### 1.1 環境（D93）

- 代碼表 `pack_data_access.data_environment`（`test`、`prod`）帶四個旗標：`requires_test_basis`（正式區）、`is_test_source`（測試區）、`applies_to_legacy`（舊單視為哪一區＝正式區）、`default_when_missing`（新的輸入沒有指定時＝測試區）。程式只讀旗標，不寫死區的代碼。
- 內容的 `environment` 進版本雜湊；顯示摘要多一行「環境：測試區」（`display.content.environment`），瀏覽器簽的是整份顯示摘要，所以 `web/lib/signing.js` 不用改；`75` DA-ENV-FIELD 以鏈上記下的要簽內容和 `decisionContent` 逐位元組比對。
- **舊單**（升版前、沒有這個鍵）：雜湊不重算、顯示摘要不多這一行、視為正式區；送審複核不追加「要引用測試區單」這條新規則（照樣能送審與簽核）。系統整理過的舊內容（帶 `catalog` 鍵，例如目錄改版時重新綁定）再整理時仍是正式區，不會被改到測試區。
- **新的輸入沒有 `environment`**：以測試區處理並提示（`DA-N-ENVIRONMENT-DEFAULT`）。理由：從嚴——沒說要哪一區就只給較不敏感、期限較短的那一區；要正式區必須明講並附測試依據。這也讓不知道這個欄位的舊用法（紅隊腳本、舊的前端）有明確、合理的行為，而不是全部變成錯誤。
- 級別：`catalog_field_environment` 標示「這一欄在某一區已去識別或遮罩，分級是 X」（必須比正式區低，`DA-E-CATALOG-ZONE`）。整理內容時依區取分級（申請人帶的分級不算數），降級時提示。目錄快照升為 `data_access_catalog/2`：只有標示過的欄位多 `environments` 鍵，所以只有雜湊的格式字串與那兩欄改變；引用摘要只留這張單那一區的標示，標示測試區不會讓正式區的單被當成目錄異動。
- 交付：規則帶 `environment`（舊單不帶，已送出的位元組不變）。sim/dc 在同一個資料庫裡兩組 schema，規則角色只拿到那一區的權限；已簽的套用與驗證結果回報實際套用到的區，平台不同或沒回報就不生效、撤回、開 `DA-ENV-MISMATCH`。
- 驗證：每個查詢帶區（反例被同一被授權者其他單放行的判斷也以同一區的聯集算），另加 `request:other_environment`。
- 重疊與完全涵蓋只和同一區的授權比；對帳每一項的限制條件帶權限實際所在的區。
- 正式區送審（核心的送審複核 hook）：引用的單必須是測試區、曾經生效、同申請人或同被授權者、主題包與欄位涵蓋、列條件不比它窄；或填理由（開例外 `DA-TEST-EXCEPTION`，簽核人在決定畫面看得到）。期限上限依環境（參數，適用範圍 `environment:data_access:<區>`），和依級別的上限同時成立。

### 1.2 測試報告（D94）

- `test_report(來源單, 內容)` 從來源單的使用摘要（核心 `sgn_sdk.case_usage_detail`，每個鍵最新的一批）算出：`tested`、`used`（逐欄次數與最後使用時間）、`unused`、`blocked`（總數與範圍以外被擋下的欄位）、`diff`（沒測過、沒用到仍申請、測過但沒申請）、`application`（申請人填的＋測試時的版本識別與來源）、`completeness`（有沒有回報、時段數、人數、總次數）、`warnings`、`settings`。`rows: {reported: false}`：使用方的摘要沒有列層級的資料。
- 內容的 `test_report` 是報告加它的 RFC 8785 雜湊；顯示摘要的 `test_report` 是由資料庫產生的文字（`report_display`），簽核人簽的內容包含它。比較內容時忽略報告（它是從依據與使用紀錄算出的，簽核人縮小時重算），但換依據、換理由、換應用面算擴大。
- 送審的那一刻重算，和內容裡的不同（新的使用紀錄進來了）就擋下（`DA-E-TEST-REPORT-STALE`），申請畫面每次輸入都會重存，所以畫面上按送出時一定是最新的；相同就寫進 `test_report_snapshot`（每張單每一版一筆，只增不改）。
- 應用面（`application`：程式或報表、版本識別、結果給誰看、每欄用途）由申請人填，正式區必填（`DA-E-APPLICATION-REQUIRED`）。

### 1.3 新畫面動作在 390px 寬的步數（`e2e/tests/system-zone.test.mjs` 量的）

| 動作 | 步數 | 步驟 |
|---|---|---|
| 申請測試區 | 0（比原本多） | 畫面預設測試區 |
| 申請正式區並引用測試區的單 | 比原本多 5 | 在「哪些資料」選「正式區」→ 從清單選測試區的單 → 填「用在哪支程式或報表」→ 填版本識別 → 填「結果給誰看」（每欄用途選填） |
| 申請正式區、沒有測試紀錄 | 比原本多 5 | 選「正式區」→ 選「沒有測試紀錄」→ 填理由 → 應用面的程式與給誰看（版本選填） |
| 簽核人看測試報告與警示 | 0（決定畫面本身） | 「要使用的資料」裡直接顯示，警示在最上面，「實際用了什麼」與「與這次申請的差異」預設打開 |
| 申請人補上線後使用報告 | 2 | 打開首頁 → 按「產生使用報告」 |

## 2. 怎麼執行

```bash
tools/check.sh                      # 全部（最後跑 tools/run-all.sh）
db/build.sh                         # 只建庫＋資料庫測試
sim/dc/test.sh tests/13-environment.test.ts
tools/run-all.sh --keep             # 起系統；新申請畫面「哪些資料」最上面選區
```

驗證結果見 §6。

## 3. 與 D93、D94 不同的地方與理由

| # | 不同 | 理由 |
|---|---|---|
| 1 | 新的輸入沒有 `environment` 不是錯誤，而是以測試區處理並提示；畫面預設測試區 | 從嚴（只給較不敏感、期限較短的區）；不認得這個欄位的舊用法有明確的行為（任務要求，紅隊腳本不必改） |
| 2 | 舊單（沒有環境鍵）送審時不追加「要引用測試區單」 | D93 沒說舊單；「舊單照樣能簽」。新的內容一律帶環境鍵，這個例外只涵蓋升版前的內容 |
| 3 | 「範圍涵蓋」＝主題包與欄位涵蓋、列條件不比它窄；**不比資料期間與匯出** | 測試區是過去時間的副本，期間本來就不同；匯出要不要另由簽核決定 |
| 4 | 測試區期限上限的初始值 3 個月（正式區依級別 12、6 個月） | D93 (5) 只說「較短」；參數，可以改。既有測試的預設授權期間因此由 5 個月改為 2 個月 |
| 5 | 對帳的「鍵加環境」：區放在比對的限制條件，不在鍵裡 | 規則代碼本來就分到單，一張單一區；放進鍵要改核心的鍵與所有既有的回報格式（含紅隊腳本依賴的 `resource.id`）。沒有規則的權限（後門）以限制條件的區比對，見 §4.1 |
| 6 | 使用摘要的區：每筆帶，必須等於平台送出的最新一版規則的區；鍵沒有另外加區 | 摘要的鍵（單、人、時段）裡的單只有一區 |
| 7 | 報告的「列條件實際範圍」沒有做 | 使用方的摘要沒有列層級的資料；要做需擴充 06 的義務（每次使用的列條件值範圍），留給下一位 |
| 8 | 「沒用到的欄位」與「沒測過的欄位」分開：沒測過＝這次申請、測試時沒有的欄位；沒用到仍申請＝測試時有、次數為 0 | 正式區的依據必須涵蓋，所以送審時「沒測過」一定是空的；它在報告重用（續期、複查）時才會出現 |
| 9 | 警示多兩種：版本識別變了、使用方沒有回報使用紀錄 | B5 要提示；紀錄完整性是報告的第七區塊，沒有回報時「次數 0」不代表沒有使用 |
| 10 | L4 版本變動「要重新測試」做成擋下送審（`DA-E-VERSION-RETEST`） | 申請人換一張涵蓋新版本使用紀錄的測試區單、或在原本的測試區單上用新版本跑過（使用紀錄帶新的版本識別）才能送 |
| 11 | 上線後使用報告由申請人在首頁按一下產生（不是系統定時產生） | D94 (4) 要「限期補」；系統替人產生就沒有人為報告負責。報告內容仍全部由系統算 |
| 12 | D94 (5) 「正式區生效後持續比對，沒用到的欄位提醒縮小」、續期、定期複查沒做 | 任務範圍外（B6 只要求可重用） |
| 13 | 測試區的資料是正式區**全部期間**的副本（sim/dc） | 驗證案例會查任意日期；「過去時間」的切點是使用方的事，不影響平台的判定 |
| 14 | 只有申請人能產生上線後使用報告；被授權者的負責人不行 | 核心沒有給流程包「被授權者負責人是誰」的讀取口；申請人本來就是要補報告的人 |

### 3.1 和 `rules.md` 的矛盾（沒有修改 rules.md，回報負責人）

- `rules.md` 第 30 行「主題包、欄位、分級、擁有者以 DC 為準」（第一批已回報）：這一批的「分區標示」也在平台的目錄。
- `rules.md`「不做的事」第二條「L1、L2 不走申請」：欄位在測試區降到 L1、L2 時，那一區自動給、從申請移除（照 DA-TIER-AUTO-GRANT），但正式區的同一欄仍要申請。條文沒有區的概念，請負責人確認這個解讀。
- `rules.md`「申請單不記錄媒介」：環境不是媒介（D93 (6)），已照 D93 做；條文要補一句。

## 4. 威脅小表

每列的「測試」在拿掉那道防線時會失敗。

| 新機制 | 誰能寫它 | 能否回捲 | 空值、零筆、極大值 | 舊但仍有效的輸入 | 它停掉時誰知道 | 測試 |
|---|---|---|---|---|---|---|
| 內容的 `environment` | 只有整理內容的 hook（代碼表的值；不認得就是錯誤，不能送審） | 換區＝擴大，從第一關重簽 | 沒有＝測試區並提示；不是字串＝錯誤 | 舊單沒有：雜湊不重算、視為正式區 | — | `75` DA-ENV-FIELD（兩個） |
| 分區標示 `catalog_field_environment` | 只有 `catalog_load`（種子、migration）；分級必須比正式區低 | 每次載入產生目錄版本（只增不改，第一批） | 沒有標示＝同級 | 舊版本的快照沒有這個鍵：引用摘要相同（正式區的單不受影響） | 同步執行 | `75` DA-ENV-TIER；`60` DA-CATALOG-VERSION |
| 交付結果的區 `check_delivery_zoned` | 只採信外部系統的證明（交付程式改不了） | — | 沒回報＝不接受 | 舊單的規則沒有區：期待 `prod` | 一直不接受→例外＋撤回（既有） | `75` DA-ENV-MISMATCH |
| 反例 `request:other_environment` | 流程包依代碼表產生 | — | 只有一個啟用的區時不產生 | 舊單：查詢不帶區（正式區），反例查測試區 | 驗證不通過（既有） | `75` DA-ENV-VERIFY；`50` DA-VERIFY-CASES |
| 重疊、對帳分區 | 流程包 | — | 回報沒有區＝正式區 | — | 對帳 `K-RECON-OVERDUE`（既有） | `75` DA-ENV-OVERLAP |
| 送審複核 `review_submission`（K-SUBMIT-REVIEW） | 核心在送審的交易裡呼叫；應用角色碰不到流程包 schema | 送審失敗整個交易回滾 | 引用的單不存在、不是測試區、沒生效過、別人的、不涵蓋→各自的錯誤 | 舊單不追加 | 同步 | `75` DA-ENV-TEST-BASIS、K-SUBMIT-REVIEW |
| 沒有測試紀錄的例外 | 送審後由核心開（同單同規則未結案不重開） | 不能（例外只增不改，既有） | 空白理由＝沒有理由，不能送審 | — | 簽核人在決定畫面看到 | `75` DA-TEST-EXCEPTION |
| 依環境的期限上限 | 參數（只增不改，既有） | — | 0 個月＝什麼都不能送 | — | — | `75` DA-ENV-VALIDITY |
| 使用摘要 `/2`（K-USAGE-DETAIL） | 只有對帳程式交；只採信外部系統的證明（第一批） | 不能 | 逐欄負數、非整數、時段外、版本識別空字串或超過 128 字→整批不收 | `/1` 照收，三樣是空的；區要和送出的規則相同 | `K-USAGE-OVERDUE`（既有） | `75` K-USAGE-DETAIL |
| 內容的 `test_report` | 只有整理內容的 hook（輸入帶的被換掉） | 依據或使用紀錄變了→送審時擋下 | 來源單沒有使用紀錄→次數 0、警示「測試量低」 | — | — | `80` DA-TEST-REPORT |
| 快照 `test_report_snapshot`、使用報告 `usage_report` | 送審複核、申請人的動作（`api`，別人 403） | 不能：擋 `UPDATE`、`DELETE`、`TRUNCATE` | — | 同一版再送審不重寫 | — | `80` DA-TEST-REPORT、DA-TEST-REPORT-FOLLOWUP |
| 警示 | 流程包從報告算 | — | 門檻是參數（依級別） | — | — | `80` DA-TEST-REPORT-WARN |
| 版本識別 | 使用方系統的摘要（證明涵蓋）；沒有才用申請人填的 | — | 都沒有＝不比 | — | — | `80` DA-TEST-VERSION |
| 生效後的後續（K-GRANT-FOLLOWUP） | 核心在建立授權的交易裡呼叫流程包 | — | 0 個工作天＝立刻逾期 | — | 逾期：排程升級一次並通知（既有 K-EXCEPTION-FOLLOWUP） | `80` DA-TEST-REPORT-FOLLOWUP K-GRANT-FOLLOWUP |

### 4.1 自認未解

- 使用方系統自己說謊（回報的區、逐欄次數、版本識別）：證明只防網路與平台的程式（06 §3）。版本識別尤其容易：使用方的前端帶什麼就是什麼。
- 人工交付的受管系統（`hr_saas`）沒有已簽的結果，沒有「套用到哪一區」的證明；由系統管理人標記。
- 對帳：同一個被授權者在兩區都有「沒有規則」的多餘權限（只有後門做得出來）時，兩項的比對鍵相同，可能只開一筆。
- 新的輸入沒有環境時預設測試區：攻擊者省略環境只會拿到測試區（較低的分級、較短的期限），不會拿到正式區。但測試區的分級較低，前提是使用方真的照標示遮罩了資料（06 9.5），平台驗不到資料內容。
- 測試報告的「沒用到」以時段摘要為準：使用方沒有回報（或通道從來沒交過摘要）時，報告寫「使用方沒有回報」並警示，但不擋送審。
- 代碼表與信封都叫 `environment`：信封與證明的 `environment`（`sim_dc`）是交付的目標環境，內容與規則的 `environment`（`test`、`prod`）是資料在哪一區。同名不同義是既有的命名，要改需要動 02 §8.8 與 sim/dc 的信封，留給下一位決定。

## 5. 需要負責人寫進 rules.md 的條文草稿

放在「需求單」的欄位表之後（新增「環境」一節）與「時間規則」：

> **環境**
> - 申請的資料分測試區與正式區。環境是申請單的必填欄位，一張單只有一個環境；測試區的核准不能拿到正式區用，升到正式區是另一張單。環境是「哪一份資料」，不是媒介。
> - 級別由資料目錄逐欄、逐環境決定：測試區預設與正式區同級；目錄標示該欄在測試區已去識別或遮罩時，才用那一區的分級。申請人不能自稱。
> - 交付的規則帶環境；使用方系統證明套用到哪一區，和規則不同就不生效。自動驗證另外確認同一份規則在另一區查不到。重疊、對帳與使用紀錄都分區。
> - 正式區的單必須引用一張涵蓋它的測試區單（同一位申請人或同一個被授權者、主題包與欄位涵蓋、列條件不比它窄、曾經生效）。沒有時要填理由，送出後開例外，簽核人看得到；核准生效後，申請人要在期限內補上線後的使用報告，逾期升級，不撤銷。
>
> **測試報告**
> - 正式區的單引用測試區單時，系統從那張單的使用紀錄產生測試報告，送出時凍結，簽核人簽的內容包含它。報告列出：測試了什麼、實際用了什麼（逐欄次數與最後使用時間）、沒用到的欄位、被擋下的嘗試、與這次申請的差異、應用面（申請人填：程式或報表與版本、結果給誰看、每欄用途）、紀錄完整性。
> - 系統自動標警示：有沒測過的欄位、沒用到的欄位仍在申請裡、測試期間有被擋下的嘗試、測試量低於門檻。
> - 應用面的版本以使用方系統回報的為準，沒有才用申請人填的；版本和測試時不同時，L4 要重新測試，L3 提示。
>
> **預設時限（加兩列）**：測試區授權上限 3 個月；沒有測試紀錄上線後補使用報告 20 個工作天。測試量門檻 L3 10 次、L4 20 次。

規則代碼（`sgn.rule`）：DA-ENV-FIELD、DA-ENV-TIER、DA-ENV-MISMATCH、DA-ENV-VERIFY、DA-ENV-OVERLAP、DA-ENV-TEST-BASIS、DA-TEST-EXCEPTION、DA-ENV-VALIDITY、DA-TEST-REPORT、DA-TEST-REPORT-WARN、DA-TEST-VERSION、DA-TEST-REPORT-FOLLOWUP；核心 K-SUBMIT-REVIEW、K-USAGE-DETAIL、K-GRANT-FOLLOWUP。

## 6. 驗證結果

2026-11-21，停掉背景程式、`rm -rf .run` 之後以 root 跑 `tools/check.sh`：**全部通過**——資料庫測試 320（原 305；新增 `75-environment` 11 個、`80-test-report` 4 個）、通行金鑰對照 16、端對端 38（原 35；新增 `system-zone` 3 個）、規則代碼 135（原 120；新增 15 個，每個都有測試）、sim/dc 95（原 89；新增 `13-environment` 6 個）。

之後 `tools/run-all.sh --keep`（同樣全部通過：320／16／38），`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` 依序跑 `redteam/exploits/[0-9][0-9]-*.mjs`（跳過 `00-*`，57 支）：**34、40、57 回 1，其餘 54 支回 0**，和這一批之前相同。沒有修改 `redteam/`。

為了新規則改動的既有測試（不是放寬）：
- `db/tests/packs/data_access/lib.mjs`：`terms()` 的預設授權期間 5 個月改 2 個月（測試區上限 3 個月）；`l3Content`、`l4Content` 明寫 `environment: 'test'`；新增 `prod()`、`application()`。紅隊腳本 import 這個檔案，所以它們送的單也是測試區、2 個月。
- `20-flow`：依級別的上限測試改用正式區（`prod()`）；其他明寫 3–5 個月的改 2 個月以內。`30-display` 縮小後的期間改 1 個月。
- `50-delivery`：驗證案例多了 `request:other_environment`；模擬的對帳回報帶 `environment`（使用方的義務 06 3.4）；聯集判斷的查詢帶區。
- `60-catalog-version`：測試向量更新；舊單模擬結束後換回目前登記的 hook（原本寫死第一批的名稱）；送審時帶 `catalog` 鍵的那一張明寫測試區。
- `70-usage`：批次格式 `/2`、每筆帶區。`90-architecture`：hook 十六個、新的路由。
- `e2e`：`path` 的授權期間改 2 個月以內；`system-delivery`、`system-loop` 對 sim/dc 的查詢帶 `environment: 'test'`；`lib/ui.mjs` 的 `fillApplication` 多了環境、依據、理由、應用面。
- `sim/dc/tests`：套用結果多 `environment`、對帳的限制條件多 `environment`、使用摘要格式 `/2`。

## 7. 留給下一位

- C 的六個畫面問題都沒做：稽核證據頁的「nullnull」（這一批在 40 張單的證據頁、稽核首頁的文字裡沒有找到，需要重現的步驟）、稽核人員首頁重點的排列與待簽清單的排序、例外清單的重複與分組、縮小／撤銷面板對申請人自己操作時的文案、每開新申請就多一張刪不掉的草稿與單號跳號、重疊提示沒寫出重疊的欄位。依任務，排序、分組、可否捨棄都要放資料庫 function。
- 報告的「列條件實際範圍」：要先擴充使用方義務（每次使用的列條件值範圍或命中的列數）與摘要格式。
- D94 (5)：正式區生效後持續比對、沒用到的欄位提醒縮小；續期與定期複查用 `test_report`／`reportView`。
- 被授權者的負責人也能產生上線後使用報告：需要核心給流程包讀被授權者負責人的入口（`sgn_sdk`）。
- `environment` 同名不同義（§4.1 最後一點）。
- 測試區的單變成正式區的依據之後，如果測試區的單被撤銷或縮小，正式區的單不受影響（依據是送審當時的快照）；要不要連動由負責人決定。
- 這一批與第一批都還沒經紅隊攻擊（D95 說第二批一起打）。
