# Media Processing and Delivery

## 1. Goals

Profile photos must be private by default, validated independently of client claims, safe to process, ordered consistently, removable, and deliverable through thumbnail/blur/original policies without coupling the domain to Cloudflare.

## 2. Object layout

Use separate private buckets or at minimum separate prefixes and credentials:

```text
quarantine/{environment}/{assetId}/original
validated/{environment}/{assetId}/original
variants/{environment}/{assetId}/thumbnail.webp
variants/{environment}/{assetId}/blurred-preview.webp
report-evidence/{environment}/{reportId}/{snapshotId}
```

Object keys use random internal IDs only. They never include Telegram ID, username, real name, location, or original filename. Production and non-production buckets/keys/credentials are isolated.

The database stores provider, object key, checksum, dimensions, detected content type, and a stable delivery path. It does not treat a public URL as authorization.

## 3. Ingestion workflows

### Telegram

1. Adapter validates coarse file metadata and creates an upload/ingestion intent.
2. Worker downloads from Telegram as a bounded stream; no whole-file memory buffering.
3. Stream is size-limited, hashed, scanned, and stored in quarantine.
4. Worker verifies stored object checksum/size and records completion.

### Future web/mobile

1. Authenticated client requests upload intent with declared size/type.
2. API rate-limits, checks photo count, and returns a short-lived presigned PUT constrained to one random quarantine key and allowed headers.
3. Client uploads directly.
4. Client calls completion; backend performs HEAD/checksum verification and enqueues validation.
5. An intent cannot be completed for another user or another key.

Presigned URLs are bearer credentials: short lifetime, HTTPS only, exact method/key, no list permission, and not logged. Because R2 presigned S3 URLs do not use a custom domain, user-facing delivery uses a separate signed CDN/Worker route.

## 4. Validation pipeline

Validation never trusts extension or declared MIME:

- enforce maximum 10 MB while streaming;
- sniff magic bytes and allow JPEG, PNG, or WebP only;
- decode with a maintained sandboxed image library and fail on malformed/decompression-bomb images;
- enforce minimum 600x600 and configured safe maximum pixels/dimensions;
- strip EXIF/IPTC/XMP, especially GPS/device information;
- normalize orientation and color space;
- re-encode variants so hidden metadata/polyglot content is not served;
- malware scan original/quarantine object;
- compute original and normalized hashes;
- reject animation/multi-frame input unless explicitly supported later;
- record stable safe failure code, never decoder internals to the user.

Original becomes `valid` only after all required checks. ProfilePhoto becomes visible only after the required thumbnail exists and the transaction preserves 2..6 photo/primary rules. Automated identity, face, age, liveness, or NSFW verification is not claimed by MVP.

## 5. Variants

- Thumbnail is generated at upload processing time and is required for visibility.
- Blurred preview is generated on first authorized need or eagerly when capacity allows; unique asset/type makes duplicate work harmless.
- Variant dimensions/quality are configuration with a version in the transformation job. A future new rendition creates a new versioned key before switching delivery.
- Transform workers have CPU/memory/time limits and low-privilege object credentials.
- Failure leaves the previous visible asset safe or keeps a new photo non-visible; it never publishes the original accidentally.

## 6. Delivery authorization

Clients request media through `ResolveMediaDeliveryGrant(viewer, asset/photo, purpose)`:

- verify viewer Account/capability and relationship to the profile;
- verify owner/Profile/photo visibility and moderation state;
- select thumbnail, blurred preview, or authorized full rendition for the product surface; a locked Liked By card uses the on-demand blurred variant of the current primary photo, while an effective Like-scoped unlock may resolve the permitted Profile rendition;
- create a short-lived signed CDN token bound to path, rendition, audience/user or session, and expiry;
- return cache policy appropriate to sensitivity.

The CDN/Cloudflare Worker validates the signature at the edge and fetches from private R2. Bucket listing and unauthenticated public access are disabled. Revocation is bounded by short token TTL; safety removal also purges CDN cache by asset path/version.

## 7. Photo lifecycle

- User delete and admin delete mark ProfilePhoto deleted atomically, repair order/primary and Profile validity, then enqueue object cleanup.
- Admin hide/restore changes presentation state and appends PhotoModerationRecord; hidden content remains only for moderation under retention policy.
- Deleting a primary photo requires another non-deleted visible photo to be promoted in the same transaction, or Profile becomes invalid according to canonical rules.
- Cleanup deletes variants and original when no permitted reference remains, verifies absence, and records `storage_deleted_at`.
- Account deletion enumerates all owned assets plus report-evidence exceptions in a signed/checksummed deletion manifest.
- R2 lifecycle rules clean abandoned quarantine uploads, but database jobs remain authoritative for product deletion.

## 8. Caching

- Variant URLs are content/version-addressed and may use CDN caching.
- Signed authorization token is separated from cache key where the edge design safely supports it; otherwise private/no-store responses avoid cross-user leakage.
- Original uploads are never broadly cached or served directly.
- Moderation deletion invalidates delivery grants and purges cached variants.
- Database caches store metadata/authorization facts only briefly and are invalidated by media/profile events.

## 9. Operational metrics

Track upload intents, completion ratio, validation outcome by safe code, scan/transform latency, variant backlog, R2/API errors, bytes stored/delivered, cache hit ratio, cleanup age, orphan objects/rows, and attempted unauthorized delivery. Alert on required-variant backlog, quarantine growth, deletion verification failures, and unusual hash/upload patterns.

## 10. Media test gates

- spoofed MIME, corrupt headers, oversized stream, decompression bomb, EXIF GPS, animation, and polyglot corpus;
- duplicate completion/validation/variant jobs;
- delete/hide racing delivery request;
- primary deletion at minimum photo count;
- another user reuses upload key or signed URL;
- expired/tampered delivery token;
- R2 write succeeds but DB commit fails, and the inverse;
- CDN purge failure and retry;
- deletion manifest identifies all objects and preserves only authorized evidence.
