# 交接：核准內容 → 使用方系統的閉環，第一批（closed-loop-1）

依據：`docs/decision-log.md` D91、D92；設計 `docs/contract/pending-amendments.md` 的 D91-a、D91-c；使用方義務 `docs/contract/06-consumer-obligations.md`。D92 與增修不同時以 D92 為準。

## 1. 做了什麼

| 項目 | 狀態 | 實作 | 測試 |
|---|---|---|---|
| 1. 資料目錄版本綁定（D92 (1)、(6)） | 完成 | `db/packs/data_access/130_catalog_version.sql`；核心通用部分 `db/kernel/540_closed_loop.sql`；種子加上「代碼 → 實體資源」的對照；`sim/dc/src/catalogVersion.ts` | `db/tests/packs/data_access/60-catalog-version.test.mjs`（10 個）、`93` 合約一個、`sim/dc/tests/11-catalog-version.test.ts`、`e2e/tests/system-loop.test.mjs` |
| 2. 使用方系統的能力宣告（D92 (5)） | 完成（使用方自己的能力查詢沒做） | `db/packs/data_access/140_capability.sql`；種子 `db/seed/packs/data_access/020_capability.sql` | `65-capability.test.mjs`（4 個）、`e2e` |
| 3. 使用紀錄的批次摘要（D92 (4)） | 完成 | `db/kernel/545_usage_summary.sql`；`api/src/reconciler.ts`、`dcHttp.ts`、`dcMock.ts`；`sim/dc/src/usage.ts`；畫面 `web/pages/case.js`、`audit.js` | `70-usage.test.mjs`（4 個）、`sim/dc/tests/12-usage.test.ts`、`e2e` |
| 4. 文件 | 完成 | 02 §8.1、§8.5（標示已取代）、§8.6–§8.9；`sim/dc/README.md` 改成引用；06 的 2.10、6.1–6.3、9.1–9.4 改為已實作並填測試 | — |

### 1.1 目錄版本

- 快照（只含啟用項目、依代碼排序）的 RFC 8785 SHA-256 就是版本的雜湊；涵蓋主題包、欄位、分級、列條件、列舉值與每一層的 `resource`（實體資源）。`catalog_load` 每次套用後比較，不同才產生新版本（`pack_data_access.catalog_version`，只增不改，進鏈）。平台與 sim/dc 第一次就算出相同的雜湊（`8880fedf…`），共用的測試向量在 `db/tests/packs/data_access/fixtures/catalog-vectors.json`。
- 綁定：整理內容的 hook 換成包裝（`normalize_bound` → `normalize_capable`），內容多一個 `catalog: {version_no, sha256}`；版本雜湊的公式沒變，所以自動涵蓋。顯示摘要多一行「資料目錄第 N 版（雜湊前 12 碼）」，瀏覽器簽的是整份顯示摘要，所以 `web/lib/signing.js` 不用改；測試以鏈上記下的要簽內容和 `decisionContent` 逐位元組比對（核准、縮小後核准）。比較內容的 hook 忽略 `catalog`（與 `capability_gaps`）。
- 舊單：沒有 `catalog` 鍵的內容不重算、顯示摘要不多這一行（照樣能簽，測試有）；升版時對未結束的單記事後基準 `catalog_baseline`，交付時帶基準的版本。
- 交付：規則多 `catalog`；sim/dc 與 mock 在已簽的結果裡回報 `catalog_sha256`。核心新的 hook `check_delivery_result`（在證明驗過、判定成功之後）由流程包比對「這張單引用的部分」在兩個版本上是否相同：不同 → 視同拒絕（不生效、撤回、開 `DA-CATALOG-MISMATCH`）；平台不認得 → 寬限內重送、逾時 `DA-CATALOG-UNKNOWN`。對帳回報經另一個新 hook `check_reconciliation_report` 逐張比對。
- 目錄改版：簽核中的單重新整理成新的一版、從第一關重簽（核心 `case_rebind`，`K-CONTENT-REBIND`；整理後有錯就退回申請人）；已核准的單開 `DA-CATALOG-DRIFT` 通知資料擁有者；只改名稱時帶期限，資料擁有者在首頁確認（`api.data_access_catalog_confirm`），逾期由排程升級（核心 `K-EXCEPTION-FOLLOWUP`，`api_job.exception_followup_due`），不撤銷。
- 順帶修的核心缺陷：`sgn.case_task` 的檢查「未認領 ⇔ 沒有指派對象」讓 `stages_close_open` 在群組認領關還沒有人認領時一定失敗（作廢的工作沒有指派對象）。重新綁定第一次碰到；撤回到 MIS 認領關也會。540 改成「未認領一定沒有指派、等人決定與已決定一定有、作廢兩者都可以」，回歸測試 `K-CONTENT-REBIND 停在群組認領關…`。

