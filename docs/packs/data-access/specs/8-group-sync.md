# 規格：功能第八批——團隊對應目錄群組、調職偵測、外部人員擋下

狀態：**待實作規格**（2026-11-21）。條文草稿要負責人確認後才貼進 `rules.md`；本文件不修改任何規則。

依據：`rules.md`「被授權者」（團隊、負責人離職或調職）；`docs/decision-log.md` D97 (3)、D99 (2)；`requester-scenarios.md` 類型 3、9、14、16 與設計 d（只取「擋下」，不做外部成員設計）；骨幹 `K-HR-SYNC`、`K-HR-TRANSFER`、`K-EXTERNAL-SPONSOR`、`K-MEMBER-REDUCE`、`K-PRINCIPAL`；交接 `feature-4-deadlines.md` §3 #8、#15、§7。

沿用的入口：人員同步 `api_sync.directory_apply`（暫存、差異、門檻、冷卻期，`230`、`280`、`340`）、同步工具 `db/tools/directory-sync.mjs`、模擬目錄 `sim/ldap`（`change.sh`、`reset.sh`）、負責人缺口與改指派（`580_owner_continuity.sql`：`principal_owner_gap`、`principal_owner_propose`、`principal_owner_accept_passkey`、`api_job.principal_checks`）、被授權者結束 `principal_end_due`（團隊 `ended` → 撤銷）、決定者資格 `decider_denial`、例外 `exception_open_due`、撤銷 `grant_end`。

## 1. 範圍與不做的事

做：

| # | 項目 |
|---|---|
| G1 | 人員與組織 port 加「群組」：目錄裡標為團隊的群組 → 平台的團隊被授權者（建立、成員、負責人、結束） |
| G2 | 人員同步多帶「單位」與「雇用類型」兩個欄位；雇用類型經對照表（資料）換成平台的類型 |
| G3 | 調職偵測：單位改變（過冷卻期）→ 他負責的被授權者開負責人缺口（原因「調職」），沿用第四批的寬限期與改指派 |
| G4 | 調職後仍留在原單位團隊的群組裡：期限後開例外給團隊負責人（平台不改目錄） |
| G5 | 外部人員擋下（D99 (2)）：外部人員不能是資料授權的申請人、簽核人、被授權者負責人；團隊有外部成員時不能送審、不能核准；生效中的團隊多出外部成員 → 例外，限期內沒移出就撤銷該團隊的資料授權 |
| G6 | 使用方回報的使用紀錄裡，實際操作的人是外部人員 → 例外 |
| G7 | 合約測試：真實 adapter 對著 `sim/ldap` 讀群組、單位、雇用類型 |

不做：

- 外部成員的保證人、委外合約、成員資格期限（設計 d）：D99 (2) 裁決不做。
- 專案、agent 的成員表：平台不知道專案或 agent 背後是誰用，只靠 G5 的申請人檢查與 G6 的使用紀錄偵測。
- 交付帶成員名單或排除名單給 DC：使用方以同一個目錄群組判斷成員（見開放問題 Q3）；平台只在名單不合規時撤銷。
- 巢狀群組：群組裡的群組成員不展開，記一筆例外（`K-TEAM-SYNC`，原因 `nested_group`）。
- 調職時進行中的關卡重新解析（骨幹 `K-HR-TRANSFER` 的其他項）：主管關係由同步改變、有冷卻期與 `K-DETECT-MANAGER-FLIP`，這批不另做。
- 到職前預先申請（`K-HR-HIRE`）。

## 2. rules.md 條文草稿

**取代「被授權者」中「團隊」那一點**：

> - **團隊**：對應人員目錄（AD／LDAP）中標為團隊的群組，成員與負責人以目錄為準，由人員同步建立與結束；群組從目錄消失時團隊解散，相關授權自動撤銷。成員異動不需簽核，通知負責人並列入定期複查。（D97 (3)。）

**取代「負責人離職或調職」那一點**（第四批的草稿已在交接 §5，這裡併入調職）：

