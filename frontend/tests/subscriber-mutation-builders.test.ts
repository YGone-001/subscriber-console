import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  validateAndNormalizeImportRecord,
  ALLOWED_IMPORT_RECORD_KEYS,
  SENSITIVE_IMPORT_KEYS,
  type ImportRecord,
} from '../src/features/subscribers/mutation-contract';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const requestContractPath = resolve(__dirname, '../mutation-request-contract.json');
const requestContracts = JSON.parse(readFileSync(requestContractPath, 'utf8')) as Array<{
  name: string;
  method: string;
  path: string;
  queryMode: string;
  requiredBodyKeys: string[];
  optionalBodyKeys: string[];
  forbiddenBodyKeys: string[];
  responseSemantics?: string;
  nestedContracts?: Record<string, { requiredKeys?: string[]; allowedKeys?: string[]; forbiddenKeys?: string[] }>;
}>;

function getContract(name: string) {
  const contract = requestContracts.find((item) => item.name === name);
  assert.ok(contract, `Contract for "${name}" must exist in mutation-request-contract.json`);
  return contract;
}

function validatePayloadAgainstContract(
  payload: Record<string, unknown>,
  contract: ReturnType<typeof getContract>,
) {
  const payloadKeys = Object.keys(payload);
  const required = new Set(contract.requiredBodyKeys);
  const optional = new Set(contract.optionalBodyKeys);
  const forbidden = new Set(contract.forbiddenBodyKeys);

  for (const rk of required) {
    assert.ok(rk in payload, `Required key "${rk}" missing in payload for ${contract.name}`);
  }

  for (const fk of forbidden) {
    assert.equal(fk in payload, false, `Forbidden key "${fk}" present in payload for ${contract.name}`);
  }

  for (const pk of payloadKeys) {
    assert.ok(
      required.has(pk) || optional.has(pk),
      `Unexpected key "${pk}" in payload for ${contract.name}. Allowed: ${[...required, ...optional].join(', ')}`,
    );
  }

  if (contract.nestedContracts) {
    for (const [nestedPath, nestedSpec] of Object.entries(contract.nestedContracts)) {
      if (nestedPath.endsWith('[]')) {
        const baseKey = nestedPath.slice(0, -2);
        const arrayVal = payload[baseKey];
        if (Array.isArray(arrayVal)) {
          for (const item of arrayVal) {
            if (typeof item === 'object' && item !== null) {
              const itemKeys = Object.keys(item as Record<string, unknown>);
              const nestedReq = new Set(nestedSpec.requiredKeys || []);
              const nestedAllowed = new Set(nestedSpec.allowedKeys || []);
              const nestedForb = new Set(nestedSpec.forbiddenKeys || []);
              for (const nr of nestedReq) {
                assert.ok(nr in (item as Record<string, unknown>), `Required nested key "${nr}" missing in ${nestedPath}`);
              }
              for (const nf of nestedForb) {
                assert.equal(nf in (item as Record<string, unknown>), false, `Forbidden nested key "${nf}" present in ${nestedPath}`);
              }
              for (const ik of itemKeys) {
                assert.ok(
                  nestedAllowed.has(ik),
                  `Unexpected nested key "${ik}" in ${nestedPath}. Allowed: ${[...nestedAllowed].join(', ')}`,
                );
              }
            }
          }
        }
      } else {
        const nestedVal = payload[nestedPath];
        if (typeof nestedVal === 'object' && nestedVal !== null && !Array.isArray(nestedVal)) {
          const itemKeys = Object.keys(nestedVal as Record<string, unknown>);
          const nestedReq = new Set(nestedSpec.requiredKeys || []);
          const nestedAllowed = new Set(nestedSpec.allowedKeys || []);
          const nestedForb = new Set(nestedSpec.forbiddenKeys || []);
          for (const nr of nestedReq) {
            assert.ok(nr in (nestedVal as Record<string, unknown>), `Required nested key "${nr}" missing in ${nestedPath}`);
          }
          for (const nf of nestedForb) {
            assert.equal(nf in (nestedVal as Record<string, unknown>), false, `Forbidden nested key "${nf}" present in ${nestedPath}`);
          }
          for (const ik of itemKeys) {
            assert.ok(
              nestedAllowed.has(ik),
              `Unexpected nested key "${ik}" in ${nestedPath}. Allowed: ${[...nestedAllowed].join(', ')}`,
            );
          }
        }
      }
    }
  }
}

