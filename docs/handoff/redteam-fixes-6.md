# 交接：裁決 D86 的兩個小修（redteam-fixes-6）

> **本檔寫於 2026-11-20，以下已過時：§0 的測試數字（之後 `redteam-fixes-7.md` 與 `closed-loop-*` 又增加測試）。仍有效：D86 (3)(4) 的小修仍是現況：合併角色 `sgn_job` 不存在、持有控制類或治理類角色的人只憑登入停用通行金鑰時當場開例外（`K-PASSKEY-SUSPEND-HOLDER`）。**

日期：2026-11-20。依據：裁決 D85 (2)、D86 (3)(4)、`docs/handoff/redteam-fixes-5.md`。
範圍：`db/`、`tools/`、`packages/contract/`、`web/i18n.js`、本文件。沒有改 `redteam/`、`rules.md` 與其他文件；沒有 commit、沒有 push。

## 0. 結果一覽

| D86 | 項目 | 結果 | 測試 |
|---|---|---|---|
| (4) | 移除合併角色 `sgn_job`；每個用到它的地方改用對的那一個角色；建置後不存在 | 做了 | `12` 新增「D86 (4)」：`sgn_job` 不存在、沒有任何角色是執行期帳號的成員、function 註解不再指名它；`12` 允許清單（不變）、`10`（拿掉 JOB）|
| (3) | 只憑登入停用通行金鑰時，持有控制類或治理類角色就當場開例外並通知 | 做了（新規則代碼 K-PASSKEY-SUSPEND-HOLDER）| `87` K-PASSKEY-SUSPEND-HOLDER |

## 1. 移除 `sgn_job`（D86 (4)）

用到它的地方逐一換成那個呼叫實際屬於的角色（依路由表的四張允許清單）：

| 地方 | 原本 | 改成 | 依據 |
|---|---|---|---|
| `db/sgn.env` | `SGN_ROLE_JOB=sgn_job` | 刪掉，留一行說明沒有合併角色 | — |
| `db/build.sh` | `login_keys` 有 JOB、`job_members` 授成員、`connect` 授 JOB、90_grants 的 `:"job"` | 拿掉；舊建置留下的 `sgn_job` 以 `retired_roles` 一併 `drop role if exists`；90_grants 的 `:"job"` 傳排程角色 | 見 §3 |
| `db/tools/grants-sql.mjs` | 撤銷清單多一個 JOB | 只撤允許清單裡的角色（90_grants 給排程角色的整個 schema 也在這裡撤掉再逐一授權）| `12` 允許清單完全相等 |
| `packages/contract/src/routes.ts` | `jobCalls`（四張表的聯集）| 刪除；`deliveryCalls` 註解改成 sgn_scheduler | `90` 改成直接合併四張表 |
| `db/tools/verify-chain.mjs`、`60`、`70`、`72`、`78`、`83` 的 `verifyChain`／`anchorOnce` | `roleUrl(config, 'JOB')` | `ANCHOR`（chain_head、events_after、code_fingerprint、anchor_policy、anchor_recorded 都在 anchorCalls）| — |
| `60` 的資料庫副本 `grant connect` | `SGN_ROLE_JOB` | `SGN_ROLE_ANCHOR` | 同上 |
| `86` 寄送 | `JOB` | `MAILER` | mailerCalls |
| `88` 卡住檢查 | `JOB` | `SCHEDULER` | schedulerCalls |
| `50` | `pool('JOB')` | 對帳回報用 `RECONCILER`，其餘（stuck、expire、overdue）用 `SCHEDULER`；「不能領交付」對兩者各斷言一次 | — |
| `55`、`79`、`83`、`85` | `pool('JOB')` | `SCHEDULER` | — |
| `85` 儀式 function 不授權給執行期帳號 | APP、SYNC、JOB | APP、SYNC 與四個程式角色 | 加嚴 |
| `12` 新建 function 預設不開放 | public、APP、SYNC、JOB；只建 api、api_sync 的探針 | public 與允許清單的全部角色；另建 api_job 的探針 | 加嚴（原本 JOB 經成員關係涵蓋 api_job）|
| `12` 合併角色的斷言（聯集、沒有直接授權）| 有 | 換成「不存在、執行期帳號沒有成員」| D86 (4) |
| `10` 角色隔離 | 含 JOB | 拿掉（四個程式角色原本就逐一檢查）| — |
| 已套用的 migration 的 `COMMENT ON FUNCTION`（12 個 api_job function 寫著「呼叫者：sgn_job」）| — | 新檔 `db/kernel/505_retire_job_role.sql` 把註解裡的 `sgn_job` 改成「程式自己的資料庫角色」；角色名只在路由表 | `12` 斷言沒有註解提到 sgn_job |
| 註解：`programs.mjs`、`env.mjs`、`run-all.sh`、`86`、`88` | sgn_job | 對的角色 | — |

已套用的 migration（`90_grants.sql`、`10`–`500` 的 SQL 註解）沒有改。

## 2. 停用通行金鑰時的例外範圍（D86 (3)）

新檔 `db/kernel/510_passkey_suspension_holders.sql`：

