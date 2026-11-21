# 長期維運手冊（sgn）

給接手的 MIS 管理員、資安、稽核。目標：三到五年內不靠原作者也能維運。

- 撰寫日期：2026-11-21。依據：當日的 `db/`、`api/`、`web/`、`tools/`、`packages/contract/src/routes.ts`、`docs/decision-log.md`（D81–D98）、`docs/handoff/`、`redteam/findings-*.md`。
- 每個指令都是 repo 裡真的存在的檔案；查不到依據的地方寫「程式裡沒有，需要補」，並列在 [gaps.md](gaps.md)。

## 先讀這一段：現況的三個事實

1. **目前只有開發與驗收環境，沒有正式環境的部署。** 沒有 `deploy/` 目錄、沒有 CI 設定檔（`.github/` 不存在）、沒有 systemd 或容器的服務定義。所有背景程式由 `tools/run-all.sh` 啟動，連的是端對端資料庫 `sgn_e2e`（`db/sgn.env`），身分提供者、人員目錄、郵件、外部系統都是 `sim/` 的模擬服務（`api/src/config.ts` 直接讀 `sim/idp/service.env`）。
2. **唯一的安裝程序 `db/build.sh` 會刪掉資料庫重建。** 它先 `drop database ... with (force)`、重建所有角色並換新密碼、清空錨點檔（`db/tools/provision-secrets.mjs`）。`tools/check.sh` 最後會跑 `tools/run-all.sh`，也就會跑 `db/build.sh`。**在有真實資料的主機上執行 `tools/check.sh`、`tools/run-all.sh` 或 `db/build.sh` 等於清掉全部資料與稽核鏈。** 這三支只能在獨立的驗證主機上跑。
3. **例外沒有人工結案的入口。** 例外只有開立（`sgn_internal.exception_open`）與少數幾種「狀況解除時自動結案」；稽核頁只能看，不能處理或結案（見 [exceptions.md](exceptions.md)）。

因此本手冊分兩種內容：「現在就能照做」的（標 **可執行**），和「正式上線前必須先補的程式」（標 **尚未實作**，對應 gaps.md 的編號）。

## 索引

| 檔案 | 內容 |
|---|---|
| [exceptions.md](exceptions.md) | 每一個例外代碼：代表什麼、誰收到通知、該做什麼、多久內、怎麼結案、不處理的後果 |
| [programs.md](programs.md) | 九個背景程式的職責、作業系統帳號、密鑰檔、停掉時的表現、誰會知道、怎麼重啟 |
| [backup-restore.md](backup-restore.md) | 要備份什麼、還原步驟、還原後怎麼驗稽核鏈與錨點、演練紀錄格式 |
| [upgrade.md](upgrade.md) | migration 只增不改之下的升級與回退、升級前後檢查、Node／PostgreSQL／套件的年度更新 |
| [key-rotation.md](key-rotation.md) | 系統裡每一種金鑰與密鑰：存在哪、誰能讀、怎麼輪替、外洩時怎麼辦 |
| [break-glass.md](break-glass.md) | 破窗：用資料庫最高權限直接處理的程序、見證、事前事後紀錄、稽核複核 |
| [gaps.md](gaps.md) | 要真的維運三五年還缺的程式與工具，依嚴重度排序 |

## 角色分工

角色代碼來自 `db/kernel/210_role_registry.sql`；誰被通知由參數決定（`sgn.setting_definition`，下表是預設值）。角色是「角色指派」，不是寫死的人；人員異動時改指派，不改程式。

| 平台角色（代碼） | 誰 | 在維運裡做什麼 | 不能做什麼 |
|---|---|---|---|
| 技術維運（`tech_ops`） | MIS 管理員 | 主機、PostgreSQL、背景程式、備份、升版、看 log；收 K-PROGRAM-STALLED（`program.stalled_notify_roles`） | 不能做簽核決定（`approval.excluded_decider_roles` 預設含 `tech_ops`）；不得自己執行破窗 |
| MIS（`mis`） | MIS 的資安合規窗口 | 收交付與對帳的升級通知（`delivery.escalation_roles` 預設 `["mis","ciso"]`）；可撤銷授權（`grant.revoker_roles`） | — |
| 系統管理人（`system_custodian`，依受管系統） | 各外部系統的管理人 | 人工執行的系統套用與移除權限（K-DELIVERY-MANUAL 通知他） | — |
| 資安長（`ciso`）與其代理人 | 資安 | 收大多數安全例外；**破窗的見證人**（D98） | 不執行破窗的 SQL |
| 稽核主管（`audit_head`）、稽核（`auditor`） | 內部稽核 | 稽核頁看證據、例外、程式存活（`api.program_health` 只限稽核角色）；**破窗事後複核**（D98）；保存平台外的見證紀錄 | 不能做簽核決定 |
| 稽核治理人、董事長、母公司指定主管（治理類） | 治理角色 | 收身分提供者金鑰變更（`identity.idp_key_notify_roles`） | — |
| 通行金鑰登記人（`passkey_registrar`） | 至少 2 位、互不為主管 | 替別人的第一把金鑰背書；少於 `passkey.registrar_min`（2）會開 K-REGISTRAR-MIN | — |
| 資料庫擁有者（`sgn_owner`，NOLOGIN） | 只能經主機 root 的本機 peer 連線 `set role` | migration、登記金鑰、破窗 | 平時不使用 |