test('buildBatchPrecheckRequest produces authoritative shape and satisfies contract', () => {
  const req = buildBatchPrecheckRequest('001010000000001', 10);
  assert.deepEqual(req, {
    startImsi: '001010000000001',
    count: 10,
  });

  const contract = getContract('subscriber batch precheck');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);

  assert.throws(() => buildBatchPrecheckRequest('', 10), /startImsi is required/);
  assert.throws(() => buildBatchPrecheckRequest('001010000000001', 0), /count must be an integer/);
  assert.throws(() => buildBatchPrecheckRequest('001010000000001', -5), /count must be an integer/);
});

test('buildBatchCreateRequest produces authoritative shape and satisfies contract', () => {
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

  const contract = getContract('subscriber batch create');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);

  const minimal = buildBatchCreateRequest('001010000000001', 1);
  assert.deepEqual(minimal, {
    startImsi: '001010000000001',
    count: 1,
  });
  assert.equal('profile' in minimal, false);
  validatePayloadAgainstContract(minimal as unknown as Record<string, unknown>, contract);
});

test('buildBatchUpdateRequest produces authoritative shape with required reason and satisfies contract', () => {
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

  const contract = getContract('subscriber batch update');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);

  assert.throws(() => buildBatchUpdateRequest(['001010000000001'], patch, ''), /reason must contain at least 3 characters/);
  assert.throws(() => buildBatchUpdateRequest(['001010000000001'], patch, 'ab'), /reason must contain at least 3 characters/);
  assert.throws(() => buildBatchUpdateRequest([], patch, 'Valid reason'), /imsis must contain at least one valid IMSI/);
  assert.throws(() => buildBatchUpdateRequest(['001010000000001'], {}, 'Valid reason'), /patch object must not be empty/);
});

test('buildBulkDeleteRequest produces authoritative shape with imsiList and satisfies contract', () => {
  const req = buildBulkDeleteRequest(['001010000000001', '001010000000002']);
  assert.deepEqual(req, {
    imsiList: ['001010000000001', '001010000000002'],
  });
  assert.equal('imsis' in req, false);

  const contract = getContract('subscriber bulk delete');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);

  assert.throws(() => buildBulkDeleteRequest([]), /imsiList must contain at least one valid IMSI/);
});

test('buildImportPrecheckRequest produces authoritative shape with imsiList and satisfies contract', () => {
  const req = buildImportPrecheckRequest(['001010000000001']);
  assert.deepEqual(req, {
    imsiList: ['001010000000001'],
  });
  assert.equal('subscribers' in req, false);

  const contract = getContract('subscriber import precheck');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);

  assert.throws(() => buildImportPrecheckRequest([]), /imsiList must contain at least one valid IMSI/);
});

test('buildImportRequest produces authoritative shape with records and overwrite, and satisfies contract', () => {
  const records: ImportRecord[] = [{ imsi: '001010000000001', plan_id: 'plan_a' }];
  const req = buildImportRequest(records, false);
  assert.deepEqual(req, {
    records: [{ imsi: '001010000000001', plan_id: 'plan_a' }],
    overwrite: false,
  });
  assert.equal('subscribers' in req, false);

  const contract = getContract('subscriber import execute');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);

  assert.throws(() => buildImportRequest([]), /records must contain at least one record/);
});

test('buildSubscriberCreateRequest produces valid subscriber create payload and satisfies contract', () => {
  const req = buildSubscriberCreateRequest('001010000000001', {
    msisdn: '12345678901',
    planId: 'plan_1',
  });
  assert.deepEqual(req, {
    imsi: '001010000000001',
    msisdn: '12345678901',
    planId: 'plan_1',
  });

  const contract = getContract('subscriber create');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);

  assert.throws(() => buildSubscriberCreateRequest(''), /imsi is required/);
});

/*
 * Authentication material travels on the CREATE request. It is provisioned when the subscriber is
 * created and immutable afterwards, so the builder must emit it here and never on the update.
 */
