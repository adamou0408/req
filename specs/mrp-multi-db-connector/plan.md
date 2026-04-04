# 技術方案：跨部門資料整合平台（MRP Multi-DB Connector）

## 對應規格
- Spec: [specs/mrp-multi-db-connector/spec.md](spec.md)
- 狀態：`approved`
- 審核日期：2026-04-04

---

## 系統架構總覽

```
┌──────────────────────────────────────────────────────────────────┐
│                        Frontend (Web UI)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │DB Explorer│ │MRP Views │ │Dashboards│ │Admin Mgmt│           │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
│  React + TypeScript + TanStack Query + Ant Design               │
└──────────────────────────┬───────────────────────────────────────┘
                           │ REST API + WebSocket (即時推送)
┌──────────────────────────▼───────────────────────────────────────┐
│                     Backend (API Server)                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ Auth Module   │ │ Connector    │ │ MRP Engine   │             │
│  │ (AD/LDAP)     │ │ Manager      │ │ (MRP II)     │             │
│  ├──────────────┤ ├──────────────┤ ├──────────────┤             │
│  │ RBAC Module   │ │ Schema       │ │ CRP Module   │             │
│  │               │ │ Explorer     │ │              │             │
│  ├──────────────┤ ├──────────────┤ ├──────────────┤             │
│  │ Audit Logger  │ │ Data Sync    │ │ Alert Engine │             │
│  │               │ │ (CDC+Batch)  │ │              │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  Python (FastAPI) + SQLAlchemy + Celery                          │
└──────────┬──────────────┬──────────────┬────────────────────────┘
           │              │              │
┌──────────▼──┐ ┌────────▼──────┐ ┌────▼───────────────────────┐
│ Platform DB  │ │ Message Queue │ │ External Data Sources      │
│ (PostgreSQL) │ │ (Redis)       │ │ ┌────────┐ ┌────────────┐ │
│ - users      │ │ - CDC events  │ │ │Tiptop  │ │ PostgreSQL │ │
│ - connections│ │ - sync jobs   │ │ │(Oracle)│ │ (others)   │ │
│ - configs    │ │ - alerts      │ │ └────────┘ └────────────┘ │
│ - audit_logs │ │ - websocket   │ │ ┌────────────────────────┐ │
│ - mrp_data   │ │               │ │ │ Future: MySQL, MSSQL,  │ │
│ - sync_state │ │               │ │ │ API, CSV, ...          │ │
└─────────────┘ └───────────────┘ │ └────────────────────────┘ │
                                   └────────────────────────────┘
```

## 技術選型

| 層級 | 技術 | 選擇理由 |
|------|------|---------|
| **Frontend** | React 18 + TypeScript | 群聯內部多為 Web 系統，React 生態成熟、元件庫豐富、招募容易 |
| **UI Framework** | Ant Design 5 | 企業級 UI，內建表格、表單、圖表元件，適合資料密集型介面 |
| **資料取得** | TanStack Query + Axios | 自動快取、重新取得、樂觀更新，降低 API 負載 |
| **圖表** | ECharts | 支援大量資料點的趨勢圖、良率圖、儀表板 |
| **Backend** | Python 3.12 + FastAPI | 非同步高效能、自動生成 OpenAPI 文件、Python 生態豐富（資料處理、DB 驅動） |
| **ORM** | SQLAlchemy 2.0 | 支援多種資料庫方言（Oracle、PostgreSQL、MySQL），動態連線管理 |
| **任務佇列** | Celery + Redis | CDC 監聽、批次同步排程、MRP 運算等背景任務 |
| **Platform DB** | PostgreSQL 16 | 儲存系統設定、連線資訊、audit log、MRP 運算結果 |
| **快取/訊息** | Redis 7 | 任務佇列 broker、WebSocket pub/sub、查詢快取 |
| **身份驗證** | python-ldap + JWT | AD/LDAP 整合驗證，JWT token 做 API 授權 |
| **CDC** | Debezium (Oracle + PG) | 成熟的 CDC 方案，支援 Oracle LogMiner 和 PG logical replication |
| **容器化** | Docker + Docker Compose | 開發一致性、部署可攜性 |

