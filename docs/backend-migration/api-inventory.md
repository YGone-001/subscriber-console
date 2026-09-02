# API Inventory

> **Phase 0 Baseline** — Generated from source code scan on 2026-08-31
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb`

## Summary

| Metric | Count |
|--------|-------:|
| Route files | 63 |
| Total operations | 89 |
| GET | 40 |
| POST | 32 |
| PUT | 7 |
| PATCH | 3 |
| DELETE | 7 |

## By Domain

| Domain | Routes | Operations |
|--------|-------:|----------:|
| alerts | 3 | 3 |
| analytics | 3 | 3 |
| approvals | 8 | 10 |
| audit | 3 | 3 |
| auth | 6 | 10 |
| notifications | 1 | 1 |
| ocs | 4 | 4 |
| profiles | 5 | 8 |
| ratings | 2 | 5 |
| search | 1 | 1 |
| subscribers | 9 | 12 |
| system | 6 | 6 |
| tariff-plans | 10 | 17 |
| users | 2 | 6 |

## Complete Route Table

### Alerts

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/alerts` | `src/app/api/alerts/route.ts` | Yes | `requireAuth` | READ | N/A | alertRepository | xcloud_ops | app_alerts | — |
| POST | `/api/alerts/acknowledge` | `src/app/api/alerts/acknowledge/route.ts` | Yes | `requireAuth` | WRITE | UNKNOWN | alertRepository | xcloud_ops | app_alerts | audit |
| POST | `/api/alerts/workflow` | `src/app/api/alerts/workflow/route.ts` | Yes | `requireAuth` | WRITE | UNKNOWN | alertRepository | xcloud_ops | app_alerts | audit |

### Analytics

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| POST | `/api/analytics/init` | `src/app/api/analytics/init/route.ts` | Yes | `requireAuth` | WRITE | UNKNOWN | analyticsRepository | xcloud | subscribers, ocs_balances, ocs_subscribers | — |
| GET | `/api/analytics/metrics` | `src/app/api/analytics/metrics/route.ts` | Yes | `requireAuth` | READ | N/A | analyticsRepository | xcloud_ops | app_metrics | — |
| GET | `/api/analytics/sparkline` | `src/app/api/analytics/sparkline/route.ts` | Yes | `requireAuth` | READ | N/A | analyticsRepository | xcloud_ops | app_metrics | — |

### Approvals

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/approvals` | `src/app/api/approvals/route.ts` | Yes | `requireAuth` | READ | N/A | approvalRepository | xcloud_ops | app_approvals | — |
| POST | `/api/approvals` | `src/app/api/approvals/route.ts` | Yes | `requirePermission(approvals.create)` | WRITE | APPROVAL_GOVERNED | approvalRepository | xcloud_ops | app_approvals, app_sequences | audit |
| GET | `/api/approvals/:id` | `src/app/api/approvals/[id]/route.ts` | Yes | `requireAuth` | READ | N/A | approvalRepository | xcloud_ops | app_approvals | — |
| POST | `/api/approvals/:id/approve` | `src/app/api/approvals/[id]/approve/route.ts` | Yes | `requirePermission(approvals.approve)` | WRITE | APPROVAL_GOVERNED | approvalRepository | xcloud_ops | app_approvals | audit |
| POST | `/api/approvals/:id/reject` | `src/app/api/approvals/[id]/reject/route.ts` | Yes | `requirePermission(approvals.reject)` | WRITE | APPROVAL_GOVERNED | approvalRepository | xcloud_ops | app_approvals | audit |
| POST | `/api/approvals/:id/cancel` | `src/app/api/approvals/[id]/cancel/route.ts` | Yes | `requirePermission(approvals.cancel)` | WRITE | APPROVAL_GOVERNED | approvalRepository | xcloud_ops | app_approvals | audit |
| POST | `/api/approvals/:id/execute` | `src/app/api/approvals/[id]/execute/route.ts` | Yes | `requirePermission(approvals.execute)` | WRITE | APPROVAL_GOVERNED | approvalExecutors | xcloud_ops + xcloud | varies | audit |
| GET | `/api/approvals/:id/audit` | `src/app/api/approvals/[id]/audit/route.ts` | Yes | `requireAuth` | READ | N/A | approvalRepository | xcloud_ops | app_approvals | — |
| GET | `/api/approvals/export` | `src/app/api/approvals/export/route.ts` | Yes | `requireAuth` | READ | N/A | approvalRepository | xcloud_ops | app_approvals | — |

### Audit

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/audit` | `src/app/api/audit/route.ts` | Yes | `requireAuth` | READ | N/A | auditRepository | xcloud_ops | app_audit_logs | — |
| GET | `/api/audit/:id` | `src/app/api/audit/[id]/route.ts` | Yes | `requireAuth` | READ | N/A | auditRepository | xcloud_ops | app_audit_logs | — |
| GET | `/api/audit/export` | `src/app/api/audit/export/route.ts` | Yes | `requireCapability(audit_export)` | READ | N/A | auditRepository | xcloud_ops | app_audit_logs | — |

