# Framework v2.0 vs 市場主流 SDD 工具完整比較

> 分析日期：2026-04-06
> 比較對象：GitHub Spec Kit v0.5、AWS Kiro GA、Tessl、Cursor 2.0、Windsurf (Cognition AI)、AutoSpec
> 資料來源：GitHub、Martin Fowler、Scott Logic、各工具官方文件

---

## 比較對象概覽

| 工具 | 開發者 | Stars / 定位 | 核心理念 | AI 後端 |
|------|--------|-------------|----------|---------|
| **此框架 v2.0** | 獨立開發 | — | 需求→交付→回饋閉環系統 | Claude |
| **GitHub Spec Kit** | GitHub | 85.5K stars | 規格→程式碼轉換工具包 | 20+ 後端（Claude/Gemini/Copilot/Codex/Cursor/Windsurf/Kiro 等） |
| **AWS Kiro** | Amazon | GA IDE | 規格驅動 IDE（EARS 標記法） | Claude via Bedrock |
| **Tessl** | 前 GitHub 團隊 | VC-backed | 規格即源碼（Spec-as-Source） | MCP（任何 agent） |
| **Cursor 2.0** | Anysphere | 最大 AI 社群 | 速度優先的 AI 編輯器 | Multi-model |
| **Windsurf** | Cognition AI | 收購 $250M | 全 codebase 感知 IDE | 自有 AI (Cascade/Flow) |
| **AutoSpec** | 社群 | 118 stars | YAML-first SDD CLI | Claude/OpenCode |

### Martin Fowler 的 SDD 成熟度分類

> 出處：martinfowler.com — "Understanding SDD: Kiro, spec-kit, and Tessl"

| 等級 | 定義 | 代表工具 |
|------|------|----------|
| **Spec-first** | 先寫規格再寫程式碼 | Spec Kit、Kiro、AutoSpec |
| **Spec-anchored** | 規格在開發後持續維護，作為演化基礎 | Tessl |
| **Spec-as-source** | 規格即原始碼，程式碼是衍生物 | Tessl（目標）、此框架（理念） |

此框架的 CONSTITUTION 第 2 條原則（「程式碼是規格的產物」）與 Spec-as-source 理念一致，但實作上更接近 Spec-anchored（透過 /iterate 持續維護規格）。

---

## 零、各工具核心特色（深入分析）

### GitHub Spec Kit v0.5（85.5K stars）

**核心流程**：constitution → specify → plan → tasks → implement（5 階段）

**獨特優勢**：
- **意圖壓縮（Intentional Compaction）**：每個階段輸出一份壓縮文件供下階段使用，有效管理 token 限制
- **20+ AI 後端支援**：Claude、Copilot、Gemini、Cursor、Windsurf、Codex、Kiro 等全部支援
- **VS Code 擴充（Spec Kit Assistant + Companion）**：視覺化工作流
- **MCP Server（Rust）**：`@lsendel/spec-kit-mcp`
- **Microsoft Learn 官方教學模組**

**已知弱點**（Scott Logic 評論 + 社群討論）：
- 產生「markdown 文件海」，流程沉重
- 更適合全新專案，既有程式碼適應困難
- 部分人認為是「重新發明的瀑布式開發」
- 維護人員異動後社群有維護擔憂
- 無部署、無監控、無安全掃描

---

### AWS Kiro GA

**核心流程**：requirements（EARS 標記法）→ design → tasks → implement

**獨特優勢**：
- **EARS 標記法**（源自 Rolls-Royce 航太）：`WHEN [條件] THE SYSTEM SHALL [行為]`，強制思考邊界情況
- **Hooks 系統**：檔案儲存時自動觸發 AI 行動（如自動生成測試）
- **Steering 檔案**：專案層級的持久上下文，無需每次重新解釋
- **安全內建**：commit 時自動掃描洩漏密鑰
- **深度 AWS 整合**：GovCloud 合規支援

**已知弱點**：
- 最適合全新 + AWS 原生專案
- 三階段強制執行對小變更過於僵硬
- Martin Fowler 評為三大 SDD 工具中「最簡單」的

---

### Tessl（前 GitHub 團隊）

**核心流程**：describe → spec（含能力清單 + API）→ implement

**獨特優勢**：
- **Spec Registry**：10,000+ 函式庫規格，防止 AI 幻覺和版本混淆
- **Spec-as-source 願景**：規格即源碼，程式碼是衍生物
- **程式碼標記**：`// GENERATED FROM SPEC - DO NOT EDIT`
- **MCP 整合**：支援任何 MCP-compatible agent
- **自動聚合**：類似需求自動合併