## 模組設計

### Module 1：Connector Manager（資料來源管理）

**對應 User Story**：大數據工程師 — DB 連線管理 + Schema 探索

```
connector_manager/
├── connectors/
│   ├── base.py          # 抽象基礎類別 (DBConnector ABC)
│   ├── oracle.py        # Oracle/Tiptop 連接器
│   ├── postgresql.py    # PostgreSQL 連接器
│   └── registry.py      # 插件註冊表（動態載入新連接器）
├── schema_explorer.py   # 資料表/欄位/function 探索
├── encryption.py        # 連線資訊加密（AES-256-GCM）
├── connection_pool.py   # 連線池管理（控制並發數）
└── api/
    ├── connections.py   # CRUD 連線 API
    └── schema.py        # Schema 探索 API
```

**插件架構**：新增資料庫類型只需：
1. 實作 `DBConnector` 介面（connect / list_tables / list_functions / preview_data）
2. 在 `registry.py` 註冊
3. 前端自動出現新的連線類型選項

### Module 2：Data Sync Engine（資料同步引擎）

**對應 User Story**：大數據工程師 — CDC + 批次同步

```
sync_engine/
├── cdc/
│   ├── oracle_cdc.py       # Oracle LogMiner / Debezium 監聽
│   ├── pg_cdc.py           # PostgreSQL logical replication
│   └── event_processor.py  # CDC 事件處理與寫入 platform DB
├── batch/
│   ├── scheduler.py        # 批次排程管理（Celery Beat）
│   ├── extractors.py       # 資料抽取邏輯
│   └── loaders.py          # 資料載入邏輯
├── mapping/
│   ├── field_mapper.py     # 跨來源欄位對應
│   ├── transformers.py     # 資料轉換規則
│   └── version_control.py  # Mapping 版本控制
└── monitoring/
    ├── sync_status.py      # 同步狀態追蹤
    └── lag_detector.py     # 延遲偵測與告警
```

### Module 3：Auth & RBAC（身份驗證與權限）

**對應 User Story**：MIS 管理員 — 存取控管 + Audit Log

```
auth/
├── ad_connector.py      # Active Directory / LDAP 連線
├── jwt_handler.py       # JWT token 生成與驗證
├── rbac/
│   ├── models.py        # 角色、權限、資料範圍模型
│   ├── permissions.py   # 權限檢查邏輯（含敏感欄位黑名單）
│   └── role_templates.py # 8 個角色的預設權限模板
├── audit/
│   ├── logger.py        # 存取紀錄寫入
│   ├── analyzer.py      # 異常偵測（過頻、過慢）
│   └── reporter.py      # 報表匯出
└── api/
    ├── auth.py          # 登入/登出/token refresh
    ├── users.py         # 使用者管理
    └── audit.py         # Audit log 查詢 API
```

**權限模型**：
- 預設開放（CONFLICT-003 決議）
- 敏感欄位黑名單（薪資、成本、客戶個資）
- 白名單由 MIS 管理（CONFLICT-001 備案）
- 頻率限制用連線池 + 令牌桶演算法（CONFLICT-002）

### Module 4：MRP II Engine（MRP 運算引擎）

**對應 User Story**：製造生產 — MRP 運算 + 缺料預警

