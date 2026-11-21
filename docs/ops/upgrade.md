# 升級與回退

結論：

- **目前沒有「對既有資料庫套用新 migration」的工具。** `db/build.sh` 每次都刪掉資料庫、從 `01_core.sql` 依序套用全部 migration；沒有「已套用到哪一支」的紀錄表。工程規範規定「已套用到任何環境的 migration 不得修改，只能新增」，但不刪資料的升級程序程式裡沒有，需要補（gaps G-01）。
- **每次升級都會讓錨定停住**：程式指紋（`api_job.code_fingerprint`，涵蓋自家 schema 的 function、trigger 與權限）一改，錨定程式回 `CODE_CHANGED` 並拒絕寫錨點（`db/tools/chain-lib.mjs` 的 `anchorOnce` 註解：「要由人確認後另行處理；探針沒有做這個流程」）。沒有「確認這次指紋變更是核准的升級」的程序（gaps G-01b）。
- 下面寫的是「必須遵守的原則」與「升級前後一定要跑的檢查」（可執行），以及缺工具的步驟（標 **尚未實作**）。

## 1. 原則（來自工程規範與決定紀錄）

- migration 依模組切分，檔名帶版本序（`db/kernel/NNN_*.sql`、`db/packs/<流程包>/NNN_*.sql`），`db/build.sh` 的 `migration_files` 以 `sort -V` 排序：核心全部 → 各流程包。後面的檔案可以呼叫前面的，反過來不行。
- 已套用到任何環境的 migration **不得修改**，只能新增。改 function 的做法是新檔案裡 `create or replace function`（現有檔案都這樣做，例如 `515_exception_close.sql` 重新定義 `governance_key_check`）。
- 新增的 function 預設不對 PUBLIC 開放；執行權限只由路由表產生（`db/tools/grants-sql.mjs`）。新增 `api` function 一定要同時加進 `packages/contract/src/routes.ts`，否則契約測試失敗。
- 路徑（`sgn.approval_policy`）、規則代碼、錯誤代碼、通知範本、參數定義都只能經 migration 變更並留紀錄。
- 有些舊 migration 假設「全新建置」（例如 `110_rules.sql`：「這時還沒有任何例外紀錄引用規則代碼（全新建置），可以直接換」），**不能對既有資料庫重跑全部檔案**；只能套用新增的檔案。

## 2. 升級前檢查（**可執行，只在獨立的驗證主機**）

`tools/check.sh` 會重建資料庫，**絕不能在正式主機或別人正在用的主機上跑**。

1. 在驗證主機取得要升級的版本：`npm ci`（只有根目錄有 `package-lock.json`；`sim/dc` 自己有一份，`check.sh` 會一起檢查）。
2. 全部品質關卡：`tools/check.sh`。全部通過才繼續。它依序做：`npm ci`、Prettier、ESLint、`tsc`、shellcheck、plpgsql_check（`db/build.sh --plpgsql-check`）、禁止字串、追蹤檔案、`npm audit --audit-level=high`、`sim/dc` 的檢查，最後 `tools/run-all.sh`（建庫、資料庫測試、規則代碼覆蓋、通行金鑰對照、端對端）。
   - 尚未納入 `check.sh` 的工具（工程規範 §6 有列）：sqlfluff、knip、Trivy、hadolint、actionlint、產生檔無差異檢查（`tools/check.sh` 開頭註解、`docs/handoff/promote.md` §7）。`tools/install-dev-tools.sh` 會安裝其中幾個，但 `check.sh` 沒有呼叫（gaps G-13）。
3. 紅隊回歸：
   ```bash
   tools/run-all.sh --keep
   for f in redteam/exploits/*.mjs; do
       case "$f" in */00-*) continue ;; esac
       SGN_DATABASE=sgn_e2e PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node "$f"; echo "$f → $?"
   done
   ```
   （單支的跑法見 `docs/handoff/leftovers-1.md`、`redteam-fixes-3.md`；`00-*.mjs` 是共用函式庫不是攻擊。）判讀：0＝擋下；1＝成功或殘餘；2＝無法判定。以最近一輪（`redteam/findings-8.md`）為基準：34、40 回 1 是已接受的殘餘（D85、D86），57 回 1 是資訊項（D90 (2)）；**其餘任何一支不是 0 就不能升級**；回 2 不算通過（D85）。
   - 攻擊腳本會以 superuser 改時間、建刪角色、讀證據（`redteam/findings-8.md` 開頭），**只能對驗證環境跑**。
4. 比對新舊版的 migration 清單：新版只能多檔案，舊檔案一個字都不能變。
   ```bash
   git diff --name-status <目前上線的版本> <要升級的版本> -- db/kernel db/packs
   ```
   出現 `M`（修改）或 `D`（刪除）就退回給開發者。這個檢查目前沒有寫進 `check.sh`（gaps G-14）。

