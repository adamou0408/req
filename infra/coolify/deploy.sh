#!/bin/bash
# ──────────────────────────────────────
# Coolify Deploy Script
# AI 和 CI/CD 共用的部署腳本
# ──────────────────────────────────────
#
# Usage:
#   ./deploy.sh <environment>
#   ./deploy.sh staging
#   ./deploy.sh production
#
# Environment variables required:
#   COOLIFY_URL          - Coolify instance URL
#   COOLIFY_API_TOKEN    - API authentication token
#   COOLIFY_APP_UUID     - Target application UUID
#
# Optional:
#   HEALTH_CHECK_URL     - Health check endpoint (full URL)
#   HEALTH_RETRIES       - Number of health check retries (default: 10)
#   HEALTH_INTERVAL      - Seconds between retries (default: 15)
# ──────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVIRONMENT="${1:?Usage: deploy.sh <environment>}"

# Source API client library
source "${SCRIPT_DIR}/api.sh"

echo "🚀 Deploying to ${ENVIRONMENT}..."

# ── Step 1: Validate connection ───────
echo "📡 Validating Coolify connection..."
if ! coolify_health > /dev/null 2>&1; then
  echo "❌ Cannot reach Coolify at ${COOLIFY_URL}"
  exit 1
fi
echo "✅ Coolify is reachable"

# ── Step 2: Deploy via API ────────────
echo "📡 Triggering deployment..."
coolify_deploy_and_wait "${COOLIFY_APP_UUID}" 300 10
DEPLOY_EXIT=$?

if [ "$DEPLOY_EXIT" -ne 0 ]; then
  echo "❌ Deployment failed"
  exit 1
fi

# ── Step 3: Health check (if URL provided) ──
if [ -n "${HEALTH_CHECK_URL:-}" ]; then
  echo "🏥 Running health check on ${HEALTH_CHECK_URL}..."
  RETRIES="${HEALTH_RETRIES:-10}"
  INTERVAL="${HEALTH_INTERVAL:-15}"

  for i in $(seq 1 "$RETRIES"); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_CHECK_URL}" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
      echo "✅ Health check passed (attempt ${i}/${RETRIES})"
      break
    fi
    if [ "$i" -eq "$RETRIES" ]; then
      echo "❌ Health check failed after ${RETRIES} attempts"
      echo ""
      echo "📊 Deployment Summary"
      echo "   Environment: ${ENVIRONMENT}"
      echo "   Status:      HEALTH CHECK FAILED"
      echo "   Health:      ${HEALTH_CHECK_URL} → HTTP ${HTTP_CODE}"
      exit 1
    fi
    echo "   Attempt ${i}/${RETRIES} — HTTP ${HTTP_CODE}, retrying in ${INTERVAL}s..."
    sleep "$INTERVAL"
  done
fi

# ── Step 4: Success ───────────────────
echo ""
echo "📊 Deployment Summary"
echo "   Environment: ${ENVIRONMENT}"
echo "   Status:      SUCCESS"
[ -n "${HEALTH_CHECK_URL:-}" ] && echo "   Health:      ${HEALTH_CHECK_URL} → 200 OK"
exit 0