### 1.2 能力宣告

- 放在既有的受管系統登記處：依 `system:<代碼>` 設定的參數 `data_access.capability.{column,row,data_period,export,usage_log}`（和 `delivery.mode` 同一種範圍），預設 false。示範種子：dc 與 hr_saas 全部 true。
- 整理內容時：匯出做不到 → 關閉可否匯出並提示（rules.md「若 DC 無法區分，這個欄位就關閉」）；其他做不到的 → 內容的 `capability_gaps`（進版本雜湊與顯示摘要），依 `data_access.capability_gap_action`（L3 `warn`、L4 `block`）提示或擋下送審。
- 驗證：做不到的限制的反例帶 `skip`，核心不送也不比對（`K-VERIFY-SKIPPED`），記在 `verification_run.skipped` 與鏈上，畫面顯示「沒有驗證」。

### 1.3 使用紀錄

- 核心（與流程包無關）：`api_job.usage_submit`（只有對帳程式的角色能執行），只採信外部系統的證明（405 的 `attestation_open`，路徑 `/usage-summaries`），簽發時間嚴格遞增、新鮮度、只收一次、筆數與次數上限、每一筆都要對得到這個通道交付過的單；整批的雜湊一筆稽核事件，摘要只增不改。同一個鍵以最新的一批為準。
- 對帳程式每一輪對帳之後拉一批（同一個 port，`fetchUsage`），心跳沿用 `reconciler_heartbeat`；路由表 `reconcilerCalls.usageSubmit`、`schedulerCalls.usageChecks`、`schedulerCalls.exceptionFollowupDue` 是允許清單的唯一來源（`db/tools/grants-sql.mjs` 產生授權，`12-grants` 比對）。
- 畫面：單的頁面「使用情形」（最後使用時間、近 `usage.recent_days` 天的查詢、匯出、被擋次數與人數）、稽核證據頁同一份。生效超過 `usage.idle_alert_days` 天沒有任何查詢或匯出（只看回報過使用摘要的通道）→ `K-USAGE-IDLE` 通知申請人與被授權者負責人，不撤銷；回報過的通道超過 `usage.max_interval_seconds` 沒有新的一批 → `K-USAGE-OVERDUE`。
- sim/dc：`POST {base}/use`（admin 金鑰扮演使用方系統的前端）真的以被授權者的身分查資料庫並記下；`GET {base}/usage-summaries` 依時段彙總。

## 2. 怎麼執行

```bash
tools/check.sh                      # 全部（最後跑 tools/run-all.sh）
db/build.sh                         # 只建庫＋資料庫測試
sim/dc/test.sh tests/11-catalog-version.test.ts tests/12-usage.test.ts
tools/run-all.sh --keep             # 起系統；首頁（資料擁有者）會出現「等你確認的資料目錄異動」
```

驗證結果（2026-11-21，停掉背景程式、清掉 `.run` 之後）：`tools/check.sh` 全部通過——資料庫測試 305（原 285）、通行金鑰對照 16、端對端 35（原 32）、規則代碼 120（原 101）、sim/dc 89。之後 `tools/run-all.sh --keep` 起系統，`redteam/exploits/[0-9][0-9]-*.mjs`（跳過 `00-*`）：34、40、57 回 1，其餘回 0，和這一批之前相同。

其他順帶的改動：`web/verify.js`（稽核頁的鏈上驗證）把 `case.rebound` 算成一個內容版本（沒改時稽核頁會判「目前的內容不是鏈上記下的最新一版」，`z-anchor-store` 抓到）；端對端的 `signer`（放回前面測試檔登記的金鑰）從 `system-delivery.test.mjs` 移到 `e2e/tests/lib/ui.mjs` 共用；sim/dc 的 `/use` 和驗證一樣在沒有對應資料列時插入測試列（模擬資料只到 2027 年）。

### 2.1 新畫面動作在 390px 寬的步數（`e2e/tests/system-loop.test.mjs` 量的）

| 動作 | 步數 | 步驟 |
|---|---|---|
| 資料擁有者確認目錄只改名稱 | 2 | 打開首頁 → 按「意義沒變，確認」 |
| 看一張單的使用情形 | 1（從單的頁面） | 單的頁面「使用情形」一段直接顯示 |
| 簽核人看到能力落差與目錄版本 | 0（決定畫面本身） | 決定畫面「要使用的資料」裡直接顯示 |

## 3. 與 D91、D92、增修不同的地方與理由

