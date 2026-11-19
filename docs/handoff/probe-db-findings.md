# 架構探針：資料庫這一半的結論

> **歷史紀錄（2026-11-19 探針）**：內容維持探針當時的原貌。之後探針已升格為正式目錄：`probe/db` → `db/`（SQL 在 `db/kernel/`、測試在 `db/tests/kernel/`）、`probe/api` → `api/`、`probe/web` → `web/`、`probe/e2e` → `e2e/`、`probe/run-all.sh` → `tools/run-all.sh`；角色與 schema 改名、以及本文列出的問題怎麼處理，見 [promote.md](promote.md)。

日期：2026-11-19。範圍：`probe/db/`。這是驗證「架構做不做得出來」的探針，不是功能實作。
本文分清楚三種狀態：**跑過且通過**（附指令）、**寫了但沒跑**、**沒做到**。

## 0. 一句話結論

| 賭注 | 結論 | 一句話 |
|---|---|---|
| 一：資料庫自己驗證「決定來自本人」 | **有條件成立** | 純 PL/pgSQL 驗 ES256（通行金鑰）與 RS256（Dex ID token）都做得到、夠快（單次 p95 約 21 ms／4 ms）；能擋住「拿到後端連線帳號的人」離線冒用、重放、挪用、改內容。擋不住：資料庫最高權限者、同步帳號、以及在使用者「正在操作時」同時控制前端與後端的人。 |
| 二：雜湊鏈 + 外部摘要抓得到竄改與重算 | **有條件成立** | 錨點涵蓋的範圍內，改一筆、整條重算、刪尾、還原舊備份全部抓到；**最後一個錨點之後**的事件可以被改或刪而不被發現（已用測試證明這個缺口存在）。缺口大小＝錨定間隔。 |
| 三：角色隔離 | **成立** | 一般後端角色對任何資料表、序列、檢視都沒有權限，只能執行 `api` 的 function；以 `pg_catalog` 查實際權限、再以真的連線越權，全部被拒。前提是 owner 與 superuser 不給應用程式使用。 |

建議的架構：**(a) 為主、(b) 為輔，全部在資料庫內以純 PL/pgSQL 驗章；不採 (c)。** 理由見 §2.5。

## 1. 怎麼跑

```bash
sim/up.sh                      # 需要 ldap、idp（若 ldap 健康檢查說人數不對，先 sim/ldap/reset.sh）
probe/db/build.sh              # 從頭建庫、匯入 Dex 公鑰、從 LDAP 同步人員、跑全部測試（約 20 秒）
probe/db/build.sh --bench      # 另外跑效能量測（約 1 分鐘），結果寫到 probe/db/.run/bench.json
node probe/db/tools/anchor.mjs              # 把鏈頭與程式指紋寫到錨點檔（資料庫以外）
node probe/db/tools/anchor.mjs --every 60   # 常駐，每 60 秒一次
node probe/db/tools/verify-chain.mjs        # 全量驗證鏈並比對錨點檔；有問題時結束代碼 2
node probe/db/tools/verifier-service.mjs    # 架構 (c) 的驗證服務（比較用）
```

**跑過且通過**（2026-11-19，本機）：`probe/db/build.sh` → `規則代碼 8 個，每個都有測試`、`# tests 60 # pass 60 # fail 0`；`shellcheck -x probe/db/build.sh` 無輸出。

連線設定的唯一來源是 `probe/db/probe.env`；sim 的位址與測試帳密從 `sim/*/service.env`、`test-credentials.env` 讀，不另外寫死。

## 2. 賭注一：資料庫自己驗證「決定來自本人」

### 2.1 PostgreSQL 16 裡驗非對稱簽章的做法（實際安裝試驗）

