# 工程規範

這份文件是程式碼品質要求的唯一來源。所有人和所有代理動手前都要先讀。

## 1. 單一真相來源（SSOT）

每一種資訊只能有一個來源，其他地方用「讀取」或「產生」取得，不得手抄。

| 資訊 | 唯一來源 | 其他地方怎麼取得 |
|---|---|---|
| 業務規則的定義 | `docs/decisions.md` | 文件引用，不重寫 |
| 業務規則的實作 | `db/migrations` 裡的 SQL function | 後端、前端不得重寫任何業務判斷 |
| 規則代碼 | 資料表 `das.rule` | 稽核事件、測試名稱、文件都引用代碼；對照表由腳本產生 |
| 錯誤代碼、訊息、HTTP 狀態 | 資料表 `das.error_catalog` | SQL 只能透過 `das_internal.raise_error(代碼)` 丟錯；後端啟動時讀表；前端直接顯示後端回傳的訊息 |
| 狀態、級別等列舉值 | 資料庫的 enum 或代碼表 | 由產生器輸出成 TypeScript |
| 設定值與預設值 | 資料表 `das.setting` | 透過 api function 讀取 |
| SQL function 的簽章 | 資料庫本身（`pg_catalog`） | 產生器輸出 TypeScript 型別與參考文件 |
| API 端點（路徑、對應的 function、參數、回應型別） | `packages/contract/src/routes.ts` | 後端依這張表註冊路由；前端依這張表產生呼叫函式；參考文件由腳本產生 |
| 介面文案 | `web/src/i18n/zh-Hant.ts` | 元件只引用 key |
| 環境變數 | `api/src/config.ts` 的定義 | `deploy/.env.example` 由測試比對，不一致就失敗 |
| 套件版本 | 根目錄的 `package-lock.json` | 一律 `npm ci` |
| 工程規範 | 本文件 | `CLAUDE.md` 只引用本文件 |

規則：

- 產生的檔案放在 `generated/` 目錄或 `docs/reference/`，檔頭註明「自動產生，請勿手動修改」。CI 會重新產生並檢查沒有差異。
- `docs/sql-functions.md` 和 `docs/api.md` 是設計階段的契約。實作完成後，以產生的 `docs/reference/` 為準，設計契約標示為「已由參考文件取代」。
- 發現同一件事寫在兩個地方，就視為缺陷，要收斂成一處。

## 2. 架構

依賴方向只有一個：`web → api → db`。越靠近資料庫，責任越重。

### 資料庫

- `das`：資料表。應用程式角色 `das_app` 沒有任何資料表權限。
- `api`：對外 function，`SECURITY DEFINER` 並固定 `search_path`。`das_app` 只能執行這裡的 function。
- `das_internal`：共用的內部函式。
- migration 檔案依模組切分；後面的檔案可以呼叫前面的，反過來不行。需要反向呼叫時，把共用部分移到核心檔案。
- 每一類橫切邏輯只有一個入口：授權檢查、狀態轉移、稽核寫入、錯誤丟出、取得現在時間、通知寫入。任何 function 不得自己另寫一套。
- 狀態轉移由一張轉移表驅動，不散落在各 function 的 `if` 裡。
- 已經套用到任何環境的 migration 不得修改，只能新增。

### 後端

- 分層：路由表（`packages/contract`）→ 通用 handler → `callApi` → 資料庫。
- 對外系統一律走 port 與 adapter：SSO、mail、DC、人員與組織、MFA。
- 不得出現依狀態、角色、級別做判斷的程式碼；需要判斷就代表該邏輯應該放進 SQL function。

### 前端

- 分層：頁面 → 共用元件 → API 呼叫層。頁面不直接呼叫 `fetch`。
- 畫面要顯示或隱藏哪個按鈕，依後端回傳的「可執行動作」清單，不自行依狀態推斷。
- 手機優先：每個頁面在 390px 寬不得水平捲動，觸控目標至少 44px。

## 3. 可讀性

- 命名：SQL 用 `snake_case`，function 用「動詞_名詞」；TypeScript 用 `camelCase`，型別與元件用 `PascalCase`。同一個概念全專案只用一個名字。
- 長度：SQL function 超過約 80 行、TypeScript 函式超過約 40 行，就拆出有名字的小函式。
- 註解寫「為什麼」，不寫「做了什麼」。和業務規則有關的地方標上規則代碼。
- 每個 `api` function 都要有 `COMMENT ON FUNCTION`：用途、誰可以呼叫、對應的規則代碼。
- SQL 格式：關鍵字小寫、縮排 4 個空白、一個子句一行。
- TypeScript 開啟 `strict`，不使用 `any`；ESLint 與 Prettier 零警告。
- 不留 `TODO`、`FIXME`、被註解掉的程式碼、沒有用到的程式碼。
- 不用假資料或空殼充數。做不到或沒做完的事，明確寫進 `docs/handoff/` 並在回報中說明。

## 4. 套件管理

- 整個 repo 是一個 npm workspaces monorepo：`packages/contract`、`api`、`web`、`e2e`、`tools`。只有根目錄有 `package-lock.json`。
- Node 版本寫在 `.nvmrc` 和 `package.json` 的 `engines`。
- 版本一律精確鎖定（`save-exact`），安裝一律 `npm ci`。
- 共用設定放在根目錄：`tsconfig.base.json`、`eslint.config.js`、Prettier 設定，各 workspace 繼承。
- 新增套件的門檻：標準函式庫做得到、或 30 行內寫得完，就不加。要加時在 handoff 說明用途。不得有功能重複的套件。
- 資料庫擴充套件只用 `pgcrypto`。
- CI 依序執行：`npm ci`、lint、型別檢查、資料庫測試、後端測試、前端測試、產生檔無差異檢查、`npm audit`（high 以上視為失敗）。

## 5. 測試

- `docs/decisions.md` 的每一條規則至少有一個資料庫測試，測試名稱包含規則代碼。腳本會檢查 `das.rule` 的每個代碼都有測試。
- 架構測試（查 `pg_catalog`）：
  - `api` 的每個 function 都是 `SECURITY DEFINER`、固定 `search_path`、第一個參數是 `p_actor`、有 `COMMENT`。
  - `das_app` 沒有任何資料表權限。
  - 稽核紀錄表擋下 `UPDATE`、`DELETE`、`TRUNCATE`。
- 契約測試：路由表引用的每個 function 都存在且參數相符；每個 `api` function 都有路由，或明確列為只供內部排程使用。
- 不得為了讓測試通過而跳過、停用或放寬測試。測試失敗就修程式。

## 6. 工作方式

- 動手前先讀：本文件、`docs/decisions.md`、與任務相關的契約段落、`docs/handoff/` 裡的交接紀錄。
- 只修改自己負責的範圍。需要動到別人的範圍時，寫進交接紀錄並回報。
- 完成前必須實際執行驗證（安裝、建置、lint、測試），並在回報中附上指令與結果。
- 完成時更新 `docs/handoff/<代號>.md`：做了什麼、怎麼執行、和契約不同的地方、留給下一位的事項。
