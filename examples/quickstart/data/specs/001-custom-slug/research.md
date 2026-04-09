# 調研報告：自訂短網址 slug

## 對應需求
- 原始 intake：[data/intake/raw/2026-04-08-add-custom-slug.md](../../intake/raw/2026-04-08-add-custom-slug.md)
- 調研日期：2026-04-08
- 執行者：`req-research` subagent

## 去重檢查

### 現有 spec 掃描
掃描 `data/specs/` 共 0 個現有 spec（本 quickstart 為 greenfield 範例，只有這 1 個 spec）。

- **完全重複 (>80% 重疊)**：無
- **部分重疊 (30~80%)**：無
- **existing-features.md 對照**：不存在（pre-onboarding），跳過

### 去重結論
無重複。建議以全新 spec 進行 `/req-translate`。

---

## 可行性評估

**Feasibility: Yellow**

涉及以下需額外考量的項目：

1. **資料庫 schema 變更** — 原本 slug 欄位可能是自動產生的 base62 hash，改為使用者輸入需要：
   - 新增 uniqueness constraint（避免兩人搶同一個 slug）
   - 新增字元驗證（長度 3~40，只允許 `[a-z0-9-]`）
   - 新增保留詞（reserved words）檢查欄位或外鍵
2. **併發寫入** — 多人同時送出相同 slug 的 race condition
3. **速率限制政策變更** — 原始需求明確反對 rate limit，但平台管理員立場相反，這是需要 `/req-detect-conflicts` 介入的訊號
4. **新角色衍生** — 原 intake 只提到「業務」，但建立保留詞清單需要「管理員」角色

### 高風險項目
- 併發 unique slug 爭搶 → 需要 DB-level constraint + 友善的錯誤訊息
- 保留詞清單的維護責任不清 → 需要 `/req-translate` 過程釐清 ownership
- 速率限制 vs 業務需求衝突 → 明確進入 `/req-detect-conflicts` 範疇

---

## 技術脈絡蒐集

- **相關現有程式碼**：無（quickstart 為 greenfield）
- **相關基礎建設**：Primary DB（關聯式），無 cache layer
- **相關角色定義**：
  - [data/personas/end-user.md](../../personas/end-user.md) — 業務人員
  - [data/personas/admin.md](../../personas/admin.md) — 平台管理員（本 spec 觸發建立）
- **相關未解衝突**：無

---

## 建議路徑

**推薦做法**：以獨立 spec 進行 `/req-translate`，並預期 `/req-detect-conflicts` 會找到速率限制相關的跨角色衝突。

### 實作考量預告
- slug 驗證規則應在 `contracts.md` 明訂
- 速率限制的最終政策須由 `/req-resolve-conflict` 決定
- 保留詞清單的管理介面不屬於本 spec 範疇，建議後續以 `/req-iterate` 分拆
