# Legacy Redis To MongoDB Migration

The application no longer needs Redis at runtime. This document is only for one-time migration from an older Redis-backed deployment.

## What Is Migrated

- `SUB_4G:*`, `AUTH_4G:*`, and OCS keys into Open5GS-style `subscribers` documents
- `PROFILE:*` into `app_profiles`
- `PROFILE_VERSION:*` into `app_profile_versions`
- `OCS:RATES:RATES_*` into `app_ratings`
- `SYS_USER:*` into `app_users`
- `LOG:AUDIT` into `app_audit_logs`
- `LOG:ALERTS:LOCAL` into `app_alerts`

Derived statistics are not copied. The dashboard now computes analytics from MongoDB subscriber documents.

## Before Running

1. Back up Redis and MongoDB.
2. Configure `.env` with `MONGODB_URI` and `MONGODB_DB`.
3. Run `npm run mongo:init`.
4. Make sure the old Redis instance is reachable from the migration host.

## Dry Run

```bash
REDIS_URL=redis://127.0.0.1:6379/0 npm run mongo:migrate-redis -- --dry-run
```

PowerShell:

```powershell
$env:REDIS_URL = "redis://127.0.0.1:6379/0"
npm run mongo:migrate-redis -- --dry-run
```

The script prints counts without writing MongoDB documents.

## Migrate

```bash
REDIS_URL=redis://127.0.0.1:6379/0 npm run mongo:migrate-redis
```

PowerShell:

```powershell
$env:REDIS_URL = "redis://127.0.0.1:6379/0"
npm run mongo:migrate-redis
```

Existing MongoDB documents are kept by default. Use `--overwrite` only when Redis should replace existing MongoDB documents:

```bash
REDIS_URL=redis://127.0.0.1:6379/0 npm run mongo:migrate-redis -- --overwrite
```

Skip audit and alert history when only subscriber/profile/rating/user data is needed:

```bash
REDIS_URL=redis://127.0.0.1:6379/0 npm run mongo:migrate-redis -- --skip-logs
```

## Cutover

After migration:

1. Run `npm run build`.
2. Start the application with MongoDB environment variables.
3. Verify subscriber list, profile list, ratings, users, audit logs, and alerts.
4. Stop Redis after the new deployment is confirmed.
