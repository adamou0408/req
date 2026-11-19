# 架構探針：通行金鑰的 Node 端對照組

日期：2026-11-19。範圍：`probe/api/src/frontdoor/`、`probe/e2e/frontdoor/`、`probe/docs/webauthn-vectors.json`。
這份文件分三種狀態：**跑過且通過**（附指令）、**寫了但沒跑**、**沒做到**。

## 0. 範圍變更

原本的任務有五項（登入、LDAP 人員、通行金鑰、頁面外殼、端對端測試）。做到一半時，另一位代理（整合者）也開始在 `probe/api` 寫接資料庫的後端，兩邊改到同一批檔案。協調者裁定：`probe/api`、`probe/web`、`probe/e2e` 的共用檔案歸整合者，本項只交三樣：

1. 通行金鑰在 Node 端的獨立驗證（註冊、簽署、驗證），以及用虛擬驗證器跑通的測試。用途是當資料庫驗證的**對照組**。
2. 測試向量 `probe/docs/webauthn-vectors.json`。
3. 本文件。

所以登入頁、頁面外殼、LDAP 模組、`probe/api/README.md` 的指向行都沒有做，或做了但不再維護（見 §4）。

## 1. 做到了什麼

| 項目 | 狀態 | 位置 |
|---|---|---|
| WebAuthn 註冊驗證（clientDataJSON、rpIdHash、UP／UV、attestedCredentialData、COSE 公鑰；attestation 視為 `none`） | 跑過且通過 | `probe/api/src/frontdoor/webauthn/verify.ts` |
| WebAuthn 簽署驗證（type、challenge、origin、crossOrigin、rpIdHash、UP、UV、ES256／RS256 簽章、計數器） | 跑過且通過 | 同上 |
| 最小 CBOR 解碼器、COSE → KeyObject／SPKI DER／PEM | 跑過且通過（經由上面的測試） | `webauthn/cbor.ts`、`webauthn/cose.ts` |
| 可替換的挑戰值產生器、一次性消耗 | 跑過且通過 | `webauthn/challenge.ts` |
| 原始資料完整保留與匯出（每次驗證不論成敗都記一筆） | 跑過且通過 | `webauthn/store.ts`、`webauthn/service.ts` |
| 真實 Chromium + CDP 虛擬驗證器的端對端測試，390px 寬 | 跑過且通過（16 項） | `probe/e2e/frontdoor/passkey.test.ts`、`vectors.test.ts` |
| 測試向量：有效、竄改 signature、竄改 clientDataJSON、重放（他張挑戰值） | 跑過且通過 | `probe/docs/webauthn-vectors.json` |
| 向量拿資料庫的純 PL/pgSQL ES256 交叉比對 | 跑過，結果一致（見 §3） | 只讀呼叫，沒有改 `probe/db` |

## 2. 怎麼跑

```bash
cd probe/e2e/frontdoor
npm ci
npm run typecheck          # tsc，含 probe/api/src/frontdoor 底下的檔案
npm test                   # PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers；先跑 passkey 再跑 vectors
```

- 不需要 sim、不需要資料庫。測試自己起一個最小的 relying party（`rp-server.ts`），優先用 3000 埠（資料庫探針的 webauthn origin 設定是 `http://localhost:3000`，向量才能直接拿去驗）；3000 被占用時改用隨機埠，向量檔的 `origin` 會跟著變。
- rpId 是 `localhost`：WebAuthn 不接受 IP 當 rpId，所以瀏覽器用 `http://localhost:<埠>` 連。
- 套件：`playwright` 1.63.0（與全域安裝的同版）、`typescript`、`@types/node`，全部精確版本，只在 `probe/e2e/frontdoor/` 的 lockfile。驗證本身只用 `node:crypto`，沒有加任何 WebAuthn 套件。Node 22.18 以上直接執行 `.ts`（型別剝除），不需要建置。

**從乾淨狀態跑過**（2026-11-19）：刪掉 `node_modules` 與向量檔 → `npm ci` → `npm run typecheck`（無輸出）→ `npm test`：`# tests 16 # pass 16 # fail 0`。另外 `probe/api` 的 `tsc --noEmit -p .`（整合者的設定，會一併檢查 `src/frontdoor`）無錯誤。

測試涵蓋：

| 測試 | 預期 | 結果 |
|---|---|---|
| 390px 寬沒有水平捲動 | `scrollWidth ≤ 390` | 通過 |
| 註冊 | 保存 ES256 公鑰（COSE、SPKI、PEM），attestation `none` | 通過 |
| 按「用通行金鑰確認」 | 驗證通過 | 通過 |
| 竄改 signature（翻轉最後一個 byte） | `SIGNATURE_INVALID` | 通過 |
| 竄改 clientDataJSON（`"type":` 後多一個空白，JSON 語意相同、bytes 不同） | `SIGNATURE_INVALID` | 通過 |
| 用挑戰值 A 的簽署回應挑戰值 B | `CHALLENGE_MISMATCH` | 通過 |
| 再送一次 A | `CHALLENGE_UNKNOWN`（已用過） | 通過 |
| 四組向量離線重驗：Node 驗證器 | 與檔案的 `expected` 相同 | 通過 |
| 四組向量離線重驗：只用 PEM ＋ OpenSSL 驗原始簽章 | 有效與重放＝簽章有效；兩組竄改＝無效 | 通過 |

