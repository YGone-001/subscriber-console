import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = process.cwd();

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

assert.ok(runbook.includes('GoRegistered = 84'), 'Runbook must document GoRegistered = 84');
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
assert.ok(agents.includes('127.0.0.1:13333'), 'AGENTS.md must document the Next.js upstream 127.0.0.1:13333');
assert.ok(agents.includes('84 exact METHOD+PATH registrations'), 'AGENTS.md must document the 84 Go registration authority');
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
];

for (const pattern of forbiddenInDeployment) {
  assert.ok(
    !deployment.includes(pattern),
    `Forbidden pattern "${pattern}" found in ${deploymentPath}`
  );
}

assert.ok(deployment.includes('127.0.0.1:18888'), 'deployment.md must document the Go upstream 127.0.0.1:18888');
assert.ok(deployment.includes('127.0.0.1:13333'), 'deployment.md must document the Next.js upstream 127.0.0.1:13333');
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
assert.ok(claude.includes('84 条 Go 注册'), 'CLAUDE.md must document the 84 Go registration authority');

// 6. README.md
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');

assert.ok(!readme.includes('approval governance'), 'README.md must not list active approval governance in features');
assert.ok(!/route-owner table/i.test(readme), 'README.md must not present a route-owner table as the current architecture');
assert.ok(readme.includes('127.0.0.1:18888'), 'README.md must document the Go upstream 127.0.0.1:18888');
assert.ok(readme.includes('127.0.0.1:13333'), 'README.md must document the Next.js upstream 127.0.0.1:13333');

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
assert.ok(docsReadme.includes('frontend/src/proxy.ts'), 'docs/README.md must point to the UI-only navigation guard');

// The architecture tier must describe the present system only.
const systemArchPath = path.join(ROOT, 'docs/architecture/system-architecture.md');
const systemArch = fs.readFileSync(systemArchPath, 'utf8');
assert.ok(systemArch.includes('Nginx'), 'system-architecture.md must describe the Nginx edge');
assert.ok(systemArch.includes('127.0.0.1:18888'), 'system-architecture.md must document the Go upstream 127.0.0.1:18888');
assert.ok(systemArch.includes('127.0.0.1:13333'), 'system-architecture.md must document the Next.js upstream 127.0.0.1:13333');
assert.ok(!/route-owner table/i.test(systemArch), 'system-architecture.md must not present a route-owner table as the current architecture');

console.log('Current architecture documentation consistency: PASS');
