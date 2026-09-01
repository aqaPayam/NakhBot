# Domain-to-Implementation Traceability

This matrix prevents the technical implementation from silently omitting or reinterpreting the 44 minimum acceptance scenarios. Test IDs are stable and must appear in CI reports.

| ID | Required behavior | Primary design owner | Required proof |
|---:|---|---|---|
| ACC-001 | simultaneous first start creates one User | Identity; Telegram ingress | unique Telegram ID + concurrency component test |
| ACC-002 | guest/incomplete share max-ten preview counter | Identity; Discovery | conditional counter update + race test |
| ACC-003 | active invalid Profile routes to Fix Profile | Identity capability; Profile | routing contract test |
| ACC-004 | visibility off blocks discovery, not pending settlement | Discovery; Nakh | eligibility matrix component test |
| ACC-005 | restricted can read, not send chat | Identity; Chat | authorization contract/E2E |
| ACC-006 | banned cannot use support; one appeal/ban | Support; Moderation | FK uniqueness + authorization test |
| ACC-007 | Persian Gregorian year normalized; invalid age/calendar denied | Profile policy | unit/property/adapter tests |
| ACC-008 | one visible + one hidden photo invalid | Profile; Media | revalidation component test |
| ACC-009 | seven concurrent uploads cannot exceed six | Media | locked Profile/photo count race test |
| ACC-010 | thumbnail failure creates no visible photo | Media worker | failure-injection integration test |
| ACC-011 | blurred-preview failure keeps photo valid | Media worker | failure-injection integration test |
| ACC-012 | primary hide promotes and may invalidate | Media; Profile | atomic lifecycle test |
| ACC-013 | delete removes public media, preserves required evidence | Media; Deletion | object/evidence manifest test |
| ACC-014 | Explore gender does not modify Profile preference | Discovery | repository/state comparison test |
| ACC-015 | filter cannot broaden reciprocal compatibility | Discovery | generated property test |
| ACC-016 | preview/consumption prevents repeats | Discovery | unique insert + concurrency/load test |
| ACC-017 | opposite simultaneous Likes create one Match/chat | Interaction; Matching | pair lock/unique constraint race test |
| ACC-018 | Like not withdrawable; Not Interested silent | Interaction; Notification | transition/absence-of-delivery test |
| ACC-019 | Liked By exclusions correct | Interaction query | query matrix at realistic volume |
| ACC-020 | unlock one Like, no time expiry/double charge | Interaction; Billing | partial unique + concurrent funding test |
| ACC-021 | concurrent directional Nakh creates one flow | Nakh | unique pair race test |
| ACC-022 | no sixth unpaid Pending Nakh | Nakh counter | counter-lock race/reconciliation test |
| ACC-023 | unpaid Pending Nakh invisible/silent | Nakh; Notification | query/delivery-negative test |
| ACC-024 | credit increase settles strict FIFO | Billing; Nakh worker | ordered property/concurrency test |
| ACC-025 | duplicate callback delivers one Nakh/notification | Billing; Nakh | provider replay/crash test |
| ACC-026 | visibility ignored, restriction/invalidity blocks settlement | Nakh eligibility | matrix component test |
| ACC-027 | cancellation converts exactly to Like or NotInterested | Nakh; Interaction | atomic shape/concurrency test |
| ACC-028 | rejected stored, Closed displayed | Nakh; Localization | persistence + renderer test |
| ACC-029 | separate 14-day clocks | Nakh scheduler | fake-clock boundary test |
| ACC-030 | accepted Nakh creates one Match/chat under retry | Nakh; Matching | callback replay/concurrency test |
| ACC-031 | unmatch terminal; report exactly 24h | Matching; Moderation | fake-clock boundary and property test |
| ACC-032 | concurrent chat unlock charges once, benefits Match | Billing; Interaction | lock/partial unique race test |
| ACC-033 | unlock no clock expiry, ends on closure/revocation | Interaction; Chat | authorization lifecycle test |
| ACC-034 | pre-unlock text and all media rejected | Chat | command negative tests through adapters |
| ACC-035 | keep 50 normal messages, preserve snapshots | Chat cleanup; Moderation | retention job integration test |
| ACC-036 | package callback grants credits once | Billing | provider replay + ledger test |
| ACC-037 | failed paid action corrected once | Billing; target coordinator | injected-boundary correction test |
| ACC-038 | mutable mute respected; critical notices bypass | Notification | preference matrix/delivery test |
| ACC-039 | threshold uses distinct reporters | Moderation | uniqueness/window test |
| ACC-040 | concurrent fifth reports one restriction, no ban | Moderation; Identity | multi-connection race/audit test |
| ACC-041 | every admin mutation permission-checked/logged | Administration | full permission matrix + failure log test |
| ACC-042 | deletion immediate, resumable, no restoration | Deletion coordinator | checkpoint interruption/manifest E2E |
| ACC-043 | return keeps preview/safety retention | Identity; Retention | delete-return E2E |
| ACC-044 | no handler-owned English prose | Localization | static scan + adapter contract test |

## Cross-cutting rule coverage

| Domain rule family | Persistence/transaction | Adapter/operation | Verification |
|---|---|---|---|
| Account access/routing | Account/history/capability in `03` and `04` | Telegram routing in `06` | access matrix and ACC-001..006 |
| Profile/catalog/media | Profile constraints and media lifecycle in `03` | ingestion/delivery in `08` | ACC-007..013 + media corpus |
| Discovery/reciprocity | query/consumption in `03` | generic Explore contract in `04` | ACC-014..016 + property/load |
| Like/Liked By | pair locks/unique rows in `05` | commands/queries in `04` | ACC-017..020 |
| Nakh | flow/quota/transactions/jobs in `03`/`05` | Telegram/payment integration `06`/`07` | ACC-021..030 |
| Match/chat | exact membership/sequence/closure `03`/`05` | relay in `06` | ACC-030..035 |
| Payment/credits | ledger/provider uniqueness `03`/`07` | Stars flow `06` | ACC-020/024/025/032/036/037 |
| Notifications | durable delivery/preferences `03`/`05` | Telegram classification `06` | ACC-018/023/025/038 |
| Safety/admin/support | restricted schemas/commands `03`/`04`/`09` | operator controls `10` | ACC-039..041 |
| Deletion/retention | saga/checkpoints/manifest `03`/`05`/`09` | runbook/restore `10` | ACC-013/035/042/043 |
| Localization/config/jobs/audit | contracts and platform tables `03`/`04`/`05` | operations `10` | ACC-028/044 + static/schema checks |

## Change rule

When a domain rule or acceptance scenario changes, the same pull request must update:

1. canonical domain document;
2. affected technical design;
3. this traceability row;
4. contract/schema/migration plan;
5. automated test ID and any performance/security/deletion registry;
6. localization/config/seed artifact where applicable.

An acceptance scenario may be split into more tests, but its stable ID cannot disappear.