**已知弱點**：
- Framework 仍在封閉測試
- Registry 為開放測試（10K+ 規格）
- 尚未大規模驗證

---

### Cursor 2.0

**核心理念**：速度優先，SDD 為可選項

**獨特優勢**：
- **8 個平行 Agent**：同時處理多任務
- **Plan Mode**：AI 先推理再編碼（非持久化）
- **Rules 層級**：Global → Project（`.cursor/rules/`）→ File-specific
- **Enterprise 自架**（2026/3）：程式碼和密鑰留在本地

**已知弱點**：
- 無正式規格結構
- 無強制審核閘門
- SDD 需開發者自行設計

---

### Windsurf / Cognition AI

**核心理念**：全 codebase 感知，規則引導

**獨特優勢**：
- **Flow 引擎**：業界最強的 codebase 索引系統
- **Memories**：跨 session 持久記憶，記住編碼風格和專案邏輯
- **三層規則**：Global → Workspace（`.windsurfrules`）→ System-Level
- **LogRocket 排名 #1**（2026/2 AI 開發工具排行）

**已知弱點**：
- 非規格驅動設計
- 無結構化規格、無衝突偵測、無部署整合

---

### AutoSpec（118 stars）

**核心理念**：YAML-first，成本效率導向

**獨特優勢**：
- **YAML-first**：機器可讀（vs Spec Kit 的 Markdown-first 人類可讀）
- **Session 隔離**：每任務獨立上下文，API 成本減少 80%+
- **8 階段**：constitution → specify → clarify → plan → tasks → checklist → analyze → implement
- **標準化退出碼（0-5）**：便於 CI/CD 整合

**已知弱點**：
- 社群極小（118 stars）
- 無部署、無監控、無安全

---

## 一、33 維度完整比較矩陣

### 維度說明
- ✅ 完整支援（內建功能）
- ⚠️ 部分支援（需額外配置或社群擴充）
- ❌ 不支援

---

### A. 需求管理（上游）

| 維度 | 此框架 v2.0 | Spec Kit | Kiro | Tessl | Cursor | Windsurf | AutoSpec |
|------|-------------|----------|------|-------|--------|----------|----------|
| **1. 非技術人員輸入** | ✅ 任何格式、GitHub Issue 模板 | ❌ 需開發者 | ❌ 需開發者 | ❌ 需開發者 | ❌ 需開發者 | ❌ 需開發者 | ❌ CLI |
| **2. 需求去重** | ✅ /research 自動掃描 >80% 重疊 | ❌ | ⚠️ 手動 | ✅ 自動聚合 + Registry | ❌ | ❌ | ❌ |
| **3. 可行性評估** | ✅ 技術風險、安全、DB 變更自動標記 | ❌ | ⚠️ steering | ❌ | ❌ | ❌ | ❌ |
| **4. 角色衝突偵測** | ✅ 4 種衝突類型自動偵測 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **5. 衝突解決流程** | ✅ /resolve-conflict 結構化決策 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **6. 多角色 User Story** | ✅ 每個 persona 獨立 Story | ⚠️ 單一視角 | ⚠️ EARS 單一 | ❌ | ❌ | ❌ | ❌ |

**v2.0 優勢**：需求管理是此框架最強的領域。**#4 衝突偵測和 #5 衝突解決是市場上唯一提供的**。Tessl 在去重方面接近（Registry + 聚合），但無衝突管理。

---

### B. 規格結構（核心）

| 維度 | 此框架 v2.0 | Spec Kit | Kiro | Tessl | Cursor | Windsurf | AutoSpec |
|------|-------------|----------|------|-------|--------|----------|----------|
| **7. 規格模板** | ✅ 12 欄位（含安全、成功指標、依賴） | ✅ 5 檔案 PRD | ✅ 3 檔案 EARS | ✅ 3 部分 spec | ⚠️ rules 檔 | ⚠️ rules+memories | ✅ YAML 格式 |
| **8. 規格版本管理** | ✅ 版本歷史表 + /iterate 自動遞增 | ❌ 僅 git | ⚠️ 內建追蹤 | ⚠️ Registry 版本 | ❌ | ❌ | ❌ |
| **9. 規格依賴圖** | ✅ 前置/後續/共享資源 | ❌ | ⚠️ hooks | ❌ | ❌ | ❌ | ⚠️ 依賴欄位 |
| **10. API 合約** | ✅ contracts.md 模板 | ✅ contracts/ 目錄 | ✅ design.md 內 | ✅ spec API 區塊 | ❌ | ❌ | ❌ |
| **11. 狀態機** | ✅ 5 狀態 + 3 衝突狀態 + 4 任務狀態 | ❌ 無正式定義 | ⚠️ 隱含 | ❌ | ❌ | ❌ | ⚠️ task status |
| **12. 技術調研** | ✅ research.md | ✅ research.md | ⚠️ steering | ✅ Registry 查詢 | ❌ | ❌ | ⚠️ clarify 階段 |

