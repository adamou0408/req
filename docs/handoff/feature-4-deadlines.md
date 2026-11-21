# 交接：功能第四批——時限與負責人離職（feature-4-deadlines）

依據：`docs/packs/data-access/rules.md`「逾時」「被授權者」「時間規則」「預設時限」與原則 ②、④；`docs/decision-log.md` D99 (c)、D101 的功能順序；`docs/packs/data-access/requester-scenarios.md` §5 的前置工作（關卡催辦與升級、到期前提醒、負責人寬限期）；骨幹 `K-SLA-REMIND`、`K-SLA-ESCALATE`、`K-EXPIRE-REMIND`、`K-OWNER-CONTINUITY` 與第 8 節的參數名稱。沿用既有入口：主管 resolver（`resolve_manager`，只用已過冷卻期的主管關係）與決定者資格入口（`resolve_eligible`、`decider_denial`）、營業日（`add_workdays`、`sgn.calendar_holiday`）、參數（`sgn_internal.setting`）、例外（`exception_open`、`exception_close`）、通知範本、撤銷與交付撤回（`grant_end`）、通行金鑰的簽章公式（`signing_challenge`、`signature_verify`）、心跳與逾期工作（`K-PROGRAM-STALLED`、`overdue_work`）。`rules.md` 與 `redteam/` 沒有修改。

## 1. 做了什麼

