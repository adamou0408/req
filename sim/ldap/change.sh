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
# 讓 $(...) 裡的函式也在出錯時立刻停止；否則查不到人時會帶著空值繼續修改目錄。
shopt -s inherit_errexit

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

# 輸出「把主管改成指定的人」的 modify 內容；none 表示沒有主管。
manager_change() {
    local dn="$1" manager_uid="$2" manager
    # replace 不帶值就是清空，原本有沒有主管都適用。
    printf 'replace: manager\n'
    [[ "$manager_uid" != none ]] || return 0
    manager="$(person_dn "$manager_uid")"
    [[ "$manager" != "$dn" ]] || sim_die "主管不能是自己"
    printf 'manager: %s\n' "$manager"
}

cmd_transfer() {
    [[ "$#" -eq 3 ]] || usage
    local dn unit="$2" manager_lines
    dn="$(person_dn "$1")"
    find_dn "$SIM_LDAP_ORG_DN" "(&(objectClass=organizationalUnit)(ou=$(filter_escape "$unit")))" \
        "單位 ${unit}" >/dev/null
    manager_lines="$(manager_change "$dn" "$3")"
    # 單位與主管放在同一次修改，不會出現只改了一半的狀態。
    modify "$dn" <<LDIF
replace: ou
ou:: $(b64 "$unit")
-
${manager_lines}
LDIF
    sim_log "$1 已調到 ${unit}，主管 $3"
}

cmd_set_manager() {
    [[ "$#" -eq 2 ]] || usage
    local dn manager_lines
    dn="$(person_dn "$1")"
    manager_lines="$(manager_change "$dn" "$2")"
    modify "$dn" <<<"$manager_lines"
    sim_log "$1 的主管已改為 $2"
}

cmd_offboard() {
    [[ "$#" -eq 1 ]] || usage
    local dn
    dn="$(person_dn "$1")"
    # 只停用、不刪除、不動群組：真實環境裡人離職後，群組常常晚一步才清，測試要能重現這種落差。
    modify "$dn" <<LDIF
replace: employeeType
employeeType: terminated
-
replace: pwdAccountLockedTime
pwdAccountLockedTime: ${LOCKED_FOREVER}
LDIF
    sim_log "$1 已離職停用（群組成員資格未變動，需要時用 group-remove 移除）"
}

# 用法：cmd_group_member add|delete <群組> <uid>
cmd_group_member() {
    [[ "$#" -eq 3 ]] || usage
    local operation="$1" group member
    group="$(group_dn "$2")"
    member="$(person_dn "$3")"
    modify "$group" <<LDIF
${operation}: member
member: ${member}
LDIF
}

cmd_group_set() {
    [[ "$#" -ge 2 ]] || usage
    local name="$1" group uid member members=""
    shift
    group="$(group_dn "$name")"
    for uid in "$@"; do
        member="$(person_dn "$uid")"
        members+="member: ${member}"$'\n'
    done
    modify "$group" <<LDIF
replace: member
${members}
LDIF
    sim_log "群組 ${name} 的成員已換成：$*"
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