> - **負責人離職或調職**：人員目錄顯示負責人離職、停用或調到其他單位時，通知他原本的主管在寬限期內改指派負責人，新負責人確認接下才生效；新負責人不能是這個被授權者的單的簽核人。調職時，專案與 agent 可以由原負責人本人確認續任；團隊一定要改指派。寬限期內，簽核中的單不能再核准；逾期自動撤銷。

**新增一點，貼在「被授權者」最後**：

> - **外部人員**：委外、派遣、顧問等外部人員（依人員目錄的雇用類型判斷；判斷不出來的視為外部人員）目前不能碰 L3、L4 的資料：不能申請、不能簽核、不能當被授權者負責人；團隊裡有外部成員時不能送審或核准，系統會說明原因。生效中的團隊多了外部成員，系統通知負責人在 2 個工作天內從群組移出，逾期撤銷該團隊的授權。（D99 (2)。）

**「預設時限」表新增兩列**：

> | 團隊出現外部成員，移出的期限 | 2 個工作天 |
> | 調職後仍在原單位團隊，提醒負責人的期限 | 7 天 |

## 3. 資料模型與參數

### 3.1 資料表（核心，`db/kernel/610_directory_groups.sql`、`615_person_unit.sql`、`620_employment_kind.sql`）

| 表 | 欄位 | 只增不改 | 說明 |
|---|---|---|---|
| `sgn.person_unit` | `id`、`person_id`、`source`、`unit_ref`（目錄的單位識別，LDAP 是 DN）、`unit_name`、`valid_from timestamptz`、`recorded_at`、`event_seq` | 是 | 目前的單位＝最後一筆已生效的；改變走冷卻期（`directory.sync_cooling_workdays`），期間記 `directory.person_change_deferred`（沿用） |
| `sgn.employment_kind_map` | `source`、`raw_value`、`kind`（`regular`、`intern`、`contractor`、`dispatch`、`consultant`）；主鍵 `(source, raw_value)` | 只經 migration | 對照表是資料；換身分來源只換這張表與 adapter |
| `sgn.person_employment` | `id`、`person_id`、`source`、`raw_value`、`kind`（對照表的值或 `unknown`）、`valid_from`、`event_seq` | 是 | 目前的類型＝最後一筆。變成外部（收緊）立即生效；外部變正職（放寬）過冷卻期 |
| `sgn.directory_group` | `id`、`source`、`group_ref`（DN）、`name`、`owner_external_id`、`unit_ref`（擁有單位）、`first_seen_at`、`event_seq`；唯一 `(source, group_ref)` | 是（後續變化記在下兩張） | 目錄說它是團隊的群組 |
| `sgn.directory_group_state` | `group_id`、`kind`（`seen`、`owner_changed`、`gone`）、`detail`、`at`、`event_seq` | 是 | |
| `sgn.principal_member_event` | `id`、`principal_id`、`person_id`（對不到人時 null）、`external_id`、`kind`（`added`、`removed`）、`source`、`at`、`event_seq` | 是 | 目前的成員＝依 `principal_id, external_id` 取最後一筆為 `added` |
| `sgn.principal`（不改表） | 團隊由同步建立：`source = 目錄來源代碼`、`external_ref = group_ref` | — | 沿用 `principal_upsert`；`status` 改 `ended` 只經新入口 `principal_end_mark` |
| `sgn.principal_owner_gap`（加欄） | `cause text not null default 'departed' check (cause in ('departed', 'transferred', 'ineligible', 'source_owner_changed'))` | — | `transferred`：專案、agent 允許原負責人續任；`source_owner_changed`：原負責人仍在職，逾期只留例外、不撤銷 |
| `sgn.directory_source`（加欄） | `groups_baseline_at`、`employment_baseline_at` | — | 第一次完整的群組／雇用同步完成的時間；之前雇用類型「沒有紀錄」視為正職（不擋），之後視為 `unknown` |

### 3.2 流程類型選項

`data_access` 的 `options` 加 `allows_external_members: false`、`allows_external_applicant: false`（核心選項，骨幹第 3 節；「外部」的定義是參數 `employment.external_kinds`）。

### 3.3 參數

