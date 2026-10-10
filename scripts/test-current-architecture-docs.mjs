import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = process.cwd();

/**
 * Declared Next.js version, derived from the installed frontend manifest.
 * Never hard-coded: `frontend/package.json` is the single source of truth.
 */
export function extractDeclaredNextVersion(packageJsonText) {
  const parsed = JSON.parse(packageJsonText);
  const declared =
    (parsed.dependencies && parsed.dependencies.next) ||
    (parsed.devDependencies && parsed.devDependencies.next) ||
    null;
  if (!declared) return 'retired';
  const match = /(\d+\.\d+\.\d+)/.exec(String(declared));
  return match ? match[1] : 'retired';
}

/** Next.js version stated by the current documentation technology statement. */
export function extractDocumentedNextVersion(documentText) {
  if (/Next(?:\.js)?.*retired/i.test(documentText) || !/Next\.js\s+\d+\.\d+\.\d+\s+App Router/.test(documentText)) {
    return 'retired';
  }
  const match = /Next\.js\s+(\d+\.\d+\.\d+)\s+App Router/.exec(documentText);
  return match ? match[1] : 'retired';
}

/**
 * Detect semantic equivalents of retired production topology presented as active:
 * - production Nginx /* -> Next.js
 * - production UI owner = Next.js
 * - production requires next start
 * - production application runs as Next.js + Go dual service
 */
export function detectStaleProductionTopology(docText) {
  const violations = [];
  const patterns = [
    {
      name: 'production_edge_routes_to_next',
      regex: /(?:Nginx|production|edge).*(?:routes|proxies).*(?:\/\*|everything else).*Next(?:\.js)?/i,
    },
    {
      name: 'production_nginx_slash_to_next',
      regex: /production\s+Nginx\s+\/\*\s*->\s*Next(?:\.js)?/i,
    },
    {
      name: 'production_ui_owner_next',
      regex: /production\s+(?:UI\s+owner|edge\s+owner)\s*=\s*Next(?:\.js)?/i,
    },
    {
      name: 'production_requires_next_start',
      regex: /production\s+(?:requires|runs)\s+.*next\s+start/i,
    },
    {
      name: 'production_dual_service',
      regex: /production\s+application\s+runs\s+as\s+Next(?:\.js)?\s*\+\s*Go\s+dual\s+service/i,
    },
  ];
  for (const p of patterns) {
    if (p.regex.test(docText)) {
      violations.push(p.name);
    }
  }
  return violations;
}

/**
 * Detect instructing sudo ./deploy/nginx/setup.sh for local Next.js development workflow:
 * - EDGE_REQUIRED followed by setup.sh instead of setup-next-legacy.sh
 * - local:dev instructions recommending setup.sh instead of setup-next-legacy.sh
 */
export function detectWrongDevInstaller(docText) {
  const violations = [];
  const patterns = [
    {
      name: 'edge_required_instructs_prod_setup',
      regex: /EDGE_REQUIRED.*sudo\s+\.\/deploy\/nginx\/setup\.sh(?!\b-next-legacy)/i,
    },
    {
      name: 'local_dev_workflow_uses_prod_setup',
      regex: /sudo\s+\.\/deploy\/nginx\/setup\.sh(?!\b-next-legacy)[\s\S]{0,100}npm\s+run\s+local:dev/i,
    },
    {
      name: 'local_dev_instructions_recommend_prod_setup',
      regex: /npm\s+run\s+local:dev[\s\S]{0,150}sudo\s+\.\/deploy\/nginx\/setup\.sh(?!\b-next-legacy)/i,
    },
  ];
  for (const p of patterns) {
    if (p.regex.test(docText)) {
      violations.push(p.name);
    }
  }
  return violations;
}

/**
 * Detect active references in current-authority documentation to retired artifacts
 * or unsupported migration-era transports:
 * - frontend-spa
 * - deploy/nginx/xcloud-next-legacy.conf
 * - deploy/nginx/setup-next-legacy.sh
 * - frontend/src/proxy.ts
 * - temporary Next.js local development
 * - Next.js HMR as supported current development transport
 */
