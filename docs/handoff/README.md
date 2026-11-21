# 交接紀錄索引

依時間排序（同一天的依內容互相引用的先後）。每份交接是「寫的那一天」的紀錄，不會回頭更新；過時的部分在該檔檔頭標明，內容不刪。要知道現況，先看最後面幾份與根目錄 [README.md](../../README.md)。

狀態：**有效**＝內容仍是現況；**部分過時**＝檔頭列出過時的段落，其餘仍有效；**歷史**＝只當背景，不當現況。

| 日期 | 檔案 | 寫了什麼 | 狀態 |
|---|---|---|---|
| 2026-11-19 | [probe-db-findings.md](probe-db-findings.md) | 架構探針：資料庫內驗通行金鑰與 ID token 的可行性與效能 | 歷史（探針已升格為 `db/`） |
| 2026-11-19 | [probe-frontdoor-findings.md](probe-frontdoor-findings.md) | 架構探針：通行金鑰的 Node 端對照組 | 歷史（對照組仍在 `e2e/reference/passkey`） |
| 2026-11-19 | [probe-path-findings.md](probe-path-findings.md) | 架構探針：申請到核准的路徑接通 | 歷史 |
| 2026-11-19 | [sim-mail.md](sim-mail.md) | `sim/mail`（Mailpit）、`sim/lib`、`sim/up.sh` 等 | 有效 |
| 2026-11-19 | [sim-directory.md](sim-directory.md) | `sim/ldap`（OpenLDAP）、`sim/idp`（Dex） | 有效（種子名單以 `docs/contract/seed-directory.md` 為準） |
| 2026-11-19 | [promote.md](promote.md) | 探針升格為正式目錄、七項修正、最小品質關卡 `tools/check.sh` | 部分過時；仍未做的工具與產生器仍是待辦 |
| 2026-11-20 | [sim-dc.md](sim-dc.md) | `sim/dc`：模擬的外部資料系統，把規則套用成真的資料庫權限 | 部分過時；用法以 `sim/dc/README.md` 為準 |
| 2026-11-20 | [flow-db.md](flow-db.md) | 資料授權完整簽核流程：資料庫這一半 | 部分過時 |
| 2026-11-20 | [flow-surface.md](flow-surface.md) | 資料授權完整簽核流程：後端、頁面、端對端這一半 | 部分過時 |
| 2026-11-20 | [delivery.md](delivery.md) | 核准後系統對系統的交付、威脅表、與契約不一致處 | 部分過時 |
| 2026-11-20 | [redteam-fixes.md](redteam-fixes.md) | 紅隊第一輪的修復 | 部分過時（數字） |
| 2026-11-20 | [redteam-fixes-2.md](redteam-fixes-2.md) | 紅隊第二輪的修復（D65–D71） | 部分過時（數字） |
| 2026-11-20 | [redteam-fixes-3.md](redteam-fixes-3.md) | 紅隊第三輪的修復（D65–D79） | 部分過時（數字） |
| 2026-11-20 | [leftovers-1.md](leftovers-1.md) | 第三輪留下的項目：代填確認、遺失裝置補救、QR、好用性、通知卡住 | 部分過時 |
| 2026-11-20 | [redteam-fixes-4.md](redteam-fixes-4.md) | 紅隊第四輪：設定分開載入、回應與對帳回報簽章、撤回封存（D81） | 部分過時（數字） |
| 2026-11-20 | [applicant-confirm.md](applicant-confirm.md) | 申請人確認驗證結果、逾期自動撤銷（D80–D82） | 部分過時（數字） |
| 2026-11-20 | [redteam-fixes-5.md](redteam-fixes-5.md) | 紅隊第五輪的修復（D84） | 部分過時（數字） |
| 2026-11-20 | [redteam-fixes-6.md](redteam-fixes-6.md) | D86 兩個小修：移除合併角色 `sgn_job`、停用通行金鑰的持有人例外 | 有效（數字過時） |
| 2026-11-20 | [redteam-fixes-7.md](redteam-fixes-7.md) | 紅隊第七輪的修復（D88）、破窗安裝儀式 | 有效（數字過時）；最後一輪紅隊修復 |
| 2026-11-21 | [proposal.md](proposal.md) | 給稽核、資安、MIS 的提案與實機示範頁 `docs/site/proposal.html` 怎麼做的 | 有效（頁面內的數字是當天截圖的結果） |
| 2026-11-21 | [closed-loop-1.md](closed-loop-1.md) | 閉環第一批：資料目錄版本綁定、能力宣告、使用紀錄批次摘要（D91–D92） | 有效；最近一次經複核（D95） |
| 2026-11-21 | [closed-loop-2.md](closed-loop-2.md) | 閉環第二批：測試區與正式區、測試報告（D93–D94） | 有效；乾淨狀態複核通過（D96：資料庫 320、對照 16、端對端 38） |
| 2026-11-21 | [closed-loop-3.md](closed-loop-3.md) | 閉環第三批：六個畫面問題、匯出需求調查（D96–D97） | 有效；尚未複核（§6 驗證結果還沒填） |
| 2026-11-21 | [feature-4-deadlines.md](feature-4-deadlines.md) | 功能第四批：關卡催辦與升級、到期前提醒、負責人離職的改指派與逾期撤銷、被授權者結束 | 有效；尚未複核、尚未經紅隊 |

## 想知道某件事，看哪裡

| 想知道 | 看 |
|---|---|
| 現在做到哪、怎麼跑 | 根目錄 [README.md](../../README.md) |
| 資料授權的交付、對帳、使用紀錄格式 | [02 §8.6–§8.8](../contract/02-pack-data-access.md) |
| 為什麼這樣決定 | [decision-log.md](../decision-log.md) |
| 已知缺口與還沒併入契約的增修 | [pending-amendments.md](../contract/pending-amendments.md)、最新一份 closed-loop 的「留給下一位」 |
| 紅隊的發現與可重跑的攻擊腳本 | `redteam/findings*.md`、`redteam/exploits/` |