## 3. 正式升級步驟（**尚未實作，以下是必要順序；沒有工具可照做**）

1. 依 [backup-restore.md](backup-restore.md) 備份資料庫、錨點存放處與密鑰，記下目前的鏈頭與最後一個錨點。
2. 跑一次 `node db/tools/verify-chain.mjs <資料庫>`，結束碼 0 才繼續（升級前的鏈必須乾淨，否則升級後分不清是誰造成的）。
3. 停掉所有背景程式與 api（[programs.md](programs.md) §3）。
4. 只套用新增的 migration 檔（以 `sgn_owner`），再套用 `node db/tools/grants-sql.mjs` 產生的權限 SQL。**沒有工具**：需要一支「讀已套用清單、只套新檔、記錄」的升級程式（gaps G-01）。
5. 確認程式指紋的變更是這次升級造成的、並留紀錄（升級單號、新舊指紋、核准人）。**沒有工具**：錨定程式遇到 `CODE_CHANGED` 只會拒絕；要有「由人確認後，寫一個帶新指紋的錨點」的程序，且這個動作本身要進鏈（gaps G-01b）。
6. 啟動程式；`node db/tools/verify-chain.mjs <資料庫>` 回 0；稽核頁的背景程式全綠。
7. 升級後對**驗證環境**再跑一次 §2.3 的紅隊回歸（正式環境不跑攻擊腳本）。

## 4. 回退

migration 只增不改，所以**沒有 down migration**，回退的意思是：

- **程式碼的回退**（Node 程式、頁面）：換回上一版的檔案、重新啟動。前提是資料庫的 function 簽章沒有不相容的變更（後端依路由表呼叫 function，簽章不合會在啟動或第一次呼叫時失敗）。
- **資料庫的回退**：寫一支**新的** migration，把 function 以 `create or replace` 改回舊的定義。不要刪檔、不要改舊檔。這一樣會改程式指紋，走 §3 的第 5 步。
- **資料損壞時的回退**：從升級前的備份還原（backup-restore.md）。注意還原點早於最後一個錨點時錨定會卡住（backup-restore.md §4 的 `ANCHOR_BEYOND_HEAD`），所以升級前要先讓錨點追上，再備份。

## 5. 年度版本更新

| 項目 | 目前版本與鎖定的地方 | 上游支援期限（撰寫時的已知資訊，每年重查） | 做法 |
|---|---|---|---|
| Node.js | `.nvmrc`＝`22`；`package.json` `engines`＝`>=22.18.0 <23`；`.npmrc` `engine-strict=true` | Node 22 LTS 到 2027-04 | 程式直接以 `node` 執行 `.ts`（型別剝除，需要 22.18 以上），升主版本前要確認新版的行為。改 `.nvmrc` 與 `engines` 兩處，在驗證主機跑 §2 全部 |
| PostgreSQL | 16；寫死在 `db/build.sh`（`pg_ctlcluster 16 main`）與 `tools/install-dev-tools.sh`（`postgresql-16-plpgsql-check`） | 16 到 2028-11 | 主版本升級用 PostgreSQL 的 `pg_upgrade` 或匯出匯入，之後一定要跑 `verify-chain.mjs`。注意 `pg_get_functiondef` 的輸出若因新版改變，程式指紋也會變（`10_audit_chain.sql`），會觸發 `CODE_CHANGED`，要走 §3 第 5 步。版本號散在兩支腳本裡，要一起改（gaps G-15） |
| 資料庫擴充 | 只用 `pgcrypto`（工程規範 §4）；plpgsql_check 只在開發與 CI | 隨 PostgreSQL | — |
| npm 套件 | 根目錄 `package-lock.json`（`save-exact=true`）；`sim/dc` 另一份 | — | 每季看 `npm audit --audit-level=high --omit=optional`；有 high 以上就在驗證主機升級、`npm ci`、跑 §2 全部。新增套件要符合工程規範 §4 的門檻並寫進 handoff |
| 檢查工具 | `tools/install-dev-tools.sh`：Trivy 0.76.2、sqlfluff 3.4.2、actionlint-py 1.7.12.25、hadolint-bin 2.15.1 | — | 每年檢查新版；換版要改腳本裡的版本常數 |
| 瀏覽器（端對端） | Playwright 瀏覽器在 `/opt/pw-browsers`（`tools/run-all.sh`） | — | 隨 Playwright 版本 |

每次版本更新都要留紀錄：日期、項目、舊版→新版、`tools/check.sh` 結果、紅隊回歸結果、執行者、複核者。