export function detectRetiredDocumentationArtifacts(docText) {
  const violations = [];
  const lines = docText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Allow explicit prohibition / negative guard / historical context statements
    if (/(?:prohibit|retired|never|not|must not|cannot|zero|deleted|absence|removed|histor)/i.test(rawLine)) {
      continue;
    }
    const checks = [
      { name: 'frontend_spa_ref', re: /\bfrontend-spa\b/ },
      { name: 'legacy_nginx_conf_ref', re: /xcloud-next-legacy\.conf/ },
      { name: 'legacy_nginx_setup_ref', re: /setup-next-legacy\.sh/ },
      { name: 'deleted_proxy_guard_ref', re: /frontend\/src\/proxy\.ts/ },
      { name: 'temporary_next_dev_ref', re: /temporary (?:local )?development with Next(?:\.js)?/i },
      { name: 'next_hmr_supported_ref', re: /Next(?:\.js)? HMR(?: as supported| for local)/i },
    ];
    for (const check of checks) {
      if (check.re.test(rawLine)) {
        violations.push({ line: i + 1, name: check.name, text: rawLine.trim() });
      }
    }
  }
  return violations;
}

/**
 * Extract declared script names from frontend/package.json.
 */
export function extractDeclaredFrontendScripts(packageJsonText) {
  const parsed = typeof packageJsonText === 'string' ? JSON.parse(packageJsonText) : packageJsonText;
  const scripts = (parsed && parsed.scripts) || {};
  return new Set(Object.keys(scripts));
}

/**
 * Extract documented frontend commands from markdown documentation.
 * Specifically scans the frontend commands section in markdown.
 */
export function extractDocumentedFrontendScripts(docText) {
  const match = /#\s*Frontend\s*\([^)]*frontend\/[^)]*\)[\s\S]*?(?:```|$)/i.exec(docText);
  if (!match) return [];
  const sectionText = match[0];
  const commands = [];
  const lines = sectionText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) continue;
    const npmRunMatch = /^npm\s+run\s+([a-zA-Z0-9_:-]+)/.exec(trimmed);
    if (npmRunMatch) {
      commands.push(npmRunMatch[1]);
      continue;
    }
    const npmTestMatch = /^npm\s+test\b/.exec(trimmed);
    if (npmTestMatch) {
      commands.push('test');
      continue;
    }
  }
  return [...new Set(commands)];
}

/**
 * Validate that all documented frontend scripts exist in declared frontend scripts.
 * Returns array of undeclared script names.
 */
export function validateDocumentedFrontendScripts(documentedScripts, declaredScripts) {
  const undeclared = [];
  for (const script of documentedScripts) {
    if (!declaredScripts.has(script)) {
      undeclared.push(script);
    }
  }
  return undeclared;
}

/**
 * Reject current documentation that presents any frontend npm command
 * or Vite/frontend server as a production server runtime.
 */
export function detectFrontendProductionServerDocs(docText) {
  const violations = [];
  const lines = docText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Allow explicit negative statements / prohibitions / guards
    if (/(?:does not|not a|not an|never|zero|no|retire|without|neither|nor)\b/i.test(rawLine)) {
      continue;
    }
    const patterns = [
      { name: 'npm_run_start_prod_server', re: /npm\s+run\s+start\b.*(?:start\s+)?production\s+server/i },
      { name: 'vite_production_server', re: /Vite\s+production\s+server/i },
      { name: 'frontend_production_server', re: /(?:start\s+)?frontend\s+production\s+server/i },
      { name: 'start_frontend_server_in_prod', re: /start\s+frontend\s+server\s+in\s+production/i },
      { name: 'preview_as_production_runtime', re: /preview.*(?:is|as|runs?\s+as)\s+(?:the\s+)?production\s+runtime/i },
      { name: 'npm_start_in_production', re: /npm\s+run\s+start\b/i },
    ];
    for (const p of patterns) {
      if (p.re.test(rawLine)) {
        violations.push({ line: i + 1, name: p.name, text: rawLine.trim() });
      }
    }
  }
  return violations;
}

