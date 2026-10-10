#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spa = resolve(root, 'frontend');
const source = resolve(spa, 'src');
const productionSource = resolve(root, 'frontend/src');

const contractPath = resolve(spa, 'operational-contract.json');
const legacyParityContractPath = resolve(spa, 'operational-mutation-parity-contract.json');
const requestContractPath = resolve(spa, 'operational-mutation-request-contract.json');
const routesPath = resolve(spa, 'route-contract.json');

const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
const contracts = JSON.parse(readFileSync(contractPath, 'utf8'));
const requestContracts = JSON.parse(readFileSync(requestContractPath, 'utf8'));

const goRegistrations = deriveGoRegistrations(root);
const goRouteKeys = new Set(goRegistrations.keys);

const walk = (directory, files = []) => {
  for (const name of readdirSync(directory)) {
    const file = resolve(directory, name);
    if (statSync(file).isDirectory()) walk(file, files);
    else files.push(file);
  }
  return files;
};

const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const countMatches = (text, expression) => (text.match(expression) ?? []).length;

const isExistingSource = (value) => {
  if (typeof value !== 'string' || !value.startsWith('frontend/src/')) return false;
  const file = resolve(root, value);
  return existsSync(file) && statSync(file).isFile();
};

// 1. Verify Route Inventory
assert.equal(routes.length, 32, 'route contract must contain 32 routes');

const systemHealthRoute = routes.find((r) => r.route === '/system-health');
assert.ok(systemHealthRoute, 'system-health route must be present in route contract');

// 2. Validate Operational Authority Contract
function validateOperationalContracts(entries) {
  const result = {
    schemaErrors: 0,
    duplicateRoutes: 0,
    missingRoutes: 0,
    unknownRoutes: 0,
    invalidSources: 0,
    unregisteredEndpoints: 0,
    authorizationSchemaErrors: 0,
    authorizationMismatches: 0,
  };

  if (!Array.isArray(entries)) {
    result.schemaErrors += 1;
    return result;
  }

  const routesSeen = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      result.schemaErrors += 1;
      continue;
    }

    if (routesSeen.has(entry.route)) {
      result.duplicateRoutes += 1;
    }
    routesSeen.add(entry.route);

    if (entry.route !== '/system-health') {
      result.unknownRoutes += 1;
    }

    if (!isExistingSource(entry.source)) {
      result.invalidSources += 1;
    }

    if (!Array.isArray(entry.operations)) {
      result.schemaErrors += 1;
      continue;
    }
    if (entry.operations.length !== 4) {
      result.schemaErrors += 1;
    }

    for (const op of entry.operations) {
      if (!op || typeof op !== 'object') {
        result.schemaErrors += 1;
        continue;
      }

      if (typeof op.request !== 'string' || !op.request.startsWith('POST ')) {
        result.schemaErrors += 1;
      } else if (!goRouteKeys.has(op.request)) {
        result.unregisteredEndpoints += 1;
      }

      if (!op.authorization || typeof op.authorization !== 'object') {
        result.authorizationSchemaErrors += 1;
      } else {
        const auth = op.authorization;
        if (auth.kind === 'role') {
          if (!Array.isArray(auth.values) || !auth.values.includes('admin') || !auth.values.includes('operator')) {
            result.authorizationMismatches += 1;
          }
          if (auth.values.includes('viewer')) {
            result.authorizationMismatches += 1;
          }
        } else if (auth.kind === 'capability') {
          if (auth.value !== 'system_heal') {
            result.authorizationMismatches += 1;
          }
        } else {
          result.authorizationSchemaErrors += 1;
        }
      }

      if (typeof op.confirmation !== 'boolean') {
        result.schemaErrors += 1;
      }

      if (typeof op.responseSemantics !== 'string') {
        result.schemaErrors += 1;
      }

      if (typeof op.backendAuthority !== 'string' || !existsSync(resolve(root, op.backendAuthority))) {
        result.schemaErrors += 1;
      }
    }
  }

  if (!routesSeen.has('/system-health')) {
    result.missingRoutes += 1;
  }

  return result;
}

const contractValidation = validateOperationalContracts(contracts);
assert.equal(contractValidation.schemaErrors, 0);
assert.equal(contractValidation.duplicateRoutes, 0);
assert.equal(contractValidation.missingRoutes, 0);
assert.equal(contractValidation.unknownRoutes, 0);
assert.equal(contractValidation.invalidSources, 0);
assert.equal(contractValidation.unregisteredEndpoints, 0);
assert.equal(contractValidation.authorizationSchemaErrors, 0);
assert.equal(contractValidation.authorizationMismatches, 0);

// 3. Validate Operational Request Contracts
const expectedOperationalEndpoints = new Set([
  'POST /api/analytics/init',
  'POST /api/system/audit/scan',
  'POST /api/system/audit/heal',
  'POST /api/system/audit/batch-heal',
]);

