# ──────────────────────────────────────────────
# Demand-Driven Dev — Outputs
# ──────────────────────────────────────────────

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "alb_dns_name" {
  description = "Application Load Balancer DNS name"
  value       = aws_lb.main.dns_name
}

output "alb_url" {
  description = "Application URL"
  value       = "https://${aws_lb.main.dns_name}"
}

output "ecs_cluster_name" {
  description = "ECS Cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS Service name"
  value       = aws_ecs_service.app.name
}

output "sns_alerts_topic_arn" {
  description = "SNS topic ARN for alerts (feedback loop)"
  value       = aws_sns_topic.alerts.arn
}

output "environment" {
  description = "Current deployment environment"
  value       = var.environment
}