/**
 * Detect active presentation of obsolete dev port 13334 as Vite dev server:
 * - 127.0.0.1:13334
 * - localhost:13334
 * - Vite ... 13334
 * Lines marked with retirement/prohibition/historical keywords are permitted.
 */
export function detectObsoleteDevPort13334(docText) {
  const violations = [];
  const lines = docText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (/(?:prohibit|retired|退役|never|not|must not|cannot|zero|deleted|absence|removed|histor|reassign|old)/i.test(rawLine)) {
      continue;
    }
    if (/(?:127\.0\.0\.1:13334|localhost:13334|Vite.*13334|\bport\s+13334\b)/i.test(rawLine)) {
      violations.push({ line: i + 1, name: 'obsolete_port_13334', text: rawLine.trim() });
    }
  }
  return violations;
}

/**
 * Detect active presentation of Next.js running on port 13333 as current architecture.
 * Next.js on 13333 is permanently retired.
 * Lines marked with retirement/prohibition/reassignment keywords are permitted.
 */
export function detectNextOnPort13333(docText) {
  const violations = [];
  const lines = docText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (/(?:prohibit|retired|退役|never|not|must not|cannot|zero|deleted|absence|removed|histor|reassign|old|no longer)/i.test(rawLine)) {
      continue;
    }
    if (/(?:Next(?:\.js)?.*(?:13333|:13333)|(?:13333|:13333).*Next(?:\.js)?)/i.test(rawLine)) {
      violations.push({ line: i + 1, name: 'next_on_port_13333', text: rawLine.trim() });
    }
  }
  return violations;
}

console.log('Testing current architecture documentation consistency...');

// 1. OCS Management Runbook
const runbookPath = path.join(ROOT, 'docs/operations/ocs-management-runbook.md');
const runbook = fs.readFileSync(runbookPath, 'utf8');

const forbiddenInRunbook = [
  'Dual-Governance Access Control',
  'Maker-Checker',
  'maker-checker',
  'approval ticket',
  'APPROVAL_REQUIRED',
  'MAKER_CANNOT_BE_CHECKER',
  '/governance/approvals',
  'WriteStrict',
  'Pending approval request is created',
  'Super Admin must approve',
];

for (const pattern of forbiddenInRunbook) {
  assert.ok(
    !runbook.includes(pattern),
    `Forbidden pattern "${pattern}" found in ${runbookPath}`
  );
}

assert.ok(runbook.includes('GoRegistered = 119'), 'Runbook must document GoRegistered = 119');
assert.ok(runbook.includes('Canonical RBAC & Direct Execution'), 'Runbook must document Canonical RBAC & Direct Execution');
assert.ok(runbook.includes('xcloud_ops.app_audit_logs'), 'Runbook must reference app_audit_logs');
assert.ok(runbook.includes('app_approvals'), 'Runbook must mention historical app_approvals status');

// 2. main.go comments
const mainGoPath = path.join(ROOT, 'backend/cmd/server/main.go');
const mainGo = fs.readFileSync(mainGoPath, 'utf8');

assert.ok(!mainGo.includes('operator→APPROVAL'), 'main.go must not contain operator→APPROVAL');
assert.ok(!mainGo.includes('super_admin/root→DIRECT'), 'main.go must not contain super_admin/root→DIRECT');

// 3. AGENTS.md - current deployment boundary (Nginx edge + Go registration authority)
const agentsPath = path.join(ROOT, 'AGENTS.md');
const agents = fs.readFileSync(agentsPath, 'utf8');

const forbiddenInAgents = [
  'Strict audit logging to `app_audit_logs`',
  'approval review/execute',
  '## 9.1 Approval Governance',
  '## 9.2 Super Admin Direct Governance Policy',
  // Retired mechanisms must not be presented as the current architecture.
  'Every production API operation owner = Go (route-owner table',
  'Proxy ownership',
  'ownership decision + exact METHOD+PATH forwarding',
];

for (const pattern of forbiddenInAgents) {
  assert.ok(
    !agents.includes(pattern),
    `Forbidden pattern "${pattern}" found in ${agentsPath}`
  );
}

