# 金鑰與密鑰的輪替

結論：

- 系統裡有 **13 種**金鑰或密鑰（§1）。其中由平台自己產生的（資料庫角色密碼、錨點寫入金鑰、交付簽章金鑰）**目前只在 `db/build.sh` 重建時更換**，而重建會刪掉資料庫。
- **不能拿 `db/tools/provision-secrets.mjs` 單獨來「重發密鑰」**：它每次都重新產生錨點寫入金鑰，而且會清空錨點存放處的資料檔（`closeSync(openSync(file, 'w'))`）。在有資料的系統上執行它等於丟掉全部外部錨點。
- 不刪資料的輪替工具程式裡沒有，需要補（gaps G-05）。下面每一種都寫了「現在能怎麼做」與「缺什麼」。

## 1. 清單（從程式查出來的）

查法：`db/tools/lib/programs.mjs`（每個程式的密鑰鍵）、`db/tools/provision-secrets.mjs`（值從哪來）、`db/build.sh`（角色密碼、簽章金鑰）、`db/tools/lib/env.mjs`（sim 的密碼檔）、`grep -n "create table sgn\.[a-z_]*key" db/kernel/*.sql`（資料庫裡的金鑰表）。

| # | 名稱 | 用途 | 存在哪 | 誰讀得到 | 誰產生 |
|---|---|---|---|---|---|
| K1 | 資料庫登入角色密碼（`sgn_app`、`sgn_sync`、`sgn_scheduler`、`sgn_reconciler`、`sgn_anchor`、`sgn_mailer`、`sgn_delivery`、`sgn_idp_keys`；測試庫另有 `sgn_test_verifier`） | 各程式連資料庫 | `.run/secrets/roles.env`（全部，0600）；`.run/secrets/<程式>.env` 的 `SGN_DB_PASSWORD`（各自一份，0400，擁有者 `sgn-<程式>`） | root；各程式帳號只讀得到自己的 | `db/build.sh` 的 `recreate_roles`（`openssl rand -hex 24`），每次建置都換 |
| K2 | 資料庫管理者連線 | 建置、migration、破窗 | 沒有密碼：只限本機 unix socket 的 peer（作業系統帳號 root → 同名 superuser，`db/admin.env`）；`pg_hba.conf` 拒絕 superuser 經 TCP | 主機的 root | `db/build.sh` 的 `secure_admin`（清掉所有 superuser 的密碼） |
| K3 | 交付簽章私鑰（Ed25519） | 平台對外部系統的交付信封簽章 | 資料庫 `sgn.signing_key.seed`（一次只有一把未退役） | 只有 `sgn_owner`（與 superuser）；**資料庫備份裡也有** | `sgn_internal.signing_key_create`（`db/build.sh` 建置時呼叫） |
| K4 | 外部系統回應證明的公鑰（P-256） | 驗外部系統的套用、驗證、對帳、使用摘要回應 | `sgn.channel_key`（每通道可多把） | 公鑰，不機密；寫入只有 owner | 外部系統產生；`db/tools/delivery-keys.mjs` 以 `sgn_internal.channel_key_register` 登記 |
| K5 | 外部系統的呼叫金鑰：platform（交付用） | delivery 呼叫外部系統 | `.run/secrets/delivery.env` 的 `SGN_DC_KEY`；來源 `sim/.run/dc/keys/secrets.env` | `sgn-delivery`、root | 外部系統 |
| K6 | 外部系統的呼叫金鑰：auditor（唯讀，對帳用） | reconciler 拉回報 | `.run/secrets/reconciler.env` 的 `SGN_DC_KEY` | `sgn-reconciler`、root | 外部系統 |
| K7 | 錨點寫入金鑰 | anchor 寫入存放處 | `.run/secrets/anchor.env` 的 `SGN_ANCHOR_WRITE_KEY`；存放處只存 SHA-256（`anchor-store.env` 的 `SGN_ANCHOR_WRITE_KEY_SHA256`） | `sgn-anchor`（本體）、`sgn-anchor-store`（雜湊）、root | `provision-secrets.mjs`，每次建置都換 |
| K8 | 身分提供者 client secret | api 的 OIDC 登入 | `.run/secrets/api.env` 的 `SGN_IDP_CLIENT_SECRET`；來源 `sim/.run/idp/secrets.env` | `sgn-api`、root | 身分提供者（模擬環境由 `sim/idp/lib.sh` 產生） |
| K9 | 身分提供者的簽章公鑰 | 驗登入的 ID token | `sgn.idp_key`、`sgn.idp_key_trust` | 公鑰；寫入只有 `sgn_idp_keys`（經 `api_idp.idp_keys_sync`）與 owner | 身分提供者；第一次由 `db/tools/idp-keys-sql.mjs` 登記，之後 idp-keys 程式自動 |
| K10 | 使用者的通行金鑰（公鑰） | 每個簽核決定的證明 | `sgn.passkey_credential` | 公鑰；私鑰在使用者的裝置 | 使用者登記（背書、冷卻，D65） |
| K11 | 工作階段 token | 登入後的工作階段 | 資料庫只存雜湊（`sgn.auth_session.token_hash`） | — | 登入時產生 |
| K12 | 人員目錄的讀取帳號密碼 | `directory-sync.mjs` 連 LDAP | `sim/.run/ldap/secrets.env` 的 `SIM_LDAP_READER_PASSWORD` | root | 模擬環境由 `sim/ldap/lib.sh` 產生；正式環境屬於公司目錄 |
| K13 | 登記人的軟體金鑰（**只在開發環境**） | 測試扮演登記人 | `.run/registrar-<資料庫>.json` | root | `db/tools/bootstrap-registrar.mjs` |

