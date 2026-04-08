# 部署影響檢查清單 (Deployment Checklist)

> **用途**：本文件是 [plan.md](plan.md) 中「部署影響評估」段落的延伸查核表。撰寫 plan.md 時，逐項對照本清單判斷是否有遺漏。
>
> **適用目標**：Coolify（單機／小叢集）與 Kubernetes（中大型叢集）雙目標通用。各段落中凡有平台差異處，會以「Coolify：」「K8s：」分別標註。
>
> **強制性**：plan.md 的「部署影響評估」段落為**強制填寫**（見 [CONSTITUTION.md](../../CONSTITUTION.md) > Architectural Guardrails > Deployment Integrity）。本清單為非強制參考文件，但若新功能觸及任一段落主題，plan.md 必須對應回答。

> **語言**：本檔案採用「中文標題 (English heading)」雙語並列格式，依據 [AGENTS.md](../../AGENTS.md) section 7.0 Language Convention。術語以 [CONSTITUTION.md](../../CONSTITUTION.md) > Glossary 為準。

---

## 1. 健康檢查影響 (Health Check Impact)

> **段落重點**：確認新功能不會讓 readiness 變慢、不會引入會抖動的相依檢查、有處理 SIGTERM。
> **何時需要讀**：本功能新增任何外部相依、改動啟動流程、或本身會吃啟動時間時。

### 基本原則

- 應用程式必須提供**分離的** liveness 與 readiness 端點：
  - `/healthz`（liveness）：回答「我還活著嗎」，**不檢查相依服務**
  - `/readyz`（readiness）：回答「我可以接流量嗎」，檢查 DB / 快取 / 必要下游
- 兩者不可合併，否則相依服務暫時抖動會觸發容器重啟而非暫時流量隔離

### 查核項目

- [ ] 本功能是否會延長 readiness 的回應時間？預估幾毫秒
- [ ] 是否新增 readiness 需檢查的相依（新 DB、新第三方 API）？
- [ ] 應用程式冷啟動時間是否改變？（影響 `initialDelaySeconds`）
- [ ] 是否有 graceful shutdown 處理 SIGTERM？停止接收新請求 → 處理完 in-flight → 退出
- [ ] Shutdown 時間預估是否仍在平台預設寬限內？
  - K8s：預設 `terminationGracePeriodSeconds: 30`
  - Coolify：Docker stop 預設 10 秒，可調整

---

## 2. Schema 向後相容性 (Schema Backward Compatibility)

> **段落重點**：所有 schema 變更都必須假設「rolling update 期間新舊版同時跑」，因此要走 Expand & Contract 三階段。
> **何時需要讀**：本功能涉及任何 DB schema 變更（新增欄位、改型別、刪除欄位等）時。

### 核心原則：Expand & Contract

破壞性 schema 變更絕不能單次部署完成。必須拆成三階段：

1. **Expand**：先加新結構（新欄位必須 nullable 或有 default），新舊版應用都能跑
2. **Migrate**：背景回填資料，應用程式雙寫（同時寫新舊欄位）
3. **Contract**：確認新版穩定（通常數天至數週）後，才移除舊結構

### 查核項目

- [ ] 本次 schema 變更是否向後相容？
  - 「是」= 舊版應用程式讀到新 schema 仍可正常運作
  - 「否」= 觸發 [/deploy](../../commands/deploy.md) 的「irreversible data model changes」人工核准 gate
- [ ] 新增欄位是否為 nullable 或有 default value？
- [ ] 是否有 `DROP COLUMN` / `RENAME COLUMN` / `ALTER TYPE`？若有，必須走 Expand & Contract
- [ ] Migration 是否與應用啟動分離？
  - K8s：用 Job 或 initContainer
  - Coolify：用 pre-deployment command
  - 禁止：綁在 app 啟動腳本（多 replica 會打架）
- [ ] Migration 檔是否進 git 並使用正式工具？（Flyway、Liquibase、Alembic、golang-migrate、Prisma Migrate 等）
- [ ] 大表變更是否會鎖表？預估影響時間？是否需 online migration 工具（gh-ost、pt-online-schema-change）

---

## 3. 設定與機密同步 (Configuration & Secrets Parity)

> **段落重點**：每個新環境變數都要同時更新 `.env.example` 與部署平台設定，且敏感資料一定走 Secret 不走 ConfigMap。
> **何時需要讀**：本功能新增或修改任何環境變數、設定檔、API key、credentials 時。

### 基本原則

- 所有設定走環境變數（12-Factor），不 hardcode、不讀本地設定檔
- 設定與機密分離：
  - 一般設定 → ConfigMap / Coolify env
  - 敏感資料 → Secret / Coolify secret
- `.env.example` 是開發者的「合約」：必須列出所有變數（value 用 placeholder）

### 查核項目

- [ ] 本次新增／修改的環境變數清單（完整列出 key name）
- [ ] 是否同步更新 `.env.example`？
- [ ] 部署平台設定是否同步？
  - Coolify：Environment Variables UI 已更新
  - K8s：ConfigMap / Secret manifest 已更新（進 git，GitOps）
