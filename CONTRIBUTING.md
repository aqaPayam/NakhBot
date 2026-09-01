# Contributing

## Requirements

- Node.js 24 LTS
- pnpm 11
- Docker with Compose for PostgreSQL and Redis integration checks

## Setup

```sh
pnpm install
docker compose -f deploy/docker/compose.yml up -d postgres redis
cp .env.example .env
pnpm db:migrate
pnpm db:verify
pnpm check
pnpm test:integration
```

## Architecture rules

- Product behavior comes from `docs/domain`; implementation choices come from `docs/technical`.
- Dependencies point inward: adapters to application to domain.
- Import another workspace package only from its public index.
- Domain code imports no framework, SQL, Redis, queue, HTTP, Telegram, or provider SDK.
- External input is `unknown` until validated by a versioned contract.
- State-changing commands define authorization, idempotency, transaction/locks, audit, outbox, retention, and tests.
- Never edit an applied migration. Use expand/migrate/contract changes.
- Never log profile/chat/report/support text, Telegram identity, payment payload, charge identifier, object key, signed URL, or a secret.

## Required checks

`pnpm check` runs formatting, lint, strict type checking, unit tests, and all builds. PostgreSQL/Redis integration tests run with `pnpm test:integration` and are mandatory in CI.

The M0 sample-effect route is a non-production walking skeleton for idempotency/outbox verification. It returns 404 in production and is removed when the first real M1 vertical slice replaces it.