| 項目 | 狀態 | 實作 | 測試 |
| --- | --- | --- | --- |
| A1 催辦、升級 | 完成 | `db/kernel/570_approval_sla.sql`：`api_job.approval_sla_due`（排程每一輪）、`sgn.case_task_sla`（每件工作每步驟一筆，只增不改）、`task_sla_next`（唯一的期限計算） | `db/tests/packs/data_access/87-deadlines.test.mjs` K-SLA-REMIND、K-SLA-ESCALATE（三個） |
| A2 升級後只有升級對象能簽；撞到職責分離再往上；找不到人開例外 | 完成 | 工作改指派給升級對象；`task_escalation_target` 經主管 resolver 與 `resolve_eligible`（不能是申請人、不在本單其他關、排除的角色，最後到路徑的 top_resolver）；找不到 → `K-SLA-STALLED`，工作留給原簽核人 | `87` K-SLA-ESCALATE、K-SLA-STALLED（兩個） |
| A3 群組認領關 | 完成 | 沒人認領：催辦整個群組（目前的候選人）；再逾期開 `K-SLA-CLAIM`，通知候選人的主管（經主管 resolver）與治理角色；認領之後從認領時間重新計時 | `87` K-SLA-CLAIM |
| A4 工作天、參數、事件 | 完成 | 營業日走既有入口（假日表 `sgn.calendar_holiday` 已存在，見 §3 #3）；參數 `approval.remind_after_workdays`（3）、`approval.escalate_after_workdays`（2），依級別、流程類型；`approval.stalled_notify_roles`；事件寫明規則代碼、起點、期限與參數值 | `87` 全部 |
| A5 畫面 | 完成 | `case_summary.sla`（已等幾個工作天、催辦與升級期限、是否逾期、是否已升級、升級給誰、參數值）；待簽清單逾期的在前（系統逾期警示或已過催辦期限），再依等最久；首頁卡片與單的頁面顯示 | `87` K-SLA-VIEW；`e2e/tests/system-zz-deadlines.test.mjs` K-SLA-VIEW |
| B 到期前提醒 | 完成（「已續期」是近似，見 §3 #6） | `db/kernel/575_expiry_remind.sql`：`api_job.grant_expiry_remind_due`、`sgn.grant_expiry_reminder`（每筆授權一次）；參數 `validity.remind_before_days`（14，依級別） | `db/tests/packs/data_access/88-expiry-owner.test.mjs` K-EXPIRE-REMIND |
| C1 負責人離職或停用 → 開例外通知主管 | 完成（調職沒有偵測，見 §3 #8） | `db/kernel/580_owner_continuity.sql`：人員同步停用的入口 `directory_deactivate` 同一個交易裡開缺口 `sgn.principal_owner_gap` 與例外 `K-OWNER-CONTINUITY`，期限＝寬限期 `grant.owner_grace_days`（14 天）；排程也補開漏掉的 | `88` K-OWNER-CONTINUITY（兩個） |
| C2 改指派、通行金鑰接下、職責分離 | 完成 | `api.principal_owner_gaps`、`principal_owner_propose`（缺口記下的主管或 `grant.owner_reassign_roles`）、`principal_owner_challenge`、`principal_owner_accept_passkey`（簽資料庫產生的顯示摘要）；`K-OWNER-SOD`；首頁區塊 `web/pages/owners.js` | `88` K-OWNER-CONTINUITY K-OWNER-SOD；`90-contract`；`e2e` K-OWNER-CONTINUITY |
| C3 逾期自動撤銷 | 完成 | 排程 `api_job.principal_checks`：寬限期過了、負責人仍不在職 → 名下生效中的授權逐筆 `grant_end('revoked', …, 'K-OWNER-CONTINUITY')`（交付撤回）；原負責人恢復在職 → 結案不撤銷 | `88` K-OWNER-CONTINUITY（逾期） |
| C4 簽核中的單擋下並提示 | 完成 | 授權入口 `denial_reason`：被授權者不能用（負責人不在職、被授權者已結束）時 `approve`、`approve_reduced` → `PRINCIPAL_UNAVAILABLE`；退回、駁回、撤回照常；`case_summary.hold`（錯誤目錄的訊息與改指派期限）；這類單的時限暫停 | `88` K-OWNER-CONTINUITY K-OWNER-SOD、K-PRINCIPAL-END |
| C5 團隊解散、專案結束 | 部分：之前沒有實作（只在送審時檢查），這次做了失效；團隊解散沒有來源 | `principal_end_due`：專案、agent 過了結束日 → 到期失效；團隊狀態 `ended` → 撤銷；簽核中的單擋下 | `88` K-PRINCIPAL-END |
| C6 用 sim/ 的 LDAP 讓人離職的端對端 | 完成 | `sim/ldap/change.sh offboard p06` → `db/tools/directory-sync.mjs` → 主管在首頁指定 → 新負責人用通行金鑰接下；最後 `sim/ldap/reset.sh` 還原 | `e2e` K-OWNER-CONTINUITY |
| 文件 | 完成 | 骨幹檔頭與 5.4、5.5 的現況；根目錄 `README.md`；交接索引 | — |

新規則代碼（都登記在 `sgn.rule`、都有測試）：`K-SLA-REMIND`、`K-SLA-ESCALATE`（partial）、`K-SLA-STALLED`、`K-SLA-CLAIM`、`K-SLA-VIEW`、`K-EXPIRE-REMIND`（partial）、`K-OWNER-CONTINUITY`（partial）、`K-OWNER-SOD`、`K-PRINCIPAL-END`（partial）。partial 的原因寫在 `sgn.rule.note`。

### 1.1 期限怎麼算（`task_sla_next` 是唯一的計算入口，排程、逾期工作、畫面共用）

