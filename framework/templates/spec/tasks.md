# 任務清單：功能名稱

## 對應規格
- Spec: [連結到 spec.md]
- Plan: [連結到 plan.md]

## 並行標記說明
- `[P-group-X]`：同一 group 的任務可並行執行
- `[depends: N]`：必須等任務 N 完成後才能開始
- 無標記：按順序依序執行

## 任務列表

### 任務 1：任務名稱 `[P-group-A]`
- **對應 User Story**：（引用 spec.md 中的 User Story）
- **描述**：
- **驗收條件**：
  - [ ] 條件 1
  - [ ] 條件 2
- **測試策略**：
  - Unit：（單元測試範圍）
  - Integration：（整合測試範圍，如有）
  - E2E：（端到端測試範圍，如有）
- **狀態**：`todo` | `in-progress` | `done` | `needs-human-intervention`

### 任務 2：任務名稱 `[P-group-A]`
- **對應 User Story**：
- **描述**：
- **驗收條件**：
  - [ ] 條件 1
- **測試策略**：
  - Unit：
- **狀態**：`todo`

### 任務 3：任務名稱 `[depends: 1, 2]`
- **對應 User Story**：
- **描述**：
- **驗收條件**：
  - [ ] 條件 1
- **測試策略**：
  - Integration：
  - E2E：
- **狀態**：`todo`

## 進度摘要
- 總任務數：
- 已完成：
- 進行中：
- 需人工介入：
- 可並行的 group 數：
