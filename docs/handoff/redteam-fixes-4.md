# 交接：紅隊第四輪的修復（redteam-fixes-4）

> **本檔寫於 2026-11-20，以下已過時：§0 的測試數字；「同主機 root 未解」仍是現況（見 `redteam-fixes-5.md`、`redteam-fixes-7.md` 的殘餘風險），但其餘「未解」項目後續已處理。仍有效：第四輪攻擊（`redteam/findings-4.md`）的修復紀錄與設定依程式分開載入的做法（高-1）仍有效；它也是 sim/dc 回應簽章與撤回封存的來源，格式的唯一來源是 `docs/contract/02-pack-data-access.md` §8.8。**

日期：2026-11-20。依據：`redteam/findings-4.md`、裁決 D81（背景 D80）、`docs/handoff/delivery.md`、`docs/handoff/sim-dc.md`、`sim/dc/README.md`。
範圍：`db/`、`api/`、`web/`、`e2e/`、`packages/contract/`、`tools/`、`sim/dc/`、本文件。沒有改 `redteam/`、`docs/packs/**/rules.md` 與其他文件；沒有 commit。

## 0. 結果一覽

| 項目 | 結果 | 測試（拿掉防法就失敗） |
|---|---|---|
| 高-1 設定依程式分開載入、各角色獨立隨機密碼、執行期讀不到管理者連線與別人的金鑰 | 做了（同主機 root 未解，見 §1） | `95` 架構 ×7（檔案的鍵與擁有者、跨帳號讀不到、三個程序的 heap snapshot）|
| 高-2 回應與對帳回報簽章（請求摘要、結果、一次性亂數／新鮮度），資料庫驗章才採信 | 做了 | sim/dc `10-interface-level`；`93` K-DELIVERY-ATTESTED ×5；`50` K-RECON-UNVERIFIED、K-DELIVERY-RETRY、K-DELIVERY-REJECTED |
| 中-1 撤回＝封存整張單；簽章帶期限 | 做了 | sim/dc `02-change`、`10`；`93` K-DELIVERY-ORDER（封存）、K-DELIVERY-ATTESTED（期限）|
| 中-2 被簽的內容帶通道、環境、方法、路徑、期限；每個環境各自的信任清單 | 做了 | sim/dc `10`（環境、方法、路徑、通道、期限、遮罩金鑰）；`93` K-DELIVERY-ATTESTED（遮罩環境）|
| 中-3 對帳逾期開例外、單輪上限、已知單的「多出來」自動排撤回、結案進鏈 | 做了（生效中的單的多出來只升級，見 §3）| `50` K-RECON-OVERDUE、K-RECON-LIMIT、K-RECON-EXTRA（自動撤回）、K-RECON-RESOLVED |
| 高-3 信任清單只放這個資料庫目前那一把；sgn_test 與 sgn_e2e 分開；開發金鑰移除 | 做了：sim/dc 兩個實例（main＝sgn_e2e、unit＝sgn_test）| `95` 信任清單、跨實例互送 401 |
| 中-4 錨點由頁面直接向獨立的錨點存放處取得；離線工具同樣 | 做了（存放處與後端同主機、不同帳號）| e2e `z-anchor-store` ×2 |
| 中-5 身分提供者金鑰更新程序；新 kid 出現時開例外 | 做了 | `96` K-IDP-KEY-NEW ×2、K-IDP-KEY-UNTRUSTED |
| 低-1 撤回被拒退避重送並升級 | 做了 | `50` K-DELIVERY-REJECTED（撤回被拒不是終態）|
| 資訊 2 principal_id 格式不對走錯誤目錄 | 做了 | `40` 被授權者 id 只認標準寫法 |
| 資訊 3 ed25519_sign 自己從種子導出公鑰 | 做了（保留參數只用來比對，見 §3）| `93` ed25519_sign 公鑰不一致就拒絕 |
| D81 (2) 做不到完整等級的外部系統列為較低等級、每張單開常設例外 | **沒做** | — |
| 申請人確認、縮小的畫面、傳輸加密 | 不在這次範圍（傳輸加密列為部署必要項，§6）| — |

