# sim/dc：模擬的外部資料系統（DC）

一個獨立的小服務（Node 22 + TypeScript，唯一的執行期套件是 `pg`），加上它自己的 PostgreSQL 資料庫。收到平台核准的規則後，把它套用成**真正的資料庫權限**：每個被授權者一個身分角色、**每條規則一個角色**（欄位層級的權限、列層級安全 RLS 都掛在規則角色上，所以不同規則互不交叉）、匯出另外授權。測試查詢與對帳都是對資料庫的真實操作。只供開發與測試；不含平台的業務判斷，收到什麼規則就執行什麼。

實作到平台定義的「外部系統交付介面」完整等級（裁決 D81 (2)；格式的唯一來源 `docs/contract/02-pack-data-access.md` §8.8）：平台簽的請求帶通道、環境、方法、路徑與期限（信封）；整張單撤回＝封存，之後任何版本都不收；每個環境各自的信任清單；**每個回應都帶 DC 自己簽的證明**（請求摘要、平台給的一次性亂數、HTTP 狀態與結果），對帳回報也是。另外回報自己用的目錄版本（02 §8.6）、提供使用紀錄的批次摘要（02 §8.7）。

## 怎麼跑

```bash
sim/dc/start.sh            # 實例 main（7001）。第一次會安裝套件、產生這個實例的密鑰、建立資料庫與示範資料（幾秒）
SIM_DC_INSTANCE=unit sim/dc/start.sh   # 實例 unit（7002）：平台的資料庫測試（sgn_test）專用
sim/dc/start.sh --reset    # 重建兩個資料庫的結構與示範資料，刪除所有被授權者角色
sim/dc/health.sh           # /health 回 ok（HTTP 在、兩個資料庫都連得上）才回 0
sim/dc/stop.sh
sim/dc/test.sh             # 型別檢查＋全部測試；可以只給檔案：sim/dc/test.sh tests/01-apply.test.ts
```

- **實例**：`main`（`service.env`，平台端對端用的 `sgn_e2e` 連它）與 `unit`（`instances/unit.env` 只覆寫不同的值：埠、資料庫、服務角色、角色前綴）。兩個平台資料庫的單號都從 1 編起，各自一個實例才不會互相覆蓋或撤回對方的單。平台的 `db/build.sh` 啟動兩個實例、寫信任清單、登記回應金鑰。
- **密鑰不在 repo**：每個實例第一次啟動時（`cli.ts init-secrets`）在 `sim/.run/<實例>/keys/`（0700）產生 `secrets.env`（服務的資料庫密碼、三個呼叫方的金鑰，隨機）與回應證明的 ES256 金鑰對；之後沿用。平台的建置以 root 讀取，再只把 platform 金鑰發給交付程式、auditor 金鑰發給對帳程式（`db/tools/provision-secrets.mjs`）。

- 需要 Node 22.18 以上（直接執行 TypeScript）、npm、curl、jq，以及一個 PostgreSQL 16（與開發環境共用，連線見下）。
- 程式與 `node_modules` 安裝在 `sim/.run/dc/app/`（repo 可能以唯讀掛載）；log 在 `sim/.run/dc/dc.log`。
- 設定的唯一來源是 `service.env`、`instances/<實例>.env`（非機密）與實例的 `keys/secrets.env`（執行期產生）。superuser 連線沒有另外設定時讀 `db/admin.env` 的 `SGN_PG_ADMIN_URL`，只用來建立本服務的登入角色與資料庫。那是本機 unix socket 的 peer 連線（以 root 執行；裁決 D84 (1)：superuser 不得經 TCP 以密碼登入，`db/build.sh` 在 `pg_hba.conf` 拒絕）。
- **測試不占用 7001、7002**：`test.sh` 另外啟動一份服務，聽 `sim/.run/dc/test/dc.sock`，用資料庫 `sim_dc_check`、`sim_dc_check_test`、服務角色 `simdc_t_service`、角色前綴 `simdc_t_`，以及自己產生的密鑰與兩把平台測試金鑰（正式與遮罩環境各一把）。開發用的服務在跑也不受影響。

## 資料庫

