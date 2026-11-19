#!/usr/bin/env bash
# up.sh / down.sh / status.sh 共用：找出有哪些模擬服務、依 depends_on 排出順序。
# 服務清單不寫在任何腳本裡：sim/ 下任何含 start.sh 的目錄就是一個服務。

# shellcheck source=SCRIPTDIR/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

readonly SIM_SERVICE_SCRIPTS=(start.sh stop.sh health.sh)

sim_discover_services() {
    local dir
    for dir in "$SIM_ROOT"/*/; do
        [[ -f "${dir}start.sh" ]] || continue
        basename "$dir"
    done | LC_ALL=C sort
}

sim_is_service() {
    [[ "$1" =~ ^[a-z0-9][a-z0-9_-]*$ && -f "$(sim_service_dir "$1")/start.sh" ]]
}

# 服務目錄必須備齊慣例要求的檔案，缺了就明講，而不是等到執行一半才失敗。
sim_check_service_layout() {
    local name="$1" dir file missing=()
    dir="$(sim_service_dir "$name")"
    for file in "${SIM_SERVICE_SCRIPTS[@]}"; do
        [[ -x "${dir}/${file}" ]] || missing+=("${file}（需可執行）")
    done
    [[ -f "${dir}/service.env" ]] || missing+=("service.env")
    [[ "${#missing[@]}" -eq 0 ]] || sim_die "sim/${name} 缺少：${missing[*]}"
}

# 讀 sim/<服務>/depends_on：一行一個服務名稱，# 之後是註解；沒有這個檔就是沒有相依。
sim_service_deps() {
    local file
    file="$(sim_service_dir "$1")/depends_on"
    [[ -f "$file" ]] || return 0
    sed -e 's/#.*//' -e 's/[[:space:]]//g' -e '/^$/d' "$file"
}

declare -A _sim_visit_state=()
_sim_order=()

_sim_visit() {
    local name="$1" via="$2" dep
    case "${_sim_visit_state[$name]:-}" in
        visited) return 0 ;;
        visiting) sim_die "相依關係形成循環：${via} → ${name}" ;;
    esac
    sim_is_service "$name" || sim_die "找不到服務 ${name}（${via} 的相依）"
    _sim_visit_state[$name]=visiting
    while IFS= read -r dep; do
        _sim_visit "$dep" "$name"
    done < <(sim_service_deps "$name")
    _sim_visit_state[$name]=visited
    _sim_order+=("$name")
}

# 輸出指定服務的啟動順序（被相依的在前），連同它們間接相依的服務。
sim_order_for() {
    local name
    _sim_visit_state=()
    _sim_order=()
    for name in "$@"; do
        _sim_visit "$name" "指令列"
    done
    [[ "${#_sim_order[@]}" -eq 0 ]] || printf '%s\n' "${_sim_order[@]}"
}

# 輸出全部服務的啟動順序。
sim_full_order() {
    local names=()
    mapfile -t names < <(sim_discover_services)
    [[ "${#names[@]}" -eq 0 ]] || sim_order_for "${names[@]}"
}

# 用法：sim_start_order [服務...]；不指定就是全部。
sim_start_order() {
    if [[ "$#" -eq 0 ]]; then
        sim_full_order
    else
        sim_order_for "$@"
    fi
}

# 輸出停止順序（相依別人的先停）。指定服務時，連同相依於它們的服務一起停，
# 否則會留下相依對象已經不在的服務。
# 用法：sim_stop_order [服務...]；不指定就是全部。
sim_stop_order() {
    local name dep order_text all=() order=()
    local -A wanted=()
    # 先排出完整順序（順便驗證相依關係），再放進陣列：
    # sim_die 在行程替換裡只會結束子 shell，要用回傳值把失敗帶出來。
    order_text="$(sim_full_order)" || return 1
    [[ -z "$order_text" ]] || mapfile -t all <<<"$order_text"
    if [[ "$#" -eq 0 ]]; then
        for name in "${all[@]}"; do wanted[$name]=1; done
    else
        for name in "$@"; do
            sim_is_service "$name" || sim_die "找不到服務 ${name}"
            wanted[$name]=1
        done
        # all 已依相依順序排好，順著走一遍就能把間接相依者都標出來。
        for name in "${all[@]}"; do
            while IFS= read -r dep; do
                [[ -z "${wanted[$dep]:-}" ]] || wanted[$name]=1
            done < <(sim_service_deps "$name")
        done
    fi
    for name in "${all[@]}"; do
        [[ -z "${wanted[$name]:-}" ]] || order=("$name" "${order[@]}")
    done
    [[ "${#order[@]}" -eq 0 ]] || printf '%s\n' "${order[@]}"
}

# 等 health.sh 通過。用法：sim_wait_healthy <服務> [秒數]
sim_wait_healthy() {
    local name="$1" timeout="${2:-60}" health deadline
    health="$(sim_service_dir "$name")/health.sh"
    deadline=$((SECONDS + timeout))
    until "$health" >/dev/null 2>&1; do
        [[ "$SECONDS" -lt "$deadline" ]] || return 1
        sleep 0.5
    done
}

# 服務狀態：healthy（健康檢查通過）、unhealthy（行程在跑但檢查沒過）、stopped。
sim_service_state() {
    local name="$1" pid_file pid
    if "$(sim_service_dir "$name")/health.sh" >/dev/null 2>&1; then
        echo healthy
        return 0
    fi
    for pid_file in "${SIM_RUN_ROOT}/${name}"/*.pid; do
        [[ -s "$pid_file" ]] || continue
        pid="$(<"$pid_file")"
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
            echo unhealthy
            return 0
        fi
    done
    echo stopped
}

# 從 service.env 彙整位址：每個 *_PORT 變數配上同名的 *_HOST（沒有就用 127.0.0.1）。
# 輸出：每行「<用途> <主機>:<埠>」。埠對照表只從這裡產生，不另外手抄。
sim_service_endpoints() {
    local name="$1" env_file
    env_file="$(sim_service_dir "$name")/service.env"
    [[ -f "$env_file" ]] || return 0
    (
        set -a
        # shellcheck source=/dev/null
        source "$env_file"
        set +a
        local key prefix host_var label strip
        strip="$(tr '[:lower:]-' '[:upper:]_' <<<"$name")"
        while IFS= read -r key; do
            prefix="${key%_PORT}"
            host_var="${prefix}_HOST"
            label="${prefix#SIM_}"
            label="${label#"${strip}"_}"
            [[ "$label" != "$strip" ]] || label=""
            printf '%s %s:%s\n' "$(tr '[:upper:]' '[:lower:]' <<<"${label:-port}")" \
                "${!host_var:-127.0.0.1}" "${!key}"
        done < <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*_PORT=' "$env_file" | tr -d '=')
    )
}
