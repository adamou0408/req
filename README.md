# 需求驅動設計開發（Demand-Driven AI Development）

## 這個專案是做什麼的？

**你不需要懂任何技術，只需要說出你想要什麼。**

這個專案讓任何人都能提出需求——不管你是老闆、業務、客服還是使用者，你只要用你自己的話說出「我想要什麼」，AI 就會自動幫你把想法變成可以開發的規格，最終變成真正能用的軟體。

你不需要：
- ❌ 學習任何技術知識
- ❌ 寫正式的「需求文件」
- ❌ 用特定的格式或模板
- ❌ 和工程師反覆溝通

你只需要：
- ✅ 說出你的想法

---

## 我該怎麼提需求？3 步驟超簡單

### 第 1 步：說出你想要什麼
用你自己的話就好。可以是一句話、一段對話、一份會議紀錄，甚至是一張截圖加幾句說明。

### 第 2 步：AI 會幫你調研和整理
AI 會先檢查有沒有類似的需求，再把你說的話整理成結構化的規格，包含不同使用者的需求、可能的衝突等等。

### 第 3 步：你來確認
AI 整理好之後，會請你（或負責人）看一下是否正確。確認之後，AI 就會開始開發。

就這麼簡單！

> 💡 **想先看實際產出再決定要不要導入？** 跳到 [`examples/quickstart/`](examples/quickstart/) — 那是一個已經跑完六大階段的示範專案，完整的 `spec.md` / `plan.md` / `tasks.md` / `contracts.md` / 衝突記錄 / 審核 checklist 都放在那裡，5 分鐘就能看完。

---

## 流程總覽

> 下圖的 `intake/`、`specs/`、`src/` 是邏輯名稱;實際位置依安裝模式而定(Init 模式在專案根目錄;Submodule 模式在 `.req/` 下,生成的程式碼仍落在 host repo 原本的 `src/`、`tests/`)。完整說明見 [docs/installation.md](docs/installation.md)。

```mermaid
graph TD
    A[👤 任何人提交原始需求] -->|/req-intake| R[🔍 /req-research 調研去重]
    R -->|重複| A2[/req-iterate 合併至現有 spec]
    R -->|全新| B[🤖 /req-translate 轉譯]
    B --> C[📋 結構化規格 spec.md]
    B --> D[👥 自動識別/更新角色 personas/]
    B --> E{⚠️ /req-detect-conflicts}
    E -->|有衝突| F[conflicts/ 標記衝突]
    F --> G[👤 /req-resolve-conflict 人類裁決]
    G --> C
    E -->|無衝突| C
    C --> H[👤 /req-review 人類審核]
    H -->|退回| A
    H -->|通過| I[🤖 /req-plan 技術方案]
    I --> J[🤖 /req-plan 拆解 tasks.md]
    J --> K[🤖 /req-implement 寫碼]
    K --> L[🧪 自動化測試 tests/]
    L -->|失敗| K
    L -->|通過| L2[🔒 安全掃描 + 程式碼審查]
    L2 -->|通過| M[🚀 /req-deploy]
    M --> N[📡 持續監控]
    N -->|發現問題| O[🔄 /req-feedback 自動回報]
    O --> A
    N -->|正常| P[✅ 持續運行]
    P -.->|需求變更| A
```

### 流程說明

| 階段 | 指令 | 誰負責 | 做什麼 |
|------|------|--------|--------|
| 提需求 | `/req-intake` | **你** | 用任何方式說出你想要什麼 |
| 調研去重 | `/req-research` | AI | 檢查是否有重複需求,評估可行性(由 `req-research` subagent 執行) |
| 轉譯 | `/req-translate` | AI | 把你的話整理成結構化 `spec.md` |
| 衝突偵測 | `/req-detect-conflicts` | AI | 找出不同角色之間的需求矛盾(由 `req-conflict-detector` subagent 執行) |
| 裁決衝突 | `/req-resolve-conflict` | **人類** | 透過結構化決策框架解決衝突(彈出選項視窗) |
| 審核 | `/req-review` | **人類** | 確認 AI 整理的規格是否正確(含安全性,彈出 Approve/Reject 視窗) |
| 技術方案 | `/req-plan` | AI + **人類** | AI 產 `plan.md`/`tasks.md`,結束時呼叫 `ExitPlanMode` 等人按核准 |
| 開發 | `/req-implement` | AI | 自動寫程式 + 測試;測試失敗自動修最多 3 次 |
| 部署 | `/req-deploy` | AI + **人類** | 跑 health check,正式環境需要人確認 |
| 監控/回報 | `/req-feedback` | AI | 持續監控,發現問題自動回報成新 intake |
| 迭代 | `/req-iterate` | **你** | 想改什麼隨時說,流程會重新跑 |
| 修補(fixup) | `/req-iterate --fixup` | **你** + AI | L2/L3 的事後補救網:對單一 `done` spec 做 patch-level 修補,只能填補既有 acceptance criteria 的漂移,micro-plan 上限 5 task |
| 漂移偵測 | `/req-audit` | AI | Read-only 掃描所有 `done` spec 的 spec↔code 漂移、`TODO(auto)` 殘留、`[autonomy: auto]` changelog 條目;`--iterate` 模式會把每條 drift 串到 `/req-iterate --fixup` |
| 切換自主程度 | `/req-autonomy` | **你** | 三級切換 `strict` / `balanced` / `auto`,預設 `strict` 全部要人。L2/L3 必須搭配 `/req-audit` + `/req-iterate --fixup` 當補救網(詳見 [docs/installation.md](docs/installation.md)) |
| Onboarding(選配) | `/req-onboard` | AI | 在既有 repo 安裝後跑一次,掃描 host code 產出 personas + feature inventory + project context,給後續 `/req-*` 當 baseline。三個深度 `shallow` / `medium` / `deep`,預設 `medium`。 |