- 起點：等人決定的工作＝升級的時間（`sla_from`）、改交給新負責人的時間（`sla_restart_at`）、認領的時間或開始的時間；等認領的工作＝開始的時間；再加上被擋下的累計時間（`sla_shift`）。
- 催辦期限＝起點＋`approval.remind_after_workdays` 個工作天；升級期限＝max（催辦期限, 實際催辦時間 `sla_reminded_at`）＋`approval.escalate_after_workdays` 個工作天（rules.md「催辦後再 2 個工作天」：催辦晚寄，升級跟著晚）。參數依「級別 → 流程類型 → 全域 → 預設值」取。
- 步驟：等認領 `claim_remind` → `claim_stalled`；等人決定 `remind` → `escalate`；升級過的 `stalled`。每件工作每一輪（`sla_round`，改交給另一個人時加一）每步驟最多一筆（唯一鍵），排程重跑不重複。
- 排程逐件隔離：每件工作自己一個 savepoint，先不鎖單看有沒有到期的步驟，有才鎖單、重新確認仍在等同一個人再做；失敗只回捲那一件並開 `K-SLA-STALLED`（kind `job_error`，同一件不重複開）。到期前提醒、負責人缺口的逾期撤銷、被授權者結束也一樣逐筆隔離（`job_failed`）。
- 只算簽核關（phase = approval）。執行關由既有的交付卡住檢查（`K-DELIVERY-STUCK`）與人工執行的後續處理。
- 被授權者不能用的單暫停（不催、不升級；`sgn.case_sla_hold` 記下開始）；恢復時把被擋下的時間加進還在等的工作的起點與實際催辦時間，期限一起往後移。擋下期間時限例外不結案（結案判斷用不看「能否使用」的 `approval_tasks_waiting`）。

### 1.2 新畫面動作的步數（390px，`e2e/tests/system-zz-deadlines.test.mjs` 量的）

| 動作 | 步數 | 步驟 |
| --- | --- | --- |
| 簽核人看已等幾天、是否逾期 | 0 | 首頁待簽清單每張卡片直接顯示（也是排序依據） |
| 看目前這關的期限、是否已升級 | 1 | 點開單的頁面 |
| 主管指定新的負責人 | 3 | 首頁的「負責人離職」區塊：選新的負責人 → 寫原因 → 按「指定為新的負責人」 |
| 新負責人確認接下 | 2 | 首頁按「確認接下負責人」→ 用通行金鑰確認 |

### 1.3 獨立審查後的修正（2026-11-21）

| # | 審查的問題 | 怎麼修 | 測試 |
| --- | --- | --- | --- |
| 1 | 撤銷後缺口每 14 天重開；缺口期間交付中的單照樣生效 | 同一位離職者已有 revoked 缺口就不重開；缺口期間擋「標記已套用」「確認生效」（授權入口），`grant_activate` 也檢查被授權者能用；逾期時執行中、驗證中的單一併撤銷並交付撤回，簽核中的單（沒有作廢的轉移）每張開例外 `in_approval_blocked` | `88` K-OWNER-CONTINUITY（逾期；`gaps_opened` 精確為 1） |
| 2 | 擋下期間時限例外被當成「不再等待」結案 | 結案改用不含「能否使用」的等待查詢 | `87` K-SLA-STALLED（擋下再恢復） |
| 3 | 催辦後連續兩輪就升級；擋下期間不順延 | 升級期限從 max（催辦期限, 實際催辦時間）起算；恢復時平移起點與實際催辦時間 | `87` K-SLA-ESCALATE（催辦後不立刻升級）、K-SLA-STALLED（擋下再恢復） |
| 4 | 新負責人可簽同一被授權者進行中的單 | `decider_denial` 加 `SOD_PRINCIPAL_OWNER`：負責人確認關以外，被授權者目前的負責人不合格 | `88` K-OWNER-CONTINUITY K-OWNER-SOD |
| 5 | 改指派後「負責人確認」工作仍在原負責人身上 | 接下時交給新負責人（新的一輪、重新計時、事件 `case.task_reassigned`、通知）；新負責人不能是那些單的申請人 | `88` K-OWNER-CONTINUITY K-OWNER-SOD |
| 6 | 升級事件缺參數值 | 升級與升級失敗事件加 `approval.manager_change_cooling_workdays`、`approval.excluded_decider_roles` | `87` K-SLA-ESCALATE |
| 7 | 確認面板畫的不是簽的那一份 | `owners.js` 先取挑戰值，面板只從 `ch.display` 畫，簽的也是它 | `e2e` K-OWNER-CONTINUITY |
| 8 | 提議人可指定自己 | `OWNER_CANDIDATE_SELF`（錯誤目錄） | `88` |
| 9 | 升級對象在同一關已有工作 | 視為不合格（`SAME_STAGE`）繼續往上；升級對象的找法改成逐人過 `decider_denial`＋同關檢查，再到 top_resolver | `87` K-SLA-ESCALATE（同一關） |
| 10 | 排程整輪回捲 | 逐件 savepoint、鎖單後重新確認、失敗開例外 | `87` K-SLA-STALLED（逐件隔離）、K-SLA-ESCALATE（簽核與升級同時） |
| 11 | 寬限期過了仍能接下 | 缺口的授權入口在 `due_at <= now()` 時回 `OWNER_GAP_STATE`（指定與接下都是） | `88` K-OWNER-CONTINUITY（逾期） |
| 12 | 「已續期」太寬 | 只認原申請人或被授權者負責人本人送出、仍在進行的單；駁回、撤回之後下一輪補寄 | `88` K-EXPIRE-REMIND |
| 55 | 紅隊 55 回 1 | `program_health` 原本先做檢查（要算全公司的逾期工作，這一批變多）再讀心跳，檢查期間每 2 秒回報的錨定程式會變成「沒停擺」；改成先讀心跳再檢查 | 紅隊 55 |

