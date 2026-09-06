# M2 Execution Guide — Secure Media Ingestion, Lifecycle, and Delivery

Status: approved implementation guide for M2. This document tells the implementation team exactly what to build, in what order, and what evidence is required before M2 is accepted.

## 1. Authority and milestone boundary

This guide translates the canonical domain and technical documents into executable work. It does not redefine product behavior. Resolve conflicts in this order:

1. `docs/domain/` owns user-visible behavior, states, limits, and acceptance scenarios.
2. [`03-data-architecture.md`](03-data-architecture.md), [`05-transactions-events-and-jobs.md`](05-transactions-events-and-jobs.md), and [`08-media-delivery.md`](08-media-delivery.md) own persistence, transaction, object, processing, and delivery behavior.
3. This guide owns M2 sequencing, temporary later-milestone boundaries, technical defaults, and evidence.

M2 starts after M1 code and CI are green. Real M1 staging acceptance remains open until cloud resources exist; that does not block provider-neutral M2 coding. M2 staging cannot be accepted until a private Cloudflare R2 staging bucket, scoped credentials, and an authenticated CDN/Worker delivery domain exist.

## 2. Required outcome

At the end of M2, the backend must:

- accept explicit Telegram photo uploads without importing Telegram Profile photos;
- count every upload attempt and enforce 20 attempts per rolling 24 hours under concurrency;
- stream provider content through a 10 MB hard limit instead of buffering entire files;
- quarantine, hash, scan, decode, validate, normalize, and re-encode JPEG, PNG, and WebP;
- reject animation, malformed content, spoofed MIME, decompression bombs, unsafe dimensions, and exact duplicate active photos;
- make a photo visible only after original and required thumbnail storage are verified;
- preserve two-to-six visible/saved/primary invariants under concurrent uploads and lifecycle changes;
- support ordering, primary selection, user deletion, and internal moderation hide/restore/delete;
- generate blurred previews on demand without making blur failure invalidate a photo;
- issue short-lived, purpose-bound delivery grants without exposing R2 keys or public buckets;
- clean abandoned/removed objects with idempotent, verified jobs;
- provide the real PostgreSQL-backed media eligibility adapter required by M1 Profile confirmation;
- keep application/domain behavior independent of Telegram, R2, and Cloudflare so later web/mobile clients converge on the same workflow.

No application server disk is durable media storage. No photo becomes reachable from an uncredentialed R2 URL.

## 3. Explicit non-goals

Do not add these in M2:

- automated face, identity, age, liveness, or NSFW claims;
- video, GIF, HEIC/HEIF, stickers, documents, animated WebP, or chat media;
- production report/review UI, administration RBAC, or operator provisioning—M7 owns them;
- full account-deletion orchestration or evidence-retention decisions—M8 owns them;
- discovery, Liked By, Like, Match, or billing behavior—later milestones consume delivery grants;
- public buckets, permanent signed URLs, raw-original card delivery, or client-selected object keys;
- a web/mobile upload route before those clients have an authenticated principal. M2 defines the convergent upload-intent seam only.

## 4. Locked technical decisions

### 4.1 Asset versus ProfilePhoto timing

Signup has no persisted Profile until final confirmation. Therefore:

- uploads create User-owned `MediaAsset` rows first;
- a validated asset and thumbnail may exist before it is assigned to a Profile;
- M1 signup drafts reference owned MediaAsset IDs;
- final confirmation locks the User/draft/assets, rechecks current eligibility, creates the Profile, and creates ordered ProfilePhoto assignments in the same PostgreSQL transaction;
- subsequent uploads for an existing Profile create the visible ProfilePhoto only after validation and thumbnail verification.

The pre-transaction media proof is advisory and short-lived. The confirmation transaction must authoritatively re-read and lock every selected asset. A proof alone never authorizes completion.

### 4.2 Storage and object mutation

Use these private random-ID keys:

```text
quarantine/{environment}/{assetId}/original
validated/{environment}/{assetId}/original
variants/{environment}/{assetId}/thumbnail-v1.webp
variants/{environment}/{assetId}/blurred-preview-v1.webp
report-evidence/{environment}/{reportId}/{snapshotId}
```