| 做法 | 能驗什麼 | 試驗結果 | 評估 |
|---|---|---|---|
| pgcrypto | 雜湊、HMAC、對稱加密、OpenPGP 加解密 | 已安裝。**沒有** ECDSA、RSA PKCS#1、Ed25519 的簽章驗證 function | 只能用來產生亂數（`gen_random_bytes`）。PostgreSQL 16 內建 `sha256()`，雜湊不需要 pgcrypto |
| 純 PL/pgSQL（numeric 當大數） | ES256、RS256（本探針實作） | **跑過且通過**：與 OpenSSL 交叉比對 50 組 ES256、15 組 RS256（2048／3072 位元），含竄改、錯鑰、邊界值；並驗過真的 Chromium 產生的 WebAuthn 憑證與簽章 | 不違反「只用 pgcrypto」的工程規範；速度見 §2.4。約 420 行 SQL（`02`～`04`，含註解） |
| plpython3u + python3-cryptography | 全部（底層 OpenSSL） | apt `postgresql-plpython3-16` 安裝成功；系統的 python3-cryptography 41 可用。只裝在比較用的 `sgn_probe_bench` | 快 30～40 倍，但 untrusted 語言：只有 superuser 能建 function，function 內可讀寫資料庫主機的檔案與網路；違反工程規範第 4 節 |
| pgsodium | 只有 Ed25519（libsodium `crypto_sign`），不含 ES256、RS256 | apt 沒有這個套件；原始碼可取得，但在本 session 安裝到系統 PostgreSQL 的動作**被權限拒絕，沒有試成** | 就算能裝，也解決不了主流通行金鑰（ES256）與 Dex（RS256） |
| plv8、pgjwt | — | apt 都沒有 | 沒試 |
| plperl（`postgresql-plperl-16` 有） | 需要 Perl 加密模組 | 沒試 | 同樣是 untrusted 才有用 |
| 純 PL/pgSQL 的 Ed25519 | — | **沒做** | 可行（pgcrypto 有 SHA-512，曲線運算同 ES256 手法），預估耗時同量級；目前沒有需要 |

### 2.2 三種架構的最小實作

共同部分（`sql/30_identity.sql`、`sql/50_decide.sql`）：

- `api.challenge_issue`：資料庫自己算出綁定內容 `{case_id, case_no, version, content_sha256, decision}`，產生 32 bytes 的一次性挑戰值，有效 `challenge.ttl_seconds`（300 秒）。只發給這張單的簽核人。
- 決定流程固定三段：`decision_prepare`（鎖住挑戰值、檢查用途／未用／未過期、決定種類相符、內容版本與雜湊沒變）→ **驗證明，得出「是誰」** → `decision_commit`（是否申請人本人、是否簽核人、消耗挑戰值、狀態轉移、存原始證明、寫雜湊鏈）。
- 「是誰」只從驗過的證明得出；沒有任何 function 接受後端傳入的 actor。

| | (a) 資料庫驗通行金鑰 | (b) 資料庫驗 Dex ID token | (c) 獨立驗證服務 |
|---|---|---|---|
| 入口 | `api.case_decide_passkey` | `api.case_decide_idp` | 服務 `POST /decide` → `api_verified.case_decide_passkey` |
| 證明 | WebAuthn assertion：clientDataJSON 的 `challenge` 必須等於資料庫存的挑戰值、`type=webauthn.get`、`origin`、rpIdHash、UP 與 UV 旗標、ES256 簽章（DER）、計數器 | Dex 以 nonce＝挑戰值簽發的 ID token：只收 RS256 與登記的 kid、`iss`、`aud`、`exp`、`iat` 新鮮度（300 秒）、`nonce`，再以 `federated_claims` 對到同步進來、在職的人 | 服務用 OpenSSL 驗同樣的 WebAuthn 欄位；資料庫只檢查挑戰值、綁定、資格 |
| 呼叫者角色 | `sgn_probe_app` | `sgn_probe_app` | `sgn_probe_verifier`（app 無權執行） |
| 信任放在哪裡 | 資料庫裡的公鑰登記（登記時由 IdP 再驗證把關）＋使用者的驗證器 | 資料庫裡登記的 IdP 公鑰＋IdP（Dex 沒有 MFA，等於只靠密碼） | **驗證服務的程式、主機與 `sgn_probe_verifier` 的密碼**：拿到它就能不經簽章以任何已登記通行金鑰的人核准（測試 `(c) 殘餘風險` 證明會成功） |

通行金鑰的登記（`api.passkey_register`）：資料庫發登記挑戰值，使用者在 IdP 再驗證，ID token 的 nonce 必須是 `b64url(sha256(挑戰值 || 公鑰 SPKI))`，所以這張 token 只能登記這一把公鑰；公鑰必須在 P-256 曲線上。attestation 不驗（`none`）。