test('buildSubscriberCreateRequest emits auth4G in OPc mode and satisfies the create contract', () => {
  const req = buildSubscriberCreateRequest('001010000000001', {
    planId: 'plan_1',
    auth4G: {
      k: '00112233445566778899aabbccddeeff',
      opc: 'aabbccddeeff00112233445566778899',
      amf: '8000',
      sqn: 0,
    },
  });

  assert.deepEqual(req, {
    imsi: '001010000000001',
    planId: 'plan_1',
    auth4G: {
      k: '00112233445566778899AABBCCDDEEFF',
      amf: '8000',
      sqn: 0,
      opc: 'AABBCCDDEEFF00112233445566778899',
    },
  });
  assert.ok(!('op' in (req.auth4G as object)), 'OPc mode must not emit op');

  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, getContract('subscriber create'));
});

test('buildSubscriberCreateRequest emits auth4G in OP mode and satisfies the create contract', () => {
  const req = buildSubscriberCreateRequest('001010000000002', {
    auth4G: {
      k: '00112233445566778899aabbccddeeff',
      op: 'ffeeddccbbaa99887766554433221100',
      amf: '8a0b',
      sqn: 1719756,
    },
  });

  assert.deepEqual(req.auth4G, {
    k: '00112233445566778899AABBCCDDEEFF',
    amf: '8A0B',
    sqn: 1719756,
    op: 'FFEEDDCCBBAA99887766554433221100',
  });
  assert.ok(!('opc' in (req.auth4G as object)), 'OP mode must not emit opc');
});

test('buildSubscriberCreateRequest preserves SQN 0 rather than treating it as absent', () => {
  const req = buildSubscriberCreateRequest('001010000000003', {
    auth4G: { k: '00112233445566778899aabbccddeeff', opc: 'aabbccddeeff00112233445566778899', amf: '8000', sqn: 0 },
  });
  assert.equal(req.auth4G?.sqn, 0);
});

test('buildSubscriberCreateRequest omits auth4G entirely when not supplied', () => {
  const req = buildSubscriberCreateRequest('001010000000004', { planId: 'plan_1' });
  assert.ok(!('auth4G' in req), 'auth4G must be absent so the server keeps its defaults');
});