## 2. 怎麼執行

```bash
tools/check.sh
db/build.sh                                   # 只建庫＋資料庫測試（87、88 是這一批）
tools/run-all.sh --keep                       # 起系統；排程每 60 秒跑 approval_sla_due、grant_expiry_remind_due、principal_checks
sim/ldap/change.sh offboard p06               # 手動試離職；之後 db/tools/directory-sync.mjs 同步、sim/ldap/reset.sh 還原
```

驗證結果見 §6。

## 3. 與要求、設計不同的地方與理由

| # | 不同 | 理由 |
| --- | --- | --- |
| 1 | 每件工作只催辦一次，沒有「依參數間隔」重催 | 任務允許二擇一；重催要另一個參數與步驟，升級已是下一個訊號 |
| 2 | 升級過的工作不再升級；升級對象也逾期（再過催辦＋升級天數）開 `K-SLA-STALLED` 給治理角色與他的主管 | 「同一關同一階段只升級一次」；再往上升級等於沒有上限的逐級升級，由人處理較穩 |
| 3 | 假日表不缺：`sgn.calendar_holiday` 在 `100_settings.sql` 就有，營業日已排除週末與登記的假日；只是沒有登記入口與資料（目前沒有任何假日） | 任務假設可能不存在；實際是有表沒資料。登記入口屬於設定治理（骨幹 18），沒做 |
| 4 | 期限不因排程停擺順延（停擺由心跳與新的逾期工作 `approval_sla` 讓人知道） | 骨幹 `K-VALIDITY-READTIME`「停機只順延要人做事的時限」：這裡要人做事的是簽核人，他在待簽清單上本來就看得到已等幾天；但一定先催辦、下一輪才升級，不會沒催就升級 |
| 5 | 執行關（系統管理人人工執行）不催辦、不升級 | 「所有關卡」解讀為簽核關；執行關已有交付卡住與人工執行的例外 |
| 6 | 到期前提醒的「已續期」：續期（`K-RENEW`）還沒實作，以「同一被授權者、送審後的單在重疊檢查列了這筆授權、迄日較晚、還沒結束」當作已續期 | 沒有續期的實體；這是現有資料裡最接近「續期」的訊號。續期做完後要改成看 `source_kind` |
| 7 | 負責人確認關（K-PRINCIPAL-OWNER-CONFIRM）也照一般規則升級給負責人的上一層主管 | rules.md「所有關卡都適用」。這讓代填時的負責人確認可以由負責人的主管代為確認，見 §4.1 |
| 8 | 調職（調離單位）沒有偵測；只有離職、停用 | 人員與組織 port 只同步人員、主管與群組，沒有單位（`directory-sync.mjs` 不讀 LDAP 的單位）。主管改變不能當作調職：改組時會大量誤判並在 14 天後撤銷授權 |
| 9 | 骨幹「agent 在負責人離任當天暫停」沒做；照 rules.md 給寬限期 | 平台沒有暫停（`K-SUSPEND`）；rules.md 的條文是寬限期、逾期撤銷 |
| 10 | 寬限期以日曆天計（14 天），不是工作天 | rules.md「負責人異動寬限期 14 天」沒寫工作天；其他寫明工作天的照工作天 |
| 11 | 改指派的提議不要通行金鑰，只有新負責人接下要 | 提議不改變任何東西；接下才換負責人，是要負責的那個人簽 |
| 12 | 候選人清單只列原負責人的主管與他的直屬部屬；API 接受任何在職、通過檢查的人 | 平台沒有人員搜尋；畫面給一個合理的預設範圍，治理角色要指定其他人時可以直接呼叫（仍經同樣的檢查） |
| 13 | 新負責人的職責分離（K-OWNER-SOD）：不能是這個被授權者任何一張進行中或生效中的單上的簽核人（包含等他簽的工作） | 既有規則：代填時負責人確認是路徑上的一關，每關不同人；簽核人接手負責人就等於同一個人在同一張單上兩關。比只看「這張單」從嚴 |
| 14 | 被授權者不能用時擋下「核准」，不自動退回 | 「退回或擋下並提示」二擇一；擋下不需要替人做決定（原則：系統只執行），簽核人仍可退回 |
| 15 | 團隊解散沒有來源：沒有任何入口把團隊標為 `ended`（團隊與目錄群組的同步 D97 (3) 還沒做）；測試以管理者連線設定狀態 | 失效的機制已在；來源屬於群組同步那一批 |
| 16 | 專案、agent 結束的授權以「到期」（expired）結束，團隊解散以「撤銷」（revoked）結束 | rules.md：團隊解散「自動撤銷」、專案結束「自動失效」 |
| 17 | 新增核心路由四個、排程三個；`case_summary` 多 `sla`、`hold` 兩個鍵（路由表的結構同步更新） | 每個新入口都登記在路由表，`12-grants`、`90-contract` 照常比對 |
| 18 | 為新入口改的既有測試：`db/tests/kernel/90-contract.test.mjs` 實際呼叫四個新路由（每個路由都要檢查過結構） | 登記新入口，不是放寬 |

