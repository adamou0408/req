# 交接：核准之後的系統對系統交付（平台側，接上 sim/dc）

日期：2026-11-20。依據：裁決 D63、方向頁策略 2、4、`docs/packs/data-access/rules.md`、`docs/handoff/sim-dc.md`、`sim/dc/README.md`、
契約 02 §5.10–§5.12、§8，05 §8。範圍：`db/`、`api/`、`web/`、`e2e/`、`packages/contract/`、`tools/`、本文件。
沒有改 `sim/dc/` 的程式與 `redteam/`；沒有 commit。執行期改了 `sim/.run/dc/keys/trusted-keys.json`（見 §4）。

## 0. 結果一覽

（§7 有指令與實測結果。）

| 項目 | 結果 | 測試 |
|---|---|---|
| 交付是 port＋adapter，交付方式（system／file／manual）是資料 | 做了 | `50` K-DELIVERY-AUTO、K-DELIVERY-MANUAL；`93` 兩個 adapter 同一份合約 |
| 規則內容由資料庫從核准版本產生、資料庫簽章 | 做了 | `50` K-DELIVERY-SIGNED；`93` Ed25519 向量、K-DELIVERY-SIGNED ×2 |
| outbox、冪等鍵、重送與退避（參數）、持續送不到開例外 | 做了 | `50` K-DELIVERY-RETRY、K-DELIVERY-STUCK；e2e 重送 |
| 外部系統的回報驗證來源 | 部分（只收交付程式帳號在租約內的回報；回應本身沒有簽章，未解） | `50` 架構、K-DELIVERY-RETRY（租約） |
| 順序：撤銷不被較舊的套用蓋掉 | 做了 | `50` K-DELIVERY-ORDER；`93` K-DELIVERY-ORDER ×2 |
| 自動驗證（案例由資料庫產生）、不過不生效 | 做了 | `50` K-VERIFY-AUTO、DA-VERIFY-CASES；`93` K-VERIFY-AUTO ×2；e2e |
| 撤銷、縮小、到期（含清除）自動送出；撤回送不到開例外＋升級 | 做了（生效後縮小沒有畫面） | `50` K-GRANT-REVOKE、K-GRANT-REDUCE、K-GRANT-EXPIRE、K-DELIVERY-STUCK；`93` K-GRANT-EXPIRE；e2e 撤銷 |
| 對帳（多出、少掉、範圍不同各開例外） | 做了 | `50` K-RECON-*；`93` K-RECON-DIFFERENT；e2e 後門 |
| 畫面：詳情顯示交付與驗證（390px）、例外清單、人工退路只在人工時出現 | 做了 | e2e 版面檢查與畫面斷言 |
| 申請人確認驗證結果（rules.md「驗證中」） | **沒做**（與任務的「自動驗證 → 生效」矛盾，見 §5） | — |

`50`＝`db/tests/packs/data_access/50-delivery.test.mjs`，`93`＝`db/tests/kernel/93-delivery-adapter.test.mjs`（對著真的 sim/dc），
e2e＝`e2e/tests/system-delivery.test.mjs`。

## 1. 架構與持鑰者

```
 sgn_app（後端）── api.case_revoke／case_reduce ──┐
                                                  ▼
 資料庫：核准版本 → build_delivery（流程包）→ sgn.delivery_op（outbox，本文是文字）
         領取時以 sgn.signing_key 簽章（Ed25519，純 PL/pgSQL）；回報由資料庫分類；驗證案例由流程包產生、核心比對
                ▲  api_delivery.delivery_claim／delivery_report             ▲ api_job.reconciliation_submit
 sgn_delivery（api/src/delivery.ts，platform 金鑰）            sgn_job（api/src/reconciler.ts，auditor 唯讀金鑰）
                │  PUT／DELETE／POST（原樣送出資料庫給的位元組）              │ GET /reconciliation
                ▼                                                            ▼
                               sim/dc（套用成真正的資料庫權限）
```