## 3. 測試向量（給資料庫那邊）

`probe/docs/webauthn-vectors.json`，由 `passkey.test.ts` 每次執行重新產生，請勿手改。

- 頂層：`rpId`、`origin`、`requireUserVerification`、`credential`（`credentialId`、`alg`、`publicKeyCose`、`publicKeySpki`、`publicKeyPem`，以及註冊時的原始 `clientDataJSON`、`attestationObject`）。
- 每組向量：`expectedChallenge`、`storedSignCountBefore`、`authenticatorData`、`clientDataJSON`（另附解碼後的 `clientDataJSONText` 與 `clientDataHash` 方便除錯）、`signature`（DER）、`expected`（`ok` 與失敗代碼）。
- 二進位值一律 base64url、無 padding，和資料庫的約定相同。被簽的資料＝`authenticatorData || SHA-256(clientDataJSON)`。

交叉比對（只讀呼叫資料庫探針已建好的函式）：`sgn_crypto.es256_verify(message, signature, sgn_crypto.p256_spki_to_point(publicKeySpki))` 的結果：

| 向量 | Node | 資料庫純 PL/pgSQL |
|---|---|---|
| valid | 簽章有效、整體通過 | `t` |
| tampered-signature | `SIGNATURE_INVALID` | `f` |
| tampered-clientDataJSON | `SIGNATURE_INVALID` | `f` |
| replay-other-challenge | 簽章有效，但 `CHALLENGE_MISMATCH` | `t`（簽章本身有效；擋下它要靠比對挑戰值） |

注意：資料庫的 `es256_verify` 收的是 65 bytes 的未壓縮點，不是 SPKI；要先經過 `p256_spki_to_point`。上面的指令是在本 session 手動執行的，**沒有**寫成自動測試（避免改到 `probe/db`）。整合者把向量接進資料庫的測試時，可以照這張表斷言。

## 4. 給下一位的介面說明

整合者的方向是「資料庫驗證、後端不驗」。Node 端的驗證器在正式路徑裡不需要，它的角色是：

1. **對照組**：同一份原始資料，Node（OpenSSL）與資料庫（純 PL/pgSQL）的成敗必須一致。新增攻擊情境時，可以先在 Node 端產生資料、確認結果，再交給資料庫驗。
2. **測試向量的產生器**：`passkey.test.ts` 用真的 Chromium 產生資料。若資料庫那邊的 origin 改了，改 `FRONTDOOR_PORT` 或 `rp-server.ts` 的 rpId／origin 後重跑即可。

要換成資料庫的地方（若有人想把這個對照組直接接上資料庫）：

| 函式 | 現在 | 換成 |
|---|---|---|
| `ChallengeGenerator`（`webauthn/challenge.ts` 的 `randomChallenge`） | 32 bytes 亂數，記憶體內記住、一次性 | 呼叫 `api.challenge_issue(session, case_id, decision)` 或 `api.passkey_register_begin(session)`，用回傳的 `challenge_id`、`challenge`、`binding` |
| `ChallengeRegistry.take` | 記憶體內，取出即作廢（不論成敗） | 由資料庫的 `decision_prepare`／`challenge_consume` 處理。**語意不同**：資料庫是「驗證失敗不消耗、可重試」，這裡是「試一次就作廢」 |
| `PasskeyService.finishConfirmation` 裡的 `verifyAssertion` | Node 驗 | `api.case_decide_passkey(challenge_id, decision, credential_id, authenticator_data, client_data_json, signature)`；欄位名稱與編碼和這裡的證據紀錄一一對應 |
| `CredentialStore` | 記憶體內 | 資料庫的通行金鑰登記。資料庫要的是 SPKI（`response.getPublicKey()`），本模組同時保存 COSE、SPKI、PEM |

### 寫了但不再維護的檔案

`probe/api/src/frontdoor/` 底下的 `server.ts`（node:http 的最薄後端：`/auth/login`、`/auth/oidc/callback`、`/auth/me`、`/webauthn/*`、`/webauthn/evidence`）、`oidc.ts`（PKCE、state、nonce、以 JWKS 驗 RS256 ID token、at_hash）、`session.ts`（記憶體內工作階段、httpOnly cookie、登入後換 id）、`config.ts`（讀 sim 的 env 檔）：**型別檢查過，沒有實際啟動或跑過測試**。登入改由整合者以「資料庫驗 ID token」的方式做，這幾個檔案只留作參考；不需要就刪掉。

