# 交接：紅隊第二輪的修復（redteam-fixes-2）

> **本檔寫於 2026-11-20，以下已過時：§0 的測試數字（162 個資料庫測試）；自認未解的項目（後續由 `redteam-fixes-3.md` 起處理）。仍有效：第二輪攻擊（`redteam/findings-2.md`）的修復紀錄仍有效。**

日期：2026-11-20。依據：`redteam/findings-2.md`、裁決 D65–D71（`docs/decision-log.md`）、`docs/handoff/redteam-fixes.md`。
範圍：`db/`、`api/`、`web/`、`e2e/`、`packages/contract/`、`tools/`、本文件。沒有改 `redteam/`、`sim/`。沒有 commit。

## 0. 結果一覽

| 項目 | 結果 |
|---|---|
| `tools/check.sh`（乾淨狀態） | **10 段全部通過**（exit 0），見 §7 |
| 資料庫測試 | **162／162**（上一輪 141；新增 21；既有的調整見 §5） |
| 通行金鑰 Node 對照組 | 16／16（沒動） |
| 端對端 | **15／15**（新增 2：主管背書通行金鑰、頁面與後端分開來源） |
| 攻擊腳本（`run-all.sh --keep` 剛建好的系統，依序 01→12） | 01–05、07、09、11 = **0**；06、08、10、12 = **2**（原因見 §6） |
| 同上，但在每支之間模擬冷卻期已過（§6） | 06、10 = **0**；08 = **1**（假陽性）；12 = **2** |

**順序**：每一項都寫了回歸測試，但和上一輪一樣是「測試與修法一起寫」，沒有先在修復前的程式上跑一次證明它會失敗（攻擊腳本本身在修復前是 1，見 `findings-2.md`）。

## 1. D68 挑戰值由瀏覽器算（高-2）——已做

- 公式（唯一來源 `sgn_internal.signing_challenge`，`db/kernel/250_signing.sql`；瀏覽器端 `web/lib/signing.js`）：
  挑戰值 = SHA-256(JCS({purpose, ref, content_sha256, decision, nonce}))，content_sha256 = SHA-256(JCS(內容))。
  用途：`case.decision`（ref＝單號、內容＝{版本雜湊, 輸入}）、`role_change.propose`（ref＝`new`）、`role_change.decision`（ref＝變更編號，決定 approve／block）、`passkey.enrollment`（ref＝登記編號，決定 endorse）。
- 資料庫只發 nonce（`challenge_issue`、`role_change_challenge`、`role_change_propose_challenge`、`passkey_endorse_challenge` 都只回 `{challenge_id, nonce, …}`），驗章的唯一入口 `sgn_internal.signature_verify` 用自己的紀錄重算。內容對不上是新代碼 `SIGNED_CONTENT_MISMATCH`。
- 角色變更的提出改成兩步加通行金鑰；舊的 `role_change_propose`、`role_change_approve_passkey` 刪除。
- 角色變更的內容含被指派人的 id **和畫面上的名字**、角色代碼**和名稱**：後端把下拉選單的「名字→id」對應換掉，簽章就對不上。
- 決定事件記下 `challenge`（實際簽的值）、`nonce`、`signed`（簽了什麼），稽核頁（`web/verify.js`）自己重算一次。
- 頁面與後端分開來源：`web/server.mjs`（`SGN_WEB_ORIGIN`，3001）只送 `web/` 的檔案並帶 CSP（`script-src 'self'`、`connect-src 'self' <後端>` 等）；後端（3000）不再送頁面，只回 JSON，CORS 只開給頁面來源並帶 cookie，帶別的 Origin 的 POST 一律 403；`GET /` 導回頁面來源。cookie：`HttpOnly; SameSite=Strict`（https 時加 `Secure`）。
- 每個決定事後寫一筆通知給決定者本人（`decision.recorded`，只進待寄送佇列）。
- 測試：`81-signing`（公式跨語言一致、情境 1、換內容四種、情境 2、low-s、冷卻期、競態）、端對端「D68 頁面與後端分開來源」。

## 2. D65 通行金鑰登記（高-3）——已做

