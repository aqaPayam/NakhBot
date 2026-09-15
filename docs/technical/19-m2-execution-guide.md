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
3. `000012_m2_media_quarantine.sql` — verified quarantine completion facts and immutable completion guard.
4. `000013_m2_media_jobs.sql` — durable ingestion-worker leases and versioned clean-scan evidence.
5. `000014_m2_media_validation.sql` — validation leases, verified rendition facts, and publication guards.
6. `000015_m2_media_cleanup.sql` — deletion generations, cleanup leases, immutable storage keys, and verified-deletion facts.

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

1. authenticate User;
2. lock User and return a matching completed command replay if present;
3. lock Account and evaluate capability (`continue_signup` for incomplete accounts, otherwise `edit_profile`);
4. read database `clock_timestamp()` after obtaining the User lock; count all attempts at or after `now-24h` (including equal/future timestamps) and reject at 20;
5. insert pending MediaAsset with a random key derived only from asset ID, or a rejected asset for a coarse size/type failure; the rejected result must commit, not throw and roll back its attempt;
6. append audit/outbox `media.ingestion-requested.v1` or `media.ingestion-rejected.v1`;
7. persist the unique command response in the same transaction and commit.

Download begins only after commit. Replays return the same asset and do not consume another attempt.

The 21st request is denied before an ingestion intent exists; it does not create an unbounded rejection table. All admitted attempts, including coarse rejections and later processing failures, count for the full window. PR3 adds transport-level request throttling. Client `occurredAt` never controls this clock. Raw Telegram IDs and filenames are not stored in audit/outbox/asset text fields; PR3 supplies authenticated-encrypted, size-bounded transport metadata and clears it after ingestion.

### 8.2 Download and quarantine

The worker fetches only through the Telegram port, streams through a byte counter and SHA-256, aborts at 10 MiB, scans, writes one quarantine key, then HEAD-verifies length/checksum. The database records verified quarantine size and SHA-256 once; a retry with the same facts is idempotent. If R2 succeeds and the DB update fails, the same job reconciles by HEAD and completes; an orphan scan later removes unreferenced quarantine objects. If DB intent exists and R2 fails, state remains retryable and never visible.

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

Current implementation: the provider-neutral ingestion handler and request throttle, bounded stream, Telegram `getFile`/download adapter, quarantine/scanner coordinator, AES-256-GCM transport envelope, official S3-client R2 transport, durable PostgreSQL worker leases, immutable clean-scan/quarantine facts, atomic completion/rejection audit and outbox, ClamAV adapter, bounded metric definitions, and guarded worker event routing are implemented. The worker composition is disabled by default and resolves credentials only from named secret environment references. The authenticated Telegram gateway now resolves an existing Telegram identity, strictly maps the largest photo rendition into an idempotent ingestion command, and remains fail-closed behind the same media activation flag.

### PR3 continuation checklist

1. Preserve the current fail-closed boundary: there is no live upload route until scanning, storage, and worker composition are complete.
2. [x] Implement a maintained S3-compatible client with bounded streaming, independently verified checksum/length, conditional creation, and verified deletion. The worker uses bounded temporary storage to know content length and SHA-256 before upload; the object records the digest as immutable metadata. Unknown HEAD outcomes are retryable, never absent.
3. [x] Compose the durable download claim in the worker behind an off-by-default activation flag. Each delivery uses a unique owner token; the 60-second network deadline stays below the 120-second lease. BullMQ supplies retry/backoff and database facts reconcile duplicate delivery.
4. [x] Supply a maintained streaming malware-scanner adapter and record its engine/signature versions through the implemented clean-scan evidence seam. A clean result permits quarantine completion but never implies decoded/valid/published.
5. [x] Route the implemented atomic completion/rejection outbox events to validation/reconciliation exactly once at the consumer boundary.
6. [x] Compose the production gateway upload route with authenticated Telegram ownership, strict contract validation, the required rate limiter, and the encryption key ring. Queue routing and worker metrics are composed. Keys come from named secret environment references; old decryption keys must remain until outstanding intents expire. Raw identifiers cannot enter logs or events.
7. [x] Exercise provider faults, concurrent workers, write-success/database-failure, audit rollback, key rotation, and startup configuration in automated tests. Real private R2/CDN staging fault evidence remains required for M2 acceptance.

Current component guarantees: network metadata is capped at 64 KiB, downloads have a 60-second deadline, redirects are rejected, and early stream exits cancel the response. The 10 MiB cap and declared length are checked while streaming. AES-GCM ciphertext is bound to environment, asset ID, key ID, and envelope version. Conditional object creation and HEAD comparison prevent silent overwrite; a prior object is re-downloaded, rescanned, hashed, and matched before database reconciliation. Worker claims fence concurrent processing and expire for recovery. Completed storage and clean-scan facts are immutable; matching replays return recorded facts without downloading again. Successful completion or terminal rejection clears transport ciphertext and atomically records audit/outbox. Rejection cleanup failures remain retryable. No photo visibility or image-validation guarantee is claimed by these components.

