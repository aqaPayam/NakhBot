# NakhBot

NakhBot is an English-first Telegram dating product for adults in Iran. The MVP is delivered entirely through a Telegram bot, but its domain model is designed so later clients can use the same application services and rules.

This repository contains the product specification, backend technical blueprint, and M0 engineering foundation. Product feature implementation begins with M1.

## Specification authority

The canonical specification is the numbered set in [`docs/domain`](docs/domain/README.md).

When implementing the product:

1. `06-business-rules-and-invariants.md` is authoritative for cross-entity behavior, permissions, concurrency, and acceptance criteria.
2. `05-statuses-and-enums.md` is authoritative for controlled values and allowed transitions.
3. `03-attributes.md` is authoritative for entity-owned data and configured MVP defaults.
4. `04-relationships.md` is authoritative for cardinality and lifecycle flows.
5. `02-entities.md` is authoritative for entity purpose and boundaries.
6. `01-glossary.md` is authoritative for terminology.

If an implementation detail is not specified, choose the simplest design that preserves the invariants. Do not introduce new product behavior in a handler, migration, or background job without updating the canonical document that owns that behavior.

The implementation architecture is specified in [`docs/technical`](docs/technical/README.md). Technical documents may choose how to implement a product rule, but may not change the behavior defined by the domain documents.

## MVP boundaries

The MVP includes:

- Persistent guest previews and guided signup
- Profiles, media, discovery filters, Likes, Liked By, and Not Interested
- Paid Nakh signals
- Matches and bot-relay chat
- Telegram Stars, internal credits, and scoped feature unlocks
- Notifications, reporting, moderation, support, deletion, and safety retention
- English UI localization with a path to Persian and other languages

The MVP does not include:

- A mobile or web client
- Native Telegram direct-message chat
- Automated identity, age, face, liveness, or NSFW verification
- User-facing blocking
- A web admin panel
- User-requested refunds

## Current status

Product decisions and the backend technical blueprint are complete. The M0 foundation and M1 identity/signup/Profile implementation are complete, including PostgreSQL/Redis reliability, security hardening, telemetry contracts, containers, and CI. Final M1 acceptance is waiting only for deployment to a real staging environment and the recorded manual staging checklist. The AWS staging package is default-off and can be validated before an account is purchased. Deployment-specific values such as bot tokens, storage credentials, webhook secrets, and bootstrap admin Telegram IDs must be supplied through environment or secret configuration and are not product decisions.

Local setup and required checks are documented in [`CONTRIBUTING.md`](CONTRIBUTING.md).
