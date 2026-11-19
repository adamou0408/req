# 模擬環境的容器映像：只提供工具鏈（Go、Node、git、編譯器）。
# 服務本身不放進映像，而是掛載 repo 後執行 sim/ 的同一批腳本，
# 這樣容器裡跑的和本機直接跑的是同一套設定，不會有第二份。只供開發與測試。
FROM golang:1.24-bookworm AS go

FROM node:22-bookworm
COPY --from=go /usr/local/go /usr/local/go
# GOTOOLCHAIN=auto：服務指定的版本若需要較新的 Go，由 go 指令自行下載對應的工具鏈。
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=auto
WORKDIR /workspace
# 模擬服務需要用 apt 安裝套件並自行管理資料目錄，所以用 root；容器只在開發機上執行，不對外提供服務。
# hadolint ignore=DL3002
USER root
HEALTHCHECK --interval=10s --timeout=10s --start-period=10m --retries=3 \
    CMD ["/workspace/sim/status.sh", "--strict"]
ENTRYPOINT ["/workspace/sim/lib/container/entrypoint.sh"]
