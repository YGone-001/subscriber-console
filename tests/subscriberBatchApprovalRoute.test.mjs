import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModule } from './helpers/loadModule.mjs';

const validInput = {
  imsis: ['460001234567890'], patch: { accessRestrictionData: 0 }, reason: '维护窗口测试', ticketId: 'CHG-20260828-001',
};

const frozenV2 = {
  version: 'subscriber-batch-update-v2',
  targets: [{ imsi: validInput.imsis[0], before: { access_restriction_data: 32 }, after: { access_restriction_data: 0 }, preconditionHash: 'hash' }],
  patch: validInput.patch,
  fieldNames: ['access_restriction_data'],
  targetCount: 1,
  snapshotBytes: 200,
  operationFingerprint: 'fingerprint',
};

function routeHarness({ role = 'root', activeApprovals = [], executorResult = null } = {}) {
  const audits = [];
  const approvals = [];
  const executions = [];
  const dependencies = {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/audit': { writeAuditLog: async (event) => { audits.push(event); return true; } },
    '@/lib/audit/record': { auditRequestContext: () => ({ request: { requestId: 'req-phase5', correlationId: 'corr-phase5' } }) },
    '@/lib/accountSession': { validateCurrentAccount: async () => ({ userId: `${role}-1`, username: role, role, normalizedRole: role }) },
    '@/lib/authz': { requireCapability: () => ({ ok: true, auth: { user: role, role, sessionVersion: 0 } }) },
    '@/lib/rateLimit': { enforceRateLimit: async () => ({ ok: true }) },
    '@/server/approvalWorkflow': { approvalActionEligibility: () => ({ canApprove: false, canExecute: false }) },
    '@/server/subscriberOperationPolicy': {
      validateSubscriberBatchChangeRequest: () => validInput,
      prepareFrozenSubscriberBatchUpdateV2: async () => frozenV2,
      executeFrozenSubscriberBatchUpdate: async () => executorResult || { requested: 1, modifiedImsis: ['460001234567890'], conflictImsis: [], failedImsis: [], matchedCount: 1, modifiedCount: 1, partialMutation: false, mutationCommitted: true, fieldNames: ['access_restriction_data'], operationFingerprint: 'fingerprint' },
      classifyBatchUpdateResult: () => executorResult ? 'FAILED_NO_MUTATION' : 'SUCCESS',
      SubscriberBatchGovernanceError: class extends Error { constructor(code) { super(code); this.code = code; } },
    },
    '@/server/subscriberGovernanceRegistry': {
      evaluateSubscriberOperationForActor: () => {
        if (role === 'operator' || role === 'ops_admin') {
          return { executable: true, governanceMode: 'APPROVAL', requiresApproval: true };
        }
        return { executable: true, governanceMode: 'DIRECT_GOVERNED', requiresApproval: false };
      },
      SUBSCRIBER_OPERATIONS: { BATCH_UPDATE: 'SUBSCRIBER_BATCH_UPDATE' },
    },
    '@/server/approvalCreator': {
      createGovernedApproval: async (input) => { const approval = { id: 'approval-1', changeId: 'CHG-1', status: 'pending', riskLevel: 'high', ...input }; approvals.push(approval); return approval; },
      ApprovalCreationError: class extends Error { constructor(code, approval) { super(code); this.approval = approval; } },
    },
    '@/server/repositories/approvalRepository': {
      listActiveSubscriberBatchApprovals: async () => activeApprovals,
    },
  };
  return {
    route: loadModule('src/app/api/subscribers/batch-update/route.ts', dependencies),
    approvals,
    audits,
    executions,
  };
}

// ─── Section S: Node Route Acceptance Tests ───

test('operator → 202 Approval', async () => {
  const h = routeHarness({ role: 'operator' });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.requiresApproval, true);
  assert.equal(body.approval.action, 'SUBSCRIBER_BATCH_UPDATE');
  assert.equal(h.approvals.length, 1);
});

