# M8 media source authority rehearsal

This candidate does not enable deletion ingress, fresh return, retained-data release
or M9. Keep media delivery disabled until the whole environment and current M8
candidate are approved. CI and synthetic storage prove software behavior; they do
not prove real R2, Cloudflare, staging, restore/DR or operator acceptance.

## Required graph

Apply migration 98 and verify the complete deletion registry. Both API and worker
must run the same version of the native grant issuer. The grant records the exact
original source, actor/owner epochs and environment; it contains no image bytes,
storage credentials or user text. Original product source identifiers have no live
Photo/Like foreign keys that would prevent ordinary archival. Unexpired receipts
are immutable. Expired receipts are ordinary capability data that may be purged;
their maximum five-minute authority lifetime is not a retained-data policy period.

Use separate media-signing and audience keys. The worker, API and edge reject
overlapping roles. Preserve the configured key identifiers and resolve keys from
their secret references. Never put plaintext keys into configuration artifacts.
The API's actual module registers `/internal/media/source-authority` only under the
existing explicit media-delivery flag. Its request must have a valid independent
audience bearer and exact signed grant/path; its response contains only `allowed`
and is never cached. The edge's `NAKH_MEDIA_AUTHORITY_URL` must be the fixed HTTPS
API route with no credentials, custom port, query or fragment. No redirect or
signature-only fallback is allowed. Each authority request has a two-second bound
and a strictly bounded response body. The private API and edge transport must be
reachable before enabling delivery.

The v2 signed protocol requires an opaque native receipt identifier. Previously
issued v1 signature-only URLs fail closed and must be reissued through current
authorization. Coordinate API, worker and edge versions; do not keep a legacy
signature-only edge deployment serving old URLs during the authority rollout.
Clock skew must remain within the verified credential window. A clock-readiness
failure is an activation blocker; no global clock is changed by this implementation.

## Rehearsal evidence

Run the complete repository check and all six exact-head CI jobs. Keep the original
plan volumes, indexes and timing limits. Check populated migration-97 upgrade and
replay, exact registry coverage and the native media/API suites. The source-authority
tests must verify original receipt metadata under twenty-way issuance, borrowed or
changed scopes, immutable grants, new Like references, native expiry/release,
issuance blocked on identity, source closure during that wait, and real deletion.

Exercise actual API module registration and edge runtime composition with real
signed credentials and native source queries. A valid URL must deliver the expected
synthetic bytes with no-store headers, and repeated reads must preserve its one
original receipt. Pause storage, commit a real tombstone, then release storage:
delivery must deny and cancel its stream. Replay the original URL and confirm that
storage is not reached. Unit evidence must also pause an individual stream read,
revoke its authority before it returns and prove that the revoked chunk is not
delivered. Native authority exceptions, malformed/oversized/cacheable HTTP replies,
missing endpoint, key-role overlap, and legacy tokens must fail closed.

## Remaining environment work

Rehearse these boundaries against the actual provider and network, including slow
storage, long streams, client cancellation, API outage and pool saturation. Measure
authority RPC load and delivery latency before activation. Every streamed read has
fresh checks; there is deliberately no positive authority cache. Configure private
transport and logging so request bodies, bearer headers and signed URLs never enter
logs or traces. Verify content-free observability and alarms as part of the broader
M8 production-hardening work.

This boundary revokes product delivery; it does not prove exact object deletion or
provider absence. The separate audited M7 retained-byte path remains the evidence
route. No public administrator-only media grant may bypass its permissions, audit
or hold. Whole ordinary purge, ledger partition, ephemeral invalidation, controlled
policy manifests and verified fresh return remain separate M8 obligations. Financial,
safety and workforce retention periods remain unapproved and retained-data release
remains disabled.
