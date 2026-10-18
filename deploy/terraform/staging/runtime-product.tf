# Fixed four-host composition. Values are non-secret configuration or full secret
# references. Provider secrets are provisioned separately, never copied into state.
variable "product_runtime" {
  description = "Reviewed optional product composition. Null keeps the existing inactive feature defaults. It does not activate services or authorize a launch."
  type = object({
    features                       = set(string)
    secret_arns                    = map(string)
    r2_endpoint                    = string
    r2_bucket                      = string
    media_cdn_host                 = string
    cloudflare_zone_id             = string
    deletion_cutover_evidence_hash = optional(string, "")
    review_note_key_id             = optional(string, "review-notes-v1")
    review_note_key_version        = optional(number, 1)
    report_snapshot_key_id         = optional(string, "report-snapshot-v1")
    report_snapshot_key_version    = optional(number, 1)
    media_signing_key_id           = optional(string, "media-v1")
    media_audience_key_id          = optional(string, "audience-v1")
    media_transport_key_id         = optional(string, "active-v1")
    deletion_confirmation_key_id   = optional(string, "delete-v1")
  })
  default  = null
  nullable = true

  validation {
    condition = var.product_runtime == null ? true : (
      can(regex("^https://[a-f0-9]{32}\\.r2\\.cloudflarestorage\\.com$", var.product_runtime.r2_endpoint)) &&
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.product_runtime.r2_bucket)) &&
      can(regex("^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$", var.product_runtime.media_cdn_host)) &&
      can(regex("^[a-f0-9]{32}$", var.product_runtime.cloudflare_zone_id)) &&
      alltrue([for id in [var.product_runtime.review_note_key_id, var.product_runtime.report_snapshot_key_id, var.product_runtime.media_signing_key_id, var.product_runtime.media_audience_key_id, var.product_runtime.media_transport_key_id, var.product_runtime.deletion_confirmation_key_id] : can(regex("^[A-Za-z0-9_-]{8,160}$", id))]) &&
      alltrue([for version in [var.product_runtime.review_note_key_version, var.product_runtime.report_snapshot_key_version] : version >= 1 && floor(version) == version])
    )
    error_message = "Product configuration requires canonical provider names, zone ID and explicit bounded writer identities."
  }
}

