# sim/mail：模擬的郵件伺服器（Mailpit）

真的 SMTP 伺服器（[Mailpit](https://mailpit.axllent.org)，版本寫在 `service.env`），收下所有寄進來的信但不往外送，並提供 HTTP API 與網頁介面讀信。給 mail port 的真實 adapter 與端對端測試使用：平台寄出的通知信真的走 SMTP，測試再從信箱取出信裡的連結。只供開發與測試。

## 怎麼跑

```bash
sim/up.sh mail                # 或 sim/mail/start.sh
sim/mail/health.sh            # HTTP 的 readyz 通過且 SMTP 回應 220 才回 0
sim/mail/selftest.sh          # 用 SMTP 寄一封繁體中文的信，再用 API 讀回比對
sim/mail/stop.sh
```

- 第一次啟動會建置 Mailpit（約一到兩分鐘），需要 Go、Node 與 npm，以及能連到 Go 模組代理與 npm registry。執行檔放在 `sim/.run/mail/bin/`。
- 不直接 `go install` 的原因：Go 模組不含建置好的前端檔，`go install` 出來的執行檔 SMTP 與 API 正常，但網頁介面是空白頁；`install.sh` 改用模組內附的原始碼連前端一起建置。
- 位址寫在 `service.env`（唯一來源），`sim/status.sh mail` 會列出。下面的範例先載入它：

```bash
set -a; source sim/mail/service.env; set +a
```

## 怎麼連

| 用途 | 位址 |
|---|---|
| SMTP | `smtp://${SIM_MAIL_SMTP_HOST}:${SIM_MAIL_SMTP_PORT}` |
| 網頁介面（看信） | `http://${SIM_MAIL_HTTP_HOST}:${SIM_MAIL_HTTP_PORT}/` |
| HTTP API | `http://${SIM_MAIL_HTTP_HOST}:${SIM_MAIL_HTTP_PORT}/api/v1/`（說明文件在同一個位址的 `/api/v1/`） |

平台後端的設定（變數定義在 `api/src/config.ts`）：

```bash
MAIL_MODE=smtp
SMTP_URL="smtp://${SIM_MAIL_SMTP_HOST}:${SIM_MAIL_SMTP_PORT}"
MAIL_FROM="no-reply@sim.example"
```

## 測試帳號

不需要帳號。SMTP 不帶帳密可以寄；帶了也可以，任何帳號與密碼都會被接受（例如 `sim-mailer`／`sim-mail-pass`，只是讓 adapter 的驗證路徑測得到，伺服器不比對）。任何收件人與網域都收；人員的 email 是 `sim/ldap` 種子資料的 `<代號>@sim.example`。網頁介面與 API 沒有驗證。

## 測試輔助：`mailbox.sh`

```bash
# 等待並取回寄給某人的最新一封信（依收件人與主旨關鍵字），預設最多等 15 秒，逾時回傳 2
sim/mail/mailbox.sh wait --to p04@sim.example --subject 待簽核                 # 整封信的 JSON
sim/mail/mailbox.sh wait --to p04@sim.example --subject 待簽核 --output links  # 信裡的連結，一行一個
sim/mail/mailbox.sh wait --to p04@sim.example --subject 催辦 --output text --consume

sim/mail/mailbox.sh list --to p04@sim.example   # 時間、收件人、主旨（新的在前）
sim/mail/mailbox.sh clear                       # 清空信箱
```

- `--to` 是完全相符（不分大小寫），收件人、副本、密件副本都算；`--subject` 是「包含」。
- `--output`：`json`（預設）、`text`、`html`、`links`、`id`。`links` 先列 HTML 的 `href`，再列純文字內文的網址，重複的只列一次；同一個網址在兩種內文的寫法不同時（例如中文有沒有做百分比編碼）會各出現一次，取第一個即可。
- 同一個主旨會寄很多次時（例如催辦），「最新的一封」可能是上一次留下的。兩種做法：每個測試開始前 `clear`；或每次取信加 `--consume`（取回後刪除），下一次 `wait` 就只會等到新的信。
- 端對端測試的用法：從測試程式執行這支腳本並讀標準輸出；要直接呼叫 API 的話，`GET /api/v1/messages` 列信、`GET /api/v1/message/<ID>` 取整封信。

## 資料

收到的信存在 `sim/.run/mail/mailpit.db`，重啟後還在；最多保留最新的 500 封（Mailpit 的預設），更舊的自動刪除。log 在 `sim/.run/mail/mail.log`。

## 已知限制

- 只有明文的 SMTP 與 HTTP，沒有 TLS；只綁 127.0.0.1。正式環境的 `smtps://` 與憑證驗證在這裡測不到。
- 所有信都收下、都不往外送：收件人不存在、信箱已滿、退信這類情況不會發生。要測寄信失敗，可以停掉服務（連線被拒），或用 Mailpit 的 Chaos 功能（目前沒有開啟）。
- SMTP 帳密不比對，測不到「帳密錯誤」。
