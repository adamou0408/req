# 維運基礎實作計畫

- 撰寫日期：2026-11-21。對象：D99 (d) 排定的「維運基礎」這一批的實作者。
- 依據（都讀過）：`CLAUDE.md`、`docs/engineering-standards.md`、`docs/ops/` 全部（尤其 [gaps.md](gaps.md)）、`docs/decision-log.md` D81–D100、`docs/contract/00-spine.md` §4.4、§14.2、§14.3、`db/build.sh`、`db/tools/` 全部、`tools/run-all.sh`、`tools/check.sh`、`db/kernel/10_audit_chain.sql`、`495_anchor_lag.sql`、`515_exception_close.sql`、`525_program_liveness.sql`、`390_notification_stuck.sql`、`410_delivery.sql`、`485_reconciliation_rounds.sql`、`540_closed_loop.sql`、`api/src/config.ts`、`db/tests/kernel/60-chain.test.mjs`、`92-program-stall.test.mjs`、`90-contract.test.mjs`、`redteam/exploits/`。
- 這份是計畫，不是程式。每項寫到「實作者不必再做設計決定」；真的需要負責人給事實的地方集中在 §10，每題附建議預設，實作者在負責人回答前照預設做並在 handoff 標明。
- 本計畫不修改任何業務規則（`docs/packs/*/rules.md`）；新增的都是核心（`K-*`）的平台規則。

## 0. 先讀：現況的事實與全域決定

### 0.1 現況（實作前請再核對一次）

| 事實 | 位置 |
|---|---|
| migration 在 `db/kernel/NNN_*.sql`（最新 `565_screen_fixes.sql`）與 `db/packs/data_access/NNN_*.sql`（最新 `170_export_survey.sql`），沒有 `db/migrations/`；近期編號每次 +5 | `ls db/kernel db/packs/data_access` |
| 套用順序的唯一實作是 `db/build.sh` 的 `migration_files()`（`sort -V`；核心 → 流程包；`01_core.sql` 與 `90_grants.sql` 特別處理）；`pgcrypto` 由 superuser 裝進 `sgn_internal` | `db/build.sh` 66–127 行 |
| `db/build.sh` 一開始就 `drop database ... with (force)` 三個庫、刪掉所有角色重建、`rm -rf .run/secrets`、清錨點檔 | `recreate_roles`、218 行 |
| `provision-secrets.mjs` 每次重產錨點寫入金鑰，並 `closeSync(openSync(file, 'w'))` 清空錨點檔 | 30、66–71 行 |
| 程式指紋只算 `sgn`、`sgn_internal`、`api`、`api_sync`、`api_job`、`api_verified`；只算 function、trigger（含 `tgenabled`）、資料表權限與擁有者，不含限制、索引、欄位、其他 schema | `10_audit_chain.sql` 158–183 行 |
| 防改寫 trigger 共 25 個（核心 12：`10_audit_chain` 5、`100_settings` 2、`240_decision_proof_only_passkey` 1、`545_usage_summary` 4；流程包 13：`070` 1、`130` 6、`160` 4、`170` 2），全部是預設的 `ENABLE`（`O`），`session_replication_role = replica` 可繞過 | `grep -rn "create trigger" db/kernel db/packs` |
| 錨定程式遇到指紋改變回 `CODE_CHANGED` 並以結束碼 2 結束；資料庫的 `anchor_recorded` 也要求回報的指紋等於目前指紋 | `chain-lib.mjs` `anchorOnce`、`495_anchor_lag.sql` |
| 鏈頭 trigger 只允許「前進一格」 | `10_audit_chain.sql` `audit_head_check` |
| 登入會寫稽核事件（`session.opened`、`session.closed`） | `30_identity.sql` 223、249 行 |
| 例外結案的唯一入口 `sgn_internal.exception_close(p_id bigint, p_detail jsonb)` 已存在，進鏈；8 種代碼有自動結案 | `515_exception_close.sql`；`docs/ops/exceptions.md` |
| 對帳發現結案（K-RECON-RESOLVED）只標 `reconciliation_finding.resolved_run_id`，不結例外 | `485_reconciliation_rounds.sql` `reconciliation_resolve` |
| 心跳：`sgn.program` 六列（jobs、mailer、delivery、reconciler、anchor、idp-keys）；從沒回報的程式以「任何程式的第一次心跳」起算 | `525_program_liveness.sql` |
| `api` function 的第一個參數必須是 `p_session` 或 `p_challenge_id`，或沒有參數；`session_begin` 例外 | `90-contract.test.mjs` 106–116 行 |
| 授權的唯一入口 `sgn_internal.authorize`／`denial_reason`，依 `sgn.action`（`actor_rule = 'role'` 時讀 `role_setting` 參數） | `40_case.sql`、`140_case_model.sql`、`220_role_change.sql` |
| 通行金鑰簽章的唯一公式 `sgn_internal.signing_challenge(purpose, ref, content, decision, nonce)`，瀏覽器端 `web/lib/signing.js`；驗章入口 `sgn_internal.signature_verify` | `250_signing.sql` |
| `passkey.registered` 事件只記 `public_key_sha256`，不記 SPKI | `260_passkey_enrollment.sql` 298 行 |
| 交付簽章金鑰一次只能一把未退役（唯一索引 `signing_key_one_current`）；sim/dc 的信任清單是 `{keys: [...]}`，本身可以放多把 | `410_delivery.sql` 181 行；`sim/dc/src/cli.ts` |
| 背景程式清單的唯一來源 `db/tools/lib/programs.mjs`；但 `tools/run-all.sh` 的 `stop_bg` 手抄了一份名單 | `run-all.sh` 27 行（這是 SSOT 缺陷，本計畫順手收斂） |
| PostgreSQL 主版本寫死在 `db/build.sh` 與 `tools/install-dev-tools.sh`（G-15） | — |
| 61 個 `redteam/exploits/*.mjs`（`00-*` 是共用函式庫）；沒有任何一支用 `session_replication_role` 或 `disable trigger`；`10-authz-blocked` 只建 `pg_temp` 的 function | `grep -rnE "create (or replace )?function\|disable trigger" redteam/exploits` |

### 0.2 全域決定（各項共用，只實作一次）

下面五個機制被多項共用。各項只引用，不另寫一套（工程規範 §2「每一類橫切邏輯只有一個入口」）。

**G1. 環境身分與模式（`sgn.environment`，項 1 實作）**
- 一列：`environment_id`（uuid）、`kind`（`production`｜`verification`）、`mode`（`normal`｜`maintenance`｜`restore_pending`｜`isolated`，取自骨幹 §14.3，`bootstrap`、`archive` 不在這一批）。
- 寫入閘門放在**寫稽核事件的唯一入口** `sgn_internal.audit_append` 的第一行：模式不是 `normal` 時，只允許資料表 `sgn.environment_mode_event` 列出的事件種類（例如登入、兩人確認），其餘丟 `ENVIRONMENT_READ_ONLY`。因為每個狀態變更都必須寫事件（K-AUDIT-APPEND），擋住寫事件就擋住所有業務寫入，不必逐一改 function。
- 以 superuser 連線（`session_user` 的 `rolsuper`）的工具（migrate、restore）不受閘門限制：它們本來就能做任何事，擋它們只會逼人繞過；它們的動作另外以事件留在鏈上。
- 沒有環境列時（全新建置、`575` 之前的檔案在套用中）不擋。

**G2. 主機標記（`/etc/sgn/environment`，項 1 實作）**
- 正式主機上由 `db/install.sh` 寫入，root 擁有、0644，內容 `SGN_ENVIRONMENT_KIND=production`、`SGN_ENVIRONMENT_ID=<uuid>`、`SGN_DATABASE=<名稱>`。
- 用途兩個：(a) 會刪資料的工具（`db/build.sh`、`tools/run-all.sh`、`tools/check.sh`、`provision-secrets.mjs`）看到它就拒絕；(b) 啟動前檢查（項 2、項 5）比對它和資料庫裡的 `environment_id`，不同就是「還原了別的環境的備份」。
- 路徑固定，不提供覆寫的環境變數（覆寫就等於關掉防呆）。測試用的是「檢查函式收一個路徑參數」，正式呼叫點寫死常數。

**G3. 兩人確認（`sgn.ops_attestation`，項 1 後半實作，項 2 重用）**
- 一個「由 root 端工具提案、由兩位平台內的人以通行金鑰確認」的通用機制。種類（`kind`）：`code_fingerprint`（G-01b）、`restore_gap`（K-RESTORE-GAP）。之後的破窗補登也能用（不在這一批）。
- 第一位：參數 `ops.attest_first_roles`（預設 `["tech_ops"]`）的持有人；第二位：參數 `ops.attest_second_roles`（預設 `["ciso", "audit_head"]`）的持有人；兩人不同；兩人都不得是提案內容裡列為當事人的人。參數可依種類（`attest_kind:<種類>`）設定不同值。
- 簽的內容是提案的完整主體（`subject`），簽章、簽章者的 SPKI 與 credential id 全部進鏈，**離線工具與稽核頁不靠資料庫就能重驗**（見項 1 的「離線驗章」）。這是它和「資料庫裡記一筆核准」的差別：superuser 可以偽造資料列與事件，偽造不了別人通行金鑰的簽章。

**G4. 操作者事件（`sgn_internal.ops_event_record`，項 1 實作）**
- root 端工具（migrate、backup、restore、rotate）做的事都經這一個 owner 專用的入口進鏈。事件種類只能是 `sgn.ops_event_kind` 列出的（`ops.migration_applied`、`ops.backup_completed`、`ops.restore_drill_completed`、`ops.secret_rotated`、`ops.environment_mode_changed` 等），detail 一律帶 `operator`（作業系統帳號，`SUDO_USER` 或 `id -un`）與 `change_ref`（升級單或作業單號，必填）。
- 事件內容**不得含任何密鑰或其雜湊**（測試檢查）。

**G5. 執行期狀態與設定的位置（項 5 實作，項 1 先用預設值）**
- 新環境變數（定義在 `api/src/config.ts` 的 `envVars`，見項 5）：`SGN_CONFIG_DIR`（非機密設定，預設 `db/`；正式環境必須是 `/etc/sgn`）、`SGN_STATE_DIR`（密鑰、錨點檔、log，預設 `.run/`；正式環境 `/var/lib/sgn`）、`SGN_PROFILE`（`sim`｜`production`，預設 `sim`）。
- `db/tools/lib/env.mjs` 的 `DB_DIR/sgn.env`、`RUN_DIR`、`SECRETS_DIR` 改由這兩個目錄決定；預設值讓開發與驗證主機完全不變。

### 0.3 命名與編號

- 核心 migration 從 `570` 起每次 +5；流程包 `data_access` 從 `175` 起每次 +5。只增不改。
- 新的資料庫測試檔放 `db/tests/kernel/99-ops-<主題>.test.mjs`（排在既有 `98-anchor-lag` 之後）；流程包的放 `db/tests/packs/data_access/95-<主題>.test.mjs`。測試名稱以規則代碼開頭（`db/tools/rule-coverage.mjs` 以 `test('<代碼> ...` 檢查）。
- 每批完成寫 `docs/handoff/ops-foundation-<批號>.md`，並更新 `docs/handoff/README.md` 的索引、`docs/ops/` 對應文件與 `gaps.md` 的狀態欄。

## 1. 不刪資料的安裝與升級（G-01 的資料庫部分、G-01b、G-14、G-15）

### 1.1 設計

**migration 套用紀錄**
- 兩張表：一次執行一列（`sgn.migration_run`），一個檔案一列（`sgn.migration_applied`）。檔名用 repo 相對路徑（`db/kernel/570_environment.sql`），雜湊是檔案位元組的 SHA-256。兩張表只增不改，trigger `ENABLE ALWAYS`。
- 「已套用檔被改動」「已套用檔不見了」「新檔排在已套用檔之前」的判斷放在 SQL（`sgn_internal.migration_check`），Node 只負責讀檔與算雜湊——判斷規則只有一處。
- 全新安裝時，`575` 之前的檔案在紀錄表存在前就套用了：`migrate.mjs` 先在記憶體記下它們的檔名與雜湊，`575` 一套完就在同一個連線裡補記。全新安裝中途失敗時資料庫狀態不明，工具拒絕繼續並要求刪庫重來（全新安裝沒有資料，可以重來）。
- 既有的資料庫沒有紀錄表、但有 `sgn` schema：拒絕（`MIGRATION_UNKNOWN_STATE`）。理由：目前沒有任何正式環境，所有既有資料庫都是驗證用、可重建；不寫「認養」流程，就不會有人把來路不明的資料庫認養成正式環境。
- 每個待套用的檔案各自一個交易：`begin; set role sgn_owner; \i <檔>; reset role; select sgn_internal.migration_record(...); commit;`。實作者先 `grep -rniE "concurrently|alter type .* add value|vacuum" db/kernel db/packs` 確認沒有不能在交易內執行的語句（撰寫時沒有）；之後的 migration 若需要，架構測試會擋（見測試）。
- 一次執行結束只寫**一筆**事件 `ops.migration_applied`（列出所有檔案與雜湊、執行前後的指紋），不是每檔一筆。

**`migrate.mjs` 成為套用順序的唯一來源**
- `db/build.sh` 的 `migration_files()` 移到 `db/tools/migrate.mjs`；`build.sh` 改呼叫 `migrate.mjs --mode fresh`。驗證主機的每次建置因此也走同一條路徑、也有紀錄表——正式環境的升級工具每次 `tools/check.sh` 都被跑過。
- 檔案清單另外產生一份 `db/generated/migrations.lock`（檔頭「自動產生，請勿手動修改」；每行 `<相對路徑> <sha256>`，依套用順序）。用途：
  - G-14：`tools/check.sh` 新增一段，重新產生後必須無差異，而且 **git 歷史上每一版 lock 的每一行都必須原樣出現在現在這一版、順序不變**（`git log --format=%H -- db/generated/migrations.lock` 逐版比對）。這不需要發行標籤，改舊檔或刪舊檔都會失敗。
  - 正式環境升級時，`migrate.mjs` 先比對磁碟上的檔案和 lock（部署的檔案樹沒被改過），再和資料庫的紀錄表比對。

**升級時的模式**
- `db/migrate.sh` 開始時把模式設為 `maintenance`，結束時：
  - 第 1 批（還沒有兩人確認）：設回 `normal`，印出新指紋與「錨定會回 CODE_CHANGED，照現行 upgrade.md 處理」——和現況一樣，沒有退步。
  - 第 2 批起：指紋有變就建立 `code_fingerprint` 提案並**維持 `maintenance`**，兩人確認後才回 `normal`（建議預設；§10 第 7 題）。理由：確認之前寫進鏈的事件是在「還沒被承認的程式」下產生的。