**持鑰者：資料庫。** 私鑰在資料庫裡以 `gen_random_bytes` 產生（`sgn_internal.signing_key_create`，`db/build.sh` 以 owner 執行），
存在 `sgn.signing_key`（只有 owner 讀得到；`sgn_app`、`sgn_delivery`、`sgn_job` 都沒有資料表權限），
簽章在 SECURITY DEFINER 的領取入口裡做，第一次領取時簽、之後重送用同一份。理由（對照 §2）：

- 任務要求「規則內容必須由資料庫產生，交付程式不得能改」。只要簽章的人和產生內容的人不同，簽章的人就必須相信別人給的內容：
  獨立的簽章程式拿到金鑰，被拿走時可以簽任何東西；交付程式持鑰更糟（它就是送的人）。簽在資料庫裡，簽章只會是資料庫狀態的函數，
  能簽任意內容的只剩資料庫擁有者——他本來就能改核准紀錄，而那由雜湊鏈與外部錨點事後偵測（#13 未解）。
- 代價：Ed25519 要自己寫（pgcrypto 沒有）。`db/kernel/400_ed25519.sql` 約 200 行，和 RFC 8032 的向量逐位元組相同、
  Node 的 `crypto.verify` 驗得過隨機訊息（`93` 第 1 個）；一次簽章約 12 毫秒。私鑰會跟著資料庫備份走。
- 公鑰交給外部系統：`db/tools/delivery-keys.mjs` 讀各資料庫目前那一把的公鑰（PEM），併進 sim/dc 的信任清單，再重新啟動 sim/dc。

**三個帳號、兩把外部金鑰分開**：後端（`sgn_app`）不能領取、不能回報、不能交對帳；交付程式（`sgn_delivery`）只能 `api_delivery`；
對帳（`sgn_job`）用 sim/dc 的 auditor 唯讀金鑰拉回報。交付程式被拿走而謊報套用、驗證、撤回時，對帳從另一條路抓到。

## 2. 威脅表

欄位：資料流／不可信方／被入侵時能做什麼／防法／測試。B＝被入侵的後端（sgn_app）；D＝被入侵的交付程式（sgn_delivery＋platform 金鑰）；
N＝交付程式與外部系統之間的網路；J＝被入侵的對帳程式（sgn_job＋auditor 金鑰）。

