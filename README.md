# NakhBot

NakhBot is an English-first Telegram dating product for adults in Iran. The MVP is delivered entirely through a Telegram bot, but its domain model is designed so later clients can use the same application services and rules.

This repository contains the product specification, backend technical blueprint, and the implemented
M0, M1, and provider-neutral M2 backend foundations.

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

Product decisions and the backend technical blueprint are complete. M0 and the provider-neutral M1
identity/signup/Profile and M2 secure-media implementations are green in CI. Final M1 acceptance is
waiting for the real staging checklist. Final M2 acceptance additionally requires private R2/CDN
infrastructure, real-provider fault/load evidence, and the authenticated owner photo-management
transport recorded in
[`20-m2-acceptance-evidence.md`](docs/technical/20-m2-acceptance-evidence.md). All media features
remain default-off until those prerequisites are supplied. The AWS staging package can be validated
without purchasing an account and creates no resources until an authorized operator applies it.
Deployment-specific tokens, storage credentials, webhook secrets, and bootstrap administrator
identities are external configuration, not product decisions.

Local setup and required checks are documented in [`CONTRIBUTING.md`](CONTRIBUTING.md).