**`db/build.sh` 的防呆**
- 新檔 `db/lib/guard.sh`，函式 `sgn_refuse_if_production`，任一成立就印出理由並 `exit 3`：
  1. `/etc/sgn/environment` 存在（G2）；
  2. 叢集裡任何一個資料庫有 `sgn.environment` 且 `kind = 'production'`（逐一連 `pg_database` 的非範本庫查，查不到表就跳過）；
  3. 要被刪的三個庫（`SGN_DB_TEST`、`SGN_DB_E2E`、`SGN_DB_BENCH`）任一存在，且 `sgn.person_identity` 有來源不在 `db/sgn.env` 新鍵 `SGN_SIM_IDENTITY_SOURCES`（預設 `sim-ldap`）裡的人——即有真實人員資料（實作者先核對 `sgn.person_identity` 的來源欄位名稱與 `directory-sync.mjs` 的 `SOURCE = 'sim-ldap'`）。
- 呼叫點：`db/build.sh`（`secure_admin` 之前）、`tools/run-all.sh`（`stop_bg` 之前，它會殺程式）、`tools/check.sh`（第一段）、`db/tools/provision-secrets.mjs`（以 `execFileSync('bash', ['db/lib/guard.sh'])`）。
- 沒有「強制」旗標。

**`provision-secrets.mjs` 不再清空錨點檔**（項 6 要求，放在第 1 批因為它是防呆）
- 錨點檔：不存在才建立；存在就只修正擁有者與權限，**一律不截斷**。`db/build.sh` 第 218 行本來就先 `rm -f` 驗證庫的錨點檔，所以開發行為不變。
- 開頭呼叫 guard。

**程式指紋的承認（G-01b，第 2 批）**
- `migrate.mjs --mode upgrade` 結束時（以及 PostgreSQL 主版本升級後執行 `db/migrate.sh --refingerprint --change-ref <單號>`，不套任何檔案只重算指紋），以 owner 呼叫 `sgn_internal.ops_attestation_propose('code_fingerprint', <subject>, ...)`。subject：`{from: <最後一個被記下的錨點指紋，sgn.anchor_receipt 最後一列>, to: <目前指紋>, runs: [<這段期間的 migration_run id>], files: [{file, sha256}], change_ref, postgres_version}`。同一段期間已有未完成的提案就作廢（`superseded`）再開新的，新提案涵蓋所有執行。
- 兩人在平台的「維運確認」頁看到 subject、各自以通行金鑰簽。第二人簽完：寫事件 `ops.attestation_completed`（含兩個簽章與 SPKI），模式回 `normal`。
- 錨定程式（`chain-lib.mjs` `anchorOnce`）：最後一個錨點的指紋 L ≠ 目前指紋 C 時，呼叫新的 `api_job.code_fingerprint_attested(L, C)`；回傳已完成的確認且其事件序號大於 L 那個錨點的序號，才寫新錨點，錨點多一個欄位 `fingerprint_change: {from, to, attestation_seq}`；否則照舊 `CODE_CHANGED`、結束碼 2。存放處 `anchor-store.mjs` 不用改（它不檢查多出的欄位，仍要求序號變大）。
- `sgn_internal.anchor_recorded` 照舊要求回報指紋等於目前指紋（不用改）。
- 離線驗證（`verifyChain`）與稽核頁（`web/verify.js`）：相鄰兩個錨點的指紋不同時，後一個錨點必須有 `fingerprint_change`，而且鏈上在兩錨點之間有一筆 `ops.attestation_completed`（種類、from、to 相符），其中兩個簽章離線驗得過。不符就是新問題 `CODE_CHANGE_UNATTESTED`。原本的「目前指紋 vs 最後錨點」`CODE_CHANGED` 不變。
- **離線驗章**（一份實作兩處用）：新檔 `web/lib/webauthn-verify.js`，只用 WebCrypto（瀏覽器與 Node 22 都有 `crypto.subtle`）：以 `web/lib/signing.js` 的 `signingChallenge` 重算挑戰值；檢查 clientDataJSON 的 `type`、`challenge`、`origin`（事件裡記下當時的 `webauthn.origin`）、authenticatorData 的 rpIdHash 與 UP/UV 旗標；以 SPKI 驗 ES256（DER 轉 raw，只收 low-s，與 `250_signing.sql` 一致）；SPKI 的 SHA-256 必須等於鏈上同一個 credential 的 `passkey.registered` 事件的 `public_key_sha256`，且該 credential 在確認之前沒有撤銷或停用事件（實作者列舉 `passkey.*` 事件種類寫成常數表）；兩位簽章者的 `actor` 不同。
- 限制（寫進 handoff 與 backup-restore.md）：離線驗證證明「兩個不同人的已登記金鑰簽了這份內容」；簽章當時是否持有角色由資料庫在簽章時檢查並記在事件裡，離線不重算角色。

### 1.2 檔案

| 檔案 | 新增／修改 | 內容 |
|---|---|---|
| `db/kernel/570_environment.sql` | 新增 | G1、G4（`sgn.environment`、`sgn.environment_mode_event`、`sgn.ops_event_kind`、`environment_*`、`ops_event_record`、`audit_append` 加閘門、`api.environment_status`） |
| `db/kernel/575_migration_ledger.sql` | 新增 | 紀錄表與 `migration_*`、`api.ops_migrations` |
| `db/kernel/580_tamper_hardening.sql` | 新增 | 項 4（核心 trigger 改 ALWAYS、指紋 v2） |
| `db/packs/data_access/175_tamper_hardening.sql` | 新增 | 項 4（流程包 trigger 改 ALWAYS） |
| `db/kernel/585_ops_attestation.sql` | 新增（第 2 批） | G3 |
| `db/kernel/590_code_fingerprint_attest.sql` | 新增（第 2 批） | `code_fingerprint` 種類、`api_job.code_fingerprint_attested` |
| `db/tools/migrate.mjs` | 新增 | 唯一的套用順序；`--mode fresh|upgrade`、`--refingerprint`、`--print-lock`、`--database`、`--operator`、`--change-ref`、`--with-testing`、`--source-dir`（測試用，預設 repo） |
| `db/migrate.sh` | 新增 | root 檢查；主機標記存在時要求所有 `sgn-*` 寫入程式已停（第 5 批後以 `systemctl is-active` 檢查；之前只在驗證主機用）；呼叫 `migrate.mjs --mode upgrade`；最後跑 `grants-sql.mjs` |
| `db/lib/guard.sh` | 新增 | `sgn_refuse_if_production`；另有 `sgn_marker_present <路徑>` 供測試 |
| `db/build.sh` | 修改 | 呼叫 guard；`build_schema` 改用 `migrate.mjs --mode fresh`（保留 `create database`、`revoke`、`grant connect`、default privileges、pgcrypto 的特殊步驟，搬進 `migrate.mjs` 的 fresh 前置）；建完呼叫 `environment_init('verification', ...)`；刪掉 `migration_files()`；PostgreSQL 主版本改讀 `db/sgn.env` 的 `SGN_PG_MAJOR`（G-15） |
| `tools/install-dev-tools.sh` | 修改 | 改讀 `SGN_PG_MAJOR`（G-15） |
| `db/sgn.env` | 修改 | 新鍵 `SGN_PG_MAJOR=16`、`SGN_SIM_IDENTITY_SOURCES=sim-ldap` |
| `db/generated/migrations.lock` | 新增（產生） | 見上 |
| `tools/check-migrations.mjs` | 新增 | lock 無差異＋git 歷史只增不改（G-14） |
| `tools/check.sh` | 修改 | 第一段呼叫 guard；新段「migration 只增不改（G-14）」 |
| `tools/run-all.sh` | 修改 | 呼叫 guard；`stop_bg` 的名單改由 `node -e` 讀 `programs.mjs`（收斂 SSOT） |
| `db/tools/provision-secrets.mjs` | 修改 | 呼叫 guard；錨點檔不截斷 |
| `db/tools/chain-lib.mjs`、`web/verify.js` | 修改（第 2 批） | 指紋承認的接受與離線驗證 |
| `web/lib/webauthn-verify.js` | 新增（第 2 批） | 離線驗章 |
| `web/pages/ops.js`、`web/src/i18n/zh-Hant.ts` | 新增／修改（第 2 批） | 「維運確認」頁：待確認清單、subject 逐欄顯示、簽章按鈕；文案只用 key |
| `packages/contract/src/routes.ts` | 修改 | 新路由（下表） |

### 1.3 資料表

```sql
-- 570
create table sgn.environment (
    singleton boolean primary key default true check (singleton),
    environment_id uuid not null,
    kind text not null check (kind in ('production', 'verification')),
    mode text not null check (mode in ('normal', 'maintenance', 'restore_pending', 'isolated')),
    label text not null,
    created_at timestamptz not null,
    mode_changed_at timestamptz not null,
    mode_reason text not null
);
create table sgn.environment_mode_event (      -- 非 normal 模式下仍允許的事件種類（like 樣式）
    mode text not null check (mode in ('maintenance', 'restore_pending', 'isolated')),
    event_type_pattern text not null,
    primary key (mode, event_type_pattern)
);
-- 初始資料：maintenance：session.%、ops.%；restore_pending：session.%、ops.attestation_%、ops.restore_gap、ops.environment_mode_changed；
-- isolated：session.%、ops.%。實作者以測試確認登入、發挑戰值、簽確認所寫的事件都在清單內（不夠就加列，不放寬成 %）。
create table sgn.ops_event_kind (
    event_type text primary key check (event_type like 'ops.%'),
    description text not null
);

-- 575
create table sgn.migration_run (
    id bigint generated always as identity primary key,
    kind text not null check (kind in ('install', 'upgrade', 'refingerprint')),
    operator text not null,
    change_ref text not null check (length(change_ref) > 0),
    tool_version text not null,                 -- git commit
    started_at timestamptz not null,
    finished_at timestamptz,
    fingerprint_before text,
    fingerprint_after text,
    event_seq bigint
);
create table sgn.migration_applied (
    file text primary key check (file ~ '^db/(kernel|packs/[a-z_]+)/[0-9]+_[a-z0-9_]+\.sql$'),
    sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
    position int not null unique,
    run_id bigint not null references sgn.migration_run (id),
    applied_at timestamptz not null
);
-- migration_run 只允許把 finished_at、fingerprint_after、event_seq 從 null 填一次（before update trigger 檢查），不得刪；
-- migration_applied 擋 update、delete、truncate。四個 trigger 都 enable always。

-- 585（第 2 批）
create table sgn.ops_attestation (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('code_fingerprint', 'restore_gap')),
    subject jsonb not null,
    involved uuid[] not null default '{}',     -- 不得確認的人（例如還原事故的當事人）
    proposed_by text not null,                 -- 作業系統帳號
    change_ref text not null,
    proposed_at timestamptz not null,
    expires_at timestamptz not null,
    status text not null check (status in ('proposed', 'first_signed', 'completed', 'superseded', 'expired')),
    proposed_seq bigint not null,
    completed_seq bigint
);
create table sgn.ops_attestation_signature (
    attestation_id uuid not null references sgn.ops_attestation (id),
    position smallint not null check (position in (1, 2)),
    person_id uuid not null references sgn.person (id),
    credential_id bytea not null,
    roles jsonb not null,                      -- 簽章當時持有、使他有資格的角色
    signed_challenge bytea not null,
    raw jsonb not null,                        -- authenticator_data、client_data_json、signature（base64url）
    signed_at timestamptz not null,
    event_seq bigint not null,
    primary key (attestation_id, position),
    unique (attestation_id, person_id)
);
-- 兩張表只增：ops_attestation 只能改 status、completed_seq（trigger 檢查轉移 proposed→first_signed→completed，
-- proposed|first_signed→superseded|expired）；signature 擋 update、delete、truncate。全部 enable always。
```

### 1.4 Function（簽章）

| Function | 誰能執行 | 作用 |
|---|---|---|
| `sgn_internal.environment_init(p_kind text, p_environment_id uuid, p_label text) returns uuid` | owner | 只能一次（`ENVIRONMENT_EXISTS`）；事件 `ops.environment_initialized` |
| `sgn_internal.environment_mode_set(p_mode text, p_reason text, p_operator text, p_change_ref text) returns void` | owner | 事件 `ops.environment_mode_changed` |
| `sgn_internal.environment_write_check(p_event_type text) returns void` | 內部 | G1 閘門 |
| `sgn_internal.audit_append(p_event_type text, p_case_id uuid, p_actor_person_id uuid, p_data jsonb) returns bigint` | 內部 | `create or replace`，同簽章；第一行 `perform sgn_internal.environment_write_check(p_event_type)`，其餘與 `10_audit_chain.sql` 相同 |
| `sgn_internal.ops_event_record(p_event_type text, p_operator text, p_change_ref text, p_detail jsonb) returns bigint` | owner | G4；種類不在 `sgn.ops_event_kind` 丟 `OPS_EVENT_UNKNOWN` |
| `api.environment_status(p_session text) returns jsonb` | 登入者 | `{kind, mode, mode_changed_at, mode_reason}`；頁面據此顯示「維護中」「還原待確認」橫幅 |
| `sgn_internal.migration_check(p_files jsonb) returns jsonb` | owner | 輸入依套用順序的 `[{file, sha256}]`；回 `{pending: [...]}`；丟 `MIGRATION_FILE_CHANGED`、`MIGRATION_FILE_MISSING`、`MIGRATION_ORDER` |
| `sgn_internal.migration_run_begin(p_kind text, p_operator text, p_change_ref text, p_tool_version text) returns bigint` | owner | 記 `fingerprint_before` |
| `sgn_internal.migration_record(p_run_id bigint, p_file text, p_sha256 text) returns void` | owner | position 自動遞增 |
| `sgn_internal.migration_run_finish(p_run_id bigint) returns jsonb` | owner | 記 `fingerprint_after`；經 `ops_event_record` 寫 `ops.migration_applied` |
| `api.ops_migrations(p_session text) returns jsonb` | `audit.read` 或 `ops.read`（新 action，`role_setting = 'ops.reader_roles'`，預設 `["tech_ops", "auditor", "audit_head", "ciso"]`） | 每次執行與檔案 |
| `sgn_internal.ops_attestation_propose(p_kind text, p_subject jsonb, p_involved uuid[], p_proposed_by text, p_change_ref text) returns uuid` | owner | 作廢同種類未完成的提案；事件 `ops.attestation_proposed`；通知兩組角色的持有人（`ops.attestation_requested` 範本） |
| `api.ops_attestation_list(p_session text) returns jsonb` | `ops.read` | 每筆帶 `actions`（`sign` 或空），頁面只依它顯示按鈕 |
| `api.ops_attestation_challenge(p_session text, p_attestation_id uuid) returns jsonb` | 有資格的人 | 發一次性亂數，purpose `ops.attestation` |
| `api.ops_attestation_sign_passkey(p_challenge_id uuid, p_credential_id text, p_authenticator_data text, p_client_data_json text, p_signature text) returns jsonb` | 有資格的人 | 以 `signature_verify(challenge, attestation_id, subject, 'attest', ...)` 驗章；`challenge_owner_check`；依位置檢查角色、不同人、不在 `involved`、未逾期；第一位寫 `ops.attestation_signed`，第二位寫 `ops.attestation_completed`（含兩個簽章的 raw、SPKI、credential id、roles、當時的 `webauthn.origin`），並呼叫種類的完成動作（`code_fingerprint`：模式回 normal；`restore_gap`：見項 2） |
| `sgn_internal.ops_attestation_expire() returns int`；包裝 `api_job.ops_attestation_expire() returns jsonb` | 排程（加進 `schedulerCalls`） | 逾期的提案改 `expired` 並寫事件 `ops.attestation_expired` |
| `api_job.code_fingerprint_attested(p_from text, p_to text) returns jsonb` | `sgn_anchor`（加進 `anchorCalls`） | 回 `{attested: bool, attestation_id, completed_seq}` |

