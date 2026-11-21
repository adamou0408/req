# 例外處置表

結論：系統目前會開 **39 種例外代碼**（核心 33、資料存取流程包 6）。**只有 8 種會在狀況解除時自動結案（其中 DA-CATALOG-DRIFT 只限「只改名稱」的那一種），其餘 31 種開了就一直是「未結案」**，因為人工結案的入口還沒做（gaps G-02）。在那之前，處置的結果要記在平台外（見 §4 的處置紀錄格式），稽核頁的未結案清單會持續累積。

## 1. 代碼清單怎麼抓的（重跑就能核對本表有沒有落後）

例外只有一個開立入口 `sgn_internal.exception_open`（`db/kernel/40_case.sql`），另有兩個包裝：`sgn_internal.exception_open_due`（帶期限，`540_closed_loop.sql`）與流程包用的 `sgn_sdk.exception_open`／`sgn_sdk.exception_open_due`。`sgn.exception_record.rule_code` 外鍵指向 `sgn.rule`，所以每個例外代碼都是規則代碼。

```bash
# (a) 直接寫在開立呼叫裡的代碼
grep -rhoP "exception_open(_due)?\(\s*'[A-Z]+-[A-Z0-9-]+'" db/kernel db/packs | grep -oP "'[A-Z]+-[A-Z0-9-]+'" | sort -u
# (b) 代碼是變數的呼叫點（要逐一追來源）
grep -rnP "exception_open(_due)?\(\s*[a-z_]" db/kernel db/packs
# (c) 經 fulfilment_fail、reconciliation_reject 傳進去的代碼
grep -rhoP "(fulfilment_fail|reconciliation_reject)\([^;]*?'[A-Z]+-[A-Z0-9-]+'" db/kernel db/packs | grep -oP "'[A-Z]+-[A-Z0-9-]+'" | sort -u
# (d) 流程包 hook 回傳給核心去開的代碼（送審複核、交付結果判定、對帳判定、生效後續）
grep -rhoP "'rule_code',\s*'[A-Z]+-[A-Z0-9-]+'" db/kernel db/packs | sort -u
# (e) 依條件選代碼的兩處
grep -n "K-SOD-ROLE-ESCALATED\|K-PRINCIPAL-OWNER-CONFIRM" db/kernel/370_principal_owner_confirm.sql | head -3
grep -n "K-RECON-EXTRA' when" db/kernel/440_reconciliation.sql
```

(b) 追到的來源：`stage_escalation_rule`（K-SOD-ROLE-ESCALATED、K-PRINCIPAL-OWNER-CONFIRM）、`fulfilment_fail`（K-VERIFY-AUTO、K-DELIVERY-REJECTED、以及流程包交付判定的 DA-CATALOG-MISMATCH、DA-CATALOG-UNKNOWN、DA-ENV-MISMATCH）、`reconciliation_reject`（K-RECON-UNVERIFIED、K-RECON-LIMIT）、`reconciliation_finding` 的 case 運算式（K-RECON-EXTRA／MISSING／DIFFERENT）、流程包 hook（DA-TEST-EXCEPTION、DA-TEST-REPORT-FOLLOWUP、DA-CATALOG-*）。`40_case.sql` 的 `PRB-SYNC-GUARD` 已被 `110_rules.sql` 刪除代碼、由後面的版本取代，不會再開。

靜態搜尋的極限：流程包未來若用新的變數組代碼，(a)–(e) 都抓不到。執行中的系統實際開過哪些，以資料庫為準（需要管理者連線，屬唯讀查詢；目前沒有唯讀的維運角色，gaps G-12）：

```bash
source db/sgn.env; source db/admin.env
psql -X "${SGN_PG_ADMIN_URL%/*}/sgn_e2e" -c "select rule_code, count(*) filter (where closed_at is null) as open, count(*) as total, max(opened_at) as last from sgn.exception_record group by rule_code order by open desc, rule_code"
```

平常不用這條；看稽核頁的例外清單（`api.audit_exception_groups`，同規則同單合成一筆，未結案與已結案分開）。

## 2. 共通規則

