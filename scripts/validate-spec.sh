#!/usr/bin/env bash
# validate-spec.sh - Validate spec file format and completeness
#
# Usage: ./scripts/validate-spec.sh [spec-directory]
# Example: ./scripts/validate-spec.sh specs/user-search

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

errors=0
warnings=0

log_error() { echo -e "${RED}[ERROR]${NC} $1"; errors=$((errors + 1)); }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; warnings=$((warnings + 1)); }
log_ok() { echo -e "${GREEN}[OK]${NC} $1"; }

if [ $# -eq 0 ]; then
    echo "Usage: $0 <spec-directory>"
    echo "Example: $0 specs/user-search"
    exit 1
fi

SPEC_DIR="$1"
SPEC_FILE="$SPEC_DIR/spec.md"

echo "=== Validating spec: $SPEC_DIR ==="
echo ""

# Check spec.md exists
if [ ! -f "$SPEC_FILE" ]; then
    log_error "spec.md not found in $SPEC_DIR"
    exit 1
fi
log_ok "spec.md exists"

# Check for status field
if grep -q '## 狀態' "$SPEC_FILE" || grep -q '## Status' "$SPEC_FILE"; then
    log_ok "Status field found"
    # Check valid status
    if grep -qE '`(draft|in-review|approved|in-progress|done)`' "$SPEC_FILE"; then
        log_ok "Valid status value"
    else
        log_warn "Status value may not be set (still template placeholder)"
    fi
else
    log_error "Missing status field"
fi

# Check for source traceability
if grep -q '## 來源追溯' "$SPEC_FILE" || grep -q 'intake/' "$SPEC_FILE"; then
    log_ok "Source traceability section found"
else
    log_error "Missing source traceability (must link to intake/)"
fi

# Check for User Stories
if grep -q '使用者故事\|User Story\|作為.*我想要' "$SPEC_FILE"; then
    log_ok "User Stories found"
else
    log_error "No User Stories found"
fi

# Check for acceptance criteria
if grep -q '\- \[ \]' "$SPEC_FILE"; then
    log_ok "Acceptance criteria (checkboxes) found"
else
    log_warn "No acceptance criteria checkboxes found"
fi

# Check for conflict markers
if grep -q '⚠️' "$SPEC_FILE"; then
    log_warn "Conflict markers found — ensure conflicts are resolved before approval"
fi

# Check for open questions
if grep -q '開放問題\|Open Questions' "$SPEC_FILE"; then
    open_questions=$(grep -c '\- \[ \]' "$SPEC_FILE" 2>/dev/null || echo "0")
    if [ "$open_questions" -gt 0 ]; then
        log_warn "$open_questions open items (checkboxes) remain"
    fi
fi

# ── Review Checklist Consistency ──────────────
FEATURE_SLUG=$(basename "$SPEC_DIR")
SPEC_STATUS=$(grep -oP '`(draft|in-review|approved|in-progress|done)`' "$SPEC_FILE" | head -1 | tr -d '`')

# Find corresponding review file
REVIEW_FILE=$(find reviews/ -name "REVIEW-${FEATURE_SLUG}-*" -type f 2>/dev/null | head -1)

if [ -n "$REVIEW_FILE" ]; then
    log_ok "Review file found: $REVIEW_FILE"

    # Check review result
    REVIEW_RESULT=$(grep -oP '結果.*`\K(approved|rejected)' "$REVIEW_FILE" 2>/dev/null || echo "")

    if [ "$SPEC_STATUS" = "approved" ] || [ "$SPEC_STATUS" = "in-progress" ] || [ "$SPEC_STATUS" = "done" ]; then
        if [ "$REVIEW_RESULT" != "approved" ]; then
            log_error "Spec is '$SPEC_STATUS' but review result is not 'approved'"
        else
            log_ok "Review result matches spec status"
        fi

        # Check for unchecked items in an approved review
        UNCHECKED=$(grep -c '\- \[ \]' "$REVIEW_FILE" 2>/dev/null; true)
        UNCHECKED=${UNCHECKED:-0}
        if [ "$UNCHECKED" -gt 0 ] 2>/dev/null; then
            log_error "Review is approved but has $UNCHECKED unchecked items — checklist is inconsistent"
        else
            log_ok "All review checklist items are checked"
        fi
    fi

    # Check reviewer is filled in
    if grep -q '審核者.*待填' "$REVIEW_FILE" 2>/dev/null; then
        log_warn "Reviewer name is still '待填' (not filled in)"
    fi
else
    if [ "$SPEC_STATUS" = "approved" ] || [ "$SPEC_STATUS" = "in-progress" ] || [ "$SPEC_STATUS" = "done" ]; then
        log_warn "Spec is '$SPEC_STATUS' but no review file found in reviews/"
    fi
fi

echo ""
echo "=== Validation Summary ==="
echo -e "Errors:   ${RED}$errors${NC}"
echo -e "Warnings: ${YELLOW}$warnings${NC}"

if [ "$errors" -gt 0 ]; then
    echo -e "${RED}FAILED${NC} — fix errors before proceeding"
    exit 1
else
    echo -e "${GREEN}PASSED${NC}"
    exit 0
fi
