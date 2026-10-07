# M8 Execution Guide — Deletion, Retention and Production Hardening

Start from verified M7 implementation `d9ff0e1e681108984369ce82bbae82370541ed59`.
M7 remains code complete / staging blocked; its provider/operator evidence is not invented here.
M8 owns `ACC-042..044`. M9 activation is outside this work.

## Current increment

The deletion lifecycle defines eight ordered phases: shared closure, evidence capture, ordinary
product data, media objects, ephemeral access, retention manifest, verification and completion.
Checkpoint changes cannot skip, repeat, reverse or restart completion. Fresh return requires a
deleted Account, completed purge, explicit reactivation approval and no retained safety bar.
Completion alone never grants return. GuestPreviewCounter and immutable safety history remain.

Own-account contracts require user authority, an opaque confirmation token and an exact Account
version. Clients cannot select another subject, set retention policy or receive private manifest
content/provider keys. These contracts do not enable a deletion route yet; durable confirmation,
tombstone, worker and ingress composition must be implemented and verified before activation.

Identity reads now preserve deleted-account routing after settings purge, use public default locale
and disabled visibility while deleted, and retain the original preview counter. Start replay reads
current Account state; new starts lock User then Account before touching mutable identity data so
they cannot repopulate a deleted username. Native PostgreSQL probes include twenty concurrent
starts and a start blocked behind a committing tombstone. Live accounts missing required settings
fail closed rather than attempting to register another identity. These are lifecycle prerequisites;
they do not authorize return or enable deletion ingress.

M8 prerequisite commit `27ddf1d` passed quality, all four images and 411 native tests, but its
terminal M7 integrity snapshot took 1618.507 ms against the unchanged 1500 ms budget. No disk spill
or missing parallel worker explained the failure. The repair uses a set join for exact historical
resolution candidates and evaluates the cheap resolution-existence violation first in aggregate
sampling. All owning bindings and paged diagnostic ordering remain; eleven additional single-field
corruption probes compare scanner, current metrics and health findings, then verify repair. The
candidate must pass the complete exact-head CI, including all 27 plans, before more M8 features.

Repair candidate `cc24bd3` passed all 411 native tests and five CI jobs, but the terminal snapshot
took 1772.502 ms and the free set join lost the required resolution-index path. Its replacement
keeps an episode-specific covering-index candidate boundary, validates owner/request/digest fields outside
the narrow physical-key joins, and separates administrator admission, restoration and non-account
actions into exhaustive branches with distinct exact history sets. Resolution facts preserve both
valid and invalid candidates through grouping. Episode audit/notice joins use unique references,
with every original safety predicate evaluated in its flag; this removes a repeated materialized
audit scan observed in the isolated 1,000-episode diagnostic (124 ms terminal snapshot, no
materialized rescan). That smaller probe is not production acceptance. No safety binding, historical
plan, fixture volume, repeated sample, required index or execution budget is removed. Native
account, photo, corruption, metrics and health evidence precedes another complete exact-head CI.

Repair `e8405a7` passed five jobs and every 1,500 ms execution limit (terminal snapshot
1379.550 ms), but PostgreSQL selected a full action scan/sort instead of the required resolution
index. The next candidate restores the parameterized episode lookup while retaining grouped
validation and the audit/notice scan repair. Index requirements remain unchanged.

Repair `504bc59` retained both required indexes and passed 411 native tests, but its terminal
snapshot took 1657.292 ms. The indexed resolution relation performed 20,001 administrator-log
lookups. The next candidate materializes the indexed candidates before joining attempt evidence,
so the dense batch can use its cardinality without losing the episode-specific index boundary.
The isolated 1,000-episode diagnostic retains that index, replaces repeated attempt probes with
one attempt scan and reports no repeated materialized scan; 17 focused native tests pass. The
Windows 20,000-volume diagnostic timed out on a count query without lock/constraint failure;
it is not acceptance evidence. Full Linux CI remains required.

Repair `2b1bf48` kept both required indexes and passed the native integration suite, but the
terminal snapshot took 1584.967 ms. The four action branches repeated large audit/notice/attempt
joins. The next candidate restores the verified two actor branches from green `7a1aab7`, retaining
all exact history classes, while preserving the indexed episode candidate batch and physical
audit/notice reference repair. No performance or correctness gate is weakened.

## Execution sequence

1. Implement durable actor/version-bound confirmation and atomic Account tombstone, history,
   deletion record, audit/outbox and mandatory purge work. Prove twenty-way races, replay, changed
   payload denial and required-audit rollback. Banned-account deletion remains available.
2. Close every shared Like/Match/Chat/Nakh/unlock scope in bounded resumable batches; race normal
   commands and prevent deleted content/access from reaching the other participant.
3. Secure required Report snapshots before ordinary purge; preserve exact private evidence holds.
4. Purge ordinary data by a machine-readable entity registry, including dependent references,
   notifications, support, signup, discovery, interactions and product financial projections.
   Never rewrite financial history or delete the other participant's financial ledger.
5. Revoke media delivery immediately; delete and verify ordinary objects, fence retries and preserve
   only explicitly retained private evidence. Invalidate ephemeral caches/sessions/projections.
6. Produce a content-free retained-data manifest with policy owner/purpose/access/review rules.
   Approved retention periods are an external input. Implement policy-controlled release and
   dependency handling; keep retained-data purge disabled until approval is supplied.
7. Verify the entire deletion registry and allow only approved fresh return: same stable identity,
   unchanged preview counter, zero balance and no restored old product data or safety evasion.
8. Complete localization/static checks, bounded worker scheduling, aggregate telemetry, alarms,
   load/failure/security tests, backup/PITR/restore/DR procedures and acceptance documentation.

Each necessary commit passes `pnpm check`, is pushed to `main`, and must pass all six exact-head
CI jobs before the next feature. Diagnose and repair failures first; preserve privacy-safe native,
migration, concurrency, plan/load and recovery evidence. Count tracked lines with
`git ls-files -z | xargs -0 wc -l`. Historical production queries and limits remain authoritative.

## Acceptance boundary

Automated evidence must cover interruption at every checkpoint, replay/concurrent deletion,
pending evidence, provider absence verification, complete entity classification and delete/return
without restored product content. The full registry follows
[the retention registry](17-data-retention-registry.md) and
[testing strategy](11-testing-strategy.md).

Real staging/DR, approved retention periods, external security review and named operational sign-off
remain separate release requirements. Never label synthetic CI, a local restore or disabled policy
controls as those approvals. Stop when independent M8 implementation is finished and report exact
external blockers; do not begin M9.
