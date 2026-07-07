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
npm run build
```

Recommended future tests:

- API authorization tests
- MongoDB repository integration tests
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
npm run lint
```
