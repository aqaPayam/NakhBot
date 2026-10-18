output "terraform_state_bucket" { value = aws_s3_bucket.terraform_state.id }
output "github_deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
output "aws_account_id" { value = data.aws_caller_identity.current.account_id }
output "github_oidc_subject" { value = var.github_oidc_subject }
output "reviewed_policy_hashes" { value = local.reviewed_policy_hashes }
