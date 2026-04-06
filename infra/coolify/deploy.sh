#!/bin/bash
# ──────────────────────────────────────
# Coolify Multi-Project Deploy Script
# 多專案 Coolify 部署腳本
# ──────────────────────────────────────
# Usage:
#   ./deploy.sh <project> <environment>
#   ./deploy.sh mrp staging
#   ./deploy.sh erp production
#
# Environment variables required:
#   COOLIFY_URL          - Coolify instance URL
#   COOLIFY_API_TOKEN    - API authentication token
#   COOLIFY_APP_UUID     - Target application UUID
#   HEALTH_CHECK_URL     - Health check endpoint (full URL)
#   HEALTH_RETRIES       - Number of health check retries
#   HEALTH_INTERVAL      - Seconds between retries
# ──────────────────────────────────────

set -euo pipefail

PROJECT="${1:?Usage: deploy.sh <project> <environment>}"
ENVIRONMENT="${2:?Usage: deploy.sh <project> <environment>}"

echo "🚀 Deploying ${PROJECT} to ${ENVIRONMENT}..."

# ── Step 1: Trigger deployment via Coolify API ──
echo "📡 Triggering Coolify deployment..."
DEPLOY_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "${COOLIFY_URL}/api/v1/deploy" \
  -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"uuid\": \"${COOLIFY_APP_UUID}\", \"force_rebuild\": true}")

HTTP_CODE=$(echo "$DEPLOY_RESPONSE" | tail -1)
BODY=$(echo "$DEPLOY_RESPONSE" | head -1)

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
  echo "❌ Coolify API returned HTTP ${HTTP_CODE}"
  echo "Response: ${BODY}"
  exit 1
fi

echo "✅ Deployment triggered successfully"

# ── Step 2: Wait for container to start ──
echo "⏳ Waiting 30s for container startup..."
sleep 30

# ── Step 3: Health check ──
echo "🏥 Running health check on ${HEALTH_CHECK_URL}..."
RETRIES="${HEALTH_RETRIES:-10}"
INTERVAL="${HEALTH_INTERVAL:-15}"

for i in $(seq 1 "$RETRIES"); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_CHECK_URL}" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Health check passed (attempt ${i}/${RETRIES})"
    echo ""
    echo "📊 Deployment Summary"
    echo "   Project:     ${PROJECT}"
    echo "   Environment: ${ENVIRONMENT}"
    echo "   Status:      SUCCESS"
    echo "   Health:      ${HEALTH_CHECK_URL} → 200 OK"
    exit 0
  fi
  echo "   Attempt ${i}/${RETRIES} — HTTP ${HTTP_CODE}, retrying in ${INTERVAL}s..."
  sleep "$INTERVAL"
done

# ── Step 4: Health check failed ──
echo ""
echo "❌ Health check failed after ${RETRIES} attempts"
echo ""
echo "📊 Deployment Summary"
echo "   Project:     ${PROJECT}"
echo "   Environment: ${ENVIRONMENT}"
echo "   Status:      FAILED"
echo "   Health:      ${HEALTH_CHECK_URL} → UNREACHABLE"
echo ""
echo "⏪ Please check Coolify dashboard for rollback options."
exit 1
