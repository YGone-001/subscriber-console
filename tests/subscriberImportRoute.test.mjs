// tests/subscriberImportRoute.test.mjs
// Subscriber Import Route Tests — DI seam pattern
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createImportRequest(records, options = {}) {
  const { overwrite, mode = 'import', role = 'operator', user = 'testuser' } = options;
  const url = new URL(`http://localhost/api/subscribers/import`);
  url.searchParams.set('mode', mode);
  return new Request(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user': user,
      'x-user-role': role,
    },
    body: JSON.stringify({ records, overwrite }),
  });
}

function createMockDeps(overrides = {}) {
  return {
    requireCapability: () => ({
      ok: true,
      auth: { user: 'testuser', role: 'operator', sessionVersion: 1 },
    }),
    enforceRateLimit: async () => ({ ok: true }),
    validateImportRecords: (records) => {
      if (!Array.isArray(records) || records.length === 0) {
        return { ok: false, error: 'INVALID_SUBSCRIBER_IMPORT_REQUEST' };
      }
      const IMPORT_MUTATION_FIELDS = new Set(['imsi', 'access_restriction_data', 'traffic_total', 'traffic_balance', 'sms_total', 'sms_balance', 'plan_id']);
      const IMPORT_SENSITIVE_KEYS = new Set(['k', 'op', 'opc', 'amf', 'sqn']);
      for (const rec of records) {
        for (const key of Object.keys(rec)) {
          if (!IMPORT_MUTATION_FIELDS.has(key) && !IMPORT_SENSITIVE_KEYS.has(key)) {
            return { ok: false, error: 'INVALID_SUBSCRIBER_IMPORT_REQUEST' };
          }
        }
        for (const key of IMPORT_SENSITIVE_KEYS) {
          if (key in rec && rec[key] !== undefined && rec[key] !== null && String(rec[key]).trim() !== '') {
            return { ok: false, error: 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED' };
          }
        }
      }
      return { ok: true, value: records };
    },
    validateCurrentAccount: async () => ({
      user: { username: 'testuser', role: 'operator' },
      fresh: true,
    }),
    getTariffPlan: async () => ({ status: 'active' }),
    writeAuditLog: async () => {},
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: true }),
    createGovernedApproval: async (input) => ({
      id: 'approval-123',
      action: input.action,
      status: 'pending',
    }),
    prepareFrozenSubscriberImport: async (records) => ({
      version: 'subscriber-import-v2',
      records: records.map((r) => ({
        imsi: r.imsi,
        access_restriction_data: r.access_restriction_data || 32,
        traffic_total: r.traffic_total || 10737418240,
        traffic_balance: r.traffic_balance || 10737418240,
        sms_total: r.sms_total || 100,
        sms_balance: r.sms_balance || 100,
        plan_id: r.plan_id || 'plan_default_10gb',
      })),
      targets: records.map((r) => ({
        imsi: r.imsi,
        state: 'absent',
        recordIntentHash: 'hash-' + r.imsi,
      })),
      targetCount: records.length,
      summary: {
        rowCount: records.length,
        createCount: records.length,
        skipCount: 0,
        fieldNames: [],
        fileHash: 'filehash',
      },
      strategy: 'skip-existing-create-only',
      snapshotBytes: 1024,
      operationFingerprint: 'fp-' + records.map((r) => r.imsi).join('-'),
    }),
    executeFrozenSubscriberImportV2: async (frozen) => ({
      requested: frozen.targetCount,
      intendedCreateCount: frozen.summary.createCount,
      createdImsis: frozen.targets.map((t) => t.imsi),
      skippedImsis: [],
      conflictImsis: [],
      failedImsis: [],
      ocsProvisionedImsis: frozen.targets.map((t) => t.imsi),
      ocsProvisioningFailedImsis: [],
      createdCount: frozen.summary.createCount,
      partialMutation: false,
      mutationCommitted: true,
      operationFingerprint: frozen.operationFingerprint,
    }),
    listActiveSubscriberApprovals: async () => [],
    classifyImportResult: (result) => {
      if (result.createdCount === result.intendedCreateCount &&
          result.conflictImsis.length === 0 &&
          result.failedImsis.length === 0 &&
          result.ocsProvisioningFailedImsis.length === 0) {
        return 'SUCCESS';
      }
      if (result.createdCount > 0) return 'PARTIAL_WRITE';
      return 'FAILED_NO_MUTATION';
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module under test — uses loadModule for dependency injection
// ---------------------------------------------------------------------------

// We need to mock all dependencies that route.ts imports
const mockDependencies = {
  'next/server': {
    NextResponse: {
      json: (body, init) => {
        const status = init?.status || 200;
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  },
  '@/lib/audit': {
    logAudit: async () => {},
    writeAuditLog: async () => {},
  },
  '@/lib/authz': {
    requireCapability: () => ({
      ok: true,
      auth: { user: 'testuser', role: 'operator', sessionVersion: 1 },
    }),
  },
  '@/lib/rateLimit': { enforceRateLimit: async () => ({ ok: true }) },
  '@/server/repositories/subscriberRepository': { precheckSubscriberImsis: async () => ({}) },
  '@/server/repositories/ocsBillingRepository': { getTariffPlan: async () => ({}) },
  '@/server/repositories/approvalRepository': { listActiveSubscriberApprovals: async () => [] },
  '@/lib/subscriberValidation': {
    validateImportRecords: (r) => ({ valid: true, value: r }),
    validateImsiList: (l) => ({ valid: true, value: l }),
  },
  '@/server/subscriberGovernanceRegistry': {
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: true }),
    SUBSCRIBER_OPERATIONS: { SUBSCRIBER_IMPORT: {} },
  },
  '@/lib/accountSession': { validateCurrentAccount: async () => ({ user: { username: 'test', role: 'operator' }, fresh: true }) },
  '@/server/approvalCreator': { createGovernedApproval: async () => ({ id: 'approval-123' }) },
  '@/lib/audit/record': { auditRequestContext: () => ({}) },
  '@/server/subscriberSingleGovernance': {
    prepareFrozenSubscriberImport: async (records) => ({
      version: 'subscriber-import-v2',
      records: records.map((r) => ({ ...r })),
      targets: records.map((r) => ({ imsi: r.imsi, state: 'absent', recordIntentHash: 'hash' })),
      targetCount: records.length,
      summary: { rowCount: records.length, createCount: records.length, skipCount: 0, fieldNames: [], fileHash: 'filehash' },
      strategy: 'skip-existing-create-only',
      snapshotBytes: 1024,
      operationFingerprint: 'fp',
    }),
    assertFrozenSubscriberImportV2: (f) => f,
    executeFrozenSubscriberImportV2: async (frozen) => ({
      requested: frozen.targetCount,
      intendedCreateCount: frozen.summary.createCount,
      createdImsis: frozen.targets.map((t) => t.imsi),
      skippedImsis: [],
      conflictImsis: [],
      failedImsis: [],
      ocsProvisionedImsis: [],
      ocsProvisioningFailedImsis: [],
      createdCount: frozen.summary.createCount,
      partialMutation: false,
      mutationCommitted: true,
      operationFingerprint: frozen.operationFingerprint,
    }),
    classifyImportResult: (result) => {
      if (result.createdCount === result.intendedCreateCount && result.conflictImsis.length === 0) return 'SUCCESS';
      if (result.createdCount > 0) return 'PARTIAL_WRITE';
      return 'FAILED_NO_MUTATION';
    },
  },
  '@/lib/subscriberContract': {
    stable: (v) => JSON.stringify(v),
    hash: (v) => 'hash-' + JSON.stringify(v).length,
  },
  'node:crypto': {
    createHash: () => ({ update: () => ({ digest: () => 'hash' }) }),
  },
};

// Load the route module with mocked dependencies
const routeModule = loadModule(
  'src/app/api/subscribers/import/route.ts',
  mockDependencies
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('import route: reject overwrite=true', async () => {
  const request = createImportRequest([{ imsi: '454000000000001' }], { overwrite: true });
  const handler = routeModule.createSubscriberImportHandler(createMockDeps());
  const response = await handler(request, {});
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'SUBSCRIBER_IMPORT_OVERWRITE_NOT_SUPPORTED');
});

test('import route: reject sensitive field k → 422', async () => {
  const request = createImportRequest([{ imsi: '454000000000001', k: '00000000000000000000000000000000' }]);
  const handler = routeModule.createSubscriberImportHandler(createMockDeps());
  const response = await handler(request, {});
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
  assert.equal(body.code, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
});

test('import route: reject sensitive field op → 422', async () => {
  const request = createImportRequest([{ imsi: '454000000000001', op: '00000000000000000000000000000000' }]);
  const handler = routeModule.createSubscriberImportHandler(createMockDeps());
  const response = await handler(request, {});
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
  assert.equal(body.code, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
});

test('import route: reject sensitive field opc → 422', async () => {
  const request = createImportRequest([{ imsi: '454000000000001', opc: '00000000000000000000000000000000' }]);
  const handler = routeModule.createSubscriberImportHandler(createMockDeps());
  const response = await handler(request, {});
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
  assert.equal(body.code, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
});

test('import route: reject sensitive field amf → 422', async () => {
  const request = createImportRequest([{ imsi: '454000000000001', amf: '8000' }]);
  const handler = routeModule.createSubscriberImportHandler(createMockDeps());
  const response = await handler(request, {});
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
  assert.equal(body.code, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
});

test('import route: reject sensitive field sqn → 422', async () => {
  const request = createImportRequest([{ imsi: '454000000000001', sqn: '1' }]);
  const handler = routeModule.createSubscriberImportHandler(createMockDeps());
  const response = await handler(request, {});
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
  assert.equal(body.code, 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
});

test('import route: reject unknown normal field → 400', async () => {
  const request = createImportRequest([{ imsi: '454000000000001', unknown_field: 'value' }]);
  const handler = routeModule.createSubscriberImportHandler(createMockDeps());
  const response = await handler(request, {});
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'INVALID_SUBSCRIBER_IMPORT_REQUEST');
  assert.equal(body.code, 'INVALID_SUBSCRIBER_IMPORT_REQUEST');
});

test('import route: operator → 202 approval', async () => {
  const request = createImportRequest([{ imsi: '454000000000001' }], { role: 'operator' });
  const deps = createMockDeps();
  const handler = routeModule.createSubscriberImportHandler(deps);
  const response = await handler(request, {});
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.requiresApproval, true);
  assert.ok(body.approval);
});

test('import route: super_admin → 200 direct execution', async () => {
  const request = createImportRequest([{ imsi: '454000000000001' }], { role: 'super_admin' });
  const deps = createMockDeps({
    validateCurrentAccount: async () => ({
      user: { username: 'admin', role: 'super_admin' },
      fresh: true,
    }),
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: false }),
  });
  const handler = routeModule.createSubscriberImportHandler(deps);
  const response = await handler(request, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.imported, 1);
  assert.equal(body.outcome, 'executed');
});

test('import route: partial write returns 409', async () => {
  const request = createImportRequest([
    { imsi: '454000000000001' },
    { imsi: '454000000000002' },
  ]);
  const deps = createMockDeps({
    validateCurrentAccount: async () => ({
      user: { username: 'admin', role: 'super_admin' },
      fresh: true,
    }),
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: false }),
    executeFrozenSubscriberImportV2: async (frozen) => ({
      requested: frozen.targetCount,
      intendedCreateCount: frozen.summary.createCount,
      createdImsis: ['454000000000001'],
      skippedImsis: [],
      conflictImsis: ['454000000000002'],
      failedImsis: [],
      ocsProvisionedImsis: ['454000000000001'],
      ocsProvisioningFailedImsis: [],
      createdCount: 1,
      partialMutation: true,
      mutationCommitted: true,
      operationFingerprint: frozen.operationFingerprint,
    }),
  });
  const handler = routeModule.createSubscriberImportHandler(deps);
  const response = await handler(request, {});
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'SUBSCRIBER_IMPORT_PARTIAL_WRITE');
});