- **在哪裡看**：稽核頁（稽核角色）。單內的例外也顯示在那張單的稽核頁。被通知的人收到站內待辦與郵件（郵件經寄信程式，它停了就只有站內）。
- **通知對象的預設值**來自參數，改參數就改對象（不改程式）。下表的「升級對象」＝`delivery.escalation_roles`（預設 `mis`、`ciso`）的持有人。
- **帶期限的例外**（`exception_open_due`）逾期未結案時，排程的 `exception_followup_due` 再通知 `exception.followup_escalation_roles`（預設 `ciso`、`audit_head`）與原處理人，每筆一次（K-EXCEPTION-FOLLOWUP）。**不會自動做任何決定。**
- **「多久內」**：程式裡只有帶期限的例外有期限（參數）。其餘欄位寫的是本手冊建議的處理時限（標「建議」），不是系統強制的；正式定案要由資安長與稽核主管核定後寫進參數或內控文件。
- **結案**：「自動」＝資料庫在狀況解除時呼叫 `sgn_internal.exception_close` 並進鏈；「無」＝程式裡沒有結案路徑。

## 3. 處置表

### 3.1 背景程式與稽核鏈

| 代碼 | 代表什麼 | 誰收到通知 | 該做什麼 | 多久內 | 怎麼結案 | 不處理的後果 |
|---|---|---|---|---|---|---|
| K-PROGRAM-STALLED | 某背景程式超過 `program.heartbeat_max_seconds`（300 秒）沒心跳，或最舊的逾期工作（授權到期、確認逾期、交付逾時）超過 `program.overdue_max_seconds`（600 秒）沒人處理 | `program.stalled_notify_roles`：`tech_ops`、`audit_head`、`ciso` | 依 detail 的 `subject`（`program:<代碼>` 或 `work:<種類>`）查 [programs.md](programs.md) 對應程式；看 `.run/<程式>.log` 尾段；必要時重啟 | 建議 1 小時 | 自動：狀況解除時（`525_program_liveness.sql`） | 授權到期不收回、確認逾期不撤銷、交付不送；最壞是該收回的權限繼續有效 |
| K-ANCHOR-LAG | 最後一次被存放處收下的錨點之後，事件最舊的超過 `audit.anchor_max_lag_seconds`（預設 3600；開發環境 `db/build.sh` 設 30）或筆數超過 `audit.anchor_max_lag_events`（10000） | `audit.anchor_lag_notify_roles`：`audit_head`、`ciso` | 檢查 anchor 與 anchor-store 程式；anchor 的 log 有 `CODE_CHANGED`／`ANCHOR_MISMATCH` 時**不是程式停了而是鏈或程式指紋不一致**，立刻當作竄改嫌疑處理並通知資安長（見 break-glass.md §7） | 建議 4 小時；有不一致時立即 | 無（同一段落後只開一筆；落後解除後也不結案） | 稽核頁顯示失敗；這段期間的事件只靠資料庫保護，被最高權限者改了也比不出來 |
| K-NOTIFY-STUCK | 一則通知建立後超過 `notification.stuck_alert_seconds`（1800 秒）還沒寄出（每則一筆） | 無人（寄信程式可能就是停的那個）；只出現在稽核頁 | 檢查 mailer 程式與 SMTP；寄信程式只能「標成已寄而不寄」的殘餘（紅隊 40，D85 (4)）也會讓信沒到，抽查收件匣 | 建議 1 個工作天 | 無 | 被通知的人只剩站內待辦；確認期限、到期提醒可能沒人看到 |

### 3.2 交付、驗證與對帳（外部系統）

