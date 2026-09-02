# Development

This guide defines the local setup, source layout, quality checks, and commit requirements for `subscriber-console`.

## Environment setup

Install:

- Node.js 20.9 or later
- npm
- MongoDB, preferably the same database used by a local xCloud setup

Install dependencies:

```bash
npm install
```

Create local configuration:

```bash
cp .env.example .env
```

Update `.env` with local values. Never commit `.env`.

## Local startup

Start MongoDB, initialize indexes, then run:

```bash
npm run mongo:init
npm run dev
```

Open `http://localhost:3000`.

## Code standards

- Use TypeScript for new source files.
- Read the relevant guide under `node_modules/next/dist/docs/` before changing Next.js APIs, file conventions, or routing behavior. Follow `AGENTS.md` and heed deprecation notices.
- Keep route handlers under `src/app/api`.
- Treat every route handler as a public endpoint. Validate authentication, authorization, input, and business conflicts on the server. Do not expose internal errors or sensitive data.
- Keep cross-layer pure utilities in `src/lib`.
- Keep server-only orchestration in `src/server`.
- Keep MongoDB access in `src/server/repositories`.
- Keep reusable UI in `src/components`.
- Follow [UI Design System Rules](design-system-rules.md) for tokens, tables, forms, charts, and responsive behavior.
- Follow the existing role authorization pattern in API handlers.
- Add new user-facing text to both locale files and access it through the i18n provider. Product names, protocol identifiers, and data values may remain untranslated.

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

This command:

- Creates temporary databases based on `MONGODB_DB` and `MONGODB_APP_DB`
- Verifies required indexes
- Exercises core subscriber, profile, rating, user, audit, alert, rate-limit, and metric writes
- Drops the temporary databases when it finishes

Set `MONGODB_TEST_DB` and `MONGODB_TEST_APP_DB` to choose the temporary database names. Use `-- --keep-db` only when you intend to inspect the generated databases.

MongoDB query performance smoke test:

```bash
npm run mongo:perf
```

This command reads the configured `MONGODB_DB` and `MONGODB_APP_DB` without modifying them. It runs `explain("executionStats")` for key queries and reports collection scans, high scan ratios, and queries slower than the threshold.

Use these options when needed:

- `-- --json`: Write machine-readable output
- `-- --imsi-prefix=460020`: Set the subscriber search prefix
- `-- --slow-ms=500`: Set the slow-query threshold
- `-- --allow-collscan`: Allow full-collection analytics scans for the current dataset

Operational scripts write JSON reports under `reports/ops/` by default:

- `npm run mongo:init`
- `npm run mongo:migrate-app-db`
- `npm run mongo:test-core`
- `npm run mongo:perf`

Set `OPS_REPORT_DIR` to write reports elsewhere.

For the full local quality gate, run:

```bash
npm run check
```

Prioritize tests for gaps that do not already have automated coverage:

- Route-level authentication, authorization, validation, and error sanitization
- Subscriber import and export integration flows
- Batch creation conflicts across concurrent requests
- Audit and analytics side effects against a temporary MongoDB database
- Keyboard, focus, and accessible-name behavior for tables, forms, dialogs, and charts

## Git commit convention

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
