data "aws_caller_identity" "current" {}

locals {
  state_bucket_name = "${var.project_name}-${data.aws_caller_identity.current.account_id}-${var.aws_region}-production-tfstate"
}

resource "aws_s3_bucket" "terraform_state" {
  bucket        = local.state_bucket_name
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Sid = "DenyInsecureTransport", Effect = "Deny", Action = "s3:*", Resource = [aws_s3_bucket.terraform_state.arn, "${aws_s3_bucket.terraform_state.arn}/*"], Principal = "*", Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}


data "aws_partition" "current" {}
data "aws_iam_policy" "reviewed" {
  for_each = var.reviewed_deployment_policies
  arn      = each.key
}
locals {
  reviewed_policy_hashes = { for arn, policy in data.aws_iam_policy.reviewed : arn => sha256(jsonencode(jsondecode(policy.policy))) }
  bounded_policy_shapes = { for arn, policy in data.aws_iam_policy.reviewed : arn => try(
    length(jsondecode(policy.policy).Statement) > 0 && alltrue([
      for statement in jsondecode(policy.policy).Statement : contains(["Allow", "Deny"], statement.Effect) && (
        statement.Effect == "Deny" ? true : (
          !contains(keys(statement), "NotAction") && !contains(keys(statement), "NotResource") &&
          !contains(keys(statement), "Principal") && !contains(keys(statement), "NotPrincipal") &&
          length(flatten([statement.Action])) > 0 && length(flatten([statement.Resource])) > 0 &&
          alltrue([for action in flatten([statement.Action]) : action != "*" && !endswith(action, ":*")])
        )
      )
  ]), false) }
  trust = {
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRoleWithWebIdentity",
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn },
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = var.github_oidc_subject
      } }
    }]
  }
}
resource "aws_iam_role" "github_deploy" {
  name                 = "${var.project_name}-production-github-deploy"
  description          = "Production environment OIDC with explicitly reviewed customer-managed policies."
  assume_role_policy   = jsonencode(local.trust)
  max_session_duration = 3600
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_aws_account_id
      error_message = "Observed AWS identity must match the separate production account."
    }
    precondition {
      condition = alltrue([for arn, digest in var.reviewed_deployment_policies :
        startswith(arn, "arn:${data.aws_partition.current.partition}:iam::${var.expected_aws_account_id}:policy/") &&
        local.reviewed_policy_hashes[arn] == digest && local.bounded_policy_shapes[arn]
      ])
      error_message = "Policy identity, canonical review digest and bounded shape must match. Blanket action grants and Allow NotAction/NotResource are denied; least-privilege review remains mandatory."
    }
  }
}
resource "aws_iam_role_policy_attachment" "reviewed" {
  for_each   = var.reviewed_deployment_policies
  role       = aws_iam_role.github_deploy.name
  policy_arn = each.key
}
