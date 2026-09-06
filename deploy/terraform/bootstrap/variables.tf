variable "project_name" {
  type    = string
  default = "nakh"
}

variable "aws_region" {
  description = "Region chosen for the staging account and Terraform state bucket."
  type        = string
}

variable "github_repository" {
  description = "Exact GitHub owner/repository allowed to assume the deployment role."
  type        = string
  default     = "aqaPayam/NakhBot"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use owner/repository format."
  }
}