`93`＝`db/tests/kernel/93-delivery-adapter.test.mjs`，`95`＝`db/tests/kernel/95-program-secrets.test.mjs`，`96`＝`db/tests/kernel/96-idp-keys.test.mjs`，
`50`＝`db/tests/packs/data_access/50-delivery.test.mjs`，`40`＝`db/tests/packs/data_access/40-principal-owner.test.mjs`，
e2e `z-anchor-store`＝`e2e/tests/z-anchor-store.test.mjs`，sim/dc `10`＝`sim/dc/tests/10-interface-level.test.ts`。

## 1. 威脅小表（動手前寫；每列對應的測試在最後一欄）

欄位：機制／誰送給誰／經過的不可信方／攻擊者可離線試幾次／當事人能否影響／測試。
起點代號沿用 findings-4：B 後端主機、F 交付程式、D（J）對帳程式、N 平台與外部系統之間的網路。

| # | 機制 | 誰送給誰 | 經過的不可信方 | 離線可試 | 當事人能否影響 | 測試 |
|---|---|---|---|---|---|---|
| 1 | 角色密碼 | `db/build.sh`（root）→ `.run/secrets/roles.env`（root 0600）→ `provision-secrets.mjs` → `.run/secrets/<程式>.env`（該程式的作業系統帳號 0400）| 主機檔案系統 | 48 個十六進位字（192 bits）隨機，不可試；不再是「前綴＋角色名」 | 不能 | `95` #2（不同、隨機、和名稱無關、別的帳號讀不到）|
| 2 | 外部系統呼叫方金鑰 | sim/dc 實例 `init-secrets`（`sim/.run/<實例>/keys/`，root 0700）→ 平台建置 → 只把 platform 給交付程式、auditor 給對帳程式 | 主機檔案系統；**N（明文 http，截得到）** | 隨機 24 bytes，不可試 | 不能 | `95` #1、#2；N 截到之後只能送已簽章、有期限、指定環境的請求或讀回報（#4、#6）|
| 3 | 管理者連線 | `db/admin.env` → 只有建置與測試工具讀 | **repo 本身**：這是開發環境 PostgreSQL 的既有帳號，密碼是環境給的已知值 | — | — | `95` #4–6（三個程序的記憶體裡沒有它）。**未解**：知道密碼的人仍連得上（部署必要項 §6）|
| 4 | 平台簽的請求（信封） | 資料庫（簽）→ F → N → 外部系統 | F、N | Ed25519，不可偽造 | 不能 | F／N 能做的只剩：期限內重送同一份（冪等）、送到別的環境（環境不符 409／不信任 401）、撤銷後送較新版（封存 409）、拖到期限後（401 過期）、改內容（401）。sim/dc `10`、`02`；`93` ORDER、ATTESTED；腳本 22、23 |
| 5 | 外部系統的回應證明 | 外部系統（ES256 簽）→ N → F → 資料庫驗 | N、F | P-256，不可偽造 | 不能 | 沒有證明、證明被改、別一次領取的回應（亂數不同）、別一筆的回應（摘要不同）→ 當成沒送到（重送，超時開卡住例外）；可讀副本被改不影響。`93` ATTESTED ×4；`50` RETRY、STUCK。送出途中被改（摘要不符）→ 拒絕（套用不生效並撤回）：`50` REJECTED（竄改）|
| 6 | 對帳回報 | 外部系統（ES256 簽）→ N → 對帳程式 D → 資料庫驗 | N、D | 同上 | 不能 | D／N 改、刪、加項目無效；重送（同一份）、過期、沒有證明都不收並開例外（限速）；不交 → 資料庫依時間開逾期例外；灌項目 → 上限。`50` UNVERIFIED、LIMIT、OVERDUE、RESOLVED |
| 7 | 錨點 | 錨定程式（sgn_job＋寫入金鑰）→ 錨點存放處（另一個來源 3002、作業系統帳號 sgn-anchor-store，只存金鑰雜湊、只增不改）→ 頁面與離線工具直接讀 | B 不在路上 | 寫入金鑰 32 bytes 隨機 | 不能 | e2e `z-anchor-store` #1（後端改寫鏈與「錨點」，頁面仍判失敗）、#2（沒金鑰 401、別的帳號寫不了檔、後端沒有 /anchors）|
| 8 | 身分提供者的金鑰 | Dex → idp-keys 程式（sgn_idp_keys）→ 資料庫 | **N（http 到 Dex）**、這個程式的帳號 | — | 不能 | 新金鑰立即信任、進鏈、開例外、通知治理角色；不能信任的開例外；退役。`96` ×3。**未解**：網路上的人能讓平台信任自己的金鑰並冒用登入（不能做決定，決定要通行金鑰）；TLS 是部署必要項 |
| 9 | 撤回被拒 | 外部系統 → 資料庫 | — | — | — | 不是終態：第一次開例外並通知，之後退避重送。`50` REJECTED（撤回被拒）|
| 10 | 兩個平台資料庫 | sgn_e2e ↔ sim/dc main；sgn_test ↔ sim/dc unit | — | — | — | 各自的資料庫、角色、金鑰、信任清單；交叉送 401。`95` #7 |