### 3.1 和 `rules.md` 的關係（沒有修改）

- 「逾時」第 2 點「升級後只有升級對象能簽」：照做。條文沒寫「往上找不到人」與「升級對象也逾期」怎麼辦；這一批開例外給治理角色，建議補一句（§5）。
- 「被授權者」：「負責人離職或調職」——調職沒有資料來源（§3 #8），條文不用改，但要記為已知缺口。
- 「時間規則」「到期前提醒」：沒有寫提醒誰；這一批提醒申請人與被授權者負責人（任務的要求）。
- 矛盾：骨幹附錄 B「負責人離職給寬限期 vs agent 當天暫停（核心從嚴）」與 rules.md 不一致，照 rules.md（§3 #9）。

## 4. 威脅小表

每列的「測試」在拿掉那道防線時會失敗。

| 新機制 | 誰能觸發 | 能否被用來搶簽或拖延 | 能否回捲 | 時鐘被動手腳 | 停掉時誰知道 | 測試 |
| --- | --- | --- | --- | --- | --- | --- |
| 催辦 `remind`、`claim_remind` | 只有排程（`sgn_scheduler` 只能執行 `api_job`，`12-grants`） | 只送通知，不改指派 | 不能：`case_task_sla` 擋 `UPDATE`、`DELETE`、`TRUNCATE`；唯一鍵讓重跑不重複 | 時鐘往前：提早催辦（只是通知）；往後：延後，但待簽清單照樣顯示已等幾天 | 排程心跳 `K-PROGRAM-STALLED`；到期沒做的步驟是逾期工作 `approval_sla` | `87` K-SLA-REMIND |
| 升級 `escalate` | 只有排程；對象由主管 resolver 決定，任何人都不能指定 | 故意拖到升級好讓特定的人簽：升級對象是簽核人「已生效」的上一層主管（主管異動有冷卻期與 `K-DETECT-MANAGER-FLIP`），不能挑；仍受每關不同人、不能是申請人約束；事件寫明路徑與用的主管關係。主管關係在途中被改：只用已過冷卻期的那一條 | 升級事件進鏈；工作的 `basis.escalations` 留下每次升級 | 時鐘往前：提早升級（升級對象仍要用通行金鑰簽，不會自動通過） | 同上 | `87` K-SLA-ESCALATE（四個：基本、職責分離、主管關係被改、原簽核人拿著挑戰值也簽不了） |
| 升級不了、升級後仍逾期 `K-SLA-STALLED` | 排程 | 工作留給原來的人，不卡死也不自動通過 | 例外只增不改；不再等待時由排程結案 | — | 同上 | `87` K-SLA-STALLED（兩個） |
| 群組認領逾期 `K-SLA-CLAIM` | 排程 | 認領之後從認領時間重新計時：拖延的上限是「催辦＋升級」再一輪，且已經開過例外 | 同上 | — | 同上 | `87` K-SLA-CLAIM |
| 畫面的期限 `case_summary.sla` | 資料庫算（唯讀） | — | — | 時鐘被改時畫面跟著錯（和排程同一個時鐘，不會互相矛盾） | — | `87` K-SLA-VIEW；`e2e` |
| 到期前提醒 | 只有排程 | 只送通知 | 不能：`grant_expiry_reminder` 只增不改，每筆授權一筆 | 往前：提早提醒；往後：延後（逾期工作 `expiry_remind` 讓人知道） | 心跳；逾期工作 `expiry_remind` | `88` K-EXPIRE-REMIND |
| 負責人缺口的開啟 | 人員同步停用一個人的同一個交易（`sgn_sync`），或排程補開 | 同步程式被拿來假造「負責人離職」以撤銷別人的授權：既有的同步防護（單一時間窗內停用超過 `directory.bulk_deactivation_max` 就延後並開例外、控制類角色延後、完整快照的變動上限）仍在；假造之後要等 14 天才會撤銷，期間主管與治理角色都收到通知、例外在稽核首頁；下一次誠實的同步把人改回在職（冷卻期後套用）就結案、不撤銷。能造成的是簽核中的單暫時不能核准（拖延），撤銷前有 14 天的人工訊號 | 缺口狀態可改（open → reassigned／restored／revoked），每次都進鏈；例外只增不改 | 往前跳 14 天以上會直接撤銷（只會收回權限，不會擴大） | 心跳；寬限期過了沒撤銷是逾期工作 `owner_gap` | `88` K-OWNER-CONTINUITY；`e2e` |
| 指定新負責人 | 缺口記下的主管（開缺口時解析，之後主管關係再改也不影響）或治理角色；授權入口 `denial_reason`（第四種實體） | 被指定的人必須在職、不是原負責人、不是這個被授權者的單的簽核人（K-OWNER-SOD）；提議不改任何東西 | 新的提議取代舊的；舊的作廢（`superseded`），都進鏈 | — | — | `88` K-OWNER-CONTINUITY K-OWNER-SOD |
| 新負責人接下 | 被指定的人本人，用通行金鑰簽資料庫產生的顯示摘要；挑戰值綁提議編號，提議換了就對不上 | 後端換掉被授權者或新負責人：簽章對不上（`SIGNED_CONTENT_MISMATCH`）；別人拿到挑戰值：`challenge_owner_check` | 換負責人只有 `principal_owner_set` 一個入口（種子與匯入用 `principal_upsert`）；事件帶證明雜湊 | — | — | `88`；`90-contract` |
| 逾期撤銷 | 只有排程 | — | 撤銷走既有的 `grant_end`（交付撤回、通知）；只撤一次（缺口結束） | 同上 | 同上 | `88` K-OWNER-CONTINUITY（逾期） |
| 簽核中擋下 `PRINCIPAL_UNAVAILABLE` | 授權入口（`approve`、`approve_reduced`） | 用來拖延：讓負責人「離職」就能卡住別人的單——要能假造同步（見上），而且單仍可退回 | — | — | — | `88` K-OWNER-CONTINUITY K-OWNER-SOD、K-PRINCIPAL-END |
| 被授權者結束 | 排程（結束日是被授權者的資料；團隊解散目前沒有來源） | — | 走 `grant_end` | 往前：提早失效（只收回） | 逾期工作 `principal_end` | `88` K-PRINCIPAL-END |

