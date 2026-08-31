# Decision Status

There are no unresolved product decisions that block MVP implementation.

## Resolved during specification consolidation

- Profile relationship preference and the current Explore gender filter are separate concepts.
- Normal Explore uses reciprocal relationship-preference compatibility. The current Explore gender filter only narrows that eligible set.
- MVP gender options are `man`, `woman`, and `other`; the catalog remains extensible.
- `hidden` photos are moderation-controlled. Users may reorder, replace, or delete their own photos but cannot hide them.
- A thumbnail is required at upload time. A blurred preview is generated and cached on demand for a locked Liked By card's current primary photo.
- Liked By and chat unlocks have no time-based expiry in MVP.
- Account deletion permanently removes ordinary product data. A retained identity may return only through a fresh signup and never receives old product data or purchases.
- `seen` is the delivered-Nakh view status. Pending Nakh status is not part of delivered Nakh status.
- A stable `NakhFlow` enforces one Nakh attempt per directional user pair while pending and delivered records remain separate.
- Direct Telegram Stars prices are 2 Stars for Nakh, 4 Stars for one Liked By unlock, and 4 Stars for one match-chat unlock.
- Pending Nakh reminders run on a 48-hour cadence during a 14-day pending lifetime.
- Explore uses a default candidate pool of 100 and refreshes shuffle keys every 6 hours.
- HEIC/HEIF is not accepted in MVP. JPEG, PNG, and WebP are accepted after content validation.
- Optional profile enum values are finalized in `05-statuses-and-enums.md`.

## Required deployment inputs

The following are secrets or environment-specific data, not open product decisions:

- Telegram bot token and webhook secret
- Telegram payment/provider credentials and payload-signing secrets
- Cloudflare R2 and CDN credentials
- Database and queue connection values
- Bootstrap admin Telegram user IDs
- Public service URLs

## Required seed artifacts

Before a production launch, the implementation repository must contain versioned seed data for:

- All supported Iranian provinces and cities
- Interests
- Spoken languages
- Personality tags
- Predefined chat questions and answers
- English localization keys

The schema and product flows can be implemented before the final wording or ordering of these catalogs. Missing production seed data blocks release, not domain implementation.
