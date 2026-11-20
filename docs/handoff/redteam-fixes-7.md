# 交接：紅隊第七輪的修復（redteam-fixes-7）

日期：2026-11-20。依據：`redteam/findings-7.md`、裁決 D88（背景 D84–D87）、`docs/handoff/redteam-fixes-5.md`、`redteam-fixes-6.md`。
範圍：`db/`、`api/`、`web/`、`e2e/`、`packages/contract/`、`tools/`（沒有改）、本文件。
沒有改 `redteam/`、`docs/packs/*/rules.md` 與其他文件；沒有 commit、沒有 push。

## 0. 結果一覽

（`91`＝`db/tests/kernel/91-passkey-recovery.test.mjs`、`92`＝`92-program-stall.test.mjs`、`50`＝`db/tests/packs/data_access/50-delivery.test.mjs`、
e2e `path`＝`e2e/tests/path.test.mjs`）

| D88 | 項目 | 結果 | 測試 |
|---|---|---|---|
| (1) | 撤銷某人金鑰的人，期間內（`passkey.recovery_window_days`＝30）不得背書同一人的新金鑰（主管與登記人都適用） | 做了 | `91` K-PASSKEY-RECOVERY；`87` K-PASSKEY-REVOKE（改）；`90`（改）；e2e `path` K-PASSKEY-REVOKE K-PASSKEY-RECOVERY |
| (1) | 被別人撤銷之後才登記的新金鑰：冷卻期加長（`passkey.recovery_cooling_workdays`＝5）、當場開例外 K-PASSKEY-RECOVERY、通知本人、主管與治理類角色 | 做了 | `91` K-PASSKEY-RECOVERY；e2e `path` 同上 |
| (1) | 冷卻期內本人只憑登入回報「不是我登記的」：金鑰立即撤銷、開例外 K-PASSKEY-NOT-ME；上限（`passkey.not_me_max`＝2／`passkey.not_me_window_days`＝30）；畫面入口 | 做了 | `91` K-PASSKEY-NOT-ME；`90` 契約；e2e `path` K-PASSKEY-NOT-ME（3 步）|
| (2) | 可用的登記人少於 `passkey.registrar_min`（預設 2）開例外 K-REGISTRAR-MIN 並通知 | 做了 | `91` K-REGISTRAR-MIN |
| (2) | 全公司只憑登入的停用在時間窗內有上限（`passkey.suspend_global_max`＝10／`passkey.suspend_global_window_hours`＝24），超過拒絕並開例外 K-PASSKEY-SUSPEND-FLOOD | 做了 | `91` K-PASSKEY-SUSPEND-FLOOD |
| (2) | 模擬環境補第二位登記人（與第一位互不為主管） | 做了（p24 葉佳蓉；p24 的主管 p23、p30 的主管 p15）| `91` K-REGISTRAR-MIN 第一個斷言；`82`（改）|
| (2) | 破窗寫進文件 | 做了（§4）；安裝儀式只在可用的登記人少於下限時能執行 | `91` K-REGISTRAR-MIN（G4）|
| (3) | 每個背景程式各用自己的角色、自己的函式回報心跳 | 做了（6 個程式、6 個函式）| `92` K-PROGRAM-STALLED 第一個 |
| (3) | 其他每個程式的迴圈與稽核頁都檢查「誰沒回報、最舊的逾期工作多久了」，超過參數開 K-PROGRAM-STALLED 並通知 | 做了 | `92` ×4 |
| (3) | 首頁與單的頁面對逾期未處理的單顯示警示（資料庫算） | 做了（`overdue` 欄位）| `92` 第三個；e2e `path` K-PROGRAM-STALLED |
| (4) | K-GOVERNANCE-KEY、K-PASSKEY-SUSPEND-HOLDER 狀況解除時結案；去重只看未結案的；種子階段的舊例外能被結案 | 做了（通用的結案入口 `sgn_internal.exception_close`，新規則代碼 K-EXCEPTION-CLOSE）| `91` K-EXCEPTION-CLOSE、K-REGISTRAR-MIN（G3）|
| (5) | 標記已套用與申請人確認時檢查授權迄日，已過就走到期 | 做了（新規則代碼 K-GRANT-LATE）| `50` K-GRANT-LATE |

