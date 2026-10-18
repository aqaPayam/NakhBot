# Product runtime deployment composition

The existing staging root accepts an optional `product_runtime` object. Its
default is `null`: product features remain disabled, the scanner is absent and
`activate_services` remains independently false. A profile is configuration,
not permission to create resources, activate services or admit real users.

The manual deployment and rollback workflows read the non-secret JSON from
`STAGING_PRODUCT_RUNTIME`; an unset variable supplies `null`. Keep the reviewed
profile fixed throughout a release/recovery window, under the existing exclusive
operator-control requirement. Review it together with the selected source's
reference/config snapshot and approved service capacity. Never insert secret
values into this variable or a Terraform input file.

## Profile and secret references

`deploy/runtime-product.json` declares the fixed four hosts, existing feature
flags/dependencies, required secret field names and scanner pin. The profile
contains:

- `features`: the explicitly reviewed subset of those environment flag names;
- `secret_arns`: exactly the union of the manifest's named fields, each mapped
  to a full same-account/region Secrets Manager ARN;
- `r2_endpoint`, `r2_bucket`, `media_cdn_host`, `cloudflare_zone_id`;
- the optional explicit review-note/report-snapshot key IDs and versions,
  media signing/audience/transport key IDs and deletion confirmation key ID;
- `deletion_cutover_evidence_hash`, only when the existing deletion-worker
  prerequisite has genuinely been recorded.

Each referenced secret's entire string is the value consumed by its named
environment variable. Store individual keys/credentials and retained key-ring
JSON separately. ECS injects the fields selected for each host; the scheduler
does not receive administrator MFA/action keys. The operator's `totpSecretArn`
can reference the same retained key-ring secret used by the API and gateway.
No provider secret value is retrieved by Terraform. Existing generated database,
Redis and bot bootstrap credentials still require the protected Terraform state
described in the staging runbook.

The API/gateway receive the administrator, retained-evidence and account-control
references their enabled host adapters use. The worker receives media, deletion,
notification and Stars references. The scheduler receives ordinary media-cleanup
credentials. R2 permissions must retain the existing separate ordinary-media,
cleanup, deletion and administrator-evidence scopes. A secret reference does not
establish that its provider permissions are correct.

The profile validates known flags and their dependencies before service task
registration. Administrator composition requires the reviewed HTTPS/DNS origin.
Deletion composition still requires the native recorded cutover proof and its
existing startup verification. The profile grants no retained-data erasure or
Return approval authority. Migrations keep the original minimal five-secret,
single-container composition, independent of product-provider startup.

## Private scanner

Media ingestion adds one private `clamav` container to each worker task. It uses
the official ClamAV 1.5.4 Linux/AMD64 image pinned by manifest digest, UID/GID
1000, the vendor's unprivileged entry, dropped capabilities and no application
secrets or published ports. The vendor process needs writable signature/log/temp
paths; application and telemetry containers retain their existing read-only
root filesystems. Its task uses 2 vCPU/8 GiB, with a 4 GiB scanner limit. Review
the resulting cost/capacity plan before any billable deployment.

The worker waits for the scanner's declared health check. The release controller
accepts only the source-pinned scanner definition and requires its actual running
digest and healthy container/task state before recording release health. Missing,
substituted or unhealthy scanners prevent acceptance. The native ingestion
pipeline continues to own scan verdicts and publication checks.

CI exercises the actual `ClamdMalwareScanner` TCP adapter against this image as
an unprivileged container: clean content must pass and the standard harmless
EICAR antivirus test payload must be detected. The receipt records source,
image, scanner/signature versions and outcomes, without content or credentials.
This is a container transport rehearsal, not real R2/Telegram delivery or proof
of deployed signature-update freshness. See the
[vendor Docker procedure](https://github.com/Cisco-Talos/clamav/blob/main/README.Docker.md)
and [ECS container dependency rules](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html).

## Remaining launch work

Mock-provider Terraform tests verify inactive defaults, scanner resources,
per-host secret projection and migration isolation without AWS calls. Runtime
configuration/release tests verify actual parser compatibility and the unhealthy
scanner stop path. These cannot approve provider accounts, secret contents,
operator identities, network permissions, catalog/pricing/roles or live canaries.

Separate production infrastructure/release composition remains open. After that
independent preparation, provide the owner one consolidated setup checklist for
AWS, R2, domain and test/production bots, followed by explicit deployment/cost
review, real-provider/operator drills, privacy/security acceptance and the
controlled cohort/health observations. Retained erasure remains disabled pending
approved policy periods.