---

## 本 repo 結構

這個 repo 是**框架本體**,不是需求專案。實際只有三個目錄:

| 資料夾 | 用途 |
|--------|------|
| `framework/` | 框架核心:`commands/`(14 個 `req-*` slash 指令)、`agents/`(`req-research`、`req-conflict-detector`、`req-onboarder` 三個 subagent)、`scripts/`(安裝/同步)、`templates/`(spec/intake/persona 範本 + `settings.json` permissions 模板)、`config/` |
| `examples/` | 參考範例:[`personas/`](examples/personas) 角色定義、[`quickstart/`](examples/quickstart) 完整走完六大階段的示範專案(**推薦首次接觸者先看**) |
| `docs/` | 框架自身文件,含 [installation.md](docs/installation.md)、[permissions.md](docs/permissions.md)(權限模板逐條說明)、[metrics.md](docs/metrics.md)、[speckit-comparison.md](docs/speckit-comparison.md) |

> 安裝後在你自己的需求專案裡才會出現的 `intake/`、`specs/`、`personas/`、`conflicts/`、`reviews/`、`src/`、`tests/` 等業務目錄,說明見 [docs/installation.md](docs/installation.md)。

---

## 快速開始

這個 repo 既是**框架本體**,也是**可初始化的需求專案範本**。依照你的場景挑一種安裝方式:

### 場景 A:全新需求專案(Init 模式)

```bash
git clone https://github.com/adamou0408/req /tmp/req-framework
mkdir my-req-project && cd my-req-project
bash /tmp/req-framework/framework/scripts/req-init.sh           # 預設 --mode=copy
git init && git add -A && git commit -m "chore: bootstrap req project"
```

`req-init.sh` 預設會把 framework 複製成 `./.req-framework/`,並自動建立 `intake/`、`specs/`、`.req.config.yml`、`.claude/commands/req-*.md`、`.claude/agents/req-*.md` 與 `.claude/settings.json`(若 host 已有則不覆蓋)。若想改用 git submodule 連動上游,改執行:

```bash
cd my-req-project && git init
bash /tmp/req-framework/framework/scripts/req-init.sh --mode=submodule --remote=https://github.com/adamou0408/req
```

完成後在 Claude Code 中執行 `/req-intake`,AI 會引導你提出第一個需求。

### 場景 B:導入既有 repo(Submodule 模式,零侵入)

```bash
cd /path/to/your-existing-repo
git submodule add https://github.com/adamou0408/req .req-framework
bash .req-framework/framework/scripts/req-add-submodule.sh
git add .req.config.yml .req .claude/commands/req-*.md .claude/agents/req-*.md .claude/settings.json
git commit -m "chore: install req framework"
```

只新增 `.req-framework/`(submodule)、`.req/`(業務資料)、12 個 `req-*.md` slash 指令、2 個 `req-*.md` subagent,以及 `.claude/settings.json`(若你已有則跳過),**完全不動**你的 `src/`、`tests/`、`README.md`、CI。

### 升級到新版

```bash
git submodule update --remote .req-framework
bash .req-framework/framework/scripts/req-sync-commands.sh
git add .req-framework .claude/commands/req-*.md .claude/agents/req-*.md .req.config.yml
git commit -m "chore: bump req framework"
```

完整安裝、升級、客製、解除安裝說明見 [docs/installation.md](docs/installation.md)。