## 1. 威脅小表（動手前寫；每列對應「拿掉這道防線就會失敗」的測試）

起點沿用 findings-7：A 一般員工（含主管、登記人本人）、B 後端程序、D 排程／對帳帳號、F 交付程式、G 金鑰同步帳號（可偽造任何人的登入）、
H 錨定程式、M 寄信程式、N 網路。欄位：誰能寫它／能否回捲／空值、零筆、極大值／舊但仍有效的輸入／它停掉時誰知道。

| 列 | 新增或改動的機制 | 誰能寫它 | 能否回捲 | 空值／零筆／極大值 | 舊但仍有效的輸入 | 它停掉時誰知道 | 測試（拿掉就失敗） |
|---|---|---|---|---|---|---|---|
| R1 | 撤銷的人不得背書（授權入口 `denial_reason`，看 `sgn.passkey_revocation`）| 只有簽的撤銷（`passkey_revoke_all`）寫撤銷紀錄；B、G 寫不到表 | 撤銷紀錄只增；過了期間（參數）自然失效 | 期間參數 0＝立即失效（等於拿掉防線，參數改變進設定表、只增不改）；極大＝那個人永遠不能背書這個人 | 挑戰值發出後才撤銷：簽的那一步再授權一次；撤銷前就排好的登記，撤銷時一律作廢 | 防線本身不會「停」：它是授權判斷；被拒時本人與主管都已收到撤銷通知 | `91` R1：主管與登記人各被 PASSKEY_ENDORSER_REVOKER 擋下；`87`、e2e 同 |
| R2 | 復原金鑰：冷卻加長、例外、通知（`enrollment_activate`）| 背書的人（主管或登記人，用自己的金鑰）| 金鑰撤銷即失效；例外與通知進鏈不可收回 | 冷卻參數 0＝立即可簽（參數變動留在設定表）；沒有撤銷紀錄＝一般冷卻 | 期間過了才登記的：回到一般冷卻、不開例外（`91` R3）| 例外與通知；寄信程式停了仍有站內例外，且 K-PROGRAM-STALLED 會發現寄信停擺 | `91` R2：usable_from 等於加長的冷卻、K-PASSKEY-RECOVERY、通知對象逐一比對 |
| N1–N4 | 本人「不是我登記的」（`api.passkey_report_not_me`）| 只憑登入：本人，或冒用登入的 G／B | 撤銷不可回捲（只會收回）| 沒有可回報的 → PASSKEY_NOT_ME_NONE；上限 0＝不能回報（參數）；極大＝G 可以一直作廢合法的新金鑰 | 已過冷卻期的、本人用舊金鑰核准的都不能回報 | 回報開例外並通知本人、主管、背書人與治理角色 | `91` N1–N4；`90` 契約；e2e K-PASSKEY-NOT-ME |
| N-G | 「不是我」被 G 冒用：作廢合法的新金鑰 | G | — | 每人 30 天 2 次（參數）：G 最多讓一個人的重新登記失敗 2 次，第三次起合法的金鑰留得住；每次都通知本人與主管、開例外 | 回報後重新登記只能當面掃 QR（同只憑登入的撤銷）| 例外與通知（本人收到「你回報了不是你」卻沒做，就知道被冒用）| `91` N3（PASSKEY_NOT_ME_LIMIT）|
| G1–G3 | 登記人下限（`registrar_min_check`）| 角色指派與金鑰狀態的變化；例外只由資料庫開與結 | 例外結案進鏈，不可刪 | 下限 0＝不檢查（參數）；持有不能做決定的角色的登記人不算可用 | 例外開著時狀況已解除：下一次檢查（排程、停用、撤銷、恢復、回報不是我）結案 | 停用、撤銷、回報、恢復當場檢查；排程每輪檢查。排程停了 → K-PROGRAM-STALLED | `91` G1–G3 |
| G4 | 破窗（安裝儀式 `passkey_bootstrap`，資料庫擁有者）| 只有擁有者（沒有授權給任何執行期帳號）| 進鏈（`passkey.bootstrapped`）；之後可由登記人撤銷 | 可用的登記人達到下限時拒絕（PASSKEY_BOOTSTRAP_DONE）| — | 事件在鏈上、稽核頁看得到 | `91` G4：下限以上被拒、後端帳號沒有權限、少於下限時可以 |
| F1–F3 | 全公司停用上限（`passkey_suspend_all`）| 只憑登入的停用（本人或 G）| 拒絕不改任何狀態；例外進鏈 | 上限 0＝全部拒絕；極大＝等於沒有上限。拒絕時回 refused（要留下例外，所以不丟錯）| 時間窗內的停用紀錄被管理者刪掉（測試準備）會讓窗內次數變少——只有擁有者做得到 | 例外與通知；窗內次數回到上限以下時排程結案 | `91` F1–F3 |
| F-G | 停用上限被 G 用滿：之後真的遺失裝置的人不能只憑登入停用 | G | — | 擋住的是「只憑登入」這條；主管或登記人用金鑰簽的撤銷不受影響 | — | 開例外並通知稽核主管、資安長 | `91` F1（refused 時仍有例外）|
| E1–E4 | 例外結案（`exception_close`、`holder_key_exceptions_settle`）| 只有資料庫的檢查（排程、恢復、停用與撤銷前）；架構測試確認沒有別的 function 改寫例外 | 結案進鏈；不重開舊的，再出事開新的 | 沒有未結案的 → 照常開；種子階段的舊例外由同一個檢查結案 | 狀況已用別的方式解除、排程還沒結：停用與撤銷之前先結掉，新事故開新的一筆（`91` E2 第二段）| 排程停了 → 結案延後（不影響開新的：停用與撤銷前會先結）；K-PROGRAM-STALLED 會發現排程停擺 | `91` E1–E4 |
| S1 | 心跳（各程式自己的角色、自己的函式）| 每個程式只能執行自己的那一個（路由表的允許清單）| 心跳只記時間，不影響任何決定 | 從沒回報過：從「登記時」與「第一個程式開始回報時」較晚者算起 | 很久以前的心跳 → 逾時 | 別的程式的心跳與稽核頁 | `92` S1：別的程式的心跳函式一律沒有權限 |
| S2–S3 | 存活檢查（`program_stall_check`）| 只有資料庫依自己的表判斷；程式只能觸發 | 例外結案進鏈 | 間隔參數（預設 10 秒，心跳觸發的最少間隔）；逾時參數依程式、依工作種類 | 被檢查的程式停了，其他程式照樣檢查；只做事不報心跳 → 心跳逾時；只報心跳不做事 → 逾期工作 | 所有程式都停了：只有稽核頁（列 S4）與頁面上的警示（列 S5）| `92` S2、S3 |
| S4 | 稽核頁觸發（`api.program_health`，只限稽核角色）| 稽核角色 | 同上 | — | — | 沒有人打開稽核頁就沒有主動訊號（未解，見 §5）| `92` S4 |
| S5 | 單上的警示（`case_summary.overdue`，資料庫算）| 沒有人寫：從授權、確認、交付的資料算出 | — | 沒有逾期 → null | 已處理掉的 → 消失 | 頁面每次打開都重算 | `92` S5；e2e K-PROGRAM-STALLED |
| L1 | 授權迄日（`case_advance`、`case_confirm_verification` 的 `grant_lapse`）| 執行人標記、交付回報、申請人確認都會走到 | 走到期之後不能再確認或標記（狀態轉移表）| 沒有迄日 → 不算過期（同排程的到期）| 迄日在開確認之後才過：申請人確認時再看一次 | 不靠排程：生效的那一刻就看 | `50` K-GRANT-LATE |

