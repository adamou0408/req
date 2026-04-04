# ──────────────────────────────────────────────
# Development Environment
# ──────────────────────────────────────────────

environment       = "dev"
app_desired_count = 1
app_cpu           = 256
app_memory        = 512
app_image_tag     = "dev-latest"

# Relaxed thresholds for dev
error_rate_threshold = 50
latency_threshold_ms = 5000

# Feedback loop disabled in dev (optional)
feedback_webhook_url = ""
