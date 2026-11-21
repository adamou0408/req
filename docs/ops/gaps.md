# 維運缺口

寫手冊時發現：要真的維運三五年，程式或工具還缺的東西。依嚴重度排序（「阻擋」＝不補就不能上正式環境；「高」＝上線後第一年內一定會出事；「中」＝影響稽核或維運效率；「低」＝整理）。編號是穩定的標籤，其他 ops 文件以編號引用。

| 排序 | 編號 | 嚴重度 | 缺什麼 | 建議做法 |
|---|---|---|---|---|
| 1 | G-01 | 阻擋 | 沒有正式環境的部署：唯一的安裝與啟動（`db/build.sh`、`tools/run-all.sh`）會刪庫重建、換掉所有密碼；沒有不刪資料的「只建角色」「只啟動程式」「只套新 migration」工具，也沒有已套用 migration 的紀錄；程式的外部設定寫死讀 `sim/*/service.env`（`api/src/config.ts`、`delivery.ts`、`reconciler.ts`、`idp-keys.mjs`、`mailer.ts`），沒有真實外部系統、SMTP 認證、身分提供者 TLS 與憑證釘選（D84 (3)）的設定位置；`deploy/` 不存在 | 拆出 `deploy/`：服務定義（每個程式的帳號、密鑰檔、監看）、正式環境設定檔（取代 sim 的 service.env，`deploy/.env.example` 由測試比對）、`db/migrate`（記錄已套用的檔名與雜湊、只套新檔、套完重跑 `grants-sql.mjs`） |
| 2 | G-01b | 阻擋 | 程式指紋一改（任何升級、PostgreSQL 主版本升級）錨定就永久拒絕（`CODE_CHANGED`），沒有「人確認後重新起算」的程序 | 新增 owner 專用的 function：記下核准的升級單與新指紋、進鏈，之後錨定程式接受新指紋；破窗等級，見證留紀錄 |
| 3 | G-03 | 阻擋 | 沒有備份程式、沒有 WAL 歸檔、沒有還原工具；還原到早於最後錨點的時間點後錨定永久卡住（`ANCHOR_BEYOND_HEAD`→`ANCHOR_MISMATCH`）；契約 §14.3 的 `K-RESTORE-GAP`、`restore_pending` 尚未實作 | 實作 §14.3：備份與 PITR 腳本、每週自動還原驗證；還原缺口以一筆進鏈的事件承認遺失的序號區間，錨點存放處接受「帶缺口聲明」的新錨點 |
| 4 | G-02 | 阻擋 | 例外沒有人工處理與結案的入口（39 種中 31 種永遠不結案）；對帳發現已解決時例外仍開著；沒有派工、處理時限、篩選（`docs/handoff/promote.md` §7、`closed-loop-3.md` §7、D90 (3)） | 例外處理畫面：認領、處理說明、結案依據（經 `sgn_internal.exception_close` 進鏈）、依規則代碼的處理角色與時限參數；K-RECON-RESOLVED 時一併結案 |
| 5 | G-05 | 高 | 沒有不刪資料的金鑰輪替工具；`provision-secrets.mjs` 會清空錨點存放處、重產錨點寫入金鑰；交付簽章金鑰沒有新舊並存的過渡期 | 每類金鑰一支輪替指令（只換一個、保留權限、留紀錄）；`signing_key` 允許短暫兩把（新的先發、外部系統切換後退役舊的） |
| 6 | G-08 | 高 | api、web、anchor-store 沒有心跳；PostgreSQL 或主機停了所有偵測一起停；K-NOTIFY-STUCK 沒有通知對象；沒有磁碟、時鐘（簽章 300 秒、回報 120 秒的新鮮度依賴時鐘）監控；所有程式都停又沒人開稽核頁時沒有訊號 | 外部監控（平台以外的主機）定期打 `/errors`、頁面、`/anchors` 與一個唯讀的健康端點；NTP 監控；告警走郵件以外的管道 |
| 7 | G-07 | 高 | 人員目錄同步只在建置時跑一次，沒有排程程式、沒有自己的帳號與密鑰檔（用 root 的操作者設定）；離職、調動不會進來 | 把 `directory-sync` 加進 `programs.mjs`（`sgn-sync` 帳號、`sync.env`）、加心跳與排程，納入 K-PROGRAM-STALLED |
| 8 | G-06 | 高 | 錨點存放處和其他程式、資料庫在同一台主機的 `.run/`，只靠檔案擁有者區隔；主機 root 能同時改資料庫與錨點（D81「同一台主機就只是一道」） | 存放處移到另一台主機或一次寫入的儲存（WORM），只開 `POST`／`GET /anchors`；另存一份不同管理者的副本 |
| 9 | G-11 | 高 | 防改寫的 trigger 不是 `ENABLE ALWAYS`（`10_audit_chain.sql`），`session_replication_role` 可繞過且不改指紋；superuser 的語句沒有資料庫層紀錄（契約 §14.2 的 `pgaudit` 未實作） | 新 migration 把 trigger 改 `ENABLE ALWAYS`（並納入指紋）；裝 `pgaudit` 把非應用角色的 DDL、DML 送到平台外 |
| 10 | G-10 | 高 | 程式指紋只涵蓋 `sgn`、`sgn_internal`、`api`、`api_sync`、`api_job`、`api_verified`，不含 `sgn_sdk`、`api_delivery`、`api_idp` 與流程包 schema；業務資料表的直接修改不會被錨點發現 | 指紋改成涵蓋所有自家 schema（新 migration，會觸發一次 G-01b）；破窗期間的資料表異動靠 G-11 的 pgaudit |
| 11 | G-12 | 中 | 沒有唯讀的維運角色：看例外總表、背景程式明細、不屬於單的稽核事件都要 superuser；稽核頁只能依單號查，`api.audit_chain` 沒有畫面 | 新增唯讀的維運 function 與路由（例外總表、事件依序號瀏覽、程式心跳明細），給 `tech_ops` 與稽核 |
| 12 | G-09 | 中 | 營業日的休假日表 `sgn.calendar_holiday` 沒有登記入口，也不支援補班日（週六上班）；所有「營業日」期限依它計算 | 每年由 migration 或受控的設定變更登記；`is_workday` 加補班日 |
| 13 | G-22 | 中 | 參數（`sgn.setting_value`）只能由 owner 呼叫 `register_setting_value` 改，沒有設定變更單（契約寫的「來源的設定變更單」）；正式環境改任何參數都等於破窗 | 實作設定變更的申請與核准流程（流程包），套用時記下單號 |
| 14 | G-18 | 中 | 沒有 CI（`.github/` 不存在）；工程規範要求推上 `main` 前跑 `tools/check.sh`，目前只靠人 | 在獨立的 CI 主機跑 `tools/check.sh`（它會重建資料庫，不能和任何使用中的系統共用） |
| 15 | G-19 | 中 | `pg_hba.conf` 的 superuser 拒絕名單是建置當下的快照，之後新增的帶密碼 superuser 可經 TCP 登入（紅隊 57、D90 (2)） | 改成正面表列允許 TCP 的應用角色，其餘一律拒絕 |
| 16 | G-14 | 中 | 「已套用的 migration 不得修改」沒有自動檢查 | `check.sh` 加一段：和上一個發行標記比對 `db/kernel`、`db/packs`，只允許新增 |
| 17 | G-13 | 中 | 工程規範 §6 的 sqlfluff、knip、Trivy（弱點、密鑰、錯誤設定、授權）、hadolint、actionlint、產生檔無差異檢查還沒進 `check.sh` | 依 `docs/handoff/promote.md` §7 補進去 |
| 18 | G-16 | 中 | 保存與銷毀（契約 §14.4）未實作；稽核事件、通知、對帳回報只增不減，沒有分區或封存；三五年後的資料量沒有量測 | 依 `retention.years` 實作封存與匯出；量測五年資料量下 `verify-chain.mjs` 的全量重算時間 |
| 19 | G-17 | 中 | 沒有「資安長代理人」的角色或代理機制；破窗見證（D98）與通知都只認 `ciso` | 以帶期間的角色指派表達代理，或補骨幹的代理（delegation）實作 |
| 20 | G-04 | 中 | 契約的 `K-BREAKGLASS`（預先封存、分持的破窗帳號、使用即告警）未實作；破窗沒有演練過 | 實作前每年演練一次本手冊的程序；實作時把「使用 superuser 連線」本身變成告警 |
| 21 | G-23 | 中 | 紅隊待補：D90 (4) 列的下一輪必補項（第二人背書的正向路徑、串通殘餘留下的訊號、等過復原期間、不能做決定的登記人分支）；閉環第一、二批尚未經紅隊（D95、D96）；端對端偶發失敗待觀察（D87、D89 (5)） | 排下一輪紅隊，結果寫 `redteam/findings-9.md` |
| 22 | G-15 | 低 | PostgreSQL 主版本寫死在 `db/build.sh` 與 `tools/install-dev-tools.sh` 兩處 | 收斂成 `db/sgn.env` 一個變數 |
| 23 | G-20 | 低 | `docs/reference/` 與產生器不存在（工程規範 §1 要求 SQL function、路由、規則代碼的參考文件由腳本產生）；本手冊的例外清單只能靠 grep | 由 `pg_catalog` 與路由表產生參考文件，含「規則代碼 × 會開例外的地方 × 通知參數」表，取代 exceptions.md §1 的手動指令 |
| 24 | G-21 | 低 | `db/tools/lib/programs.mjs` 的註解說 `tools/run-all.sh` 以 `tools/lib/as-program.sh` 啟動程式，但該檔不存在（實際是 `run-all.sh` 內的 `setpriv`） | 改註解 |
| 25 | G-24 | 低 | 角色 `key_custodian`（金鑰保管人）有定義但沒有任何 function 使用；金鑰輪替沒有對應的平台角色 | 決定金鑰保管人負責哪些步驟（key-rotation.md），或移除 |