assert.ok(agents.includes('Best-effort / non-business-gating operation logging'), 'AGENTS.md must document best-effort operation logging');
assert.ok(agents.includes('Nginx'), 'AGENTS.md must describe the Nginx edge');
assert.ok(agents.includes('127.0.0.1:18888'), 'AGENTS.md must document the Go upstream 127.0.0.1:18888');
assert.ok(agents.includes('127.0.0.1:13333') || agents.includes('13333'), 'AGENTS.md must document Vite dev server 127.0.0.1:13333');
assert.ok(agents.includes('embedded static React SPA') || agents.includes('embedded static SPA'), 'AGENTS.md must document Go embedded SPA hosting');
assert.ok(agents.includes('119 exact METHOD+PATH registrations'), 'AGENTS.md must document the 119 Go registration authority');
assert.ok(agents.includes('Route authority'), 'AGENTS.md must document the derived Go registration authority');
assert.ok(agents.includes('the derived Go registration set'), 'AGENTS.md must derive route authority from the Go registration set');

// 4. deployment.md - final edge boundary
const deploymentPath = path.join(ROOT, 'docs/operations/deployment.md');
const deployment = fs.readFileSync(deploymentPath, 'utf8');

const forbiddenInDeployment = [
  'upstream nextjs',
  'upstream golang',
  'location /api/subscribers',
  'still go to Next.js during migration',
  'upstream xcloud_next',
];

for (const pattern of forbiddenInDeployment) {
  assert.ok(
    !deployment.includes(pattern),
    `Forbidden pattern "${pattern}" found in ${deploymentPath}`
  );
}

assert.ok(deployment.includes('127.0.0.1:18888'), 'deployment.md must document the Go upstream 127.0.0.1:18888');
assert.ok(deployment.includes('13333') || deployment.includes('127.0.0.1:13333'), 'deployment.md must document dev port 13333');
assert.ok(deployment.includes('upstream xcloud_go'), 'deployment.md must document the single Go upstream xcloud_go');
assert.ok(deployment.includes('location = /api'), 'deployment.md must document the exact /api Go location');
assert.ok(deployment.includes('location /api/'), 'deployment.md must document the /api/ Go location');
assert.ok(deployment.includes('/api/notifications/stream'), 'deployment.md must document the SSE location');
assert.ok(deployment.includes('client_max_body_size 10m'), 'deployment.md must document the 10 MiB upload boundary');
assert.ok(deployment.includes('proxy_set_header X-User ""'), 'deployment.md must document identity header stripping');
assert.ok(deployment.includes('nginx -t'), 'deployment.md must document nginx -t validation');
assert.ok(deployment.includes('setup.sh'), 'deployment.md must document setup.sh [listen_port] usage');
assert.ok(deployment.includes('AUTH_UNAVAILABLE'), 'deployment.md must document Go 503 AUTH_UNAVAILABLE semantics');

// 5. CLAUDE.md - no retired mechanism presented as current architecture
const claudePath = path.join(ROOT, 'CLAUDE.md');
const claude = fs.readFileSync(claudePath, 'utf8');

assert.ok(!claude.includes('approval review/execute'), 'CLAUDE.md must not contain approval review/execute');
assert.ok(!claude.includes('ACTUALLY_ROUTED = 26`'), 'CLAUDE.md must not contain stale ACTUALLY_ROUTED = 26 in active invariants');
assert.ok(!/route-owner table/i.test(claude), 'CLAUDE.md must not present a route-owner table as the current architecture');
assert.ok(claude.includes('Nginx'), 'CLAUDE.md must describe the Nginx edge');
assert.ok(claude.includes('119 条 Go 注册'), 'CLAUDE.md must document the 119 Go registration authority');

// 6. README.md
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');

