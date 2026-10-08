#!/usr/bin/env node
/*
 * One-off forward-port helper.
 *
 * Copies a historical file into the current checkout and rewrites every module
 * specifier to a path that is correct from the destination's depth. Alias
 * rewriting by string prefix is not enough: `@/components/I18nProvider` and
 * `@/components/ui/Dialog` land in different target directories, and a bare
 * `./X.module.css` has to become a path into `styles/modules/`.
 *
 * Usage: node scripts/forward-port.mjs <spec.json>
 * The spec is a JSON array of { source, target, header } entries where source and
 * target are paths relative to the two checkouts' `frontend/` directories.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, resolveReferenceRoot } from './lib/project-paths.mjs';

const [specPath] = process.argv.slice(2);
if (!specPath) {
  console.error('forward-port: no spec file given');
  process.exit(2);
}

/*
 * The reference is an external checkout resolved from an override or a project-relative
 * sibling; the project root comes from the repository layout. No absolute path is
 * embedded, so the tool runs from any checkout on any platform.
 */
const REFERENCE = resolveReferenceRoot({ env: 'FORWARD_PORT_REFERENCE' });
const PROJECT = process.env.FORWARD_PORT_PROJECT || PROJECT_ROOT;
const REF_SRC = path.join(REFERENCE, 'frontend', 'src');
const CUR_SRC = path.join(PROJECT, 'frontend', 'src');

/** Where an alias points inside the current `src` tree. */
function aliasTarget(specifier) {
  if (specifier.startsWith('@/components/')) {
    const rest = specifier.slice('@/components/'.length);
    if (rest === 'I18nProvider') return 'providers/I18nProvider';
    if (rest === 'OperationFeedback') return 'components/ui/OperationFeedback';
    return `components/${rest}`;
  }
  if (specifier.startsWith('@/lib/')) return specifier.slice('@/'.length);
  if (specifier.startsWith('@/types/')) return specifier.slice('@/'.length);
  if (specifier.startsWith('@/hooks/')) return `providers/${specifier.slice('@/hooks/'.length)}`;
  return null;
}

const stripExtension = (value) => value.replace(/\.(tsx|ts)$/, '');

function rewriteSpecifier(specifier, targetRel) {
  const targetDir = path.dirname(path.join(CUR_SRC, targetRel));

  if (specifier.startsWith('@/')) {
    const resolved = aliasTarget(specifier);
    if (!resolved) throw new Error(`unmapped alias ${specifier}`);
    const absolute = path.join(CUR_SRC, resolved);
    let relative = path.relative(targetDir, absolute).replace(/\\/g, '/');
    if (!relative.startsWith('.')) relative = `./${relative}`;
    return relative;
  }

  if (specifier.startsWith('.')) {
    const base = path.basename(specifier);
    if (base.endsWith('.module.css') || base.endsWith('.css')) {
      const absolute = path.join(CUR_SRC, 'styles', 'modules', base);
      let relative = path.relative(targetDir, absolute).replace(/\\/g, '/');
      if (!relative.startsWith('.')) relative = `./${relative}`;
      return relative;
    }
  }

  return specifier;
}

function rewrite(source, targetRel, header) {
  let text = source;
  text = text.replace(/^"use client";\r?\n\r?\n?/, '');
  text = text.replace(/(from\s+)['"]([^'"]+)['"]/g, (match, prefix, specifier) => {
    if (!specifier.startsWith('@/') && !specifier.startsWith('.')) return match;
    return `${prefix}'${stripExtension(rewriteSpecifier(specifier, targetRel))}'`;
  });
  /* Drop a local stylesheet import: the layers are loaded from app.css already. */
  text = text.replace(/^import\s+['"]\.\.?\/[^'"]+\.css['"];\r?\n/m, '');
  return `${header}${text}`;
}

const entries = JSON.parse(fs.readFileSync(specPath, 'utf8'));
for (const entry of entries) {
  const source = fs.readFileSync(path.join(REF_SRC, entry.source), 'utf8');
  const note = entry.note ?? 'Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.';
  const header = `/*\n * Forward-ported from the historical xCloud UI (reference commit 2c40903):\n * frontend/src/${entry.source}\n${note.split('\n').map((line) => ` * ${line}`).join('\n')}\n */\n`;
  const destination = path.join(CUR_SRC, entry.target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, rewrite(source, entry.target, header));
  console.log(`ported ${entry.source} -> ${entry.target}`);
}
