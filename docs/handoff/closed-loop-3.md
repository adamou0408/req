# 交接：閉環第三批——六個畫面問題、匯出需求調查（closed-loop-3）

依據：`docs/decision-log.md` D91–D96（D96 (4)：匯出調查）；沿用 `docs/handoff/closed-loop-1.md`、`closed-loop-2.md` 的做法（hook 包裝、舊單不重算、以鏈上記下的要簽內容和 `decisionContent` 逐位元組比對、只增不改的表）。提案 `docs/packs/data-access/export-purposes.md`。`docs/packs/data-access/rules.md` 與 `redteam/` 沒有修改（條文草稿在 §5）。

**範圍修正（負責人 2026-11-21，經主代理轉達）**：匯出調查的「方法」不進申請內容、不進版本雜湊、不進顯示摘要、不給簽核人簽，只存成附屬的調查紀錄（只增不改、有稽核事件），用於彙總與送審前的引導；「目的」「頻率」照原要求進內容與簽的內容。第一版曾把方法放進內容（尚未套用到任何環境、沒有 commit），已改掉，現在的 migration 只有修正後的設計。

## 1. 做了什麼

| 項目                        | 狀態                                           | 實作                                                                                                                                                                                                                                                                                                                                                                                                                   | 測試                                                                                                                            |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A1 稽核證據頁的「nullnull」 | 完成（找到原因並重現）                         | `web/ui.js` 新增 `fill`；`web/pages/audit.js`、`apply.js`、`app.js`、`packs/*.js` 一律改用它；ESLint `no-restricted-properties` 禁止 `web/` 直接用 `replaceChildren`（`ui.js` 除外）                                                                                                                                                                                                                                   | `e2e/tests/system-screens.test.mjs` K-CASE-DISCARD（捨棄的草稿、簽核中的證據頁沒有 null／undefined／NaN）                       |
| A2 首頁重點與待簽排序       | 完成                                           | `db/kernel/565_screen_fixes.sql`：`person_capabilities` 的順序＝首頁區塊順序；`api.inbox_list` 依「有逾期警示 → 等最久 → 單號」；`api.case_list_mine` 有動作的在前；`web/pages/home.js` 依 capabilities 順序畫                                                                                                                                                                                                         | `db/tests/packs/data_access/85-screens-survey.test.mjs` K-HOME-ORDER；`e2e` K-HOME-ORDER                                        |
| A3 例外去重、分組           | 完成                                           | `api.audit_exception_groups`（同規則同單合成一筆、未結案與已結案分開、順序由資料庫）；首頁只列未結案，已結案收在 `<details>`；說明先問流程包（DA-\* 不再顯示「請查看稽核紀錄」）                                                                                                                                                                                                                                       | `85` K-HOME-ORDER；`e2e` K-HOME-ORDER                                                                                           |
| A4 原因欄位的文案           | 完成                                           | `case_detail.reason_audience`（動作 → applicant／principal_owner／applicant_principal_owner／record）；撤銷與縮小的通知對象改由同一個 `case_end_recipients` 取（`grant_end`、`grant_reduce_deliver` 重新定義，行為不變）；撤銷、縮小面板與退回、駁回、撤回的確認面板都依代碼取 `t.reasonFor`                                                                                                                           | `85` K-REASON-AUDIENCE；`e2e` K-REASON-AUDIENCE                                                                                 |
| A5 刪不掉的草稿、單號跳號   | 部分：做了「捨棄草稿」；單號仍在建立草稿時取號 | `draft → cancelled`（轉移表＋動作 `discard`）、`api.case_discard`（稽核事件 `case.discarded`，帶內容指紋），捨棄的草稿不列在我的申請；新申請畫面與單的頁面都有「捨棄草稿」（確認面板）                                                                                                                                                                                                                                 | `85` K-CASE-DISCARD；`e2e` K-CASE-DISCARD（量步數）                                                                             |
| A6 重疊提示寫出欄位         | 完成                                           | `case_detail.overlap_shown`：經流程包的顯示 hook 換成主題包與欄位名稱；對方的單號與期間只在操作者能看那張單（經手人 `read`、或稽核）時才給；新申請畫面改用它                                                                                                                                                                                                                                                           | `85` K-OVERLAP-SHOWN；`e2e` K-OVERLAP-SHOWN                                                                                     |
| B 匯出需求調查              | 完成                                           | `db/packs/data_access/170_export_survey.sql`：三張代碼表、目的與頻率進內容（`export_survey`）與顯示摘要、方法的調查紀錄 `export_method_record` 與 `api.data_access_export_method_record`／`_latest`、引導與擋下（參數 `data_access.export_redirect_action`）、送審複核、彙總 `api.data_access_export_survey_summary`（稽核或 MIS）；畫面 `web/packs/data_access_form.js` 的調查欄位、`data_access.js` 的顯示與首頁彙總 | `85` DA-EXPORT-SURVEY（兩個）、DA-EXPORT-SURVEY-GUIDE、DA-EXPORT-SURVEY-RULES、DA-EXPORT-SURVEY-SUMMARY；`e2e` DA-EXPORT-SURVEY |

