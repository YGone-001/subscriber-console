#!/usr/bin/env node
/*
 * UI forward-port boundary gate.
 *
 * The historical UI is being forward-ported from the reference checkout into the
 * current React/Vite app. That port must never drag the retired Next.js runtime
 * back in, never move API ownership into the frontend, never resurrect the
 * retired approval/audit consoles, and never silently replace the current
 * Vite / React Router entry files.
 *
 * The gate is SELF-VERIFYING: `--self-test` builds one controlled fixture per
 * rule in a temporary tree and asserts that the scanner actually reports it.
 * A gate that cannot fail is worse than no gate.
 *
 * Usage:
 *   node scripts/test-ui-forward-port-boundaries.mjs
 *   node scripts/test-ui-forward-port-boundaries.mjs --self-test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', 'coverage']);

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const exists = (file) => fs.existsSync(file);

function walk(dir, predicate, out = []) {
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, predicate, out);
    } else if (stat.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (base, file) => path.relative(base, file).replace(/\\/g, '/');

/* ------------------------------------------------------------------ rules -- */

/** Module specifiers the retired framework runtime would arrive through. */
const FORBIDDEN_MODULE_PATTERNS = [
  { pattern: /(?:^|[\s(])import\s[^;]*?from\s*['"]next(?:\/[^'"]*)?['"]/m, detail: 'next module import' },
  { pattern: /\bexport\s[^;]*?from\s*['"]next(?:\/[^'"]*)?['"]/m, detail: 'next module re-export' },
  { pattern: /\brequire\(\s*['"]next(?:\/[^'"]*)?['"]\s*\)/m, detail: 'next module require' },
  { pattern: /\bfrom\s*['"]@next\/[^'"]*['"]/m, detail: '@next scope import' },
];

/**
 * The bare module path, matched ANYWHERE including comments.
 *
 * `scripts/test-ui-restoration-contract.mjs` rejects these literals as raw text,
 * so a porting note that spells out `next/<subpath>` turns that unrelated suite
 * red. Checking it here surfaces the same mistake in the gate that owns the port.
 * Write such notes as "the Next.js link component" instead.
 */
const FORBIDDEN_BARE_PATH = /\bnext\/(?:link|navigation|image|font|headers|server|router|dynamic)\b|_next\//;

/**
 * A framework directive is only meaningful as a module prologue. Matching it
 * anywhere would flag the porting notes that document its removal, so the check
 * is anchored past any leading comment block.
 */
const DIRECTIVE_PROLOGUE = /^\s*(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*))*['"]use (?:client|server)['"]\s*;?/;

/** A frontend that owns an API surface has broken the Go single-ownership rule. */
const SERVER_ROUTE_FILE = /^(?:route|middleware)\.(?:ts|tsx|js|jsx|mjs)$/;
/* Only top-level route-handler trees count. `src/lib/api/*` is a client module
 * directory and must not be mistaken for a server route surface. */
const SERVER_ROUTE_ROOTS = ['src/api/', 'src/pages/api/', 'src/app/api/'];

const BROWSER_DIRECT_ORIGIN = /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(?:18888|18889|13334)\b/;

/** Consoles removed with the approval workflow; they must not come back. */
const RETIRED_ROUTE_PREFIXES = [
  '/approvals', '/approval', '/audit', '/audit-log', '/audit-logs',
  '/governance/approvals', '/operations/approvals',
];

/** Fingerprints of the files that own the current runtime. */
const PROTECTED_FILES = [
  {
    file: 'package.json',
    must: [
      { pattern: /"type"\s*:\s*"module"/, detail: 'ESM module type' },
      { pattern: /"react-router-dom"/, detail: 'react-router-dom dependency' },
      { pattern: /"vite"\s*:/, detail: 'vite dev dependency' },
      { pattern: /tsc -b && vite build/, detail: 'vite build command' },
      { pattern: /--port 13333 --strictPort/, detail: 'canonical dev port 13333' },
    ],
    mustNot: [
      { pattern: /"(?:next|@next\/[^"]*)"\s*:/, detail: 'framework runtime dependency' },
    ],
  },
  {
    file: 'vite.config.ts',
    must: [
      { pattern: /@vitejs\/plugin-react/, detail: 'react plugin' },
      { pattern: /port:\s*13333/, detail: 'canonical dev port' },
      { pattern: /strictPort:\s*true/, detail: 'strict port ownership' },
      { pattern: /'\/api'/, detail: 'development API proxy' },
    ],
  },
  {
    file: 'index.html',
    must: [
      { pattern: /id="root"/, detail: 'SPA mount point' },
      { pattern: /src="\/src\/main\.tsx"/, detail: 'Vite module entry' },
    ],
  },
  {
    file: 'src/main.tsx',
    must: [
      { pattern: /react-dom\/client/, detail: 'client renderer' },
      { pattern: /getElementById\('root'\)/, detail: 'SPA mount point' },
    ],
  },
  {
    file: 'src/app/App.tsx',
    must: [
      { pattern: /react-router-dom/, detail: 'React Router authority' },
      { pattern: /RouterProvider/, detail: 'router provider' },
    ],
  },
  {
    file: 'src/router/router.tsx',
    must: [
      { pattern: /createBrowserRouter/, detail: 'browser router' },
      { pattern: /APP_ROUTES/, detail: 'navigation authority' },
    ],
  },
  {
    file: 'src/lib/navigation.ts',
    must: [
      { pattern: /APP_ROUTES/, detail: 'route table' },
      { pattern: /hasNavigationPermission/, detail: 'navigation permission gate' },
    ],
  },
];

