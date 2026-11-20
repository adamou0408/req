# sim/ldap：模擬的人員目錄（OpenLDAP）

真的 OpenLDAP 伺服器，載入 `docs/contract/seed-directory.md` 的人員、單位與角色。給「人員與組織」port 的真實 adapter、`sim/idp` 的登入，以及人事異動相關的測試使用。只供開發與測試。

## 怎麼跑

```bash
sim/up.sh ldap          # 或 sim/ldap/start.sh；已在跑就不重啟
sim/ldap/health.sh      # 用唯讀帳號查得到種子文件裡的每個人（目前 26 人）才回 0
sim/ldap/stop.sh        # 停止；資料保留
sim/ldap/reset.sh       # 清除資料並重新載入種子（做過異動後回到原狀）
```

- 第一次啟動會用 apt 安裝 `slapd` 與 `ldap-utils`（需要 root）。只用套件的執行檔；設定與資料都在 `sim/.run/ldap/`，不使用也不修改 `/etc/ldap` 的系統實例。在有 systemd 的機器上，apt 會順便啟動系統的 slapd（埠 389），和這裡無關，可自行停用。
- 還需要 Node（產生種子 LDIF）。
- 種子資料由 `seed-ldif.mjs` 從種子文件的表格產生，不手抄名單；改了種子文件後執行 `reset.sh` 即可。

## 怎麼連

位址與 DN 的唯一來源是 `service.env`。密碼在第一次啟動時隨機產生，唯一來源是 `sim/.run/ldap/secrets.env`（目錄 0700、檔案 0600，只有 root 讀得到；裁決 D84 (1)：沒有可用的已知密碼）。第五輪之前 repo 裡的固定密碼已經不能用；改了密碼檔或刪掉它，下一次 `start.sh` 會重新產生並重新載入種子。

| 項目 | 值 |
|---|---|
| 位址 | `ldap://127.0.0.1:3890`（明文，沒有 TLS） |
| base DN | `dc=sim,dc=example` |
| 管理者（腳本用，可寫） | `cn=admin,dc=sim,dc=example`／`SIM_LDAP_ADMIN_PASSWORD` |
| 唯讀服務帳號（adapter 與 IdP 用） | `cn=reader,ou=services,dc=sim,dc=example`／`SIM_LDAP_READER_PASSWORD` |
| 人員 | `uid=<代號>,ou=people,dc=sim,dc=example`，例如 `uid=p04,...`／密碼一律 `SIM_LDAP_USER_PASSWORD`（模擬「每個人知道自己的密碼」；只有 root 的測試工具讀得到） |

匿名連線查不到任何資料；人員只讀得到自己。

```bash
source sim/.run/ldap/secrets.env   # 以 root
ldapsearch -x -LLL -H ldap://127.0.0.1:3890 \
  -D cn=reader,ou=services,dc=sim,dc=example -w "$SIM_LDAP_READER_PASSWORD" \
  -b ou=people,dc=sim,dc=example '(uid=p04)' '*' memberOf
```

## 目錄內容

| 位置 | 物件類別 | 內容 |
|---|---|---|
| `ou=people` | `inetOrgPerson` | 一人一筆：`uid`（代號）、`cn`／`displayName`（姓名）、`mail`、`title`（職稱）、`employeeNumber`、`employeeType`（`active`／`terminated`）、`ou`（單位名稱）、`manager`（主管的 DN；總經理沒有）、`memberOf`（所屬群組，自動維護） |
| `ou=org` | `organizationalUnit` | 單位樹，上下層用 DN 的巢狀表示，例如 `ou=通路業務組,ou=業務分析部,ou=業務處,ou=總經理室,ou=org,...` |
| `ou=groups` | `groupOfNames` | 角色群組：`cn`＝角色代碼、`description`＝角色名稱、`businessCategory`＝種子文件的類型、`member`＝持有人 |

角色的表示方式：

- 群組與群組認領（`sys_admin`、`mis`、`auditor`、`legal`、`seal_keeper`）：一個群組，成員就是持有人。
- 單一持有人（`ciso`、`cfo`）：群組只有一位成員；代理人放在 `<代碼>_deputy`（`businessCategory`＝代理人，`seeAlso` 指回原角色）。
- 依範圍（`data_owner`）：`cn=data_owner` 含所有範圍的持有人；每個範圍另有 `cn=data_owner:<範圍>`（`ou`＝範圍名稱，`seeAlso` 指回 `data_owner`）。

種子文件沒有列出、由產生器依固定規則推得的欄位：

| 欄位 | 規則 |
|---|---|
| `mail` | `<代號>@sim.example` |
| `employeeNumber` | `E` 加四位數，例如 p04 → `E0004`（刻意與 `uid` 不同格式，避免程式把兩者混用） |
| 單位的上下層 | 單位裡向外單位主管報告的人，其主管所在的單位就是上層單位 |
| `simLoginName` | `uid` 與 `mail` 各一筆，只給 `sim/idp` 比對登入名稱用（見 `sim.schema`） |

## 模擬人事異動

```bash
sim/ldap/change.sh transfer p04 通路業務組 p07    # 調職：改單位與主管
sim/ldap/change.sh set-manager p05 p07            # 換主管（none＝沒有主管）
sim/ldap/change.sh offboard p08                   # 離職：停用帳號，無法再登入
sim/ldap/change.sh group-add mis p20              # 加入群組
sim/ldap/change.sh group-remove mis p18           # 移出群組
sim/ldap/change.sh group-set ciso p20             # 把成員換成指定的人（單一持有人換人）
sim/ldap/reset.sh                                 # 回到種子狀態
```

- 離職是停用而不是刪除：`employeeType` 改為 `terminated`，並以密碼政策鎖定帳號（`pwdAccountLockedTime`，要明確指定才查得到），之後連線驗證會被伺服器拒絕。群組成員資格不會自動移除，用來重現「人走了、權限還在」。
- `groupOfNames` 至少要有一位成員，移除最後一位會被伺服器拒絕；換人請用 `group-set`。

## 已知限制

- 沒有 TLS、沒有複寫，也不是 Active Directory（沒有 `sAMAccountName`、巢狀群組展開等 AD 特有行為）。
- 被授權者（專案、agent）不在目錄裡；它們是平台自己的資料。
- 沒有「新進人員」的異動指令。