### 1.1 A1：「nullnull」的原因

`web/pages/audit.js` 的證據頁用原生的 `body.replaceChildren(…, c.overdue ? … : null, c.exceptions.length ? … : null, …)`。`el()` 會丟掉 null，但原生的 `replaceChildren` 把 null 轉成文字「null」：沒有逾期警示、也沒有例外的單，摘要卡片下面就出現「nullnull」（只有其中一個是 null 時是一個「null」）。上一位在 40 張單都沒重現，是因為端對端的單幾乎都帶 K-DETECT-MANAGER-FLIP 例外。同樣的錯也在 `web/packs/data_access_form.js` 的測試依據清單（有可以引用的單時清單最上面出現「null」）。

檢查過的其他串接點（都沒有問題，或已改用 `fill`）：`eventLine` 的關卡名稱、決定者、版本、證明種類；`facts` 的申請人、被授權者、期間、使用情形；`t.validRange`、`t.usage.*`、`t.overdue.*`、`t.programHealth.*`、`t.principalOption`、`t.verificationCase`；資料庫端 `case_summary`、`case_usage`、`audit_case_events`、`person_name`（以管理者連線掃過測試資料庫 729 張單的摘要，沒有 JSON null 被轉成字串）。順帶補了證據頁上沒有名稱的事件類型（確認、提醒、交付簽章、例外升級、對帳解除、捨棄草稿、重新綁定、流程包的三種），原本顯示成「例外：請查看稽核紀錄」。

### 1.2 B：匯出需求調查

- 代碼表（資料層可調整：改名稱、停用、加項目、改引導）：`export_purpose`（export-purposes.md 第 2 節的八個；`redirect`＝匯入另一個系統、`alternative`＝系統內替代做法的文字）、`export_frequency`（一次性、每月、每週、每日、持續）、`export_method`（人工下載檔案、排程產出檔案、介面串接到另一系統〔redirect〕、其他需說明）。
- 內容：要匯出時 `export_survey = {purpose, frequency, description}`（輸入帶的 `method` 會被丟掉）。進版本雜湊；顯示摘要多一行「匯出需求調查：目的「…」、頻率「…」（說明：…）」，所以簽核人簽到它；`85` DA-EXPORT-SURVEY 以鏈上記下的要簽內容和 `decisionContent` 逐位元組比對，並確認方法的名稱與代碼不在顯示摘要與簽的內容裡。
- 方法：`api.data_access_export_method_record`（只有能 `revise` 這張單的人，即草稿或退回的申請人）寫一筆 `export_method_record`（只增不改，擋 `UPDATE`、`DELETE`、`TRUNCATE`）與稽核事件 `data_access.export_method_recorded`；不產生新的內容版本。
- 必填：畫面送來調查時，目的、頻率即時列為要修正的地方；送審複核（hook）一律檢查三項——目的、頻率看內容，方法看最新一筆調查紀錄。不經畫面也繞不過。
- 引導：目的是 redirect（匯入另一個系統）→ 整理內容時依參數關閉可否匯出並提示（`block`）或只提示（`warn`）；方法是 redirect（介面串接）→ 判斷依據是調查紀錄：記錄當下回傳 `close_export`，畫面就取消「需要匯出」；送審時最新紀錄仍是 redirect 而內容仍要匯出就擋下（`DA-E-EXPORT-METHOD-REDIRECT`）。有替代做法的目的提示替代做法，不擋。
- 規則不因調查而異：`build_fulfilment` 沒有改，`85` DA-EXPORT-SURVEY-RULES 比對有、無調查的兩張單送出的規則相同（除了單號）。
- 舊單：沒有 `environment`、沒有調查的內容不重算、顯示摘要不多這一行、送審不追加（`85` 第二個 DA-EXPORT-SURVEY）。生效後縮小時畫面沿用原本的調查，原本沒有就不送這個鍵。
- 比較：仍要匯出時調查不同算擴大；改成不匯出算縮小（調查不影響範圍）。
- 彙總：`api.data_access_export_survey_summary`（`sgn_sdk.authorize_any(['audit.read', 'report.mis_read'])`；MIS 角色是參數 `report.mis_role`）。目的、頻率取內容，方法取最新的調查紀錄；只算送審過的單。首頁 capabilities 有 `report`（稽核或 MIS）時顯示。

