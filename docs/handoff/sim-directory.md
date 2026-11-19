# 交接：sim-directory（sim/ldap、sim/idp）

## 做了什麼

- `sim/ldap`：真的 OpenLDAP（slapd 2.6，apt 安裝），自有設定與資料目錄 `sim/.run/ldap/`，監聽 `ldap://127.0.0.1:3890`，base DN `dc=sim,dc=example`。
  - 種子資料由 `seed-ldif.mjs` 從 `docs/contract/seed-directory.md` 的表格產生（26 人、13 個單位、14 個群組），沒有手抄名單。
  - `change.sh`：調職、換主管、離職停用、群組加入／移出／換人；`reset.sh` 回到種子狀態。
  - 啟用 `memberof`（人員的 `memberOf` 自動維護）與 `ppolicy`（離職以鎖定帳號表示，伺服器真的拒絕驗證）。
- `sim/idp`：真的 OIDC 身分提供者 Dex v2.43.1，LDAP connector 接 `sim/ldap`，issuer `http://127.0.0.1:5556/dex`，預先登記 client `sgn-api`。
  - `login-check.sh`：以 authorization code flow（含 PKCE）走完登入，驗證 RS256 簽章、`iss`、`aud`、`exp`、`nonce`、`at_hash`，印出 claims。
- 兩個服務都照 `sim/lib/common.sh` 的慣例（`start.sh`、`stop.sh`、`health.sh`、`service.env`、pid 與 log 在 `sim/.run/<名稱>/`）；`sim/idp/depends_on` 宣告相依 `ldap`。

## 怎麼跑

```bash
sim/up.sh idp                     # 依序啟動 ldap、idp
sim/ldap/health.sh && sim/idp/health.sh
sim/idp/login-check.sh p16        # 也可用 p16@sim.example
sim/ldap/change.sh offboard p08   # 之後 p08 登入會被拒絕
sim/ldap/reset.sh
sim/down.sh ldap                  # 停 idp 與 ldap
```

連線資訊、測試帳號、給平台後端的 OIDC 設定值與 claims 對應，見 `sim/ldap/README.md` 與 `sim/idp/README.md`。

## 和任務說明不同的地方

- Dex 不能用 `go install ...@版本`：它的 `go.mod` 有 `replace` 指令，Go 會拒絕。改為取回固定標籤的原始碼（並比對 commit）再 `go build`，所以第一次啟動要能連 `github.com`。
- 測試密碼除了寫在 README，也放在各服務的 `test-credentials.env`，因為腳本與 Dex 設定要讀；README 註明以該檔為準。
- 為了讓 uid 與 email 都能登入，目錄多了一個 sim 專用屬性 `simLoginName`（Dex 只能用單一屬性比對登入名稱）。

## 需要契約確認的事

`docs/contract/seed-directory.md` 沒有 email、員工編號與組織樹，目前由產生器依規則推得（規則寫在 `sim/ldap/README.md`）：email＝`<代號>@sim.example`、員工編號＝`E00NN`、單位上下層由主管關係推出（例如 通路業務組 → 業務分析部 → 業務處 → 總經理室）。如果契約要明訂，請補進種子文件，產生器再改成讀表。

## 留給下一位

- 平台的「人員與組織」與 SSO 真實 adapter 尚未對著這兩個服務跑合約測試（不在本次範圍）。
- 建議對應：`person_identity` 以 `iss`＋`sub` 記 OIDC 身分，以 `federated_claims.user_id`（＝LDAP `uid`）和目錄同步的人對起來。
- 離職停用後群組成員資格不會自動移除（刻意保留，用來測「人走了、權限還在」）。
- 已知限制：沒有 TLS；Dex 沒有 MFA、登出端點與瀏覽器端登入狀態；目錄不是 Active Directory；沒有新進人員的異動指令；被授權者（專案、agent）不在目錄裡。
- `shellcheck` 要加 `-x`（腳本以 `source` 載入 `sim/lib/common.sh`）。
