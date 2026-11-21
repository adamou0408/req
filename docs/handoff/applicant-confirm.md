# 交接：申請人確認驗證結果、逾期自動撤銷、生效後縮小的畫面入口（applicant-confirm）

> **本檔寫於 2026-11-20，以下已過時：§0 與 §7 的測試數字；§「留給下一位」中的畫面項目（後續批次已調整首頁與單的頁面）。仍有效：申請人確認驗證結果、逾期自動撤銷、`K-CONFIRM-*` 的機制仍是現況（取代 `delivery.md` 的「沒做」）。**

日期：2026-11-20。依據：`docs/packs/data-access/rules.md`（「驗證中」「申請人逾期沒有確認驗證結果，自動撤銷」「驗證結果確認時限 5 個工作天」「撤銷」「修改、退回與撤銷」）、
裁決 D80 (4)、D81、D82、骨幹 `docs/contract/00-spine.md` §2（`case_confirmation`）、§3（`requires_confirmation`、`confirmation_parties`）、§4.1、§5.5（`K-CONFIRM`）、§8（`confirmation.due_workdays`）、附錄 B、
`docs/handoff/delivery.md`、`docs/handoff/redteam-fixes-4.md`、`docs/ux-acceptance.md`（T7）。
範圍：`db/`、`api/`（沒有改）、`web/`、`e2e/`、`packages/contract/`、`tools/`（沒有改）、本文件。沒有改 `redteam/`、`sim/`、`rules.md` 與其他文件；沒有 commit、沒有 push。

## 0. 結果一覽

| 項目 | 結果 | 測試（拿掉防法就失敗的見 §1） |
|---|---|---|
| 自動驗證全部通過不直接生效，開「等申請人確認」（時限是參數、開的時候算好、記進鏈並通知申請人） | 做了 | `55` K-CONFIRM #1；`50` K-DELIVERY-AUTO（改：確認前沒有授權）|
| 只有申請人本人能確認；代填時也是申請人（負責人不能） | 做了 | `55` K-CONFIRM #1（主管、資料擁有者、MIS）、#2（代填）|
| 確認後才結案生效（產生授權）；紀錄寫明是誰確認 | 做了 | `55` K-CONFIRM #1；e2e K-DELIVERY-AUTO K-CONFIRM |
| 自動驗證還沒全部通過時不能確認、回報、撤銷；驗證不一致的單不開確認 | 做了 | `55` K-CONFIRM #3 |
| 申請人回報「不對」→ 不生效、撤回已送出的、開例外、通知（升級對象、申請人、負責人）；要原因 | 做了 | `55` K-CONFIRM-DISPUTE；e2e K-CONFIRM-DISPUTE（真的 sim/dc：權限消失）|
| 逾期沒確認 → 自動撤銷並撤回；逾期後不能再確認；事件寫明規則代碼、期限與用到的參數值 | 做了（逾期前提醒沒做，見 §6）| `55` K-CONFIRM-TIMEOUT ×2（排程、只有交付程式）；e2e K-CONFIRM-TIMEOUT（真的 sim/dc：權限消失）|
| 等確認時可以撤銷（縮小到零），確認作廢 | 做了 | `55` K-CONFIRM #4 |
| 狀態走轉移表；按鈕只依後端的可執行動作；通知走範本 | 做了 | `55` 全部斷言 `actions`；`70` K-DECISION-PROOF、`90` 架構（狀態入口清單）|
| 確認畫面：每個驗證案例的結果、剩餘工作天，390px 不水平捲動、觸控 44px、結果不用捲動就看得到 | 做了 | e2e K-DELIVERY-AUTO K-CONFIRM（版面、步數、結果在動作列之上）|
| T7 步數 | **3 步**（上限 3）| e2e 同上（實際量到 3 步，見 §3）|
| 生效後縮小的畫面入口（欄位、列條件、期限；判斷在資料庫） | 做了 | e2e K-GRANT-REDUCE（畫面縮小 → 重新驗證 → sim/dc 上那個欄位查不到；繞過畫面擴大被擋）|
| 生效後縮小的新一版內容指紋進鏈（原本漏記，稽核頁會誤判） | 做了（420 的缺陷，見 §4）| `50` K-GRANT-REDUCE（加斷言）；e2e `z-anchor-store` 第 1 個（原本就有的測試抓到的）|

