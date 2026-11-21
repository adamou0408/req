# 交接：紅隊確認的弱點修復（redteam-fixes）

> **本檔寫於 2026-11-20，以下已過時：§0 的測試數字（141 個資料庫測試）；§ 殘餘風險與未做的項目（後續由 `redteam-fixes-2.md` 起各輪處理）。仍有效：第一輪攻擊（`redteam/findings.md`）的修復紀錄與威脅表仍有效。各輪的對照見 `README.md`（本目錄）。**

日期：2026-11-20。依據：`redteam/findings.md`、主代理的裁決。範圍：`db/`、`packages/contract/`、`web/`、`e2e/`、根目錄的 ESLint／Prettier 設定、本文件、`redteam/retest-1.md`（只新增）。`api/` 不需要改（路由依路由表註冊）。
本文分清楚：**跑過且通過**、**寫了但沒跑**、**沒做到**。

## 0. 結果一覽

| 項目 | 結果 |
|---|---|
| `tools/check.sh`（全部 10 段） | **從乾淨狀態跑過且通過**（§7） |
| 資料庫測試 | **141／141**（上一輪 122；新增 19，既有測試沒有刪除或放寬，調整見 §5） |
| 通行金鑰 Node 對照組 | 16／16（沒動） |
| 端對端 | **13／13**（新增 1：角色指派頁） |
| plpgsql_check | 沒有問題（142 個 PL/pgSQL function） |
| 新的 19 個回歸測試在**修復前**的程式上 | **跑過，19 個全部失敗**（§6）：把新測試複製到 `git archive HEAD` 的樹上建置後執行 |
| 兩支原攻擊腳本重跑 | **結束碼 2，不是 0**：攻擊的呼叫被資料庫拒絕，腳本把錯誤當「腳本錯誤」。見 `redteam/retest-1.md` |

**沒有照「先寫會失敗的測試再修」的順序做**：測試和修法同時寫，事後才在修復前的程式上驗證新測試會失敗（§6）。

## 1. 高-1：同步帳號可以把任何角色立即指派給任何人

**根因**：資料庫不知道「角色」是什麼。人員同步把目錄群組名稱原封不動寫成 `role_assignment`、立即生效，分不出業務角色與稽核、資安這類控制角色，也就沒有地方限制誰能指派。

**修法**

| 檔案 | 內容 |
|---|---|
| `db/kernel/210_role_registry.sql` | `sgn.role`：類別（business／control／platform／governance）、指派來源政策（`manual`／`sync_proposed`，檢查條件強制「非 business 一律 manual」）、提出人角色、核准人角色、不得經手的角色。核心登記 17 個控制／平台／治理角色。`role_assignment` 加 `effective_from`（之後才算數）與 `change_event_seq`；「現在算不算數」只有一個判斷 `role_assignment_active`，`has_role`、`role_holders` 改用它。`sgn_sdk.register_role` 給流程包用 |
| `db/packs/data_access/060_roles.sql` | 資料擁有者登記為業務類、`sync_proposed` |
| `db/kernel/220_role_change.sql` | 平台內的角色指派變更：`role_change_options`／`list`／`propose`／`challenge`／`approve_passkey`。授權在 `denial_reason` 的角色變更版本（同名、第三個參數型別不同）：提出人要持有該角色的提出人角色；核准人要持有核准人角色、不是提出人也不是被指派的人、不持有 `approval.excluded_decider_roles`；兩者都不得持有「不得經手的角色」。核准以通行金鑰（`webauthn_verify`，挑戰值只能由發給的人使用），證明存進 `decision_proof`，提出與核准各一筆事件進鏈 |
| `db/kernel/230_directory_sync.sql` | 同步只對業務類角色套用；基準之後的增減有冷卻期（`directory.sync_cooling_workdays`，預設 1 營業日）：新增要過冷卻期才算，移除排在冷卻期之後（期間內原持有人仍算），每筆進鏈並開 `K-ROLE-SOURCE` 例外。控制類角色一律不套用，只記在 `sgn.directory_role_claim`；基準之後新出現的說法開 `K-ROLE-SOURCE` 例外。沒登記的群組名稱忽略並回報 |
| `db/seed/kernel/005_bootstrap_roles.sql` | 只在開發與驗收：把基準同步記下的控制類說法當成期初的平台內指派（正式環境要走導入時的設定變更） |
| `web/pages/roles.js`（＋`app.js`、`pages/home.js`、`i18n.js`） | 簡單的角色指派頁：清單、提出表單、用通行金鑰核准。首頁依 `capabilities` 的 `role_change` 顯示入口 |

