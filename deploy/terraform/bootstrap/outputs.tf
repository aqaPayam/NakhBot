output "terraform_state_bucket" {
  value = aws_s3_bucket.terraform_state.id
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}

output "aws_account_id" {
  value = data.aws_caller_identity.current.account_id
}