### 2.3 攻擊測試（全部跑過且通過）

攻擊者模型：拿到 `sgn_probe_app` 的連線帳號，而且手上有主管的工作階段代碼（後端本來就看得到）。

| 攻擊 | (a) | (b) | (c) |
|---|---|---|---|
| 直接呼叫內部的決定 function | 42501 權限不足 | 同左 | 呼叫 `api_verified` 也是 42501 |
| 用自己產生、未登記的金鑰簽 | `PASSKEY_UNKNOWN` | — | — |
| 主管的憑證 id 配偽造簽章 | `PASSKEY_INVALID` | — | 服務回 `PASSKEY_INVALID` |
| 偽造 token：alg=none、HS256（拿公鑰當 HMAC 金鑰的經典攻擊）、自己的 RSA 金鑰冒用 kid、改 payload | — | 全部 `TOKEN_INVALID` | — |
| 同事用自己合法的證明簽主管的挑戰值 | `NOT_APPROVER` | `NOT_APPROVER` | — |
| 替主管登記攻擊者的金鑰（用自己的 token／挪用主管登記 A 金鑰的 token 登記 B） | `PERSON_UNKNOWN`／`TOKEN_NONCE` | — | — |
| 主管平常登入用的 token 拿來做決定 | — | `TOKEN_NONCE` | — |
| 重放舊證明 | `CHALLENGE_USED`（計數器恆為 0 的同步型通行金鑰也擋得住）；舊證明配新挑戰值 `PASSKEY_INVALID` | `CHALLENGE_USED` | `CHALLENGE_USED` |
| A 單的證明用在 B 單 | `PASSKEY_INVALID`，兩張單都沒動 | `TOKEN_NONCE` | `PASSKEY_INVALID` |
| 內容改了（退回→改→再送審）之後用舊證明 | `CONTENT_CHANGED` | `CONTENT_CHANGED` | `CONTENT_CHANGED` |
| 使用者簽「退回」、後端送「核准」 | `DECISION_MISMATCH` | `DECISION_MISMATCH` | （同一套 prepare） |
| 沒有 UV、錯 origin、錯 rpId、type 不對 | `PASSKEY_INVALID` | — | — |
| 複製的驗證器（計數器倒退） | `PASSKEY_COUNTER` | — | — |
| 過期挑戰值／過舊 token | `CHALLENGE_EXPIRED` | `TOKEN_STALE` | — |
| 真實瀏覽器 | Chromium（CDP 虛擬驗證器）登記並簽章，資料庫驗過、核准成功 | — | — |

測試檔：`test/30-proof-passkey.test.mjs`、`test/40-proof-idp.test.mjs`、`test/50-proof-verifier.test.mjs`、`test/80-browser-passkey.test.mjs`。過期與新鮮度的測試是把參數（`sgn.setting`）調小再等待，執行路徑沒有假時鐘。

### 2.4 量到的數字

量法：`bench/verify-bench.mjs`，每項 N=200、先暖身 10 次，`process.hrtime` 量客戶端來回時間（本機 TCP；同條件下 `select 1` 的 p50 0.06 ms 當基準）。單次驗章每次換不同的金鑰與簽章；端到端只量「送出決定 → 回傳」那一個呼叫（含驗章、狀態轉移、存證明、寫雜湊鏈、commit），證明與 token 事先準備好、不計入。機器：4 核心沙箱，PostgreSQL 16.15 預設設定。兩次量測結果相近，下表是第二次（`.run/bench.json`）。

| 項目 | p50 (ms) | p95 (ms) | max (ms) |
|---|---|---|---|
| ES256 驗章，純 PL/pgSQL | 16.45 | 20.78 | 29.5 |
| ES256 驗章，plpython3u（比較用） | 0.46 | 0.71 | 1.55 |
| RS256 驗章（2048 位元），純 PL/pgSQL | 1.65 | 1.82 | 3.04 |
| RS256 驗章，plpython3u（比較用） | 0.16 | 0.42 | 2.49 |
| 基準：`api.case_get` | 0.16 | 0.53 | 2.84 |
| (a) 端到端核准（資料庫驗通行金鑰） | 17.32 | 21.51 | 59.66 |
| (b) 端到端核准（資料庫驗 ID token） | 3.20 | 4.41 | 6.39 |
| (c) 端到端核准（HTTP 呼叫驗證服務） | 3.50 | 4.38 | 7.99 |
| (a) 10 個連線同時核准 200 張 | 44.43 | 78.5 | 108.56 |

