# Observability and Operations

## 1. Service-level indicators and objectives

Measure user outcomes, not only process uptime.

| Service | Indicator | Initial SLO |
|---|---|---|
| Telegram ingress | valid updates durably claimed within 1 second | 99.9% monthly |
| Command API | eligible commands return non-5xx within target latency | 99.9% monthly; p95 <300 ms |
| Discovery | eligible request returns candidate/exhausted result | 99.5%; p95 <500 ms |
| Payment fulfillment | verified successful payment reaches fulfillment or correction | 99.9% within 2 min, 100% eventually reconciled |
| Notification | critical payment/safety delivery reaches provider terminal result | 99% within 1 min |
| Media | accepted upload reaches visible or safe terminal failure | 99% within 2 min |
| Deletion | requested purge reaches verified completion | 99% within 24 h; immediate access block 99.9% |
| Data durability | recoverable PostgreSQL state | RPO <=5 min, rehearsed RTO <=60 min |

Exclude only documented planned maintenance and invalid/unauthorized requests. Provider outages remain visible separately and must not be hidden from product-health dashboards.

Use error-budget burn alerts rather than paging on every isolated error: fast burn for immediate response and slow burn for sustained degradation.

## 2. Telemetry standards

### Traces

- OpenTelemetry trace begins at webhook/API/provider/job ingress.
- Propagate trace/correlation/causation IDs through outbox and queue payloads.
- Span names use low-cardinality operation codes, not URLs with IDs.
- Record module, command/query/event/job code, outcome, retry count, database duration, queue delay, and safe provider status.
- Sample errors, payments, moderation actions, deletion, and slow traces at a higher rate; never attach content or secrets.

### Metrics

Core RED metrics per process: request/job rate, error rate, and duration. Resource metrics cover CPU, memory, event-loop lag, connection pools, PostgreSQL locks/replication/vacuum, Redis memory/eviction, queue depth/age, R2 errors, and network/provider latency.

Business-integrity metrics include:

- signup starts/completions and Profile invalidation;
- preview limit denials;
- discovery exhaustion/consumption conflicts;
- Like/Nakh/Match/chat command outcomes;
- pending Nakh quota and FIFO settlement delay;
- ledger/callback/fulfillment/refund reconciliation mismatches;
- reports, distinct-threshold episodes, moderation queue age;
- deletion step age/failures and orphan media;
- notification suppression/retry/terminal failures.

Do not use internal User ID or target ID as a metrics label.

### Logs

JSON logs contain timestamp, severity, service/version/environment, trace/request/job IDs, operation, safe actor pseudonym, result code, duration, and error fingerprint. Central redaction is unit-tested. Error stack traces are retained only in protected tooling and still contain no request body/provider payload.

### Audit

Audit logs are distinct from diagnostic logs, append-only, protected by dedicated roles/retention, and cover security-relevant state changes. Audit failure for a required admin/payment/safety action fails the transaction rather than allowing an unaudited mutation.

## 3. Dashboards

Minimum dashboards:

- executive product health: active users, command success, provider health, SLO/error budget;
- ingress/API: throughput, latency, 4xx/5xx, webhook dedupe and backlog;
- PostgreSQL: connections, transactions, slow queries, locks/deadlocks, cache hit, WAL, replica lag, vacuum/bloat;
- Redis/queues: memory, evictions, queue depth/oldest age, retry/dead letter, worker concurrency;
- payments: invoice/pre-checkout/success, callback delay, fulfillment/correction age, ledger reconciliation;
- media: ingestion/validation/transformation/delete outcomes and storage/CDN health;
- safety/support: report/review age, threshold restrictions, appeals/support backlog;
- deletion/privacy: workflow step age, retained categories, failed object deletion;
- release comparison: key indicators by current/previous version.

## 4. Alert policy

Page immediately for:

- verified payment not durably recorded, growing paid-but-unfulfilled age, ledger invariant failure;
- database writer unavailable/corruption signal or backup/PITR failure;
- critical safety/admin authorization bypass signal;
- Telegram webhook authentication failure spike indicating attack or secret mismatch;
- deletion access not blocked or systematic data-leak/media-authorization failure;
- fast SLO burn.

Create non-page tickets for slow error-budget burn, moderate queue growth, catalog/localization issues, isolated cleanup retry, or cost anomalies. Every page links to a runbook and names an owner/escalation.

## 5. Runbook catalog

Required before production:

1. Telegram outage, token compromise, webhook secret rotation.
2. PostgreSQL writer failure, failover, connection exhaustion, slow query/lock storm.
3. Redis outage/eviction and queue recovery.
4. Outbox backlog and poison event.
5. Payment callback backlog, paid-unfulfilled item, uncertain/refund reconciliation.
6. R2/CDN outage, leaked delivery token/path, orphan cleanup.
7. Report surge, automated restriction anomaly, compromised admin.
8. Deletion workflow stuck or retained-data policy exception.
9. Bad migration/release rollback or forward-fix.
10. Secret/key rotation and application-field key compromise.
11. Backup restoration and regional recovery.
12. Privacy/security incident containment, evidence preservation, notification decision.

Runbooks include symptoms, safe diagnosis queries, containment, recovery, verification, communication owner, and post-incident actions. They do not instruct operators to edit business tables manually.

## 6. Backup and disaster recovery

- Managed PostgreSQL Multi-AZ/high-availability writer with continuous WAL/PITR and encrypted daily snapshots.
- Backup copies in a separate failure domain/account where available; access is separate from runtime.
- Redis is not backed up as product authority; queue/outbox recovery is tested.
- R2 object versioning/lifecycle decision is aligned with deletion privacy; backups cannot silently defeat deletion policy.
- IaC, migration artifacts, localization/catalog seeds, and container images are reproducible and retained.
- Quarterly restore into an isolated environment verifies schema, row counts, constraints, application smoke tests, and recovery timing.
- A regional exercise rebuilds network, services, secrets, database, Redis, and media access from documented state.

## 7. Operational access

- SSO/MFA for cloud, telemetry, and database administration.
- Just-in-time production role elevation; no shared accounts.
- Read-only approved views for routine support; restricted-content reveal is explicit and audited.
- Database shell access is exceptional; repair uses application commands.
- Every deployment and config change records actor, diff, release, and rollback pointer.
- Synthetic canary User/accounts are clearly marked and excluded from real discovery.

## 8. Cost and capacity review

Track cost per DAU and per successful signup across compute, PostgreSQL, Redis, R2 storage/operations/egress, Telegram/provider-related operations, telemetry, and backups. Weekly at launch, then monthly, review top queries/jobs, cache effectiveness, media bytes, log volume, and over-provisioning. Cost controls must not weaken retention, backup, security, or correctness without an approved design change.

## 9. Release health

Every deployment annotates dashboards and runs synthetic checks for start/signup routing, discovery, Like-to-Match, Nakh funding in test provider mode, chat authorization, media grant, report, and deletion initiation. Progressive rollout automatically stops on SLO burn, payment mismatch, authorization failure, migration error, or queue-age regression.
