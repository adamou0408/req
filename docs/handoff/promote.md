# 交接：探針升格、修掉探針發現的問題、最小品質關卡

> **本檔寫於 2026-11-19，以下已過時：§0 與 §4 的「10 段通過、約 54 秒」（`tools/check.sh` 之後多了 `sim/dc` 一段，現為 10 個檢查段加 `tools/run-all.sh`）；§6「需要主代理決定的事」第 1、2、4、5 項已處理（骨幹與工程規範對 `p_session`、`db` workspace 的矛盾、根目錄 `README.md`）；§7 留給下一位中「參數改成 `setting_definition`／`setting_value`」「例外的結案流程」「申請人修改退回單的畫面」已做；§1 描述的 `probe/` 目錄已不存在。仍有效：`tools/check.sh` 仍未納入的工具（sqlfluff、knip、Trivy、hadolint、actionlint、產生檔無差異檢查）與產生器（`docs/reference/`、TypeScript 型別）仍然沒做，是目前仍有效的待辦。現況見根目錄 `README.md` 與 `tools/check.sh`。**

日期：2026-11-19。範圍：`db/`、`api/`、`web/`、`e2e/`、`packages/contract/`、`tools/`（`commit-guard.sh`、`install-dev-tools.sh` 沒動）、根目錄的 package 設定、`.gitignore`（只新增一行）、`docs/handoff/`。
本文分清楚：**跑過且通過**、**寫了但沒跑**、**沒做到**。

## 0. 結果一覽

| 部分 | 結果 |
|---|---|
| 第一部分：升格 | **跑過且通過**。`tools/run-all.sh` 從乾淨狀態（刪掉 `node_modules/`、`.run/`，`sim/down.sh`）跑過 |
| 第二部分：七項修正 | **跑過且通過**。每項的測試另以「把修正改回去」的變異測試確認會失敗（§3.8） |
| 第三部分：`tools/check.sh` | **跑過且通過**，10 段全部通過，總時間約 54 秒 |

測試數量（全部在 `tools/run-all.sh` 裡）：

| | 搬之前 | 現在 |
|---|---|---|
| 資料庫測試 | 60 | **79** |
| 通行金鑰的 Node 對照組（原 frontdoor） | 16（不在 run-all，要另外跑） | **16**（併入 run-all） |
| 端對端 | 4 | **7** |
| 合計 | 64（run-all 內）／80（含 frontdoor） | **102** |

```bash
tools/check.sh          # 全部品質關卡，最後呼叫 tools/run-all.sh
tools/check.sh --fast   # 不跑測試，只做靜態檢查與 plpgsql_check
tools/run-all.sh        # 模擬環境 → 建庫與資料庫測試 → 對照組 → 錨定程式與後端 → 端對端
tools/run-all.sh --keep # 跑完讓後端（http://localhost:3000）與錨定程式繼續跑
db/build.sh             # 只建庫並跑資料庫測試（要先 sim/up.sh ldap idp、根目錄 npm ci）
```

最後一次結果（`tools/check.sh`，從乾淨狀態）：`# tests 79 # pass 79`、`# tests 16 # pass 16`、`# tests 7 # pass 7`，`全部通過`。之後又單跑一次 `tools/run-all.sh`，結果相同。

## 1. 第一部分：升格

### 1.1 目錄

