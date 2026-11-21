# 背景程式

結論：九個程式，每個以自己的作業系統帳號 `sgn-<程式>` 執行、只讀得到自己的密鑰檔 `.run/secrets/<程式>.env`（0400，擁有者是該帳號）。其中六個（jobs、mailer、delivery、reconciler、anchor、idp-keys）每一輪回報心跳並互相檢查；**api、web、anchor-store 沒有心跳**，停了不會開 K-PROGRAM-STALLED。目前唯一的啟動方式是 `tools/run-all.sh`（會先重建資料庫，見 README「先讀這一段」），沒有正式環境的服務定義（gaps G-01）。

依據：程式與密鑰的唯一來源 `db/tools/lib/programs.mjs`；發密鑰 `db/tools/provision-secrets.mjs`；啟動與監看 `tools/run-all.sh` 的 `supervise`、`start_program`；心跳與存活檢查 `db/kernel/525_program_liveness.sql`；各程式能呼叫的 function `packages/contract/src/routes.ts`。

## 1. 總表

| 程式 | 進入點 | 作業系統帳號 | 資料庫角色 | 密鑰檔的鍵 | 週期（`run-all.sh`） | 心跳 |
|---|---|---|---|---|---|---|
| api（後端） | `api/src/server.ts` | `sgn-api` | `sgn_app` | `SGN_DB_PASSWORD`、`SGN_IDP_CLIENT_SECRET` | 常駐 HTTP（`SGN_RP_ORIGIN`） | 無 |
| web（頁面） | `web/server.mjs` | `sgn-web` | 不連資料庫 | 無 | 常駐 HTTP（`SGN_WEB_ORIGIN`） | 無 |
| anchor-store（錨點存放處） | `db/tools/anchor-store.mjs` | `sgn-anchor-store` | 不連資料庫 | `SGN_ANCHOR_WRITE_KEY_SHA256` | 常駐 HTTP（`SGN_ANCHOR_ORIGIN`） | 無 |
| anchor（錨定） | `db/tools/anchor.mjs` | `sgn-anchor` | `sgn_anchor` | `SGN_DB_PASSWORD`、`SGN_ANCHOR_WRITE_KEY` | `--every 2`（秒） | `api_job.anchor_heartbeat` |
| jobs（排程） | `db/tools/jobs.mjs` | `sgn-jobs` | `sgn_scheduler` | `SGN_DB_PASSWORD` | `--every 60` | `api_job.scheduler_heartbeat` |
| mailer（寄信） | `api/src/mailer.ts` | `sgn-mailer` | `sgn_mailer` | `SGN_DB_PASSWORD` | `--every 5` | `api_job.mailer_heartbeat` |
| delivery（交付） | `api/src/delivery.ts` | `sgn-delivery` | `sgn_delivery` | `SGN_DB_PASSWORD`、`SGN_DC_KEY`（外部系統的 platform 金鑰） | `--every 1` | `api_delivery.delivery_heartbeat` |
| reconciler（對帳與使用摘要） | `api/src/reconciler.ts` | `sgn-reconciler` | `sgn_reconciler` | `SGN_DB_PASSWORD`、`SGN_DC_KEY`（外部系統的 auditor 唯讀金鑰） | `--every 30` | `api_job.reconciler_heartbeat` |
| idp-keys（身分提供者金鑰） | `db/tools/idp-keys.mjs` | `sgn-idp-keys` | `sgn_idp_keys` | `SGN_DB_PASSWORD` | `--every 60` | `api_idp.idp_keys_heartbeat` |

不是背景程式、但維運會用到的：人員目錄同步 `db/tools/directory-sync.mjs`（角色 `sgn_sync`）目前**只在 `db/build.sh` 建置時跑一次**，沒有排程、沒有自己的作業系統帳號與密鑰檔（它用操作者設定 `loadConfig()` 讀 root 才讀得到的 `roles.env`）。正式環境要定期同步就必須先補（gaps G-07）。

## 2. 各程式

每一節的「誰會知道」指資料庫會開的例外（處置見 [exceptions.md](exceptions.md)）。停擺偵測的門檻：心跳超過 `program.heartbeat_max_seconds`（300 秒）、或逾期工作超過 `program.overdue_max_seconds`（600 秒）。檢查由**其他**程式的心跳（最少每 `program.stall_check_interval_seconds`＝10 秒一次）與稽核頁觸發。