## 2. 做了什麼（檔案）

資料庫（都是新檔，以同簽章替換既有 function；沒有改已套用的 migration）：

- `db/kernel/515_exception_close.sql`：`sgn.exception_record` 加 `closed_at`、`closed_seq`、`close_detail`；結案入口 `exception_close`（進鏈 `exception.closed`）；
  `holder_key_exceptions_settle`；`governance_key_check`、`passkey_suspend_flag` 改成只看未結案的；`api.audit_exceptions` 多 `closed_at`。
- `db/kernel/520_passkey_recovery.sql`：授權入口兩個版本（登記的背書、以人為對象）；`enrollment_activate`（復原）；`api.passkey_not_me_list`、
  `api.passkey_report_not_me`（表 `sgn.passkey_disowned`）；`registrar_available`、`registrar_min_check`；`passkey_suspend_all`（全公司上限、refused）；
  `passkey_revoke_all`、`passkey_restore_step`（之後檢查）；`passkey_bootstrap`（少於下限才能執行）；`api_job.governance_check`；`api.me`（`passkey_disownable`）。
- `db/kernel/525_program_liveness.sql`：`sgn.program`（6 個程式）、`sgn.program_check`；`overdue_work`（逾期工作的唯一來源）、`case_overdue`；
  `program_stall_check`、`program_heartbeat`；6 個心跳函式（`api_job.scheduler_heartbeat`、`mailer_heartbeat`、`reconciler_heartbeat`、`anchor_heartbeat`、
  `api_delivery.delivery_heartbeat`、`api_idp.idp_keys_heartbeat`）；`api.program_health`；`case_summary` 多 `overdue`。