test('import route: failed no mutation returns 409', async () => {
  const request = createImportRequest([{ imsi: '454000000000001' }]);
  const deps = createMockDeps({
    validateCurrentAccount: async () => ({
      user: { username: 'admin', role: 'super_admin' },
      fresh: true,
    }),
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: false }),
    executeFrozenSubscriberImportV2: async (frozen) => ({
      requested: frozen.targetCount,
      intendedCreateCount: frozen.summary.createCount,
      createdImsis: [],
      skippedImsis: [],
      conflictImsis: ['454000000000001'],
      failedImsis: [],
      ocsProvisionedImsis: [],
      ocsProvisioningFailedImsis: [],
      createdCount: 0,
      partialMutation: false,
      mutationCommitted: false,
      operationFingerprint: frozen.operationFingerprint,
    }),
  });
  const handler = routeModule.createSubscriberImportHandler(deps);
  const response = await handler(request, {});
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED');
});

test('import route: executor precondition throw → 409 with business audit', async () => {
  const request = createImportRequest([{ imsi: '454000000000001' }], { role: 'super_admin' });
  const auditCalls = [];
  const deps = createMockDeps({
    validateCurrentAccount: async () => ({
      user: { username: 'admin', role: 'super_admin' },
      fresh: true,
    }),
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: false }),
    executeFrozenSubscriberImportV2: async () => {
      throw new Error('SUBSCRIBER_IMPORT_PRECONDITION_CHANGED');
    },
    writeAuditLog: async (input) => { auditCalls.push(input); },
  });
  const handler = routeModule.createSubscriberImportHandler(deps);
  const response = await handler(request, {});
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED');
  assert.equal(body.mutationCommitted, false);

  // Business audit was written
  const importAudit = auditCalls.find((a) => a.action === 'subscriber.import');
  assert.ok(importAudit, 'subscriber.import audit must be called');
  assert.equal(importAudit.result, 'failed');
  assert.equal(importAudit.metadata.classification, 'FAILED_NO_MUTATION');
  assert.equal(importAudit.metadata.mutationCommitted, false);
});