`api.ops_attestation_sign_passkey` 的參數順序照抄既有的 `api.role_change_decide_passkey`（實作者先讀它）。每個 `api` function 寫 `COMMENT ON FUNCTION`（用途、呼叫者、規則代碼），並加進 `routes.ts`。

### 1.5 規則代碼、錯誤代碼、參數

| 規則代碼 | 內容 | 批 |
|---|---|---|
| `K-MIGRATION-LEDGER` | 每次套用記錄檔名、雜湊、順序、時間、操作者與單號；只套新檔；已套用檔被改、不見、新檔排在前面一律拒絕；一次執行一筆事件 | 1 |
| `K-ENV-MODE` | 環境模式不是 normal 時，只有允許清單的事件能寫；superuser 工具不受限但留事件 | 1 |
| `K-ENV-IDENTITY` | 環境只初始化一次；會刪資料的工具遇到正式環境標記或真實人員資料就拒絕（骨幹已有此代碼，登記為 `partial`，第 3 批補啟動比對後改 `full`） | 1 |
| `K-OPS-ATTEST` | 兩人確認：角色、不同人、非當事人、通行金鑰、逾期、內容即簽章、全部進鏈且可離線重驗 | 2 |
| `K-CODE-CHANGE-ATTEST` | 程式指紋改變後，錨定只接受經兩人確認的那一次變更（from、to 完全相符），錨點記下確認的序號；離線驗證檢查每一次指紋轉換 | 2 |

錯誤代碼（`sgn.error_catalog`）：`ENVIRONMENT_EXISTS` 409、`ENVIRONMENT_READ_ONLY` 503、`OPS_EVENT_UNKNOWN` 500、`MIGRATION_FILE_CHANGED` 409、`MIGRATION_FILE_MISSING` 409、`MIGRATION_ORDER` 409、`MIGRATION_UNKNOWN_STATE` 409、`ATTEST_ROLE_REQUIRED` 403、`ATTEST_SAME_PERSON` 403、`ATTEST_INVOLVED` 403、`ATTEST_STATE` 409、`ATTEST_EXPIRED` 409。

參數（`register_setting_definition`）：`ops.reader_roles`（json，見上）、`ops.attest_first_roles`（json，`["tech_ops"]`，範圍 `attest_kind`）、`ops.attest_second_roles`（json，`["ciso", "audit_head"]`，範圍 `attest_kind`）、`ops.attest_expire_hours`（integer，72，範圍 `attest_kind`）。確認事件記下用到的參數值。

### 1.6 測試

`db/tests/kernel/99-ops-migrate.test.mjs`（`migrate.mjs` 對 `sgn_test` 的複本與暫存的檔案目錄執行）：
- `K-MIGRATION-LEDGER 全新建置後每個 migration 檔都有一筆紀錄，雜湊與 db/generated/migrations.lock 相同`
- `K-MIGRATION-LEDGER 只套用新檔：複本上多一個新檔，upgrade 只套它，紀錄一筆、事件一筆`
- `K-MIGRATION-LEDGER 已套用的檔被改一個位元組：拒絕（MIGRATION_FILE_CHANGED），資料庫沒有任何變更`
- `K-MIGRATION-LEDGER 已套用的檔不見了：MIGRATION_FILE_MISSING`
- `K-MIGRATION-LEDGER 新檔排在已套用的檔之前：MIGRATION_ORDER`
- `K-MIGRATION-LEDGER 新檔中途失敗：那個檔的變更與紀錄一起回滾，之前的檔已記`
- `K-MIGRATION-LEDGER 沒有紀錄表但有 sgn schema：MIGRATION_UNKNOWN_STATE`
- `K-MIGRATION-LEDGER 紀錄表擋下 UPDATE、DELETE、TRUNCATE；執行期帳號讀不到也寫不了`
- `K-MIGRATION-LEDGER 每個 migration 檔都能在交易內執行（沒有 concurrently、vacuum 等）`

`db/tests/kernel/99-ops-env.test.mjs`：
- `K-ENV-MODE maintenance：sgn_app 的業務寫入被拒（ENVIRONMENT_READ_ONLY），登入成功`
- `K-ENV-MODE restore_pending：只有允許清單的事件能寫`
- `K-ENV-MODE superuser 工具在 maintenance 仍能套 migration，並留下 ops.environment_mode_changed`
- `K-ENV-IDENTITY environment_init 第二次：ENVIRONMENT_EXISTS`
- `K-ENV-IDENTITY guard：叢集裡有 kind=production 的資料庫（測試建一個暫存庫）時拒絕並指出庫名；刪掉後通過`
- `K-ENV-IDENTITY guard：目標庫有非模擬來源的人員時拒絕`
- `K-ENV-IDENTITY guard 的主機標記檢查（sgn_marker_present 對暫存路徑）`
- `K-ENV-IDENTITY provision-secrets 不截斷非空的錨點檔`
- `K-ENV-IDENTITY ops 事件不含任何密鑰（比對 .run/secrets/ 所有值與其 SHA-256 都不出現在事件 body）`

`db/tests/kernel/99-ops-attest.test.mjs`（第 2 批）：
- `K-OPS-ATTEST 第一位只能是 ops.attest_first_roles 的持有人（ATTEST_ROLE_REQUIRED）`
- `K-OPS-ATTEST 第二位不能和第一位同一人（ATTEST_SAME_PERSON）`
- `K-OPS-ATTEST 列在 involved 的人不能確認（ATTEST_INVOLVED）`
- `K-OPS-ATTEST 只憑登入、沒有通行金鑰簽章不能確認；簽的內容和 subject 差一個字元驗章失敗`
- `K-OPS-ATTEST 逾期（ATTEST_EXPIRED）；排程把逾期提案改 expired 並寫事件`
- `K-OPS-ATTEST 新提案作廢同種類未完成的舊提案`
- `K-CODE-CHANGE-ATTEST migrate 後錨定回 CODE_CHANGED；兩人確認後錨定接受，錨點帶 fingerprint_change`
- `K-CODE-CHANGE-ATTEST 確認的是 A→B、實際是 A→C：錨定仍拒絕`
- `K-CODE-CHANGE-ATTEST 確認之前 maintenance 擋業務寫入，確認後 normal`
- `K-CODE-CHANGE-ATTEST verifyChain 離線驗兩個簽章：superuser 直接 insert 確認紀錄並以 audit_append 寫假的完成事件 → CODE_CHANGE_UNATTESTED`
- `K-CODE-CHANGE-ATTEST verifyChain：簽章者的 SPKI 和 passkey.registered 的雜湊不同 → CODE_CHANGE_UNATTESTED`
- `K-CODE-CHANGE-ATTEST --refingerprint（PostgreSQL 主版本升級）走同一條路徑`

端對端（第 2 批）：`e2e/tests/ops-attest.test.mjs`：390px 下兩位不同的人登入、看到同一份 subject、各自簽章，第二人簽完頁面顯示完成；沒有資格的人看不到簽章按鈕。

既有測試要改的地方（**不是放寬，要在 handoff 寫明**）：見項 4 的「對既有測試的影響」。

### 1.7 對紅隊腳本與 `tools/run-all.sh` 的影響

- `run-all.sh`：多一行 guard；`stop_bg` 名單改讀 `programs.mjs`（名單內容相同）；建置多一筆 `ops.migration_applied` 事件（序號整體後移一號）。
- 紅隊腳本：沒有任何一支依賴絕對事件序號（實作者以 `grep -rnE "seq\s*(=|===)\s*[0-9]" redteam/exploits` 再確認）；`32`、`41`、`50` 讀目前指紋，不受影響。第 2 批讓錨定在指紋改變後「可以」繼續——這是新的攻擊面，交給下一輪紅隊（偽造確認、重放舊確認、用 from/to 不符的確認），開發者不改紅隊腳本。
- 會刪資料的三支腳本在驗證主機上行為不變（guard 只在有正式環境證據時拒絕）。

### 1.8 威脅

| 攻擊者在哪裡 | 想做什麼 | 擋法 | 殘餘 |
|---|---|---|---|
| 主機 root（正式環境） | 誤跑 `db/build.sh` 或 `tools/check.sh` 清掉資料 | guard 三道檢查、沒有強制旗標 | 刪掉 `/etc/sgn/environment` 又把資料庫的 kind 改掉再跑：這已是蓄意破壞，靠備份與錨點 |
| 部署者 | 改一支已套用的 migration 再部署 | lock＋紀錄表雙重比對，拒絕 | — |
| 主機 root | 套一支惡意 migration，自己承認指紋 | 承認要兩位平台內的人以通行金鑰簽；離線可重驗 | root＋第一位＋第二位三方串通 |
| superuser | 在資料庫裡偽造確認紀錄與事件 | 離線驗章（SPKI 對 `passkey.registered`） | — |
| `sgn_anchor` 的密碼外洩 | 寫帶 `fingerprint_change` 的假錨點 | 存放處仍要序號變大（不變）；離線驗證要求鏈上真的有對應確認 | 與現況相同：可寫更大序號的假錨點造成 K-ANCHOR-LAG |

### 1.9 大小與相依

- 第 1 批的 migration 紀錄、模式、guard：**中**。第 2 批的兩人確認與錨定、離線驗章、頁面：**大**。
- 相依：第 2 批依賴第 1 批（模式、紀錄表、指紋 v2 先定案）。

## 2. 備份與還原（G-03、K-RESTORE-GAP、骨幹 §14.3）

### 2.1 備份什麼

| 項目 | 工具 | 頻率（預設，§10 第 4、5 題） | 放哪 | 加密 |
|---|---|---|---|---|
| 平台資料庫的邏輯備份 | `db/backup.sh`：`pg_dump --format=custom` | 每日 | `SGN_BACKUP_DIR`（§10） | `openssl cms -encrypt -binary -stream -aes256 -recip <備份收件憑證>`：資料庫主機只有公鑰，解密私鑰由金鑰保管人離線保管 |
| 叢集角色（不含密碼） | `pg_dumpall --roles-only --no-role-passwords` | 每日，同一份清單 | 同上 | 同上 |
| PITR：基底備份＋WAL | `db/backup-base.sh`：`pg_basebackup --wal-method=stream --format=tar`；`archive_command` 呼叫 `db/tools/wal-archive.sh %p %f`（複製後 `sync`、存在即拒絕覆寫） | 基底每週、WAL 連續（`archive_timeout = 300`） | 同上 | 同上 |
| 錨點存放處資料檔 | 由錨點存放處主機上**另一個帳號**的排程複製（`deploy/` 提供 `anchor-copy.sh`，只追加不覆寫） | 每小時 | 和資料庫備份**不同**位置、不同管理者（§10 第 11 題） | 不需要（不含業務內容） |
| 各程式的密鑰檔 | 不備份；金鑰保管人依 key-rotation.md 另存，或還原時重發（項 6 的工具） | — | — | — |
| 非機密設定 `/etc/sgn/*.env` | 隨部署版本（git） | — | — | — |

每份備份產生一份清單 `manifest.json`：資料庫名稱、`environment_id`、時間、鏈頭序號與雜湊、最後一個錨點收據（`sgn.anchor_receipt`）的序號、目前指紋、`migration_applied` 的最後一列、各檔的 SHA-256。`db/backup.sh` 最後以 owner 呼叫 `sgn_internal.backup_record(p_manifest jsonb)` 寫事件 `ops.backup_completed`（清單內容進鏈，所以之後能證明「那天的備份就是這一份」）。

`postgresql.conf` 的 `archive_mode`、`archive_command`、`archive_timeout` 由 `db/install.sh`（第 5 批）寫入 `conf.d/sgn-archive.conf`；驗證主機不開（避免影響共用叢集）。

### 2.2 還原順序（`db/restore.sh`）

```
db/restore.sh --target-db <新庫名> --change-ref <事故或演練單號> \
              (--dump <加密的 dump> | --base <基底備份目錄> --until <時間點>) [--cluster-port <埠>]
```

1. guard：目標庫不得已存在；`--until` 模式要求另一個叢集（`--cluster-port`），不碰正在服務的叢集。
2. 解密（`openssl cms -decrypt`，私鑰由執行者在提示下提供路徑，不留在主機）。
3. 角色：依角色清單建立缺少的角色（不刪、不改已存在角色的密碼）；新建的登入角色密碼由項 6 的 `secrets.mjs provision` 發。
4. `create database <新庫名> owner sgn_owner`；`pg_restore`（或 PITR 叢集啟動到 `recovery_target_time`）。
5. 重做資料庫層級的權限（`revoke all on database ... from public`、`grant connect`、default privileges；與 `migrate.mjs` fresh 前置共用同一個函式）；跑 `grants-sql.mjs`。
6. 驗證：對錨點存放處跑 `verifyChain`。
7. 依結果：

