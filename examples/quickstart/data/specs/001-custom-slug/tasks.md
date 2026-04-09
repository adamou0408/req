# 任務拆解：自訂短網址 slug

## 對應規格
- Spec：[spec.md](spec.md)
- Plan：[plan.md](plan.md)

## 任務清單

### Task 1 — Schema migration 階段 1（Expand）
- **User Story**：Admin - 維護 slug 唯一性
- **描述**：新增 `short_urls.slug_custom` nullable 欄位與 `reserved_slugs` 新表
- **測試策略**：migration 對空表、對含資料表的 up/down 測試（integration）
- **標記**：`[P-group-A]`

### Task 2 — `slug_validator` 元件
- **User Story**：End User - 可輸入 3~40 字元，僅限 `[a-z0-9-]`
- **描述**：實作純函式 validator，處理字元、長度、保留詞
- **測試策略**：unit test 涵蓋所有拒絕原因碼 + 邊界值
- **標記**：`[P-group-A]`（與 Task 1 可並行）

### Task 3 — `rate_limiter` 元件
- **User Story**：End User - 每分鐘 10 次 + Admin - 防濫用
- **描述**：token bucket 實作，以 `user_id` 為 key，讀 `SLUG_RATE_LIMIT_PER_MIN`
- **測試策略**：unit（邏輯）+ integration（Redis 互動）
- **標記**：`[P-group-A]`

### Task 4 — `slug_allocator` + API endpoint
- **User Story**：End User - 指定 slug 建立短網址；Admin - slug_reserved 錯誤碼
- **描述**：串接 validator → rate_limiter → DB insert，處理 409 taken / reserved、429 rate_limited、400 invalid
- **測試策略**：e2e（POST /shorten 全流程）
- **標記**：`[depends: 1, 2, 3]`

### Task 5 — 觀測性（log + metrics + alert）
- **User Story**：Admin - 監控建立速率
- **描述**：新增結構化 log 項目、Prometheus metrics、告警規則，串到 `feedback_loop`
- **測試策略**：unit（log emission）+ 手動驗證 alert 流程
- **標記**：`[depends: 4]`

### Task 6 — Schema migration 階段 3（Contract）
- **User Story**：Admin - slug 唯一性強制保證
- **描述**：swap `slug` 欄位、加上 unique constraint；執行於低峰時段
- **測試策略**：integration（driver 測試 constraint violation 處理）
- **標記**：`[depends: 5]`（部署後才可收尾）

## 並行 group 總覽
- `[P-group-A]`：Task 1, 2, 3 可同時進行
- Task 4 → 5 → 6 為序列相依