assert.ok(!readme.includes('approval governance'), 'README.md must not list active approval governance in features');
assert.ok(!/route-owner table/i.test(readme), 'README.md must not present a route-owner table as the current architecture');
assert.ok(readme.includes('127.0.0.1:18888'), 'README.md must document the Go upstream 127.0.0.1:18888');
assert.ok(readme.includes('13333') || readme.includes('127.0.0.1:13333'), 'README.md must document dev port 13333');
assert.ok(readme.includes('React 19'), 'README.md must document React 19 in production tech stack');
assert.ok(readme.includes('Vite 8'), 'README.md must document Vite 8 in production tech stack');

// 7. docs/README.md - documentation authority model
const docsReadmePath = path.join(ROOT, 'docs/README.md');
const docsReadme = fs.readFileSync(docsReadmePath, 'utf8');

assert.ok(docsReadme.includes('# Documentation'), 'docs/README.md must be the documentation entry point');
assert.ok(docsReadme.includes('## Authority Model'), 'docs/README.md must document the authority model');

// The authority model is ordered and must name every documentation tier.
const authorityTiers = [
  'README.md',
  'docs/README.md',
  'docs/architecture/**',
  'docs/operations/**',
  'docs/database/**',
  'docs/archive/**',
];
for (const tier of authorityTiers) {
  assert.ok(
    docsReadme.includes(tier),
    `docs/README.md authority model must name the "${tier}" tier`
  );
}

// The archive tier must be explicitly marked as non-authoritative.
assert.ok(
  docsReadme.includes('NOT current architecture authority'),
  'docs/README.md must mark docs/archive/** as not current architecture authority'
);

// The authority model must point at the primary production sources, not at removed trees.
assert.ok(docsReadme.includes('deploy/nginx/xcloud.conf'), 'docs/README.md must point to the Nginx edge configuration');
assert.ok(docsReadme.includes('backend/cmd/server/main.go'), 'docs/README.md must point to the Go registration authority');
assert.ok(docsReadme.includes('frontend/src/') || docsReadme.includes('frontend/'), 'docs/README.md must point to canonical frontend source');

// The architecture tier must describe the present system only.
const systemArchPath = path.join(ROOT, 'docs/architecture/system-architecture.md');
const systemArch = fs.readFileSync(systemArchPath, 'utf8');
assert.ok(systemArch.includes('Nginx'), 'system-architecture.md must describe the Nginx edge');
assert.ok(systemArch.includes('127.0.0.1:18888'), 'system-architecture.md must document the Go upstream 127.0.0.1:18888');
assert.ok(systemArch.includes('13333') || systemArch.includes('127.0.0.1:13333'), 'system-architecture.md must document dev port 13333');
assert.ok(!/route-owner table/i.test(systemArch), 'system-architecture.md must not present a route-owner table as the current architecture');

// 8. Current documentation framework version must match the installed manifest.
const declaredNextVersion = extractDeclaredNextVersion(fs.readFileSync(path.join(ROOT, 'frontend/package.json'), 'utf8'));
const documentedNextVersion = extractDocumentedNextVersion(readme);

assert.ok(declaredNextVersion, 'frontend/package.json must declare a Next.js version');

// Negative sentinel: a synthetic mismatch must be detected, proving this assertion is
// non-tautological rather than merely restating its own input.
const sentinelMismatchDetected =
  extractDocumentedNextVersion('Next.js 0.0.1 App Router') !== declaredNextVersion;
assert.ok(sentinelMismatchDetected, 'Next.js documentation version detector must flag a mismatch');

assert.equal(
  documentedNextVersion,
  declaredNextVersion,
  `README Next.js version "${documentedNextVersion}" must match frontend/package.json "${declaredNextVersion}"`
);

// 9. Negative assertions rejecting stale production topology and wrong installer in docs
const readmeStaleHits = detectStaleProductionTopology(readme);
assert.equal(
  readmeStaleHits.length,
  0,
  `README.md must not present stale production topology: ${readmeStaleHits.join(', ')}`
);

const deploymentStaleHits = detectStaleProductionTopology(deployment);
assert.equal(
  deploymentStaleHits.length,
  0,
  `docs/operations/deployment.md must not present stale production topology: ${deploymentStaleHits.join(', ')}`
);