| 結果 | 工具做什麼 |
|---|---|
| `ok` | 印出「一致」；模式保持備份當時的值；結束碼 0 |
| 只有 `ANCHOR_BEYOND_HEAD`（且序號 ≤ 鏈頭的錨點全部相符） | 還原點早於最後一個錨點：走 §2.3，結束碼 10 |
| 只有 `CODE_CHANGED` | 備份之後升過級：印出要先套哪些 migration（比對紀錄表與 lock），結束碼 11；不自動套 |
| 其他任何問題 | 視為竄改或備份損毀，不寫任何東西，結束碼 2（照 break-glass.md §7） |

8. 寫 `ops.restore_completed`（`ops_event_record`；清單 SHA-256、目標庫、結果）。
9. 切換：程式連哪個庫由 `SGN_DATABASE`；錨點檔名改由 `SGN_ANCHOR_STREAM` 決定（預設＝資料庫名稱，正式環境＝`environment_id`，第 5 批），所以還原到新庫名不必改存放處。

### 2.3 還原到最後一個錨點之前（K-RESTORE-GAP）

設還原後鏈頭是 H，存放處最後一個錨點是 A（A > H）。事件 H+1..A 遺失。骨幹 §14.3：「還原後第一筆事件寫明遺失的序號區間，不重算、不偽裝連續」。

- **缺口事件**：`db/restore.sh` 立刻（在任何程式或登入之前）以 owner 呼叫 `sgn_internal.restore_gap_declare(p_last_anchor_seq bigint, p_last_anchor_hash text, p_manifest jsonb, p_operator text, p_change_ref text)`：
  - 檢查 `p_last_anchor_seq > 鏈頭`；
  - 寫一筆序號為 **A+1** 的事件 `ops.restore_gap`，`prev_hash` = H 的雜湊，body 的 data：`{lost_from: H+1, lost_to: A, last_anchor: {seq: A, hash}, restored_head: {seq: H, hash}, manifest_sha256, operator, change_ref}`；
  - 模式設為 `restore_pending`、開例外 `K-RESTORE-GAP`（detail 同上）、通知 `restore.gap_notify_roles`；
  - 建立 `restore_gap` 種類的兩人確認提案（G3），`involved` 留空（§10 第 6 題可改）。
- 鏈頭跳號：`create or replace function sgn_internal.audit_head_check()`：`new.seq = old.seq + 1` 照舊允許；另外**只**在「`new.seq` 那一筆的 `event_type = 'ops.restore_gap'`、`prev_hash = old.hash`、body 的 `lost_from = old.seq + 1` 且 `lost_to = new.seq - 1`」時允許。寫入只能經 `sgn_internal.audit_append_restore_gap`（owner 專用、只被 `restore_gap_declare` 呼叫），它複製 `audit_append` 的組 body 方式但序號用 A+1。
- 之後的事件從 A+2 起照常；錨點存放處只收序號 > A，不用改。
- **驗證工具**（`chain-lib.mjs` 的 `checkEvent`／`verifyChain`、`anchorOnce`、`web/verify.js`）：
  - 序號跳躍只有在跳到的那一筆是 `ops.restore_gap` 且 data 的區間剛好等於跳過的區間時，不算 `SEQ_GAP`；`prev_hash` 照常要等於前一筆重算的雜湊。
  - 宣告的 `last_anchor` 必須是存放處裡真的存在的錨點（序號、雜湊相同），否則 `RESTORE_GAP_INVALID`。
  - 序號 ≤ H 的錨點照常逐一比對（證明還原的部分沒被改）；序號在 (H, A] 的錨點不比對，列在結果的 `acknowledged_gaps`。
  - 鏈上在缺口事件之後必須有一筆 `ops.attestation_completed`（`restore_gap` 種類、指向這個缺口事件的序號）且簽章離線驗得過，否則問題 `RESTORE_GAP_UNATTESTED`——**確認之前稽核頁顯示失敗**。
  - `anchorOnce` 從上一個錨點增量重算時，若緊接著的是缺口事件，改做一次從創世的全量重算（罕見情況，避免為它寫第二套增量邏輯）。
- **兩人確認完成**時：模式回 `normal`；K-RESTORE-GAP 例外**不自動結案**，由處理角色在例外頁結案（項 3；骨幹：「還原例外由控制負責人覆核結案」）。
- 為什麼由 root 單方面宣告缺口而不是等兩人確認才寫：登入本身就寫事件（`session.opened`），任何事件都會佔掉 H+1 而和遺失的錨點衝突；缺口事件必須是還原後第一筆。單方面宣告只能「承認遺失」，不能改動 ≤ H 的任何一筆；而且沒有兩人確認前，驗證一律失敗。

### 2.4 啟動前檢查（第 3 批做檢查本體，第 5 批接上 systemd）

`db/tools/preflight.mjs`（root，管理者連線）：
1. 比對主機標記與資料庫 `sgn.environment` 的 `environment_id`、`kind`：不同 → 模式設 `isolated`、結束碼 4（K-ENV-IDENTITY：還原了別的環境的備份，交付與對帳不得送出）。
2. 比對鏈頭與存放處最後一個錨點：存放處較新 → 印出「需要 db/restore.sh 的缺口程序」、結束碼 5，不自己宣告缺口（宣告只在 restore.sh 裡做，留下明確的人為動作）。
3. 模式不是 normal → 結束碼 6（寫入程式不啟動）。
第 5 批的 systemd 單元：交付、對帳、排程、寄信、目錄同步 `Requires=` 並 `After=` `sgn-preflight.service`；api、web、anchor、anchor-store 不依賴它（確認頁與錨定在 restore_pending 也要能跑）。

### 2.5 演練腳本（納入 `tools/check.sh`）

`tools/drill-backup-restore.sh`，在 `tools/run-all.sh` 之後執行（需要 `sgn_test` 已建好），只用自己的資料庫名稱 `sgn_drill_src`、`sgn_drill_ok`、`sgn_drill_gap` 與 `$SGN_STATE_DIR/drill/` 的暫存錨點檔，結束時全部刪掉（`trap`）：

1. `create database sgn_drill_src template sgn_test`，`environment_mode_set` 不動；以 `anchorOnce`（檔案形式的存放處）錨定。
2. `db/backup.sh --database sgn_drill_src --out <暫存>`（以演練用的自簽收件憑證加密，憑證在暫存目錄產生）。
3. `db/restore.sh --dump ... --target-db sgn_drill_ok` → 必須結束碼 0，`verifyChain` 一致。
4. 在 src 寫入幾筆事件（以 owner 呼叫 `ops_event_record('ops.drill_marker', ...)`）並再錨定一次；把第 2 步的舊備份還原到 `sgn_drill_gap` → 必須結束碼 10、模式 `restore_pending`、鏈上有 `ops.restore_gap`、`verifyChain` 回 `RESTORE_GAP_UNATTESTED`。
5. 以測試用的兩位持有人（`db/tests/kernel/lib/harness.mjs` 的軟體金鑰；只在驗證主機）完成兩人確認 → `verifyChain` 一致、`acknowledged_gaps` 列出 (H, A]；再錨定一次成功。
6. PITR：`initdb` 一個暫存叢集（`/usr/lib/postgresql/$SGN_PG_MAJOR/bin`、隨機埠、`archive_mode=on`），載入 src、`backup-base.sh`、再寫事件、記下時間 T、再寫事件，還原到 T → 鏈頭等於 T 時的鏈頭。暫存叢集結束即刪。
7. 以 owner 呼叫 `sgn_internal.restore_drill_record(p_result jsonb)` 寫 `ops.restore_drill_completed` 到 **sgn_test**（測試庫）——不寫正式庫；正式環境的演練由 `deploy/` 的同一支腳本帶 `--production-drill` 在**另一台主機**上做，結果寫回正式庫（§10 第 5 題）。

`tools/check.sh` 新段 `run "備份還原演練" tools/drill-backup-restore.sh`（`--fast` 時不跑）。

### 2.6 監看：備份與演練有沒有在做

- `api_job.backup_age_check()`（加進 `schedulerCalls`）：最後一筆 `ops.backup_completed` 超過 `backup.max_age_hours` → 開 `K-BACKUP-STALE`（每段一筆，備份恢復時自動結案）並通知 `backup.stale_notify_roles`；最後一筆通過的 `ops.restore_drill_completed` 超過 `backup.drill_max_age_days` → 開 `K-RESTORE-DRILL`（同樣自動結案）。
- 只在 `sgn.environment.kind = 'production'` 時檢查（驗證主機不每天備份）。

### 2.7 檔案、function、代碼、參數

- `db/kernel/595_backup_restore.sql`：`audit_head_check` 新版、`audit_append_restore_gap`、`restore_gap_declare`、`backup_record`、`restore_drill_record`、`backup_age_check`、`api_job.backup_age_check`、`restore_gap` 種類的完成動作、`sgn.environment_mode_event` 補列、`sgn.ops_event_kind` 補列、通知範本 `restore.gap_declared`、`backup.stale`。
- `db/backup.sh`、`db/backup-base.sh`、`db/restore.sh`、`db/tools/wal-archive.sh`、`db/tools/preflight.mjs`、`db/tools/backup-manifest.mjs`（清單產生與比對）、`tools/drill-backup-restore.sh`、`deploy/anchor-copy.sh`。
- 修改：`db/tools/chain-lib.mjs`、`web/verify.js`、`db/tools/verify-chain.mjs`（輸出 `acknowledged_gaps`）、`db/tools/lib/env.mjs`（`anchorFile` 改用 stream）。
- 規則代碼：`K-RESTORE-GAP`（骨幹已命名；`full`）、`K-BACKUP-STALE`、`K-RESTORE-DRILL`；`K-ENV-IDENTITY` 改 `full`。
- 錯誤代碼：`RESTORE_GAP_INVALID` 409（宣告的序號不大於鏈頭、或跳號的事件不是缺口事件）。
- 參數：`backup.max_age_hours`（integer，30）、`backup.drill_max_age_days`（integer，35）、`backup.stale_notify_roles`（json，`["tech_ops", "ciso"]`）、`restore.gap_notify_roles`（json，`["ciso", "audit_head", "audit_governor"]`）。

### 2.8 測試

`db/tests/kernel/99-ops-restore.test.mjs`：
- `K-RESTORE-GAP 還原到最後錨點之後：一致，不需聲明`
- `K-RESTORE-GAP 還原到最後錨點之前：缺口事件序號是最後錨點 +1、prev_hash 是還原的鏈頭、模式 restore_pending、開例外並通知`
- `K-RESTORE-GAP 沒有兩人確認：verifyChain 回 RESTORE_GAP_UNATTESTED；確認後一致並列出缺口`
- `K-RESTORE-GAP 宣告的 last_anchor 不在存放處或雜湊不同：RESTORE_GAP_INVALID`
- `K-RESTORE-GAP 缺口之前的事件被改過：仍報 ANCHOR_MISMATCH（缺口不掩蓋之前的竄改）`
- `K-RESTORE-GAP 宣告序號不大於鏈頭：RESTORE_GAP_INVALID`
- `K-AUDIT-APPEND 只有缺口事件能讓鏈頭跳號；superuser 以一般事件跳號仍被 trigger 擋下`
- `K-RESTORE-GAP restore_pending 期間業務寫入被拒，登入與兩人確認可做；確認後 normal，例外仍開著`
- `K-RESTORE-GAP 確認後錨定程式在缺口之後寫得進新錨點`
- `K-BACKUP-STALE 正式環境超過 backup.max_age_hours 沒有備份事件就開例外；有新的備份事件就結案；驗證環境不檢查`
- `K-RESTORE-DRILL 超過 backup.drill_max_age_days 沒有通過的演練就開例外`
- `K-ENV-IDENTITY preflight：主機標記與資料庫的 environment_id 不同 → isolated、結束碼 4`

### 2.9 對紅隊腳本與 `tools/run-all.sh`

- `run-all.sh` 不變（演練在它之後、另外的庫）。`check.sh` 多約數分鐘。
- 鏈頭 trigger 的新分支、缺口事件、`acknowledged_gaps` 都是新攻擊面：下一輪紅隊必打（以 owner 宣告假缺口刪掉錨點之後的事件、以兩個舊確認重放、在 restore_pending 寫業務事件）。`32-audit-page-forged-chain` 的頁面判定邏輯會改，交紅隊確認腳本仍能判定。

### 2.10 威脅

| 攻擊者在哪裡 | 想做什麼 | 擋法 | 殘餘 |
|---|---|---|---|
| 主機 root | 刪掉最近的事件，偽裝成「從備份還原」 | 缺口只能跳到存放處真的有的錨點之後；缺口之前的錨點仍比對；沒有兩人確認就驗證失敗；開例外並通知治理角色 | root＋兩位確認人串通（同指紋承認） |
| 拿到資料庫備份的人 | 讀交付簽章私鑰種子 | 備份以收件憑證加密，資料庫主機沒有解密私鑰 | 解密私鑰的保管（§10 第 4 題） |
| 能寫備份位置的人 | 換掉備份 | 清單 SHA-256 進鏈；還原後驗證 | — |
| 還原了別的環境 | 交付送到錯的外部系統 | preflight 比對 environment_id → isolated | — |

### 2.11 大小與相依

**大**。依賴第 1 批（模式、ops 事件）與第 2 批（兩人確認、離線驗章）。

## 3. 例外的人工處理與結案入口（G-02、D90 (3)）

### 3.1 設計

