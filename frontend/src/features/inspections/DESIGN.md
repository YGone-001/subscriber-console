---
name: xCloud scheduled inspection workbench
description: Feature-local record of the existing operations interface
colors:
  primary: "var(--primary)"
  surface: "var(--surface)"
  border: "var(--surface-border)"
  text: "var(--text)"
  secondary-text: "var(--text-secondary)"
  danger: "var(--danger)"
  warning: "var(--warning)"
  success: "var(--success)"
typography:
  heading:
    fontFamily: "var(--font-interface)"
    fontSize: "1.125rem"
    fontWeight: 600
  caption:
    fontFamily: "var(--font-interface)"
    fontSize: "0.75rem"
  identity:
    fontFamily: "var(--font-data)"
    fontSize: "0.75rem"
rounded:
  panel: "8px"
spacing:
  field: "16px"
  section: "20px"
  editor: "24px"
---

# Design System: xCloud scheduled inspections

## Overview

**Creative North Star: "Existing xCloud operations workbench"**

This records the built inspection feature, not a replacement product identity.
The global authority remains [frontend UI ownership](../../../../docs/architecture/frontend-ui-ownership.md),
the shared components, `styles/tokens.css` and `styles/globals.css`. Semantic
colors remain live references so light and dark themes keep their own palette.

**Key Characteristics:**

- Compact operational tables with progressive evidence disclosure.
- Existing page frame, controls, navigation and bilingual copy.
- Textual execution and evidence states that remain readable independently of color.

## Colors

Primary color marks navigation and actions. Neutral surfaces and separators
organize dense evidence. Warning, danger and success accompany explicit state
labels; they do not replace those labels. The feature creates no local palette.

## Typography

Interface text inherits the existing Noto Sans SC interface stack. Section
headings use the shared heading token; tables and provenance use caption size.
Resource and evidence identities use the existing data font. Status labels keep
whole words while prose and long identities can wrap.

## Layout

The workspace uses a grid with section spacing. The editor is bounded to 70rem,
with wrapping field grids and two-column scope selectors. Below 768px selectors
stack; secondary table columns are omitted while evidence disclosure preserves
their content. Below 440px filters and facts stack. Table overflow stays inside
its bordered container. The shared application shell owns page scrolling.

## Elevation & Depth

Local evidence tables rely on surface color and thin borders. The existing
MetricStrip and shared buttons retain their inherited depth; this feature does
not add a shadow vocabulary.

## Shapes

Tables and dialogs use the shared panel radius. Form fields and buttons retain
shared control geometry. Dialogs are bounded by the viewport and scroll inside.

## Components

- `OperationsPageFrame` supplies the title, one refresh action and operations tabs.
- `ViewSwitch`, `CursorPagination` and tables support the two directories.
- `MetricStrip` presents findings, unknowns and passes as separate counts.
- `Field` associates errors with controls. A focused summary links to corrections
  before preview or save; rejected input preserves the draft.
- `Dialog` and `UnsavedChangesGuard` retain focus handling and explicit cancellation.
- Evidence disclosure shows read time, measurement time, age, threshold and source
  identity; source links open the existing workspace.

## Do's and Don'ts

- Do reuse shared tokens and the established shell.
- Do keep state labels readable and expose secondary evidence on narrow screens.
- Do distinguish stored historical evidence from the current source page.
- Don't introduce local colors, fonts or an alternative page frame.
- Don't imply that an unknown result passed, or that report refresh repeats collection.

Native browser zoom, human accessibility checks and live-source activation are
acceptance evidence, not inferred design guarantees.
