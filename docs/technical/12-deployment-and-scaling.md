# Deployment and Scaling

## 1. Environment model

Use isolated `local`, `test`, `staging`, and `production` environments. Production has separate cloud account/project, database, Redis, R2 buckets/credentials, Telegram bot/token, KMS keys, domains, telemetry, and operator roles. Staging mirrors topology but may use smaller capacity. Local development uses containers and fake Telegram/payment/R2 adapters by default.

No production personal data is copied to a lower environment.

## 2. Reference production deployment

The baseline is provider-neutral managed infrastructure:

- global DNS/TLS/WAF and load balancer;
- autoscaling managed container service for API, Telegram gateway, workers, and scheduler;
- Multi-AZ managed PostgreSQL writer plus optional read replica;
- highly available managed Redis with TLS;
- private Cloudflare R2 buckets and signed edge delivery worker/CDN;
- managed secret store/KMS;
- OpenTelemetry collector/exporter, metrics/log/tracing backend, and paging;
- Terraform state in a protected remote backend;
- CI identity using short-lived workload federation rather than static cloud keys.

AWS ECS/Fargate + RDS PostgreSQL + ElastiCache is a valid reference mapping, but application packages depend on capability ports, not AWS SDKs. A different managed provider can be selected before production without changing domain/application code. Kubernetes is justified only when team/platform needs make its operational cost worthwhile.

## 3. Network and process layout

- Only edge/load-balancer and signed media-delivery route are public.
- PostgreSQL/Redis accept private-network traffic from explicit workloads only.
- Provider callbacks use dedicated routes, limits, secrets, and observability.
- API and gateway run at least two instances across failure zones in production.
- Workers are separate deployments by queue class: critical billing/safety, notifications, media, and maintenance.
- Scheduler runs multiple replicas for availability but uses lease plus unique schedule runs.
- Migrations run once as an approved deployment stage, never automatically in every application process.

## 4. Container and release policy

- minimal non-root runtime image, read-only filesystem where practical, dropped Linux capabilities, bounded CPU/memory;
- lockfile and base image digest pinned; SBOM and signature produced;
- one commit produces images promoted unchanged;
- graceful shutdown/readiness stops traffic before connection termination;
- startup checks configuration and dependencies but readiness does not depend on optional providers;
- health endpoints disclose no version/secrets beyond authenticated operational needs.

Release sequence:

1. verify backup/PITR and migration compatibility;
2. apply expand migration;
3. deploy canary API/gateway/workers;
4. run synthetic critical journeys;
5. progressively increase traffic and watch error budgets/invariants;
6. activate feature flag/seed if needed;
7. complete backfill/contract migration in later releases;
8. record release and rollback/forward-fix decision.

Application rollback is permitted only while database compatibility is maintained. Destructive migrations are separated by at least one stable release.

## 5. Autoscaling

- API/gateway: request rate, CPU, event-loop lag, p95 latency, and active connections.
- Worker: queue oldest age plus depth and observed service time; separate min/max per queue.
- Media workers: CPU/memory and transform backlog, isolated from critical work.
- PostgreSQL: scale vertically first, tune queries/indexes/pools, then read replicas; do not autoscale connections blindly.
- Redis: memory/eviction/ops and queue workload; use separate cluster for cache vs queue when contention or failure impact is measured.

Use a connection budget: sum of maximum pools across every replica stays below database capacity with operator/migration reserve. A local pool per process has small bounds; add a transaction pooler when scale warrants and verify session-feature compatibility.

## 6. Capacity stages

### Stage A — launch

- modular monolith processes, one HA PostgreSQL writer, HA Redis, private R2;
- PostgreSQL discovery, no read replica required;
- multiple gateway/API instances and queue-class workers;
- target up to 100k DAU after load validation.

### Stage B — growth

Triggers: writer read saturation, analytics/admin interference, notification/media backlog, or millions of active profiles.

- read replica for lag-tolerant queries;
- separate Redis queue/cache clusters;
- derived eligible-profile projection and cached catalogs/localization;
- independently scale media/notification processes;
- tune/partition append-only operational tables;
- target around 1M DAU based on measured usage shape.

### Stage C — large platform

Triggers: stable boundaries plus independent scaling/failure/compliance need.

- CDC/outbox-fed discovery/search service for candidate retrieval, with writer recheck/consumption;
- dedicated notification and media services;
- chat storage/partitioning strategy based on measured message volume;
- regional read/media delivery and disaster-recovery region;
- carefully planned database sharding only after single-cluster limits and access patterns are proven.

User sharding, if ever needed, cannot naively shard by User because pair, Match, and billing workflows cross users. A dedicated design must define pair ownership, global identity lookup, payment ledger placement, and migration/reconciliation.

## 7. Scaling safeguards

- bounded pages, candidate pools, job batches, and provider concurrency;
- keyset pagination and explicit query timeouts;
- load shedding for non-critical work before billing/safety;
- backpressure at ingress/queues; do not accept unlimited memory work;
- bulkheads for providers and queue classes;
- caches have TTL/version and cannot authorize state;
- reconciliation covers every denormalized counter/projection;
- database partitions/extractions follow measurements and ADRs, not expected prestige scale.

## 8. Infrastructure acceptance

Before production:

- Terraform can create a clean environment and policy scan passes;
- no public PostgreSQL/Redis/R2 bucket;
- zone failure preserves service/data;
- autoscaling catches a tested burst and scales down safely;
- secret rotation succeeds without broad downtime;
- database restore and regional rebuild meet RPO/RTO;
- deployment canary stops on injected failure;
- queue recovery from Redis loss republishes committed outbox work;
- signed media authorization and cache purge work at edge;
- cost budget/alerts and capacity ownership are active.