### api（後端）
- 職責：對使用者的 JSON API；依路由表呼叫 `api` schema 的 function；OIDC 登入（client secret）。不做任何業務判斷。
- 停掉時：使用者打不開資料、不能申請或簽核。資料庫裡的到期、撤銷、交付照常（由其他程式做），因為有效性在讀取時以時間計算（D58）。
- 誰會知道：**沒有例外**。使用者回報；web 頁面顯示連線錯誤。需要外部監控（gaps G-08）。
- 啟動檢查：`tools/run-all.sh` 用 `curl -fsS "$SGN_RP_ORIGIN/errors"` 判斷起來了沒。

### web（頁面）
- 職責：只送 `web/` 的靜態檔與 `/config.js`、`/config.json`；每個回應帶 CSP。沒有密鑰。
- 停掉時：使用者看不到畫面；後端照常。
- 誰會知道：沒有例外；`curl -fsS "$SGN_WEB_ORIGIN/"`。

### anchor-store（錨點存放處）
- 職責：保存錨點（`GET /anchors` 給頁面與驗證工具；`POST /anchors` 只收帶寫入金鑰、序號比最後一筆大的錨點）。資料檔 `.run/anchors-<端對端資料庫>.jsonl`，擁有者是 `sgn-anchor-store`。
- 停掉時：錨定寫不進去，稽核頁與 `verify-chain.mjs` 取不到錨點，驗證失敗。
- 誰會知道：K-ANCHOR-LAG（由排程的 `anchor_lag_check`，落後超過 `audit.anchor_max_lag_seconds`）。存放處自己沒有心跳。
- 注意：D81 (4) 要求存放處不放在後端主機可寫的地方；目前它和其他程式在同一台主機的 `.run/` 下，只靠檔案擁有者區隔（gaps G-06）。

### anchor（錨定）
- 職責：每輪從上一個錨點增量重算鏈；一致才把鏈頭與程式指紋寫到存放處，並回報資料庫（`api_job.anchor_recorded`）。
- 停掉時：同 anchor-store。
- **它會自己停**：重算不一致（`ANCHOR_MISMATCH`、`ANCHOR_BEYOND_HEAD`）或程式指紋改變（`CODE_CHANGED`）時以結束碼 2 結束，監看 1 秒後重啟、又結束。log 裡反覆出現 `結束（結束碼 2）` 就是這個情況。**這不是當機，是偵測到竄改、還原或升級**，不要只重啟了事：見 [break-glass.md](break-glass.md) §7 與 [upgrade.md](upgrade.md) §3（升級後一定會遇到 `CODE_CHANGED`，目前沒有重新錨定的程序，gaps G-01b）。
- 誰會知道：K-PROGRAM-STALLED（心跳，它在錨定前先回報心跳，所以反覆重啟時心跳仍在；靠的是 K-ANCHOR-LAG）、K-ANCHOR-LAG。

### jobs（排程）
- 職責：依 `schedulerCalls` 每輪呼叫：延後異動生效、清挑戰值、治理金鑰檢查、通知卡住、交付卡住、授權到期、確認逾期撤銷、確認提醒、對帳逾期、錨定落後、有期限例外的升級、使用摘要檢查。
- 停掉時：到期的授權不結束、不排清除（授權讀取時仍依迄日判為無效，但外部系統上的權限不會被收回）；確認逾期不撤銷；多數「逾期才開」的例外不再開。
- 誰會知道：K-PROGRAM-STALLED（`program:jobs`，由其他程式的心跳或稽核頁檢查；`work:grant_expiry`、`work:confirmation_expiry`）。首頁與單的頁面對逾期未處理的單顯示警示。

### mailer（寄信）
- 職責：領走待寄通知、經 SMTP 寄出、回報結果。站內待辦不靠它。
- 停掉時：郵件不寄；站內待辦照常。
- 誰會知道：K-NOTIFY-STUCK（每則超過 1800 秒未寄）、K-PROGRAM-STALLED。這兩個例外本身也要靠郵件以外的方式被看到（稽核頁）。
- 已知殘餘：拿到寄信角色的人可以標成已寄而不寄（紅隊 40，D85 (4)）。

