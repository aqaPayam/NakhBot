# Controlled staging release

This runbook covers the fixed API, Telegram gateway, worker and scheduler fleet.
The workflows remain manual, staging-only and subject to explicit authorization
for resources and charges. The owner has no cloud accounts/bots/domain prepared
yet. Source tests and Terraform validation do not authorize an actual deployment
or certify provider behavior. Keep production launch and retained erasure off.

## Before dispatch

Require the selected source's six successful CI jobs and live digest-bearing
native/performance/telemetry artifacts, verified image attestations, approved
reference/config inputs, a maintenance window and an operator able to stop the
fleet independently. The workflows recheck source CI before activation. Maintain
exclusive control of this staging cluster, scaling, database migrations and runtime
secrets during the window; GitHub deployment/rollback concurrency serializes the
two workflows but cannot fence an independent console administrator or migrator.

For first provisioning, choose `initialize=true` only with empty Terraform state
and no existing named ECS cluster. The controller requires the exact AWS account
and a definitive `MISSING` result for that cluster. An unreadable provider/state
or zero API replicas never qualifies as first provisioning. Existing environments
leave `initialize` false. `PROJECT_NAME`, default `nakh`, must match the existing
staging resources.

## Release order

1. Verify source CI before cloud access. Prepare/verify all four image subjects
   and pin their digests. An existing release remains online during image work.
2. Prepare only protected release custody before draining. The bucket is private,
   encrypted, versioned, protected from destruction, and requires conditional
   creates under `releases/`. Object/version deletion is denied there. This is
   operational custody, not Object Lock compliance or an approved retention term.
3. Read all four services, scaling targets and active task identifiers. Preserve
   their original capacity and suspension flags in the private intent before the
   first fleet mutation. Hold dynamic scale-in, dynamic scale-out and scheduled
   scaling with minimum zero. Updating a scalable target can otherwise restore
   capacity to its minimum even when suspension flags are set.
4. Preserve capacity observed after scaling is held, before setting desired counts
   to zero. Verify all desired/running/pending counts zero and every observed old
   task and container actually stopped in two observations. Scan both desired
   `RUNNING` and `STOPPED`; a task shutting down may already desire `STOPPED`.
   Newly observed active task identifiers are journaled and re-described even if
   later lists omit them. Missing details, unknown active standalone producers,
   failed pages, repeated cursors or verification ceilings deny progress.
5. Only after drain, register the selected API task definition. Forward deploy
   runs its migration and then its read-only compatibility command; rollback runs
   compatibility only. Validate the exact source/digest, database-secret reference,
   private networking and compiled command. Record preparation before `RunTask`,
   bind its idempotency token, preserve its returned task ARN and verify actual
   stopped containers, image digest and zero exit. A checkbox cannot override a
   schema mismatch or qualify a historical image without the command.
6. Recheck CI and physical drain. Require a successful native schema observation
   no more than five minutes old immediately before activation. Persist original
   per-service policy in `TF_VAR_release_capacity`; activate with
   `release_scaling_hold=true`. ECS automatic rollback is disabled because a failed
   release does not qualify an older binary for the forward-only database.
7. Require public HTTPS readiness and all four stable selected-image fleets before
   restoring original capacity and suspension flags. Do not blindly enable scaling
   that an operator previously suspended. Verify the restored policies and selected
   running task digests, then preserve the activated phase observation.

The intent key is
`releases/<selected-source-sha>/<github-run-id>/<attempt>/intent.json`.
Phase bodies contain source/infrastructure/task identifiers, counts and digests;
keep them private. No raw provider responses, resolved secrets, private catalog
or administrator review snapshots belong in public Actions artifacts. Downloads
are size-checked before fetching and tied to an immutable S3 version and checksum.
An unacknowledged upload is not considered observed success.

## Failure and recovery

The failure/cancellation step requests all scaling categories held with minimum
zero and all four managed services desired zero. It does not stop an unknown
standalone task or infer a provider result. It attempts every owned service even
if a scaling read fails. A previously verified local intent may only keep the fleet
off during a custody outage; admission never falls back to cached cloud evidence.
Job cancellation, lost credentials or a process crash can prevent cleanup from
running: the operator must independently verify maintenance. Demonstrate those
cases with actual AWS before accepting deployment automation.

A prepared one-off operation without a durably observed task ARN is uncertain.
Do not invoke it again or manufacture an exit result. Reconcile the actual ECS
task using its source/run/request identity and provider observations. If its ARN
was preserved, the same operation observes that exact task; it does not start a
replacement. SQL migration bookkeeping remains forward-only. A schema failure,
expired admission, unknown task or unavailable proof leaves maintenance in place.

