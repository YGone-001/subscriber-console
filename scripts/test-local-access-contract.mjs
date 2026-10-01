#!/usr/bin/env node
/**
 * Local Access Contract Gate.
 *
 * Permanent, phase-neutral acceptance suite that derives the local full-stack access
 * contract from source and fails closed. It proves:
 *
 *   - the Next.js production and development listeners bind loopback 127.0.0.1:13333;
 *   - Next.js owns no /api rewrite, no /api route handler and no API reverse proxy;
 *   - the repository Nginx config still routes /api and /api/* to Go and / to Next.js;
 *   - README, deployment.md, AGENTS.md and CLAUDE.md document the Nginx edge as the
 *     only full-stack browser entry and never instruct users to browse to :13333;
 *   - the local stack doctor exists and is wired to the root npm script.
 *
 * It is pure source analysis: no network, no MongoDB, no build step.
 *
 * Usage: node scripts/test-local-access-contract.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).replaceAll('\\', '/');

const read = (p) => readFileSync(p, 'utf8');

const NEXT_INTERNAL_HOST = '127.0.0.1';
const NEXT_INTERNAL_PORT = '13333';
const GO_INTERNAL_HOST = '127.0.0.1';
const GO_INTERNAL_PORT = '18888';

const frontendPackagePath = resolve(root, 'frontend/package.json');
const nextConfigPath = resolve(root, 'frontend/next.config.ts');
const nextAppApiRoot = resolve(root, 'frontend/src/app/api');
const frontendSrcRoot = resolve(root, 'frontend/src');
const nginxConfPath = resolve(root, 'deploy/nginx/xcloud.conf');
const readmePath = resolve(root, 'README.md');
const deploymentPath = resolve(root, 'docs/operations/deployment.md');
const agentsPath = resolve(root, 'AGENTS.md');
const claudePath = resolve(root, 'CLAUDE.md');
const doctorPath = resolve(root, 'scripts/check-local-stack.mjs');
const rootPackagePath = resolve(root, 'package.json');

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Blank `//` and block comments while preserving line count. */
function stripComments(source) {
  const out = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let i = 0;
    let built = '';
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end === -1) {
          i = raw.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (raw.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (raw.startsWith('//', i) && (i === 0 || raw[i - 1] !== ':')) break;
      built += raw[i];
      i += 1;
    }
    out.push(built);
  }
  return out.join('\n');
}

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

/**
 * A browser instruction that presents the internal Next.js origin as the normal
 * application URL. A prohibition ("do not open ... :13333") is explicitly allowed.
 */
const DIRECT_NEXT_ACTION_RE = /\b(?:open|browse|visit|navigate|go to|access|point|use)\b/i;
const PROHIBITION_RE = /\b(?:do not|don't|never|avoid|not\s+supported|unsupported|intentionally|instead)\b/i;

export function directNextBrowserInstructions(text) {
  const violations = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hasLocalhost = /localhost:13333/.test(line);
    const hasLoopback = /127\.0\.0\.1:13333/.test(line);
    if (!hasLocalhost && !hasLoopback) continue;
    if (PROHIBITION_RE.test(line)) continue;
    // localhost:13333 must never appear as an entry; a bare loopback mention is only
    // a violation when it is paired with a browse action.
    if (hasLocalhost || DIRECT_NEXT_ACTION_RE.test(line)) {
      violations.push({ line: i + 1, text: line.trim() });
    }
  }
  return violations;
}

export function rewriteApiOwnershipCount(configCode) {
  const rewrites = (configCode.match(/rewrites\s*\(/g) || []).length;
  return rewrites > 0 && /\/api/.test(configCode) ? rewrites : 0;
}

const REVERSE_PROXY_RES = [
  /\bforwardToGo\s*\(/,
  /\bproxyToBackend\b/,
  /\bNextResponse\.rewrite\s*\(/,
  /\bcreateProxyHandler\s*\(/,
];

export function apiReverseProxyFunctions(sources) {
  let hits = 0;
  for (const code of sources) {
    for (const re of REVERSE_PROXY_RES) {
      if (re.test(code)) hits += 1;
    }
  }
  return hits;
}

/** Extract the body of a `location <spec> { ... }` block from an Nginx config. */
function locationBlock(config, specRe) {
  const lines = config.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!specRe.test(lines[i])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*\}\s*$/.test(lines[j])) return body.join('\n');
      body.push(lines[j]);
    }
  }
  return null;
}

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
}