審查後補的防線：同一位離職者撤銷過就不重開缺口；缺口期間擋「標記已套用」「確認生效」，`grant_activate` 最後再檢查；逾期時交付中的單一併撤銷、簽核中的單開例外；寬限期一過就不能指定或接下；提議人不能指定自己；新負責人不能簽同一被授權者進行中的單（`SOD_PRINCIPAL_OWNER`）；升級期限從實際催辦時間起算、擋下期間順延；升級對象在同一關已有工作就往上找；排程逐件 savepoint、鎖單後重新確認（簽核與升級同時發生只會有一個結果，`87` 有測試）。

### 4.1 自認未解

- 升級對象由主管關係決定。拿到人員同步帳號的人可以把簽核人的主管改成同夥，等過了冷卻期（1 個工作天），再讓簽核人拖到升級——升級對象就是同夥。冷卻期內的異動不會被用到、過了冷卻期的主管異動開 `K-DETECT-MANAGER-FLIP`（既有），但升級本身不另開例外。
- 負責人確認關也會升級給負責人的主管（§3 #7）：代填的人可以藉由「負責人不理」讓負責人的主管代為確認。負責人仍是原來的人，授權仍由他負責；若負責人要求這一關不能代理，要改成「負責人確認關逾期只開例外」。
- 假造離職的拖延（上表）：被假造的人負責的被授權者，簽核中的單在下一次誠實同步之前不能核准。
- 時鐘：所有期限都以資料庫的時鐘（`sgn_internal.now()`）為準，資料庫主機的時鐘被改，期限就跟著錯；平台沒有第二個時間來源（錨定的時間可以事後比對）。
- 寬限期內負責人恢復在職要過同步的冷卻期才算數；恢復與寬限期的競合（第 14 天恢復）以排程那一輪看到的狀態為準。
- 候選人清單的預設範圍（§3 #12）可能不包含真正適合的人。
- 寬限期過了之後還在簽核中的單沒有系統動作可以作廢（狀態轉移表沒有 in_approval → 取消），只開例外 `in_approval_blocked`，它們維持不能核准，要申請人撤回或簽核人退回。
- 被擋下的期間由排程每一輪記錄，排程兩輪之間短暫的擋下不會被記下（不順延）；記下的期間以排程看到的時間為準（最多差一輪）。
- 新的 `SOD_PRINCIPAL_OWNER` 也適用執行關：被授權者的負責人如果是那個受管系統的系統管理人，人工執行會改由同一範圍的其他人或停住。

