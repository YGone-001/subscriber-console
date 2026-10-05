#!/usr/bin/env node
/*
 * Reference-driven UI parity contract.
 *
 * Unlike `test-ui-restoration-contract.mjs` (which asserts strings the current
 * implementation defines itself, and therefore can never fail on divergence),
 * this gate reads the REFERENCE checkout and compares against it directly:
 *
 *   1. every forward-ported stylesheet keeps >= PARITY_THRESHOLD of the reference
 *      rule count for its domain;
 *   2. the reference shared-primitive inventory is present;
 *   3. the reference JSX class vocabulary is covered by the current markup.
 *
 * Reference source is located via UI_PARITY_REFERENCE, defaulting to the local
 * reference checkout. When it is absent the gate SKIPS (exit 0) with a notice, so
 * a machine without the reference does not get a false red.
 *
 * Reference baseline: commit 2c40903 (last pure-Next.js state). The reference
 * working tree is equivalent for `frontend/src` — see
 * docs/architecture/frontend-ui-parity-plan.md §1.2.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REFERENCE_ROOT = process.env.UI_PARITY_REFERENCE || 'C:/Users/YGone/Desktop/subscriber-console';
const PROJECT_ROOT = process.cwd();
const REF_SRC = join(REFERENCE_ROOT, 'frontend/src');
const CUR_SRC = join(PROJECT_ROOT, 'frontend/src');

/* Coverage floor. Phase 4 restored the page layers; the remaining gap is the
 * not-yet-wired surfaces listed in the plan (§4.10), so the floor is set at the
 * achieved level to prevent regression rather than to claim full parity. */
const PARITY_THRESHOLD = Number(process.env.UI_PARITY_THRESHOLD || 0.9);

/* Class-vocabulary floor for the app markup. This is deliberately a REGRESSION
 * floor, not a parity claim: the residual gap is exactly the not-yet-wired
 * reference surfaces (SubscribersTable, the Profile governance table, the
 * notification-preference drawer). Raise this as those land; the target is 0.90. */
const CLASS_COVERAGE_FLOOR = Number(process.env.UI_PARITY_CLASS_FLOOR || 0.30);
const CLASS_COVERAGE_TARGET = 0.9;

const results = [];
let failed = 0;

function check(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${detail}`);
}

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.next'].includes(entry)) continue;
      walk(full, predicate, out);
    } else if (stat.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

const ruleCount = (text) => (text.match(/\{/g) || []).length;

/**
 * Reference surfaces that are intentionally NOT ported. Their class vocabulary is
 * excluded from the coverage denominator, otherwise the gate could never pass even
 * at true parity. Sources: docs/architecture/frontend-ui-restoration.md and plan §4.4.
 */
const EXCLUDED_REFERENCE_PATHS = [
  'DataHub',
  'datahub',
  'diff-viewer',
  'VisualDiffViewer',
  '/governance/',
  'SubscriberTraceModal',
  'subscriber-trace-modal',
  '/rating/',
  'SubscriberBatchUpdateModal',
  'approval',
  'soundEffects',
  'imsQosPresets',
];

const isExcluded = (file) => EXCLUDED_REFERENCE_PATHS.some((needle) => file.includes(needle));

/** Extract class tokens from JSX `className` attributes. */
function classVocabulary(dir, { exclude } = {}) {
  const tokens = new Set();
  for (const file of walk(dir, (f) => /\.(tsx|jsx)$/.test(f))) {
    if (exclude && isExcluded(file)) continue;
    const source = read(file);
    for (const match of source.matchAll(/className=(?:\{`|["'])([^`"']*)/g)) {
      for (const token of match[1].split(/[\s${}]+/)) {
        if (/^[a-z][a-z0-9-]*$/.test(token)) tokens.add(token);
      }
    }
  }
  return tokens;
}

if (!existsSync(REF_SRC)) {
  console.log(`ui_parity_result=SKIP`);
  console.log(`reason=reference source not found at ${REF_SRC}`);
  console.log('Set UI_PARITY_REFERENCE to the reference checkout to run this gate.');
  process.exit(0);
}

console.log('==================================================');
console.log('Reference-driven UI parity contract');
console.log(`reference: ${REF_SRC}`);
console.log(`threshold: ${PARITY_THRESHOLD}`);
console.log('--------------------------------------------------');