| 代碼 | 代表什麼 | 誰收到通知 | 該做什麼 | 多久內 | 怎麼結案 | 不處理的後果 |
|---|---|---|---|---|---|---|
| K-DELIVERY-STUCK | 一筆交付超過 `delivery.stuck_alert_seconds`（900 秒）還沒結果 | 升級對象 | 檢查 delivery 程式、外部系統可達性（擋下網路也會造成卡住，D81 (7)） | 建議 4 小時 | 無 | 核准的權限沒套用（申請人等不到）；撤回沒送到則該收回的權限還在 |
| K-DELIVERY-REJECTED | 外部系統拒絕交付（簽章不符、版本衝突、格式錯誤）；單不生效，已送出的部分撤回 | 升級對象＋申請人（`verification.failed`） | 查 detail 的回應；簽章不符時檢查信任清單是否為目前那一把（key-rotation.md §3.3） | 建議 1 個工作天 | 無 | 申請人要重新申請；若是金鑰錯置，之後每一張都會失敗 |
| K-VERIFY-AUTO | 套用後的自動驗證不通過（實際權限和核准的不同）；單不生效或已生效的被撤銷 | 升級對象＋申請人 | 和外部系統管理人比對實際設定；確認撤回已完成 | 建議 1 個工作天 | 無 | 外部系統上可能殘留多給的權限，要靠對帳（K-RECON-*）再抓 |
| K-DELIVERY-MANUAL | 受管系統的交付方式是 `manual`（人工執行），每次走人工都開一筆常設例外；授權正常到期時也開（D89 (2)） | 該系統的 `system_custodian` | 管理人在外部系統手動套用或移除，回平台標記；稽核每季抽查人工系統 | 依流程包的時限；建議到期當天移除 | 無（設計上是常設例外，D63） | 人工設上去的權限不會自己消失 |
| K-RECON-OVERDUE | 超過 `reconciliation.max_interval_seconds`（300 秒）沒有有效的對帳回報 | 升級對象 | 檢查 reconciler 程式與外部系統的稽核金鑰 | 建議 4 小時 | 無 | 交付程式謊報、外部系統被人改，都沒人知道 |
| K-RECON-UNVERIFIED | 對帳回報沒有有效證明、過期、重送或太大（同一通道在新鮮度時間內一筆） | 升級對象 | 檢查外部系統的回應金鑰是否輪替（`sgn.channel_key`）、時鐘是否同步 | 建議 1 個工作天 | 無 | 同上；而且可能是有人在偽造回報 |
| K-RECON-LIMIT | 單輪項目超過 `reconciliation.max_items`（5000）整份不收，或新發現超過 `reconciliation.max_new_findings`（100）合併成一筆 | 升級對象 | 確認是外部系統的真實狀況還是被灌爆（D81 (3)）；調整參數要走設定變更 | 建議 1 個工作天 | 無 | 這一輪沒有對帳 |
| K-RECON-EXTRA | 外部系統上有、平台沒核准（或已撤銷、到期且清除）的權限；屬於平台認得、已不該有權限的單時自動排撤回，生效中的單只升級（D82 (1)） | 升級對象（`reconciliation.finding`） | 未自動撤回的：和系統管理人確認來源，必要時由 `mis` 撤銷或請管理人移除 | 建議 1 個工作天 | 發現（`sgn.reconciliation_finding`）在連續 `reconciliation.resolve_after_rounds` 輪沒看到時標為已解決並進鏈（K-RECON-RESOLVED）；**例外本身不結案**（gaps G-02） | 未經核准的存取持續存在 |
| K-RECON-MISSING | 平台認為已生效、外部系統上卻沒有 | 升級對象 | 可能是交付程式謊報成功；比對交付紀錄與外部系統 | 建議 1 個工作天 | 同上 | 申請人以為有權限；也可能是交付程式被入侵的訊號 |
| K-RECON-DIFFERENT | 兩邊都有但列條件、資料期間或有效期間不同 | 升級對象 | 以核准版本為準修正外部系統 | 建議 1 個工作天 | 同上 | 實際範圍和核准不同 |
| DA-CATALOG-MISMATCH | 使用方系統回報的目錄版本在這張單引用的部分和綁定的版本不同（交付時不生效並撤回；對帳時也比對） | 交付時：升級對象＋申請人；對帳時：升級對象 | 確認使用方系統的目錄同步 | 建議 1 個工作天 | 無 | 使用方系統依錯的欄位對照執行 |
| DA-CATALOG-UNKNOWN | 使用方系統回報平台不認得的目錄版本，寬限 `data_access.catalog_unknown_grace_minutes` 後仍不認得 | 同上 | 同上 | 建議 1 個工作天 | 無 | 同上 |
| DA-ENV-MISMATCH | 使用方系統回報實際套用的區（測試／正式）和單上的不同或沒回報；不生效 | 升級對象＋申請人 | 和使用方系統確認分區設定 | 建議 1 個工作天 | 無 | 規則可能被套到另一區 |

### 3.3 使用紀錄（使用方系統回報的摘要）

| 代碼 | 代表什麼 | 誰收到通知 | 該做什麼 | 多久內 | 怎麼結案 | 不處理的後果 |
|---|---|---|---|---|---|---|
| K-USAGE-UNVERIFIED | 不收的使用摘要（證明不符、過期、重送、不比上一批新、格式不合、太多筆） | 升級對象 | 同 K-RECON-UNVERIFIED | 建議 1 個工作天 | 無 | 測試報告與閒置偵測沒有資料 |
| K-USAGE-OVERDUE | 回報過摘要的通道超過 `usage.max_interval_seconds`（600 秒）沒有新的一批 | 升級對象 | 檢查 reconciler（它也負責拉使用摘要） | 建議 1 個工作天 | 無 | 同上 |
| K-USAGE-IDLE | 生效超過 `usage.idle_alert_days`（30 天）仍沒有任何查詢或匯出 | 申請人、被授權者負責人 | 由申請人或負責人決定縮小或撤銷 | 建議 10 個工作天 | 自動：之後有使用，或授權已結束（`545_usage_summary.sql`） | 不需要的權限繼續存在 |

