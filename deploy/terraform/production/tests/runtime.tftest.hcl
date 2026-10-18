mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-1a", "eu-west-1b"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/nakh-synthetic" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:eu-west-1:123456789012:nakh-synthetic" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/nakh-synthetic/1234567890123456" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/nakh-synthetic/1234567890123456" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:eu-west-1:123456789012:task-definition/nakh-synthetic:1" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:nakh-production/runtime-Abc123" }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:eu-west-1:123456789012:regional/webacl/nakh-synthetic/00000000-0000-4000-8000-000000000000" }
  }
}
# AWS is mocked. Real local random generation proves the credential encoding;
# random_bytes keeps its secret outputs sensitive and has no printable ID.

variables {
  aws_region                      = "eu-west-1"
  environment                     = "production"
  expected_aws_account_id         = "123456789012"
  staging_aws_account_id          = "210987654321"
  database_role_isolation_enabled = true
  database_instance_class         = "db.t4g.medium"
  redis_node_type                 = "cache.t4g.small"
  monthly_budget_usd              = 1000 # Synthetic test input, not a price or spending approval.
  telegram_bot_token              = "123456789:synthetic-production-only-token"
  telegram_webhook_secret         = "synthetic-production-webhook-value-32"
  telegram_action_token_key       = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}

run "production_inactive_runtime" {
  module { source = "../modules/runtime" }
  command = apply
  assert {
    condition     = length(aws_nat_gateway.main) == 2 && alltrue([for az in ["eu-west-1a", "eu-west-1b"] : aws_nat_gateway.main[az].subnet_id == aws_subnet.public[az].id && aws_route.private_egress[az].nat_gateway_id == aws_nat_gateway.main[az].id && aws_route_table_association.private[az].route_table_id == aws_route_table.private[az].id])
    error_message = "Each production AZ requires its own NAT and matching private route."
  }
  assert {
    condition     = aws_db_instance.postgres.multi_az && aws_db_instance.postgres.storage_encrypted && !aws_db_instance.postgres.publicly_accessible && aws_db_instance.postgres.deletion_protection && !aws_db_instance.postgres.skip_final_snapshot && aws_db_instance.postgres.backup_retention_period >= 7
    error_message = "Production database safeguards cannot inherit disposable staging settings."
  }
  assert {
    condition     = alltrue([for service in ["api", "telegram-gateway", "worker", "scheduler"] : aws_ecs_service.service[service].desired_count == 0 && one([for entry in jsondecode(aws_ecs_task_definition.service[service].container_definitions)[0].environment : entry.value if entry.name == "NAKH_ENV"]) == "production"]) && output.database_role_isolation_enabled
    error_message = "Production remains inactive and uses production configuration with purpose credentials."
  }
}
run "production_root_bootstrap" {
  command   = apply
  state_key = "production-root-target"
  assert {
    condition     = output.ecs_cluster_name == "nakh-production" && output.aws_account_id == "123456789012"
    error_message = "The guarded root must publish its own cluster and account after inactive bootstrap."
  }
}
run "production_root_target" {
  command   = apply
  state_key = "production-root-target"
  plan_options { target = [module.runtime.aws_ecs_task_definition.migration] }
  assert {
    condition     = output.database_role_isolation_enabled && output.ecs_cluster_name == "nakh-production" && output.aws_region == "eu-west-1" && length(keys(output.ecr_repository_urls)) == 4 && length(output.private_subnet_ids) == 2 && length(output.service_security_group_id) > 0 && length(output.runtime_secret_arn) > 0 && length(output.release_evidence_bucket) > 0 && output.release_default_capacity.min == 2 && output.release_default_capacity.max == 6 && output.aws_account_id == "123456789012"
    error_message = "The actual production root must publish the guarded targeted-registration outputs."
  }
}
run "deny_shared_account" {
  module { source = "../modules/runtime" }
  command = plan
  variables { staging_aws_account_id = "123456789012" }
  expect_failures = [var.staging_aws_account_id]
}
run "deny_wrong_caller_account" {
  module { source = "../modules/runtime" }
  command = plan
  variables { expected_aws_account_id = "999999999999" }
  expect_failures = [var.expected_aws_account_id]
}
run "deny_owner_fallback" {
  module { source = "../modules/runtime" }
  command = plan
  variables { database_role_isolation_enabled = false }
  expect_failures = [var.database_role_isolation_enabled]
}
run "deny_disposable_database" {
  module { source = "../modules/runtime" }
  command = plan
  variables { skip_final_snapshot = true }
  expect_failures = [var.skip_final_snapshot]
}

run "deny_unprotected_database" {
  module { source = "../modules/runtime" }
  command = plan
  variables { deletion_protection = false }
  expect_failures = [var.deletion_protection]
}
