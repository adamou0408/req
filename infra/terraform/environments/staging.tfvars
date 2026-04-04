# ──────────────────────────────────────────────
# Staging Environment
# ──────────────────────────────────────────────

environment       = "staging"
app_desired_count = 2
app_cpu           = 512
app_memory        = 1024
app_image_tag     = "staging-latest"

# Moderate thresholds
error_rate_threshold = 20
latency_threshold_ms = 3000

# Feedback loop enabled in staging
# feedback_webhook_url = "https://your-feedback-endpoint.example.com/staging"
