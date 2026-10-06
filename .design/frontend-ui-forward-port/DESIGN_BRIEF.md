# Design Brief: Historical Frontend UI Forward Port

Date: 2026-10-06

## Objective

Forward-port the historical UI from `C:\Users\YGone\Desktop\subscriber-console\frontend` into the current React/Vite frontend at `C:\Users\YGone\Desktop\program\subscriber-console\frontend` so that comparable routes match the historical visual structure, styling, responsive behavior, and contract-supported interactions.

## Strategy

Use the historical frontend as the presentation authority and the current frontend as the runtime and data authority.

```text
Current React Router route
        -> current read/mutation client
        -> typed Go response adapter
        -> forward-ported historical UI component
        -> historical DOM, CSS, and interaction presentation
```

The work is a bulk, domain-oriented forward port. It is not a directory overwrite and it is not a page-by-page visual reimplementation.

## In scope

- Historical presentational components, component-local state, CSS modules, global UI styles, icons, and responsive behavior.
- OCS tariff, contract, and balance lists/details/modals.
- User list, detail, create, edit, reset-password, filters, summary, and supported bulk orchestration.
- Subscriber summary, toolbar, table, row actions, sorting, pagination, and supported dialogs.
- Profile list, filters, empty states, view/edit presentation, and supported dialogs.
- Login, system-health, command-palette, shell polish, and current-only Inventory localization.
- Current Go-contract adapters and tests needed to feed the historical components safely.

## Out of scope

- Next.js runtime, App Router, server components, server actions, Node route handlers, or Node API proxies.
- Changes to Go methods, paths, request/response contracts, RBAC, rate limits, Mongo schemas, OCS charging-plane boundaries, or direct-execution governance.
- Retired approval and user-facing audit consoles.
- Historical interactions without a current authoritative API or permission contract.

## Protected current files and boundaries

The forward port must preserve the current authority of:

- `frontend/package.json`
- `frontend/vite.config.ts`
- `frontend/tsconfig*.json`
- `frontend/src/main.tsx`
- `frontend/src/app/App.tsx`
- Current React Router route authority and navigation permission model.
- Current authentication/session providers.
- Current read client, mutation client, subscriber mutation builders, and inventory contract implementation.
- Current tests, unless extended without weakening existing assertions.

## Reference sources

- Historical UI root: `C:\Users\YGone\Desktop\subscriber-console\frontend\src`
- Current UI root: `C:\Users\YGone\Desktop\program\subscriber-console\frontend\src`
- Audit evidence: `.workbuddy-ai/reports/ui-parity-audit-2026-10-06/REPORT.md`

## Acceptance criteria

- Comparable historical routes match their reference screenshots at 1440x900, 1024x768, and 390x844 after masking only live values.
- No `next/*` import, Node API route, browser-direct Go URL, or retired route enters the current frontend.
- All current frontend tests remain green and new adapter/interaction tests cover the ported behavior.
- No raw response envelope, untranslated key, object stringification, or generic key/value fallback appears on a production page.
- Admin, operator, and viewer presentation matches current authorization rules.
- Empty, loading, error, populated, forbidden, conflict, and rate-limited states are represented where applicable.
- The final parity gate targets at least 90% historical JSX class coverage after documented exclusions.
