# 交接：sim-dc（sim/dc，模擬的外部資料系統）

> **本檔寫於 2026-11-20，以下已過時：「與契約不同的地方」中的規則格式代碼與信任清單（格式唯一來源已改為 `docs/contract/02-pack-data-access.md` §8.8，信封與回應證明由 `redteam-fixes-4.md` 加上）；「限制」中的「沒有簽章」「沒有時間戳或 nonce」與「留給下一位」中的平台 adapter 路徑（`api/src/packs/data_access/dcPort.ts` 不存在，現為 `api/src/dcHttp.ts`、`deliveryPort.ts`）；只描述一個資料庫 `sim_dc` 與 `sim_dc_test`、不含測試區與正式區兩組 schema、使用紀錄與目錄版本（見 `closed-loop-1.md`、`closed-loop-2.md`）。仍有效：sim/dc 的用法與端點以 `sim/dc/README.md` 為準；本檔的驗證結果與規則隔離的做法仍有效。**

用法、端點與格式的細節在 `sim/dc/README.md`；這裡寫做了什麼、驗證了什麼、給平台那一側的對接說明、與契約不同的地方、限制。

## 做了什麼

- `sim/dc/`：Node 22 + TypeScript 的獨立服務（只有 `pg` 一個執行期套件；開發用 `typescript`、`@types/node`、`@types/pg`，版本對齊根目錄的 lock）。自己的 `package.json` 與 `package-lock.json`，**不在根目錄的 workspaces**；安裝到 `sim/.run/dc/app/`。tsconfig 與 Prettier 設定和根目錄相同（因為不是 workspace，tsconfig 不繼承，選項照抄 `tsconfig.base.json`）。
- 資料庫 `sim_dc`（合成資料）與 `sim_dc_test`（遮罩資料），同一個行程以路徑前綴 `/v1`、`/masked/v1` 服務兩者。服務以 `simdc_service`（非 superuser、`CREATEROLE`）運作；superuser 只用來建立這個角色與兩個資料庫。
- 示範資料：四個主題包（客戶主檔、銷售訂單、產品成本明細、員工薪資），代碼與平台的 `db/seed/packs/data_access/010_catalog.sql` 相同（有測試比對）。約 1.4 萬列，因為有資料期間的主題包每天都有資料（理由見 README）。
- 套用：每個被授權者一個 `NOLOGIN` 身分角色 `simdc_p_<principal_id>`（不持有資料權限），每條規則再一個規則角色 `…_r<雜湊>`；欄位層級權限與該規則的 RLS policy（授權起迄、列條件、資料期間）只掛在規則角色上；匯出走每個規則角色專屬的 `security_invoker` 檢視表，與查詢是兩個分開的權限。每次異動整個重算該被授權者的權限，因此冪等、縮小、撤回與清除都是真的變小。
- 規則來源：Ed25519 簽章（格式見下）。沒簽章、金鑰不受信任、簽章不符、內容改過都 401，資料庫不變。
- 呼叫方：每個呼叫方一把預先設定的金鑰（`platform`、`auditor`、`admin`），各有可用範圍；每次呼叫寫進 `simdc_meta.call_log`。
- 測試查詢：真的 `SET ROLE` 成被授權者角色查資料庫，回 allow／deny／no_data 與筆數，不回資料；分得出「被權限擋下」和「本來就沒有資料」。
- 對帳回報：從系統目錄讀（`has_column_privilege`、`pg_policy`、角色說明、匯出檢視表），格式是 05 §8.3 的上傳項目。
- 管理後門（只供測試）：多給／少給欄位或匯出、刪 policy、拿掉列條件、讓一條規則套用時默默失敗、重設。
- 遮罩環境與沙箱：`/masked/v1/sandbox/runs` 執行一組查詢，以 `EXPLAIN (VERBOSE, FORMAT JSON)` 回報實際讀到的主題包、欄位與條件，並回筆數。

## 怎麼執行

```bash
sim/dc/start.sh        # 或 sim/up.sh dc
sim/dc/health.sh
sim/dc/test.sh         # 型別檢查＋76 個測試；測試用自己的資料庫與 unix socket，不占 7001
sim/dc/stop.sh
```

## 驗證結果（2026-11-20）

