# M7 Moderation Dashboard

Use environment, release, service, and the fixed `phase`/`outcome` registries only. Never add
user, admin, report, evidence, appeal, pair, reason, locale, token, cursor, text or exception labels.

Chart `nakh.m7.reconciliation.batches`, `.duration`, `.scanned` and `.new_findings` by phase;
batch outcomes distinguish progress, completion and failure. New findings count newly persisted
quarantines, not all currently failing rows. Deduplication means a repeated fault may add zero.
Inspect retained findings through authorized operational access before accepting a release.
Do not interpret historical quarantines as current mismatch measurements or erase them to clear alarms.

Show `nakh.m7.backlog.pending_report_oldest_age` and `.in_review_oldest_age` separately.
Show `nakh.m7.reconciliation.active_age`, `.completed_age` and `.never_completed` together:
zero completed age with never-completed = 1 means missing coverage, not a healthy scan.
These are aggregate database liveness facts; they do not decrypt or cryptographically validate snapshots.

Staging Terraform pages for new findings, scan/measurement failures, a scan over 30 minutes,
completion older than one hour, no completed scan, or queues waiting over 15 minutes.
Missing completion telemetry breaches the freshness alarm. Alarm routing and exporter mapping
still require a real staging drill; configuration validation is not evidence of deployed monitoring.
Use [the M7 operations runbook](../runbooks/m7-operations.md).
