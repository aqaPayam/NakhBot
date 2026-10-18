# Trusted administrator provisioning and recovery

The operator command composes the existing native TOTP approval, credential
revocation, session revocation, security audits and request receipts. It does
not add public provisioning or recovery routes. A pending invitation still
requires the selected user's authenticated first factor, authenticator setup
and separate code confirmation. Provisioning never issues an administrator
session; normal sign-in still requires a fresh authenticator proof.

This command is implementation tooling, not evidence of approved production
operators or live AWS access. Keep it unused until the protected binding,
operator IAM trust/permissions, target database and administrator assignments
have been explicitly reviewed. Do not put invitations, key rings, database
URLs or private operator files in Git, CI artifacts, logs or chat.

## Trusted configuration

Run from a reviewed checkout after `pnpm build`, on an operator-controlled host
with AWS CLI v2 and private network access to the selected database. The host,
executable PATH, AWS profile/trust policy, configuration directory and files are
the trust boundary. Public requests cannot select any of them. Use a dedicated
operator role; application task roles must not inherit this capability.

Store an approved JSON binding outside the checkout in an operator-only
directory. It has exactly these fields:

| Field | Approved value |
|---|---|
| `version` | `1` |
| `environment` | `staging` or `production`; reviewed against the selected secret ARNs/database |
| `accountId`, `region` | Actual account and commercial AWS region |
| `principalArn`, `principalUserId` | Exact STS assumed-role session ARN and unique principal ID, including session name |
| `operatorId` | Stable approved UUID mapped to this trusted operator in security audits |
| `databaseSecretArn` | Full same-account/region Secrets Manager ARN containing only `{"NAKH_DATABASE_URL":"…"}` |
| `totpSecretArn` | Separate full ARN containing the same retained TOTP key-ring JSON used by the API |
| `keyId`, `keyVersion` | Explicit approved enrollment writer; array order cannot select it |

The command verifies all three fields returned by
[STS GetCallerIdentity](https://docs.aws.amazon.com/cli/latest/reference/sts/get-caller-identity.html),
including the unique role ID, before retrieving secrets, after retrieving them
and immediately before the native operation. A new STS session requires a
reviewed binding update; a matching display name cannot replace the principal.
Full secret ARNs, returned version IDs and `AWSCURRENT` labels are checked.
Only the two selected secrets are read. IAM must separately restrict
`secretsmanager:GetSecretValue` and any KMS decrypt grant to those resources.
The tool does not create IAM identities, rotate secrets or grant itself access.

The database must contain migration 161. Before changing MFA state, the host
checks retained historical TOTP key custody with one authenticated ciphertext
sample per version. Missing versions or invalid ciphertext prevent the command.
This is a bounded custody check, not a full corruption scan.

## Invocation and private results

Create a private command JSON file with exactly `operation` and `input`.
For `approve`, `input` contains `actorUserId`, `requestId`, `reasonCode` and
`roles`. Roles are an explicitly approved unique subset of `super_admin`,
`moderator`, `support`; no role is inferred from Telegram or an email address.
For `revoke`, replace `roles` with the exact native `credentialId`.
Reasons are `bootstrap`, `enrollment` or `recovery`.

Use absolute paths for the binding, command and NEW result file:

```text
pnpm admin:operator <binding-path> <command-path> <new-private-result-path>
```

The compiled entry is
`packages/persistence-postgres/dist/cli/admin-totp-operator.js`.
No credential, token or request body belongs in process arguments. The result
file is exclusively reserved before any native effect, written with POSIX mode
0600 and synchronized before reporting success. Windows operators must supply
an operator-only directory ACL; a POSIX mode is not a Windows ACL. Standard
output contains only completion/status; errors are generic.

A pending approval's private result contains the short-lived invitation token
and expiry. Deliver it privately to the already selected user using the
approved operator procedure and existing sign-in enrollment flow. Do not share
the TOTP seed or database/key-ring secrets. The native store owns invitation
expiry and first-factor/role checks.

If output writing fails after a committed operation, keep the SAME request ID
and body and retry with a NEW private result path. Approval replay recovers
the same pending invitation; changed actor, roles, reason, operation or
operator binding conflicts. A failed invocation can leave an empty reserved
file. Never infer absence of a native effect from absence of a private result.

For lost-device recovery, separately revoke the exact credential first. Native
revocation also revokes existing administrator sessions with security audits.
Then approve a replacement using a NEW request ID and `recovery`. The user must
complete enrollment and sign in again; accepted recovery does not bypass MFA.

## Evidence and remaining launch conditions

Unit cases reject altered principals, root/user identities, substituted secrets,
previous secret stages, malformed requests and authority fields in request input.
Native PostgreSQL cases exercise concurrent host approvals, one receipt and
invitation, changed-role conflicts, first-factor enrollment, real TOTP activation,
session issuance and idempotent credential/session revocation. AWS responses in
these cases are synthetic. Existing native approval/audit rollback cases remain.

Actual IAM/provider verification, operator identity/role approval, protected
file ACL review and a supervised enrollment/recovery drill remain required
before launch. Production runtime/IaC composition and the original M9 provider,
privacy/security, cohort and daily-health acceptance also remain open. Retained
data erasure stays disabled pending approved retention policy.