- `260_passkey_enrollment.sql`。`passkey_register`（身分提供者再驗證，簽章不變）只建立**待核准的登記**；金鑰要經 `passkey_endorse_passkey`（用途 `passkey.enrollment`，內容綁定指紋與六位數短碼）核准：本人用已生效的舊金鑰，或第一把由本人的主管（找主管的唯一入口，含冷卻期）或持有 `passkey.registrar_role` 的人背書；背書人不得是本人、不得持有不能做決定的角色。核准後過 `passkey.cooling_workdays`（預設 1 營業日）才能簽章（`PASSKEY_NOT_ACTIVE`）。登記、背書、生效都進鏈，並通知本人與主管。
- 授權是 `denial_reason` 的第三個重載（`sgn.passkey_enrollment`），維持「授權只有一個入口」。
- 第一位登記人：`sgn_internal.passkey_bootstrap`（只有 owner，只能一次）。開發與驗收：`db/tools/bootstrap-registrar.mjs` 在建置時以 `SGN_SEED_REGISTRAR`（p30 江佩玲）建立，軟體金鑰存在 `.run/registrar-<資料庫>.json`。
- 畫面：登記後顯示短碼（這個瀏覽器從自己的公鑰算）；首頁「待核准的通行金鑰登記」→ `#passkeys`，背書人畫面從指紋自己算短碼。
- 測試輔助：`harness.registerPasskey` 走完整流程（登記人背書＋以管理者連線模擬冷卻期已過）；e2e 的 `ensurePasskey` 在畫面上登記、核對短碼、由登記人背書。測試：`82-passkey-enroll`、端對端「第一把通行金鑰由主管背書」。

## 3. 高-1、D70——已做

`280_directory_guard.sql`：
- `resolve_manager`：取最近一條已生效的關係（不論主管在不在職）；主管不在職就往上一層；都沒有就不用未生效的關係（只有基準之後才由同步新增的人例外，`person.joined_after_baseline`）。
- 停用門檻改為 `directory.deactivation_window_hours`（預設 24）內累計（已停用＋已延後，含增量）。停用本身仍立即。
- 恢復在職、改姓名、改 email 進冷卻期並開 `K-HR-SYNC` 例外（`sgn.person_change`），目錄改回就取消，到期由同步或排程套用。`directory_apply_due` 改回傳兩種筆數。
- 同步新增人員寫 `directory.person_added`。
- 畫面上的姓名唯一入口 `person_name` 遇到同名的在職人員加上 email；`waiting_on`、`applicant_name` 改用它。
- 排程接上：`db/tools/jobs.mjs`（run-all 每 60 秒跑 `directory_settle`、`auth_challenge_purge`）。
- 測試：`79-directory-sync`（高-1 回歸、時間窗累計、改名同名、恢復在職冷卻、新增人員進鏈）。

## 4. D69 角色指派變更（高-4）——已做

`270_role_change_governance.sql`，規則都是資料：
- 核准人不得持有被變更的角色（`ROLE_CHANGE_SAME_ROLE`），登記時核准人角色不得是角色本身（檢查條件）；控制負責人改由董事長核准。
- 經手人排除改成對照表 `sgn.role_change_excluded`；稽核治理人：流程管理、控制負責人、技術維運不得經手。
- 衝突矩陣 `sgn.role_conflict`（骨幹 18.2；稽核對所有非業務角色除稽核主管），提出與核准都檢查（`ROLE_CONFLICT`）。
- 範圍：`sgn.scope_registry`（流程包的主題包由觸發器登記；受管系統由開發種子登記；`process:<流程類型>` 免登記），提出人與核准人的範圍要涵蓋。
- 業務類角色不能在平台內指派（`ROLE_CHANGE_SOURCE`）。
- 必要角色（`sgn.role.required`）不得撤最後一位（`ROLE_LAST_HOLDER`）。
- 要冷卻的角色（`sgn.role.change_cooling`，目前是治理類）核准後 `role_change.governance_cooling_workdays` 才生效，通知全部治理類持有人，期間內任一人以通行金鑰擋下（`block`）。
- 測試：`78-role-source`（K-ADMIN-SOD、高-4 回歸 a–d、自我繁殖、冷卻與擋下）。

## 5. D71——已做

