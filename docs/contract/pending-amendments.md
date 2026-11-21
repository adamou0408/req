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

## D91 的契約增修

依據：`docs/decision-log.md` D91。使用方系統要照做的事列在 [06-consumer-obligations.md](06-consumer-obligations.md)；這一節只寫**契約還沒有**的三件事，定案後分別併入標示的契約，併入後從這裡刪除。規則代碼、參數、錯誤代碼都是建議名稱，登記時以 `sgn.rule`、`sgn.setting_definition`、`sgn.message_catalog` 為準。

共通前提：已套用的 migration 不改，全部以新檔案加上 `create or replace` 完成；核心不得出現流程包代號，所以凡是「目錄」「欄、列」的判斷都放在流程包，核心只加通用的 hook。

### D91-a 資料目錄版本綁定

併入：`02-pack-data-access.md` §4.2、§5.1、§5.6、§5.10、§8.5；`00-spine.md` §6.4（兩個新 hook）。

**版本怎麼產生**

| 項目 | 規定 |
|---|---|
| 資料表 | `pack_data_access.catalog_version`（`version_no` 遞增、`catalog_sha256` 唯一、`snapshot` 完整快照、`source`、`created_at`、`created_by` 或同步批次）。只增不改，擋 `UPDATE`、`DELETE`、`TRUNCATE` |
| 何時產生 | `catalog_load` 每次套用快照後算雜湊；與目前版本不同才新增一列並寫稽核事件 `data_access.catalog_versioned`（新舊雜湊、差異筆數）。相同則不新增 |
| 雜湊範圍 | 每個主題包的 `code`、`name`、`system`、`period_field`；欄位的 `code`、`name`、`classification`；列條件的 `code`、`name`、`value_type`；列舉值的 `value`、`label`。**不含**擁有者（角色指派另有紀錄）、說明文字、排序 |
| 正規化 | 主題包、欄位、列條件依 `code` 排序，列舉值依 `value` 排序，停用的項目不列入；以核心的 JCS（`db/kernel/05_jcs.sql`）序列化後取 SHA-256，輸出小寫十六進位。使用方系統用同一個算法（測試向量放 `db/tests/packs/data_access/fixtures/`，兩邊共用） |
| 引用摘要 | `pack_data_access.catalog_ref_sha256(p_content, p_version_no)`：只取這份申請內容引用到的主題包、欄位、列條件與列舉值，在指定版本的快照上以同樣方式算雜湊。用來判斷「目錄改了，但這張單引用的部分有沒有變」 |

**綁在哪、怎麼進入簽的內容**

- `normalize_content` 在整理後的內容加上 `catalog: {"version_no", "sha256"}`，值是整理當下的目前版本。每一個內容版本（建立、儲存、送審、退回後修改、簽核人縮小、生效後縮小）都重新整理，所以**送審的那一版綁的就是送審當下的目錄**。
- `version_sha256` 是 `{content, terms}` 的雜湊（`db/kernel/160_case_flow.sql` 的 `version_prepare`），`catalog` 在 `content` 裡，所以自動被涵蓋，核心不用改。
- `display_content` 增加一行「資料目錄第 N 版（雜湊前 12 碼）」，因此顯示摘要（`display_sha256`）也涵蓋；簽核人簽的內容＝`version_sha256`＋`display_sha256`，兩者都帶目錄版本。
- `compare_content` 忽略 `catalog` 這個鍵本身（版本號不同不算擴大）；引用的項目有沒有變，由下面「目錄改版時」處理。
- **舊單**：這次增修之前建立的內容版本沒有 `catalog` 鍵，已存的 `version_sha256` 不重算、不補簽。升版的 migration 為每張未結束的單記一筆基準（`pack_data_access.catalog_baseline`：單、內容版本、當時的目錄版本、`basis = 'baseline'`）並寫稽核事件；基準只用來偵測之後的目錄異動，畫面與證據頁標示「目錄版本為事後記錄，不在簽核內容內」。舊單下一次產生新內容版本（續期、縮小）時自然綁定。

**交付與回報**

