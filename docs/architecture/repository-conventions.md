# Repository Conventions

> Active engineering rules for repository naming and structure.
> Architecture authority: `docs/architecture/`. Operations: `docs/operations/`.
> Historical provenance: `docs/backend-migration/`, `docs/archive/`,
> `docs/architecture/phase-*.md`, `docs/operations/dev-log.md`.

## Naming Rule

Lifecycle phase numbers belong in historical delivery records, not in active
production symbols, test identifiers, CI job names, environment variables,
synthetic API probes, or permanent architecture terminology.

Concretely, active scopes must not introduce:

- numbered lifecycle tokens: a lifecycle word or stage code immediately
  followed by a stage number, in file names, identifiers, log labels, or
  comments;
- migration-state vocabulary that is no longer factually true: retired
  route-owner tables, shadow / parity surface descriptions, pending-transition
  wording, past production-owner statements, and residual-migration phrasing;
- phase-specific environment variables, CI job IDs, CI step names, or
  machine-readable result keys.

Describe the current responsibility instead of the historical transition:
a route is a "management endpoint", a suite is a "deployment boundary
acceptance", a result key is `deployment_boundary_result`, and a probe is
`/api/__routing_unknown_probe__`.

## Scope

| Scope | Phase terminology |
| --- | --- |
| `backend/**` (production source) | forbidden |
| `frontend/src/**` (production source) | forbidden |
| `deploy/**` | forbidden |
| `scripts/**` (active tests, acceptance, tooling) | forbidden, except documented fixtures |
| `.github/workflows/ci.yml` | forbidden |
| `AGENTS.md`, `CLAUDE.md` | forbidden |
| `README.md`, `backend/README.md`, `docs/architecture/*`, `docs/operations/*`, `docs/database/*` | forbidden |
| `docs/backend-migration/**`, `docs/archive/**`, `docs/architecture/phase-*.md`, `docs/operations/dev-log.md` | allowed (historical evidence) |

Historical evidence is provenance, not current architecture authority. It is
intentionally allowed to keep lifecycle numbering and must not be rewritten.

## Single Source Of Truth

- API route authority: the Go registration set parsed from
  `backend/cmd/server/main.go` plus `backend/internal/remediation/handler.go`
  (shared helper `scripts/lib/go-registrations.mjs`).
- Current behavior: this directory and `docs/operations/`.
- Historical behavior: `docs/backend-migration/`.

## Enforcement

`scripts/test-repository-normalization.mjs` enforces this rule. It scans active
scopes, excludes historical evidence, verifies the API surface and the Next.js
backend-absence invariants, and includes a synthetic negative self-test proving
the scanner can fail.