| 項目 | 值 |
|---|---|
| 資料庫 | `sim_dc`（合成資料）、`sim_dc_test`（遮罩資料，結構相同） |
| 服務的登入角色 | `simdc_service`（main）、`simdc_u_service`（unit）：擁有資料表，`CREATEROLE`，不是 superuser；密碼在實例的 `keys/secrets.env` |
| 被授權者角色 | `simdc_p_<principal_id>`（遮罩資料庫是 `simdc_m_p_…`）；UUID 去掉連字號，或正整數。`NOLOGIN`，身分的錨點，不持有資料權限 |
| 規則角色 | `simdc_p_<principal_id>_r<規則代碼雜湊>`，每條有效的規則一個；`NOLOGIN`。欄位權限、policy、匯出檢視表只掛在它上面 |
| 時區 | `Asia/Taipei`（授權起迄與「今天」） |

| schema | 內容 | 被授權者看得到什麼 |
|---|---|---|
| `data` | 四張表：`customer_master`、`sales_order`、`product_cost`、`payroll`。欄名就是平台目錄的欄位代碼，另有列條件欄（`region`、`product_line`、`pay_type`）與技術鍵 `row_id` | 每條規則的角色：該規則給的欄位＋`row_id` 的欄位權限、該規則的一個 RLS policy |
| `export` | 每個可以匯出的規則角色、每個主題包一個檢視表（`security_invoker`） | 只有自己的那一個 |
| `simdc` | RLS 用的判斷函式（`rule_match`、`rule_reason`、`as_of`） | 執行權 |
| `simdc_meta` | 服務收到的規則、撤回請求、呼叫紀錄 | 沒有 |

示範資料（合成）：客戶 240 筆；訂單每天每區一筆、成本每天每產品線一筆（2024-01-01～2027-12-31）；薪資 60 人每月 5 日、2 月與 7 月 10 日發獎金。有資料期間的主題包每天都有資料，因為平台的驗證案例會查「期間起日」與「前一天」這種任意日期。遮罩資料：L3、L4 的文字換成固定代號（同值同代號）、數字加雜訊；列條件欄位與日期保留。

## 呼叫方（`Authorization: Bearer <金鑰>`）

金鑰在實例的 `keys/secrets.env`（執行期隨機產生）。

| 呼叫方 | 金鑰變數 | 可以做 |
|---|---|---|
| `platform` | `SIM_DC_KEY_PLATFORM` | 套用、撤回、查規則、測試查詢、對帳、沙箱 |
| `auditor` | `SIM_DC_KEY_AUDITOR` | 查規則、對帳、使用摘要 |
| `admin` | `SIM_DC_KEY_ADMIN` | 查規則、測試查詢、對帳、使用摘要、代替使用者查詢（`/use`）、**管理後門** |

## 端點

`{base}` 是 `http://127.0.0.1:7001/v1`（合成資料）或 `http://127.0.0.1:7001/masked/v1`（遮罩資料）；兩者端點相同。

| 方法與路徑 | 用途 | 本文 → 回應 |
|---|---|---|
| `GET /health` | 健康檢查（不需金鑰） | → `{"status":"ok","databases":{…}}` |
| `PUT {base}/rule-sets/{case_no}` | 套用規則（**要簽章**） | `data_access_rule_set/1` → `{"status":"applied","dc_ref":"DC-{case_no}-v{版}","catalog_sha256"}` |
| `DELETE {base}/rule-sets/{case_no}` | 撤回（**要簽章**） | `{"request_id","case_no","rule_ids"?}` → `{"status":"withdrawn"}`；省略 `rule_ids` 是全部 |
| `GET {base}/rule-sets`、`GET {base}/rule-sets/{case_no}` | 服務收到並接受了哪些規則（服務自己的紀錄） | → 規則清單 |
| `POST {base}/maintenance/purge-expired` | 清除授權期間已結束的規則（可由排程呼叫；platform 金鑰；不需簽章，只會收回已過期的） | `{}` → `{"status":"purged","count","purged":[{"case_no","rule_id","db_role"}]}` |
| `POST {base}/test-query` | 以某個被授權者的身分真的查一次 | `{"principal_id","query","probe_missing_row"?}` → 見下 |
| `POST {base}/test-queries` | 平台的驗證（02 §8.8） | `{"request_id","run_id","rule_set","cases"}` → `{"status":"completed","results":[{"code","actual","reason","detail"}],"catalog_sha256"}` |
| `GET {base}/reconciliation[?exclude_inactive=1]` | 對帳回報：資料庫裡實際存在的權限 | → 見下 |
| `GET {base}/usage-summaries` | 使用紀錄的批次摘要（02 §8.7） | → `usage_summary_batch/1` |
| `POST {base}/use` | 代替實際操作的人查一次並記下使用 | 見「使用紀錄」 |
| `POST /masked/v1/sandbox/runs` | 遮罩環境的沙箱 | `{"queries":[{"name","sql"}]}` → 見下 |
| `POST {base}/admin/{操作}` | **管理後門，只供測試** | 見下 |