| key | 型別 | 預設 | 界限 | 適用範圍 | 說明 |
|---|---|---|---|---|---|
| `employment.external_kinds` | json | `["contractor","dispatch","consultant","unknown"]` | 只能加 | — | 算外部人員的類型 |
| `employment.decider_kinds` | json | `["regular"]` | 只能減 | — | 能被解析為簽核人、能當被授權者負責人的類型（`K-EXTERNAL-SPONSOR` 的「非正職不得為負責人或簽核人」） |
| `directory.group_max_change_percent` | integer | 20＊ | 1–100 | — | 完整群組快照中團隊數或成員數的變動超過就整批拒絕並開例外 |
| `directory.transfer_bulk_max` | integer | 5＊ | 1–100 | — | 一次同步調離單位超過這個人數，全部延後並開例外（防改組或改名被當成大量調職） |
| `directory.transfer_member_grace_days` | integer | 7＊ | 1–30 | — | G4 |
| `data_access.external_member_grace_workdays` | integer | 2＊ | 0–10 | `tier` | G5：生效中的團隊多出外部成員，限期移出 |
| `directory.team_group_filter`（adapter 設定，不是資料庫參數） | — | — | — | — | 哪些群組是團隊；sim 是 `businessCategory=team`。列在 `api/src/config.ts` 的環境變數定義，`deploy/.env.example` 照規範比對 |

## 4. SQL function、轉移、規則代碼、錯誤代碼

### 4.1 function

