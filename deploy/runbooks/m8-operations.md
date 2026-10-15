# M8 deletion operations

## Authority and observation

Deletion health reports queue metadata. It does not certify the entity registry,
provider absence, retained-data release, completion or Return approval. Native
phase receipts, full verification and separately audited Return approval remain
the authorities. A completed Root can remain healthy after the same stable User
returns into another product epoch; its old Account version is historical proof.

The enabled deletion worker records each bounded poll outcome and samples all
eight native phases every 30 seconds. One MVCC statement uses one native clock;
only six counts/ages per phase and the sample time leave PostgreSQL. Missing Root
or work rows, mismatched phase/checkpoint/current deleted owner, and malformed
completion alignment contribute inconsistencies. This is alignment checking, not
a cryptographic re-verification of retained proof. No owner, Root, command,
provider key, error text or failure-code label is exported.

Health reads never overlap. Shutdown stops the timer and waits for the current
read before closing PostgreSQL and telemetry. A failed read increments the health
failure counter and leaves the old sample timestamp unchanged. Telemetry failure
never changes a committed lifecycle result. Worker diagnostics contain only the
finite `deletion.health_failed` or `deletion.telemetry_failed` operation.

## Deployment and alarm activation

The staging collector has a separate `nakh-m8` pipeline with the existing pinned
ADOT image. Its positive metric/type/phase/outcome allowlist strips all resource
attributes and rejects unexpected scope versions, scope attributes, labels and
metric names. The ordinary exporter excludes every M8 name, preventing a rejected
M8 point from escaping through a legacy route. M7 keeps its independent policy.

Terraform `account_deletion_monitoring_enabled` defaults to false. Enable the
alarms and dashboard only after the configured deletion worker is running and
actual CloudWatch delivery and SNS routing are verified by the operator. This
switch never enables a deletion worker, ingress, Return or retained-data release.
Do not enable it on an intentionally disabled producer merely to suppress a
missing-sample alarm. Keep monitoring disabled until producer acceptance exists.

Default operational thresholds are 900 seconds for overdue unleased work, 3,600
seconds for total pending age and 300 seconds for sample age. The first two are
explicit bounded Terraform inputs. They are operational defaults for review,
not approved retention periods, legal deadlines or permission to release data.
Alignment drift and health/claim failures alert independently; repeated retries
and lease loss use aggregate five-minute counts. Gauges use Maximum, avoiding
double counting samples from multiple workers. Counters use Sum.

## Diagnosis and recovery

1. Check sample freshness first. Missing or stale health means counts are
   unavailable, including an old zero. Confirm worker readiness, database access,
   OTLP endpoint, collector health and export. Restore observation before drawing
   a completion conclusion.
2. For fresh alignment drift, retain tombstones and original evidence. Inspect
   the owning Root/work/account through approved private database access. Do not
   repair by editing Account state/epoch, phase, checkpoint, completion flag,
   manifest, lease generation or Redis marker. Diagnose and deploy a native repair.
3. Distinguish total pending age from overdue unleased work. A live native lease
   is excluded from due age but remains part of total pending age. Expired leases
   become due; native claim/retry ownership decides recovery. A waiting provider
   observation must not be converted into absence to clear an alarm.
4. Retry and lease-loss outcomes can follow a lost response after a native or
   provider effect. The next native claim and permanent idempotency receipts own
   resumption. Do not guess current authority, reset attempts, replay an expired
   lease or roll back a later monotonic namespace fence.
5. After a repair, require a fresh sample and inspect the relevant actual native
   proof/provider checks. Falling gauges alone are not deletion, Return or
   controlled-release acceptance. Retained-data purge remains off until approved
   periods and separate release authorization exist.

Never paste raw identifiers, content, ciphertext, cache bodies, object names,
provider exceptions or receiver payloads into telemetry or public incidents.
Use finite aggregate symptoms in operational status. Provider/MFA/drain evidence
and actual external paging are separate from synthetic fixtures.

## Verification and evidence

Run `pnpm check`, the complete native health suite and `pnpm test:m8-collector`.
The native suite includes lease expiry/retry, explicit corruption rollback, an
actual completed deletion/approved Return, and 20,000 metadata rows spanning all
eight phases with a 1,500 ms query budget and three repeated samples. Synthetic
scale rows do not claim actual cleanup or approval and are rolled back.

The collector rehearsal uses the actual OpenTelemetry SDK, OTLP HTTP and pinned
ADOT-to-EMF conversion. It requires all 13 M8 instruments, eight phase drift and
clear samples, stale/fresh sample times, the first failure counter, rejection of
private synthetic markers and preservation of M1 and M7 metrics. CI retains only
fixed metadata in `m8-telemetry-<sha>`. No raw EMF is printed on failure. This
stdout conversion does not prove CloudWatch delivery, SNS routing, production
capacity, provider acceptance, PITR/DR, external security review or operator sign-off.

Check Terraform formatting and staging validation. Actual deployment, alert
routing, capacity thresholds and restore/DR acceptance require the external
operator environment. Do not report them as passed from local or CI fixtures.