- 登入：資料庫限制未用的登入挑戰值總數（`auth.login_pending_max`）；每個來源每分鐘次數（`auth.login_attempts_per_minute`，預設 30）由後端擋，參數由 `api.frontdoor_policy` 啟動時讀。
- `api_job.auth_challenge_purge` 清除過期挑戰值（`auth.challenge_retention_hours`）。
- 登入頁只收錯誤代碼：後端回呼只帶代碼，`GET /errors` 給錯誤目錄的文字，頁面查不到就不顯示。
- 離線驗證（`db/tools/chain-lib.mjs`）回報 `unanchored`（筆數、最舊一筆多久），超過 `audit.anchor_max_lag_events`／`audit.anchor_max_lag_seconds` 或完全沒有錨點即 `ANCHOR_LAG`。開發環境（`db/build.sh`）設 30 秒（錨定每 2 秒）。
- 簽章只收 low-s；瀏覽器（`web/webauthn.js`）與測試的軟體驗證器送出前換成 low-s。
- 測試：`83-frontdoor`、`81-signing` 的 low-s。

## 5'. 既有測試的調整（逐項原因）

| 測試 | 調整 | 原因 |
|---|---|---|
| 30 | 兩處 `PASSKEY_INVALID` → `SIGNED_CONTENT_MISMATCH` | 挑戰值不符有了自己的代碼；攻擊照樣被擋 |
| 40、50 | 不改；`db/testing/` 的 (b)(c) 改成驗同一個公式算出的挑戰值 | 比較用的架構跟著 D68 |
| 60 | 先錨定再全量驗證；整個檔案把時間門檻放寬到 3600 秒 | 沒有錨點即判失敗（D71）；這個檔案測竄改，不是錨定停擺 |
| 76、packs/20 | `ch.binding.input` → `ch.input` | 回傳不再有 binding |
| 78 | 改用 harness 的 `proposeRole`／`decideRole`；「被指派的人不能核准」改為斷言 `ROLE_CONFLICT` | 提出要金鑰；稽核治理人持有稽核角色本身違反衝突矩陣，情境在提出時就被擋 |
| 79 | 改名、恢復在職的斷言改為冷卻期；單人停用的測試把時間窗設 0 | D70 |
| 80 | origin 改頁面來源、背書、low-s | D65、D68、D71 |
| 90 | 結構檢查涵蓋新路由；授權錯誤代碼清單加 5 個 | 新入口 |
| e2e | 頁面網址、`callApi` 打後端來源、`ensurePasskey`、提出角色要按確認、偽造簽章改用正確算出的挑戰值、cookie 的 url | D65、D68 |

## 6. 攻擊腳本

依序對剛建好的系統跑：01、02、03、04、05、07、09、11 = 0；06、08、10、12 = 2。

- **入口改變，腳本的「合法流程」不存在了**：`00-lib.mjs` 的 `decide`／`approve` 簽的是 `ch.challenge`（後端給的值）。D68 之後後端不給可以直接簽的值——而「瀏覽器簽後端給的值」正是 04 情境 1 的攻擊本身，兩者在資料庫看來位元組完全相同，沒有任何設計能讓 00-lib 的合法流程成功、04 又被擋下。所以：
  - 02、04、07 回 0 的直接原因是入口或公式改變（02 的合法基準也失敗；07 的提出全部是 42883）。攻擊不成立的實質證據在資料庫測試：`81-signing`（04 兩個情境）、`78-role-source`（07 的 a–d）。
  - 08 回 1 是**假陽性**：R2 五次全部 `SIGNED_CONTENT_MISMATCH`，「只能生效一次」變成「零次」。新協定下的同一組競態在 `81-signing` 最後一個測試：5 次只生效 1 次；核准與駁回只有一個生效。
  - 12 回 2：第一個 `decide` 沒包在 attempt 裡。K-SOD-DISTINCT 的資料庫測試照舊通過。
- **06、08、10 的 2（PERSON_UNKNOWN）**：05 收尾時用同步「恢復」p03，D70 讓恢復進冷卻期，p03 一個營業日內是停用的，之後的腳本登入不了。以管理者連線模擬冷卻期已過（套用到期異動）後重跑：06 = 0（五人拆開送全部延後、例外 5 筆、改名沒有生效）、10 = 0（22 項全擋）。
- 下一輪紅隊依 D67 把 00-lib 改成新入口（扮演瀏覽器的計算可以直接用 `db/tests/kernel/lib/harness.mjs` 的 `issueChallenge`、`proposeRole`、`decideRole`、`endorse`）。