| 環節 | 內容 |
|---|---|
| 交付 | `build_fulfilment` 的輸出加 `catalog: {"version_no", "sha256"}`（舊單取基準；值在已簽章的信封裡） |
| 使用方回報 | 套用、驗證、對帳三種回應的 `result` 都加 `catalog_sha256`（使用方當時用的目錄版本），在證明（attestation）涵蓋的範圍內。使用方的代碼對實體欄位的對照有變動時，必須讓它的目錄版本跟著變（做法：對照表的雜湊併入它自己的版本來源，並重新匯出目錄給平台） |
| 平台判定 | 新 hook `check_delivery_result(p_case_id, p_kind, p_result) returns jsonb`（核心在採信證明之後、分類結果之前呼叫；回 `null` 表示接受，否則回規則代碼與說明，核心照「外部系統拒絕」處理：不生效、撤回、開例外）。資料授權的實作：回報的版本平台不認得，或在該版本上算出的引用摘要與綁定版本的不同 → 不接受 |
| 對帳 | 新 hook `check_reconciliation_report(p_channel, p_report) returns jsonb`：回報的版本平台不認得，且超過 `data_access.catalog_unknown_grace_minutes` → 每個通道開一筆例外，並觸發一次目錄同步 |

**例外**

| 規則代碼 | 何時開 | 處理 |
|---|---|---|
| `DA-CATALOG-MISMATCH` | 套用或驗證的回報：引用摘要不同 | 這張單不生效、撤回已送出的部分（沿用 `fulfilment_fail`），通知執行關的管理人與資料擁有者 |
| `DA-CATALOG-UNKNOWN` | 回報的版本平台不認得（平台同步落後，或使用方改了對照） | 寬限時間內重送；逾時開例外並通知系統管理人。每個通道同時只有一筆 |
| `DA-CATALOG-DRIFT` | 目錄改版影響到進行中或生效中的單（見下） | 依下表 |

**目錄改版時**（新版本產生的同一個交易內，逐張比較舊綁定版本與新版本的引用摘要；相同就不動）

| 單的狀態 | 引用的項目怎麼變 | 處理 |
|---|---|---|
| 草稿、已退回 | 任何 | 不動；下次儲存或送審時重新整理並綁新版本 |
| 簽核中 | 項目被停用 | 重新整理成新版本（既有行為：移除並提示），屬縮小，從目前關卡繼續，通知申請人 |
| 簽核中 | 分級調高、名稱或標籤改變、型別或值域改變 | 重新整理成新版本，視為無法判定（`DA-CHANGE-COMPARE`：無法判定一律算擴大），從第一關重簽；差異畫面標示「資料目錄異動」 |
| 待套用、驗證中 | 任何 | 作廢未完成的交付，回到簽核中並依上兩列處理 |
| 生效中 | 分級調高 | 依核心 `K-REAPPROVE`（`grant.reapproval_grace_days` 內依新級別重新核准，逾期撤銷） |
| 生效中 | 項目被停用 | 開 `DA-CATALOG-DRIFT`，系統送出縮小後的新版本（`K-GRANT-REDUCE` 的路徑），通知負責人與資料擁有者 |
| 生效中 | 只有名稱或標籤改變 | 開 `DA-CATALOG-DRIFT`，資料擁有者在 `data_access.catalog_rename_confirm_workdays` 內確認「意義沒有改變」（確認進稽核鏈）；確認後系統以新目錄版本產生新的內容版本並重送；逾期升級，不自動撤銷 |

這張表取代 02 §4.2 的 `impacts` 判定方式（改以引用摘要判斷受影響的單）；通知範本沿用 02 §7.6 的 `data_access.catalog_sync_impact`。