LDAP 人員模組（`people.ts` 與命令列腳本）：**跑過**一次（對 sim 讀到 35 人、35 個群組，主管關係與群組正確），但因為它需要 `ldapts` 而整合者的 `package.json` 沒有這個套件，已從 `src/frontdoor` 移除；原始碼在 git 提交 af48e463 的 `probe/api/src/people.ts` 與 `probe/api/scripts/people.ts`（`git show af48e463:probe/api/src/people.ts`）。目錄觀察：sim 的 LDAP 已是新版名單 35 人（p01–p35），與 `docs/contract/seed-directory.md` 一致；但 LDAP 沒有「公司」欄位（HQ／JP），p31–p35 屬於 JP 這件事目前讀不出來。

## 5. 通行金鑰流程的步數

從按下「用通行金鑰確認」到看到結果：

| 步 | 動作 | 測試裡 |
|---|---|---|
| 1 | 點「用通行金鑰確認」 | `page.tap('#confirm')` |
| 2 | 驗證器的使用者驗證（實機：Face ID／指紋／螢幕鎖 PIN） | 虛擬驗證器自動通過（`isUserVerified`、`automaticPresenceSimulation`） |

**共 2 步**，虛擬驗證器下耗時約 80 ms。實機上可能多出的步驟（沒有實測）：

- 裝置上同一個網站有多把通行金鑰時，系統會先跳出帳號選擇（＋1）；`allowCredentials` 只列這位使用者的金鑰可以避免大部分情況。
- 通行金鑰在另一台裝置（例如電腦上核准、金鑰在手機）：掃 QR code 並在手機上驗證（＋2 以上），而且需要藍牙。
- 第一次使用前要先註冊：本測試是 1 次點擊＋1 次使用者驗證。

## 6. 遇到的困難

- **兩個代理同時寫同一個目錄**。整合者在我寫到一半時改寫了 `probe/api` 的 `package.json`、`tsconfig.json`、`config.ts`、`oidc.ts`，並把我的檔案移到 `.previous-attempt/`。協調者介入後縮小範圍，我的檔案集中到 `src/frontdoor/`。教訓：同一個目錄只能有一位負責人，平行派工要先切開目錄。
- **我自己的錯**：一次 `cd` 失敗後，`.npmrc`、`.gitignore` 被寫到 repo 根目錄、`npm install` 在根目錄產生 `package-lock.json`，而且被自動 wip 提交收進去（abebc2e3），連帶讓 `sim/.run/`（含 35 MB 的 dex 執行檔）被提交。我已把根目錄的 `.gitignore` 還原、刪掉多出的 `.npmrc` 與 `package-lock.json`，並回報協調者；git 歷史與已進索引的 `sim/.run/` 要由協調者處理。之後的指令一律用絕對路徑。
- WebAuthn 的 rpId 不能是 IP：sim 登記了 `127.0.0.1` 與 `localhost` 兩個 redirect URI，要用 `localhost` 才走得通整條路。
- 資料庫的 `es256_verify` 收原始點而不是 SPKI，交叉比對時才發現；向量檔同時給 COSE、SPKI、PEM 以免再踩到。

## 7. 沒做到

- 登入（Dex OIDC）、`/auth/me`、頁面外殼、林怡君登入的端對端測試：協調者改派給整合者；`src/frontdoor` 裡的版本沒有實際跑過。
- `probe/api/README.md` 第一行的指向：那是整合者的共用檔案，沒有改。
- attestation 不驗（`none`）：不知道驗證器的出身；虛擬驗證器本來就不提供可信的 attestation。
- RS256 通行金鑰的路徑寫了（`pubKeyCredParams` 有 -257、`verifyAssertion` 支援），但虛擬驗證器只產生 ES256，**沒有測到**。
- 計數器倒退（`COUNTER_REGRESSED`）有程式，但沒有獨立的測試案例（虛擬驗證器的計數器一直遞增，重放案例先被挑戰值擋下）。
- 實機（iOS／Android）沒有測；步數是依虛擬驗證器與平台行為推算。
- 工程規範第 6 節的 ESLint、Prettier、knip：沒跑；只跑了 `tsc`。

## 8. 對「手機上用通行金鑰核准，幾步內完成」這個賭注的看法

- **步數上成立**：確認本身是 2 步（按鈕＋生物辨識），在 `ux-acceptance.md` T1／T2 的 4 步上限內，還留 2 步給「打開單」與「確認對話框」。
- **流程上不會卡在協定**：真的 Chromium 走完註冊與簽署，Node 與資料庫兩邊對同一份資料的判定一致；驗證本身不是瓶頸（資料庫 p95 約 21 ms）。
- **風險在協定以外**：(1) 驗證器的系統畫面不顯示要核准的內容，使用者看到的內容與簽的挑戰值是否一致，全靠前端與資料庫的綁定，這點資料庫探針已列為殘餘風險；(2) 跨裝置（金鑰不在這支手機）會多出 QR code 與藍牙，步數與成功率都會變差；(3) 第一次註冊、換手機、遺失手機的復原流程還沒有設計，這會是使用者真正卡住的地方。建議下一步在實機上量 T1、T2，並把「金鑰不在這台裝置」當成一個獨立的驗收情境。
