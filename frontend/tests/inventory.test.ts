import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildCreateResourceRequest,
  buildRetireResourceRequest,
  buildUpdateResourceRequest,
} from '../src/features/inventory/inventory-builders';
import {
  findSensitiveAttributeKey,
  validateAttributes,
  validateLabelKey,
  validateLabels,
  validateLabelValue,
  validateMachineName,
  validateManagementEndpoints,
} from '../src/features/inventory/inventory-validation';

test('inventory validation: machine name rules', () => {
  assert.equal(validateMachineName('host-01'), null);
  assert.equal(validateMachineName('amf.5gc.node:primary'), null);
  assert.equal(validateMachineName('router_core-1'), null);

  assert.notEqual(validateMachineName(''), null);
  assert.notEqual(validateMachineName('-invalid-start'), null);
  assert.notEqual(validateMachineName('.invalid-start'), null);
  assert.notEqual(validateMachineName('has whitespace'), null);
  assert.notEqual(validateMachineName('a'.repeat(129)), null);
});

test('inventory validation: management endpoints validation', () => {
  const valid = [
    { name: 'sbi', protocol: 'https', addressType: 'ipv4', address: '10.0.0.1', port: 443 },
    { name: 'n2', protocol: 'ngap', addressType: 'ipv4', address: '10.0.0.1', port: 38412 },
  ];
  assert.equal(validateManagementEndpoints(valid), null);

  // Duplicate tuple
  const dup = [
    { name: 'sbi-1', protocol: 'https', addressType: 'ipv4', address: '10.0.0.1', port: 443 },
    { name: 'sbi-2', protocol: 'https', addressType: 'ipv4', address: '10.0.0.1', port: 443 },
  ];
  assert.match(validateManagementEndpoints(dup) ?? '', /Duplicate/);

  // Address with URL scheme
  const scheme = [
    { name: 'sbi', protocol: 'https', addressType: 'ipv4', address: 'https://10.0.0.1', port: 443 },
  ];
  assert.match(validateManagementEndpoints(scheme) ?? '', /URL schemes/);

  // Invalid port
  const badPort = [
    { name: 'sbi', protocol: 'https', addressType: 'ipv4', address: '10.0.0.1', port: 99999 },
  ];
  assert.match(validateManagementEndpoints(badPort) ?? '', /between 1 and 65535/);
});

test('inventory validation: sensitive attribute key rejection', () => {
  assert.equal(findSensitiveAttributeKey({ mtu: 1500, duplex: 'full' }), null);
  assert.equal(findSensitiveAttributeKey({ nested: { ip: '1.2.3.4' } }), null);

  assert.equal(findSensitiveAttributeKey({ password: '123' }), 'password');
  assert.equal(findSensitiveAttributeKey({ admin_secret: 'x' }), 'admin_secret');
  assert.equal(findSensitiveAttributeKey({ auth: { token: 'xyz' } }), 'auth.token');
  assert.equal(findSensitiveAttributeKey({ api_key: 'abc' }), 'api_key');
  assert.equal(findSensitiveAttributeKey({ 'api-key': 'abc' }), 'api-key');
  assert.equal(findSensitiveAttributeKey({ apikey: 'abc' }), 'apikey');
  assert.equal(findSensitiveAttributeKey({ API_KEY: 'abc' }), 'API_KEY');
  assert.equal(findSensitiveAttributeKey({ credentials: {} }), 'credentials');
});