| # | 不同 | 理由 |
|---|---|---|
| 1 | 雜湊涵蓋「代碼 → 實體資源」的對照，對照存在平台的目錄（`resource` 欄）；D91-a 的雜湊範圍沒有對照，並假設版本由 DC 匯出 | D92 (1)：目錄由平台維護、平台算版本；任務要求涵蓋對照 |
| 2 | `catalog_sha256` 不是唯一：改回原樣也產生新的序號（雜湊相同） | 序號只增，「目前版本」永遠是最新一列；回報的雜湊對到最新的那一版（快照相同） |
| 3 | 簽核中的單只要引用的部分有變就從第一關重簽（包含「項目被停用」）；D91-a 停用算縮小、從目前關卡繼續 | 一律從嚴；縮小的判定要另寫一套比較，留給下一位 |
| 4 | 待套用、驗證中的單只開 `DA-CATALOG-DRIFT`，不作廢交付、不回到簽核中；D91-a 要作廢並回到簽核 | 交付結果的比對（`DA-CATALOG-MISMATCH`）已經擋住「使用方用了不同的對照」；作廢交付要動核心的交付狀態機，風險大 |
| 5 | 只改名稱的確認不產生新的內容版本、不重送；改記確認紀錄（`catalog_ack`），之後綁定的版本與確認過的版本都接受 | D92 (6) 只要求限期確認、逾期升級不撤銷；重送會讓生效中的授權在使用方系統上短暫重算 |
| 6 | 能力是五項（欄、列、資料期間、匯出、使用紀錄），沒有 D91-c 的「有效期間」 | 依任務的五項 |
| 7 | 能力落差的動作 L4 預設 `block`；D91-c 預設 `warn` 並待裁決 | D92 (5)：L4 預設擋下、L3 提示 |
| 8 | 「使用紀錄」做不到也算落差（L4 因此會被擋） | 一律從嚴；示範環境兩個系統都宣告做得到，不影響既有流程 |
| 9 | 使用方系統自己的能力查詢（`GET /capabilities`）與 `DA-CAPABILITY-MISMATCH` 沒做 | 任務沒有要求；宣告只在平台 |
| 10 | 使用紀錄在核心（`K-USAGE-*`），不是 05 §5.7 的逐筆回報 | D92 (4)：批次摘要、整批雜湊進鏈 |
| 11 | `DA-E-CATALOG-HASH`（匯入的快照自帶雜湊）沒做；`DA-CATALOG-UNKNOWN` 不觸發目錄同步 | 平台維護目錄，沒有從使用方同步的入口 |
| 12 | hr_saas 在示範種子宣告全部做得到 | D91-c 的負責人說明「現有的系統都做得到」；否則既有的 L4 薪資測試全部被擋 |
| 13 | 通知範本用新的 `data_access.catalog_drift`，不是 02 §7.6 的 `catalog_sync_impact` | 沒有同步，事件不同 |

### 3.1 和 `rules.md` 的矛盾（沒有修改 rules.md，回報負責人）

- `rules.md` 第 30 行「本站管決策和證據，DC 管執行和資料目錄……主題包、欄位、分級、擁有者以 DC 為準」，與 D92 的事實「資料目錄由簽核平台維護」矛盾。這一批的機制（版本、綁定、比對）不決定誰維護目錄，只要求兩邊一致才生效，所以沒有停下；但 rules.md 這一句要由負責人改。
- D91-a 已指出的缺漏仍在：目錄只改名稱、項目停用時生效中的單怎麼處理，rules.md 沒有規定（這一批依 D92 (6) 做）。

## 4. 威脅小表

每列的「測試」在拿掉那道防線時會失敗。