`55`＝`db/tests/packs/data_access/55-confirmation.test.mjs`（新，7 個），`50`＝`db/tests/packs/data_access/50-delivery.test.mjs`，
`70`＝`db/tests/kernel/70-business.test.mjs`，`90`＝`db/tests/kernel/90-contract.test.mjs`，e2e＝`e2e/tests/system-delivery.test.mjs`（新 3 個、改 3 個）。

## 1. 威脅小表（動手前寫；每列對應「拿掉防法就失敗」的測試）

欄位：機制／誰送給誰／經過的不可信方／攻擊者可離線試幾次／當事人能否影響／防法／測試。B＝被入侵的後端（sgn_app，持有經過它的使用者工作階段）；
F＝被入侵的交付程式（sgn_delivery）；J＝排程帳號（sgn_job）。確認不是簽核決定：沒有通行金鑰，身分只來自資料庫驗過的工作階段。

| # | 機制 | 誰送給誰 | 不可信方 | 離線可試 | 當事人能否影響 | 防法 | 測試 |
|---|---|---|---|---|---|---|---|
| 1 | 確認、回報不對 | 申請人瀏覽器 → B → 資料庫 | B | 沒有密鑰可試（工作階段由資料庫發、驗） | 主管、資料擁有者、MIS、負責人想替申請人確認 | 動作目錄 `actor_rule = applicant`，判斷只在 `denial_reason`；身分由 `session_person` 得出 | `55` #1、#2（NOT_APPLICANT；按鈕不出現）。**拿掉防法**（改成 case_party）→ #1、#2 失敗（實測）|
| 2 | B 替申請人按「確認」 | B（用經過它的申請人工作階段）→ 資料庫 | B | — | 申請人事後才知道 | **未解（可接受，評估如下）** | `55` #1（`confirmation.confirmed` 記下確認人；`grant.activated` 觸發 `case.activated` 通知申請人）|
| 3 | 跳過自動驗證直接確認 | 申請人／B → 資料庫 | B | — | 申請人 | 驗證中但沒有 pending 的確認 → CONFIRMATION_NOT_OPEN（`denial_reason`）；確認只在執行關完成（每一筆套用的驗證都通過）時由 `case_advance` 開 | `55` #3。**拿掉防法** → #3 失敗（實測）|
| 4 | 畫面顯示假的「全部 ✓」讓申請人確認錯的結果 | B → 申請人瀏覽器（畫面的資料經 B） | B | — | 申請人看到的是 B 給的 | 確認只對「資料庫比對過、全部通過」的驗證開；驗證不一致的單不開確認，所以假畫面最多讓申請人確認一個本來就通過的結果。**未解**：B 可以把真的 ✗ 畫成 ✓——但那種單不會開確認（狀態已是 fulfilment_failed）| `55` #3（不一致 → 不開確認、確認被拒）|
| 5 | 逾期之後才確認 | 申請人／B → 資料庫 | B | — | 申請人 | 期限在開確認時算好存在資料庫；`denial_reason` 對 `due_at <= now()` 回 CONFIRMATION_OVERDUE，不靠排程有沒有跑 | `55` K-CONFIRM-TIMEOUT #1。**拿掉防法** → 失敗（實測）|
| 6 | 代填：誰確認 | 申請人（代填的人）→ 資料庫 | — | — | 被授權者負責人 | 骨幹附錄 B：資料授權的 `confirmation_parties` 只有申請人；負責人在第一關已確認代填（K-PRINCIPAL-OWNER-CONFIRM）| `55` #2 |
| 7 | 排程停擺，逾期的單權限一直在 | 資料庫（期限）→ 撤銷 | J 停擺（或被拿走而不跑） | — | — | 兩個入口：排程 `api_job.confirmation_expire_due` 與交付程式每一輪的領取（`delivery_claim` 先處理逾期）；任一個在跑就撤銷 | `55` K-CONFIRM-TIMEOUT #2（只有交付程式）。**拿掉防法**（領取不檢查）→ 失敗（實測）。**未解**：J 與 F 同時停擺時撤回延後（逾期後也不能確認，權限停在外部系統上直到其中一個恢復；交付卡住另有 K-DELIVERY-STUCK）|
| 8 | 時限參數 | MIS 系統管理員 → `sgn.setting_value` | — | — | — | 參數只增不改、有生效時間；開確認時把用到的值存在確認紀錄與事件；之後改參數不影響已開的確認 | `55` K-CONFIRM-TIMEOUT #1（2 個工作天的確認在參數改回 5 之後仍是 2；事件 settings）|
| 9 | 撤回（回報不對、逾期、撤銷）送到外部系統 | 資料庫 → F → 外部系統 | F、網路 | 簽章（Ed25519）不可偽造 | — | 既有的 outbox、簽章、證明、封存（D81）；送不到開 K-DELIVERY-STUCK | `55` DISPUTE、TIMEOUT（mock 上撤回）；e2e DISPUTE、TIMEOUT（sim/dc 上 `deny`、`withdrawn`）|
| 10 | 等確認期間外部系統上已經有權限 | 資料庫 → 外部系統（套用） | — | — | 申請人、被授權者 | **未解（設計）**：自動驗證要對真的權限查，所以套用必須先上去；平台的授權（grant）在確認後才產生，但被授權者在確認期間（最多 5 個工作天）技術上已經能查。逾期自動撤回、對帳把它當成「應該在」| e2e K-CONFIRM-TIMEOUT（等確認時 sim/dc 回 `allow`）|
| 11 | B 擋下申請人的確認或回報 | 申請人 → B | B | — | 申請人 | **未解（同 delivery.md #16）**：請求經過 B；擋下確認的結果是逾期自動撤銷（失效安全），擋下回報的結果是逾期撤銷或申請人之後撤銷 | — |
| 12 | B 替申請人按「結果不對」 | B → 資料庫 | B | — | — | **未解（可接受）**：只會讓授權不生效（縮小），同 delivery.md #15 的撤銷；開例外、通知升級對象與負責人 | `55` DISPUTE |

