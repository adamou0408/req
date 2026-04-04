# 完整工作流程

## 流程總覽

```mermaid
graph TD
    A[👤 任何人提交原始需求] -->|intake/| B[🤖 AI 轉譯]
    B --> C[📋 結構化規格 spec.md]
    B --> D[👥 自動識別/更新角色 personas/]
    B --> E{⚠️ 衝突偵測}
    E -->|有衝突| F[conflicts/ 標記衝突]
    F --> G[👤 人類裁決]
    G --> C
    E -->|無衝突| C
    C --> H[👤 人類審核 review]
    H -->|退回| A
    H -->|通過| I[🤖 AI 生成技術方案 plan.md]
    I --> J[🤖 AI 拆解任務 tasks.md]
    J --> K[🤖 AI 實作程式碼 src/]
    K --> L[🧪 自動化測試 tests/]
    L -->|失敗| K
    L -->|通過| M[🚀 部署 deploy]
    M --> N{🚪 Spec Gate + 健康檢查}
    N -->|失敗| O[⏪ 自動 Rollback]
    O --> P[🔄 自動建立 intake]
    P --> A
    N -->|通過| Q[📡 持續監控]
    Q -->|異常告警| P
    Q -->|正常| R[✅ 持續運行]
    R -.->|需求變更| A
```

## 各階段詳細說明

### 1. 需求收集（Intake）
- **負責人**：任何人
- **輸入**：自然語言、會議紀錄、截圖、語音轉文字...任何格式
- **輸出**：`intake/raw/YYYY-MM-DD-{slug}.md`
- **命令**：`/intake`

### 2. AI 轉譯（Translate）
- **負責人**：AI
- **輸入**：原始需求檔案
- **輸出**：`specs/{feature}/spec.md`（狀態：`draft`）+ 角色更新
- **命令**：`/translate`

### 3. 衝突偵測（Detect Conflicts）
- **負責人**：AI
- **輸入**：spec.md 中的 User Stories
- **輸出**：`conflicts/CONFLICT-{NNN}.md`
- **命令**：`/detect-conflicts`

### 4. 人類裁決（Resolve Conflicts）
- **負責人**：人類
- **輸入**：衝突紀錄和 AI 分析
- **輸出**：衝突狀態更新為 `resolved`

### 5. 人類審核（Review）
- **負責人**：人類
- **輸入**：spec.md
- **輸出**：`reviews/REVIEW-{feature}-{date}.md` + 狀態更新為 `approved`
- **命令**：`/review`

### 6. 技術方案（Plan）
- **負責人**：AI
- **輸入**：已審核的 spec.md
- **輸出**：`specs/{feature}/plan.md` + `specs/{feature}/tasks.md`
- **命令**：`/plan`

### 7. AI 實作（Implement）
- **負責人**：AI
- **輸入**：plan.md + tasks.md
- **輸出**：`src/` 程式碼 + `tests/` 測試
- **命令**：`/implement`

### 8. 部署（Deploy）
- **負責人**：AI（自動）+ 人類（prod 審核）
- **輸入**：通過測試的程式碼
- **輸出**：部署到目標環境
- **命令**：`/deploy`
- **閉環機制**：
  - CI 檢查 spec 是否已 approved（Spec Gate）
  - 部署後執行健康檢查
  - 失敗自動 rollback + 建立 intake

### 9. 監控與回饋（Monitor & Feedback）
- **負責人**：自動化系統
- **輸入**：部署後的系統指標
- **輸出**：告警 → 自動建立 `intake/raw/` 問題回報
- **命令**：`/feedback`
- **閉環機制**：
  - 監控告警自動轉為 intake 項目
  - 30 分鐘內重複告警自動去重
  - 24 小時內 3 次以上相同告警自動升級

### 10. 迭代（Iterate）
- **負責人**：任何人（發起）+ AI（分析）+ 人類（審核）
- **輸入**：變更描述
- **輸出**：影響分析 + 更新的 specs
- **命令**：`/iterate`

## 狀態流轉圖

```mermaid
stateDiagram-v2
    [*] --> draft: AI 轉譯完成
    draft --> in_review: 提交審核
    in_review --> approved: 人類通過
    in_review --> draft: 人類退回
    approved --> in_progress: AI 開始實作
    in_progress --> done: 測試全部通過
    done --> deployed: 部署成功
    deployed --> monitoring: 持續監控
    monitoring --> draft: 監控告警（閉環回饋）
    done --> draft: 需求變更
    approved --> draft: 需求變更
    in_progress --> draft: 需求變更
```

## 閉環部署流程

```mermaid
graph TD
    A[程式碼推送] --> B{CI 檢查}
    B -->|Spec 未 approved| X[❌ 阻擋部署]
    B -->|測試失敗| X
    B -->|全部通過| C[部署到 staging]
    C --> D[健康檢查]
    D -->|失敗| E[自動 rollback]
    E --> F[自動建立 intake 問題回報]
    D -->|通過| G[👤 人類審核]
    G -->|通過| H[部署到 prod]
    H --> I[持續監控]
    I -->|異常告警| F
    F --> J[回到需求驅動流程]
    I -->|正常| K[✅ 持續運行]
```

## 部署環境

| 環境 | 自動部署 | 需人工審核 | 回饋迴路 |
|------|---------|-----------|---------|
| dev | 每次 push | 否 | 可選 |
| staging | PR 合併 | 否 | 啟用 |
| prod | 手動觸發 | **是** | **必須啟用** |
