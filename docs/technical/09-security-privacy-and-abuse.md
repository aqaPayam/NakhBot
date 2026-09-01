# Security, Privacy, and Abuse Controls

## 1. Security model

Nakh handles sensitive dating, location, chat, moderation, and payment data. Security design assumes malicious users, replayed Telegram/provider callbacks, compromised client state, scraped media URLs, abusive automation, curious operators, and ordinary infrastructure failures.

Security controls are release requirements, not later enhancements.

## 2. Data classification

| Class | Examples | Controls |
|---|---|---|
| Restricted | chat text, reports/evidence, raw provider callbacks, charge IDs, moderation notes | application-layer encryption where retained, narrow roles, audited access, no logs, shortest retention |
| Sensitive | Telegram ID/username, dating preference, birth year, City, photos, support text | encryption at rest/TLS, purpose-limited access, redacted logs, deletion policy |
| Internal | internal User ID, pair state, feature flags, operational metadata | authenticated service access, least privilege |
| Public/catalog | localized labels, active catalog options | integrity/version controls |

Dating profile data is never called public merely because another eligible user can view it.

## 3. Identity and authorization

- Telegram identity is established only from authenticated webhook update data, never typed username/ID.
- Internal User ID is the authorization subject.
- Every command checks current Account state; privileged commands also check permission and target scope.
- Pair-scoped operations verify actor membership/role and normalized pair state.
- Object/media access uses short-lived purpose-bound grants.
- Admin and worker roles are separate from normal application roles.
- Production break-glass access is time-bound, approved, recorded, and reviewed.
- Future web sessions use short access tokens, rotating hashed refresh tokens, device/session revocation, and separate admin audience/MFA.

## 4. Input and output safety

- Validate every external, queue, database-JSON, and provider payload against a versioned schema.
- Normalize Unicode and enforce length before database work.
- Parameterize all SQL; dynamic identifiers come from closed code maps.
- Escape Telegram/HTML/Markdown and future web output by default.
- Reject control/bidirectional spoofing characters where names or admin displays could mislead; preserve legitimate language text under a documented normalization policy.
- Never fetch a user-controlled arbitrary URL. Telegram and R2 clients use allowlisted configured endpoints.
- File processing follows the sandbox/limits in media design.
- Error responses expose stable safe codes, not SQL, stack, provider, or account-existence details.

## 5. Secrets and cryptography

- Secrets live in a managed secret store and are injected by reference/short-lived identity where possible.
- Separate keys by environment and purpose: webhook verification, callback signing, cursor signing, media grants, field encryption.
- Use established authenticated encryption through a reviewed library and envelope encryption with KMS-managed key versions.
- Store key version/nonce/ciphertext; support online rotation and background re-encryption.
- Passwords are not an MVP concept. If introduced, use a modern memory-hard password hash and breach/MFA controls.
- TLS is required for all external and service/data-store connections.
- Redact secret-shaped values at logger, tracer, error reporter, and support tooling boundaries.

## 6. Abuse prevention

Layer controls by actor, Telegram identity, normalized IP where available, target, pair, and global provider budget:

- token bucket for normal command bursts;
- exact durable windows for report, photo, payment, support, and appeal limits;
- escalating cooldown for repeated invalid callbacks/payment attempts;
- pair-level serialization for interaction races;
- distinct-reporter threshold for automated restriction;
- hash/upload anomaly detection without claiming automated content moderation;
- maximum payload/body/connections and per-queue concurrency;
- suspicious automation metrics and manual moderation queue.

Redis limits are fast-path. Safety-critical durable limits and enforcement outcomes are recorded in PostgreSQL. If Redis is unavailable, abuse-sensitive mutations fail closed or use a lower-throughput database limit.

## 7. Moderation safety

- Report creation snapshots evidence immediately because normal content can later be deleted.
- Reporter identity is not revealed to the target.
- Unique reporter counting, not report volume, triggers the five-in-30-days restriction.
- Automated restriction is idempotent, reversible only through authorized workflow, and generates a safety notice/audit.
- Admin commands require explicit permission, target confirmation, reason, and attempted-action log even when rejected/failed.
- Hidden photos remain inaccessible to users and available only to permitted moderation roles.
- Internal pair block immediately prevents discovery/interaction/chat and closes affected active state through the lifecycle coordinator.
- Appeal uniqueness is tied to one ban-history event.

## 8. Logging and operator privacy

Allowed log fields include request/trace IDs, internal pseudonymous IDs, command/event code, outcome, duration, row count, queue/job ID, safe provider status class, and error fingerprint.

Prohibited fields include chat/profile/support/report text, birth year plus City combination, usernames, raw Telegram updates, bot tokens, callback data, payment payload/charge ID, storage keys/signed URLs, and decrypted snapshots.

Operator interfaces use least data: queues show metadata before content, reveal actions are permissioned/audited, exports are disabled by default, and production queries use approved views. Audit logs are append-only and monitored for tampering/access anomalies.

## 9. Deletion and retention privacy

Deletion immediately disables product access and starts the checkpointed purge saga. Ordinary data is removed, shared state is closed, media is deleted and verified, caches/sessions are invalidated, and derived projections are purged.

Permitted retained data is minimized and pseudonymized:

- stable identity/guest counter needed to enforce fresh-return rules;
- ban/safety history and report evidence only for a documented safety purpose;
- financial evidence required for provider/accounting reconciliation;
- deletion manifest and retention explanation.

No retained record is used to rebuild the deleted dating Profile or chat history. Every category has owner, purpose, access role, retention/review rule, and eventual deletion mechanism. Legal/compliance counsel must approve actual durations before production.

## 10. Infrastructure controls

- private network paths for PostgreSQL/Redis; no public database;
- WAF/body/rate controls at edge, but application authorization remains mandatory;
- separate production cloud account/project and least-privilege workload identities;
- encrypted backups with restore access separated from runtime;
- image/container dependency scanning, signed artifacts/SBOM, protected main branch, reviewed IaC;
- egress allowlist for Telegram, R2, telemetry, and secret/KMS endpoints where platform supports it;
- patch SLA based on severity and internet exposure;
- clocks synchronized and UTC;
- non-production uses synthetic data, never copied production profiles/chats.

## 11. Threat review gates

Before production, perform:

- data-flow and trust-boundary threat model;
- authorization matrix and object-level access tests;
- webhook/callback replay, tamper, and cross-user tests;
- SQL/injection/output-escaping review;
- media parser/upload/download test corpus;
- payment abuse and reconciliation review;
- deletion/retention verification with sample manifests;
- dependency/container/IaC scan and external penetration test;
- admin misuse/break-glass tabletop;
- incident exercise for bot-token leak, media URL leak, database read exposure, and malicious admin.

Critical/high findings block launch unless risk acceptance is explicit, time-limited, owned, and approved.
