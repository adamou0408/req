# 交接：紅隊第五輪的修復（redteam-fixes-5）

日期：2026-11-20。依據：`redteam/findings-5.md`、裁決 D84（背景 D81–D83）、`docs/handoff/redteam-fixes-4.md`、`docs/handoff/applicant-confirm.md`、`docs/packs/data-access/rules.md`。
範圍：`db/`、`api/`、`web/`、`e2e/`、`packages/contract/`、`tools/`、`sim/`（含 `sim/dc/README.md`、`sim/ldap`、`sim/idp`）、本文件。
沒有改 `redteam/`、`rules.md` 與其他文件；沒有 commit、沒有 push。

## 0. 結果一覽

（見 §7 的實測；`97`＝`db/tests/kernel/97-program-reach.test.mjs`、`98`＝`98-anchor-lag.test.mjs`、`96`＝`96-idp-keys.test.mjs`、
`87`＝`87-passkey-revoke.test.mjs`、`12`＝`12-grants.test.mjs`、`50`＝`db/tests/packs/data_access/50-delivery.test.mjs`、
`55`＝`55-confirmation.test.mjs`、e2e `path`＝`e2e/tests/path.test.mjs`、e2e `z`＝`e2e/tests/z-anchor-store.test.mjs`）

| D84 | 項目 | 結果 | 測試 |
|---|---|---|---|
| (1) | 管理者連線只限本機 peer、沒有可用的已知密碼；私鑰、密碼、備份、log 只有擁有者讀得到；以後端帳號實際探測 | 做了 | `97` ×11（root 對照組、9 個程式帳號各一、檔案權限）|
| (3) | 身分提供者金鑰：不退役到零把、退役冷卻＋例外＋通知、退役後再出現可恢復、時間窗內新增上限 | 做了（G 灌一把自己的金鑰仍可冒用登入，D84 接受，見 §1 #6）| `96` K-IDP-KEY-RETIRE、K-IDP-KEY-NEW（恢復、kid 換公鑰）、K-IDP-KEY-LIMIT；`96` K-IDP-KEY-UNTRUSTED（改）|
| (4)＋資訊 1 | 待套用、驗證中可撤銷；撤回並作廢未完成的交付；正在送的套用與驗證一併作廢 | 做了 | `55` K-GRANT-REVOKE ×2（待套用四種撤銷者、驗證中未開確認）；`50` K-DELIVERY-ORDER K-GRANT-REVOKE（正在送的作廢、回報不採信、不重送）|
| (5) | 對帳回報簽發時間嚴格遞增；發現連續數輪沒看到才結案 | 做了（參數 `reconciliation.resolve_after_rounds`＝3）| `50` K-RECON-UNVERIFIED（舊回報 not_newer）、K-RECON-RESOLVED（中間又看到重新計算）|
| (6) | 排程、對帳、錨定、寄信各用各的角色；grants 產生器與 12 一併更新；站內待辦為主、逾期前提醒不只靠郵件 | 做了 | `12`（允許清單、合併角色、交叉不通）、`10`；`55` K-CONFIRM-REMIND；e2e `path`（首頁待辦剩幾天）|
| (7) | 存放處序號嚴格遞增、不收 ≤0；落後由資料庫開例外、稽核頁判失敗；錨定程式停掉會被重啟 | 做了 | `98` ×2；e2e `z` ×2（存放處拒絕、頁面 bad＋資料庫例外＋殺掉後重啟）|
| (2) | 只憑登入撤銷通行金鑰改為停用；本人原金鑰＋主管背書恢復；每日上限；治理角色持有人被停用開例外；畫面步數 | 做了 | `87` K-PASSKEY-SUSPEND ×2；`90` 契約；e2e `path` K-PASSKEY-SUSPEND（步數）|
| (8) | 人工執行的單也開申請人確認 | 做了 | `50` K-DELIVERY-MANUAL K-CONFIRM-MANUAL；`20` DA-PATH-L3（改）；e2e `path` 主路徑（步數）|

## 1. 威脅小表（動手前寫；每列對應「拿掉防法就失敗」的測試）

起點沿用 findings-5：A 一般員工、B 後端帳號 sgn-api、D 對帳／排程、F 交付程式、G 身分提供者金鑰同步、H 錨定程式、M 寄信程式（新拆出來）、N 網路。

