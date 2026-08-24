import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('audit evidence records actor and correlation metadata through a durable post-response task', () => {
  const auditSource = read('src/lib/audit.ts');
  const repositorySource = read('src/server/repositories/auditRepository.ts');

  assert.match(auditSource, /import \{ after \} from 'next\/server'/);
  assert.match(auditSource, /after\(async \(\) =>/);
  assert.match(auditSource, /x-user/);
  assert.match(auditSource, /x-request-id/);
  assert.match(auditSource, /attempt <= 3/);
  assert.doesNotMatch(auditSource, /setTimeout\(async \(\) =>/);
  assert.match(repositorySource, /actor\?: string/);
  assert.match(repositorySource, /correlationId\?: string/);
  assert.match(repositorySource, /approvalId\?: string/);
});

test('audit viewing, bulk export, change review, and execution use separate capabilities', () => {
  const viewRoute = read('src/app/api/audit/route.ts');
  const exportRoute = read('src/app/api/approvals/export/route.ts');
  const reviewRoute = read('src/app/api/approvals/[id]/route.ts');

  assert.match(viewRoute, /requireCapability\(request, 'audit_view'\)/);
  assert.match(exportRoute, /requireCapability\(request, 'audit_export'/);
  assert.match(reviewRoute, /requireCapability\(request, 'approval_review'\)/);
  assert.match(reviewRoute, /requireCapability\(request, 'approval_execute'\)/);
});
