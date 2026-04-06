# 完整範例：從需求到部署

這個範例演示一個完整的需求如何走過框架的全部 12 個階段。

---

## 情境：公司內部系統需要新增「員工搜尋」功能

### 階段 1：Intake（需求收集）

業務部的小王在 Claude Code 中執行 `/intake`：

> **我是誰**：業務部小王
> **我想要什麼**：能在系統裡搜尋同事，用名字、部門或技能都能找到
> **為什麼**：每次要找某個技能的人都要問來問去，很浪費時間

系統自動建立：`intake/raw/2026-04-05-employee-search.md`

---

### 階段 2：Research（調研去重）

AI 自動執行 `/research`：

```markdown
# 調研報告：員工搜尋

## 去重檢查
| 現有 Spec | 相似度 | 重疊部分 | 建議 |
|-----------|--------|----------|------|
| specs/employee-directory/ | 25% | 都涉及員工資料 | 獨立 spec，但需設為依賴 |

結論：[x] 無重複，可繼續進入 /translate

## 可行性評估
- [x] 資料庫 schema 變更（需要新增搜尋索引）
- [ ] 安全敏感操作
- [x] 效能敏感操作（全文搜尋）
```

自動產出：`specs/employee-search/research.md`
結論：無重複，自動進入 `/translate`

---

### 階段 3：Translate（AI 轉譯）

AI 自動執行 `/translate`，產出 `specs/employee-search/spec.md`：

```markdown
# 員工搜尋功能

## 狀態：`draft`

## 版本歷史
| 版本 | 日期 | 變更摘要 | 觸發者 |
|------|------|----------|--------|
| v1.0 | 2026-04-05 | 初始版本 | /translate |

## 負責人
- Spec 擁有者：小王（業務部）
- 技術負責人：待指派
- 審核者：待指派
- 審核期限：2026-04-07

## 依賴關係
- 前置需求：specs/employee-directory/（員工資料庫必須先完成）
- 後續需求：無
- 共享資源：員工資料表

## 使用者故事

### 業務人員
- **作為**業務人員，**我想要**用名字搜尋同事，**以便**快速找到聯繫方式
- **驗收條件**：
  - [ ] 輸入 2 個字以上即可搜尋
  - [ ] 搜尋結果在 500ms 內回傳
  - [ ] 顯示姓名、部門、電話、email

### 管理員
- **作為**系統管理員，**我想要**管理搜尋索引，**以便**在員工異動時更新資料
- **驗收條件**：
  - [ ] 員工新增/修改時自動更新索引
  - [ ] 可手動觸發全量索引重建

## 安全性需求
- 資料分類：內部
- 認證需求：需要登入
- 授權需求：所有內部員工可搜尋，但敏感欄位（薪資）不顯示
- 個資處理：涉及 PII（姓名、電話、email），需遵守公司隱私政策

## 成功指標
- 目標 1：上線後 30 天內，80% 的員工至少使用過一次搜尋
- 目標 2：「找人」相關的內部提問減少 50%
- 量測方式：搜尋 API 使用紀錄 + 內部問卷
```

---

### 階段 4：Detect Conflicts（衝突偵測）

AI 自動執行 `/detect-conflicts`，發現一個衝突：

```markdown
# 衝突編號：CONFLICT-001
## 狀態：`detected`

## 衝突描述
- **業務人員** 需要：搜尋結果包含電話和 email
- **資安團隊** 需要：個人聯繫方式不應該被大量存取
- **為什麼衝突**：大量搜尋可能被用於蒐集員工個資

## AI 分析
- 方案 1：所有員工都能看到完整聯繫方式（便利，但有資安風險）
- 方案 2：只顯示部門電話，隱藏個人資訊（安全，但不方便）
- 方案 3：顯示聯繫方式，但加入存取頻率限制（折衷）
```

---

### 階段 5：Resolve Conflict（衝突解決）

人類執行 `/resolve-conflict conflicts/CONFLICT-001.md`：

AI 呈現影響矩陣：
| 方案 | 受益角色 | 受損角色 | 開發成本 | 風險 |
|------|----------|----------|----------|------|
| 方案 1 | 業務人員 | 資安團隊 | 低 | 高（個資外洩） |
| 方案 2 | 資安團隊 | 業務人員 | 低 | 低 |
| 方案 3 | 兩者皆可 | 無 | 中 | 中 |

**人類決策**：選擇方案 3
**理由**：兼顧便利與安全，每人每小時最多搜尋 100 次

衝突更新為 `resolved`，spec 中的 ⚠️ 標記更新為 ✅

---

### 階段 6：Review（人類審核）

人類執行 `/review specs/employee-search/`：