(a) 併發時總共 1001 ms 完成 200 張，約 200 張／秒（4 核心；驗章是 CPU 密集，連線數超過核心數時每次呼叫變慢）。骨幹 13.1 的門檻「單次驗章 p95 < 150 ms」：**達成**，不需要改用擴充套件。登入（Dex 一次授權碼流程）約 50 ms，不在上表。

### 2.5 建議

1. **決定一律走 (a)**：資料庫內驗通行金鑰，純 PL/pgSQL。它把「誰做的決定」綁在使用者手上的驗證器（要 UV：生物辨識或 PIN），後端拿到什麼都無法離線產生決定。17 ms 對使用者無感。
2. **登入與通行金鑰登記走 (b)**：資料庫內驗 ID token。沒有通行金鑰的人，一般級別的決定可以用 (b)，但要知道它等於「知道密碼的人」（Dex 不帶 `amr`，資料庫無從判斷有沒有 MFA）。
3. **不採 (c)**：速度沒有優勢（(b) 已經 3 ms；(a) 17 ms 也夠），卻把信任搬到另一個服務和另一組密碼上，等於多一個能冒用所有人的帳號。唯一的理由會是「不想維護 SQL 版的密碼學」——若要走這條路，應改成「資料庫內的 untrusted 語言」而不是外部服務，且要先修工程規範。
4. 純 PL/pgSQL 的密碼學是受保護路徑：必須有公開測試向量（本探針只做了與 OpenSSL 的隨機交叉比對與 Chromium 實測，**沒有**跑 Wycheproof 之類的標準向量集）、變更要雙人審查。

### 2.6 這個方案保證什麼、不保證什麼（殘餘風險）

保證（有測試）：拿到後端連線帳號、甚至拿到使用者工作階段代碼的人，**沒有使用者當下的證明**就做不出決定；證明不能重放、不能挪到別張單、不能用在改過的內容、不能換決定種類。

不保證：

| 風險 | 說明 | 偵測方式（本探針做了哪些） |
|---|---|---|
| 資料庫 superuser／owner | 可以把驗章 function 換成不驗的版本。**測試「竄改 7」證明偽造的核准會成功**。 | 程式指紋（`api_audit.code_fingerprint`：function 定義、trigger 與啟用狀態、權限）隨錨點寫到資料庫外；驗證工具報 `CODE_CHANGED`（已測）。限制：改了又改回、恰好在兩次錨定之間，就看不出來（測試「竄改 8」）。正式環境需要 pgaudit 外送 DDL |
| 同步帳號（`sgn_probe_sync`） | 能改「誰是誰的主管」，等於能決定誰有資格核准。**測試證明：拿到同步帳號的人把自己設成主管，再用自己的金鑰核准，會成功**。這和「後端帳號」一樣是高權限，探針之前沒被列為信任點 | 同步本身寫進鏈（`directory.synced`，含輸入雜湊）。建議：主管異動通知本人與新舊主管、冷卻期、與 HR 來源比對 |
| 使用者正在操作時，前端與後端同時被控制 | 使用者看到 A，驗證器簽的是 B 的挑戰值（WebAuthn 不顯示內容；Dex 的登入頁也不顯示）。(b) 更弱：主管任何一次登入都可以被換成某個決定的 nonce | 決定後由資料庫產生通知摘要寄給本人（沒做）、異常偵測（沒做） |
| IdP 管理者 | 可以冒名登入，也就能替別人登記通行金鑰 | 登記事件在鏈上（`passkey.registered`）；登記後通知本人、冷卻期（沒做） |
| IdP 金鑰輪替 | Dex 每 6 小時換簽章金鑰；探針只在建置時匯入當下的 JWKS，之後新 kid 的 token 會被拒（`TOKEN_INVALID`） | **沒做**輪替流程。骨幹 13.1 的「pending → 延遲生效 → 告警」設計仍需要 |