| 原本 | 現在 |
|---|---|
| 舊骨架 `api/`、`web/`（未驗證） | 刪除 |
| `probe/db/sql/*.sql` | `db/kernel/*.sql`（骨幹第 9 節的 migration 目錄） |
| 架構 (c) 的 `api_verified`（比較用） | `db/testing/50_verifier.sql`＋`db/testing/verifier-service.mjs`，**只裝在資料庫測試的資料庫**（骨幹：`db/testing/` 不進發行包） |
| `probe/db/test/` | `db/tests/kernel/` |
| `probe/db/tools/`、`bench/` | `db/tools/`、`db/bench/` |
| `probe/db/probe.env` | `db/sgn.env`（連線設定的唯一來源；錨點檔的路徑不再寫死絕對路徑） |
| `probe/api/src/routes.ts` | `packages/contract/src/routes.ts`（工程規範：路由表的唯一來源），加上回傳結構 |
| `probe/api` | `api/` |
| `probe/web` | `web/` |
| `probe/e2e/tests` | `e2e/tests/` |
| `probe/api/src/frontdoor/webauthn/` 與 `probe/e2e/frontdoor/` | `e2e/reference/passkey/`：Node 端的通行金鑰對照實作與它的 16 個測試，**不在執行路徑**。沒跑過、只型別檢查過的 `server.ts`、`oidc.ts`、`session.ts`、`config.ts` 刪除（沒用到的程式） |
| `probe/docs/*.md` | `docs/handoff/probe-*.md`（原貌保留，開頭加一行說明路徑已搬） |
| `probe/docs/webauthn-vectors.json` | `db/tests/kernel/fixtures/webauthn-vectors.json`（凍結的一份，資料庫測試用）。對照組每次重新產生的那份改寫到 `.run/`，不再改動被追蹤的檔案 |
| `probe/run-all.sh` | `tools/run-all.sh` |
| 執行期檔案 `probe/.run/`、`probe/db/.run/` | `.run/`（根目錄；`.gitignore` 新增 `.run/` 一行） |

### 1.2 命名（骨幹第 1.1 節）

| 項目 | 探針 | 現在 |
|---|---|---|
| schema | `sgn`、`sgn_internal`、`sgn_crypto`、`api`、`api_sync`、`api_audit`、`api_verified` | `sgn`、`sgn_internal`（驗章與 pgcrypto 併入）、`api`、`api_sync`、`api_job`（錨定與驗證工具＝排程）；`api_verified` 只在測試 |
| 角色 | `sgn_probe_owner/app/sync/anchor/verifier` | `sgn_owner`、`sgn_app`、`sgn_sync`、`sgn_job`；測試專用 `sgn_test_verifier` |
| 資料庫 | `sgn_probe`（資料庫測試跑完再重建一次給端對端） | `sgn_test`（資料庫測試）、`sgn_e2e`（端對端）各一個，不再重建兩次；`sgn_bench`（效能比較，只在 `--bench`） |
| 取得時間 | 各處 `clock_timestamp()` | 唯一入口 `sgn_internal.now()` |

骨幹沒有規定資料庫名稱，`sgn_test`、`sgn_e2e` 是我定的。

### 1.3 套件（工程規範第 4 節）

- npm workspaces：`packages/contract`、`api`、`web`、`e2e`、`tools`，**另加 `db`**（資料庫測試與工具要 `pg`、`ldapts`；規範的清單沒有 `db`，見 §6）。
- 只有根目錄一份 `package-lock.json`；根目錄 `.npmrc` 設 `save-exact=true`、`engine-strict=true`；`.nvmrc` 是 22，`engines` 是 `>=22.18.0 <23`（Node 直接執行 `.ts`）。
- 共用設定在根目錄：`tsconfig.base.json`、`eslint.config.js`、`.prettierrc.json`。
- 新增的開發套件與用途：`eslint` 10.15.0、`@eslint/js` 10.0.1、`typescript-eslint` 8.73.0（lint）、`globals` 17.14.0（ESLint 的瀏覽器與 Node 全域名稱表）、`prettier` 3.8.1（格式）；`e2e` 的 `playwright` 1.63.0 改成精確鎖定的本地套件（原本從全域 npm 目錄 import）。ESLint 9 已被標為不再支援，所以用 10。`npm audit`：0 個弱點。

### 1.4 行為的改變（有意的）

升格本身沒有改行為；第二部分的修正改了 API：每個 `api` function 改回傳 jsonb、送出申請改成一個 function、錯誤目錄多了後端用的代碼。e2e 的 4 個原測試全部保留，改的只有 import 路徑與 `config` 名稱。

## 2. 和契約、規範不同的地方

