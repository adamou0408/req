#!/usr/bin/env bash
# 模擬人事異動：直接修改執行中的目錄，給同步、權限把關與登入的測試用。
# 做完測試用 reset.sh 回到種子狀態。
#
# 用法：
#   change.sh transfer <uid> <新單位名稱> <新主管 uid>   調職：改單位與主管
#   change.sh set-manager <uid> <主管 uid|none>          換主管（none＝沒有主管）
#   change.sh offboard <uid>                             離職：停用帳號，無法再登入
#   change.sh group-add <群組> <uid>                     加入群組
#   change.sh group-remove <群組> <uid>                  移出群組
#   change.sh group-set <群組> <uid>...                  把群組成員換成指定的人（單一持有人換人）
# 群組以 cn 指定，例如 mis、ciso、ciso_deputy、data_owner:客戶主檔。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# ppolicy 規定的「永久鎖定」時間值。
readonly LOCKED_FOREVER=000001010000Z

usage() {
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//' >&2
    exit 2
}

b64() {
    printf '%s' "$1" | base64 -w0
}

# 把使用者輸入放進搜尋條件前，先跳脫 LDAP filter 的特殊字元（RFC 4515）。
filter_escape() {
    local value="$1"
    value="${value//\\/\\5c}"
    value="${value//\*/\\2a}"
    value="${value//(/\\28}"
    value="${value//)/\\29}"
    printf '%s' "$value"
}

# 查出唯一符合的項目並輸出它的 DN；找不到或不只一筆就失敗。
find_dn() {
    local base="$1" filter="$2" what="$3" output count
    output="$(sim_ldap_as_admin ldapsearch -LLL -o ldif-wrap=no -b "$base" "$filter" 1.1)"
    count="$(grep -c '^dn:' <<<"$output" || true)"
    [[ "$count" -eq 1 ]] || sim_die "找不到${what}（符合 ${count} 筆）"
    if [[ "$output" =~ ^dn::\ ([^$'\n']+) ]]; then
        base64 -d <<<"${BASH_REMATCH[1]}"
    else
        [[ "$output" =~ ^dn:\ ([^$'\n']+) ]]
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

person_dn() {
    [[ "$1" =~ ^[a-z0-9._-]+$ ]] || sim_die "uid 格式不符：$1"
    find_dn "$SIM_LDAP_PEOPLE_DN" "(&(objectClass=inetOrgPerson)(uid=$1))" "人員 $1"
}

group_dn() {
    find_dn "$SIM_LDAP_GROUPS_DN" "(&(objectClass=groupOfNames)(cn=$(filter_escape "$1")))" "群組 $1"
}

# 從標準輸入讀「modify 的內容」，套用到指定的 DN。DN 一律用 base64，中文也不會出錯。
modify() {
    local dn="$1"
    {
        printf 'dn:: %s\nchangetype: modify\n' "$(b64 "$dn")"
        cat
    } | sim_ldap_as_admin ldapmodify >/dev/null
}

set_manager() {
    local dn="$1" manager_uid="$2" manager
    if [[ "$manager_uid" == none ]]; then
        # 原本就沒有主管時，刪除會回報沒有這個屬性；結果一樣，所以用 replace 成空值。
        modify "$dn" <<<$'replace: manager\n'
        return
    fi
    manager="$(person_dn "$manager_uid")"
    [[ "$manager" != "$dn" ]] || sim_die "主管不能是自己"
    modify "$dn" <<LDIF
replace: manager
manager: ${manager}
LDIF
}

cmd_transfer() {
    [[ "$#" -eq 3 ]] || usage
    local dn unit="$2"
    dn="$(person_dn "$1")"
    find_dn "$SIM_LDAP_ORG_DN" "(&(objectClass=organizationalUnit)(ou=$(filter_escape "$unit")))" \
        "單位 ${unit}" >/dev/null
    set_manager "$dn" "$3"
    modify "$dn" <<LDIF
replace: ou
ou:: $(b64 "$unit")
LDIF
    sim_log "$1 已調到 ${unit}，主管 $3"
}

cmd_set_manager() {
    [[ "$#" -eq 2 ]] || usage
    set_manager "$(person_dn "$1")" "$2"
    sim_log "$1 的主管已改為 $2"
}

cmd_offboard() {
    [[ "$#" -eq 1 ]] || usage
    # 只停用、不刪除、不動群組：真實環境裡人離職後，群組常常晚一步才清，測試要能重現這種落差。
    modify "$(person_dn "$1")" <<LDIF
replace: employeeType
employeeType: terminated
-
replace: pwdAccountLockedTime
pwdAccountLockedTime: ${LOCKED_FOREVER}
LDIF
    sim_log "$1 已離職停用（群組成員資格未變動，需要時用 group-remove 移除）"
}

cmd_group_member() {
    local operation="$1"
    shift
    [[ "$#" -eq 2 ]] || usage
    modify "$(group_dn "$1")" <<LDIF
${operation}: member
member: $(person_dn "$2")
LDIF
}

cmd_group_set() {
    [[ "$#" -ge 2 ]] || usage
    local group="$1" uid members=""
    shift
    for uid in "$@"; do
        members+="member: $(person_dn "$uid")"$'\n'
    done
    modify "$(group_dn "$group")" <<LDIF
replace: member
${members}
LDIF
    sim_log "群組 ${group} 的成員已換成：$*"
}

[[ "$#" -ge 1 ]] || usage
command="$1"
shift
sim_ldap_load_env

case "$command" in
    transfer) cmd_transfer "$@" ;;
    set-manager) cmd_set_manager "$@" ;;
    offboard) cmd_offboard "$@" ;;
    group-add)
        cmd_group_member add "$@"
        sim_log "$2 已加入群組 $1"
        ;;
    group-remove)
        # groupOfNames 至少要有一位成員；移除最後一位會被 LDAP 拒絕，請改用 group-set 換人。
        cmd_group_member delete "$@"
        sim_log "$2 已移出群組 $1"
        ;;
    group-set) cmd_group_set "$@" ;;
    *) usage ;;
esac