## 7. 怎麼執行

```bash
tools/check.sh
tools/run-all.sh --keep     # 頁面 http://localhost:3001，後端 http://localhost:3000
node redteam/exploits/NN-*.mjs
```

**從乾淨狀態執行（2026-11-20）**：停掉後端、錨定、排程、頁面伺服器，`rm -rf node_modules .run`（沒有執行 `sim/down.sh`，以免動到 sim/dc），`tools/check.sh` → 10 段全部通過；資料庫 162／162、對照組 16／16、端對端 15／15。

## 8. 和裁決、文件不一致的地方

| 項目 | 依據 | 現在 | 理由 |
|---|---|---|---|
| 稽核治理人由誰核准 | D69「由稽核線核准」 | 稽核主管提出、董事長核准 | 稽核線的人都持有稽核角色，而持有稽核角色的人不得做任何決定（K-AUDITOR-INDEPENDENT、`approval.excluded_decider_roles`）；骨幹說稽核治理人由董事會或審計委員會指定。請裁決 |
| 控制負責人由誰核准 | 骨幹與上一輪預設：控制負責人 | 董事長 | D69 不得自我繁殖 |
| 「簽章只接受 low-s」 | D71 | 資料庫只收 low-s，瀏覽器送出前換算 | 真的驗證器的 s 是隨機的，直接拒收一半的簽章不能用 |
| 「以完整性雜湊鎖定」頁面程式 | D68 配套 (1) | 只做了分開來源與 CSP，沒有 SRI | ES module 的 import 沒有 SRI；同一個靜態伺服器送的 SRI 不增加保護 |
| D68 配套 (3)「下一關行動前可撤回」 | D68 | 只做了事後通知決定者 | 範圍外，見 §9 |
| `SGN_RP_ORIGIN` 的名字 | 原本是頁面兼後端 | 現在只是後端（身分提供者登記的回呼在這裡）；WebAuthn 的 origin 是新的 `SGN_WEB_ORIGIN` | 不改 sim/ 的回呼設定與紅隊腳本 |
| 業務角色由平台指派 | 上一輪允許 | `ROLE_CHANGE_SOURCE` | D66、D69：業務類由同步帶入 |
| 設計文件 `docs/api.md`、`docs/sql-functions.md`、`docs/contract/` | — | 仍寫舊的挑戰值、提出、登記 | 不在我的範圍 |

## 9. 沒做到的、殘餘風險

- D68 (3)：決定「下一關行動前可撤回」沒做（只寫了通知）。通知只進佇列，沒有寄送。
- 角色變更沒有駁回、撤回、到期；冷卻期結束後狀態仍是 `cooling`（以 `effective_at` 判斷）。
- 通行金鑰沒有撤銷與「遺失裝置」的停用；舊環境（這一版之前登記的金鑰）照舊視為已生效。
- 名字對應：申請單上的名字（被授權者、申請人）不在簽的內容裡，被入侵的後端仍可以在頁面上換名字（id 與內容雜湊換不了）。角色變更與背書有把名字簽進去。
- 每個來源的登入次數限制在後端記憶體；拿到後端的人可以不擋（資料庫的總數上限仍在）。
- 頁面與後端都在 localhost，同一個「site」；正式環境要不同主機並用 https（cookie 會帶 Secure）。
- 開發環境的錨點落後門檻 30 秒；正式環境的預設 3600 秒要依錨定頻率設。

## 10. 另外發現的同類問題

| 問題 | 處理 |
|---|---|
| 紅隊腳本的收尾依賴「同步可以立即恢復在職」，D70 之後在 e2e 資料庫留下停用的人 | 記在 §6；需要紅隊腳本或環境提供「模擬時間經過」 |
| 審計頁的事件標籤沒有 passkey 新事件 | 已補 i18n |
| 稽核主管同時持有稽核角色，所以所有「由稽核線核准」的設計都會撞到 K-AUDITOR-INDEPENDENT | §8 第一列，待裁決 |