| 指令 | 結果 |
|---|---|
| `sim/dc/test.sh` | tsc 無錯誤；76 個測試全部通過（9 個檔案），約 8 秒（原 57 個加 `08-isolation`、`09-purge` 共 19 個） |
| `shellcheck -x sim/dc/*.sh` | 無訊息 |
| `node_modules/.bin/eslint --no-ignore --max-warnings 0 sim/dc/src sim/dc/tests`（根目錄設定） | 無訊息。根目錄的 ESLint 與 Prettier 設定忽略 `sim/`，所以 `tools/check.sh` 不會檢查這裡；我以同一份設定手動跑過 |
| `prettier --ignore-path /dev/null --check`（根目錄設定） | 已套用 |
| `npm audit`（sim/dc 的 lock） | 0 個弱點 |
| `start.sh` → `health.sh` → 重複 `start.sh`（不重啟）→ `stop.sh` 兩次 → `health.sh` 失敗 → `start.sh` | 符合 sim 慣例 |
| `sim/status.sh`（只讀） | 列出 `dc healthy 127.0.0.1:7001, pg 127.0.0.1:5432` |
| 對開發用服務以 curl 簽章套用 02 §5.10 範例 1、測試查詢、對帳 | 正常 |

測試涵蓋（檔名）：`08-isolation`（A／B 兩單交叉、匯出不跨規則、同一列符合兩條規則、授權期間隔離、對帳數字）、`09-purge`（清除前後的對帳、目錄、冪等、重送不復活）、`01-apply`（範圍內查得到；範圍外欄位、列條件外、期間外、未授權的主題包、到期後、起日前、不可匯出都被擋；可匯出與 `export: null`；no_data 與測試列；系統目錄裡的權限；02 §5.11 範例 1 的 9 個驗證案例全部等於預期）、`02-change`（冪等、同版不同內容、縮小、較舊版本、部分撤回、全部撤回後角色消失、撤回後重送舊規則被拒、撤回請求重放無效）、`03-signature`（沒簽章、不受信任的金鑰、冒用金鑰代號、內容被改、只改空白、格式錯誤、撤回也要簽章、呼叫方驗證與範圍、結構錯誤）、`04-reconcile`（格式；後門多給欄位與匯出、少給欄位、拿掉列條件、刪 policy 都看得到；重新套用後回到規則的樣子；套用默默失敗看得出少了；到期規則與 `exclude_inactive`）、`05-injection`（列條件值與測試查詢值帶引號、分號、註解、聯集、反斜線、dollar quote；代碼類輸入；被授權者以登入帳號自己設定查詢日期無效）、`06-masked`（遮罩值、沙箱回報、沙箱只能查詢、角色與正式環境分開）、`07-catalog`（目錄代碼與平台種子一致）。

## 給平台那一側的對接說明

DC adapter（`http`，02 §8.5）的 `{base}` 是 `http://127.0.0.1:7001/v1`。

| 動作 | 要送什麼 | 會收到什麼 |
|---|---|---|
| 交付 `deliver` | `PUT {base}/rule-sets/{case_no}`；本文是 `build_fulfilment` 的輸出原樣；標頭 `Authorization: Bearer <platform 金鑰>`、`Sgn-Signature`；可帶 `X-Request-Id`（只記錄） | 200 `{"status":"applied","dc_ref"}`；401／409／422 `{"status":"failed","code","error"}` → adapter 回 `failed` 附 `error` |
| 撤回 `withdraw` | `DELETE {base}/rule-sets/{case_no}`；本文 `{"request_id","case_no","rule_ids"?}`（就是 `withdraw_request`），**也要簽章** | 200 `{"status":"withdrawn"}`；404 沒有這張單或規則 |
| 驗證 `verify` | `POST {base}/test-queries`；本文是 `verify_request`（不需簽章：不改權限） | `{"status":"completed","results":[{"code","actual","reason","detail"}]}` |
| 對帳 | `GET {base}/reconciliation?exclude_inactive=1` | `items` 可直接上傳到 `POST /integration/v1/reconciliation/runs/{run_id}/items`；`observed_at` 用回應裡的 |

簽章：`Sgn-Signature: keyid="<代號>", alg="ed25519", sig="<base64>"`，被簽的是 `"sgn-dc-sig/1\n"` 加上**本文的原始位元組**。所以簽章與送出要用同一串位元組：建議在資料庫裡簽（`convert_to(rule_set::text, 'UTF8')`），後端原樣送出那串文字，不要 `JSON.parse` 再 `JSON.stringify`。開發環境的私鑰在 `sim/.run/dc/keys/platform-dev.private.pem`（`start.sh` 產生）；正式環境改成平台自己的金鑰，DC 設定公鑰。

