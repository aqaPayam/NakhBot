variable "database_role_isolation_enabled" {
  description = "Provision fixed purpose credentials and require their drained native provisioning before activation. False preserves legacy inactive staging."
  type        = bool
  default     = false
}
