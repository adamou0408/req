# ──────────────────────────────────────────────
# Production Environment
# ──────────────────────────────────────────────

environment       = "prod"
app_desired_count = 3
app_cpu           = 1024
app_memory        = 2048
app_image_tag     = "prod-latest"

# Strict thresholds for production
error_rate_threshold = 5
latency_threshold_ms = 2000

# Feedback loop MUST be enabled in production
# feedback_webhook_url = "https://your-feedback-endpoint.example.com/prod"
