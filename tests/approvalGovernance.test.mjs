import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessApprovalRisk, requiresIndependentReviewer, supportedApprovalActions } from '../src/server/approvalRiskPolicy.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('risk policy is server-owned, exhaustive for supported actions, and fail-safe for unknown operations', () => {
  assert.ok(supportedApprovalActions().length >= 13);
  for (const action of supportedApprovalActions()) {
    const assessment = assessApprovalRisk(action);
    assert.match(assessment.policyId, /^approval-risk-/);
    assert.ok(assessment.reasons.length > 0);
  }
  assert.equal(assessApprovalRisk('UNKNOWN_DESTRUCTIVE_ACTION').level, 'high');
  assert.equal(requiresIndependentReviewer('high'), true);
  assert.equal(requiresIndependentReviewer('critical'), true);
  assert.equal(requiresIndependentReviewer('medium'), false);
});

test('automatic subscriber approvals have an explicit production executor coverage invariant', async () => {
  const registry = await import('../src/server/subscriberGovernanceRegistry.ts');
  const execution = read('src/server/approvalExecution.ts');
  for (const action of registry.governedSubscriberApprovalActions) assert.match(execution, new RegExp(action));
  assert.doesNotThrow(() => registry.assertGovernedOperationCoverage(registry.governedSubscriberApprovalActions));
  assert.throws(() => registry.assertGovernedOperationCoverage([]), /GOVERNED_OPERATION_EXECUTOR_MISSING/);
});

test('change IDs use an atomic sequence and new writes never persist legacy executed status', () => {
  const repository = read('src/server/repositories/approvalRepository.ts');
  assert.match(repository, /findOneAndUpdate\([\s\S]*?\$inc:\s*\{ value: 1 \}[\s\S]*?upsert: true/);
  assert.match(repository, /CHG-\$\{key\}-\$\{String\(sequence\.value\)\.padStart\(5, '0'\)\}/);
  assert.match(repository, /legacyExecuted \? 'completed'/);
  assert.doesNotMatch(repository, /nextStatus:\s*'executed'|status:\s*'executed'/);
  assert.match(read('scripts/init-mongo-indexes.mjs'), /partialFilterExpression:\s*\{ changeId: \{ \$type: 'string' \} \}/);
});

test('decision APIs are explicit, reject reason is server validated, and approval cannot execute', () => {
  const legacy = read('src/app/api/approvals/[id]/route.ts');
  const approve = read('src/app/api/approvals/[id]/approve/route.ts');
  const reject = read('src/server/approvalWorkflow.ts');
  assert.match(legacy, /body\.decision !== 'approve' && body\.decision !== 'reject'/);
  assert.match(legacy, /INVALID_DECISION/);
  assert.doesNotMatch(approve, /executeApprovedChange|executeApproval/);
  assert.match(reject, /REJECTION_REASON_REQUIRED/);
  assert.match(reject, /reason\.length < 3/);
  assert.match(reject, /APPROVAL_TEXT_TOO_LONG/);
});

test('operation reasons use JSON bodies while the legacy header remains read-only compatibility', () => {
  const users = read('src/app/(dashboard)/users/hooks/useUserCrud.ts');
  const record = read('src/lib/audit/record.ts');
  assert.doesNotMatch(users, /X-Operation-Reason/);
  assert.match(users, /JSON\.stringify\(\{ \.\.\.payload, reason \}\)/);
  assert.match(record, /x-operation-reason/);
});

test('execution claims before invocation, checks preconditions, and correlates terminal callbacks by execution ID', () => {
  const execution = read('src/server/approvalExecution.ts');
  const repository = read('src/server/repositories/approvalRepository.ts');
  assert.match(execution, /expectedStatus: 'approved', nextStatus: 'executing'/);
  assert.match(execution, /validateExecutionPrecondition\(claimed\.approval\)[\s\S]*?executor\.execute/);
  assert.match(execution, /APPROVAL_PRECONDITION_CHANGED/);
  assert.match(execution, /OUTSIDE_MAINTENANCE_WINDOW/);
  assert.match(repository, /'execution\.id': input\.expectedExecutionId/);
  assert.match(execution, /crypto\.randomUUID\(\)/);
});

test('approval console is URL-driven, uses server eligibility, real events, frozen diffs and audit deep links', () => {
  const consoleSource = read('src/app/(dashboard)/approvals/ApprovalConsole.tsx');
  const page = read('src/app/(dashboard)/approvals/page.tsx');
  assert.match(page, /Suspense/);
  assert.match(consoleSource, /useSearchParams/);
  assert.match(consoleSource, /approval\.actions\.canApprove/);
  assert.match(consoleSource, /\/api\/approvals\/\$\{pendingAction\.approval\.id\}\/\$\{pendingAction\.type\}/);
  assert.doesNotMatch(consoleSource, /decision:\s*['"]approve/);
  assert.match(consoleSource, /<EventTimeline events=\{approval\.events\}/);
  assert.match(consoleSource, /<ChangeDiff before=\{approval\.before\} after=\{approval\.after\}/);
  assert.match(consoleSource, /\/audit-logs\?approvalId=/);
  assert.match(consoleSource, /riskLevel === 'critical'/);
  assert.match(consoleSource, /type === 'execute'/);
});

test('approval list exposes canonical query dimensions and full-filter summary counts', () => {
  const route = read('src/app/api/approvals/route.ts');
  const repository = read('src/server/repositories/approvalRepository.ts');
  for (const key of ['page', 'pageSize', 'q', 'status', 'risk', 'action', 'resourceType', 'resourceId', 'requester', 'reviewer', 'from', 'to']) assert.ok(route.includes(`'${key}'`) || route.includes(`get('${key}')`), key);
  for (const field of ['canReview', 'awaiting', 'todayApproved', 'highRiskPending']) assert.match(repository, new RegExp(field));
  assert.match(route, /approvalActionEligibility\(approval, auth\.auth\)/);
});
