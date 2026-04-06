# Coolify 基礎設施（AI 驅動）

## 設計理念

使用者**不需要**手動操作 Coolify Dashboard。

整個基礎設施的初始化和管理都由 AI 透過 Coolify API 完成。使用者只需要：

1. 安裝 Coolify（一行指令）
2. 產生 API Token（在 Dashboard 點一次）
3. 執行 `/setup`（AI 引導完成所有設定）

之後所有操作都透過 `/infra` 和 `/deploy` 命令，由 AI 控制 Coolify API。

## 快速開始

```bash
# Step 1: 安裝 Coolify（在你的伺服器上）
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

# Step 2: 開啟 Coolify Dashboard，到 Settings > API Tokens 產生 Token

# Step 3: 設定環境變數
export COOLIFY_URL="https://coolify.yourserver.com"
export COOLIFY_API_TOKEN="your-token-here"

# Step 4: 在專案中執行 AI 引導設定
/setup
```

`/setup` 會自動：
- 驗證 Coolify 連線
- 探查現有資源
- 建立專案 / 環境 / 應用程式
- 偵測 repo 依賴，建立所需資料庫
- 設定環境變數（含自動產生密碼）
- 設定域名與 SSL
- 執行首次部署
- 產生 `config.local.yml` 記錄所有資源

## 日常操作

所有操作透過 AI 命令：

```bash
# 查看狀態
/infra status

# 新增資料庫
/infra add database postgres

# 部署
/deploy staging
/deploy prod

# 查看 log
/infra logs app staging

# 設定環境變數
/infra env set API_KEY=xxx

# 備份
/infra backup create mydb
```

## 檔案結構

```
infra/coolify/
├── api.sh              # Coolify API 客戶端（AI 呼叫的工具）
├── deploy.sh           # 部署腳本（CI/CD 和 AI 共用）
├── config.local.yml    # 本地設定（.gitignore，由 /setup 產生）
└── README.md           # 本文件
```

### config.local.yml（由 AI 自動產生）

```yaml
coolify:
  url: "https://coolify.yourserver.com"

resources:
  project_uuid: "abc123"
  server_uuid: "def456"
  staging:
    app_uuid: "ghi789"
    db_uuid: "jkl012"
    domain: "staging.example.com"
  production:
    app_uuid: "pqr678"
    db_uuid: "stu901"
    domain: "app.example.com"
```

## AI 可以做什麼？

透過 Coolify API，AI 可以：

| 類別 | 操作 |
|------|------|
| **應用程式** | 建立、部署、重啟、停止、查看 log、設定環境變數 |
| **資料庫** | 建立 PostgreSQL / MySQL / Redis / MongoDB、備份、還原 |
| **域名** | 設定 FQDN、自動 SSL（Let's Encrypt） |
| **監控** | 建立 Prometheus + Grafana 服務 |
| **部署** | 觸發部署、查看部署狀態、取消部署 |
| **環境變數** | 單一設定、批次設定 |

## CI/CD 整合

`.github/workflows/cd-coolify.yml` 在 CI 中使用相同的 `deploy.sh`：
- Push to main → 自動部署 staging
- 手動觸發 → 部署 production
- 部署失敗 → 自動建立 intake 回饋

CI 需要的 GitHub Secrets（由 `/setup` 引導設定）：
- `COOLIFY_URL`
- `COOLIFY_API_TOKEN`
- `COOLIFY_STAGING_UUID`
- `COOLIFY_PROD_UUID`
