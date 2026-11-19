# 交接：sim-mail（sim/mail、sim/lib、up／down／status、docker-compose）

## 做了什麼

- `sim/mail`：真的 SMTP 伺服器 Mailpit v1.34.0（SMTP 與信箱 API／網頁介面，位址在 `service.env`）。
  - `install.sh` 從固定版本的 Go 模組原始碼連前端一起建置，執行檔放 `sim/.run/mail/bin/`。
  - `mailbox.sh`：`wait`（等待並取回寄給某人的最新一封信，可輸出整封信、內文或信裡的連結）、`list`、`clear`。
  - `selftest.sh`：用 SMTP 寄一封繁體中文（主旨、寄件人名稱、純文字與 HTML 內文）的信，再用 API 讀回逐項比對。
- `sim/lib/common.sh`：服務腳本共用的函式（載入 `service.env`、pid 與 log 位置、背景啟動與停止、等待埠）。`sim/ldap`、`sim/idp` 也用這一份。
- `sim/lib/orchestrate.sh` 與 `sim/up.sh`、`down.sh`、`status.sh`：自動找出 `sim/*/start.sh`，依各目錄的 `depends_on` 排序；不寫死服務名稱。
- `sim/README.md`：慣例、怎麼新增服務。埠對照表不手抄，以 `sim/status.sh` 的輸出為準。
- `sim/docker-compose.yml`、`sim/lib/container/`：在一個容器裡執行同一批腳本（非 root、主機網路、repo 唯讀掛載）。
- `.gitignore`：`sim/.run/`。

## 怎麼跑

```bash
sim/up.sh                 # 全部；sim/up.sh mail 只啟動 mail
sim/status.sh             # 狀態與位址（--strict：有不健康的就回 1）
sim/mail/selftest.sh
sim/mail/mailbox.sh wait --to p04@sim.example --subject 待簽核 --output links
sim/down.sh
```

## 實測過的事

- mail：啟動 → 健康檢查 → `selftest.sh` 通過 → 用平台的 nodemailer（帶與不帶帳密）寄信、`mailbox.sh` 取回內容與連結 → 停止 → 再啟動（信還在）→ 清空。信箱超過一頁（123 封）時仍找得到最舊的那封。
- 編排：用四個暫時的假服務（已刪除）驗證啟動順序、等待相依者健康、只啟動部分、反向停止、連同相依者停止、重複執行、循環相依、相依對象不存在、缺檔、健康檢查逾時、pid 檔指到無關行程時不誤殺、8025 被占用時拒絕啟動。
- 與 `sim/ldap`、`sim/idp` 一起：`sim/up.sh` 依 ldap → idp → mail 啟動，`sim/idp/login-check.sh p16` 通過，`sim/down.sh` 再 `sim/up.sh` 正常。
- `shellcheck -x`、`hadolint`、`trivy config sim/lib/container`、`docker compose config` 全部沒有訊息。

## 和任務說明不同的地方

- Mailpit 不是直接 `go install`：那樣的執行檔沒有網頁介面（Go 模組不含建置好的前端檔）。改用同一個固定版本的模組原始碼建置，因此多需要 npm，而且 Go 會自動下載 1.26 的工具鏈（Mailpit 的要求）。
- docker-compose 不是每個服務一個官方映像，而是一個容器執行 `sim/up.sh`。理由：另寫一份 slapd、Dex 的容器設定會和腳本裡的設定變成兩個來源。
- 多了 `sim/lib/orchestrate.sh`、`sim/lib/container/`、`sim/mail/install.sh`、`selftest.sh`。

## 已知限制與留給下一位

- **docker-compose 沒有實際啟動過**（這個環境沒有 Docker daemon）。只做過靜態檢查，以及在本機以非 root 使用者、另一個 `SIM_RUN_ROOT` 執行進入點腳本啟動 mail。主機網路在 Docker Desktop 需要 4.34 以上並手動開啟。
- `sim/lib/container/Dockerfile` 有一處 `hadolint ignore=DL3008`（apt 套件不固定版本，原因寫在該行上方）。工程規範要求例外放在工具的設定檔；等 `tools/check.sh` 與 hadolint 設定檔建立後請搬過去。
- mail 沒有 TLS、不比對 SMTP 帳密、所有信都收：寄信失敗的情境要靠停掉服務來測。Mailpit 預設只保留最新 500 封。
- `status.sh` 的「unhealthy」是指 `sim/.run/<服務>/*.pid` 的行程還在但 `health.sh` 沒過；不寫 pid 檔的服務只會顯示 healthy 或 stopped。
- 平台 mail port 的真實 adapter 尚未對著 `sim/mail` 跑合約測試；端對端測試也還沒有接上 `mailbox.sh`（`e2e/` 尚未建立）。
- spine 第 12 節的 DC 模擬器與示範使用方系統還沒做；照 `sim/README.md` 的步驟加目錄即可被 `up.sh` 納入。
- `sim/idp/install.sh` 的版本檢查用 `dex version | grep -q`，在 `pipefail` 下理論上可能誤判成未安裝而重建（本次沒有發生）；`sim/mail/install.sh` 改成先存輸出再比對，可參考。
