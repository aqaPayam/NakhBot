# M7 Reporting and Moderation Staging Runbook

Use an isolated staging environment, synthetic users and a separate Telegram test bot. Pin one
immutable candidate that has passed all six default-branch CI jobs. Follow the
[acceptance ledger](../../docs/technical/30-m7-acceptance-evidence.md) and
[operations runbook](m7-operations.md); green CI does not authorize a production rollout.

## Evidence header and preconditions

Record candidate commit/CI URL, image references, UTC interval, operator, rollback release,
`m7-performance-<candidate>` and `m7-telemetry-<candidate>` archive digests, and named backend,
operations, moderation, product and security reviewers. Repeat CI gates for any changed candidate.
Keep the shared ledger content-free: no user/report/appeal/pair identifiers, snapshots, support
text, provider bodies, tokens, seeds, signed links, raw SQL or raw errors.

Stop unless the candidate passed migrations through 84, historical upgrades, verification/replay,
all integration/race suites, 27 M7 query plans, support concurrency load, collector conversion,
security audit, Terraform validation, four images and restore smoke. Preserve the immutable
three-role/fourteen-permission seed. Prior M6 evidence and retained evidence storage must be ready.

Provision isolated PostgreSQL/Redis, private object storage, telemetry and secret references.
Compose trusted first-factor authentication, native authenticator MFA/key resolution and restricted
operator enrollment/recovery explicitly. The ordinary application startup does not enable these
capabilities by itself; never install a fake authenticator or bypass approval to activate staging.
Keep access restricted to the approved synthetic cohort until every drill passes.

## Required drills

Record pass/fail, UTC interval, aggregate audit cardinality and reviewer for each observation:

1. Enroll an administrator through trusted operator approval and an authenticator app. Verify one-use
   code replay denial, enrollment expiry, concurrent confirmation, rate limits, first-factor denial,
   logout, revocation and recovery. Confirm old grants cannot prepare or execute commands.
2. Exercise all roles and permission combinations. Test success, missing permission, disabled actor,
   stale target/version, changed replay and rejected/failed attempts. Required audit failure must
   roll back the effect and reveal; private values must not enter attempted-command logs.
3. Submit all five report evidence kinds through signed test-bot actions. Replay concurrently and
   reject foreign/tampered/expired handles. Confirm immutable snapshots survive retention cleanup;
   reveal retained synthetic photos through actual private object delivery with bounded access.
4. Prove `ACC-039`: repeated reports from one reporter do not restrict; five distinct unresolved
   reporters inside the rolling window do. Check boundary and already-resolved cases.
5. Prove `ACC-040`: race twenty candidate fifth reports. Observe one threshold episode, one system
   restriction/history/notice/audit and no automatic ban. Replay without duplicate effects.
6. Review and confirm report account/photo actions. Verify target ownership/version checks, stale
   confirmation rejection, terminal states and required audit rollback using synthetic evidence.
7. Create an internal block concurrently with Match creation. Verify silent closure of pair, Chat
   and scoped access. Removal must not reopen an old Match/Chat or expose either identity.
8. Race support opens/replays. Admit only two unanswered messages, reset admission after an audited
   reply, confirm closure and banned-user routing, and deny foreign/stale review prompts.
9. Submit one appeal for the exact current ban through its opaque user-bound reference. Concurrent
   submissions/replays converge to one appeal. Reject forged, foreign and obsolete references.
10. Accept the appeal as a reviewer without unban permission and verify the Account remains banned.
    Execute a separately confirmed `unban_user` command as an authorized administrator. Race/replay
    it once; a later ban must never reuse the earlier acceptance.
11. Restart scheduler/worker during bounded reconciliation. Verify durable cursor resume, finding
    deduplication and read-only behavior. Inject controlled metadata drift, observe its fixed phase,
    repair only through authorized commands, resample to zero and retain historical quarantines.
12. Exercise all nineteen M7 alarms and their recoveries through actual CloudWatch/SNS. Verify ten
    phase-only mismatch alarms, missing/stale timestamp, initial failures, queue ages and scan ages.
    A missing/stale sample never proves zero drift. Attach subscription receipt evidence; stdout
    collector rehearsal cannot substitute for this drill.

## Load, failure, privacy and rollback

Run approved launch and 2× profiles against synthetic accounts. Record aggregate latency, throughput,
saturation, queue recovery and alert transitions; CI's 1,500 ms plan envelope is not a staging SLO.
Inject duplicate commands, stale confirmations, audit-store failure, provider timeout/429/5xx,
worker termination, Redis interruption, scheduler restart and database failover. There must be no
duplicate domain effect, unauthorized reveal, missing audit or identity/content leak.

Inspect actual exported metrics/logs/traces, delivery and retained artifacts for private markers and
prohibited content. A leak or unaccounted effect blocks acceptance. Preserve restricted evidence;
disable the narrow affected write/reveal path and follow the operations runbook.

Restore a backup and rehearse schema-compatible image rollback. Never reverse an applied migration,
delete history/audits/quarantines, reset cursors manually, bypass MFA or reopen a closed pair. An
accepted appeal never authorizes a manual database unban.

## Sign-off

M7 is accepted only when every observation passes on the same candidate, retained artifacts match
it, Critical/High acceptance defects are zero and all five named reviewers sign the ledger. Until
then the status is **code complete / staging blocked**. Record unavailable evidence as blocked,
never passed. Do not advance to M8/M9 as part of this handoff.