| # | 新增或改動的機制 | 誰送給誰 | 經不可信方 | 離線可試 | 當事人能否影響 | 誰能寫它／回捲／空值／舊而有效的輸入／停掉時誰知道 | 測試 |
|---|---|---|---|---|---|---|---|
| 1 | 管理者連線（本機 peer、root 角色）| 建置與測試工具（root）→ unix socket → PostgreSQL | 無 | 沒有密碼可試 | 不能 | 只有 root 與 postgres 寫得了 pg_hba；新增的 superuser 下次建置才進拒絕清單（未解：兩次建置之間新增的）| `97` 對照組＋各帳號 `db.*` 全部連不上 |
| 2 | sim 的隨機密碼（LDAP 管理者、reader、人員；IdP client secret）| `sim/*/start.sh`（root）→ `sim/.run/<服務>/secrets.env`（0700/0600）| 主機檔案系統 | 48 位十六進位，不可試 | 不能 | 刪掉檔案＝下次啟動重新產生並重新載入種子；git 歷史裡的舊密碼一律不能用 | `97` `ldap.*_old_known`、掃檔 |
| 3 | 整庫備份、log 權限 | 測試（root）、run-all（root）| — | — | — | 舊的 0644 log 會被 `start_program` 先刪再建（測試抓到過）| `97` 檔案權限 |
| 4 | 撤銷時作廢正在送的套用 | 使用者 → B → 資料庫；資料庫 → F | B、F、N | — | 撤銷者能，F 不能 | F 晚交的回報 → DELIVERY_LEASE；晚到外部系統的套用 → 封存 409；撤回不等它 | `50` K-DELIVERY-ORDER；`55` K-GRANT-REVOKE |
| 5 | 待套用、驗證中可撤銷 | 撤銷者 → B → 資料庫 | B | — | 撤銷者 | B 可以替經過它的人撤銷（只會縮小，同 D84 (2) 的分類）| `55` K-GRANT-REVOKE（拿掉轉移表那一列 → STATE_TRANSITION）|
| 6 | 身分提供者金鑰：冷卻退役、不到零把、恢復、上限 | G（或 N 改明文 JWKS）→ 資料庫 | G、N | — | 不能 | 空清單 → 不退役；回捲（舊 kid 再出現）→ 公鑰相同才恢復；**未解（D84 接受）**：G 在上限內加一把自己的金鑰就能冒用任何人登入，只有事後偵測（K-IDP-KEY-NEW 例外＋通知）| `96` RETIRE（拿掉冷卻 → 立即退役、空清單 → 登不進來）、LIMIT、恢復 |
| 7 | 對帳簽發時間遞增、N 輪才結案 | 外部系統 → N → D → 資料庫 | D、N | — | 不能 | 舊回報 → not_newer；D 只能不交（K-RECON-OVERDUE）| `50` K-RECON-UNVERIFIED（中-2 情境）、RESOLVED |
| 8 | 拆角色 | 各程式 → 資料庫 | 各程式帳號 | 48 位隨機 | 不能 | 合併角色 sgn_job 只在 root 的 roles.env；**未解**：M 仍能把通知標成已寄出而不寄（D84 未要求收據；站內待辦不受影響）| `12`（交叉不通、sgn_job 沒有直接授權）|
| 9 | 錨點回報（anchor_recorded）＋落後檢查 | H → 資料庫；排程 → 資料庫 | H | — | 不能 | H 謊報「已錨定」→ 雜湊與指紋要和資料庫的鏈相符；H 寫了但不回報 → 資料庫開例外（誤報，偏安全）；H 回報了但沒寫 → 頁面看存放處判 bad；排程停掉 → 頁面仍判 bad | `98`（拿掉雜湊比對 → 收下假雜湊）|
| 10 | 存放處序號嚴格遞增、>0 | H → 存放處 | H | — | 不能 | H 寫一個極大的序號 → 誠實的錨定程式寫不進去 → 頁面「錨點超過鏈頭」bad＋資料庫 K-ANCHOR-LAG；**未解**：要人清掉那一行 | e2e `z`（0、負、相等、較小都拒絕）|
| 11 | 監看重啟 | run-all（root）→ 程式 | — | — | — | 監看本身被殺就不再重啟（只有 root 殺得了）；重啟迴圈寫進 log | e2e `z`（SIGKILL 後換 pid、錨定恢復）|
| 12 | 通行金鑰停用 | B（冒用登入）→ 資料庫 | B | — | 本人 | 每日 1 次；治理角色開例外；恢復要原金鑰（冒用者沒有）＋主管背書（拿走裝置的人沒有）；停用中仍算有金鑰，不能另登第一把 | `87` K-PASSKEY-SUSPEND ×2 |
| 13 | 提醒＋站內待辦 | 排程 → 資料庫 → 通知；首頁從資料庫取 | M（郵件可被吞）| — | — | 排程停掉 → 沒有提醒信，但首頁的剩餘天數與「快到期」仍由資料庫算 | `55` K-CONFIRM-REMIND |
| 14 | 人工執行開確認 | 執行人 → 資料庫；申請人確認 | B | — | 申請人 | 執行人標記即轉驗證中；確認者只有申請人 | `50` K-CONFIRM-MANUAL（NOT_APPLICANT）|