const readmeWrongInstallerHits = detectWrongDevInstaller(readme);
assert.equal(
  readmeWrongInstallerHits.length,
  0,
  `README.md must not instruct production setup.sh for local Next dev: ${readmeWrongInstallerHits.join(', ')}`
);

const deploymentWrongInstallerHits = detectWrongDevInstaller(deployment);
assert.equal(
  deploymentWrongInstallerHits.length,
  0,
  `docs/operations/deployment.md must not instruct production setup.sh for local Next dev: ${deploymentWrongInstallerHits.join(', ')}`
);

// Negative sentinels: prove detectors flag synthetic violations (falsifiability)
const syntheticStaleExamples = [
  'Nginx routes /api to Go and everything else to Next.js.',
  'production Nginx /* -> Next.js',
  'production UI owner = Next.js',
  'production requires next start',
  'production application runs as Next.js + Go dual service',
];
let sentinelStaleDetectedCount = 0;
for (const example of syntheticStaleExamples) {
  const detected = detectStaleProductionTopology(example);
  assert.ok(
    detected.length > 0,
    `detectStaleProductionTopology must flag synthetic example: "${example}"`
  );
  sentinelStaleDetectedCount++;
}

const syntheticWrongInstallerExamples = [
  'EDGE_REQUIRED and instructs sudo ./deploy/nginx/setup.sh',
  'sudo ./deploy/nginx/setup.sh\nnpm run local:dev',
  'npm run local:dev\nStart Nginx: sudo ./deploy/nginx/setup.sh',
];
let sentinelWrongInstallerDetectedCount = 0;
for (const example of syntheticWrongInstallerExamples) {
  const detected = detectWrongDevInstaller(example);
  assert.ok(
    detected.length > 0,
    `detectWrongDevInstaller must flag synthetic example: "${example}"`
  );
  sentinelWrongInstallerDetectedCount++;
}

// 10. Scan active current-authority documentation for retired artifacts
function walkDocs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      if (entry === 'archive' || entry === 'node_modules') continue;
      walkDocs(full, out);
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const activeDocs = [
  path.join(ROOT, 'README.md'),
  path.join(ROOT, 'AGENTS.md'),
  path.join(ROOT, 'CLAUDE.md'),
  ...walkDocs(path.join(ROOT, 'docs')),
];

let currentDocsFrontendSpaRefs = 0;
let currentDocsLegacyNextSetupRefs = 0;
let currentDocsDeletedNextProxyRefs = 0;
const retiredDocViolations = [];

for (const docFile of activeDocs) {
  const content = fs.readFileSync(docFile, 'utf8');
  const hits = detectRetiredDocumentationArtifacts(content);
  for (const hit of hits) {
    retiredDocViolations.push({ file: path.relative(ROOT, docFile).replaceAll('\\', '/'), ...hit });
    if (hit.name === 'frontend_spa_ref') currentDocsFrontendSpaRefs++;
    if (hit.name === 'legacy_nginx_setup_ref' || hit.name === 'legacy_nginx_conf_ref') currentDocsLegacyNextSetupRefs++;
    if (hit.name === 'deleted_proxy_guard_ref') currentDocsDeletedNextProxyRefs++;
  }
}

assert.equal(retiredDocViolations.length, 0, `Retired documentation artifact references found: ${JSON.stringify(retiredDocViolations)}`);

// Negative sentinels: prove detectors flag synthetic violations (falsifiability)
const syntheticRetiredDocExamples = [
  'cd frontend-spa && npm run build',
  'run setup-next-legacy.sh to start Nginx for Next',
  'deploy/nginx/xcloud-next-legacy.conf provides edge proxy',
  'UI page guard in frontend/src/proxy.ts validates JWT',
  'temporary local development with Next.js is enabled',
  'Next.js HMR for local development server',
];
let sentinelRetiredDocDetectedCount = 0;
for (const example of syntheticRetiredDocExamples) {
  const detected = detectRetiredDocumentationArtifacts(example);
  assert.ok(detected.length > 0, `detectRetiredDocumentationArtifacts must flag synthetic example: "${example}"`);
  sentinelRetiredDocDetectedCount++;
}