- [ ] 敏感資料是否真的走 Secret 而非 ConfigMap？（API key、DB password、JWT secret 等）
- [ ] Secret 是否出現在 image layer 或 build args？（禁止）
- [ ] 是否有 secret rotation 需求？多久一次？由誰負責？
- [ ] 多環境（dev / staging / prod）的設定差異是否清楚文件化？

---

## 4. 資源預算 (Resource Budget)

> **段落重點**：所有服務都要設 request 與 limit，預估值來自壓測或量測，會成為平台 resource 設定的依據。
> **何時需要讀**：本功能會改變記憶體、CPU、外部呼叫、連線數的使用量時。

### 基本原則

- 所有服務都要有 CPU / memory 的 request 與 limit
- request = 平時用量（排程依據）；limit = 硬上限（超過 memory limit 會 OOMKill）
- 預估值來自**壓測或 baseline 量測**，不是猜的
- 預估值會成為 K8s manifest / Coolify resource 設定的依據

### 查核項目

- [ ] 記憶體 baseline 預估：____ MB（空載）
- [ ] 記憶體 peak 預估：____ MB（壓力測試下）
- [ ] CPU baseline：____ millicores
- [ ] CPU peak：____ millicores
- [ ] 每個請求平均觸發幾次 DB query？幾次外部 API 呼叫？
- [ ] 連線池大小設定？（`max_connections` × replica 數 < DB 上限）
- [ ] 是否需要 HPA (autoscaling)？觸發條件（CPU? memory? custom metric?）
  - K8s：HPA + metrics-server
  - Coolify：目前 autoscaling 支援有限，傾向 vertical scaling
- [ ] 對現有服務的 resource limits 是否需要調整？
- [ ] 預算超標時的處理策略？（降級、快取、限流）

---

## 5. 資料持久性影響 (Data Persistence Impact)

> **段落重點**：先把要產生的資料分類，再決定走 DB / S3 / volume / emptyDir。所有持久化資料都要納入備份策略。
> **何時需要讀**：本功能會儲存任何新資料（DB 表、檔案、log、快取）時。

### 狀態分類

先把本功能會產生的資料分類，每類處理方式不同：

| 類型 | 範例 | 可否遺失 | 處理原則 |
|------|------|---------|---------|
| 關鍵業務資料 | 訂單、用戶、交易 | 絕不可失 | 外部託管 DB + 備份 |
| 使用者上傳檔案 | 頭像、附件 | 不可失 | S3 相容物件儲存 |
| 快取 / Session | Redis cache | 可失（降速） | In-memory，可重建 |
| Log / Metrics | 應用 log | 短期保留 | 外送到 log stack |
| 臨時檔 | 上傳暫存、PDF 生成 | 可失 | `emptyDir` / tmpfs |

### 查核項目

- [ ] 本功能會產生哪些新資料？屬於上表哪一類？
- [ ] 是否有任何資料寫入容器本地檔案系統？（預設會遺失，除非明確 volume mount）
- [ ] 使用者上傳檔案是否走 S3 相容儲存？（禁用本地 `./uploads/`）
- [ ] 新增的 DB 表／檔案是否納入備份策略？
- [ ] 資料量預估：每日新增 ____ 筆／MB，對現有容量的衝擊？
- [ ] 是否有 GDPR / 個資刪除需求？如何實作？
- [ ] 持久化儲存選擇：
  - Coolify：Docker volume mount 或外部託管服務
  - K8s：PersistentVolumeClaim（指定 StorageClass、accessMode）
- [ ] 多 replica 是否需要共享儲存？
  - K8s：需 ReadWriteMany（NFS、CephFS、EFS），效能較差
  - Coolify：傾向共用外部服務而非共用 volume
- [ ] 備份驗證：備份是否定期演練還原？（未驗證的備份等於沒備份）

### 災難復原問題

若以下問題答不出來，表示持久化設計不完整：

- RPO（Recovery Point Objective）：最多能接受掉幾分鐘的資料？
- RTO（Recovery Time Objective）：掛掉後要多久恢復？
- 整個 region / VPS 掛掉怎麼辦？異地備份在哪？
- 誤刪資料怎麼救？是否有 PITR？
- 還原流程文件在哪？半夜上 call 的人找得到嗎？

---

## 6. 觀測性 (Observability)

> **段落重點**：log / metrics / tracing 三者缺一不可。log 寫 stdout 不寫檔案、metric label 別放高基數值、trace context 要傳到下游。
> **何時需要讀**：本功能新增關鍵業務操作、外部呼叫、需告警的失敗情境時。

### 基本原則

- Log 走 stdout/stderr，不寫檔案（由平台收集）
- Metrics 透過 `/metrics` 端點（Prometheus 格式為業界預設）
- Tracing 用 OpenTelemetry（可後端切 Jaeger / Tempo / Datadog）
- 三者缺一不可：log 告訴你發生什麼、metrics 告訴你嚴重程度、trace 告訴你為什麼

### 查核項目

#### Logging

