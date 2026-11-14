import assert from 'node:assert/strict';
import test from 'node:test';

import { notificationDeliveriesPath } from '../src/features/nf-alerts/nf-notifications-api';

test('delivery ledger path always carries a bounded limit and subject kind', () => {
  assert.equal(
    notificationDeliveriesPath(),
    '/api/nf-notifications/deliveries?limit=50&subjectKind=nf_alert',
  );
});

test('delivery ledger path forwards status, cursor and alert filters', () => {
  const path = notificationDeliveriesPath({
    limit: 100,
    status: 'failed',
    cursor: 'cursor+/=',
    alertId: '0192f0c0-a000-7000-8000-0000000000a1',
    subjectKind: 'config_drift',
  });
  assert.ok(path.includes('limit=100'));
  assert.ok(path.includes('status=failed'));
  assert.ok(path.includes('subjectKind=config_drift'));
  assert.ok(path.includes('alertId=0192f0c0-a000-7000-8000-0000000000a1'));
  assert.ok(path.includes('cursor=cursor%2B%2F%3D'), 'cursor must be URL encoded');
});

test('an empty status filter is omitted rather than sent as a wildcard', () => {
  const path = notificationDeliveriesPath({ status: '' });
  assert.ok(!path.includes('status='));
});