- `db/kernel/530_grant_late.sql`：轉移表 `pending_fulfilment`／`verifying` → `expired`；`case_terms_lapsed`、`grant_lapse`；`case_advance`、
  `api.case_confirm_verification`。
- 新規則代碼（`sgn.rule`）：K-PASSKEY-RECOVERY、K-PASSKEY-NOT-ME、K-REGISTRAR-MIN、K-PASSKEY-SUSPEND-FLOOD、K-EXCEPTION-CLOSE、K-PROGRAM-STALLED、K-GRANT-LATE；
  K-GOVERNANCE-KEY、K-PASSKEY-SUSPEND-HOLDER 改成 full（有結案）。新參數與錯誤代碼見各檔開頭。

其他：

- 路由表（`packages/contract/src/routes.ts`）：新路由 `passkey_not_me_list`、`passkey_report_not_me`、`program_health`；6 個心跳加進各程式的允許清單；
  `caseFields.overdue`、`me.passkey_disownable`、`suspensionResult.refused`、`audit_exceptions.closed_at`。
- 程式：`db/tools/jobs.mjs`（不用改：心跳在 `schedulerCalls` 的第一個）、`api/src/mailer.ts`、`api/src/delivery.ts`、`api/src/reconciler.ts`、
  `db/tools/anchor.mjs`、`db/tools/idp-keys.mjs` 每一輪先回報心跳（失敗不擋住本來的工作）。
- 第二位登記人：`db/sgn.env` 的 `SGN_SEED_REGISTRAR_2=p24`；`db/tools/bootstrap-registrar.mjs` 依序建立兩位，金鑰存在 `.run/registrar-<資料庫>.json`（第二位在 `others`）；
  `db/tests/kernel/lib/harness.mjs` 的 `oldKey` 認得它；`e2e/tests/lib/ui.mjs` 的 `useInstalledRegistrarKey` 把它放進瀏覽器的虛擬驗證器。
- 頁面：`web/pages/passkeys.js`（「冷卻期內的新金鑰」區塊與「不是我登記的」、停用被拒時顯示資料庫的訊息）；`web/decide.js`（冷卻提示多一個連結）；
  `web/pages/home.js`（卡片的逾期警示、稽核首頁的背景程式狀態、例外的結案時間）；`web/pages/case.js`、`web/pages/audit.js`（逾期警示；稽核頁的背景程式狀態）；`web/i18n.js`。

## 3. 和 D88 不同的地方、與要求不同的地方