### PR 4 — Validation, thumbnail, and publish pipeline

- add the isolated decoder/transformer adapter, normalized storage, thumbnail v1, duplicate protection, and malicious-image corpus;
- prove `ACC-009..011` with real PostgreSQL and failure injection.

Current implementation: the worker-only Sharp/libvips boundary performs actual format sniffing, enforces the encoded-byte and 40-megapixel decode limits, rejects corrupt/unsupported/animated/unsafe images, applies orientation and sRGB normalization, strips input metadata through fresh WebP encoding, and produces thumbnail v1. The worker consumes clean-quarantine events, reads the private object, writes and verifies normalized and thumbnail objects, and only then atomically publishes PostgreSQL state. PostgreSQL validation leases fence workers; server-derived keys, sizes, and hashes are rechecked; per-user duplicate races and six-photo limits serialize on the user/Profile lock; accepted or rejected outcomes commit with audit/outbox records. A rejected duplicate/limit result removes its unpublished renditions. The automated hostile corpus covers malformed signatures, HTML/polyglot-like input, truncated JPEG, unsupported format, unsafe dimensions, metadata stripping, encoded-size limits, and a compressed image above the decoded-pixel ceiling. Failure injection covers each object-write boundary, verification mismatch, database completion failure, cleanup, claim release, invalid provider bodies, and concurrent duplicate publication.

PR4 continuation checklist:

- [x] decoder/transformer boundary and safe WebP renditions;
- [x] private R2 read plus verified immutable normalized/thumbnail writes;
- [x] PostgreSQL validation claims, lease recovery fields, and terminal lease guard;
- [x] atomic asset/variant/ProfilePhoto publication with audit and outbox;
- [x] serialized normalized-duplicate and six-photo decisions;
- [x] permanent decoder rejection versus retryable infrastructure failure routing;
- [x] worker event composition, strict payload validation, and off-by-default provider wiring;
- [x] formatting, lint, type checks, unit tests, all builds, and production audit locally;
- [x] GitHub PostgreSQL integration and container jobs green for migration 000014;
- [x] malicious/truncated/decompression-bomb corpus and crash-point fault injection;
- [ ] real private R2 staging evidence (deferred until infrastructure is purchased).

### PR 5 — Photo management and moderation lifecycle

- implement owner list/reorder/primary/delete and internal hide/restore/delete;
- recompute Profile completion atomically and prove `ACC-008`/`ACC-012` plus lifecycle races;
- keep the admin transport disabled until M7.

Current implementation: application handlers enforce user/admin actor separation and stable moderation reason codes. The PostgreSQL adapter locks Admin (when applicable), User, Profile, and photo rows in a consistent order; uses Profile version as the optimistic concurrency boundary; performs collision-free reorder updates; prevents owner deletion of the current primary; promotes the lowest-order visible replacement after moderation; and rechecks authoritative asset/thumbnail eligibility before committing Profile completion. Owner mutations claim and complete a request-hashed idempotency record in the same transaction, so duplicate transport delivery returns the original collection without repeating audit or outbox effects. Owner and moderator mutations atomically write their photo state, Profile state, append-only moderation record where applicable, audit record, and photo/Profile outbox events. Responses expose logical photo IDs and state only, never storage keys.

PR5 continuation checklist:

- [x] provider-neutral owner list/reorder/select-primary/delete handlers;
- [x] admin-only hide/restore/delete handler with validated reason code;
- [x] PostgreSQL lock ordering, optimistic Profile version, and collision-free reorder;
- [x] primary-delete denial and moderation replacement-primary promotion;
- [x] authoritative completion invalidation/restoration in the same transaction;
- [x] append-only moderation history plus atomic audit/outbox;
- [x] concurrent primary-selection and lifecycle integration coverage prepared for CI;
- [x] transactionally idempotent owner mutations under duplicate transport delivery;
- [x] authenticated, rate-limited Telegram owner command ingress with server-side identity resolution;
- [x] callback-sized HMAC action-token codec and bounded Redis state port with actor/expiry binding;
- [ ] localized owner menu rendering and opaque inline action-token delivery;
- [ ] report-linked moderation orchestration (deferred to M7; `report_id` remains locked null);
- [ ] verified external object cleanup for deleted photos (PR7).

### PR 6 — Delivery grants and on-demand blur

- implement viewer/purpose/rendition policy, HMAC key rotation, Cloudflare Worker verifier, private R2 fetch, blur deduplication, cache purge, and tamper/expiry/cross-user tests;
- do not expose raw keys or direct originals.

