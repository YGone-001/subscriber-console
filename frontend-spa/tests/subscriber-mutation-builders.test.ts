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