### Auth

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| POST | `/api/auth/login` | `src/app/api/auth/login/route.ts` | No | — | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit, JWT cookie |
| POST | `/api/auth/logout` | `src/app/api/auth/logout/route.ts` | No | — | WRITE | DIRECT_GOVERNED | — | — | — | clear cookie |
| GET | `/api/auth/me` | `src/app/api/auth/me/route.ts` | Yes | `requireAuth` | READ | N/A | userRepository | xcloud_ops | app_users | — |
| GET | `/api/auth/permissions` | `src/app/api/auth/permissions/route.ts` | Yes | `requireAuth` | READ | N/A | — | — | — | — |
| GET | `/api/auth/users` | `src/app/api/auth/users/route.ts` | Yes | `requireAuth` | READ | N/A | userRepository | xcloud_ops | app_users | — |
| POST | `/api/auth/users` | `src/app/api/auth/users/route.ts` | Yes | `requirePermission(users.create)` | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit |
| GET | `/api/auth/users/:username` | `src/app/api/auth/users/[username]/route.ts` | Yes | `requireAuth` | READ | N/A | userRepository | xcloud_ops | app_users | — |
| PUT | `/api/auth/users/:username` | `src/app/api/auth/users/[username]/route.ts` | Yes | `requirePermission(users.update)` | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit |
| DELETE | `/api/auth/users/:username` | `src/app/api/auth/users/[username]/route.ts` | Yes | `requirePermission(users.delete)` | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit |
| PATCH | `/api/auth/users/:username` | `src/app/api/auth/users/[username]/route.ts` | Yes | `requirePermission(users.disable)` | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit |

### Notifications

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/notifications/stream` | `src/app/api/notifications/stream/route.ts` | Yes | `requireAuth` | READ | N/A | — | — | — | SSE stream |

### OCS

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/ocs/balances` | `src/app/api/ocs/balances/route.ts` | Yes | `requireAuth` | READ | N/A | ocsOperationsRepository | xcloud | ocs_balances | — |
| GET | `/api/ocs/sessions` | `src/app/api/ocs/sessions/route.ts` | Yes | `requireAuth` | READ | N/A | ocsOperationsRepository | xcloud | ocs_sessions | — |
| GET | `/api/ocs/reservations` | `src/app/api/ocs/reservations/route.ts` | Yes | `requireAuth` | READ | N/A | ocsOperationsRepository | xcloud | ocs_reservations | — |
| GET | `/api/ocs/usage` | `src/app/api/ocs/usage/route.ts` | Yes | `requireAuth` | READ | N/A | ocsOperationsRepository | xcloud | ocs_usage_records | — |

