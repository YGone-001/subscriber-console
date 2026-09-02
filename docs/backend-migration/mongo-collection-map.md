# MongoDB Collection Map

> **Phase 0 Baseline** — Generated from source code scan on 2026-08-31
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb`

## Database Architecture

| Database | Env Variable | Default | Purpose |
|----------|-------------|---------|---------|
| `xcloud` | `MONGODB_DB` / `MONGODB_XCLOUD_DB` | `xcloud` | HSS subscriber provisioning + OCS billing |
| `xcloud_ops` | `MONGODB_APP_DB` | `xcloud_ops` | Console operations data |

**Connection**: Single `MongoClient` with global promise cache (`src/lib/mongo.ts`).
**Pool**: `maxPoolSize: 20`, `minPoolSize: 0`, `serverSelectionTimeoutMS: 5000`.

## Collection Registry

Defined in `src/lib/mongo.ts:86-107`:

```typescript
export const mongoCollections = {
  subscribers: 'subscribers',
  ocsTariffPlans: 'ocs_tariff_plans',
  ocsSubscribers: 'ocs_subscribers',
  ocsBalances: 'ocs_balances',
  ocsSessions: 'ocs_sessions',
  ocsReservations: 'ocs_reservations',
  ocsUsageRecords: 'ocs_usage_records',
  ocsEvents: 'ocs_events',
  ocsConfig: 'ocs_config',
  ocsBalanceAdjustments: 'ocs_balance_adjustments',
  profiles: 'app_profiles',
  profileVersions: 'app_profile_versions',
  ratings: 'app_ratings',
  users: 'app_users',
  approvals: 'app_approvals',
  sequences: 'app_sequences',
  auditLogs: 'app_audit_logs',
  alerts: 'app_alerts',
  rateLimits: 'app_rate_limits',
  metrics: 'app_metrics',
};
```

## xcloud Database Collections

| Collection | Domain | Read | Write | Repository | Key Fields | Notes |
|-----------|--------|------|-------|------------|------------|-------|
| `subscribers` | HSS | subscriberRepository, systemAuditRepository, analyticsRepository | subscriberRepository | `subscriberRepository.ts` | `imsi`, `msisdn[]`, `security`, `ambr`, `slice[]`, `access_restriction_data`, `network_access_mode`, `webui_meta` | xCloud BSON document. Uses `Long` for numeric fields. `replaceOne` with `upsert: true` for updates. |
| `ocs_tariff_plans` | OCS | ocsBillingRepository | ocsBillingRepository | `ocsBillingRepository.ts` | `plan_id`, `name`, `status`, `rules[]`, `quota_per_grant`, `validity_time`, `volume_threshold` | Uses `Long` for numeric fields. |
| `ocs_subscribers` | OCS | ocsBillingRepository, subscriberRepository | ocsBillingRepository | `ocsBillingRepository.ts` | `imsi`, `msisdn`, `status`, `plan_id` | Links subscriber to tariff plan. |
| `ocs_balances` | OCS | ocsBillingRepository, ocsOperationsRepository, ocsBalanceGovernance | ocsBillingRepository, ocsBalanceGovernance | `ocsBillingRepository.ts`, `ocsBalanceGovernance.ts` | `imsi`, `data_total`, `data_used`, `data_reserved`, `data_available`, `voice_*`, `sms_*`, `version` | Uses `Long` for all numeric fields. Version-based CAS for balance adjustments. |
| `ocs_sessions` | OCS | ocsOperationsRepository | — (read-only from console) | `ocsOperationsRepository.ts` | `session_id`, `imsi`, `apn`, `state`, `granted_octets`, `used_octets` | Runtime OCS sessions. |
| `ocs_reservations` | OCS | ocsOperationsRepository | — (read-only from console) | `ocsOperationsRepository.ts` | `reservation_id`, `imsi`, `state` | Runtime reservations. |
| `ocs_usage_records` | OCS | ocsOperationsRepository | — (read-only from console) | `ocsOperationsRepository.ts` | `imsi`, `data_volume`, `timestamp` | Historical usage. |
| `ocs_events` | OCS | — | — | — | — | Referenced in mongo.ts but no direct route usage found. |
| `ocs_config` | OCS | — | — | — | — | Referenced in mongo.ts but no direct route usage found. |

## xcloud_ops Database Collections

| Collection | Domain | Read | Write | Repository | Key Fields | Notes |
|-----------|--------|------|-------|------------|------------|-------|
| `app_profiles` | Profiles | profileRepository | profileRepository | `profileRepository.ts` | `name`, `title`, `auth`, `ambr`, `msisdnList`, `sliceList`, `ocsDefaults` | Profile templates for subscriber provisioning. |
| `app_profile_versions` | Profiles | profileRepository | profileRepository | `profileRepository.ts` | `versionId`, `profileName`, `savedAt`, `savedBy`, `action`, `profile` | Version history. Max 50 versions per profile. |
| `app_ratings` | Ratings | ratingRepository → ocsBillingRepository | ocsBillingRepository | `ratingRepository.ts`, `ocsBillingRepository.ts` | `rating_group_id`, `currency`, `rates`, `charging_type`, `apn` | Rating policies. Stored in `xcloud_ops` but logically part of OCS domain. |
| `app_users` | Auth | userRepository | userRepository | `userRepository.ts` | `username`, `passwordHash`, `role`, `status`, `displayName`, `email`, `security`, `locked` | System user accounts. `passwordHash` excluded from API responses. |
| `app_approvals` | Governance | approvalRepository | approvalRepository | `approvalRepository.ts` | `id` (UUID), `changeId` (CHG-YYYYMMDD-NNNNN), `action`, `status`, `riskLevel`, `requester`, `reviewer`, `payload`, `events[]`, `execution` | Approval workflow documents. CAS transitions via `findOneAndUpdate`. |
| `app_sequences` | Governance | approvalRepository | approvalRepository | `approvalRepository.ts` | `_id`, `value`, `updatedAt` | Auto-increment for change IDs. `findOneAndUpdate` with `$inc` + `upsert`. |
| `app_audit_logs` | Audit | auditRepository | auditRepository, audit.ts | `auditRepository.ts` | `id` (UUID), `eventId`, `action`, `module`, `actor`, `resource`, `result`, `before`, `after`, `metadata` | Audit evidence. `_id` = `id` for idempotent inserts. |
| `app_alerts` | Alerts | alertRepository | alertRepository | `alertRepository.ts` | `id`, `timestamp`, `level`, `imsi`, `reason`, `is_acknowledged`, `workflow_status`, `assigned_to` | System alerts. |
| `app_rate_limits` | Security | rateLimitRepository | rateLimitRepository | `rateLimitRepository.ts` | `key`, `count`, `expiresAt` | Fixed-window rate limiting. TTL index for auto-cleanup. |
| `app_metrics` | Analytics | analyticsRepository | analyticsRepository | `analyticsRepository.ts` | — | Operational metrics. |

## Balance Adjustments Ledger (xcloud_ops)

| Collection | Domain | Read | Write | Repository | Key Fields | Notes |
|-----------|--------|------|-------|------------|------------|-------|
| `ocs_balance_adjustments` | OCS Governance | ocsBalanceGovernance | ocsBalanceGovernance | `ocsBalanceGovernance.ts` | `adjustmentId`, `executionId`, `status` (claimed/completed/failed), `imsi`, `bucket`, `before`, `after` | Idempotency ledger for balance adjustments. `claimedAt`, `completedAt`, `failedAt` timestamps. |

## BSON Data Patterns

### Long Fields (MongoDB BSON Long)

Used extensively in OCS collections:
- `ocs_balances`: `data_total`, `data_used`, `data_reserved`, `data_available`, `voice_*`, `sms_*`, `version`
- `ocs_tariff_plans`: `quota_per_grant`, `volume_threshold`
- `ocs_tariff_plans.rules[]`: `rating_group_id`, `service_identifier`, `quota_per_grant`, `volume_threshold`

**Conversion**: `Long.toNumber()` for reads, `Long.fromNumber()` for writes.

### ObjectId Usage

- `_id` fields are `ObjectId` by default in all collections
- `app_audit_logs`: Uses `id` (UUID string) as `_id` for idempotent inserts
- `app_approvals`: Uses `id` (UUID string), not `_id`
- `app_users`: Uses `username` as logical key, `_id` is ObjectId

### Nested Documents

**xCloud Subscriber** (`subscribers` collection):
```
{
  imsi: string,
  msisdn: string[],
  security: { k, op, opc, amf, sqn, RAND },
  ambr: { downlink: { value, unit }, uplink: { value, unit } },
  slice: [{ sst, sd, session: [{ name, type, qos, ambr }] }],
  access_restriction_data: number,
  network_access_mode: number,
  webui_meta: { profile_name, updated_at, created_at }
}
```

**OCS Tariff Plan** (`ocs_tariff_plans` collection):
```
{
  plan_id: string,
  name: string,
  status: 'active' | 'disabled',
  rules: [{ rule_id, apn, rating_group, charging_type, quota_per_grant, ... }],
  quota_per_grant: Long,
  validity_time: number,
  volume_threshold: Long
}
```

### Transactions

**No MongoDB transactions used.** All mutations use:
- `replaceOne` with `upsert: true` (subscriber updates)
- `findOneAndUpdate` with CAS (approval transitions, sequences)
- `bulkWrite` with `ordered: true/false` (batch operations)
- `updateOne` with version filter (balance adjustments)

### Atomic Operations

- **Approval transitions**: `findOneAndUpdate` with `{id, status: expectedStatus}` filter
- **Balance adjustments**: `updateOne` with `{imsi, version: expectedVersion}` filter
- **Sequence generation**: `findOneAndUpdate` with `$inc` + `upsert`
- **Rate limiting**: `findOneAndUpdate` with `$inc` + TTL

## Critical Risks

1. **No transactions**: Multi-collection writes (e.g., subscriber + OCS provisioning) are not atomic. Partial failures are possible.
2. **Long type handling**: OCS collections use BSON `Long` extensively. Incorrect `Long` ↔ `number` conversion can cause data corruption.
3. **xCloud schema coupling**: The `subscribers` collection schema is dictated by xCloud HSS. Changes to xCloud format would break the console.
4. **Dual-database joins**: Subscriber list queries join `subscribers` (xcloud) with `ocs_subscribers` + `ocs_balances` (xcloud) + `app_profiles` (xcloud_ops). No cross-database transactions.
