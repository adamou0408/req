# 待納入契約的增修

契約草稿撰寫期間新增的要求。交叉審查與修訂時逐項納入對應的契約文件，納入後從這裡刪除。

| # | 要求 | 影響的契約 | 來源 |
|---|---|---|---|
| A1 | 對外整合介面（判定、查詢、事件、對帳、定期複查、證據輸出）與兩個新 hook | 01-kernel（與 05-integration 對齊）、02、03 | 00-spine 第 11 節 |
| A2 | 稽核過關：一鍵稽核資料包（期間內全部申請單的清單並可證明沒有遺漏、每張單的完整紀錄、例外清單）；稽核準備度畫面（未結案的例外） | 01-kernel、04-screens | platform-vision |
| A3 | 申請單保密：流程類型可宣告內容保密；保密的申請單只有申請人、被指派的簽核人與執行人、稽核看得到內容；清單與通知遮蔽摘要；MIS 群組未認領前只看得到必要資訊 | 00-spine（選項）、01-kernel、04-screens | validation-cases |
| A4 | 查閱紀錄：查看申請單詳情與證據頁都寫入稽核事件 | 01-kernel | validation-cases |
| A5 | 依事件到期：授權可以綁定一個到期事件（日期由擁有者或流程包設定，例如財報公告日）；事件發生時失效或降級 | 00-spine、01-kernel、02 | validation-cases |
| A6 | 資料授權的資料領域擴充：人資（薪資、考績、健康檢查）、財會（未公告財報、總帳）加入資料目錄的種子資料與驗收案例；人資案例驗證 A3、A4，財會案例驗證 A5 與知悉人員名單 | 02、data-access 的 acceptance-cases、DC 模擬器 | validation-cases |
| A7 | 人工的獨立驗證：驗證步驟可設定為由未參與簽核與執行的人確認 | 00-spine、01-kernel | validation-cases |
| A8 | 五種流程都納入第一版：新增程式變更上線、系統帳號與角色權限、供應商銀行帳號變更三個流程包的規則與契約；核心新增緊急路徑、職責衝突矩陣、核決權限表（resolver 種類） | 00-spine、01-kernel、新的流程包契約 | decision-log D13 |
| A9 | 調查結論（docs/research/00-synthesis.md）與控制對照表（docs/audit/control-matrix.md）完成後，逐項核對契約有沒有缺口 | 全部 | platform-vision |
| A10 | 設定變更走簽核：流程定義、路徑、參數、角色指派的修改都是「設定變更申請單」（雙人覆核、版本、生效時間、影響試算、回復）；提供管理畫面 | 00-spine、01-kernel、04-screens | decision-log D12 |
| A11 | 宣告式流程定義：分級規則、各欄位的縮小方向、重複判斷的鍵、摘要欄位都可在流程定義中宣告；hook 只在宣告不足時使用。合約用印改為完全宣告、不寫 hook | 00-spine、01-kernel、03 | decision-log D14 |
| A12 | 集團多公司：公司別作為核心維度（流程、路徑、參數、角色、行事曆、可見範圍）；跨公司的申請與簽核 | 00-spine、01-kernel、04-screens、seed-directory | decision-log D15 |
| A13 | 補齊簽核動作：駁回、提問與回覆、加簽、轉簽、撤回，各有規則代碼與紀錄；狀態機與畫面對應更新 | 00-spine、01-kernel、04-screens | decision-log D16 |
| A14 | 多語：文案與通知範本採多語架構，提供繁體中文與英文 | 01-kernel（通知範本）、04-screens | decision-log D17 |
| A15 | 真實情境檢查的裁決結果（docs/reality-check/00-decisions.md）逐項納入 | 全部 | decision-log D18 |
| A16 | 受管系統（`resource_system`）：業務擁有單位、系統管理人角色（依系統指派，可為外部人員）、整合方式（api／file／manual）、平台維運能否查閱內容；資源（例如主題包）隸屬於受管系統；執行、驗證、對帳依系統的管理人與整合方式進行 | 00-spine、01-kernel、02、05-integration、seed-directory | decision-log D19、D21 |
| A17 | 資料授權的最後一關拆成兩件事：資安合規檢查（資安或 MIS）與執行設定（該系統的管理人）。資料不經過 DC 的系統（例如外購的人資系統）走自己的整合方式 | packs/data-access/rules.md（補充說明，不改既有規則）、02 | decision-log D19 |
| A18 | 外部人員：廠商人員可以作為執行人，必須有內部保證人、有期限、只看得到執行所需的最少內容；帳號來源可以不在公司的身分系統內 | 00-spine、01-kernel、04-screens | decision-log D19 |
| A19 | 機密欄位：流程類型可標示機密欄位，寫入資料庫前加密，金鑰由金鑰 port 提供且不存放在資料庫；分級與摘要只能使用非機密欄位或在加密前算出的衍生值；維運與資料庫管理員讀不到 | 00-spine、01-kernel、後端、engineering-standards（port 清單） | decision-log D20 |
| A20 | 平台管理角色分離：技術維運、流程管理（可依公司別、流程類型、受管系統委派給業務單位）、稽核；取代單一的 `sys_admin` | 00-spine、01-kernel、seed-directory | decision-log D20 |
| A21 | 檔案與人工的整合方式：權限清單檔案上傳對帳；人工執行後由未參與的人獨立驗證；證據格式與 API 方式一致 | 05-integration、01-kernel | decision-log D21 |
| A22 | 每個角色的方便程度都要有驗收標準：申請人、簽核人、資料或系統擁有者、系統管理人（含業務單位與外部廠商）、流程管理者、稽核、技術維運 | ux-acceptance、04-screens | decision-log D22 |