### 3.4 人員目錄、角色與簽核路徑

| 代碼 | 代表什麼 | 誰收到通知 | 該做什麼 | 多久內 | 怎麼結案 | 不處理的後果 |
|---|---|---|---|---|---|---|
| K-HR-SYNC | 人員同步的異常，detail 的 `kind` 分四種：`manager_changed`（基準之後的主管異動，冷卻期內仍由原主管簽）、`entries_screened`（被篩掉的條目）、`deactivation_deferred`（大量停用或控制類角色持有人被停用，延後生效）、`person_change_deferred` | 無（只在稽核頁） | 每一筆和人資確認是否真實異動；大量停用要當作同步帳號被冒用的可能（D66） | 建議冷卻期（`approval.manager_change_cooling_workdays`、`directory.sync_cooling_workdays`）結束前 | 無 | 冷卻期一過，假的異動就生效（換主管＝換簽核人） |
| K-ROLE-SOURCE | 同步帶入業務類角色（`business_role_from_sync`）或目錄宣稱了不可同步的角色（`role_not_syncable`） | 無 | 和角色的負責單位確認 | 同上 | 無 | 同上，換的是「誰能簽」 |
| K-DETECT-MANAGER-FLIP | 由基準之後同步異動而來的主管關係被用來指派簽核 | 無（顯示在單上：申請人、簽核人、稽核都看得到） | 稽核抽查這些單的簽核人是否正當 | 建議該單核准前 | 無 | 被竄改的主管關係簽了單 |
| K-RESOLVE-HALT | 某一關解析不到合格的人，關卡停住（不跳關） | 申請人（`case.halted`） | 補上角色指派或主管關係；單會停在那一關 | 建議 3 個工作天 | 無 | 單永遠停住 |
| K-SOD-ROLE-ESCALATED | 角色關卡因職責分離排除了持有人，改由主管鏈往上找人 | 無（單上可見） | 稽核抽查 | — | 無 | 由非預期的人簽 |
| K-PRINCIPAL-OWNER-CONFIRM | 被授權者負責人那一關升級到主管鏈 | 無（單上可見） | 同上 | — | 無 | 同上 |

### 3.5 通行金鑰與登記人

| 代碼 | 代表什麼 | 誰收到通知 | 該做什麼 | 多久內 | 怎麼結案 | 不處理的後果 |
|---|---|---|---|---|---|---|
| K-GOVERNANCE-KEY | 治理類角色的持有人沒有可用的通行金鑰 | 停用造成時：`passkey.suspend_exception_notify_roles`（`audit_head`、`ciso`、`passkey_registrar`）；排程檢查開的：無 | 請當事人恢復或重新登記金鑰 | 建議 5 個工作天 | 自動：有可用金鑰或不再持有該類角色（`515_exception_close.sql`） | 治理決定（例如角色變更治理）做不了 |
| K-PASSKEY-SUSPEND-HOLDER | 控制類或治理類角色持有人的金鑰被「只憑登入」停用（`passkey.suspend_exception_categories`） | 同上 | 聯絡本人確認是否本人所為；不是就當作身分提供者被冒用 | 建議當天 | 自動：同上 | 有人可能在冒用登入讓關鍵角色失能 |
| K-PASSKEY-SUSPEND-FLOOD | 全公司在 `passkey.suspend_global_window_hours` 內的停用達到 `passkey.suspend_global_max`，之後的停用被拒絕 | `passkey.suspend_global_notify_roles`（`audit_head`、`ciso`） | 視為大規模冒用登入，檢查身分提供者 | 立即 | 自動：時間窗內低於上限時 | 其他人當天不能只憑登入停用 |
| K-REGISTRAR-MIN | 可用的登記人少於 `passkey.registrar_min`（2） | `passkey.registrar_min_notify_roles`（`audit_head`、`ciso`、`passkey_registrar`） | 指派新登記人；平台內救不回來時走 [break-glass.md](break-glass.md) 的安裝儀式 | 建議 5 個工作天 | 自動：可用登記人回到下限以上（`520_passkey_recovery.sql`） | 新人與遺失裝置的人無法取得金鑰 |
| K-PASSKEY-RECOVERY | 某人的金鑰被別人撤銷後才登記的新金鑰（冷卻加長） | 本人、本人主管、`passkey.recovery_notify_categories`（治理類）持有人 | 和本人當面或電話確認；不是本人就讓本人回報「不是我」 | 冷卻期（`passkey.recovery_cooling_workdays`）結束前 | 無（事件型，D90 (3)） | 兩位背書人串通加冒用登入可接管（已接受殘餘，D88 (1)） |
| K-PASSKEY-NOT-ME | 本人回報冷卻中的新金鑰「不是我」，金鑰作廢 | 本人、主管、背書人、治理類持有人 | 調查背書人與登入來源 | 立即 | 無（事件型） | 背書人或身分提供者可能被利用 |

