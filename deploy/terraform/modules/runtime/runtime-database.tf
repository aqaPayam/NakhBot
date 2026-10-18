variable "database_role_isolation_enabled" {
  description = "Provision fixed purpose credentials and require their drained native provisioning before activation. False preserves legacy inactive staging."
  type        = bool
  default     = false
  validation {
    condition     = var.environment != "production" || var.database_role_isolation_enabled
    error_message = "Production requires fixed database purposes."
  }
}

locals {
  database_roles = {
    NAKH_USER_DATABASE_URL        = "nakh_user"
    NAKH_FINANCIAL_DATABASE_URL   = "nakh_financial"
    NAKH_ADMIN_DATABASE_URL       = "nakh_administration"
    NAKH_MAINTENANCE_DATABASE_URL = "nakh_maintenance"
    NAKH_SCHEDULER_DATABASE_URL   = "nakh_scheduler"
  }
  database_extra_fields = {
    api              = ["NAKH_ADMIN_DATABASE_URL"]
    telegram-gateway = ["NAKH_FINANCIAL_DATABASE_URL", "NAKH_ADMIN_DATABASE_URL"]
    worker           = ["NAKH_FINANCIAL_DATABASE_URL", "NAKH_MAINTENANCE_DATABASE_URL"]
    scheduler        = ["NAKH_FINANCIAL_DATABASE_URL"]
  }
  purpose_database_urls = {
    for name, credential in random_bytes.database_purpose : name => "postgresql://${local.database_roles[name]}:${replace(replace(trimsuffix(credential.base64, "="), "+", "-"), "/", "_")}@${aws_db_instance.postgres.address}:5432/nakh?sslmode=require"
  }
  database_service_secrets = {
    for service in keys(local.services) : service => !var.database_role_isolation_enabled ? local.runtime_secrets : concat(
      [for entry in local.runtime_secrets : entry if entry.name != "NAKH_DATABASE_URL"],
      [{ name = "NAKH_DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:${service == "scheduler" ? "NAKH_SCHEDULER_DATABASE_URL" : "NAKH_USER_DATABASE_URL"}::" }],
      [for name in local.database_extra_fields[service] : { name = name, valueFrom = "${aws_secretsmanager_secret.runtime.arn}:${name}::" }]
    )
  }
  database_migration_secrets = concat(local.runtime_secrets, [for name in(var.database_role_isolation_enabled ? sort(keys(local.database_roles)) : []) : {
    name = name, valueFrom = "${aws_secretsmanager_secret.runtime.arn}:${name}::"
  }])
}

resource "random_bytes" "database_purpose" {
  for_each = var.database_role_isolation_enabled ? local.database_roles : {}
  length   = 32
}

output "database_role_isolation_enabled" {
  value      = var.database_role_isolation_enabled
  depends_on = [aws_ecs_task_definition.migration]
}
