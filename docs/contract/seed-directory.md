# 種子資料：公司、人員、組織、角色與受管系統

示範與驗收共用的資料。所有契約與流程包的驗收案例都使用這份名單，不另外發明公司、人物或系統。只載入開發與測試環境，不進正式環境。識別字與欄位意義依 [00-spine.md](00-spine.md)。

驗收案例的基準日期為 2026-11-10（星期二）。

## 公司

| 代碼 | 名稱 | 母公司 | 適用法域 | 時區 | 預設語言 | 行事曆 |
|---|---|---|---|---|---|---|
| `HQ` | 宏遠股份有限公司（母公司，上櫃） | — | TW | Asia/Taipei | zh-Hant | 台灣 |
| `JP` | 宏遠日本株式會社（子公司） | `HQ` | JP | Asia/Tokyo | en | 日本（2026-11-23 為非工作日，台灣為工作日） |

## 組織與人員

內部人員的身分來源是 `sim/` 的 LDAP（`managed_source` 代碼 `sim-ldap`，`external_id` 為「代號」）。員工編號在公司內唯一。p27、p28 是董事，不屬於任何主管線。

| 代號 | 姓名 | 公司 | 單位 | 職稱 | 直屬主管 | 員工編號 | email |
|---|---|---|---|---|---|---|---|
| p01 | 高志遠 | HQ | 總經理室 | 總經理 | — | E0001 | p01@sim.example |
| p02 | 方國華 | HQ | 業務處 | 業務副總 | 高志遠 | E0002 | p02@sim.example |
| p03 | 陳建宏 | HQ | 業務分析部 | 經理 | 方國華 | E0003 | p03@sim.example |
| p04 | 林怡君 | HQ | 業務分析部 | 分析師 | 陳建宏 | E0004 | p04@sim.example |
| p05 | 王志明 | HQ | 業務分析部 | 分析師 | 陳建宏 | E0005 | p05@sim.example |
| p06 | 蔡佩珊 | HQ | 業務分析部 | 分析師 | 陳建宏 | E0006 | p06@sim.example |
| p07 | 劉俊傑 | HQ | 通路業務組 | 組長 | 陳建宏 | E0007 | p07@sim.example |
| p08 | 何宗翰 | HQ | 通路業務組 | 專員 | 劉俊傑 | E0008 | p08@sim.example |
| p09 | 周文傑 | HQ | 業務管理部 | 經理 | 方國華 | E0009 | p09@sim.example |
| p10 | 蘇慧敏 | HQ | 財務處 | 財務長 | 高志遠 | E0010 | p10@sim.example |
| p11 | 張美玲 | HQ | 財務部 | 經理 | 蘇慧敏 | E0011 | p11@sim.example |
| p12 | 吳家豪 | HQ | 財務部 | 專員 | 張美玲 | E0012 | p12@sim.example |
| p13 | 鄭雅文 | HQ | 財務部 | 專員 | 張美玲 | E0013 | p13@sim.example |
| p14 | 邱冠廷 | HQ | 財務部 | 專員 | 張美玲 | E0014 | p14@sim.example |
| p15 | 楊淑惠 | HQ | 人力資源部 | 經理 | 高志遠 | E0015 | p15@sim.example |
| p16 | 謝明哲 | HQ | 資訊部 | 經理 | 高志遠 | E0016 | p16@sim.example |
| p17 | 李志偉 | HQ | 資訊部 | 工程師 | 謝明哲 | E0017 | p17@sim.example |
| p18 | 林冠宇 | HQ | 資訊部 | 工程師 | 謝明哲 | E0018 | p18@sim.example |
| p19 | 賴政達 | HQ | 資訊安全室 | 資安長 | 高志遠 | E0019 | p19@sim.example |
| p20 | 許文豪 | HQ | 資訊安全室 | 資安工程師 | 賴政達 | E0020 | p20@sim.example |
| p21 | 鍾國強 | HQ | 稽核室 | 主任 | 高志遠 | E0021 | p21@sim.example |
| p22 | 黃淑芬 | HQ | 稽核室 | 稽核員 | 鍾國強 | E0022 | p22@sim.example |
| p23 | 簡志豪 | HQ | 法務室 | 主任 | 高志遠 | E0023 | p23@sim.example |
| p24 | 葉佳蓉 | HQ | 法務室 | 法務專員 | 簡志豪 | E0024 | p24@sim.example |
| p25 | 洪美惠 | HQ | 總務部 | 主任 | 高志遠 | E0025 | p25@sim.example |
| p26 | 游志明 | HQ | 總務部 | 專員 | 洪美惠 | E0026 | p26@sim.example |
| p27 | 郭永昌 | HQ | 董事會 | 董事長 | — | E0027 | p27@sim.example |
| p28 | 白崇德 | HQ | 董事會 | 獨立董事（審計委員會召集人） | — | E0028 | p28@sim.example |
| p29 | 石明德 | HQ | 資訊部 | 系統工程師 | 謝明哲 | E0029 | p29@sim.example |
| p30 | 江佩玲 | HQ | 人力資源部 | 專員 | 楊淑惠 | E0030 | p30@sim.example |
| p31 | 佐藤健一 | JP | 日本總經理室 | 總經理 | — | E0031 | p31@sim.example |
| p32 | 田中美咲 | JP | 日本管理部 | 經理 | 佐藤健一 | E0032 | p32@sim.example |
| p33 | 鈴木大輔 | JP | 日本業務部 | 經理 | 佐藤健一 | E0033 | p33@sim.example |
| p34 | 高橋由美 | JP | 日本業務部 | 專員 | 鈴木大輔 | E0034 | p34@sim.example |
| p35 | 渡邊翔 | JP | 日本管理部 | 資訊專員 | 田中美咲 | E0035 | p35@sim.example |