### 3.6 身分提供者金鑰

| 代碼 | 代表什麼 | 誰收到通知 | 該做什麼 | 多久內 | 怎麼結案 | 不處理的後果 |
|---|---|---|---|---|---|---|
| K-IDP-KEY-NEW | 身分提供者公布新簽章金鑰，已立即信任（不設冷卻，D81 (5)） | `identity.idp_key_notify_roles`（`audit_governor`、`board_chair`、`parent_officer`、`ciso`） | 和身分提供者的管理人確認確實有輪替；沒有就是金鑰同步被冒用（已接受殘餘 34 a，D85 (3)） | 建議當天 | 無 | 冒用者可用自己的金鑰登入任何人（決定仍要通行金鑰） |
| K-IDP-KEY-UNTRUSTED | 身分提供者公布了平台不能信任的金鑰（不是 RS256 等） | 同上 | 和身分提供者確認設定 | 建議 1 個工作天 | 無 | 該金鑰簽的登入全部失敗 |
| K-IDP-KEY-LIMIT | `identity.idp_key_new_window_seconds` 內新增超過 `identity.idp_key_new_max`（2）把 | 同上 | 視為攻擊；也會擋住正常輪替（D86 (5)） | 立即 | 無 | 正常輪替被擋，全公司可能登不進來 |
| K-IDP-KEY-RETIRE | 金鑰退役（有冷卻 `identity.idp_key_retire_cooldown_seconds`；不得退役到零把） | 同上 | 確認是正常輪替 | 建議當天 | 無 | — |

### 3.7 申請單與資料存取流程包

| 代碼 | 代表什麼 | 誰收到通知 | 該做什麼 | 多久內 | 怎麼結案 | 不處理的後果 |
|---|---|---|---|---|---|---|
| K-CONFIRM-DISPUTE | 申請人在驗證中回報「拿到的不對」 | 升級對象、申請人、被授權者負責人 | 和外部系統比對 | 建議 1 個工作天 | 無 | 實際權限和核准的不同 |
| DA-CATALOG-DRIFT | 目錄改版影響單引用的部分；只改名稱時是帶期限的確認 | 受影響主題包的資料擁有者 | 資料擁有者在期限內確認 | `data_access.catalog_rename_confirm_workdays` | 只改名稱的：資料擁有者確認後自動結案（`130_catalog_version.sql`）；其他：無 | 逾期由 K-EXCEPTION-FOLLOWUP 升級，不撤銷（D92 (6)） |
| DA-TEST-EXCEPTION | 正式區的單沒有測試紀錄，申請人填了例外理由 | 無（簽核人在決定畫面看得到） | 簽核人判斷 | — | 無 | — |
| DA-TEST-REPORT-FOLLOWUP | 沒有測試紀錄就上線的正式區授權：限期補上線後使用報告 | 申請人（`grant.followup`）；逾期再通知 `ciso`、`audit_head` | 申請人產生上線後使用報告 | `data_access.post_launch_report_workdays` | 自動：申請人產生報告時（`160_test_report.sql`） | 逾期只升級，不撤銷 |

## 4. 處置紀錄格式（結案入口做好之前用）

結案入口做好之前，人的處置要留在平台外，稽核才能複核。每筆一行，存放位置由稽核主管指定：

```
日期時間 | 例外 id（稽核頁或 sgn.exception_record.id） | 規則代碼 | 單號或範圍 | 處理人 | 做了什麼 | 結果 | 是否需要後續 | 複核人與日期
```

結案入口做好之後（gaps G-02），這些紀錄要能對回鏈上的 `exception.closed` 事件。
