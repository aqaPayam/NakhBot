# Operational release metadata only. No catalog/admin snapshots or user bodies.
# There is no retention-period default or Object Lock compliance claim here.
resource "aws_s3_bucket" "release_evidence" {
  bucket        = "${local.name}-release-${substr(sha256("${data.aws_caller_identity.current.account_id}:${var.aws_region}"), 0, 16)}"
  force_destroy = false
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "release_evidence" {
  bucket                  = aws_s3_bucket.release_evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "release_evidence" {
  bucket = aws_s3_bucket.release_evidence.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "release_evidence" {
  bucket = aws_s3_bucket.release_evidence.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "release_evidence" {
  bucket = aws_s3_bucket.release_evidence.id
  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_iam_policy_document" "release_evidence" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.release_evidence.arn, "${aws_s3_bucket.release_evidence.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "RequireConditionalCreate"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.release_evidence.arn}/releases/*", "${aws_s3_bucket.release_evidence.arn}/archives/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }
  statement {
    sid       = "PreserveReleaseHistory"
    effect    = "Deny"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.release_evidence.arn}/releases/*", "${aws_s3_bucket.release_evidence.arn}/archives/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "release_evidence" {
  bucket = aws_s3_bucket.release_evidence.id
  policy = data.aws_iam_policy_document.release_evidence.json
  depends_on = [
    aws_s3_bucket_public_access_block.release_evidence,
    aws_s3_bucket_ownership_controls.release_evidence,
    aws_s3_bucket_server_side_encryption_configuration.release_evidence,
    aws_s3_bucket_versioning.release_evidence,
  ]
}