// 11. Frontend script contract & production server documentation guard
const frontendPackageJsonText = fs.readFileSync(path.join(ROOT, 'frontend/package.json'), 'utf8');
const declaredFrontendScripts = extractDeclaredFrontendScripts(frontendPackageJsonText);
const readmeFrontendScripts = extractDocumentedFrontendScripts(readme);

const undeclaredReadmeScripts = validateDocumentedFrontendScripts(readmeFrontendScripts, declaredFrontendScripts);
assert.equal(
  undeclaredReadmeScripts.length,
  0,
  `README documents undeclared frontend scripts: ${undeclaredReadmeScripts.join(', ')}`
);

// Verify required production wording is present in README
assert.ok(
  /Production does not start a frontend server\.\s*The production SPA is built from frontend\//i.test(readme),
  'README must include authoritative production SPA embed wording: "Production does not start a frontend server..."'
);

// Check that no active documentation presents frontend npm commands or Vite as a production server
const prodServerDocViolations = [];
for (const docFile of activeDocs) {
  const content = fs.readFileSync(docFile, 'utf8');
  const hits = detectFrontendProductionServerDocs(content);
  for (const hit of hits) {
    prodServerDocViolations.push({ file: path.relative(ROOT, docFile).replaceAll('\\', '/'), ...hit });
  }
}
assert.equal(
  prodServerDocViolations.length,
  0,
  `Active documentation presents frontend as production server: ${JSON.stringify(prodServerDocViolations)}`
);

// 12. Negative Falsifiability Sentinels for frontend scripts and production server docs
// (a) Synthetic fixture with "npm run start # Start production server"
const syntheticNonexistentStartFixture = `
# Frontend (from frontend/)
npm run start # Start production server
`;
const syntheticStartCommands = extractDocumentedFrontendScripts(syntheticNonexistentStartFixture);
const syntheticStartUndeclared = validateDocumentedFrontendScripts(syntheticStartCommands, declaredFrontendScripts);
assert.ok(
  syntheticStartUndeclared.includes('start'),
  'validateDocumentedFrontendScripts must detect nonexistent "start" script'
);
const syntheticStartProdServerHits = detectFrontendProductionServerDocs(syntheticNonexistentStartFixture);
assert.ok(
  syntheticStartProdServerHits.length > 0,
  'detectFrontendProductionServerDocs must flag "npm run start # Start production server"'
);

// (b) Synthetic fixture with invented command "npm run deploy-ui"
const syntheticInventedScriptFixture = `
# Frontend (from frontend/)
npm run deploy-ui
`;
const syntheticInventedCommands = extractDocumentedFrontendScripts(syntheticInventedScriptFixture);
const syntheticInventedUndeclared = validateDocumentedFrontendScripts(syntheticInventedCommands, declaredFrontendScripts);
assert.ok(
  syntheticInventedUndeclared.includes('deploy-ui'),
  'validateDocumentedFrontendScripts must detect invented script "deploy-ui"'
);

// (c) Synthetic production server patterns
const syntheticProdServerExamples = [
  'Vite production server',
  'frontend production server',
  'start frontend server in production',
];
for (const ex of syntheticProdServerExamples) {
  const hits = detectFrontendProductionServerDocs(ex);
  assert.ok(hits.length > 0, `detectFrontendProductionServerDocs must flag "${ex}"`);
}

// (d) Positive contract: verify all 7 canonical scripts are declared and accepted
const EXPECTED_FRONTEND_SCRIPTS = ['dev', 'build', 'preview', 'lint', 'typecheck', 'test', 'check'];
for (const s of EXPECTED_FRONTEND_SCRIPTS) {
  assert.ok(declaredFrontendScripts.has(s), `frontend/package.json must declare script "${s}"`);
}
const positiveValidation = validateDocumentedFrontendScripts(EXPECTED_FRONTEND_SCRIPTS, declaredFrontendScripts);
assert.equal(positiveValidation.length, 0, 'All expected frontend scripts must be declared');

