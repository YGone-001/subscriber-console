/**
 * Canonical Go API route authority.
 *
 * The Go router registration site is the single source of truth for which METHOD+PATH
 * operations exist. Every consumer derives the production API surface from Go source; no
 * route-owner table is consulted.
 *
 * Nothing here is hard-coded: the set is always parsed out of the Go registration site.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Go files that contain `mux.Handle("METHOD /path", ...)` registrations. */
export const GO_ROUTER_SOURCES = [
  'backend/cmd/server/main.go',
  'backend/internal/remediation/handler.go',
];

const REGISTRATION_RE = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"\s*,/g;

/**
 * Parse every `mux.Handle` registration out of a single Go router source text.
 *
 * Exposed so historical-comparison consumers (for example the production-architecture
 * certification, which derives the baseline set from `git show <sha>:<file>`) share
 * exactly one registration parser instead of maintaining a second copy.
 *
 * @param {string} text raw Go source
 * @returns {string[]} `METHOD /path` keys in source order
 */
export function parseRegistrationKeys(text) {
  const keys = [];
  let match;
  REGISTRATION_RE.lastIndex = 0;
  while ((match = REGISTRATION_RE.exec(text)) !== null) {
    keys.push(`${match[1]} ${match[2]}`);
  }
  return keys;
}

/**
 * Parse every `mux.Handle` registration out of the Go router sources.
 * @returns {{ keys: string[], perSource: Record<string, string[]>, duplicates: string[] }}
 */
export function deriveGoRegistrations(rootDir = REPO_ROOT) {
  const perSource = {};
  const seen = new Set();
  const duplicates = [];

  for (const relativePath of GO_ROUTER_SOURCES) {
    const file = path.join(rootDir, relativePath);
    if (!existsSync(file)) {
      perSource[relativePath] = [];
      continue;
    }
    const found = parseRegistrationKeys(readFileSync(file, 'utf8'));
    for (const key of found) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    perSource[relativePath] = found;
  }

  return { keys: [...seen].sort(), perSource, duplicates };
}

/** Go operations that are semantic reads even though they use POST. */
export const SEMANTIC_READ_POST = new Set([
  'POST /api/subscribers/batch/precheck',
  'POST /api/system/audit/scan',
  'POST /api/analytics/init',
]);

/** Split the Go registration set into read vs mutation operations. */
export function classifyGoRegistrations(keys) {
  const reads = keys.filter((key) => key.startsWith('GET ') || SEMANTIC_READ_POST.has(key));
  const mutations = keys.filter((key) => !reads.includes(key));
  return { reads, mutations };
}

/** Convert a Go `{param}` path to the inventory-style `:param` form. */
export function toInventoryPath(pattern) {
  return pattern.replace(/\{(\w+)\}/g, ':$1');
}