```
mrp_engine/
├── core/
│   ├── bom_processor.py     # BOM 展開與多階計算
│   ├── demand_calculator.py # 需求計算（銷售預測 + 訂單）
│   ├── supply_analyzer.py   # 供給分析（庫存 + 在途 + 採購）
│   ├── mrp_runner.py        # MRP 主運算（淨需求 = 毛需求 - 供給）
│   └── crp_runner.py        # CRP 能力需求計劃
├── planning/
│   ├── master_schedule.py   # 主生產排程（MPS）
│   ├── capacity_planner.py  # 產能規劃
│   └── purchase_planner.py  # 採購建議
├── alerts/
│   ├── shortage_detector.py # 缺料預警
│   └── capacity_alert.py    # 產能瓶頸預警
└── api/
    ├── mrp.py               # MRP 運算結果查詢
    ├── planning.py          # 排程與建議 API
    └── alerts.py            # 預警 API
```

**MRP II 第一階段範圍**：
- ✅ MPS（主生產排程）
- ✅ MRP（物料需求計劃）
- ✅ CRP（能力需求計劃）
- ✅ 經營規劃（產能 vs 需求大盤）
- ✅ 銷售規劃（銷售預測 → MPS 輸入）
- ❌ 財務管理（後續階段）

### Module 5：Market & Sales Hub（市場與業務中心）

**對應 User Story**：市場部 — 主力組合管理 + 採購追蹤；業務 — 庫存查詢 + 銷售報表

```
market_sales/
├── combo_manager/
│   ├── models.py            # 主力組合模型（Controller + Flash + 目標比例）
│   ├── approval_flow.py     # 市場部主管核准流程
│   ├── publisher.py         # 發布 + 通知（WebSocket 推送）
│   └── history.py           # 決策歷史紀錄
├── procurement/
│   ├── flash_tracker.py     # Flash 採購追蹤（串接 Tiptop 採購模組）
│   ├── price_analyzer.py    # 價格趨勢分析
│   └── safety_stock.py      # 安全庫存預警
├── sales/
│   ├── inventory_query.py   # 即時庫存查詢
│   ├── schedule_query.py    # 生產排程查詢
│   └── reports.py           # 銷售趨勢報表 + 匯出
└── api/
    ├── combos.py            # 主力組合 CRUD + 發布
    ├── procurement.py       # 採購資訊 API
    └── sales.py             # 庫存/排程/報表 API
```

### Module 6：Dashboard & Reports（儀表板與報表）

**對應 User Story**：PM — 跨專案儀表板；測試 — 良率分析；HW/FW — BOM/版本比對

```
dashboards/
├── pm_dashboard.py          # PM 專案進度儀表板
├── quality_dashboard.py     # 測試/良率儀表板
├── engineering/
│   ├── bom_explorer.py      # BOM 查詢 + ECN 歷史
│   └── version_compare.py   # FW 版本測試比較
├── export/
│   ├── excel_exporter.py    # Excel 匯出
│   └── pdf_exporter.py      # PDF 匯出
└── api/
    ├── dashboards.py        # 儀表板資料 API
    └── exports.py           # 匯出 API
```

## 資料庫設計（Platform DB）

