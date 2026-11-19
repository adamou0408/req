#!/usr/bin/env bash
# 自我測試：用真的 SMTP 寄一封繁體中文的信，再從信箱 API 讀回來比對。
# 服務要先啟動（sim/up.sh mail）。全部相符回 0，測試信會刪掉，不影響信箱裡其他的信。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
source "${here}/../lib/common.sh"

sim_require_cmd curl jq base64
sim_load_env mail

readonly SENDER="no-reply@sgn.sim.test"
readonly RECIPIENT="selftest@sgn.sim.test"
token="selftest-$(date +%s)-$$"
readonly SUBJECT="【待簽核】資料授權申請：客戶主檔（北區客戶流失分析）${token}"
readonly LINK="http://127.0.0.1:5173/cases/42?from=mail&token=${token}"
readonly TEXT_BODY="林怡君 您好：
您有一張申請單等待簽核，請在期限內處理。
${LINK}"
readonly HTML_BODY="<p>林怡君 您好：</p><p>您有一張申請單等待簽核，請在期限內處理。</p><p><a href=\"${LINK//&/&amp;}\">開啟申請單</a></p>"

b64() {
    printf '%s' "$1" | base64
}

# 主旨含非 ASCII 字元，標頭必須用 RFC 2047 編碼。一個編碼字最多 75 個字元，而且不能把
# 一個字切成兩半，所以每 10 個字一段；用 jq 切是因為它以字（而不是位元組）為單位。
encode_header() {
    jq -rn --arg value "$1" '
        ($value | explode) as $chars
        | [range(0; $chars | length; 10) | $chars[.:. + 10] | implode | @base64 | "=?UTF-8?B?\(.)?="]
        | join("\n ")
    '
}

build_message() {
    local boundary="sim-${token}"
    cat <<MESSAGE
From: $(encode_header "簽核平台") <${SENDER}>
To: <${RECIPIENT}>
Subject: $(encode_header "$SUBJECT")
Date: $(LC_ALL=C date -R)
Message-ID: <${token}@sgn.sim.test>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="${boundary}"

--${boundary}
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: base64

$(b64 "$TEXT_BODY")
--${boundary}
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: base64

$(b64 "$HTML_BODY")
--${boundary}--
MESSAGE
}

expect_equal() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        sim_log "相符：${label}"
    else
        sim_log "不符：${label}"
        sim_log "  預期：${expected}"
        sim_log "  實際：${actual}"
        return 1
    fi
}

build_message | curl -fsS --max-time 10 --crlf \
    --url "smtp://${SIM_MAIL_SMTP_HOST}:${SIM_MAIL_SMTP_PORT}" \
    --mail-from "$SENDER" --mail-rcpt "$RECIPIENT" --upload-file -
sim_log "已用 SMTP 寄出：${SUBJECT}"

message="$("${here}/mailbox.sh" wait --to "$RECIPIENT" --subject "$token" --timeout 10)"
id="$(jq -r .ID <<<"$message")"
failed=0
expect_equal "主旨" "$SUBJECT" "$(jq -r .Subject <<<"$message")" || failed=1
expect_equal "寄件人名稱" "簽核平台" "$(jq -r .From.Name <<<"$message")" || failed=1
expect_equal "寄件人地址" "$SENDER" "$(jq -r .From.Address <<<"$message")" || failed=1
expect_equal "收件人" "$RECIPIENT" "$(jq -r '.To[0].Address' <<<"$message")" || failed=1
expect_equal "純文字內文" "$TEXT_BODY" "$(jq -r .Text <<<"$message" | tr -d '\r')" || failed=1
expect_equal "HTML 內文" "$HTML_BODY" "$(jq -r .HTML <<<"$message" | tr -d '\r')" || failed=1
expect_equal "取出的連結" "$LINK" \
    "$("${here}/mailbox.sh" wait --to "$RECIPIENT" --subject "$token" --output links --consume)" || failed=1
expect_equal "刪除後查不到" "" \
    "$("${here}/mailbox.sh" list --to "$RECIPIENT" --subject "$token")" || failed=1

[[ "$failed" -eq 0 ]] || sim_die "自我測試失敗（信件 ID ${id}）"
sim_log "自我測試通過"