### 1.3 新畫面動作的步數（390px 寬，`e2e/tests/system-screens.test.mjs` 量的）

| 動作                   | 步數       | 步驟                                             |
| ---------------------- | ---------- | ------------------------------------------------ |
| 捨棄草稿（新申請畫面） | 2          | 按「捨棄草稿」→ 確認捨棄                         |
| 捨棄草稿（從首頁）     | 3          | 打開草稿 → 按「捨棄草稿」→ 確認                  |
| 要匯出時填調查         | 比原本多 3 | 選目的 → 選頻率 → 選方法（選「其他」時多寫說明） |
| 簽核人看調查           | 0          | 決定畫面「完整內容」直接顯示                     |
| 稽核看匯出彙總         | 0          | 首頁直接顯示（依目的展開，頻率、方法各一個收合） |
| 申請人看重疊的欄位     | 0          | 「檢查並送出」直接列出                           |

## 2. 怎麼執行

```bash
tools/check.sh
db/build.sh                                   # 只建庫＋資料庫測試
tools/run-all.sh --keep                       # 起系統；稽核（p22）首頁最上面是背景程式、例外、匯出彙總
```

驗證結果見 §6。

## 3. 與要求不同的地方與理由

| #   | 不同                                                                                                                                                                                       | 理由                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 單號仍在建立草稿時取號（`case_no` 是 identity），捨棄的草稿仍留下跳號；骨幹 K-CASE-NUMBER 要求送審時無間隙取號                                                                             | 單號是所有清單、證據頁、簽的顯示摘要、交付信封、紅隊腳本的鍵；改成送審時取號要動單號的產生與每一處以單號為鍵的地方，風險大。依任務寫進交接、不硬改。K-CASE-DISCARD 登記為 partial 並寫明 |
| 2   | 沒有改成「第一次儲存才建立」；改提供捨棄                                                                                                                                                   | 畫面本來就是第一次輸入才自動存（打開畫面不建立）；問題是存了之後刪不掉                                                                                                                   |
| 3   | 待簽清單的「最需要處理」定義為：有逾期警示 → 等最久（目前開著的工作最早開始的時間）→ 單號                                                                                                  | 平台沒有簽核時限的參數；等最久的最可能被耽誤。若負責人要「新的在上」，只改 `api.inbox_list` 的排序                                                                                       |
| 4   | 首頁區塊的順序放在 `me.capabilities` 的陣列順序                                                                                                                                            | 不必改 `me` 的回傳結構；順序仍由資料庫決定                                                                                                                                               |
| 5   | 方法的擋下是「送審時擋下」＋「記錄時回傳 close_export、畫面取消匯出」，不是資料庫直接改內容                                                                                                | 範圍修正規定方法不進內容；整理內容的 hook 只拿到內容，無從讀調查紀錄。內容的可否匯出仍只由申請人的版本決定，送審時一定一致                                                               |
| 6   | 匯出被引導關閉（目的是匯入另一個系統）時，內容仍留目的與頻率                                                                                                                               | 之後收斂需求要看得到「想匯入另一個系統」的申請；顯示摘要加註「已依引導改為只能查看」                                                                                                     |
| 7   | 畫面取消匯出後（方法是介面串接）內容不再帶目的、頻率；彙總的方法那一欄仍算到它                                                                                                             | 不匯出就不問調查（舊單不追加的同一條規則）；方法的紀錄還在                                                                                                                               |
| 8   | 新增核心動作 `report.mis_read` 與 `sgn_sdk.authorize_any`、`sgn_sdk.authorize_case`                                                                                                        | 「稽核與 MIS 可看」要兩個角色之一；流程包只能經 `sgn_sdk`，授權仍由 `denial_reason` 判斷                                                                                                 |
| 9   | 新增核心路由 `audit_exception_groups`，舊的 `audit_exceptions` 保留                                                                                                                        | 既有測試與紅隊腳本 47 讀舊的結構                                                                                                                                                         |
| 10  | 為了新的入口更新了兩個「完整清單」的架構測試（`70-business` 的狀態入口加 `api.case_discard`、稽核唯讀 function 加 `audit_exception_groups`）與契約測試（`90-contract` 實際呼叫兩個新路由） | 這些測試要求清單完全相等；是登記新入口，不是放寬                                                                                                                                         |

