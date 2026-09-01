# Stack and Repository Design

## 1. Selected stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 24 LTS | Maintained production LTS, strong TypeScript ecosystem, efficient I/O |
| Language | TypeScript, strict mode | One typed language for API, adapters, workers, contracts, and tests |
| HTTP/application | NestJS on Fastify | Explicit dependency boundaries and lifecycle with a fast HTTP adapter |
| Validation/contracts | TypeBox plus Ajv | Runtime validation and generated JSON/OpenAPI schemas from typed contracts |
| SQL | Kysely plus `pg` | Typed SQL without hiding PostgreSQL capabilities or transaction control |
| Migrations | Ordered SQL migrations with a small migration runner | Constraints and indexes remain reviewable and database-native |
| Primary database | Managed PostgreSQL, latest provider-supported major | ACID transactions, relational constraints, indexing, full-text/geo extension path |
| Cache/queue | Managed Redis plus BullMQ | Rate limits, ephemeral state, leases, delayed jobs, horizontal workers |
| Object storage | Cloudflare R2 through an internal S3-compatible port | Private durable media with CDN support and provider portability |
| Telemetry | OpenTelemetry SDK | Vendor-neutral traces, metrics, and log correlation |
| Tests | Vitest, Testcontainers, Fastify inject, Playwright later for web | Fast unit tests and real PostgreSQL/Redis integration verification |
| Workspace | pnpm workspaces | Deterministic installs and shared package boundaries |
| Packaging | OCI multi-stage images | Same artifact through local, staging, and production |
| Infrastructure | Terraform | Reviewable, reproducible environments |

Pin exact versions in the root lockfile and container digests. Runtime and database majors are upgraded through scheduled compatibility work; do not silently track `latest` in production.

## 2. Dependency rules

Dependencies point inward:

```text
adapters -> application -> domain
infrastructure -> application ports
bootstrap -> all composition-only packages
domain -> no framework, provider SDK, SQL, Redis, HTTP, or Telegram dependency
```

- Domain packages contain entities/value objects only when behavior benefits from them, pure policies, errors, and controlled values.
- Application packages contain commands, queries, coordinators, authorization, transaction ports, and result contracts.
- Infrastructure implements repositories, event stores, queues, media, provider clients, telemetry, and clocks.
- Adapters translate HTTP/Telegram/job input and application output. They never implement product rules.
- Import boundaries are enforced with ESLint rules and architecture tests in CI.

## 3. Monorepo layout

```text
/
  apps/
    api/                    # public/internal HTTP bootstrap
    telegram-gateway/       # Telegram webhook and rendering bootstrap
    worker/                 # named BullMQ consumers
    scheduler/              # leader-elected due-job enqueuer
  packages/
    domain/                 # pure rules and shared value types
    application/            # use cases and module public ports
    contracts/              # versioned API/event/job schemas
    persistence-postgres/   # repositories, queries, unit of work
    queue-redis/             # BullMQ producers/consumers and leases
    telegram/                # Telegram client and presentation adapter
    media-r2/                # object-store adapter
    localization/           # message catalog and render contract
    observability/          # tracing, metrics, redaction, audit helpers
    config/                 # typed environment loading and validation
    testkit/                # builders, database reset, fake clock, provider fakes
  migrations/
    000001_*.sql
    verify/                  # read-only post-migration assertions
  deploy/
    docker/
    terraform/
    dashboards/
    runbooks/
  docs/
    domain/
    technical/
```

Inside `packages/application`, organize by business module rather than technical layer:

```text
application/src/
  identity/
  profile/
  media/
  discovery/
  interaction/
  nakh/
  matching/
  chat/
  billing/
  notification/
  moderation/
  support/
  administration/
  account-lifecycle/
  platform/
```

Each module exports only its public commands, queries, results, events, and ports from one `index.ts`. Deep imports across module folders fail CI.

## 4. Runtime configuration

Configuration is parsed once at process startup into a typed immutable object. Startup fails if a required value is missing or invalid. Required groups include:

- runtime/environment and service name;
- HTTP bind/port, trusted proxy count, request limits, and graceful shutdown;
- PostgreSQL writer and optional reader DSNs, pool sizes, statement/lock timeouts;
- Redis TLS DSN and queue prefixes;
- Telegram token reference, webhook secret, webhook base URL, and provider limits;
- R2 endpoint, bucket names, credentials, CDN host, signing secrets, and upload limits;
- encryption/KMS key references and key version;
- telemetry exporter, sampling, alert routing, and release version;
- feature flags and operational limits from a versioned configuration table.

Secrets are references resolved from the deployment secret manager. They are never committed, printed, embedded in images, or returned from diagnostics.

## 5. Coding standards

- TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and explicit public return types.
- No `any` at boundaries; `unknown` must be validated.
- Money-like and credit values are integer types; no floating point.
- Database rows, domain types, API types, and provider types are distinct even when structurally similar.
- Functions receive a clock and ID generator where determinism matters.
- All commands carry `actor`, `requestId`, `idempotencyKey`, `occurredAt`, and optional `channelContext`.
- Expected business rejections are typed error codes; exceptions represent faults.
- Logs are structured and pass through centralized redaction.
- Provider SDK calls exist only behind owned interfaces.

## 6. Database migration policy

Use expand/migrate/contract changes:

1. add compatible tables/columns/indexes;
2. deploy code that reads/writes both forms when required;
3. backfill in bounded, observable batches;
4. verify counts and constraints;
5. switch reads;
6. remove old structures in a later release.

Production migrations must be backward-compatible with the previous application release, acquire no unbounded table lock, set `lock_timeout` and `statement_timeout`, and include a rollback or forward-fix procedure. Large indexes use `CREATE INDEX CONCURRENTLY` outside a transaction. Schema drift checks run in CI and deployment.

## 7. Versioning and releases

- HTTP APIs are prefixed `/v1`; additive fields do not require a new version.
- Event and job types use stable names plus integer `schemaVersion`.
- Database migrations are immutable after merge.
- Containers are tagged by commit SHA and promoted without rebuild.
- Domain, contract, and migration changes require code-owner review.
- Feature flags separate deployment from activation but may not bypass invariants.

## 8. Rejected alternatives

- **Microservices now:** adds distributed consistency and operational load before team/domain boundaries are proven.
- **Serverless functions for all handlers:** awkward for connection pools, queue consumers, Telegram throughput control, and predictable latency; individual media jobs may still use serverless compute later.
- **Document database as source of truth:** product behavior is relationship- and constraint-heavy.
- **ORM-generated migrations:** insufficient review control for partial indexes, exclusion/unique constraints, lock behavior, and backfills.
- **Redis-only queues without outbox:** a committed business change could lose its required side effect.
- **Telegram handlers as application services:** would make future clients repeat or bypass business rules.