**D81 的原理（兩道防線有沒有共用同一段網路、同一份設定、同一台主機上的同一個檔案）逐項檢查：**

| 兩道防線 | 共用什麼 | 結論 |
|---|---|---|
| 交付的證明 ↔ 對帳 | **同一段網路、同一個外部系統實例**（都到 7001） | 回應與回報都簽章之後，N 只剩「擋下」；擋下由資料庫依時間開例外（K-DELIVERY-STUCK、K-RECON-OVERDUE），這兩個例外不經網路。所以共用網路不再能「同時騙過」。**未解**：外部系統自己說謊（證明只證明「外部系統說」）時兩道都失效——這是外部系統的信任邊界 |
| 交付程式 ↔ 對帳程式 ↔ 後端的密鑰 | 不同檔案、不同作業系統帳號；**同一台主機** | 程式被拿走（以它的帳號執行）時拿不到別人的（`95`）。**未解**：同主機 root 讀得到全部 |
| 對帳程式 ↔ 排程 ↔ 錨定 ↔ 寄信 | **同一個資料庫角色 sgn_job**（四個檔案各一份同樣的密碼）| 見 §3：紅隊腳本以 sgn_job 呼叫排程與對帳的入口；回報簽章之後 sgn_job 不能偽造對帳，只能不交（逾期例外）。**部分未解** |
| 鏈 ↔ 錨點 | 不同來源、不同程序與帳號；**同一台主機** | 後端程序改不了錨點（`z-anchor-store`）。**未解**：同主機 root、或錨定程式的帳號被拿走時能寫「更新」的錨點（改不了已寫下的） |
| 平台信任外部系統 ↔ 外部系統信任平台 | 各自的金鑰；**同一台主機上的 root** 讀得到兩邊的私鑰 | 模擬環境的限制；正式環境兩邊在不同主機 |

## 2. 做了什麼

### 高-1：每個程式只拿得到自己的密鑰

