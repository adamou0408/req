#!/bin/bash
# ──────────────────────────────────────────
# Coolify API Client Library
# AI 透過此腳本與 Coolify 互動
# ──────────────────────────────────────────
#
# Usage:
#   source infra/coolify/api.sh
#   coolify_health
#   coolify_list_projects
#   coolify_create_app "project_uuid" "staging" "server_uuid" ...
#
# Required env vars:
#   COOLIFY_URL          - Coolify instance URL (no trailing slash)
#   COOLIFY_API_TOKEN    - API Bearer token
# ──────────────────────────────────────────

set -euo pipefail

# ── Core HTTP helpers ─────────────────────

_coolify_get() {
  local path="$1"
  curl -sf \
    -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
    -H "Accept: application/json" \
    "${COOLIFY_URL}/api/v1${path}"
}

_coolify_post() {
  local path="$1"
  local data="${2:-{}}"
  curl -sf \
    -X POST \
    -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "$data" \
    "${COOLIFY_URL}/api/v1${path}"
}

_coolify_patch() {
  local path="$1"
  local data="${2:-{}}"
  curl -sf \
    -X PATCH \
    -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "$data" \
    "${COOLIFY_URL}/api/v1${path}"
}

_coolify_delete() {
  local path="$1"
  curl -sf \
    -X DELETE \
    -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
    -H "Accept: application/json" \
    "${COOLIFY_URL}/api/v1${path}"
}

# ── Health / Version ──────────────────────

coolify_health() {
  curl -sf "${COOLIFY_URL}/api/v1/health" 2>/dev/null
}

coolify_version() {
  _coolify_get "/version"
}

# ── Servers ───────────────────────────────

coolify_list_servers() {
  _coolify_get "/servers"
}

coolify_get_server() {
  _coolify_get "/servers/$1"
}

coolify_validate_server() {
  _coolify_get "/servers/$1/validate"
}

coolify_server_resources() {
  _coolify_get "/servers/$1/resources"
}

coolify_server_domains() {
  _coolify_get "/servers/$1/domains"
}

# ── Projects ──────────────────────────────

coolify_list_projects() {
  _coolify_get "/projects"
}

coolify_create_project() {
  local name="$1"
  local description="${2:-Managed by req framework}"
  _coolify_post "/projects" "{\"name\":\"${name}\",\"description\":\"${description}\"}"
}

coolify_get_project() {
  _coolify_get "/projects/$1"
}

coolify_delete_project() {
  _coolify_delete "/projects/$1"
}

# ── Environments ──────────────────────────

coolify_list_environments() {
  _coolify_get "/projects/$1/environments"
}

coolify_create_environment() {
  local project_uuid="$1"
  local env_name="$2"
  _coolify_post "/projects/${project_uuid}/environments" "{\"name\":\"${env_name}\"}"
}

coolify_get_environment() {
  local project_uuid="$1"
  local env_name="$2"
  _coolify_get "/projects/${project_uuid}/${env_name}"
}

coolify_delete_environment() {
  local project_uuid="$1"
  local env_name="$2"
  _coolify_delete "/projects/${project_uuid}/environments/${env_name}"
}

# ── Applications ──────────────────────────

coolify_list_apps() {
  _coolify_get "/applications"
}

coolify_get_app() {
  _coolify_get "/applications/$1"
}

coolify_update_app() {
  local uuid="$1"
  local data="$2"
  _coolify_patch "/applications/${uuid}" "$data"
}

coolify_delete_app() {
  _coolify_delete "/applications/$1"
}

# Create app from public git repo
coolify_create_app_public() {
  local data="$1"  # Full JSON payload
  _coolify_post "/applications/public" "$data"
}

# Create app from private repo via GitHub App
coolify_create_app_github() {
  local data="$1"
  _coolify_post "/applications/private-github-app" "$data"
}

# Create app from Dockerfile
coolify_create_app_dockerfile() {
  local data="$1"
  _coolify_post "/applications/dockerfile" "$data"
}

# Create app from Docker image
coolify_create_app_image() {
  local data="$1"
  _coolify_post "/applications/dockerimage" "$data"
}

# Create app from docker-compose
coolify_create_app_compose() {
  local data="$1"
  _coolify_post "/applications/dockercompose" "$data"
}

# ── Application Lifecycle ─────────────────

coolify_start_app() {
  _coolify_post "/applications/$1/start"
}

coolify_stop_app() {
  _coolify_post "/applications/$1/stop"
}

coolify_restart_app() {
  _coolify_post "/applications/$1/restart"
}

coolify_app_logs() {
  _coolify_get "/applications/$1/logs"
}

# ── Application Environment Variables ─────

coolify_list_app_envs() {
  _coolify_get "/applications/$1/envs"
}

coolify_create_app_env() {
  local app_uuid="$1"
  local key="$2"
  local value="$3"
  local is_build="${4:-false}"
  _coolify_post "/applications/${app_uuid}/envs" \
    "{\"key\":\"${key}\",\"value\":\"${value}\",\"is_build_time\":${is_build}}"
}

coolify_bulk_app_envs() {
  local app_uuid="$1"
  local data="$2"  # JSON array of env vars
  _coolify_patch "/applications/${app_uuid}/envs/bulk" "$data"
}