## 5. 需要負責人寫進 rules.md 的條文草稿

放在「逾時」與「被授權者」：

> **逾時**（補兩點）
> - 升級時往上找不到符合「每關不同人」的人，或升級對象也逾期未簽：開例外通知治理角色，工作留給原來的人，不自動通過。
> - 群組認領的關卡沒人認領：先催辦整個群組，再逾期開例外通知群組的主管與治理角色。
>
> **被授權者**（補一句）
> - 負責人離職或調職：通知他的主管在寬限期內改指派負責人，新負責人確認接下才生效；新負責人不能是這個被授權者的單的簽核人。寬限期內，簽核中的單不能再核准；逾期自動撤銷。

## 6. 驗證結果

**審查後的修正（最新）**：2026-11-21，停掉背景程式、`rm -rf .run` 之後以 root 跑 `tools/check.sh`：**全部通過**——資料庫測試 345（原 329；`87-deadlines` 12 個、`88-expiry-owner` 4 個）、通行金鑰對照 16、端對端 45（原 43）、規則代碼 152（原 143）。資料庫測試總時間 233 秒（修正前一度慢到 500 秒，見下）。

之後 `tools/run-all.sh --keep`（345／16／45 全過），`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` 依序跑 `redteam/exploits/[0-9][0-9]-*.mjs`（64 支）：**34、40、57 回 1；51 回 2；其餘 60 支回 0（55 回 0）**。沒有修改 `redteam/`。