Do not include User IDs, Telegram IDs, usernames, Profile fields, or filenames in keys. Object writes/deletes happen outside database transactions. PostgreSQL state plus outbox jobs records the intended operation; workers verify the external result before advancing state.

### 4.3 Validation defaults

- accepted detected types: non-animated JPEG, PNG, WebP;
- maximum streamed original: 10 MiB;
- minimum dimensions: 600 × 600;
- maximum dimension: 12,000 pixels on either side;
- maximum decoded area: 40 megapixels;
- exactly one decoded frame/page;
- every served rendition is freshly re-encoded with metadata removed and normalized orientation/color space;
- thumbnail transformation version 1 is required for visibility;
- blurred-preview transformation version 1 is optional until an authorized locked-card request needs it.

These maximum decode values are operational safety defaults and may be lowered by configuration. Raising them requires a memory/load review and malicious-image corpus rerun.

### 4.4 Processing isolation

Image decoding and malware scanning run in a dedicated media-worker queue, not the API or Telegram gateway. Workers have bounded CPU, memory, wall time, concurrency, and temporary disk; no database superuser or bucket-list permission. The maintained image decoder must enforce its pixel/page limits before full decode. The malware scanner uses a versioned signature set and returns only stable safe result codes to product code.

### 4.5 Delivery grants

`ResolveMediaDeliveryGrant` rechecks the viewer, owner, ProfilePhoto, moderation state, relationship purpose, and exact permitted rendition on every request. It returns an HTTPS CDN path carrying a short-lived HMAC-SHA256 token with key ID, path/version, purpose/audience, expiry, and random nonce. The edge validates the signature and expiry before reading private R2. Default lifetime is five minutes and cannot exceed fifteen minutes.

Presigned R2 PUT/GET URLs are storage credentials and are never returned as user-facing delivery URLs. Storage keys, signatures, provider errors, and delivery URLs are redacted from logs.

## 5. Source layout

Keep the modular monolith boundaries:

```text
packages/domain/src/media/                 # pure state and invariant rules
packages/contracts/src/m2.ts               # strict channel/job/query contracts
packages/application/src/media/            # commands, queries, ports, coordinators
packages/persistence-postgres/src/media/    # transactions and repositories
packages/media-r2/src/                      # S3-compatible R2 adapter only
packages/telegram/src/media/                # Telegram metadata/download adapter
apps/worker/src/media/                      # validation/variant/cleanup processors
migrations/000010..                         # forward-only M2 schema changes
test/fixtures/media/                        # synthetic licensed malicious-image corpus
```

The domain imports no Node streams, image library, Telegram, R2, Cloudflare, SQL, or framework. Application ports use `AsyncIterable<Uint8Array>` for bounded streaming. Provider adapters translate to and from those ports.

## 6. Persistence design

### 6.1 Migration sequence

Create new forward-only migrations after `000009_m1_hardening.sql`:

1. `000010_m2_media_assets.sql` — media schema, assets, upload-attempt indexes, and validation state.
2. `000011_m2_profile_photos.sql` — assignments, variants, moderation records, constraints, and indexes.
3. `000012_m2_media_jobs.sql` — cleanup/delivery-revocation state only if it cannot use existing outbox/job tables cleanly.

Never edit an applied migration. Each migration must run from empty and immediately previous schema, be replay-safe through the migration runner, and add verification SQL.

### 6.2 MediaAsset

`media.media_assets` stores:

- UUID ID and owner User;
- source type and encrypted/limited Telegram transport metadata needed only until ingestion finishes;
- optional sanitized original filename, never used as a key;
- validation state `pending|valid|rejected|failed`, stable error code, and version;
- detected MIME, bounded byte size/dimensions/frame count;
- original and normalized SHA-256 values as `bytea`;
- provider, quarantine key, validated key, stable delivery path/version;
- attempt, upload, validation, terminal, storage-deleted, created, and updated timestamps.

Index owner plus attempt time for the rolling limit and owner plus upload time for management. Unique provider/key constraints prevent aliasing. A partial unique owner/normalized-hash index rejects exact active duplicates only after a normalized hash exists. Terminal validation states cannot return to pending.