locals {
  product_manifest        = jsondecode(file("${path.module}/../../runtime-product.json"))
  product_features        = var.product_runtime == null ? toset([]) : var.product_runtime.features
  product_secret_names    = toset(flatten(values(local.product_manifest.secrets)))
  product_secret_arns     = var.product_runtime == null ? {} : var.product_runtime.secret_arns
  product_scanner_enabled = contains(local.product_features, "NAKH_MEDIA_INGESTION_ENABLED")

  product_environment = var.product_runtime == null ? [] : concat(
    [for name in sort(keys(local.product_manifest.features)) : { name = name, value = tostring(contains(local.product_features, name)) }],
    [
      { name = "NAKH_R2_ENDPOINT", value = var.product_runtime.r2_endpoint },
      { name = "NAKH_R2_BUCKET", value = var.product_runtime.r2_bucket },
      { name = "NAKH_R2_ACCESS_KEY_REF", value = "NAKH_R2_ACCESS_KEY" },
      { name = "NAKH_R2_SECRET_KEY_REF", value = "NAKH_R2_SECRET_KEY" },
      { name = "NAKH_MEDIA_CDN_HOST", value = var.product_runtime.media_cdn_host },
      { name = "NAKH_CLOUDFLARE_ZONE_ID", value = var.product_runtime.cloudflare_zone_id },
      { name = "NAKH_ADMIN_PUBLIC_ORIGIN", value = "https://${coalesce(var.public_hostname, "disabled.invalid")}" },
      { name = "NAKH_DELETION_CUTOVER_EVIDENCE_HASH", value = var.product_runtime.deletion_cutover_evidence_hash },
      { name = "NAKH_ADMIN_REVIEW_NOTE_KEY_ID", value = var.product_runtime.review_note_key_id },
      { name = "NAKH_ADMIN_REVIEW_NOTE_KEY_VERSION", value = tostring(var.product_runtime.review_note_key_version) },
      { name = "NAKH_REPORT_SNAPSHOT_KEY_ID", value = var.product_runtime.report_snapshot_key_id },
      { name = "NAKH_REPORT_SNAPSHOT_KEY_VERSION", value = tostring(var.product_runtime.report_snapshot_key_version) },
      { name = "NAKH_MEDIA_SIGNING_KEY_ID", value = var.product_runtime.media_signing_key_id },
      { name = "NAKH_MEDIA_AUDIENCE_KEY_ID", value = var.product_runtime.media_audience_key_id },
      { name = "NAKH_MEDIA_TRANSPORT_KEY_ID", value = var.product_runtime.media_transport_key_id },
      { name = "NAKH_MEDIA_TRANSPORT_KEY_REF", value = "NAKH_MEDIA_TRANSPORT_KEY" },
      { name = "NAKH_DELETION_CONFIRMATION_KEY_ID", value = var.product_runtime.deletion_confirmation_key_id },
      { name = "NAKH_CLAMAV_HOST", value = "127.0.0.1" },
      { name = "NAKH_CLAMAV_PORT", value = tostring(local.product_manifest.scanner.port) },
    ]
  )
  service_environment = concat(
    [for entry in local.common_environment : entry if !contains([for override in local.product_environment : override.name], entry.name)],
    local.product_environment
  )
  service_secrets = {
    for service in keys(local.services) : service => concat(local.runtime_secrets,
      var.product_runtime == null ? [] : [for name in local.product_manifest.secrets[service] : {
        name = name, valueFrom = lookup(local.product_secret_arns, name, "invalid")
      }]
    )
  }
  scanner_container = {
    name                   = "clamav"
    image                  = local.product_manifest.scanner.image
    user                   = local.product_manifest.scanner.user
    entryPoint             = local.product_manifest.scanner.entryPoint
    essential              = true
    readonlyRootFilesystem = false # The unprivileged vendor process owns its signature/log/temp paths.
    cpu                    = 1024
    memory                 = 4096
    environment            = [{ name = "CLAMAV_NO_MILTERD", value = "true" }]
    linuxParameters        = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } }
    healthCheck = {
      command  = local.product_manifest.scanner.healthCommand
      interval = 30, timeout = 10, retries = 10, startPeriod = 300
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["worker"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "clamav"
      }
    }
  }
}

resource "terraform_data" "product_runtime" {
  input = var.product_runtime == null ? "disabled" : "reviewed-profile"
  lifecycle {
    precondition {
      condition = var.product_runtime == null ? true : (
        local.product_manifest.schemaVersion == 1 &&
        length(setsubtract(local.product_features, toset(keys(local.product_manifest.features)))) == 0 &&
        alltrue([for feature, required in local.product_manifest.features : !contains(local.product_features, feature) || length(setsubtract(toset(required), local.product_features)) == 0])
      )
      error_message = "Product features must be known and include their existing runtime dependencies."
    }
    precondition {
      condition = var.product_runtime == null ? true : (
        toset(keys(local.product_secret_arns)) == local.product_secret_names &&
        alltrue([for arn in values(local.product_secret_arns) : can(regex("^arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$", arn))])
      )
      error_message = "Supply exactly the named full same-account/region provider secret ARNs; secret values are forbidden."
    }
    precondition {
      condition     = !contains(local.product_features, "NAKH_DELETION_WORKER_ENABLED") ? true : can(regex("^[a-f0-9]{64}$", var.product_runtime.deletion_cutover_evidence_hash))
      error_message = "Deletion composition requires the existing recorded cutover evidence hash; this is not erasure authority."
    }
    precondition {
      condition     = !contains(local.product_features, "NAKH_ADMINISTRATION_ENABLED") || local.dns_enabled
      error_message = "Administrator composition requires the reviewed HTTPS origin and DNS."
    }
  }
}