- **結案政策是資料**：新表 `sgn.exception_close_policy`，每個會開例外的規則代碼一列：`close_mode`（`manual`＝可人工結案，`auto_only`＝只能由條件消失自動結案）、`close_check regprocedure`（可為 null；人工結案前呼叫，回傳錯誤代碼或 null，用來表達「條件未解除前不能結」）。**沒有列的代碼一律拒絕人工結案**（`EXCEPTION_CLOSE_POLICY_MISSING`，失敗時關閉）。
- `auto_only`（撰寫時的清單；實作者以 exceptions.md §1 的抓取指令重跑核對）：`K-PROGRAM-STALLED`、`K-GOVERNANCE-KEY`、`K-PASSKEY-SUSPEND-HOLDER`、`K-PASSKEY-SUSPEND-FLOOD`、`K-REGISTRAR-MIN`、`K-USAGE-IDLE`、`K-RECON-EXTRA`、`K-RECON-MISSING`、`K-RECON-DIFFERENT`（第 3.3 節改成自動結案）、`K-BACKUP-STALE`、`K-RESTORE-DRILL`、`DA-TEST-REPORT-FOLLOWUP`。理由：這些代碼的「狀況」由資料庫判斷；讓人結案等於讓人把仍成立的警訊關掉。
- `manual` 但有 `close_check`：`K-RESTORE-GAP`（兩人確認完成前不能結：`sgn_internal.exception_check_restore_gap`）、`DA-CATALOG-DRIFT`（`detail.kind = 'rename_only'` 的只能由資料擁有者確認自動結案：`pack_data_access.exception_check_catalog_drift`，流程包自己登記）。
- 其餘代碼 `manual`（含事件型的 `K-PASSKEY-RECOVERY`、`K-PASSKEY-NOT-ME`）。
- **誰能結案**：參數 `exception.handler_roles`（範圍 `rule:<代碼>`），預設值依 exceptions.md 的「誰收到通知」（§3.5 表）。新 action `exception.handle`（`actor_rule = 'role'`、`role_setting = 'exception.handler_roles'`），授權一律經 `sgn_internal.authorize`，範圍帶規則代碼。
- **不能結自己造成的**：`sgn_internal.exception_involved(p_exception_id bigint) returns uuid[]`＝開立事件的 `actor`、單的申請人、被授權者負責人、detail 中參數 `exception.involved_detail_keys`（預設 `["person", "people", "endorser", "endorsers", "revoked_by", "applicant", "owner"]`）列的欄位裡的人。結案人在其中 → `EXCEPTION_CLOSE_SELF`。
- **結案要通行金鑰**：只憑登入就能關掉警訊，等於身分提供者被冒用時可以掩蓋痕跡（D84 (2) 的分類）。認領只需登入（最壞是把案子掛在自己名下，不掩蓋任何東西）。
- **必填**：處置代碼 `disposition`（`resolved`｜`false_positive`｜`duplicate`｜`risk_accepted`）、說明 `note`（至少 `exception.close_note_min_chars` 字）。`risk_accepted` 另外要 `exception.risk_accept_roles` 的持有人（預設 `["ciso"]`），對應骨幹 §4.4 的 `risk_accepted`。
- **結案是稽核事件**：照舊只經 `sgn_internal.exception_close(p_id, p_detail)`；detail 多 `{manual: true, by, disposition, note, signed_challenge, credential_id}`。另外通知 `exception.manual_close_notify_roles`（預設 `["audit_head", "ciso"]`，扣掉結案人）——人工結案不會無聲無息。
- 狀態：只加「認領」（`in_progress`），不做骨幹的 `pending_review`（第二人覆核）；理由：結案已要求金鑰、非當事人、通知稽核主管，稽核可事後抽查；要不要加覆核是 §10 第 9 題。
- 處理時限（G-02 提到的派工與時限）不在這一批：排在 D99 下一批「時限與離職」，那一批的時限機制會一起套到例外。

### 3.2 畫面（最小可用）

- `web/pages/exceptions.js`，路由 `#/exceptions`；首頁的導覽依 `person_capabilities` 多一個 `exceptions`（有任何處理角色或稽核角色）。
- 清單：篩選（規則代碼、未結案／已結案、我認領的、未認領）；每列：規則代碼與名稱、單號（連到單）、開立時間、認領人、狀態。390px 單欄卡片，觸控目標 44px。
- 明細：detail 依鍵值逐列顯示（不顯示原始 JSON）、相關事件序號、可執行動作（後端 `actions`：`claim`、`close`），結案表單（處置單選、說明多行、通行金鑰簽章）。
- 文案全部進 `web/src/i18n/zh-Hant.ts`（`exceptions.*`）。符合 `docs/ux-acceptance.md`。

### 3.3 對帳發現解決時連帶結案

`create or replace function sgn_internal.reconciliation_resolve(p_channel text, p_run bigint)`（同簽章，`605`）：每筆發現標為已解決並寫 `reconciliation.finding_resolved` 之後，若同一個 `exception_id` 已沒有未解決的發現，就呼叫 `sgn_internal.exception_close(v_finding.exception_id, {resolved: 'reconciliation_resolved', finding, resolved_run, rules: ['K-RECON-RESOLVED']})`。K-RECON-LIMIT 合併成一筆的例外，所有發現都解決才結。

### 3.4 檔案、function、代碼、參數

- `db/kernel/600_exception_handling.sql`：`sgn.exception_close_policy`、`sgn.exception_claim`（認領紀錄，只增）、`exception_involved`、`exception_manual_close`、核心代碼的政策列、`exception.handle` action、通知範本 `exception.closed_manual`。
- `db/kernel/605_recon_exception_close.sql`：`reconciliation_resolve` 新版。
- `db/packs/data_access/180_exception_close_policy.sql`：`DA-*` 的政策列與 `close_check`（經新的 `sgn_sdk.register_exception_close_policy(p_rule_code text, p_close_mode text, p_close_check regprocedure)`，在 `600` 定義）。
- `web/pages/exceptions.js`、`web/src/i18n/zh-Hant.ts`、`packages/contract/src/routes.ts`。

```sql
create table sgn.exception_close_policy (
    rule_code text primary key references sgn.rule (code),
    close_mode text not null check (close_mode in ('manual', 'auto_only')),
    close_check regprocedure,
    registered_at timestamptz not null
);
create table sgn.exception_claim (
    exception_id bigint not null references sgn.exception_record (id),
    person_id uuid not null references sgn.person (id),
    claimed_at timestamptz not null,
    event_seq bigint not null
);  -- 只增；目前的認領人＝最後一列
```

| Function | 作用 |
|---|---|
| `api.exception_list(p_session text, p_filter jsonb) returns jsonb` | 有處理角色或稽核角色；只列看得到的代碼；每筆帶 `actions` |
| `api.exception_detail(p_session text, p_exception_id bigint) returns jsonb` | 同上；含 detail、認領歷程、結案資訊、`close_note_min_chars` |
| `api.exception_claim(p_session text, p_exception_id bigint) returns jsonb` | 處理角色；事件 `exception.claimed`；已結案丟 `EXCEPTION_ALREADY_CLOSED` |
| `api.exception_close_challenge(p_session text, p_exception_id bigint, p_disposition text, p_note text) returns jsonb` | 先做全部檢查（政策、close_check、角色、當事人、說明長度、risk_accepted 角色）再發挑戰值；purpose `exception.close`，content `{exception_id, rule_code, disposition, note}` |
| `api.exception_close_passkey(p_challenge_id uuid, p_credential_id text, p_authenticator_data text, p_client_data_json text, p_signature text) returns jsonb` | 驗章後重做全部檢查（期間狀況可能變了），呼叫 `exception_close` 並通知 |
| `sgn_sdk.register_exception_close_policy(...)` | 流程包登記政策 |

- 規則代碼：`K-EXCEPTION-HANDLE`（新）；`K-EXCEPTION-CLOSE` 由 `partial` 改 `full` 並更新說明；`K-RECON-RESOLVED` 說明補「例外一併結案」。
- 錯誤代碼：`EXCEPTION_CLOSE_POLICY_MISSING` 409、`EXCEPTION_CLOSE_AUTO_ONLY` 409、`EXCEPTION_CLOSE_CONDITION` 409（close_check 未通過時，訊息帶原因代碼）、`EXCEPTION_CLOSE_SELF` 403、`EXCEPTION_HANDLER_REQUIRED` 403、`EXCEPTION_NOTE_TOO_SHORT` 422、`EXCEPTION_RISK_ACCEPT_ROLE` 403、`EXCEPTION_ALREADY_CLOSED` 409、`EXCEPTION_DISPOSITION_INVALID` 422。
- 參數：`exception.handler_roles`（json，預設 `["mis", "ciso"]`，範圍 `rule`；migration 依 exceptions.md 為下列代碼登記範圍值：背景程式與錨定類 `["tech_ops", "ciso"]`、`K-DELIVERY-MANUAL` `["system_custodian", "mis"]`、人員目錄類 `["mis", "ciso"]`、`K-RESTORE-GAP` `["ciso", "audit_head"]`）、`exception.risk_accept_roles`（`["ciso"]`）、`exception.close_note_min_chars`（integer，20）、`exception.manual_close_notify_roles`（`["audit_head", "ciso"]`）、`exception.involved_detail_keys`（見上）。

### 3.5 測試

`db/tests/kernel/99-ops-exception.test.mjs`：
- `K-EXCEPTION-HANDLE 處理角色依 rule:<代碼> 的參數；沒有角色的人 actions 是空的，直接呼叫被拒（EXCEPTION_HANDLER_REQUIRED）`
- `K-EXCEPTION-HANDLE 不能結自己造成的：開立事件的行為人、單的申請人、detail 列的人各試一次（EXCEPTION_CLOSE_SELF）`
- `K-EXCEPTION-HANDLE 說明太短（EXCEPTION_NOTE_TOO_SHORT）；處置代碼不在清單（EXCEPTION_DISPOSITION_INVALID）`
- `K-EXCEPTION-HANDLE 結案要通行金鑰：只有挑戰值沒有簽章不能結；簽的內容和送出的說明不同驗章失敗`
- `K-EXCEPTION-HANDLE 結案進鏈（exception.closed 帶 manual、by、disposition、note）並通知 manual_close_notify_roles（不含結案人）`
- `K-EXCEPTION-HANDLE 每一個 auto_only 代碼都不能人工結案（EXCEPTION_CLOSE_AUTO_ONLY）`
- `K-EXCEPTION-HANDLE 沒有政策列的代碼拒絕（EXCEPTION_CLOSE_POLICY_MISSING）`
- `K-EXCEPTION-HANDLE 程式碼裡每個會開例外的代碼都有政策列`（靜態掃 `db/kernel`、`db/packs` 的 `exception_open(_due)?(`、`fulfilment_fail`、`reconciliation_reject`、`'rule_code',`，同 exceptions.md §1；變數代碼的來源列成常數表）
- `K-EXCEPTION-HANDLE risk_accepted 只限 exception.risk_accept_roles`
- `K-EXCEPTION-HANDLE 認領進鏈；已結案的不能認領或結案`
- `K-EXCEPTION-HANDLE K-RESTORE-GAP 在兩人確認完成前不能結（EXCEPTION_CLOSE_CONDITION）`
- `K-RECON-RESOLVED 發現連續數輪沒出現而結案時，對應例外一併結案；同一例外還有未解決的發現時不結`

`db/tests/packs/data_access/95-exception-policy.test.mjs`：
- `DA-CATALOG-DRIFT 只改名稱的例外不能人工結案（要資料擁有者確認）；其他種類可以`
- `DA-TEST-REPORT-FOLLOWUP 不能人工結案`

端對端 `e2e/tests/exceptions.test.mjs`：390px，處理人看到清單、篩選、認領、以金鑰結案；稽核看得到但沒有按鈕；無水平捲動。

### 3.6 對紅隊腳本與 `tools/run-all.sh`

- `54-exception-close-counting`、`49-revoke-residual`（判定會把已結案的例外算進去，D89 (3)）：人工結案是新路徑，腳本不需改就應維持 0；但 49 的判定方式已知有問題，交紅隊。
- 新攻擊面（交紅隊）：當事人經別人的名義結案、只憑登入結案、以 close_check 的時間差結掉仍成立的例外、對帳發現連帶結案被灌爆（K-RECON-LIMIT）。
- `run-all.sh` 不變；端對端多一支。

### 3.7 威脅

| 攻擊者 | 想做什麼 | 擋法 | 殘餘 |
|---|---|---|---|
| 冒用登入（身分提供者被冒用） | 結掉警訊掩蓋痕跡 | 結案要通行金鑰 | — |
| 造成例外的人 | 自己結掉 | `exception_involved` | detail 沒記到的間接當事人；`involved_detail_keys` 是參數，可補 |
| 處理人 | 結掉仍成立的狀況 | auto_only、close_check；通知稽核主管 | 「條件」只對有 close_check 的代碼成立；其餘靠稽核抽查 |
| 對帳帳號 | 讓發現看起來解決，連帶結掉例外 | 回報要外部系統簽章、連續數輪（D84 (5)），沿用 | 外部系統本身說謊（D95 (4) 已知） |

### 3.8 大小與相依

**中～大**（SQL 中、頁面與端對端中）。依賴第 1 批（例外頁的「環境模式」橫幅）；`K-RESTORE-GAP` 的 close_check 依賴第 3 批（若第 4 批先做，這一列在第 3 批補登）。可與第 2、3 批平行。

## 4. 防改寫的繞過路徑（G-11、G-10）

### 4.1 trigger 一律 `ENABLE ALWAYS`

- `580_tamper_hardening.sql`：對核心 12 個 trigger 逐一 `alter table <表> enable always trigger <名稱>;`。`data_access/175_tamper_hardening.sql`：流程包 13 個。之後新增的 trigger，migration 作者自己寫 `enable always`；架構測試擋漏寫。
- `ENABLE ALWAYS` 讓 `session_replication_role = replica` 也照樣觸發。剩下的繞法是 superuser `alter table ... disable trigger`：停用期間指紋改變（`tgenabled` 本來就在指紋裡），恢復成 `A` 之後看不出來——這是 pgaudit 才能補的，見 §4.4。

### 4.2 程式指紋涵蓋全部 schema（指紋 v2）

`create or replace function api_job.code_fingerprint()`（同簽章，`580`）：
- 範圍：所有 `nspname not like 'pg\_%' and nspname <> 'information_schema'` 的 schema（不再列名單；流程包 schema、`sgn_sdk`、`api_delivery`、`api_idp`、`public` 都算）。
- 內容（每一類一個前綴，排序後串接再 SHA-256，與 v1 相同的組法）：
  - `s:` schema 名稱、擁有者、`nspacl`（新增 schema 就變）
  - `f:` function（`prokind` 全部種類，不只 `'f'`）的 `regprocedure`、`pg_get_functiondef`（aggregate 用 `proname` 加參數型別）、`proacl`、`proowner`、`prosecdef`、`proconfig`
  - `t:` 非內部 trigger 的定義與 `tgenabled`
  - `r:` relation 的 `relacl`、擁有者、`relkind`、`relrowsecurity`、`relforcerowsecurity`
  - `c:` 欄位：`attname`、型別、`attnotnull`、預設值運算式（`pg_get_expr`），排除 `attisdropped`
  - `k:` 限制（`pg_get_constraintdef`）
  - `i:` 索引（`pg_get_indexdef`；含 `signing_key_one_current` 這類唯一索引）
  - `p:` row level security policy（`pg_policies`，目前沒有，留著防新增）
  - `w:` rewrite rule（`pg_rewrite`，排除 view 的 `_RETURN`）
  - `e:` 擴充套件名稱與版本（`pg_extension`；pgcrypto 升版也要確認）
  - `v:` 事件 trigger（`pg_event_trigger` 的名稱、事件、`evtenabled`；目前沒有，防新增）