| # | 資料流 | 不可信方 | 能做什麼 | 防法 | 測試 |
|---|---|---|---|---|---|
| 1 | 核准版本 → 規則內容 | B | 改規則內容 | 內容由資料庫的 hook 從核准版本產生，B 沒有任何交付入口與資料表權限 | `50` K-DELIVERY-AUTO（送出的＝fulfilment）、架構 |
| 2 | outbox → 外部系統 | D、N | 改規則內容（擴大列條件） | 簽章涵蓋本文原始位元組；外部系統拒絕 → 平台開例外、不生效、撤回 | `50` K-DELIVERY-REJECTED；`93` K-DELIVERY-SIGNED；e2e 竄改 |
| 3 | 簽章 | B、D | 簽自己編的規則 | 私鑰只在 owner 讀得到的表；簽章 function 不開放 | `50` K-DELIVERY-SIGNED |
| 4 | outbox → 外部系統 | D、N | 重放舊的已簽章規則（較舊版本、撤回後的同一版） | 外部系統的版本規則（409）；平台判為 reject 開例外 | `93` K-DELIVERY-ORDER |
| 5 | 撤銷 → 外部系統 | D | 擋下撤回（不送、送了不回報） | 撤回在撤銷的同一個交易裡排進 outbox；超過參數開例外並通知升級對象（MIS、資安長）；對帳看到權限還在 | `50` K-DELIVERY-STUCK、K-RECON-EXTRA |
| 6 | 撤銷 → 外部系統 | 任何人（並行） | 撤回被較舊的套用蓋掉 | 同一張單同一通道一次只送最前面一筆；還沒送的套用與驗證作廢；作廢的不能回報 | `50` K-DELIVERY-ORDER |
| 7 | 外部系統 → 平台 | B | 謊報套用成功、驗證結果 | B 沒有 `api_delivery` 權限 | `50` 架構；`12-grants` |
| 8 | 外部系統 → 平台 | D | 謊報套用成功 | 生效要再通過驗證；對帳（另一個帳號、另一把金鑰）抓到「少掉的」 | `50` K-VERIFY-AUTO、K-RECON-MISSING |
| 9 | 外部系統 → 平台 | D | 謊報驗證結果 | 案例由資料庫產生、資料庫比對（少回、多回、重複都不算通過）；**部分未解**：D 照預期回答就會通過，靠對帳事後抓 | `50` K-VERIFY-AUTO、K-RECON-* |
| 10 | 外部系統 → 平台 | D | 回報舊的租約、亂回報 | 只收這次領取的租約；格式不對拒收；分類由資料庫依 HTTP 狀態與回應決定 | `50` K-DELIVERY-RETRY |
| 11 | 外部系統 → 交付程式 | N | 偽造外部系統的回應 | **未解**：sim/dc 的回應沒有簽章（http）；只能靠驗證與對帳事後抓 | — |
| 12 | 已簽章、還沒送出的較新版本 | D | 撤銷之後才送出，讓權限復活 | **未解**：sim/dc 全部撤回之後仍接受更新的版本；只能靠對帳（K-RECON-EXTRA）事後抓。要外部系統支援「撤回後整張單不再接受」或簽章帶期限 | — |
| 13 | 私鑰 | 資料庫擁有者、備份 | 簽任意規則 | **未解**：沒有硬體金鑰；資料庫擁有者本來就能改核准紀錄（雜湊鏈與錨點事後偵測） | — |
| 14 | 對帳回報 | J、N | 交假的回報（說一切正常） | **未解**：回報沒有簽章；J 和 D 不同帳號、不同金鑰，要兩個都拿到才能同時騙過驗證與對帳 | — |
| 15 | 撤銷 | B | 替使用者撤銷（讓授權失效） | **未解（可接受）**：撤銷只會縮小，B 本來就能讓服務停擺；每次進鏈並通知申請人與負責人 | `50` K-GRANT-REVOKE |
| 16 | 撤銷 | B | 擋下使用者按的撤銷（不轉給資料庫） | **未解**：使用者的請求經過 B；頁面顯示的狀態也經過 B（D68 的分開部署只保護頁面程式） | — |
| 17 | 人工退路 | 系統管理人 | 只在畫面上標記已套用、實際沒做 | 走人工的每一張都開常設例外 K-DELIVERY-MANUAL；**未解**：人工的系統沒有驗證與對帳 | `50` K-DELIVERY-MANUAL |
| 18 | 驗證案例 ↔ 外部系統的判斷 | —（設計） | 外部系統以被授權者為單位取聯集：同一被授權者另一張單合法放行的列，讓這張單的反例「查得到」→ 假的驗證失敗；反過來，正例也可能是別張單滿足的 | 反例若被同一被授權者其他可能在外部系統上的單放行，就不列入（`pack_data_access.rules_allow`，和 sim/dc 同樣以欄位為單位取聯集）；**部分未解**：正例分不出是哪張單放行，靠對帳逐規則比對（sim/dc 每條規則一個角色） | `50` DA-VERIFY-CASES（聯集）；`93` K-VERIFY-AUTO 聯集 ×2；e2e 重送（2025、2026 年兩張單） |

