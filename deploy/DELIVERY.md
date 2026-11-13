# NakhBot software delivery and operator handoff

This is the starting point for the person receiving, deploying and operating the software.
The deliverable is the application source, database migrations, four service-image builds,
media edge, configuration contracts, deployment controls, checks and operating procedures.
A recipient does not need the developer's PC, temporary `artifacts/` files or private trial
credentials to build the application. Hosting accounts and runtime credentials are supplied
by the recipient. This document does not authorize purchases or public release.

## Receive and verify

Clone the repository and select the exact agreed commit on `main`. Preserve its full SHA.
Require all six CI jobs for that exact commit: quality, four application/native shards and
PostgreSQL reliability. A green result on another commit does not qualify this source.
Use Node 24.19.0 and pnpm 11.19.0 as pinned by the Dockerfile and package metadata.

```sh
git rev-parse HEAD
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm check
```

For an offline source delivery, run the following from a clean checkout of the agreed commit.
Git archives committed files only; ignored secrets, local databases and developer artifacts
are excluded. Transfer the archive and checksum together. It is a source package, not an
operating database backup or a signed production release archive.

```sh
git archive --format=tar.gz --output=nakh-source.tar.gz HEAD
sha256sum nakh-source.tar.gz > nakh-source.tar.gz.sha256
```

The receiving operator checks `sha256sum -c nakh-source.tar.gz.sha256`. Extract it into a
new directory. The source SHA and exact CI run must accompany the transfer separately;
an extracted archive has no Git metadata. Protected AWS release workflows use the stronger
source/image attestation and immutable custody protocol described in their runbooks.

## Build and rehearse without a live bot

From the repository root, build all four images with the same source SHA:

```sh
SOURCE_SHA=$(git rev-parse HEAD)
for APP in api telegram-gateway worker scheduler; do
  docker build -f deploy/docker/Dockerfile \
    --build-arg APP="$APP" --build-arg NAKH_RELEASE="$SOURCE_SHA" \
    --build-arg NAKH_REPOSITORY=aqaPayam/NakhBot \
    -t "nakh-$APP:$SOURCE_SHA" .
done
```

For an extracted archive, set `SOURCE_SHA` to the full agreed SHA instead of running Git.
Record the actual image IDs/digests. These images run as non-root and contain the compiled
application and migrations. Keep all four on the same reviewed release.

Follow [local infrastructure and rehearsal](docker/README.md) and
[development setup](../CONTRIBUTING.md). The PowerShell rehearsal creates synthetic/local
infrastructure and removes its volumes unless `-KeepEnvironment` is selected. Never point
that rehearsal at a live database, reuse its fixed credentials online or run its cleanup
against an existing installation. CI supplies complete native integration qualification;
local startup alone is not evidence of every product journey.

## Choose the deployment route

| Route                | Entry point                                                                                                                                                                                               | Operator responsibility                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS staging          | [Staging infrastructure](terraform/staging/README.md), [controlled release](runbooks/m9-controlled-release.md)                                                                                            | Reviewed account/region, private state, OIDC, provider secrets, planned costs and release approval.                                                        |
| AWS production       | [Production infrastructure](terraform/production/README.md), [production bootstrap](terraform/production-bootstrap/README.md)                                                                             | Separate account custody, approved permissions, capacities/budget, protected production environment and production-specific signatures.                    |
| Existing private VPS | [VPS readiness/operator contract](../docs/technical/40-private-vps-readiness.md), [physical cutover](runbooks/private-vps-deletion-cutover.md), [backup/recovery](runbooks/private-vps-backup-restore.md) | Host-owned Docker/service configuration, verified database TLS, protected file secrets, actual image IDs, independent stop and encrypted off-host backups. |

AWS provisioning is implemented but requires operator-owned infrastructure and approval.
The existing private VPS is a separately configured, bounded pilot, not a portable production
Compose installer. Do not copy the developer's temporary deployment scripts or the local
rehearsal overlay and describe them as a fresh-server production installation. A VPS operator
must supply and review its host/service configuration under the linked contracts. Existing
live configuration and secrets require a separate private custody transfer if that particular
installation changes operator; they must never be put in the public source archive.

## Configuration and credentials

Use [.env.example](../.env.example) as the configuration inventory and
[runtime-product.json](runtime-product.json) for feature dependencies, per-service secret
requirements and the pinned private scanner. Defaults are intentionally fail-closed; copying
the example does not enable a complete live bot. The config parser validates enabled-module
requirements at startup. Keep secrets outside source, command arguments and public logs;
use the deployment's secret references or private file-reference mechanism. Give each service
only its required credentials. Preserve independent key domains and existing historical keys.

