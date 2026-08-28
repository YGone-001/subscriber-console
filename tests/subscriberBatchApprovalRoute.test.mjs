import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModule } from './helpers/loadModule.mjs';

const validInput = {
  imsis: ['460001234567890'], patch: { accessRestrictionData: 0 }, reason: '维护窗口测试', ticketId: 'CHG-20260828-001',
};

function routeHarness(activeApprovals = []) {
  const audits = [];
  const approvals = [];
  const dependencies = {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/audit': { writeAuditLog: async (event) => { audits.push(event); return true; } },
    '@/lib/audit/record': { auditRequestContext: () => ({ request: { requestId: 'req-phase5', correlationId: 'corr-phase5' } }) },
    '@/lib/accountSession': { validateCurrentAccount: async () => ({ userId: 'root-1', username: 'admin', role: 'root' }) },
    '@/lib/authz': { requirePermission: () => ({ ok: true, auth: { user: 'admin', role: 'root', sessionVersion: 0 } }) },
    '@/lib/rateLimit': { enforceRateLimit: async () => ({ ok: true }) },
    '@/server/approvalWorkflow': { approvalActionEligibility: () => ({ canApprove: false, canExecute: false }) },
    '@/server/subscriberOperationPolicy': {
      validateSubscriberBatchChangeRequest: () => validInput,
      evaluateSubscriberOperationPolicy: () => ({ allowed: true, operation: 'SUBSCRIBER_BATCH_UPDATE', policyId: 'subscriber-batch-governance-v1', requiresApproval: true }),
      prepareFrozenSubscriberBatchChange: async () => ({ version: 'subscriber-batch-update-v1', targets: [{ imsi: validInput.imsis[0], before: { access_restriction_data: 32 }, after: { access_restriction_data: 0 }, preconditionHash: 'hash' }], patch: validInput.patch, fieldNames: ['access_restriction_data'], targetCount: 1, snapshotBytes: 200, operationFingerprint: 'fingerprint' }),
      SubscriberBatchGovernanceError: class extends Error {},
    },
    '@/server/repositories/approvalRepository': {
      listActiveSubscriberBatchApprovals: async () => activeApprovals,
      createApprovalRequest: async (input) => { const approval = { id: 'approval-1', changeId: 'CHG-1', status: 'pending', riskLevel: 'high', ...input }; approvals.push(approval); return approval; },
    },
  };
  return { route: loadModule('src/app/api/subscribers/batch-update/route.ts', dependencies), approvals, audits };
}

test('root batch-update request only creates a governed approval and never receives a bypass path', async () => {
  const h = routeHarness();
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.requiresApproval, true);
  assert.equal(body.approval.action, 'SUBSCRIBER_BATCH_UPDATE');
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].payload.targets[0].after.access_restriction_data, 0);
  assert.equal(h.audits[0].approvalId, 'approval-1');
});

test('duplicate batch submit returns the existing active approval instead of a second request', async () => {
  const existing = { id: 'approval-existing', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'pending', operationFingerprint: 'fingerprint', payload: { targets: [], fieldNames: [] } };
  const h = routeHarness([existing]);
  const response = await h.route.POST(new Request('https://ops.test/api/subscribers/batch-update', { method: 'POST', body: JSON.stringify(validInput) }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.idempotent, true);
  assert.equal(body.approval.id, existing.id);
  assert.equal(h.approvals.length, 0);
});

test('legacy high-risk batch-create route no longer contains a super-admin direct mutation branch', () => {
  const source = readFileSync(new URL('../src/app/api/subscribers/batch/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /isSuperAdmin|createSubscribersBatch/);
  assert.match(source, /requiresApproval:\s*true/);
});
