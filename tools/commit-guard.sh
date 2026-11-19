#!/usr/bin/env bash
# Refuses to commit runtime data or large files. Run after `git add` and before `git commit`.
set -euo pipefail

MAX_BYTES=$((1024 * 1024))
FORBIDDEN_PATHS='(^|/)(\.run|node_modules|dist|test-results|playwright-report)/'

failed=0
while IFS= read -r -d '' path; do
    if [[ "$path" =~ $FORBIDDEN_PATHS ]]; then
        echo "commit-guard: runtime or build output staged: $path" >&2
        failed=1
        continue
    fi
    size=$(git cat-file -s ":$path" 2>/dev/null || echo 0)
    if (( size > MAX_BYTES )); then
        echo "commit-guard: file larger than 1 MB staged: $path ($size bytes)" >&2
        failed=1
    fi
done < <(git diff --cached --name-only --diff-filter=AM -z)

exit "$failed"