| 類別 | 新增 |
|---|---|
| 規則代碼 | `DA-CATALOG-VERSION`（目錄每次異動產生新版本，只增不改）、`DA-CATALOG-BOUND`（每個內容版本綁定整理當下的目錄版本，進入簽核內容）、`DA-CATALOG-MISMATCH`、`DA-CATALOG-UNKNOWN`、`DA-CATALOG-DRIFT` |
| 參數 | `data_access.catalog_unknown_grace_minutes`（整數，預設 60，可依通道）、`data_access.catalog_rename_confirm_workdays`（整數，預設 5，可依級別） |
| 錯誤代碼 | `DA-E-CATALOG-HASH`（匯入的快照自帶的雜湊與平台算的不同，422）、`DA-E-CATALOG-VERSION-MISSING`（交付時找不到綁定的版本，500） |
| 測試 | 每個規則代碼一個資料庫測試；另加：相同快照不產生新版本；雜湊與排序、停用項目無關（測試向量）；`version_sha256` 隨目錄版本改變；舊單的雜湊在升版前後相同；`compare_content` 忽略 `catalog`；引用摘要在無關的主題包變動時不變；`sim/dc` 新增 `11-catalog-version`（回報版本、對照變動使版本改變）；`93` 新增不一致與不認得兩個案例 |
| 與 `rules.md` | (1) `rules.md` 沒有規定目錄異動後的處理（A24 的缺漏之一只涵蓋分級調高）；上表「只有名稱或標籤改變」「項目被停用」兩列是新的業務規則，需要負責人確認後補進 `rules.md`。(2) `rules.md`「主題包、欄位、分級、擁有者以 DC 為準」：版本因此應該由 DC 的匯出帶出、平台驗算，而不是平台單方面產生；現況目錄只由種子載入，沒有同步（`db/packs/data_access/010_catalog.sql` 檔頭），所以 D91-a 以 02 §4.2 的同步先做完為前提。(3) 生效中的單因停用項目而由系統縮小，與「人做決定，系統只執行」不衝突的前提是紀錄寫明依據的規則代碼與目錄版本 |
| 相依 | 核心的 `K-REAPPROVE` 還沒有實作；生效後縮小只有資料庫入口。兩者是這張表最後三列的前提 |

### D91-b 團隊類被授權者對應目錄群組

併入：`00-spine.md` §2（`principal`、`principal_member`、`principal_identity`）、§5.6；`05-integration.md` §3.2、§6.5；`02-pack-data-access.md` §5.10；契約 01c。不新增身分體系。

**資料模型**

| 實體 | 規定 |
|---|---|
| `sgn.principal`（已有） | 團隊的 `source` 是目錄來源代碼（`sgn.directory_source`），`external_ref` 是群組在目錄上**不會隨改名改變**的識別碼（AD 的 `objectGUID`、LDAP 的 `entryUUID`；由 adapter 決定取哪個屬性）。`(source, external_ref)` 已經唯一。團隊只能由目錄同步建立與結束，畫面不能建團隊（專案與 agent 照舊） |
| `sgn.principal_member`（骨幹已定義、未實作） | 人、被授權者、種類、生效起迄（雙時間）、來源。團隊的成員列只有目錄同步能寫 |
| `sgn.principal_identity`（骨幹與 05 §11.2 已定義、未實作） | 每個身分來源一列：使用方系統認得的群組識別碼（例如群組的 DN 或帳號名稱）。寫入來源依 05 §3.2 的 `K-INT-IDENTITY`（只有同步或經覆核的變更申請） |
| 同步入口 | 沿用 `api_sync`：新增 `api_sync.directory_groups_apply(p_source, p_kind, p_total, p_entries)`，項目是 `{external_id, name, identities[], owner_external_id, members[]}`。防護沿用人員同步的做法（`db/kernel/230_directory_sync.sql`、`280_directory_guard.sql`）：完整快照的差異超過 `directory.full_snapshot_max_change_percent` 整批拒絕並開例外 |
| 負責人 | 取目錄上群組的管理者屬性（adapter 對應）；目錄沒有時維持平台上指定的負責人。兩種來源都受 `K-OWNER-CONTINUITY` 約束 |
| 群組消失 | 連續 `principal.group_missing_rounds` 輪完整同步都沒有這個群組才結束團隊，結束時依 `rules.md`「團隊解散時，相關授權自動撤銷」 |

**成員異動**

- 每一筆加入與移除，在同步的同一個交易內寫稽核事件 `principal.member_added`／`principal.member_removed`（被授權者、人、目錄來源、同步批次、目錄上的生效時間）。
- 通知：同一次同步、同一個被授權者合併成一則，寄給負責人（範本 `principal.membership_changed`，列出加入與移除的人）。這個被授權者沒有進行中或生效中的授權時不通知，只留紀錄。
- 對外：05 §7.1 的 `sgn.principal.membership_changed` 事件（05 實作後）。
- 移除不需要任何人確認（骨幹 `K-MEMBER-REDUCE`）。

**要負責人重新確認的情況**（全部是參數；任一成立就開一件「成員確認」待辦給負責人）