| 項目 | 規定 | 現在 | 理由 |
|---|---|---|---|
| `api` function 的第一個參數 | 工程規範第 5 節：`p_actor`；骨幹 1.1：`p_session` | `p_session`，或 `p_challenge_id`（行為人由證明得出的決定與登入）；架構測試檢查「沒有任何人員參數」 | 兩份文件互相矛盾，照骨幹（`p_actor` 等於讓後端說「我是誰」，正是要防的）。**需要主代理裁決並修規範** |
| 規則代碼前綴 | 骨幹：核心 `K-` | 仍是 `PRB-*`（新增 `PRB-SYNC-GUARD`、`PRB-SESSION`、`PRB-CONTENT-HASH`） | 這些是探針路徑上的部分實作，直接改成 `K-SESSION` 等會宣稱涵蓋了骨幹完整的規則（例如閒置時限）。**需要主代理決定對應方式** |
| `api` 的回傳 | 骨幹：統一的結果信封，規則拒絕寫 denied 事件後以結果回傳 | 成功回傳 jsonb；拒絕仍以例外離開（`P0001`＋錯誤目錄） | 信封與 denied 事件是新功能，這一輪不擴充 |
| 介面文案 | `web/src/i18n/zh-Hant.ts` | `web/i18n.js` | 頁面沿用探針的無建置 ES module；改成 TS 需要建置步驟 |
| 前端呼叫函式 | 由路由表產生 | `web/api.js` 只有一個 `api.call(名稱, 參數)`，路徑一律 `/api/<名稱>`；資料庫測試檢查 `web/` 用到的名稱都在路由表裡 | 沒有產生器；用檢查代替產生 |
| migration 只增不改 | 已套用到任何環境的不得修改 | 這一輪直接改了探針的 SQL（例如把 `error_catalog.http_status` 併回建表） | 探針只套用過本機的開發資料庫。**從這一版起只能新增** |
| 參數 | `setting_definition`／`setting_value`、適用範圍、生效時間 | 仍是單一的 `sgn.setting`（全域值） | 不擴充功能 |
| 資料庫測試 | 骨幹：`db/tests/kernel/` | 照做；測試仍以 Node 驅動（登入、簽章都在資料庫外產生） | — |
| 開發用的人員來源 | — | `sgn.directory_source` 在 migration 裡登記了 `sim-ldap`，`sgn.setting` 也有 sim 的 issuer | 正式環境的登記要改成導入時的 migration 或設定流程 |

## 3. 第二部分：七項修正

### 3.1 人員同步帳號可以把自己設成別人的主管（`PRB-SYNC-GUARD`）

**選的做法：不擋，但讓它一定看得到。** 資料庫分辨不出「假快照」與「真的人事異動」，也不知道同步帳號背後是誰，所以防的對象不是「同步者本人」，而是「同步寫入的主管異動」本身（同步者指定任何人都一樣）。依據 RA-38（權威事實不在平台簽核，以同步防護與異動偵測控管）、RA-24（新主管關係被用於簽核的偵測）、RB-03。

1. 人員來源要先登記（`sgn.directory_source`）；第一次同步是基準，之後一律不是基準。未登記的來源 → `DIRECTORY_SOURCE_UNKNOWN`（不能另開一個「新基準」）。
2. 基準之後的每一筆主管異動，單獨寫一筆 `directory.manager_changed`（人、舊主管、新主管）進雜湊鏈；`sgn.reporting_line` 記 `origin`（`baseline`／`sync_change`）與那筆事件的序號。
3. 送審時記下簽核人依據的那條主管關係（`request_case.approver_line_id`），`case.submitted` 事件帶 `approver_basis`。依據是 `sync_change` 時，開一筆例外（`sgn.exception_record`，同時寫 `exception.opened` 進鏈）。
4. 例外出現在：申請人與簽核人看到的單張摘要（`exceptions`，簽核詳情頁顯示警示）、待簽清單、稽核證據頁（含那筆主管異動事件）、稽核人員的例外清單 `api.audit_exceptions`（不必知道單號）。決定事件記下當時未結案的例外（`open_exceptions`）。
5. 簽核人在送審時固定：送審後的同步異動不改變進行中的單（攻擊者拿不到挑戰值）。

攻擊測試（`db/tests/kernel/72-sync-guard.test.mjs`，3 個，跑過且通過）：同步帳號送假快照把 p05 設成 p04 的主管 → 異動在鏈上、送審開例外、三方都看得到、決定事件記下例外、整條鏈仍一致；進行中的單 → `NOT_APPROVER`；基準只有一次、假來源被拒、同步帳號只能執行 `api_sync`。原探針的「殘餘風險（預期會成功）」測試由第一個攻擊測試取代。

