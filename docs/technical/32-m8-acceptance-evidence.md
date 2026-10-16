# M8 Acceptance Evidence and Staging Handoff

Status: **implementation complete; final revision CI required / staging blocked**.
M8 implements immediate tombstones, resumable deletion, retained manifests,
separately approved fresh Return, primary-entry activation and operational
hardening. Accept the revision containing this handoff only after all six of its
CI jobs pass with their source-bound artifacts. External release conditions below
remain separate. This handoff supersedes historical remaining-work estimates in
the execution guide. M9 has not started.

## Agreed completion scope

The owner selected the original M8 requirements in
[the implementation plan](13-implementation-plan.md),
with retained-data erasure disabled until policies are approved. Completing all
34 retained-resource erasure adapters is outside this implementation milestone.
Unknown periods have no seeded default. The support-body release implementation
also remains disabled. Ordinary product deletion is implemented independently of
those retention decisions.

## Acceptance coverage

| Requirement | Automated implementation evidence | External acceptance |
|---|---|---|
| `ACC-042` immediate deletion and resumable purge | Native deletion admission, work, shared closure, evidence/checkpoint, product, media, session, ephemeral and final-store suites cover tombstones, lease generations, interruption, retries, rollback and completion. API, Telegram and worker runtime suites exercise composition. | Repeat the journey through the test bot and deployed worker with actual provider failure, retry and restart. |
| Complete deletion registry | Native catalog/registry coverage, product checkpoint selectors and retained-manifest suites enumerate user-linked resources and reject missing coverage or proof. Financial and safety records retain their original authority. | Privacy and module owners approve classification and provider/object inventory for the release. |
| Ordinary product and shared data | Product, pair, Like, referenced Like, Flow, Nakh, unlock, notification, Profile, financial projection and operational suites prove removal/closure without restoring prior interactions. | Verify real object and transport absence using the accepted release. |
| Private retained media and ephemeral access | Media work verifies authenticated private custody before public source deletion. Session and namespace fences, queue draining and completion receipts prevent stale access and producers. | Demonstrate R2 custody/deletion, deployed Redis absence and producer drain; synthetic observations are insufficient. |
| `ACC-043` fresh Return | Return approval, owner Return, activation, protected-profile original-life and ingress suites preserve preview/safety history, require independent administrator approval and owner action, and deny old sessions, commands and bodies. | Verify the actual authenticator, control channel and signed primary-entry journey with approved operators. |
| Review response minimization | Migration 151 replaces copied protected values with four-field transport receipts. Replay reconstructs only current native history and checks the original review command, decision, reviewer and audit. Native tests cover twenty retries, command aliases, completed deletion/Return, forged receipts and populated upgrade audit rollback. | Include transport cache inspection in the private privacy review. Native retained requests, reviews and audits keep their existing classification. |
| `ACC-044` localized output | M8 catalog/seed synchronization, Telegram adapter and host contract tests use localized keys and fixed notices without private interpolation; architecture checks remain part of project quality. | Product/localization owners review rendered test-bot notices in supported locales. |
| Failure, concurrency and security | Existing native permission, stale-life, replay, lease-loss, corruption, mandatory-audit rollback and concurrency cases remain in the complete CI inventory. | Independent security review and resolution of high/critical findings on the tested release. |
| Backup and recovery | CI database backup/restore smoke and populated migrations prove the bounded automated rehearsal. | Actual provider PITR, failover/DR, recovery objectives and operator sign-off. |
| Performance, dashboards and alerts | Full query-plan gates, concurrency load, native 20,000-row deletion health tests, actual SDK/OTLP/pinned collector conversion, Terraform dashboard/alarm configuration and operations runbooks. | Approve launch capacity and demonstrate real CloudWatch/SNS alarm and recovery delivery. |

