# 紅隊報告：稽核級簽核平台（sgn）

- 日期：2026-11-20
- 範圍：白箱，`/home/user/req`；實測對象為 `tools/run-all.sh --keep` 建起的 `sgn_e2e`（後端 http://localhost:3000、Dex 5556、LDAP 3890）。
- 原則：只列「實際重現成功」的弱點，每個附可重跑腳本（`redteam/exploits/`，非 0 結束碼＝弱點存在）。推論但未驗證的另列並標示。
- 對照基準：`docs/00-direction.md` 的五個槓桿與「目前的賭注」、`docs/contract/00-spine.md` 第 5 節核心規則。

## 嚴重度統計

| 嚴重度 | 數量 |
|---|---|
| 重大 | 0 |
| 高 | 2 |
| 中 | 1 |
| 低 | 0 |
| 推論未驗證 | 2 |

---

## 高-1：同步帳號（sgn_sync）可即時把任何角色指派給任何人（K-ROLE-SOURCE、K-AUDITOR-INDEPENDENT 完全失效）

- 攻擊者起點：C（只拿到 `sgn_sync` 連線字串；不需要任何人的通行金鑰或密碼）。影響擴大需受害帳號正常登入一次。
- 重現腳本：`redteam/exploits/01-sync-role-injection.mjs`（已跑，EXIT=1）。

### 能做到什麼（對照承諾）

`api_sync.directory_apply(source, entries)` 的每個 `entries[].roles` 會原封不動寫進 `sgn.role_assignment`，由 `sgn_internal.directory_set_source_roles`（`db/kernel/130_principal_grant.sql:19`）插入，`valid_to = null`（立即生效），**沒有角色類別過濾、沒有核准、沒有冷卻期、不開例外**。

這直接違反 K-ROLE-SOURCE（平台管理類角色只能 `manual`；`sync_proposed` 只能提議、平台內核准後生效）與 K-AUDITOR-INDEPENDENT（稽核角色須稽核主管提出、`audit_governor` 核准）。

示範：把 `auditor` 塞給一般分析師 p04（林怡君）。注入後 p04 用自己的工作階段就通過 `api.audit_chain`／`audit_case`／`audit_exceptions` 的 `authorize(..., 'audit.read')`，讀到整條雜湊鏈與每一張單的內容與決定證明。這同時打穿槓桿 1（決定可問責）與槓桿 3（紀錄改不掉）所依賴的「稽核獨立」。

角色無範圍（`scope_ref = null`），可注入的是不依範圍的角色：`auditor`、`audit_head`、`ciso`、`compliance_officer`、`security_responder`、`mis`、`key_custodian`、`tech_ops` 等。注入 `mis` 可認領 L4 單的資安合規檢查關；注入 `security_responder` 可暫停他人授權。依範圍的 `data_owner` 因注入時 `scope_ref` 為 null，不會被特定範圍解析（恰好擋下，非刻意設計）。

### 重現步驟

```bash
tools/run-all.sh --keep
SGN_DATABASE=sgn_e2e node redteam/exploits/01-sync-role-injection.mjs
```

關鍵輸出：

```
注入前 p04 capabilities = ["case.submit"] ；audit_chain = AUDITOR_REQUIRED
sgn_sync directory_apply 回傳： {"entries":2,"baseline":false,"manager_changes":0}
注入後 p04 capabilities = ["case.submit","audit"] ；audit_chain 事件數 = 5
```

亦可 psql（`PGPASSWORD=dev-pass-sgn_sync`）呼叫 `api_sync.directory_apply('sim-ldap','[{"external_id":"p04",...,"roles":["auditor"]}]')` 重現。

### 建議修法

- `directory_set_source_roles` 不得寫入平台／控制／治理類角色；同步只能「提議」符合 `sync_proposed` 的業務角色，平台內核准後才生效。
- 稽核與控制角色一律 `manual`；任何同步路徑要擋下並開例外。
- 架構測試：`api_sync` 無法賦予 `role.category in (platform, control, governance)` 的角色。

---

## 高-2：合約宣告「刻意不開路由」的 `api.case_decide_idp` 其實可由 sgn_app 直接執行——通行金鑰要求可被繞過