## 2. 做了什麼（檔案）

- 資料庫（新增，依序）：`db/kernel/480_revoke_in_flight.sql`（撤銷作廢正在送的、待套用與驗證中可撤銷、人工開確認、提醒、摘要的 `confirm_due`）、
  `485_reconciliation_rounds.sql`、`490_idp_keys_guard.sql`、`495_anchor_lag.sql`（`anchor_recorded`、`anchor_lag_check`、稽核頁的落後參數）、
  `500_passkey_suspension.sql`（停用、恢復、`webauthn_verify_credential`）。沒有改已存在的 migration（全部以新檔的同簽章替換）。
- 角色：`db/sgn.env` 新增 `sgn_scheduler`、`sgn_reconciler`、`sgn_anchor`、`sgn_mailer`；`sgn_job` 改為只給操作者的合併角色（四者的成員、沒有直接授權）。
  路由表 `schedulerCalls`、`reconcilerCalls`、`anchorCalls`、`mailerCalls`（`jobCalls` 是聯集）；`grants-sql.mjs`、`programs.mjs`、`build.sh` 跟著改。
- 管理者連線：`db/admin.env` 改成 `postgres://root@%2Fvar%2Frun%2Fpostgresql/...`；`db/build.sh` 的 `secure_admin`（建立 root 角色、清所有 superuser 密碼、
  在 `pg_hba.conf` 前面寫入拒絕 superuser 的 TCP 登入、`admin.env` 0600）；建置要以 root 執行。
- sim：`sim/ldap`、`sim/idp` 的密碼與 client secret 改為執行期隨機產生（`sim/.run/<服務>/secrets.env`），目錄 0700；刪除兩個 `test-credentials.env`；
  `db/tools/lib/env.mjs` 改讀新位置。
- 執行：`tools/run-all.sh` 每個程式有監看（結束就 1 秒後重新啟動）、log 0600、`.run` 0711；`provision-secrets.mjs` `.run` 0711；60-chain 的備份 0600。
- 交付程式：回報被拒（DELIVERY_LEASE，送的途中被作廢）時這一輪其他筆照常回報。`dcMock` 的簽發時間嚴格遞增。
- 存放處：`anchor-store.mjs` 只收 seq > 0 而且比最後一個大；`chain-lib.mjs` 寫進存放處後回報資料庫。
- 頁面：`verify.js` 落後超過參數判 bad；`case.js` 人工執行的確認說明；`home.js` 確認待辦顯示剩幾天與快到期、主管的「等你背書恢復」；
  `passkeys.js` 停用中的金鑰區塊（申請恢復、背書恢復）；`decide.js` 停用中的提示；`i18n.js`。

## 3. 和裁決不同的地方

