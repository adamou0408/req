#!/usr/bin/env bash
# 測試輔助：查詢與清空模擬信箱（走 Mailpit 的 HTTP API）。
#
# 用法：
#   mailbox.sh wait --to <收件人> [--subject <關鍵字>] [--timeout <秒>] [--output <格式>] [--consume]
#       等到有符合的信為止，輸出最新的一封；逾時回傳 2。
#       --to       收件人地址，完全相符（不分大小寫；收件人、副本、密件副本都算）
#       --subject  主旨包含這段文字（可省略）
#       --timeout  最多等幾秒（預設 15）
#       --output   json（預設，整封信）｜text｜html｜links（信裡的連結，一行一個）｜id
#       --consume  取回後刪除這封信；同一個主旨會寄很多次時，下一次 wait 才不會拿到舊信
#   mailbox.sh list [--to <收件人>] [--subject <關鍵字>]
#       列出符合的信（新的在前）：時間、收件人、主旨。
#   mailbox.sh clear
#       清空信箱。
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

readonly PAGE_SIZE=100
readonly EXIT_TIMEOUT=2

sim_require_cmd curl jq
sim_load_env mail
readonly API="http://${SIM_MAIL_HTTP_HOST}:${SIM_MAIL_HTTP_PORT}/api/v1"

usage() {
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//' >&2
    exit 64
}

api() {
    curl -fsS --max-time 10 "$@"
}

# 篩出符合收件人與主旨的信件摘要（新的在前）。逐頁讀完整個信箱，不會漏掉較舊的信。
find_messages() {
    local to="$1" subject="$2" start=0 page total count
    while :; do
        page="$(api "${API}/messages?limit=${PAGE_SIZE}&start=${start}")"
        jq -c --arg to "$to" --arg subject "$subject" '
            .messages[]
            | select($to == "" or any((.To // [])[], (.Cc // [])[], (.Bcc // [])[];
                (.Address | ascii_downcase) == ($to | ascii_downcase)))
            | select(.Subject | contains($subject))
        ' <<<"$page"
        total="$(jq -r .total <<<"$page")"
        count="$(jq -r '.messages | length' <<<"$page")"
        start=$((start + count))
        [[ "$count" -gt 0 && "$start" -lt "$total" ]] || break
    done
}

# 取出信裡的連結：先 HTML 的 href，再純文字裡的網址；去掉重複、保留順序。
print_links() {
    jq -r '
        [ ((.HTML // "") | [match("href=\"([^\"]+)\""; "g").captures[0].string]
              | map(gsub("&amp;"; "&")))[],
          ((.Text // "") | [match("https?://[^\\s<>\"]+"; "g").string])[] ]
        | reduce .[] as $url ([]; if index($url) then . else . + [$url] end)
        | .[]
    '
}

print_message() {
    local id="$1" output="$2" message
    message="$(api "${API}/message/${id}")"
    case "$output" in
        json) jq . <<<"$message" ;;
        text) jq -r '.Text // ""' <<<"$message" ;;
        html) jq -r '.HTML // ""' <<<"$message" ;;
        links) print_links <<<"$message" ;;
        id) printf '%s\n' "$id" ;;
    esac
}

cmd_wait() {
    local to="" subject="" timeout=15 output=json consume=false matches id deadline
    while [[ "$#" -gt 0 ]]; do
        case "$1" in
            --to) to="${2:?--to 需要值}"; shift 2 ;;
            --subject) subject="${2:?--subject 需要值}"; shift 2 ;;
            --timeout) timeout="${2:?--timeout 需要值}"; shift 2 ;;
            --output) output="${2:?--output 需要值}"; shift 2 ;;
            --consume) consume=true; shift ;;
            *) usage ;;
        esac
    done
    [[ -n "$to" ]] || sim_die "wait 必須指定 --to"
    [[ "$timeout" =~ ^[0-9]+$ ]] || sim_die "--timeout 必須是整數秒"
    [[ "$output" =~ ^(json|text|html|links|id)$ ]] || sim_die "--output 不支援 ${output}"

    deadline=$((SECONDS + timeout))
    while :; do
        matches="$(find_messages "$to" "$subject")"
        id="$(jq -rs '.[0].ID // empty' <<<"$matches")"
        [[ -z "$id" ]] || break
        if [[ "$SECONDS" -ge "$deadline" ]]; then
            sim_log "等了 ${timeout} 秒，沒有寄給 ${to}、主旨含「${subject}」的信"
            exit "$EXIT_TIMEOUT"
        fi
        sleep 0.3
    done
    print_message "$id" "$output"
    if [[ "$consume" == true ]]; then
        api -X DELETE -H 'Content-Type: application/json' \
            --data "$(jq -cn --arg id "$id" '{IDs: [$id]}')" "${API}/messages" >/dev/null
    fi
}

cmd_list() {
    local to="" subject=""
    while [[ "$#" -gt 0 ]]; do
        case "$1" in
            --to) to="${2:?--to 需要值}"; shift 2 ;;
            --subject) subject="${2:?--subject 需要值}"; shift 2 ;;
            *) usage ;;
        esac
    done
    find_messages "$to" "$subject" \
        | jq -r '[.Created, ([.To[]?.Address] | join(",")), .Subject] | @tsv'
}

cmd_clear() {
    [[ "$#" -eq 0 ]] || usage
    api -X DELETE "${API}/messages" >/dev/null
}

command="${1:-}"
[[ -n "$command" ]] || usage
shift
case "$command" in
    wait) cmd_wait "$@" ;;
    list) cmd_list "$@" ;;
    clear) cmd_clear "$@" ;;
    *) usage ;;
esac