Native suites are under `packages/persistence-postgres/src` and the corresponding
host directories under `apps`. Run `pnpm check` and the complete CI workflow;
focused test selection does not replace the zero-skip native inventory.
Migration 151 adds one populated upgrade baseline and four native cases: the
required inventory becomes at least **1,286 cases in 154 files**, with four
disjoint source-bound receipts. All six jobs retain their 20-minute caps.

## Verified baseline and final revision evidence

The independently verified baseline is
`4db8ded3f4709fbfd62cbb8a1d903c7faffa746c`, with
[all six CI jobs green](https://github.com/aqaPayam/NakhBot/actions/runs/38852689393).
It passed 1,202 unit tests and 1,281 native cases in 154 files with zero skips.
All 27 production-shaped plans passed at the original 20,000 scale and 1,500 ms
limit. The terminal snapshot took **1,302.888 ms**, used both required indexes,
and had zero workers or spill. Shared support load accepted 10, denied 90 and
replayed 100; backup/restore passed. Actual collector conversions verified 13 M7
metrics across ten phases and 13 M8 metrics across eight phases.

| Baseline artifact | Verified archive SHA256 |
|---|---|
| `postgres-integration-4db8ded3f4709fbfd62cbb8a1d903c7faffa746c` | `91d0aeeb70efe82c6d9fa6ecfd2243922bc37ef5df9e4e5b74c15815abf88cbc` |
| `m7-performance-4db8ded3f4709fbfd62cbb8a1d903c7faffa746c` | `47ff0528ed743732cd5e115f4810fd7922eefe5c762c39d397ae8827f19a4166` |
| `m7-telemetry-4db8ded3f4709fbfd62cbb8a1d903c7faffa746c` | `4ecfdc75a841af3ebb51ac9ddfeed979ff382afabeb6636d8cddbaf087eed69a` |
| `m8-telemetry-4db8ded3f4709fbfd62cbb8a1d903c7faffa746c` | `506c76ebf79ca2e405a4ab803284ecf3f62e041feb3858264eda99c1e9080de4` |

The baseline predates the final review-cache correction. Its green result cannot
approve a later revision. Require the same six successful jobs, four exact-source
native receipts, complete zero-skip inventory, all performance/load/recovery
gates and digest-verified telemetry artifacts for the commit containing this
handoff or any subsequent repair. Artifact names carry that exact source SHA;
keep the run URL, attempt, image references and archive digests together.

CI retains artifacts for fourteen days. Preserve accepted artifacts in the
restricted release evidence store before expiry. Shared acceptance records may
contain revision/digest references, UTC intervals, aggregate outcomes and named
sign-offs; keep private bodies, subject identifiers, provider keys, raw payloads
and credentials out of them.

## External release blockers

| Owner | Required action |
|---|---|
| Privacy / legal / safety | Approve actual resource-specific periods, legal/safety holds and release procedures. Retained erasure stays disabled until separate authorization and complete adapter coverage. |
| Platform / operations | Supply provider accounts, regions, secrets/KMS and storage/transport configuration; rehearse actual provider cleanup, producer drain, PITR, failover/DR and rollback. |
| Operations / on-call | Deploy the accepted producer/collector configuration; prove CloudWatch/SNS alarm and recovery delivery and approve capacity/recovery objectives. |
| Security / module owners | Review private custody, authenticator and key handling, deletion/Return authorization, immutable evidence and the tested deployment; resolve blocking findings. |
| Product / moderation / localization | Run the real test-bot deletion, approval, Return and primary-entry journeys; verify persistent preview/safety behavior and localized notices. |

Use [M8 operations](../../deploy/runbooks/m8-operations.md),
[media source authority](../../deploy/runbooks/m8-media-source-authority.md) and
[ephemeral cutover](../../deploy/runbooks/m8-ephemeral-cutover.md) for these drills.
Keep production activation and retained-data release flags off until their
specific acceptance conditions are met. M9 controlled launch requires a separate
instruction after this handoff.