| 項目 | D84 | 這裡 | 理由 |
|---|---|---|---|
| (6) 各用各的角色 | 排程、對帳、錨定、寄信各一個 | 四個角色各自的密碼與允許清單；另留 `sgn_job` 當操作者的合併角色（四者的成員、沒有直接授權、密碼只在 root 的 roles.env） | 測試與紅隊腳本以 `connect('JOB')` 扮演誠實的防守方（對帳、排程、讀鏈），不得改腳本；沒有任何程式拿得到它（`12`、`97`）|
| (6) 寄出要有證據 | findings 的修法方向提到 SMTP 收據 | 沒做收據；改以站內待辦為主（D84 的裁決文字）| 寄信程式仍能把通知標成已寄而不寄（未解 §1 #8）；等確認的剩餘天數、快到期由資料庫算、首頁顯示 |
| (3) 新金鑰 | 上限內立即信任 | 同 | G 在上限內加一把自己的金鑰就能冒用登入（腳本 34 a 仍成立）；D84 接受，TLS 與憑證釘選列為部署必要項 |
| (2) 主管背書 | 主管 | 主管或登記人（不是本人、不持有不能做決定的角色）| 和撤銷的資格一致；登記人本人被停用時由他的主管或另一位登記人背書（推論未驗證 1）|
| (7) 程式指紋改變時的錨點 | — | 存放處不再收「序號沒變、指紋改變」的錨點 | 那正是 41 的入口；指紋改變後要等鏈上有新事件才寫得進去，期間稽核頁顯示「程式被改過」（失敗）|
| 監看 | 錨定程式 | run-all 的所有背景程式都有監看 | 同一個機制；`$name.pid` 仍是程式本身（暫停與恢復不變）|

## 4. 既有測試的調整（逐項原因；斷言沒有放寬）

| 測試 | 調整 | 原因 |
|---|---|---|
| `10` 角色隔離 | ANCHOR 換成四個新角色＋合併角色 | D84 (6) 拆角色 |
| `12` 權限 | 允許清單多四個角色；新增合併角色與交叉不通的斷言 | 同上（加嚴）|
| `60` 竄改 | 備份檔 chmod 0600 | D84 (1)；斷言不變 |
| `87` 只憑登入撤銷（2 個）| 改寫成 K-PASSKEY-SUSPEND：停用、恢復、每日上限、停用中不能另登第一把 | D84 (2)：只憑登入不再撤銷（原測試的「撤銷後只能 QR 背書」路徑已不存在）|
| `90` 契約 | p14 停用後由登記人用金鑰撤銷再重登；新增停用清單與恢復兩步的回傳結構 | 同上；新路由都要真的呼叫 |
| `96` K-IDP-KEY-UNTRUSTED | 不再公布 → 先 missing、模擬冷卻期滿才退役 | D84 (3) 冷卻 |
| `20` DA-PATH-L3、DA-FULFIL-CUSTODIAN；`50` K-DELIVERY-MANUAL | 標記已套用 → verifying，申請人確認後 active | D84 (8) |
| `50` K-DELIVERY-AUTO、`55` K-CONFIRM #3 | 待套用、驗證中未開確認時 actions 是 `['revoke']`（原本 `[]`），拿掉「驗證中撤銷 → CONFIRMATION_NOT_OPEN」 | D84 (4)（確認與回報仍 NOT_OPEN）|
| `50` K-DELIVERY-ORDER 第二段 | 正在送的套用不再「等它有結果才送撤回」，改成作廢、撤回立即可領、晚到的回報 DELIVERY_LEASE、外部系統 409 | D84 (4)、資訊 1 |
| `50` K-RECON-MISSING、UNVERIFIED、EXTRA（縮小）、RESOLVED | 結案改為連續 3 輪沒看到 | D84 (5) |
| e2e `path` 主路徑 | 標記已套用 → 申請人在畫面上確認（量步數）| D84 (8) |
| e2e `path` K-PASSKEY-REVOKE | 拆成 K-PASSKEY-SUSPEND（停用、恢復、步數）與「主管用金鑰撤銷 → 重登 → QR 背書」 | D84 (2) |

## 5. 攻擊腳本結束碼（`tools/run-all.sh --keep` 重建後，01–41 依序各一次；沒有改腳本）

修前取自 findings-5。這一輪是在乾淨 check 之前的那次重建上跑的（之後只改了首頁的停用提示與 e2e，資料庫沒有變）。