稽核角色（`auditor`、`audit_head`）：提出人 `audit_head`、核准人 `audit_governor`、不得經手 `tech_ops`。「受查範圍內的技術維運」這一版做成「持有 `tech_ops` 就不行」（沒有範圍）。

**測試**（`db/tests/kernel/78-role-source.test.mjs`）：攻擊腳本 01 的回歸（舊簽章不存在、宣告成增量也不套用並開例外、宣告成完整快照整批拒絕）；推論-1 的回歸（注入 `mis` 認領不到）；業務角色的冷卻期；控制角色的提出與核准（不能提出、自己不能核准、被指派的人不能核准、拿別人的通行金鑰簽被擋、已核准不能再核准、撤除、鏈驗得過）；`K-AUDITOR-INDEPENDENT`（只有稽核主管能提出、只有治理人能核准、技術維運就算持有兩個角色也不能經手）。端對端 `e2e/tests/path.test.mjs`「K-ROLE-SOURCE 稽核角色只能在平台內指派」。契約測試實際呼叫新路由並檢查結構。

## 2. 高-2：不該對外的函式被整組授權給後端帳號

**根因**：「刻意不開放」只寫在路由表（後端不註冊路由），資料庫端卻是 `grant execute on all functions in schema api`，而且 PostgreSQL 新建的 function 預設 PUBLIC 可執行。權限與路由表是兩份資料。

**修法**

| 檔案 | 內容 |
|---|---|
| `db/tools/grants-sql.mjs`（`db/build.sh` 的最後一步） | 權限的唯一來源是路由表：先撤掉所有非系統 schema 的 function 對 PUBLIC 與三個執行期帳號的 EXECUTE，再逐一列名授權。`sgn_app`＝`routes`＋`packRoutes`＋`backendCalls`；`sgn_sync`＝`syncCalls`；`sgn_job`＝`jobCalls`。列出的 function 不存在時建置失敗 |
| `packages/contract/src/routes.ts` | 新增 `syncCalls`、`jobCalls`、角色變更的 5 個路由；刪除 `notExposed`（不開放的就不在正式建置裡） |
| `db/build.sh` | 建庫時 `alter default privileges for role sgn_owner revoke execute on functions from public` |
| `db/kernel/240_decision_proof_only_passkey.sql` | 刪除 `api.case_decide_idp`；參數 `decision.allowed_proof_kinds`（預設只有 `passkey`），`decision_proof` 寫入時以觸發器檢查——之後就算又多一條證明路徑，正式環境也存不進去；已建好的環境也撤掉預設權限 |
| `db/testing/70_idp_decide.sql` | 比較用的 (b) 改放 `api_verified.case_decide_idp`，只有 `sgn_test_verifier` 能執行，只在 `sgn_test` 放寬允許的證明種類 |

**測試**（`db/tests/kernel/12-grants.test.mjs`，同時檢查 `sgn_test` 與正式建置的 `sgn_e2e`）：三個帳號能執行的 function 與允許清單**完全相等**；正式建置沒有清單外的 api function、呼叫 `decision_commit` 的只有 `case_decide_passkey`；PUBLIC 不能執行任何非系統 function，owner 新建的 function 預設也不對任何執行期帳號開放（在交易裡真的建一個再檢查）；攻擊腳本 02 與推論-2 的回歸；正式建置存非通行金鑰的證明被擋。契約測試另檢查 `syncCalls`、`jobCalls` 的參數與「schema 裡沒有清單外的 function」。

## 3. 中：部分快照清空資料；同步帳號可任意改 active、email、主管

**根因**：宣稱完整快照，卻只處理傳入的人；主管只在同一批找，找不到就當「沒有主管」；在職狀態與 email 直接覆寫、不留紀錄。

**修法**（`db/kernel/230_directory_sync.sql`）：新簽章 `api_sync.directory_apply(source, kind, total, entries)`，舊的兩參數版本刪除（不宣告就沒有可呼叫的 function）。