For a separately reviewed continuation, dispatch a new run with `recovery_intent`
set to the exact original protected intent key. The controller preserves the
original pre-zero capacity and operator flags, including the separate held-capacity
observation. It never reconstructs them from current zeroes/all-held flags. It
captures and drains the currently observed fleet and obtains fresh native schema
proof for the selected image. Missing/foreign/corrupt original proof denies recovery.
Without that explicit input, an already-held minimum-zero fleet is not treated as
a fresh deployment. Keep the accepted per-service `release_capacity` for later IaC
applies; do not overwrite it with default replica counts or suspension flags.

Do not reset queues, financial reconciliation, uncertain delivery reservations,
permanent preview counters or deletion work to obtain a clean deployment. These
native obligations retain their original authority. A fleet-drain receipt is not
an M8 Root checkpoint, Redis/queue absence proof, retained-media custody approval
or permission to release retained data. Follow the separate M8 cutover and provider
verification runbooks.

## Required real acceptance

Protocol tests exercise interruption, concurrency, replay, changed task/code/DB
binding, missing/unknown observations, capacity preservation and conditional S3
readback. They simulate AWS. Native schema tests use actual PostgreSQL and reject
an older source against a newer ledger, including an observed migration-lock race.

Before production, demonstrate actual ECS stop/grace behavior, pagination,
scaling holds/restoration, failed-image maintenance, uncertain task recovery,
S3 version/checksum/conditional-write and access-denial behavior, secret/network
binding and the safe forward/rollback journeys. Complete protected production
approval, least-privilege identities, actual signed archive/expired-online-ZIP rollback acceptance,
reference-input approvals and the original M9 provider/canary/cohort/health work.
Phase custody alone does not qualify a release or launch. The signed archive
workflow and its separate acceptance requirements are described below.

AWS contracts: [scaling-target updates](https://docs.aws.amazon.com/autoscaling/application/APIReference/API_RegisterScalableTarget.html),
[task desired-status filtering](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html),
[RunTask idempotency](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html),
and [conditional S3 writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html).

## Signed archive and historical rollback

Forward deployment prepares and verifies the four CI ZIPs and four image bundles,
retains those bytes in the private release bucket, signs the exact manifest with
`actions/attest@v4`, then verifies/seals it before drain. The manifest also preserves
the observed trusted-root document, producing workflow run/attempt, selected source,
controller source, six CI job IDs and scoped image/infrastructure bindings. The
producer must run the selected source. Content is addressed by SHA-256; every write
requires independent checksum/version-bound readback. A prepared or partially sealed
archive is not complete. Replays preserve the same manifest/signature; conflicting
or uncertain evidence cannot become an activation receipt.

For historical rollback, independently obtain the reviewed producing archive key
and provide `archive_ref` as
`archives/<selected-source-sha>/<producing-deploy-run>/<attempt>/manifest.json`.
There is no mutable latest pointer. Keep the source SHA, `ROLLBACK-STAGING` and
separate transport/data review inputs. The current controller can differ from the
selected image source; phase envelope format 2 records both plus archive key/hash.
Older format 1 phase records lack this binding and are rejected. Never manufacture
an upgraded phase receipt or use a different source to retroactively sign old images.

The verifier uses current GitHub CLI trust, the pinned original deploy workflow,
main ref, selected source/signer SHA, GitHub-hosted runners and exact manifest subject.
Saved roots never supply their own trust. It requires the complete protected archive,
matching file digests/sizes, all original native/performance/telemetry checks, original
image bundles and current ECR digests/tags. It still reads newest selected-source CI
and requires the same green run/attempt and six job IDs. A newer red/pending run,
changed attempt, missing signature or unavailable trust denies rollback. Archive
expiry is not a reason to skip live CI status or native current-schema admission.
Without `archive_ref`, rollback retains the original live CI artifact expiry gates.

Rehearse actual manifest/image verification and archive-based rollback after online
ZIP expiry in staging, including missing objects, changed signature, denied reads,
partial writes and a newer CI attempt. Verify S3 conditional-create/delete policies
under both `releases/` and `archives/`. Capture real evidence before claiming provider
acceptance. Local protocol tests use synthetic bundles and simulated S3; the separate
read-only GitHub probe covers actual ZIP download/report inspection only. An archive
is release evidence, not a launch approval, retention policy or M8 Root checkpoint.