其他要注意的：

- **`entitlement_id` 一律是 null**：規則裡沒有權限項目的 id，DC 不知道。對帳項目的 `properties` 有 `case_no`、`rule_id`、`case_version_no`；要讓平台逐筆比對（05 §8.3「依來源拆開」），建議在 `data_access_rule_set` 加上每條規則對應的 `entitlement_id`，DC 就能寫進 policy 並回報。
- **主體用平台內部 id**：對帳的 `subject.id` 是規則裡的 `principal_id`，`properties.provider` 是 `sgn`。依 05 §3.2，DC 的 `api_client` 要把 `sgn` 列入 `allowed_providers`（需登記原因），或平台為 DC 建 `principal_identity` 並把它放進規則。
- 版本：同一張單只接受更新的 `case_version_no`；撤回後同一版不能再套用。平台重新執行時沿用同一版同內容是冪等的。
- 不同受管系統：規則的 `rules[].system` 必須在 `SIM_DC_SYSTEMS`（預設 `dc hr_saas`，因為種子把 `payroll` 放在 `hr_saas`，而這個模擬器也放了薪資資料）。

## 與契約不同的地方

| 項目 | 契約 | 這裡 | 理由 |
|---|---|---|---|
| 規則格式代碼 | 02 §5.10、§8.1：`dc_rule_set/1` | 只接受 `data_access_rule_set/1` | 任務指定以 `build_fulfilment` 的實際輸出為準；兩者要收斂成一個（屬於 db/ 與契約的負責人） |
| `principal_id` | 02 §5.10 範例是整數 | 接受 UUID 或正整數 | 實際輸出是 UUID |
| `rules[].system` | 02 §5.10 沒有 | 必填並檢查 | 實際輸出有這個鍵 |
| 驗證案例沒有對應資料列 | 02 §8.5：回 `error` | `/test-queries` 在交易內插入一列測試資料再判斷（`detail.row_source = "probe"`），最後 rollback | 數字列條件（例如 §5.11 範例 3 的 `order_amount = 100000`）不可能預先備好所有值；判定仍是資料庫做的。`/test-query` 預設不插入，回 `no_data` |
| `verify_result.results[]` | `code`、`actual`、`reason` | 另加 `detail`（`db_role`、`rows_matching`、`rows_visible`、`row_source`） | 給人除錯；核心只比對 `actual` |
| `reason` | 七個代碼 | 另有 `row_level_security`（列被擋下但辨識不出是哪個條件，例如 policy 被直接改過） | 照實回報 |
| 撤回請求 | 02 §8.5 只寫了 `withdraw_request` 的格式 | 本文就是 `withdraw_request`，要簽章；`rule_ids` 可省略 | 撤回也會改權限，要能確認來源 |

## 限制（做不到或沒做的事）

