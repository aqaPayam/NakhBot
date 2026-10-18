variable "database_role_isolation_enabled" {
  description = "Provision fixed purpose credentials and require their drained native provisioning before activation. False preserves legacy inactive staging."
  type        = bool
  default     = true
  validation {
    condition     = var.database_role_isolation_enabled
    error_message = "Production cannot use the migration owner for ordinary services."
  }
}