| Input                | Required setup                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL and Redis | Persistent storage, private networking, verified TLS and five database purpose credentials; migration/role operations use separate protected owner access.                      |
| Telegram             | Bot identity/token, HTTPS webhook endpoint and independent webhook secret; register `message`, `callback_query`, `pre_checkout_query` and preserve pending updates.             |
| Photos               | Private R2 bucket, scoped credentials, private ClamAV, signing/transport/audience keys and the [media edge](cloudflare/README.md) with HTTPS host and encrypted Worker secrets. |
| Administrator        | Existing verified native staff identity, scoped role permissions and authenticator enrollment through the protected operator; never bypass MFA.                                 |
| Payments             | Native package catalog, rendered purchase terms/support contact, independent financial key ring and matching reviewed policy digest.                                            |
| Operations           | HTTPS certificates/DNS, private health/alert route, backup public key and separately protected recovery private key, key-expiry inventory and independent stop ownership.       |

For Telegram Stars, use currency `XTR` and an empty external payment-provider token.
Never copy real charge IDs, invoice payloads, signing keys or saved user sessions into a demo.
Current owner-approved packages are 10/25/50/100 credits for 10/20/35/60 Stars; direct Nakh
costs 2 Stars. A different operator must review its own catalog, displayed terms and support
contact and capture the corresponding approval digest. Checkout revalidates the native offer,
original owner/session and durable consent; credit delivery follows a successful-payment
receipt, not merely a pre-checkout approval. Only one distinct checkout approval may reserve
an intent, including sibling invoice attempts. Exact provider redelivery remains idempotent.

## Install or update in order

1. Preserve the exact source, six-job CI evidence and all four image digests. Review the
   destination host/account, database, bot, configuration, key custody and costs.
2. Prepare private networking, persistent PostgreSQL/Redis, TLS, scanner, provider storage,
   HTTPS and protected secrets. Keep admission closed and invoice creation disabled.
3. Hold ingress/producers through the chosen release procedure. For an existing environment,
   take an encrypted backup and preserve queues, database volumes, financial keys and
   encrypted administrator credentials. Never initialize over existing data.
4. Run the selected image's migration, role-provisioning, schema/compatibility and purpose-role
   verification operations as prescribed by the chosen deployment workflow. Do not edit an
   applied migration or rewrite its recorded checksum. The current schema contains 172
   migrations; an update must use the target image's actual schema contract.
5. Start API, Telegram gateway, worker and scheduler, all on the reviewed images. Require
   readiness, actual image identity and native reference/catalog/role verification. Keep
   database/Redis/scanner ports private and app containers non-root with read-only roots.
6. Deploy the photo edge and verify private storage/scanning, HTTPS and authenticated webhook
   delivery. Verify approved Stars policy and financial key custody before enabling invoices.
7. Verify independent stop, alerts, graceful restart and an actual isolated encrypted-backup
   recovery. Stopping new product activity must preserve payment callbacks, corrections,
   refunds and support. Never discard pending Telegram updates as a release shortcut.
8. Prepare the source-bound reviewed canary through the protected operator, then explicitly
   approve bounded access. A trial invitation does not authorize unrestricted public access.

Keep free test top-ups disabled when real Stars purchases are enabled. Retained-data erasure
stays disabled until retention policies are approved. Return/fresh entry, support-body release
and orphan sweeping need their own review; do not enable every flag to make installation
appear complete. Ordinary deletion requires its configured worker/media cleanup dependencies.

## Operate and recover

Use [M7 operations](runbooks/m7-operations.md), [M8 operations](runbooks/m8-operations.md),
[private backup/recovery](runbooks/private-vps-backup-restore.md) and
[launch review](../docs/technical/38-m9-launch-review.md). Record actual outcomes privately.
Never restore an older database over later payment receipts. Rollback requires compatibility
with the current schema and custody; an old image tag is not sufficient. Preserve financial
key history and uncertain provider outcomes. Do not retry an ambiguous refund blindly.

Renew expiring provider credentials before extending an operating window. No deadline or
invitation from the developer's November 2026 private trial is a default for a new installation.
The recipient sets and reviews its own audience, stop time, credential lifetimes and staffing.

## Delivery acceptance versus launch acceptance

The owner accepts the software without further step-by-step manual UX testing. That decision
is not a fabricated provider receipt or evidence that a paid journey occurred. The recipient
can build and deploy the supplied software; it remains responsible for its credentials,
infrastructure, operational review and live release decision. Record actual payment/refund,
moderation, deletion/Return and real-user outcomes before certifying those launch conditions.
The [implementation handoff](../docs/technical/39-m9-verification-and-launch-handoff.md) and
[payment implementation](../docs/technical/40-stars-payment-implementation.md) distinguish
historical deployment evidence from current operating state.