**#2 的評估（被入侵的後端替申請人按確認）**：確認不用通行金鑰（它不是簽核決定），所以 B 只要拿到申請人的工作階段（申請人登入期間經過 B 的 cookie）就能按。後果：

- 能得到的：這張單提早生效（產生 grant、`case.activated`），申請人失去「看過外部系統上的結果再說」的機會，也讓逾期自動撤銷不會發生。
- 得不到的：範圍不會變大——生效的是各關以通行金鑰核准、外部系統已套用、而且資料庫已比對「該查的查得到、不該查的查不到」全部通過的那一版；B 不能讓驗證不一致的單開確認（#3、#4），也不能確認別人的單（#1）。外部系統上的權限在確認前就已存在（#10），所以 B 按確認並沒有多給被授權者任何存取。
- 留下的證據：`confirmation.confirmed` 寫在鏈上（確認人、時間）；申請人收到「已生效」通知；申請人隨時可以撤銷。
- 結論：不加通行金鑰。若負責人裁決「確認要有不可否認的本人證據」，改法是把 `confirm_verification` 改成 `needs_proof = true`（決定證明的既有機制），T7 會多一步（通行金鑰）。列為待裁決 §5-3。

先失敗的測試（照實寫）：威脅表在動手前寫好，測試與程式一起寫，`55` 第一次跑就 7／7 通過，沒有逐列先看到失敗。之後做了一次「拿掉防法」的實測：
同時把確認者改成 `case_party`、拿掉 CONFIRMATION_NOT_OPEN 與 CONFIRMATION_OVERDUE 兩個條件、拿掉領取時的逾期檢查，`55` 7 個裡 5 個失敗（#1、#2、#3、TIMEOUT #1、TIMEOUT #2）；
還原後全過。#4、#12 沒有單獨的「拿掉」實驗（防法是 #3 的同一個條件、或本來就只會縮小）。

