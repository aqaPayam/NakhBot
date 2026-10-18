# Private controlled-cohort operator

This command composes the existing native launch policy authority. It creates no
public endpoint, new tables, cloud resources or product session. Default cohort
admission remains closed. Real AWS identity, network, secret custody, operator
approval, canary/drill completion and launch-health acceptance remain required
before an actual cohort can open. Local tests use synthetic AWS and an explicitly
injected local PostgreSQL connector; they do not qualify real AWS or TLS.

## Reviewed trust binding

Run a reviewed build on a private operator host with AWS CLI v2, a reviewed PATH,
and private database connectivity. Application task roles must not inherit this
capability. Keep files outside Git and logs in an operator-only directory. On
Windows, supply an operator-only directory ACL; POSIX mode 0600 does not set one.

The binding JSON contains exactly:

| Field | Reviewed value |
|---|---|
| `version` | `1` |
| `environment`, `sourceSha`, `telegramBotId` | Exact deployed staging/production audience; full forty-character source SHA |
| `accountId`, `region` | Selected AWS account and commercial region |
| `principalArn`, `principalUserId` | Exact STS assumed-role session ARN and unique principal ID, including session name |
| `operatorId` | Approved stable UUID recorded in the native security audit |
| `databaseSecretArn` | Full same-account/region Secrets Manager ARN, restricted separately by IAM/KMS |
| `databaseHost`, `databaseName`, `databaseUser` | Reviewed endpoint, database and database-owner login |
| `approvedCommandDigest` | Exact canonical opening-command SHA256, or `null` for inspection, lookup and closing |

The selected `AWSCURRENT` secret must have a version ID and contain only
`{"NAKH_DATABASE_URL":"…"}`. Its URL must bind the reviewed host, database and
login, default/5432 port, a nonempty password and `sslmode=verify-full`. The only
optional query parameter is an absolute `sslrootcert` path. Review that private
CA file or the operator host's trusted certificate store. Libpq host/user/options,
alternative SSL modes, duplicate query parameters and URL fragments are rejected.
This is an independent private operator secret, not the multi-field runtime secret.

The host checks all three STS identity fields before secret access, after secret
retrieval and immediately before native execution. It also checks migration 163,
the current database, original session login, current role and audit-table owner.
The native insertion trigger independently requires both owner identities.
Configuration and requests are captured before the first await. Generic failures
keep secret values and native error detail out of CLI output.

## Commands and explicit opening approval

Private command files support these shapes:

- `{"operation":"inspect"}` returns only the latest global policy metadata,
  or `null` when absent. Inspect its audience as well as its version.
- `{"operation":"resolve-member","telegramUserId":"…"}` resolves one exact
  current, non-deleted member to private `userId` and `productEpoch`, or `null`.
  This is no public directory and grants no admission.
- `{"operation":"apply","input":{…}}` contains the existing exact nine-field
  native command: `requestId`, `expectedVersion`, `sourceSha`, `environment`,
  `telegramBotId`, `mode`, `expiresAt`, `reviewDigest`, `members`.

For `cohort`, select one to one hundred distinct current user lives. Use the
native version from inspection and an explicit ISO UTC expiry within the native
twenty-four-hour limit. Resolve members again after an approved Return; an earlier
life never authorizes a later one. A new source requires a new matching audience.

Compute a candidate digest without AWS access or database effects:

```text
pnpm launch:operator --digest <absolute-command-path> <new-absolute-private-digest-path>
```

An authorized reviewer must approve this exact command after reviewing the actual
source-bound canary/drill and health evidence, the private roster, expiry and
version. Place its digest in the protected binding only after that approval.
The canonical digest includes every native field and normalizes UUIDs and roster
order; JSON whitespace cannot change the approved operation. `reviewDigest` is a
private evidence reference. Neither a digest nor a valid binding proves that a
drill happened or that health is acceptable. No live opening is authorized by
the implementation tests or this document.

Invoke an approved operation with absolute file paths:

```text
pnpm launch:operator <binding-path> <command-path> <new-private-receipt-path>
```

The compiled entry is
`packages/persistence-postgres/dist/cli/launch-operator.js`; image verification
requires that file. Input files are bounded and regular. The output is reserved
exclusively before any native effects, written privately and synchronized.
Standard output reports completion only; private member IDs and policy results
stay in the receipt. Commands and credentials never belong in process arguments.

## Closing, replay and gradual expansion

A close command uses `mode:"closed"`, `members:[]`, `expiresAt:null`, a NEW request
UUID, the inspected expected version and a private review reference. An opening
digest is unnecessary for closing; the authenticated operator, exact audience,
native owner authority, CAS and mandatory security audit still apply. If another
operator wins the version race, inspect again and submit a separately reviewed
new command. Expiry independently closes admission.

Concurrent identical requests converge to one immutable policy and roster audit.
Replaying an earlier opening after a close returns its old receipt with
`latest:false`; it cannot reopen the cohort or renew its expiry. Changed content
under the same request ID conflicts, even with a newly approved digest. Each
expansion requires a new reviewed complete roster, expected version, expiry and
request. Never infer current admission from an old successful receipt.

If receipt writing fails after a commit, retain the same request and body and
retry to a NEW private output path. An empty reserved file does not prove that
the native operation was absent. Inspect current policy after uncertain results.

Actual operator IAM/ACL review, verified provider connectivity and TLS, supervised
canary/moderation/payment drills, ongoing health review and explicit real-user
release approval remain external launch conditions. Retained-data erasure stays
disabled pending approved policy.
