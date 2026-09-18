import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const consoleSource = read('src/app/(dashboard)/audit-logs/AuditConsole.tsx');
const pageSource = read('src/app/(dashboard)/audit-logs/page.tsx');
const styles = read('src/app/(dashboard)/audit-logs/AuditConsole.module.css');

test('audit console uses App Router URL state and server pagination without a 500-row client cache', () => {
  assert.match(pageSource, /Suspense/);
  assert.match(consoleSource, /useSearchParams/);
  assert.match(consoleSource, /router\[replace \? 'replace' : 'push'\]/);
  assert.match(consoleSource, /DataTablePagination/);
  assert.match(consoleSource, /pageSize: nextSize/);
  assert.doesNotMatch(consoleSource, /limit.*500|filteredTotal|totalScanned|logs\.forEach/);
});

test('audit console metrics, table and detail drawer use server evidence and existing governance components', () => {
  for (const key of ['matched', 'failed', 'denied', 'highRisk']) assert.match(consoleSource, new RegExp(`summary\\.${key}`));
  assert.match(consoleSource, /AuditResultBadge/);
  assert.match(consoleSource, /RiskBadge/);
  assert.match(consoleSource, /ChangeDiff before=\{log\.oldData\} after=\{log\.newData\}/);
  assert.match(consoleSource, /\/api\/audit\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(consoleSource, /\/approvals\?approvalId=/);
  assert.match(styles, /width: min\(820px, 100vw\)/);
});

test('audit export UI delegates the complete filter to the server and never builds a browser Blob', () => {
  assert.match(consoleSource, /\/api\/audit\/export\?/);
  assert.match(consoleSource, /can\('audit\.export'\)/);
  assert.doesNotMatch(consoleSource, /new Blob|URL\.createObjectURL|toCsvRow/);
});