- 51 回 2（「環境問題／腳本錯誤，無法判定」）：腳本送的單被 `OVERLAP_COVERED` 擋下——它用隨機的資料年份（2200–2899），撞到前面腳本還沒撤完的同一被授權者、同一年份的授權。跑完之後系統裡只剩一筆無關的生效授權（單號 1，2025 年）；同一個系統上連跑兩次都回 0、判定與之前相同。屬於腳本的隨機年份碰撞，不是這一批的機制。
- 55：上一輪回 1 的原因查清了——`program_health` 先做停擺檢查（要算全公司的逾期工作，這一批多了幾種）再讀心跳，檢查期間每 2 秒回報的錨定程式會變成「沒停擺」。改成先讀心跳再檢查（580 重新定義 `api.program_health`），這一輪回 0。
- 效能：審查修正後第一次全跑時資料庫測試慢到 500 秒（`K-HOME-ORDER` 66 秒），原因是 `waiting_approval_tasks` 改成 SQL 包裝時，在 PL/pgSQL 裡的通用執行計畫會替每張單掃全部的等待中工作。`approval_tasks_waiting` 改成 PL/pgSQL、指定單與全部分開兩段，`waiting_approval_tasks` 改成逐件判斷能不能用之後，每張單的摘要約 3 毫秒，總時間回到 218–239 秒。`70-usage` 的 K-USAGE-UNVERIFIED 那次失敗就是這個變慢造成的（它的「新鮮度內一筆」依賴核心測試與它之間的時間），速度回來之後通過，測試沒有改。
- 為了跑 `tools/check.sh`，主代理留下的兩個 git worktree（`.claude/worktrees/agent-*`，Prettier 與 ESLint 會掃到）用 `git worktree move` 暫時移到 scratchpad，跑完已移回原位，內容沒有動。

**第一版（審查前）**：資料庫測試 341、對照 16、端對端 45、規則代碼 152；攻擊腳本 34、40、57 回 1，55 那一輪回 1。

為了新入口改動的既有測試（不是放寬）：`db/tests/kernel/90-contract.test.mjs` 實際呼叫四個新路由（測試專用的被授權者，負責人渡邊翔 p35 停用 → 主管田中美咲 p32 指定 → 鈴木大輔 p33 接下；最後恢復在職、把這個被授權者標為結束，讓 `20-flow` 的被授權者完整清單不變）。

## 7. 留給下一位

- 調職偵測：人員與組織 port 加單位（LDAP 已有，`sim/ldap/change.sh transfer`），定義「調離」並沿用這一批的缺口。
- 續期做完之後，到期前提醒的「已續期」改看續期的來源單（§3 #6）。
- 假日的登記入口（設定治理）；骨幹的「依簽核人所在據點的行事曆」。
- 升級前 1 個工作天預告、申請人每週期可提醒一次（骨幹 `K-SLA-ESCALATE`、`K-SLA-REMIND` 的其餘部分）。
- 團隊解散的來源（群組同步 D97 (3)）。
- 這一批尚未經紅隊攻擊（D101：功能批次做完後集中打）。