**殘餘風險：**

- 攻擊者**仍然能核准**，只是留下例外。例外的結案流程、派給控制負責人、通知本人與新舊主管：**沒做**（骨幹的例外作業與通知是新功能）。
- 真的人事異動同樣開例外，在有結案流程之前，每次換主管後的第一批送審都會帶例外（`70-business` 的 PRB-DIRECTORY 測試斷言了這件事）。
- 沒有冷卻期、沒有與人資來源比對、沒有「異動後很快又改回」的偵測（RA-24 的 `K-DETECT-MANAGER-FLIP`）。
- 基準同步本身（導入時第一次）沒有防護：那時寫入的關係一律可信。骨幹的 `sys_baseline` 核准沒做。
- 同步帳號仍能改角色（例如給自己 `auditor`，稽核是唯讀）、改 `active`（讓真主管「離職」→ `NO_APPROVER`）、改姓名與信箱；這些都還沒有逐筆事件。RA-38 的 `sync_proposed` 角色沒做。
- 循環主管關係（A→B→A）沒擋；只有資料表的 check 擋「主管是自己」。

### 3.2 授權檢查只有一個入口

- `sgn.action`（動作目錄：誰能做、要不要證明、是不是改狀態）＋`sgn_internal.denial_reason(person, action, case)` 是唯一的判斷；`sgn_internal.authorize` 不允許就丟錯。
- 每個動作 function（修改、送審、發挑戰值、決定、讀單、稽核查詢）都呼叫 `authorize`；決定時以**驗過的證明得出的人**再判一次。可執行動作清單（`case_actions`）與畫面功能（`person_capabilities` 的 audit）也由 `denial_reason` 算出。探針的 `challenge_issue`、`case_submit`、`decision_commit`、`case_get`、`audit_events`、`require_auditor` 各自的檢查全部移除；`api.audit_events` 刪除（和 `audit_case` 重複）。
- 架構測試（`90-contract.test.mjs`）：授權錯誤代碼、`has_role`、申請人／簽核人與人員變數的比對，只能出現在 `denial_reason`；例外只有三個「依我自己挑資料」的清單查詢，逐項寫在測試裡並附理由。另一個測試：會改狀態或讀稽核資料的 function 都呼叫 `authorize`。
- 有意的改變：`challenge_issue` 收到不需要證明的動作（`cancel`、`revise`）改回 `ACTION_UNKNOWN`（原本是 `STATE_TRANSITION`）；「挑戰值發給別人」改回 `CHALLENGE_PURPOSE`（不再借用授權代碼）。

### 3.3 每個使用者動作一個 function，回傳結構固定

- 「送出申請」改成 `api.case_submit_new`（建立＋送審同一個交易，送審失敗不留草稿）。`case_create`（存草稿）、`case_revise`、`case_submit`（送審草稿）仍在，路由都開了。
- 核准／退回仍是兩次呼叫（`challenge_issue` → `case_decide_passkey`）：WebAuthn 本身要求先拿挑戰值再簽，這是協定的兩步，不是前端串流程。
- 每個 `api` function 都回傳 jsonb；結構寫在 `packages/contract/src/routes.ts`（`routes`：15 個畫面路由；`backendCalls`：登入、登記、登出、錯誤目錄；`notExposed`：`case_decide_idp` 與理由）。申請單一律是同一個 `CaseSummary`（解決探針 `case_no` 有時字串有時數字的問題）。
- 測試（`90-contract.test.mjs`）：每個路由的 function 存在、參數名稱與順序相符、回傳 jsonb；每個 `api` function 都有歸屬；**真的呼叫每一個 function 一次**，以 `shapeProblems` 檢查結構不多不少；`web/` 呼叫的名稱都在路由表。
- 錯誤目錄加了後端自己判定的代碼（`BAD_INPUT`、`NOT_FOUND`、`INTERNAL`、登入往返失敗等），後端不再寫死中文訊息；登入失敗時前端直接顯示後端帶回的訊息（探針原本查不到對照、一律顯示通用訊息）。

### 3.4 用 Wycheproof 驗 ES256

