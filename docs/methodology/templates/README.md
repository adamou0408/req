# 文件範本

新專案直接複製這裡的檔案，把 `<...>` 換成實際內容。每個範本開頭的註解說明用途與填法，填完後刪除註解。步驟編號對應 `.claude/skills/product-from-zero/SKILL.md`。

| 範本 | 複製到 | 何時建立 |
|---|---|---|
| `CLAUDE.md` | `CLAUDE.md` | 步驟 1：定規範。規範進 repo 後，子代理啟動時才會讀到 |
| `platform-vision.md` | `docs/platform-vision.md` | 步驟 0 確認目標與優先順序後、步驟 1 寫成文件 |
| `engineering-standards.md` | `docs/engineering-standards.md` | 步驟 1 |
| `decision-log.md` | `docs/decision-log.md` | 步驟 1 建立；步驟 0 起每個方向衝突都記一筆，步驟 4 裁決後大量更新 |
| `ux-acceptance.md` | `docs/ux-acceptance.md` | 步驟 1 建立；步驟 9 驗收時使用 |
| `gitignore` | `.gitignore` | 步驟 1，專案一開始就設，避免執行期資料被提交 |
| `install-dev-tools.sh` | `tools/install-dev-tools.sh` | 步驟 1，與工程規範第 6 節的工具清單一致 |
| `control-matrix.md` | `docs/audit/control-matrix.md`（路徑可自訂） | 步驟 2 調查後起草；步驟 6 契約完成時核對，不能有空格 |
| `spine.md` | `docs/contract/00-spine.md` | 步驟 5：裁決完成後 |
| `pending-amendments.md` | `docs/contract/pending-amendments.md` | 步驟 5 骨幹定案時建立；步驟 6 修訂契約時逐項納入並刪除 |
