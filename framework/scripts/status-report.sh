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
            ((count++))
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
            ((count++))
        fi
    done
    printf "   %-20s %d\n" "$status" "$count"
done

review_count=$(find "$DATA/reviews" -name 'REVIEW-*.md' 2>/dev/null | wc -l)
echo ""
echo "✅ Reviews: $review_count"

src_count=$(find "$CODE/src" -type f ! -name '.gitkeep' 2>/dev/null | wc -l)
echo ""
echo "💻 Source Files: $src_count"

test_count=$(find "$CODE/tests" -type f ! -name '.gitkeep' 2>/dev/null | wc -l)
echo "🧪 Test Files: $test_count"

echo ""
echo "========================================"