### Profiles

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/profiles` | `src/app/api/profiles/route.ts` | Yes | `requireAuth` | READ | N/A | profileRepository | xcloud_ops | app_profiles | — |
| POST | `/api/profiles` | `src/app/api/profiles/route.ts` | Yes | `requireCapability(profile_write)` | WRITE | DIRECT_GOVERNED | profileRepository | xcloud_ops | app_profiles, app_profile_versions | audit |
| GET | `/api/profiles/:name` | `src/app/api/profiles/[name]/route.ts` | Yes | `requireAuth` | READ | N/A | profileRepository | xcloud_ops | app_profiles | — |
| PUT | `/api/profiles/:name` | `src/app/api/profiles/[name]/route.ts` | Yes | `requireCapability(profile_write)` | WRITE | DIRECT_GOVERNED | profileRepository | xcloud_ops | app_profiles, app_profile_versions | audit |
| DELETE | `/api/profiles/:name` | `src/app/api/profiles/[name]/route.ts` | Yes | `requireCapability(profile_write)` | WRITE | DIRECT_GOVERNED | profileRepository | xcloud_ops | app_profiles, app_profile_versions | audit |
| GET | `/api/profiles/:name/stats` | `src/app/api/profiles/[name]/stats/route.ts` | Yes | `requireAuth` | READ | N/A | profileRepository | xcloud + xcloud_ops | subscribers, app_profiles | — |
| GET | `/api/profiles/:name/versions` | `src/app/api/profiles/[name]/versions/route.ts` | Yes | `requireAuth` | READ | N/A | profileRepository | xcloud_ops | app_profile_versions | — |
| POST | `/api/profiles/:name/versions/:versionId/restore` | `src/app/api/profiles/[name]/versions/[versionId]/restore/route.ts` | Yes | `requireCapability(profile_rollback)` | WRITE | APPROVAL_GOVERNED | profileRepository | xcloud_ops | app_profiles | approval, audit |

### Ratings

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/ratings` | `src/app/api/ratings/route.ts` | Yes | `requireAuth` | READ | N/A | ratingRepository → ocsBillingRepository | xcloud_ops | app_ratings | — |
| POST | `/api/ratings` | `src/app/api/ratings/route.ts` | Yes | `requireCapability(rating_publish)` | WRITE | APPROVAL_GOVERNED | ratingRepository | xcloud_ops | app_ratings | approval, audit |
| GET | `/api/ratings/:id` | `src/app/api/ratings/[id]/route.ts` | Yes | `requireAuth` | READ | N/A | ratingRepository → ocsBillingRepository | xcloud_ops | app_ratings | — |
| PUT | `/api/ratings/:id` | `src/app/api/ratings/[id]/route.ts` | Yes | `requireCapability(rating_publish)` | WRITE | APPROVAL_GOVERNED | ratingRepository | xcloud_ops | app_ratings | approval, audit |
| DELETE | `/api/ratings/:id` | `src/app/api/ratings/[id]/route.ts` | Yes | `requireCapability(rating_publish)` | WRITE | APPROVAL_GOVERNED | ratingRepository | xcloud_ops | app_ratings | approval, audit |

### Search

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/search` | `src/app/api/search/route.ts` | Yes | `requireAuth` | READ | N/A | — | xcloud + xcloud_ops | multiple | — |

### Subscribers

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/subscribers` | `src/app/api/subscribers/route.ts` | Yes | `requireAuth` | READ | N/A | subscriberRepository | xcloud | subscribers, ocs_subscribers, ocs_balances | — |
| POST | `/api/subscribers` | `src/app/api/subscribers/route.ts` | Yes | `requireCapability(subscriber_write)` | WRITE | DIRECT_GOVERNED | subscriberRepository | xcloud | subscribers | audit |
| GET | `/api/subscribers/:imsi` | `src/app/api/subscribers/[imsi]/route.ts` | Yes | `requireAuth` | READ | N/A | subscriberRepository | xcloud | subscribers, ocs_subscribers, ocs_balances | — |
| PUT | `/api/subscribers/:imsi` | `src/app/api/subscribers/[imsi]/route.ts` | Yes | `requireCapability(subscriber_write)` | WRITE | APPROVAL_GOVERNED | subscriberRepository | xcloud | subscribers | approval, audit |
| DELETE | `/api/subscribers/:imsi` | `src/app/api/subscribers/[imsi]/route.ts` | Yes | `requireCapability(subscriber_write)` | WRITE | APPROVAL_GOVERNED | subscriberRepository | xcloud | subscribers | approval, audit |
| POST | `/api/subscribers/batch` | `src/app/api/subscribers/batch/route.ts` | Yes | `requireCapability(subscriber_write)` | WRITE | APPROVAL_GOVERNED | subscriberRepository | xcloud | subscribers | approval, audit |
| POST | `/api/subscribers/batch/precheck` | `src/app/api/subscribers/batch/precheck/route.ts` | Yes | `requireAuth` | READ | N/A | subscriberRepository | xcloud | subscribers | — |
| POST | `/api/subscribers/batch-update` | `src/app/api/subscribers/batch-update/route.ts` | Yes | `requireCapability(subscriber_write)` | WRITE | APPROVAL_GOVERNED | subscriberRepository | xcloud | subscribers | approval, audit |
| POST | `/api/subscribers/bulk-delete` | `src/app/api/subscribers/bulk-delete/route.ts` | Yes | `requireCapability(subscriber_write)` | WRITE | APPROVAL_GOVERNED | subscriberRepository | xcloud | subscribers | approval, audit |
| POST | `/api/subscribers/import` | `src/app/api/subscribers/import/route.ts` | Yes | `requireCapability(subscriber_write)` | WRITE | APPROVAL_GOVERNED | subscriberRepository | xcloud | subscribers | approval, audit |
| POST | `/api/subscribers/policy` | `src/app/api/subscribers/policy/route.ts` | Yes | `requireCapability(policy_approve)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_subscribers, ocs_balances | approval, audit |
| POST | `/api/subscribers/:imsi/traffic-adjustments` | `src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts` | Yes | `requireCapability(balance_adjust)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_balances | approval, audit |

