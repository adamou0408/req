#!/usr/bin/env bash
# status-report.sh - Generate a project status report
#
# Usage: bash framework/scripts/status-report.sh
#
# Reads .req.config.yml to locate data_root and code_root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

req_load_config

DATA="$REQ_HOST_ROOT/$REQ_DATA_ROOT"
CODE="$REQ_HOST_ROOT/$REQ_CODE_ROOT"

echo "========================================"
echo "  Demand-Driven Dev — Status Report"
echo "  $(date '+%Y-%m-%d %H:%M')"
echo "  data_root: $REQ_DATA_ROOT  code_root: $REQ_CODE_ROOT"
echo "========================================"
echo ""

raw_count=$(find "$DATA/intake/raw" -name '*.md' 2>/dev/null | wc -l)
echo "📥 Raw Requirements (intake/raw/): $raw_count"

persona_count=$(find "$DATA/personas" -maxdepth 1 -name '*.md' ! -name '_template.md' ! -name 'README.md' 2>/dev/null | wc -l)
echo "👥 Personas: $persona_count"

echo ""
echo "📋 Specs by Status:"
for status in draft in-review approved in-progress done; do
    count=0
    for spec in "$DATA"/specs/*/spec.md; do
        [ -f "$spec" ] || continue
        if grep -q "\`$status\`" "$spec" 2>/dev/null; then
            count=$((count + 1))
        fi
    done
    printf "   %-15s %d\n" "$status" "$count"
done

echo ""
echo "⚠️  Conflicts by Status:"
for status in detected under-discussion resolved; do
    count=0
    for conflict in "$DATA"/conflicts/CONFLICT-*.md; do
        [ -f "$conflict" ] || continue
        if grep -q "\`$status\`" "$conflict" 2>/dev/null; then
            count=$((count + 1))
        fi
    done
    printf "   %-20s %d\n" "$status" "$count"
done

review_count=$(find "$DATA/reviews" -name 'REVIEW-*.md' 2>/dev/null | wc -l)
echo ""
echo "✅ Reviews: $review_count"

if [ -d "$CODE/src" ]; then
    src_count=$(find "$CODE/src" -type f ! -name '.gitkeep' 2>/dev/null | wc -l)
else
    src_count=0
fi
echo ""
echo "💻 Source Files: $src_count"

if [ -d "$CODE/tests" ]; then
    test_count=$(find "$CODE/tests" -type f ! -name '.gitkeep' 2>/dev/null | wc -l)
else
    test_count=0
fi
echo "🧪 Test Files: $test_count"

echo ""
echo "📈 Derived Metrics (from docs/changelog.md)"
echo "   (accuracy depends on AGENTS.md §6 changelog discipline; see docs/metrics.md)"

CHANGELOG="$DATA/docs/changelog.md"
if [ ! -f "$CHANGELOG" ]; then
    echo "   changelog not found → metrics: N/A"
else
    # Metric 1: median cycle time (draft → done) for specs currently in `done` state
    # Parses lines like: "2026-04-08: spec slug-foo (draft → in-review) by /req-..."
    # and "2026-04-08: spec slug-foo (in-progress → done) by /req-..."
    #
    # Approximation: for each slug that has a `→ done` entry, find the earliest entry
    # (taken as the draft creation) and compute day delta.
    cycle_times=()
    while IFS= read -r done_line; do
        # extract slug and done date
        done_date=$(echo "$done_line" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
        slug=$(echo "$done_line" | grep -oE 'spec [a-zA-Z0-9_-]+' | awk '{print $2}')
        [ -z "$slug" ] && continue
        [ -z "$done_date" ] && continue
        first_date=$(grep -E "spec $slug" "$CHANGELOG" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' | sort | head -n1)
        [ -z "$first_date" ] && continue
        # day delta using `date -d` (GNU date)
        first_epoch=$(date -d "$first_date" +%s 2>/dev/null || echo "")
        done_epoch=$(date -d "$done_date" +%s 2>/dev/null || echo "")
        [ -z "$first_epoch" ] && continue
        [ -z "$done_epoch" ] && continue
        delta_days=$(( (done_epoch - first_epoch) / 86400 ))
        cycle_times+=("$delta_days")
    done < <(grep -E '→ done' "$CHANGELOG" 2>/dev/null || true)

    if [ "${#cycle_times[@]}" -gt 0 ]; then
        # sorted median
        sorted=($(printf '%s\n' "${cycle_times[@]}" | sort -n))
        mid=$(( ${#sorted[@]} / 2 ))
        median="${sorted[$mid]}"
        printf "   %-38s %s days (n=%d)\n" "Median cycle time (draft→done):" "$median" "${#cycle_times[@]}"
    else
        printf "   %-38s N/A\n" "Median cycle time (draft→done):"
    fi

    # Metric 2: first-pass approval rate
    # Count specs that went `in-review → approved` without ever returning to `draft` afterward.
    # Approximation: for each slug that has an `approved` entry, check whether it also has
    # any later `→ draft` entry. If none, count as first-pass.
    total_in_review=0
    first_pass=0
    while IFS= read -r slug; do
        [ -z "$slug" ] && continue
        total_in_review=$((total_in_review + 1))
        # last matching transition
        has_rollback=$(awk -v s="spec $slug" '
            $0 ~ s && /→ approved/ { seen_approved=1; next }
            $0 ~ s && /→ draft/ && seen_approved { print "yes"; exit }
        ' "$CHANGELOG")
        if [ -z "$has_rollback" ]; then
            # also verify it actually reached approved at least once
            if grep -qE "spec $slug.*→ approved" "$CHANGELOG"; then
                first_pass=$((first_pass + 1))
            fi
        fi
    done < <(grep -E '→ in-review' "$CHANGELOG" 2>/dev/null | grep -oE 'spec [a-zA-Z0-9_-]+' | awk '{print $2}' | sort -u)

    if [ "$total_in_review" -gt 0 ]; then
        rate=$(( first_pass * 100 / total_in_review ))
        printf "   %-38s %d%% (%d/%d)\n" "First-pass approval rate:" "$rate" "$first_pass" "$total_in_review"
    else
        printf "   %-38s N/A\n" "First-pass approval rate:"
    fi

    # Metric 3: fixup frequency (last 30 days)
    # Counts lines with `[reason: fixup]` in changelog within the last 30 days.
    cutoff_epoch=$(date -d "30 days ago" +%s 2>/dev/null || echo "0")
    fixup_count=0
    while IFS= read -r line; do
        entry_date=$(echo "$line" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
        [ -z "$entry_date" ] && continue
        entry_epoch=$(date -d "$entry_date" +%s 2>/dev/null || echo "0")
        if [ "$entry_epoch" -ge "$cutoff_epoch" ]; then
            fixup_count=$((fixup_count + 1))
        fi
    done < <(grep -F '[reason: fixup]' "$CHANGELOG" 2>/dev/null || true)
    printf "   %-38s %d (last 30 days)\n" "Fixup frequency:" "$fixup_count"
fi

echo ""
echo "========================================"
