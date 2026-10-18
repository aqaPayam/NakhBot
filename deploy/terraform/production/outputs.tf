output "aws_account_id" {
  value = module.runtime.aws_account_id
}

output "aws_region" {
  value = module.runtime.aws_region
}

output "ecr_repository_urls" {
  value = module.runtime.ecr_repository_urls
}

output "ecs_cluster_name" {
  value = module.runtime.ecs_cluster_name
}

output "release_evidence_bucket" {
  value = module.runtime.release_evidence_bucket
}

output "release_default_capacity" {
  value = module.runtime.release_default_capacity
}

output "migration_task_definition_arn" {
  value = module.runtime.migration_task_definition_arn
}

output "private_subnet_ids" {
  value = module.runtime.private_subnet_ids
}

output "service_security_group_id" {
  value = module.runtime.service_security_group_id
}

output "load_balancer_dns_name" {
  value = module.runtime.load_balancer_dns_name
}

output "public_url" {
  value = module.runtime.public_url
}

output "runtime_secret_arn" {
  value = module.runtime.runtime_secret_arn
}

output "operations_topic_arn" {
  value = module.runtime.operations_topic_arn
}

output "database_role_isolation_enabled" {
  value = module.runtime.database_role_isolation_enabled
}

