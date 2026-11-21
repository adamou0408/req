# 備份與還原

結論：

- **程式裡沒有備份程式、沒有排程、沒有還原工具。** 唯一碰過備份的是資料庫測試 `db/tests/kernel/60-chain.test.mjs`（`pg_dump --format=custom` → `pg_restore` 到新資料庫，再以驗證工具確認會被抓到 `ANCHOR_BEYOND_HEAD`）。契約 `docs/contract/00-spine.md` §14.3（還原偵測 `K-RESTORE-GAP`、`restore_pending`、每週自動還原驗證）標明「尚未實作」。
- **從較舊的備份還原之後，錨定會永久卡住**：存放處的錨點比資料庫新，錨定程式每輪回 `ANCHOR_BEYOND_HEAD`；等新事件把序號推過去後改成 `ANCHOR_MISMATCH`。存放處只收序號更大的錨點，程式裡沒有「承認還原缺口、重新起算」的程序（gaps G-01b、G-03）。
- 因此本文件是**還原時要照的順序與驗證方法**，大部分步驟 **尚未實際演練過**；每一步都標出來。

## 1. 要備份什麼

| 項目 | 在哪裡 | 為什麼要 | 敏感度 | 和誰分開放 |
|---|---|---|---|---|
| 平台資料庫（`sgn_e2e`；正式環境的名稱尚未定） | PostgreSQL 16 叢集 | 全部業務資料與稽核鏈（`sgn.audit_event`、`sgn.audit_chain_head`） | **極高**：裡面有交付簽章的私鑰種子（`sgn.signing_key.seed`，Ed25519，`db/kernel/410_delivery.sql`）。拿到備份＝能以平台名義對外部系統簽交付 | 和錨點存放處分開 |
| 叢集層級的角色 | PostgreSQL（`pg_dump` 不含角色） | 還原需要 `sgn_owner` 與各登入角色存在，權限才掛得回去 | 中（密碼另存） | — |
| 錨點存放處的資料檔 | `.run/anchors-<資料庫>.jsonl`（擁有者 `sgn-anchor-store`） | 證明資料庫沒被改寫的外部依據 | 中（不含業務內容，只有序號、雜湊、程式指紋） | **必須和資料庫備份分開保管、分開權限**；放在一起等於讓能改資料庫備份的人也能改錨點（D81「兩道防線共用同一處就只是一道」） |
| 各程式的密鑰檔 | `.run/secrets/<程式>.env`、`.run/secrets/roles.env` | 角色密碼、錨點寫入金鑰、外部系統金鑰、身分提供者 client secret | **極高** | 和資料庫備份分開；見 [key-rotation.md](key-rotation.md) |
| 外部系統（模擬）的金鑰 | `sim/.run/dc/keys/`（正式環境屬於外部系統自己） | 回應證明私鑰、信任清單 | 高 | 正式環境不由平台備份 |
| 非機密設定 | `db/sgn.env`、`db/admin.env`、`sim/*/service.env` | 在 git 裡 | 低 | 以 git 為準 |

不需要備份：`.run/*.log`（log；但事故調查期間要保留）、`.run/passkeys-*.json`、`.run/registrar-*.json`（開發環境的軟體金鑰，正式環境不應存在）。

## 2. 怎麼備份（建議做法，**尚未實作、尚未演練**）

repo 裡沒有可照抄的備份腳本。以下是依現有工具（PostgreSQL 16 內建）的建議，實作前要經資安長與稽核主管核定並補進 `tools/`：

1. 資料庫：以 WAL 歸檔做時間點還原（PITR），讓還原點可以選到「最後一個錨點之後」。只用每日 `pg_dump` 時，還原後一定落後錨點（必然觸發 §1 結論的卡住）。
2. 每日另做一份 `pg_dump --format=custom`（與 `60-chain.test.mjs` 相同格式）供邏輯還原與演練，加密後存放；權限只給 root（架構測試 `97-program-reach.test.mjs` 斷言整庫備份只有 root 讀得到）。
3. 角色：另存叢集層級的角色定義（不含密碼）。
4. 錨點存放處：另一套排程、另一個帳號、另一個儲存位置複製 `.jsonl`，只增不改。
5. 密鑰檔：不和資料庫備份放在一起；依 key-rotation.md 的保管方式。

## 3. 還原步驟（**尚未實際演練過**）

前提：還原在**另一台**主機或另一個資料庫名稱上先做，驗證過再切換。下面的 `<還原庫>` 是新的資料庫名稱。

1. **停止寫入**：停掉所有背景程式與 api（[programs.md](programs.md) §3「全部停掉」）。理由：避免還原期間有新事件寫進舊庫。
2. **保全現場**：把目前的資料庫（若還在）、錨點檔、`.run/*.log` 各複製一份唯讀保存，供事後調查。
3. **建立資料庫並還原**（以 root 經管理者連線；指令與 `60-chain.test.mjs` 相同）：
   ```bash
   source db/sgn.env; source db/admin.env
   psql -X "${SGN_PG_ADMIN_URL%/*}/postgres" -c "create database \"<還原庫>\" owner \"$SGN_ROLE_OWNER\""
   pg_restore --dbname "${SGN_PG_ADMIN_URL%/*}/<還原庫>" <備份檔>
   ```
   角色必須先存在（`sgn_owner` 與 `db/sgn.env` 列的各角色）。**`db/build.sh` 不能用來建角色**：它會刪掉所有平台資料庫（含 `sgn_e2e`）並換掉所有角色密碼。只建角色、不刪資料庫的工具程式裡沒有，需要補（gaps G-01）。
