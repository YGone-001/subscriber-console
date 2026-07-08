# Development

## Environment Setup

Install:

- Node.js 20+
- npm
- MongoDB, preferably the same database used by a local Open5GS setup

Install dependencies:

```bash
npm install
```

Create local configuration:

```bash
cp .env.example .env
```

Update `.env` with local values. Never commit `.env`.

## Local Startup

Start MongoDB, initialize indexes, then run:

```bash
npm run mongo:init
npm run dev
```

Open `http://localhost:3000`.

## Code Standards

- Use TypeScript.
- Keep route handlers under `src/app/api`.
- Keep shared server logic in `src/lib`.
- Keep MongoDB access in `src/server/repositories`.
- Keep reusable UI in `src/components`.
- Follow the existing role authorization pattern in API handlers.
- Keep user-facing text aligned with the i18n provider when practical.

## Testing

Current baseline checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

MongoDB core integration smoke test:

```bash
npm run mongo:test-core
```

This command creates a temporary database based on `MONGODB_DB`, verifies required indexes, exercises core subscriber/profile/rating/user/audit/alert/rate-limit/metric writes, and drops the temporary database when it finishes. Set `MONGODB_TEST_DB` to choose the temporary database name. Use `-- --keep-db` only when you intentionally want to inspect the generated test database.

MongoDB query performance smoke test:

```bash
npm run mongo:perf
```

This command is read-only against the configured `MONGODB_DB`. It runs `explain("executionStats")` for key subscriber, audit, alert, profile, rating, and analytics queries, then flags collection scans, high scan ratios, and queries slower than the threshold. Use `-- --json` for machine-readable output, `-- --imsi-prefix=460020` to force the subscriber search prefix, `-- --slow-ms=500` to tune the slow-query threshold, and `-- --allow-collscan` when full-collection analytics scans are acceptable for the current dataset.

Operational scripts write JSON reports under `reports/ops/` by default:

- `npm run mongo:init`
- `npm run mongo:test-core`
- `npm run mongo:perf`

Set `OPS_REPORT_DIR` to write reports elsewhere.

For the full local quality gate, run:

```bash
npm run check
```

Recommended future tests:

- API authorization tests
- Subscriber import/export tests
- Batch creation conflict tests
- Audit and analytics side-effect tests

## Git Commit Convention

Use Conventional Commits:

```text
feat: add profile version comparison
fix: prevent viewer from mutating subscribers
docs: document deployment variables
chore: initialize project documentation
```

Before committing:

```bash
git status
git diff --check
npm run check
```