不在清單內但要注意：SMTP 目前沒有帳密（`api/src/smtp.ts` 只有 host、port）；正式環境若需要 SMTP 認證，程式裡沒有地方放（gaps G-01）。角色 `key_custodian`（金鑰保管人）定義在 `210_role_registry.sql`，但沒有任何 function 用到它。

## 2. 共通原則

- 每個程式只拿自己的密鑰（D81 (1)）；輪替時也只發給那一個程式，不要把整份 `roles.env` 複製到別處。
- 密鑰不進 git、不進 log、不進聊天或郵件；`.run/` 已列入 `.gitignore`，`tools/check.sh` 也檢查 `.run/` 沒有被追蹤。
- 每次輪替留紀錄（§4），由資安長或其代理人複核。

## 3. 各類的輪替步驟

### 3.1 資料庫角色密碼（K1）

- 現在能做的（**未演練**）：以管理者連線改單一角色的密碼，再改寫那個程式的密鑰檔並重啟它。
  ```bash
  source db/sgn.env; source db/admin.env
  psql -X "${SGN_PG_ADMIN_URL%/*}/postgres" -c "alter role \"$SGN_ROLE_MAILER\" password '<新密碼>'"
  ```
  然後以 root 改 `.run/secrets/mailer.env` 的 `SGN_DB_PASSWORD`（保持 0400、擁有者 `sgn-mailer`）與 `roles.env` 的對應列，`kill "$(cat .run/mailer.pid)"` 讓監看重啟。新密碼用 `openssl rand -hex 24`（與 `db/build.sh` 相同）。
- 缺什麼：沒有一支只換一個角色、同時改兩個檔、保留權限與擁有者的工具（gaps G-05）。手動改檔容易弄錯權限；改完要跑架構測試 95、97 的同等檢查，但那兩個測試只在建置時跑。
- 驗證：該程式的心跳恢復（稽核頁背景程式全綠）；舊密碼連不上。

### 3.2 錨點寫入金鑰（K7）

- 現在能做的（**未演練**）：以 root 產生新金鑰，同時改 `anchor.env` 的 `SGN_ANCHOR_WRITE_KEY` 與 `anchor-store.env` 的 `SGN_ANCHOR_WRITE_KEY_SHA256`（新金鑰的 SHA-256 十六進位），先重啟 anchor-store、再重啟 anchor。**不要跑 `provision-secrets.mjs`**（會清空存放處）。
- 驗證：anchor 的 log 出現新的 `{"ok":true,...}`；`curl -fsS "$SGN_ANCHOR_ORIGIN/anchors"` 最後一筆時間更新；`node db/tools/verify-chain.mjs <資料庫>` 回 0。

### 3.3 交付簽章金鑰（K3）與外部系統的信任清單

- 機制已在程式裡：`sgn_internal.signing_key_create('<新 key_id>')` 會把舊的退役、產生新的、進鏈（`delivery.signing_key_created`），回傳新公鑰 PEM。外部系統的信任清單只放目前那一把（D81 (2)）。
- 步驟（**未演練**；開發環境由 `db/tools/delivery-keys.mjs` 一次做完「讀目前公鑰 → 寫 sim/dc 的信任清單 → 登記 sim/dc 的回應公鑰」，之後要重啟 sim/dc 實例）：
  1. 和外部系統的管理人約定時間（換的瞬間到外部系統更新信任清單之間，交付會被拒，開 K-DELIVERY-REJECTED）。
  2. 停 delivery。
  3. 以 owner 執行 `select sgn_internal.signing_key_create('<新 key_id>')`（破窗等級的連線，留紀錄）。
  4. 把回傳的 PEM 交給外部系統，換掉它的信任清單。
  5. 啟動 delivery，觀察沒有新的 K-DELIVERY-REJECTED。