test('inventory validation: label grammar and limits match backend authority', () => {
  for (const key of ['site', 'rack-04', 'tier_name', 'region/zone', '5gc/core']) {
    assert.equal(validateLabelKey(key), null, `${key} must be accepted`);
  }
  for (const key of ['Region', 'SITE', 'cluster.id', '$site', '/site', 'a.b']) {
    assert.notEqual(validateLabelKey(key), null, `${key} must be rejected`);
  }

  assert.equal(validateLabels(Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key${index}`, 'ok']))), null);
  assert.match(validateLabels(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, 'ok']))) ?? '', /32/);
  assert.equal(validateLabelValue('x'.repeat(128)), null);
  assert.match(validateLabelValue('x'.repeat(129)) ?? '', /128/);
});

test('inventory validation: attribute structural constraints', () => {
  assert.equal(validateAttributes({ a: 1, b: 'two' }), null);

  // Key with dot
  assert.match(validateAttributes({ 'invalid.key': 1 }) ?? '', /cannot contain dots/);

  // Key starting with $
  assert.match(validateAttributes({ $where: 1 }) ?? '', /start with \$/);

  // Sensitive key rejection
  assert.match(validateAttributes({ user_password: 'secret' }) ?? '', /sensitive key/);
});

test('inventory builders: buildCreateResourceRequest validates required and strips forbidden', () => {
  const req = buildCreateResourceRequest({
    kind: 'host',
    name: 'host-srv-01',
    domain: 'platform',
    role: 'compute',
  });
  assert.equal(req.kind, 'host');
  assert.equal(req.name, 'host-srv-01');
  assert.equal(req.domain, 'platform');
  assert.equal(req.role, 'compute');

  // Rejects initial retired state
  assert.throws(() => {
    buildCreateResourceRequest({
      kind: 'host',
      name: 'h1',
      domain: 'cloud',
      lifecycleState: 'retired',
    });
  }, /retired/);

  // Rejects forbidden server-owned fields
  assert.throws(() => {
    buildCreateResourceRequest({
      kind: 'host',
      name: 'h1',
      domain: 'cloud',
      ...({ revision: 5 } as unknown as Record<string, unknown>),
    } as unknown as Parameters<typeof buildCreateResourceRequest>[0]);
  }, /server-owned/);

  assert.throws(() => {
    buildCreateResourceRequest({
      kind: 'host',
      name: 'h1',
      domain: 'cloud',
      labels: { 'cluster.id': 'edge' },
    });
  }, /Label key/);
});

test('inventory builders: buildUpdateResourceRequest enforces expectedRevision and structure', () => {
  const req = buildUpdateResourceRequest(2, {
    kind: 'host',
    name: 'host-srv-01-renamed',
    domain: 'platform',
    lifecycleState: 'active',
  });
  assert.equal(req.expectedRevision, 2);
  assert.equal(req.resource.name, 'host-srv-01-renamed');
  assert.equal(req.resource.lifecycleState, 'active');

  // Revision 0 rejection
  assert.throws(() => {
    buildUpdateResourceRequest(0, {
      kind: 'host',
      name: 'h1',
      domain: 'cloud',
      lifecycleState: 'active',
    });
  }, /positive integer/);

  // Negative revision rejection
  assert.throws(() => {
    buildUpdateResourceRequest(-1, {
      kind: 'host',
      name: 'h1',
      domain: 'cloud',
      lifecycleState: 'active',
    });
  }, /positive integer/);

  // Missing lifecycleState rejection
  assert.throws(() => {
    buildUpdateResourceRequest(1, {
      kind: 'host',
      name: 'h1',
      domain: 'cloud',
    });
  }, /lifecycleState is required/);

  // Retired lifecycleState via update rejection
  assert.throws(() => {
    buildUpdateResourceRequest(1, {
      kind: 'host',
      name: 'h1',
      domain: 'cloud',
      lifecycleState: 'retired',
    });
  }, /retired/);

  assert.throws(() => {
    buildUpdateResourceRequest(1, {
      kind: 'host',
      name: 'h1',
      domain: 'cloud',
      lifecycleState: 'active',
      labels: { Region: 'cn' },
    });
  }, /Label key/);
});

test('inventory builders: buildRetireResourceRequest enforces expectedRevision and reason', () => {
  const req = buildRetireResourceRequest(3, 'Decommissioning old compute node');
  assert.equal(req.expectedRevision, 3);
  assert.equal(req.reason, 'Decommissioning old compute node');

  // Revision 0 rejection
  assert.throws(() => {
    buildRetireResourceRequest(0, 'Decommissioning');
  }, /positive integer/);

  // Negative revision rejection
  assert.throws(() => {
    buildRetireResourceRequest(-1, 'Decommissioning');
  }, /positive integer/);

  // Empty reason rejection
  assert.throws(() => {
    buildRetireResourceRequest(3, '   ');
  }, /reason is required/);
});

test('inventory contracts: inventory-contract.json and inventory-request-contract.json are well formed', () => {
  const invContract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../inventory-contract.json'), 'utf8'));
  assert.equal(invContract.length, 2);
  const ops = invContract.flatMap((c: { operations: unknown[] }) => c.operations);
  assert.equal(ops.length, 3);

  const reqContract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../inventory-request-contract.json'), 'utf8'));
  assert.equal(reqContract.length, 3);

  const updateContract = reqContract.find((e: { name: string }) => e.name === 'inventory resource update');
  assert.ok(updateContract);
  assert.ok(updateContract.nestedContracts?.resource);
  assert.deepEqual(updateContract.nestedContracts.resource.requiredKeys, ['kind', 'name', 'domain', 'lifecycleState']);
});