- **刻意不納入**（寫在 function 的註解，「為什麼」）：資料庫層級的 `datacl`（測試與還原會對複本 `grant connect`）、叢集角色的屬性與成員（紅隊腳本會建刪角色；角色與連線來源屬 G-19 的 `pg_hba` 正面表列）、序列的目前值與統計資訊（正常運作就會變）。
- 實作者先在 `sgn_test` 上確認：全套資料庫測試前後、端對端前後，指紋不變（若有正常運作會改的部分，找出來排除並寫原因，**不是**拿掉整類）。

### 4.3 對既有測試的影響（必須在 handoff 寫明；沒有任何斷言被放寬）

- `db/tests/kernel/60-chain.test.mjs` 的 `tamper()` 以 `disable trigger user` 停用、以 `enable trigger user` 恢復。改成 ALWAYS 之後，`enable trigger user` 會把 trigger 恢復成 `O` 而不是原本的 `A`，指紋因此改變，`竄改 1b`、`2`、`5` 的 `deepEqual` 會多出 `CODE_CHANGED`，`竄改 3`、`4` 的 `ok: true` 會變 false。
  - 修法：`tamper()` 恢復時逐一 `enable always trigger <名稱>`（名單由 `pg_trigger` 查，不手抄）。這是讓測試裡的攻擊者「如實恢復原狀」，和原本的攻擊者模型相同；所有斷言不變。
  - `竄改 8` 的第二段（「恢復之後就看不出來」）同樣改成 `enable always` 恢復，斷言不變；**新增** `竄改 8b：恢復成 ENABLE（不是 ALWAYS）→ CODE_CHANGED`。
- `92-program-stall.test.mjs` 不受第 1 批影響。
- 指紋 v2 會改變所有既有資料庫的指紋：驗證環境每次重建，錨點檔也重建，不受影響；正式環境還不存在，不需要第 2 批的承認流程（G-10 原寫的「會觸發一次 G-01b」不成立）。

### 4.4 pgaudit 的替代（G-11 後半）

工程規範 §4 只准 `pgcrypto`，所以不裝 pgaudit。這一批做的是 PostgreSQL 內建的最小替代，寫進 `db/install.sh` 的 `conf.d/sgn-logging.conf`（第 5 批）：`log_connections = on`、`log_disconnections = on`、`log_line_prefix` 帶使用者與來源；對管理者角色 `alter role <管理者> set log_statement = 'all'`；log 以 syslog 送到看門狗主機（第 6 批）。殘餘（寫進 break-glass.md）：superuser 可以在自己的工作階段 `set log_statement = 'none'`；這個動作本身會先被記下嗎——不會。所以這只能留下「誰、何時連進來」，不能保證留下語句內容；要語句層級的保證只有 pgaudit 或作業系統層的 session 錄影（§10 第 19 題）。

### 4.5 測試

`db/tests/kernel/99-ops-tamper.test.mjs`：
- `K-AUDIT-APPEND 所有非系統 schema 的非內部 trigger 都是 ENABLE ALWAYS（tgenabled = 'A'）`
- `K-AUDIT-APPEND session_replication_role = replica 時，稽核事件、鏈頭、參數值、使用摘要、目錄版本的 UPDATE／DELETE／TRUNCATE 仍被擋`（逐張表）
- `K-CODE-FINGERPRINT 改 sgn_sdk、api_delivery、api_idp、pack_data_access 各一個 function：指紋改變`
- `K-CODE-FINGERPRINT 刪掉 signing_key_one_current、刪一個 check 限制、改一個欄位預設值：指紋改變`
- `K-CODE-FINGERPRINT 新增一個 schema、在 public 建一個 function：指紋改變`
- `K-CODE-FINGERPRINT trigger 由 ALWAYS 改回 ENABLE：指紋改變`
- `K-CODE-FINGERPRINT 正常運作不改變指紋（建單、決定、登入、對帳、通知、心跳前後相同）`
- `K-CODE-FINGERPRINT 對複本 grant connect 不改變指紋`

### 4.6 對紅隊腳本與 `tools/run-all.sh`

- 沒有腳本用 `session_replication_role` 或停用 trigger。`10-authz-blocked` 的 `pg_temp` function 不在範圍（`pg_%`）。紅隊腳本在執行中的系統上若建 schema、在 `public` 建 function 或改限制，錨定會因 `CODE_CHANGED` 停住並開 K-ANCHOR-LAG——撰寫時沒有這樣的腳本；下一輪紅隊的新腳本若要這樣做，應在複本上做（60-chain 的做法）。
- `run-all.sh` 不變。

### 4.7 威脅

| 攻擊者 | 想做什麼 | 擋法 | 殘餘 |
|---|---|---|---|
| superuser | `session_replication_role = replica` 後改事件 | ALWAYS | — |
| superuser | 停用 trigger、改、再恢復 | 停用期間指紋改變；改了的事件被雜湊與錨點抓 | 「試過」不留痕跡（無 pgaudit） |
| superuser／owner | 改流程包或 `sgn_sdk` 的 function、刪限制或唯一索引 | 指紋 v2 | 只改資料不改結構：靠事件與錨點；業務資料表直接改而不寫事件仍抓不到（break-glass.md §7 已載明） |

### 4.8 大小與相依

**小**。放在第 1 批（指紋要在兩人確認之前定案）。

## 5. 缺的心跳與監看（G-08）

### 5.1 後端（api）的心跳

- `sgn.program` 新增一列 `api`（`610_liveness_extra.sql`）。
- `api.backend_heartbeat() returns jsonb`：沒有參數（契約測試允許），`security definer`，固定呼叫 `sgn_internal.program_heartbeat('api')`——**只能報自己**，不收程式代碼參數。加進 `backendCalls`。
- `api/src/server.ts` 啟動後每 `SGN_API_HEARTBEAT_SECONDS`（環境變數，預設 30，定義在 `config.ts` 的 `envVars`）呼叫一次；失敗只寫 log，不讓服務停。
- 門檻：既有參數 `program.heartbeat_max_seconds`（預設 300）。

### 5.2 web 與 anchor-store：不進資料庫，由外部看門狗看

- 這兩個程式刻意不連資料庫（web 沒有任何密鑰；存放處要和資料庫、後端獨立，D81 (4)）。讓 api 或錨定程式「替它們報平安」違反 D88 (3) 與紅隊 55 的原則（一個程式不能替別的程式報心跳）。
- 平台內已有的間接訊號：存放處停了 → K-ANCHOR-LAG；web 停了 → 沒人能用。直接的存活訊號由 §5.4 的看門狗負責。在 programs.md 寫明。

### 5.3 健康端點

- `api.health_status() returns jsonb`（沒有參數，加進 `backendCalls`）：`{db_now, environment: {kind, mode}, chain_head_seq, last_anchor_receipt: {seq, recorded_at}, programs: [{code, stalled}], open: {<規則代碼>: 未結案筆數}}`，`open` 只列參數 `health.watched_rules`（預設 `["K-PROGRAM-STALLED", "K-ANCHOR-LAG", "K-NOTIFY-STUCK", "K-RESTORE-GAP", "K-BACKUP-STALE", "K-DELIVERY-STUCK", "K-RECON-OVERDUE"]`）。**不含任何人名、單號、detail**。
- 後端路由 `GET /health`：需要 `Authorization: Bearer <看門狗權杖>`；後端只存權杖的 SHA-256（`api.env` 的新鍵 `SGN_HEALTH_TOKEN_SHA256`，同錨點存放處的做法），比對用 `timingSafeEqual`。權杖本體只在看門狗主機。
- 不呼叫 `program_stall_check`（健康端點是唯讀；會開例外的檢查仍是心跳與 `program_health`）。

### 5.4 外部看門狗（最小做法）

- `deploy/watchdog/watchdog.mjs`：跑在**平台以外**的主機（§10 第 1 題），只用 Node 標準函式庫，不連資料庫。每 `--every 60` 秒：
  1. `GET <web>/` 200；
  2. `GET <api>/health`（帶權杖）200，且 `programs[].stalled` 全為 false、`environment.mode = 'normal'`、`open` 的計數沒有比上一輪增加；
  3. `GET <anchor-store>/anchors` 200，最後一個錨點的 `anchored_at` 在 `--anchor-max-age`（預設 3600 秒）內，且 `seq` ≥ health 的 `last_anchor_receipt.seq`；
  4. 時鐘：`|health.db_now − 看門狗主機時間| ≤ --clock-skew-max`（預設 5 秒；簽章 300 秒、回報 120 秒的新鮮度都依賴它）。看門狗主機本身要對時（§10 第 13 題）。
- 告警：狀態由正常變異常、或異常變正常時，`POST` 到 `SGN_WATCHDOG_ALERT_URL`（JSON：檢查項、上一次正常的時間、目前值；**不經平台的寄信程式**）。同一異常每 `--repeat` 秒（預設 3600）重送一次。設定與權杖讀 `/etc/sgn-watchdog/watchdog.env`（0400）。
- 看門狗自己死掉：每輪成功後 `GET`／`POST` 一次 `SGN_WATCHDOG_DEADMAN_URL`（外部的「定期報到」服務，沒報到就由那一方告警；§10 第 8 題）。沒有這個服務時，`deploy/watchdog/README` 要求兩台看門狗互相看。
- 磁碟與主機：`deploy/bin/host-check.sh`（systemd timer，每 5 分鐘，在資料庫主機上）：`df` 低於 `--min-free-percent`（預設 15）、`chronyc tracking` 偏移超過 1 秒、`archive_command` 失敗次數（`pg_stat_archiver.failed_count` 增加）→ 直接 POST 到同一個告警 URL。主機整個停掉時由看門狗的 HTTP 檢查發現。
- PostgreSQL 停了：api 的 `/health` 回 503 → 看門狗告警。這是「偵測者和被偵測者不死在一起」的最小做法。

### 5.5 K-NOTIFY-STUCK 要通知到人

- `615_notify_stuck_recipients.sql`：`create or replace function sgn_internal.notification_stuck_check()`（同簽章）：照舊每則卡住的通知開一筆例外；**這一輪新開了任何一筆**時，呼叫一次 `sgn_internal.notify('notification.stuck', <參數 notification.stuck_notify_roles 的持有人>, null, {count, oldest_created_at})`（合併成一則，站內待辦＋郵件）。
- 防無限增生：`event_code = 'notification.stuck'` 的通知自己卡住時，照樣開例外，但**不**再觸發新的 `notification.stuck` 通知。
- 遞迴：`notify` 寫入前會呼叫 `notification_stuck_check`（`390`）。新開的那則通知剛建立、不會立刻符合「超過時間」，遞迴呼叫找不到新的列就結束；測試要覆蓋。
- 郵件可能就是壞掉的那一段：站內待辦照常；看門狗看 `open.K-NOTIFY-STUCK` 的計數增加也會走非郵件告警。

### 5.6 檔案、代碼、參數

- `db/kernel/610_liveness_extra.sql`（api 程式列、`backend_heartbeat`、`health_status`；項 7 的 directory-sync 程式列也在這裡）、`db/kernel/615_notify_stuck_recipients.sql`。
- `api/src/server.ts`（心跳、`/health`）、`api/src/config.ts`（新環境變數與 `SGN_HEALTH_TOKEN_SHA256` 的讀取）、`db/tools/lib/programs.mjs`（api 多一個密鑰鍵 `SGN_HEALTH_TOKEN_SHA256`）、`deploy/watchdog/watchdog.mjs`、`deploy/watchdog/watchdog.env.example`、`deploy/bin/host-check.sh`、`deploy/systemd/`（第 5 批產生）。
- 規則代碼：`K-PROGRAM-STALLED` 說明補 api；`K-NOTIFY-STUCK` 說明補通知對象；新 `K-HEALTH-READ`（健康端點的內容限制與權杖）。
- 參數：`notification.stuck_notify_roles`（json，`["tech_ops", "audit_head"]`）、`health.watched_rules`（json，見上）。
- 新密鑰：K14 看門狗權杖（key-rotation.md 補一列）。

### 5.7 測試

`db/tests/kernel/99-ops-liveness.test.mjs`：
- `K-PROGRAM-STALLED 後端心跳：backend_heartbeat 只更新 api 那一列；api 超過門檻沒心跳就開例外，回來就結案`
- `K-PROGRAM-STALLED sgn_app 不能替別的程式報心跳（呼叫其他心跳函式被拒）`
- `K-HEALTH-READ 健康狀態只有允許的欄位，不含人名、單號、detail；只有 sgn_app 能呼叫`
- `K-NOTIFY-STUCK 一輪新開卡住例外時，通知 notification.stuck_notify_roles 的持有人一次（站內待辦）`
- `K-NOTIFY-STUCK 關於卡住通知的通知自己卡住：開例外但不再產生新的 notification.stuck 通知`
- `92-program-stall.test.mjs` 的 `programs` 表補上 `api`（與第 5 批的 `directory-sync`）：這是讓既有測試涵蓋新程式，不是放寬；不補的話新程式從沒心跳會在測試中開出非預期的例外。

`deploy/watchdog/watchdog.test.mjs`（`node:test`，單元測試用本機假伺服器）：每一項檢查的正常、異常、恢復、重送間隔、時鐘偏移。整合：`tools/run-all.sh` 在端對端之後以 `--once` 對執行中的開發系統跑一次，告警 URL 指向本機的接收器，斷言全部正常；再 `kill -STOP` api 程式，下一輪斷言告警送出，`kill -CONT` 後斷言恢復通知（這一步放在端對端之後，避免干擾）。

### 5.8 對紅隊腳本與 `tools/run-all.sh`

- `run-all.sh`：api 多一個每 30 秒的心跳；最後多一步看門狗整合檢查（約 1 分鐘）。
- `55-liveness-heartbeat`：檢查的跨程式組合不含 api；新的 `backend_heartbeat` 不收代碼參數，不會讓 55 回 1。交紅隊補打「sgn_app 報其他程式」。
- `47-scheduler-delivery-outage`：多了 api 的心跳觸發存活檢查（每個心跳都檢查別人），只會更快發現，不改變判定。

### 5.9 威脅

| 攻擊者 | 想做什麼 | 擋法 | 殘餘 |
|---|---|---|---|
| 拿到 `sgn_app` 的人 | 停掉別的程式並替它報平安 | 每個心跳函式只授權給自己的角色、只報自己 | 可替 api 自己報平安（後端已被拿下） |
| 停掉整台主機或 PostgreSQL | 讓所有偵測一起停 | 平台外的看門狗 | 看門狗與報到服務同時失效 |
| 拿到看門狗權杖 | 讀健康狀態 | 內容不含個資；只是一個計數 | 知道系統哪裡壞了 |
| 讓寄信停擺 | 讓卡住的通知沒人知道 | 站內待辦＋看門狗非郵件告警 | — |

