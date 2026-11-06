# Private VPS backup restore verification

An authenticated encrypted archive is not evidence that its database can be
restored. `deploy/vps/restore_probe.py` performs that separate observation without
replacing the live database or interrupting the trial. Run reviewed, six-job-green
operator bytes on the dedicated Linux VPS as root with `python3 -I -B`.
Install its reviewed `deletion_cutover.py` sibling in the same protected directory;
the restore tool reuses its private input/output path checks.

The backup private key stays on the protected owner PC. First verify the encrypted
archive SHA-256 and authenticate its CMS AES-GCM envelope using the existing
off-host backup procedure. Decrypt in memory; never upload the private key or write
the plaintext archive to disk. Stream an uncompressed tar containing **only**
`database.dump` and `database-roles.sql` over the pinned, owner-authorized SSH
connection to the operator's standard input. Do not stream application secrets,
profile/photo files, bot tokens or host configuration into the restore container.

The CLI takes three absolute paths: a root-private manifest, its preserved accepted
operator CI receipt, and a new private output receipt. The manifest has exactly:

- `version: 1`, `applicationSourceSha`, `operatorSourceSha`;
- `encryptedArchiveSha256` for the previously authenticated encrypted archive;
- `dumpSha256`, `rolesSha256` for those two authenticated plaintext members;
- `postgresImageId`, `postgresUid`, `postgresGid` from the existing trusted
  PostgreSQL image and its non-root postgres user;
- `hostIdentitySha256`, hashing the dedicated host's actual machine identity;
- `migrations`: the exact sorted `{name, sha256}` inventory from the accepted
  application's archive. Preserve the deployed migration bytes, including the
  established CRLF policy; never regenerate or rewrite applied checksums.

No image is pulled: the full local image ID must match the actual compose database
container. Private input-file protections are shared with the physical-drain
observer. The accepted operator receipt must match the operator source and include
all six passed jobs and ten preserved evidence artifacts. Neither supplied metadata
nor the restore tool independently authenticates the encrypted archive; preserve
the separate off-host cryptographic verification receipt alongside it.

The input tar is bounded to 64 MiB, with two regular, uniquely named members of at
most 32 MiB each. Extra members, traversal, links, extensions, duplicate names,
changed member hashes and invalid dump headers are rejected without extraction.
This deliberately small private-trial tool refuses larger backups; review capacity
and the implementation before raising its limits.

The operator creates one uniquely labelled, non-root container with no network,
published ports, bind mounts, extra capabilities or host PID/IPC access. Its root
filesystem is read-only. Database files and sockets use private bounded tmpfs;
CPU, memory and process counts are limited. Swap is disabled by
[equal positive memory/swap limits](https://docs.docker.com/engine/containers/resource_constraints/#--memory-swap-details).
The effective cgroup v2 `memory.swap.max` must independently read zero inside the
private cgroup namespace before import and after verification. Docker's tmpfs
option parser does not accept the kernel's `noswap` mount option; do not pass it
or silently substitute a swappable container. The host must support these controls;
otherwise the tool refuses to restore. At least 2 GiB of host memory must be available before the
bounded 1 GiB restore container starts. The isolated bootstrap role is unique
to that invocation, so the authenticated original role inventory can be restored
before `pg_restore --exit-on-error` imports the complete dump with original
ownership/ACLs. The exact restored migration ledger must match the supplied source
inventory. The receipt includes an aggregate account count, never identities,
profile content, SQL, role passwords or database diagnostics.

Isolation is inspected before startup and after verification. Cleanup removes only
the exact newly created container ID, including any accidental anonymous volumes;
it never targets the live compose database. A successful receipt is written only
after cleanup succeeds and a separate successful Docker inventory shows the
container absent. Restore, inspection or cleanup failure withholds success and
prints a generic error. Investigate an uncertain cleanup privately before retrying.

Preserve the encrypted archive, its authenticated off-host verification, exact
source migration inventory, manifest, operator code hash/CI, actual restore receipt
and receipt hash in protected recovery custody. Never attach raw private backup
members to CI. Unit tests and the Vitest wrapper use synthetic payloads only; they
cannot supply an actual-host restore receipt.

The final CI database job additionally runs `restore_rehearsal.py` against the
pinned PostgreSQL image with only a synthetic one-migration/two-account fixture.
It exercises actual container startup, kernel swap controls, cross-cluster role
ownership/import and successful cleanup, then corrupt-import refusal and cleanup.
Its separately retained `private-vps-restore` report is explicitly synthetic; the
existing ten-artifact acceptance contract is unchanged. Three GiB must be available
for its two simultaneous bounded containers. It cannot issue a private-host receipt
or access a private backup, and does not replace the real snapshot observation.

This verifies a disposable database snapshot restore, not live recovery, photo
object recovery, point-in-time recovery, failover, complete disaster recovery or
production approval. No restored database is exposed to Telegram, R2, workers or
schedulers. A real recovery must separately preserve deletion tombstones and
reconcile subsequent deletions/provider state before any restored system opens.