| schema.function | 簽章 | 誰可呼叫 | 規則 |
|---|---|---|---|
| `sgn_internal.directory_entry_problem`（`create or replace`） | 允許的鍵加 `unit_ref`、`unit_name`、`employment_raw`（三個都必填，`employment_raw` 可為空字串） | 核心 | `K-HR-SYNC` |
| `api_sync.directory_apply`（`create or replace`，同簽章） | 套用單位（冷卻、`transfer_bulk_max`）與雇用類型（對照、收緊立即、放寬冷卻）；第一次帶雇用欄位的完整快照寫 `employment_baseline_at` | `sgn_sync` | `K-HR-SYNC`、`K-EMPLOYMENT-KIND`、`K-HR-TRANSFER` |
| `api_sync.directory_groups_apply`（新） | `(p_source text, p_kind text, p_total int, p_groups jsonb) returns jsonb`；每個群組 `{group_ref, name, owner_external_id, unit_ref, members: [external_id]}`；只收完整快照（`p_kind = 'full'`） | `sgn_sync`（同一次同步，在 `directory_apply` 之後） | `K-TEAM-SYNC` |
| `sgn_internal.team_sync_group` | `(p_source text, p_group jsonb) returns jsonb` | 核心：新群組 → 負責人對得到人、在職、類型在 `decider_kinds` 才 `principal_upsert`（kind `team`），否則不建並開例外 `K-TEAM-SYNC`（`no_owner`、`owner_ineligible`）；負責人變了 → 開 `principal_owner_gap`（`cause = 'source_owner_changed'`）並提議目錄上的新負責人，由他用通行金鑰接下；成員差異寫 `principal_member_event` | `K-TEAM-SYNC` |
| `sgn_internal.principal_end_mark` | `(p_principal_id uuid, p_rule_code text, p_detail jsonb) returns void` | 核心：群組消失 → 團隊 `ended`（事件進鏈），之後由既有的 `principal_end_due` 撤銷 | `K-TEAM-SYNC`、`K-PRINCIPAL-END` |
| `sgn_internal.person_employment_kind` | `(p_person_id uuid) returns text` stable | 核心：目前類型；基準前沒有紀錄回 `regular`，基準後回 `unknown` | `K-EMPLOYMENT-KIND` |
| `sgn_internal.person_is_external` | `(p_person_id uuid) returns boolean` stable | 核心：類型在 `employment.external_kinds` | `K-EMPLOYMENT-KIND` |
| `sgn_internal.principal_external_members` | `(p_principal_id uuid) returns jsonb` stable | 核心：目前成員中外部人員或對不到人的 external_id | `K-EXTERNAL-PARTY` |
| `sgn_internal.decider_denial`（`create or replace`） | 類型不在 `employment.decider_kinds` → 不合格（走既有的往上找） | 核心 | `K-EXTERNAL-PARTY` |
| `sgn_internal.denial_reason`（case 版，`create or replace`） | 選項關閉時：申請人是外部 → `EXTERNAL_APPLICANT_BLOCKED`（送審、核准）；被授權者有外部成員 → `EXTERNAL_MEMBER_BLOCKED`（送審、核准）；退回、駁回、撤回照常 | 核心 | `K-EXTERNAL-PARTY` |
| `sgn_internal.owner_candidate_problem`（第四批的提議與接下共用檢查，`create or replace`） | 新負責人類型不在 `decider_kinds` → `OWNER_CANDIDATE_INVALID`；`cause = 'transferred'` 且被授權者是專案或 agent 時允許原負責人本人 | 核心 | `K-OWNER-CONTINUITY`、`K-HR-TRANSFER` |
| `sgn_internal.person_transfer_apply` | `(p_person_id uuid, p_from jsonb, p_to jsonb) returns void` | 核心：單位改變生效的同一個交易：他負責、仍有效的被授權者各開缺口（`cause = 'transferred'`，主管＝調職前的主管關係） | `K-HR-TRANSFER` |
| `api_job.principal_checks`（`create or replace`，同簽章）與新的 `sgn_internal.owner_gaps_ineligible`、`transfer_member_stale_check` | 加三件事：(1) 負責人類型變成不合格 → 開缺口 `ineligible`；(2) `source_owner_changed` 逾期只留例外、不撤銷；(3) 調職後 `transfer_member_grace_days` 仍在原單位團隊 → 例外通知團隊負責人 | `sgn_scheduler` | `K-OWNER-CONTINUITY`、`K-HR-TRANSFER` |
| `sgn_internal.external_member_check` ／ `api_job.external_member_check` | `() returns jsonb` | 排程：選項關閉的流程類型，生效中授權的團隊有外部成員 → `exception_open_due`（`DA-EXTERNAL-BLOCK`，期限 `external_member_grace_workdays`）通知負責人、控制負責人；逾期仍有 → 名下該流程類型的生效中授權 `grant_end('revoked', …, 'DA-EXTERNAL-BLOCK')`；移出了 → 結案 | `K-EXTERNAL-PARTY`、`DA-EXTERNAL-BLOCK` |
| `sgn_internal.usage_external_check`（新；`api_job.usage_checks` 以 `create or replace` 多呼叫它） | `() returns int`：選項 `allows_external_applicant` 關閉的流程類型，`sgn.usage_summary` 的 `person_id` 是外部人員或為 null（對不到人）→ 例外 `K-EXTERNAL-USAGE`（同一張單同一個操作人每期一筆），通知被授權者負責人與控制負責人 | `sgn_scheduler` | `K-EXTERNAL-USAGE` |
| hook `review_signals`（第七批，`create or replace` 流程包實作） | 加 `member_changed`（上期以來成員有增減）、`team_unlinked` | 流程包 | `DA-REVIEW-SIGNALS` |
| `api.principal_get`（新） | `(p_session text, p_principal_id uuid) returns jsonb` | 被授權者負責人、控制負責人、稽核：成員清單（姓名、單位、類型、加入時間）、外部成員警示；其他人只看到人數與是否有外部成員 | `K-TEAM-SYNC` |

團隊的既有授權在第一次群組同步之後才知道成員：群組基準之前就存在、但沒有對應群組的團隊（種子或手動建立的）標為「未對應」——送審時 `PRINCIPAL_UNLINKED`（新申請擋下），既有授權照舊有效、在定期複查標 `team_unlinked`。對應關係由 migration 依負責人提供的清單寫入（開放問題 Q4）。

### 4.2 adapter 與模擬目錄

`db/tools/directory-sync.mjs`：

- 人員多讀 `ou`（單位名稱）與 `businessCategory`（雇用類型原值）；單位名稱經 `ou=org` 樹找唯一的單位 DN 當 `unit_ref`，找不到或不唯一 → 那個人的 `unit_ref` 為空字串並讓資料庫以 `DIRECTORY_ENTRY_INVALID` 整批拒絕（從嚴，不猜）。
- 群組：`businessCategory=team` 的 `groupOfNames` 是團隊，讀 `cn`、`owner`、`ou`、`member`；其他群組照舊當角色（團隊群組不得再進 `roles`）。
- 一次同步先 `directory_apply` 再 `directory_groups_apply`；第二個失敗不影響第一個。

