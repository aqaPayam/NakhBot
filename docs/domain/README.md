# Domain Documentation

This folder contains the product domain model for the Telegram Dating Bot MVP.

The goal is to define the product concepts before database design and coding.

## Folder Contents

* `01-glossary.md`
  Defines core product terms and their meanings.

* `02-entities.md`
  Lists the domain entities used by the product.

* `03-attributes.md`
  Lists the attributes owned by each entity.

* `04-relationships.md`
  Defines how entities are connected.

* `05-statuses-and-enums.md`
  Lists controlled status values and enums.

* `06-business-rules-and-invariants.md`
  Defines product rules that must always hold.

* `07-open-decisions.md`
  Tracks decisions that are not finalized yet.

## Current Status

This is domain documentation, not final database schema.

Database tables, indexes, constraints, and migrations will be designed after this domain model is stable.

## Maintenance Rules

* Keep product terms consistent across all files.
* Do not add database-specific details here unless needed for domain clarity.
* Do not duplicate business rules across many files.
* Put cross-entity rules in `06-business-rules-and-invariants.md`.
* Put unresolved questions in `07-open-decisions.md`.
