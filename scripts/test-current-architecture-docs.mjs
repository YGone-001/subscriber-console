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

assert.ok(runbook.includes('ACTUALLY_ROUTED = 36'), 'Runbook must document ACTUALLY_ROUTED = 36');
assert.ok(runbook.includes('Canonical RBAC & Direct Execution'), 'Runbook must document Canonical RBAC & Direct Execution');
assert.ok(runbook.includes('xcloud_ops.app_audit_logs'), 'Runbook must reference app_audit_logs');
assert.ok(runbook.includes('app_approvals'), 'Runbook must mention historical app_approvals status');

// 2. main.go comments
const mainGoPath = path.join(ROOT, 'backend/cmd/server/main.go');
const mainGo = fs.readFileSync(mainGoPath, 'utf8');

assert.ok(!mainGo.includes('operator→APPROVAL'), 'main.go must not contain operator→APPROVAL');
assert.ok(!mainGo.includes('super_admin/root→DIRECT'), 'main.go must not contain super_admin/root→DIRECT');

// 3. AGENTS.md
const agentsPath = path.join(ROOT, 'AGENTS.md');
const agents = fs.readFileSync(agentsPath, 'utf8');

const forbiddenInAgents = [
  'Strict audit logging to `app_audit_logs`',
  'approval review/execute',
  '## 9.1 Approval Governance',
  '## 9.2 Super Admin Direct Governance Policy',
  '`app_users` = Phase 2 read-only',
];

for (const pattern of forbiddenInAgents) {
  assert.ok(
    !agents.includes(pattern),
    `Forbidden pattern "${pattern}" found in ${agentsPath}`
  );
}

assert.ok(agents.includes('Best-effort / non-business-gating operation logging'), 'AGENTS.md must document best-effort operation logging');
assert.ok(agents.includes('ACTUALLY_ROUTED = 36'), 'AGENTS.md must document ACTUALLY_ROUTED = 36');
assert.ok(agents.includes('CUTOVER_TABLE = 36'), 'AGENTS.md must document CUTOVER_TABLE = 36');

// 4. CLAUDE.md
const claudePath = path.join(ROOT, 'CLAUDE.md');
const claude = fs.readFileSync(claudePath, 'utf8');

assert.ok(!claude.includes('approval review/execute'), 'CLAUDE.md must not contain approval review/execute');
assert.ok(!claude.includes('ACTUALLY_ROUTED = 26`'), 'CLAUDE.md must not contain stale ACTUALLY_ROUTED = 26 in active invariants');

// 5. README.md
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');

assert.ok(!readme.includes('approval governance'), 'README.md must not list active approval governance in features');

console.log('Current architecture documentation consistency: PASS');