function validateOperationalRequestContracts(entries) {
  const result = {
    entries: 0,
    duplicates: 0,
    invalidAuthorities: 0,
    shapeErrors: 0,
    keySetErrors: 0,
    nestedContractErrors: 0,
  };

  if (!Array.isArray(entries)) {
    result.shapeErrors += 1;
    return result;
  }

  const seen = new Set();

  for (const entry of entries) {
    result.entries += 1;
    const key = `${entry.method} ${entry.path}`;

    if (seen.has(key)) result.duplicates += 1;
    seen.add(key);

    if (!expectedOperationalEndpoints.has(key)) {
      result.shapeErrors += 1;
    }

    if (!goRouteKeys.has(key)) {
      result.shapeErrors += 1;
    }

    if (typeof entry.backendAuthority !== 'string' || !existsSync(resolve(root, entry.backendAuthority))) {
      result.invalidAuthorities += 1;
    }

    if (typeof entry.productionReference !== 'string' || !existsSync(resolve(root, entry.productionReference))) {
      result.invalidAuthorities += 1;
    }

    if (!isStringArray(entry.requiredBodyKeys) || !isStringArray(entry.optionalBodyKeys) || !isStringArray(entry.forbiddenBodyKeys)) {
      result.shapeErrors += 1;
      continue;
    }

    // Check disjoint key sets
    const reqSet = new Set(entry.requiredBodyKeys);
    const optSet = new Set(entry.optionalBodyKeys);
    const forbSet = new Set(entry.forbiddenBodyKeys);

    for (const k of reqSet) {
      if (optSet.has(k) || forbSet.has(k)) result.keySetErrors += 1;
    }
    for (const k of optSet) {
      if (forbSet.has(k)) result.keySetErrors += 1;
    }

    if (entry.nestedContracts) {
      for (const [parentKey, contract] of Object.entries(entry.nestedContracts)) {
        if (!entry.requiredBodyKeys.includes(parentKey.replace('[]', '')) && !entry.optionalBodyKeys.includes(parentKey.replace('[]', ''))) {
          result.nestedContractErrors += 1;
        }

        const nestedAllowed = new Set(contract.allowedKeys ?? []);
        const nestedForbidden = new Set(contract.forbiddenKeys ?? []);

        for (const k of nestedAllowed) {
          if (nestedForbidden.has(k)) result.nestedContractErrors += 1;
        }
      }
    }
  }

  return result;
}

const reqValidation = validateOperationalRequestContracts(requestContracts);
assert.equal(reqValidation.entries, 4);
assert.equal(reqValidation.duplicates, 0);
assert.equal(reqValidation.invalidAuthorities, 0);
assert.equal(reqValidation.shapeErrors, 0);
assert.equal(reqValidation.keySetErrors, 0);
assert.equal(reqValidation.nestedContractErrors, 0);

// 4. Source inspection in features/system-health/
const systemHealthFeatureDir = resolve(source, 'features/system-health');
assert.ok(existsSync(systemHealthFeatureDir), 'features/system-health directory must exist');

const systemHealthFiles = walk(systemHealthFeatureDir).filter((f) => /\.(ts|tsx)$/.test(f));
assert.ok(systemHealthFiles.length >= 3, 'system-health feature must contain components, contract, and types');

const systemHealthSourceText = systemHealthFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

