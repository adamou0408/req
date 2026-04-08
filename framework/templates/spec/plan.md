# 技術方案：功能名稱

> **欄位標記說明**：標題前有 `*` 為**必填**段落（即使結論是「無」也要明確寫出）；標題後標 `（選填）` 為視情況補充。

## * 對應規格

- Spec：[連結到 spec.md]
- Research：[連結到 research.md]
- 狀態：`approved`

## * 工作量估算

- 總體複雜度：S / M / L / XL
- 預估任務數：
- 預估開發週期：

## * 技術選型

| 技術 | 選擇理由 |
|------|----------|
|      |          |

## * 架構設計

### 元件拆解
（描述系統元件及其職責）

### 元件互動
（描述元件之間如何通訊與協作）

## 與現有系統的整合點（選填）

（如何與已存在的功能整合；若為獨立新功能可填「無」）

## * 風險評估

| 風險 | 可能性 | 影響 | 緩解方案 |
|------|--------|------|----------|
|      |        |      |          |

## * 資料模型變更

- 新增表格／欄位：
- 修改表格／欄位：
- 刪除表格／欄位：
- 遷移策略：（向前相容 / 藍綠部署 / 多階段遷移）
  - 詳細請填寫於下方「部署影響評估 > Schema 向後相容性」
- 回滾策略：（此遷移是否可逆？如不可逆，需額外人工批准）

## * 部署影響評估

> **強制填寫**。即使結論是「無影響」也要明確寫出，不可省略整段。每個子區塊都是必填，下方僅列出核心填空項；完整查核清單與常見雷區請見 [deployment-checklist.md](deployment-checklist.md)。

### * Health Check 影響

- Readiness 啟動時間預估變化：
- 是否新增 readiness 需檢查的相依服務（DB / 快取 / 第三方 API）：
- Graceful shutdown 是否有額外處理需求：

### * Schema 向後相容性

- 本次變更是否向後相容（Expand & Contract 模式）：是 / 否
- 若「否」：拆分階段與舊版相容策略：
- Migration 執行方式：（K8s Job / initContainer / Coolify pre-deployment command）
- ⚠️ 標示為「否」會自動觸發 [/deploy](../../../framework/commands/deploy.md) 的「irreversible data model changes」人工核准 gate

### * 設定與環境變數

- 新增／修改的環境變數清單：
- 已同步更新 `.env.example`：是 / 否
- 已同步更新部署平台設定（Coolify env vars / K8s ConfigMap / K8s Secret）：是 / 否 / N/A
- 敏感資料走 Secret（非 ConfigMap）：是 / N/A

### * 資源預算

- 記憶體 baseline / peak：___ MB / ___ MB
- CPU baseline / peak：___ millicores / ___ millicores
- 每請求 DB query 次數 / 外部 API 呼叫次數：
- 對現有 resource limits 是否需要調整：是 / 否

### * 資料持久性

- 本功能產生的資料類型分類（關鍵業務 / 使用者檔案 / 快取 / log / 臨時檔）：
- 持久化儲存選擇（外部 DB / S3 / Volume / emptyDir）：
- 是否納入備份策略：是 / 否 / N/A

### * 觀測性

- 新增的結構化 log 項目：
- 新增的業務 metrics（RED / USE）：
- 新增的 tracing span 包裹點：
- 新增的告警規則（含 `feedback_loop` 設定）：

## * 安全性考量

- 此方案是否引入新的安全面向：
- 需要的安全措施（輸入驗證、權限檢查、加密等）：
- 是否需要安全審查：

## API 合約（選填）

- 若此功能涉及 API 變更，詳見 [contracts.md](contracts.md)
- 是否需要 API 合約文件：是 / 否

## 實作策略（選填）

（描述開發順序、階段劃分等；若 tasks.md 已涵蓋可填「見 tasks.md」）