## 3. 賭注二：雜湊鏈與外部摘要

### 3.1 實作（`sql/10_audit_chain.sql`、`tools/chain-lib.mjs`）

- `sgn.audit_event`：`hash = sha256(prev_hash || body)`，`body` 是存下來的 UTF-8 JSON bytes（內含 seq），驗證只看 bytes，不依賴資料庫的輸出格式；查詢用的欄位（行為人、單號、時間）驗證工具會比對與 body 一致。
- 只增不改：row trigger 擋 UPDATE、DELETE，statement trigger 擋 TRUNCATE；**連 owner 也擋**（已測）。
- 有序：單列的 `audit_chain_head` 以 `FOR UPDATE` 鎖住，寫入排隊；鏈頭只能前進一格且必須指向剛寫入的那一筆（trigger 檢查）。
- 外部摘要：`tools/anchor.mjs` 從上一個錨點**增量重算**到目前鏈頭，一致才把 `{seq, hash, code_fingerprint, anchored_at}` 追加並 fsync 到 `PROBE_ANCHOR_FILE`；不一致就拒絕寫入。
- 驗證：`tools/verify-chain.mjs` 從創世全量重算，檢查序號、前後連結、雜湊、欄位與 body 一致、鏈頭、每一個錨點、最新錨點的程式指紋。

### 3.2 測試結果（`test/60-chain.test.mjs`，全部跑過且通過）

攻擊者：資料庫 superuser（停用 trigger、直接改表、重算、pg_dump／pg_restore），碰不到錨點檔。每個情境在主資料庫的複本上做。

| 情境 | 驗證工具的結果 |
|---|---|
| 20 個連線同時寫 500 筆 | 序號連續、沒有分叉、全鏈驗過。約 1,370～1,450 筆／秒（量法：20 連線 × 25 次 `api.case_create`，總時間 344～364 ms） |
| 改一筆（錨點之前），不重算 | `HASH_MISMATCH`、`ANCHOR_MISMATCH` |
| 只改查詢欄位（行為人），不動 body | `COLUMN_MISMATCH` |
| 改一筆後整條重算（含鏈頭） | 鏈本身完全一致，只有 `ANCHOR_MISMATCH` 抓得到；錨定工具拒絕在被重算過的資料庫上寫新錨點 |
| **改「最後一個錨點之後」的一筆並重算** | **抓不到**（已知缺口，測試斷言它確實抓不到） |
| **刪掉錨點之後的最後幾筆並修正鏈頭** | **抓不到**（同上） |
| 刪到錨點之前 | `ANCHOR_BEYOND_HEAD` |
| 從舊備份還原（pg_dump → pg_restore） | `ANCHOR_BEYOND_HEAD` |
| 把驗章 function 換掉／停用只增不改的 trigger | `CODE_CHANGED`；但 trigger 恢復之後就看不出來 |

全量驗證速度：約 2～4 萬筆／秒（500～600 筆，15～24 ms；量法同上，Node 單執行緒）。**沒有**做十年量級的壓測；以這個速度估，單月百萬筆約一分鐘內，但這是外推，不是量測。

### 3.3 建議

1. 缺口＝錨定間隔。決定類事件要嘛同步錨定（commit 後立刻送出鏈頭），要嘛把錨定間隔壓到可接受的分鐘數，並在報告裡寫明「最後 N 分鐘的紀錄只靠資料庫保護」。
2. 錨點檔要放在資料庫管理者碰不到的地方（WORM 物件儲存、另一個管理網域、或 RFC 3161 時戳）。本探針只寫到本機檔案，**沒有**保護它。
3. 鏈頭鎖讓所有寫入排隊：4 核心上約 1,400 筆／秒，對簽核量足夠；高頻紀錄（查閱、判定）照骨幹 14.2 另走彙總區塊，不要進主鏈。
4. 程式指紋要隨每個錨點一起存，並配合 pgaudit 外送 DDL，才能縮小「改了又改回」的窗口。正式的 migration 會改指紋，需要一個「確認新指紋」的流程（**沒做**；目前錨定工具遇到指紋改變就拒絕）。

## 4. 賭注三：角色隔離（`sql/90_grants.sql`、`test/10-roles.test.mjs`，全部跑過且通過）