`sim/ldap`：

- `seed-ldif.mjs`：人員加 `businessCategory: regular`；依種子文件新增的「團隊」表產生團隊群組（`businessCategory=team`、`owner`、`ou`＝擁有單位）。種子文件 `docs/contract/seed-directory.md` 加「團隊」表（現有種子團隊各對應一個群組）。
- `change.sh` 加：`team-create <cn> <負責人 uid> <單位> <成員 uid>...`、`team-remove <cn>`、`set-owner <群組> <uid>`、`set-kind <uid> <類型原值>`。既有的 `transfer`、`group-add`、`group-remove` 照用。
- `README.md` 的目錄內容表補 `businessCategory` 與團隊群組。

### 4.3 狀態轉移表

`principal_owner_gap` 第四批是 check constraint 的狀態欄；這批把它併入轉移表：`entity = 'owner_gap'`：`open --reassign--> reassigned`、`open --restore--> restored`、`open --expire_revoke--> revoked`、`open --expire_keep--> lapsed`（新，`source_owner_changed` 逾期），並以 `create or replace` 讓 580 的改狀態處改走 `entity_next_state`（行為不變）。`principal` 的 `active --end--> ended` 也進轉移表（`entity = 'principal'`）。

### 4.4 新規則代碼

| 代碼 | 說明 |
|---|---|
| `K-TEAM-SYNC` | 目錄的團隊群組由人員同步建立、更新成員與負責人、結束團隊；負責人對不到或不合格就不建並開例外；負責人變更要新負責人以通行金鑰接下；群組變動超過門檻整批拒絕 |
| `K-EMPLOYMENT-KIND` | 雇用類型由目錄原值經對照表換算；對不到視為 `unknown`；收緊立即、放寬過冷卻期 |
| `K-EXTERNAL-PARTY` | 非 `decider_kinds` 不得被解析為簽核人或當負責人；流程選項關閉時，外部人員不得當申請人，被授權者有外部成員時不能送審與核准；生效中出現外部成員限期移出，逾期撤銷 |
| `K-HR-TRANSFER`（partial） | 單位改變（冷卻、批量門檻）時，他負責的被授權者開缺口；專案、agent 可由本人續任；調職後仍在原單位團隊開例外 |
| `DA-EXTERNAL-BLOCK` | 資料授權不開放外部人員（D99 (2)）：選項關閉、擋下的訊息、逾期撤銷 |
| `K-EXTERNAL-USAGE` | 選項關閉的流程類型，使用紀錄的操作人是外部人員或對不到人時開例外 |

`K-OWNER-CONTINUITY` 的 note 去掉「沒有調職偵測」；`K-PRINCIPAL-END` 的 note 去掉「團隊解散沒有來源」，兩者 coverage 改 `full`。

### 4.5 新錯誤代碼

| code | message | http |
|---|---|---|
| `EXTERNAL_APPLICANT_BLOCKED` | 外部人員（委外、派遣、顧問）目前不能申請 L3、L4 的資料；請由內部的負責人提出 | 403 |
| `EXTERNAL_MEMBER_BLOCKED` | 這個團隊有 %s 位外部成員，目前不能申請或核准 L3、L4 的資料；請團隊負責人先從群組移出 | 409 |
| `PRINCIPAL_UNLINKED` | 這個團隊還沒有對應人員目錄的群組，平台不知道成員是誰，暫時不能申請 | 409 |
| `DIRECTORY_GROUP_INVALID` | 群組同步的資料格式不正確 | 422 |
| `DIRECTORY_GROUPS_OVER_THRESHOLD` | 群組同步的變動超過門檻，整批沒有套用，已開例外 | 409 |

## 5. 路由與畫面

