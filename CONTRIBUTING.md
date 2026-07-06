# Contributing

Thanks for helping improve `subscriber-console`.

## Branch Naming

- `feat/<short-description>` for new features.
- `fix/<short-description>` for bug fixes.
- `docs/<short-description>` for documentation-only changes.
- `chore/<short-description>` for maintenance work.

## Commit Style

Use concise Conventional Commits:

```text
feat: add subscriber batch precheck
fix: handle missing Redis profile data
docs: update deployment guide
chore: refresh dependencies
```

## Pull Request Flow

1. Open an issue or link to existing context for non-trivial changes.
2. Create a focused branch from `main`.
3. Keep the PR scoped to one feature, fix, or documentation task.
4. Include a summary, testing notes, and screenshots for UI changes.
5. Request review after lint/build checks pass.

## Issue Guidelines

For bugs, include:

- Current behavior
- Expected behavior
- Steps to reproduce
- Environment details
- Logs or screenshots when useful

For feature requests, include:

- User problem
- Proposed behavior
- Alternatives considered
- Operational or security impact

## Code Style

- Use TypeScript for application code.
- Prefer existing `src/lib`, `src/components`, and `src/hooks` patterns.
- Keep API authorization checks close to Route Handler entry points.
- Keep UI text in the existing i18n structure when practical.
- Do not commit generated build output, local Redis data, or real secrets.

## Testing Requirements

Before submitting a PR, run:

```bash
npm run lint
npm run build
```

Add tests for high-risk behavior when introducing or changing:

- Authentication or role authorization
- Redis key schema writes
- Subscriber import/export
- Batch provisioning
- Audit logging
- System health repair flows
