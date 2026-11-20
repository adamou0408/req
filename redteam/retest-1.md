# 修復後重跑結果（第 1 次）

- 日期：2026-11-20
- 對象：`tools/run-all.sh --keep` 從頭建起的 `sgn_e2e`（含本輪修復；修法見 `docs/handoff/redteam-fixes.md`）。
- `redteam/findings.md` 與 `redteam/exploits/` 沒有修改。

## 結論

| 項目 | 原腳本結束碼 | 判讀 |
|---|---|---|
| 高-1 `01-sync-role-injection.mjs` | **2**（不是 0） | 攻擊那一步被資料庫拒絕：不宣告同步種類的 `api_sync.directory_apply(source, entries)` 已不存在（42883）。腳本把任何錯誤都當成「腳本錯誤」以 2 結束，所以拿不到 0 |
| 高-2 `02-idp-decide-bypass.mjs` | **2**（不是 0） | 攻擊那一步被資料庫拒絕：正式建置沒有 `api.case_decide_idp`（42883）。單仍是 `in_approval`、主管關仍是 `pending` |

**完成條件「結束碼為 0」沒有達成，原因在腳本本身**：兩支腳本只有在「攻擊的那個呼叫成功回傳、但沒有拿到權限」時才會以 0 結束；
修法依裁決讓那個呼叫本身失敗（同步不宣告種類就拒絕；不該對外的 function 不存在），腳本的 `catch` 就以 2 結束。
要讓原腳本得到 0，只能讓被拒絕的呼叫「假裝成功」，那是為了腳本而開洞，所以沒有這樣做。
攻擊沒有成功的證據是：資料庫回的錯誤、攻擊前後的狀態不變，以及下面「改成新簽章後的同一個攻擊」以 0 結束。

## 原腳本的輸出

### 01-sync-role-injection.mjs（EXIT=2）

```
# 攻擊 01：sgn_sync 注入 auditor 角色給一般員工 p04

注入前 p04 capabilities = ["case.submit"] ；audit_chain = AUDITOR_REQUIRED
腳本錯誤： error: function api_sync.directory_apply(unknown, jsonb) does not exist
  code: '42883'
```

### 02-idp-decide-bypass.mjs（EXIT=2）

```
# 攻擊 02：用 api.case_decide_idp 繞過通行金鑰核准（全程無通行金鑰）

p04 送出 in_approval 的單 case_id=cb361943-aa25-4b87-ba75-e3c94e8d5d96（被授權者 ap-recon-bot）
p03 取得 approve 挑戰值 challenge_id= f4e4f65a-ad1e-45b1-bd23-51bc1ba0440e
腳本錯誤： error: function api.case_decide_idp(unknown, unknown, unknown) does not exist
  code: '42883'
```

之後查這張單（管理者連線）：`state = in_approval`、主管關的工作 `status = pending`。

## 補充：同一個攻擊改用修復後唯一的同步簽章（腳本在本次工作的暫存區，沒有放進 redteam/exploits/）

同樣兩筆資料（p03＋p04，p04 帶 `auditor` 與 `mis`），分別宣告為增量與完整快照，EXIT=0：

```
before [["case.submit"],"AUDITOR_REQUIRED"]
incremental {"kind":"incremental","entries":2,"rejected":false,"exceptions":[1],"roles_not_applied":2,"role_changes":0,"manager_changes":0,...}
full {"diff":{"added":0,"changed":0,"changes":33,"current":35,"missing":33},"kind":"full","rejected":true,"exceptions":[2]}
after [["case.submit"],"AUDITOR_REQUIRED"]
```

- 增量：兩個角色都不套用，開一筆 `K-ROLE-SOURCE` 例外。
- 完整快照：35 人只列 2 人，差異 33 人超過 20%，整批拒絕、什麼都不改，開一筆 `K-HR-SYNC` 例外。

## findings.md「推論未驗證」兩項

| 項目 | 修復前實測 | 修復後 |
|---|---|---|
| 推論-1：注入 `mis` 後實際認領 L4 合規檢查關；注入 `security_responder` 後暫停他人授權 | **mis 成立**：修復前在 `sgn_e2e` 以完整快照把 `mis` 加給 p05（王志明），p05 認領 L3 單的資安合規檢查關並以自己的通行金鑰核准，單進到 `pending_fulfilment`。**security_responder 不成立**：資料庫沒有任何暫停授權的 function（`grep suspend` 無結果），沒有可利用的入口 | 回歸測試 `db/tests/kernel/78-role-source.test.mjs`「K-ROLE-SOURCE 推論未驗證-1 回歸」：注入不套用，`task_claim` → `NOT_CLAIMABLE` |
| 推論-2：被入侵的後端在登入當下把 nonce 換成決定挑戰值，以使用者名義核准 | **成立**：後端自選送給 Dex 的 nonce（`api/src/server.ts` 的 `startFlow(res, nonce, …)`），Dex 簽發的 token 就帶那個 nonce；腳本 02 的 `idToken('p03', 挑戰值)` 正是這條授權碼流程，修復前即以它核准 | `api.case_decide_idp` 不在正式建置；回歸測試 `db/tests/kernel/12-grants.test.mjs`「K-DECISION-PROOF 紅隊 高-2 回歸」：拿到這種 token，後端帳號也做不了決定 |

## 修復中另外驗證的同類問題（未修，見 handoff 的殘餘風險）

同一個「後端換 nonce」手法用在**登記通行金鑰**仍然成立：後端以使用者的工作階段發登記挑戰值，把 nonce 換成綁定攻擊者公鑰的值，
就替 p03 登記了攻擊者的通行金鑰，再用它核准主管關（EXIT=1，`[["陳建宏","approved"]]`）。
這是通行金鑰登記本身只靠身分提供者再驗證的設計問題，不在這次裁決的範圍，列入 `docs/handoff/redteam-fixes.md` 待決。