- 雇用類型都是 `regular`；p31–p35 的時區為 Asia/Tokyo、語言為 en，其餘為 Asia/Taipei、zh-Hant。
- 各公司最高主管（高志遠、佐藤健一）沒有直屬主管：他們自己的申請與往上升級由路徑的 `top_resolver` 處理。

## 外部人員

外部人員走外部身分來源（代碼 `sim-external`），不在公司的 LDAP 裡；雇用類型為 `external`，一律用 passkey。

| 代號 | 姓名 | 所屬 | 在平台上的身分 | 保證人 | 委外合約 | 效期 | email |
|---|---|---|---|---|---|---|---|
| x01 | 羅文彬 | 廠商甲（人資系統供應商） | 外購人資系統的主要管理人 | 楊淑惠 | OC-2026-HR（2026-07-01 至 2027-06-30，內部負責人楊淑惠） | 2026-09-01 至 2027-02-28 | x01@vendor.example |
| x02 | 莊雅婷 | 會計師事務所乙 | 外部稽核 | 鍾國強 | OC-2026-AUD（2026-10-01 至 2027-04-30，內部負責人鍾國強） | 2026-11-01 至 2027-03-31 | x02@auditor.example |

## 跨公司職權

`appointment`：人在另一家公司有職權，但不是該公司的雇用。

| 人 | 公司 | 職務 |
|---|---|---|
| 高志遠 | JP | 董事 |
| 蘇慧敏 | JP | 監察人（財務督導） |

## 角色指派

「類型」是持有方式；「類別」對應 `role` 的類別（business、control、platform、governance）。單一持有人的「代理人」就是 `designated_deputy` 名單。依範圍的角色，範圍代碼見下一節。v1 的 `sys_admin` 已取消。

| 角色 | 代碼 | 類型 | 類別 | 持有人 |
|---|---|---|---|---|
| 技術維運 | `tech_ops` | 群組 | platform | 石明德 |
| 流程管理者 | `process_admin` | 依範圍 | platform | 資料授權：謝明哲；合約用印：洪美惠；人資系統：楊淑惠；母公司：周文傑；日本子公司：田中美咲 |
| 控制負責人 | `control_owner` | 依範圍 | control | 資安類：賴政達；個資類：葉佳蓉；其餘類別：簡志豪 |
| 稽核 | `auditor` | 群組 | platform | 鍾國強、黃淑芬 |
| 稽核主管 | `audit_head` | 單一持有人 | platform | 鍾國強 |
| 稽核治理人 | `audit_governor` | 單一持有人 | governance | 白崇德 |
| 金鑰保管人 | `key_custodian` | 群組 | platform | 蘇慧敏、簡志豪、賴政達 |
| 資安緊急停權 | `security_responder` | 群組 | control | 許文豪 |
| 董事長 | `board_chair` | 單一持有人 | governance | 郭永昌 |
| 母公司指定主管 | `parent_officer` | 單一持有人 | governance | 高志遠 |
| 資安長 | `ciso` | 單一持有人 | control | 賴政達（代理人：許文豪） |
| 法遵 | `compliance_officer` | 單一持有人 | control | 簡志豪 |
| 個資窗口 | `privacy_officer` | 單一持有人 | control | 葉佳蓉 |
| 法務主管 | `legal_head` | 單一持有人 | control | 簡志豪（代理人：葉佳蓉） |
| 人資的資料管理人 | `hr_data_steward` | 單一持有人 | control | 楊淑惠 |
| 財務長 | `cfo` | 單一持有人 | business | 蘇慧敏（代理人：張美玲） |
| MIS（資安合規檢查） | `mis` | 群組認領 | control | 謝明哲、李志偉、林冠宇 |
| 法務 | `legal` | 群組認領 | business | 簡志豪、葉佳蓉 |
| 印鑑管理人 | `seal_keeper` | 群組認領 | business | 洪美惠、游志明 |
| 資料擁有者 | `data_owner` | 依範圍 | control | 客戶主檔：周文傑；銷售訂單：張美玲；產品成本明細：張美玲；員工薪資：楊淑惠 |