`routes` 加 `principal_get(session, principal_id)`；`principal`、`principalChoice` 形狀加 `members_count`、`external_members`（bool）、`linked`（bool）；`ownerGap` 加 `cause`、`may_continue`。`syncCalls` 加 `directoryGroupsApply`；`schedulerCalls` 加 `external_member_check`。

| 角色 | 動作 | 步數（390px） | 步驟 |
|---|---|---|---|
| 申請人 | 選到有外部成員的團隊 | 0 | 新申請的被授權者選項標「有外部成員，不能申請」並停用；送審時同訊息 |
| 外部人員 | 想申請 | 0 | 新申請頁直接顯示 `EXTERNAL_APPLICANT_BLOCKED` 的訊息，不顯示表單 |
| 團隊負責人 | 看成員 | 1 | 被授權者頁點開團隊 |
| 團隊負責人 | 收到外部成員警示 | 0 | 通知與首頁卡片：哪個人、期限、逾期撤銷哪些單；移出在目錄做 |
| 主管 | 調職的負責人改指派 | 3 | 同第四批（首頁「負責人異動」區塊，原因顯示「調職」） |
| 原負責人 | 專案或 agent 續任 | 2 | 首頁「確認續任」→ 通行金鑰 |

## 6. 測試清單

資料庫測試（以 fixture 呼叫 `api_sync`，不連 LDAP）：

`db/tests/kernel/79a-directory-groups.test.mjs`：

| 規則代碼 | 測試 |
|---|---|
| `K-TEAM-SYNC` | 新群組建團隊；負責人對不到 → 不建、例外；負責人是外部 → 不建；群組消失 → `ended`，下一輪 `principal_checks` 撤銷名下授權 |
| `K-TEAM-SYNC` | 成員增減寫事件並通知負責人；變動超過 `group_max_change_percent` → 整批拒絕、什麼都不改；增量快照 → `SYNC_KIND_REQUIRED` |
| `K-TEAM-SYNC` | 目錄改負責人 → 缺口 `source_owner_changed`，新負責人通行金鑰接下才換；逾期不撤銷 |
| `K-EMPLOYMENT-KIND` | 原值對照；對不到 → `unknown`；基準前沒有紀錄視為正職、基準後視為 `unknown`；外部 → 正職要過冷卻期，正職 → 外部立即 |
| `K-HR-TRANSFER` | 單位改變過冷卻期後開缺口 `transferred`；團隊不能本人續任、專案可以；一次超過 `transfer_bulk_max` 人 → 延後並開例外；7 天後仍在原單位團隊 → 例外 |

`db/tests/packs/data_access/89c-external-block.test.mjs`：

| 規則代碼 | 測試 |
|---|---|
| `K-EXTERNAL-PARTY` | 外部人員被解析到主管關 → 往上找；資料擁有者是外部 → 找同角色其他人；外部人員當新負責人 → `OWNER_CANDIDATE_INVALID` |
| `DA-EXTERNAL-BLOCK` | 外部申請人送審 → `EXTERNAL_APPLICANT_BLOCKED`；團隊有外部成員送審、核准 → `EXTERNAL_MEMBER_BLOCKED`；退回仍可 |
| `DA-EXTERNAL-BLOCK` | 生效中的團隊多一位外部成員 → 例外、通知；2 個工作天內移出 → 結案不撤銷；逾期 → 撤銷並交付撤回；事件記參數值 |
| `DA-EXTERNAL-BLOCK` | 對不到人的成員視同外部；未對應的團隊送審 → `PRINCIPAL_UNLINKED` |
| `K-EXTERNAL-USAGE` | 使用摘要的操作人是外部或對不到人 → 例外一筆；同期重報不重開 |
| `DA-REVIEW-SIGNALS` | 成員有增減 → 複查訊號 `member_changed` |

端對端 `e2e/tests/system-zz-group-sync.test.mjs`（真的 `sim/ldap`，最後 `sim/ldap/reset.sh`）：(1) `change.sh team-create` → 同步 → 團隊出現在新申請的選項；(2) `set-kind` 把一位成員改成委外 → 同步 → 390px 的新申請畫面該團隊停用並顯示訊息；生效中的單在假時鐘 2 個工作天後被撤銷、DC 查不到；(3) `transfer` 負責人 → 同步、過冷卻期 → 主管在首頁看到「調職」的改指派並完成。同一個檔案也是人員與組織 port 的合約測試（讀群組、單位、雇用類型）。