### 3.1 和 `rules.md` 的關係（沒有修改）

- `rules.md`「申請單不記錄媒介」（DA-NO-MEDIUM）：匯出的目的、頻率進了申請內容，方法沒有。條文要補一句（§5）。
- export-purposes.md 的 E1–E6 仍待負責人裁決；這一批只做到調查與引導，沒有做匯出形式（3.2）。

## 4. 威脅小表

每列的「測試」在拿掉那道防線時會失敗。

| 新機制                                | 誰能寫它                                                                   | 能否回捲                                                        | 空值、零筆、極大值                            | 舊但仍有效的輸入               | 它停掉時誰知道 | 測試                                          |
| ------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- | ------------------------------ | -------------- | --------------------------------------------- |
| 捨棄草稿 `case_discard`               | 只有申請人（授權入口 `discard`，actor_rule applicant），只有草稿（轉移表） | 不能：轉移表沒有 cancelled 的出口；內容與版本照樣保存，事件進鏈 | 送審過的單、已捨棄的再捨棄→`STATE_TRANSITION` | —                              | 同步           | `85` K-CASE-DISCARD                           |
| 清單順序、例外分組                    | 資料庫 function（唯讀）                                                    | —                                                               | 沒有工作的單不在待簽；沒有例外是兩個空陣列    | 舊的 `audit_exceptions` 保留   | —              | `85`、`e2e` K-HOME-ORDER                      |
| `reason_audience`                     | 由通知對象（`case_end_recipients`）扣掉操作者算出；不是授權判斷            | —                                                               | 沒有負責人時只剩申請人；都扣掉＝record        | —                              | —              | `85` K-REASON-AUDIENCE                        |
| `overlap_shown`                       | 資料庫依授權入口（`read`、`audit.read`）決定給不給單號與期間               | —                                                               | 沒有重疊檢查＝null                            | `overlap`（原樣）保留          | —              | `85` K-OVERLAP-SHOWN                          |
| 內容的 `export_survey`                | 只有整理內容的 hook（只留三個鍵、輸入的 method 丟掉）                      | 改調查＝擴大，從第一關重簽                                      | 缺目的或頻率→不能送審；不認得的代碼→錯誤      | 舊單沒有這個鍵：不重算、不追加 | —              | `85` DA-EXPORT-SURVEY（兩個）                 |
| 方法的調查紀錄 `export_method_record` | 能修改這張單的申請人（`sgn_sdk.authorize_case(…, 'revise')`）；別人 403    | 不能：擋 `UPDATE`、`DELETE`、`TRUNCATE`；以最新一筆為準         | 沒有紀錄＝沒填，送審擋下；其他沒寫說明→422    | —                              | 同步           | `85` DA-EXPORT-SURVEY、DA-EXPORT-SURVEY-GUIDE |
| 引導與擋下                            | 參數 `data_access.export_redirect_action`（只增不改）                      | —                                                               | block／warn 兩種                              | —                              | —              | `85` DA-EXPORT-SURVEY-GUIDE                   |
| 彙總                                  | 稽核或 MIS（`authorize_any`）                                              | —                                                               | 沒有單＝全部 0                                | —                              | —              | `85` DA-EXPORT-SURVEY-SUMMARY                 |

