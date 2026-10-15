# M8 deletion metrics

The staging Terraform deletion dashboard and alarms are gated by
`account_deletion_monitoring_enabled=false`. Enable only with an accepted producer
and verified external delivery. All metrics use scope `nakh-m8` and namespace
`Nakh/Platform`. Resource attributes are stripped; User/Root/provider labels are
forbidden. See [the operations runbook](../runbooks/m8-operations.md).

| Instrument                         | Type          | Labels         | Meaning                                                         |
| ---------------------------------- | ------------- | -------------- | --------------------------------------------------------------- |
| `nakh.m8.deletion.batches`         | Counter       | phase, outcome | Every bounded poll, including idle/busy/closed                  |
| `nakh.m8.deletion.duration`        | Histogram, ms | phase, outcome | Observed poll duration                                          |
| `nakh.m8.deletion.retries`         | Counter       | none           | Native retry scheduled                                          |
| `nakh.m8.deletion.lease_lost`      | Counter       | none           | Original lease no longer usable; effect may have committed      |
| `nakh.m8.deletion.failures`        | Counter       | none           | Claim/runtime failure before a usable native result             |
| `nakh.m8.deletion.health.failures` | Counter       | none           | Health unavailable; sample time is not refreshed                |
| `nakh.m8.deletion.records`         | Gauge         | phase          | Durable records/work; completed phase is historical             |
| `nakh.m8.deletion.leased`          | Gauge         | phase          | Pending work with an unexpired lease                            |
| `nakh.m8.deletion.retrying`        | Gauge         | phase          | Pending work with a persisted retry indication                  |
| `nakh.m8.deletion.inconsistent`    | Gauge         | phase          | Queue/account/checkpoint alignment mismatch, not proof validity |
| `nakh.m8.deletion.oldest_age`      | Gauge, s      | phase          | Oldest pending request age; completed phase is zero             |
| `nakh.m8.deletion.due_age`         | Gauge, s      | phase          | Oldest available, unleased/expired pending work age             |
| `nakh.m8.deletion.sampled_at`      | Gauge, Unix s | none           | Native sample time; use before interpreting any gauge           |

Health has exactly `shared_closure`, `evidence_capture`, `product_data`,
`media_objects`, `ephemeral_access`, `retention_manifest`, `verification` and
`completed`. Polls also allow phase `unknown`. Outcomes are `progress`, `waiting`,
`advanced`, `completed`, `idle`, `busy`, `closed`, `retry_scheduled`, `lease_lost`
and `failure`. Unexpected poll labels are mapped to finite failure/unknown labels.
Unexpected health shapes or values are rejected before a fresh timestamp is emitted.

Pending dashboard panels omit historical completed counts. Alignment includes all
eight phases. Never sum replicated global gauge observations from multiple worker
instances; use Maximum and native timestamp freshness. The sample-age alarm treats
missing data as breaching only when monitoring is enabled; other alarms rely on
freshness rather than interpreting missing counts as proof of health.

Thresholds are operational review inputs. These metrics do not approve retention
periods, certify absence or completion, authorize Return, reset Guest allowance or
release retained financial/safety data. Actual CloudWatch/SNS, provider and staging
acceptance remain external evidence requirements.