- 來源：`go mod download github.com/google/wycheproof@latest` → `v0.0.0-20261111220454-65ca494727a5`（Go 模組代理）。檔案原樣放在 `db/tests/kernel/fixtures/wycheproof/`，附 Apache 2.0 `LICENSE`。sha256：`ecdsa_secp256r1_sha256_test.json` `182db4f3…9332`，`ecdsa_secp256r1_sha256_p1363_test.json` `c60de693…c986`。
- **先跑出一個真的缺陷**：對探針原本的資料庫跑 DER 向量，484 個裡 tcId 6（`Legacy: ASN encoding of s misses leading 0`，invalid）被判為有效——DER 解析接受負數 INTEGER。修正：`sgn_internal.der_integer_strict`（非負、最短編碼）。
- 結果（`22-wycheproof.test.mjs`，跑過且通過）：

| 檔案 | 走哪條 | 個數 | valid | invalid | acceptable | 不一致 |
|---|---|---|---|---|---|---|
| DER | 正式路徑 `es256_verify`（WebAuthn 用 DER）；另以 SPKI 解析每組公鑰 | 484 | 174 | 310 | 0 | 0 |
| P1363（r‖s） | 驗章核心 `p256_verify_digest`；資料庫沒有 P1363 解析，長度不是 64 bytes 的 21 個由測試這邊判為無效 | 262 | 173 | 89 | 0 | 0 |

- **acceptable**：這一版的兩個檔案都**沒有** acceptable（舊版 Wycheproof 的 DER 檔有 BER 類的 acceptable，新版改成 invalid）。測試斷言 acceptable 為 0；之後更新向量若出現，測試會失敗，要逐項決定，不自動歸類。
- 另把凍結的 Chromium 向量接成自動測試（`20-crypto`）：valid／竄改簽章／竄改 clientDataJSON／重放 → `t f f t`，與 Node 對照組一致（frontdoor-findings §3 原本是手動跑的）。
- 沒做：稽核頁 `web/verify.js` 的 DER 轉換（給 WebCrypto 用）仍是寬鬆解析，沒有對 Wycheproof 跑。

### 3.5 內容雜湊用標準化 JSON（`PRB-CONTENT-HASH`）

- `db/kernel/05_jcs.sql`：`sgn_internal.jcs`（RFC 8785：鍵依 UTF-16 code unit 排序、ECMAScript 字串跳脫、數字轉 IEEE 754 double 後依 ECMAScript `Number::toString` 排版）。內容雜湊、事件 body、決定證明的雜湊都改用它。
- Node 端：`web/lib/jcs.js`（稽核人員的瀏覽器與測試共用同一份；ECMAScript 本身就是 RFC 8785 的定義，所以只有遞迴與排序）。稽核頁改成自己標準化內容與證明再算雜湊，`audit_case` 不再回傳 `content_text`、`raw_text` 原文。
- 跨語言對照（`25-jcs.test.mjs`，6 個，跑過且通過）：RFC 本文的範例一字不差；3.2.3 的鍵排序例子（表情符號排在 U+FB33 之前）；附錄 B 的 IEEE 754 數字、排版邊界、2000 個隨機 double；3000 份隨機巢狀 JSON（含控制字元、補充平面字元）；申請單的 `content_sha256` 由 Node 從回傳內容算得出；超出 double 範圍（`1e400`、`1e-400`）→ `CONTENT_NOT_CANONICAL`。
- **測試抓到一個真的差異**：PostgreSQL 的 float8 最短輸出在十進位值剛好落在兩個 double 中點時多給位數（`1e23` 印成 `9.999999999999999e+22`，ECMAScript 是 `1e+23`）。`sgn_internal.jcs_shortest` 由短到長再試一次修掉。
- 限制：超過 2^53 的整數會照 RFC 變成 double（數值會變）；之後若內容要放大整數，要改成字串。

### 3.6 登出讓資料庫的工作階段失效（`PRB-SESSION`）

`api.session_close` 寫 `closed_at`（並寫 `session.closed` 進鏈），`session_person` 拒絕已關閉的；後端 `/auth/logout` 先呼叫它再清 cookie。測試：資料庫 1 個（之後任何 function 都 `SESSION_INVALID`、可重複按、只關這一個）；端對端 1 個（登出後拿留下的 cookie 從另一個瀏覽器環境打 `/api/me` → 401 `SESSION_INVALID`）。

