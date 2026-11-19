# 模擬環境的容器映像：只提供工具鏈與系統套件。只供開發與測試。
# 服務本身不放進映像，而是掛載 repo 後執行 sim/ 的同一批腳本，
# 這樣容器裡跑的和本機直接跑的是同一套設定，不會有第二份。
FROM golang:1.24-bookworm AS go

# 用完整版（非 slim）的 Node 映像：內含 git、gcc、curl，建置各服務的執行檔時用得到。
FROM node:22-bookworm

# 各服務的 install.sh 發現缺套件時會用 apt 安裝，但那需要 root；先裝好，容器才能以一般使用者執行。
# 新增的模擬服務若需要系統套件，加在這裡。
# 不固定套件版本：Debian 的套件庫只保留最新的修補版，固定版本會讓映像在下一次安全更新後建不起來。
# hadolint ignore=DL3008
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq ldap-utils slapd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=go /usr/local/go /usr/local/go
# GOTOOLCHAIN=auto：服務指定的版本若需要較新的 Go，由 go 指令自行下載對應的工具鏈。
# slapd 裝在 /usr/sbin，一般使用者的 PATH 預設沒有。
ENV PATH="/usr/local/go/bin:/usr/sbin:${PATH}" \
    GOTOOLCHAIN=auto \
    SIM_RUN_ROOT=/var/lib/sgn-sim

# 具名 volume 第一次掛載時會沿用映像裡目錄的擁有者，所以先建好並交給執行的使用者。
RUN mkdir -p "${SIM_RUN_ROOT}" /home/node/go \
    && chown 1000:1000 "${SIM_RUN_ROOT}" /home/node/go

# node 映像內建的一般使用者；用數字是為了不依賴主機能否解析使用者名稱。
USER 1000:1000
WORKDIR /workspace
HEALTHCHECK --interval=10s --timeout=10s --start-period=10m --retries=3 \
    CMD ["/workspace/sim/status.sh", "--strict"]
ENTRYPOINT ["/workspace/sim/lib/container/entrypoint.sh"]