Current implementation: the provider-neutral grant handler separates authoritative authorization from signing, enforces user/admin purpose boundaries, limits grants to 10–300 seconds, and returns only the documented HTTPS URL, expiry, rendition, and cache policy. The delivery-token adapter signs a canonical versioned payload with HMAC-SHA256, binds it to exact delivery path, audience, purpose, rendition, issued time, and expiry, compares signatures in constant time, rejects non-canonical encoding, copies key material defensively, and supports one current plus bounded previous verification keys. The separate edge entry point imports no Node runtime APIs, verifies the same canonical token with Web Crypto, requires a trusted audience-authentication adapter, accepts only one exact token query on the configured HTTPS origin, derives a versioned private R2 key only after verification, and returns indistinguishable no-store denials without exposing storage facts. Successful responses are `image/webp`, `nosniff`, CSP-sandboxed, same-site, and private-cache bounded by remaining grant life; moderation evidence is never cached. The edge must not derive audience identity from a client-controlled header or query parameter. Tamper, expiry, cross-user/path replay, invalid purpose/rendition, TTL, origin, and key-rotation tests are present. On-demand blur generation reads only validated current-primary media, creates a metadata-free 96×96 WebP under a deterministic private key, trusts only object-provider write verification, and publishes one versioned database rendition under concurrency. Publication repeats User/Profile/asset/photo lock ordering and rechecks visible-primary state, so a concurrent lifecycle change cannot publish a stale rendition; a write-before-database-failure remains a private deterministic orphan for PR7 reconciliation. Photo hide/delete commits an outbox fact before asynchronous cache revocation. The purge consumer strictly validates that fact, resolves retained versioned paths from PostgreSQL, deduplicates and batches them, and calls Cloudflare's fixed zone endpoint with a secret-manager-resolved scoped token. Provider errors remain retryable BullMQ failures; duplicate delivery is harmless. Composition is off by default until the Cloudflare zone and token are provisioned.

PR6 continuation checklist:

- [x] provider-neutral authorization and signer ports;
- [x] short-lived canonical HMAC token with path/audience/purpose/rendition binding;
- [x] bounded current/previous key rotation and constant-time verification;
- [x] tamper, expiry, cross-user/path replay, combination, and rotation tests;
- [x] fail-closed PostgreSQL authorization for owner preview and active administrators;
- [ ] PostgreSQL card/detail authorization after pair/interaction state exists;
- [x] on-demand blurred-preview generation and concurrent deduplication;
- [x] Cloudflare Worker private-R2 fetch and authenticated audience binding seam;
- [x] retry-safe lifecycle cache purge/revocation, off by default until Cloudflare provisioning;
- [ ] real CDN/R2 staging evidence.

### PR 7 — Cleanup, hardening, and staging evidence

- implement verified object cleanup/orphan reconciliation and the M2 portion of `ACC-013`;
- complete observability, alerts, runbooks, load/failure/security tests, IaC for R2 secrets/media workers, and acceptance ledger;
- deploy to real R2/CDN staging and record evidence before declaring M2 complete.

Current implementation: an owner or moderator deletion now atomically tombstones the logical photo,
its asset, and every ordinary rendition before the lifecycle event is published, so a new delivery
grant is impossible immediately after commit. The worker claims a bounded PostgreSQL cleanup lease,
derives an allowlisted deletion plan exclusively from trusted asset and rendition rows, deletes each
private R2 object, and relies on the object adapter's post-delete absence check before recording
completion. Missing objects are success; unknown provider outcomes remain retryable. The deletion
generation and lease owner fence stale workers, while database constraints and immutable storage-key
triggers prevent a cleanup plan from being redirected to another asset or evidence namespace. Cache
revocation runs before object cleanup and both operations are safe under duplicate event delivery.
Cleanup is independently fail-closed behind `NAKH_MEDIA_CLEANUP_ENABLED=false` and supports separate,
deletion-scoped R2 credentials. No real provider deletion evidence is claimed yet.

The scheduler also supports an independently disabled orphan reconciler. A Redis lease limits the
cluster to one bounded scan every 30 minutes. Each run reads one 20-object page from each ordinary
environment prefix, persists opaque continuation cursors, ignores objects inside a 24-hour safety
window, and rechecks all candidate keys against current PostgreSQL asset/rendition references before
deletion. The provider adapter accepts only the three ordinary prefix shapes and rejects malformed,
duplicate, cross-prefix, or unbounded listing results. A failed verification leaves the current page
cursor unchanged. Metrics and logs contain bounded counts only; keys and cursors remain secret.

PR7 continuation checklist:

