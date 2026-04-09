# API 合約：自訂短網址 slug

## 對應規格
- Spec：[spec.md](spec.md)
- Plan：[plan.md](plan.md)

## API 端點

### `POST /shorten`
- **描述**：建立一個新的短網址，可選自訂 slug
- **認證**：需要
- **權限**：登入使用者可呼叫；Admin 額外可寫 `reserved_slugs`
- **請求參數**：
  | 參數 | 型別 | 必填 | 說明 |
  |------|------|------|------|
  | `url` | string | 是 | 要縮短的原始 URL |
  | `slug` | string | 否 | 自訂 slug；若不填則系統自動產生 |
- **請求範例**：
  ```json
  {"url": "https://example.com/spring-sale-2026", "slug": "spring-sale"}
  ```
- **回應範例**：
  ```json
  {"short_url": "https://short.ly/spring-sale", "slug": "spring-sale", "created_at": "2026-04-08T10:15:00Z"}
  ```
- **錯誤碼**：
  | 狀態碼 | 原因碼 | 說明 |
  |--------|--------|------|
  | 400    | `invalid_slug` | slug 不符合 `[a-z0-9-]{3,40}` |
  | 401    | `unauthenticated` | 未登入 |
  | 409    | `slug_taken` | slug 已被他人使用 |
  | 409    | `slug_reserved` | slug 命中保留詞清單 |
  | 429    | `rate_limited` | 超過每分鐘配額；回應含 `Retry-After` header |

## 資料模型

### short_urls
| 欄位 | 型別 | 必填 | 說明 | 約束 |
|------|------|------|------|------|
| `id` | bigint | 是 | 主鍵 | auto-increment |
| `slug` | varchar(40) | 是 | 短網址路徑 | unique, `[a-z0-9-]` |
| `url` | text | 是 | 原始 URL | |
| `user_id` | bigint | 是 | 建立者 | FK users.id |
| `created_at` | timestamptz | 是 | 建立時間 | default now() |

### reserved_slugs
| 欄位 | 型別 | 必填 | 說明 | 約束 |
|------|------|------|------|------|
| `slug` | varchar(40) | 是 | 保留的 slug | primary key |
| `reason` | text | 否 | 保留原因 | |
| `created_at` | timestamptz | 是 | 加入保留清單的時間 | |

### 模型間關係
- `short_urls.user_id` → `users.id`（多對一）
- `short_urls.slug` 與 `reserved_slugs.slug` 為互斥集合：建立 short_url 時會查詢 reserved_slugs，命中則拒絕

## 向後相容性
- 此 API 是否會破壞現有客戶端？**否**
- 新增的 `slug` 參數為選填；既有客戶端不送 `slug` 行為不變（自動產生）
- 新增的 `slug_reserved` 錯誤碼是 409 子類型，既有客戶端若只處理 HTTP 狀態碼不需改動

## 速率限制與配額

| 端點 | 限制 | 窗口 | 超限行為 | 豁免對象 |
|------|------|------|----------|----------|
| `POST /shorten` | 10 次 | 每分鐘 | HTTP 429 + `Retry-After: 60` | Admin role（sliding scale） |

- 實作方式：token bucket（Redis-backed），key = `user_id`
- 冷卻策略：觸發後 60 秒內拒絕；冷卻期間所有請求皆 429
- 設定來源：環境變數 `SLUG_RATE_LIMIT_PER_MIN`（預設 10）
- 監控告警：`slug_rate_limit_hit_total{user_id}` 5 分鐘內 > 100 次 → 平台告警

## 版本策略

- **版本方案**：URL 前綴版本，所有端點位於 `/v1/*`（本 API 為 `/v1/shorten`）
- **當前版本**：v1
- **客戶端發現方式**：`GET /v1` 回傳 `{"version": "v1", "deprecated": false, "sunset": null}`
- **棄用窗口**：任一版本 deprecate 後至少保留 **6 個月**，期間回應 header 加 `Deprecation: true` 與 `Sunset: <date>`
- **與「向後相容性」段落關係**：backward-compatible 變更（如新增選填欄位）在同一版本內進行；breaking change 則升級 v2 並保留 v1 至少 6 個月
