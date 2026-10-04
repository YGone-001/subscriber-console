import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchPrecheckRequest,
  buildBatchCreateRequest,
  buildBatchUpdateRequest,
  buildBulkDeleteRequest,
  buildImportPrecheckRequest,
  buildImportRequest,
  buildSubscriberCreateRequest,
  buildSubscriberUpdateRequest,
  buildProfileApplyRequest,
  buildTrafficAdjustRequest,
} from '../src/features/subscribers/mutation-contract';

test('buildBatchPrecheckRequest produces authoritative shape', () => {
  const req = buildBatchPrecheckRequest('001010000000001', 10);
  assert.deepEqual(req, {
    startImsi: '001010000000001',
    count: 10,
  });

  // Rejects invalid inputs
  assert.throws(() => buildBatchPrecheckRequest('', 10), /startImsi is required/);
  assert.throws(() => buildBatchPrecheckRequest('001010000000001', 0), /count must be an integer/);
  assert.throws(() => buildBatchPrecheckRequest('001010000000001', -5), /count must be an integer/);
});

test('buildBatchCreateRequest produces authoritative shape', () => {
  const req = buildBatchCreateRequest('001010000000001', 5, {
    profileName: 'gold_profile',
    planId: 'plan_standard',
    strategy: 'overwrite',
  });
  assert.deepEqual(req, {
    startImsi: '001010000000001',
    count: 5,
    profileName: 'gold_profile',
    planId: 'plan_standard',
    strategy: 'overwrite',
  });

  const minimal = buildBatchCreateRequest('001010000000001', 1);
  assert.deepEqual(minimal, {
    startImsi: '001010000000001',
    count: 1,
  });
  assert.equal('profile' in minimal, false);
});

test('buildBatchUpdateRequest produces authoritative shape with required reason', () => {
  const patch = { accessRestrictionData: 32 };
  const req = buildBatchUpdateRequest(['001010000000001', '001010000000002'], patch, 'Emergency maintenance', {
    ticketId: 'CHG-999',
  });
  assert.deepEqual(req, {
    imsis: ['001010000000001', '001010000000002'],
    patch: { accessRestrictionData: 32 },
    reason: 'Emergency maintenance',
    ticketId: 'CHG-999',
  });

  // Rejects missing/short reason
  assert.throws(() => buildBatchUpdateRequest(['001010000000001'], patch, ''), /reason must contain at least 3 characters/);
  assert.throws(() => buildBatchUpdateRequest(['001010000000001'], patch, 'ab'), /reason must contain at least 3 characters/);

  // Rejects empty imsis
  assert.throws(() => buildBatchUpdateRequest([], patch, 'Valid reason'), /imsis must contain at least one valid IMSI/);

  // Rejects empty patch
  assert.throws(() => buildBatchUpdateRequest(['001010000000001'], {}, 'Valid reason'), /patch object must not be empty/);
});

test('buildBulkDeleteRequest produces authoritative shape with imsiList key', () => {
  const req = buildBulkDeleteRequest(['001010000000001', '001010000000002']);
  assert.deepEqual(req, {
    imsiList: ['001010000000001', '001010000000002'],
  });
  assert.equal('imsis' in req, false);

  assert.throws(() => buildBulkDeleteRequest([]), /imsiList must contain at least one valid IMSI/);
});

test('buildImportPrecheckRequest produces authoritative shape with imsiList key', () => {
  const req = buildImportPrecheckRequest(['001010000000001']);
  assert.deepEqual(req, {
    imsiList: ['001010000000001'],
  });
  assert.equal('subscribers' in req, false);

  assert.throws(() => buildImportPrecheckRequest([]), /imsiList must contain at least one valid IMSI/);
});

test('buildImportRequest produces authoritative shape with records and overwrite', () => {
  const records = [{ imsi: '001010000000001', plan_id: 'plan_a' }];
  const req = buildImportRequest(records, false);
  assert.deepEqual(req, {
    records: [{ imsi: '001010000000001', plan_id: 'plan_a' }],
    overwrite: false,
  });
  assert.equal('subscribers' in req, false);

  assert.throws(() => buildImportRequest([]), /records must contain at least one record/);
});

test('buildSubscriberCreateRequest produces valid subscriber create payload', () => {
  const req = buildSubscriberCreateRequest('001010000000001', {
    msisdn: '12345678901',
    planId: 'plan_1',
  });
  assert.deepEqual(req, {
    imsi: '001010000000001',
    msisdn: '12345678901',
    planId: 'plan_1',
  });

  assert.throws(() => buildSubscriberCreateRequest(''), /imsi is required/);
});

test('buildSubscriberUpdateRequest produces sub4G with msisdnList array', () => {
  const req = buildSubscriberUpdateRequest({
    msisdn: '12345678901',
    accessRestrictionData: 32,
  });
  assert.deepEqual(req, {
    sub4G: {
      msisdnList: [{ msisdn: '12345678901' }],
      access_restriction_data: 32,
    },
  });

  // Verify sub4G does NOT have direct string msisdn
  const sub4G = req.sub4G as Record<string, unknown>;
  assert.equal(typeof sub4G.msisdn, 'undefined');
  assert.ok(Array.isArray(sub4G.msisdnList));
});

test('buildProfileApplyRequest produces authoritative shape with profileName', () => {
  const req = buildProfileApplyRequest('profile_standard');
  assert.deepEqual(req, {
    profileName: 'profile_standard',
  });

  assert.throws(() => buildProfileApplyRequest(''), /profileName is required/);
});

test('buildTrafficAdjustRequest produces valid traffic adjustment payload', () => {
  const req = buildTrafficAdjustRequest({
    bucket: 'data',
    amount: 500,
    reason: 'Monthly bonus',
  });
  assert.deepEqual(req, {
    bucket: 'data',
    amount: 500,
    reason: 'Monthly bonus',
  });
});