架構測試：新表都擋 UPDATE、DELETE、TRUNCATE（`principal_owner_gap` 除外，改狀態只經轉移表）；`api_sync` 只有 `sgn_sync` 能執行（`12-grants`）。

## 7. 威脅小表

| 誰 | 想做什麼 | 怎麼擋 | 殘餘 |
|---|---|---|---|
| 目錄管理者 | 把外部人員直接加進有授權的團隊群組 | 同步後限期移出，逾期撤銷；使用紀錄偵測 | 限期內（2 個工作天）外部人員可透過 DC 使用；平台不改目錄 |
| 目錄管理者 | 把外部人員的類型改成正職 | 放寬過冷卻期並進鏈；`directory.person_change_deferred` 有例外 | 來源本身被改就是來源的說法（`K-HR-SYNC`：錯在來源就改來源） |
| 目錄管理者 | 刪群組讓團隊解散、撤銷別人的授權 | 群組變動門檻；撤銷只收回權限 | 單一團隊被刪只會被撤銷（從嚴，可重新申請） |
| 拿到同步帳號的人 | 假造調職讓授權 14 天後被撤銷 | 冷卻期、批量門檻、14 天寬限期內主管與治理角色都收到通知 | 同第四批 §4.1 |
| 拿到同步帳號的人 | 改團隊負責人成同夥 | 新負責人要通行金鑰接下；原負責人在接下前仍是負責人；新負責人不能是該團隊單的簽核人 | — |
| 申請人 | 用專案或 agent 繞過團隊的外部成員檢查 | 申請人本人不能是外部；使用紀錄偵測 | 平台不知道專案、agent 的實際使用者，只能事後偵測 |
| 使用方 | 以自己的群組名單判斷成員、與平台不同 | 見開放問題 Q3 | 名單不同時平台的擋下對使用方無效 |

## 8. 接點、可能衝突、開放問題

| # | 接點或衝突 | 處理 |
|---|---|---|
| 1 | sim 目錄的 `employeeType` 目前代表在職或離職 | 不改它；雇用類型用另一個屬性 `businessCategory` |
| 2 | 目前每個群組都被當成角色 | 團隊群組排除在角色之外（adapter），否則團隊名會變成「沒有登記的群組名稱」被忽略——行為不變，但要寫明 |
| 3 | 第四批 `OWNER_CANDIDATE_INVALID`「不能是原負責人」 | 只在 `cause = 'transferred'` 且為專案、agent 時放寬；要負責人確認（C7） |
| 4 | 第七批查核案的會計師成員 | 外部人員不能當查核案成員（第七批 Q1） |
| 5 | rules.md「團隊：讀取組織資料」與「團隊解散時，相關授權自動撤銷」 | 條文改寫為對應目錄群組；機制沿用 `K-PRINCIPAL-END` |
| 6 | 骨幹 `K-MEMBER-REDUCE`「團隊成員隨人事事件自動異動」 | 成員增加不重簽（rules.md 沒有要求）；但外部成員一律擋下 |

開放問題（只有負責人知道的事實）：

- Q1：正式的 AD 裡，哪些群組算「團隊」（某個 OU、命名規則、或屬性）？負責人記在哪個屬性（`managedBy`、`owner`）？建議：專用 OU 加 `managedBy`；adapter 設定 `directory.team_group_filter`。
- Q2：AD 用哪個屬性、哪些值分辨正職、派遣、委外、顧問？建議：`employeeType`，原值由人資定義後寫進 `employment_kind_map`；在那之前對不到的都視為外部（會擋下，所以上線前一定要先有答案）。
- Q3：使用方系統（DC 背後）判斷「誰屬於這個團隊」是讀同一個 AD 群組嗎？建議：是；若不是，要在交付裡帶成員名單（另一批，交付格式要改）。
- Q4：現有的團隊被授權者各對應哪一個 AD 群組？建議：負責人提供對照清單，由 migration 一次寫入；沒有對應的團隊停止新申請。
