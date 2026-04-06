# /infra - AI-Driven Infrastructure Management

## Description
透過 Coolify API 管理基礎設施資源。初始化後（`/setup`），AI 可以隨時建立、查詢、修改、刪除基礎設施資源，使用者不需要進入 Coolify Dashboard。

## Prerequisites
- 已執行過 `/setup` 完成初始化
- `COOLIFY_URL` 和 `COOLIFY_API_TOKEN` 環境變數已設定
- 或 `infra/coolify/config.local.yml` 存在

## Usage
```
/infra [action] [resource] [options]
```

### Actions

| 指令 | 說明 | 範例 |
|------|------|------|
| `/infra status` | 查看所有資源狀態 | `/infra status` |
| `/infra add db` | 新增資料庫 | `/infra add db postgresql` |
| `/infra add redis` | 新增 Redis | `/infra add redis` |
| `/infra add app` | 新增應用程式 | `/infra add app --repo=org/repo` |
| `/infra add service` | 新增服務（compose stack） | `/infra add service monitoring` |
| `/infra logs` | 查看應用程式日誌 | `/infra logs staging` |
| `/infra env set` | 設定環境變數 | `/infra env set DATABASE_URL=...` |
| `/infra env list` | 列出環境變數 | `/infra env list staging` |
| `/infra scale` | 調整資源 | `/infra scale staging --replicas=3` |
| `/infra backup` | 管理資料庫備份 | `/infra backup create` |
| `/infra destroy` | 刪除資源（需確認） | `/infra destroy staging-db` |

## Behavior

### `/infra status` — 總覽
透過 API 查詢所有資源並呈現：

```bash
# 執行的 API 呼叫
GET /api/v1/servers              → 伺服器狀態
GET /api/v1/projects             → 專案列表
GET /api/v1/applications         → 應用程式狀態
GET /api/v1/databases            → 資料庫狀態
GET /api/v1/services             → 服務狀態
GET /api/v1/deployments          → 最近部署
```

以表格格式呈現給使用者：
```
🖥️  伺服器：server-01 (healthy)
📁 專案：my-project
   staging:
     🟢 app      my-app-staging       running   staging.example.com
     🟢 postgres  my-db-staging       running   5432
     🟢 redis     my-redis-staging    running   6379
   production:
     🟢 app      my-app-prod          running   app.example.com
     🟢 postgres  my-db-prod          running   5432
     🔴 redis     my-redis-prod       stopped   —
```

### `/infra add db [type]` — 新增資料庫
1. 讀取 `config.local.yml` 取得 project_uuid 和 server_uuid
2. 詢問使用者：目標環境（staging/production）
3. 自動產生安全密碼
4. 透過 API 建立資料庫：
   ```bash
   POST /api/v1/databases/{type}
   ```
5. 自動將 `DATABASE_URL` 設為對應 app 的環境變數：
   ```bash
   POST /api/v1/applications/{uuid}/envs
   ```
6. 更新 `config.local.yml`
7. 回報連線資訊

### `/infra add app` — 新增應用程式
1. 偵測 repo 中的建置方式（Dockerfile / buildpack）
2. 透過 API 建立應用程式
3. 設定域名與 SSL
4. 設定環境變數
5. 更新 `config.local.yml`

### `/infra logs [env]` — 查看日誌
```bash
GET /api/v1/applications/{uuid}/logs
```

### `/infra env set KEY=VALUE` — 設定環境變數
```bash
POST /api/v1/applications/{uuid}/envs
  { "key": "KEY", "value": "VALUE", "is_build_time": false }
```

### `/infra backup` — 資料庫備份
```bash
# 建立備份排程
POST /api/v1/databases/{uuid}/backups

# 查看備份紀錄
GET /api/v1/databases/{uuid}/backups/{backup_uuid}/executions
```

### `/infra destroy [resource]` — 刪除資源
1. **必須**向使用者確認：「確定要刪除 {resource} 嗎？此操作不可逆。」
2. 使用者確認後才執行刪除

## API Client
所有操作透過 `infra/coolify/api.sh` 執行。AI 使用 `source infra/coolify/api.sh` 載入函式庫後呼叫對應函式。

## Constraints
- **MUST** 在執行破壞性操作（刪除、停止 production）前要求使用者確認
- **MUST** 自動產生安全密碼，不使用弱密碼
- **MUST** 更新 `config.local.yml` 保持本地狀態同步
- **MUST NOT** 將 API Token 或密碼寫入 git 追蹤的檔案
- **MUST NOT** 在沒有使用者確認的情況下修改 production 環境
