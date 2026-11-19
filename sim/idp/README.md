# sim/idp：模擬的 OIDC 身分提供者（Dex）

真的 OpenID Connect 身分提供者（[Dex](https://dexidp.io) v2.43.1），帳號、密碼驗證與群組都來自 `sim/ldap`。給 SSO port 的真實 adapter 與端對端測試的登入使用。只供開發與測試。

## 怎麼跑

```bash
sim/up.sh idp                 # 會先啟動相依的 ldap；也可在 ldap 啟動後執行 sim/idp/start.sh
sim/idp/health.sh             # discovery 的 issuer 正確且有簽章金鑰才回 0
sim/idp/login-check.sh p16    # 走完一次真正的登入，驗證 ID token 簽章並印出 claims
sim/idp/stop.sh
```

- 第一次啟動會建置 Dex（約一到兩分鐘），需要 Go、git、gcc，以及能連到 `github.com` 與 Go 模組代理。執行檔放在 `sim/.run/idp/bin/`。不用 `go install` 的原因寫在 `install.sh` 開頭。
- Dex 的設定檔每次啟動由 `start.sh` 產生到 `sim/.run/idp/config.yaml`；要改設定請改 `service.env` 或 `start.sh`。

## 給平台後端的 OIDC 設定值

唯一來源是 `service.env`（非機密）與 `test-credentials.env`（只供 sim 的測試用 secret）；下表是目前的值。

| 項目 | 值 |
|---|---|
| issuer | `http://127.0.0.1:5556/dex` |
| discovery | `http://127.0.0.1:5556/dex/.well-known/openid-configuration` |
| client id | `sgn-api` |
| client secret | `sim-idp-client-secret` |
| redirect URI（已登記） | `http://127.0.0.1:3000/auth/oidc/callback`、`http://localhost:3000/auth/oidc/callback` |
| scopes | `openid profile email groups federated:id` |
| 流程 | authorization code（可加 PKCE S256）；token 端點用 HTTP Basic 帶 client 帳密 |
| ID token 簽章 | RS256，公開金鑰在 `http://127.0.0.1:5556/dex/keys` |

ID token（與 userinfo）的欄位對應：

| 用途 | claim | 來源（LDAP） | 範例（p16） |
|---|---|---|---|
| 穩定識別（搭配 `iss`） | `sub` | 由 `uid` 與 connector 代號編碼而成，不會變 | `CgNwMTYSBGxkYXA` |
| 目錄帳號，用來和 LDAP 同步的人對起來 | `federated_claims.user_id`（需要 `federated:id`）；`preferred_username` 也是同一個值 | `uid` | `p16` |
| email | `email`（`email_verified` 固定為 true） | `mail` | `p16@sim.example` |
| 姓名 | `name` | `cn` | 謝明哲 |
| 群組 | `groups`（需要 `groups`） | 所屬 `groupOfNames` 的 `cn` | `["sys_admin","mis"]` |

沒有任何群組的人，token 裡不會有 `groups` 這個欄位。依範圍的角色會同時出現 `data_owner` 與 `data_owner:<範圍>`。

## 登入帳號

`docs/contract/seed-directory.md` 的每個人都能登入：帳號填代號（`p01`…`p26`）或 email（`p01@sim.example`），兩者得到同一個 `sub`；密碼是 `sim/ldap` 的人員測試密碼 `sim-user-pass`。

登入頁的欄位（給 Playwright 用）：帳號 `#login`、密碼 `#password`、送出 `#submit-login`、錯誤訊息 `#login-error`。

人事異動（`sim/ldap/change.sh`）在下一次登入就會反映：群組變動會出現在新的 token；離職停用的人登入會被拒絕（`login-check.sh` 回傳 2）。

## 已知限制

- 只有 HTTP，沒有 TLS；只綁 127.0.0.1。
- Dex 沒有多因子驗證，token 不帶 `amr`、`acr`；MFA 要另外模擬。
- Dex 不保留瀏覽器端的登入狀態，也沒有登出端點（`end_session_endpoint`）：每次導向授權端點都會再出現登入頁。
- ID token 效期 24 小時；簽章金鑰每 6 小時輪替（舊金鑰仍會公布到 token 過期），金鑰存在 `sim/.run/idp/dex.db`，重啟後沿用。
- Dex 的 LDAP connector 只能用單一屬性比對登入名稱，所以在 sim 的目錄加了 `simLoginName`；真實目錄不會有這個屬性。
- 登入頁是 Dex 內建的英文版面。