## 2. 做了什麼

### 資料庫

`db/kernel/470_case_confirmation.sql`（新，核心）：

- 狀態照骨幹 §4.1：`verifying` 是「驗證中或等確認」，**不另開狀態**；等確認由 `sgn.case_confirmation`（骨幹的 `case_confirmation`）的一筆 `pending` 表示（一張單同時最多一筆）。
- 轉移表：申請單 `verifying` → `active`（`confirm_verification`）、→ `fulfilment_failed`（`dispute_verification`）、→ `revoked`（`confirmation_expire`、`revoke`）；
  確認紀錄 `pending` → `confirmed`／`disputed`／`expired`／`cancelled`（entity `confirmation`）。
- 動作目錄：`confirm_verification`、`dispute_verification`（`applicant`，不需要證明）、`confirmation_expire`（system）。
- `denial_reason`（同簽章替換）：驗證中沒有 pending 的確認時，確認、回報、撤銷回 CONFIRMATION_NOT_OPEN；逾期不能確認（CONFIRMATION_OVERDUE），回報仍可。
- `case_advance`（同簽章替換）：執行關完成、狀態是 `verifying`、流程類型選了 `requires_confirmation` → `confirmation_open`（不轉移狀態、不產生授權）；否則照舊生效。人工執行的退路（`pending_fulfilment`）沒有自動驗證，照舊直接生效。
- `confirmation_open`：時限 `confirmation.due_workdays`（流程類型 → 全域 → 預設 5；`add_workdays`），存在紀錄的 `settings`，事件 `confirmation.opened`（`due_at`、通過的驗證輪、`settings`、規則 K-CONFIRM），通知範本 `confirmation.requested`。
- `api.case_confirm_verification`（K-CONFIRM）、`api.case_dispute_verification`（K-CONFIRM-DISPUTE：要原因、例外、撤回、人工系統通知、通知範本 `confirmation.disputed`）。
- `sgn_internal.confirmation_expire_due`＋`api_job.confirmation_expire_due`（K-CONFIRM-TIMEOUT：事件 `case.confirmation_expired` 帶 `due_at`、`settings`、規則；通知範本 `confirmation.expired`）；`delivery_claim`（同簽章替換）每一輪先呼叫它。
- `grant_end`（同簽章替換）：等確認時被撤銷，確認作廢。
- `case_detail`（同簽章替換）多 `confirmation`（狀態、期限與當地時間文字、**剩幾個工作天由資料庫算** `workdays_between`、用到的參數值、確認人、原因）。
- `api.case_reduce`（同簽章替換）：新的一版寫 `case.reduced` 事件（版本、內容指紋，和縮小後核准同一個事件），見 §4。
- 規則：新增 K-CONFIRM、K-CONFIRM-DISPUTE、K-CONFIRM-TIMEOUT；K-VERIFY-AUTO、K-GRANT-REDUCE 改為 full，K-FULFIL 的說明更新。錯誤目錄：CONFIRMATION_NOT_OPEN、CONFIRMATION_OVERDUE。
- `sgn_sdk.register_process_options`：流程包合併登記流程類型的選項（不必重登整個流程類型）。

`db/packs/data_access/120_confirmation.sql`（新，流程包）：`requires_confirmation = true`；`confirmation.due_workdays` 在 `process:data_access` 登記 5（rules.md）。

### 路由與排程

- `packages/contract/src/routes.ts`：路由 `case_confirm_verification`、`case_dispute_verification`；`caseDetail.confirmation`；排程 `jobCalls.confirmationExpireDue`。
- `db/tools/jobs.mjs`：排程多跑 `api_job.confirmation_expire_due`。權限由 `grants-sql.mjs` 依路由表產生（`12-grants` 檢查相等）。

### 畫面（`web/`）

