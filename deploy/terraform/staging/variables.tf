variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be staging or production."
  }
}

variable "primary_region" {
  description = "Selected managed-container and PostgreSQL region."
  type        = string
}

variable "service_min_replicas" {
  description = "Minimum API and gateway replicas across failure zones."
  type        = number
  default     = 2

  validation {
    condition     = var.service_min_replicas >= 2
    error_message = "Staging/production services require at least two replicas."
  }
}