### 5.10 大小與相依

api 心跳與 K-NOTIFY-STUCK：**小**。健康端點、看門狗、host-check：**中**。依賴第 1 批（環境模式）；看門狗的部署形態依賴第 5 批（systemd）。

## 6. 金鑰與密鑰輪替（G-05、G-24）

### 6.1 一支工具

`db/tools/secrets.mjs`（root），兩個子命令；`provision-secrets.mjs` 變成 `secrets.mjs provision --dev-build` 的包裝（`db/build.sh` 專用，guard 過才執行）：

- `provision [--program <p>]`：建立缺少的作業系統帳號與密鑰檔；**已存在的密鑰一律不覆寫**；錨點檔不存在才建立（第 1 批已改）。正式環境的安裝用這個。
- `rotate <種類> [--program <p>] --change-ref <單號>`：只換一個、保留檔案擁有者與權限（寫暫存檔 → `chmod 0400`、`chown` → `rename`）、寫 `ops.secret_rotated`（種類、程式、操作者、單號；不含值或雜湊）、印出要重啟的單元（第 5 批後直接 `systemctl restart`）。

| 種類 | 對應 key-rotation.md | 步驟（工具做的事） | 停機 |
|---|---|---|---|
| `role-password` | K1 | 產生新密碼（`randomBytes(24)` hex，同 build.sh 的長度）→ 寫該程式密鑰檔的 `SGN_DB_PASSWORD` 與 `roles.env` 的那一列 → `alter role ... password` → 重啟該程式 → 等它的心跳更新（`sgn.program.last_seen`），逾時就回報失敗（舊密碼已失效，必須處理） | 那一個程式重啟數秒 |
| `anchor-write-key` | K7 | 停 anchor → 產生新金鑰 → 寫 `anchor-store.env` 的雜湊、重啟 anchor-store → 寫 `anchor.env` → 啟動 anchor → 等一個新錨點被收下。**不碰錨點檔** | 錨定暫停數秒（遠低於落後門檻） |
| `dc-call-key` | K5、K6 | 讀外部系統管理人提供的新金鑰（從 stdin，不進命令列與 shell 歷史）→ 寫 `delivery.env` 或 `reconciler.env` 的 `SGN_DC_KEY` → 重啟 | 該程式數秒 |
| `idp-client-secret` | K8 | 同上，寫 `api.env` | api 數秒 |
| `ldap-reader` | K12 | 同上，寫 `directory-sync.env`（項 7） | 無（下一輪同步才用） |
| `health-token` | K14 | 產生新權杖 → 寫 `api.env` 的雜湊 → 重啟 api → 印出權杖本體給看門狗主機（只印一次） | api 數秒 |
| `signing-key stage|activate|finish` | K3 | 見 §6.2 | 無 |
| `channel-key add|only` | K4 | 包裝 `sgn_internal.channel_key_register(..., false)` 與 `(..., true)` | 無 |

`secrets.mjs` 以 owner 呼叫 owner 專用的 function；沒有新的 `api` function。

### 6.2 交付簽章金鑰的新舊並存（K3）

資料庫裡仍然**只用一把簽**（不放寬 `D81 (2)`「信任清單只放目前那一把」的精神：並存只發生在外部系統的信任清單上，而且有上限）：

1. `stage`：`sgn_internal.signing_key_stage(p_key_id text) returns text`——產生新金鑰，狀態「預備」（`activated_at is null`），回傳公鑰 PEM；事件 `delivery.signing_key_staged`。預備的金鑰不簽任何東西。
2. 外部系統管理人把新公鑰加進信任清單（此時清單有兩把）。開發環境由 `delivery-keys.mjs --add-staged` 寫 sim/dc 的清單並重啟實例。
3. `activate`：`sgn_internal.signing_key_activate(p_key_id text) returns void`——新的成為唯一啟用、舊的 `retired_at = now()`；事件 `delivery.signing_key_activated`（新舊 key_id）。之後所有新交付用新金鑰簽；已簽好送出的舊信封仍可被外部系統驗（它的清單還有舊的）。
4. 等進行中的交付都有結果（工具查 `sgn.delivery_op` 沒有以舊金鑰簽、尚未有結果的列，實作者依 `410` 的欄位寫查詢）。
5. 外部系統移除舊公鑰；`finish`：`sgn_internal.signing_key_external_retired(p_key_id text) returns void` 記下「外部已移除舊金鑰」；事件 `delivery.signing_key_external_retired`。開發環境由 `delivery-keys.mjs` 重寫清單只留目前那一把。

- 資料表（`620_signing_key_rotation.sql`）：`alter table sgn.signing_key add column activated_at timestamptz, add column external_retired_at timestamptz`；既有列 `activated_at = created_at`。換索引：`drop index sgn.signing_key_one_current`；`create unique index signing_key_one_active ... where activated_at is not null and retired_at is null`；`create unique index signing_key_one_staged ... where activated_at is null and retired_at is null`。簽章入口（`410` 讀 `retired_at is null` 那一把的地方）改成讀「啟用中」那一把（實作者 `grep -n "retired_at is null" db/kernel/*.sql` 逐一改成 `create or replace`）。`signing_key_create` 維持「建立即啟用」（建置與安裝用）。`signing_keys_current()` 回傳啟用與預備的（給 `delivery-keys.mjs` 寫清單）。
- 並存上限：`api_job.signing_key_rotation_check()`（加進 `schedulerCalls`）：預備超過 `delivery.signing_key_stage_max_hours`、或啟用後超過 `delivery.signing_key_overlap_max_hours` 還沒有 `finish` → 開 `K-SIGNING-KEY-ROTATE`（自動結案：啟用或 finish 之後）並通知升級對象。
- G-24（`key_custodian` 沒人用）：決定為「`secrets.mjs` 的 `signing-key`、`health-token`、備份解密金鑰的保管人」，在 key-rotation.md 寫明誰做哪一步；平台內不給它任何 function（這些都是 root 端的操作）。若負責人不要這個角色，改為移除（§10 第 14 題）。

### 6.3 代碼、參數、測試

- 規則代碼：`K-SECRET-ROTATE`、`K-SIGNING-KEY-ROTATE`。錯誤代碼：`SIGNING_KEY_STATE` 409（重複預備、啟用不是預備中的、finish 不是已退役的）。
- 參數：`delivery.signing_key_stage_max_hours`（integer，168）、`delivery.signing_key_overlap_max_hours`（integer，72）。

`db/tests/kernel/99-ops-keys.test.mjs`（`secrets.mjs` 對暫存的 `SGN_STATE_DIR` 與 `sgn_test` 的複本執行）：
- `K-SIGNING-KEY-ROTATE 預備的金鑰不簽任何交付；啟用後只用新的簽；舊的退役`
- `K-SIGNING-KEY-ROTATE 同時最多一把啟用、一把預備（SIGNING_KEY_STATE）`
- `K-SIGNING-KEY-ROTATE 預備太久、或啟用後太久沒有 finish：開例外；完成後結案`
- `K-SECRET-ROTATE 換一個角色的密碼：只有那個密鑰檔與 roles.env 那一列改變，擁有者與權限不變，舊密碼連不上，其他角色不受影響`
- `K-SECRET-ROTATE 換錨點寫入金鑰：錨點檔位元組不變；舊金鑰寫入回 401；新金鑰寫得進`
- `K-SECRET-ROTATE ops.secret_rotated 不含任何密鑰值或雜湊`
- `K-ENV-IDENTITY provision 不覆寫已存在的密鑰`
- `95-program-secrets`、`97-program-reach` 由 `programs.mjs` 自動涵蓋新增的鍵（`SGN_HEALTH_TOKEN_SHA256`、`SGN_LDAP_READER_PASSWORD`），不需改測試。

`sim/dc/tests/`：信任清單兩把時兩把簽的信封都收；只剩一把後舊的不收。

### 6.4 對紅隊腳本與 `tools/run-all.sh`

- `25-dev-key-still-trusted` 讀 sim/dc 的信任清單：只在輪替中途有兩把；建置與 `run-all.sh` 結束時只有一把，腳本維持 0。
- `20-backend-holds-all-keys`：新密鑰鍵都依程式分檔，`sgn-api` 讀不到別人的。
- `run-all.sh` 不變（輪替測試在資料庫測試裡用暫存目錄）。

### 6.5 威脅

| 攻擊者 | 想做什麼 | 擋法 | 殘餘 |
|---|---|---|---|
| 主機 root | 輪替時讀到密鑰 | 本來就讀得到（K2）；工具不把值寫進命令列、log、事件 | — |
| 外部系統的信任清單長期留著舊金鑰 | 舊金鑰外洩後仍可簽交付 | 並存上限＋例外 | 外部系統不照做時平台只能告警 |
| 操作失誤 | 密碼換了但程式沒重啟成功 | 工具等心跳，失敗就明確回報 | — |

### 6.6 大小與相依

**中**。依賴第 1 批（guard、ops 事件）與第 5 批（`SGN_STATE_DIR`、systemd 重啟；在第 5 批之前以印出指令代替）。

## 7. 人員目錄同步排程（G-07）

### 7.1 設計

- `programs.mjs` 新增：`'directory-sync': { roleKey: 'SYNC', secrets: ['SGN_LDAP_READER_PASSWORD'], entry: 'db/tools/directory-sync.mjs' }`。作業系統帳號 `sgn-directory-sync`、密鑰檔 `directory-sync.env`；LDAP 的網址、DN 是非機密設定（G5 的 `integrationEnv('ldap')`）。
- `directory-sync.mjs`：
  - 執行期改用 `loadProgramConfig('directory-sync')` 與 `programDbUrl`；`readDirectory` 改收 `{url, readerDn, readerPassword, peopleDn, groupsDn}`。
  - 保留操作者模式（`--operator`，`db/build.sh` 的第一次基準同步用，讀 root 的設定）。
  - `--every <秒>` 常駐；每輪先呼叫新的 `api_sync.directory_sync_heartbeat()`，再同步。同步失敗（LDAP 連不上、資料庫整批拒絕）只寫 log，不結束；心跳照報（心跳證明程式在跑；同步被拒由既有的 `directory.sync_rejected` 與例外處理）。
- 資料庫（`610`）：`sgn.program` 新增 `directory-sync`；`api_sync.directory_sync_heartbeat()` 呼叫 `program_heartbeat('directory-sync')`，加進 `syncCalls`；`register_setting_value('program.heartbeat_max_seconds', 'program:directory-sync', 2700, ...)`（3 倍於預設排程間隔）。
- 排程間隔：正式環境 `deploy/` 的 systemd 單元參數 `--every 900`（§10 第 12 題）；`run-all.sh` 用 `--every 900`，而且**第一輪延後一個間隔才同步**（建置剛做過基準同步），降低和紅隊腳本改 LDAP 的競態。
- 每輪都會寫一筆 `directory.synced` 事件（`340_directory_identity.sql`）：每天 96 筆、五年約 17.5 萬筆，可接受；在 G-16 的量測裡列入。

### 7.2 測試

- `db/tests/kernel/99-ops-liveness.test.mjs` 加：`K-PROGRAM-STALLED 目錄同步程式有自己的心跳與門檻 program:directory-sync`；`K-HR-SYNC 排程同步以 sgn_sync 與自己的密鑰檔執行，讀不到 roles.env 與 LDAP 以外的密鑰`（`95`／`97` 由程式表自動涵蓋，這一條另外斷言實際執行）。
- 既有 `79-directory-sync.test.mjs` 不改（操作者模式仍在）。
- `92-program-stall` 的 `programs` 表補 `directory-sync`（同項 5）。

### 7.3 對紅隊腳本與 `tools/run-all.sh`

- `run-all.sh` 多一個程式（`start_program directory-sync ... --every 900 --delay-first`）。
- 可能的競態：會改 sim LDAP 再自己觸發同步的腳本（實作者 `grep -ln "ldap\|directory" redteam/exploits` 列出，撰寫時包含與人員同步、角色來源相關的幾支）。第一輪延後 900 秒，一般單支腳本跑完前不會撞到；連跑全部 57 支時可能撞到——交紅隊確認，必要時紅隊在腳本開頭 `kill -STOP` 這個程式（腳本歸紅隊，開發者不改）。

### 7.4 威脅

| 攻擊者 | 想做什麼 | 擋法 | 殘餘 |
|---|---|---|---|
| 拿到同步程式的密鑰 | 灌假的人事異動 | 既有的同步防護（冷卻、大量停用延後、篩選；D66）不變 | 與現況相同 |
| 停掉同步 | 讓離職不進來 | 心跳與 K-PROGRAM-STALLED | — |
| 拿到 `sgn-directory-sync` 帳號 | 讀其他程式的密鑰 | 每程式一個帳號與檔案（95、97） | — |

### 7.5 大小與相依

**小**。依賴第 1 批（guard）；與第 5 批的 api 心跳同一個 migration（`610`），放在同一批。

## 8. 正式環境的安裝（G-01 其餘：設定來源、`install.sh`、服務定義）

項 1 只處理資料庫的升級；要在正式主機上「第一次裝起來」還需要這一節。它是第 5 批的主體。