### 4.1 自認未解

- 方法是自填的調查，系統驗不到申請人實際怎麼帶走資料；擋下只擋「誠實填了介面串接」的人。真正的管控仍是可否匯出（使用方系統的義務）。
- 方法不在簽的內容裡：拿到後端與申請人工作階段的人可以代為記錄方法（不擴大權限，只影響彙總與引導）。
- 申請人在送審後改不了方法（只有 revise 權限的人能記）；退回後可以再記，以最新一筆為準。
- 單號跳號仍在（§3 #1）。

## 5. 需要負責人寫進 rules.md 的條文草稿

放在「需求單」的「可否匯出」與「不記錄媒介」：

> **申請單不記錄媒介**（補一句）：匯出需求調查的「目的」「頻率」是「為什麼、多常要帶走資料」，不是媒介，記在申請單上、簽核人會看到；「方法」（人工下載、排程檔案、介面串接）屬於取得的管道，不記在申請單上、不簽，只存成調查紀錄供彙總與引導。交給使用方系統的規則不因調查結果而不同，仍只有可否匯出。
>
> **匯出需求調查**：要匯出時必填目的、頻率、方法。目的是「匯入另一個系統」或方法是「介面串接到另一系統」時，不給匯出，引導那個系統自己當被授權者申請（D92 (7)）。能在系統內完成的目的提示替代做法。稽核與 MIS 可以看依目的、頻率、方法的彙總。

規則代碼（`sgn.rule`）：DA-EXPORT-SURVEY、DA-EXPORT-SURVEY-GUIDE、DA-EXPORT-SURVEY-RULES、DA-EXPORT-SURVEY-SUMMARY；核心 K-CASE-DISCARD、K-HOME-ORDER、K-REASON-AUDIENCE、K-OVERLAP-SHOWN。

## 6. 驗證結果

2026-11-21，停掉背景程式、`rm -rf .run` 之後以 root 跑 `tools/check.sh`：**全部通過**——資料庫測試 329（原 320；新增 `85-screens-survey` 9 個）、通行金鑰對照 16、端對端 43（原 38；新增 `system-screens` 5 個）、規則代碼 143（原 135；新增 8 個，每個都有測試）、sim/dc 照舊通過。

之後 `tools/run-all.sh --keep`（同樣 329／16／43 全過），`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` 依序跑 `redteam/exploits/[0-9][0-9]-*.mjs`（跳過 `00-*`，57 支）：**34、40、57 回 1，其餘 54 支回 0**，和這一批之前相同。沒有修改 `redteam/`。

為了新入口改動的既有測試（不是放寬）：`db/tests/kernel/70-business.test.mjs` 的兩個完整清單（狀態入口加 `api.case_discard`、稽核唯讀 function 加 `audit_exception_groups`）；`db/tests/kernel/90-contract.test.mjs` 實際呼叫兩個新路由（每個路由都要檢查過結構）。

過程中的插曲（不影響結果）：有一次在 `run-all.sh` 跑資料庫測試時同時跑了 `tools/check.sh --fast`（它的 plpgsql_check 會重建 `sgn_test`），那一輪 93 個失敗；重跑後全過。另一次跑攻擊腳本的迴圈把結束碼取錯（`$?` 被 `$(basename …)` 蓋掉），作廢後重起系統重跑，上面是重跑的結果。

## 7. 留給下一位

- 單號改成送審時取號（K-CASE-NUMBER）：要另開一個「送審號」並讓所有以單號為鍵的地方改用它，或接受跳號並改骨幹。
- export-purposes.md 的匯出形式（3.2）與 E1–E6 的裁決；彙總的畫面只有數字，沒有篩選與下載。
- 例外清單沒有處理入口與篩選（proposal.md 第 3 點的後半）；前綴仍是內部分類。
- 待簽清單沒有顯示「已等幾天」（排序的依據在畫面上看不到）。
- `docs/contract/02-pack-data-access.md` 還沒有寫進匯出調查的段落（內容的 `export_survey`、調查紀錄、引導）。