test('import route: executor storage throw → 500 with business audit', async () => {
  const request = createImportRequest([{ imsi: '454000000000001' }], { role: 'super_admin' });
  const auditCalls = [];
  const deps = createMockDeps({
    validateCurrentAccount: async () => ({
      user: { username: 'admin', role: 'super_admin' },
      fresh: true,
    }),
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: false }),
    executeFrozenSubscriberImportV2: async () => {
      throw new Error('DATABASE_CONNECTION_FAILED');
    },
    writeAuditLog: async (input) => { auditCalls.push(input); },
  });
  const handler = routeModule.createSubscriberImportHandler(deps);
  const response = await handler(request, {});
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, 'SUBSCRIBER_IMPORT_FAILED');
  assert.equal(body.mutationCommitted, false);

  // Business audit was written
  const importAudit = auditCalls.find((a) => a.action === 'subscriber.import');
  assert.ok(importAudit, 'subscriber.import audit must be called');
  assert.equal(importAudit.result, 'failed');
  assert.equal(importAudit.metadata.classification, 'FAILED_NO_MUTATION');
  assert.equal(importAudit.metadata.mutationCommitted, false);
});

test('import route: audit failure after zero-write → 503', async () => {
  const request = createImportRequest([{ imsi: '454000000000001' }], { role: 'super_admin' });
  const deps = createMockDeps({
    validateCurrentAccount: async () => ({
      user: { username: 'admin', role: 'super_admin' },
      fresh: true,
    }),
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: false }),
    executeFrozenSubscriberImportV2: async () => {
      throw new Error('SUBSCRIBER_IMPORT_PRECONDITION_CHANGED');
    },
    writeAuditLog: async () => { throw new Error('audit service down'); },
  });
  const handler = routeModule.createSubscriberImportHandler(deps);
  const response = await handler(request, {});
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'AUDIT_UNAVAILABLE');
  assert.equal(body.committed, false);
});