Every coarse rejection still has an attempt row. Begin-upload locks `identity.users`, counts the prior rolling window, inserts the attempt, and relies on the lock so concurrent attempts cannot exceed 20.

### 6.3 ProfilePhoto and variants

`media.profile_photos` stores unique asset, Profile, `visible|hidden|deleted`, primary flag, display order, lifecycle timestamps, and version. Add:

- partial unique Profile/display-order for non-deleted photos;
- partial unique Profile where visible and primary;
- check primary implies visible;
- index Profile/status/order;
- foreign keys to Profile and MediaAsset with controlled deletion.

`media.photo_variants` stores asset, `thumbnail|blurred_preview`, transformation version, provider/key/delivery path, dimensions, checksum, generated/deleted timestamps, with unique asset/type/version and provider/key.

`media.photo_moderation_records` is append-only and records internal admin identity, action, reason code, optional report ID, and time. M2 has no public moderation endpoint; tests use an authorized internal fixture until M7 supplies RBAC and transport.

### 6.4 Retention registration

The same migration change updates [`17-data-retention-registry.md`](17-data-retention-registry.md) for every media table and each object prefix. Ordinary originals/variants are purged. Hidden/evidence assets are retained only when a later safety record explicitly authorizes it; a generic hidden state is not a retention reason.

## 7. Application operations and ports

### 7.1 Commands

- `BeginTelegramPhotoIngestion` — authenticate owner, consume attempt slot, persist intent, enqueue download.
- internal `CompleteQuarantineUpload` — verify HEAD size/checksum and enqueue validation.
- internal `RecordPhotoValidation` — record safe metadata or stable rejection/failure.
- internal `PublishValidatedPhoto` — verify required original/thumbnail objects and create/assign visible photo when a Profile exists.
- `SetPrimaryPhoto`, `ReorderPhotos`, and `DeletePhoto` — owner-only, versioned, idempotent.
- internal `ModeratePhoto` — hide/restore/delete with audit and outbox; no production route before M7.
- internal `GenerateBlurredPreview` and `CleanupMediaObjects` — retry-safe jobs.

### 7.2 Queries

- `GetOwnPhotos` returns safe states/order only, never storage keys.
- `GetProfileMediaEligibility` provides the short-lived precheck consumed by M1.
- `ResolveMediaDeliveryGrant` returns only an authorized HTTPS grant.
- internal cleanup/evidence queries return least-data job models.

### 7.3 Ports

- Telegram file metadata/download port with allowlisted Bot API origin and bounded streaming;
- object store put/head/get/delete port with exact key and checksum operations but no application-level list dependency;
- malware scanner port;
- image decoder/transformer port;
- delivery-token signer and CDN purge port;
- evidence-retention decision port owned finally by moderation/deletion.

Provider errors are mapped to stable retry classes. Unknown results are retried/reconciled; they never mark an object absent or a photo visible.

## 8. Transaction and job designs

### 8.1 Begin upload

1. authenticate User and capability;
2. claim command idempotency;
3. lock User;
4. count attempts in `[now-24h, now)` and reject at 20;
5. insert pending MediaAsset with a random key derived only from asset ID;
6. append audit/outbox `media.ingestion-requested.v1`;
7. persist response and commit.

Download begins only after commit. Replays return the same asset and do not consume another attempt.

### 8.2 Download and quarantine

The worker fetches only through the Telegram port, streams through a byte counter and SHA-256, aborts at 10 MiB, scans, writes one quarantine key, then HEAD-verifies length/checksum. If R2 succeeds and the DB update fails, the same job reconciles by HEAD and completes; an orphan scan later removes unreferenced quarantine objects. If DB intent exists and R2 fails, state remains retryable and never visible.

### 8.3 Validate, transform, and publish

1. conditionally claim pending asset/version;
2. decode with safe limits and actual type sniffing;
3. reject multiple frames, invalid dimensions, corrupt content, scanner detection, and normalized duplicates;
4. normalize/re-encode original and thumbnail with metadata stripped;
5. write and HEAD-verify versioned validated objects;
6. in one DB transaction, lock User then Profile when present, recheck asset/hash/slot limits, record valid asset and thumbnail variant, create visible ProfilePhoto if applicable, append audit/outbox, commit;
7. enqueue quarantine cleanup after commit.