### 3.7 端對端補上的分支

- **退回**（資料庫已支援）：陳建宏從畫面用通行金鑰退回 → 從待簽清單消失；林怡君的單變回「草稿」、可做的動作是 `revise`、`submit`；稽核驗證通過、退回事件由陳建宏以通行金鑰簽章。**申請人修改退回單的畫面仍沒做**（新畫面，不擴充）。
- **尚未錨定**：測試把錨定程式 `SIGSTOP`，核准一張單後查稽核頁 → 狀態 `warn`，標題寫「…尚未有外部摘要涵蓋，目前只靠資料庫保護，還不算完成驗證」，不含「驗證通過」；這張單的每一筆未涵蓋紀錄都標「尚未有外部摘要涵蓋」。`SIGCONT` 後等錨定 → 才變成通過、標示消失。
- 竄改測試移到最後一個：竄改期間錨定程式若剛好重算到被改的那一筆，會依設計停下來，不能影響其他測試。

量到的數字（N=1，只當量級）：主管從待簽清單到核准 4 步（T2 上限 4）、按確認到顯示已核准 118 ms、稽核重驗 60 ms、版面問題 0 個（`.run/e2e-results.json`）。

### 3.8 變異測試：修正改回去，測試會失敗

在 `sgn_test` 的副本上把每項修正改回原本的行為，只跑對應的測試（腳本是一次性的，沒有放進 repo）：

| 變異 | 結果 |
|---|---|
| 不開例外（`exception_open` 改成什麼都不做） | 72-sync-guard：1 失敗 |
| 另寫一個丟 `NOT_APPROVER` 的 function | 90-contract 的授權單一入口測試失敗 |
| DER 解析改回寬鬆 | 22-wycheproof DER 測試失敗 |
| `jcs` 改回 `jsonb::text` | 25-jcs：6 個全部失敗 |
| `session_close` 不真的關 | 74-session 失敗 |
| 單張摘要少一個欄位 | 90-contract 結構測試失敗 |

## 4. 第三部分：`tools/check.sh`

依 `docs/methodology/templates/check.sh` 改寫。每一段都跑過且通過（2026-11-19，從乾淨狀態，約 54 秒）：

| 段落 | 內容 |
|---|---|
| 安裝 | `npm ci` |
| 格式 | `prettier --check .`（`sim/`、`docs/`、`*.md`、`package-lock.json`、外部測試資料不納入，寫在 `.prettierignore`） |
| lint | `eslint --max-warnings 0 .`：`@eslint/js` recommended＋`typescript-eslint` strict（含不得用 `any`、非空斷言）；未使用的 disable 註解也算錯 |
| 型別 | `tsc` 檢查 `packages/contract`、`api`、`e2e/reference/passkey`（`strict`） |
| shell | `shellcheck -x -P SCRIPTDIR`，repo 裡全部 `.sh`（含 `sim/`，目前都通過） |
| PL/pgSQL | `db/build.sh --plpgsql-check`：只在 `sgn_test` 建 schema，`plpgsql_check` 裝在獨立 schema，逐一檢查 57 個 PL/pgSQL function（含 trigger function，開 extra warnings）。第一次跑抓到 3 個沒用到或從沒讀過的變數，已修 |
| 禁止字串 | 程式裡的 TODO／FIXME；測試裡的 `.skip(`、`.only(`、`.todo(`、`{ skip: … }` 等 |
| 追蹤的檔案 | 已追蹤＋會被加入的新檔：超過 1 MB、或在 `.run`、`node_modules`、`dist`、`test-results`、`playwright-report` 底下 |
| 套件弱點 | `npm audit --audit-level=high` |
| 測試 | `tools/run-all.sh` |

禁止字串與檔案大小兩段另外以故意放進去的違規檔確認會失敗。

**沒納入（照實列出）**：

