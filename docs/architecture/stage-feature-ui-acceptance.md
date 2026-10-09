# Feature + UI/UX Completion Gate

> Permanent engineering policy for every future implementation stage that
> introduces or modifies a user-facing capability.
>
> This document is forward-looking policy. It does not authorize new features and
> it does not alter any frozen business behaviour.

## 1. Why this gate exists

Backend and frontend are one feature, not two deliverables. A stage is **not**
complete merely because:

- Backend APIs exist.
- MongoDB documents can be created.
- HTTP integration tests pass.
- A basic page renders.
- A navigation entry exists.
- An isolated component was created.
- The new UI uses inconsistent styling.
- Users must call APIs manually to finish ordinary tasks.

A fully implemented backend with an incomplete, inconsistent or unusable frontend
is not a completed stage.

## 2. Completion model

```text
FEATURE COMPLETION
        |
        +-- Domain model completed
        +-- Persistence completed
        +-- API contracts completed
        +-- Security / RBAC / Audit completed
        +-- Frontend navigation integrated
        +-- Frontend workflows operable
        +-- Existing design system reused
        +-- Visual consistency verified
        +-- Responsive and accessibility checks passed
        +-- Backend integration passed
        +-- Frontend interaction tests passed
        +-- Existing feature regressions passed
        +-- Exact-SHA CI passed
        |
        v
STAGE ACCEPTED
```

## 3. Minimum acceptance obligations

Every future user-facing stage must satisfy all twelve obligations.

### 3.1 Existing design-system reuse

Reuse the current xCloud operator-console visual system. Read and follow:

- [Design system rules](design-system-rules.md)
- [Design tokens](design-tokens.md)
- [Page templates](page-templates.md)
- [Frontend UI restoration](frontend-ui-restoration.md)

Use the existing shared components where their contracts fit. Do not duplicate
them under alternative names. Do not create an unrelated new design language.

### 3.2 Navigation and permission integration

New surfaces participate in the shared navigation authority:

```text
frontend/src/router/router.tsx
frontend/src/lib/navigation.ts
```

They must reach the sidebar, tab bar, breadcrumbs and command palette, and
role-aware visibility must be derived from the existing permission authority. An
unauthorized mutation control must never be exposed.

### 3.3 Complete operator workflow

Every ordinary task must be completable through the UI. Manual API calls are not
an acceptable substitute for a workflow. Create, edit, retire, and equivalent
lifecycle operations each need a first-class surface with validation feedback.

### 3.4 Responsive layout

Mandatory review sizes:

```text
Desktop: 1440 x 900
Tablet:   768 x 1024
Mobile:   390 x 844
```

At every size: header and sidebar remain usable, page title and actions do not
overlap, tables confine overflow to their own container, no horizontal page
overflow occurs, and primary actions stay discoverable. Dense visualizations may
degrade to an equivalent list on mobile; they must not be scaled until
unreadable.

### 3.5 Light/dark theme correctness

Both themes must render correctly. Use semantic CSS variables
(`--sys-color-*`, `--surface-*`, `--text-*`, `--ref-*`, `--space-*`) rather than
hardcoded colors, so the theme switch is automatic and complete.

### 3.6 Chinese/English localization

All new visible interface strings support both languages through the current i18n
authority. Do not introduce a new translation provider. Do not leave a new
surface English-only.

### 3.7 Loading, empty and error states

Handle at minimum: initial loading, successful populated data, empty collection,
no filter results, partial/degraded projection, read failure, mutation validation
failure, permission denied, conflict, stale state and unknown resource. Error
handling must never be reduced to silent console messages, and data must never be
invented to make a screen appear populated.

### 3.8 Accessible keyboard interaction

Persistent form labels, accessible dialogs, keyboard navigation, visible focus,
Escape-to-close, `aria-invalid` and error descriptions, descriptive action names,
non-color-only status representation and reduced-motion compatibility. Where a
visualization is used, an equivalent structured list or table is the primary
semantic representation; a visualization without an accessible equivalent is not
acceptable.

### 3.9 Shared feedback and confirmation patterns

Reuse the shared feedback primitives (operation notices, confirmation panels,
toasts, dialogs). Destructive or terminal actions require explicit confirmation
with the affected identity visible. The interface must not claim success until
the server confirms success, and conflicts must not trigger automatic retries.

### 3.10 Real rendered visual evidence

Capture authenticated screenshots of the new surfaces and of representative
existing pages in the same environment, covering at least desktop light, desktop
dark and mobile. Fixtures must be real running data, clearly identified as test
data. Automated source checks alone do not prove visual consistency: a visually
inconsistent or unusable surface must not be reported as complete even if backend
tests pass.

### 3.11 Frontend regression tests

Add behavior tests that assert operator-observable behavior rather than
source-code strings, and add contract tests that fail on drift. Do not weaken or
relax an existing gate merely to make a new surface pass.

### 3.12 Exact-SHA CI

All mandatory jobs must pass at the exact source SHA, including any new
stage-specific job. A stage-specific job must be independently named and must
gate production architecture certification. Do not rename historical jobs to
manipulate the job count.

## 4. Applying the gate

A stage reports `PASS` only when every applicable obligation is backed by a named
test, runtime check or inspected artifact. Where a screenshot is required, the
evidence path or CI artifact must be stated explicitly. Where an obligation does
not apply, the stage must say why.

Intentional differences from existing modules must be recorded rather than
silently accepted.

## 5. Scope boundary

This policy does not authorize modifying unrelated current pages, changing frozen
business behaviour, or relaxing an existing acceptance gate. Later stages may add
stage-specific UI tests on top of these obligations; they may not remove them.