| 參數 | 型別與預設 | 意思 |
|---|---|---|
| `principal.member_reconfirm_added_count` | 整數；全域 5，級別 L4 設為 1 | 一次同步加入的人數達到這個數字。以被授權者目前有效授權的最高級別取值 |
| `principal.member_reconfirm_added_percent` | 整數；20 | 上次確認以來累計加入的人數，占上次確認時人數的百分比 |
| `principal.member_reconfirm_outside_unit` | 布林；true | 加入的人不在負責人所屬單位的子樹內，或是外部人員 |
| `principal.member_reconfirm_on_rename` | 布林；true | 群組改名（名稱在簽核人看到的顯示摘要裡） |
| `principal.member_reconfirm_single_member` | 布林；true | 成員只剩一人（實質上是對個人授權） |
| `principal.member_reconfirm_workdays` | 整數；5 | 確認的期限 |
| `principal.member_reconfirm_overdue_action` | `revoke` 或 `exception`；`revoke` | 逾期：先升級給負責人的主管，再過一個期限仍未確認時，撤銷這個被授權者的全部授權，或只留例外 |

確認是決定類動作（需要決定證明），內容綁定當時的成員名單雜湊；負責人可以選「確認」或「撤銷全部授權」。確認與負責人的代填確認（`rules.md`「代填申請」）是兩件事。

**交付**

- 帶群組識別，不帶成員清單：`build_fulfilment` 的 `grantee` 增加 `identities: [{"provider", "external_id"}]`，取該受管系統登記的身分來源（新參數 `delivery.subject_provider`，依通道）在 `principal_identity` 的對應；`principal_id` 保留。沒有對應時不交付，開例外 `K-PRINCIPAL-IDENTITY-MISSING`。
- 使用方系統把規則掛在同一個群組上，存取當下向目錄確認成員；對帳回報的主體用同一個身分來源的識別碼（05 §3.2）。
- 識別碼改變：平台以新識別碼送出新版本並撤回舊的（05 §3.2 已規定要發事件、阻止相關對帳發現自動結案）。

**與既有契約的出入（要改 05，不是 `rules.md`）**

- 05 §3.2 最後一段寫「成員名單以本平台的 `principal_member` 為準，使用方的 LDAP 群組與它不一致時依 `principal_member`」。D91 決定使用方認同一個目錄群組，所以改成：團隊的 `principal_member` 是目錄群組的同步副本，權威來源是目錄；兩者的差異只來自同步延遲。05 §6.5 的成員端點保留給不能直接查目錄的使用方。
- 骨幹 §2 寫 `principal_identity` 是「在各受管系統上的識別碼」，05 §3.2 寫的是「各身分來源的識別碼」；以 05 為準，骨幹的說明要改。

| 類別 | 新增 |
|---|---|
| 規則代碼 | `K-PRINCIPAL-GROUP`（團隊只由目錄群組同步產生與結束）、`K-MEMBER-SYNC`（團隊成員只由目錄同步寫入，每筆異動進稽核鏈並通知負責人）、`K-MEMBER-RECONFIRM`（達到參數條件時由負責人重新確認，逾期依參數處理）、`K-PRINCIPAL-IDENTITY-MISSING`；既有的 `K-MEMBER-REDUCE`、`K-INT-IDENTITY` 不變 |
| 參數 | 上表七個，加 `principal.group_missing_rounds`（整數，預設 2）、`delivery.subject_provider`（文字，依通道，沒有預設：沒設定就不交付） |
| 錯誤代碼 | `PRINCIPAL_TEAM_SYNC_ONLY`（從畫面建立或修改團隊，409）、`PRINCIPAL_MEMBER_SYNC_ONLY`（409）、`MEMBER_RECONFIRM_NOT_OWNER`（403）、`MEMBER_RECONFIRM_STALE`（名單在確認前又變了，409） |
| 測試 | 每個規則代碼一個資料庫測試；另加：同一份快照送兩次不產生事件；差異超過門檻整批拒絕；每個重新確認條件各一個；L4 的門檻取到 1；逾期的兩種處理；群組少一輪不結束、少兩輪結束並撤銷；交付內容帶群組識別且不帶成員；沒有對應不交付。`sim/ldap` 補群組的管理者與穩定識別碼；`sim/dc` 補「以登入帳號經群組成員身分取得規則角色」的案例；`79-directory-sync` 加群組 |
| 與 `rules.md` | (1) `rules.md`「團隊：讀取組織資料」沒有說是組織單位還是目錄群組；D91 定為目錄群組，`rules.md` 要補一句（不衝突，但現在的寫法會被讀成組織樹）。(2) 目錄群組的成員可以由目錄管理員或群組管理者直接加入，不一定經過人事事件；加人等於不經簽核取得資料。`rules.md` 原則 ③「任何擴大都從第一關重簽」沒有把成員增加算進去，骨幹 `K-MEMBER-EXPAND` 也只管專案與 agent。上面的「重新確認」是折衷，**是否足夠需要負責人裁決**。(3) 逾期預設 `revoke` 是依原則 ①「一律從嚴」推的，`rules.md` 沒有這條規則。(4) 群組消失要等兩輪才撤銷，比 `rules.md`「自動撤銷」慢一輪同步的時間。(5) 「改組是否算解散」仍是 C1 的未決事項 |
| 相依 | `principal_member`、`principal_identity`、`K-OWNER-CONTINUITY`、`K-MEMBER-*` 在資料庫都還沒有實作；現在的被授權者只由種子建立 |