test('ops_admin → 202 Approval', async () => {
  const h = routeHarness({ role: 'ops_admin' });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.requiresApproval, true);
  assert.equal(h.approvals.length, 1);
});

test('super_admin → 200 executed', async () => {
  const h = routeHarness({ role: 'super_admin' });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, 'executed');
  assert.equal(body.requiresApproval, false);
  assert.equal(h.approvals.length, 0);
  assert.equal(h.audits.length, 1);
});

test('root → 200 executed', async () => {
  const h = routeHarness({ role: 'root' });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, 'executed');
  assert.equal(body.requiresApproval, false);
  assert.equal(h.approvals.length, 0);
  assert.equal(h.audits.length, 1);
});

// ─── Section T: Active Approval Tests ───

test('operator exact duplicate pending → 202 idempotent', async () => {
  const existing = { id: 'approval-existing', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'pending', operationFingerprint: 'fingerprint', payload: { targets: [], fieldNames: [] } };
  const h = routeHarness({ role: 'operator', activeApprovals: [existing] });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.idempotent, true);
  assert.equal(body.approval.id, existing.id);
  assert.equal(h.approvals.length, 0);
});

test('operator exact duplicate approved → 202 idempotent', async () => {
  const existing = { id: 'approval-existing', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'approved', operationFingerprint: 'fingerprint', payload: { targets: [], fieldNames: [] } };
  const h = routeHarness({ role: 'operator', activeApprovals: [existing] });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.idempotent, true);
});

test('operator exact duplicate executing → 202 idempotent', async () => {
  const existing = { id: 'approval-existing', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'executing', operationFingerprint: 'fingerprint', payload: { targets: [], fieldNames: [] } };
  const h = routeHarness({ role: 'operator', activeApprovals: [existing] });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.idempotent, true);
});

test('operator overlap same target+field → 409', async () => {
  const existing = { id: 'approval-conflict', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'pending', operationFingerprint: 'different-fingerprint', payload: { targets: [{ imsi: '460001234567890' }], fieldNames: ['access_restriction_data'] } };
  const h = routeHarness({ role: 'operator', activeApprovals: [existing] });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'ACTIVE_CHANGE_CONFLICT');
});

test('super_admin exact duplicate any active state → 409', async () => {
  const existing = { id: 'approval-existing', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'pending', operationFingerprint: 'fingerprint', payload: { targets: [], fieldNames: [] } };
  const h = routeHarness({ role: 'super_admin', activeApprovals: [existing] });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'ACTIVE_CHANGE_CONFLICT');
});

test('root overlap → 409', async () => {
  const existing = { id: 'approval-conflict', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'pending', operationFingerprint: 'different-fingerprint', payload: { targets: [{ imsi: '460001234567890' }], fieldNames: ['access_restriction_data'] } };
  const h = routeHarness({ role: 'root', activeApprovals: [existing] });
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'ACTIVE_CHANGE_CONFLICT');
});

// ─── Legacy tests (preserved) ───

test('legacy high-risk batch-create route no longer contains a super-admin direct mutation branch', () => {
  const source = readFileSync(new URL('../src/app/api/subscribers/batch/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /isSuperAdmin|createSubscribersBatch/);
  assert.match(source, /requiresApproval:\s*true/);
});

test('subscriber batch UI previews a governed request and does not optimistically mutate the list', () => {
  const modal = readFileSync(new URL('../src/components/SubscriberBatchUpdateModal.tsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/app/(dashboard)/subscribers/page.tsx', import.meta.url), 'utf8');
  assert.match(modal, /\/api\/subscribers\/batch-update/);
  assert.match(modal, /提交变更/);
  assert.match(modal, /变更原因/);
  assert.match(page, /订阅用户数据尚未修改/);
  assert.doesNotMatch(modal, /mutateSubscribers|onRefresh/);
});
