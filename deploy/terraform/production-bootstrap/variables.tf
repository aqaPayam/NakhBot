variable "project_name" {
  type    = string
  default = "nakh"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.project_name))
    error_message = "Use a 2-20 character lowercase project name."
  }
}
variable "aws_region" { type = string }
variable "expected_aws_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_aws_account_id))
    error_message = "Pin the production AWS account ID."
  }
}
variable "staging_aws_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.staging_aws_account_id)) && var.staging_aws_account_id != var.expected_aws_account_id
    error_message = "Production must use a different account from staging."
  }
}
variable "github_repository" {
  type    = string
  default = "aqaPayam/NakhBot"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use the exact owner/repository."
  }
}
variable "github_oidc_subject" {
  description = "Exact observed production-environment subject, including immutable owner/repository IDs when enabled. No wildcard or branch subject."
  type        = string
  validation {
    condition = try(length(split(":", var.github_oidc_subject)) == 4 && split(":", var.github_oidc_subject)[0] == "repo" && split(":", var.github_oidc_subject)[2] == "environment" && split(":", var.github_oidc_subject)[3] == "production" && (
      split(":", var.github_oidc_subject)[1] == var.github_repository || (
        can(regex("^[A-Za-z0-9_.-]+@[1-9][0-9]*/[A-Za-z0-9_.-]+@[1-9][0-9]*$", split(":", var.github_oidc_subject)[1])) &&
        replace(split(":", var.github_oidc_subject)[1], "/@[1-9][0-9]*/", "") == var.github_repository
    )), false)
    error_message = "Supply this repository's exact production environment subject; verify its actual OIDC format first."
  }
}
variable "reviewed_deployment_policies" {
  description = "One to five existing production customer-managed policy ARNs mapped to the reviewed SHA-256 of jsonencode(jsondecode(policy)). No default permissions."
  type        = map(string)
  validation {
    condition = length(var.reviewed_deployment_policies) >= 1 && length(var.reviewed_deployment_policies) <= 5 && alltrue([
      for arn, digest in var.reviewed_deployment_policies : can(regex("^arn:aws(-us-gov|-cn)?:iam::${var.expected_aws_account_id}:policy/[A-Za-z0-9+=,.@_/-]{1,512}$", arn)) && can(regex("^[a-f0-9]{64}$", digest))
    ])
    error_message = "Supply 1-5 exact production customer-managed policy ARNs and their reviewed canonical SHA-256s."
  }
}
