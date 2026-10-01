# Repository Conventions

> Active engineering rules for repository naming and structure.
> Architecture authority: `docs/architecture/`. Operations: `docs/operations/`.
> Historical summaries: `docs/archive/`. Documentation index: `docs/README.md`.

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
| `README.md`, `backend/README.md`, `docs/README.md`, `docs/architecture/*`, `docs/operations/*`, `docs/database/*` | forbidden |
| `docs/archive/**` (concise historical summaries only) | allowed (historical) |

`docs/archive/**` holds concise historical summaries, not current architecture
authority. It is intentionally allowed to keep lifecycle numbering and must not
be rewritten.

## Single Source Of Truth

- API route authority: the Go registration set parsed from
  `backend/cmd/server/main.go` plus `backend/internal/remediation/handler.go`
  (shared helper `scripts/lib/go-registrations.mjs`).
- Current behavior: `docs/architecture/`, `docs/operations/` and
  `docs/database/`. Documentation index: `docs/README.md`.
- Historical behavior: not maintained in the current tree; retrieve it from Git
  history (see `docs/archive/backend-migration-summary.md`).

## Documentation Policy

- Current architecture documentation describes only the present system.
- Completed implementation plans and acceptance records are not maintained
  indefinitely in HEAD.
- Git history preserves detailed historical development evidence.
- `docs/archive/**` may contain only concise historical summaries.
- New lifecycle-numbered documentation must not be introduced into the active
  documentation set.
- Implementation work updates the permanent current documentation instead of
  leaving lifecycle-specific documents behind.

## Enforcement

`scripts/test-repository-normalization.mjs` enforces the naming rule. It scans
active scopes, excludes historical summaries, verifies the API surface and the
Next.js backend-absence invariants, and includes a synthetic negative self-test
proving the scanner can fail.

`scripts/test-documentation-integrity.mjs` enforces the documentation policy. It
proves the retired documentation trees stay absent, the required current
documents exist, all relative Markdown links resolve, active documentation
carries no lifecycle numbering, and no active document references a deleted
documentation tree.