| 項目 | D88／要求 | 這裡 | 理由 |
|---|---|---|---|
| (1) 「不是我」的範圍 | 冷卻期內（被別人撤銷之後的新金鑰）| 任何「別人背書、還在冷卻期」的新金鑰（第一把金鑰的路徑都算）| 第一把金鑰被騙背書是同一種威脅；本人用自己舊金鑰核准的不算（G 做不到）|
| (1) 「不是我」之後 | — | 也寫一筆本人只憑登入的撤銷紀錄：重新登記只能當面掃 QR | 沿用 `passkey.reenroll_after_unsigned_revocation`（不另寫一套）|
| (2) 停用超過上限 | 拒絕並開例外 | 不丟錯，回傳 `refused`（訊息來自錯誤目錄），頁面顯示它 | 丟錯會連例外一起回捲（沒有自主交易，擴充套件只用 pgcrypto）|
| (2) 破窗 | 仍是資料庫擁有者的安裝儀式 | 安裝儀式的條件從「沒有任何登記人」改成「可用的登記人少於下限」 | 只剩一位登記人時，擁有者就能補第二位，不必等到一位都不剩；第二位種子也走同一個儀式 |
| (2) 可用的登記人 | 持有登記人角色且有可用金鑰 | 再排除持有不能做決定的角色（稽核、技術維運）的人 | 那種人背書會被授權入口擋下，算進去等於虛報 |
| (3) 稽核頁觸發 | 稽核頁 | 新路由 `api.program_health`（不叫 `audit_*`）| `api.audit_*` 是唯讀（`70` 的架構測試斷言 stable）；這個會開例外與結案，不能偽裝成唯讀的稽核讀取 |
| (3) 心跳觸發的檢查 | 每一輪 | 每一輪都報心跳；檢查最少間隔 `program.stall_check_interval_seconds`（10 秒）| 交付程式每秒一輪；每秒全掃一次沒有必要。稽核頁不受間隔限制 |
| (3) 從沒回報的程式 | 「誰沒回報」| 從「登記時」與「第一個程式開始回報時」較晚的算起 | 建置之後、程式啟動之前（資料庫測試要跑幾分鐘）不該全部判停擺；所有程式都沒啟動過時仍從登記時算 |
| (3) 檢查做什麼 | 開例外並通知 | 只開例外與通知，不替停擺的程式做它的工作 | 各程式的角色只能做自己的事（D84 (6)）；寄信程式的角色不該能讓授權到期 |
| (4) 停用、撤銷前先結案 | 去重只看未結案的 | 停用與撤銷前先對當事人跑一次結案檢查 | 狀況已用別的方式解除、排程還沒結時，新事故不會被舊的那筆吃掉（紅隊腳本的還原就是這種情況）|
| (5) 人工執行的過期 | 已過就不生效 | 走到期之外，再開 K-DELIVERY-MANUAL（event `lapsed`）通知管理人去拿掉 | 執行人已經在外部系統上設好了；到期（`expired`）原本不通知人工系統 |

## 4. 破窗：資料庫擁有者的安裝儀式

- 什麼時候用：可用的登記人少於 `passkey.registrar_min`（K-REGISTRAR-MIN 開著），而且平台內沒有人能恢復——例如 findings-7 中-1 的死結
  （登記人與他的主管同時被停用，第二位登記人也不可用）。可用的登記人在下限以上時，資料庫拒絕（PASSKEY_BOOTSTRAP_DONE）。
- 誰執行：資料庫擁有者（`sgn_owner`），只能經管理者連線（本機 peer，D84 (1)）。`sgn_internal.passkey_bootstrap` 沒有授權給任何執行期帳號（`91` G4、`82`）。
- 怎麼做：`db/tools/bootstrap-registrar.mjs` 是開發環境的版本（軟體金鑰）；正式環境由擁有者在登記人本人面前，以登記人的真驗證器產生公鑰
  （credential id 與 SPKI），再以擁有者身分執行 `select sgn_internal.passkey_bootstrap(<人員 id>, <credential id>, <SPKI>, '<原因與見證人>')`。
  原因欄寫明 K-REGISTRAR-MIN 的例外編號與見證人。
- 誰見證：至少兩人在場——資料庫擁有者以外的稽核主管（或其代理）與資安長（或其代理），任一人是當事登記人時換人；擁有者不得是被指派的登記人本人。
  見證紀錄（日期、在場者、例外編號、執行的 SQL）由稽核主管保存在平台以外。
- 留下什麼紀錄：鏈上的 `passkey.bootstrapped`（人員、角色、金鑰指紋、原因、儀式前可用的登記人、參數）與 `passkey.registered`；
  登記人角色的指派（`change_event_seq` 指向儀式事件）；K-REGISTRAR-MIN 結案（`exception.closed`）。稽核頁看得到這些事件。
