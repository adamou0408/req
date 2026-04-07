#!/usr/bin/env bash
# _lib.sh — shared helpers for req framework scripts
#
# Provides:
#   req_find_host_root           — locate the host repo root (where .req.config.yml lives)
#   req_load_config              — populate REQ_DATA_ROOT / REQ_CODE_ROOT / REQ_FRAMEWORK_ROOT / REQ_LAST_SYNCED_VERSION
#   req_substitute_vars <file>   — print <file> with ${REQ_*_ROOT} placeholders resolved
#   req_framework_version        — read framework/VERSION (or VERSION at framework_root)
#
# All scripts in framework/scripts/ should `source` this file.

set -euo pipefail

REQ_CONFIG_FILENAME=".req.config.yml"

req_find_host_root() {
    # Walk upward from CWD until we find .req.config.yml
    local dir
    dir="$(pwd)"
    while [ "$dir" != "/" ] && [ "$dir" != "" ]; do
        if [ -f "$dir/$REQ_CONFIG_FILENAME" ]; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

req_load_config() {
    local host_root
    if ! host_root="$(req_find_host_root)"; then
        echo "ERROR: $REQ_CONFIG_FILENAME not found in current directory or any parent." >&2
        echo "       Run 'req-init.sh' or 'req-add-submodule.sh' first." >&2
        return 1
    fi
    REQ_HOST_ROOT="$host_root"

    local cfg="$host_root/$REQ_CONFIG_FILENAME"
    # Minimal yaml parser: only top-level "key: value" lines, value may be quoted
    REQ_DATA_ROOT="$(awk -F': *' '/^data_root:/ {gsub(/["\047]/, "", $2); print $2; exit}' "$cfg")"
    REQ_CODE_ROOT="$(awk -F': *' '/^code_root:/ {gsub(/["\047]/, "", $2); print $2; exit}' "$cfg")"
    REQ_FRAMEWORK_ROOT="$(awk -F': *' '/^framework_root:/ {gsub(/["\047]/, "", $2); print $2; exit}' "$cfg")"
    REQ_LAST_SYNCED_VERSION="$(awk -F': *' '/^last_synced_version:/ {gsub(/["\047]/, "", $2); print $2; exit}' "$cfg")"

    : "${REQ_DATA_ROOT:?data_root missing in $cfg}"
    : "${REQ_CODE_ROOT:?code_root missing in $cfg}"
    : "${REQ_FRAMEWORK_ROOT:?framework_root missing in $cfg}"

    export REQ_HOST_ROOT REQ_DATA_ROOT REQ_CODE_ROOT REQ_FRAMEWORK_ROOT REQ_LAST_SYNCED_VERSION
}

req_substitute_vars() {
    local file="$1"
    # Resolve ${REQ_DATA_ROOT}, ${REQ_CODE_ROOT}, ${REQ_FRAMEWORK_ROOT} placeholders
    sed \
        -e "s|\${REQ_DATA_ROOT}|${REQ_DATA_ROOT}|g" \
        -e "s|\${REQ_CODE_ROOT}|${REQ_CODE_ROOT}|g" \
        -e "s|\${REQ_FRAMEWORK_ROOT}|${REQ_FRAMEWORK_ROOT}|g" \
        "$file"
}

req_framework_version() {
    local fw_root="${1:-${REQ_FRAMEWORK_ROOT:-}}"
    if [ -z "$fw_root" ]; then
        return 1
    fi
    # framework_root may point at the repo root that contains framework/ + VERSION,
    # or at the framework/ subdir itself. Handle both.
    if [ -f "$fw_root/VERSION" ]; then
        cat "$fw_root/VERSION"
    elif [ -f "$fw_root/../VERSION" ]; then
        cat "$fw_root/../VERSION"
    else
        echo "unknown"
    fi
}

req_semver_major() {
    # Print the major component of a semver string (e.g. "2.1.0" → "2")
    echo "${1%%.*}"
}