失敗一律回 `{"status":"failed","code","error"}`：401 金鑰或簽章不對（`signature_invalid`）、簽章過期（`signature_expired`）、403 呼叫方沒有權限、409 版本衝突（`conflict`）、這張單已封存（`archived`）、簽章指定的通道／環境／方法／路徑和這次請求不同（`target_mismatch`）、422 規則或查詢的結構不對、不是信封（`invalid_envelope`）、404 沒有這張單。請求本文要帶 `content-length`。環境前綴底下的**每個回應**（含失敗）都另有 `attestation`（見「簽章格式與回應的證明」）。

### 套用的語意

- 只接受 `format = data_access_rule_set/1`（`pack_data_access.build_fulfilment` 的實際輸出）。檢查的只有「能不能執行」：主題包、欄位、列條件在 DC 的目錄上、運算子與值的型別對、`rules[].system` 是本 DC 接受的（`SIM_DC_SYSTEMS`）。
- 每次套用、撤回或清除，把該被授權者在資料庫裡的權限**整個重算**：收回全部 → 依目前所有有效的規則，各自建立一個規則角色並授予。所以：同一份規則送兩次結果相同；新的一版取代舊的一版（縮小就真的變小）；直接在資料庫做的改動（例如管理後門）在下一次重算時會被蓋掉。
- 版本：同一版同內容 → 冪等；同一版不同內容、較舊的版本、已撤回的同一版 → 409（擋下重送舊的已簽章規則）。撤回請求以 `request_id` 記住，重送不會再動作。
- **撤回整張單＝封存**（省略 `rule_ids` 的撤回）：之後這張單的任何版本都 409 `archived`，連平台簽過、比較新的版本也一樣（紅隊第四輪 中-1）。沒有套用過的單也會封存（回 404）。部分撤回不封存。
- **規則互相隔離**：同一個被授權者有 A 單（欄位 a、北區）與 B 單（欄位 b、南區）時，a 只在 A 的列條件、授權期間、資料期間內可讀，b 只在 B 的範圍內可讀；實際範圍恰好是各規則範圍的聯集。匯出同樣各自隔離。
- 每條規則一個 policy（掛在該規則的角色上）：`simdc.rule_match('<規則 JSON>'::jsonb, jsonb_build_object(<條件欄>))`，判斷授權起迄（以查詢日期）、列條件（全部成立）、資料期間。`export` 是 `true` 或 `null` 時建立匯出檢視表。

### 測試查詢

`query` 是 02 §5.11 的格式：`{"package","fields","row","data_date","action","as_of"}`。

1. 以服務角色（資料表擁有者）找出 `row`、`data_date` 對得上的資料列 → `rows_matching`。沒有：回 `decision: "no_data"`（本來就沒有資料）；`probe_missing_row: true` 時改為在這個交易裡插入一列測試資料。
2. 對被授權者的每個規則角色、每個查詢的欄位，各自 `SET ROLE` 後 `select row_id, <欄位> from data.<主題包>`（匯出是該規則角色的匯出檢視表）`where row_id = any(…)`，查詢日期設為 `as_of`。一個欄位有任何規則角色放行某列，才算那一列的這個欄位讀得到；每個欄位都讀得到的列 ≥ 1 → `allow`，否則 `deny`（欄位沒有任何規則涵蓋、或列被擋下）。放不放行都是 PostgreSQL 判定。
3. 被擋下時從系統目錄讀原因（只供人閱讀）：`no_rule`、`field_not_granted`、`export_not_allowed`、`not_yet_valid`、`expired`、`row_filter`、`data_period`。
4. 整個交易 rollback，不回傳任何資料內容。