- 之後：被停用的人照一般流程恢復（本人原金鑰＋新的登記人背書）；儀式建立的登記人若只是臨時補位，事後由角色變更流程撤除並進鏈。

## 5. 威脅表裡自認未解的

- 兩位能背書的人串通（一人撤銷、另一人背書）再加 G，仍可接管（D88 接受的殘餘）：只有事後的 K-PASSKEY-RECOVERY、加長的冷卻期與「不是我」。
- 「不是我」被 G 冒用：每人每 30 天最多讓合法的重新登記失敗 2 次（N-G）；之後要靠主管或登記人當面處理。
- 停用上限被 G 用滿：其他人當天不能只憑登入停用（F-G），要主管或登記人用金鑰撤銷；有例外與通知。
- 所有背景程式都停了、而且沒有人打開稽核頁：沒有主動訊號（K-PROGRAM-STALLED 的 partial）；頁面上的逾期警示仍在。寄信程式停了時通知寄不出去，
  例外仍在資料庫（站內）。
- 心跳只證明「程式還在跑、資料庫連得上」，不證明它把工作做對；做不對由逾期工作的檢查與既有的例外（交付卡住、對帳）發現。

## 6. 既有測試的調整（逐項原因；斷言沒有放寬）

| 測試 | 調整 | 原因 |
|---|---|---|
| `82` K-PASSKEY-ENROLL 安裝儀式 | `passkey.bootstrapped` 事件 1 筆 → 2 筆；標題改成「可用的登記人少於下限時才行」| D88 (2)：種子建立兩位登記人；「下限以上被拒」的斷言保留 |
| `87` K-PASSKEY-SUSPEND | 停用事件的 rules 多 K-PASSKEY-SUSPEND-FLOOD | 每次停用都檢查全公司上限，事件寫明用到的規則與參數 |
| `87` K-PASSKEY-REVOKE 主管替部屬撤銷 | 重新登記原本由撤銷的主管背書，改成先斷言主管被 PASSKEY_ENDORSER_REVOKER 擋下，再由登記人背書 | D88 (1)（加嚴）|
| `90` 契約 | 登記人撤銷之後改由第二位登記人背書；多檢查 `passkey_not_me_list`、`passkey_report_not_me`、`program_health` 的回傳結構 | D88 (1)；新路由都要真的呼叫 |
| e2e `path` K-PASSKEY-REVOKE | 撤銷的田中美咲不能背書（清單沒有、直接打後端 PASSKEY_ENDORSER_REVOKER），改由登記人葉佳蓉在畫面上掃 QR 背書；多斷言復原的例外與「不是我」的入口 | D88 (1) |
| e2e `path` | 新增 K-PROGRAM-STALLED（暫停排程時首頁與單的頁面顯示逾期警示）、K-PASSKEY-NOT-ME（步數）| D88 (3)、(1) 的畫面 |

## 7. 實測（2026-11-20，以 root）

### `tools/check.sh`（停掉背景程式、`rm -rf .run`）

| 段落 | 結果 |
|---|---|
| 安裝、格式、lint、型別、shellcheck、plpgsql_check、禁止字串、追蹤的檔案、npm audit、sim/dc | 通過 |
| 規則代碼覆蓋 | 101 個（上一輪 94；新增 7 個）|
| 資料庫測試 | **284／284**（上一輪 274；新增 `91` 5、`92` 4、`50` 1）|
| 通行金鑰對照組 | 16／16 |
| 端對端 | **32／32**（上一輪 30；新增 K-PROGRAM-STALLED、K-PASSKEY-NOT-ME）|
| 結果 | 全部通過（exit 0）|

第一次跑 check 時端對端 30／32：K-PASSKEY-NOT-ME（首頁沒有待簽清單的人看不到提示，已修 `home.js`）與 `z-anchor-store` 的 K-ANCHOR-LAG
（「資料庫開例外 0 !== 1」：測試暫停錨定的 4.5 秒裡，背景排程剛好跑了一輪 `anchor_lag_check` 先開了例外——`.run/jobs.log` 19:24:19 那一輪
`"anchor_lag_check":{"opened":1}`，和這次的改動無關，是既有測試與每 60 秒的排程的競態）。第二次全過。這個競態列待觀察，沒有改測試。