/** Scan one frontend tree and return every violation, tagged by rule. */
function scanFrontend(frontendRoot) {
  const violations = [];
  const srcRoot = path.join(frontendRoot, 'src');
  const sourceFiles = walk(srcRoot, (file) => /\.(ts|tsx|js|jsx|mjs)$/.test(file));

  /* A-01 - protected runtime files are intact. */
  for (const spec of PROTECTED_FILES) {
    const target = path.join(frontendRoot, spec.file);
    if (!exists(target)) {
      violations.push({ rule: 'A-01', file: spec.file, detail: 'protected file missing' });
      continue;
    }
    const text = read(target);
    for (const expectation of spec.must ?? []) {
      if (!expectation.pattern.test(text)) {
        violations.push({ rule: 'A-01', file: spec.file, detail: `lost ${expectation.detail}` });
      }
    }
    for (const expectation of spec.mustNot ?? []) {
      if (expectation.pattern.test(text)) {
        violations.push({ rule: 'A-01', file: spec.file, detail: `gained ${expectation.detail}` });
      }
    }
  }

  /* A-02 - no retired framework runtime in the ported source. */
  for (const file of sourceFiles) {
    const text = read(file);
    for (const { pattern, detail } of FORBIDDEN_MODULE_PATTERNS) {
      if (pattern.test(text)) violations.push({ rule: 'A-02', file: rel(frontendRoot, file), detail });
    }
    if (FORBIDDEN_BARE_PATH.test(text)) {
      violations.push({ rule: 'A-02', file: rel(frontendRoot, file), detail: 'retired framework module path literal' });
    }
    if (DIRECTIVE_PROLOGUE.test(text)) {
      violations.push({ rule: 'A-02', file: rel(frontendRoot, file), detail: 'framework server/client directive' });
    }
  }

  /* A-03 - the frontend owns no server route surface. */
  const rootLevelServerFiles = ['middleware.ts', 'middleware.tsx', 'middleware.js', 'middleware.mjs'];
  for (const file of sourceFiles) {
    const relative = rel(frontendRoot, file);
    const underServerRoot = SERVER_ROUTE_ROOTS.some((prefix) => relative.startsWith(prefix));
    if (underServerRoot || (relative.startsWith('src/') && SERVER_ROUTE_FILE.test(path.basename(file)))) {
      violations.push({ rule: 'A-03', file: relative, detail: 'server route surface in frontend' });
    }
    if (/\bNext(?:Request|Response)\b/.test(read(file))) {
      violations.push({ rule: 'A-03', file: relative, detail: 'framework server request/response type' });
    }
  }
  for (const file of rootLevelServerFiles) {
    if (exists(path.join(frontendRoot, file))) {
      violations.push({ rule: 'A-03', file, detail: 'server route surface in frontend' });
    }
  }

  /* A-04 - no browser-direct Go origin; the SPA always talks through its own origin. */
  const originFiles = [...sourceFiles, path.join(frontendRoot, 'index.html')].filter(exists);
  for (const file of originFiles) {
    const text = read(file);
    if (BROWSER_DIRECT_ORIGIN.test(text)) {
      violations.push({ rule: 'A-04', file: rel(frontendRoot, file), detail: 'browser-direct backend origin' });
    }
  }

  /* A-05 - retired approval/audit consoles stay retired. */
  const routeFiles = sourceFiles.filter((file) => /\/(?:router|lib)\//.test(rel(frontendRoot, file)));
  for (const file of routeFiles) {
    const text = read(file);
    for (const match of text.matchAll(/route:\s*['"]([^'"]+)['"]/g)) {
      const declared = match[1];
      if (RETIRED_ROUTE_PREFIXES.some((prefix) => declared === prefix || declared.startsWith(`${prefix}/`))) {
        violations.push({ rule: 'A-05', file: rel(frontendRoot, file), detail: `retired route ${declared}` });
      }
    }
  }

  return violations;
}

/* -------------------------------------------------------------- self test -- */

const FIXTURE_PROTECTED_FILES = [
  'package.json', 'vite.config.ts', 'index.html',
  'src/main.tsx', 'src/app/App.tsx', 'src/router/router.tsx', 'src/lib/navigation.ts',
];

const FIXTURES = [
  { rule: 'A-01', label: 'protected entry file replaced', file: 'src/main.tsx', content: 'export default function main() {}\n' },
  { rule: 'A-02', label: 'framework router import', file: 'src/features/example/Example.tsx', content: "import Link from 'next/link';\nexport const Example = () => <Link href=\"/x\">x</Link>;\n" },
  { rule: 'A-02', label: 'framework client directive prologue', file: 'src/features/example/Directive.tsx', content: "'use client';\n\nexport const Directive = () => null;\n" },
  { rule: 'A-02', label: 'framework module path in a porting note', file: 'src/features/example/Note.tsx', content: "/* Ported: next/link became the router link. */\nexport const Note = () => null;\n" },
  { rule: 'A-03', label: 'node route handler', file: 'src/api/route.ts', content: "export async function GET() { return new Response('ok'); }\n" },
  { rule: 'A-04', label: 'browser-direct backend origin', file: 'src/lib/direct.ts', content: "export const BASE = 'http://127.0.0.1:18888/api';\n" },
  { rule: 'A-05', label: 'retired approval route', file: 'src/lib/navigation.ts', content: "export const APP_ROUTES = [\n  { route: '/approvals', targetRoute: '/approvals' },\n];\nexport const hasNavigationPermission = () => true;\n" },
];

function buildFixture(root, injection) {
  for (const file of FIXTURE_PROTECTED_FILES) {
    const source = path.join(FRONTEND, file);
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  if (injection) {
    const target = path.join(root, injection.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, injection.content);
  }
}

function selfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-forward-port-boundary-'));
  const results = [];
  try {
    /* The untouched mirror must be clean, otherwise the fixtures prove nothing. */
    const cleanRoot = path.join(tempRoot, 'clean');
    buildFixture(cleanRoot, null);
    const cleanViolations = scanFrontend(cleanRoot);
    results.push({
      label: 'clean mirror reports no violation',
      ok: cleanViolations.length === 0,
      detail: cleanViolations.map((item) => `${item.rule}:${item.file}`).join(',') || 'clean',
    });

    for (const [index, fixture] of FIXTURES.entries()) {
      const fixtureRoot = path.join(tempRoot, `fixture-${index}-${fixture.rule}`);
      buildFixture(fixtureRoot, fixture);
      const violations = scanFrontend(fixtureRoot);
      const hit = violations.some((item) => item.rule === fixture.rule);
      results.push({
        label: `${fixture.rule} detects ${fixture.label}`,
        ok: hit,
        detail: hit ? 'detected' : `not detected (saw ${violations.map((item) => item.rule).join(',') || 'nothing'})`,
      });
    }
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed++;
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label} :: ${result.detail}`);
  }
  console.log(`ui_forward_port_boundary_selftest=${failed === 0 ? 'PASS' : 'FAIL'}`);
  return failed;
}

const isSelfTest = process.argv.slice(2).includes('--self-test');

if (isSelfTest) {
  process.exit(selfTest() === 0 ? 0 : 1);
}

console.log('==================================================');
console.log('UI forward-port boundary gate');
console.log(`frontend: ${FRONTEND}`);
console.log('--------------------------------------------------');

const violations = scanFrontend(FRONTEND);
const byRule = new Map();
for (const violation of violations) {
  if (!byRule.has(violation.rule)) byRule.set(violation.rule, []);
  byRule.get(violation.rule).push(violation);
}

const RULES = [
  ['A-01', 'protected Vite / React Router runtime files intact'],
  ['A-02', 'no retired framework runtime import'],
  ['A-03', 'frontend owns no server route surface'],
  ['A-04', 'no browser-direct backend origin'],
  ['A-05', 'retired approval/audit consoles stay retired'],
];

let failed = 0;
for (const [rule, label] of RULES) {
  const hits = byRule.get(rule) ?? [];
  if (hits.length) failed++;
  const detail = hits.length ? `${hits.length} violation(s): ${hits.slice(0, 3).map((hit) => `${hit.file} (${hit.detail})`).join('; ')}` : 'clean';
  console.log(`${hits.length ? 'FAIL' : 'PASS'}  ${rule} ${label} :: ${detail}`);
}

/* The gate must be able to fail; verify that before trusting a green result. */
const selfTestFailures = selfTest();
if (selfTestFailures) failed++;

console.log('--------------------------------------------------');
console.log(`ui_forward_port_boundary_violations=${violations.length}`);
console.log(`ui_forward_port_boundary_result=${failed === 0 ? 'PASS' : 'FAIL'}`);
console.log('==================================================');
process.exit(failed === 0 ? 0 : 1);
