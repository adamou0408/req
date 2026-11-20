# 待納入契約的增修

[00-spine.md](00-spine.md) v2 已納入原 A1–A24 中屬於骨幹的全部內容，以及 [reality-check/00-decisions.md](../reality-check/00-decisions.md) 第 3 節的骨幹修改清單；已納入的項目已從這裡刪除（A1–A5、A7、A10–A16、A18–A21、A23 整項刪除）。

下面是還沒完成的部分。每項寫明留下的原因；處理後從這裡刪除。

## 原增修中尚未完成的部分

| # | 還沒做的事 | 影響的文件 | 留下的原因 |
|---|---|---|---|
| A6 | 資料授權的人資（薪資、考績、健康檢查）與財會（未公告財報、總帳）資料領域：資料目錄種子、驗收案例、DC 模擬器與檔案式人資系統模擬器 | `02-pack-data-access.md`、`packs/data-access/acceptance-cases.md`、`sim/` | 屬於流程包契約與模擬環境，不是骨幹的內容。骨幹與種子名單只備妥前提：保密流程、依事件到期、知悉名單、受管系統 `hr_saas`。財會領域的主題包與資料擁有者要由 02 的作者提出後補進 `seed-directory.md` |
| A8 | 系統帳號與角色權限、程式變更上線、供應商銀行帳號變更三個流程包，以及治理範本包的 `docs/packs/<流程包>/rules.md` 與契約 | `docs/packs/*/rules.md`、契約 08–11 | 骨幹已納入它們需要的核心能力（緊急路徑、職責衝突矩陣、核決權限表、獨立驗證、當事人角色）。規則文件是業務規則的唯一來源，要先寫並經專案負責人確認 |
| A9 | 各契約完成後，依控制對照表逐列核對有沒有缺口 | 全部契約、`audit/control-matrix.md` | 骨幹層級已核對（骨幹附錄 A：46 個控制都有規則代碼）。契約層級要等契約寫完 |
| A17 | 在資料授權規則文件補充說明：資安合規檢查與執行設定是兩件事、由不同的人做；資料不經過 DC 的系統走自己的整合方式 | `packs/data-access/rules.md` | 規則文件不得由契約作者修改；骨幹的做法見骨幹第 19 節與附錄 B |
| A22 | 每個角色的方便程度都要有驗收標準 | `ux-acceptance.md` | 骨幹第 10 節只固定各角色的畫面與歸屬的畫面規格。驗收任務要另外寫進 `ux-acceptance.md`（至少增加：從零找到正確流程、看懂退回並修正、手機設代理、手機核准設定變更、流程管理者建流程、系統管理人回報完成與上傳對帳檔、技術維運判讀狀態、第一天體驗、螢幕報讀軟體走完關鍵任務） |
| A24 | 在資料授權規則文件補充四項已裁決的缺漏（撤銷後收回外部設定、目錄調高分級後重新核准、L4 不能申請匯出、現任資料擁有者可撤銷） | `packs/data-access/rules.md` | 骨幹已納入（`K-RECLAIM`、`K-REAPPROVE`、`K-REVOKE`）；規則文件的補充說明尚未寫 |

## 骨幹改寫後要同步的其他文件

| # | 文件 | 要改的地方 |
|---|---|---|
| B1 | `platform-vision.md` | 「多公司（多租戶）不在第一版範圍」改為「雲端多租戶的資料隔離不在第一版」；「流程定義由流程包的升版腳本載入」「不提供拖拉式的流程設計器」「流程包的領域邏輯寫成 SQL function」改為宣告優先、設定變更走簽核、結構化流程編輯器；「手機核准與 MFA」改為決定證明；第一版流程包改為五種加治理範本；文件地圖依骨幹第 21 節 |
| B2 | `engineering-standards.md` | 架構測試的 `p_actor` 改為 `p_session`；`sgn.error_catalog` 改為 `sgn.message_catalog`；「路徑只能透過 migration 變更」刪除；錯誤由 `guard` 轉成結果信封；連線角色與 schema 依骨幹 1.1；port 清單增加金鑰與機密內容、錨定位置、通知通道、翻譯、附件掃描、簽章、機密來源、可列印檔；介面文案改為語言包；增加受保護路徑與發行流程；「只用 `pgcrypto`」視驗章效能的技術驗證結果決定；workspaces 增加 `vault` |
| B3 | `audit/control-matrix.md` | 「平台怎麼做到」與「缺口」欄依骨幹附錄 A 更新；`K-MOBILE-MFA`、`K-SETTING-ADMIN` 改為新代碼 |
| B4 | `research/00-synthesis.md` | R-N02、R-N09、R-N13 加註被裁決限縮 |
| B5 | `02-pack-data-access.md`、`03-pack-seal.md`、`05-integration.md` | 依骨幹 v2 改寫；更名與刪除的對照見骨幹附錄 C。03 改為完全宣告。05 的檢查點併入核心的 `audit_checkpoint`，複查未回應改為先升級再暫停，寫入類範圍改用 `private_key_jwt` |
| B6 | `sim/ldap/seed-ldif.mjs` 與 `sim/` | 種子名單已增加公司、員工編號、email 欄與 9 位人員，產生器目前仍可解析，但應改為直接讀這些欄位；外部人員、受管系統、SCIM／CSV 來源、錨定位置、機密內容服務等新的模擬對象依骨幹第 12 節補上 |
| B7 | `packs/data-access/acceptance-cases.md`、`packs/seal/acceptance-cases.md` | 種子名單取消 `sys_admin`；agent 增加結束日；單號格式改為含公司代碼；MIS 的合規檢查與執行拆成兩個人 |