| 角色 | 只能執行 | 用途 |
|---|---|---|
| `sgn_probe_owner`（NOLOGIN） | 擁有全部物件 | 不給任何程式使用 |
| `sgn_probe_app` | `api.*` | 一般後端 |
| `sgn_probe_verifier` | `api_verified.*` | 架構 (c) 的驗證服務（比較用） |
| `sgn_probe_sync` | `api_sync.*` | LDAP 同步 |
| `sgn_probe_anchor` | `api_audit.*` | 錨定與驗證工具（唯讀） |

證明方式：以 `has_table_privilege`／`has_sequence_privilege` 查四個登入角色對所有非系統 relation 的權限＝無；以 `has_function_privilege` 查每個角色能執行的非系統 function 只在自己的 schema；再以真的連線 SELECT／INSERT／UPDATE 資料表、呼叫內部與別人的 function、建表、建暫存表、`SET ROLE owner`，全部被拒。另外查 `api*` 的每個 function 都是 SECURITY DEFINER、固定 `search_path = pg_catalog, pg_temp`、有 COMMENT。

條件：superuser 與 owner 不在隔離範圍內（見 §2.6）；SECURITY DEFINER function 裡每個物件都寫完整 schema 名稱。

## 5. 最小的業務路徑（`test/70-business.test.mjs`）

- 人員與主管：`tools/directory-sync.mjs` 以唯讀帳號真的連 sim 的 LDAP，讀 35 人與群組，交給 `api_sync.directory_apply`；主管關係帶生效期間，換主管會關閉舊的、開新的。
- 申請單：內容 jsonb，每次修改新增版本與內容雜湊；狀態由轉移表 `sgn.state_transition` 驅動（draft → submitted → approved，或 submitted → draft 退回）。
- 稽核唯讀查詢：`api.audit_events`，只限 LDAP 群組 `auditor` 的人，function 宣告為 STABLE（資料庫拒絕在其中寫入）。

| 規則代碼 | 內容 | 測試 |
|---|---|---|
| PRB-DIRECTORY | 主管關係從目錄同步；LDAP 換主管後重同步，舊關係關閉、新送審由新主管簽 | 通過 |
| PRB-APPLICANT | 只有申請人能改與送出 | 通過 |
| PRB-STATE | 送審後不能改；退回後可改；核准後不能再決定 | 通過 |
| PRB-APPROVER | 同事、隔級主管拿不到挑戰值；沒有主管（總經理）不能送審 | 通過 |
| PRB-SELF | 申請人拿不到自己單的挑戰值；拿主管的挑戰值用自己的金鑰簽也被擋 | 通過 |
| PRB-PROOF | 一般後端能改狀態的入口只有兩個決定 function，都要求證明（加上 §2.3 全部） | 通過 |
| PRB-CHAIN | 建立、送審、核准每一步都在鏈上，整條鏈驗得過 | 通過 |
| PRB-AUDIT-READ | 稽核員查得到軌跡與證明雜湊；非稽核員 `AUDITOR_REQUIRED` | 通過 |

`tools/rule-coverage.mjs` 檢查 `sgn.rule` 的每個代碼都出現在測試名稱裡（build.sh 會跑）。

關於「商業邏輯全部放在資料庫，寫得出來、測得動」（方向文件的第三個賭注，不在本次任務但有觀察）：規則本身很短、好讀；測試要靠 Node 驅動（登入、簽章都在資料庫外產生），純 SQL 測試框架不夠。決定流程拆成 prepare／verify／commit 三段後，錯誤代碼才清楚（一開始合在一起時，重放被計數器先擋下，回錯代碼）。

## 6. 給後端的介面說明（下一位照這個接）

連線：一律以 `sgn_probe_app` 連線，只能 `select api.<function>(...)`。錯誤：SQLSTATE `P0001`，訊息格式 `代碼: 中文訊息`，代碼與訊息在 `sgn.error_catalog`；權限不足是 `42501`。所有二進位值以 base64url（無 padding）字串傳遞。

### 6.1 登入