### delivery（交付）
- 職責：領走該送的交付（`api_delivery.delivery_claim`），經交付 port 送到外部系統，把回應原樣交回。不產生、不簽內容（簽章在資料庫裡）。
- 停掉時：核准的權限不套用、撤回不送達（該收回的權限留在外部系統）。
- 誰會知道：K-PROGRAM-STALLED（`program:delivery`、`work:delivery`）、K-DELIVERY-STUCK（900 秒）。
- 現況：通道只接 `sim/dc`（`api/src/delivery.ts` 的 `deliveryConfig` 讀 `sim/dc` 的 service.env）；真實外部系統的 adapter 與設定還沒有（gaps G-01）。

### reconciler（對帳）
- 職責：以唯讀稽核金鑰拉外部系統實際的權限與使用摘要，原樣交給資料庫驗證比對。
- 停掉時：交付程式謊報、外部系統被人改都看不到；測試報告沒有使用資料。
- 誰會知道：K-RECON-OVERDUE（300 秒）、K-USAGE-OVERDUE（600 秒）、K-PROGRAM-STALLED。

### idp-keys（身分提供者金鑰）
- 職責：讀身分提供者的 JWKS 交給 `api_idp.idp_keys_sync`（新金鑰立即信任並開 K-IDP-KEY-NEW；不能信任的開 K-IDP-KEY-UNTRUSTED；不再公布的退役）。
- 停掉時：身分提供者輪替金鑰後，用新金鑰簽的登入全部失敗（全公司登不進來）。
- 誰會知道：K-PROGRAM-STALLED。
- 現況：讀的是 `sim/idp/service.env` 的 issuer；D84 (3) 要求取 JWKS 的傳輸加密與憑證釘選，目前沒有（gaps G-01）。

## 3. 怎麼看狀態、怎麼重啟（開發與驗收環境，**可執行**）

以 root 在專案根目錄：

| 要做的事 | 指令 | 依據 |
|---|---|---|
| 看程式有沒有在跑 | `for f in .run/*.pid; do printf '%s ' "$f"; kill -0 "$(cat "$f")" 2>/dev/null && echo up \|\| echo down; done` | `run-all.sh` 寫 `<程式>.pid`（目前那個程式）與 `<程式>.supervisor.pid`（監看） |
| 看被重啟過幾次 | `grep -c '結束（結束碼' .run/*.log` | `supervise` 每次重啟寫一行 |
| 看某程式的最近輸出 | `tail -n 50 .run/<程式>.log` | log 只有 root 讀得到 |
| 重啟單一程式 | `kill "$(cat .run/<程式>.pid)"`；監看會在 1 秒後以同一個帳號重新啟動 | `supervise` 的迴圈 |
| 暫停（測試用） | `kill -STOP "$(cat .run/<程式>.pid)"`，恢復 `kill -CONT ...` | `stop_bg` 會先送 CONT |
| 全部停掉 | `kill $(cat .run/*.supervisor.pid)` 再 `kill $(cat .run/*.pid)`（先停監看，否則它會重啟） | `run-all.sh` 的 `stop_bg` 順序 |
| 從頭全部啟動 | `tools/run-all.sh --keep` | **會重建資料庫**，只在驗證主機用 |
| 存活狀態（給人看） | 稽核頁最上方（`api.program_health`，只限稽核角色） | `web/pages/home.js` 的 `programHealth` |

沒有「只啟動背景程式、不重建資料庫」的指令（`run-all.sh` 一律先跑 `db/build.sh`）。全部停掉之後要在**不清資料**的前提下重新啟動，程式裡沒有，需要補（gaps G-01）。

## 4. 已知的偵測盲點

- 所有背景程式都停了、而且沒有人打開稽核頁：沒有主動訊號（`docs/handoff/redteam-fixes-7.md` §5）。每日打開稽核頁就是為了補這個。
- 心跳只證明「程式在跑、連得上資料庫」，不證明工作做對；做不對靠逾期檢查與交付、對帳的例外。
- api、web、anchor-store 沒有心跳。
- 主機本身（磁碟滿、時鐘漂移、PostgreSQL 停）：沒有任何監控。PostgreSQL 停了所有心跳與例外都停（偵測和被偵測的死在一起），只能靠外部監控（gaps G-08）。