test('buildSubscriberCreateRequest rejects invalid authentication material', () => {
  const valid = { k: '00112233445566778899aabbccddeeff', opc: 'aabbccddeeff00112233445566778899', amf: '8000', sqn: 0 };

  assert.throws(() => buildSubscriberCreateRequest('001010000000005', { auth4G: { ...valid, k: '0011' } }), /K has an invalid format/);
  assert.throws(() => buildSubscriberCreateRequest('001010000000006', { auth4G: { ...valid, k: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' } }), /K has an invalid format/);
  assert.throws(() => buildSubscriberCreateRequest('001010000000007', { auth4G: { ...valid, opc: 'AABB' } }), /OPc has an invalid format/);
  assert.throws(() => buildSubscriberCreateRequest('001010000000008', { auth4G: { ...valid, amf: '80' } }), /AMF has an invalid format/);
  assert.throws(() => buildSubscriberCreateRequest('001010000000009', { auth4G: { ...valid, sqn: -1 } }), /sqn must be an integer between/);
  assert.throws(() => buildSubscriberCreateRequest('001010000000010', { auth4G: { ...valid, sqn: 1.5 } }), /sqn must be an integer between/);
  assert.throws(() => buildSubscriberCreateRequest('001010000000011', { auth4G: { ...valid, k: '' } }), /K is required/);
});

/*
 * The frontend must enforce the same SQN ceiling the server does. Accepting a larger value would
 * let the form submit something the service answers with 400, turning a local mistake into a
 * round trip and an error the operator cannot act on.
 */
test('buildSubscriberCreateRequest enforces the SQN ceiling the backend enforces', () => {
  const base = { k: '00112233445566778899aabbccddeeff', opc: 'aabbccddeeff00112233445566778899', amf: '8000' };
  const MAX = 9007199254740991;

  assert.equal(buildSubscriberCreateRequest('001010000000014', { auth4G: { ...base, sqn: MAX } }).auth4G?.sqn, MAX);
  assert.equal(buildSubscriberCreateRequest('001010000000015', { auth4G: { ...base, sqn: 0 } }).auth4G?.sqn, 0);

  assert.throws(() => buildSubscriberCreateRequest('001010000000016', { auth4G: { ...base, sqn: MAX + 1 } }), /sqn must be an integer between 0 and 9007199254740991/);
  assert.throws(() => buildSubscriberCreateRequest('001010000000017', { auth4G: { ...base, sqn: Number.MAX_SAFE_INTEGER + 10 } }), /sqn must be an integer between/);
});

test('buildSubscriberCreateRequest requires exactly one of op and opc', () => {
  const base = { k: '00112233445566778899aabbccddeeff', amf: '8000', sqn: 0 };
  const op = 'ffeeddccbbaa99887766554433221100';
  const opc = 'aabbccddeeff00112233445566778899';

  assert.throws(
    () => buildSubscriberCreateRequest('001010000000012', { auth4G: { ...base, op, opc } }),
    /exactly one of op or opc, not both/,
  );
  assert.throws(
    () => buildSubscriberCreateRequest('001010000000013', { auth4G: { ...base } }),
    /exactly one of op or opc/,
  );
});

/*
 * The update request must never carry authentication material: the service rejects a change to it
 * on an existing subscriber, so emitting it would turn ordinary edits into 422s.
 */
/*
 * The edit form must not present authentication material as editable on an existing subscriber.
 * There is no DOM harness here, so this asserts the contract at the source level: the fields are
 * bound to a read-only flag derived from `imsi`, and the flag is false only for a new subscriber.
 */
test('subscriber edit form makes authentication fields read-only for an existing subscriber', () => {
  const editMode = readFileSync(
    resolve(__dirname, '../src/features/subscribers/components/subscriber/SubscriberEditMode.tsx'),
    'utf8',
  );

  assert.match(editMode, /const authReadOnly = Boolean\(imsi\)/, 'read-only flag must derive from imsi');

  /*
   * Counted over the whole auth grid rather than per line: the inputs are written across several
   * lines, so a per-line match would depend on formatting rather than on behaviour.
   */
  const gridStart = editMode.indexOf('auth-edit-grid');
  const grid = editMode.slice(gridStart, editMode.indexOf('Global Network Configure', gridStart));
  assert.ok(grid.length > 0, 'expected to locate the authentication section');

  const readOnlyBindings = (grid.match(/readOnly=\{authReadOnly\}/g) ?? []).length;
  const disabledBindings = (grid.match(/disabled=\{authReadOnly\}/g) ?? []).length;
  assert.equal(readOnlyBindings, 4, 'K, OP/OPc, AMF and SQN must all be readOnly');
  assert.equal(disabledBindings, 5, 'K, OP/OPc, the OP/OPc selector, AMF and SQN must all be disabled');

  /* And the constraint must be explained, not left as an apparently broken form. */
  assert.match(editMode, /sub_auth_provisioned_readonly/, 'a localized explanation must accompany the read-only fields');
});

test('buildSubscriberUpdateRequest never emits auth4G', () => {
  const req = buildSubscriberUpdateRequest({ msisdn: '12345678901', accessRestrictionData: 32 });
  assert.ok(!('auth4G' in req), 'ordinary subscriber edit must not carry auth4G');

  const contract = getContract('subscriber edit');
  assert.ok(
    !(contract.optionalBodyKeys as string[]).includes('auth4G'),
    'the subscriber edit contract must not advertise auth4G as a mutable field',
  );
});

test('buildSubscriberUpdateRequest produces sub4G with msisdnList array and satisfies contract', () => {
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

  const sub4G = req.sub4G as Record<string, unknown>;
  assert.equal(typeof sub4G.msisdn, 'undefined');
  assert.ok(Array.isArray(sub4G.msisdnList));

  const contract = getContract('subscriber edit');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);
});

test('buildProfileApplyRequest produces authoritative shape with profileName and satisfies contract', () => {
  const req = buildProfileApplyRequest('profile_standard');
  assert.deepEqual(req, {
    profileName: 'profile_standard',
  });

  const contract = getContract('subscriber apply profile');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);

  assert.throws(() => buildProfileApplyRequest(''), /profileName is required/);
});

test('buildTrafficAdjustRequest produces valid traffic adjustment payload and satisfies contract', () => {
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

  const contract = getContract('subscriber traffic adjustment');
  validatePayloadAgainstContract(req as unknown as Record<string, unknown>, contract);
});

// Targeted Semantic Parity Tests
test('import: valid minimal record is normalized correctly', () => {
  const minimal = { imsi: '001010000000001' };
  const res = validateAndNormalizeImportRecord(minimal);
  assert.deepEqual(res, { imsi: '001010000000001' });
});

test('import: valid full supported record is normalized correctly', () => {
  const full = {
    imsi: '001010000000001',
    access_restriction_data: 32,
    traffic_total: 10737418240,
    traffic_balance: 10737418240,
    sms_total: 100,
    sms_balance: 100,
    plan_id: 'plan_default_10gb',
  };
  const res = validateAndNormalizeImportRecord(full);
  assert.deepEqual(res, full);
});

test('import: unknown fields (msisdn, profile, arbitrary) are rejected', () => {
  assert.throws(
    () => validateAndNormalizeImportRecord({ imsi: '001010000000001', msisdn: '12345' }),
    /Unsupported import field: "msisdn"/,
  );
  assert.throws(
    () => validateAndNormalizeImportRecord({ imsi: '001010000000001', profile: 'gold' }),
    /Unsupported import field: "profile"/,
  );
  assert.throws(
    () => validateAndNormalizeImportRecord({ imsi: '001010000000001', arbitraryField: 'value' }),
    /Unsupported import field: "arbitraryField"/,
  );
});

test('import: sensitive credential material is rejected', () => {
  assert.throws(
    () => validateAndNormalizeImportRecord({ imsi: '001010000000001', k: '000102030405060708090A0B0C0D0E0F' }),
    /Sensitive credential field "k" is not supported/,
  );
  assert.throws(
    () => validateAndNormalizeImportRecord({ imsi: '001010000000001', op: '000102030405060708090A0B0C0D0E0F' }),
    /Sensitive credential field "op" is not supported/,
  );
  assert.throws(
    () => validateAndNormalizeImportRecord({ imsi: '001010000000001', opc: '000102030405060708090A0B0C0D0E0F' }),
    /Sensitive credential field "opc" is not supported/,
  );
  assert.throws(
    () => validateAndNormalizeImportRecord({ imsi: '001010000000001', amf: '8000' }),
    /Sensitive credential field "amf" is not supported/,
  );
  assert.throws(
    () => validateAndNormalizeImportRecord({ imsi: '001010000000001', sqn: '1719756' }),
    /Sensitive credential field "sqn" is not supported/,
  );
});

test('import: overwrite=true is strictly rejected by buildImportRequest', () => {
  const records = [{ imsi: '001010000000001' }];
  assert.throws(() => buildImportRequest(records, true), /Subscriber import overwrite is not supported/);
});

test('import: duplicate IMSIs are rejected', () => {
  const duplicateRecords = [
    { imsi: '001010000000001' },
    { imsi: '001010000000001' },
  ];
  assert.throws(() => buildImportRequest(duplicateRecords, false), /Duplicate IMSI in import records/);
});

test('single edit: MSISDN update produces only sub4G.msisdnList and no unintended fields', () => {
  const req = buildSubscriberUpdateRequest({
    msisdn: '12345678901',
  });
  assert.deepEqual(req, {
    sub4G: {
      msisdnList: [{ msisdn: '12345678901' }],
    },
  });

  const sub4G = req.sub4G as Record<string, unknown>;
  assert.equal(typeof sub4G.access_restriction_data, 'undefined');
  assert.equal(typeof sub4G.network_access_mode, 'undefined');
  assert.equal(typeof sub4G.ambr, 'undefined');
  assert.equal(typeof sub4G.sliceList, 'undefined');
  assert.equal(typeof req.auth4G, 'undefined');
  assert.equal(typeof req.ocsTraffic, 'undefined');
});

test('single edit: clearing MSISDN emits empty msisdnList array', () => {
  const req = buildSubscriberUpdateRequest({
    msisdn: '',
  });
  assert.deepEqual(req, {
    sub4G: {
      msisdnList: [],
    },
  });
});

test('traffic adjustment: classified as routing-acknowledgement, never mutation-result', () => {
  const contract = getContract('subscriber traffic adjustment');
  assert.equal(contract.responseSemantics, 'routing-acknowledgement');
  assert.notEqual(contract.responseSemantics, 'mutation-result');
});

test('import: ALLOWED_IMPORT_RECORD_KEYS and SENSITIVE_IMPORT_KEYS definitions', () => {
  assert.equal(ALLOWED_IMPORT_RECORD_KEYS.size, 7);
  assert.ok(ALLOWED_IMPORT_RECORD_KEYS.has('imsi'));
  assert.equal(SENSITIVE_IMPORT_KEYS.size, 5);
  assert.ok(SENSITIVE_IMPORT_KEYS.has('k'));
});
