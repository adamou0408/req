# 稽核級簽核平台

通用的簽核平台，讓每一個決定都可問責、核准的內容不走樣、紀錄改不掉。各種申請以「流程包」加入，核心不綁定特定領域。

第一版包含兩個流程包：

- **資料授權**：L3、L4 資料的授權申請；核准結果輸出成規則，由 DataCentric（DC）套用。
- **合約用印**：示範用，用來證明核心不綁定領域。

## 目前狀態

開發中。`main` 會隨進度更新；尚未驗證的 commit 以 `wip:` 開頭。

| 項目 | 狀態 |
|---|---|
| 方向、工程規範、UI/UX 驗收標準、契約骨幹 | 已定稿 |
| 核心（身分、通行金鑰驗證、稽核鏈、路徑、職責分離） | 已實作，資料庫測試通過 |
| 資料授權流程包：申請 → 多關簽核 → 執行 → 驗證 | 已實作，端對端測試通過（模擬的手機瀏覽器，未用真機） |
| 模擬環境：LDAP、OIDC、SMTP | 可用 |
| 紅隊第一輪 | 找到 2 個高風險、1 個中風險，修復中（`redteam/findings.md`） |
| 模擬的外部資料系統（DC）、系統對系統交付 | 進行中 |
| 催辦升級、代理、續期、到期、對帳、複查、管理畫面、部署 | 未開始 |
| 合約用印等其餘流程包 | 只有契約，未實作 |

執行全部檢查：`tools/check.sh`。啟動整套系統：`tools/run-all.sh --keep`。

## 文件

- **[方向](docs/00-direction.md)：目標、策略、目前的賭注、修正的規則。最上層的依據**

- [產品定位](docs/platform-vision.md)：終極目標、要解決的問題、核心與流程包的分工
- [決策紀錄](docs/decision-log.md)：方向衝突時的判斷
- [工程規範](docs/engineering-standards.md)：單一真相來源、架構、抽象層、品質關卡
- [UI/UX 驗收標準](docs/ux-acceptance.md)
- [契約骨幹](docs/contract/00-spine.md)：命名、實體、狀態、流程包介面
- 流程包規則：[資料授權](docs/packs/data-access/rules.md)、[合約用印](docs/packs/seal/rules.md)
- [資料授權的待確認問題](docs/packs/data-access/open-questions.md)

