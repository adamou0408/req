#!/usr/bin/env bash
# 各模擬服務的 start.sh / stop.sh / health.sh 共用的函式。
# 用法：在服務腳本開頭
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
# 之後所有函式都以「服務名稱」（也就是 sim/ 下的目錄名）為第一個參數。

SIM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SIM_ROOT
# 執行期資料的根目錄；測試可以用環境變數換到別處，避免動到開發者正在用的資料。
SIM_RUN_ROOT="${SIM_RUN_ROOT:-${SIM_ROOT}/.run}"

sim_log() {
    printf '[sim] %s\n' "$*" >&2
}

sim_die() {
    sim_log "錯誤：$*"
    exit 1
}

sim_require_cmd() {
    local cmd
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null 2>&1 || sim_die "找不到指令 ${cmd}，請先安裝"
    done
}

sim_service_dir() {
    printf '%s/%s\n' "$SIM_ROOT" "$1"
}

# 執行期資料目錄（資料庫檔、pid、log），不存在就建立。
sim_run_dir() {
    local dir="${SIM_RUN_ROOT}/$1"
    mkdir -p "$dir"
    printf '%s\n' "$dir"
}

sim_pid_file() {
    printf '%s/%s.pid\n' "$(sim_run_dir "$1")" "${2:-$1}"
}

sim_log_file() {
    printf '%s/%s.log\n' "$(sim_run_dir "$1")" "${2:-$1}"
}

# 把服務的 service.env 載入目前的 shell，並匯出給子行程。
sim_load_env() {
    local env_file
    env_file="$(sim_service_dir "$1")/service.env"
    [[ -f "$env_file" ]] || sim_die "找不到 ${env_file}"
    set -a
    # shellcheck source=/dev/null
    source "$env_file"
    set +a
}

# 行程是否還在跑。已結束但還沒被回收的行程（殭屍）kill -0 仍然成功，要另外排除，
# 否則在不會即時回收的環境（例如容器）裡，停掉的服務會一直被當成還在。
sim_process_running() {
    local pid="$1" stat
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    if [[ -r "/proc/${pid}/stat" ]]; then
        stat="$(<"/proc/${pid}/stat")" || return 1
        # 格式是「pid (名稱) 狀態 ...」；名稱可能含空白與括號，所以從最後一個「) 」之後取狀態。
        [[ "${stat##*) }" != Z* ]] || return 1
    fi
}

# pid 檔記錄的行程是否還活著，而且確實是本服務啟動的。
# 只看 pid 不夠：重開機後 pid 會被別的行程重用，stop.sh 會誤殺。
# 所以啟動時在行程的環境變數放標記 SIM_SERVICE，這裡比對（需要 /proc；沒有時退回只看 pid）。
sim_pid_alive() {
    local name="$1" pid_file pid
    pid_file="$(sim_pid_file "$1" "${2:-$1}")"
    [[ -s "$pid_file" ]] || return 1
    pid="$(<"$pid_file")"
    sim_process_running "$pid" || return 1
    if [[ -r "/proc/${pid}/environ" ]]; then
        # 直接讓 grep 讀檔（-z：以 NUL 分隔）。不能接管線：grep -q 一找到就結束，
        # 前一段會收到 SIGPIPE，在 pipefail 下整條管線算失敗，活著的行程會被誤判成不在。
        grep -qzx "SIM_SERVICE=${name}" "/proc/${pid}/environ" 2>/dev/null || return 1
    fi
    return 0
}

# 以背景行程啟動指令，寫 pid 檔，輸出接到 log。
# 用法：sim_start_daemon <服務> <行程代號> <指令> [參數...]
# 用 setsid 讓它脫離呼叫者的行程群組，up.sh 被 Ctrl-C 中斷時不會連帶被砍。
sim_start_daemon() {
    local name="$1" proc="$2" pid_file log_file
    shift 2
    pid_file="$(sim_pid_file "$name" "$proc")"
    log_file="$(sim_log_file "$name" "$proc")"
    rm -f "$pid_file"
    # shellcheck disable=SC2016  # 單引號內的 $$ 與 $@ 要留給內層的 bash 展開
    SIM_SERVICE="$name" SIM_PID_FILE="$pid_file" setsid bash -c \
        'echo "$$" >"$SIM_PID_FILE"; exec "$@"' sim-daemon "$@" \
        >>"$log_file" 2>&1 </dev/null &
    local waited=0
    until [[ -s "$pid_file" ]]; do
        sleep 0.1
        waited=$((waited + 1))
        [[ "$waited" -lt 50 ]] || sim_die "${name}/${proc} 沒有寫出 pid 檔，請看 ${log_file}"
    done
}

# 停止 sim_start_daemon 啟動的行程：先 TERM，逾時再 KILL。
# 用法：sim_stop_daemon <服務> [行程代號] [等待秒數]
sim_stop_daemon() {
    local name="$1" proc="${2:-$1}" timeout="${3:-10}" pid_file pid waited=0
    pid_file="$(sim_pid_file "$name" "$proc")"
    if ! sim_pid_alive "$name" "$proc"; then
        rm -f "$pid_file"
        return 0
    fi
    pid="$(<"$pid_file")"
    kill -TERM "$pid" 2>/dev/null || true
    while sim_process_running "$pid"; do
        if [[ "$waited" -ge $((timeout * 10)) ]]; then
            sim_log "${name}/${proc}（pid ${pid}）${timeout} 秒內沒有結束，強制停止"
            kill -KILL "$pid" 2>/dev/null || true
            break
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    rm -f "$pid_file"
}

sim_port_open() {
    (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null
}

# 等待埠開始接受連線。用法：sim_wait_port <主機> <埠> [秒數]
sim_wait_port() {
    local host="$1" port="$2" timeout="${3:-30}" waited=0
    until sim_port_open "$host" "$port"; do
        [[ "$waited" -lt $((timeout * 5)) ]] || return 1
        sleep 0.2
        waited=$((waited + 1))
    done
}

# 啟動前確認埠沒被別的程式占用，否則之後的健康檢查會誤把別人的服務當成自己的。
sim_require_port_free() {
    local host="$1" port="$2"
    if sim_port_open "$host" "$port"; then
        sim_die "${host}:${port} 已經被其他程式占用"
    fi
}