補充：

- `top_resolver`：`HQ` 的路徑用 `board_chair`，`JP` 的路徑用 `parent_officer`。
- 稽核的範圍：鍾國強、黃淑芬為全集團（`HQ`、`JP`）全部流程類型；外部稽核莊雅婷（x02）只有 `HQ`、2026 年度的事件，到期日 2027-03-31，機密內容不可解密。
- 稽核室以跨公司服務指派服務 `JP`；`JP` 沒有自己的控制負責人、資安長與金鑰保管人，由 `HQ` 的持有人在集團層級擔任。
- 技術維運只有一位，且不持有其他平台管理角色。

## 範圍代碼

| 角色 | 表中的範圍 | `scope_ref` |
|---|---|---|
| `process_admin` | 資料授權、合約用印 | `process:data_access`、`process:seal` |
| `process_admin` | 人資系統 | `system:hr_saas` |
| `process_admin` | 母公司、日本子公司 | `company:HQ`、`company:JP` |
| `control_owner` | 資安類、個資類 | `class:security`、`class:privacy` |
| `control_owner` | 其餘類別 | `class:general`、`class:sod`、`class:evidence`、`class:authority`、`class:detection` |
| `data_owner` | 客戶主檔、銷售訂單、產品成本明細、員工薪資 | 由資料授權流程包定義（`data_access:bundle:<代碼>`） |

## 受管系統

系統管理人（`system_custodian`）與對帳執行人（`reconciler`）是各系統上的範圍指派，列在這裡，不列在上面的角色表。

| 代碼 | 名稱 | 公司 | 業務擁有單位 | 整合方式 | `authority` | 涵蓋狀態 | 技術維運可否查閱內容 | 主要管理人 | 備援管理人 | 對帳執行人 | 對帳間隔 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `dc` | 資料平台 DataCentric | HQ | 資訊部 | `api` | `platform` | `managed` | 可 | 李志偉 | 林冠宇 | 許文豪 | 1 天 |
| `hr_saas` | 外購人資系統（薪資、考績、健康檢查） | HQ | 人力資源部 | `file` | `platform` | `managed` | 否 | 羅文彬（x01，外部廠商） | 江佩玲 | 邱冠廷 | 30 天 |
| `erp` | ERP 財會系統（供應商主檔、付款） | HQ | 財務部 | `manual` | `platform` | `managed` | 可 | 吳家豪 | 鄭雅文 | 周文傑 | 90 天 |
| `cicd` | 部署管線 | HQ | 資訊部 | `api` | `platform` | `managed` | 可 | 林冠宇 | 李志偉 | 許文豪 | 1 天 |
| `jp_crm` | 日本客戶管理系統 | JP | 日本業務部 | `file` | `platform` | `scheduled`（2027-01-15） | 可 | 渡邊翔 | —（只有一位，列常設例外） | 高橋由美 | 30 天 |

- `hr_saas` 不歸資訊單位管：由人力資源部外購、廠商維運，資料不經過 `dc`，技術維運與 MIS 都不能查閱其申請內容；員工薪資這個資源屬於它。客戶主檔、銷售訂單、產品成本明細屬於 `dc`。
- 每個系統的對帳執行人都不是該系統的管理人，也不與管理人同一直屬主管或有上下級關係。
- 資料授權的資安合規檢查由 `mis` 群組認領，執行設定由該資源所屬系統的管理人負責；同一張單這兩件事必為不同的人。

## 被授權者

非人類主體（agent、服務帳號）一定有結束日。

| 類型 | 名稱 | 公司 | 負責人 | 結束日 | 成員或使用對象 |
|---|---|---|---|---|---|
| team | 業務分析部 | HQ | 陳建宏 | — | 依人資組織 |
| team | 通路業務組 | HQ | 劉俊傑 | — | 依人資組織 |
| team | 日本業務部 | JP | 鈴木大輔 | — | 依人資組織 |
| project | 北區客戶流失分析 | HQ | 林怡君 | 2027-06-30 | 林怡君、王志明 |
| project | 季度業績看板 | HQ | 蔡佩珊 | 2027-03-31 | 蔡佩珊、何宗翰 |
| agent | sales-report-bot | HQ | 林怡君 | 2027-12-31 | 使用對象：王志明、蔡佩珊 |
| agent | ap-recon-bot | HQ | 吳家豪 | 2027-12-31 | 使用對象：鄭雅文 |
| service_account | dc-etl-svc | HQ | 李志偉 | 2027-12-31 | — |

## 給 `sim/` 的說明

- 「組織與人員」「角色指派」兩節第一張表的既有欄名沒有改，`sim/ldap/seed-ldif.mjs` 可以照常解析；email 與員工編號和產生器原本推得的值相同。產生器之後應改為直接讀這兩欄與「公司」欄。
- 外部人員、受管系統、跨公司職權、被授權者不在 LDAP 裡，由各自的 `sim/` 服務或 `db/seed/` 載入。
