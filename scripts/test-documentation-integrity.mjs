#!/usr/bin/env node
/**
 * Documentation Integrity Gate.
 *
 * Permanent, phase-neutral acceptance test for the consolidated documentation
 * model: the current tree contains only present-tense documentation, the retired
 * migration-era documentation trees stay removed, every repository-local Markdown
 * link resolves, and no active document or repository instruction points at a
 * deleted documentation tree.
 *
 * It is intentionally NOT a repository-wide content grep. Historical summaries
 * under `docs/archive/**` are exempt from the phase-neutral and deleted-reference
 * checks because they exist precisely to describe the completed migration.
 *
 * Checks:
 *   21.1 removed historical trees stay removed
 *   21.2 required current documentation exists
 *   21.3 Markdown relative links resolve
 *   21.4 active documentation is phase-neutral
 *   21.5 no current reference to a deleted documentation tree
 *
 * Usage: node scripts/test-documentation-integrity.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function relOf(p) {
  return relative(root, p).replaceAll('\\', '/');
}

function read(p) {
  return readFileSync(p, 'utf8');
}

const failures = [];
function fail(message) {
  failures.push(message);
}

// ---------------------------------------------------------------------------
// 21.1 Removed historical trees stay removed
// ---------------------------------------------------------------------------
const DOCS_BACKEND_MIGRATION = 'docs/backend-migration';
const DOCS_ARCHITECTURE = 'docs/architecture';
const DEV_LOG = 'docs/operations/dev-log.md';
const TODO = 'docs/operations/todo.md';

const docsBackendMigrationPresent = existsSync(resolve(root, DOCS_BACKEND_MIGRATION)) ? 1 : 0;

const architectureDir = resolve(root, DOCS_ARCHITECTURE);
const phaseNamedArchitectureFiles = existsSync(architectureDir)
  ? readdirSync(architectureDir).filter((name) => /^phase-.*\.md$/i.test(name))
  : [];
const docsPhaseNamedArchitectureFiles = phaseNamedArchitectureFiles.length;

const docsDevLogPresent = existsSync(resolve(root, DEV_LOG)) ? 1 : 0;
const docsTodoPresent = existsSync(resolve(root, TODO)) ? 1 : 0;

if (docsBackendMigrationPresent) fail(`${DOCS_BACKEND_MIGRATION} still exists`);
if (docsPhaseNamedArchitectureFiles > 0) {
  fail(`${DOCS_ARCHITECTURE}/phase-*.md still exists: ${phaseNamedArchitectureFiles.join(', ')}`);
}
if (docsDevLogPresent) fail(`${DEV_LOG} still exists`);
if (docsTodoPresent) fail(`${TODO} still exists`);

// ---------------------------------------------------------------------------
// 21.2 Required current documentation exists
// ---------------------------------------------------------------------------
const REQUIRED_DOCUMENTS = [
  'docs/README.md',
  'docs/architecture/system-architecture.md',
  'docs/architecture/frontend-backend-boundary.md',
  'docs/architecture/security-model.md',
  'docs/architecture/governance-design.md',
  'docs/operations/deployment.md',
  'docs/operations/authentication-model.md',
  'docs/operations/rbac-model.md',
  'docs/operations/operation-model.md',
  'docs/operations/direct-operation-model.md',
  'docs/operations/ocs-management-runbook.md',
  'docs/archive/backend-migration-summary.md',
];

for (const doc of REQUIRED_DOCUMENTS) {
  if (!existsSync(resolve(root, doc))) fail(`required document missing: ${doc}`);
}

// ---------------------------------------------------------------------------
// Markdown discovery (shared by 21.3 / 21.4 / 21.5)
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'out', 'tmp', 'test-results',
]);
const MARKDOWN_ROOTS = ['docs', 'backend', 'frontend'];
const ROOT_MARKDOWN = ['README.md', 'AGENTS.md', 'CLAUDE.md'];

function collectMarkdown(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectMarkdown(full, out);
    else if (stat.isFile() && extname(entry).toLowerCase() === '.md') out.push(full);
  }
  return out;
}

const markdownFiles = [];
for (const markdownRoot of MARKDOWN_ROOTS) collectMarkdown(resolve(root, markdownRoot), markdownFiles);
for (const name of ROOT_MARKDOWN) {
  const p = resolve(root, name);
  if (existsSync(p)) markdownFiles.push(p);
}
const uniqueMarkdown = [...new Set(markdownFiles)];

function isArchived(rel) {
  return rel === 'docs/archive' || rel.startsWith('docs/archive/');
}

// ---------------------------------------------------------------------------
// 21.3 Markdown relative links resolve
// ---------------------------------------------------------------------------
function stripFencedCode(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

function stripInlineCode(text) {
  return text.replace(/`[^`]*`/g, '');
}

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const brokenLinks = [];

for (const file of uniqueMarkdown) {
  const rel = relOf(file);
  const source = stripInlineCode(stripFencedCode(read(file)));
  const baseDir = dirname(file);
  let match;
  while ((match = LINK_RE.exec(source)) !== null) {
    let target = match[1].trim();
    // Drop an optional Markdown title: (path "title")
    target = target.replace(/\s+["'][^"']*["']\s*$/, '').trim();
    // Drop angle-bracket form: (<path>)
    target = target.replace(/^<|>$/g, '').trim();
    if (!target) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:, etc.
    if (target.startsWith('#')) continue; // pure anchor
    const withoutAnchor = target.split('#')[0].split('?')[0];
    if (!withoutAnchor) continue;
    let decoded = withoutAnchor;
    try {
      decoded = decodeURIComponent(withoutAnchor);
    } catch {
      // Keep the raw form when it is not valid percent-encoding.
    }
    const resolved = resolve(baseDir, decoded);
    if (!existsSync(resolved)) {
      brokenLinks.push({ file: rel, target: withoutAnchor });
    }
  }
}

if (brokenLinks.length > 0) {
  console.error('Broken relative Markdown links:');
  for (const link of brokenLinks) {
    console.error(`  ${link.file} -> ${link.target}`);
  }
  fail(`${brokenLinks.length} broken relative Markdown link(s)`);
}
const documentationBrokenRelativeLinks = brokenLinks.length;

// ---------------------------------------------------------------------------
// 21.4 Active documentation is phase-neutral
// ---------------------------------------------------------------------------
const PHASE_MARKER_RE = /(?:phase|p8)[\s_.-]*[0-9]/i;

const activeDocumentationPhaseMarkers = [];
for (const file of uniqueMarkdown) {
  const rel = relOf(file);
  if (isArchived(rel)) continue;
  const lines = read(file).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(PHASE_MARKER_RE);
    if (match) {
      activeDocumentationPhaseMarkers.push({ file: rel, line: i + 1, match: match[0] });
    }
  }
}

if (activeDocumentationPhaseMarkers.length > 0) {
  console.error('Lifecycle numbering in active documentation:');
  for (const marker of activeDocumentationPhaseMarkers) {
    console.error(`  ${marker.file}:${marker.line} -> ${marker.match}`);
  }
  fail(`${activeDocumentationPhaseMarkers.length} lifecycle marker(s) in active documentation`);
}

// ---------------------------------------------------------------------------
// 21.5 No current reference to a deleted documentation tree
// ---------------------------------------------------------------------------
const DELETED_DOC_REFERENCES = [
  'docs/backend-migration',
  'docs/architecture/phase-',
  'docs/operations/dev-log',
  'docs/operations/todo',
];

const deletedDocumentReferences = [];
for (const file of uniqueMarkdown) {
  const rel = relOf(file);
  if (isArchived(rel)) continue;
  const lines = read(file).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const ref of DELETED_DOC_REFERENCES) {
      if (lines[i].includes(ref)) {
        deletedDocumentReferences.push({ file: rel, line: i + 1, ref });
      }
    }
  }
}

if (deletedDocumentReferences.length > 0) {
  console.error('References to deleted documentation:');
  for (const ref of deletedDocumentReferences) {
    console.error(`  ${ref.file}:${ref.line} -> ${ref.ref}`);
  }
  fail(`${deletedDocumentReferences.length} reference(s) to deleted documentation`);
}

// ---------------------------------------------------------------------------
// Machine-readable summary
// ---------------------------------------------------------------------------
const documentationIntegrityResult = failures.length === 0 ? 'PASS' : 'FAIL';

console.log(`docs_backend_migration_present=${docsBackendMigrationPresent}`);
console.log(`docs_phase_named_architecture_files=${docsPhaseNamedArchitectureFiles}`);
console.log(`docs_dev_log_present=${docsDevLogPresent}`);
console.log(`docs_todo_present=${docsTodoPresent}`);
console.log(`documentation_broken_relative_links=${documentationBrokenRelativeLinks}`);
console.log(`active_documentation_phase_markers=${activeDocumentationPhaseMarkers.length}`);
console.log(`deleted_document_references=${deletedDocumentReferences.length}`);
console.log(`documentation_integrity_result=${documentationIntegrityResult}`);
console.log(`documentation_integrity_failures=${failures.length}`);

if (failures.length > 0) {
  console.error('Documentation integrity failures:');
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log('Documentation integrity: PASS');
