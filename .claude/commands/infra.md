# /infra - AI-Driven Infrastructure Management

## Description
透過 AI 管理 Coolify 上的所有基礎設施資源。AI 直接呼叫 Coolify API，使用者不需要進入 Coolify Dashboard。

## Prerequisites
- 已完成 `/setup` 初始化
- `COOLIFY_URL` 和 `COOLIFY_API_TOKEN` 環境變數已設定
- `infra/coolify/config.local.yml` 存在（由 `/setup` 產生）

## Usage
```
/infra [action] [resource] [options]
```

### Actions

#### 查看狀態
```
/infra status                    # 總覽所有資源狀態
/infra status apps               # 列出所有應用程式
/infra status databases          # 列出所有資料庫
/infra status services           # 列出所有服務
/infra status deployments        # 列出最近的部署紀錄
```

#### 新增資源
```
/infra add database postgres     # 新增 PostgreSQL
/infra add database redis        # 新增 Redis
/infra add database mysql        # 新增 MySQL
/infra add database mongodb      # 新增 MongoDB
/infra add service monitoring    # 新增 Prometheus + Grafana
/infra add app --from=dockerfile # 新增應用（從 Dockerfile）
/infra add app --from=image      # 新增應用（從 Docker image）
```

#### 管理資源
```
/infra restart app [name]        # 重啟應用
/infra restart database [name]   # 重啟資料庫
/infra stop app [name]           # 停止應用
/infra start app [name]          # 啟動應用
/infra logs app [name]           # 查看應用 log
/infra env set KEY=VALUE         # 設定環境變數
/infra env list                  # 列出環境變數
```

#### 備份
```
/infra backup create [db-name]   # 建立資料庫備份
/infra backup list [db-name]     # 列出備份紀錄
```

#### 域名與 SSL
```
/infra domain set app staging example.com   # 設定域名（自動 SSL）
/infra domain list                          # 列出所有域名
```

## Behavior

### Resource Discovery
AI 執行 `/infra status` 時：
1. 讀取 `infra/coolify/config.local.yml` 取得已知資源 UUID
2. 呼叫 `GET /api/v1/resources` 取得所有資源
3. 呼叫 `GET /api/v1/applications/{uuid}` 取得每個 app 的狀態
4. 呼叫 `GET /api/v1/databases/{uuid}` 取得每個 DB 的狀態
5. 以表格形式回報

### Adding Resources
AI 執行 `/infra add` 時：
1. 從 `config.local.yml` 讀取 project_uuid 和 server_uuid
2. 詢問使用者需要的設定（名稱、版本等），或根據 repo 依賴自動推斷
3. 自動產生安全密碼
4. 呼叫對應的 Coolify API 建立資源
5. 啟動資源
6. 如果是資料庫，自動將連線字串設為 app 的環境變數
7. 更新 `config.local.yml`

### Dependency Auto-Detection
當 AI 分析 repo 時，自動偵測需要的基礎設施：

| 偵測來源 | 推斷的資源 |
|----------|-----------|
| `package.json` 中有 `pg` / `sequelize` / `prisma` | PostgreSQL |
| `package.json` 中有 `redis` / `ioredis` / `bull` | Redis |
| `package.json` 中有 `mongoose` / `mongodb` | MongoDB |
| `requirements.txt` 中有 `psycopg2` / `sqlalchemy` | PostgreSQL |
| `requirements.txt` 中有 `django` | PostgreSQL（預設） |
| `docker-compose.yml` 中的 `services` | 對應各服務 |
| `Gemfile` 中有 `pg` | PostgreSQL |

### API Calls
AI 透過 `infra/coolify/api.sh` 中的函數與 Coolify 互動：

```bash
source infra/coolify/api.sh

# 查看狀態
coolify_list_apps
coolify_list_databases
coolify_list_services
coolify_list_deployments

# 建立資源
coolify_create_postgresql '{"project_uuid":"...","server_uuid":"...","name":"mydb"}'
coolify_create_redis '{"project_uuid":"...","server_uuid":"..."}'

# 設定環境變數
coolify_create_app_env "app-uuid" "DATABASE_URL" "postgresql://..."

# 部署
coolify_deploy_and_wait "app-uuid" 300 10
```

## Constraints
- **MUST** 在建立或刪除資源前向使用者確認
- **MUST** 自動產生安全密碼，不使用預設密碼
- **MUST** 更新 `config.local.yml` 記錄所有資源 UUID
- **MUST NOT** 將密碼或 Token 寫入 git 追蹤的檔案
- **MUST NOT** 在沒有使用者確認的情況下刪除資源
- **MUST** 在建立資料庫後自動設定對應的 app 環境變數