// Assertions on forbidden security patterns
assert.equal(countMatches(systemHealthSourceText, /\bfetch\s*\(/g), 0, 'raw fetch is forbidden');
assert.equal(countMatches(systemHealthSourceText, /127\.0\.0\.1:18888|localhost:18888/g), 0, 'direct Go URLs forbidden');
assert.equal(countMatches(systemHealthSourceText, /from 'next\/|next\//g), 0, 'Next.js imports forbidden');
assert.equal(countMatches(systemHealthSourceText, /\.\.\/\.\.\/frontend\//g), 0, 'cross-frontend imports forbidden');
assert.equal(countMatches(systemHealthSourceText, /jose|jsonwebtoken/g), 0, 'JWT runtime forbidden');
assert.equal(countMatches(systemHealthSourceText, /document\.cookie|auth_token/g), 0, 'auth cookie access forbidden');
assert.equal(countMatches(systemHealthSourceText, /X-User|X-Role|X-Permissions/g), 0, 'trusted identity headers forbidden');

// Generic execution prohibitions
const genericExecutionPatterns = [
  /\bssh\b/i,
  /\bscp\b/i,
  /\bexec\s*\(/i,
  /\bsystemctl\b/i,
  /\bdocker\b/i,
  /\bkubectl\b/i,
  /\bkubernetes\b/i,
  /\brestart service\b/i,
  /\breload service\b/i,
  /\bremote host\b/i,
];

let genericExecutorCalls = 0;
for (const pat of genericExecutionPatterns) {
  genericExecutorCalls += countMatches(systemHealthSourceText, pat);
}
assert.equal(genericExecutorCalls, 0, 'generic remote/system execution patterns must be absent');

assert.ok(!existsSync(legacyParityContractPath), 'legacy operational-mutation-parity-contract.json must be absent');

// 5. Run dedicated test suite to verify builders and partial-result semantics
const testOutput = execSync('npx tsx --test tests/system-health-operational.test.ts', {
  cwd: spa,
  encoding: 'utf8',
});

const passedUnitTests = new Set();
for (const line of testOutput.split('\n')) {
  const match = line.match(/^ok \d+ - (.+)$/);
  if (match) {
    passedUnitTests.add(match[1].trim());
  }
}

const analyticsInitContract = passedUnitTests.has('analytics init has no fabricated body') ? 'PASS' : 'FAIL';
const auditScanContract = (passedUnitTests.has('audit scan valid phases') && passedUnitTests.has('audit scan invalid phase rejection') && passedUnitTests.has('audit scan cursor preservation')) ? 'PASS' : 'FAIL';
const singleHealContract = (passedUnitTests.has('single heal exact body') && passedUnitTests.has('single heal optional profile') && passedUnitTests.has('single heal malformed anomaly rejection')) ? 'PASS' : 'FAIL';
const batchHealContract = (passedUnitTests.has('batch heal exact body') && passedUnitTests.has('batch heal empty-list rejection') && passedUnitTests.has('batch heal malformed-entry rejection')) ? 'PASS' : 'FAIL';
const batchPartialResultSemantics = passedUnitTests.has('batch HTTP 200 with partial failure is not treated as total success') ? 'PASS' : 'FAIL';

assert.equal(analyticsInitContract, 'PASS');
assert.equal(auditScanContract, 'PASS');
assert.equal(singleHealContract, 'PASS');
assert.equal(batchHealContract, 'PASS');
assert.equal(batchPartialResultSemantics, 'PASS');

// 6. Negative Sentinel Coverage
const validContract = contracts[0];
assert.ok(validateOperationalContracts([{ ...validContract, route: '/invalid' }]).unknownRoutes > 0, 'unknown operational route sentinel must fail');

const makeInvalidOpContract = (patch) => [{
  ...validContract,
  operations: [
    { ...validContract.operations[0], ...patch },
    ...validContract.operations.slice(1),
  ],
}];

assert.ok(validateOperationalContracts(makeInvalidOpContract({ request: 'POST /api/invalid' })).unregisteredEndpoints > 0, 'unregistered operational endpoint sentinel must fail');
assert.ok(validateOperationalContracts(makeInvalidOpContract({ authorization: { kind: 'invalid' } })).authorizationSchemaErrors > 0, 'invalid auth kind sentinel must fail');
assert.ok(validateOperationalContracts(makeInvalidOpContract({ authorization: { kind: 'role', values: ['viewer'] } })).authorizationMismatches > 0, 'viewer allowed auth mismatch sentinel must fail');

const validReqContract = requestContracts[0];
assert.ok(validateOperationalRequestContracts([{ ...validReqContract, backendAuthority: 'backend/missing.go' }]).invalidAuthorities > 0, 'missing authority sentinel must fail');
assert.ok(validateOperationalRequestContracts([{ ...validReqContract, requiredBodyKeys: ['k1'], optionalBodyKeys: ['k1'] }]).keySetErrors > 0, 'overlapping key set sentinel must fail');

// 7. Output machine evidence lines
console.log(`frontend_operational_route_total=${routes.length}`);
console.log(`frontend_operational_contract_entries=${contracts.length}`);
console.log(`frontend_operational_operation_count=${requestContracts.length}`);
console.log(`frontend_operational_registered_endpoints=4`);
console.log(`frontend_operational_unregistered_endpoints=0`);
console.log(`frontend_operational_authorization_errors=${contractValidation.authorizationSchemaErrors + contractValidation.authorizationMismatches}`);
console.log(`frontend_operational_request_contract_errors=${reqValidation.shapeErrors + reqValidation.keySetErrors}`);
console.log(`frontend_operational_nested_contract_errors=${reqValidation.nestedContractErrors}`);
console.log('');
console.log(`frontend_operational_analytics_init_contract=${analyticsInitContract}`);
console.log(`frontend_operational_audit_scan_contract=${auditScanContract}`);
console.log(`frontend_operational_single_heal_contract=${singleHealContract}`);
console.log(`frontend_operational_batch_heal_contract=${batchHealContract}`);
console.log(`frontend_operational_batch_partial_result_semantics=${batchPartialResultSemantics}`);
console.log('');
console.log(`frontend_operational_raw_fetch_calls=0`);
console.log(`frontend_operational_direct_go_urls=0`);
console.log(`frontend_operational_next_imports=0`);
console.log(`frontend_operational_cross_frontend_imports=0`);
console.log(`frontend_operational_jwt_runtime=0`);
console.log(`frontend_operational_auth_cookie_access=0`);
console.log(`frontend_operational_trusted_identity_headers=0`);
console.log(`frontend_operational_generic_executor_calls=${genericExecutorCalls}`);
console.log('');
console.log('frontend_operational_contract_result=PASS');
console.log('frontend_operational_result=PASS');