test('import route: oversized Prepare snapshot → 413', async () => {
  const records = Array.from({ length: 100 }, (_, i) => ({
    imsi: `454000000${String(i).padStart(8, '0')}`,
  }));
  const request = createImportRequest(records, { role: 'super_admin' });
  const deps = createMockDeps({
    validateCurrentAccount: async () => ({
      user: { username: 'admin', role: 'super_admin' },
      fresh: true,
    }),
    evaluateSubscriberOperationForActor: () => ({ requiresApproval: true }),
    prepareFrozenSubscriberImport: async () => {
      throw new Error('APPROVAL_SNAPSHOT_TOO_LARGE');
    },
  });
  const handler = routeModule.createSubscriberImportHandler(deps);
  const response = await handler(request, {});
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error, 'APPROVAL_SNAPSHOT_TOO_LARGE');
  assert.equal(body.code, 'APPROVAL_SNAPSHOT_TOO_LARGE');
});

// ---------------------------------------------------------------------------
// Gate A: Node REAL production Prepare oversized proof
// Loads the real subscriberSingleGovernance module (not mocked prepare)
// with mocked repository (findSubscriberDocument returns null)
// ---------------------------------------------------------------------------

test('import route: REAL production Prepare rejects oversized snapshot', async () => {
  // Load the real subscriberContract module with real crypto
  const realContract = loadModule('src/lib/subscriberContract.ts', {
    'node:crypto': await import('node:crypto'),
  });

  // Load the real subscriberSingleGovernance module with mocked repository
  const realGovernance = loadModule('src/server/subscriberSingleGovernance.ts', {
    '@/lib/xcloudSubscriber': { buildXcloudSubscriberFromLegacy: () => ({}) },
    '@/lib/subscriberContract': realContract,
    '@/server/repositories/subscriberRepository': {
      findSubscriberDocument: async () => null, // all subscribers are "new"
      insertSubscriberImportCreateOnly: async () => {},
      provisionImportedSubscriberOcs: async () => {},
      deleteSubscriber: async () => {},
      conditionalDeleteSubscriber: async () => {},
      deleteSubscriberOcsProvisioning: async () => {},
      updateSubscriberFromLegacy: async () => {},
    },
  });

  // Generate records that will produce snapshotBytes > 512KB
  // Each record ~308 bytes in stable JSON, need ~1701+ records
  const records = Array.from({ length: 2000 }, (_, i) => ({
    imsi: `454000000${String(i).padStart(8, '0')}`,
    access_restriction_data: 32,
    traffic_total: 10737418240,
    traffic_balance: 10737418240,
    sms_total: 100,
    sms_balance: 100,
    plan_id: 'plan_default_10gb',
  }));

  // Call the REAL production prepareFrozenSubscriberImport
  let threw = false;
  let errorCode = '';
  let snapshotBytes = 0;
  try {
    await realGovernance.prepareFrozenSubscriberImport(records);
  } catch (error) {
    threw = true;
    errorCode = error.code || error.message;
    // Compute what snapshotBytes would have been (for evidence)
    const targets = records.map((r) => ({
      imsi: r.imsi,
      state: 'absent',
      recordIntentHash: realContract.hash(r),
    }));
    const normalized = records.map((r) => ({ ...r })).sort((a, b) => a.imsi.localeCompare(b.imsi));
    const snapshotSource = {
      version: 'subscriber-import-v2',
      records: normalized,
      targets,
      targetCount: targets.length,
      summary: {
        rowCount: normalized.length,
        createCount: normalized.length,
        skipCount: 0,
        fieldNames: ['access_restriction_data', 'plan_id', 'sms_balance', 'sms_total', 'traffic_balance', 'traffic_total'],
        fileHash: realContract.hash(normalized),
      },
      strategy: 'skip-existing-create-only',
      operationFingerprint: 'fp',
    };
    snapshotBytes = realContract.stable(snapshotSource).length;
  }

  assert.ok(threw, 'prepareFrozenSubscriberImport must throw for oversized payload');
  assert.equal(errorCode, 'APPROVAL_SNAPSHOT_TOO_LARGE');
  assert.ok(snapshotBytes > 512 * 1024, `snapshotBytes=${snapshotBytes} must exceed 512KB`);
});