### 步數（手機 390×844，從首頁算）

- 本人回報「不是我登記的」：**3 步**（首頁「這把新金鑰不是我登記的」→「不是我登記的」→「確認撤銷這把金鑰」；只憑登入，不需要裝置上的驗證）。
- 登記人背書復原的金鑰（掃 QR）：4 步（同原本主管背書的步數，背書人換成登記人）。
- 逾期警示：不需要動作（首頁卡片與單的頁面直接顯示）。

### 攻擊腳本（`tools/run-all.sh --keep` 重建後，01–51 依序各一次；沒有改腳本）

修前取自 findings-7 的複核（34、40、46、47、48、49 回 1，其餘 0）。修後：

| 腳本 | 修前 | 修後 | 說明 |
|---|---|---|---|
| 47 排程與交付同時停擺 | 1 | **0** | A、B、C 的單頁與稽核頁有「警示…沒有在執行」，D 另有對帳例外；恢復後補做。腳本量「全域例外」的時間點在模擬時間過去後約 3 秒，那時還沒有 K-PROGRAM-STALLED；資料庫裡 19:38:28（停擺期間、恢復前）由其他程式的心跳開了 work:confirmation_expiry、work:delivery、work:grant_expiry 三筆並通知，恢復後 19:38:53 結案。延遲來自心跳觸發的檢查最少間隔 10 秒加上寄信程式每 5 秒一輪 |
| 48 停用整條簽核線 | 1 | **1** | 腳本判定與新行為衝突：死結的判定只試 p30 與 p15 互相背書、p01（沒有金鑰），沒有試第二位登記人 p24。實測：同樣停用 p30 與 p15 之後，K-REGISTRAR-MIN 當場開、p30 本人原金鑰簽＋p24 背書 → restored，例外結案（手動腳本，不在 repo）。其餘判定都是好的：bypassed false、兩個持有人例外與 K-GOVERNANCE-KEY 都開了；通知多了 passkey.registrar_min |
| 49 金鑰撤銷殘餘項 | 1 | **1** | 高-1 擋下：主管 p03 背書 PASSKEY_ENDORSER_REVOKER、登記人 p30 背書 PASSKEY_ENDORSER_REVOKER（managerTakeover、registrarTakeover 都 false）；乾淨持有人被撤光當場開 K-GOVERNANCE-KEY。回 1 只因 `staleGovernanceException`：腳本以「這個人有沒有任何 K-GOVERNANCE-KEY（不分結案與否）」判定，p01、p27、p28 的種子階段例外已經結案（closed_at 有值）但仍存在；例外只增不刪，這個判定在新行為下永遠成立 |
| 46 人工執行關 | 1 | **1** | 低-2 擋下：迄日已過的單標記已套用 → expired、確認 STATE_TRANSITION、沒有授權（lateActivation false）。執行人＝申請人：關卡停住並開 K-RESOLVE-HALT（selfFulfil、sodSilentStuck 都 false）。回 1 只剩 `expiryManualSilent`：人工系統的授權到期（i 段）沒有 K-DELIVERY-MANUAL 也沒有通知管理人——既有的 `grant_manual_followup` 對 `expired` 不動作（「外部系統依迄日擋下」的設計），不在 D88 範圍，沒有改；過了迄日才標記的那一種（K-GRANT-LATE）已會通知管理人 |
| 34、40 | 1 | 1 | 已接受的殘餘（D85、D86）|
| 其餘 45 支 | 0 | 0 | 不變 |

## 8. 留給下一位

- 紅隊腳本 48、49 的判定要依 D88 改寫（48 要試第二位登記人；49 的 4a 要看未結案的例外）；46 的 i 段（人工系統的到期）要決定是否也通知管理人。
- `z-anchor-store` 的 K-ANCHOR-LAG 與背景排程的競態（§7）。
- 別人範圍的文件（`docs/contract/00-spine.md` 等）還沒有提到心跳、例外的結案、第二位登記人與破窗的條件；破窗的見證程序（§4）要由負責人確認後寫進正式的維運文件。
