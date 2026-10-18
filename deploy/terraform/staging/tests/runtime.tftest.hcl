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
mock_provider "random" {
  mock_resource "random_password" {
    defaults = { result = "syntheticPasswordOnly123456789012345678901234567890" }
  }
}

variables {
  aws_region                = "eu-west-1"
  telegram_bot_token        = "123456789:synthetic-test-only-token"
  telegram_webhook_secret   = "synthetic-test-only-webhook-value-32"
  telegram_action_token_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}

run "inactive_defaults" {
  command = apply
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.service["worker"].container_definitions)) == 2 && aws_ecs_service.service["worker"].desired_count == 0
    error_message = "Default composition must preserve two containers and zero running services."
  }
}

run "reviewed_media_profile" {
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