```markdown
# 審核紀錄：員工搜尋

## 審核清單
- [x] 所有 User Stories 完整且合理
- [x] 驗收條件具體且可測試
- [x] 所有衝突已解決
- [x] 無未解答的開放問題
- [x] 安全性需求已評估（含頻率限制）
- [x] Spec 依賴有效（employee-directory 已 approved）
- [x] 成功指標已定義且可量測
- [x] 追溯性完整（intake → research → spec）

## 審核結果：`approved` ✅
```

---

### 階段 7：Plan（技術方案）

AI 執行 `/plan specs/employee-search/`：

```markdown
# 技術方案：員工搜尋

## 工作量估算
- 總體複雜度：M
- 預估任務數：4
- 預估開發週期：3 天

## 技術選型
| 技術 | 選擇理由 |
|------|----------|
| Elasticsearch | 全文搜尋效能，支援中文分詞 |
| Redis | 存取頻率限制（rate limiting） |

## 資料模型變更
- 新增：Elasticsearch 員工搜尋索引
- 遷移策略：向前相容（新增索引不影響現有功能）
- 回滾策略：可逆（刪除索引即可）

## API 合約
→ 詳見 contracts.md
```

同時產出 `tasks.md`（含並行標記和測試策略）和 `contracts.md`。

---

### 階段 8：Implement（AI 實作）

AI 執行 `/implement specs/employee-search/`：

```
✅ 任務 1：建立搜尋 API [P-group-A] — done
   - Unit tests: 12 passed
   - Integration tests: 3 passed

✅ 任務 2：建立前端搜尋元件 [P-group-A] — done
   - Unit tests: 8 passed
   - E2E tests: 2 passed

✅ 任務 3：建立頻率限制 [P-group-A] — done
   - Unit tests: 5 passed

✅ 任務 4：整合測試 [depends: 1, 2, 3] — done
   - Integration tests: 5 passed
   - E2E tests: 3 passed

📊 實作報告：
- 4/4 任務完成，0 需人工介入
- 測試覆蓋：38 tests passed
- 安全檢查：無硬編碼密鑰，輸入驗證完整
```

---

### 階段 9：安全掃描 + 程式碼審查

CI 自動執行安全掃描：
```
✅ Secret detection: no hardcoded secrets
✅ Dependency audit: no high-severity vulnerabilities
```

人類審查程式碼 → 通過 ✅

---

### 階段 10：Deploy（部署）

人類執行 `/deploy prod`：

```
🚀 部署策略：Canary
1. ✅ 5% 流量 — 10 分鐘監控正常
2. ✅ 25% 流量 — 10 分鐘監控正常
3. ✅ 50% 流量 — 10 分鐘監控正常
4. ✅ 100% 流量 — 健康檢查通過

📊 部署報告：
- 環境：production
- 策略：canary (5% → 25% → 50% → 100%)
- 健康檢查：通過
- 回滾：未觸發
```

---

### 階段 11：Monitor & Feedback（監控）

部署後第 3 天，監控偵測到異常：

```
⚠️ Alert: HighLatency
- P95 latency > 3s for 10 minutes
- 影響：搜尋 API
```

系統自動執行 `/feedback`：
- 建立 `intake/raw/2026-04-08-auto-high-latency.md`
- 類型：warning（普通）
- 關聯 spec：`specs/employee-search/`
- 建議：標準 `/research` → `/translate` 流程

---

### 階段 12：Iterate（迭代）

基於監控回饋，團隊執行 `/iterate`：

```
影響分析：
- 受影響 spec：specs/employee-search/ v1.0
- 根本原因：搜尋索引未配置中文分詞器
- 預估影響：修改 Elasticsearch 索引設定
- 新衝突：無
```

Spec 版本更新為 v1.1，狀態重設為 `draft`，重新走 review → plan → implement → deploy 流程。

---

## 範例：部署失敗觸發回饋迴路

假設在階段 10 部署時，canary 階段的 25% 流量出現錯誤率上升：

```
🚀 部署策略：Canary
1. ✅ 5% 流量 — 10 分鐘監控正常
2. ❌ 25% 流量 — 錯誤率 > 5%，觸發回滾

⏪ 自動回滾至上一版本
📥 自動建立 intake：intake/raw/2026-04-05-auto-deploy-prod-failure.md
📝 自動建立事後檢討：docs/postmortems/2026-04-05-deploy-failure.md
```

此 intake 自動進入 `/research` → `/translate` → ... 的完整流程，直到問題被修復並重新部署。

---

## 關鍵觀察

1. **人類只做了 3 件事**：解決衝突（選方案 3）、審核 spec、審核程式碼
2. **AI 做了其他所有事**：調研、轉譯、偵測衝突、規劃、實作、測試、部署、監控
3. **閉環運作**：監控問題自動回流成新需求，無需手動報告
4. **溯源完整**：從小王說的一句話，到最終部署的每一行程式碼，都可追溯
