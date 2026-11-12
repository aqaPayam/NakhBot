# M9 implementation verification and launch handoff

Status: **Stars payment flow implemented; new purchases paused while the distinct-checkout approval repair is qualified. Real-user payment acceptance and unrestricted public launch remain separate**.

The current payment behavior, approved prices, deployed controls and exact
acceptance boundary are recorded in the
[Stars payment implementation handoff](40-stars-payment-implementation.md).
The dated entries below preserve earlier preparation and paused-deployment
states; they do not override the subsequent authorized activation.

## Actual paused Stars deployment and stop observer - 12 November 2026

Source `d2837ae5f2e637ee37ccbf05656b81cf0cb23669` passed all six jobs on
attempt one in [run 43195970896](https://github.com/aqaPayam/NakhBot/actions/runs/43195970896).
Its ten source-bound artifacts and supplemental restore fixture were verified;
1,665 native cases in 189 files have zero skips. The unchanged 20,000-row,
1,500 ms M7 terminal gate took 1,169.259 ms. Local `pnpm check` passed before
commit. Tracked lines were 318,301, summed across every `wc` total chunk.

All four services now run that accepted source on the existing VPS. Only
migration 172 was applied. Schema verification, compatibility, five purpose
roles and four actual service-reference captures passed. The older 171 migration
files use CRLF on this server; the current archive uses LF. The first isolated
upgrade correctly refused their differing raw checksums. Qualified VPS images
preserve all 171 original raw files plus migration 172's archive bytes, prove
canonical SQL and authentic Git tree unchanged, and verify every raw checksum
in all four runtime images and the source carrier. No native migration record
was rewritten. Existing database/Redis volumes and encrypted administrator
authenticator credentials were preserved.

The owner approved the proposed v1 English terms, support `@NakhSupport`, packages
10/25/50/100 credits for 10/20/35/60 Stars, and direct Nakh for 2 Stars. The live
financial-role capture matches that proposal and approval digest exactly. New
financial keys are independent from navigation and retained in the protected
encrypted backup. Actual private R2 upload/read/anonymous denial/delete/absence
and clean/EICAR scanner probes passed with synthetic content only. The encrypted
deployed-release backup was authenticated off-host and its database members
actually restored into an isolated, networkless, non-root, swap-disabled RAM-only
container: 172 migration records and one account, followed by verified removal.
The private backup key stayed on the PC; plaintext was not written to disk.

Graceful four-service restart and Telegram webhook registration passed, including
pre-checkout updates, authentication rejection, an authenticated empty probe and
preservation of pending updates. A diagnostic printed the old webhook check
value; it was replaced in protected service files, proxy and Telegram before
delivery resumed. No bot API token was changed or printed. Native product
admission is closed, new invoices and free top-ups are off, while financial
ingress and refunds remain enabled. The tested independent native stop preserves
the webhook and financial processing. A separate live active-invoice stop drill
was rejected by automatic approval review because it would enable real charges;
it was not executed. Explicit activation permission is pending separately from
price/terms approval. No funded purchase, real-provider receipt or unrestricted
public launch acceptance is claimed. Cloudflare key renewal still needs the
owner's separate login permission; cache-cleanup custody expires on 13 November
at 20:29:59 UTC. Any bounded opening must end before that expiry unless renewed.

The physical-drain observer still assumed an inline webhook secret despite the
deployed protected-file configuration. The repair resolves only a single
read-only bind below the private host secret root, opens each path component
without following symlinks, checks private root/service ownership and file
metadata before and after reading, and rejects ambiguous settings. The receipt
still contains no secret. Ledger-format image tags require their exact reviewed
build tag and image digest; arbitrary tags, changed images, active producers or
missing physical hold remain denied. These changes do not enable deletion or
payments. Their own full check and six-job acceptance remain required.

## Checkout repair after consent integration - 12 November 2026

Consent source `03b10c48fe4797483f53114917ad03d7a5ddf54a` is **not accepted**.
Its full local check and 36 focused native Stars cases passed, but the scheduler
shard in [run 43183568174](https://github.com/aqaPayam/NakhBot/actions/runs/43183568174)
found the existing signup Stars route trying to create an invoice before
collecting the newly required consent. The other quality/image jobs passed;
reliability was skipped. No unchanged CI retry or weakened consent guard is used.

The repair connects a purchase review to that route and the account credit menu.
The original private account life and captured sign-in grant remain authoritative;
checkout never registers an account or issues a replacement grant. A separate
`purchase` MAC namespace fences public selectors from other menus. Package
selection creates an existing native funding intent and reviews its immutable
price/quantity snapshot before confirmation. Agree and Cancel share one owned
menu claim. Exact provider redeliveries retain the accepted offer, consent and
invoice identity, including an ambiguous invoice acknowledgement. The provider's
bounded 502 error now reaches this route rather than the old signup catch's
generic 500; the full-process case retains its four-delivery/one-attempt assertions.
A later full-process check caught the product-stop fixture leaving new invoices
on while signup was stopped. It now explicitly pauses new invoices and verifies
that public terms register no account and an existing receipt still replays once.
Paused approved checkout does not require the primary signup/menu flags; active
new charging still does. The diagnostic case passes, but is not full-suite
acceptance. All unfiltered checks and the repair's own six jobs remain required.
The current Stars, checkout and signup files pass all 64 native cases with no
skips. An earlier seven-file run passed 91 cases across schema, reference,
identity and deletion coverage as well as those product paths; the additional
payment-pause case was then verified in the final 64-case run. Separate focused
migration probes passed bootstrap/replay and the migration-162 upgrade. The other
87 migration cases remain mandatory in CI; focused local filtering supplies no
full-migration acceptance. No funded payment or real-provider receipt is claimed.

`NAKH_STARS_PURCHASE_APPROVAL_DIGEST` defaults empty. Enabled checkout requires
an exact approval of the captured public terms, active package prices/quantities,
Nakh price, default/active locales and configured support contact. Capturing that
read-only repeatable snapshot is not approval. Its approved presentation is
captured at startup; a newly created native offer must still match that reviewed
policy. The consent records the rendered offer/document digest and original
locale before the protected Stars adapter can present an invoice. Choosing the
review confirmation does not itself charge Stars or fulfill a purchase.

The public `/terms` route works without registering an account and remains
available with invoices paused and an approved policy configured.
A paused shop-policy mismatch disables terms presentation rather than publishing
unapproved terms, and returns the payment-support route instead. It cannot block
the underlying recorded-payment ingress from starting. Active new charging still
requires the exact reviewed policy and complete customer entry readiness. It shares the
financial ingress's position before product admission, while purchase navigation
remains behind cohort admission. `/paysupport` retains the existing external
contact and ordinary support behavior. Actual receipts and corrections remain
independent of new invoice availability and customer sign-in lifetime.

Migration 172 adds seventeen English presentation rows and no user-linked table
or column. Baseline-to-current, schema/reference, locale and deletion coverage
fixtures include it; retained erasure remains disabled. Deploy the migration
before the new checkout source. A 171-only image is not a qualified rollback on
a 172 database. Prepare a checked 172-compatible rollback mode with invoices off
and financial/privacy processing active; do not restore away later financial
receipts. The live VPS remains on its accepted 171/free-credit deployment while
this repair is checked. Owner price/terms review, funded provider acceptance and
paid deployment/stop-path verification remain separate, uncompleted steps.

## Completion objective and Stars consent - 12 November 2026

The owner has resumed the goal and requested completion of all remaining product
implementation and launch preparation. Continue coherent implementation and
verification batches until complete; do not stop at individual feature summaries.
Existing purchase, login and retained-erasure restrictions still apply. Real
provider acceptance and operator decisions must not be replaced by assumptions.

Invoice source `db77ae3d353e7637c4340a56603b63b891762515` passed all six jobs
on attempt one in [run 43171878372](https://github.com/aqaPayam/NakhBot/actions/runs/43171878372).
Its 1,635 native cases across 188 files have zero skips. Ten source-bound artifacts
and the supplemental restore fixture were verified; the unchanged 20,000-row M7
terminal query took 1,457.122 ms against the 1,500 ms limit. Local `pnpm check`
passed before that commit. Tracked lines were 316,255.

The consent increment reuses append-only native audit facts for explicit customer
acceptance. A confirmation binds the immutable offer digest, rendered-document
digest, terms version, locale, native account life and original sign-in grant.
It contains no purchase prose, Telegram identifier or provider secret. Canonical
hashing survives PostgreSQL JSON key ordering. Identical concurrent confirmations
produce one fact; retries preserve the original command/request identifiers and
are not charged against the bounded new-consent limit.

Review, acceptance and invoice authorization take the existing billing-user lock
before the original native identity/session fences. Account state, pending status,
version, native expiry and captured-payment exclusion are rechecked on replay.
The public Stars factory requires native consent before preparing an invoice and
rechecks it after localization. This does not authorize fulfillment: real provider
receipts and the existing ledger remain its independent authority. Recorded paid
callbacks continue processing with invoices disabled or the session revoked.

The native Stars file passes all 36 cases, including concurrent confirmation,
cross-owner/offer/life/grant rejection, immutable audit, malformed metadata,
expiry, cancellation and paid-receipt independence. The first fixture tried to
change an account epoch directly; the native verified-Return guard correctly
rejected it. The repaired case preserves that guard and rejects a consent claimed
for another life. Malformed writes now reject through their promised async
contract. No native lifecycle or validation guard was weakened.

There is no schema migration or new user-linked relation. Existing migration and
restore gates still apply. These audit rows remain covered by the registry's
actor-linked `platform.audit_logs` operational policy; retained-record erasure
stays disabled pending approved policies. Customer checkout must supply the
reviewed consent before live invoice creation can be enabled. The customer terms,
package selection and paid deployment review remain open; this source is not a
paid-launch approval. Its own full check and six exact-head jobs remain required.

## Stars purchase preparation - 12 November 2026

The owner now wants real purchases through Telegram Stars. This supersedes the
earlier deferral of payment implementation; it does not authorize the operator
to buy Stars, perform funded test purchases, change billing limits or activate
unreviewed prices and purchase terms. Keep live charging disabled while completing
the customer checkout, acceptance and refund/support presentation.

After the owner made the repository public, all six checks for `1e899dc` passed
on attempt two in [run 43046506391](https://github.com/aqaPayam/NakhBot/actions/runs/43046506391).
The original attempt had executed no test steps because GitHub rejected job
startup for account payment/spending settings. The owner changed the repository
conditions before the diagnosed rerun; no billing limits or test gates changed.
Ten artifacts and the separate restore rehearsal were verified. The unchanged
20,000-row M7 terminal query took 811.676 ms against the 1,500 ms limit.

The next invoice increment connects existing native credit-package attempts to
Telegram's fixed `XTR` transport. Credit quantity and Star amount come from the
stored payment snapshot, not callback-supplied prices or the current catalog.
Owned original account life, active account state, pending/unexpired intent and
unpaid attempt are required; presentation is rechecked after localization waits
and the original session is rechecked before the provider call. Nakh invoices keep
their existing two-Star presentation. Other direct paid-action invoice surfaces
remain outside this increment; users will fund their ordinary credit balance.

The complete focused transport suite passes 17 cases. The complete native Stars
file passes 18 cases, covering all four package amounts, stored-payload replay,
concurrent creation of one new attempt, later catalog changes, cross-owner denial
and completed-payment denial alongside existing callback/custody cases. A first
concurrency fixture mistakenly requested an already-open equivalent offer; native
billing correctly reused it. The repaired fixture selects a distinct package
before checking concurrent attempt creation. No deduplication guard was weakened.
These runs use disposable databases and synthetic provider responses, not funded
payments or live Telegram purchase acceptance. This increment still needs its
full check and exact-head six-job acceptance before release.

Customer package selection, reviewed purchase terms and explicit acceptance,
refund/support presentation and the final paid deployment review remain separate
work. Current catalog definitions are implementation inputs, not newly approved
launch prices. The previously deployed free-credit trial remains separate from
paid activation. Cloudflare cache-purge credential renewal remains deferred at
the owner's request; its observed expiry is `2026-11-13T20:29:59Z`.

## Clean trial deployment - 11 November 2026

Accepted application source `b55363d54e81d64a9d56730c606415d52c9e72a1`
passed all six jobs on attempt one in
[run 42298593585](https://github.com/aqaPayam/NakhBot/actions/runs/42298593585):
1,584 unit tests and 1,627 native tests across 188 files, with no native skips.
The unchanged 20,000-row M7 terminal query took 1,232.761 ms against its
1,500 ms limit. Ten ordinary artifacts and the separate restore rehearsal were
verified. No unchanged reliability retry or relaxed gate was needed.

That application source is now deployed on the existing VPS. A final encrypted
source backup was copied to protected off-host custody, authenticated in memory
and restored into an isolated temporary database: 164 migrations and three
accounts were verified before the temporary database was removed. The source
policy was closed, authenticated incoming transport was held, and all four old
application producers stopped gracefully before administrator carryover. The old
PostgreSQL and Redis named volumes remain preserved offline.

The fresh cluster has 171 migrations, five new purpose logins and verified TLS
for PostgreSQL and Redis. The Root carryover command transferred one workforce
identity, one active administrator, one role assignment and one encrypted TOTP
credential. It rechecked the unchanged stopped-source credential fingerprint
after target commit. Test dating profiles, photos, balances, old sign-in sessions,
MFA proofs and pending enrollments were not copied. No real owner authenticator
seed was decrypted, and no owner sign-in session was fabricated.

The actual source archive and deployed target migration files use **CRLF**.
An earlier preparation receipt described the target as canonical LF; that
description was incorrect. The qualification checkout was rebuilt from the
authentic commit with CRLF checkout configured before extraction. All 171 raw
archive migration checksums match; original Git identity and clean status were
verified. No native migration checksum was rewritten. The separate synthetic
CRLF-source/LF-target carryover test remains valid evidence of that different
case, rather than a description of the actual deployment.

All four application images run as the unprivileged service user with read-only
filesystems and purpose-specific private secret-file mounts. Database compatibility,
schema and purpose-role checks passed. The authentic source CLI captured and
verified the actual configurations and 24 native reference tables for each of
API, gateway, worker and scheduler. Temporary reference commands used a separate
administration connection; deployed worker/scheduler privileges were not expanded.

The deployed worker uploaded and read back one synthetic R2 object, denied
anonymous access, removed the object and verified absence. Actual ClamAV accepted
clean content and detected the standard antivirus test sample. Telegram accepted
the private health test alert and its recovery message; human receipt is not
inferred. The final encrypted deployment backup also passed memory-only
authentication and isolated recovery: 171 migrations and one account restored,
temporary database removed, no plaintext archive written or private backup key
uploaded. Neither check establishes photo-object restoration or point-in-time
recovery qualification.

A fresh canary dossier had no native blockers. The independent native close,
same-command replay and physical authenticated transport hold were checked before
opening the reviewed private trial. Telegram delivery is connected without
discarding pending updates. Admission covers the existing administrator and a
secret invitation for at most nine additional users, with independent automatic
closure at `2026-11-12T13:47:24.394Z`. The invitation remains outside Git.
Free-credit authority is bound to that exact policy and expiry: 100 noncash
credits per refill, at most ten refills per minute, without a lifetime refill cap.
Activation replay was verified without modifying the owner's balance.

The four application services then completed a graceful restart rehearsal in
15.531 seconds. Incoming transport was held during restart and restored only
after healthy checks; the native trial policy, registered webhook and empty
queue state were preserved. The independent expiry timer stayed active. This
checks application restart, not an actual host reboot or production failover.

This is a bounded **staging test release**, not unrestricted production admission.
Real Stars payments, Return/fresh entry, retained-record erasure, support-body
release and orphan photo sweeping remain disabled. Existing test media stays
protected in R2 alongside the preserved source backup. The owner selected only
`@NakhSupport` for the public contact, confirmed receiving private messages there
and requested deferring further independent contact verification. That handle is
configured on the gateway. No personal name or country is published, and an
independent end-to-end contact check is not claimed.

The current private VPS operators and free-credit controls deliberately accept
staging only. Public production on this VPS requires its own reviewed deployment
and operator procedure; do not relabel this trial, remove staging guards, invent
completed real-user journeys or treat a clean dossier as public-launch approval.
The observations above supersede earlier statements that the clean trial cutover
had not yet run. They do not supersede outstanding public-launch acceptance.

## Current owner direction - non-payment test release

The owner chose a clean public user database while preserving the protected test
backup. Existing test profiles and balances must not be carried into that database.
Real payment implementation and the payment box are deferred. Instead, every
admitted user of the test version should be able to add internal test credits
repeatedly for free. The bounded staging activation is recorded above; it is not
a claim that payment qualification has passed. Keep Stars purchases disabled;
do not create fake provider receipts or represent test credits as real money.
The previous one-time 100-credit question is superseded by repeatable free top-ups.
The owner subsequently confirmed on 11 November that `@NakhSupport` can receive
messages and requested configuring that handle alone, with further independent
contact checks deferred until the final review.

The source audit found unfinished customer surfaces beyond the backend milestone
tests: profile/settings menus, contextual credit access and Liked By presentation.
Those flows and the dedicated original-session Nakhes customer flow are now
implemented in the accepted deployed source. Their automated evidence does not
invent completed real-user journeys or public-launch acceptance.

## Clean database and administrator continuity

The private Root maintenance entry point `vps-workforce-carryover` copies only
selected workforce identities, Telegram bindings, active role assignments and
encrypted active TOTP credentials with their original activation audits. Necessary
inactive role-assigner identities are included for foreign-key continuity. It
creates fresh Guest accounts, settings and zero credit accounts. It does not copy
profiles, photos, balances, old sign-in sessions, MFA proofs or pending enrollments.
No real authenticator seed is decrypted and no administrator session is fabricated.

Source and target must be different databases with the exact supplied native
migration ledgers and compatible workforce table catalogs. Source checksums are
not rewritten: a historical CRLF ledger can coexist with a fresh canonical LF
target. Both connections require database superuser authority. Native row locks
hold the encrypted credential/replay floor until target commit; a failed audit
rolls the entire target import back. Native JSON/text preserves ciphertext,
microsecond timestamps and bigint Telegram bindings/counters without JavaScript
number rounding. The target receives the exact source replay floor through the
existing insertion and monotonic-update guards. Same-command retries return a
bound historical receipt and cannot overwrite an advanced target counter.

This is one stopped-fleet maintenance step, not an online database migration.
Before using it, preserve the encrypted backup, verify isolated restoration, hold
new ingress, drain accepted work and stop all four source application services.
Create a separate empty cluster/volume with fresh purpose credentials. Supply the
private command, accepted exact-head CI evidence and exclusive private receipt
paths to the Root CLI. After import, recheck the stopped source fleet and unchanged
source credential floor before target traffic. Keep the source cluster/volume
preserved offline. Once the target accepts activity, switching back requires
explicit data and replay-floor reconciliation. Do not enable orphan photo
cleanup against the empty product database while backed-up objects remain in R2.
A successful synthetic carryover does not establish that this live cutover ran.

Linux services can use `NAKH_DATABASE_URL_FILE`, `NAKH_REDIS_URL_FILE`,
`NAKH_TELEGRAM_WEBHOOK_SECRET_FILE` and `<SECRET_REFERENCE>_FILE` for private mounted runtime values. Direct environment
values remain supported, but supplying both forms fails closed. Mounted values
must be canonical absolute regular files owned by Root or the service UID, with
one hard link, no group/world permissions and at most 64 KiB. Final symlinks,
malformed UTF-8, empty/NUL-containing values and detected concurrent changes are
rejected without printing the value or path. One terminal line ending is removed;
structured multiline keyrings are preserved. Connection values are resolved only
in process memory. Deployment must omit the corresponding direct Docker environment
values, mount only each service's required files and separately qualify TLS and
host custody. This facility alone does not certify a deployed secret store.

## Exact-unlock Liked By profile foundation

Migration 169 extends ordinary media receipts with the original FeatureUnlock
identifier. Interactive blurred previews retain their original user session;
full profile thumbnails additionally require the exact active owned unlock,
original Like, both current account lives and the original native session.
The database insertion guard rechecks these facts after canonical lock waits.
Revocation, deletion, inbox visibility withdrawal, rejection or pair closure
invalidates existing receipts. A sender hiding their profile or changing their
preferences does not retract their already-sent Like.

The private profile projection is shared with delivered candidate details and
remains transient. Reads collect every current visible photo, issue separate
short-lived receipts, then recheck the exact sources and complete photo set
before loading prose. Subsequent sends must recheck that source and text version.
No profile body is added to a transport queue, idempotency receipt or cache.
Historical retained manifests keep their immutable proofs; new manifests require
the current schema inventory. Retained-data erasure stays disabled.

This is the native access foundation. Interactive inbox/unlock delivery wiring
is described below. Real release qualification remains separate; neither section
claims the new feature is deployed.

## Original-session Liked By customer delivery

Migration 170 and the primary-entry gateway connect the home menu and `/liked_by`
to the asynchronous inbox. Opaque card and cursor references authenticate the
original user session, account life and exact Like. Legacy references cannot be
upgraded by a newer sign-in. Confirmation displays the current internal-credit
price and balance; native payment-command idempotency prevents repeat charges.
Real payment purchases remain disabled under the owner's test-release decision.

The durable handoff contains selectors, original authority and provider receipts,
never profile prose or signed media URLs. Database guards make its selectors
immutable. Workers recheck their lease and original authority before delivery,
including after private photo retrieval. Full delivery freezes the first profile
version and resumes only recorded provider successes; uncertain sends retain the
existing at-least-once limitation. Protected photos and bounded private text use
separate receipts. Changed profiles or revoked sources fail closed.

Like Back and dismissal require the exact owned unlock and original Like. Native
command receipts support replay after that command closes its own Like. Profile
and individual-photo reporting retain historical safety access to that original
Like without reopening ordinary profile access or selecting a returned user's
new life. Report capture remains encrypted and separate from privileged reveal.

The ordinary deletion inventory includes the four new queue columns. Historical
retained manifests keep their original immutable proofs, and retained erasure
remains disabled. A clean trial database, security custody transfer, deployment
qualification and a current bounded admission review remain separate release
work; existing test profiles and credits must not be silently carried forward.

## Original-session Nakhes customer flow

Migration 171 and the disabled-by-default `NAKH_TELEGRAM_NAKH_ENABLED` switch add
the dedicated Nakhes menu and `/nakhes` entry. Received and sent pages retain
terminal status history; sender-only pending drafts support versioned editing
through an exact private reply and explicit cancellation to Like or Not Interested.
Past pending entries remain read-only. Free credit refills use the existing account
menu; original pending authorizations retain their FIFO settlement rules.

Every callback retains its original native session and account life. Receiver
actions check that session before returning cached command results. A profile view
performs the existing sent-to-seen transition once. Full profile receipts bind the
exact received, viewed, unexpired Nakh, both original lives and the same session;
they cannot borrow a candidate, Like, unlock or another recipient's source. Receipt
insertion rechecks admission after canonical pair locks. Acceptance, rejection,
revocation and native deletion close ordinary profile access. Previously received
Nakhes remain accessible when visibility is off; a receiver's incomplete profile
does not block reading the sender's valid profile.

Private profile and individual-photo reports use a separate original-source safety
scope, including historical closed Nakhes, without reopening ordinary profiles or
including private Nakh text as profile evidence. Text and photo delivery are
protected, check current source authority before each send, and retain provider
ambiguity as at-least-once delivery. Only selectors enter Redis; native commands
are idempotent. This flow does not claim durable per-message provider receipts.

The main menu exposes Matches and the appropriate Fix Profile, Nakhes and Support
entries. Settings links to Edit Profile and hides Language while only one locale is
active. The deletion inventory classifies the new receipt selector, preserving
historical retained-manifest proofs. This source change does not activate traffic
or replace clean-database deployment and actual launch qualification.

## Repeatable free test credits

The account menu now has Settings → Your credits → Add 100 free credits,
with `/settings` and `/credits` entry commands. Each fresh refill action grants
100 noncash credits. Retries of the same opaque, original-session-bound button
reuse the ledger receipt; a newly rendered button allows another refill. Existing
Nakh/chat credit costs and the credit-increased event remain unchanged. Previously
approved pending Nakhes may consume the new balance through their existing FIFO
processing. There are no payment records, provider receipts or cash refunds for
these grants. A burst limit of ten new refills per minute prevents accidental
loops without imposing a lifetime credit allowance.

`NAKH_TELEGRAM_ACCOUNT_MENU_ENABLED` and `NAKH_FREE_TEST_TOPUPS_ENABLED` default
off. Free funding is staging-only and rejects enabled real invoice creation.
Migration 165 preserves the existing financial ledger constraints and adds an
explicit `free_test_topup` kind, English menu text and deferred exact ledger/audit/
outbox proofs. Each new grant requires a current native user session, active
original account life, exact source/bot and current bounded cohort membership.
Mode closure and grants share the cohort lock; user lifecycle and session changes
retain their existing native locks. Valid historical financial proof survives mode
closure, session expiry and ordinary deletion without relaxing the operational
deletion blocker for unknown audit bodies. No new table, column or foreign-key
classification is introduced; the unchanged deletion inventory accepts schema 165.

Only the pinned Root owner operator can enable the native funding mode, with an
exact command digest, current cohort-policy id and expiry within that policy.
The compiled `vps-free-test-credit-operator` supports protected absolute input and
output files and an independent disable command. Application flags alone cannot
mint credits. This source change does not activate free refills, expand admission
or replace the clean-database cutover. Native integration coverage includes real
restricted-logins, retry/concurrency and closure races, an orphan audit borrowing
attempt, populated 164-to-165 migration preservation, and PostgreSQL/Redis Bot API
serialization. Synthetic rehearsals remain separate from live release evidence.

## Owned profile and account controls

With the account menu enabled, the main menu offers Edit profile and Settings.
The editor also accepts `/edit_profile`. Core edits use the current profile
version; location is committed only after selecting its complete country,
province and city hierarchy. Optional edits merge a fresh owned snapshot so
changing one answer preserves biography, height and the other optional fields.
Private text goes directly from the exact bot reply prompt to PostgreSQL; menu
storage contains public selectors and original-session references only. Photo
management remains available through `/photos` from the editor's instructions.

Birth year and gender stay protected. Their editor entries submit correction
requests with a private reason and show the owner's current-life request status;
they do not change protected values or grant reviewer authority. Administrator
review uses the authenticated and audited flow below.

Settings exposes active interface languages, profile visibility and the four
ordinary notification switches. The native settings and notification writes
recheck the original user session and account before returning cached command
results, serialize retries and reject competing stale versions. Critical safety,
account-service and payment categories retain their existing mandatory-delivery
policy. Notification choices affect new activity, not already-queued messages.
Settings screens do not require financial reads; the credit balance is read only
when opening Your credits. Returning to the main menu preserves the same grant.

Migration 166 seeds 49 English messages without introducing retained resources,
tables, columns or foreign keys. The deletion inventory accepts that schema, and
the release-reference inventory includes every new key and its exact value.
Synthetic PostgreSQL/Redis bot journeys cover private prompt ownership, stale
edits, optional-field preservation, revoked/borrowed controls, correction requests
and account switches. These checks do not activate the new menus on the live VPS
or qualify public launch.

## Owned Explore filters

The account-menu composition adds Explore filters and `/filters`, using the
original native product session on every callback. Numeric age pages, current
allowed genders, an atomic country/province/city choice and an optional
relationship goal reuse the M3 filter command. Changes preserve sibling values,
compare the original filter version and retain one result for identical retries.
Navigation stores public selectors, expected versions and grant references only.

The owned read displays the existing age/location defaults without creating a
filter. A profile preference change is disclosed before the available gender
selection is saved by an explicit filter action. Both default age bounds remain
within 18–120. Native writes recheck current account/profile capability before
cached outcomes and validate active city, province and country together.
Migration 168 installs thirteen English presentation messages, with fallback and
exact reference inventory checks; it introduces no retained resource. Native
coverage includes concurrent retries, competing versions, old-grant revocation,
borrowed owners, catalog withdrawal and independent filter/profile locations.
This implementation does not establish deployed activation or live acceptance.

## Administrator profile correction review

Authenticated staff with `review_change_requests` can open `/admin_changes`.
The bounded pending queue shows field names and submission times. Viewing the
current/requested values and private reason requires a separate View request
action; its required audit commits before the protected plain-text delivery.
Link previews and forwarding are disabled. Private content is never saved in
navigation or replay receipts, and an ambiguous delivery cannot replay the body.
The administrator must open a fresh queue/read action to view it again.

Approval and rejection each require a separate confirmation. The native M7
command boundary pins the original authenticator session, current Telegram
binding and current permission before cached results and effects. Role/session/
credential revocation cannot be replaced by a newer sign-in. The protected-field
resolver also checks the exact target profile/account life and its current
protected value; ordinary deletion and Return cannot revive a stale request.
Required audit failure rolls back the entire review, including the profile,
review row, outbox and command receipt. Replayed reads contain no private body.

The real authenticator host refuses unbound M1 review construction. Historical
M1 fixtures with generic synthetic factor providers remain distinct from this
host policy. Reusing an existing database transaction keeps the M7 command audit
and protected-field change atomic. Migration 167 adds 16 English staff messages
and updates sign-in/editing instructions. It reuses the existing M1 review queue
index and adds no table, column or foreign key; the unchanged deletion inventory
accepts schema 167. Synthetic native and bot-serialization evidence does not
establish live operator review or public-launch acceptance.

## Invoice-pause composition repair

Commit `23396fe` passed local checks but failed the native process-composition
case: the new invoice switch overloaded the existing Stars `enabled` field, so
signup interpreted paused invoices as a missing callback service. Do not accept
that failed head as a release. The repair retains `enabled` for callback-service
readiness and adds explicit `invoiceCreationEnabled` for menu/invoice admission.
Both composition requirements remain checked. The native process boots in paused
mode before executing the complete original invoice-enabled journey; unit
regressions retain missing-service and missing-invoice-service rejection. All six
exact-head CI jobs must pass before further feature work.

## Public-launch preparation - 6 November 2026

The owner expanded delivery from a completed private trial to public-launch
preparation, retaining the existing `@NakhTestBot` identity and choosing
`@NakhSupport` as the public payment/account/privacy contact. No second bot,
new service login, purchase, funded payment drill or unrestricted activation is
implied by that preparation request. One bot has one active delivery destination;
prepare an explicit held cutover rather than two competing webhooks. Existing
private trial identities, noncash credits and profile data must be reviewed before
any production migration or exposure.

Telegram requires a `/paysupport` entry for digital-goods merchants. The gateway
now recognizes it through the existing support route, with the same private actor,
original-life, throttling, replay and native support constraints. The actual
PostgreSQL/Redis tombstone-race case runs for both support commands. This first
entry increment does not change refund authority or banned/deleted-account rules.
An independent public contact route, reviewed purchase terms and explicit terms
acceptance are still required before accepting Stars; an ordinary support alias
alone does not qualify payments. See
[Telegram's official Stars requirements](https://core.telegram.org/bots/payments-stars).

The current private VPS operator explicitly accepts staging only. Public production
admission therefore needs a reviewed production deployment/operator procedure;
changing `NAKH_ENV` or removing the staging guard is not an accepted cutover.
The existing production AWS implementation remains available, but the owner chose
the existing low-cost VPS. No AWS provisioning or additional expenditure is
approved. Retained erasure and support-body release remain disabled pending the
previously required policies and approvals.

The independent public contact entry is opt-in through
`NAKH_PUBLIC_SUPPORT_TELEGRAM_USERNAME` (username only, without `@`; empty by default).
Once an approved working contact is configured, `/paysupport` returns only that
public handle/button before native product support or cohort admission. Private
sender/chat binding and independent ten-per-minute throttling still apply. It
does not create an account, grant or support thread, forward the submitted body,
or claim that a dispute has been filed. Ordinary `/support` and appeals retain
their native account-life rules. The owner-provided `@NakhSupport` contact still
needs confirmation of ownership and ability to receive private messages before
live activation. Failed public web access is not evidence that the contact is absent.

`NAKH_TELEGRAM_STARS_INVOICES_ENABLED` is a separate, default-off invoice creation
switch; it requires `NAKH_TELEGRAM_STARS_ENABLED=true`. With payment ingress on
and new invoices off, invoice preparation and delivery are denied before database
work while pre-checkout decisions, successful-payment replay and existing financial
obligations continue through their original native path. The native tests cover
both switch states, including concurrent paid retries after session revocation.
Do not disable the whole payment ingress to pause purchases with outstanding
provider obligations. Both settings and the public contact participate in the
exact release reference; no live payment activation or purchase-policy approval
is implied by this implementation.

## Private deletion and recovery checkpoint — 6 November 2026

After explicit owner approval, the private trial was held without discarding
Telegram updates, native admission was closed and all four application producers
were physically stopped. The six-job-green `2ffb1f6` host observer recorded two
matching actual-host observations. The same accepted application `1341139` then
restarted with ordinary deletion ingress/worker and real zone-scoped cache purge
configured. A fresh source/config review reported no blockers; policy 14 reopened
the two original tester lives plus a new eight-seat invitation at the original
6 November 12:26:36 UTC deadline. The new bound stop timer, actual webhook,
four-service readiness, original-life admission and unlisted-identity denial were
verified. The old invitation was invalidated by closure; use the new private handoff.

The owner supplied the new purge credential through the masked private entry form.
Cloudflare accepted a single unused-URL purge request; this does not claim a cached
photo was removed. A disposable R2 object passed upload/read/delete and separate
HEAD-absence verification. No real tester account was deleted by the operator.
The owner reports their tested product flows worked; the newly enabled deletion
journey remains separately unverified. Payments, Return/fresh entry, retained erasure
and support-body release remain disabled. This is private-trial activation, not M9
completion or public-launch qualification.

The final encrypted snapshot was copied off-host and authenticated, including its
actual drain receipt and reopened configuration. The next recovery implementation
is the [isolated backup restore tool](../../deploy/runbooks/private-vps-backup-restore.md).
It restores only authenticated database members into a disposable network-disabled
RAM-backed database, verifies the exact source migration ledger and withholds success
until cleanup is independently observed. Its synthetic tests are not an actual
snapshot restore, PITR, photo recovery or production DR acceptance. Execute its
reviewed bytes only after all six exact-source jobs pass and preserve the actual
result privately; the tool is independent of the running application release.

The first actual restore attempt withheld success before importing private data:
Docker rejected the kernel-only `noswap` tmpfs option. Cleanup and unchanged live
health were independently observed. The repair keeps equal positive memory/swap
limits and verifies the effective cgroup v2 swap limit is zero before and after
import. A real-container synthetic roundtrip, corrupt-import refusal and cleanup
are now required in the final CI job, with a separate non-authorizing artifact.
This fixture evidence does not substitute for the pending real backup observation.

## Dependency security maintenance - 6 November 2026

The inspected advisories are addressed by exact overrides for `fast-uri` 3.1.9
and 4.2.3, Fastify 5.12.6, glob 14.0.2 and minimatch 11.0.1; Vitest and its
coverage adapter move together to 4.1.12. The glob/minimatch major overrides are
restricted to the previously affected major lines. The archive and cleanup
consumers were exercised with synthetic files, including exclusions and preservation
of an unrelated file. Existing sign-in, API and release tests plus all six exact-source
CI jobs remain required. No advisory allowlist or package safety gate is relaxed.
An updated source lockfile does not establish deployment of the patched application.
The security revision `bec484d` passed all six CI jobs; a fresh full dependency
audit and GitHub alert refresh both reported zero current findings.

Actual reference capture on the existing image failed safely because its build
omitted `dist/cli/release-reference.js`. The package build now includes that
existing operator command. A compiled-command native rehearsal covers capture,
verification, changed-reference rejection, private file permissions, refusal to
overwrite a receipt and wrong-source rejection. This packaging fix does not
certify a successful live snapshot; capture and verify the installed revision
with its actual four service configurations after its six-job acceptance.

Restore repair `46e395a` passed all six jobs, including the real-container synthetic
roundtrip and refusal/cleanup rehearsal. Its ten ordinary CI artifacts and separate
source-bound rehearsal artifact were verified privately. The real encrypted backup
is still not certified restored: transferring its decrypted database members back
to the isolated VPS container requires the owner's separate approval. The fixture
never substitutes for that observation or for photo recovery/PITR qualification.

## Verified private trial checkpoint — 5 November 2026

Application `13411398e2597bab548f23bd9add01d5a365ca5c` passed
[all six CI jobs](https://github.com/aqaPayam/NakhBot/actions/runs/42022043319).
The ten source-bound artifacts were verified and preserved. Its archive SHA-256 is
`2fc87788c78fc14bf1270ce40891510226eacc3539f32189c98a7ff982f58662`: all 163 previously
applied CRLF migrations were preserved, migration 164 was applied, and the five
runtime-purpose permissions were provisioned before schema/role/compatibility and
four-service readiness verification. Both existing profiles and MFA were retained.
Encrypted snapshots before and after rollout were copied off-host and authenticated;
this does not claim a restore of those new snapshots.

The reviewed window admits the two owner-controlled accounts plus one eight-seat
shareable invitation, expires 6 November at 12:26:36 UTC and has its bound automatic
stop. Native invitation creation/replay, wrong-secret denial, existing-account
admission and unlisted-identity denial were observed. No synthetic tester was enrolled
to claim a real user journey. The owner subsequently reported that the flows they
tested worked and asked to continue implementation without routine supervised tests.
This is owner-reported acceptance of their tested flows; it does not identify or
certify separately unperformed funded payment, moderation, deletion/Return or recovery
drills. Payments, deletion/Return, retained erasure and support-body release stay off.

Actual configuration inspection found the deletion worker/ingress lack the account
control and confirmation keys, worker evidence-key references, deletion object-key
references, cache-purge credential and recorded producer-drain hash. The existing
ingestion object credential already passed upload/read/delete probes; no broader
bucket access is implied. The next independent preparation is the
[private VPS deletion cutover observer](../../deploy/runbooks/private-vps-deletion-cutover.md).
It is a separate host tool, not a new application release or deletion activation.
Its synthetic tests do not substitute for the required physical drain. The active
trial must not be relabelled as drained merely to supply a configuration hash.

Creating a zone-scoped Cloudflare cache-purge token and any service login remain
subject to the owner's access approval instructions. The existing
[Cloudflare purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/)
accepts `Cache Purge` permission and distinguishes accepted requests from proof that
content was cached or removed. Keep provider acceptance, object absence, current
media authority and independent native checkpoints distinct.

## Private-trial preparation update

The owner subsequently requested shareable access for new testers and private
ratings/comments, without supervised testing. Migration 164 adds an operator-created
staging invitation bound to the current source, bot, policy and its existing expiry.
The explicit members plus invitation capacity cannot exceed ten. Only a SHA-256
token hash is stored. A narrowly granted, token-checking database function consumes
one seat per user; concurrent joins, retries and policy closure share the existing
launch lock. Closing, expiry, deployment-source mismatch and Root/Return deny old
claims. Original launch-policy/member writes remain owner-only. No public mode or
production qualification is added.

After ordinary signup, the worker grants each invited account life 100 noncash
credits once. Native ledger writes recheck the original life and current invitation
authority under locks. Renewals and duplicate deliveries do not replenish credits.
Payments remain disabled. `/feedback 1` through `/feedback 5`, with optional comments,
uses the existing rate-limited private support workflow and its access, text-length,
idempotency and retention controls. It neither publishes reviews nor releases support
bodies. Trial notices use the existing English fallback.

The audit facts contain no token, profile, photo or comment content. There is no new
user-data table or foreign key: the deletion inventory accepts exactly schema 164
with its existing layouts, while valid original-life claim metadata remains fenced
and retained under the existing operational security policy. Retained erasure stays
disabled. Native fixtures cover the populated 163-to-164 upgrade, constrained-purpose
logins, twenty-way replay/capacity races, credits, real deletion/approved Return and
first-Start registration. Fixture/provider stubs are not real human acceptance evidence.
Deployment still requires the full check, all six exact-source CI jobs, a pre-migration
backup, runtime grant provisioning and a fresh bounded review. An owner's instruction
to proceed without supervised testing does not mark unperformed human journeys passed.

The first invitation candidate `e0675bc` passed quality, including `pnpm check`, but
failed native CI: existing populated-upgrade manifests and current migration/catalog
counts still described schema 163. The repair adds the exact new migration and three
catalog entries to those expectations and advances the unknown-future-schema probe to
165. Historical baselines, preserved-row comparisons and rejection assertions remain.
Review also adds rejection of unprotected pre-164 invitation facts, with native proof
that an attempted upgrade rolls back without deleting those facts or adding a ledger
entry. The failed candidate is not deployed; the repair requires its own six-job CI.

Application `541dfb10f79df98a88da0b588f258e0cc9c536c2` passed
[all six CI jobs](https://github.com/aqaPayam/NakhBot/actions/runs/41993354949)
and was deployed after schema, runtime-role and exact migration-byte checks.
Both owner-controlled accounts have now completed ordinary signup, with two
eligible photos each. The second signup recovered its saved answers after the
one-photo review repair. This is actual signup evidence; it does not establish
completed matching, chat, moderation or production launch drills.

The supervised window was intentionally closed early to prepare independent
private use. Its old timer was disabled after successful native closure and
transport hold, so it cannot accidentally stop a replacement window. This early
closure is not evidence that this particular timer reached its original deadline.
The owner requested independent preparation and subsequent testing with friends,
rather than supervised testing of each screen. Friend identification is deferred
until access is needed; unknown accounts remain outside the private cohort.

Background chat delivery needs the worker's existing notification and chat
switches. The worker may configure chat without configuring public signup;
gateway and other service configurations retain the signup requirement. Actual
worker startup still checks its database, localization, bot identity, navigation
key and Redis composition. This change neither enables delivery by default nor
opens a cohort. Deployment, fresh review, a bounded admission window and a bound
automatic stop remain necessary. Payments, retained erasure and support-body
release stay disabled. A private trial does not complete M9 launch acceptance.

## Historical initial private staging checkpoint

The deployed application is `3d227521a3e41512322c253c7e702e66ee58ecc7`, with
[all six CI jobs successful](https://github.com/aqaPayam/NakhBot/actions/runs/41856418428):
`pnpm check`, 1,529 unit cases in 276 files, and 1,505 native cases in 174 files
with zero skips. Ten source-bound artifacts were downloaded and verified.
Tracked lines at that application source were **296,972**. A later documentation
commit does not change the source labels of the four deployed images.

The owner chose a low-cost private VPS pilot instead of provisioning the original
AWS production plan. The VPS, owned domain/DNS/HTTPS, private R2 bucket, test bot,
five native database-purpose logins, private operator and health-transition
alerts now exist. Actual native authenticator activation and one audited browser
administrator sign-in were verified. Enrollment and sign-in are distinct from
product admission; expired staff sessions require normal reauthentication.

After explicit configuration and opening approvals, a fresh blocker-free review
authorized one original owner life on the exact deployed source. Native policy
version 2, actual Telegram webhook registration, authentication-negative HTTP
checks and admission denial for an unlisted identity were observed. Two old
owner setup updates were preserved privately and discarded with approval.
The original scheduled host timer subsequently completed successfully without
changing its deadline. Read-only post-closure checks observed native policy
version 3 closed with no cohort, authenticated webhook requests held with HTTP
503, unauthenticated requests rejected with HTTP 401, and the matching Telegram
webhook removed while preserving pending updates. The original opening receipt
remained recoverable after closure and review expiry. The owner's original
account life was unchanged and no longer admitted. This proves the scheduled
closure, not a completed product journey or permission to reopen the test.

The actual storage SDK probe uploaded/read/deleted its own test object and
verified absence; its anonymous request returned a non-success response without
the test bytes. An authenticated encrypted off-host backup was decrypted in PC
memory and its database dump streamed to an owner-only disposable database on
the original VPS. Recovery verified all 163 migrations, administrator identity,
active authenticator and activation audit, and archived credential-key references.
The scratch database was removed. The private backup key stayed on the PC; no
plaintext archive was written. This is schema/data recovery on the original
host, not PITR, offsite disaster recovery or runtime-role recovery qualification.
The live worker's configured ClamAV transport also accepted a clean sample and
detected EICAR; neither sample was ingested as user media or uploaded to storage.

There are still **zero completed real product canary journeys**. Authenticated
empty HTTP probes, local replay of approved setup commands, provider setup
responses and a blocker-free dossier do not substitute for a user sending a
fresh message through Telegram and completing the ordinary product flows.
Payments, retained-data erasure and support-body release remain disabled.
The owner will return for supervised testing; private evidence stays outside Git.

### Migration byte provenance

The deployed archive was exported from the reviewed Windows checkout. All 163
native migration hashes match that archive's CRLF files; they differ from an LF
checkout of the same Git commit. A clean source checkout with explicit
`core.autocrlf=true` is required to reproduce those deployed migration bytes.
Record the archive hash and checkout policy alongside the source SHA. A source
SHA alone does not establish identical packaged bytes.

Do not rewrite the applied ledger, normalize an existing release archive, or
disable exact migration checks to obtain a passing review. A later release
must preserve the reviewed bytes or use a separately reviewed migration of
the byte-provenance policy before rollout. Linux CI success does not establish
compatibility with this existing CRLF ledger. Private reference capture and
verification remain observations; neither approves the reference values nor
qualifies production.

The historical audit below preserves the original production requirements.
It must not be read as saying that the already-prepared private pilot resources
are absent or that AWS purchases are required to perform the owner-only VPS test.

The low-cost private staging VPS preparation now has a separate
[read-only readiness boundary](40-private-vps-readiness.md). It observes the
reviewed Linux host and native database without AWS credentials and cannot open
a cohort or qualify production. This does not replace the original launch
requirements or the protected operator's opening approval.
This audit uses the five original M9 requirements in
[the implementation plan](13-implementation-plan.md), preserving the
[M8 handoff scope](32-m8-acceptance-evidence.md). It supersedes historical
remaining-work estimates in the M9 execution guide. It does not close M9 or
authorize deployment, cloud charges or real-user traffic.

## Historical implementation baseline and evidence boundary

The verified implementation baseline is
`ce1cbabbe8d6edb4f6cfbea375f17d8955fc4c3d`, with
[all six CI jobs successful](https://github.com/aqaPayam/NakhBot/actions/runs/39142428165).
It passed `pnpm check`: 1,489 unit tests in 273 files, types, lint, format and
build. Complete native coverage passed 1,479 tests in 172 files, zero skips,
with four disjoint receipts bound to that source, run and attempt.

All 27 original query plans passed at scale 20,000 and maximum 1,500 ms. The
terminal snapshot took 1,332.440 ms, with the required indexes and zero workers,
JIT or spill. Shared support load accepted 10, denied 90 and replayed 100;
backup/restore passed. Actual pinned collector conversions covered 13 M7 metrics
and ten phases plus 13 M8 metrics and eight phases. The actual pinned scanner
transport accepted clean content and rejected EICAR. Four images passed source,
non-root and CLI checks. These are CI/container/local-native observations.

Downloaded archive SHA256s were independently checked:

| Source-bound artifact prefix | ZIP SHA256 |
|---|---|
| `postgres-integration` | `5cbcab1894a07d39005b862f527f8792cb790c03a27069fff865fc56c999a804` |
| `m7-performance` | `8171f4056c2920b94fad868050585f2715149fed3505585506b9f11e6e03c58c` |
| `m7-telemetry` | `251603531004be0f49f27fcfcecc6f3002ad273d7bc91d4ee91df3dd7425d25f` |
| `m8-telemetry` | `8f3dc2fd96fa8bc512d45abe367071a7abdfb0a49a7bec125ac0916e072dc672` |
| `m9-scanner` | `32678ef66be13d955d5ea75d2cd9b8b35279db0ed1320cd5b200d06f1482754e` |
| `m9-infrastructure` | `0c37b4160d0d9cb86af4cbfd79fbf267f24f9e7ff99ae0f24dc94863d71fbc2e` |

Each artifact name appends the full baseline SHA. The release archive reader also
downloaded and inspected the four native/performance/telemetry ZIPs through the
actual GitHub adapter. This does not prove S3 custody, AWS signatures, real IAM
permissions, CloudWatch/SNS delivery, Telegram/R2 behavior or operator acceptance.
The infrastructure proof covers 138 state moves and zero infrastructure changes
under mocked AWS; the 19 production-bootstrap scenarios are also AWS-mocked.

Tracked lines at that baseline were **293,738**, summing every `total` chunk from
`git ls-files -z | xargs -0 wc -l`. A later revision, including this documentation,
requires its own `pnpm check`, push and six exact-head CI jobs before acceptance.
CI artifact retention is fourteen days; preserve actual release evidence privately
through the reviewed archive procedure before it expires.

## Original requirement audit

| Original M9 requirement | Implementation and inspected automated evidence | Actual acceptance still required |
|---|---|---|
| Seed/verify production catalogs, UI text, prompts, prices/config and administrator roles | `release-reference.ts`, its private CLI and five native cases capture every declared reference category and migration checksum in one read-only repeatable snapshot. They detect text/prompt/price/activation/role drift, preserve exact bigint prices and prove concurrent snapshot consistency. The config projection rejects unknown leaves and excludes secret material. | Capture and review actual production reference inputs separately for all four services, seed only approved values and role assignments, and verify the exact reviewed snapshots. A fixture or new capture is not approval. |
| Create production infrastructure, secrets, bot, webhook and R2 | Shared runtime plus separate inactive production/bootstrap roots, guarded production deploy/rollback workflows, source/image attestations, signed archive/custody protocol, drain/migrate/role/compatibility admission, held activation and scaling restoration. Database-purpose isolation is mandatory in production. Native/compiled-host, protocol, image and mocked-IaC cases cover these controls. | The private VPS, domain/DNS/HTTPS, test bot, R2 and native TLS/purpose roles now exist; see the current checkpoint. The original AWS production account/region/IAM/OIDC path remains unqualified. Complete actual production custody, provider journeys, drain, failover/PITR/DR and rollback acceptance for the selected production architecture. |
| Run synthetic canaries and moderation/payment drills | Ordinary gateway/API/worker composition and native host suites cover signup/profile/media, discovery/interactions/Nakh, chat/relay/reporting, Stars/correction/refund, admin MFA/evidence, support/appeal and deletion/Return paths. The source-bound review procedure specifies supervised provider journeys and required private evidence roles. | Designated testers must execute the real deployed bot/provider journeys, moderation/permission/MFA and separately approved funded payment/refund drills. Preserve actual native/provider/audit outcomes, including replay and failure/recovery evidence. Test transports do not satisfy this item. |
| Launch a small cohort, observe support/safety/capacity and expand gradually | Migration 163 and native cohort/gateway suites prove immutable audited manifests, exact source/environment/bot and original-life grants, expiry, concurrent CAS/idempotency, owner/runtime denial, Root/Return fencing, indexed admission and limited safety/financial/privacy availability during holds. The private operator requires exact principal/secret/database admission and approved command digest. Reviewed CLI openings require a fresh dossier, including deadline checks after native locks; closing and read-only receipt recovery remain independent. | Approve real operators, private ACLs, roster/lives, stop plan, source/config and explicit release. Execute the initial synthetic-only canary plan, then accept completed drills before public cohort/expansion. Observe actual support, safety and capacity; demonstrate stop and recovery. A one-owner private canary policy and webhook were opened with explicit review approval; completed real product journeys, public release and expansion remain unaccepted. |
| Hold daily launch review until error budget, payments, safety and deletion are healthy | Native health reuses the existing safety/deletion samplers in a read-only repeatable snapshot, plus four latest reconciliation probes checked at 20,000 rows under 1,500 ms. Review code binds exact intent/audience, native facts, attachment bytes/roles/times and expiry. Unit/native/compiled-CLI cases reject missing/stale/changed references and verify non-authorizing results. Historical findings remain distinct from current drift. | Review actual error-budget denominators/burn, capacity, metric freshness, alert delivery, reconciliation and dispositions, safety/support queues, deletion/provider completion, staffing and security/privacy sign-offs on the deployed source. Hashes, empty blockers and native metadata do not authenticate external records or replace the human decision. |

The source audit found the implementation tools for each original requirement.
The remaining acceptance actions in the right column are not satisfied by the
partial private-pilot observations above. M9 is
therefore not complete. Provider qualification can expose concrete defects; fix
them through the same checked-commit/six-job process rather than pre-certifying
untested behavior or adding unrelated business modules.

## Owner preparation, in order

1. Prepare an AWS account for staging with full account/region/IAM control, then
   a separate production account. For this Terraform deployment, use the account
   configuration supported by AWS's
   [advanced signup guide](https://docs.aws.amazon.com/accounts/latest/reference/getting-started.html);
   see its [signup comparison](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html)
   for available service and region controls. Use the provider's account/MFA and
   administrator setup procedure. Initial information needed here is only the
   twelve-digit account IDs and intended region; no credentials belong in chat.
2. Prepare a Cloudflare account and the intended R2 subscription using the
   [official R2 setup guide](https://developers.cloudflare.com/r2/get-started/).
   Supply the account/zone identifiers and intended separate environment buckets.
   Bucket access, cleanup, private evidence custody and purge credentials will be
   scoped separately in protected provisioning. R2 activation/usage has its own
   provider billing; it is not authorized by a successful source build.
3. Select the owned domain and intended staging/production API, webhook and media
   hostnames. Review DNS/Route53/Cloudflare delegation before changing nameservers
   or creating resources. If the domain is not registered, agree the intended
   name and purchase separately; no registrar or purchase has been selected here.
4. Create separate test and production bots through the official
   [BotFather procedure](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
   Supply bot usernames/identities initially. Deliver bot tokens and webhook secrets
   only through the reviewed private secret/GitHub environment procedure.
5. Agree the initial tester/cohort forecast, region, capacity, monthly budget,
   alert destination and staffing. Review current regional costs and the complete
   concrete Terraform plan before explicit authorization to create billable
   infrastructure. Budget-alert settings are not a price estimate or approval.
6. Approve operator identities, real production deployment policies and exact
   environment OIDC trust. The production bootstrap has no default permission set;
   use observed staging operations and IAM Access Analyzer as described in its
   README, then qualify actual least privilege. Review protected GitHub environments,
   permissions boundaries, state/evidence custody and private operator access.

This was the preparation list for the original AWS production path. The owner
subsequently prepared the VPS, Cloudflare/R2, domain and test bot described in
the current checkpoint. Separate production infrastructure/bot decisions and
their actual qualification remain outstanding. This historical list does not
authorize purchases, production release or expansion beyond the reviewed pilot.

## Release sequence and outstanding evidence

Use [production bootstrap](../../deploy/terraform/production-bootstrap/README.md),
[production infrastructure](../../deploy/terraform/production/README.md),
[purpose isolation](36-m9-database-purpose-isolation.md),
[trusted administrator provisioning](34-m9-trusted-operator.md),
[cohort operations](37-m9-cohort-operator.md) and
[canary/daily review](38-m9-launch-review.md) as the concrete procedures.

After the owner inputs and reviewed plans exist, obtain the specific deployment
authorization, provision staging and qualify real IAM/TLS/provider/custody/drain/
alert/DR behavior. Capture and verify the actual reference/config/role inputs.
Run the scoped synthetic canary and moderation/payment/deletion-Return drills;
resolve failures and preserve reviewed evidence. Only then approve a concrete
production plan, actual production qualification and the exact small-cohort
opening. Each expansion needs a new current roster/version/expiry, dossier,
explicit approval and real observed health. Preserve daily decisions and use
the independent close path for failed or uncertain conditions.

The M8 external privacy/security, recovery and provider obligations remain
applicable. Retained-data erasure and the support-body release remain disabled;
no retention periods are invented, and implementing all 34 retained-resource
erasure adapters is outside the owner-approved implementation scope. Ordinary
product deletion and retained manifests retain their existing separate behavior.
