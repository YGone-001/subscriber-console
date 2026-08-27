# Audit query and index plan

Phase 3 continues to use `app_audit_logs`. Timestamps remain ISO 8601 strings so
existing sort and range behavior stays compatible. No TTL or retention mutation is
part of this change.

| Query pattern | Expected selectivity | Index | Reason |
| --- | --- | --- | --- |
| Recent events / bounded date range | Medium | `{ timestamp: -1 }` | Default sort and range scan |
| Module + recent time | Medium | `{ module: 1, timestamp: -1 }` | Main console filter |
| Failed or denied + recent time | High for exceptional results | `{ result: 1, timestamp: -1 }` | Investigation metric and filter |
| High or critical risk + recent time | High for exceptional risk | `{ riskLevel: 1, timestamp: -1 }` | Security investigation filter |
| Legacy actor + recent time | High | `{ actor: 1, timestamp: -1 }` | Keeps historical events searchable |
| New actor username + recent time | High | `{ actorContext.username: 1, timestamp: -1 }` | User-to-audit trace |
| Resource type/id + recent time | High | `{ resource.type: 1, resource.id: 1, timestamp: -1 }` | Target investigation |
| Request ID | Very high | `{ request.requestId: 1 }` | Direct request trace lookup |
| Correlation ID | Very high | `{ request.correlationId: 1 }` | Cross-request trace lookup |
| Approval ID + recent time | Very high | `{ approvalId: 1, timestamp: -1 }` | Approval evidence lookup |

`q` is intentionally limited to escaped identifier fields. Ordinary B-tree indexes
do not efficiently support arbitrary multi-field contains searches, so Phase 3 does
not add speculative indexes for `q`. Source IP is masked and often low-selectivity;
it also remains unindexed until production evidence justifies its write cost.