- `kind`：`full`（沒列到的人視為離職）或 `incremental`（只動有列到的人）；其他值 `SYNC_KIND_REQUIRED`。`total` 必須等於筆數。第一次（基準）必須是 `full`。
- 欄位固定六個、不多不少、型別正確、外部帳號不重複，否則 `DIRECTORY_ENTRY_INVALID`。
- 完整快照與現況不同的人數超過 `directory.full_snapshot_max_change_percent`（預設 20%）：整批拒絕、什麼都不改，開 `K-HR-SYNC` 例外並寫 `directory.sync_rejected`。
- 主管依身分對應找（同一批 → 已同步過的人）；只有明寫 `null` 才移除；對不到 `DIRECTORY_MANAGER_UNKNOWN`。
- 改姓名、email：`directory.person_changed`（舊值、新值）。停用：`directory.person_deactivated`；恢復：`directory.person_reactivated`。
- 一次停用超過 `directory.bulk_deactivation_max`（預設 1）人、或停用持有控制類角色的人：延後到冷卻期之後（`sgn.person_deactivation`），開 `K-HR-SYNC` 例外，期間內仍在職；目錄又說在職就取消；到期由下一次同步或排程 `api_job.directory_settle` 套用。
- 每次同步的 `directory.synced` 事件記下這次用到的三個參數值。
- `db/tools/directory-sync.mjs` 改為宣告 `full` 並帶總筆數。

**測試**（`db/tests/kernel/79-directory-sync.test.mjs`，8 個）：不宣告／總筆數不符／欄位不對／主管對不到；部分的完整快照整批拒絕；增量只動列到的人、明寫 null 才移除主管；email 進鏈；單人停用立即生效並使工作階段失效；持有控制角色者延後、排程到期才套用；多人停用延後、取消；完整快照門檻內沒列到的人停用。

## 4. 推論未驗證的兩項

見 `redteam/retest-1.md`。推論-1：`mis` 部分修復前**成立**（實測認領並核准），`security_responder` 部分**不成立**（沒有暫停授權的 function）。推論-2：**成立**（後端自選 nonce），由高-2 的修法擋下。

## 5. 既有測試的調整（逐項原因）

| 測試 | 調整 | 原因 |
|---|---|---|
| `40-proof-idp` | `decideIdp(app, …)` → `decideStepUp(verifier, …)`，斷言不變 | (b) 不在後端帳號的路徑上 |
| `70-business` K-DECISION-PROOF | 呼叫 `decision_commit` 的清單從 `[case_decide_idp, case_decide_passkey]` 收緊為 `[case_decide_passkey]` | 同上（收緊，不是放寬） |
| `72-sync-guard` | 假快照改為宣告 `incremental` 與總筆數，斷言不變 | 新簽章；宣告成 `full` 會被門檻整批拒絕，攻擊就測不到原本要測的主管異動 |
| `10-roles` | 「後端呼叫同步被拒」改用新簽章 | 舊簽章不存在 |
| `90-contract` | 「沒有孤兒」不再接受 `notExposed`；授權錯誤代碼清單加上 5 個角色變更代碼；結構檢查涵蓋 5 個新路由；新增 sync／job 清單的契約測試 | `notExposed` 刪除；授權單一入口的檢查範圍擴大 |
| `db/bench/verify-bench.mjs` | 同 40 | 同上（沒有跑） |

## 6. 修復前的程式上跑新測試

把 12、78、79 三個測試檔與 `harness.mjs`、`grants-sql.mjs`、`routes.ts` 複製到 `git archive HEAD` 解開的樹，建置後執行：19 個全部失敗。有意義的失敗：允許清單不相等（多了 `case_decide_idp` 等）、PUBLIC 與執行期帳號對新建 function 有預設權限、`decideIdp` 沒有被拒（Missing expected rejection）、舊的兩參數同步沒有被拒。其餘因為新簽章、新表不存在而失敗。另以修復前的程式實測中-1：兩人的「快照」讓 p04、p06 的主管被清空、p04 的 email 被改、p06 被停用，鏈上只有主管異動。

## 7. 怎麼執行

```bash
tools/check.sh                      # 全部
db/build.sh                         # 建庫＋資料庫測試
tools/run-all.sh --keep             # 讓後端繼續跑，再重跑攻擊腳本：
SGN_DATABASE=sgn_e2e node redteam/exploits/01-sync-role-injection.mjs
SGN_DATABASE=sgn_e2e node redteam/exploits/02-idp-decide-bypass.mjs
```

從乾淨狀態（刪 `node_modules/`、`.run/`，`sim/down.sh`）執行 `tools/check.sh` 的結果記在本節最後一行。

## 8. 和契約、骨幹、裁決不同的地方

