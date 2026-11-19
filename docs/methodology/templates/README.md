# 文件範本

新專案複製這裡的檔案，把 `<...>` 換成實際內容。每個範本開頭的註解說明用途與填法，填完後刪除註解。步驟編號與完成條件以 `.claude/skills/product-from-zero/SKILL.md` 為準。

流程順序：釐清(0) → 定規範(1) → 調查(2) → 骨幹初稿(3) → 架構探針(4) → 情境檢查(5) → 裁決(6) → 骨幹定稿(7) → 契約(8) → 擴展(9) → 驗收(10)。

| 範本 | 複製到 | 建立於 | 小專案 |
|---|---|---|---|
| `platform-vision.md` | `docs/platform-vision.md` | 步驟 0 | 照做 |
| `decision-log.md` | `docs/decision-log.md` | 步驟 0（記衝突題），之後持續追加 | 照做 |
| `CLAUDE.md` | `CLAUDE.md` | 步驟 1 | 照做 |
| `engineering-standards.md` | `docs/engineering-standards.md` | 步驟 1 | 只留用得到的節 |
| `ux-acceptance.md` | `docs/ux-acceptance.md` | 步驟 1；步驟 10 使用 | 照做 |
| `gitignore` | `.gitignore` | 步驟 1 | 照做 |
| `pending-amendments.md` | `docs/pending-amendments.md` | 步驟 1（空白），用到上線後 | 照做 |
| `install-dev-tools.sh` | `tools/install-dev-tools.sh` | 步驟 1 | 最小可用版 |
| `check.sh` | `tools/check.sh` | 步驟 1 | 只開格式、lint、測試 |
| `control-matrix.md` | `docs/control-matrix.md` | 步驟 2 建立；各欄填寫時機見範本 | 併入設計文件 |
| `spine.md` | `docs/contract/00-spine.md` | 步驟 3 初稿、步驟 7 定稿 | 改名 `docs/design.md` |
| `handoff.md` | `docs/handoff/<工作塊>.md` | 步驟 3（`probe.md`）；之後每個工作塊 | 照做 |
| `rulings.md` | `docs/rulings.md` | 步驟 6 | 併入設計文件 |
| `tech-debt.md` | `docs/tech-debt.md` | 第一筆技術債出現時 | 照做 |
| `lessons-log.md` | 不複製：追加到 `docs/methodology/lessons-log.md` | 步驟 0 起，訊號發生當下 | 照做 |

小專案的設計文件 `docs/design.md`：以 `spine.md` 為底，加一節「裁決」（`rulings.md` 的表）與一節「目標對照」（`control-matrix.md` 的表），契約內容也寫在裡面。
