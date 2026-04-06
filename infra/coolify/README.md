# Coolify 地端部署指南

## 這是什麼？

此目錄提供**需求驅動開發框架**在 Coolify（自架 PaaS）上部署的範本與工具。

這**不是**特定專案的部署設定——而是一套**可被任何採用此框架的專案複用**的部署基礎設施。

## 框架 vs 專案的關係

```
此框架（req repo）                    採用框架的專案（例如 your-app repo）
├── infra/coolify/                    ├── .claude/commands/ ← 從框架複製
│   ├── projects.yml (範本)           ├── infra/coolify/
│   ├── deploy.sh (通用腳本)          │   ├── projects.local.yml ← 填入自己的設定
│   └── README.md                     │   └── deploy.sh ← 從框架複製
├── .github/workflows/                ├── .github/workflows/
│   └── cd-coolify.yml (範本)         │   └── cd-coolify.yml ← 從框架複製
└── CONSTITUTION.md                   ├── specs/
                                      ├── intake/
                                      └── src/
```

## 導入步驟（將框架套用到你的專案）

### Step 1：安裝 Coolify
```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

### Step 2：在 Coolify Dashboard 建立你的 App
1. 建立 Project
2. 建立 Environment: `staging` 和 `production`
3. 在每個 Environment 中建立 Application（連結你的 GitHub repo）
4. 設定域名、Health check 路徑、環境變數
5. 記下每個 Application 的 **UUID**

### Step 3：設定 GitHub Secrets

在你的專案 repo 中設定以下 Secrets：

| Secret | 說明 |
|--------|------|
| `COOLIFY_URL` | Coolify 實例 URL（如 `https://coolify.yourcompany.com`） |
| `COOLIFY_API_TOKEN` | Coolify API Token |
| `COOLIFY_STAGING_UUID` | Staging app 的 UUID |
| `COOLIFY_PROD_UUID` | Production app 的 UUID |
| `STAGING_HEALTH_URL` | Staging 健康檢查 URL（如 `https://staging.yourcompany.com/health`） |
| `PROD_HEALTH_URL` | Production 健康檢查 URL（如 `https://app.yourcompany.com/health`） |

### Step 4：複製框架檔案到你的專案
```bash
# 從框架 repo 複製 Coolify 部署檔案
cp -r req/infra/coolify/ your-project/infra/coolify/
cp req/.github/workflows/cd-coolify.yml your-project/.github/workflows/
cp req/infra/coolify/deploy.sh your-project/infra/coolify/
```

### Step 5：部署
```bash
# 推到 main 自動部署 staging
git push origin main

# 手動部署到 production
gh workflow run "CD — Coolify Deploy" -f environment=production
```

## 多個專案共用一個 Coolify 實例

多個採用此框架的專案可以共用同一個 Coolify 實例：

```
Coolify 實例
├── Project A（repo-a 的 staging + production）
├── Project B（repo-b 的 staging + production）
└── 共用監控（Prometheus + Grafana）
```

每個 repo 各自有：
- 自己的 `cd-coolify.yml`
- 自己的 GitHub Secrets（指向各自的 Coolify app UUID）
- 共用的 `COOLIFY_URL` 和 `COOLIFY_API_TOKEN`

## 手動部署

```bash
# 透過 GitHub CLI
gh workflow run "CD — Coolify Deploy" -f environment=staging
gh workflow run "CD — Coolify Deploy" -f environment=production

# 透過 Claude Code（在採用框架的專案中）
/deploy staging --target=coolify
/deploy prod --target=coolify
```

## 回饋迴路

部署失敗時自動：
1. 建立 `intake/raw/` 問題回報
2. Production 失敗額外建立 `docs/postmortems/` 事後檢討
3. 觸發 `/research` → `/translate` → ... 完整需求驅動流程