Duplicate workers converge through asset version and unique variant/photo constraints. Thumbnail failure creates no visible ProfilePhoto. Blur failure records a retryable/terminal variant outcome but does not change Profile validity.

### 8.4 Profile confirmation integration

The media eligibility precheck verifies ownership, valid state, required thumbnail, distinct 2–6 assets, and requested primary. In the existing Profile confirmation transaction, lock selected assets in stable ID order after User/draft locks, repeat those checks, create ProfilePhoto rows with positions `0..n-1`, and then mark Profile complete. Deleting or moderating an asset between precheck and transaction therefore cannot bypass confirmation.

### 8.5 Photo lifecycle

Every set-primary/reorder/hide/restore/delete transaction locks User, Profile, then all active ProfilePhoto rows in stable order. It rechecks ownership/version and:

- never allows more than six saved visible+hidden photos;
- requires a complete duplicate-free reorder set;
- denies owner deletion of the current primary until another visible primary is selected;
- lets moderation hide/delete a primary only while atomically promoting the lowest-order visible replacement when present;
- synchronously recomputes Profile completion after visibility changes;
- records moderation/audit/outbox state before external cleanup/purge.

Deleted is terminal. Cleanup never changes a deleted photo back to visible.

### 8.6 Cleanup

Cleanup jobs carry asset ID plus deletion generation, enumerate keys from trusted DB rows, delete exact objects, HEAD-verify absence, and conditionally set `storage_deleted_at`. Missing objects are success. Timeout/unknown outcomes retry. Persistent failures alert. Evidence objects use a separate restricted reference and cannot be deleted by ordinary cleanup.

## 9. Security and observability

- allowlist Telegram and R2 endpoints; never fetch a URL from user input;
- use separate least-privilege quarantine, transform, delivery, and cleanup credentials where deployable;
- deny bucket public access/listing and separate production/non-production;
- never log image bytes, filenames, hashes, Telegram file IDs, storage keys, delivery URLs/tokens, or decoder/provider detail;
- keep content-derived values and User/asset IDs out of metric labels;
- audit upload outcome, primary/order/delete actions, moderation, delivery denial, and cleanup result with stable codes;
- measure attempts, accepted/rejected/failed validation, processing latency, queue age, storage errors, blur demand/failure, unauthorized delivery, cleanup age, and orphan count;
- alert on validation backlog, quarantine growth, cleanup verification failure, unusual attempt/hash patterns, and delivery authorization failures.

## 10. Required tests and acceptance ledger

### 10.1 Pure and contract tests

Test all state transitions, exact boundaries, MIME/type mismatch, frame/dimension/pixel limits, photo eligibility, primary promotion, owner-delete rule, strict schemas, unknown fields, and purpose/rendition delivery matrix.

### 10.2 PostgreSQL integration and concurrency

Use real PostgreSQL for attempt-limit races, seven accepted uploads racing for the sixth slot, normalized duplicate race, confirmation versus deletion/moderation, two primary selections, reorder versus delete, lifecycle promotion, variant uniqueness, idempotent cleanup, audit/outbox rollback, and every database check/partial unique index.

### 10.3 Provider and malicious-image corpus

Use synthetic/licensed fixtures for spoofed MIME, corrupt/truncated headers, oversized streams, high-compression/high-pixel images, EXIF GPS/device metadata, animation/multi-frame files, and polyglot/trailing data. Verify served re-encodes contain no metadata. Provider fakes must reproduce timeout, partial stream, checksum mismatch, write success/DB failure, DB intent/write failure, delete unknown, and purge retry.

### 10.4 Acceptance status

| Evidence | M2 completion rule |
|---|---|
| `ACC-008/M2-E2E` | one visible plus one hidden synchronously makes Profile invalid |
| `ACC-009/M2-CONCURRENCY` | seven concurrent accepted assets produce at most six saved photos |
| `ACC-010/M2-FAILURE` | thumbnail failure produces no visible ProfilePhoto |
| `ACC-011/M2-FAILURE` | blur failure leaves existing photo/Profile valid |
| `ACC-012/M2-LIFECYCLE` | primary hide promotes deterministically and recomputes Profile |
| `ACC-013/M2-PHOTO-DELETE` | ordinary photo deletion removes delivery and objects; full account/evidence deletion remains M7/M8-owned |