- `db/tools/lib/programs.mjs`（唯一來源）：九個執行期程式（api、delivery、reconciler、jobs、mailer、anchor、anchor-store、idp-keys、web）與各自的資料庫角色、密鑰鍵名。
- `db/build.sh`：每次建置每個登入角色一組 `openssl rand -hex 24`，寫 `.run/secrets/roles.env`（root 0600）；`sgn.env` 拿掉 `SGN_ROLE_PASSWORD_PREFIX` 與管理者連線（移到 `db/admin.env`）；新角色 `sgn_idp_keys`。
- `db/tools/provision-secrets.mjs`（建置最後，以 root）：建立作業系統帳號 `sgn-<程式>`（system、無家目錄、nologin），寫 `.run/secrets/<程式>.env`（0400、擁有者是該帳號；目錄 0711）。錨點寫入金鑰每次重新產生，存放處只拿它的 SHA-256。
- `db/tools/lib/env.mjs`：`loadConfig()` 只給操作者（建置、測試、攻擊腳本：以 root 讀全部）；新增 `loadProgramConfig(程式)`、`programDbUrl`，執行期程式只用這兩個。`roleUrl` 改讀 `roles.env`；`config.dc` 是這個資料庫對應的外部系統實例（含它的金鑰）。
- `api/src/config.ts` 只剩後端自己的（sgn_app、client secret）；交付、對帳、寄信的設定搬進各自的程式（`delivery.ts`、`reconciler.ts`、`mailer.ts`）；`db/tools/jobs.mjs`、`anchor.mjs`、`idp-keys.mjs`、`anchor-store.mjs`、`web/server.mjs` 都改用 `loadProgramConfig`。
- `tools/run-all.sh`：每個背景程式以 `setpriv --reuid sgn-<程式>` 啟動，環境變數只留 `PATH` 與 `SGN_DATABASE`；因此要以 root 執行。
- 測試 `95`：每個程式的檔案只有清單上的鍵與自己的值；每個帳號讀不到別人的檔、`roles.env`、外部系統的 `secrets.env` 與回應私鑰；**以各自的帳號實際啟動 api、delivery、reconciler，拍 heap snapshot，確認記憶體裡沒有別的程式的密鑰與管理者連線**（也確認自己的密鑰在，證明快照涵蓋了設定）。

### 高-2、中-1、中-2、中-3：外部系統交付介面的完整等級（平台與 sim/dc 一起改）

平台（`db/kernel/405_external_attestation.sql` 新增；`410`、`430`、`440` 就地修改）：

- `sgn.channel_key`：外部系統回應證明的公鑰（P-256）；`channel_key_register`（建置時由 `db/tools/delivery-keys.mjs` 登記，只留目前那一把）。參數 `delivery.target_environment`、`delivery.signature_ttl_seconds`、`delivery.attestation_context`。
- `sgn.delivery_op` 多 `method`、`path`、`sent_body`、`sent_sha256`、`signed_until`、`nonce`、`refused_exception_id`。方法與路徑由資料庫決定（`delivery_target`）。
- 領取：套用與撤回送的是信封（`delivery_envelope`：通道、環境、方法、路徑、`not_after`、payload），第一次領取或快過期時簽（`delivery_seal`，每次簽都進鏈）；每次領取給一個一次性亂數。
- 回報：`delivery_verdict`（`delivery_classify` 包它）只採信外部系統的證明——驗章、通道與環境、方法、路徑、這次的亂數都要相符，否則當成沒送到（retry）；證明有效但請求摘要不符＝送出途中被改，一律拒絕；信封過期 → 重送並在下次領取重新簽。交付程式交回的 HTTP 狀態只用來判斷「連不上」。
- 撤回被拒（低-1）：不進終態，第一次開例外 K-DELIVERY-REJECTED 並通知升級對象，之後退避重送。
- 對帳（`440` 重寫）：只採信證明裡的回報；新鮮度（`issued_at` 在 `reconciliation.max_report_age_seconds` 內）、同一份只收一次（`report_sha256` unique）；不收的回報開 K-RECON-UNVERIFIED（同一通道在新鮮度的時間內一筆，灌不爆）；`reconciliation.max_items` 超過整份不收、`max_new_findings` 超過時合併成一筆 K-RECON-LIMIT；`api_job.reconciliation_overdue_check`（排程）逾期開 K-RECON-OVERDUE；多出來的屬於已不該有權限的單（撤銷、到期、失敗）自動排撤回（進鏈）；每筆結案寫 `reconciliation.finding_resolved` 進鏈。
- 撤銷的單不再算「不確定期」：撤銷在平台那一刻生效，撤回還沒完成時外部系統上的權限就是多出來的（高-2 的情境：撤回被擋下時，對帳立刻看得到）。