coolify_delete_app_env() {
  local app_uuid="$1"
  local env_uuid="$2"
  _coolify_delete "/applications/${app_uuid}/envs/${env_uuid}"
}

# ── Databases ─────────────────────────────

coolify_list_databases() {
  _coolify_get "/databases"
}

coolify_get_database() {
  _coolify_get "/databases/$1"
}

coolify_delete_database() {
  _coolify_delete "/databases/$1"
}

# Create database by type
coolify_create_postgresql() {
  _coolify_post "/databases/postgresql" "$1"
}

coolify_create_mysql() {
  _coolify_post "/databases/mysql" "$1"
}

coolify_create_mariadb() {
  _coolify_post "/databases/mariadb" "$1"
}

coolify_create_redis() {
  _coolify_post "/databases/redis" "$1"
}

coolify_create_mongodb() {
  _coolify_post "/databases/mongodb" "$1"
}

# Database lifecycle
coolify_start_database() {
  _coolify_post "/databases/$1/start"
}

coolify_stop_database() {
  _coolify_post "/databases/$1/stop"
}

coolify_restart_database() {
  _coolify_post "/databases/$1/restart"
}

# Database env vars
coolify_list_db_envs() {
  _coolify_get "/databases/$1/envs"
}

coolify_create_db_env() {
  local db_uuid="$1"
  local key="$2"
  local value="$3"
  _coolify_post "/databases/${db_uuid}/envs" \
    "{\"key\":\"${key}\",\"value\":\"${value}\",\"is_build_time\":false}"
}

# Database backups
coolify_list_db_backups() {
  _coolify_get "/databases/$1/backups"
}

coolify_create_db_backup() {
  local db_uuid="$1"
  local data="$2"
  _coolify_post "/databases/${db_uuid}/backups" "$data"
}

# ── Services (docker-compose stacks) ─────

coolify_list_services() {
  _coolify_get "/services"
}

coolify_create_service() {
  _coolify_post "/services" "$1"
}

coolify_get_service() {
  _coolify_get "/services/$1"
}

coolify_update_service() {
  _coolify_patch "/services/$1" "$2"
}

coolify_delete_service() {
  _coolify_delete "/services/$1"
}

coolify_start_service() {
  _coolify_post "/services/$1/start"
}

coolify_stop_service() {
  _coolify_post "/services/$1/stop"
}

coolify_restart_service() {
  _coolify_post "/services/$1/restart"
}

# ── Deployments ───────────────────────────

coolify_deploy() {
  local data="$1"  # { "uuid": "...", "force_rebuild": true }
  _coolify_post "/deploy" "$data"
}

coolify_list_deployments() {
  _coolify_get "/deployments"
}

coolify_get_deployment() {
  _coolify_get "/deployments/$1"
}

coolify_cancel_deployment() {
  _coolify_post "/deployments/$1/cancel"
}

coolify_app_deployments() {
  _coolify_get "/deployments/applications/$1"
}

# ── Deploy and wait ───────────────────────
# High-level: trigger deploy, poll status, return result

coolify_deploy_and_wait() {
  local app_uuid="$1"
  local max_wait="${2:-300}"  # seconds
  local poll_interval="${3:-10}"

  echo "Triggering deployment for ${app_uuid}..."
  local response
  response=$(_coolify_post "/deploy" "{\"uuid\":\"${app_uuid}\",\"force_rebuild\":true}")

  local deployment_uuid
  deployment_uuid=$(echo "$response" | grep -oP '"deployment_uuid"\s*:\s*"\K[^"]+' 2>/dev/null || echo "")

  if [ -z "$deployment_uuid" ]; then
    echo "Deployment triggered (no deployment UUID in response)"
    echo "$response"
    return 0
  fi

  echo "Deployment UUID: ${deployment_uuid}"
  echo "Polling status (max ${max_wait}s)..."

  local elapsed=0
  while [ "$elapsed" -lt "$max_wait" ]; do
    local status_response
    status_response=$(_coolify_get "/deployments/${deployment_uuid}" 2>/dev/null || echo "{}")
    local status
    status=$(echo "$status_response" | grep -oP '"status"\s*:\s*"\K[^"]+' 2>/dev/null || echo "unknown")

    case "$status" in
      finished)
        echo "Deployment finished successfully."
        return 0
        ;;
      failed|cancelled)
        echo "Deployment ${status}."
        echo "$status_response"
        return 1
        ;;
      *)
        echo "  Status: ${status} (${elapsed}s elapsed)"
        sleep "$poll_interval"
        elapsed=$((elapsed + poll_interval))
        ;;
    esac
  done

  echo "Deployment timed out after ${max_wait}s."
  return 1
}

# ── Resources (all types) ─────────────────

coolify_list_resources() {
  _coolify_get "/resources"
}

# ── Utility: generate random password ─────

coolify_random_password() {
  local length="${1:-32}"
  openssl rand -base64 "$length" | tr -dc 'a-zA-Z0-9' | head -c "$length"
}

# ── Utility: read local config ────────────

coolify_read_config() {
  local config_file="infra/coolify/config.local.yml"
  if [ -f "$config_file" ]; then
    cat "$config_file"
  else
    echo "No local config found at ${config_file}"
    return 1
  fi
}
