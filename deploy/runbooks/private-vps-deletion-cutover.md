# Private VPS deletion prerequisites

Ordinary account deletion is implemented, but the private trial leaves its ingress
and worker disabled until real cache purge and producer-drain prerequisites exist.
Keep retained erasure and support-body release disabled. Passing tests or an owner's
permission to continue without supervised testing does not replace these observations.

`deploy/vps/deletion_cutover.py` is a read-only host observer, not an activation tool.
Run its reviewed bytes directly on the dedicated Linux VPS as root using `python3 -I -B`.
Application containers remain non-root; do not mount the Docker socket into them.
The command accepts four absolute paths: private readiness binding, the application's
build receipt, its preserved six-job CI receipt, and a new private output receipt.
The live application source can differ from the separately reviewed observer commit;
the output records its actual operator-file hash and the application's exact source.

Before observation, the authorized maintenance procedure must close native product
admission, reload the authenticated webhook transport hold, preserve pending Telegram
updates, and gracefully stop API, Telegram gateway, worker and scheduler. Coordinate
the health observer so its temporary read-only Node containers do not confuse physical
producer inventory. Do not stop databases, destroy queues, delete user data or replace
an uncertain provider outcome with a success.

The observer requires all four expected application containers to exist, be exited
with code zero and PID zero, use the reviewed source labels and build image IDs, and
retain non-root/read-only configuration and one consistent queue prefix. It rejects
extra running Nakh containers or any live Node/Bun/Deno process. It independently
observes native admission closed on that source and checks the real authenticated
webhook returns the held 503 response. Two complete observations must agree. Host
machine identity is checked before and after them. Inputs must be root-owned private,
single-linked regular files; output is exclusively created and synced with mode 0600.
Errors withhold the successful receipt digest and never print environment/secret data.

Preserve the exact receipt, its returned SHA-256, accepted application CI, operator
code bytes, maintenance approval and configuration rollback files privately. Only
after review can the receipt hash become `NAKH_DELETION_CUTOVER_EVIDENCE_HASH`. Restart
the same reviewed current reference-only producers; keep the namespace and evidence
hash stable for all in-flight Roots. This observation does not verify Redis physical
absence, queue cleanup, revoked sessions, storage deletion or cache purge. The existing
bounded executors and independent native deletion checkpoints must do that work.

Separate provider prerequisites remain: a Cloudflare credential limited to Cache
Purge for the owned test zone, actual successful provider verification, configured
account-control/confirmation keys, the existing historical report-evidence key ring,
and authorized bucket object cleanup. Do not claim a purge with a no-op adapter or
enable deletion by inventing a drain hash. Creation of additional provider access
must respect the owner's login/access approval instructions. No purchase is needed
for this code preparation; provider authorization and metered usage remain separate.

After activation, requests still require the real user's ordinary two-step deletion
confirmation. Return and fresh entry retain their independent staff, lifecycle and
admission controls. Do not delete a live tester merely to substitute for their
acceptance testing, and do not automatically carry an old invitation into a new life.

The Python validator tests use explicitly synthetic observations. The Vitest wrapper
runs them in `pnpm check` so source quality CI includes active-producer denial, drift,
source/CI/identity mismatch, secret projection and private-file protections. These
tests neither observe a real host nor authorize activation. Actual capture, provider
permissions and any subsequent source/configuration rollout require separate evidence.
