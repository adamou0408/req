#!/usr/bin/env bash
# status-report.sh - Generate a project status report
#
# Usage: ./scripts/status-report.sh

set -euo pipefail

echo "========================================"
echo "  Demand-Driven Dev — Status Report"
echo "  $(date '+%Y-%m-%d %H:%M')"
echo "========================================"
echo ""

# Count raw intake files
raw_count=$(find intake/raw -name '*.md' 2>/dev/null | wc -l)
echo "📥 Raw Requirements (intake/raw/): $raw_count"

# Count personas
persona_count=$(find personas -maxdepth 1 -name '*.md' ! -name '_template.md' ! -name 'README.md' 2>/dev/null | wc -l)
echo "👥 Personas: $persona_count"

# Count specs by status
echo ""
echo "📋 Specs by Status:"
for status in draft in-review approved in-progress done; do
    count=0
    for spec in specs/*/spec.md; do
        [ -f "$spec" ] || continue
        if grep -q "\`$status\`" "$spec" 2>/dev/null; then
            ((count++))
        fi
    done
    printf "   %-15s %d\n" "$status" "$count"
done

# Count conflicts by status
echo ""
echo "⚠️  Conflicts by Status:"
for status in detected under-discussion resolved; do
    count=0
    for conflict in conflicts/CONFLICT-*.md; do
        [ -f "$conflict" ] || continue
        if grep -q "\`$status\`" "$conflict" 2>/dev/null; then
            ((count++))
        fi
    done
    printf "   %-20s %d\n" "$status" "$count"
done

# Count reviews
review_count=$(find reviews -name 'REVIEW-*.md' 2>/dev/null | wc -l)
echo ""
echo "✅ Reviews: $review_count"

# Count source files
src_count=$(find src -type f ! -name '.gitkeep' 2>/dev/null | wc -l)
echo ""
echo "💻 Source Files: $src_count"

# Count test files
test_count=$(find tests -type f ! -name '.gitkeep' 2>/dev/null | wc -l)
echo "🧪 Test Files: $test_count"

echo ""
echo "========================================"
