mock_provider "aws" {
  mock_resource "aws_iam_openid_connect_provider" { defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" } }

  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_iam_policy" { defaults = { policy = jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["ec2:DescribeVpcs"], "Resource" : "*" }] }) } }
}
variables {
  aws_region                   = "eu-west-1"
  expected_aws_account_id      = "123456789012"
  staging_aws_account_id       = "210987654321"
  github_oidc_subject          = "repo:aqaPayam/NakhBot:environment:production"
  reviewed_deployment_policies = { "arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed" = sha256(jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["ec2:DescribeVpcs"], "Resource" : "*" }] })) }
}
run "exact_reviewed_production_custody" {
  command = apply
  assert {
    condition     = jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == var.github_oidc_subject && jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "Trust must pin the exact environment subject and STS audience."
  }
  assert {
    condition     = length(aws_iam_role_policy_attachment.reviewed) == 1 && aws_iam_role_policy_attachment.reviewed["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"].policy_arn == "arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed" && aws_iam_role.github_deploy.max_session_duration == 3600
    error_message = "Attach only the explicitly reviewed customer policy."
  }
  assert {
    condition     = aws_s3_bucket.terraform_state.force_destroy == false && aws_s3_bucket_versioning.terraform_state.versioning_configuration[0].status == "Enabled" && one(one(aws_s3_bucket_server_side_encryption_configuration.terraform_state.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256" && aws_s3_bucket_public_access_block.terraform_state.block_public_acls && aws_s3_bucket_public_access_block.terraform_state.block_public_policy && jsondecode(aws_s3_bucket_policy.terraform_state.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "State custody must be encrypted, private, versioned and TLS-only."
  }
}
run "exact_immutable_environment_subject" {
  command = apply
  variables { github_oidc_subject = "repo:aqaPayam@123/NakhBot@456:environment:production" }
  assert {
    condition     = jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:aqaPayam@123/NakhBot@456:environment:production"
    error_message = "Immutable identities must remain exact, never broadened to both formats."
  }
}
run "deny_branch_subject" {
  command = plan
  variables { github_oidc_subject = "repo:aqaPayam/NakhBot:ref:refs/heads/main" }
  expect_failures = [var.github_oidc_subject]
}
run "deny_other_repository" {
  command = plan
  variables { github_oidc_subject = "repo:other/NakhBot:environment:production" }
  expect_failures = [var.github_oidc_subject]
}
run "deny_staging_environment" {
  command = plan
  variables { github_oidc_subject = "repo:aqaPayam/NakhBot:environment:staging" }
  expect_failures = [var.github_oidc_subject]
}
run "deny_wildcard_subject" {
  command = plan
  variables { github_oidc_subject = "repo:aqaPayam/*:environment:production" }
  expect_failures = [var.github_oidc_subject]
}
run "deny_shared_account" {
  command = plan
  variables { staging_aws_account_id = "123456789012" }
  expect_failures = [var.staging_aws_account_id]
}
run "deny_wrong_observed_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "000000000001" }
  }
  expect_failures = [aws_iam_role.github_deploy]
}
run "deny_unreviewed_policy_bytes" {
  command = plan
  variables { reviewed_deployment_policies = { "arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed" = "0000000000000000000000000000000000000000000000000000000000000000" } }
  expect_failures = [aws_iam_role.github_deploy]
}
run "deny_managed_administrator_fallback" {
  command = plan
  variables { reviewed_deployment_policies = { "arn:aws:iam::aws:policy/AdministratorAccess" = "0000000000000000000000000000000000000000000000000000000000000000" } }
  expect_failures = [var.reviewed_deployment_policies]
}
run "deny_no_policies" {
  command = plan
  variables { reviewed_deployment_policies = {} }
  expect_failures = [var.reviewed_deployment_policies]
}
run "deny_all_actions" {
  command = plan
  override_data {
    target = data.aws_iam_policy.reviewed["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"]
    values = { policy = jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : "*", "Resource" : "*" }] }) }
  }
  variables { reviewed_deployment_policies = { "arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed" = sha256(jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : "*", "Resource" : "*" }] })) } }
  expect_failures = [aws_iam_role.github_deploy]
}
run "deny_service_wildcard" {
  command = plan
  override_data {
    target = data.aws_iam_policy.reviewed["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"]
    values = { policy = jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["iam:*"], "Resource" : "*" }] }) }
  }
  variables { reviewed_deployment_policies = { "arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed" = sha256(jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["iam:*"], "Resource" : "*" }] })) } }
  expect_failures = [aws_iam_role.github_deploy]
}
run "deny_allow_not_action" {
  command = plan
  override_data {
    target = data.aws_iam_policy.reviewed["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"]
    values = { policy = jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "NotAction" : ["iam:GetRole"], "Resource" : "*" }] }) }
  }
  variables { reviewed_deployment_policies = { "arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed" = sha256(jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "NotAction" : ["iam:GetRole"], "Resource" : "*" }] })) } }
  expect_failures = [aws_iam_role.github_deploy]
}
run "accept_explicit_deny" {
  command = apply
  override_data {
    target = data.aws_iam_policy.reviewed["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"]
    values = { policy = jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["ec2:DescribeVpcs"], "Resource" : "*" }, { "Effect" : "Deny", "NotAction" : ["iam:GetRole"], "Resource" : "*" }] }) }
  }
  variables { reviewed_deployment_policies = { "arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed" = sha256(jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["ec2:DescribeVpcs"], "Resource" : "*" }, { "Effect" : "Deny", "NotAction" : ["iam:GetRole"], "Resource" : "*" }] })) } }
}

run "deny_allow_not_resource" {
  command = plan
  override_data {
    target = data.aws_iam_policy.reviewed["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"]
    values = { policy = jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["iam:PutRolePolicy"], "NotResource" : "arn:aws:iam::123456789012:role/not-enough" }] }) }
  }
  variables { reviewed_deployment_policies = { "arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed" = sha256(jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["iam:PutRolePolicy"], "NotResource" : "arn:aws:iam::123456789012:role/not-enough" }] })) } }
  expect_failures = [aws_iam_role.github_deploy]
}
run "deny_foreign_customer_policy" {
  command = plan
  variables { reviewed_deployment_policies = { "arn:aws:iam::210987654321:policy/nakh-staging-deploy" = "0000000000000000000000000000000000000000000000000000000000000000" } }
  expect_failures = [var.reviewed_deployment_policies]
}
run "deny_foreign_partition_policy" {
  command = plan
  variables { reviewed_deployment_policies = { "arn:aws-cn:iam::123456789012:policy/nakh-production-deploy-reviewed" = sha256(jsonencode({ "Version" : "2012-10-17", "Statement" : [{ "Effect" : "Allow", "Action" : ["ec2:DescribeVpcs"], "Resource" : "*" }] })) } }
  expect_failures = [aws_iam_role.github_deploy]
}
run "canonical_policy_bytes_ignore_formatting" {
  command = plan
  override_data {
    target = data.aws_iam_policy.reviewed["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"]
    values = { policy = "{\n  \"Version\": \"2012-10-17\",\n  \"Statement\": [\n    {\n      \"Effect\": \"Allow\",\n      \"Action\": [\n        \"ec2:DescribeVpcs\"\n      ],\n      \"Resource\": \"*\"\n    }\n  ]\n}" }
  }
  assert {
    condition     = local.reviewed_policy_hashes["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"] == var.reviewed_deployment_policies["arn:aws:iam::123456789012:policy/nakh-production-deploy-reviewed"]
    error_message = "Canonical policy identity must survive formatting differences."
  }
}
