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
import { dirname, join, relative } from 'node:path';
import {
  ACCEPTANCE_TARGET,
  CURRENT_ENTRY_POINTS,
  HISTORICAL_ENTRY_POINTS,
  MAX_MISSING_REACHABLE,
  REACHABLE_REGRESSION_FLOOR,
  SCOPE_REVIEW,
  isExcluded,
  isTokenExcluded,
  validateScope,
} from './lib/ui-parity-scope.mjs';
import { buildImportGraph, classPairsOf, classSourcesOf, classVocabularyOf, collectStylesheetClasses } from './lib/ui-parity-graph.mjs';

const REFERENCE_ROOT = process.env.UI_PARITY_REFERENCE || 'C:/Users/YGone/Desktop/subscriber-console';
const PROJECT_ROOT = process.cwd();
const REF_SRC = join(REFERENCE_ROOT, 'frontend/src');
const CUR_SRC = join(PROJECT_ROOT, 'frontend/src');

/* Coverage floor. The page layers are restored; the remaining gap is the
 * not-yet-wired surfaces listed in the plan (§4.10), so the floor is set at the
 * achieved level to prevent regression rather than to claim full parity. */
const PARITY_THRESHOLD = Number(process.env.UI_PARITY_THRESHOLD || 0.9);

/*
 * Class-coverage metric.
 *
 * The declared acceptance metric is REACHABLE coverage: the share of the reference
 * class vocabulary that is produced by files the scope does NOT exclude. The
 * absolute figure over the whole historical vocabulary is reported for diagnosis
 * only and never decides pass or fail, because the excluded surfaces are
 * intentionally not ported and could never be reproduced here.
 *
 * The scope itself lives in `./lib/ui-parity-scope.mjs` and is shared with
 * `analyse-parity-ceiling.mjs`; this file must never carry its own exclusion list.
 */
const CLASS_COVERAGE_FLOOR = Number(process.env.UI_PARITY_CLASS_FLOOR || REACHABLE_REGRESSION_FLOOR);
const CLASS_COVERAGE_TARGET = ACCEPTANCE_TARGET;

/*
 * Anti-gaming: a class token only counts if it lives in a source file the app can
 * actually reach. Without this, coverage could be raised by parking class names in a
 * file nothing imports, or by rendering them inside permanently hidden elements.
 *
 * The walk starts at the real entry points and follows relative imports only, which
 * is sufficient because the app is bundled from those entries and every non-relative
 * specifier resolves to a package.
 */