- 申請單詳情（`web/pages/case.js`）：
  - 等確認時，最上面（決定事實之前）是「請確認驗證結果」：剩幾個工作天與期限、這一版每個驗證案例的 ✓／✗ 與「應該查得到／查不到，實際…」、一句說明。
  - 底部固定「結果正確，確認生效」（確認面板說明後果再按一次），內文「結果不對」（寫原因）與「撤銷」。按鈕只依 `actions`。
  - 確認結束後只留一行結果（誰確認、回報的原因、逾期撤銷、等確認時撤銷）。
  - 生效中：內文「縮小」→ 面板（授權起迄、只列目前已有的主題包、欄位、列條件值、期間、可否匯出、原因）→ `case_reduce`；擴大與否由資料庫判斷。和簽核人的「縮小後核准」共用 `reduceInputs`。
- 首頁（`web/pages/home.js`）：「等你確認驗證結果」列在「我的申請」上面（依 `actions` 含 `confirm_verification`）。
- 文案（`web/i18n.js`）：動作、確認面板、結果、縮小、例外 K-CONFIRM-DISPUTE。

## 3. 步數（T7 確認驗證結果，申請人，手機 390×844）

實測（e2e K-DELIVERY-AUTO K-CONFIRM，`console.log` 印出）：**3 步**——首頁「等你確認驗證結果」的單 →「結果正確，確認生效」→ 面板「確認生效」。
打開的第一個畫面就看得到每項測試的結果（6 項，全部 ✓）與「還有 5 個工作天（期限）」，結果清單的底在固定動作列之上（不用捲動）；兩個畫面都沒有水平捲動、可點元素都 ≥ 44px。
若不要確認面板可以是 2 步；保留是因為 `ux-acceptance.md` 要求「會造成影響的動作有確認步驟，並說明後果」，而確認會讓授權生效。

## 4. 和契約、既有設計不同的地方

| 項目 | 契約或既有 | 這裡 | 理由 |
|---|---|---|---|
| 確認的時點 | 骨幹 §4.3「存續型授權在執行完成且驗證通過時建立……確認在授權生效後進行」 | 授權在**確認後**才產生 | rules.md「兩者都通過才結案生效」；骨幹與 rules.md 矛盾，照 rules.md（規則文件不得改），**請負責人裁決並修骨幹** |
| 規則代碼 | 骨幹只有 K-CONFIRM | K-CONFIRM、K-CONFIRM-DISPUTE、K-CONFIRM-TIMEOUT | 稽核事件要寫明「依據哪條規則」：確認、回報不對、逾期撤銷是三種不同的系統行為 |
| `confirmation_timeout_action` | 骨幹 §3 `revoke`／`remind`，預設 remind | 沒有這個選項；逾期一律撤銷 | 資料授權是 revoke；沒有第二個流程包要 remind，不做空殼 |
| 逾期前提醒 | 骨幹 K-CONFIRM「提醒對象逐日擴大，撤銷前一天明說」 | 沒做（開確認時通知一次，期限寫在通知裡） | 不在這次任務；K-CONFIRM-TIMEOUT 標 partial |
| `confirmation_parties`、`confirmation_prompt` | 骨幹 §3 | 只有申請人；文字是通用的 | 骨幹附錄 B：資料授權只有申請人 |
| 驗證失敗 | 骨幹 §4.1「verifying 驗證失敗 → pending_fulfilment」 | 照 delivery.md：fulfilment_failed（回報不對也是） | 系統對系統時沒有可以修正後重送的流程（delivery.md §4）|
| 人工執行的退路 | rules.md「驗證中……再由申請人確認」 | 人工交付的單沒有自動驗證，也不開確認，照舊標記已套用即生效 | 沒有驗證結果可以給申請人確認；人工每張都有常設例外 K-DELIVERY-MANUAL。**待裁決** §5-4 |
| 生效後縮小 | — | 縮小後的新一版不再要申請人確認 | 只會縮小，重新驗證不過由系統撤銷（K-GRANT-REDUCE）|
| 420 `api.case_reduce` 的缺陷 | 縮小後核准（170）會寫 `case.reduced`（版本與內容指紋） | 420 的生效後縮小只寫 `grant.reduced`（沒有內容指紋）→ 稽核頁與離線工具判「目前的內容不是鏈上記下的最新一版」 | 畫面開放縮小後，端對端 `z-anchor-store` 第 1 個（原本就有）失敗才發現；470 替換 `api.case_reduce` 補寫 `case.reduced`，`web/verify.js` 不用改 |