- 缺什麼：沒有新舊並存的過渡期（`signing_key_one_current` 唯一索引只允許一把）；正式環境沒有對應 `delivery-keys.mjs` 的工具。

### 3.4 外部系統的回應公鑰（K4）與呼叫金鑰（K5、K6）

- 回應公鑰：外部系統換金鑰時，以 owner 呼叫 `sgn_internal.channel_key_register(<通道>, <key_id>, <PEM>, false)` 先讓新舊並存，外部系統切換後再以 `p_only => true` 重登一次讓舊的退役。並存期間舊金鑰仍被採信，要盡量短。
- 呼叫金鑰：由外部系統發新的；改 `delivery.env`／`reconciler.env` 的 `SGN_DC_KEY`，重啟該程式；外部系統撤銷舊的。
- 驗證：K-RECON-UNVERIFIED、K-USAGE-UNVERIFIED、K-DELIVERY-REJECTED 沒有新增；對帳回報照常收下。

### 3.5 身分提供者（K8、K9）

- client secret：由身分提供者發新的，改 `api.env` 的 `SGN_IDP_CLIENT_SECRET`，重啟 api。
- 簽章金鑰：身分提供者輪替後由 idp-keys 程式自動信任（開 K-IDP-KEY-NEW 並通知治理角色）。**輪替前先通知治理角色**，否則他們無法分辨正常輪替與冒用（34 a 殘餘，D85 (3)）。一個時間窗內新增超過 `identity.idp_key_new_max`（2）把會被擋（K-IDP-KEY-LIMIT）。
- 驗證：能正常登入；K-IDP-KEY-NEW 的 kid 和身分提供者管理人提供的一致。

### 3.6 通行金鑰（K10）

使用者自己的金鑰沒有定期輪替；遺失、離職、可疑時走平台內的撤銷、停用、重新登記流程（`api.passkey_revoke_*`、`api.passkey_revoke_self`，背書與冷卻見 D65、D84、D88）。登記人不足時見 [break-glass.md](break-glass.md)。

### 3.7 建議的輪替頻率（**建議值，待資安長核定**）

| 類別 | 頻率 |
|---|---|
| K1、K7 | 每年，或有人員異動（能讀到 root 的人離職）時 |
| K3、K5、K6 | 每年，配合外部系統 |
| K8 | 依身分提供者的政策，至少每年 |
| K9 | 由身分提供者決定 |

## 4. 外洩時的處置

| 外洩的是 | 最壞會怎樣（依 D81、D84 的分析） | 立即要做的 |
|---|---|---|
| K1 某一個角色的密碼 | 只能執行那個程式在路由表裡的 function（例如 `sgn_mailer` 可以把通知標成已寄而不寄） | 換那個角色的密碼（§3.1）；查該角色期間內的呼叫（稽核鏈的事件） |
| K2 主機 root | 能做任何事，包括改資料庫、改錨點檔、讀所有密鑰 | 視為整套淪陷：資安長主導；用存放處以外另存的錨點副本驗鏈（backup-restore.md §4）；換掉所有 K1、K3、K5–K8 |
| K3 交付簽章私鑰（或任何一份資料庫備份） | 能以平台名義對外部系統簽交付，直接開權限 | 立刻換簽章金鑰（§3.3）並請外部系統只信任新的；對帳找出期間內多出來的權限（K-RECON-EXTRA） |
| K5 platform 呼叫金鑰 | 能冒充交付程式呼叫外部系統，但沒有簽章私鑰時送不出有效的交付 | 請外部系統撤銷並換發 |
| K6 auditor 金鑰 | 能讀外部系統的權限清單 | 同上 |
| K7 錨點寫入金鑰 | 能寫入序號更大的假錨點（存放處只收更大的序號，寫不了更小的）；假錨點會讓之後的真錨點寫不進去（`not_newer`），開 K-ANCHOR-LAG | 換金鑰（§3.2）；把存放處裡外洩期間的錨點和資料庫重算結果比對（`verify-chain.mjs` 會報 `ANCHOR_BEYOND_HEAD` 或 `ANCHOR_MISMATCH`）；清掉假錨點**程式裡沒有工具**，要以破窗處理並留紀錄 |
| K8 client secret | 能以平台名義向身分提供者換 token；不能做決定（決定要通行金鑰） | 請身分提供者換發；改 `api.env` |
| K9 身分提供者私鑰（在身分提供者那邊） | 能冒用任何人登入；只能做 D84 (2) 分類過「只憑登入」的動作 | 請身分提供者輪替；檢查期間內的停用、撤銷、確認事件 |
| K10 某人的通行金鑰 | 能以他的名義做決定 | 本人或主管撤銷；檢查期間內他做的決定 |
