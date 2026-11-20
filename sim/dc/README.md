# sim/dc：模擬的外部資料系統（DC）

一個獨立的小服務（Node 22 + TypeScript，唯一的執行期套件是 `pg`），加上它自己的 PostgreSQL 資料庫。收到平台核准的規則後，把它套用成**真正的資料庫權限**：每個被授權者一個資料庫角色、欄位層級的權限、列層級安全（RLS）、匯出另外授權。測試查詢與對帳都是對資料庫的真實操作。只供開發與測試；不含平台的業務判斷，收到什麼規則就執行什麼。

## 怎麼跑

```bash
sim/dc/start.sh            # 第一次會安裝套件、建立資料庫與示範資料（幾秒）
sim/dc/start.sh --reset    # 重建兩個資料庫的結構與示範資料，刪除所有被授權者角色
sim/dc/health.sh           # /health 回 ok（HTTP 在、兩個資料庫都連得上）才回 0
sim/dc/stop.sh
sim/dc/test.sh             # 型別檢查＋全部測試；可以只給檔案：sim/dc/test.sh tests/01-apply.test.ts
```

- 需要 Node 22.18 以上（直接執行 TypeScript）、npm、curl、jq，以及一個 PostgreSQL 16（與開發環境共用，連線見下）。
- 程式與 `node_modules` 安裝在 `sim/.run/dc/app/`（repo 可能以唯讀掛載）；log 在 `sim/.run/dc/dc.log`。
- 設定的唯一來源是 `service.env`（非機密）與 `test-credentials.env`（只在 sim 有效的測試憑證）。superuser 連線沒有另外設定時讀 `db/sgn.env` 的 `SGN_PG_ADMIN_URL`，只用來建立本服務的登入角色與資料庫。
- **測試不占用 7001**：`test.sh` 另外啟動一份服務，聽 `sim/.run/dc/test/dc.sock`，用資料庫 `sim_dc_check`、`sim_dc_check_test` 與角色前綴 `simdc_t_`。開發用的服務在跑也不受影響。

## 資料庫

| 項目 | 值 |
|---|---|
| 資料庫 | `sim_dc`（合成資料）、`sim_dc_test`（遮罩資料，結構相同） |
| 服務的登入角色 | `simdc_service`（擁有資料表，`CREATEROLE`，不是 superuser）；密碼見 `test-credentials.env` |
| 被授權者角色 | `simdc_p_<principal_id>`（遮罩資料庫是 `simdc_m_p_…`）；UUID 去掉連字號，或正整數。`NOLOGIN` |
| 時區 | `Asia/Taipei`（授權起迄與「今天」） |

| schema | 內容 | 被授權者看得到什麼 |
|---|---|---|
| `data` | 四張表：`customer_master`、`sales_order`、`product_cost`、`payroll`。欄名就是平台目錄的欄位代碼，另有列條件欄（`region`、`product_line`、`pay_type`）與技術鍵 `row_id` | 規則給的欄位＋`row_id` 的欄位權限；每條規則一個 RLS policy |
| `export` | 每個可以匯出的角色、每個主題包一個檢視表（`security_invoker`） | 只有自己的那一個 |
| `simdc` | RLS 用的判斷函式（`rule_match`、`rule_reason`、`as_of`） | 執行權 |
| `simdc_meta` | 服務收到的規則、撤回請求、呼叫紀錄 | 沒有 |

示範資料（合成）：客戶 240 筆；訂單每天每區一筆、成本每天每產品線一筆（2024-01-01～2027-12-31）；薪資 60 人每月 5 日、2 月與 7 月 10 日發獎金。有資料期間的主題包每天都有資料，因為平台的驗證案例會查「期間起日」與「前一天」這種任意日期。遮罩資料：L3、L4 的文字換成固定代號（同值同代號）、數字加雜訊；列條件欄位與日期保留。

## 呼叫方（`Authorization: Bearer <金鑰>`）

金鑰在 `test-credentials.env`。

