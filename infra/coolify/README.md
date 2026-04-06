# Coolify 地端部署指南（多專案）

## 架構概覽

```
Coolify Dashboard
├── Project A (mrp) ─── staging / production
├── Project B (erp) ─── staging / production
└── 共用服務 ────────── Prometheus + Grafana + Alertmanager
```

## 新增專案 Checklist

### 在 Coolify 上
1. [ ] 建立 Project（例如 `MRP 系統`）
2. [ ] 在 Project 下建立 Environment: `staging`
3. [ ] 在 staging 中建立 Application（連結 GitHub repo）
4. [ ] 記錄 staging Application UUID
5. [ ] 建立 Environment: `production`
6. [ ] 在 production 中建立 Application
7. [ ] 記錄 production Application UUID
8. [ ] 設定 Health check 路徑（如 `/health`）
9. [ ] 設定域名（如 `mrp-staging.yourcompany.com`）
10. [ ] 設定環境變數（DB 連線等）

### 在 GitHub 上
11. [ ] 新增 Repository Secret: `COOLIFY_<PROJECT>_STAGING_UUID`
12. [ ] 新增 Repository Secret: `COOLIFY_<PROJECT>_PROD_UUID`
13. [ ] 在 `cd-coolify.yml` 的 project 選項中加入新專案名稱
14. [ ] 在 `cd-coolify.yml` 的 `case` 區塊中加入新專案的 UUID 和域名

### 在此 Repo 上
15. [ ] 在 `infra/coolify/projects.yml` 中新增專案區塊
16. [ ] 更新 `docs/metrics.md` 追蹤新專案的部署指標

## GitHub Secrets 清單

| Secret 名稱 | 說明 | 每個專案都需要？ |
|-------------|------|-----------------|
| `COOLIFY_URL` | Coolify 實例 URL | 共用 |
| `COOLIFY_API_TOKEN` | API 認證 Token | 共用 |
| `COOLIFY_<PROJECT>_STAGING_UUID` | Staging app UUID | 是 |
| `COOLIFY_<PROJECT>_PROD_UUID` | Production app UUID | 是 |

## 手動部署

```bash
# 部署 MRP 到 staging
gh workflow run "CD — Coolify Deploy" \
  -f project=mrp \
  -f environment=staging

# 部署 ERP 到 production
gh workflow run "CD — Coolify Deploy" \
  -f project=erp \
  -f environment=production
```

## 回饋迴路

部署失敗時自動：
1. 在 `intake/raw/` 建立問題回報（含專案名稱）
2. Production 失敗額外建立 `docs/postmortems/` 事後檢討
3. 觸發 `/research` → `/translate` → ... 完整流程