- 攻擊者起點：C（`sgn_app` 連線＝後端身分）＋能取得簽核人的 SSO 斷言。最嚴重情境：被入侵／惡意的後端本身。
- 重現腳本：`redteam/exploits/02-idp-decide-bypass.mjs`（已跑，EXIT=1）。

### 能做到什麼（對照承諾）

`packages/contract/src/routes.ts` 的 `notExposed` 明文：`case_decide_idp` =「身分提供者再驗證的決定等於只靠密碼（Dex 不帶 amr）；只有資料庫測試使用，畫面一律走通行金鑰」。整個決定模型（賭注 1、槓桿 1）靠通行金鑰（硬體、防釣魚、裝置綁定）。

但 `db/kernel/90_grants.sql:10` 把 `api` schema 的**全部** function 授權給 `sgn_app`。於是這個「刻意不可達」function，任何持有後端連線者都能直接呼叫。實測：

- HTTP `POST /api/case_decide_idp` → 404（後端未註冊路由，控制看似生效）。
- `sgn_app` 連線 `select api.case_decide_idp(...)` → 直接進入決定邏輯（回 `CHALLENGE_UNKNOWN`，非權限錯誤）。

腳本 02 全程**不登記、不使用任何通行金鑰**，把 p04 送的單用 p03 的 IdP token 核准：p03 的主管關被標 `approved`，決定證明種類 `idp_stepup`。即「決定必須有通行金鑰」不是由資料庫強制，只是畫面剛好不走這條。

為什麼是高：
1. 通行金鑰的核心價值是「偷到工作階段或重做 SSO 都不足以核准，必須有登記過的裝置」。`case_decide_idp` 把決定所需證明降級為「能完成受害者 SSO 一次」——密碼／OTP 型 IdP 下即可釣魚。
2. 直接反駁賭注「拿到後端帳號也無法冒用」：後端在每次登入／登記通行金鑰時自選 `nonce` 向 Dex 換 token。被入侵的後端可在使用者以為只是登入的當下，改送 `nonce = 某張單的決定挑戰值`，拿到的 token 餵 `case_decide_idp`，以該使用者名義核准，全程無通行金鑰。通行金鑰路徑能擋下（後端造不出 WebAuthn 簽章），此 function 可達就打開了這個洞。

限制（誠實標註）：仍需簽核人一個 `nonce = 決定挑戰值` 的 IdP token。sim 共用密碼使示範容易；唯一密碼的 IdP 下需釣到或在登入時刻劫持該簽核人 SSO——而這正是通行金鑰設計要排除、且此 function 重新打開並開給威脅模型最不信任對象的攻擊面。

### 重現步驟

```bash
SGN_DATABASE=sgn_e2e node redteam/exploits/02-idp-decide-bypass.mjs
```

關鍵輸出：主管關 `approved`、證明 `idp_stepup`、全程無通行金鑰。

### 建議修法

- 最小修法：`revoke execute on function api.case_decide_idp(...) from sgn_app`，把「不開放」從「後端不註冊路由」提升到資料庫層。加架構測試：路由表以外的 `api` function 一律不得被連線角色 EXECUTE（讓 `notExposed` 有牙齒）。
- 根本修法：決定類 function 一律要求 `decision_proof.kind = passkey`（或達動作目錄要求的憑證強度），不接受 `idp_stepup`；若保留 step-up，Dex 不帶 `amr` 時直接拒絕。

---

## 中-1：directory_apply 全快照語意具破壞性，且同步帳號可任意改寫在職狀態、email、主管

- 攻擊者起點：C（`sgn_sync`）。狀態：行為已實測觀察，未獨立成腳本。

`api_sync.directory_apply` 是全快照語意，但只處理傳入 entries：

- 傳入某人、但其 `manager_external_id` 不在同批 entries 時，解析成 null，`directory_set_manager` 會**把該人主管關係設為 null（移除）**。實測：只傳 p04（manager=p03 但 p03 不在批內）→ 回傳 `manager_changes: 1`，p04 主管被清空。一次部分快照即可悄悄拆掉主管線，造成送審解析不到人（`halted`）、流程卡死（目標 9）。
- `active`、`display_name`、`email` 由同步直接覆寫。`active:false` 讓該人工作階段立即失效（`session_person` 要求 `p.active`）並退出解析——可癱瘓特定簽核人或讓單一持有人控制角色出缺（K-ROLE-CONTINUITY）。`email` 可被改寫，違反 K-NAMED-ACCOUNT「平台內不提供修改通知信箱」的精神，並影響通行金鑰登記的本人通知。

