# sim：模擬環境

整合測試與端對端測試用的對接環境：不是假的替身，而是以真實協定運作的服務（LDAP、OIDC、SMTP……）。範圍定義在 `docs/contract/00-spine.md` 第 12 節。只供開發與測試，正式環境不包含這個目錄；裡面出現的密碼都是只在這裡有效的測試值。

## 怎麼跑

```bash
sim/up.sh                # 依相依順序啟動全部服務，逐一等到健康檢查通過
sim/up.sh idp mail       # 只啟動指定的服務（連同它們相依的服務）
sim/status.sh            # 每個服務的狀態與位址；加 --strict 時，有服務不健康就回傳 1
sim/down.sh              # 依反向順序停止全部
sim/down.sh ldap         # 停止指定的服務（連同相依於它的服務）
```

- 需要 bash 4 以上、curl、jq，以及各服務 README 列出的工具。第一次啟動會建置或安裝各服務的程式，之後就很快。
- 每個服務等待健康檢查的時間預設 60 秒，可用環境變數 `SIM_HEALTH_TIMEOUT` 調整。
- 各服務的用途、連線方式與測試帳號，見 `sim/<服務>/README.md`。

## 埠對照表

以 `sim/status.sh` 的輸出為準。它直接從各服務的 `service.env` 彙整，這裡不另外抄一份；要改埠就改該服務的 `service.env`。所有服務只綁 127.0.0.1。

## 慣例

`sim/` 下每個含 `start.sh` 的目錄就是一個服務，目錄名就是服務名稱（小寫英數、`-`、`_`）。`up.sh`、`down.sh`、`status.sh` 不寫死任何服務名稱。

| 檔案 | 規定 |
|---|---|
| `start.sh` | 啟動並寫 pid 檔；已經在跑就直接回 0，不重啟。以一般行程在背景執行，不使用 systemd |
| `stop.sh` | 乾淨停止；沒有在跑也回 0 |
| `health.sh` | 健康回 0。要真的用協定問過服務，不只看行程在不在 |
| `service.env` | 這個服務的主機、埠、版本等非機密設定，`KEY=VALUE` 格式。埠用 `SIM_<服務>_PORT` 或 `SIM_<服務>_<用途>_PORT`，配同名的 `_HOST`，`status.sh` 才列得出來 |
| `depends_on` | 可省略。一行一個要先啟動的服務名稱，`#` 之後是註解 |
| `README.md` | 用途、怎麼連、測試帳號、已知限制 |

- 執行期資料（資料庫檔、pid、log、建置出來的執行檔）一律放 `sim/.run/<服務>/`，已列入 `.gitignore`。
- 腳本用 bash、`set -euo pipefail`，並通過 `shellcheck -x`。
- 共用函式在 `sim/lib/common.sh`：`sim_load_env`、`sim_service_dir`、`sim_run_dir`、`sim_pid_file`、`sim_log_file`、`sim_start_daemon`、`sim_stop_daemon`、`sim_pid_alive`、`sim_wait_port`、`sim_require_port_free`、`sim_require_cmd`、`sim_log`、`sim_die`。用法寫在各函式上方的註解。

## 新增一個模擬服務

1. 建立 `sim/<名稱>/`，寫 `service.env`（挑一個沒人用的埠；先看 `sim/status.sh`）。
2. 寫三支腳本。最小的樣子：

   ```bash
   #!/usr/bin/env bash
   # start.sh
   set -euo pipefail
   # shellcheck source=SCRIPTDIR/../lib/common.sh
   source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

   if sim_pid_alive demo; then exit 0; fi
   sim_load_env demo
   sim_require_port_free "$SIM_DEMO_HOST" "$SIM_DEMO_PORT"
   sim_start_daemon demo demo node "$(sim_service_dir demo)/server.mjs"
   sim_wait_port "$SIM_DEMO_HOST" "$SIM_DEMO_PORT" 20 || sim_die "demo 沒有啟動，請看 $(sim_log_file demo)"
   ```

   `stop.sh` 呼叫 `sim_stop_daemon demo`；`health.sh` 用協定實際問一次（例如 `curl -fsS` 一個端點）。三支都要 `chmod +x`。
3. 需要別的服務先啟動時，把名稱寫進 `depends_on`。
4. 寫 `README.md`。
5. 驗證：`shellcheck -x sim/<名稱>/*.sh`，然後 `sim/up.sh <名稱>` → `sim/status.sh` → 實際用協定操作 → `sim/down.sh <名稱>` → 再 `sim/up.sh <名稱>`。
6. 需要系統套件（apt）時，也加進 `sim/lib/container/Dockerfile`，容器裡才跑得起來。

`sim_start_daemon` 會在行程的環境變數放 `SIM_SERVICE=<名稱>`，`sim_pid_alive` 與 `sim_stop_daemon` 靠它確認 pid 檔指到的確實是自己啟動的行程，重開機後 pid 被別的程式重用也不會誤判或誤殺。服務會自己轉到背景（daemonize）的話，請讓它留在前景，交給 `sim_start_daemon` 管。

## 用 Docker 跑

沒有 Linux 或不想在本機裝工具時，可以在容器裡執行同一批腳本：

```bash
docker compose -f sim/docker-compose.yml up -d --build
docker compose -f sim/docker-compose.yml exec sim sim/status.sh
docker compose -f sim/docker-compose.yml down          # 加 -v 連同資料一起刪
```

- 容器掛載 repo（唯讀）後執行 `sim/up.sh`，所以服務、相依順序、埠與版本和直接執行完全相同，沒有第二份設定。
- 使用主機網路，位址和直接執行時一樣。Linux 的 Docker Engine 直接可用；Docker Desktop（macOS、Windows）需要 4.34 以上，並開啟 Settings → Resources → Network 的「Enable host networking」。
- **這份設定沒有實際啟動過**：撰寫時的環境沒有 Docker daemon，只做過 `docker compose config`、hadolint 與 `trivy config` 的檢查，以及在本機以非 root 使用者、另一個資料目錄直接執行容器的進入點腳本（只啟動 mail）。第一次在有 Docker 的環境使用時，請把結果補進 `docs/handoff/`。
