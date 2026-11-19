# Scheduled inspection implementation summary

The workbench adds paused-by-default plans, bounded read-only evidence summaries,
calendar scheduling, durable execution reports, compatible comparisons and fixed
CSV/JSON exports. It reuses existing operations scope, identities, permissions and
source workspaces; it does not collect or change network configuration.

The approved implementation plan is preserved in Git history at `fafb441`.
Current authority is [the architecture](../architecture/scheduled-inspections.md)
and [the operation guide](../operations/scheduled-inspections.md).

Actual isolated MongoDB, Go race tests and a production SPA browser fixture cover
admission, recovery, concurrent retries, stale evidence, scheduling, missed records,
immutable export, role rejection, CAS draft retention and validation focus. These
are synthetic-source checks, not live network or multi-host acceptance. Native
80%/200% browser zoom and human accessibility verification remain separate;
the supplied 640 CSS-pixel/DPR-2 capture proves equivalent reflow only.

The independent UI review requested actionable field validation and unbroken
tablet status labels. Both were implemented and recaptured. The reviewer's final
verdict and documenter handoffs hit the session usage limit; the primary agent
completed the bounded verdict/documentation fallback rather than claiming a
second independent approval.

The environment owner subsequently handed managed Go/Vite processes to agent-dev.
Ownership checks, managed stop/start and full-stack access diagnostics passed.
The inspection-only initializer created the module indexes without enabling jobs.

Live acceptance on 2026-11-19 found missing health evidence indexes on histories
of roughly 324,000 records each. The focused index-only repair changed the latest
sample/run query plans from collection scans and blocking sorts to DISTINCT_SCAN;
observed query times fell from about 1.8 seconds / timeout to 12 / 3 milliseconds.
This observation is not a latency guarantee. Existing evidence was preserved.

The reviewed package paths under /etc/xCloud supply 54 readable configuration
sources: 46 explicitly bound sources cover the 21 existing Inventory resources;
eight remain unassociated rather than creating inferred resources. All 54 passed
read-only publication, and 46 bound sources reached in_sync against the accepted
deployment reference. The user selected hourly read-only collection for those 46;
the eight unassociated sources remain manual. Private declarations and the
fingerprint key remain deployment state outside Git.

The full-scope manual report read every selected source completely and recorded
134 passed checks, nine health findings and 21 unmeasured-layer gaps. Report
refresh/export did not change after a new source observation. A separate approved
file test verified all 54 files through isolated MongoDB with source_writes=0.
These results do not establish that a running NF loaded every observed file.

Live restart acceptance preserved the enabled interval plan, its next execution
and a fixed exported report. A paused daily acceptance plan remained without runs
after its real due time and was archived. The separate 15-minute interval plan
then produced a completed scheduled report at its real due time and was paused;
no synthetic clock or manual trigger substituted for that occurrence. Its IMS
scope retained 56 passed checks and four unmeasured-layer gaps. Original operator
plan definitions were preserved. Native browser zoom and keyboard acceptance
were handed to the user at their request; they are not reported as automated passes.
