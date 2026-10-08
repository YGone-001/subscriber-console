/*
 * Anti-AI-drift gate.
 *
 * The visual refresh removed a class of decoration the design system forbids: gradient
 * fills used as ornament, radial glows, conic-gradient ring gauges, and backdrop blur on
 * persistent surfaces. Nothing stopped those from creeping back in, so this gate makes the
 * removal durable.
 *
 * It scans the stylesheets for the flagged declarations and fails unless the occurrence is
 * on the sanctioned list below. Each sanctioned entry carries the reason it is legitimate,
 * so the list stays reviewable instead of becoming a dumping ground.
 *
 * Usage:
 *   node scripts/check-ui-anti-ai-drift.mjs            # gate
 *   node scripts/check-ui-anti-ai-drift.mjs --list     # print every occurrence, never fail
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'frontend', 'src');
const STYLES = path.join(SRC, 'styles');
const LIST_ONLY = process.argv.includes('--list');

/*
 * Flagged declarations. `decorative` describes what the pattern means when it is NOT
 * sanctioned, so a failure message explains the problem rather than just naming a property.
 */
const FLAGGED = [
  { property: 'linear-gradient', decorative: 'a gradient used as a fill or ornament' },
  { property: 'radial-gradient', decorative: 'a radial glow' },
  { property: 'conic-gradient', decorative: 'a ring / gauge encoding a value as an angle' },
  { property: 'backdrop-filter', decorative: 'glass blur' },
];

/*
 * Sanctioned occurrences, keyed by stylesheet (repository-relative) plus a selector
 * fragment. `selector: '*'` sanctions the property for the whole file.
 *
 * Every entry here is a deliberate exception:
 *   - loading shimmer: the skeleton needs a moving highlight to read as "loading";
 *   - the page-header status rail: an explicit situation marker the design system names;
 *   - overlay scrims: modal / drawer / command-palette backdrops, where the design system
 *     permits 2-8px blur because they are genuine overlays over live content.
 */
const SANCTIONED = [
  { file: 'styles/base.css', selector: '.loading-row', property: 'linear-gradient', reason: 'loading shimmer' },
  { file: 'styles/globals.css', selector: '.loading-row', property: 'linear-gradient', reason: 'loading shimmer' },
  { file: 'styles/analytics.css', selector: '.analytics-sparkline-placeholder', property: 'linear-gradient', reason: 'chart placeholder shimmer' },
  { file: 'styles/modules/ConsolePrimitives.module.css', selector: '.pageHeader::before', property: 'linear-gradient', reason: 'page-header status rail (named situation marker)' },
  { file: 'styles/command-palette.css', selector: '.cp-overlay', property: 'backdrop-filter', reason: 'overlay scrim, blur 4px' },
  { file: 'styles/shell.css', selector: '.cp-overlay', property: 'backdrop-filter', reason: 'overlay scrim, blur 4px' },
  { file: 'styles/shell.css', selector: '.sidebar-mobile-backdrop', property: 'backdrop-filter', reason: 'overlay scrim, blur 2px' },
  { file: 'styles/components.css', selector: '.modal-backdrop', property: 'backdrop-filter', reason: 'overlay scrim, blur 3px' },
  { file: 'styles/globals.css', selector: '.modal-overlay', property: 'backdrop-filter', reason: 'overlay scrim, blur 8px' },
  { file: 'styles/feedback.css', selector: '.op-modal-backdrop', property: 'backdrop-filter', reason: 'overlay scrim, blur 4px' },
  { file: 'styles/ocs.css', selector: '.ocs-drawer-backdrop', property: 'backdrop-filter', reason: 'overlay scrim, blur 4px' },
];

function stylesheets(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) stylesheets(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/* Nearest enclosing rule selector, walking back to the line that opened the block. */
function enclosingSelector(lines, index) {
  for (let i = index; i >= 0; i--) {
    const text = lines[i].trim();
    if (text.endsWith('{')) return text.slice(0, -1).trim();
  }
  return '(unknown)';
}

const isSanctioned = (relFile, selector, property) =>
  SANCTIONED.some((entry) =>
    entry.file === relFile &&
    entry.property === property &&
    (entry.selector === '*' || selector.includes(entry.selector)));

const findings = [];
for (const file of stylesheets(STYLES)) {
  /* `key` matches SANCTIONED (relative to frontend/src); `rel` is for display only. */
  const key = path.relative(SRC, file).replace(/\\/g, '/');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('*') || line.trim().startsWith('/*')) continue;
    for (const check of FLAGGED) {
      if (!line.includes(check.property)) continue;
      const selector = enclosingSelector(lines, i);
      findings.push({
        file: rel, line: i + 1, selector, property: check.property,
        decorative: check.decorative,
        sanctioned: isSanctioned(key, selector, check.property),
      });
    }
  }
}

if (LIST_ONLY) {
  console.log(`occurrences=${findings.length}`);
  for (const f of findings) {
    console.log(`  ${f.sanctioned ? 'OK  ' : 'FLAG'} ${f.file}:${f.line}  ${f.property}  in "${f.selector}"`);
  }
  process.exit(0);
}

const violations = findings.filter((f) => !f.sanctioned);
console.log('==================================================');
console.log('Anti-AI-drift gate');
console.log(`stylesheets_scanned=${stylesheets(STYLES).length}  occurrences=${findings.length}  sanctioned=${findings.length - violations.length}`);
console.log('--------------------------------------------------');
for (const v of violations) {
  console.log(`FAIL  ${v.file}:${v.line}`);
  console.log(`      ${v.property} in "${v.selector}" is ${v.decorative}.`);
  console.log('      Either remove it, or add a justified entry to SANCTIONED in this script.');
}
console.log('--------------------------------------------------');
console.log(`ui_anti_ai_drift_violations=${violations.length}`);
console.log(`ui_anti_ai_drift_result=${violations.length ? 'FAIL' : 'PASS'}`);
if (violations.length) process.exitCode = 1;
