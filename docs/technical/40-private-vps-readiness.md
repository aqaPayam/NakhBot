# Private VPS readiness observations

The small private staging pilot uses the owner's existing VPS. Its read-only
readiness command does not impersonate AWS, open a cohort, approve a review,
qualify production, or replace the protected AWS launch operator. Mutable VPS
launch admission still needs an independently reviewed implementation before
the private bot can admit testers.

Run the compiled `packages/persistence-postgres/dist/cli/vps-launch-readiness.js`
as Linux root on the reviewed private operator host, with two absolute paths:
the protected binding JSON and a new private receipt file. The command emits
only a fixed completion message. It reserves the receipt exclusively and writes
its contents privately. Keep inputs and receipts outside Git and public logs.

The binding contains exactly `version: 1`, `environment: "staging"`,
`sourceSha`, `telegramBotId`, `machineId`, `databaseHost`, `databaseName`,
`databaseUser`, and `databaseSecretPath`. Review the actual deployed full source
SHA, bot ID, host `/etc/machine-id`, and owner database identity. The separate
secret JSON contains only `NAKH_DATABASE_URL`. Never put that URL in arguments,
the binding, or source control. Verified database TLS is mandatory, including
the exact hostname, database and original owner login; only an absolute optional
CA path may accompany `sslmode=verify-full`.

The CLI requires root-owned regular private input files, rejects hard links,
symlinks and oversized data, and rejects writable-by-others parent directories.
It rechecks the exact Linux/root/machine identity before secret access, after
secret capture and after the native owner/migration check. The native observer
reuses the existing read-only repeatable launch-health snapshot. Output always
states `launchAuthorized: false` and `productionQualified: false`.

Native tests exercise concurrent observations, unchanged audit/cohort authority,
wrong original database login and host drift. Their injected host/TLS fixtures
do not qualify real host ownership, private-file permissions or deployed TLS.
An isolated private candidate probe also passed eight checks on the actual VPS:
the real host and verified database TLS, non-root denial, production-binding
denial, wrong machine identity, symlink and hard-link denial, non-private secret
denial, and writable-parent denial. The candidate bundle SHA256 is
`4db77bde90cc6bab6e385e2958c50d5cd7aef88befb400bb9e1599e1c263165e`;
its receipt remains private. This used the accepted staging image as an isolated
diagnostic carrier, not a new application release. Local validation passed
`pnpm check` with 1,498 unit tests and three focused native tests. The complete
six-job exact-source CI result remains required before release acceptance.

Use a short-lived private operator container with dropped capabilities, no new
privileges, a read-only root filesystem and only the internal database network.
Mount the reviewed host machine ID, binding, separate database secret and CA
read-only, plus a separate root-private writable receipt directory. Application
containers stay non-root and do not receive these operator credentials. No
Docker socket, SSH key or whole-host filesystem mount is needed.

All original canary, cohort approval, safety, privacy and retention conditions
remain in force; retained erasure and support-body release remain disabled.
