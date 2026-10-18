terraform {
  required_version = ">= 1.15.9, < 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.61.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.0"
    }
  }

  # Supply bucket, key, and region through -backend-config after bootstrap.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = var.expected_aws_account_id == null ? null : [var.expected_aws_account_id]

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "aqaPayam/NakhBot"
    }
  }
}
