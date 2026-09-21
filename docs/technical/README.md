# Backend Technical Blueprint

This directory converts the canonical product model in [`../domain`](../domain/README.md) into an implementation-ready backend design. It is written for the backend lead, application engineers, database engineer, platform engineer, QA engineer, and security reviewer who will build and operate Nakh.

## Scope

The blueprint covers:

- a channel-independent application core used by Telegram now and web/mobile later;
- service and module boundaries;
- PostgreSQL ownership, schema, constraints, indexes, and concurrency;
- synchronous APIs, durable events, background jobs, and idempotency;
- Telegram, Telegram Stars, media, notifications, moderation, and deletion;
- security, privacy, testing, observability, deployment, and scaling;
- an ordered implementation plan with release gates.

It deliberately does not contain application code or migrations. Those are the next delivery phase.

## Authority and change control

The domain documents own product behavior. This technical package owns implementation choices. If the two conflict, the domain rule wins and the technical package must be corrected.

Within this directory, authority is:

1. [`03-data-architecture.md`](03-data-architecture.md) owns persistence structure and database constraints.
2. [`04-modules-and-contracts.md`](04-modules-and-contracts.md) owns module ownership and synchronous contracts.
3. [`05-transactions-events-and-jobs.md`](05-transactions-events-and-jobs.md) owns transaction boundaries, asynchronous delivery, concurrency, and idempotency.
4. Specialized documents own their named integration or operational concern.
5. [`01-architecture.md`](01-architecture.md) owns system-wide principles and topology.
6. [`02-stack-and-repository.md`](02-stack-and-repository.md) owns selected technologies and source layout.

Any product behavior change requires a domain-document update first. Any persistent contract change requires a migration, compatibility analysis, and update to this package. Architectural decisions that reverse a locked choice require an ADR.

## Document map

| Document | Purpose |
|---|---|
| [`01-architecture.md`](01-architecture.md) | Quality goals, topology, boundaries, scaling model |
| [`02-stack-and-repository.md`](02-stack-and-repository.md) | Runtime, frameworks, dependencies, monorepo layout |
| [`03-data-architecture.md`](03-data-architecture.md) | PostgreSQL schemas, tables, constraints, indexes, retention |
| [`04-modules-and-contracts.md`](04-modules-and-contracts.md) | Module APIs, ownership, client-facing API conventions |
| [`05-transactions-events-and-jobs.md`](05-transactions-events-and-jobs.md) | Atomic workflows, outbox/inbox, queues, schedules |
| [`06-telegram-and-client-channels.md`](06-telegram-and-client-channels.md) | Telegram webhook and future web/mobile adapters |
| [`07-payments-and-entitlements.md`](07-payments-and-entitlements.md) | Stars, credits, receipts, refunds, feature unlocks |
| [`08-media-delivery.md`](08-media-delivery.md) | Upload, moderation, R2, transformations, access control |
| [`09-security-privacy-and-abuse.md`](09-security-privacy-and-abuse.md) | Threat controls, access, deletion, moderation safety |
| [`10-observability-and-operations.md`](10-observability-and-operations.md) | SLOs, telemetry, runbooks, backup, recovery |
| [`11-testing-strategy.md`](11-testing-strategy.md) | Test layers, fixtures, concurrency and contract tests |
| [`12-deployment-and-scaling.md`](12-deployment-and-scaling.md) | Environments, deployment, capacity stages, extraction triggers |
| [`13-implementation-plan.md`](13-implementation-plan.md) | Milestones, team ownership, definition of done |
| [`14-traceability-matrix.md`](14-traceability-matrix.md) | Domain-rule-to-design-and-test coverage |
| [`15-official-references.md`](15-official-references.md) | Primary implementation references and version checks |
| [`16-m1-execution-guide.md`](16-m1-execution-guide.md) | Exact M1 scope, sequencing, contracts, tests, and release gates |
| [`17-data-retention-registry.md`](17-data-retention-registry.md) | User-data classification and product-deletion behavior |
| [`18-m1-acceptance-evidence.md`](18-m1-acceptance-evidence.md) | M1 automated and staging evidence ledger |
| [`19-m2-execution-guide.md`](19-m2-execution-guide.md) | Exact M2 media sequencing, safety boundaries, PR gates, and evidence |
| [`20-m2-acceptance-evidence.md`](20-m2-acceptance-evidence.md) | M2 automated evidence, external blockers, and staging handoff ledger |
| [`21-m3-execution-guide.md`](21-m3-execution-guide.md) | Exact M3 discovery, interaction, delivery, concurrency, query-plan, and acceptance sequence |
| [`22-m3-acceptance-evidence.md`](22-m3-acceptance-evidence.md) | M3 automated evidence, external blockers, and staging handoff ledger |
| [`23-m4-execution-guide.md`](23-m4-execution-guide.md) | Exact M4 billing, Stars, paid-unlock, correction, reconciliation, and acceptance sequence |
| [`24-m4-acceptance-evidence.md`](24-m4-acceptance-evidence.md) | M4 automated evidence, operational gates, external blockers, and staging handoff ledger |
| [`25-m5-execution-guide.md`](25-m5-execution-guide.md) | Exact M5 Nakh lifecycle, funding, FIFO settlement, receiver action, and acceptance sequence |

## Locked baseline

- Architecture: modular monolith with independently deployable stateless entry points and workers.
- Runtime: Node.js 24 LTS and strict TypeScript.
- HTTP/application framework: NestJS with Fastify.
- Primary data store: one highly available PostgreSQL cluster with module-owned schemas.
- SQL access: Kysely plus `pg`; migrations are explicit SQL.
- Cache and queue transport: Redis plus BullMQ; PostgreSQL remains the source of truth.
- Reliability: transactional outbox, consumer inbox, idempotent commands, and at-least-once event/job handling.
- Media: private Cloudflare R2 objects, CDN delivery, and separate upload/processing/moderation states.
- Observability: OpenTelemetry-compatible traces, metrics, and structured logs.
- Packaging: pnpm workspace monorepo and OCI containers.
- Infrastructure: Terraform and a managed container/PostgreSQL/Redis baseline; no Kubernetes requirement for MVP.

## Open inputs, not design blockers

The following values are required before staging or production deployment, but do not block coding:

- hosting provider and primary/secondary regions;
- DNS domains and CDN hostname;
- Telegram bot token, payment configuration, and webhook secret;
- R2 account, bucket, signing credentials, and lifecycle values;
- secrets/KMS, error-tracking, email/on-call, and paging provider accounts;
- expected launch cohort and support/moderation staffing schedule.

Where a provider has not been selected, the blueprint defines a capability and a reference deployment rather than leaking provider SDKs into domain code.
