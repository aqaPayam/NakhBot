# Domain Documentation

This folder contains the domain model for the Telegram Dating Bot MVP.

The goal is to define the product clearly before database design and coding.

## Files

### `01-glossary.md`

Defines core product terms.

Examples:

* User
* Profile
* Like
* Nakh
* Match
* Chat
* Visibility
* Restriction

### `02-entities.md`

Lists all domain entities grouped by product area.

Examples:

* User
* Profile
* MediaAsset
* ExploreConsumption
* PendingNakh
* Nakh
* Match
* PaymentRecord
* Report

### `03-attributes.md`

Lists the attributes owned by each entity.

This is not the final database schema.

### `04-relationships.md`

Defines how entities connect to each other.

Examples:

* User has one Profile
* Profile has many Photos
* Match has one ChatSession
* Report has Evidence and Snapshot records

### `05-statuses-and-enums.md`

Lists all controlled values used by the system.

Examples:

* AccountState
* SignupStep
* NakhStatus
* MatchStatus
* ChatMode
* PaymentStatus
* ReportStatus

### `06-business-rules-and-invariants.md`

Defines the rules that must always be true.

Examples:

* Pending Nakh is hidden from receiver.
* Sent Nakh appears in Nakhes, not Liked By.
* Matched users cannot Like, Nakh, or Not Interested each other.
* Guest and incomplete users share the same preview counter.

### `07-open-decisions.md`

Lists decisions that are not finalized yet.

Examples:

* Credit package sizes
* Pending payment expiry time
* Optional profile field values
* Support rate limits
* Account reactivation details

## Current Scope

This folder covers domain modeling only.

It does not define:

* Final database schema
* SQL column types
* Indexes
* API endpoints
* Bot handler structure
* Deployment setup

Those will be defined later.
