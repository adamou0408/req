# 稽核級簽核平台

通用的簽核平台，讓每一個決定都可問責、核准的內容不走樣、紀錄改不掉。各種申請以「流程包」加入，核心不綁定特定領域。

第一版包含兩個流程包：

- **資料授權**：L3、L4 資料的授權申請；核准結果輸出成規則，由 DataCentric（DC）套用。
- **合約用印**：示範用，用來證明核心不綁定領域。

## 目前狀態

開發中。`main` 會隨進度更新；尚未驗證的 commit 以 `wip:` 開頭。

| 項目 | 狀態 |
|---|---|
| 產品定位、契約骨幹、工程規範、UI/UX 驗收標準 | 已定稿 |
| 核心、流程包、畫面、對外整合介面的詳細契約 | 撰寫中 |
| 法規、市場、痛點、標準的調查 | 進行中 |
| 後端與前端骨架、資料庫工具、部署設定 | 進行中，未驗證 |
| 模擬環境（LDAP、OIDC、SMTP） | 進行中，未驗證 |
| 資料庫、後端、前端的實作 | 未開始 |

## 文件

- [產品定位](docs/platform-vision.md)：終極目標、要解決的問題、核心與流程包的分工
- [決策紀錄](docs/decision-log.md)：方向衝突時的判斷
- [工程規範](docs/engineering-standards.md)：單一真相來源、架構、抽象層、品質關卡
- [UI/UX 驗收標準](docs/ux-acceptance.md)
- [契約骨幹](docs/contract/00-spine.md)：命名、實體、狀態、流程包介面
- 流程包規則：[資料授權](docs/packs/data-access/rules.md)、[合約用印](docs/packs/seal/rules.md)
- [資料授權的待確認問題](docs/packs/data-access/open-questions.md)