| 呼叫方 | 金鑰變數 | 可以做 |
|---|---|---|
| `platform` | `SIM_DC_KEY_PLATFORM` | 套用、撤回、查規則、測試查詢、對帳、沙箱 |
| `auditor` | `SIM_DC_KEY_AUDITOR` | 查規則、對帳 |
| `admin` | `SIM_DC_KEY_ADMIN` | 查規則、測試查詢、對帳、**管理後門** |

## 端點

`{base}` 是 `http://127.0.0.1:7001/v1`（合成資料）或 `http://127.0.0.1:7001/masked/v1`（遮罩資料）；兩者端點相同。

| 方法與路徑 | 用途 | 本文 → 回應 |
|---|---|---|
| `GET /health` | 健康檢查（不需金鑰） | → `{"status":"ok","databases":{…}}` |
| `PUT {base}/rule-sets/{case_no}` | 套用規則（**要簽章**） | `data_access_rule_set/1` → `{"status":"applied","dc_ref":"DC-{case_no}-v{版}"}` |
| `DELETE {base}/rule-sets/{case_no}` | 撤回（**要簽章**） | `{"request_id","case_no","rule_ids"?}` → `{"status":"withdrawn"}`；省略 `rule_ids` 是全部 |
| `GET {base}/rule-sets`、`GET {base}/rule-sets/{case_no}` | 服務收到並接受了哪些規則（服務自己的紀錄） | → 規則清單 |
| `POST {base}/test-query` | 以某個被授權者的身分真的查一次 | `{"principal_id","query","probe_missing_row"?}` → 見下 |
| `POST {base}/test-queries` | 平台的驗證（02 §8.5 `verify_request`） | `{"request_id","run_id","rule_set","cases"}` → `{"status":"completed","results":[{"code","actual","reason","detail"}]}` |
| `GET {base}/reconciliation[?exclude_inactive=1]` | 對帳回報：資料庫裡實際存在的權限 | → 見下 |
| `POST /masked/v1/sandbox/runs` | 遮罩環境的沙箱 | `{"queries":[{"name","sql"}]}` → 見下 |
| `POST {base}/admin/{操作}` | **管理後門，只供測試** | 見下 |

失敗一律回 `{"status":"failed","code","error"}`：401 金鑰或簽章不對、403 呼叫方沒有權限、409 版本衝突、422 規則或查詢的結構不對、404 沒有這張單。請求本文要帶 `content-length`。

### 套用的語意

- 只接受 `format = data_access_rule_set/1`（`pack_data_access.build_fulfilment` 的實際輸出）。檢查的只有「能不能執行」：主題包、欄位、列條件在 DC 的目錄上、運算子與值的型別對、`rules[].system` 是本 DC 接受的（`SIM_DC_SYSTEMS`）。
- 每次套用或撤回，把該被授權者在資料庫裡的權限**整個重算**：收回全部 → 依目前所有有效的規則重新授予。所以：同一份規則送兩次結果相同；新的一版取代舊的一版（縮小就真的變小）；直接在資料庫做的改動（例如管理後門）在下一次重算時會被蓋掉。
- 版本：同一版同內容 → 冪等；同一版不同內容、較舊的版本、已撤回的同一版 → 409（擋下重送舊的已簽章規則）。撤回請求以 `request_id` 記住，重送不會再動作。
- 每條規則一個 policy：`simdc.rule_match('<規則 JSON>'::jsonb, jsonb_build_object(<條件欄>))`，判斷授權起迄（以查詢日期）、列條件（全部成立）、資料期間。`export` 是 `true` 或 `null` 時建立匯出檢視表。

### 測試查詢

`query` 是 02 §5.11 的格式：`{"package","fields","row","data_date","action","as_of"}`。

1. 以服務角色（資料表擁有者）找出 `row`、`data_date` 對得上的資料列 → `rows_matching`。沒有：回 `decision: "no_data"`（本來就沒有資料）；`probe_missing_row: true` 時改為在這個交易裡插入一列測試資料。
2. `SET ROLE` 成被授權者角色，`select row_id, <fields> from data.<主題包>`（匯出是它的匯出檢視表）`where row_id = any(…)`，查詢日期設為 `as_of`。PostgreSQL 回權限錯誤或 0 列 → `deny`；有列 → `allow`。
3. 被擋下時從系統目錄讀原因（只供人閱讀）：`no_rule`、`field_not_granted`、`export_not_allowed`、`not_yet_valid`、`expired`、`row_filter`、`data_period`。
4. 整個交易 rollback，不回傳任何資料內容。