## 需要專案負責人決定或確認

| # | 事項 |
|---|---|
| C1 | 骨幹附錄 B 的十七項「與流程包規則的出入」：其中標「需確認」的五項（改組是否算解散、完全涵蓋的範圍、上線範圍、印鑑管理人能否取消、金額調降後略過財務長關）需要決定 |
| C2 | 00-decisions 第 5 節的十項取捨（全員登記 passkey、預設保存 5 年、多一個機密內容服務、卡住的單不能靠管理員解、資料授權沒有先給後審、批次與複查沒有全選等） |
| C3 | 骨幹為裁決已決定但沒有命名的規則補上的 33 個代碼：`K-SESSION`、`K-NAMED-ACCOUNT`、`K-EXTERNAL-SPONSOR`、`K-PRIVACY-NOTICE`、`K-SOD-CONFLICT`、`K-ROLE-SOURCE`、`K-AUTHORITY-MATRIX`、`K-ASSISTANT`、`K-RECALL`、`K-CANCEL`、`K-CONVERT`、`K-RENEW`、`K-REUSE`、`K-PRINCIPAL`、`K-EFFECTIVE-DELAY`、`K-GRANT-REDUCE`、`K-RECLAIM`、`K-REAPPROVE`、`K-INACTIVE`、`K-AUDIT-SNAPSHOT`、`K-ACCESS-LOG`、`K-SUBJECT-RESTRICT`、`K-EXPORT`、`K-CONFIDENTIAL`、`K-KEY-CUSTODY`、`K-ROLLOUT`、`K-CORRECTION`、`K-BREAKGLASS`、`K-NOTIFY-DELIVERY`、`K-REVIEW-CYCLE`、`K-CHECK`、`K-EVENT-DELIVERY`、`K-RECON-COVERAGE`；以及 `K-HR-*`、`K-DETECT-*` 兩個系列的個別代碼。不同意時指出代碼即可 |
| C5 | 骨幹自行決定、裁決沒有明文的設計：(1) 申請人「撤回」是把單取回成 `returned`，不是終止；(2) 存續型授權在執行完成且驗證通過時建立，確認在生效後進行；一次性許可在核准完成時建立；(3) 技術維運角色的持有人不會被解析為任何關卡的決定者；(4) 縮小使級別降低時，尚未開始的關卡依新級別重新套用；(5) 生效中的授權可以縮小（`K-GRANT-REDUCE`）；(6) 職責衝突矩陣的實體 `sod_conflict_rule` 與規則 `K-SOD-CONFLICT`；(7) 沒有依據的新預設值：`grant.reapproval_grace_days` 30、`grant.one_time_max_hours` 72、`confirmation.remind_every_workdays` 2；(8) 資料表實體名稱 `case_file`、`grant_record`，`error_catalog` 改名 `message_catalog`，流程包只經 `sgn_sdk` 接觸核心 |
| C4 | 資料庫內以 PL/pgSQL 驗章的效能技術驗證（門檻：單次 p95 小於 150 毫秒）；不達標時要放寬工程規範 |
| A25 | 測試報告（用途證明）層：測試環境以遮罩資料同結構執行；有簽章的測報（申請 vs 用到、未用到的欄位、查詢結果、環境與雜湊）；正式申請參照測報並在簽核畫面並排顯示；非人類與固定應用為硬關卡、含例外路徑；人的探索性存取不強制；接「程式變更上線」流程 | 00-spine（選項、流程包介面）、01-kernel、02、04-screens、packs/data-access/rules.md（補充） | decision-log D64 |