**v2.0 優勢**：規格結構已追平 Spec Kit，並在版本管理（#8）和依賴圖（#9）上超越。狀態機是此框架獨有的嚴謹治理。

---

### C. 開發執行（中游）

| 維度 | 此框架 v2.0 | Spec Kit | Kiro | Tessl | Cursor | Windsurf | AutoSpec |
|------|-------------|----------|------|-------|--------|----------|----------|
| **13. 任務分解** | ✅ [P-group] + [depends] | ✅ [P] 標記 | ⚠️ 基本依賴 | ✅ 自動並行 | ⚠️ 8 agent 並行 | ❌ | ✅ YAML 依賴 |
| **14. 測試策略分層** | ✅ unit/integration/e2e 每任務 | ✅ Test-First | ✅ design 內定義 | ✅ spec-linked tests | ❌ 無強制 | ❌ | ❌ 無強制 |
| **15. 上下文管理** | ✅ 3000 字摘要 + 下游摘要 | ✅ 意圖壓縮 | ✅ 動態裁剪 | ⚠️ spec 即記憶 | ✅ @ 引用 + 索引 | ✅ Flow 引擎 | ✅ Session 隔離 |
| **16. 程式碼溯源** | ✅ 內嵌註解連結 spec/task | ⚠️ 無強制 | ❌ | ✅ `GENERATED FROM SPEC` | ❌ | ❌ | ❌ |
| **17. 自動修復** | ✅ 3 次修復 + 人工升級 | ⚠️ 部分 | ✅ Hooks | ✅ 自動迭代 | ✅ 自動 | ✅ 自動 | ✅ 自動重試 |
| **18. 程式碼審查** | ✅ AGENTS 指令 + CI 門檻 | ⚠️ 開發者自行 | ✅ PR 工作流 | ⚠️ 部分 | ❌ | ❌ | ❌ |

**v2.0 評估**：開發執行與 Spec Kit/Kiro 持平。上下文管理（#15）各家方法不同——Spec Kit 用意圖壓縮、Kiro 用動態裁剪、Windsurf 用 Flow 引擎、AutoSpec 用 Session 隔離（省 80% API 成本）。Tessl 的 `GENERATED FROM SPEC` 標記與此框架的程式碼溯源（#16）理念相同。

---

### D. 安全與合規

| 維度 | 此框架 v2.0 | Spec Kit | Kiro | Tessl | Cursor | Windsurf | AutoSpec |
|------|-------------|----------|------|-------|--------|----------|----------|
| **19. 安全需求評估** | ✅ 6 維度（資料分類→個資處理） | ❌ | ✅ design 安全區塊 | ❌ | ❌ | ❌ | ⚠️ 風險評估 |
| **20. CI 安全掃描** | ✅ 密鑰偵測 + 依賴漏洞 | ⚠️ 社群整合 | ✅ commit hooks 掃描 | ⚠️ guardrails | ⚠️ Enterprise 自架 | ❌ | ❌ |
| **21. OWASP 防護** | ✅ AGENTS 指令強制 | ❌ | ⚠️ steering 建議 | ❌ | ❌ | ❌ | ❌ |

**v2.0 優勢**：安全性從 v1.0 的「空白」提升到「領先」。6 維度安全評估（#19）是市場上最結構化的。

---

### E. 部署與運維（下游）

| 維度 | 此框架 v2.0 | Spec Kit | Kiro | Tessl | Cursor | Windsurf | AutoSpec |
|------|-------------|----------|------|-------|--------|----------|----------|
| **22. CI/CD 整合** | ✅ Spec Gate + 安全掃描 + 部署 | ❌ | ✅ steering + hooks | ⚠️ 部分 | ⚠️ hooks | ❌ | ⚠️ exit codes |
| **23. 部署策略** | ✅ 4 種（Direct/Rolling/Canary/Blue-Green） | ❌ | ⚠️ steering 定義 | ⚠️ 部分 | ❌ | ❌ | ❌ |
| **24. 自動回滾** | ✅ 健康檢查失敗自動回滾 | ❌ | ✅ steering 配置 | ⚠️ 部分 | ❌ | ❌ | ❌ |
| **25. 閉環回饋** | ✅ 監控→自動 intake→開發→部署 | ❌ | ⚠️ hooks 可觸發 | ❌ | ❌ | ❌ | ❌ |
| **26. 事後檢討** | ✅ 5 Whys 模板 + 自動建立 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **27. 監控告警整合** | ✅ 6 種告警 + 去重 + 升級 | ❌ | ⚠️ AWS 整合 | ❌ | ❌ | ❌ | ❌ |