回應：`{"decision","reason","db_role","rows_matching","rows_visible","row_source"}`。`/test-queries` 對每個案例做同樣的事（一律允許插入測試列），`actual` 是 `allow`、`deny`，或查詢本身不合法時 `error`。

`as_of` 只對服務自己的連線有效：`simdc.as_of()` 只在 `session_user` 是服務角色時讀 `simdc.as_of` 設定，被授權者自己連進來設定它沒有用。

### 對帳回報

全部從系統目錄讀，不讀服務自己的紀錄：欄位權限用 `has_column_privilege`（含資料表層級、角色繼承、PUBLIC），列的限制解析 `pg_policy` 的運算式，主體讀角色說明，匯出讀 `export` 檢視表的權限。

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
                     "case_version_no": 1, "valid": {"from": "2026-11-16", "to": "2027-05-15"}, "effective_now": true}
    }
  ],
  "superusers": ["das_dev", "postgres"],
  "rls_disabled": []
}
```

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

### 簽章格式（平台那一側要照這個實作）

會改變權限的請求（`PUT`、`DELETE` 規則）必須帶：

```
Sgn-Signature: keyid="<金鑰代號>", alg="ed25519", sig="<簽章，標準 base64>"
```

- 被簽的位元組 = `"sgn-dc-sig/1\n"`（UTF-8）緊接著**請求本文的原始位元組**。不重新序列化：送出的本文必須就是簽章時的那串位元組。
- 演算法 Ed25519（RFC 8032，純 Ed25519，不先雜湊）。DC 依 `keyid` 從信任清單找公鑰。
- 信任清單：`SIM_DC_TRUSTED_KEYS_FILE`，格式 `{"keys":[{"key_id":"…","public_key_pem":"-----BEGIN PUBLIC KEY-----…"}]}`（SPKI PEM）。沒有指定時，`start.sh` 在 `sim/.run/dc/keys/` 產生一組開發用金鑰對：`platform-dev.private.pem`（給平台在開發環境簽）與 `trusted-keys.json`。
- 自己簽一份來試：

```bash
app=sim/.run/dc/app; keys=sim/.run/dc/keys
sig="$(node $app/src/cli.ts sign $keys/platform-dev.private.pem platform-dev rule-set.json)"
curl -X PUT -H 'Authorization: Bearer sim-dc-platform-key' -H "Sgn-Signature: $sig" \
     --data-binary @rule-set.json http://127.0.0.1:7001/v1/rule-sets/DA-2026-0004
```

- 要換做法（JWS、HTTP Message Signatures）只需要換 `src/signature.ts`。

### 管理後門（只供測試）

`POST {base}/admin/{操作}`，需要 admin 金鑰，`SIM_DC_ENABLE_BACKDOOR=1` 才開放，回應帶 `"test_only_backdoor": true`。直接改資料庫的權限，不經過規則，用來測試對帳抓不抓得到不一致。

| 操作 | 本文 | 效果 |
|---|---|---|
| `grant_column` | `{"principal_id","package","field","action":"read"\|"export"}` | 多給一個欄位（或匯出） |
| `revoke_column` | 同上 | 少給一個欄位 |
| `drop_policy` | `{"package","rule_id"}` | 刪掉一條規則的 policy |
| `clear_row_filter` | `{"package","rule_id"}` | 拿掉一條規則的列條件 |
| `sabotage` | `{"rule_id","clear"?}` | 之後套用時默默略過這條規則（仍回 `applied`），製造「核准未設定」 |
| `reset` | `{}` | 刪除所有被授權者角色與服務的規則紀錄 |

## 已知限制

見 `docs/handoff/sim-dc.md` 的「限制」：同一個被授權者有多張單時欄位與列條件會交叉合併、到期的權限仍留在目錄上、沙箱以執行計畫為準、容器映像沒有 PostgreSQL 等。