| 新機制 | 誰能寫它 | 能否回捲 | 空值、零筆、極大值 | 舊但仍有效的輸入 | 它停掉時誰知道 | 測試 |
|---|---|---|---|---|---|---|
| 目錄版本 `catalog_version` | 只有資料庫擁有者（`catalog_load`，種子／migration）；應用角色碰不到流程包 schema（`90-architecture`） | 不能：擋 `UPDATE`、`DELETE`、`TRUNCATE`；改回原樣是新的序號 | 空目錄不產生版本；`resource` 是 null 也算進雜湊 | 使用方回報舊版本：只在引用的部分相同時接受 | 同步執行，沒有背景程式 | `60` DA-CATALOG-VERSION |
| 內容綁定 `content.catalog` | 只有整理內容的 hook（輸入的 `catalog` 鍵被丟掉、重新填）；進版本雜湊與顯示摘要 | 換版本＝新的內容版本，之前的簽核對不上 | 沒有版本時是 null（交付時 `DA-E-CATALOG-VERSION-MISSING` 擋下） | 舊單沒有這個鍵：雜湊不重算，以事後基準比對 | — | `60` DA-CATALOG-BOUND（兩個） |
| 交付結果的目錄比對 `check_delivery_result` | 結果只採信外部系統的證明（交付程式改不了） | — | 沒回報或 null＝不認得：寬限內重送，逾時不生效 | 認得的舊版本：引用部分相同才接受 | 一直重送→`K-DELIVERY-STUCK`（既有） | `60` DA-CATALOG-MISMATCH、DA-CATALOG-UNKNOWN |
| 對帳回報的目錄比對 `check_reconciliation_report` | 同對帳（證明、嚴格遞增） | — | 不認得：每個通道一筆、寬限後才開 | 同上 | `K-RECON-OVERDUE`（既有） | `60` DA-CATALOG-MISMATCH K-RECON-REPORT-CHECK、DA-CATALOG-UNKNOWN |
| 重新綁定 `case_rebind` | 只由流程包在目錄改版的交易裡呼叫（資料庫擁有者） | — | 整理後沒有可申請的內容→退回申請人 | 改版前發的挑戰值對不上新的一版 | 同步 | `60` DA-CATALOG-DRIFT K-CONTENT-REBIND、K-CONTENT-REBIND（群組認領關） |
| 只改名稱的確認 `catalog_ack` | 受影響主題包目前的資料擁有者（別人 403）；只增不改 | 不能；同一筆再確認→找不到 | 0 個工作天＝立刻逾期 | — | 逾期：排程升級一次並通知 | `60` DA-CATALOG-RENAME-CONFIRM K-EXCEPTION-FOLLOWUP |
| 能力宣告 `data_access.capability.*` | 只有 migration 與種子（參數值沒有對外的寫入口） | 參數只增不改（既有） | 沒有宣告＝做不到 | — | — | `65` DA-CAPABILITY-DECLARE |
| 能力落差進簽的內容 | 整理內容的 hook | 換宣告後要重新整理（新版本） | L4 擋下、L3 提示（參數） | — | — | `65` DA-CAPABILITY-GAP（兩個）、`e2e` |
| 不驗的驗證案例 `skip` | 流程包依宣告決定；外部系統不能要求不驗 | — | 全部都不驗時沒有案例→核心判定不通過（既有 `no_cases`） | — | 記在驗證紀錄與鏈上 | `65` DA-CAPABILITY-VERIFY K-VERIFY-SKIPPED |
| 使用摘要 `usage_batch`、`usage_summary` | 只有對帳程式的角色能交（`12-grants`）；內容只採信外部系統的證明 | 不能：只增不改；舊的一批（簽發時間不新）不收 | 零筆的一批照收；筆數、次數有上限；負數、非整數、時段錯不收 | 同一批重送不收；同一個鍵以最新的一批為準 | 對帳程式停：`K-PROGRAM-STALLED`（既有心跳）；外部系統不交：`K-USAGE-OVERDUE` | `70` K-USAGE-ATTESTED K-USAGE-BATCH-AUDIT、K-USAGE-UNVERIFIED、K-USAGE-OVERDUE |
| 閒置提醒 | 排程與每次收批 | — | 天數是參數 | 有使用就結案 | 排程停：`K-PROGRAM-STALLED` | `70` K-USAGE-IDLE |

### 4.1 自認未解

- 使用方系統自己說謊（回報平台的雜湊卻用不同的對照、灌水或少報使用次數）：證明只防網路與平台的程式，不防使用方本身（06 §3）。
- 只改名稱的確認不需要通行金鑰（不是決定證明）：拿到後端與資料擁有者工作階段的人可以代為確認。確認只讓「改名稱前後兩個版本都接受」，不擴大權限。
- 目錄改版時若某一張簽核中的單重新解析簽核人失敗，整個 `catalog_load` 失敗（從嚴：目錄不會在沒有處理受影響的單時改版），要人處理那張單。
- `DA-CATALOG-UNKNOWN` 的寬限從交付建立的時間算：在佇列裡等很久的交付寬限較短。
- 使用紀錄把被擋下的查詢記到這個被授權者在這個主題包上的每一張單（模擬器的做法；實際系統可以更精確）。
- 生效中的單因分級調高或項目停用而改版，只開例外；`K-REAPPROVE` 與系統縮小沒做。

## 5. 留給下一位

- D91-b（團隊對應目錄群組）沒做。
- 使用方的能力查詢與 `DA-CAPABILITY-MISMATCH`；能力宣告的變更入口（骨幹 18.3 的設定變更，false 改 true 要覆核）。
- 待套用、驗證中的單在目錄改版時作廢交付、回到簽核中（D91-a）；停用項目算縮小。
- 證據頁標示「目錄版本為事後記錄，不在簽核內容內」（舊單的基準）；目前只有資料庫有基準紀錄。
- `pending-amendments.md` 的 D91-a、D91-c 已併入 02 §8.6–§8.8 的部分可以刪除；其餘（§4.2 的 `impacts`、§5.x 的文字）還沒併。
- rules.md 第 30 行要由負責人改（§3.1）。
