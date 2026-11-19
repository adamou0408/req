# 架構探針：最窄的完整路徑

申請人送出資料授權申請 → 主管用通行金鑰核准 → **資料庫自己驗證**這個核准真的來自主管本人 → 寫進雜湊鏈 → 稽核人員查得到，並在自己的瀏覽器裡驗證紀錄沒有被改過。

這是驗證「架構做不做得出來」的探針，不是功能實作。結論寫在：

- [`docs/db-findings.md`](docs/db-findings.md)：資料庫這一半（驗章、雜湊鏈、角色隔離）
- [`docs/path-findings.md`](docs/path-findings.md)：路徑接通（後端、頁面、端對端）

## 一支指令跑完全部

```bash
probe/run-all.sh          # 模擬環境 → 建庫與資料庫測試 → 後端型別檢查 → 錨定程式與後端 → 端對端測試
probe/run-all.sh --keep   # 同上，跑完後讓後端與錨定程式繼續跑，可以用瀏覽器開 http://localhost:3000
```

前提：PostgreSQL 16（`postgres://das_dev:das_dev@127.0.0.1:5432/postgres`，沒在跑時 `build.sh` 會 `pg_ctlcluster 16 main start`）、Node 22.18 以上（後端直接用 Node 執行 TypeScript）、`psql`、全域安裝的 Playwright（瀏覽器在 `/opt/pw-browsers`）、第一次啟動 sim 需要 Go（建置 Dex）。

`run-all.sh` 依序做：

1. `sim/up.sh ldap idp`：LDAP（3890）與 Dex（5556）
2. `probe/db/build.sh`：從頭建庫、從 LDAP 同步人員、跑 60 個資料庫測試；接著再跑一次 `build.sh --no-test`，讓端對端測試從乾淨的資料庫開始
3. `probe/api`：`npm ci`、`tsc --noEmit`
4. 錨定程式 `probe/db/tools/anchor.mjs --every 2`：每 2 秒把鏈頭與程式指紋寫到資料庫以外的錨點檔
5. 後端 `node probe/api/src/server.ts`（http://localhost:3000）
6. 端對端測試 `probe/e2e/tests/path.test.mjs`；量到的數字寫到 `probe/.run/e2e-results.json`

執行期的檔案（log、pid、量測結果）都在 `probe/.run/`。2026-11-19 從乾淨狀態（`sim/down.sh`、刪掉 `probe/.run/`）跑一次：全部通過，總時間 24.5 秒（Dex 已經建置過）。

## 試用帳號

密碼一律是 `sim-user-pass`（`sim/ldap/test-credentials.env`）。

| 帳號 | 人 | 在路徑裡的角色 |
|---|---|---|
| `p04` | 林怡君 | 申請人（主管是陳建宏） |
| `p03` | 陳建宏 | 簽核人；第一次核准前要登記通行金鑰（瀏覽器建立金鑰後，會再到 Dex 登入一次） |
| `p22` | 黃淑芬 | 稽核人員（LDAP 群組 `auditor`） |

手動試用時，瀏覽器要開 `http://localhost:3000`（不是 127.0.0.1）：WebAuthn 的 relying party 與 Dex 登記的 redirect URI 都是 `localhost`。

## 目錄

| 路徑 | 內容 |
|---|---|
| `db/` | 資料庫（前一段的產出）；本段新增 `sql/70_path.sql`（給畫面的查詢與稽核證據頁的入口），並把它加進 `build.sh` 的 migration 清單 |
| `api/src/` | 最薄的後端：`server.ts`（HTTP）、`routes.ts`（路由表：一個路徑就是一個資料庫 function）、`db.ts`（呼叫與錯誤目錄）、`oidc.ts`（SSO adapter）、`config.ts`（從 `probe.env` 與 sim 的設定檔讀） |
| `web/` | 頁面：純 HTML 與 ES module，不需要建置。`verify.js` 是稽核人員的瀏覽器自己做的驗證 |
| `e2e/tests/` | 端對端測試（Node 內建的 test runner，搭配全域的 Playwright） |
| `api/src/frontdoor/`、`e2e/frontdoor/`、`docs/frontdoor-findings.md` | 另一位代理的比較方案（後端自己驗 WebAuthn），**不在**這支指令的範圍 |