- [ ] 新增的關鍵操作是否有結構化 log？（JSON 格式優於純文字）
- [ ] Log level 是否正確？（不要把 debug 訊息寫成 info 刷版面）
- [ ] 敏感資料是否被遮蔽？（密碼、token、PII、信用卡）
- [ ] 是否有 correlation ID / trace ID 貫穿整個請求？
- [ ] Log 是否會被現有收集 stack 處理？
  - Coolify：內建 log viewer，亦可外送
  - K8s：Fluent Bit / Vector → Loki / Elasticsearch / CloudWatch

#### Metrics

- [ ] 本功能是否新增業務指標？（成功/失敗數、處理時間、佇列長度）
- [ ] 是否暴露到 `/metrics` 端點？
- [ ] 是否設定對應的 SLO / alert rule？
- [ ] Metric cardinality 是否會爆炸？（label 不要放 user_id、request_id 等高基數值）
- [ ] 是否區分 RED / USE 指標？
  - RED：Rate、Errors、Duration（請求面向）
  - USE：Utilization、Saturation、Errors（資源面向）

#### Tracing

- [ ] 是否透過 OpenTelemetry SDK 輸出 trace？
- [ ] 新增的外部呼叫（DB、API、queue）是否有 span 包裹？
- [ ] 取樣率是否合理？（全量取樣成本高，低流量全取／高流量抽樣）
- [ ] Trace context 是否正確傳播到下游服務？（W3C TraceContext header）

#### Alerting

- [ ] 本功能是否有必要的告警規則？
- [ ] 告警是否對應 `feedback_loop: true`，自動進 intake？（見 [CONSTITUTION.md](../../CONSTITUTION.md) Principle 6）
- [ ] 是否設定告警去重（30 分鐘內相同告警合併）？
- [ ] 告警劇本 (runbook) 是否存在？新人收到告警後知道要做什麼？

---

## 附錄 A：Coolify vs K8s 快速對照

| 面向 | Coolify | K8s |
|------|---------|-----|
| 部署單位抽象 | `docker-compose.yml` | Deployment / StatefulSet / DaemonSet |
| 設定管理 | Coolify UI env vars | ConfigMap + Secret |
| 機密管理 | Coolify secrets | Secret（可搭 Sealed Secrets / External Secrets Operator） |
| 健康檢查 | Compose healthcheck | livenessProbe / readinessProbe / startupProbe |
| 資源限制 | Compose `deploy.resources` | `resources.requests/limits` |
| 持久化 | Docker volume / 外掛託管服務 | PersistentVolumeClaim + StorageClass |
| 自動擴展 | 有限（主要靠 vertical） | HPA / VPA / KEDA |
| 備份 | 內建 + 自補 | Velero / Stash / 雲商 snapshot |
| 反向代理 | 內建 Traefik | Ingress Controller（Nginx / Traefik / Contour） |
| 學習曲線 | 低 | 高 |
| 適合規模 | 1~3 台 VPS、小型團隊 | 任意規模、有 platform team |

**決策參考**：同時維護「應用程式設計不綁定平台」＋「平台選擇可隨規模演進」是最務實的路線。Day 1 用 Coolify 上線，規模成長後遷 K8s，只要開發時遵守本清單的通用原則，遷移成本可控。

---

## 附錄 B：常見雷區 (Common Pitfalls)

集中收錄各段落實務上踩過的坑。撰寫 plan.md 時可掃過此附錄確認自己沒有掉進任何一個。

### Health Check 相關

- Readiness 檢查裡打了外部 API，對方抖一下整個 pod 被判定不健康
- 啟動時跑 migration 導致 `initialDelaySeconds` 不夠長，pod 反覆重啟
- 沒處理 SIGTERM，部署時掉請求

### Schema 變更相關

- 一次 PR 同時 `ADD COLUMN` 和 `DROP COLUMN`，rolling update 期間炸掉
- Migration 跑太久把部署流程卡住
- 在應用啟動腳本裡跑 migration，多 replica 同時搶 lock

### 設定與機密相關

- 只改 `.env.example`，沒同步到 Coolify UI，prod 上線直接爆
- 把 secret 放進 ConfigMap 或 image
- 開發者本機 `.env` 跟 `.env.example` 不同步，新人加入跑不起來

### 資源預算相關

- 沒設 memory limit，一個服務 OOM 拖垮整台機器
- HPA 設了，但應用程式不是真的 stateless（session in memory），擴容後使用者被踢
- 連線池總和超過 DB `max_connections` 上限，新 pod 起來就 connection refused

### 資料持久性相關

- 開發時寫 `./uploads/`，K8s 部署整組檔案消失
- DB 跟應用跑在同一個容器裡
- 備份從未演練過還原，真的要用時發現備份是壞的
- `emptyDir` 用來存「重要的」臨時檔，pod 重建後資料沒了

### 觀測性相關

- 只有 log 沒有 metrics，事後看得出「出事了」但不知道「多嚴重」
- Metric label 放 user_id，Prometheus 記憶體炸掉
- Trace 只到本服務就斷了，context 沒傳下去
- 告警狂響但沒人知道該怎麼處理，最後所有人把通知關靜音
