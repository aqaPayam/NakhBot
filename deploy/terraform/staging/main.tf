locals {
  required_capabilities = {
    network          = "private PostgreSQL and Redis paths"
    compute          = "autoscaling managed containers"
    database         = "managed PostgreSQL with PITR"
    cache_queue      = "managed Redis with TLS and no-eviction queue policy"
    secret_store     = "managed secrets and KMS"
    telemetry        = "OpenTelemetry export and paging"
    object_storage   = "private Cloudflare R2 with signed edge delivery"
    artifact_runtime = "signed OCI images"
  }
}

resource "terraform_data" "architecture_contract" {
  input = {
    environment            = var.environment
    primary_region         = var.primary_region
    service_min_replicas   = var.service_min_replicas
    required_capabilities  = local.required_capabilities
    architecture_reference = "docs/technical/12-deployment-and-scaling.md"
  }
}
