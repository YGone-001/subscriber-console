#!/usr/bin/env node
/*
 * Coverage ceiling analysis (diagnostic, not a gate).
 *
 * Splits the class-coverage gap into "reachable" and "unreachable" so the 90%
 * acceptance target can be judged honestly: a class used only by a file the scope
 * excludes can never be produced by the current checkout, so it belongs to a ceiling
 * rather than to a backlog.
 *
 * The exclusion set comes from `scripts/lib/ui-parity-scope.mjs`, the single scope
 * definition shared with the parity gate. This script must never carry its own list.
 *
 * Usage: node scripts/analyse-parity-ceiling.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
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

const REFERENCE = process.env.UI_PARITY_REFERENCE || 'C:/Users/YGone/Desktop/subscriber-console';
const PROJECT = process.env.UI_PARITY_PROJECT || 'C:/Users/YGone/Desktop/program/subscriber-console';
const REF_SRC = path.join(REFERENCE, 'frontend', 'src');
const CUR_SRC = path.join(PROJECT, 'frontend', 'src');

const SKIP = new Set(['node_modules', '.next', 'dist']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) { if (!SKIP.has(entry)) walk(full, out); }
    else if (/\.(tsx|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/* The parity gate's own extraction: static className literals. */
function vocabulary(files) {
  const tokens = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/className=(?:\{`|["'])([^`"']*)/g)) {
      for (const token of match[1].split(/[\s${}]+/)) {
        if (/^[a-z][a-z0-9-]*$/.test(token)) tokens.add(token);
      }
    }
  }
  return tokens;
}

const scopeProblems = validateScope();
if (scopeProblems.length) {
  console.log(`ui_parity_scope_problems=${scopeProblems.length}`);
  for (const problem of scopeProblems) console.log(`  ${problem}`);
}

/* ---------------------------------------------------------------------------
 * Symmetric reachability.
 *
 * Both sides are walked through their OWN import graph from their OWN entry points.
 * The denominator is therefore what the historical application actually rendered, not
 * "every file nobody excluded".
 * ------------------------------------------------------------------------- */

const skipExcluded = (relativePath) => isExcluded(relativePath);

const historicalEntries = HISTORICAL_ENTRY_POINTS
  .map((entry) => ({ ...entry, absolute: path.join(REF_SRC, entry.path) }))
  .filter((entry) => fs.existsSync(entry.absolute));

const historicalFiles = buildImportGraph({
  srcRoot: REF_SRC,
  entries: historicalEntries.map((entry) => entry.absolute),
  skip: skipExcluded,
});

const currentEntries = CURRENT_ENTRY_POINTS
  .map((entry) => path.join(PROJECT, entry))
  .filter((entry) => fs.existsSync(entry));

const currentFiles = buildImportGraph({
  srcRoot: path.join(PROJECT, 'frontend/src'),
  entries: currentEntries,
});

const stylesheetClasses = collectStylesheetClasses(walk(REF_SRC).filter((file) => /\.css$/.test(file)));

const historicalVocabulary = new Set(
  classPairsOf(historicalFiles, stylesheetClasses)
    .filter((pair) => !isTokenExcluded(path.relative(REF_SRC, pair.file).replace(/\\/g, '/'), pair.token))
    .map((pair) => pair.token),
);
const currentVocabulary = classVocabularyOf(currentFiles, stylesheetClasses);
const historicalSources = classSourcesOf(historicalFiles, stylesheetClasses);

const missingSymmetric = [...historicalVocabulary].filter((token) => !currentVocabulary.has(token));
const symmetricCoverage = historicalVocabulary.size === 0
  ? 1
  : (historicalVocabulary.size - missingSymmetric.length) / historicalVocabulary.size;

/* Group every missing class by the historical route that pulls its file in. */
function routeForFile(file) {
  const relative = path.relative(REF_SRC, file).replace(/\\/g, '/');
  const entry = historicalEntries.find((candidate) => candidate.path === relative);
  if (entry) return entry.route;
  for (const candidate of historicalEntries) {
    const dir = path.dirname(candidate.path);
    if (relative.startsWith(`${dir}/`)) return candidate.route;
  }
  return '(shared)';
}

const grouped = new Map();
for (const token of missingSymmetric) {
  for (const file of historicalSources.get(token) ?? ['(unknown)']) {
    const route = routeForFile(file);
    const key = `${route} -> ${path.relative(REF_SRC, file).replace(/\\/g, '/')}`;
    grouped.set(key, [...(grouped.get(key) ?? []), token]);
  }
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

console.log('');
console.log('=== symmetric reachability (acceptance metric) ===');
console.log(`historical_entry_points=${historicalEntries.length}`);
console.log(`historical_reachable_files=${historicalFiles.size}`);
console.log(`current_reachable_files=${currentFiles.size}`);
console.log(`historical_reachable_classes=${historicalVocabulary.size}`);
console.log(`current_reachable_classes=${currentVocabulary.size}`);
console.log(`missing_symmetric=${missingSymmetric.length}`);
console.log(`symmetric_coverage=${pct(symmetricCoverage)}`);
console.log(`acceptance_target=${pct(ACCEPTANCE_TARGET)}`);
console.log(`acceptance_met=${symmetricCoverage >= ACCEPTANCE_TARGET ? 'true' : 'false'}`);
console.log(`scope_revision=${SCOPE_REVIEW.revision} reviewed=${SCOPE_REVIEW.reviewedAt}`);
console.log(`scope_problems=${scopeProblems.length}`);

if (missingSymmetric.length) {
  console.log('');
  console.log('=== missing classes, grouped by historical route -> source file ===');
  for (const [key, tokens] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${key}  (${tokens.length})`);
    console.log(`    ${[...new Set(tokens)].join(' ')}`);
  }
}

/* ---------------------------------------------------------------------------
 * Diagnostic view over the whole historical vocabulary, kept for context only.
 * ------------------------------------------------------------------------- */
const referenceFiles = walk(REF_SRC);
const includedFiles = referenceFiles.filter((file) => !isExcluded(path.relative(REF_SRC, file)));
const referenceVocabulary = classVocabularyOf(referenceFiles);
const includedVocabulary = classVocabularyOf(includedFiles);
const unreachable = [...referenceVocabulary].filter((token) => !includedVocabulary.has(token));

console.log('');
console.log('=== diagnostics (never scored) ===');
console.log(`reference_vocabulary=${referenceVocabulary.size}`);
console.log(`unreachable_classes_by_scope=${unreachable.length}`);
console.log(`absolute_coverage=${pct((referenceVocabulary.size - [...referenceVocabulary].filter((t) => !currentVocabulary.has(t)).length) / referenceVocabulary.size)}`);
console.log(`regression_floor=${pct(REACHABLE_REGRESSION_FLOOR)} max_missing_reachable=${MAX_MISSING_REACHABLE}`);
