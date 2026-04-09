# CONFLICT-001：測試用衝突 — slug 速率限制

## 狀態：`detected`

## 偵測資訊
- 偵測時間：2026-04-09
- 類型：`functional`
- 嚴重度：`medium`

## 涉入角色
- 使用者 A
- 管理員 B

## 背景脈絡

這是一個供 `req ask` PoC 測試用的最小 CONFLICT 檔案。真實的 CONFLICT 檔見
`examples/quickstart/data/conflicts/CONFLICT-001-rate-limit.md`。

## 可能解決方向

### Option 1：完全無限制
- **做法**：不設 rate limit，信任使用者
- **優點**：體驗最好
- **缺點**：可能被濫用

### Option 2：嚴格配額
- **做法**：每人每日最多 20 次建立
- **優點**：系統安全
- **缺點**：業務體驗差

### Option 3：分層配額（rate limit + burst）
- **做法**：每分鐘 10 次，單日無硬上限，超過觸發 60 秒冷卻
- **優點**：平衡業務與安全
- **缺點**：實作稍複雜

---

## 解決記錄

尚未解決（此檔案僅供測試）。
