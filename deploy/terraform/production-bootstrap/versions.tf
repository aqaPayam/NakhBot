terraform {
  required_version = ">= 1.15.9, < 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.61.0"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.expected_aws_account_id]

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = "production-bootstrap"
      ManagedBy   = "terraform"
      Repository  = var.github_repository
    }
  }
}