| 項目 | 依據 | 現在 | 理由 |
|---|---|---|---|
| 資料擁有者的類別 | `docs/contract/seed-directory.md` 寫 `control` | `business` | 裁決明示「業務類的角色（例如資料擁有者）可由同步帶入」。要改回只需改 `060_roles.sql` 的一筆資料（之後新增 migration） |
| 業務角色被同步移除 | 骨幹 K-ROLE-SOURCE：`sync_proposed`「移除立即生效」 | 移除也有冷卻期（期間內原持有人仍算） | 裁決「冷卻期內維持原持有人」，比照主管關係；請決定以哪個為準 |
| 原攻擊腳本結束碼 | 完成條件：0 | 2 | 見 `redteam/retest-1.md`：裁決讓攻擊的呼叫本身失敗 |
| `cfo`、`legal`、`seal_keeper` 等業務角色與 `*_deputy`、`角色:範圍` 群組 | 種子目錄有這些群組 | 沒有登記，同步時忽略並回報 | 資料庫沒有任何地方用到；要用時由流程包登記 |
| 角色指派的期初基準 | 骨幹第 18 節：導入時的設定變更 | 開發環境由種子把基準同步的說法直接當成指派 | 設定變更流程不在範圍 |
| `90_grants.sql` | 已套用的 migration 不改 | 沒改；由產生的允許清單在它之後收斂 | 只能新增 |
| 規則 `K-ROLE-SOURCE` | 骨幹 | 新登記，coverage＝partial | 範圍比對、K-ADMIN-SOD、駁回／撤回沒做 |

工程規範的例外（逐項寫在設定檔）：`.prettierignore`、`eslint.config.js` 排除 `redteam/exploits/`——紅隊證據不得修改，而它們本身不符合格式與 lint（原本就讓 `tools/check.sh` 失敗）。

## 9. 殘餘風險

- **後端換 nonce 登記通行金鑰（已實測成立，未修）**：被入侵的後端持有使用者的工作階段，發登記挑戰值後在使用者下次登入時把 nonce 換成「綁定攻擊者公鑰」的值，就能替他登記攻擊者的通行金鑰，再以他的名義核准。與高-2 同類（決定的根基最後仍是一次身分提供者的再驗證）。可能的修法：新金鑰有冷卻期才能做決定並通知本人、已有金鑰時要用舊金鑰核准新金鑰。需要裁決。
- 角色變更：提出與核准不比對範圍（`process_admin` 任一範圍就能提出任何非稽核角色）、沒有職責衝突矩陣檢查（例如技術維運被指派稽核角色本身沒有擋）、沒有駁回／撤回／到期，待核准的單會一直留著。
- 被同步「恢復在職」、改姓名、改 email 立即生效（有紀錄，沒有冷卻期）。姓名可被改成別人的名字誤導簽核人。
- 延後的停用要靠同步或排程 `api_job.directory_settle` 套用；目前沒有接上排程器，沒有同步時不會到期生效。
- 冷卻期與門檻只對「同步帳號」有效；資料庫最高權限者仍可直接改表（只能事後由鏈偵測，`docs/00-direction.md` 已自承）。
- 目錄對控制類角色的說法「消失」（例如某人被移出稽核群組）不會開例外，平台內的指派也不會跟著撤除。
- 完整快照的差異只算人員欄位與主管，不算角色。

## 10. 另外發現的同類問題

| 問題 | 可達性 | 處理 |
|---|---|---|
| 後端換 nonce 登記通行金鑰 | `sgn_app` | 實測成立，未修（§9） |
| `sgn_internal.sync_scoped_role_assignments`／`sgn_sdk` 版本：任何角色立即生效、不看類別、沒有冷卻 | 只有 owner（migration、種子、流程包的 `catalog_load`）；執行期帳號都執行不到（12-grants 測試保證） | 未改；目錄同步的對外入口做出來時要套用同樣的類別與冷卻規則 |
| `sgn_sdk`、`pack_*` schema 的 function 原本對 PUBLIC 開放（只是沒有 schema USAGE 擋著） | 無 | 已由允許清單步驟撤掉 |
| 已撤除的舊同步入口刪掉了沒人用的 `directory_upsert_person`、`directory_set_source_roles` | — | 已刪 |
| 設計文件 `docs/api.md`、`docs/sql-functions.md` 等仍提到 `case_decide_idp`、兩參數的 `directory_apply` | 文件 | 不在我的範圍，沒有改 |

## 11. 留給下一位

- 裁決 §8 的兩項（資料擁有者類別、業務角色移除是否立即）與 §9 的通行金鑰登記。
- 排程器呼叫 `api_job.directory_settle`；角色變更的駁回、撤回、範圍、衝突矩陣。
- 更新 `docs/contract/` 的同步介面與角色登記段落。

**從乾淨狀態執行（2026-11-20）**：`kill` 後端與錨定程式、`sim/down.sh`、`rm -rf node_modules .run`，再 `tools/check.sh` → 10 段全部通過（`全部通過`，exit 0）；資料庫 141／141、通行金鑰對照組 16／16、端對端 13／13，共 170。