先失敗的測試（照實寫）：威脅表在動手前寫好，但測試與程式是一起寫的，沒有逐列先看到失敗。#18 是對著真的 sim/dc 跑端對端時才發現的：
重送測試的單（2026 年）在 sim/dc 恢復後套用成功，但「資料期間外（2025-12-31）」的反例被同一被授權者 2025 年那張單放行，驗證判為不一致、撤回——
平台的設計（契約 §5.11 逐規則產生反例）沒有考慮外部系統的聯集；修法見 #18，模擬 adapter 也改成和 sim/dc 一樣取聯集。其他實際看到失敗再修好的：
`50` 第一次跑 16 個裡 1 個失敗（bigint 比對的測試錯誤），全套跑時 3 個對帳測試失敗（別的測試留下的 K-DETECT-MANAGER-FLIP，改成只看 K-RECON-*）；
`93` 對著真的 sim/dc 第一次跑就全部通過。行為上的「拿掉防法就失敗」只確認了 #2（`93` 的竄改案例在 sim/dc 驗章時 401；mock 不驗章時同一案例會被當成成功）。

## 3. 做了什麼

### 資料庫（`db/kernel/`、`db/packs/data_access/`）

- `400_ed25519.sql`：Ed25519 公鑰、簽章、SPKI PEM。
- `410_delivery.sql`：
  - 轉移表加 `entity` 欄（主鍵改為 entity＋from_state＋action）：申請單多 `verifying`、`fulfilment_failed`、`revoked`、`expired`；
    交付（queued → sending → done／queued（重送）／rejected；queued → superseded）與驗證輪（pending → passed／failed／cancelled）也走這張表。
  - 參數：`delivery.mode`、`delivery.channel`（依 `system:<代碼>`）、`delivery.signature_context`、`delivery.lease_seconds`、
    `delivery.retry_base_seconds`、`delivery.retry_max_seconds`、`delivery.stuck_alert_seconds`（依 `channel:<代碼>`）、
    `delivery.escalation_roles`、`grant.revoker_roles`（依流程類型）。
  - `sgn.signing_key`、`sgn.delivery_op`（outbox）、`sgn.verification_run`；領取、回報、分類、退避、卡住檢查、驗證、作廢、撤回、清除、
    執行關的進度 `fulfilment_progress`（人工與自動兩條路的唯一判斷）、失敗 `fulfilment_fail`（不生效、撤回、例外、通知）。
  - 新 hook：`build_delivery`、`build_verification_cases`。
- `420_delivery_flow.sql`：執行關只為人工交付的受管系統開工作（`resolve_stage`）；`stage_open` 先排自動交付、沒有人工工作時不停住；
  `stage_close_if_done`、`case_advance` 接上驗證中；授權檢查入口多 `revoker`；`grant_end`（撤銷、到期）、`api.case_revoke`、
  `api.case_reduce`、到期 `grant_expire_due`；人工的受管系統撤銷時開例外並通知該系統的管理人。
- `430_delivery_api.sql`：`api_delivery.delivery_claim／delivery_report`、`api_job.delivery_stuck_check／grant_expire_due`、
  申請單詳情的 `delivery`（每筆交付、每輪驗證與每個案例的 `match`）、規則代碼、通知範本。
- `440_reconciliation.sql`：`api_job.reconciliation_submit`；平台該有的（最後一筆成功套用、之後沒撤回）、不確定期（還有交付沒結果）、
  多出／少掉／不同各開例外、同一個發現只開一次、下一輪沒看到就結案；新 hook `expected_entitlements`、`normalize_constraints`。
- 流程包 `110_delivery.sql`：上面四個 hook（驗證案例依契約 §5.11，文字走訊息目錄）；規則 DA-VERIFY-CASES、DA-DC-WITHDRAW，DA-FULFIL-RULE 改為 full。
- 種子 `db/seed/kernel/040_delivery.sql`：dc 走系統對系統、通道 dc；hr_saas 維持人工（示範退路）。
- `db/sgn.env`：新登入角色 `sgn_delivery`；`db/build.sh`：建角色、產生簽章金鑰、更新 sim/dc 的信任清單並以 `--reset` 重新啟動；
  `db/tools/grants-sql.mjs`：允許清單多 `deliveryCalls`，並授與各 schema 的 USAGE；`db/tools/jobs.mjs`：多兩個排程。

### 後端（`api/src/`）

