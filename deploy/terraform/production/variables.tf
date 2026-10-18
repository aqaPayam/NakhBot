variable "project_name" {
  description = "Short lowercase name used in AWS resource names."
  type        = string
  default     = "nakh"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.project_name))
    error_message = "project_name must be 2-20 lowercase letters, digits, or hyphens."
  }
}

variable "environment" {
  description = "This root is intentionally restricted to production."
  type        = string
  default     = "production"

  validation {
    condition     = var.environment == "production"
    error_message = "Use this Terraform root only for production."
  }
}

variable "aws_region" {
  description = "AWS region for the separate production account."
  type        = string
}

variable "vpc_cidr" {
  description = "Private address range for the isolated staging VPC."
  type        = string
  default     = "10.43.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR."
  }
}

variable "public_hostname" {
  description = "HTTPS hostname such as staging.example.com. Null keeps all services disabled."
  type        = string
  default     = null
  nullable    = true
}

variable "route53_zone_id" {
  description = "Route53 hosted-zone ID for public_hostname. Null keeps all services disabled."
  type        = string
  default     = null
  nullable    = true
}

variable "image_tag" {
  description = "Immutable Git commit used for every service image. Never use latest."
  type        = string
  default     = "bootstrap"

  validation {
    condition     = var.image_tag != "latest" && can(regex("^[A-Za-z0-9_.-]{1,128}$", var.image_tag))
    error_message = "image_tag must be an immutable valid OCI tag and cannot be latest."
  }
}

variable "image_digests" {
  description = "Exact four image digests verified against the selected source and deployment workflow. Empty only for inactive bootstrap."
  type        = map(string)
  default     = {}

  validation {
    condition = length(var.image_digests) == 0 || (
      toset(keys(var.image_digests)) == toset(["api", "telegram-gateway", "worker", "scheduler"]) &&
      alltrue([for digest in values(var.image_digests) : can(regex("^sha256:[a-f0-9]{64}$", digest))])
    )
    error_message = "image_digests must contain exactly the four reviewed SHA-256 digests."
  }
}

variable "activate_services" {
  description = "Explicit release gate. False creates infrastructure with zero running tasks."
  type        = bool
  default     = false
}

variable "service_min_replicas" {
  description = "Minimum replicas for each activated service."
  type        = number
  default     = 2

  validation {
    condition     = var.service_min_replicas >= 2
    error_message = "Activated production services require at least two replicas."
  }
}

variable "release_scaling_hold" {
  description = "Hold all scaling categories with min zero during the controlled release. Restore only after selected-image health checks."
  type        = bool
  default     = false
}

variable "release_capacity" {
  description = "Private release-controller snapshot preserving per-service capacity and original operator scaling suspensions."
  type = map(object({
    desired = number
    min     = number
    max     = number
    suspended = object({
      DynamicScalingInSuspended  = bool
      DynamicScalingOutSuspended = bool
      ScheduledScalingSuspended  = bool
    })
  }))
  default = {}
  validation {
    condition = length(var.release_capacity) == 0 || (
      toset(keys(var.release_capacity)) == toset(["api", "telegram-gateway", "worker", "scheduler"]) &&
      alltrue([for c in values(var.release_capacity) : c.min >= 2 && c.max <= 100 && c.desired >= c.min && c.desired <= c.max && floor(c.min) == c.min && floor(c.max) == c.max && floor(c.desired) == c.desired])
    )
    error_message = "Release capacity must preserve exactly four bounded whole-number service policies."
  }
}

variable "service_max_replicas" {
  description = "Maximum replicas for target-tracking autoscaling."
  type        = number
  default     = 6

  validation {
    condition     = var.service_max_replicas >= var.service_min_replicas
    error_message = "service_max_replicas must be at least service_min_replicas."
  }
}

variable "postgres_engine_version" {
  description = "Reviewed RDS PostgreSQL minor matching CI and restore tooling."
  type        = string
  default     = "17.11"
}

