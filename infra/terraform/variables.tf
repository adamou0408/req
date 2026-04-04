# ──────────────────────────────────────────────
# Demand-Driven Dev — Variables
# ──────────────────────────────────────────────

# ── Project ───────────────────────────────────

variable "project_name" {
  description = "Project name, used as prefix for all resources"
  type        = string
  default     = "demand-driven-dev"
}

variable "environment" {
  description = "Deployment environment (dev / staging / prod)"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
}

# ── AWS ───────────────────────────────────────

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-northeast-1"
}

variable "availability_zones" {
  description = "List of availability zones"
  type        = list(string)
  default     = ["ap-northeast-1a", "ap-northeast-1c"]
}

# ── Networking ────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

# ── Application ───────────────────────────────

variable "ecr_repository_url" {
  description = "ECR repository URL for the application image"
  type        = string
}

variable "app_image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "app_port" {
  description = "Port the application listens on"
  type        = number
  default     = 8080
}

variable "app_cpu" {
  description = "CPU units for the task (1024 = 1 vCPU)"
  type        = number
  default     = 256
}

variable "app_memory" {
  description = "Memory in MB for the task"
  type        = number
  default     = 512
}

variable "app_desired_count" {
  description = "Desired number of running tasks"
  type        = number
  default     = 2
}

# ── Monitoring / Feedback Loop ────────────────

variable "error_rate_threshold" {
  description = "Number of 5XX errors to trigger alarm"
  type        = number
  default     = 10
}

variable "latency_threshold_ms" {
  description = "Response latency threshold in milliseconds"
  type        = number
  default     = 3000
}

variable "feedback_webhook_url" {
  description = "Webhook URL for the feedback loop (receives SNS alerts, creates intake). Leave empty to disable."
  type        = string
  default     = ""
}
