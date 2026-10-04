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

For stale completion, distinguish a long active scan from no scheduler leader/failed sampling.
Keep reads bounded; do not increase batch size beyond 500 to hide backlog. Pending-report and
in-review ages identify different moderation queues; adjust authorized staffing before traffic.

Before production sign-off, prove real alert routing, current admin session/MFA revocation,
required-audit rollback, retained evidence delivery and permission-checked appeal/unban using
the same immutable release. Record named owner sign-offs. CI uses synthetic evidence and is not
proof of real Telegram, object storage, infrastructure or legal-retention readiness.