| 工具 | 狀況 |
|---|---|
| sqlfluff | 已安裝（3.4.2），沒設定；現有 SQL 的格式（關鍵字小寫、縮排）大致相符，但沒跑過、會有一批要修 |
| knip | 沒安裝、沒設定 |
| Trivy（套件、密碼、錯誤設定、授權） | 已安裝，沒納入；弱點資料庫要下載，沒試 |
| hadolint、actionlint | 目前沒有 Dockerfile 與 GitHub Actions 設定 |
| 產生檔無差異 | 沒有產生器（TypeScript 型別、`docs/reference/` 都沒做） |
| 規則代碼覆蓋 | 有，但在 `db/build.sh` 裡（`db/tools/rule-coverage.mjs`），經由 run-all 執行 |
| JavaScript 檔的型別檢查 | `.mjs`、`web/*.js` 只有 ESLint，沒有 `checkJs` |
| 函式長度上限（SQL 80 行、TS 40 行） | 沒有自動檢查；`server.ts` 的 handler、部分 SQL 接近上限，沒逐一量 |

## 5. 殘餘風險（除了 §3.1）

- 資料庫最高權限者換掉驗證程式：仍只能事後由程式指紋偵測（探針結論不變）。
- 最後一次錨定之後的紀錄只靠資料庫保護；稽核頁現在明確標示，但缺口仍在（錨定間隔 2 秒，只寫本機檔案、沒有防寫保護）。
- 稽核頁的驗證程式與錨點都由後端送來（探針結論不變）；`web/verify.js` 與 `db/tools/chain-lib.mjs` 仍是兩份驗鏈的程式，只有 JCS 共用。
- OIDC 往返的暫存仍在後端記憶體，只能單一行程。
- 錯誤目錄裡的 `http_status` 預設值、`sgn.setting` 的 sim 位址都是開發環境的值。

## 6. 需要主代理決定的事

1. 工程規範第 5 節「第一個參數是 `p_actor`」與骨幹「`p_session`」矛盾：我照骨幹。請修其中一份。
2. 規則代碼 `PRB-*` 要不要、怎麼對應到骨幹的 `K-*`（多數只是部分實作）。
3. 同步防護選「開例外、不擋」：要不要再加冷卻期或「異動須人資資料管理人確認才生效」（RB-03 的雙人確認）？那會讓真的換主管時，新主管要等一段時間或一個確認才能簽。
4. `db` 是不是要正式列進工程規範第 4 節的 workspace 清單。
5. 根目錄 `README.md`（不歸我）的「目前狀態」還寫著舊骨架「進行中」與「實作未開始」，需要更新。
6. 本機 PostgreSQL 裡我刪掉了舊的開發資料庫與角色：`sgn_kernel_ddl_check`（舊骨架留下、讓 `sgn_app` 角色刪不掉）、`sgn_probe`、`sgn_probe_bench`、`sgn_probe_scratch` 與 `sgn_probe_*` 角色。`das_api_dev` 沒動。
7. 這段期間環境自動做了兩次 `wip:` commit（`63d876b4`、`2ae69ab4`，不是我下的指令）；我沒有 commit 或 push。內容我檢查過沒有 `node_modules` 或 `.run`。

## 7. 留給下一位

- 例外的結案流程、派工、通知（§3.1 的殘餘風險大多靠它收斂）。
- 申請人修改退回單的畫面（API `case_revise`、`case_submit` 已有路由）。
- 產生器：由 `pg_catalog` 與路由表產生 TypeScript 型別與 `docs/reference/`，接著把「產生檔無差異」放進 `check.sh`。
- sqlfluff、knip、Trivy 進 `check.sh`。
- 參數改成 `setting_definition`／`setting_value`。
- `web/verify.js` 與 `db/tools/chain-lib.mjs` 合成一份不依賴 Node 的驗證模組；DER 轉換改成嚴格並跑 Wycheproof。
- 從這一版起 `db/kernel/` 的 migration 只能新增。

## 8. 試用帳號

密碼一律是 `sim-user-pass`（`sim/ldap/test-credentials.env`）。瀏覽器開 `http://localhost:3000`（不是 127.0.0.1）。

| 帳號 | 人 | 角色 |
|---|---|---|
| `p04` | 林怡君 | 申請人（主管是陳建宏） |
| `p03` | 陳建宏 | 簽核人；第一次核准前要登記通行金鑰 |
| `p22` | 黃淑芬 | 稽核人員（LDAP 群組 `auditor`） |