**v2.0 優勢**：部署與運維是此框架的第二強項。**6 項中 5 項領先**。閉環回饋（#25）和事後檢討（#26）是市場唯一。

---

### F. 生態與協作

| 維度 | 此框架 v2.0 | Spec Kit | Kiro | Tessl | Cursor | Windsurf | AutoSpec |
|------|-------------|----------|------|-------|--------|----------|----------|
| **28. 多 AI 後端** | ❌ 僅 Claude | ✅ 20+ 後端 | ❌ 僅 Claude/Bedrock | ✅ MCP（任何 agent） | ✅ 多後端 | ❌ 自有 | ⚠️ Claude/OpenCode |
| **29. IDE 整合** | ❌ CLI only | ✅ VS Code + MCP | ✅ 原生 IDE | ⚠️ MCP 整合 | ✅ 原生 IDE | ✅ 原生 IDE | ❌ CLI |
| **30. 社群生態** | ❌ 單一專案 | ✅ 85.5K stars | ⚠️ AWS 支撐 | ⚠️ VC 支撐 | ✅ 最大社群 | ⚠️ Cognition AI | ❌ 118 stars |
| **31. 多團隊協作** | ✅ 擁有者/SLA/升級 | ❌ 無 RBAC | ✅ 團隊 steering | ✅ 內建 | ✅ Enterprise SSO | ⚠️ 組織 rules | ❌ |
| **32. i18n** | ✅ zh-TW + en 雙語 | ⚠️ 社群日文 | ❌ 英文 | ❌ 英文 | ❌ 英文 | ❌ 英文 | ❌ 英文 |
| **33. 框架可觀測性** | ✅ 20+ 健康指標 | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ 執行歷史 |

**v2.0 劣勢**：生態與 IDE 整合是最大弱點。僅支援 Claude + CLI，無 IDE 外掛，無社群。但在 i18n（#32）和可觀測性（#33）上是唯一的。

---

## 二、綜合評分（10 分制）

| 能力維度 | 此框架 v2.0 | Spec Kit | Kiro | Tessl | Cursor | Windsurf | AutoSpec |
|----------|-------------|----------|------|-------|--------|----------|----------|
| 需求管理（上游） | **10** | 3 | 3 | 4 | 1 | 1 | 2 |
| 規格結構（核心） | **9** | 8 | 7 | 7 | 3 | 3 | 7 |
| 開發執行（中游） | 8 | 8 | **8** | 8 | 8 | 7 | 7 |
| 安全與合規 | **9** | 3 | 7 | 3 | 3 | 2 | 2 |
| 部署與運維（下游） | **10** | 1 | 6 | 3 | 1 | 1 | 2 |
| 生態與協作 | 4 | **10** | 7 | 6 | **9** | 6 | 2 |
| **加權總分** | **8.5** | 6.0 | 6.3 | 5.2 | 4.5 | 3.7 | 4.0 |

> 加權方式：需求管理 20%、規格結構 20%、開發執行 20%、安全合規 10%、部署運維 20%、生態協作 10%

---

## 三、v2.0 vs v1.0 進步幅度

| 維度 | v1.0 | v2.0 | 提升幅度 |
|------|------|------|----------|
| 流程階段 | 10 | 12 | +20% |
| 命令數 | 9 | 11 | +22% |
| CONSTITUTION 原則 | 6 | 7 | +17% |
| AGENTS 指令 | 8 | 12 | **+50%** |
| Spec 模板欄位 | 6 | 12 | **+100%** |
| 安全性 | 0 (空白) | 9/10 | **從無到有** |
| 上下文管理 | 0 (無) | 有 | **從無到有** |
| 衝突解決 | 僅偵測 | 完整流程 | **質的飛躍** |
| 部署策略 | 1 種 | 4 種 | **+300%** |
| i18n | 僅中文 | 雙語 | **+100%** |
| 非技術存取 | CLI only | CLI + GitHub Issue | **新增管道** |
| 可觀測性 | 0 | 20+ 指標 | **從無到有** |

