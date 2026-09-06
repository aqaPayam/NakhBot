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
  description = "This root is intentionally restricted to staging."
  type        = string
  default     = "staging"

  validation {
    condition     = var.environment == "staging"
    error_message = "Use this Terraform root only for staging."
  }
}

variable "aws_region" {
  description = "AWS region selected when the staging account is created."
  type        = string
}

variable "vpc_cidr" {
  description = "Private address range for the isolated staging VPC."
  type        = string
  default     = "10.42.0.0/16"

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
    error_message = "Activated staging services require at least two replicas."
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
  description = "Small staging class; resize from measured load before production."
  type        = string
  default     = "db.t4g.small"
}

variable "redis_engine_version" {
  description = "ElastiCache Redis OSS engine version supported in the selected region."
  type        = string
  default     = "7.1"
}

variable "redis_node_type" {
  description = "Small staging cache node; Redis is not authoritative product storage."
  type        = string
  default     = "cache.t4g.small"
}

variable "telegram_webhook_secret" {
  description = "Staging Telegram webhook secret. Pass through TF_VAR_telegram_webhook_secret; never commit it."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.telegram_webhook_secret) >= 32
    error_message = "telegram_webhook_secret must contain at least 32 characters."
  }
}

variable "telegram_bot_token" {
  description = "Token for the separate staging bot. Pass through TF_VAR_telegram_bot_token; never commit it."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.telegram_bot_token) >= 20
    error_message = "telegram_bot_token does not look like a Telegram bot token."
  }
}

variable "monthly_budget_usd" {
  description = "Staging monthly cost budget. The alert is created only when alert_email is set."
  type        = number
  default     = 250

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
  description = "Protect the staging database from accidental deletion."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Must remain false for accepted staging. Set true only for an intentional disposable rehearsal."
  type        = bool
  default     = false
}

variable "otel_collector_image" {
  description = "Pinned AWS Distro for OpenTelemetry collector sidecar image."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.49.0"
}