### D91-c 使用方系統的能力宣告

併入：`02-pack-data-access.md` §7.1、§5.2、§5.6、§5.11；`00-spine.md` §19（`resource_system`）。

**資料放哪**

能力是參數，不新增資料表：流程包登記 `data_access.capability.*`，適用範圍是受管系統（`system:<代碼>`，與 `delivery.mode` 相同的範圍種類），值帶生效時間、只增不改（`sgn.setting_value`）。骨幹 §19 的 `resource_system` 實作後，這些參數仍以它的代碼為範圍，不搬家。

| 參數 | 型別 | 預設 | 宣告為「做不到」時 |
|---|---|---|---|
| `data_access.capability.column` | 布林 | false | 這個系統上的主題包只能整包給；申請選了部分欄位時提示 |
| `data_access.capability.row` | 布林 | false | 列條件不會被執行；申請帶列條件時提示 |
| `data_access.capability.data_period` | 布林 | false | 資料期間不會被執行；提示 |
| `data_access.capability.validity` | 布林 | false | 到期不會自己擋下；提示，並在到期時比照人工執行開例外（`K-DELIVERY-MANUAL` 的做法） |
| `data_access.capability.export` | 布林 | false | 分不出查詢與匯出；這個系統上的主題包關閉「可否匯出」欄位（`rules.md`「需求單」、open-questions M5） |
| `data_access.capability.usage_log` | 布林 | false | 沒有使用紀錄；提示，定期複查時標示「沒有使用資料」 |

- **預設一律 false**：沒有宣告的系統視為做不到（從嚴），送審畫面會全部提示，逼著先宣告。示範種子把 `dc` 的六項都設為 true（負責人：現有的系統都做得到）。
- **誰能改**：由該受管系統的管理人提出；false 改 true 會讓提示消失，屬放寬，要由提出人以外的人覆核（骨幹 §18.3 的設定變更）。每次變更進稽核鏈。現況沒有任何對外的參數變更入口（參數值只由 migration 與種子寫入），所以在骨幹 §18.3 實作之前，能力只能由種子或 migration 設定，這一點要寫進交接。
- **使用方自己的宣告**：使用方系統提供能力查詢（建議 `GET {base}/capabilities`，回應帶證明），對帳程式每一輪一併取回，交給新 hook `check_reconciliation_report`（與 D91-a 同一個）。平台登記為 true 而使用方回報 false → 開例外 `DA-CAPABILITY-MISMATCH`。反過來不開例外（平台比較保守）。
- **宣告是否屬實**：由既有的自動驗證證明（`DA-VERIFY-CASES` 的反例就是在測欄、列、期間、匯出、到期）。宣告做不到的面向不產生對應的反例，並在驗證結果標示「這個系統不執行此限制，未驗證」。

**送審畫面的落差提示**

