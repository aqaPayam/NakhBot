# M7 Moderation Dashboard

Select environment/release/service through the dashboard's deployment context; M7 EMF dimensions
use only the fixed `phase`/`outcome` registries declared by the shared collector policy. Never add
user, admin, report, evidence, appeal, pair, reason, locale, token, cursor, text or exception labels.

Chart `nakh.m7.reconciliation.batches`, `.duration`, `.scanned` and `.new_findings` by phase;
batch outcomes distinguish progress, completion and failure. New findings count newly persisted
quarantines, not all currently failing rows. Deduplication means a repeated fault may add zero.
Inspect retained findings through authorized operational access before accepting a release.
Do not interpret historical quarantines as current mismatch measurements or erase them to clear alarms.

Chart `nakh.m7.integrity.current_mismatches` for the ten fixed reconciliation phases. This counts
currently violating entities once per phase, using the same metadata predicates as reconciliation.
Show `nakh.m7.integrity.sampled_at` alongside it: a stale or missing sample never proves zero drift.
The scheduler samples every thirty seconds; a failed sample preserves its last values/time and
increments `nakh.m7.operational_health.failures`. CI verifies pinned collector conversion and
production-shaped query plans; actual CloudWatch delivery and staging-volume budgets still require
their own evidence. These metadata checks do not
decrypt or authenticate snapshot contents.

Show `nakh.m7.backlog.pending_report_oldest_age` and `.in_review_oldest_age` separately.
Show `nakh.m7.reconciliation.active_age`, `.completed_age` and `.never_completed` together:
zero completed age with never-completed = 1 means missing coverage, not a healthy scan.
These are aggregate database liveness facts; they do not decrypt or cryptographically validate snapshots.

Staging Terraform pages for new findings, scan/measurement failures, a scan over 30 minutes,
completion older than one hour, no completed scan, or queues waiting over 15 minutes.
Missing completion telemetry breaches its alarm. Ten additional phase-only alarms detect current
drift; the dimensionless sample timestamp alarm evaluates `EPOCH(sample)-sample >= 900` seconds
and treats missing samples as breaching. All nineteen alarms and their recoveries route to the
operations SNS topic. Actual receipt still requires a real staging drill; configuration validation
and stdout conversion are not evidence of deployed monitoring.
Use [the M7 operations runbook](../runbooks/m7-operations.md) and
[staging acceptance runbook](../runbooks/m7-staging-acceptance.md).