No skipped media, security, concurrency, or acceptance test may be merged. M2 is not accepted from mock-only storage tests; the final gate includes real private R2 and CDN staging evidence.

## 11. Reviewable implementation sequence

### PR 1 — M2 execution, domain, and contract foundation

- approve this guide;
- add media limits, states, transitions, collection/primary/order policies, stable errors, strict command/job/delivery schemas, and pure tests;
- do not expose a route or add provider dependencies.

### PR 2 — MediaAsset persistence and M1 eligibility integration

- add migrations `000010` and `000011`, Kysely types, retention entries, repositories, attempt-limit and asset-ownership tests;
- implement authoritative confirmation-time asset locks and ProfilePhoto assignment;
- close the M1 production media-eligibility placeholder only after the real adapter is wired.

### PR 3 — Telegram streaming ingestion and quarantine

- add generic ingestion handlers/ports and thin Telegram metadata/download adapter;
- implement bounded stream hashing, scanner port, quarantine writes/verification, retry/reconciliation, rate limit, audit/outbox/metrics, and provider failure tests.

### PR 4 — Validation, thumbnail, and publish pipeline

- add the isolated decoder/transformer adapter, normalized storage, thumbnail v1, duplicate protection, and malicious-image corpus;
- prove `ACC-009..011` with real PostgreSQL and failure injection.

### PR 5 — Photo management and moderation lifecycle

- implement owner list/reorder/primary/delete and internal hide/restore/delete;
- recompute Profile completion atomically and prove `ACC-008`/`ACC-012` plus lifecycle races;
- keep the admin transport disabled until M7.

### PR 6 — Delivery grants and on-demand blur

- implement viewer/purpose/rendition policy, HMAC key rotation, Cloudflare Worker verifier, private R2 fetch, blur deduplication, cache purge, and tamper/expiry/cross-user tests;
- do not expose raw keys or direct originals.

### PR 7 — Cleanup, hardening, and staging evidence

- implement verified object cleanup/orphan reconciliation and the M2 portion of `ACC-013`;
- complete observability, alerts, runbooks, load/failure/security tests, IaC for R2 secrets/media workers, and acceptance ledger;
- deploy to real R2/CDN staging and record evidence before declaring M2 complete.

Each PR must pass frozen install, formatting, lint, type checks, unit tests, PostgreSQL migrations/integration/concurrency, production audit, and all container builds. Database changes deploy before new readers/writers. Object and schema cleanup is always deferred until forward compatibility is proven.

## 12. Definition of done

M2 is complete only when all seven PR outcomes are green and:

- no route trusts client MIME, filename, dimensions, URL, key, ownership, or authorization;
- storage and processing are bounded, private, retry-safe, and horizontally scalable;
- M1 confirmation performs an authoritative in-transaction media recheck;
- every visible photo has a verified thumbnail and exactly one visible primary per eligible Profile;
- upload/slot limits survive real concurrency;
- hidden/deleted photos cannot receive ordinary delivery grants;
- deletion removes ordinary delivery immediately and object cleanup is verified;
- all new tables/object prefixes appear in the retention registry;
- real R2/CDN staging tests and required operational evidence pass;
- Critical/High defects are zero and every Medium defect has an owner and release decision.

## 13. First implementation action

Begin only PR 1. Its traceability checklist is:

- [x] statuses and transitions map to Domain Statuses §3;
- [x] size/type/dimension/frame/attempt limits map to Business Rules §3;
- [x] two-to-six saved/visible/primary rules map to `ACC-008..012`;
- [x] owner primary deletion and moderation promotion are separate policies;
- [x] thumbnail and blur failures have distinct effects;
- [x] contracts never return object keys and reject additional properties;
- [x] delivery requests bind actor, photo, purpose, and allowed rendition;
- [x] provider-specific code and live routes remain outside PR 1;
- [ ] formatting, lint, type checks, all tests, and all builds pass before the PR 1 commit.