variable "database_instance_class" {
  description = "Required production database class from the reviewed capacity and cost plan."
  type        = string
}

variable "redis_engine_version" {
  description = "ElastiCache Redis OSS engine version supported in the selected region."
  type        = string
  default     = "7.1"
}

variable "redis_node_type" {
  description = "Required production cache class from the reviewed capacity and cost plan."
  type        = string
}

variable "telegram_webhook_secret" {
  description = "Production Telegram webhook secret. Pass through TF_VAR_telegram_webhook_secret; never commit it."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.telegram_webhook_secret) >= 32
    error_message = "telegram_webhook_secret must contain at least 32 characters."
  }
}

variable "telegram_bot_token" {
  description = "Token for the separate production bot. Pass through TF_VAR_telegram_bot_token; never commit it."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.telegram_bot_token) >= 20
    error_message = "telegram_bot_token does not look like a Telegram bot token."
  }
}

variable "telegram_action_token_key" {
  description = "Base64url-encoded 32-byte HMAC key for opaque Telegram actions. Pass through TF_VAR_telegram_action_token_key; never commit it."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{43}$", var.telegram_action_token_key))
    error_message = "telegram_action_token_key must be an unpadded base64url-encoded 32-byte key."
  }
}

variable "monthly_budget_usd" {
  description = "Explicit cost-alert threshold, not a cost estimate or spending authorization."
  type        = number

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be positive."
  }
}

variable "alert_email" {
  description = "Operational email for budget and alarm notifications. Null creates no subscription."
  type        = string
  default     = null
  nullable    = true
}

variable "deletion_protection" {
  description = "Protect the production database from accidental deletion."
  type        = bool
  default     = true
  validation {
    condition     = var.deletion_protection
    error_message = "Production requires database deletion protection."
  }
}

variable "skip_final_snapshot" {
  description = "Must remain false for accepted production. Set true only for an intentional disposable rehearsal."
  type        = bool
  default     = false
  validation {
    condition     = !var.skip_final_snapshot
    error_message = "Production cannot skip its final database snapshot."
  }
}

variable "otel_collector_image" {
  description = "Pinned AWS Distro for OpenTelemetry collector sidecar image."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.49.0"
}

variable "account_deletion_monitoring_enabled" {
  description = "Enable M8 alarms/dashboard only after the deletion worker and actual metric delivery are accepted. Does not enable deletion or retained-data release."
  type        = bool
  default     = false
}
variable "account_deletion_due_age_seconds" {
  description = "Operational overdue-work alarm; not an approved retention duration."
  type        = number
  default     = 900
  validation {
    condition     = var.account_deletion_due_age_seconds >= 60 && var.account_deletion_due_age_seconds <= 604800 && floor(var.account_deletion_due_age_seconds) == var.account_deletion_due_age_seconds
    error_message = "Deletion due age must be whole seconds between 60 and 604800."
  }
}
variable "account_deletion_oldest_age_seconds" {
  description = "Operational pending-deletion age alarm; not a legal retention deadline."
  type        = number
  default     = 3600
  validation {
    condition     = var.account_deletion_oldest_age_seconds >= 60 && var.account_deletion_oldest_age_seconds <= 604800 && floor(var.account_deletion_oldest_age_seconds) == var.account_deletion_oldest_age_seconds
    error_message = "Deletion oldest age must be whole seconds between 60 and 604800."
  }
}

variable "expected_aws_account_id" {
  description = "Required production AWS account; the provider refuses any other caller account."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_aws_account_id)) && var.expected_aws_account_id != var.staging_aws_account_id
    error_message = "Production and staging require distinct canonical AWS account IDs."
  }
}
variable "staging_aws_account_id" {
  description = "Required distinct staging AWS account."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9]{12}$", var.staging_aws_account_id))
    error_message = "Production and staging require distinct canonical AWS account IDs."
  }
}
