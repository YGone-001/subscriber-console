#!/usr/bin/env node
// Agent documentation parity gate.
//
// AGENTS.md (generic agent) and CLAUDE.md (Claude Code) must carry byte-identical
// bodies. Only the declared header block (audience / counterpart file) may differ.
// This gate makes cross-file rule drift impossible by construction: the two files
// cannot state different rules, ownership, or architecture facts.
//
// It also cross-checks every registration count stated in the documents against the
// count derived from the Go registration sources, so a stale number cannot survive
// in either file.
//
// Run with: npm run check:agent-docs-parity

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADER_END = '<!-- PARITY-HEADER-END -->';
const PAIR = ['AGENTS.md', 'CLAUDE.md'];

const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function splitBody(rel) {
  const text = read(rel);
  const idx = text.indexOf(HEADER_END);
  if (idx === -1) {
    failures.push(`${rel}: missing ${HEADER_END} marker`);
    return null;
  }
  return { header: text.slice(0, idx), body: text.slice(idx + HEADER_END.length) };
}

const parts = PAIR.map(splitBody);

// 1. Declared header block must be present and must differ (audience declaration).
if (parts.every(Boolean)) {
  const [a, b] = parts;
  if (a.header === b.header) {
    failures.push('header blocks are identical; each file must declare its own audience and counterpart');
  }
  for (const rel of PAIR) {
    const text = read(rel);
    if (!text.includes('<!-- PARITY-HEADER-BEGIN -->')) {
      failures.push(`${rel}: missing <!-- PARITY-HEADER-BEGIN --> marker`);
    }
  }

  // 2. Bodies must be byte-identical.
  if (a.body !== b.body) {
    const al = a.body.split('\n');
    const bl = b.body.split('\n');
    const diffs = [];
    const max = Math.max(al.length, bl.length);
    for (let i = 0; i < max && diffs.length < 10; i += 1) {
      if (al[i] !== bl[i]) {
        diffs.push(`  line ${i + 1}: AGENTS=${JSON.stringify(al[i])} CLAUDE=${JSON.stringify(bl[i])}`);
      }
    }
    failures.push(`bodies differ between ${PAIR[0]} and ${PAIR[1]}:\n${diffs.join('\n')}`);
  } else {
    console.log(`[ok] ${PAIR[0]} and ${PAIR[1]} bodies are byte-identical (${a.body.length} chars)`);
  }
}

// 3. Every stated registration count must equal the source-derived count.
const derived = deriveGoRegistrations().keys.length;
console.log(`[info] derived Go registration count = ${derived}`);

const COUNT_PATTERNS = [
  /共\s*\*{0,2}\s*(\d+)\s*条\s*\*{0,2}\s*Go\s*注册/g,
  /(\d+)\s*exact METHOD\+PATH registrations/g,
];
for (const rel of PAIR) {
  const text = read(rel);
  let seen = 0;
  let mismatch = false;
  for (const re of COUNT_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      seen += 1;
      const stated = Number(match[1]);
      if (stated !== derived) {
        mismatch = true;
        failures.push(`${rel}: states "${stated}" registrations but source derives ${derived} (match: "${match[0]}")`);
      }
    }
  }
  if (seen === 0) {
    failures.push(`${rel}: no total registration count statement found (expected the source-derived count)`);
  } else if (!mismatch) {
    console.log(`[ok] ${rel}: ${seen} total registration count statement(s) all match ${derived}`);
  }
}

// 4. Required architecture sentinels must survive in both files.
const SENTINELS = [
  'Nginx',
  '127.0.0.1:18888',
  '13333',
  'embedded static React SPA',
  'Route authority',
  'the derived Go registration set',
  'Best-effort / non-business-gating operation logging',
  'Never resolve canonical port contamination by changing 13333/18888',
  'Never automatically kill an arbitrary listener',
  'local:preflight',
];
for (const rel of PAIR) {
  const text = read(rel);
  for (const sentinel of SENTINELS) {
    if (!text.includes(sentinel)) {
      failures.push(`${rel}: missing required sentinel "${sentinel}"`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} agent documentation parity violation(s).`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\nPASS: agent documentation parity holds (identical bodies, consistent counts, sentinels present).');