## 5. 待裁決與要回報的矛盾

1. **規則與技術的張力（回報，未改規則）**：rules.md「兩者都通過才結案生效」，但自動驗證必須對外部系統上**真的權限**查，所以等確認期間（最多 5 個工作天）被授權者在外部系統上已經查得到（威脅表 #10，e2e 實測 `allow`）。平台的授權（grant）在確認後才產生、對帳視為應有。要真的「確認前不能用」，外部系統得支援「只給驗證帳號用的暫存規則」（sim/dc 沒有這個介面）。
2. **骨幹與 rules.md 矛盾**：骨幹 §4.3 說確認在授權生效後；這裡照 rules.md。請修骨幹。
3. **確認要不要通行金鑰**：預設不要（不是簽核決定，評估見 §1 #2）。若要本人不可否認的證據，改 `needs_proof`，T7 多一步。
4. **人工執行的單要不要申請人確認**：目前不開確認（沒有自動驗證結果）。若要，確認畫面只能顯示「系統管理人標記已套用」。
5. **代填由誰確認**：照骨幹附錄 B 是申請人（代填的人），不是被授權者負責人。理由：rules.md 角色表把「確認驗證結果」給申請人；負責人在第一關已以通行金鑰確認代填（D79 (2)）。若負責人認為「實際要用資料的一方」更合適，改 `denial_reason` 的確認者即可（測試 `55` #2 會跟著改）。

## 6. 既有測試的調整（逐項原因；斷言沒有放寬）

| 測試 | 調整 | 原因 |
|---|---|---|
| `db/tests/packs/data_access/delivery-lib.mjs` | `activeSalesOrderCase` 拆成 `confirmableSalesOrderCase`（到等確認）＋申請人確認；新增 `confirmVerification` | 生效多了申請人確認一步 |
| `50` 的 `active()` 與 SIGNED、RETRY、STUCK 三處「送完就是 active」 | 先斷言確認是 pending，再由申請人確認，斷言 active | 同上（加嚴：多斷言了等確認）|
| `50` K-DELIVERY-AUTO | 送完後斷言 `verifying`、確認 pending、沒有授權；確認後才 `active`；事件清單多 `confirmation.opened`、`confirmation.confirmed` | 同上（加嚴）|
| `50` K-GRANT-REDUCE | 多斷言 `case.reduced` 事件的版本與內容指紋 | §4 的缺陷修復 |
| `90-contract` | 「改狀態但不自己授權」白名單多 `confirmation_expire_due`（system 動作、理由寫在表裡）；多實際呼叫 `case_confirm_verification`、`case_dispute_verification` 檢查回傳結構 | 新的入口；每個路由都要檢查回傳 |
| `70-business` K-DECISION-PROOF | 會改狀態的入口清單多 `api.case_confirm_verification`、`api.case_dispute_verification`、`sgn_internal.confirmation_expire_due`；需要證明的動作清單不變 | 新的狀態入口都不是決定類動作 |
| e2e K-DELIVERY-AUTO | 改名加 K-CONFIRM；生效前多一段：在畫面上確認（T7 步數、版面、結果在動作列之上） | 同上 |
| e2e K-RECON-EXTRA、K-DELIVERY-RETRY | 等生效改成「等確認 → 直接打後端確認 → 斷言 active」（`confirmByApi`） | 同上；這兩個測試要看的不是確認畫面 |

## 7. 怎麼執行與實測紀錄

```bash
tools/check.sh                                   # 全部（以 root；乾淨狀態：停掉背景程式、rm -rf .run）
tools/run-all.sh --keep                          # 背景程式留著（排程每 60 秒、交付每秒都會處理逾期的確認）
SGN_DATABASE=sgn_test node --test db/tests/packs/data_access/55-confirmation.test.mjs   # 建好資料庫之後單獨跑（db/build.sh --no-test）
```