- `deliveryPort.ts`（port）、`dcHttp.ts`（HTTP adapter：交付與對帳）、`dcMock.ts`（模擬 adapter：驗章、版本、撤回去重、§8.5 的規則語意）。
- `delivery.ts`（交付程式）、`reconciler.ts`（對帳程式）；`config.ts` 多 `deliveryConfig`、`reconcilerConfig`（通道 → adapter）。
- 沒有任何依狀態、角色的判斷；成功、重送、拒絕都由資料庫分類。

### 畫面（`web/`）

- 申請單詳情：「交付與驗證」區塊（每筆交付的種類、狀態、次數、下次重送、錯誤；每輪驗證的每個案例與 ✓／✗，結果由資料庫的 `match` 給）；
  執行關沒有人工工作時進度顯示「系統自動送到外部系統中／系統自動驗證中」；「撤銷」按鈕（依 actions，填原因，不用通行金鑰）。
- 「標記已套用」照舊只依 actions 出現：只有人工交付的受管系統才有執行關的人工工作，所以只在交付方式是人工時出現。
- 稽核的例外清單：新例外的說明文字；不屬於任何單的對帳、清除例外標「外部系統」。

### 工具（`tools/run-all.sh`）

- 背景多交付程式（每秒）與對帳程式（每 30 秒）；sim/dc 由 `db/build.sh` 啟動。

## 4. 與契約、sim/dc 介面不一致的地方

| 項目 | 契約或介面 | 這裡 | 理由 |
|---|---|---|---|
| 交付方式 | 02 §8.2 `data_access.dc_delivery_mode` 全域 manual／auto | 核心參數 `delivery.mode` 依受管系統（system／file／manual），預設 manual，示範種子 dc＝system | D63：哪個受管系統用哪一種是資料 |
| DC port | 02 §8.5 `deliver／withdraw／verify` 三個方法 | 一個 `send(item)`：種類、本文、簽章都由資料庫決定 | 讓 adapter 沒有可以判斷或改內容的地方 |
| 撤回 | 02 §8.3 `dc_rule` 表、MIS 按「已撤回」 | outbox 的撤回自動送出；人工的系統開例外並通知管理人 | D63 |
| 驗證 | 02 §8.4 `verification_pending／verification_report` | 驗證也是一筆交付（kind verify），經 `api_delivery` | 只有交付程式能回報 |
| 驗證失敗 | rules.md「自動測試沒過，退回 MIS 修正設定」 | 不生效（fulfilment_failed）、撤回已送出的、開例外並通知 MIS 與資安長；沒有「修正後重送」的流程 | 系統對系統時沒有 MIS 可以修正的設定；重送同一版會被外部系統以版本擋下 |
| **申請人確認** | rules.md「驗證中：系統自動測試…再由申請人確認。兩者都通過才結案生效」 | 沒做：自動驗證通過就生效（既有程式本來也沒有確認） | 任務寫「自動驗證 → 生效」，與 rules.md 矛盾；**請負責人裁決**，rules.md 沒有改 |
| 對帳 | 05 §8 由外部系統以 `api_client` 上傳批次與項目 | 平台的排程拉回報、`api_job.reconciliation_submit` 一次比對；發現沒有處理流程 | 這一版沒有 `api_client`；先做偵測 |
| 規則格式代碼 | 02 §8.1 `dc_rule_set/1` | `data_access_rule_set/1`（照舊） | sim/dc 只收實際輸出；收斂屬契約的負責人 |
| 信任清單的位置 | sim/dc README：`SIM_DC_TRUSTED_KEYS_FILE` | 只能寫 `sim/.run/dc/keys/trusted-keys.json` | `service.env` 把它設成空字串，`sim_dc_load_env` 會蓋掉環境變數；**sim/dc 介面的缺口**，沒有改 sim/dc |
| 外部系統的回應 | — | 沒有簽章 | **sim/dc 介面的缺口**（威脅表 #11、#14） |
| 撤回後的新版本 | — | sim/dc 全部撤回之後仍接受更新的版本 | **sim/dc 介面的缺口**（威脅表 #12） |
| 清除 | — | `purge-expired` 是整個 DC、用 DC 的 `current_date` | 平台排一筆通道層級的清除；兩邊的「今天」要一致（都用 Asia/Taipei） |
| 驗證案例 | 02 §5.11 逐規則產生反例；§8.5 的語意只看這一份規則 | 反例若被同一被授權者的其他單放行就不列入；判斷以欄位為單位取聯集 | sim/dc 實際上以被授權者為單位判斷（威脅表 #18）；**契約 §5.11、§8.5 要補這一點** |

