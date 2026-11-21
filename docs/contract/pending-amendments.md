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

依據：`docs/decision-log.md` D91。使用方系統要照做的事列在 [06-consumer-obligations.md](06-consumer-obligations.md)；D91-a、D91-c 已併入 02（下面各留一行引用）；D91-b 尚未併入、也尚未實作。規則代碼、參數、錯誤代碼都是建議名稱，登記時以 `sgn.rule`、`sgn.setting_definition`、`sgn.message_catalog` 為準。

共通前提：已套用的 migration 不改，全部以新檔案加上 `create or replace` 完成；核心不得出現流程包代號，所以凡是「目錄」「欄、列」的判斷都放在流程包，核心只加通用的 hook。

### D91-a 資料目錄版本綁定

已併入 [02-pack-data-access.md](02-pack-data-access.md) §8.6（以 D92 (1) 改寫）與 §8.1、§8.8；實作見 [closed-loop-1.md](../handoff/closed-loop-1.md) §1.1、§3。尚未實作的部分（待套用與驗證中的單在目錄改版時作廢交付、停用項目算縮小、`DA-CATALOG-UNKNOWN` 不觸發目錄同步）見該檔 §3、§5。

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

已併入 [02-pack-data-access.md](02-pack-data-access.md) §8.6–§8.8（以 D92 (5) 改寫：五項能力、L4 預設 `block`）；實作見 [closed-loop-1.md](../handoff/closed-loop-1.md) §1.2、§3。尚未實作的部分（使用方的能力查詢、`DA-CAPABILITY-MISMATCH`、能力宣告的變更入口）見該檔 §5。

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
