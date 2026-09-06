output "aws_account_id" {
  description = "AWS account containing the isolated staging environment."
  value       = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  value = var.aws_region
}

output "ecr_repository_urls" {
  description = "Immutable image destinations keyed by service name."
  value       = { for name, repository in aws_ecr_repository.service : name => repository.repository_url }
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "migration_task_definition_arn" {
  value = aws_ecs_task_definition.migration.arn
}

output "private_subnet_ids" {
  value = values(aws_subnet.private)[*].id
}

output "service_security_group_id" {
  value = aws_security_group.services.id
}

output "load_balancer_dns_name" {
  value = aws_lb.public.dns_name
}

output "public_url" {
  value = local.dns_enabled ? "https://${var.public_hostname}" : null
}

output "runtime_secret_arn" {
  description = "Reference only; secret contents are never outputs."
  value       = aws_secretsmanager_secret.runtime.arn
}

output "operations_topic_arn" {
  value = aws_sns_topic.operations.arn
}

data "aws_caller_identity" "current" {}