- `sgn_internal.passkey_suspend_all(uuid, text)` 以同簽章替換：類別判斷與例外移到新的 `sgn_internal.passkey_suspend_flag`；`passkey.suspended` 事件多 `flagged_roles` 與用到的參數。
- 類別是參數 `passkey.suspend_exception_categories`（預設 `["control", "governance"]`），依 `sgn.role.category` 判斷，任何適用範圍的指派都算；不寫死角色名。
- 新規則代碼 **K-PASSKEY-SUSPEND-HOLDER**：K-GOVERNANCE-KEY 的語意是「治理類角色的持有人必須有可用的通行金鑰」，套到控制類不對，所以另開。
  例外的 detail：當事人、角色與類別、停用編號、用到的兩個參數。通知參數 `passkey.suspend_exception_notify_roles`（預設稽核主管、資安長、登記人）的持有人，不含當事人（當事人與主管已收到 `passkey.suspended`）；範本 `passkey.holder_suspended`。
- 治理類的持有人照舊另開 K-GOVERNANCE-KEY（排程 governance_check 下一輪也會開，例外以人去重，結果一樣）。
- K-PASSKEY-SUSPEND 的規則說明與 `api.passkey_revoke_self` 的註解跟著更新；稽核頁的例外說明（`web/i18n.js`）加上新代碼。
- 「持有哪些角色」直接看 `sgn.role_assignment`（同 `holds_control_role`），不用 `has_role`：`90` 的架構測試規定 `has_role` 只出現在授權入口，這裡不是授權判斷。

`87` K-PASSKEY-SUSPEND-HOLDER（拿掉修法、只看治理類時第一段就失敗）：

1. p34 暫時持有一個控制類角色（從 `sgn.role` 依類別挑）→ 停用 → 一筆例外，列的正是那個角色；沒有 K-GOVERNANCE-KEY；通知對象各多一封、當事人沒有；事件的 `flagged_roles`。
2. p31 暫時持有一個治理類角色 → 兩個例外都開。
3. 種子資料裡本來就是系統管理人（控制類）的 p35（第一個測試停用的）→ 也開了，列的是他持有的角色。
4. 只持有平台類角色的 p32 → 不開、不通知。

## 3. 和要求不同的地方

| 項目 | 要求 | 這裡 | 理由 |
|---|---|---|---|
| `90_grants.sql` 的 `:"job"` | 改用對的角色 | 檔案不改，`build.sh` 傳排程角色 | 它是已套用的 migration；它給的整個 schema 授權隨即被 `grants-sql.mjs` 撤掉並依允許清單重授，`12` 檢查完全相等 |
| 已套用 migration 的 COMMENT | — | 用新的 migration（505）改寫，不指名角色 | 不得改已套用的；角色歸屬的唯一來源是路由表 |
| 例外代碼 | 現有代碼語意不合就新增 | 新增 K-PASSKEY-SUSPEND-HOLDER，治理類仍另開 K-GOVERNANCE-KEY | §2 |
| `build.sh` 寫著 `sgn_job` 字面 | — | `retired_roles=(sgn_job)` | 舊建置留下的角色要刪；sgn.env 不再有這個鍵 |

## 4. 怎麼驗

```bash
for p in .run/*.pid; do kill "$(cat $p)"; done; pkill -f run-all; rm -rf .run
tools/check.sh    # 以 root
```


## 5. 實測（2026-11-20，以 root，停掉背景程式、`rm -rf .run`）

第一次 `tools/check.sh`：靜態段落全過、資料庫 274／274、對照組 16／16，端對端 27／30——`path` 的 DA-PATH-L3（新裝置登記後等不到
`#flash.ok`）、K-DECISION-PROOF（登入後等不到 `[data-testid=me]`），以及接在 L3 後面的 DA-OVERLAP-COVERED。兩個逾時都卡在
身分提供者（Dex）登入頁那一步，和這次的改動沒有關係（這兩個測試不碰停用金鑰，也不經 api_job）。同一份程式碼重跑沒有再出現：
接著跑 `tools/run-all.sh` 30／30，再從乾淨狀態重跑一次 `tools/check.sh`：

| 段落 | 結果 |
|---|---|
| 安裝、格式、lint、型別、shellcheck、plpgsql_check、禁止字串、追蹤的檔案、npm audit、sim/dc | 通過 |
| 規則代碼覆蓋 | 94 個（新增 K-PASSKEY-SUSPEND-HOLDER）|
| 資料庫測試 | **274／274**（上一輪 272；新增 `12` D86 (4) 1 個、`87` K-PASSKEY-SUSPEND-HOLDER 1 個）|
| 通行金鑰對照組 | 16／16 |
| 端對端 | 30／30 |
| 結果 | 全部通過（exit 0）|

端對端那次逾時沒有找到原因，只出現一次；下一位如果再碰到，先看 `.run/` 裡 Dex 與後端的 log。

## 6. 留給下一位

- 別人範圍的文件仍寫著 `sgn_job`：`docs/contract/00-spine.md`、`docs/site/architecture.html`、之前的 handoff、`redteam/exploits/` 的註解（10、27、35、37、38、41、00-lib，只是註解，腳本已用四個角色）。
- K-PASSKEY-SUSPEND-HOLDER 與 K-GOVERNANCE-KEY 一樣沒有結案流程（coverage partial）。
- 通知對象的預設值（稽核主管、資安長、登記人）是參數，可依部署調整；當事人是唯一持有人時那個角色就沒有人收到（其他兩個角色仍收到）。