function reachableSourceFiles(entryRoots) {
  const visited = new Set();
  const queue = [...entryRoots];

  const resolveSpecifier = (fromFile, specifier) => {
    if (!specifier.startsWith('.')) return null;
    const base = join(dirname(fromFile), specifier);
    const candidates = [
      base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`,
      join(base, 'index.tsx'), join(base, 'index.ts'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };

  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    if (!/\.(tsx|ts)$/.test(file)) continue;
    const source = read(file);
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (resolved) queue.push(resolved);
    }
  }
  return visited;
}

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

/*
 * The exclusion set is NOT defined here. It lives in `./lib/ui-parity-scope.mjs`,
 * shared with `analyse-parity-ceiling.mjs`, expressed as exact repository-relative
 * paths or directory prefixes. The previous implementation matched substrings such
 * as 'approval', 'datahub' and '/rating/', which silently swallowed files nobody had
 * reviewed; that is exactly the failure mode the scope module exists to prevent.
 */

/* Extract class tokens from an explicit file list. */
function classVocabularyFromFiles(files) {
  const tokens = new Set();
  for (const file of files) {
    if (!/\.tsx$/.test(file)) continue;
    const source = read(file);
    for (const match of source.matchAll(/className=(?:\{`|["'])([^`"']*)/g)) {
      for (const token of match[1].split(/[\s${}]+/)) {
        if (/^[a-z][a-z0-9-]*$/.test(token)) tokens.add(token);
      }
    }
  }
  return tokens;
}

/** Extract class tokens from JSX `className` attributes. */
function classVocabulary(dir, { exclude } = {}) {
  const tokens = new Set();
  for (const file of walk(dir, (f) => /\.(tsx|jsx)$/.test(f))) {
    if (exclude && isExcluded(relative(REF_SRC, file))) continue;
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
/*
 * SYMMETRIC coverage: both sides are walked through their own import graph from their
 * own entry points, so the denominator is what the historical application actually
 * rendered. A surface only the historical app's own orphans could produce never enters
 * the denominator, and a class parked in an unreachable current file never enters the
 * numerator.
 */
const historicalEntries = HISTORICAL_ENTRY_POINTS
  .map((entry) => ({ route: entry.route, path: entry.path, absolute: join(REF_SRC, entry.path) }))
  .filter((entry) => existsSync(entry.absolute));

const historicalFiles = buildImportGraph({
  srcRoot: REF_SRC,
  entries: historicalEntries.map((entry) => entry.absolute),
  skip: (relativePath) => isExcluded(relativePath),
});

const currentEntries = CURRENT_ENTRY_POINTS
  .map((entry) => join(PROJECT_ROOT, entry))
  .filter((entry) => existsSync(entry));

const currentFiles = buildImportGraph({ srcRoot: CUR_SRC, entries: currentEntries });

/*
 * Token-scoped contract exclusions are applied per (file, token) pair, so excluding
 * `success` for one file never hides the same word in another.
 */
/* The stylesheet vocabulary settles boundary-touching tokens (see the graph module). */
const historicalStylesheetClasses = collectStylesheetClasses(
  walk(REF_SRC, (f) => /\.css$/.test(f)),
);

const comparablePairs = classPairsOf(historicalFiles, historicalStylesheetClasses)
  .filter((pair) => !isTokenExcluded(relative(REF_SRC, pair.file).replace(/\\/g, '/'), pair.token));

const referenceReachableClasses = new Set(comparablePairs.map((pair) => pair.token));
const currentClasses = classVocabularyOf(currentFiles, historicalStylesheetClasses);
const historicalSources = classSourcesOf(historicalFiles, historicalStylesheetClasses);
const missingReachableClasses = [...referenceReachableClasses].filter((token) => !currentClasses.has(token));

const reachableCoverage = referenceReachableClasses.size === 0
  ? 1
  : (referenceReachableClasses.size - missingReachableClasses.length) / referenceReachableClasses.size;

/* Diagnostics over the whole historical vocabulary. Never scored. */
const referenceAllClasses = classVocabulary(REF_SRC);
const absoluteMissing = [...referenceAllClasses].filter((token) => !currentClasses.has(token));
const absoluteCoverage = referenceAllClasses.size === 0 ? 1 : (referenceAllClasses.size - absoluteMissing.length) / referenceAllClasses.size;

/* Grouped reporting: historical route -> source file -> classes. */
function historicalRouteFor(file) {
  const relPath = relative(REF_SRC, file).replace(/\\/g, '/');
  const exact = historicalEntries.find((entry) => entry.path === relPath);
  if (exact) return exact.route;
  for (const entry of historicalEntries) {
    if (relPath.startsWith(`${dirname(entry.path)}/`)) return entry.route;
  }
  return '(shared)';
}
const missingGroups = new Map();
for (const token of missingReachableClasses) {
  for (const file of historicalSources.get(token) ?? ['(unknown)']) {
    const key = `${historicalRouteFor(file)} -> ${relative(REF_SRC, file).replace(/\\/g, '/')}`;
    missingGroups.set(key, [...(missingGroups.get(key) ?? []), token]);
  }
}

/* The scope is itself a contract: a malformed entry or an unreviewed edit fails. */
const scopeProblems = validateScope();
check('P-00', scopeProblems.length === 0,
  `scope_integrity problems=${scopeProblems.length} revision=${SCOPE_REVIEW.revision} reviewed=${SCOPE_REVIEW.reviewedAt}${scopeProblems.length ? ` :: ${scopeProblems.join('; ')}` : ''}`);

check('P-03', reachableCoverage >= CLASS_COVERAGE_FLOOR && missingReachableClasses.length <= MAX_MISSING_REACHABLE,
  `reachable_coverage=${(reachableCoverage * 100).toFixed(1)}% (historical=${referenceReachableClasses.size} current=${currentClasses.size} missing_reachable=${missingReachableClasses.length}) regression_floor=${(CLASS_COVERAGE_FLOOR * 100).toFixed(1)}% acceptance_target=${(CLASS_COVERAGE_TARGET * 100).toFixed(0)}% max_missing=${MAX_MISSING_REACHABLE}`);

const targetMet = reachableCoverage >= CLASS_COVERAGE_TARGET;
check('P-04', targetMet,
  `acceptance_target_met=${targetMet ? 'true' : 'false'} reachable_coverage=${(reachableCoverage * 100).toFixed(1)}% target=${(CLASS_COVERAGE_TARGET * 100).toFixed(0)}%`);

check('P-05', absoluteCoverage >= 0,
  `absolute_coverage=${(absoluteCoverage * 100).toFixed(1)}% historical_entry_points=${historicalEntries.length} historical_reachable_files=${historicalFiles.size} current_reachable_files=${currentFiles.size} (diagnostic only, not scored)`);
if (missingReachableClasses.length > 0) {
  console.log(`  missing_reachable (${missingReachableClasses.length}), grouped by historical route -> source file:`);
  for (const [key, tokens] of [...missingGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${key} :: ${[...new Set(tokens)].join(' ')}`);
  }
}

console.log('--------------------------------------------------');
console.log(`ui_parity_threshold=${PARITY_THRESHOLD}`);
console.log(`ui_parity_reachable_coverage=${(reachableCoverage * 100).toFixed(1)}`);
console.log(`ui_parity_missing_reachable=${missingReachableClasses.length}`);
console.log(`ui_parity_historical_reachable_classes=${referenceReachableClasses.size}`);
console.log(`ui_parity_absolute_coverage=${(absoluteCoverage * 100).toFixed(1)}`);
console.log(`ui_parity_scope_revision=${SCOPE_REVIEW.revision}`);
console.log(`ui_parity_invariants_failed=${failed}`);
console.log(`ui_parity_result=${failed === 0 ? 'PASS' : 'FAIL'}`);
console.log('==================================================');
process.exit(failed === 0 ? 0 : 1);