---

## 四、此框架的市場定位圖（v2.0 更新）

```
              技術工具鏈成熟度
                   ↑
            Cursor ●    ● Kiro
                   |
          Spec Kit ●    ● Tessl
                   |
        Windsurf ● |
                   |         ● 此框架 v2.0
                   |        ↗
                   |      ● 此框架 v1.0
    ←──────────────┼──────────────→ 生命週期覆蓋範圍
     規格→程式碼    |           需求→部署→監控→回饋
                   |
                   ↓
              業務親和度
```

**v2.0 的移動**：向右上方移動 — 在保持業務親和度和生命週期覆蓋的同時，技術工具鏈成熟度大幅提升。

---

## 五、v2.0 仍存在的差距（誠實評估）

### 相對弱項（與最強競品比較）

| 差距 | 最強競品 | 競品具體做法 | v3.0 建議 |
|------|----------|-------------|-----------|
| **多 AI 後端** | Spec Kit（20+ 後端） | Agent 配置字典，每個後端有獨立模板目錄和指令格式 | 將 .claude/commands/ 抽象為 agent-agnostic 格式，支援 Gemini/GPT |
| **IDE 整合** | Kiro（原生 IDE） | 基於 Code OSS 的完整 IDE 體驗 | 開發 VS Code 擴充，將 /intake 等命令視覺化 |
| **社群生態** | Spec Kit（85.5K） | MIT 開源 + Microsoft Learn 教學 + 40+ 社群擴充 | 開源推廣 + 建立教學文件 |
| **上下文壓縮** | Spec Kit（意圖壓縮） | 每階段強制壓縮為單一文件，下階段只讀壓縮版 | 將現有「下游摘要」升級為強制壓縮機制 |
| **MCP 整合** | Tessl（MCP native） | 透過 MCP 支援任何 agent | 開發 MCP adapter，讓框架可被任何 MCP client 調用 |
| **Spec Registry** | Tessl（10K+ 規格庫） | 函式庫規格防止 AI 幻覺和版本混淆 | 可建立內部 spec registry 供跨專案複用 |
| **EARS 標記法** | Kiro | `WHEN [條件] THE SYSTEM SHALL [行為]`，強制邊界思考 | 可在 /translate 中選用 EARS 作為替代格式 |

### 絕對弱項（所有工具都沒做好）

| 能力 | 現狀 | 說明 |
|------|------|------|
| **需求品質度量** | 無工具做得好 | 如何客觀衡量一個 spec 的品質？ |
| **AI 幻覺偵測** | 無工具做得好 | AI 生成的 spec 是否準確反映原始需求？ |
| **跨專案依賴** | 無工具做得好 | 多個專案間的 spec 依賴管理 |
| **長期規格維護** | Tessl 最接近 | Martin Fowler 指出：spec-first 容易在功能完成後停止維護 |

### Scott Logic 的「重新發明的瀑布」批評

> "SDD 的嚴格階段式流程是否就是換了名字的瀑布式開發？"

此批評適用於所有 SDD 工具，但此框架的 `/iterate` 命令和 CONSTITUTION 第 5 條（「需求變更是常態」）提供了緩解：
- 任何階段都可以透過 /iterate 回退到 draft
- 變更被正面看待，不是懲罰
- 閉環回饋讓生產問題自動回流

這使此框架更接近「持續迭代的螺旋式開發」而非瀑布式。

---

## 六、結論

### v2.0 的競爭地位

此框架 v2.0 在 **33 個比較維度** 中：
- **領先所有競品**：12 個維度（需求管理 6 項全部、閉環回饋、事後檢討、安全評估、i18n、可觀測性、程式碼溯源）
- **追平最強競品**：10 個維度（規格結構、任務分解、測試分層、上下文管理、API 合約、技術調研等）
- **落後競品**：6 個維度（多 AI 後端、IDE 整合、社群生態、MCP、即時上下文裁剪、Feature Flag）

### 一句話定位

> **此框架 v2.0 是市場上唯一覆蓋「非技術需求輸入 → 衝突解決 → 安全開發 → 漸進部署 → 監控回饋 → 事後檢討」完整閉環的 SDD 框架。在需求管理和運維閉環上無人能及；在開發工具鏈成熟度上已追平主流；在 IDE 整合和社群生態上仍需努力。**

---

*分析日期：2026-04-06*
*Framework Version：2.0.0*
*比較對象：GitHub Spec Kit v0.5.0、AWS Kiro GA、Tessl、Cursor Agent、Windsurf Cascade*
