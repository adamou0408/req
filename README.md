# 稽核級簽核平台（sgn）

通用的簽核平台，讓每一個決定都可問責、核准的內容不走樣、紀錄改不掉。核心（kernel）與領域無關，各種申請以「流程包」加入。

目前只有一個流程包做完整個流程：

- **資料授權**（`data_access`）：L3、L4 資料的授權申請；核准結果輸出成規則，交給外部資料系統（DC）套用、驗證、對帳。
- **合約用印**（`seal`）：示範用，只有契約，尚未實作。

核心的做法：資料庫自己驗證「這個決定來自本人」（通行金鑰或身分提供者的簽章，在資料庫內驗章）；業務規則只寫在資料庫的 SQL function；後端只負責轉送與對外工作；稽核事件進雜湊鏈並定期錨定到外部。

## 目前狀態

開發中，不是可上線的版本。`main` 隨進度更新，尚未驗證的 commit 以 `wip:` 開頭。最近一次經複核的結果（`docs/decision-log.md` D96，閉環第二批，乾淨狀態）：資料庫測試 320、通行金鑰對照組 16、瀏覽器端對端 38 全過，`tools/check.sh` 全部通過。之後的閉環第三批（`docs/handoff/closed-loop-3.md`）尚未複核。

| 項目 | 狀態 |
|---|---|
| 方向、工程規範、UI/UX 驗收標準 | 已定稿 |
| 契約骨幹 `00-spine.md` | 是 v2 的完整設計，實作只做了一部分；各節現況見該檔檔頭的表 |
| 核心：身分與 session、通行金鑰與 `idp_stepup` 決定證明、稽核雜湊鏈與錨定、簽核路徑與職責分離、角色異動、人員同步防護 | 已實作，資料庫測試通過 |
| 資料授權：申請、多關簽核、系統對系統交付、自動驗證、申請人確認、生效、到期、撤銷、對帳、使用紀錄摘要、資料目錄版本綁定、能力宣告、測試區與正式區、測試報告、匯出需求調查 | 已實作；端對端用模擬的手機瀏覽器，未用真機 |
| 模擬環境 `sim/`：OpenLDAP、Dex（OIDC）、Mailpit（SMTP）、DC 模擬器 | 可用 |
| 紅隊：八輪，第八輪沒有高風險發現（D90） | 每個成立的攻擊都有可重跑的腳本（`redteam/exploits/`）；`34`、`40` 是已接受的殘餘風險 |
| 簽核關卡的催辦與升級、群組認領逾期、到期前提醒、負責人離職的改指派與逾期撤銷、被授權者結束時授權失效 | 已實作（功能第四批 `docs/handoff/feature-4-deadlines.md`；尚未經複核與紅隊）；沒有調職偵測、離任當天暫停、升級前預告 |
| 代理與助理、續期、批次、急件、定期複查、緊急路徑 | 未實作 |
| 公司別、組織與雇用實體、人事事件處置、設定變更單、環境與發行、機密內容服務、封套加密、第二個錨定位置 | 未實作 |
| 對外整合介面（`api_client`、`check`、`grants`、webhook、複查）；`05-integration.md` 的多數內容 | 未實作；對帳與使用紀錄走另一條路（平台向使用方系統拉取，D92） |
| 其餘流程包（合約用印、系統帳號、程式變更上線、供應商銀行帳號、治理範本） | 合約用印只有契約；其餘沒有規則文件 |
| 管理畫面、部署（`deploy/`）、離線驗證工具 `tools/verify/` | 未開始（鏈的離線驗證在 `db/tools/verify-chain.mjs`） |
| 工程規範要求但尚未做：產生器與 `docs/reference/`、`generated/`、產生檔無差異檢查；sqlfluff、knip、Trivy、hadolint、actionlint | 未做（`docs/handoff/promote.md` §7） |

細節與沒做到的事：`docs/handoff/` 的索引 [docs/handoff/README.md](docs/handoff/README.md)，最後幾份是 `closed-loop-1.md` 到 `closed-loop-3.md` 與 `feature-4-deadlines.md`。

## 目錄結構

| 路徑 | 內容 |
|---|---|
| `db/kernel/` | 核心 migration（編號越小越先套用；已套用的不得修改，只能新增） |
| `db/packs/data_access/` | 資料授權流程包的 migration（表、hook、流程定義、參數） |
| `db/seed/` | 示範與驗收用的種子資料（不進正式環境） |
| `db/testing/` | 測試專用 migration（假時鐘等），只裝在測試資料庫 |
| `db/tests/` | 資料庫測試：`kernel/`、`packs/data_access/` |
| `db/tools/` | 背景程式與工具：錨定、排程、鏈驗證、授權產生器、規則覆蓋檢查 |
| `db/build.sh` | 建置開發與測試用資料庫並跑資料庫測試 |
| `packages/contract/` | 路由表與回應形狀（API 的唯一來源） |
| `api/` | 薄後端：登入轉送、通用 handler、交付、對帳、寄信（對外系統走 port 與 adapter） |
| `web/` | 手機優先的前端（原生 JS，`pages/`、`packs/`） |
| `e2e/` | 瀏覽器端對端測試（含通行金鑰對照組 `e2e/reference/passkey`） |
| `sim/` | 模擬環境：`ldap`、`idp`、`mail`、`dc` |
| `tools/` | `check.sh`（品質關卡）、`run-all.sh`（整套系統與全部測試）、`install-dev-tools.sh`、`commit-guard.sh` |
| `redteam/` | 紅隊的發現與可重跑的攻擊腳本（`exploits/`） |
| `docs/` | 文件（見下） |