- **（已修）同一個被授權者有多張單時的交叉合併**：現在每條規則一個 `NOLOGIN` 角色（`simdc_p_<id>_r<雜湊>`），欄位權限、RLS policy、匯出檢視表都只掛在該規則的角色上；被授權者角色本身只是身分錨點，沒有資料權限。實際可讀範圍恰好是各規則範圍的聯集，對帳每個項目只帶自己規則的限制。代價：真實使用者要以「規則角色」的身分連線；若把所有規則角色用繼承授予同一個登入帳號，PostgreSQL 會把欄位權限併起來，又回到交叉合併。測試查詢因此對每個規則角色、每個欄位各查一次，再要求同一列的每個欄位都被某條規則放行（一次查詢多個欄位時，不同規則可以各自涵蓋一部分欄位）。
- **（已修）到期的權限**：新增 `POST {base}/maintenance/purge-expired`（platform 金鑰，可由排程呼叫，不需簽章，只收回授權迄日已過的規則），清除後角色、欄位權限、policy、匯出檢視表都從目錄上消失；清除是單向的，同一版重送不會讓它回來（新版本才會）。清除前對帳以 `properties.lifecycle` 分 `effective`／`expired_uncleared`／`not_yet_valid`；`exclude_inactive=1` 的行為不變。到期當下 RLS 即擋下的行為不變。限制：沒有內建排程，要由平台或 cron 定時呼叫；清除用 DC 資料庫的 `current_date`，不接受指定日期。
- **L1、L2 欄位不在規則裡**：`normalize_content` 把 L1、L2 移出申請（自動開放），所以規則只有 L3、L4。DC 照規則執行，不會給 L1、L2 的權限。「自動開放」在 DC 上要怎麼落地（基本角色？）契約沒有寫，需要平台那一側決定。
- **沒有人員帳號**：被授權者角色是 `NOLOGIN`，DC 不管誰是成員。測試查詢以服務連線 `SET ROLE` 執行；`05-injection` 另以臨時的登入帳號驗證被授權者自己連進來時 `simdc.as_of` 無效。
- **重算會蓋掉直接改動**：任何一次套用或撤回會把該被授權者在資料庫裡的權限回到規則描述的樣子（包括後門做的改動）。這是刻意的，但也表示「漂移」只在下一次異動之前看得到。
- **沙箱**：以執行計畫為準。掃描節點的 Output 可能是整張表的欄（physical tlist），所以只在它是最上層節點時採用，其他節點的 Output 與所有條件、排序、分組運算式都算；單一資料表時 EXPLAIN 不加別名，改以欄名比對（字串常數先去掉）。可能多報（例如 `Sort` 轉手的欄），也可能漏報經由函式或其他 schema 的物件取得的資料（`other_relations` 會列出其他 schema 的資料表）。條件以 EXPLAIN 的文字回報，沒有轉回列條件的結構，也沒有和申請的範圍比對。沙箱角色可讀遮罩資料庫的全部資料。
- **容器**：`sim/lib/container/Dockerfile` 沒有 PostgreSQL，`sim/docker-compose.yml` 的容器裡跑不起來這個服務。那兩個檔案不在我的範圍，沒有修改。
- **只用 Ed25519、金鑰清單是檔案**：沒有金鑰輪替的流程（多放一把公鑰即可並存）、沒有撤銷清單、沒有時間戳或 nonce；重放靠版本號與 `request_id` 擋。
- **沒有跑 `sim/up.sh`、`sim/down.sh`**（任務規定）；只以 `sim/dc/start.sh`、`stop.sh` 驗證，`status.sh` 只讀。`depends_on` 沒有寫：PostgreSQL 不是 sim 的服務。
- PostgreSQL 是共用的；`test.sh` 會重建 `sim_dc_check`、`sim_dc_check_test` 並刪除 `simdc_t_` 開頭的角色。

## 留給下一位

- 平台的 DC adapter（`api/src/packs/data_access/dcPort.ts` 的 `http`）照上面的表實作，並對著 `sim/dc` 跑合約測試（02 §8.5 的 8 列語意表與 §5.11 的案例；`01-apply` 已經驗證過同一組 9 個案例）。
- 收斂規則格式代碼（`dc_rule_set/1` 與 `data_access_rule_set/1`），決定 `entitlement_id` 與被授權者外部識別碼要不要放進規則。
- 決定 L1、L2「自動開放」在 DC 上的做法。
- 如果要在容器裡跑，`sim/lib/container/Dockerfile` 要加 PostgreSQL（或改連主機的 PostgreSQL）。

## 規則隔離改版：調整的既有測試（逐項原因）

結構改變：欄位權限與 policy 從被授權者角色移到規則角色（名稱 = 被授權者角色 + `_r<雜湊>`），被授權者角色本身沒有資料權限。斷言的內容沒有放寬，只是改成對規則角色查。

- `01-apply` 的「欄位層級權限與列層級安全」：欄位權限、匯出檢視表、policy 數量（仍是 2）改對「規則角色們」彙總。
- `02-change`、`04-reconcile`、`05-injection`：對帳項目與目錄狀態的篩選由「`db_role` 等於被授權者角色」改成「以被授權者角色加 `_r` 開頭」。
- `05-injection` 的「被授權者自己連進來」：登入帳號改成規則角色的成員；驗證的內容（`simdc.as_of` 無效、讀不到未授權欄位與 `simdc_meta`）不變。
- 後門 `grant_column`／`revoke_column` 新增選用的 `rule_id`；沒給時多給的欄位落在該主題包第一條規則的角色，少給則所有規則角色都收回，原有案例的行為不變。