sim/dc（`src/signature.ts`、`server.ts`、`apply.ts`、`schema.ts`、`config.ts`、`cli.ts`、`bootstrap.ts`、`backdoor.ts`；腳本 `lib.sh`、`start.sh`、`stop.sh`、`health.sh`、`test.sh`；`service.env`、`instances/unit.env`；刪除 `test-credentials.env`）：

- 信封驗證（通道、環境＝資料庫名稱、方法、路徑、期限）；每個環境各自的信任清單（檔案不存在＝不信任任何金鑰）；沒有開發用平台金鑰。
- 整張撤回＝封存（`simdc_meta.archived_case`），之後任何版本 409 `archived`；沒套用過的單也封存（回 404）。
- 每個回應都帶證明（ES256，`payload` 含請求摘要、`Sgn-Nonce`、HTTP 狀態、時間與結果）；回應的其他欄位是可讀副本。
- 實例：main（7001，sgn_e2e）與 unit（7002，sgn_test），各自的資料庫、服務角色、角色前綴、密鑰（第一次啟動時隨機產生）與信任清單。`bootstrap` 處理服務角色換過的舊資料庫與角色。
- 細節與格式：`sim/dc/README.md`。

後端：`api/src/deliveryPort.ts`（item 多 method、path、nonce）、`dcHttp.ts`（照資料庫給的方法與路徑送、帶 `Sgn-Nonce`、回應原樣交回；對帳不論狀態都交給資料庫）、`dcMock.ts`（同一個介面等級；可以照實回覆指定狀態、簽對帳回報，給單元測試）。

### 高-3：信任清單與兩個平台資料庫分開

- `db/tools/delivery-keys.mjs` 重寫：每個平台資料庫對應自己的實例；正式環境的信任清單**取代**為這個資料庫目前那一把，遮罩環境的清單留空；金鑰目錄只留實例自己的檔（清掉舊版本留下的 `platform-dev.*`）；資料庫登記實例的回應金鑰並設定 `delivery.target_environment`。
- `db/build.sh`：先啟動兩個實例（產生密鑰）、建兩個資料庫、互相登記金鑰、重新啟動並清空兩個實例、發密鑰。

### 中-4：錨點存放處

- `db/tools/anchor-store.mjs`：`SGN_ANCHOR_ORIGIN`（3002），作業系統帳號 sgn-anchor-store；`GET /anchors`（CORS 只開給頁面）、`POST /anchors`（寫入金鑰、只增不改：序號要更大或程式指紋改變）。資料檔 `.run/anchors-<端對端資料庫>.jsonl` 由存放處的帳號擁有（`.run` 屬於 root，別的帳號不能建立或替換檔案）。
- `db/tools/anchor.mjs` 寫到存放處（`chain-lib.mjs` 的 `anchorStoreClient`）；`verify-chain.mjs` 從存放處讀；`chain-lib.mjs` 的 `verifyChain` 多收 `anchors`、`anchorOnce` 多收 `store`（檔案形式的存放處仍給測試用）。
- 後端拿掉 `/anchors`；`web/api.js` 拿掉 `anchors()`；`web/verify.js` 的 `fetchAnchors()` 從頁面來源的 `/config.json` 得知存放處、直接取錨點（不依賴頁面的模組，離線也能跑）；`web/server.mjs` 多 `/config.json`、CSP 的 connect-src 加存放處。

### 中-5：身分提供者的金鑰更新程序

- `db/kernel/460_idp_keys.sql`：schema `api_idp`、`api_idp.idp_keys_sync(issuer, jwks)`；新的 RS256 金鑰立即信任、開 K-IDP-KEY-NEW、通知治理角色（參數 `identity.idp_key_notify_roles`）、進鏈；不能信任的開 K-IDP-KEY-UNTRUSTED（每把一次）；不再公布的退役（`sgn.idp_key.retired_at`，驗 token 時不用）。
- `db/tools/idp-keys.mjs`（帳號 sgn_idp_keys，run-all 每 60 秒）；路由表 `idpCalls`、`grants-sql.mjs` 的允許清單。建置時的第一次登記仍由擁有者做（`idp-keys-sql.mjs`，不開例外）。