4. **授連線權限**：`build_schema` 對資料庫做的 `revoke all on database ... from public` 與 `grant connect ... to <各角色>` 是資料庫層級的設定，`pg_restore` 不一定還原它們；照 `db/build.sh` 的 `build_schema` 那兩行重做。
5. **驗證稽核鏈與錨點**（§4）。
6. **只有 §4 結果是「一致」時**才把程式指向還原庫並啟動。程式連哪個庫由環境變數 `SGN_DATABASE` 決定（`run-all.sh` 傳 `SGN_DB_E2E`）；錨點存放處的資料檔名綁在 `SGN_DB_E2E`（`anchor-store.mjs`、`provision-secrets.mjs`），換庫名就要同時處理存放處的檔名——程式裡沒有改名的程序。
7. **記錄**：依 §6 格式填演練或事故紀錄；請稽核主管複核。

## 4. 還原後怎麼驗證稽核鏈與錨點一致（**可執行**）

```bash
node db/tools/verify-chain.mjs <還原庫>
```

工具從創世重算整條鏈、比對鏈頭、向錨點存放處（`SGN_ANCHOR_ORIGIN`）取錨點逐一比對、檢查程式指紋，並判斷落後。結束碼 0＝一致；2＝有問題（JSON 列出 `problems`）。判讀：

| `problems[].type` | 意思 | 還原後該怎麼辦 |
|---|---|---|
| （空，`ok: true`） | 鏈完整，所有錨點都對得上，而且沒有落後超過門檻 | 可以切換 |
| `ANCHOR_BEYOND_HEAD` | 存放處有比資料庫鏈頭還新的錨點：**還原點早於最後一個錨點**，那一段事件遺失 | 不要啟動。改用更新的還原點（PITR 推到 `anchor_seq` 以後）。沒有更新的備份時，這是資料遺失事故：通報資安長與稽核主管，遺失的序號區間由存放處的錨點證明；**程式裡沒有承認缺口後繼續營運的程序**（`K-RESTORE-GAP` 尚未實作，gaps G-03） |
| `ANCHOR_MISMATCH` | 同一個序號，資料庫算出的雜湊和錨點不同：**鏈被改寫過**（或還原了另一個環境的備份） | 視為竄改，依 [break-glass.md](break-glass.md) §7 通報 |
| `HEAD_MISMATCH` | `sgn.audit_chain_head` 和重算結果不同 | 同上 |
| `CODE_CHANGED` | 資料庫目前的 function／trigger／權限指紋和最後一個錨點記的不同 | 還原的備份和錨定時的程式版本不同（例如備份之後升過級）；確認是哪一次升級造成的，見 [upgrade.md](upgrade.md) §3 |
| `SEQ_GAP`、`LINK_BROKEN`、`HASH_MISMATCH`、`COLUMN_MISMATCH`、`BODY_UNPARSABLE` | 鏈本身斷了或某筆事件被改（`chain-lib.mjs` 的 `checkEvent`） | 視為竄改或備份損毀；換備份重試，仍有就依 break-glass.md §7 通報 |
| `ANCHOR_LAG` | 最後一個錨點之後的事件太舊或太多 | 啟動錨定程式後應自動消失 |

只靠稽核頁也能驗：稽核頁在瀏覽器裡重算整條鏈並直接向錨點存放處比對（`web/verify.js`、`web/pages/audit.js`），結果是「一致／尚未有外部摘要涵蓋／失敗」三種。

驗證工具證明的範圍：只證明**稽核事件**沒被改寫、沒有缺漏。它不證明業務資料表（例如 `sgn.grant_record`）沒被直接改過；也不涵蓋流程包 schema 與 `sgn_sdk`、`api_delivery`、`api_idp` 的 function（程式指紋只算 `sgn`、`sgn_internal`、`api`、`api_sync`、`api_job`、`api_verified`，`db/kernel/10_audit_chain.sql`；gaps G-10）。

## 5. 演練頻率

| 演練 | 頻率 | 現況 |
|---|---|---|
| 從最新備份還原到另一台主機並跑 §4 | 每月（契約 §14.3 寫的是每週自動；自動化做好之前每月人工一次） | **尚未實際演練過**；沒有備份 |
| 還原到「早於最後錨點」的時間點，確認 §4 報 `ANCHOR_BEYOND_HEAD` | 每年 | 只有資料庫測試 `60-chain.test.mjs`「竄改 6」自動做過（測試資料庫，非正式資料） |
| 含密鑰與錨點存放處的整套還原（主機全毀） | 每年 | **尚未實際演練過** |

## 6. 演練與事故紀錄格式

每次演練或真實還原一份，由執行者填、稽核主管複核，存放在平台以外（平台壞掉時也要讀得到）：

```
編號：RST-<年>-<序號>
類別：演練／事故
日期與起訖時間：
執行者（技術維運）：            見證或複核（稽核主管）：
備份來源與時間點：             備份檔的 SHA-256：
還原目標（主機、資料庫名稱）：
verify-chain.mjs 結束碼與完整輸出（附檔）：
還原後的鏈頭序號：             存放處最後一個錨點序號：
遺失的序號區間（若有）：
花費時間（RTO 實測）：          資料遺失範圍（RPO 實測）：
發現的問題與後續（對應 gaps.md 編號）：
```