回應：`{"decision","reason","db_role","rows_matching","rows_visible","row_source"}`。`/test-queries` 對每個案例做同樣的事（一律允許插入測試列），`actual` 是 `allow`、`deny`，或查詢本身不合法時 `error`。

`as_of` 只對服務自己的連線有效：`simdc.as_of()` 只在 `session_user` 是服務角色時讀 `simdc.as_of` 設定，被授權者自己連進來設定它沒有用。

### 對帳回報

全部從系統目錄讀，不讀服務自己的紀錄：每個規則角色的欄位權限用 `has_column_privilege`（含資料表層級、角色繼承、PUBLIC），列的限制解析 `pg_policy` 的運算式，主體讀角色說明，匯出讀 `export` 檢視表的權限。

```json
{
  "format": "dc_reconciliation_report/1",
  "observed_at": "2026-11-20T02:30:00.000Z",
  "database": "sim_dc",
  "process_type": "data_access",
  "resource_type": "data_field",
  "items": [
    {
      "item_key": "simdc_p_…|sales_order.amount|read|rule_da_2026_0004_2_9823d48c",
      "subject": {"type": "principal", "id": "<principal_id>", "properties": {"provider": "sgn", "kind": "team"}},
      "resource": {"type": "data_field", "id": "sales_order.amount"},
      "action": {"name": "read"},
      "entitlement_id": null,
      "constraints": {"row_filter": [{"filter": "region", "op": "in", "values": ["central", "north"]}],
                      "data_period": {"field": "order_date", "from": "2025-01-01", "to": "2026-12-31"}},
      "properties": {"db_role": "simdc_p_…", "policy": "rule_…", "rule_id": "DA-2026-0004-2", "case_no": "DA-2026-0004",
                     "case_version_no": 1, "valid": {"from": "2026-11-16", "to": "2027-05-15"}, "effective_now": true, "lifecycle": "effective"}
    }
  ],
  "superusers": ["das_dev", "postgres"],
  "rls_disabled": []
}
```

每個項目是「一條規則 × 一個欄位 × 一個動作」，`properties.db_role` 是該規則的角色，`constraints` 只有該規則自己的列條件與資料期間（不會因為同一被授權者有別張單而變寬或變窄）。`properties.lifecycle`：`effective`（有效）、`expired_uncleared`（已到期但權限還在目錄上，還沒清除）、`not_yet_valid`；清除之後該規則的項目就不再出現。

`items` 可以直接上傳到平台的 `POST /integration/v1/reconciliation/runs/{run_id}/items`（05 §8.3）。不是服務形式的 policy（例如有人直接建了 `using (true)`）回報成沒有限制（`constraints: {}`，`properties.unrecognized_policy`）；有欄位權限卻沒有 policy 回報 `properties.no_policy`；欄位不在任何規則裡回報 `properties.column_not_in_rule`；不是服務建立的角色以角色名稱回報（`provider: dc_db_role`）。

### 沙箱（只在 `/masked/v1`）

以沙箱角色（只能讀遮罩資料庫的 `data`）在唯讀交易裡，對每個查詢做 `EXPLAIN (VERBOSE, FORMAT JSON)` 並實際執行一次，回報：

```json
{"queries": [{"name": "北區訂單", "status": "ok", "error": null, "row_count": 730,
  "packages": [{"package": "sales_order", "fields": ["amount", "customer_id", "order_date", "order_no", "region"],
                "conditions": ["(o.region = 'north'::text)", "(o.order_date >= '2026-01-01'::date)"]}],
  "other_relations": []}]}
```

只接受單一查詢語句（以 extended protocol 送出）；寫入、多個語句、讀其他 schema 會失敗。

### 簽章格式與回應的證明

格式的唯一來源是 [`docs/contract/02-pack-data-access.md` §8.8](../../docs/contract/02-pack-data-access.md)（信封 `sgn_dc_request/1`、`Sgn-Signature` 標頭、被簽的位元組、驗章後的通道／環境／方法／路徑／期限檢查、回應證明 `sgn_dc_attestation/1`）。這裡只寫模擬器的設定：

