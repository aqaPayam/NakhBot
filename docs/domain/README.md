# NakhBot Domain Specification

This folder is the canonical, implementation-ready product specification for the NakhBot MVP.

## Documents and ownership

| Document | Owns |
|---|---|
| `01-glossary.md` | Stable product vocabulary |
| `02-entities.md` | Domain boundaries and entity responsibilities |
| `03-attributes.md` | Entity-owned data, seed requirements, and configurable defaults |
| `04-relationships.md` | Cardinality, stateful workflows, and lifecycle effects |
| `05-statuses-and-enums.md` | Controlled values and legal state transitions |
| `06-business-rules-and-invariants.md` | Normative rules, permissions, transactions, concurrency, and acceptance criteria |
| `07-decision-status.md` | Resolution record and non-product deployment inputs |

Rules are intentionally owned by one document. Other documents may link to a rule but should not restate it in a way that can drift.

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` have their usual requirements meaning:

- `MUST` / `MUST NOT`: required for a correct MVP.
- `SHOULD` / `SHOULD NOT`: expected unless a documented technical reason justifies an exception.
- `MAY`: optional behavior that cannot change the defined product contract.

User-facing labels are localized. Lowercase identifiers in these documents are stable internal codes and must never be shown directly to users.

## Change discipline

Every product change must update:

1. The document that owns the affected rule.
2. Any controlled value or transition affected by it.
3. The acceptance criteria in `06-business-rules-and-invariants.md`.
4. Tests and migrations once implementation begins.

The documentation describes domain behavior, not a mandatory physical table layout. A database design may combine or split storage structures only if entity ownership, auditability, deletion behavior, and all invariants remain intact.