### 資訊 2、3

- `sgn_internal.try_uuid`；`terms_errors` 的被授權者檢查不再轉型丟 22P02。
- `ed25519_sign`：從種子導出公鑰，和傳入的不一致就丟 ED25519_KEY_MISMATCH。

## 3. 和裁決（D81）不同的地方

| 項目 | D81 | 這裡 | 理由 |
|---|---|---|---|
| (1) 每個程式自己的角色 | 「各角色獨立隨機密碼」 | 角色各自隨機；但排程、對帳、錨定、寄信共用 sgn_job（四個密鑰檔各有一份同樣的密碼）| 紅隊腳本（21–29、11）以 `connect('JOB')` 同時呼叫排程入口（`delivery_stuck_check`、`chain_head`）與 `reconciliation_submit`，不得改腳本；回報簽章之後 sgn_job 不能偽造對帳。拆角色留給下一輪（要和紅隊一起改腳本）|
| (2) 回應簽章演算法 | 未指定 | 外部系統用 ES256 | 資料庫已有通過 Wycheproof 的 P-256 驗章；Ed25519 驗章要另寫一套 |
| (2) 對帳回報的新鮮度 | 「平台給的一次性亂數」 | 回報用簽發時間＋同一份只收一次；交付回應用一次性亂數 | 對帳回報是唯讀的整份快照，時間窗加唯一性就擋得住重送；對帳程式取回報時不必先向資料庫要亂數（也讓紅隊腳本 27 照原樣取回報）|
| (2) 較低等級的外部系統、每張單常設例外 | 要定義 | **沒做** | 目前唯一的外部系統（sim/dc）已到完整等級；沒有低等級的 adapter 可測 |
| (3) 「多出來的」屬於已知單 → 自動排撤回 | 已知單 | 已知、而且已不該有權限（撤銷、到期、失敗）的單才自動排撤回；生效中的單多出來的（例如後門多給欄位）只開例外並升級 | 撤回＝封存整張單：為了收回多出來的一個欄位而撤掉生效中的授權並永久封存，會切斷合法的存取。要自動收回得先有「重算到核准的那一版」的介面 |
| (4) 錨點不放在後端主機可寫的地方 | 獨立存放處 | 同一台主機、不同作業系統帳號；後端的帳號寫不了 | 模擬環境只有一台主機 |
| (5) 新 kid 出現而未信任時開例外 | — | 程式每分鐘同步：新的 RS256 金鑰立即信任並開例外（K-IDP-KEY-NEW）；不能信任的開 K-IDP-KEY-UNTRUSTED | 登入失敗的交易會回滾，不能在登入路徑上開例外；同步程式是唯一的入口 |
| 對帳的「不確定期」 | — | 撤銷、失敗的單不再有不確定期 | 高-2：撤回被擋下時要立刻看得到；誤報只在撤回送達前的幾秒，下一輪就結案（進鏈）|

## 4. 既有測試的調整（逐項原因；斷言沒有放寬）