建議：落實 K-HR-SYNC 的「差異＋門檻＋套用＋暫存」四段；欄位增減或超門檻即暫停待人工確認；`active`→false 不即時套用；主管設 null 必須是明確移除意圖，而非「不在批內」。

---

## 試過但擋得住（重點）

- **sgn_app 直接讀資料表**：`select from sgn.person / sgn.audit_event` → `permission denied for schema sgn`。`90_grants.sql` 只給 `api` 的 USAGE/EXECUTE，資料表零權限。賭注「拿到後端帳號也無法冒用」在讀取面成立。
- **級別偽裝（L4→L3）**：`classify_tier` 看的是 `normalize_content` 從目錄重建的欄位分級，攻擊者送的 `classification` 被覆寫；`version_prepare` 一律重整＋分級，`approve_reduced` 同路徑。
- **把擴大偽裝成縮小**：`compare_content`／`package_change`／`filters_within`／`filters_relation` 在無法證明子集時一律落 `expand`（移除列條件、放寬區間、換主題包、分級變動、purpose 改動、export false→true 皆 expand）。未找到繞法。
- **規避重疊檢查**：`grant_covers`／`find_overlaps` 無法證明涵蓋時落 partial（要理由），多筆合併一律 partial；完全涵蓋才擋。保守，未找到繞法。
- **核准自己的單／跳關／簽別人該簽的關**：`denial_reason`（160）的 assignee 需 `person_open_task` 命中、非申請人、`decider_denial` 再驗 SoD；`decision_commit` 另檢 `actor = challenge.person`。繞不過。
- **跨關同一人（K-SOD-DISTINCT）**：`decider_denial` 以自然人檢查其他關卡的 pending/approved/completed，撞到即 `SOD_DISTINCT`，沿主管線往上。
- **挑戰值重放／拿別人的挑戰值簽**：`challenge_consume` 一次性＋鎖定；`decision_prepare` 檢版本雜湊（`CONTENT_CHANGED`）；commit 要求 actor＝challenge.person。
- **看別人的單（IDOR）**：`case_get` 要 read＝case_party，否則 `CASE_UNKNOWN`；稽核端點一律要 `auditor`。
- **CSRF**：`/api/*` 只收 POST＋`application/json`，session cookie `SameSite=Strict`、`HttpOnly`；無改狀態的 GET。
- **同步注入主管後立即核准**：`resolve_manager` 冷卻期（預設 1 營業日）讓剛同步的 `sync_change` 關係暫不生效，送審開 PRB-SYNC-GUARD＋K-DETECT-MANAGER-FLIP 例外。即時利用被擋（但高-1 的角色注入沒有這層冷卻）。

## 未驗證（推論）或沒時間做

- **推論未驗證-1**：高-1 注入 `mis`／`security_responder` 後實際認領 L4 合規檢查關或暫停他人授權的完整鏈，未逐一成腳本（只驗 `auditor` 讀取）。機制上應成立。
- **推論未驗證-2**：高-2 的「後端在登入當下劫持 nonce 以其名義核准」只邏輯論證，未成端對端腳本；核准可行性本身已由腳本 02 證明。
- **沒做到**：WebAuthn/ES256 驗證器模糊測試與邊界（計數器回捲、flags、origin/rpId）；`sgn_job`（`api_job.*`）深入攻擊面；`web/` 前端 XSS／開放重導向／path traversal 動態測試（只讀碼，`serveStatic` 有 `..` 檢查、CSP `default-src 'self'`）；併發競態壓測（同時兩決定、核准與撤回、修改與核准）；JP 子公司跨公司路徑；速率限制（`MAX_BODY_BYTES` 256KB 有，無 rate limit）；雜湊鏈最後錨定後的竄改缺口（direction 已自承）；`npm audit`／Trivy 此輪未重跑。