「資安長代理人」在程式裡**沒有獨立的角色代碼**（只有 `ciso`）。指定代理人時以角色指派讓代理人也持有 `ciso`，或在破窗紀錄寫明代理依據（見 [break-glass.md](break-glass.md)；gaps.md G-17）。

## 例行工作清單

下列「可執行」的指令都以 root 在專案根目錄執行（各程式的密鑰檔只有 root 與該程式帳號讀得到）。

### 每日（技術維運，約 10 分鐘）

- [ ] 以稽核角色的人打開稽核頁（`web/pages/audit.js`）：最上方的「背景程式」狀態是否全綠（`api.program_health`）。這一頁打開時資料庫會順便跑一次存活檢查，所以就算所有背景程式都停了，打開它也會開 K-PROGRAM-STALLED。**可執行**
- [ ] 稽核頁的「例外」清單：有沒有新的未結案例外，依 [exceptions.md](exceptions.md) 的處置表分派。**可執行**（只能看；結案入口尚未實作，gaps G-02）
- [ ] 背景程式有沒有被監看重新啟動過：`grep -c '結束（結束碼' .run/*.log`（這行字由 `tools/run-all.sh` 的監看寫入）。次數增加就看該程式的 log 尾段。**可執行**
- [ ] 錨點存放處有沒有在收：`curl -fsS "$SGN_ANCHOR_ORIGIN/anchors"`（`source db/sgn.env` 之後；開發環境是 `http://localhost:3002/anchors`），最後一筆的 `anchored_at` 是否在幾分鐘內。**可執行**

### 每週（技術維運＋稽核）

- [ ] 全量驗證稽核鏈與錨點：`node db/tools/verify-chain.mjs sgn_e2e`，結束碼 0 才算通過；把輸出存檔（見 backup-restore.md 的紀錄格式）。**可執行**
- [ ] 檢查備份確實產生、而且能還原到另一台主機（見 backup-restore.md）。**尚未實作**（沒有備份程式，gaps G-03）
- [ ] 外部系統的人工執行單（K-DELIVERY-MANUAL）有沒有積壓：稽核頁例外清單依規則代碼看筆數。**可執行**

### 每季

- [ ] 在**獨立的驗證主機**上從乾淨狀態跑 `tools/check.sh`，並以 `tools/run-all.sh --keep` 建起系統後依序跑 `redteam/exploits/01-*.mjs` 到最新一支（見 upgrade.md §4）。已接受的殘餘 34、40 回 1；57 是資訊項。**可執行（只在驗證主機）**
- [ ] 角色持有人盤點：登記人至少 2 位且互不為主管；治理類持有人都有可用的通行金鑰（K-GOVERNANCE-KEY 未結案的就是沒有）。**可執行**（看稽核頁的例外）
- [ ] 破窗紀錄複核：這一季有沒有破窗；有的話稽核依 break-glass.md §6 複核。**可執行**
- [ ] 檢查 `npm audit --audit-level=high --omit=optional`（`tools/check.sh` 也會跑）。**可執行**

### 每年

- [ ] 登記下一年度的休假日到 `sgn.calendar_holiday`（營業日計算的唯一來源，`sgn_internal.is_workday`）。**尚未實作**：沒有登記入口，也不支援補班日（gaps G-09）。
- [ ] Node 與 PostgreSQL 的支援期限檢查與升級規劃（見 upgrade.md §5）。Node 22 的上游支援在 2027-04 結束，PostgreSQL 16 在 2028-11 結束，都落在三到五年內。**可執行（規劃）**
- [ ] 還原演練（含錨點存放處與密鑰）與破窗演練各一次，留紀錄。**尚未實作**（gaps G-03、G-04）
- [ ] 金鑰輪替（見 key-rotation.md）。**尚未實作**：目前只有重建能換金鑰（gaps G-05）。
- [ ] 紅隊：依工程規範 §5，每完成一條路徑或修完安全問題就要有一輪；一年內沒有任何一輪時至少排一輪。**可執行**

## 這份手冊怎麼維護

- 新增例外代碼、背景程式或金鑰時，同一個變更要更新對應的 ops 文件；本手冊列的抓取指令（exceptions.md §1）重跑後和表格對不上，就是文件落後。
- 本手冊不重寫業務規則（`docs/packs/<流程包>/rules.md`）與契約（`docs/contract/`），只引用。
