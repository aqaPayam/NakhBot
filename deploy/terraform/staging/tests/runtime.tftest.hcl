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
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:nakh-staging/runtime-Abc123" }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:eu-west-1:123456789012:regional/webacl/nakh-synthetic/00000000-0000-4000-8000-000000000000" }
  }
}
# AWS is mocked. Real local random generation proves the credential encoding;
# random_bytes keeps its secret outputs sensitive and has no printable ID.

variables {
  aws_region                = "eu-west-1"
  telegram_bot_token        = "123456789:synthetic-test-only-token"
  telegram_webhook_secret   = "synthetic-test-only-webhook-value-32"
  telegram_action_token_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}

run "inactive_defaults" {
  module { source = "../modules/runtime" }
  command = apply
  assert {
    condition     = length(aws_nat_gateway.main) == 1 && aws_nat_gateway.main["shared"].subnet_id == values(aws_subnet.public)[0].id && alltrue([for az in ["eu-west-1a", "eu-west-1b"] : aws_route_table_association.private[az].route_table_id == aws_route_table.private["shared"].id])
    error_message = "Staging must preserve its existing single gateway and private route bindings."
  }
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.service["worker"].container_definitions)) == 2 && aws_ecs_service.service["worker"].desired_count == 0
    error_message = "Default composition must preserve two containers and zero running services."
  }
}

run "purpose_migration_target" {
  module { source = "../modules/runtime" }
  command   = apply
  state_key = "purpose-migration-only"
  variables { database_role_isolation_enabled = true }
  plan_options { target = [aws_ecs_task_definition.migration] }
  assert {
    condition     = output.database_role_isolation_enabled == true
    error_message = "Targeted registration must publish the selected isolation mode for the next controller phase."
  }
  assert {
    condition     = length(random_bytes.database_purpose) == 5 && length(jsondecode(aws_secretsmanager_secret_version.runtime.secret_string)) == 10
    error_message = "Targeted migration registration must also create all five protected purpose values."
  }
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].secrets) == 10
    error_message = "Only the migration task receives the owner and all five purpose references."
  }
}

run "purpose_service_bindings" {
  module { source = "../modules/runtime" }
  command = apply
  variables { database_role_isolation_enabled = true }
  assert {
    condition     = alltrue([for name, role in local.database_roles : can(regex("^postgresql://${role}:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]@[^?]+[?]sslmode=require$", jsondecode(aws_secretsmanager_secret_version.runtime.secret_string)[name]))]) && length(distinct([for name in keys(local.database_roles) : regex("^postgresql://[^:]+:([^@]+)@", jsondecode(aws_secretsmanager_secret_version.runtime.secret_string)[name])[0]])) == 5
    error_message = "Real local generation must produce five distinct canonical 32-byte passwords without printing them."
  }
  assert {
    condition     = alltrue([for name in ["api", "telegram-gateway", "worker", "scheduler"] : one([for entry in jsondecode(aws_ecs_task_definition.service[name].container_definitions)[0].secrets : entry.valueFrom if entry.name == "NAKH_DATABASE_URL"]) == "${aws_secretsmanager_secret.runtime.arn}:${name == "scheduler" ? "NAKH_SCHEDULER_DATABASE_URL" : "NAKH_USER_DATABASE_URL"}::"])
    error_message = "Every ordinary host must receive its fixed base purpose instead of the migration owner."
  }
  assert {
    condition     = alltrue([for name in ["api", "telegram-gateway", "worker", "scheduler"] : one([for entry in jsondecode(aws_ecs_task_definition.service[name].container_definitions)[0].environment : entry.value if entry.name == "NAKH_DATABASE_ROLE_ISOLATION_ENABLED"]) == "true" && aws_ecs_service.service[name].desired_count == 0])
    error_message = "Purpose configuration is enabled explicitly and never activates the fleet."
  }
  assert {
    condition     = length([for entry in jsondecode(aws_ecs_task_definition.service["api"].container_definitions)[0].secrets : entry if endswith(entry.name, "DATABASE_URL")]) == 2 && length([for entry in jsondecode(aws_ecs_task_definition.service["telegram-gateway"].container_definitions)[0].secrets : entry if endswith(entry.name, "DATABASE_URL")]) == 3 && length([for entry in jsondecode(aws_ecs_task_definition.service["worker"].container_definitions)[0].secrets : entry if endswith(entry.name, "DATABASE_URL")]) == 3 && length([for entry in jsondecode(aws_ecs_task_definition.service["scheduler"].container_definitions)[0].secrets : entry if endswith(entry.name, "DATABASE_URL")]) == 2
    error_message = "Hosts receive only their assigned number of purpose credentials."
  }
}

run "reviewed_media_profile" {
  module { source = "../modules/runtime" }
  command = apply
  variables {
    product_runtime = {
      features = ["NAKH_MEDIA_INGESTION_ENABLED"]
      secret_arns = {
        for name in toset(flatten(values(jsondecode(file("../../runtime-product.json")).secrets))) : name => "arn:aws:secretsmanager:eu-west-1:123456789012:secret:nakh-staging/${name}-Abc123"
      }
      r2_endpoint        = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com"
      r2_bucket          = "nakh-synthetic"
      media_cdn_host     = "media.example.com"
      cloudflare_zone_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.service["worker"].container_definitions)) == 3 && aws_ecs_task_definition.service["worker"].cpu == "2048" && aws_ecs_task_definition.service["worker"].memory == "8192"
    error_message = "Media composition requires its private scanner and sufficient task resources."
  }
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.migration.container_definitions)) == 1 && length(jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].secrets) == 5
    error_message = "Migrations must retain the minimal existing secret/feature composition."
  }
  assert {
    condition     = alltrue([for entry in jsondecode(aws_ecs_task_definition.service["scheduler"].container_definitions)[0].secrets : !contains(["NAKH_ADMIN_TOTP_KEYS", "NAKH_ADMIN_ACTION_KEY"], entry.name)])
    error_message = "Scheduler tasks cannot receive administrator keys."
  }
  assert {
    condition     = aws_ecs_service.service["worker"].desired_count == 0
    error_message = "A configured product profile does not authorize activation."
  }
}

run "staging_root_bootstrap" {
  command   = apply
  state_key = "staging-root-target"
  assert {
    condition     = output.ecs_cluster_name == "nakh-staging" && output.aws_account_id == "123456789012"
    error_message = "The guarded root must publish its own cluster and account after inactive bootstrap."
  }
}
run "staging_root_target" {
  command   = apply
  state_key = "staging-root-target"
  variables { database_role_isolation_enabled = true }
  plan_options { target = [module.runtime.aws_ecs_task_definition.migration] }
  assert {
    condition     = output.database_role_isolation_enabled && output.ecs_cluster_name == "nakh-staging" && output.aws_region == "eu-west-1" && length(keys(output.ecr_repository_urls)) == 4 && length(output.private_subnet_ids) == 2 && length(output.service_security_group_id) > 0 && length(output.runtime_secret_arn) > 0 && length(output.release_evidence_bucket) > 0 && output.release_default_capacity.min == 2 && output.release_default_capacity.max == 6
    error_message = "The staging wrapper must retain converged mode and cluster outputs."
  }
}
