#!/usr/bin/env node
// Sync the shared body of AGENTS.md and CLAUDE.md.
//
// The two agent instruction files carry byte-identical bodies; only the declared
// header block (audience / counterpart file) differs. Edit either file, then run
// this script to propagate the body to the other one, preserving its header.
//
// Usage:
//   node scripts/sync-agent-docs.mjs              # AGENTS.md -> CLAUDE.md
//   node scripts/sync-agent-docs.mjs CLAUDE.md    # CLAUDE.md -> AGENTS.md
//
// Verify afterwards with: npm run check:agent-docs-parity

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADER_END = '<!-- PARITY-HEADER-END -->';
const PAIR = ['AGENTS.md', 'CLAUDE.md'];

const sourceName = process.argv[2] || 'AGENTS.md';

if (!PAIR.includes(sourceName)) {
  console.error(`Unknown source "${sourceName}". Expected one of: ${PAIR.join(', ')}`);
  process.exit(1);
}

const targetName = PAIR.find((f) => f !== sourceName);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function split(text, rel) {
  const idx = text.indexOf(HEADER_END);
  if (idx === -1) {
    console.error(`${rel}: missing ${HEADER_END} marker`);
    process.exit(1);
  }
  return { header: text.slice(0, idx), body: text.slice(idx + HEADER_END.length) };
}

const source = split(read(sourceName), sourceName);
const target = split(read(targetName), targetName);

if (source.body === target.body) {
  console.log(`Already in sync: ${sourceName} and ${targetName} bodies are identical.`);
  process.exit(0);
}

fs.writeFileSync(path.join(ROOT, targetName), target.header + HEADER_END + source.body);
console.log(`Synced body: ${sourceName} -> ${targetName} (header preserved).`);
console.log(`Verify with: npm run check:agent-docs-parity`);
