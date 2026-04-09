# 技術方案：自訂短網址 slug

## * 對應規格

- Spec：[spec.md](spec.md)
- Research：[research.md](research.md)
- 狀態：`approved`

## * 工作量估算

- 總體複雜度：M
- 預估任務數：6
- 預估開發週期：3~4 個工作天

## * 技術選型

| 技術 | 選擇理由 |
|------|----------|
| DB unique constraint on `slug` | 用資料庫原生保證 race-free 唯一性，比應用層 lock 更穩 |
| Token bucket（每分鐘 10 次） | 已有現成函式庫；對 burst 友善，符合 Option 3 決議 |
| 保留詞清單以 DB 表格儲存 | 允許 Admin 動態編修（未來 spec），不用改程式碼 |

## * 架構設計

### 元件拆解

- `slug_validator` — 檢查字元、長度、保留詞
- `slug_allocator` — 包裝資料庫寫入與 uniqueness 檢查，返回 `created` / `taken` / `reserved`
- `rate_limiter` — token bucket 實作，讀取配額設定
- `audit_logger` — 記錄建立與拒絕事件

### 元件互動

```
POST /shorten → validator → rate_limiter → allocator → audit_logger
                  ↓ fail         ↓ fail       ↓ fail
              400 invalid    429 limited   409 taken / 409 reserved
```

## 與現有系統的整合點

沿用既有的 `short.ly` domain 與現有 resolver — 新功能只影響建立路徑，不動現有 lookup 路徑。

## * 風險評估

| 風險 | 可能性 | 影響 | 緩解方案 |
|------|--------|------|----------|
| 保留詞清單設定錯誤鎖住合理 slug | 中 | 中 | Admin 修改介面加確認；保留詞上限 200 |
| token bucket 設定過嚴影響真實業務 | 低 | 高 | 上線前模擬 30 slug/3 分鐘場景，確認不觸發冷卻 |
| DB unique constraint 在高併發下效能退化 | 低 | 中 | slug 欄位已有 B-tree index，基準測試驗證 |

## * 資料模型變更

- 新增表格／欄位：
  - `short_urls.slug` — `VARCHAR(40) NOT NULL UNIQUE`，新增 unique 約束
  - `reserved_slugs`（新表）— `slug VARCHAR(40) PRIMARY KEY, reason TEXT, created_at TIMESTAMPTZ`
  - `user_rate_tokens`（新表 或 Redis）— 儲存 token bucket 狀態
- 修改表格／欄位：`short_urls.slug` 從可空改為必填
- 刪除表格／欄位：無
- 遷移策略：**Expand & Contract 多階段遷移**
  - 階段 1：新增 `slug_custom` 欄位（nullable），維持舊 slug 正常運作
  - 階段 2：backfill 現有 `slug` 至 `slug_custom`
  - 階段 3：swap，把 `slug` 欄位加上 unique constraint
- 回滾策略：階段 1、2 可逆；階段 3 只要保留 backup 即可逆

## * 部署影響評估

### * Health Check 影響

- Readiness 啟動時間預估變化：+50 ms（新增 `reserved_slugs` 表載入）
- 是否新增 readiness 需檢查的相依服務：無（沿用既有 Primary DB）
- Graceful shutdown 是否有額外處理需求：無 — token bucket 儲存於 Redis（現有），shutdown 不需 flush

### * Schema 向後相容性

- 本次變更是否向後相容（Expand & Contract 模式）：**是**
- 若「否」：N/A
- Migration 執行方式：K8s Job（三階段），每階段獨立部署
- 備註：階段 3 加 unique constraint 時需鎖表 < 5 秒，安排於低峰時段

### * 設定與環境變數

- 新增／修改的環境變數清單：
  - `SLUG_RATE_LIMIT_PER_MIN=10`
  - `SLUG_RESERVED_LIST_RELOAD_SEC=60`
- 已同步更新 `.env.example`：是
- 已同步更新部署平台設定（Coolify / K8s ConfigMap）：K8s ConfigMap，是
- 敏感資料走 Secret：N/A（無敏感資料）

### * 資源預算

- 記憶體 baseline / peak：無變化 / +20 MB peak（token bucket 快取）
- CPU baseline / peak：無變化 / 無變化
- 每請求 DB query 次數：新增 1 次（reserved_slugs 查詢）+ 1 次（寫入）
- 外部 API 呼叫次數：0
- 對現有 resource limits 是否需要調整：否

### * 資料持久性

- 本功能產生的資料類型分類：關鍵業務（使用者建立的 slug 資料）
- 持久化儲存選擇：外部 DB（Primary RDBMS）
- 是否納入備份策略：是（沿用既有 Primary DB 備份）

### * 觀測性

- 新增的結構化 log 項目：
  - `slug_created` — user_id, slug
  - `slug_rejected` — user_id, slug, reason (`taken` / `reserved` / `invalid` / `rate_limited`)
- 新增的業務 metrics：
  - `slug_create_total{result}` counter
  - `slug_rate_limit_hit_total{user_id}` counter
- 新增的 tracing span 包裹點：`slug_allocator.create`
- 新增的告警規則：
  - `slug_rejected{reason="rate_limited"}` 5 分鐘內 > 100 次 → 告警（可能遭遇濫用或配額設定問題）
  - `feedback_loop: true` — 告警自動觸發 `/req-feedback`

## * 安全性考量

- 此方案是否引入新的安全面向：是 — 保留詞清單本身是安全邊界
- 需要的安全措施：
  - 保留詞清單僅 Admin 可寫
  - slug 字元白名單檢查防 path traversal 與 XSS
  - rate limit 以 `user_id` 為 key，避免跨用戶共享冷卻
- 是否需要安全審查：是（建議 `/req-review` 中的安全檢查清單已涵蓋）

## API 合約

- 詳見 [contracts.md](contracts.md)
- 是否需要 API 合約文件：是

## 實作策略

見 [tasks.md](tasks.md)