- **設定來源**（G5）：`db/tools/lib/env.mjs` 新增 `integrationEnv(name)`，`name` ∈ `idp`、`ldap`、`mail`、`dc`：`SGN_PROFILE=sim` 時讀 `sim/<name>/service.env` 並把 `SIM_*` 對應成中性鍵（對照表寫在 env.mjs 一處）；`production` 時讀 `$SGN_CONFIG_DIR/integrations.env` 的 `SGN_IDP_ISSUER`、`SGN_IDP_CLIENT_ID`、`SGN_IDP_SCOPES`、`SGN_IDP_REDIRECT_URIS`、`SGN_LDAP_URL`、`SGN_LDAP_READER_DN`、`SGN_LDAP_PEOPLE_DN`、`SGN_LDAP_GROUPS_DN`、`SGN_SMTP_HOST`、`SGN_SMTP_PORT`、`SGN_DC_*`。`api/src/config.ts`、`delivery.ts`、`reconciler.ts`、`mailer.ts`、`db/tools/idp-keys.mjs`、`directory-sync.mjs` 改呼叫它。SMTP 認證、身分提供者 TLS 與憑證釘選（D84 (3)）、真實外部系統的 adapter：**不在這一批**（需要 §10 第 15–17 題的事實），handoff 列為待辦。
- **環境變數的唯一來源**：`api/src/config.ts` 匯出 `envVars`（名稱、說明、預設值）；目前在模組頂層讀設定的部分改成 `export function loadBackendConfig()`，由 `server.ts` 呼叫（避免 `env.mjs` 與 `config.ts` 互相載入時的初始化問題）。`deploy/.env.example` 由 `tools/check-env-example.mjs` 比對（`config.ts` 的 `envVars` ↔ `.env.example` ↔ 全 repo 的 `process.env.<名稱>`），不一致就失敗；加進 `tools/check.sh`。
- **`db/install.sh --kind production|verification --database <名稱> --change-ref <單號>`**（root）：
  1. `--kind production` 時要求 `SGN_CONFIG_DIR=/etc/sgn`、`SGN_STATE_DIR=/var/lib/sgn`、主機標記不存在、目標庫不存在。
  2. `secure_admin`（從 build.sh 搬到 `db/lib/admin.sh` 共用）；建 `sgn_owner` 與缺少的登入角色（不刪、不改既有的）。
  3. `migrate.mjs --mode fresh`（含資料庫層級權限、pgcrypto）。
  4. `environment_init(<kind>, <新 uuid>, <名稱>)`；`grants-sql.mjs`。
  5. 正式設定：`webauthn.rp_id`、`webauthn.origin` 由 `/etc/sgn/sgn.env` 登記（不是開發值）；`audit.anchor_max_lag_seconds` 用預設 3600。
  6. `signing_key_create('sgn-<environment_id 前 8 碼>')`；身分提供者公鑰的第一次登記（`idp-keys-sql.mjs` 改讀 `integrationEnv('idp')`）；目錄基準同步（`directory-sync.mjs --operator`）。
  7. **不做**：種子資料、軟體金鑰的登記人（正式環境的第一位與第二位登記人走 break-glass.md 的安裝儀式，見證人在場）。
  8. `secrets.mjs provision`；`conf.d/sgn-archive.conf`、`conf.d/sgn-logging.conf`（§2.1、§4.4）並重新載入。
  9. 寫主機標記；安裝 systemd 單元並 `enable`；寫 `ops.installed`（ops 事件）。
- **服務定義**：`tools/gen-systemd.mjs` 由 `programs.mjs` 產生 `deploy/generated/systemd/sgn-<程式>.service`（`User=sgn-<程式>`、`EnvironmentFile=` 只有非機密設定、`ExecStart=node <entry> <參數>`、`Restart=always`、`RestartSec=1`、`NoNewPrivileges=yes`、`ProtectSystem=strict`、`ReadWritePaths=` 只給需要寫的、`PrivateTmp=yes`）、`sgn-preflight.service`（oneshot，§2.4）、`sgn.target`；產生檔納入「重新產生無差異」檢查；有 `systemd-analyze` 時 `verify`。各程式的週期參數放 `programs.mjs`（新欄位 `args`），`run-all.sh` 也讀同一份（收斂 run-all.sh 裡手寫的 `--every`）。
- **`run-all.sh` 與 systemd 的關係**：驗證主機照舊用 `run-all.sh`（容器裡沒有 systemd）；兩者都從 `programs.mjs` 取程式、帳號、參數。
- **測試**：`tools/check-install.sh`（加進 `check.sh`，`--fast` 不跑）：以 `--kind verification --database sgn_install_check`、`SGN_CONFIG_DIR`／`SGN_STATE_DIR` 指向暫存目錄執行安裝（主機標記寫在暫存的 `SGN_CONFIG_DIR`，guard 的固定路徑 `/etc/sgn/environment` 不受影響）→ `migrate.mjs --mode upgrade`（沒有新檔，必須是空操作）→ 在暫存的來源目錄多一個新檔再升級（只套它）→ `verifyChain` 一致 → 刪庫。
- 大小：**大**。相依：第 1 批。

## 9. 分批

每一批都要在獨立的驗證主機上從乾淨狀態通過 `tools/check.sh`，並以 `tools/run-all.sh --keep` 建起系統後依序跑 `redteam/exploits/01-*.mjs` 到最新一支：結果必須和最近一次複核（D100：34、40、57 回 1，其餘 0）相同。**不得在紅隊正在使用的系統上跑**（`check.sh` 會重建資料庫）。

| 批 | 內容（對應本文件的節） | 大小 | 依賴 | 驗收條件（全部成立） |
|---|---|---|---|---|
| 1 | 升級基礎與防呆：§1 的紀錄表、`migrate.mjs`／`migrate.sh`、模式（G1）、ops 事件（G4）、guard（G2）、lock 與 G-14、G-15；§4 全部；`provision-secrets` 不截斷 | 中～大 | — | (1) `check.sh` 全過，含新段「migration 只增不改」；(2) `99-ops-migrate`、`99-ops-env`、`99-ops-tamper` 全過；(3) `60-chain` 的改動只限 §4.3 所列，handoff 逐條對照；(4) 在驗證主機手動演示：建一個 `kind=production` 的暫存庫後 `db/build.sh` 拒絕、刪掉後通過；(5) 對 `sgn_e2e` 的複本加一個新 migration 檔跑 `db/migrate.sh`，只套那一檔；(6) 紅隊回歸不變 |
| 2 | 程式指紋的兩人確認：§1 的 G3、`code_fingerprint`、錨定接受、離線驗章、「維運確認」頁 | 大 | 1 | (1) `99-ops-attest` 與 `e2e/tests/ops-attest` 全過；(2) 演示：升級 → 錨定 `CODE_CHANGED` → 兩人簽 → 錨定恢復 → `verify-chain.mjs` 與稽核頁都一致；(3) 竄改確認事件後兩者都失敗；(4) 紅隊回歸不變；(5) **之後排一輪紅隊**（偽造、重放、from/to 不符） |
| 3 | 備份與還原：§2 全部（含 preflight 本體、演練腳本進 `check.sh`、K-BACKUP-STALE、K-RESTORE-DRILL） | 大 | 1、2 | (1) `99-ops-restore` 全過；(2) `tools/drill-backup-restore.sh` 在 `check.sh` 裡通過（含 PITR）；(3) 演練紀錄依 backup-restore.md §6 的格式填一份，附在 handoff；(4) 紅隊回歸不變；(5) **與第 2 批一起交紅隊**（假缺口、重放確認、restore_pending 寫入） |
| 4 | 例外處理與結案：§3 全部 | 中～大 | 1（`K-RESTORE-GAP` 的 close_check 依賴 3） | (1) `99-ops-exception`、`packs/.../95-exception-policy`、`e2e/tests/exceptions` 全過；(2) 390px 截圖無水平捲動、觸控目標 ≥ 44px（ux-acceptance.md）；(3) exceptions.md 的「怎麼結案」欄全部更新，與政策表一致；(4) 紅隊回歸不變 |
| 5 | 正式環境部署與排程程式：§8 全部、§5.1 api 心跳、§7 目錄同步排程 | 大 | 1 | (1) `tools/check-install.sh`、`check-env-example`、systemd 產生檔無差異全過；(2) `99-ops-liveness` 的 api 與 directory-sync 部分全過；(3) programs.md 的總表多兩列且「心跳」欄沒有空白（web、anchor-store 寫「外部看門狗」）；(4) 紅隊回歸不變，連跑全部腳本時記錄是否撞到目錄同步 |
| 6 | 監看：§5.3–5.5（健康端點、看門狗、host-check、K-NOTIFY-STUCK 通知） | 中 | 5 | (1) `99-ops-liveness` 其餘、`watchdog.test.mjs` 全過；(2) `run-all.sh` 的看門狗整合步驟：停 api 後告警、恢復後恢復通知；(3) 紅隊回歸不變 |
| 7 | 金鑰輪替：§6 全部 | 中 | 1、5 | (1) `99-ops-keys`、sim/dc 的雙金鑰測試全過；(2) 在驗證主機對執行中的系統逐一演示每一種 `rotate`，每種之後 `verify-chain.mjs` 回 0、稽核頁背景程式全綠、沒有新的 K-DELIVERY-REJECTED；(3) key-rotation.md 每一節由「未演練」改成工具指令與演練紀錄；(4) 紅隊回歸不變；(5) **全部七批完成後一輪完整紅隊** |

建議順序：1 → 2 → 3 → 4 →（5 → 6、7）。4 可在 1 之後與 2、3 平行（由不同代理，注意 `routes.ts`、`zh-Hant.ts`、`sgn.ops_event_kind` 的合併）。migration 編號已依這個順序預留；平行做時由主代理分配，不得兩批用同一個號碼。

## 10. 需要負責人提供的事實（附建議預設）

實作者在得到回答之前照「建議預設」做，並在 handoff 標「預設，待負責人確認」。

| # | 問題 | 影響哪一批 | 建議預設 |
|---|---|---|---|
| 1 | 正式環境幾台主機、各跑什麼？ | 5、6 | 三台：(a) 資料庫＋所有平台程式；(b) 錨點存放處（不同的管理者，G-06）；(c) 看門狗＋接收 PostgreSQL log。理想是把 (a) 拆成資料庫與應用兩台，但不是這一批的前提 |
| 2 | 作業系統、PostgreSQL 的安裝方式與程序管理？ | 5 | Debian／Ubuntu 的 PostgreSQL 16 官方套件、systemd（與開發環境同版本） |
| 3 | 正式資料庫名稱與環境標籤？ | 5 | 資料庫 `sgn_prod`、標籤「正式」；`environment_id` 安裝時產生 |
| 4 | 備份存哪、保存多久、解密金鑰誰保管？ | 3 | 另一台主機或 NAS（資料庫主機只能寫入、不能刪除）；每日邏輯備份留 35 天、每月第一份留 12 個月、WAL 與基底備份留 14 天；每週一份複本到異地；解密私鑰由金鑰保管人離線保管兩份（不同地點） |
| 5 | RPO／RTO？正式環境的還原演練在哪台主機做？ | 3 | RPO 5 分鐘（`archive_timeout = 300`）、RTO 4 小時；每月在一台獨立的演練主機用最新備份做一次，結果寫回正式庫 |
| 6 | 兩人確認的第一位與第二位是誰？還原缺口要不要排除當事人？ | 2、3 | 第一位：技術維運（`tech_ops`）的任何持有人；第二位：資安長（`ciso`）或稽核主管（`audit_head`）的任何持有人；兩人不同。還原缺口：`involved` 預設空，由第二位自行迴避 |
| 7 | 升級後、指紋確認前，要不要擋業務寫入？ | 2 | 擋（維持 `maintenance`，只允許登入與確認）。若負責人認為停機太久，改成「不擋，只讓錨定暫停」，參數化為 `ops.block_writes_until_attested`（boolean） |
| 8 | 非郵件的告警管道？外部的定期報到服務？ | 6 | 公司既有的聊天工具 webhook；報到服務若沒有，就兩台看門狗互看 |
| 9 | 例外人工結案要不要第二人覆核（骨幹的 `pending_review`）？ | 4 | 不要：已要求通行金鑰、非當事人、通知稽核主管；稽核季抽查 |
| 10 | 例外的處理角色對應（`exception.handler_roles`）？ | 4 | 依 §3.4 的預設表 |
| 11 | 錨點存放處副本的保管人（不同於資料庫管理者）？ | 3 | 稽核主管指定的儲存位置與帳號 |
| 12 | 人員目錄同步的頻率與正式的唯讀帳號？ | 5 | 每 15 分鐘；由 AD／LDAP 管理者開一個只讀人員與群組的服務帳號 |
| 13 | NTP 來源與允許的時鐘偏差？ | 6 | 公司 NTP；看門狗告警門檻 5 秒、主機自檢 1 秒 |
| 14 | 金鑰輪替頻率（key-rotation.md §3.7）與 `key_custodian` 角色的去留？ | 7 | 照 §3.7 的建議值；保留 `key_custodian`，負責簽章金鑰、看門狗權杖、備份解密金鑰 |
| 15 | 真實外部系統（DC）在正式環境的端點、雙向 TLS 憑證由誰發？ | 5 之後 | 這一批不做真實 adapter；`integrations.env` 先留鍵 |
| 16 | SMTP 要不要認證、走哪個轉送？ | 5 之後 | 同上，先留鍵 |
| 17 | 身分提供者的 JWKS 端點與憑證釘選值？ | 5 之後 | 同上 |
| 18 | 升級單號的來源與格式？ | 1 | 公司變更管理的單號，自由文字，必填 |
| 19 | 是否允許之後例外地裝 pgaudit（工程規範 §4 目前禁止）？ | 1（只影響殘餘說明） | 不裝；以 §4.4 的內建 log 與作業系統層的 session 紀錄補，殘餘寫進 break-glass.md |
| 20 | 交付簽章金鑰並存期上限？ | 7 | 預備最長 7 天、並存最長 72 小時 |

## 11. 這一批刻意不做的事

- 真實外部系統、SMTP 認證、身分提供者 TLS／憑證釘選的 adapter（§10 第 15–17 題）。
- 錨點存放處搬到另一台主機或 WORM（G-06）：本計畫讓它可以搬（stream 名稱、獨立的備份），搬遷本身是部署動作。
- 唯讀的維運角色與事件瀏覽畫面（G-12）：`ops.read` action 先給「維運確認」與「升級紀錄」用，事件瀏覽不做。
- `pg_hba.conf` 正面表列（G-19）、設定變更單（G-22）、休假日登記（G-09）、保存與銷毀（G-16）、資安長代理（G-17）、破窗帳號（G-04 的 K-BREAKGLASS）。
- 例外的處理時限與派工：併入 D99 的下一批「時限與離職」。

## 12. 風險最大的一項

**第 3 批的還原缺口（K-RESTORE-GAP），其次是第 2 批的指紋承認。** 兩者都是放寬核心不變量：今天「鏈頭只能前進一格」「指紋一變錨定就永久拒絕」是無條件的；之後變成「在某個條件下可以」。條件判斷只要有一個漏洞（例如缺口區間的比對差一號、確認事件的 from/to 沒有綁死、離線驗章少檢查一個欄位），竄改偵測就會變成竄改洗白的正規管道——攻擊者不必再躲錨點，只要讓自己的竄改看起來像一次「還原」或「升級」。對策已寫在各節：條件全部可離線重驗（不信任資料庫）、單方面宣告只能承認遺失不能改動既有事件、沒有兩人確認前驗證一律失敗、通知治理角色，以及第 2、3 批完成後先交紅隊再往下做。實作者若在這兩批遇到任何需要「多放一點」的地方，停下來回報，不要自己決定。
