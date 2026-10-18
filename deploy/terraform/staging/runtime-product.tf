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