- `normalize_content` 對每個主題包所在的系統取能力，申請用到做不到的面向時加一則提示（`DA-N-CAPABILITY-GAP`：系統名稱、哪個面向、後果）。提示隨內容版本保存。
- `display_content` 把落差列進顯示摘要，所以每一位簽核人看到並簽到的內容都包含「這個限制不會被執行」。
- 要不要擋下送審是參數 `data_access.capability_gap_action`（`warn` 或 `block`，可依級別；預設 `warn`）。
- 前端只顯示後端回傳的提示，不自己依能力推斷。

| 類別 | 新增 |
|---|---|
| 規則代碼 | `DA-CAPABILITY-DECLARE`（每個受管系統宣告做得到的限制，沒有宣告視為做不到）、`DA-CAPABILITY-GAP`（申請用到做不到的面向時提示並進入簽核內容；依參數擋下）、`DA-CAPABILITY-MISMATCH` |
| 參數 | 上表六個，加 `data_access.capability_gap_action` |
| 錯誤與訊息 | `DA-E-CAPABILITY-GAP`（`block` 時送審被擋，422）、`DA-N-CAPABILITY-GAP`（提示）、`DA-T-VC-UNENFORCED`（驗證結果的標示文字） |
| 測試 | 每個規則代碼一個資料庫測試；另加：沒有宣告的系統每個面向都提示；`export` 為 false 時匯出欄位被關閉並提示；一張單跨兩個能力不同的系統時只提示做不到的那一個；提示出現在顯示摘要並改變 `display_sha256`；做不到的面向不產生反例；架構測試：SQL 裡不得出現寫死的系統代碼。`sim/dc` 新增能力查詢與一個「不能擋列」的實例設定，供端對端測試落差提示 |
| 與 `rules.md` | (1) 原則 ①「一律從嚴」：做不到的限制只提示而仍可核准，比「擋下」寬；D91 的指示是提示落差，所以預設 `warn`，**L4 要不要預設 `block` 需要負責人裁決**。(2) `rules.md`「不做的事」的前提是所有管道都經過 DC（M4）；能力宣告沒有涵蓋「有沒有繞過的管道」，那仍然只能靠 M4 的答案。(3) `export` 做不到時關閉欄位，與 `rules.md`、M5 一致 |

### D91 盤點時發現、不在上面三項內的缺口

這些在 [06-consumer-obligations.md](06-consumer-obligations.md) 標為「無契約」或「有契約」但與現況不同；先記在這裡，不在這次增修內解決。

| # | 缺口 | 位置 |
|---|---|---|
| G1 | 使用紀錄：05 §5.7 是為數量限制（用印份數）設計的，每筆權限項目有筆數上限、每筆回報寫一筆稽核事件，沒有「實際操作的人」與批次回報；骨幹 §11 的「用量回報」則寫成「最後使用時間」。資料授權逐筆查詢的量與內容（誰、查詢或匯出、欄位、筆數）需要流程包定義 `context` 的鍵，並決定高用量時的做法 | 05 §5.7、§15.3；骨幹 §11 |
| G2 | 對帳有兩套：05 §8 是使用方以 `api_client` 推送批次，發現分五類、有指派與獨立確認；現有實作（`db/kernel/440`、`485`）是平台拉取帶證明的回報，規則代碼是 `K-RECON-*`、例外分三類、連續幾輪沒看到就結案。兩套的代碼、資料表（同名的 `reconciliation_run`、`reconciliation_finding`）、結案規則都不同，要收斂成一套 | 05 §8、§11.7；`docs/handoff/delivery.md` §4 |
| G3 | 交付信封與回應證明的格式只寫在 `sim/dc/README.md` 與 `db/kernel/405` 的註解；02 §8.1、§8.5 還是舊的（`dc_rule_set/1`、三個方法的 port、沒有信封與證明）。格式代碼實際是 `data_access_rule_set/1` | 02 §8；`docs/handoff/sim-dc.md`「與契約不同的地方」 |
| G4 | 規則裡沒有權限項目的 id；05 §8.3 的逐筆比對與 §5.7 的用量回報都以它為鍵。05 的投影（`sgn.entitlement`）還沒有實作 | 05 §3、§8.3 |
| G5 | L1、L2「自動開放」在使用方系統上怎麼落地 | `docs/handoff/sim-dc.md`「限制」 |
| G6 | 使用方回報的 `superusers`、`rls_disabled`（能繞過限制的帳號與資料表）平台收下但沒有比對 | `sim/dc/README.md`「對帳回報」 |
