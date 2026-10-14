# M8 opaque-cache cutover

This is a prerequisite to verified ephemeral cleanup. It is not permission to mark
an account deletion complete, release retained data, enable Return or start M9.

1. Deploy the current scoped user-reference factories and the unowned UI v2
   namespace. Keep deletion ingress disabled until the complete M8 coordinator and
   its verifiers are enabled. Verify the actual service configuration; user product
   references must use the owning User/epoch store.
2. Drain all pre-cutover API, Telegram and worker processes that can still write
   the old namespace. The compatibility writer in current code honors the atomic
   fence; an older binary must not remain a producer. Record actual deployment
   evidence separately from tests. Do not infer process drain from a scan cursor.
3. For each configured Redis prefix, compose `RedisLegacyOpaqueStateRetirement`
   with `PostgresLegacyOpaqueRetirementAudit`. Start removal at cursor zero and
   retain progress until every page has been processed. Use a limit of 1ï¿½100.
   Authorization must persist before the first fence or removal. Do not substitute
   an in-memory/no-op audit in a deployed worker.
4. The permanent retirement fence blocks current v1 reads and writes. Preserve it.
   Drain all old `:action:` public/internal values without opening their bodies.
   Current `:action-v2:` UI and owner/epoch state use separate namespaces. Expired
   old buttons require a fresh menu; never copy a legacy body into current state.
5. After removal, start a NEW read-only verification pass at cursor zero. Retain all
   pages, require zero findings and recheck the permanent fence. A terminal cursor,
   an empty batch or an index/fence alone cannot certify physical absence. Any
   finding restarts cleanup and invalidates that verification pass.
6. If authorization fails, no fence/removal may occur. If removal succeeds but its
   observation is lost, preserve the uncertain native intent. Resume bounded
   removal and obtain independent physical evidence; do not invent a removal
   count or relabel an unobserved attempt as observed. The deletion coordinator
   must reconcile such intent before it can issue its separate Root receipt.
7. Preserve native security facts under the approved audit policy. No approved
   retention periods have been supplied, so retained-data release remains off.
   This procedure does not revoke native user sessions or verify queue transport;
   both require their own bounded executors and independent completion evidence.

Keep the exact-head CI artifacts, actual runtime-drain observations and provider
verification distinct. Tests do not certify a real deployment, Redis outage drill,
CloudWatch/SNS routing, PITR/DR, external security review or operator sign-off.

Migration 136 provides `ExecuteAccountDeletionEphemeral` with native durable page
history and the separate phase-5 checkpoint. Compose it with the actual native
session store, `PostgresAccountDeletionEphemeralStore` and
`RedisAccountDeletionEphemeralProvider`, using the same configured prefix and
native audit adapters. Each bounded invocation must retain/reclaim work through
the owning native lease; provider errors preserve uncertain prepared intent.
The next generation resumes the original cursor and repeats independent physical
verification. A busy operation is not done; release/retry through native work.

The native store constructor requires the SHA-256 reference to actual operator
producer-drain evidence. This must identify the verified old-process drain and
current reference-only producers; it is not a user-supplied HTTP field, a boolean
inferred from an empty scan, or approval to release retained data. Preserve the
same prefix/evidence configuration for an in-flight Root. Missing or changed
configuration blocks progress. Fixture hashes do not certify any deployment.

Queue cleanup includes original job envelopes, ordinary diagnostic fields/logs
and old event history. Active/changed jobs block their complete pass. New current
failures must remain coarse with stack retention disabled. Unknown queue families
or control/history collections above the fixed verification ceiling require
operator diagnosis; do not delete canonical money, invent ownership or relax a
verification bound to obtain a green checkpoint. Keep actual drain observations,
exact-head CI evidence and external provider/DR/security acceptance separate.

Only the independent native checkpoint can advance to retention_manifest/6.
The full saga composition, policy manifests and final completion/Return gates
must still be verified before enabling deletion ingress in a deployment.