1. `select * from api.session_begin()` → `challenge_id uuid, nonce text`。
2. 導向 Dex 授權端點，`nonce` 參數放上一步的 `nonce`（scope 需含 `openid profile email groups federated:id`）；以授權碼換到 `id_token`。**後端不需要驗 token**。
3. `select * from api.session_open(challenge_id, id_token)` → `session_token text, person_id uuid`。之後以 `session_token` 代表使用者（有效 3600 秒）。

### 6.2 登記通行金鑰

1. `select * from api.passkey_register_begin(session)` → `challenge_id, challenge`。
2. 前端 `navigator.credentials.create()`（`alg: -7`、`userVerification: 'required'`、`rp.id` = `webauthn.rp_id`），取 `rawId` 與 `response.getPublicKey()`（SPKI）。這一步的 WebAuthn challenge 可以是任意亂數（attestation 不驗）。
3. 以 nonce = `b64url(sha256(b64url_decode(challenge) || spki))` 讓使用者在 Dex 再驗證一次，取得 `id_token`。
4. `select api.passkey_register(challenge_id, id_token, credential_id, spki)`。

### 6.3 申請與送審

- `select * from api.case_create(session, content jsonb)` → `case_id, case_no`
- `select api.case_revise(session, case_id, content)` → 新版本號（只在 draft）
- `select api.case_submit(session, case_id)` → 簽核人 person_id
- `select api.case_get(session, case_id)` → jsonb（申請人與簽核人可讀）

### 6.4 做決定（核准 `approve`、退回 `return`）

1. `select * from api.challenge_issue(session, case_id, decision)` → `challenge_id, challenge, binding`。`binding` 給前端顯示（單號、版本、內容雜湊、決定種類）。
2. 用通行金鑰（建議）：前端 `navigator.credentials.get({ challenge: b64url_decode(challenge), rpId, userVerification: 'required' })`，再
   `select api.case_decide_passkey(challenge_id, decision, credential_id, authenticator_data, client_data_json, signature)` → 新狀態。
3. 或用 IdP 再驗證：以 `nonce = challenge` 走一次 Dex 授權流程，再 `select api.case_decide_idp(challenge_id, decision, id_token)`。
4. 挑戰值 300 秒內有效、只能用一次；驗證失敗時挑戰值不會被用掉，可以重試。

### 6.5 稽核

`select * from api.audit_events(session, case_id 或 null)` → 每筆事件與鏈雜湊；只限 `auditor` 角色。

### 6.6 後端不要做的事

- 不要自己判斷誰能核准、狀態能不能轉；照 function 的回傳與錯誤代碼。
- 不要把 `owner` 或 superuser 帳號給應用程式；不要給後端 `api_sync`、`api_verified`、`api_audit` 的帳號。
- 工作階段代碼只代表「已登入」，不足以做決定；不要設計任何「憑工作階段就能決定」的捷徑。

## 7. 沒做到、和骨幹不同的地方

- 內容雜湊與事件 body 用 PostgreSQL `jsonb::text`（在 PostgreSQL 內是確定的），**不是** RFC 8785；換正規化方式等於重算全部雜湊（骨幹 14.1），要在正式 DDL 前決定。
- `sgn.setting` 只有全域值，沒有生效時間與適用範圍。
- IdP 金鑰輪替、ES256 的 IdP token、第二個 IdP：沒做。
- Ed25519、RS256 以外的演算法：沒做。標準測試向量集（Wycheproof）：沒跑。
- pgsodium：安裝被權限拒絕，沒試成（且它不支援 ES256／RS256）。
- 決定只有核准與退回；沒有駁回、撤回、代理、批次。簽核人在送審時固定，送審後換主管不會改簽核人（是否要改是設計問題）。
- 目錄同步只處理快照中出現的人；從快照消失的人不會被停用；沒有測離職（offboard）流程。
- 稽核查詢沒有記錄「誰查了什麼」（骨幹的 access_log）。
- 錨點檔沒有防寫保護；沒有 pgaudit；程式指紋改變後沒有確認流程。
- 決定後寄給本人的通知摘要、同裝置偵測等「使用者正在操作時被攻擊」的偵測：沒做。
- 工程規範第 6 節的工具（sqlfluff、plpgsql_check、ESLint、Prettier）：沒跑；只跑了 shellcheck。
- 數字都是 4 核心沙箱、本機連線、資料量數千筆下量的；沒有十年量級壓測。