| 測試 | 調整 | 原因 |
|---|---|---|
| sim/dc `harness.ts` | `putRuleSet`、`withdraw` 送簽過的信封（依環境用該環境的金鑰）；`testQuery`、`reconciliation` 回傳驗過證明的結果 | 介面改成信封＋證明 |
| sim/dc `01-apply` | 回應比對改看證明裡的結果 | 回應多了 `attestation` |
| sim/dc `02-change` | 「重送同一個撤回請求不會撤掉之後新套用的規則」改用部分撤回 | 整張撤回後封存，新版本本來就不收（D81）；冪等鍵的意圖改在部分撤回驗證。「撤回後重送同一版」加斷言：較新的一版也 409 `archived`；「不存在的單」加斷言：也封存 |
| sim/dc `03-signature`、`05-injection` | 本文改成信封 | 介面改成信封；斷言不變 |
| `93` | `item()` 由資料庫產生信封；分類改用 `delivery_verdict`（帶這筆的方法、路徑、摘要、亂數）；ORDER 多「封存後較新版也被拒」；`after` 的說明 | 分類需要這一筆的期待值；外部系統分實例 |
| `50` VERIFY-AUTO（外部系統說套用成功卻沒套用）| 說謊的外部系統改成「另一個帶證明的模擬外部系統」 | 沒有證明的假回應現在根本不被採信（只會重送）；要測的「外部系統自己說套用了」需要有效證明 |
| `50` RETRY | 503 與分類用帶證明的回覆（`dc.reply`）；分類多一列「撤回 409 → reject（由 delivery_report 轉成重送）」| 同上 |
| `50` RECON-EXTRA | 「撤回還在送：不確定期，不算多出來」改成「撤回還在送：每一項都是多出來的，不重複排撤回」；撤回完成後「同一批發現，不重複開」 | 高-2：撤銷的單不再有不確定期（§3）|
| `50` RECON-*、DIFFERENT | 回報由模擬外部系統簽；`{items:'x'}` 從丟 RECONCILIATION_INVALID 改成回 rejected／unverified | 回報不再由對帳程式決定；不收的回報要留下例外而不是回滾 |
| `delivery-lib.mjs` | `mockDc` 產生回應金鑰並登記（不退役 unit 實例的）| 證明要資料庫信任的金鑰 |

## 5. 攻擊腳本結束碼（在 `tools/run-all.sh --keep` 重建後的系統上，01–32 依序跑一次）

修前取自 findings-4 的「紅隊最後一次完整重跑」。

| 腳本 | 修前 | 修後 | 說明 |
|---|---|---|---|
| 01–19 | 0 | 0 | 不變 |
| 20 後端帶著全部金鑰 | 1 | **2** | 入口改變：腳本讀 `config.ts` 匯出的 `deliveryConfig.dbUrl`，交付的設定已搬進 `delivery.ts`（後端的設定模組裡沒有它），第一步就 `Cannot read properties of undefined (reading 'dbUrl')`。腳本接著以 root 呼叫 `loadConfig()`——那是操作者的讀法（建置、測試），以後端的作業系統帳號 `sgn-api` 執行時讀不到 `roles.env`、外部系統的密鑰（`95` #2），後端程序的記憶體裡也沒有它們（`95` heap snapshot）。以 root 讀主機上的檔案仍拿得到全部：同主機 root 是未解（§1）|
| 21 交付程式謊報 | 0 | 0 | 中途一次回 1：b（縮小後擋下新版）在新的對帳語意下被當成「不確定期」藏住；改成「生效中曾套用過的單以目前這一版為準」後回 0，並補 `50` 的對應測試 |
| 22 撤銷後送較新版 | 1 | 0 | 409 `archived`（封存）|
| 23 送到另一個環境 | 1 | 0 | 遮罩環境 401（不信任任何平台金鑰；信封的環境也不符）|
| 24 網路上的人 | 1 | 0 | 假的撤回回應不被採信（撤回仍在排）；經過 N 的對帳回報以證明為準，撤銷的單三項 K-RECON-EXTRA。N 仍截得到明文的 platform 金鑰（TLS 未解）|
| 25 開發金鑰 | 1 | 0 | 主機上沒有開發用私鑰；信任清單只有 `sgn-sgn_e2e` |
| 26 身分提供者換金鑰 | 0 | 0 | 金鑰更新程序常駐 |
| 27 對帳帳號掩蓋與灌爆 | 1 | 0 | 資料庫只看簽過的回報（後門照樣抓到）；重交同一份 → 不收（限速開一筆例外）|
| 28–31 | 0 | 0 | 不變（30 的 `ed25519_sign` 介面保留，見 §3）|
| 32 稽核頁的錨點 | 1 | 0 | 頁面的驗證程式直接向錨點存放處取錨點，腳本餵的偽造錨點不被使用 |