### System

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/system/health` | `src/app/api/system/health/route.ts` | Yes | `requireAuth` | READ | N/A | systemHealthRepository | xcloud + xcloud_ops | multiple | — |
| GET | `/api/system/mongo/health` | `src/app/api/system/mongo/health/route.ts` | Yes | `requireAuth` | READ | N/A | mongoHealthRepository | xcloud + xcloud_ops | multiple | — |
| GET | `/api/system/audit/status` | `src/app/api/system/audit/status/route.ts` | Yes | `requireAuth` | READ | N/A | systemAuditRepository | xcloud | subscribers, ocs_subscribers, ocs_balances | — |
| POST | `/api/system/audit/scan` | `src/app/api/system/audit/scan/route.ts` | Yes | `requireAuth` | READ | N/A | systemAuditRepository | xcloud | subscribers, ocs_subscribers, ocs_balances | — |
| POST | `/api/system/audit/heal` | `src/app/api/system/audit/heal/route.ts` | Yes | `requireCapability(system_heal)` | WRITE | APPROVAL_GOVERNED | systemAuditRepository | xcloud | subscribers | approval, audit |
| POST | `/api/system/audit/batch-heal` | `src/app/api/system/audit/batch-heal/route.ts` | Yes | `requireCapability(system_heal)` | WRITE | APPROVAL_GOVERNED | systemAuditRepository | xcloud | subscribers | approval, audit |

### Tariff Plans

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/tariff-plans` | `src/app/api/tariff-plans/route.ts` | Yes | `requireAuth` | READ | N/A | ocsBillingRepository | xcloud | ocs_tariff_plans | — |
| POST | `/api/tariff-plans` | `src/app/api/tariff-plans/route.ts` | Yes | `requireCapability(tariff_write)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_tariff_plans | approval, audit |
| GET | `/api/tariff-plans/:planId` | `src/app/api/tariff-plans/[planId]/route.ts` | Yes | `requireAuth` | READ | N/A | ocsBillingRepository | xcloud | ocs_tariff_plans | — |
| PUT | `/api/tariff-plans/:planId` | `src/app/api/tariff-plans/[planId]/route.ts` | Yes | `requireCapability(tariff_write)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_tariff_plans | approval, audit |
| DELETE | `/api/tariff-plans/:planId` | `src/app/api/tariff-plans/[planId]/route.ts` | Yes | `requireCapability(tariff_write)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_tariff_plans | approval, audit |
| POST | `/api/tariff-plans/:planId/clone` | `src/app/api/tariff-plans/[planId]/clone/route.ts` | Yes | `requireCapability(tariff_write)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_tariff_plans | approval, audit |
| GET | `/api/tariff-plans/:planId/export` | `src/app/api/tariff-plans/[planId]/export/route.ts` | Yes | `requireAuth` | READ | N/A | ocsBillingRepository | xcloud | ocs_tariff_plans | — |
| POST | `/api/tariff-plans/:planId/migrate` | `src/app/api/tariff-plans/[planId]/migrate/route.ts` | Yes | `requireCapability(plan_assign)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_subscribers, ocs_balances | approval, audit |
| GET | `/api/tariff-plans/:planId/operations` | `src/app/api/tariff-plans/[planId]/operations/route.ts` | Yes | `requireAuth` | READ | N/A | ocsBillingRepository | xcloud | ocs_tariff_plans | — |
| GET | `/api/tariff-plans/:planId/rules` | `src/app/api/tariff-plans/[planId]/rules/route.ts` | Yes | `requireAuth` | READ | N/A | ocsBillingRepository | xcloud | ocs_tariff_plans | — |
| POST | `/api/tariff-plans/:planId/rules` | `src/app/api/tariff-plans/[planId]/rules/route.ts` | Yes | `requireCapability(tariff_write)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_tariff_plans | approval, audit |
| GET | `/api/tariff-plans/:planId/rules/:ruleId` | `src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts` | Yes | `requireAuth` | READ | N/A | ocsBillingRepository | xcloud | ocs_tariff_plans | — |
| PUT | `/api/tariff-plans/:planId/rules/:ruleId` | `src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts` | Yes | `requireCapability(tariff_write)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_tariff_plans | approval, audit |
| DELETE | `/api/tariff-plans/:planId/rules/:ruleId` | `src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts` | Yes | `requireCapability(tariff_write)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_tariff_plans | approval, audit |
| GET | `/api/tariff-plans/:planId/subscribers` | `src/app/api/tariff-plans/[planId]/subscribers/route.ts` | Yes | `requireAuth` | READ | N/A | ocsBillingRepository | xcloud | ocs_subscribers | — |
| POST | `/api/tariff-plans/import` | `src/app/api/tariff-plans/import/route.ts` | Yes | `requireCapability(tariff_write)` | WRITE | APPROVAL_GOVERNED | ocsBillingRepository | xcloud | ocs_tariff_plans | approval, audit |