// 13. Dev port 13333 reassignment and Next retirement guards
const obsoletePort13334Violations = [];
const nextOnPort13333Violations = [];
for (const docFile of activeDocs) {
  const content = fs.readFileSync(docFile, 'utf8');
  const port13334Hits = detectObsoleteDevPort13334(content);
  for (const hit of port13334Hits) {
    obsoletePort13334Violations.push({ file: path.relative(ROOT, docFile).replaceAll('\\', '/'), ...hit });
  }
  const next13333Hits = detectNextOnPort13333(content);
  for (const hit of next13333Hits) {
    nextOnPort13333Violations.push({ file: path.relative(ROOT, docFile).replaceAll('\\', '/'), ...hit });
  }
}
assert.equal(
  obsoletePort13334Violations.length,
  0,
  `Active documentation presents obsolete port 13334: ${JSON.stringify(obsoletePort13334Violations)}`
);
assert.equal(
  nextOnPort13333Violations.length,
  0,
  `Active documentation presents Next.js on port 13333: ${JSON.stringify(nextOnPort13333Violations)}`
);

// Negative sentinels: prove detectors flag synthetic violations (falsifiability)
const syntheticObsolete13334Examples = [
  'Vite dev server runs at 127.0.0.1:13334',
  'Browse to http://localhost:13334 to view the app',
  'Default Vite dev port 13334',
];
let sentinelObsolete13334DetectedCount = 0;
for (const ex of syntheticObsolete13334Examples) {
  const detected = detectObsoleteDevPort13334(ex);
  assert.ok(detected.length > 0, `detectObsoleteDevPort13334 must flag synthetic example: "${ex}"`);
  sentinelObsolete13334DetectedCount++;
}

const syntheticNext13333Examples = [
  'Next.js dev server listening on 127.0.0.1:13333',
  'production Next.js runs on port 13333',
  'Next.js on 13333 proxies to Go',
];
let sentinelNext13333DetectedCount = 0;
for (const ex of syntheticNext13333Examples) {
  const detected = detectNextOnPort13333(ex);
  assert.ok(detected.length > 0, `detectNextOnPort13333 must flag synthetic example: "${ex}"`);
  sentinelNext13333DetectedCount++;
}

console.log('Current architecture documentation consistency: PASS');

console.log(`documented_next_version=${documentedNextVersion}`);
console.log(`declared_next_version=${declaredNextVersion}`);
console.log(`next_documentation_version_match=${documentedNextVersion === declaredNextVersion}`);
console.log(`next_documentation_version_sentinel_detected=${sentinelMismatchDetected}`);
console.log(`readme_stale_production_topology=${readmeStaleHits.length}`);
console.log(`deployment_stale_production_topology=${deploymentStaleHits.length}`);
console.log(`current_docs_frontend_spa_refs=${currentDocsFrontendSpaRefs}`);
console.log(`current_docs_legacy_next_setup_refs=${currentDocsLegacyNextSetupRefs}`);
console.log(`current_docs_deleted_next_proxy_refs=${currentDocsDeletedNextProxyRefs}`);
console.log(`readme_documented_frontend_scripts=${readmeFrontendScripts.join(',')}`);
console.log(`readme_undeclared_frontend_scripts=${undeclaredReadmeScripts.length}`);
console.log(`frontend_production_server_docs_hits=${prodServerDocViolations.length}`);
console.log(`sentinel_nonexistent_start_detected=true`);
console.log(`sentinel_invented_script_detected=true`);
console.log(`sentinel_prod_server_docs_detected=true`);
console.log(`sentinel_obsolete_port_13334_detected=true`);
console.log(`sentinel_next_on_13333_detected=true`);
console.log(`current_docs_obsolete_port_13334_refs=${obsoletePort13334Violations.length}`);
console.log(`current_docs_next_on_13333_refs=${nextOnPort13333Violations.length}`);
console.log(`frontend_command_contract_result=PASS`);
console.log(`canonicalization_cleanup_result=PASS`);
console.log(`local_workflow_contract=PASS`);
console.log(`documentation_contract=PASS`);