乾淨狀態的 `tools/check.sh` 結果與紅隊腳本結束碼見 §8。

## 8. 實測紀錄

**乾淨狀態的 `tools/check.sh`（2026-11-20；停掉背景程式、`rm -rf .run` 之後，以 root）**：11 段全部通過（exit 0，約 5 分鐘）。

| 段落 | 結果 |
|---|---|
| 安裝、格式、lint、型別、shellcheck、plpgsql_check、禁止字串、追蹤的檔案、npm audit、sim/dc | 通過 |
| 規則代碼覆蓋 | 88 個，每個都有測試（新增 K-CONFIRM、K-CONFIRM-DISPUTE、K-CONFIRM-TIMEOUT）|
| 資料庫測試 | **251／251**（上一輪 244；新增 7：`55`）|
| 通行金鑰對照組 | 16／16 |
| 端對端 | **27／27**（上一輪 24；新增 3：K-CONFIRM-TIMEOUT、K-CONFIRM-DISPUTE、K-GRANT-REDUCE；改 3，見 §6）|

**紅隊腳本（`tools/run-all.sh --keep` 重建之後，01–32 依序各跑一次；沒有改腳本）**：

| 腳本 | 修前 | 這次 | 說明 |
|---|---|---|---|
| 01–19 | 0 | 0 | 不變 |
| 20 | 2 | 2 | 不變（redteam-fixes-4 §5：入口改變）|
| 21 交付程式謊報 | 0 | **2** | 流程多了確認一步：腳本的 b 段用 `approvedCase` → `drain` 後以為生效，接著 `case_reduce`（第 61 行）；單停在「驗證中・等申請人確認」，`case_reduce` 只對生效中的單 → STATE_TRANSITION，腳本判為無法判定。a 段也只走到 pending_fulfilment 就判 n/a |
| 22 撤銷後送較新版 | 0 | **2** | 同上：第 35 行 `case_reduce`（log 顯示「生效：verifying」）→ STATE_TRANSITION |
| 23–27 | 0 | 0 | 不變 |
| 28 撤銷與縮小的濫用 | 0 | 0 | 結束碼不變，但**意義變了**：drain 之後單在等確認，所有「縮小時擴大」的嘗試都在 STATE_TRANSITION 就被擋，沒有走到資料庫的縮小判斷；無關員工的撤銷仍是 NOT_REVOKER。這一支要在 drain 後加申請人確認才測得到原本要測的東西 |
| 29 租約與順序的競賽 | 0 | **2** | 同 21：第 51 行 `case_reduce` → STATE_TRANSITION |
| 30–32 | 0 | 0 | 不變 |

21、22、29 回 2、28 意義改變，都是同一個原因：腳本假設「交付程式送完＝生效」，現在要先由申請人確認（`api.case_confirm_verification`）。
腳本是紅隊的範圍，沒有改；下一輪紅隊改寫時在 `00-delivery-lib.mjs` 的 drain 之後加申請人確認即可。這次新增的入口（`case_confirm_verification`、
`case_dispute_verification`、`api_job.confirmation_expire_due`、領取時的逾期處理、畫面的縮小）需要紅隊對著執行中的系統打一輪。

## 9. 留給下一位

- 威脅表未解：#2（後端替申請人按確認，評估為可接受）、#4（部分）、#7（排程與交付程式同時停擺）、#10（等確認期間外部系統上已有權限）、#11、#12。
- 待裁決 §5 的五項；骨幹 §4.3 要依裁決修正。
- 逾期前提醒（骨幹 K-CONFIRM）、`confirmation_timeout_action = remind`、`confirmation_parties` 的其他選項沒做。
- 紅隊腳本 21、22、28、29 要配合確認一步改寫（§8）。
- `grant_manual_followup` 的通知把事件代碼（revoked）直接放進「授權已{{event}}」的文案（420 既有，沒改）。
