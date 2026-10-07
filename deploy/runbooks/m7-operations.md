# M7 Operations

Pin the immutable release, image and UTC interval before investigating. Export only aggregate
counts, fixed phases/outcomes and release identifiers. Snapshot prose, keys, links, IDs and SQL
parameters must not appear in dashboards, alert annotations or shared drill artifacts.

For reconciliation failure, check database availability/timeouts and resume through the normal
scheduler. A failed transaction does not advance its cursor. A restarted scheduler resumes the
same active run; do not reset the cursor or insert a second run manually.

For new findings, stop the narrowest affected write/reveal path, preserve audits and quarantines,
and investigate with the required operational authorization. Use audited application commands
for supported repairs. Do not edit Reports, snapshots, holds, actions, appeal decisions or logs.
An accepted appeal still requires its separate `unban_user` command and exact current ban checks.
No reconciliation finding authorizes an automatic account, photo, pair or appeal mutation.

For current integrity drift, compare the fixed-phase mismatch gauge with its sample timestamp.
A missing/stale timestamp or measurement failure requires diagnosis before interpreting the count.
Staging declares one `Maximum >= 1` current-mismatch alarm per owned phase (ten total), with only
the fixed `phase` dimension. The timestamp has no dimensions. Its alarm evaluates
`EPOCH(sample)-sample >= 900` seconds and treats missing samples as breaching; missing current
counts alone do not assert integrity drift. Every alarm routes alarm/recovery states to the existing
operations SNS topic. Confirm the subscription and delivery in the real environment before sign-off.
After an authorized repair, resample to verify the current count clears; preserve historical
quarantines and audits. Multiple failed predicates on one entity count once in that phase.
The sampler checks metadata relationships and retained-storage shape, not decrypted contents.

For stale completion, distinguish a long active scan from no scheduler leader/failed sampling.
Keep reads bounded; do not increase batch size beyond 500 to hide backlog. Pending-report and
in-review ages identify different moderation queues; adjust authorized staffing before traffic.

Before production sign-off, prove real alert routing, current admin session/MFA revocation,
required-audit rollback, retained evidence delivery and permission-checked appeal/unban using
the same immutable release. Record named owner sign-offs. CI uses synthetic evidence and is not
proof of real Telegram, object storage, infrastructure or legal-retention readiness.

The shared `deploy/telemetry/m7-collector.json` pins the collector and export policy. M7 accepts
only the `nakh-m7` unversioned scope, thirteen named instruments and each instrument's exact finite
label shape. Unexpected scopes, metrics, labels and data types are dropped; resource attributes are
removed before EMF conversion. Non-M7 metrics retain their existing pipeline and cannot carry an
M7-prefixed instrument around this boundary. M7 emits only declared dimension sets, including
unlabelled totals required by existing alarms; current mismatches remain phase-only. First counter
observations are retained, so an initial failure does not disappear during delta conversion.

Run `pnpm test:m7-collector` with Docker to exercise actual SDK → OTLP HTTP → pinned ADOT →
awsemf conversion. CI runs it inside the existing quality job and retains only fixed metadata and
verification flags in `m7-telemetry-<release>`. It checks private synthetic marker rejection, all
instruments/dimensions, initial failures, drift/clear transitions, stale/fresh timestamps and an
existing milestone metric. The collector exports to stdout for this rehearsal: no AWS credentials
or CloudWatch/SNS delivery are involved. Do not upload raw collector metric payloads or substitute
this conversion evidence for deployment, alert receipt or operator acceptance.