- [x] immediate transactional asset/rendition tombstoning on owner and moderator deletion;
- [x] strict server-derived cleanup plans with environment, asset, rendition, and version binding;
- [x] leased, generation-fenced, replay-safe cleanup completion in PostgreSQL;
- [x] verified R2 deletion semantics where missing is success and unknown is retryable;
- [x] separate off-by-default cleanup composition and deletion-scoped credential references;
- [x] unit coverage for partial provider failure, malicious keys, replay, and worker routing;
- [x] PostgreSQL integration coverage prepared for migration, lease contention, grant revocation, and completion;
- [x] bounded, cursor-based orphan reconciliation for deterministic write-before-commit objects;
- [x] bounded cleanup/orphan metrics, dashboard alerts, and incident runbook;
- [x] cleanup lease-contention smoke, crash/retry, stale-owner fencing, and malicious-key evidence;
- [ ] production-scale cleanup load and external-provider failure evidence;
- [x] GitHub PostgreSQL integration and container jobs green for migration 000015;
- [ ] real private R2/CDN staging deletion and reconciliation evidence.

The reproducible automated ledger and explicit external blockers are recorded in
[`20-m2-acceptance-evidence.md`](20-m2-acceptance-evidence.md). The real-provider gate must follow
[`m2-staging-acceptance.md`](../../deploy/runbooks/m2-staging-acceptance.md); neither document changes
the remaining unchecked items into completed evidence.

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

PR 1 is complete and its CI was confirmed green. Its traceability checklist is:

- [x] statuses and transitions map to Domain Statuses §3;
- [x] size/type/dimension/frame/attempt limits map to Business Rules §3;
- [x] two-to-six saved/visible/primary rules map to `ACC-008..012`;
- [x] owner primary deletion and moderation promotion are separate policies;
- [x] thumbnail and blur failures have distinct effects;
- [x] contracts never return object keys and reject additional properties;
- [x] delivery requests bind actor, photo, purpose, and allowed rendition;
- [x] provider-specific code and live routes remain outside PR 1;
- [x] formatting, lint, type checks, unit tests, and builds passed; user confirmed PR 1 CI green.

## 14. Historical PR 2 implementation and evidence boundary

The PR 2 scope was PostgreSQL assets/assignments/variants/moderation tables, immutable terminal-state/owner checks, six-slot and primary constraints, versioned variant uniqueness, serialized rolling attempt accounting, idempotent ingestion intent with atomic audit/outbox, and authoritative signup assignment. Decoder, object access, the upload route, and delivery were deliberately supplied by later M2 increments.

The PostgreSQL eligibility adapter is exercised with the real confirmation handler. The confirmation transaction independently locks selected assets and thumbnail records; a precheck cannot replace this check. Confirmation retries first read their completed command result, so a completed signup does not fail because its draft advanced or its photos later changed. Both ordinary and approved protected Profile edits include media eligibility before restoring completion.

The later PR 3/4 increments now compose the authenticated Telegram photo-ingestion route and verified publication worker behind an off-by-default flag. Signup confirmation still performs its independent authoritative media recheck. Synthetic validated rows remain database-fixture evidence only; they are not evidence that real provider objects were scanned or verified.

Verification checklist:

- [x] empty and previous-schema migration/verification/replay checks;
- [x] 20-attempt concurrency limit, coarse-rejection accounting, replay and transaction rollback;
- [x] missing, foreign-owned, pending, duplicate-selected, deleted, or thumbnail-less assets denied;
- [x] stale precheck rejected without Profile/account partial writes;
- [x] ordered signup assignment and confirmation handler replay;
- [x] seven concurrent assignment inserts leave at most six saved rows;
- [x] primary uniqueness, terminal validation and active normalized-hash constraints;
- [x] formatting, lint, type checks, unit tests, production audit, and build;
- [x] GitHub PostgreSQL/Redis integration, container builds, and restore smoke green.

Later increments supplied the worker/lifecycle evidence for `ACC-008..013`. The current evidence and the remaining real-provider boundary are authoritative in [`20-m2-acceptance-evidence.md`](20-m2-acceptance-evidence.md). Real M1/M2 staging remains blocked on the future infrastructure purchase.

Local evidence (2026-09-08): 22 PostgreSQL integration tests passed on an isolated PostgreSQL 17.11 server. This includes concurrent empty-database bootstrap, upgrade from all nine M1 migrations, verification SQL, migration replay, expired attempt capacity, and both ordinary/protected edits with a hidden photo. Migration bootstrap now acquires its advisory lock before creating the schema tracker. Integration suites share a service database and execute one file at a time because legacy fixtures reset shared tables; explicit concurrency inside individual tests is preserved. The migration-upgrade test requires `CREATEDB` on the disposable test server and deletes only its own randomly named test database.

The historical local PR 2 check passed 84 unit tests and all then-current builds. The suite has since expanded substantially; current counts belong to the immutable CI run recorded in the acceptance ledger, not this historical section. No real R2/CDN acceptance is claimed.