```sql
-- 連線管理
CREATE TABLE data_sources (
    id UUID PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    db_type VARCHAR(20) NOT NULL,          -- oracle, postgresql, mysql, ...
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL,
    database_name VARCHAR(100),
    username VARCHAR(100),
    encrypted_password BYTEA NOT NULL,     -- AES-256-GCM 加密
    is_active BOOLEAN DEFAULT true,
    max_connections INTEGER DEFAULT 5,     -- 連線池上限
    rate_limit_per_min INTEGER DEFAULT 60, -- 頻率限制
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 同步設定
CREATE TABLE sync_configs (
    id UUID PRIMARY KEY,
    data_source_id UUID REFERENCES data_sources(id),
    table_name VARCHAR(200) NOT NULL,
    sync_mode VARCHAR(10) NOT NULL,        -- 'cdc' or 'batch'
    cron_expression VARCHAR(50),           -- batch mode only
    last_sync_at TIMESTAMPTZ,
    last_sync_status VARCHAR(20),
    lag_seconds INTEGER,
    is_active BOOLEAN DEFAULT true
);

-- 欄位對應
CREATE TABLE field_mappings (
    id UUID PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    version INTEGER DEFAULT 1,
    source_datasource_id UUID REFERENCES data_sources(id),
    source_table VARCHAR(200),
    source_field VARCHAR(200),
    target_field VARCHAR(200),
    transform_rule JSONB,                  -- 轉換規則
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 主力組合
CREATE TABLE product_combos (
    id UUID PRIMARY KEY,
    controller_model VARCHAR(100) NOT NULL,
    flash_model VARCHAR(100) NOT NULL,
    target_ratio DECIMAL(5,2),             -- 目標生產比例 %
    status VARCHAR(20) DEFAULT 'draft',    -- draft, pending_approval, active, archived
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit Log
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    action VARCHAR(50) NOT NULL,           -- query, export, login, config_change, ...
    target_datasource_id UUID,
    query_text TEXT,
    response_time_ms INTEGER,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);

-- 使用者（AD 同步）
CREATE TABLE users (
    id UUID PRIMARY KEY,
    ad_username VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(200),
    department VARCHAR(100),
    role VARCHAR(50) NOT NULL,             -- big_data, mis, manufacturing, market, sales, pm, hw_fw_rd, qa
    is_active BOOLEAN DEFAULT true,
    last_login_at TIMESTAMPTZ
);
```

## 與現有系統的整合點

| 系統 | 整合方式 | 資料方向 | 備註 |
|------|---------|---------|------|
| Tiptop ERP (Oracle) | SQLAlchemy + cx_Oracle | 單向讀取 | CDC (LogMiner) + 批次；連線池限制並發 |
| Tiptop 採購模組 | 同上（共用 Oracle 連線） | 單向讀取 | Flash 採購資料 |
| Active Directory | python-ldap (LDAPS) | 單向讀取 | 使用者驗證 + 部門/角色同步 |
| PostgreSQL (其他) | SQLAlchemy + psycopg3 | 單向讀取 | CDC (logical replication) + 批次 |
| 未來資料來源 | 插件式擴充 | 依需求 | 只需實作 DBConnector 介面 |

## 風險評估

| 風險 | 可能性 | 影響 | 緩解方案 |
|------|--------|------|----------|
| Oracle CDC (LogMiner) 影響 Tiptop 效能 | 中 | 高 | 先用批次同步上線，CDC 在非尖峰時段測試；備案：用 Oracle GoldenGate 或改為 View + Materialized View |
| 連線池耗盡（多用戶同時查詢） | 中 | 中 | 令牌桶限流 + 查詢佇列 + 監控告警；備案：加入 Redis 快取層 |
| AD 整合問題（權限映射） | 低 | 中 | 先支援 AD 驗證 + 手動角色指派；後續做 AD Group → Role 自動映射 |
| MRP II 運算邏輯複雜度 | 高 | 高 | 分階段交付：先 MRP I（BOM + 淨需求）→ MPS → CRP；每階段可獨立驗收 |
| Flash 價格/採購資料在 Tiptop 中的表結構未知 | 中 | 中 | Schema Explorer 先探索，再設計 mapping；需 MIS 協助確認關鍵表 |

## 實作策略

### Phase 1：基礎平台（可獨立交付）
- Connector Manager：DB 連線管理 + Schema 探索
- Auth：AD 整合 + RBAC
- Audit：存取紀錄

### Phase 2：資料同步 + 市場業務
- Data Sync Engine：CDC + 批次
- Market & Sales Hub：主力組合管理 + 庫存查詢

### Phase 3：MRP 運算
- MRP Engine：BOM 展開 → 淨需求 → MPS → CRP

### Phase 4：儀表板 + 進階功能
- Dashboard：PM / 測試 / RD 儀表板
- 報表匯出
- 良率分析 + 版本比對

每個 Phase 可獨立交付和驗收，不需要等全部完成。