function main() {
  console.log('-- Local access contract (Nginx edge is the only full-stack browser entry) --\n');

  // L1 / L2 - Next.js listeners --------------------------------------------------------
  const frontendPkg = existsSync(frontendPackagePath)
    ? JSON.parse(read(frontendPackagePath))
    : { scripts: {} };
  const startCmd = frontendPkg.scripts?.start ?? '';
  const devCmd = frontendPkg.scripts?.dev ?? '';
  const listenerRe = /-H\s+(\S+)\s+-p\s+(\d+)/;
  const startMatch = startCmd.match(listenerRe);
  const devMatch = devCmd.match(listenerRe);
  const startListener = startMatch ? `${startMatch[1]}:${startMatch[2]}` : null;
  const devListener = devMatch ? `${devMatch[1]}:${devMatch[2]}` : null;
  const expectedListener = `${NEXT_INTERNAL_HOST}:${NEXT_INTERNAL_PORT}`;

  check('L1', startListener === expectedListener, `next_start_listener=${startListener}`);
  check('L2', devListener === expectedListener, `next_dev_listener=${devListener}`);

  // L3 - no /api rewrites --------------------------------------------------------------
  const nextConfigCode = existsSync(nextConfigPath) ? stripComments(read(nextConfigPath)) : '';
  const nextApiRewrites = rewriteApiOwnershipCount(nextConfigCode);
  check('L3', nextApiRewrites === 0, `next_api_rewrites=${nextApiRewrites}`);

  // L4 - no Next API route files -------------------------------------------------------
  const nextApiRouteFiles = walk(nextAppApiRoot, (p) => /route\.(ts|js)$/.test(p)).length;
  check('L4', nextApiRouteFiles === 0, `next_api_route_files=${nextApiRouteFiles}`);

  // L5 - no Next API reverse proxy -----------------------------------------------------
  const srcSources = walk(frontendSrcRoot, (p) => CODE_EXT.test(p)).map((p) => stripComments(read(p)));
  const nextApiReverseProxy = apiReverseProxyFunctions(srcSources);
  check('L5', nextApiReverseProxy === 0, `next_api_reverse_proxy=${nextApiReverseProxy}`);

  // L6 - Nginx API ownership unchanged -------------------------------------------------
  const nginx = existsSync(nginxConfPath) ? read(nginxConfPath) : '';
  const apiExact = locationBlock(nginx, /^\s*location\s+=\s*\/api\s*\{/);
  const apiPrefix = locationBlock(nginx, /^\s*location\s+\/api\/\s*\{/);
  const uiRoot = locationBlock(nginx, /^\s*location\s+\/\s*\{/);
  const apiToGo = Boolean(apiExact && /proxy_pass\s+http:\/\/xcloud_go\b/.test(apiExact));
  const apiPrefixToGo = Boolean(apiPrefix && /proxy_pass\s+http:\/\/xcloud_go\b/.test(apiPrefix));
  const uiToNext = Boolean(uiRoot && /proxy_pass\s+http:\/\/xcloud_next\b/.test(uiRoot));
  const nginxUpstreams = /upstream\s+xcloud_go\s*\{\s*server\s+127\.0\.0\.1:18888\b/.test(nginx) &&
    /upstream\s+xcloud_next\s*\{\s*server\s+127\.0\.0\.1:13333\b/.test(nginx);
  check(
    'L6',
    apiToGo && apiPrefixToGo && uiToNext && nginxUpstreams,
    `nginx_api_go=${apiToGo && apiPrefixToGo} nginx_ui_next=${uiToNext} nginx_upstreams=${nginxUpstreams}`,
  );

  // L7 - README full-stack URL ---------------------------------------------------------
  const readme = existsSync(readmePath) ? read(readmePath) : '';
  const readmeViolations = directNextBrowserInstructions(readme);
  const readmeIdentifiesEdge = /http:\/\/localhost/.test(readme) && /Nginx/i.test(readme);
  check('L7', readmeViolations.length === 0 && readmeIdentifiesEdge,
    `readme_direct_next_instructions=${readmeViolations.length} readme_identifies_edge=${readmeIdentifiesEdge}`);

  // L8 - deployment development topology ----------------------------------------------
  const deployment = existsSync(deploymentPath) ? read(deploymentPath) : '';
  const deploymentRequiresEdge = deployment.includes('Local Full-Stack Development') &&
    deployment.includes('local:doctor') && /Nginx/.test(deployment);
  check('L8', deploymentRequiresEdge, `deployment_requires_edge=${deploymentRequiresEdge}`);

  // L9 - agent guidance ---------------------------------------------------------------
  const agents = existsSync(agentsPath) ? read(agentsPath) : '';
  const claude = existsSync(claudePath) ? read(claudePath) : '';
  const agentsContract = /Local Full-Stack Access Contract/.test(agents);
  const claudeContract = /Local Full-Stack Access Contract/.test(claude);
  check('L9', agentsContract && claudeContract, `agents_contract=${agentsContract} claude_contract=${claudeContract}`);

  // L10 - doctor exists ---------------------------------------------------------------
  const doctorPresent = existsSync(doctorPath);
  const rootPkg = existsSync(rootPackagePath) ? JSON.parse(read(rootPackagePath)) : { scripts: {} };
  const doctorScript = rootPkg.scripts?.['local:doctor'] === 'node scripts/check-local-stack.mjs';
  check('L10', doctorPresent && doctorScript, `doctor_present=${doctorPresent} doctor_npm_script=${doctorScript}`);

  // L11 - in-memory negative sentinel -------------------------------------------------
  const syntheticBadReadme = '## Quick Start\n\nOpen http://localhost:13333 to use the application.\n';
  const syntheticBadConfig = 'export default { async rewrites() { return [{ source: "/api/:p*", destination: "http://127.0.0.1:18888/api/:p*" }]; } };\n';
  const sentinelReadmeDetected = directNextBrowserInstructions(syntheticBadReadme).length > 0;
  const sentinelRewriteDetected = rewriteApiOwnershipCount(syntheticBadConfig) > 0;
  const sentinelProxyDetected = apiReverseProxyFunctions(['const x = forwardToGo(request);']) > 0;
  const negativeSentinel = sentinelReadmeDetected && sentinelRewriteDetected && sentinelProxyDetected;
  check('L11', negativeSentinel,
    `sentinel_readme=${sentinelReadmeDetected} sentinel_rewrite=${sentinelRewriteDetected} sentinel_proxy=${sentinelProxyDetected}`);

  console.log('Invariants:');
  for (const inv of invariants) console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id} ${inv.detail}`);

  if (readmeViolations.length) {
    console.log('\n-- README direct Next.js browser instructions --');
    for (const v of readmeViolations) console.log(`  ${rel(readmePath)}:${v.line} ${v.text}`);
  }

  const failures = invariants.filter((i) => !i.ok);

  console.log('\n==================================================');
  console.log('local_access_public_owner=nginx');
  console.log('');
  console.log(`local_access_next_internal_host=${NEXT_INTERNAL_HOST}`);
  console.log(`local_access_next_internal_port=${NEXT_INTERNAL_PORT}`);
  console.log('');
  console.log(`local_access_go_internal_host=${GO_INTERNAL_HOST}`);
  console.log(`local_access_go_internal_port=${GO_INTERNAL_PORT}`);
  console.log('');
  console.log(`local_access_next_api_routes=${nextApiRouteFiles}`);
  console.log(`local_access_next_api_rewrites=${nextApiRewrites}`);
  console.log(`local_access_next_api_reverse_proxy=${nextApiReverseProxy}`);
  console.log('');
  console.log(`local_access_nginx_api_owner=${apiToGo && apiPrefixToGo ? 'go' : 'unknown'}`);
  console.log(`local_access_nginx_ui_owner=${uiToNext ? 'next' : 'unknown'}`);
  console.log('');
  console.log(`local_access_readme_direct_next_browser_instruction=${readmeViolations.length}`);
  console.log(`local_access_deployment_requires_edge=${deploymentRequiresEdge}`);
  console.log(`local_access_agents_contract=${agentsContract}`);
  console.log(`local_access_claude_contract=${claudeContract}`);
  console.log('');
  console.log(`local_access_doctor_present=${doctorPresent}`);
  console.log(`local_access_doctor_npm_script=${doctorScript}`);
  console.log('');
  console.log(`local_access_negative_sentinel=${negativeSentinel}`);
  console.log('');
  console.log(`local_access_contract_failures=${failures.length}`);
  console.log(`local_access_contract_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================\n');

  if (failures.length > 0) {
    console.error('Local access contract verification FAILED.');
    process.exit(1);
  }
  console.log('Local access contract verification result: PASS');
}

main();