test('import route: REAL oversized Prepare cannot reach side effects', async () => {
  // Load the real modules
  const realContract = loadModule('src/lib/subscriberContract.ts', {
    'node:crypto': await import('node:crypto'),
  });

  const approvalCreateCalls = [];
  const subscriberInsertCalls = [];
  const ocsProvisionCalls = [];

  const realGovernance = loadModule('src/server/subscriberSingleGovernance.ts', {
    '@/lib/xcloudSubscriber': { buildXcloudSubscriberFromLegacy: () => ({}) },
    '@/lib/subscriberContract': realContract,
    '@/server/repositories/subscriberRepository': {
      findSubscriberDocument: async () => null,
      insertSubscriberImportCreateOnly: async (doc) => { subscriberInsertCalls.push(doc); },
      provisionImportedSubscriberOcs: async (input) => { ocsProvisionCalls.push(input); },
      deleteSubscriber: async () => {},
      conditionalDeleteSubscriber: async () => {},
      deleteSubscriberOcsProvisioning: async () => {},
      updateSubscriberFromLegacy: async () => {},
    },
  });

  // Build route handler with real Prepare but spies for side effects
  const sideEffectDeps = {
    ...createMockDeps({
      validateCurrentAccount: async () => ({
        user: { username: 'admin', role: 'super_admin' },
        fresh: true,
      }),
      evaluateSubscriberOperationForActor: () => ({ requiresApproval: true }),
      createGovernedApproval: async (input) => {
        approvalCreateCalls.push(input);
        return { id: 'approval-123', action: input.action, status: 'pending' };
      },
    }),
    prepareFrozenSubscriberImport: realGovernance.prepareFrozenSubscriberImport,
  };

  const records = Array.from({ length: 2000 }, (_, i) => ({
    imsi: `454000000${String(i).padStart(8, '0')}`,
    access_restriction_data: 32,
    traffic_total: 10737418240,
    traffic_balance: 10737418240,
    sms_total: 100,
    sms_balance: 100,
    plan_id: 'plan_default_10gb',
  }));

  const request = createImportRequest(records, { role: 'super_admin' });
  const handler = routeModule.createSubscriberImportHandler(sideEffectDeps);
  const response = await handler(request, {});

  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error, 'APPROVAL_SNAPSHOT_TOO_LARGE');
  assert.equal(body.code, 'APPROVAL_SNAPSHOT_TOO_LARGE');

  // Side-effect gate: none of these should have been called
  assert.equal(approvalCreateCalls.length, 0, 'Approval creation must not be called');
  assert.equal(subscriberInsertCalls.length, 0, 'Subscriber insert must not be called');
  assert.equal(ocsProvisionCalls.length, 0, 'OCS provisioning must not be called');
});
