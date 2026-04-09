# Quickstart — 5 分鐘看完 req 框架實際產出

這是一個**已完整跑過六大階段**的示範專案，feature 是「url-shortener 的自訂短網址」。目的是讓新接觸 req 框架的人，**不用學 CONSTITUTION 7 原則、不用看 AGENTS 12 節、不用跑完安裝流程**，就能直接看到各階段會產出什麼。

> 這些檔案是預先生成好的 artifact snapshot；**不需要跑指令**就可以瀏覽。要實際體驗指令，見下方「想進一步試試」一節。

---

## 30 秒導覽

依照 req 框架的流程，對應產出檔案為：

| 階段 | 指令 | 本範例產出 |
|------|------|-----------|
| 1. 提需求 | `/req-intake` | [`data/intake/raw/2026-04-08-add-custom-slug.md`](data/intake/raw/2026-04-08-add-custom-slug.md) |
| 2. 調研去重 | `/req-research` | [`data/specs/001-custom-slug/research.md`](data/specs/001-custom-slug/research.md) |
| 3. 轉譯 | `/req-translate` | [`data/specs/001-custom-slug/spec.md`](data/specs/001-custom-slug/spec.md) |
| 4. 衝突偵測 | `/req-detect-conflicts` | [`data/conflicts/CONFLICT-001-rate-limit.md`](data/conflicts/CONFLICT-001-rate-limit.md) |
| 5. 裁決衝突 | `/req-resolve-conflict` | 同上檔案（status: `resolved`） |
| 6. 審核 | `/req-review` | [`data/reviews/REVIEW-2026-04-08-001-custom-slug.md`](data/reviews/REVIEW-2026-04-08-001-custom-slug.md) |
| 7. 技術計畫 | `/req-plan` | [`data/specs/001-custom-slug/plan.md`](data/specs/001-custom-slug/plan.md) + [`tasks.md`](data/specs/001-custom-slug/tasks.md) + [`contracts.md`](data/specs/001-custom-slug/contracts.md) |

框架產出的程式碼 (`src/`、`tests/`) 沒放進這個範例 — 語言/框架選擇會造成維護負擔。若想看 `/req-implement` 的輸出，照下方說明自行對此目錄執行。

---

## 推薦閱讀順序（5 分鐘）

1. **[`data/intake/raw/2026-04-08-add-custom-slug.md`](data/intake/raw/2026-04-08-add-custom-slug.md)** — 最原始的需求文字，刻意寫得模糊、有矛盾，模擬真實情境。
2. **[`data/specs/001-custom-slug/research.md`](data/specs/001-custom-slug/research.md)** — AI 調研結果：與現有 spec 無重複，但高度依賴資料庫 schema 變更，feasibility 為 Yellow。
3. **[`data/specs/001-custom-slug/spec.md`](data/specs/001-custom-slug/spec.md)** — 整理後的結構化規格，含兩個角色（end-user、admin）的 User Story。
4. **[`data/conflicts/CONFLICT-001-rate-limit.md`](data/conflicts/CONFLICT-001-rate-limit.md)** — 偵測到 end-user 與 admin 在速率限制上的衝突，列出三個解決方向。
5. **[`data/reviews/REVIEW-2026-04-08-001-custom-slug.md`](data/reviews/REVIEW-2026-04-08-001-custom-slug.md)** — 人類審核的 checklist 輸出（approved）。
6. **[`data/specs/001-custom-slug/plan.md`](data/specs/001-custom-slug/plan.md)** — 技術計畫，含完整的**部署影響六大項**（健康檢查、Schema、設定、資源、持久性、觀測性）。
7. **[`data/specs/001-custom-slug/tasks.md`](data/specs/001-custom-slug/tasks.md)** — 計畫拆解成可執行的 task，標記 `[P-group-X]` 與 `[depends: N]`。
8. **[`data/specs/001-custom-slug/contracts.md`](data/specs/001-custom-slug/contracts.md)** — API 合約，含新增的速率限制與版本策略段落。

讀完這 8 個檔案，你會理解：

- req 框架的每個階段具體產出什麼
- 規格如何從模糊需求 → 偵測衝突 → 被人類裁決 → 進入技術計畫
- 部署影響評估六大項長什麼樣
- 為什麼「需求提供者零門檻」是可能的

---

## 想進一步試試？

把這個 quickstart 當作一個 host repo，實際執行 req 指令：

```bash
# 1. 複製 quickstart 到某個臨時目錄
cp -r examples/quickstart /tmp/req-quickstart
cd /tmp/req-quickstart

# 2. 安裝 req framework 到這個目錄（init 模式）
git clone https://github.com/adamou0408/req /tmp/req-framework
bash /tmp/req-framework/framework/scripts/req-init.sh

# 3. git init（req-init.sh 假設 host 是 git repo）
git init && git add -A && git commit -m "bootstrap quickstart"

# 4. 在 Claude Code 裡跑這些指令試試
#    /req-review data/specs/001-custom-slug     # 對既有 spec 再做一次審核
#    /req-plan data/specs/001-custom-slug       # 對既有 spec 重新產 plan
#    /req-implement data/specs/001-custom-slug  # 需要先把 spec 狀態改為 in-progress
```

`.req.config.yml` 已預先配置 `data_root: data`，這樣 `/req-*` 指令會讀到上面的檔案。

---

## 這個範例刻意包含什麼

- **一個真實的衝突**（end-user 想要高速率建立 slug，admin 想要嚴格限制避免濫用）— 展示 `/req-detect-conflicts` 和 `/req-resolve-conflict` 的價值。
- **一個 Yellow feasibility**（需 schema 變更）— 不是最簡單的 Green 範例，刻意模擬真實需求的摩擦。
- **完整的部署影響評估六大項** — 展示 req 如何把「部署問題」提前到設計期。
- **新角色衍生**（`admin.md` 和 `end-user.md`）— 展示跨角色 User Story 的真實樣貌。

---

## 這個範例刻意**不**包含

- 實際的 `src/` 與 `tests/` — 避免捲入語言選擇（Node? Python? Go?）與維護成本。
- `docs/project-context.md` 與 `existing-features.md`（`/req-onboard` 產出）— 這是 brownfield 場景，quickstart 是 greenfield。
- `feedback.md`（部署後階段）— 部署不在 quickstart 範疇。

---

## 維護注意

這個 quickstart 的檔案結構必須和 `framework/templates/spec/*` 保持同步。若你修改了 template 但忘了同步這裡，`/req-audit` 或 CI 會報 drift。修改 template 時記得檢查本目錄的對應檔案。