| 腳本 | 修前 | 修後 | 說明 |
|---|---|---|---|
| 20 後端帳號探測 | 1 | 0 | admin.env 只限 root、本機 peer；Dex 私鑰、LDAP 密碼、備份、log 讀不到 |
| 33 偽造身分提供者登入 | 1 | 0 | sgn-api 讀不到 `sim/.run/idp/dex.db` |
| 34 金鑰同步帳號 | 1 | **1** | b（空清單讓全公司登不進來）擋下：不退役、登入照常；a（交上真的＋攻擊者的金鑰）仍成立——上限內立即信任，D84 (3) 接受（§3）|
| 35 舊回報結案 | 1 | 0 | not_newer |
| 36 待套用、驗證中撤銷不了 | 1 | 0 | 申請人第一個就撤銷成功 |
| 40 寄信帳號吞通知 | 1 | **2** | 入口改變：腳本用寄信程式的密碼以 `sgn_job` 登入（第一步），寄信程式現在是 `sgn_mailer`，回 password authentication failed。用 `sgn_mailer` 仍能把通知標成已寄（未解 §1 #8）|
| 41 錨點存放處 | 1 | 0 | seq 0 回 422 |
| 28 撤銷與縮小的濫用 | 0 | **2** | 腳本假設「待交付時撤銷」會被拒（D84 (4) 之後被接受），之後 `confirmAsApplicant` 找不到生效的單，判無法判定。腳本把「待交付時撤銷被接受」記為成功，和 D84 (4) 衝突 |
| 29 租約與順序 | 0 | **2** | d 段：腳本把「撤回先被領走」記為弱點，接著回報撤銷前領走的套用 → DELIVERY_LEASE 未處理。這兩件正是 D84 (4)／資訊 1 的設計（撤回＝封存，晚到的套用 409，回報不採信）|
| 其餘 01–19、21–27、30–32、37–39 | 0 | 0 | 不變 |

28、29 要和紅隊一起依 D84 (4) 改寫判定；40 要改成讀 `sgn_mailer` 的角色名。

## 6. 怎麼執行與實測紀錄

```bash
tools/check.sh             # 全部（以 root；乾淨狀態：停掉背景程式、rm -rf .run）
tools/run-all.sh --keep    # 背景程式各有監看；.run/<程式>.pid 是程式本身，.supervisor.pid 是監看
```

第一次用新版要重新啟動 sim（`sim/down.sh && sim/up.sh ldap idp mail`）：LDAP 與 IdP 的密碼改為執行期產生，舊的資料會重新載入種子。
`db/build.sh` 會改寫本機的 `pg_hba.conf`（加一段拒絕 superuser 經 TCP 登入）並清掉所有 superuser 的密碼（含環境原有的 das_dev）。

**乾淨狀態的 `tools/check.sh`（2026-11-20；停掉背景程式、`rm -rf .run`，以 root）：11 段全部通過（exit 0）。**

| 段落 | 結果 |
|---|---|
| 安裝、格式、lint、型別、shellcheck、plpgsql_check、禁止字串、追蹤的檔案、npm audit、sim/dc | 通過 |
| 規則代碼覆蓋 | 93 個（新增 K-CONFIRM-MANUAL、K-CONFIRM-REMIND、K-IDP-KEY-RETIRE、K-IDP-KEY-LIMIT、K-PASSKEY-SUSPEND、K-ANCHOR-LAG）|
| 資料庫測試 | **272／272**（上一輪 251；新增 `97` 11、`98` 2、`96` 3、`55` 3、`50` 1、`12` 1）|
| 通行金鑰對照組 | 16／16 |
| 端對端 | **30／30**（上一輪 27；新增 `z` 2、`path` 拆出 1）|

步數（手機 390×844，從首頁算）：確認人工執行的結果 3 步；申請人確認驗證結果（T7）3 步；本人申請恢復停用的金鑰 4 步、主管背書恢復 4 步（都含裝置上的使用者驗證）。

## 7. 留給下一位

- 未解：G 上限內冒用登入（§1 #6）；寄信程式能標已寄而不寄（#8）；H 寫極大序號讓錨定卡住要人清（#10）；兩次建置之間新增的 superuser 沒有進 pg_hba 的拒絕清單（#1）；
  停用時金鑰還在冷卻中的人不能用它簽恢復（PASSKEY_NOT_ACTIVE），只能由主管撤銷後重登。
- 紅隊腳本 28、29、40 要配合 D84 改寫（§5）。
- `docs/handoff/sim-directory.md`、`promote.md` 等仍寫著 `test-credentials.env` 與固定密碼（不在我的範圍），以本文件與 sim 各自的 README 為準。
