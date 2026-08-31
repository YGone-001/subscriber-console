#!/usr/bin/env node
/**
 * API Route Inventory Scanner
 *
 * Scans src/app/api (recursively) for route.ts and extracts exported HTTP methods.
 * Outputs a stable, sorted JSON to docs/backend-migration/generated/api-routes.json
 *
 * Usage: node scripts/migration/inventory-api.mjs
 *
 * Zero external dependencies — uses only Node.js built-ins.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const API_ROOT = join(import.meta.dirname, '..', '..', 'src', 'app', 'api');
const OUTPUT_DIR = join(import.meta.dirname, '..', '..', 'docs', 'backend-migration', 'generated');
const OUTPUT_FILE = join(OUTPUT_DIR, 'api-routes.json');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

/**
 * Recursively find all route.ts files under the given directory.
 */
async function findRouteFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findRouteFiles(fullPath)));
    } else if (entry.name === 'route.ts' || entry.name === 'route.js') {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract exported HTTP method names from a route file.
 * Looks for: export async function GET(...)
 *            export const POST = ...
 *            export { GET, POST }
 *            export async function GET { ... }
 */
async function extractMethods(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const methods = [];

  // Pattern 1: export async function METHOD( or export function METHOD(
  // Pattern 2: export const METHOD =
  // Pattern 3: export { METHOD, ... } (re-exports)
  const patterns = [
    // export async function GET(
    /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g,
    // export function GET(
    /export\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g,
    // export const GET =
    /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const method = match[1];
      if (!methods.includes(method)) {
        methods.push(method);
      }
    }
  }

  // Pattern 3: export { ... } — handle named re-exports
  const reExportPattern = /export\s*\{([^}]+)\}/g;
  let reMatch;
  while ((reMatch = reExportPattern.exec(content)) !== null) {
    const names = reMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      if (HTTP_METHODS.includes(name) && !methods.includes(name)) {
        methods.push(name);
      }
    }
  }

  return methods.sort();
}

/**
 * Convert a filesystem path to an API route path.
 * src/app/api/subscribers/[imsi]/route.ts → /api/subscribers/:imsi
 */
function filePathToApiPath(filePath) {
  const relativePath = relative(API_ROOT, filePath);
  // Remove the route.ts filename
  const dirParts = relativePath.split(sep).slice(0, -1);
  // Convert [param] to :param and [...param] to :param*
  const converted = dirParts.map(part => {
    if (part.startsWith('[...') && part.endsWith(']')) {
      return ':' + part.slice(4, -1) + '*';
    }
    if (part.startsWith('[') && part.endsWith(']')) {
      return ':' + part.slice(1, -1);
    }
    return part;
  });
  return '/api/' + converted.join('/');
}

/**
 * Derive the domain from the top-level directory.
 */
function deriveDomain(apiPath) {
  const parts = apiPath.split('/').filter(Boolean);
  // /api/subscribers/... → subscribers
  // /api/auth/... → auth
  // /api/system/audit/... → system
  if (parts.length >= 2) {
    return parts[1]; // first segment after "api"
  }
  return 'unknown';
}

async function main() {
  console.log('Scanning API routes...');
  const routeFiles = await findRouteFiles(API_ROOT);
  console.log(`Found ${routeFiles.length} route files.`);

  const routes = [];

  for (const filePath of routeFiles.sort()) {
    const methods = await extractMethods(filePath);
    const apiPath = filePathToApiPath(filePath);
    const domain = deriveDomain(apiPath);
    const relativeFile = relative(join(import.meta.dirname, '..', '..'), filePath);

    routes.push({
      path: apiPath,
      domain,
      methods,
      file: relativeFile,
    });
  }

  // Sort by path for stable output
  routes.sort((a, b) => a.path.localeCompare(b.path));

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(routes, null, 2) + '\n', 'utf-8');

  // Summary
  const totalOps = routes.reduce((sum, r) => sum + r.methods.length, 0);
  const methodCounts = {};
  for (const r of routes) {
    for (const m of r.methods) {
      methodCounts[m] = (methodCounts[m] || 0) + 1;
    }
  }

  console.log(`\nAPI Route Inventory Summary`);
  console.log(`==========================`);
  console.log(`Route files: ${routes.length}`);
  console.log(`Total operations: ${totalOps}`);
  for (const m of HTTP_METHODS) {
    if (methodCounts[m]) {
      console.log(`  ${m}: ${methodCounts[m]}`);
    }
  }
  console.log(`\nOutput: ${OUTPUT_FILE}`);

  // Also print domain breakdown
  const domainCounts = {};
  for (const r of routes) {
    if (!domainCounts[r.domain]) domainCounts[r.domain] = { routes: 0, ops: 0 };
    domainCounts[r.domain].routes++;
    domainCounts[r.domain].ops += r.methods.length;
  }
  console.log(`\nBy Domain:`);
  for (const [domain, counts] of Object.entries(domainCounts).sort()) {
    console.log(`  ${domain}: ${counts.routes} routes, ${counts.ops} operations`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