## 6. 部署必要項（不在這次範圍）

- **傳輸加密**：平台 ↔ 外部系統、對帳、身分提供者（JWKS）都要雙向 TLS（D81 (7)）。沒有 TLS 時 N 截得到 platform／auditor 金鑰與 Dex 的 JWKS（#2、#8）。
- **管理者帳號**：資料庫 superuser 不得以密碼經 TCP 登入（只限本機 peer）；開發環境的 `das_dev` 密碼是已知值（#3）。
- **主機分離**：後端、交付、對帳、錨點存放處、外部系統各自的主機；模擬環境只以作業系統帳號區隔，同主機 root 讀得到全部。
- 金鑰輪替：平台的交付簽章金鑰、外部系統的回應金鑰都只在建置時產生與登記；沒有執行期的輪替程序。

## 7. 怎麼執行與實測紀錄

```bash
tools/check.sh                 # 全部（以 root；sim/dc 兩個實例由 db/build.sh 啟動）
tools/run-all.sh --keep        # 背景程式以各自的帳號留著：.run/<程式>.log、.pid
sim/dc/test.sh                 # sim/dc 自己的測試
SIM_DC_INSTANCE=unit sim/dc/start.sh   # 只啟動 unit 實例
```

**乾淨狀態的 `tools/check.sh`（2026-11-20；停掉背景程式、`rm -rf .run` 之後，以 root）**：11 段全部通過（exit 0）。

| 段落 | 結果 |
|---|---|
| 安裝、格式、lint、型別、shellcheck、plpgsql_check、禁止字串、追蹤的檔案、npm audit | 通過 |
| sim/dc（新段落：格式、lint、型別、測試）| 通過，84／84（原 76；新增 `10-interface-level` 8 個；`02-change` 改寫 1、新增 0；見 §4）|
| 資料庫測試 | **244／244**（上一輪 220；新增 24：`95` 7、`96` 3、`93` 6、`50` 7、`40` 1；乾淨狀態另有 rule-coverage 通過）|
| 通行金鑰對照組 | 16／16 |
| 端對端 | **24／24**（新增 2：`z-anchor-store`）|

`tools/run-all.sh --keep` 之後各背景程式的作業系統帳號：`sgn-anchor-store`、`sgn-anchor`、`sgn-jobs`、`sgn-mailer`、`sgn-delivery`、`sgn-reconciler`、`sgn-idp-keys`、`sgn-api`、`sgn-web`（`ps -eo user,args`）。

## 8. 留給下一位

- 威脅表的未解：同主機 root（所有密鑰、兩邊的私鑰、錨點檔）；開發環境 superuser 的已知密碼；sgn_job 由四個程式共用；明文傳輸（N 截得到呼叫方金鑰、能讓平台信任假的身分提供者金鑰）；外部系統自己說謊；錨定程式的帳號被拿走時能寫「更新」的錨點。
- D81 (2) 的較低等級外部系統（沒有證明的介面）與每張單的常設例外：沒做。
- 生效中的單在外部系統上多出來的權限只開例外並升級，沒有自動收回（需要「重算到核准的那一版」的外部系統介面）。
- `docs/handoff/delivery.md` 的威脅表 #11、#12、#14 與 `docs/handoff/sim-dc.md` 的「信任清單」「test-credentials.env」說明已過時（不在我的範圍，沒有改），以本文件與 `sim/dc/README.md` 為準。
- 紅隊腳本 20 要配合新的入口改寫（例如以 `sgn-api` 帳號執行、讀 `loadProgramConfig('api')`）。
- 平台的交付簽章金鑰、外部系統的回應金鑰、錨點寫入金鑰都只在建置時產生；沒有執行期輪替的程序。
- `tools/run-all.sh` 與 `db/build.sh` 現在需要 root（作業系統帳號、檔案擁有者）；CI 要以 root 或可 sudo 的帳號執行。