### Users

| Method | Path | Source File | Auth | Permission | Operation | Governance | Repository | Mongo DB | Collection | Side Effects |
|--------|------|-------------|------|------------|-----------|------------|------------|----------|------------|--------------|
| GET | `/api/users` | `src/app/api/users/route.ts` | Yes | `requireAuth` | READ | N/A | userRepository | xcloud_ops | app_users | — |
| POST | `/api/users` | `src/app/api/users/route.ts` | Yes | `requirePermission(users.create)` | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit |
| GET | `/api/users/:username` | `src/app/api/users/[username]/route.ts` | Yes | `requireAuth` | READ | N/A | userRepository | xcloud_ops | app_users | — |
| PUT | `/api/users/:username` | `src/app/api/users/[username]/route.ts` | Yes | `requirePermission(users.update)` | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit |
| DELETE | `/api/users/:username` | `src/app/api/users/[username]/route.ts` | Yes | `requirePermission(users.delete)` | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit |
| PATCH | `/api/users/:username` | `src/app/api/users/[username]/route.ts` | Yes | `requirePermission(users.disable)` | WRITE | DIRECT_GOVERNED | userRepository | xcloud_ops | app_users | audit |

## Notes

- **Auth pattern**: All routes except `/api/auth/login` and `/api/auth/logout` require authentication via JWT cookie (verified by `proxy.ts` middleware). Route handlers additionally call `requireAuth`, `requireCapability`, or `requirePermission`.
- **Rate limiting**: Most routes enforce per-user rate limits via `enforceRateLimit()` backed by MongoDB `app_rate_limits` collection.
- **Dual permission system**: Routes use either the legacy capability system (`requireCapability`) or the new permission system (`requirePermission`). Both are enforced server-side.
- **Stale documentation claim**: CLAUDE.md states "54 API Route Handlers" — actual count is **63 route files** with **89 operations**.