- 平台的公鑰：信任清單 `SIM_DC_TRUSTED_KEYS_FILE`（`/v1`）與 `SIM_DC_TRUSTED_KEYS_FILE_MASKED`（`/masked/v1`），格式 `{"keys":[{"key_id":"…","public_key_pem":"-----BEGIN PUBLIC KEY-----…"}]}`（SPKI PEM）。檔案不存在＝不信任任何金鑰；**沒有開發用的平台金鑰**。平台的建置（`db/tools/delivery-keys.mjs`）把對應資料庫目前那一把寫進正式環境的清單、遮罩環境的清單留空。
- 回應證明的私鑰：實例的 `keys/response.private.pem`，金鑰代號 `simdc-<公鑰 SPKI 的 SHA-256 前 16 個十六進位字>`（`keys/response.key-id`）。
- 要換做法（JWS、HTTP Message Signatures）只需要換 `src/signature.ts`。

### 目錄版本

格式與演算法的唯一來源是 02 §8.6。模擬器從自己的目錄（`src/catalog.ts`，代碼、名稱、分級、標籤、對照都和平台的種子相同）加上目前的對照覆寫（`simdc_meta.catalog_remap`，只有測試後門 `remap` 會寫）算出雜湊（`src/catalogVersion.ts`），在套用、驗證與對帳的結果裡回報 `catalog_sha256`。模擬器不比對平台送來的 `catalog`，照自己的目錄執行，由平台判斷兩邊是否一致。

### 使用紀錄

格式的唯一來源是 02 §8.7。

| 方法與路徑 | 呼叫方 | 用途 |
|---|---|---|
| `POST {base}/use` | `admin`（代替使用方系統自己的前端；範圍 `data.use`） | `{"principal_id","actor":{"provider","external_id"},"query"}`：以被授權者的身分查一次（同測試查詢，PostgreSQL 判定，不回資料），並記一筆使用（這個被授權者在這個主題包上有規則的每張單各一筆；放行算查詢或匯出、擋下算被擋） |
| `GET {base}/usage-summaries` | `auditor`、`admin`（範圍 `usage.read`） | 最近 `SIM_DC_USAGE_WINDOW_DAYS` 天、每 `SIM_DC_USAGE_PERIOD_SECONDS` 秒一個時段的批次摘要 |

### 管理後門（只供測試）

`POST {base}/admin/{操作}`，需要 admin 金鑰，`SIM_DC_ENABLE_BACKDOOR=1` 才開放，回應帶 `"test_only_backdoor": true`。直接改資料庫的權限，不經過規則，用來測試對帳抓不抓得到不一致。

| 操作 | 本文 | 效果 |
|---|---|---|
| `grant_column` | `{"principal_id","package","field","action":"read"\|"export","rule_id"?}` | 多給一個欄位（或匯出）給 `rule_id` 的角色；省略時給該主題包第一條規則的角色 |
| `revoke_column` | 同上 | 少給一個欄位（省略 `rule_id` 時，該被授權者的所有規則角色都收回） |
| `drop_policy` | `{"package","rule_id"}` | 刪掉一條規則的 policy |
| `clear_row_filter` | `{"package","rule_id"}` | 拿掉一條規則的列條件 |
| `sabotage` | `{"rule_id","clear"?}` | 之後套用時默默略過這條規則（仍回 `applied`），製造「核准未設定」 |
| `remap` | `{"key","resource"?}` | 改「代碼 → 實體資源」的對照（`key` 是主題包，或「主題包.欄位或列條件」；省略 `resource` 改回預設），目錄版本跟著變 |
| `reset` | `{}` | 刪除所有被授權者角色與服務的規則紀錄 |

## 已知限制

見 `docs/handoff/sim-dc.md` 的「限制」：到期的權限要呼叫清除端點才會離開目錄、真實使用者必須以規則角色連線（見下）、沙箱以執行計畫為準、容器映像沒有 PostgreSQL 等。D81 的改動與它的限制（傳輸沒有加密、證明不防 DC 自己說謊）見 `docs/handoff/redteam-fixes-4.md`。
