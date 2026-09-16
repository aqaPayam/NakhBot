# M2 Acceptance Evidence and Traceability

Status: automated implementation evidence complete; external staging acceptance blocked until the
private R2/CDN environment is provisioned. CI success is not provider evidence.

This ledger records what the default branch proves and what must still be observed in a real staging
environment. It must be updated with the immutable commit and CI run before staging acceptance.

## Acceptance ledger

| Evidence ID | Automated status | Reproducible evidence | Remaining external evidence |
|---|---|---|---|
| `ACC-008/M2-E2E` | complete | PostgreSQL lifecycle test hides one of two visible photos and proves synchronous Profile invalidation; restore proves completion recovery | repeat through the authenticated staging client route |
| `ACC-009/M2-CONCURRENCY` | complete | seven concurrent PostgreSQL assignments serialize to exactly six successes and one rejection | run the upload burst against real staging workers and R2 |
| `ACC-010/M2-FAILURE` | complete | validation coordinator fault injection proves a thumbnail write failure never calls atomic publication; PostgreSQL publication requires a verified thumbnail | inject the real object-provider failure before thumbnail completion |
| `ACC-011/M2-FAILURE` | complete | PostgreSQL-backed blur coordinator failure proves both visible photos and Profile completion remain unchanged and no blur row is published | repeat with the staging transformer/object adapter |
| `ACC-012/M2-LIFECYCLE` | complete | PostgreSQL moderation test hides the primary, promotes the deterministic visible replacement, and recomputes Profile completion in one mutation | exercise through the future M7-authorized moderator transport when available |
| `ACC-013/M2-PHOTO-DELETE` | component complete | PostgreSQL proves immediate grant denial, tombstones, single cleanup lease, stale-owner fencing, and completion; object adapter tests prove delete-plus-absence verification | prove ordinary R2 objects and CDN access are gone in real staging; full account/evidence deletion remains M7/M8-owned |

## Rule-to-code traceability

| Rule or risk | Primary implementation | Automated evidence |
|---|---|---|
| Authenticated Telegram ownership | Telegram photo adapter plus PostgreSQL Telegram identity resolver | strict update mapping, unknown-user denial, malformed metadata, and identity integration tests |
| Attempt admission and replay | ingestion handler and `PostgresMediaStore` | 20-way rolling-window race, server-clock boundary, coarse rejection, replay, and rollback tests |
| Bounded private quarantine | Telegram download, scanner, R2, and quarantine coordinators | redirect/path rejection, partial/oversize stream, scanner, checksum, lease, and crash-point tests |
| Decode and publication safety | Sharp transformer and `PostgresMediaValidationStore` | hostile fixture corpus, metadata stripping, decode limits, duplicate race, verified rendition, and thumbnail failure tests |
| Profile lifecycle | photo management handlers/store | slot race, primary race, duplicate-command replay, reorder/delete conflicts, moderation promotion, and completion recomputation tests |
| Private delivery | grant signer, PostgreSQL authorization, and edge verifier | tamper, expiry, audience/path/purpose binding, key rotation, cross-user denial, and private-response tests |
| Optional blur | blur coordinator/store | deterministic concurrency, stale-primary denial, transform/storage failure, and Profile preservation tests |
| Deletion and reconciliation | cleanup coordinator/store, R2 adapter, worker, and scheduler | partial failure, lease recovery, generation fencing, malicious-key rejection, cursor retry, and orphan grace tests |
| Privacy and telemetry | redacting logger, fixed M2 metric registries, opaque Telegram action tokens, and localized owner-menu model | redaction, bounded-label, callback-size, tamper, actor-binding, expiry, collision, malformed-state, no-identifier view-model, and exact reorder-state tests; provider identifiers, object keys, hashes, and cursor values are excluded |
| Telegram owner menu | localized presenter, bounded Bot API client, and private-chat delivery composition | localization-only model, inline-keyboard payload, fixed API origin/methods, token-safe failures, sender/chat binding, and callback acknowledgement tests |
| Migration safety | migrations `000010` through `000016` and verification SQL | empty/replay migration CI, PostgreSQL integration, restore smoke, and production container builds |

## Default-branch automated gate

The candidate must pass all of the following without a skipped M2 acceptance, security, or
concurrency test:

1. frozen dependency installation and production dependency audit;
2. formatting, lint, type checks, unit and contract tests;
3. PostgreSQL/Redis migration, integration, and concurrency tests;
4. production image builds and restore smoke;
5. dependency, secret, and infrastructure scans available under the repository plan.

Record for the staging candidate:

| Field | Required value |
|---|---|
| Commit | immutable 40-character default-branch SHA |
| CI run | successful GitHub Actions run URL for that SHA |
| Reviewer | named backend/security reviewer |
| Recorded at | UTC timestamp |

## Open release blockers

These items do not block continued provider-neutral development, but they block declaring M2
accepted or enabling its feature flags:

- private staging R2 bucket with public access disabled and separate ingestion/cleanup credentials;
- authenticated CDN/Worker domain connected to private R2, with current and previous signing keys;
- isolated, healthy ClamAV service reachable only by media workers;
- deployment secret injection for the Telegram token, R2 credentials, media transport key, delivery
  signing key, and Cloudflare purge token;
- production-scale media load results and real-provider timeout, partial-write, deletion, and orphan
  reconciliation evidence;
- completed [`m2-staging-acceptance.md`](../../deploy/runbooks/m2-staging-acceptance.md) with evidence,
  reviewer, and timestamps.

No placeholder endpoint, bucket, key reference, simulated object store, or local container result may
be entered as external staging evidence.