## 5. 既有測試的調整（逐項原因；斷言沒有放寬）

| 測試 | 調整 | 原因 |
|---|---|---|
| `db/tests/packs/data_access/20-flow` | `before` 把 `system:dc` 設為 manual | 這個檔案測的是人工退路（系統管理人認領、通行金鑰標記已套用）；種子預設改成系統對系統 |
| e2e `path.test.mjs` | `before` 把 `system:dc` 設為 manual | 同上（DA-PATH-L3 由李志偉標記已套用） |
| `90-architecture`（流程包） | hook 清單多四個 | 新 hook |
| `90-contract`（核心） | 授權錯誤代碼多 `NOT_REVOKER`（加嚴）；「改狀態但不自己授權」的白名單多三個系統動作並寫理由；允許清單檢查多 `api_delivery`；多呼叫 `case_reduce`、`case_revoke` 的實際回傳 | 新的入口；每個路由都要檢查回傳結構 |
| `70-business` K-DECISION-PROOF | 會改狀態的入口清單多 `api.case_reduce` 與三個系統動作；需要證明的動作清單不變 | 新的狀態入口都不是決定類動作 |

## 6. 留給下一位

- 威脅表「未解」：#9（部分）、#11、#12、#13、#14、#16、#17、#18（部分）。#11、#12、#14 要外部系統（sim/dc）的介面配合：回應簽章、撤回後封存整張單、對帳回報簽章。
- 申請人確認驗證結果與逾期自動撤銷（rules.md）：待裁決。
- 生效後縮小（`api.case_reduce`）沒有畫面入口（資料庫、契約、測試都有）。
- 檔案交換（`delivery.mode = file`）這一版視同人工。
- 驗證失敗之後的補救（新版本重送）沒有流程；對帳的發現沒有處理與結案的畫面。
- 對帳的 `entitlement_id` 仍是 null；以「被授權者｜欄位｜動作｜規則代碼」比對。
- 驗證案例在同一被授權者的單很多時會剔除較多反例（#18）；要更強，得讓外部系統支援「只以某一條規則的角色查詢」。

## 7. 怎麼執行與實測紀錄

```bash
tools/check.sh                 # 全部（sim/dc 由 db/build.sh 啟動、信任這次建置的公鑰、清空）
tools/run-all.sh --keep        # 背景程式留著：交付 .run/delivery.log、對帳 .run/reconciler.log
SGN_DATABASE=sgn_e2e node api/src/reconciler.ts   # 手動對一次帳
```

**乾淨狀態的 `tools/check.sh`（2026-11-20；停掉背景程式、`rm -rf node_modules .run` 之後）**：10 段全部通過（exit 0）。

| 段落 | 結果 |
|---|---|
| 資料庫測試 | **220／220**（上一輪 192；新增 28：`50` 17 個、`93` 11 個；調整見 §5） |
| 通行金鑰對照組 | 16／16 |
| 端對端 | **22／22**（新增 5：`system-delivery.test.mjs`，真的 sim/dc） |
| plpgsql_check | 沒有問題 |

沒有跑紅隊的攻擊腳本（`redteam/`）；這一輪的新入口（`api_delivery`、`api.case_revoke`、`api.case_reduce`、`api_job.reconciliation_submit`）
需要由紅隊對著執行中的系統打過一輪。