這是 npm workspaces monorepo（`packages/contract`、`api`、`web`、`e2e`、`tools`、`db`），只有根目錄有 `package-lock.json`；Node 版本見 `.nvmrc` 與 `package.json` 的 `engines`。

## 怎麼跑

前提：Linux、root、Node 22、PostgreSQL 16、全域安裝的 Playwright 瀏覽器（預設 `/opt/pw-browsers`）。開發工具先裝：`tools/install-dev-tools.sh`。

```bash
npm ci                         # 依 package-lock.json 安裝
tools/check.sh                 # 全部檢查（格式、lint、型別、shellcheck、plpgsql_check、禁止字串、追蹤檔案、npm audit、sim/dc），最後跑 tools/run-all.sh
tools/check.sh --fast          # 只做靜態檢查，不跑 tools/run-all.sh
tools/run-all.sh               # 起模擬環境與各背景程式 → 建庫與資料庫測試 → 通行金鑰對照組 → 端對端測試，跑完停掉
tools/run-all.sh --keep        # 同上，跑完讓系統繼續跑；瀏覽器開 http://localhost:3001（不是 127.0.0.1）
db/build.sh --no-test          # 只建庫（要先 sim/up.sh ldap idp）
sim/up.sh / sim/down.sh / sim/status.sh   # 模擬環境的啟動、停止、狀態
```

`tools/run-all.sh` 與 `db/build.sh` 要以 root 執行（各背景程式以自己的作業系統帳號啟動）。試用帳號、密碼與角色見 `docs/handoff/promote.md` §8。紅隊的攻擊腳本在 `redteam/exploits/`（每支一個攻擊，結束碼非 0 代表弱點還在）。

## 文件地圖

同一件事只有一個來源（`docs/engineering-standards.md` §1），其他文件引用它。

| 要知道 | 唯一來源 |
|---|---|
| 目標、策略、目前的賭注、修正的規則（最上層的依據） | [docs/00-direction.md](docs/00-direction.md) |
| 產品定位、核心與流程包的分工 | [docs/platform-vision.md](docs/platform-vision.md) |
| 為什麼這樣決定（衝突時的判斷） | [docs/decision-log.md](docs/decision-log.md) |
| 工程規範（單一真相來源、架構、抽象層、品質關卡、測試、紅隊） | [docs/engineering-standards.md](docs/engineering-standards.md) |
| UI/UX 驗收標準 | [docs/ux-acceptance.md](docs/ux-acceptance.md) |
| 命名、核心實體、狀態、流程包介面（設計；各節現況見檔頭） | [docs/contract/00-spine.md](docs/contract/00-spine.md) |
| 資料授權的業務規則 | [docs/packs/data-access/rules.md](docs/packs/data-access/rules.md)（驗收案例、待確認問題、匯出用途同目錄） |
| 合約用印的業務規則 | [docs/packs/seal/rules.md](docs/packs/seal/rules.md) |
| 資料授權的契約（含交付信封與證明 §8.8、目錄版本 §8.6、使用紀錄 §8.7） | [docs/contract/02-pack-data-access.md](docs/contract/02-pack-data-access.md) |
| 合約用印的契約 | [docs/contract/03-pack-seal.md](docs/contract/03-pack-seal.md) |
| 對外整合介面的設計（多數尚未實作；檔頭有現況表） | [docs/contract/05-integration.md](docs/contract/05-integration.md) |
| 使用方系統（外部資料系統）要照做的事 | [docs/contract/06-consumer-obligations.md](docs/contract/06-consumer-obligations.md) |
| 還沒併入契約的增修與已知缺口 | [docs/contract/pending-amendments.md](docs/contract/pending-amendments.md) |
| 種子人員與組織 | [docs/contract/seed-directory.md](docs/contract/seed-directory.md) |
| 規則代碼、錯誤代碼、參數、函式簽章 | 資料庫（`sgn.rule`、`sgn.error_catalog`、`sgn.setting_definition`、`pg_catalog`） |
| API 端點與參數 | [packages/contract/src/routes.ts](packages/contract/src/routes.ts) |
| 各階段做了什麼、怎麼執行、沒做到什麼 | [docs/handoff/README.md](docs/handoff/README.md)（索引） |
| 控制對照表（稽核的控制與平台怎麼做到） | [docs/audit/control-matrix.md](docs/audit/control-matrix.md) |
| 紅隊的發現與攻擊腳本 | `redteam/findings*.md`、`redteam/exploits/` |
| 模擬環境的用法 | [sim/README.md](sim/README.md)、`sim/dc/README.md` |
| 背景研究、現實檢驗、方法論、線框 | `docs/research/`、`docs/reality-check/`、`docs/methodology/`、`docs/wireframes/`、`docs/validation-cases.md`；對外說明頁在 `docs/site/` |

`docs/contract/` 裡的設計文件與實作不同時，以實作為準；各檔檔頭或標題下的現況行標明差異。`docs/sql-functions.md`、`docs/api.md` 與產生的 `docs/reference/` 目前都不存在（產生器尚未做）。

## 給代理與協作者

動手前先讀 [CLAUDE.md](CLAUDE.md) 與 `docs/engineering-standards.md`。溝通與文件用繁體中文，識別字用英文。業務規則只有 `docs/packs/<流程包>/rules.md` 一個來源，不得改寫；發現矛盾就回報。