// 1. Ported stylesheets must retain the reference rule density for their domain.
//    `sources` are reference files; `target` is the forward-ported stylesheet.
const STYLE_DOMAINS = [
  { id: 'globals', target: 'styles/globals.css', sources: ['app/globals.css'], floor: 0.85 },
  { id: 'analytics', target: 'styles/analytics.css', sources: ['components/analytics.css'] },
  { id: 'ocs', target: 'styles/ocs.css', sources: ['app/(dashboard)/ocs/ocs.css'] },
  { id: 'subscribers', target: 'styles/subscribers.css', sources: [
    'app/(dashboard)/subscribers/subscribers.css',
    'components/subscriber/subscriber.css',
    'components/subscriber/rating-rule-link-panel.css',
  ] },
  { id: 'profile', target: 'styles/profile.css', sources: [
    'app/(dashboard)/profile/profile.css',
    'components/profile/profile.css',
  ] },
  { id: 'system-health', target: 'styles/system-health.css', sources: ['app/(dashboard)/system-health/system-health.css'] },
  { id: 'modals', target: 'styles/modals.css', sources: ['components/modals.css', 'components/SubscriberModal.css'] },
  { id: 'login', target: 'styles/login.css', sources: ['app/login/LoginForm.css'] },
];

let styleFailures = 0;
for (const domain of STYLE_DOMAINS) {
  const reference = domain.sources.reduce((sum, file) => sum + ruleCount(read(join(REF_SRC, file))), 0);
  const current = ruleCount(read(join(CUR_SRC, domain.target)));
  const floor = domain.floor ?? PARITY_THRESHOLD;
  const ratio = reference === 0 ? 1 : current / reference;
  const ok = ratio >= floor;
  if (!ok) styleFailures++;
  console.log(`  style:${domain.id.padEnd(15)} reference=${String(reference).padStart(4)} current=${String(current).padStart(4)} ratio=${ratio.toFixed(2)}${ok ? '' : '  <-- below floor'}`);
}
check('P-01', styleFailures === 0, `stylesheets_below_floor=${styleFailures}/${STYLE_DOMAINS.length}`);

// 2. Reference shared-primitive inventory must be present.
const REQUIRED_PRIMITIVES = [
  ['components/ui/MetricStrip.tsx', 'MetricStrip'],
  ['components/ui/DataTablePagination.tsx', 'DataTablePagination'],
  ['components/ui/DataTableState.tsx', 'DataTableStateRow'],
  ['components/ui/SortableTableHeader.tsx', 'SortableTableHeader'],
  ['components/ui/InlineNotice.tsx', 'InlineNotice'],
  ['components/ui/ChartDataTable.tsx', 'ChartDataTable'],
  ['components/ui/chartPrimitives.tsx', 'CHART_SERIES_COLORS'],
  ['components/ui/SectionHeader.tsx', 'SectionHeader'],
  ['components/ui/RefreshButton.tsx', 'RefreshButton'],
  ['components/ui/IconButton.tsx', 'IconButton'],
  ['components/ui/Dialog.tsx', 'Dialog'],
  ['components/ui/Field.tsx', 'Field'],
  ['components/ui/UnsavedChangesGuard.tsx', 'useUnsavedChangesGuard'],
  ['components/ui/useDialogFocus.ts', 'useDialogFocus'],
  ['components/ui/PageHeader.tsx', 'ConsolePageHeader'],
  ['components/ocs/OcsPageShell.tsx', 'OcsPageShell'],
  ['components/health/SubsystemCard.tsx', 'SubsystemCard'],
];
const missingPrimitives = REQUIRED_PRIMITIVES
  .filter(([file, symbol]) => !read(join(CUR_SRC, file)).includes(symbol))
  .map(([file]) => file);
check('P-02', missingPrimitives.length === 0, `missing_primitives=${missingPrimitives.length ? missingPrimitives.join(',') : 'none'}`);

// 3. Reference JSX class vocabulary coverage in the current markup, measured over
//    the surfaces we actually claim to have ported.
const referenceClasses = classVocabulary(REF_SRC, { exclude: true });
const currentClasses = classVocabulary(CUR_SRC);
const missingClasses = [...referenceClasses].filter((token) => !currentClasses.has(token));
const coverage = referenceClasses.size === 0 ? 1 : (referenceClasses.size - missingClasses.length) / referenceClasses.size;
check('P-03', coverage >= CLASS_COVERAGE_FLOOR, `class_coverage=${(coverage * 100).toFixed(1)}% (reference=${referenceClasses.size} current=${currentClasses.size} missing=${missingClasses.length}) regression_floor=${(CLASS_COVERAGE_FLOOR * 100).toFixed(0)}% target=${(CLASS_COVERAGE_TARGET * 100).toFixed(0)}%`);
if (missingClasses.length > 0 && process.env.UI_PARITY_SHOW_MISSING) {
  console.log(`  missing (first 60): ${missingClasses.slice(0, 60).join(' ')}`);
}

console.log('--------------------------------------------------');
console.log(`ui_parity_threshold=${PARITY_THRESHOLD}`);
console.log(`ui_parity_class_coverage=${(coverage * 100).toFixed(1)}`);
console.log(`ui_parity_missing_classes=${missingClasses.length}`);
console.log(`ui_parity_invariants_failed=${failed}`);
console.log(`ui_parity_result=${failed === 0 ? 'PASS' : 'FAIL'}`);
console.log('==================================================');
process.exit(failed === 0 ? 0 : 1);
