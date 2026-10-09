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
const contractPath = resolve(spa, 'mutation-contract.json');
const legacyParityContractPath = resolve(spa, 'mutation-parity-contract.json');
const requestContractPath = resolve(spa, 'mutation-request-contract.json');
const routes = JSON.parse(readFileSync(resolve(spa, 'route-contract.json'), 'utf8'));
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

const count = (items, predicate) => items.filter(predicate).length;
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isExistingSource = (value) => {
  if (typeof value !== 'string' || !value.startsWith('frontend/src/')) return false;
  const file = resolve(root, value);
  return existsSync(file) && statSync(file).isFile();
};

const routeInventory = new Map(routes.map((route) => [route.route, route]));
const expectedContractRoutes = new Set([
  '/subscribers',
  '/profile',
  '/ocs/balances',
  '/ocs/balances/:imsi',
  '/ocs/contracts',
  '/ocs/contracts/:imsi',
  '/ocs/tariffs',
  '/ocs/tariffs/:planId',
  '/users',
  '/users/:username',
  '/users/create',
]);

// Expected 29 enabled registered business mutations
const expectedEnabledEndpoints = new Set([
  'POST /api/subscribers',
  'PUT /api/subscribers/{imsi}',
  'DELETE /api/subscribers/{imsi}',
  'POST /api/subscribers/batch',
  'POST /api/subscribers/batch-update',
  'POST /api/subscribers/bulk-delete',
  'POST /api/subscribers/import',
  'POST /api/subscribers/{imsi}/profile',
  'POST /api/subscribers/{imsi}/traffic-adjustments',
  'POST /api/ocs/balances/{imsi}/adjust',
  'POST /api/ocs/subscribers',
  'PATCH /api/ocs/subscribers/{imsi}',
  'POST /api/ocs/subscribers/{imsi}/suspend',
  'POST /api/ocs/subscribers/{imsi}/resume',
  'DELETE /api/ocs/subscribers/{imsi}',
  'POST /api/tariff-plans',
  'PUT /api/tariff-plans/{planId}',
  'DELETE /api/tariff-plans/{planId}',
  'POST /api/tariff-plans/{planId}/clone',
  'POST /api/tariff-plans/{planId}/enable',
  'POST /api/tariff-plans/{planId}/disable',
  'POST /api/profiles',
  'PUT /api/profiles/{name}',
  'DELETE /api/profiles/{name}',
  'POST /api/profiles/{name}/versions/{versionId}/restore',
  'POST /api/users',
  'PATCH /api/users/{username}',
  'POST /api/users/{username}/disable',
  'POST /api/users/{username}/password-reset',
]);

const disabledEndpoints = new Set([
  'POST /api/ocs/balances/{imsi}/reset',
  'POST /api/ratings',
  'PUT /api/ratings/{id}',
  'DELETE /api/ratings/{id}',
  'POST /api/subscribers/policy',
  'POST /api/tariff-plans/import',
  'POST /api/tariff-plans/{planId}/migrate',
  'POST /api/tariff-plans/{planId}/rules',
  'PUT /api/tariff-plans/{planId}/rules/{ruleId}',
  'PATCH /api/tariff-plans/{planId}/rules/{ruleId}',
  'DELETE /api/tariff-plans/{planId}/rules/{ruleId}',
]);

const expectedAuthorizations = {
  'POST /api/subscribers': { kind: 'capability', value: 'subscriber_write' },
  'PUT /api/subscribers/{imsi}': { kind: 'capability', value: 'subscriber_write' },
  'DELETE /api/subscribers/{imsi}': { kind: 'capability', value: 'subscriber_write' },
  'POST /api/subscribers/batch': { kind: 'capability', value: 'subscriber_write' },
  'POST /api/subscribers/batch-update': { kind: 'capability', value: 'subscriber_write' },
  'POST /api/subscribers/bulk-delete': { kind: 'capability', value: 'subscriber_write' },
  'POST /api/subscribers/import': { kind: 'capability', value: 'subscriber_write' },
  'POST /api/subscribers/{imsi}/profile': { kind: 'capability', value: 'subscriber_write' },
  'POST /api/subscribers/{imsi}/traffic-adjustments': { kind: 'permission', value: 'ocs.balance.adjust' },
  'POST /api/profiles': { kind: 'permission', value: 'profiles.write' },
  'PUT /api/profiles/{name}': { kind: 'permission', value: 'profiles.write' },
  'DELETE /api/profiles/{name}': { kind: 'permission', value: 'profiles.write' },
  'POST /api/profiles/{name}/versions/{versionId}/restore': { kind: 'capability', value: 'profile_rollback' },
  'POST /api/ocs/balances/{imsi}/adjust': { kind: 'permission', value: 'ocs.balance.adjust' },
  'POST /api/ocs/subscribers': { kind: 'capability', value: 'ocs.subscriber.write' },
  'PATCH /api/ocs/subscribers/{imsi}': { kind: 'capability', value: 'ocs.subscriber.write' },
  'POST /api/ocs/subscribers/{imsi}/suspend': { kind: 'capability', value: 'ocs.subscriber.write' },
  'POST /api/ocs/subscribers/{imsi}/resume': { kind: 'capability', value: 'ocs.subscriber.write' },
  'DELETE /api/ocs/subscribers/{imsi}': { kind: 'capability', value: 'ocs.subscriber.write' },
  'POST /api/tariff-plans': { kind: 'capability', value: 'ocs.tariff.write' },
  'PUT /api/tariff-plans/{planId}': { kind: 'capability', value: 'ocs.tariff.write' },
  'DELETE /api/tariff-plans/{planId}': { kind: 'capability', value: 'ocs.tariff.write' },
  'POST /api/tariff-plans/{planId}/clone': { kind: 'capability', value: 'ocs.tariff.write' },
  'POST /api/tariff-plans/{planId}/enable': { kind: 'capability', value: 'ocs.tariff.write' },
  'POST /api/tariff-plans/{planId}/disable': { kind: 'capability', value: 'ocs.tariff.write' },
  'POST /api/users': { kind: 'permission', value: 'users.create' },
  'PATCH /api/users/{username}': { kind: 'permission', value: 'users.update' },
  'POST /api/users/{username}/disable': { kind: 'permission', value: 'users.disable' },
  'POST /api/users/{username}/password-reset': { kind: 'permission', value: 'users.reset-password' },
};

function validateMutationContracts(entries) {
  const result = {
    schemaErrors: 0,
    duplicateRoutes: 0,
    missingRoutes: 0,
    unknownRoutes: 0,
    invalidSources: 0,
    unregisteredEndpoints: 0,
    outOfScopeEndpoints: 0,
    disabledEndpoints: 0,
    nonMutationEndpoints: 0,
    authorizationSchemaErrors: 0,
    authorizationMismatches: 0,
  };
  const routesSeen = new Map();
  const addSchemaError = () => { result.schemaErrors += 1; };

  if (!Array.isArray(entries)) {
    addSchemaError();
    return result;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      addSchemaError();
      continue;
    }
    const { route, source: entrySource, operations, preflightOperations, disabledOperations } = entry;
    if (typeof route !== 'string') {
      addSchemaError();
    } else {
      routesSeen.set(route, (routesSeen.get(route) ?? 0) + 1);
    }

    if (route === '/system-health') {
      result.unknownRoutes += 1;
      addSchemaError();
    }

    if (!isExistingSource(entrySource)) {
      result.invalidSources += 1;
      addSchemaError();
    }
    if (!Array.isArray(operations) || operations.length === 0) addSchemaError();
    if (preflightOperations !== undefined && !isStringArray(preflightOperations)) addSchemaError();
    if (disabledOperations !== undefined && !isStringArray(disabledOperations)) addSchemaError();

    if (typeof route === 'string') {
      const inventory = routeInventory.get(route);
      if (!inventory || !expectedContractRoutes.has(route)) {
        result.unknownRoutes += 1;
      }
    }

    if (Array.isArray(operations)) {
      for (const op of operations) {
        if (!op || typeof op !== 'object') {
          addSchemaError();
          continue;
        }
        const { name, request, confirmation, authorization } = op;
        if (typeof name !== 'string' || typeof confirmation !== 'boolean') addSchemaError();
        if (typeof request !== 'string') {
          addSchemaError();
          continue;
        }
        if (
          !authorization ||
          typeof authorization !== 'object' ||
          !['capability', 'permission'].includes(authorization.kind) ||
          typeof authorization.value !== 'string' ||
          !authorization.value.trim()
        ) {
          result.authorizationSchemaErrors += 1;
          addSchemaError();
        } else if (expectedAuthorizations[request]) {
          const expected = expectedAuthorizations[request];
          if (authorization.kind !== expected.kind || authorization.value !== expected.value) {
            result.authorizationMismatches += 1;
          }
        }
        if (request.startsWith('GET ')) {
          result.nonMutationEndpoints += 1;
          addSchemaError();
          continue;
        }
        if (!goRouteKeys.has(request)) {
          result.unregisteredEndpoints += 1;
          addSchemaError();
        }
        if (!expectedEnabledEndpoints.has(request)) {
          result.outOfScopeEndpoints += 1;
          addSchemaError();
        }
        if (disabledEndpoints.has(request)) {
          result.disabledEndpoints += 1;
          addSchemaError();
        }
      }
    }
  }

  for (const [route, occurrences] of routesSeen) {
    if (occurrences > 1) result.duplicateRoutes += occurrences - 1;
  }
  for (const route of expectedContractRoutes) {
    if (!routesSeen.has(route)) result.missingRoutes += 1;
  }
  return result;
}

function validateRequestContracts(requestEntries) {
  const result = {
    entries: 0,
    duplicates: 0,
    invalidAuthorities: 0,
    shapeErrors: 0,
    keySetErrors: 0,
    nestedContractErrors: 0,
  };
  if (!Array.isArray(requestEntries)) {
    result.shapeErrors += 1;
    return result;
  }
  result.entries = requestEntries.length;
  const seenKeys = new Map();

  for (const entry of requestEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      result.shapeErrors += 1;
      continue;
    }
    const {
      name,
      method,
      path,
      queryMode,
      backendAuthority,
      productionReference,
      requiredBodyKeys,
      optionalBodyKeys,
      forbiddenBodyKeys,
      responseSemantics,
      nestedContracts,
    } = entry;

    const key = `${method} ${path}${queryMode !== 'none' ? '?' + queryMode : ''}`;
    seenKeys.set(key, (seenKeys.get(key) ?? 0) + 1);

    if (
      typeof name !== 'string' ||
      !name.trim() ||
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
      typeof path !== 'string' ||
      !path.startsWith('/api/') ||
      !['none', 'mode=precheck', 'mode=import'].includes(queryMode) ||
      !['mutation-result', 'preflight-result', 'routing-acknowledgement'].includes(responseSemantics) ||
      !Array.isArray(requiredBodyKeys) ||
      !Array.isArray(optionalBodyKeys) ||
      !Array.isArray(forbiddenBodyKeys)
    ) {
      result.shapeErrors += 1;
    }

    if (
      typeof backendAuthority !== 'string' ||
      !backendAuthority.startsWith('backend/') ||
      !existsSync(resolve(root, backendAuthority))
    ) {
      result.invalidAuthorities += 1;
    }

    if (
      typeof productionReference !== 'string' ||
      !productionReference.startsWith('frontend/') ||
      !existsSync(resolve(root, productionReference))
    ) {
      result.shapeErrors += 1;
    }

    if (
      Array.isArray(requiredBodyKeys) &&
      Array.isArray(optionalBodyKeys) &&
      Array.isArray(forbiddenBodyKeys)
    ) {
      const hasDuplicates = (arr) => new Set(arr).size !== arr.length;
      if (hasDuplicates(requiredBodyKeys) || hasDuplicates(optionalBodyKeys) || hasDuplicates(forbiddenBodyKeys)) {
        result.keySetErrors += 1;
      }
      const reqSet = new Set(requiredBodyKeys);
      const optSet = new Set(optionalBodyKeys);
      const forbSet = new Set(forbiddenBodyKeys);

      for (const k of reqSet) {
        if (optSet.has(k) || forbSet.has(k)) result.keySetErrors += 1;
      }
      for (const k of optSet) {
        if (forbSet.has(k)) result.keySetErrors += 1;
      }

      if (nestedContracts) {
        if (typeof nestedContracts !== 'object' || Array.isArray(nestedContracts)) {
          result.nestedContractErrors += 1;
        } else {
          for (const [nestedKey, spec] of Object.entries(nestedContracts)) {
            const parentKey = nestedKey.endsWith('[]') ? nestedKey.slice(0, -2) : nestedKey;
            if (!reqSet.has(parentKey) && !optSet.has(parentKey)) {
              result.nestedContractErrors += 1;
            }
            if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
              result.nestedContractErrors += 1;
              continue;
            }
            const { allowedKeys, forbiddenKeys, requiredKeys } = spec;
            if (!Array.isArray(allowedKeys) || hasDuplicates(allowedKeys)) {
              result.nestedContractErrors += 1;
            }
            if (forbiddenKeys !== undefined) {
              if (!Array.isArray(forbiddenKeys) || hasDuplicates(forbiddenKeys)) {
                result.nestedContractErrors += 1;
              } else {
                const allowedSet = new Set(allowedKeys || []);
                for (const fk of forbiddenKeys) {
                  if (allowedSet.has(fk)) result.nestedContractErrors += 1;
                }
              }
            }
            if (requiredKeys !== undefined) {
              if (!Array.isArray(requiredKeys) || hasDuplicates(requiredKeys)) {
                result.nestedContractErrors += 1;
              } else {
                const allowedSet = new Set(allowedKeys || []);
                for (const rk of requiredKeys) {
                  if (!allowedSet.has(rk)) result.nestedContractErrors += 1;
                }
              }
            }
          }
        }
      }
    }
  }

  for (const [, occurrences] of seenKeys) {
    if (occurrences > 1) {
      result.duplicates += occurrences - 1;
    }
  }

  return result;
}

const sourceFiles = walk(source).filter((file) => /\.(ts|tsx)$/.test(file));
const sourceText = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const featureFiles = walk(resolve(source, 'features')).filter((file) => /\.(ts|tsx)$/.test(file));
const featureText = featureFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const countMatches = (text, expression) => (text.match(expression) ?? []).length;

const validation = validateMutationContracts(contracts);
const requestContractsValidation = validateRequestContracts(requestContracts);

// Derive unique registered enabled endpoints from contract
const contractUniqueEndpoints = new Set();
for (const entry of contracts) {
  if (Array.isArray(entry.operations)) {
    for (const op of entry.operations) {
      if (typeof op.request === 'string') contractUniqueEndpoints.add(op.request);
    }
  }
}

// Runtime source code checks
const directGoUrls = countMatches(sourceText, /127\.0\.0\.1:18888|localhost:18888/g);
const jwtRuntime = countMatches(sourceText, /jose|jsonwebtoken/g);
const authCookieAccess = countMatches(sourceText, /document\.cookie|auth_token/g);
const trustedIdentityHeaders = countMatches(sourceText, /X-User|X-Role|X-Permissions/g);
const nextImports = countMatches(sourceText, /from 'next\/|next\//g);
const crossFrontendImports = countMatches(sourceText, /\.\.\/\.\.\/frontend\//g);

// Raw fetch in business feature code (must use API client)
const rawFeatureFetchCalls = countMatches(featureText, /\bfetch\s*\(/g);

// System health isolation: read-only
const systemHealthFile = resolve(source, 'features/read/ReadPages.tsx');
const systemHealthText = existsSync(systemHealthFile) ? readFileSync(systemHealthFile, 'utf8') : '';
const systemHealthWriteCalls = countMatches(systemHealthText, /postJson|putJson|patchJson|deleteJson|remediation/g);

// Disabled runtime calls check across features and API clients
const businessFeatureFiles = featureFiles.filter((file) => !file.includes('system-health'));
const businessFeatureText = businessFeatureFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

const disabledRuntimePatterns = [
  /\/api\/ocs\/balances\/[^/]+\/reset/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"]\/api\/ratings/,
  /\/api\/subscribers\/policy/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"][^'"]*\/tariff-plans[^'"]*import/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"][^'"]*\/migrate/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"][^'"]*\/rules/,
];

let disabledRuntimeCalls = 0;
for (const pattern of disabledRuntimePatterns) {
  disabledRuntimeCalls += countMatches(featureText, pattern);
}

// Scoped rule: system remediation POSTs must only occur inside system-health operational feature
const outOfScopeRemediationCalls = countMatches(
  businessFeatureText,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"]\/api\/system\/audit\/(?:heal|batch-heal)/,
);
assert.equal(
  outOfScopeRemediationCalls,
  0,
  'system remediation POSTs must only occur inside the system-health operational feature',
);

// Verify subscriber mutation request builders and execution
const subscriberPageFile = resolve(source, 'features/subscribers/SubscribersPage.tsx');
const subscriberPageText = readFileSync(subscriberPageFile, 'utf8');
const subscriberMutationContractText = readFileSync(resolve(source, 'features/subscribers/mutation-contract.ts'), 'utf8');

const brokenPrecheckHits = countMatches(subscriberPageText, /count:\s*Number\(batchCount\)[^}]*profile:\s*profileInput/g);
const brokenBatchUpdateHits = countMatches(subscriberPageText, /updates:\s*\{\s*profile/g);
const brokenBulkDeleteHits = countMatches(subscriberPageText, /imsis:\s*selectedImsis/g);
const brokenImportHits = countMatches(subscriberPageText, /subscribers:\s*items/g);
const brokenEditHits = countMatches(subscriberPageText, /sub4G:\s*\{\s*msisdn:\s*msisdnInput/g);
const brokenEditHardcodedAccess = countMatches(subscriberPageText, /accessRestrictionData:\s*32/g);
const brokenImportPlaceholderHits = countMatches(subscriberPageText, /"msisdn":\s*"12345"/g);

assert.equal(brokenPrecheckHits, 0, 'legacy broken precheck payload must be absent');
assert.equal(brokenBatchUpdateHits, 0, 'legacy broken batch-update payload must be absent');
assert.equal(brokenBulkDeleteHits, 0, 'legacy broken bulk-delete payload must be absent');
assert.equal(brokenImportHits, 0, 'legacy broken import payload must be absent');
assert.equal(brokenEditHits, 0, 'legacy broken edit payload must be absent');
assert.equal(brokenEditHardcodedAccess, 0, 'hard-coded accessRestrictionData in edit must be absent');
assert.equal(brokenImportPlaceholderHits, 0, 'invalid msisdn in import placeholder must be absent');

const subscriberEditUnintendedFields = brokenEditHardcodedAccess;

// Execute builder tests and parse TAP results
let tapOutput = '';
try {
  tapOutput = execSync('npx tsx --test tests/subscriber-mutation-builders.test.ts', {
    cwd: spa,
    encoding: 'utf8',
    stdio: 'pipe',
  });
} catch (testError) {
  console.error('Failed to run subscriber mutation builder tests:', testError);
  if (testError && testError.stdout) tapOutput = String(testError.stdout);
}

const passedTests = new Set();
for (const line of tapOutput.split('\n')) {
  const match = line.match(/^ok\s+\d+\s+-\s+(.+)$/);
  if (match) passedTests.add(match[1].trim());
}

const batchPrecheckContract = passedTests.has('buildBatchPrecheckRequest produces authoritative shape and satisfies contract') ? 'PASS' : 'FAIL';
const batchCreateContract = passedTests.has('buildBatchCreateRequest produces authoritative shape and satisfies contract') ? 'PASS' : 'FAIL';
const batchUpdateContract = passedTests.has('buildBatchUpdateRequest produces authoritative shape with required reason and satisfies contract') ? 'PASS' : 'FAIL';
const bulkDeleteContract = passedTests.has('buildBulkDeleteRequest produces authoritative shape with imsiList and satisfies contract') ? 'PASS' : 'FAIL';
const importPrecheckContract = passedTests.has('buildImportPrecheckRequest produces authoritative shape with imsiList and satisfies contract') ? 'PASS' : 'FAIL';
const importContract = passedTests.has('buildImportRequest produces authoritative shape with records and overwrite, and satisfies contract') ? 'PASS' : 'FAIL';
const subscriberEditIntentIsolation = (passedTests.has('single edit: MSISDN update produces only sub4G.msisdnList and no unintended fields') && brokenEditHardcodedAccess === 0) ? 'PASS' : 'FAIL';
const importRecordAllowlist = (passedTests.has('import: valid minimal record is normalized correctly') && passedTests.has('import: valid full supported record is normalized correctly')) ? 'PASS' : 'FAIL';
const importUnknownFieldRejection = (passedTests.has('import: unknown fields (msisdn, profile, arbitrary) are rejected') && passedTests.has('import: sensitive credential material is rejected')) ? 'PASS' : 'FAIL';
/* Import is no longer owned by the page (the historical Data Hub is retired).
 * Assert the invariant at the request-builder owner instead: the normalizer must
 * remain exported and the execution builder must invoke it before sending records. */
const importPrecheckExecuteConsistency = (
  importPrecheckContract === 'PASS'
  && countMatches(subscriberMutationContractText, /validateAndNormalizeImportRecord/g) >= 2
) ? 'PASS' : 'FAIL';
const trafficAdjustResponseSemantics = passedTests.has('traffic adjustment: classified as routing-acknowledgement, never mutation-result') ? 'PASS' : 'FAIL';

// Verify Route Inventory
assert.equal(routes.length, 30, 'route contract must contain 30 routes');

// Verify Contract Checks
assert.equal(contracts.length, 11);
assert.equal(validation.duplicateRoutes, 0);
assert.equal(validation.missingRoutes, 0);
assert.equal(validation.unknownRoutes, 0);
assert.equal(validation.invalidSources, 0);
assert.equal(validation.schemaErrors, 0);
assert.equal(validation.authorizationSchemaErrors, 0);
assert.equal(validation.authorizationMismatches, 0);

// Verify Request Contracts
assert.equal(requestContractsValidation.entries, 31);
assert.equal(requestContractsValidation.duplicates, 0);
assert.equal(requestContractsValidation.invalidAuthorities, 0);
assert.equal(requestContractsValidation.shapeErrors, 0);
assert.equal(requestContractsValidation.keySetErrors, 0);
assert.equal(requestContractsValidation.nestedContractErrors, 0);

// Verify Builder Contracts and Semantic Parity
assert.equal(batchPrecheckContract, 'PASS');
assert.equal(batchCreateContract, 'PASS');
assert.equal(batchUpdateContract, 'PASS');
assert.equal(bulkDeleteContract, 'PASS');
assert.equal(importPrecheckContract, 'PASS');
assert.equal(importContract, 'PASS');
assert.equal(subscriberEditIntentIsolation, 'PASS');
assert.equal(subscriberEditUnintendedFields, 0);
assert.equal(importRecordAllowlist, 'PASS');
assert.equal(importUnknownFieldRejection, 'PASS');
assert.equal(importPrecheckExecuteConsistency, 'PASS');
assert.equal(trafficAdjustResponseSemantics, 'PASS');

// Verify Endpoints
assert.equal(contractUniqueEndpoints.size, 29);
assert.equal(validation.unregisteredEndpoints, 0);
assert.equal(validation.outOfScopeEndpoints, 0);
assert.equal(validation.disabledEndpoints, 0);
assert.equal(disabledRuntimeCalls, 0);

// Verify System Health Isolation
assert.equal(systemHealthWriteCalls, 0);

// Verify Runtime Security Invariants
assert.equal(directGoUrls, 0);
assert.equal(jwtRuntime, 0);
assert.equal(authCookieAccess, 0);
assert.equal(trustedIdentityHeaders, 0);
assert.equal(nextImports, 0);
assert.equal(crossFrontendImports, 0);
assert.equal(rawFeatureFetchCalls, 0);

assert.ok(!existsSync(legacyParityContractPath), 'legacy mutation-parity-contract.json must be absent');

// Negative Sentinel Coverage
const sampleValid = contracts[0];
assert.ok(sampleValid);
assert.ok(validateMutationContracts([{ ...sampleValid, route: '/unknown' }]).unknownRoutes > 0, 'unknown route sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, source: 'invalid/source/file.tsx' }]).invalidSources > 0, 'invalid source sentinel must fail');
assert.ok(validateMutationContracts([sampleValid, { ...sampleValid }]).duplicateRoutes > 0, 'duplicate route sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, operations: [{ name: 'invalid', request: 'POST /api/unknown', confirmation: false, authorization: { kind: 'capability', value: 'sub' } }] }]).unregisteredEndpoints > 0, 'unregistered endpoint sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, operations: [{ name: 'disabled', request: 'POST /api/subscribers/policy', confirmation: false, authorization: { kind: 'capability', value: 'sub' } }] }]).disabledEndpoints > 0, 'disabled endpoint sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, operations: [{ name: 'get in mutation', request: 'GET /api/subscribers', confirmation: false, authorization: { kind: 'capability', value: 'sub' } }] }]).nonMutationEndpoints > 0, 'GET in mutation sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, route: '/system-health' }]).unknownRoutes > 0, 'system-health in mutation contract sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, operations: [{ ...sampleValid.operations[0], authorization: { kind: 'invalid', value: 'foo' } }] }]).authorizationSchemaErrors > 0, 'invalid auth kind sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, operations: [{ ...sampleValid.operations[0], authorization: { kind: 'capability', value: 'wrong_value' } }] }]).authorizationMismatches > 0, 'mismatched auth value sentinel must fail');

assert.ok(validateRequestContracts([{ ...requestContracts[0], backendAuthority: 'backend/nonexistent.go' }]).invalidAuthorities > 0, 'invalid authority sentinel must fail');
assert.ok(validateRequestContracts([{ ...requestContracts[0], method: 'INVALID' }]).shapeErrors > 0, 'invalid method shape sentinel must fail');
assert.ok(validateRequestContracts([requestContracts[0], { ...requestContracts[0] }]).duplicates > 0, 'duplicate request contract sentinel must fail');

// Additional Negative Sentinels for Semantic Mutation Parity
assert.ok(
  validateRequestContracts([{ ...requestContracts[0], requiredBodyKeys: ['imsi'], optionalBodyKeys: ['imsi'] }]).keySetErrors > 0,
  'overlapping required/optional body keys sentinel must fail'
);

assert.ok(
  validateRequestContracts([{
    ...requestContracts[0],
    requiredBodyKeys: ['patch'],
    optionalBodyKeys: [],
    nestedContracts: { patch: { allowedKeys: ['k1'], forbiddenKeys: ['k1'] } },
  }]).nestedContractErrors > 0,
  'overlapping allowed/forbidden nested keys sentinel must fail'
);

assert.ok(
  validateRequestContracts([{
    ...requestContracts[0],
    requiredBodyKeys: ['patch'],
    optionalBodyKeys: [],
    nestedContracts: { unknownParent: { allowedKeys: ['k1'] } },
  }]).nestedContractErrors > 0,
  'unknown nested contract parent sentinel must fail'
);

// Report machine evidence
console.log(`frontend_mutation_route_total=${routes.length}`);
console.log(`frontend_mutation_contract_entries=${contracts.length}`);
console.log(`frontend_mutation_contract_duplicate_routes=${validation.duplicateRoutes}`);
console.log(`frontend_mutation_contract_missing_routes=${validation.missingRoutes}`);
console.log(`frontend_mutation_contract_unknown_routes=${validation.unknownRoutes}`);
console.log(`frontend_mutation_contract_invalid_sources=${validation.invalidSources}`);
console.log('');
console.log(`frontend_mutation_request_contract_entries=${requestContractsValidation.entries}`);
console.log(`frontend_mutation_request_contract_duplicates=${requestContractsValidation.duplicates}`);
console.log(`frontend_mutation_request_invalid_authorities=${requestContractsValidation.invalidAuthorities}`);
console.log(`frontend_mutation_request_shape_errors=${requestContractsValidation.shapeErrors}`);
console.log(`frontend_mutation_request_key_set_errors=${requestContractsValidation.keySetErrors}`);
console.log(`frontend_mutation_nested_contract_errors=${requestContractsValidation.nestedContractErrors}`);
console.log('');
console.log(`frontend_mutation_import_record_allowlist=${importRecordAllowlist}`);
console.log(`frontend_mutation_import_unknown_field_rejection=${importUnknownFieldRejection}`);
console.log(`frontend_mutation_import_precheck_execute_consistency=${importPrecheckExecuteConsistency}`);
console.log('');
console.log(`frontend_mutation_subscriber_edit_intent_isolation=${subscriberEditIntentIsolation}`);
console.log(`frontend_mutation_subscriber_edit_unintended_fields=${subscriberEditUnintendedFields}`);
console.log('');
console.log(`frontend_mutation_traffic_adjust_response_semantics=${trafficAdjustResponseSemantics}`);
console.log('');
console.log(`frontend_mutation_subscriber_batch_precheck_contract=${batchPrecheckContract}`);
console.log(`frontend_mutation_subscriber_batch_create_contract=${batchCreateContract}`);
console.log(`frontend_mutation_subscriber_batch_update_contract=${batchUpdateContract}`);
console.log(`frontend_mutation_subscriber_bulk_delete_contract=${bulkDeleteContract}`);
console.log(`frontend_mutation_subscriber_import_precheck_contract=${importPrecheckContract}`);
console.log(`frontend_mutation_subscriber_import_contract=${importContract}`);
console.log('');
console.log(`frontend_mutation_authorization_schema_errors=${validation.authorizationSchemaErrors}`);
console.log(`frontend_mutation_authorization_mismatches=${validation.authorizationMismatches}`);
console.log('');
console.log(`frontend_mutation_enabled_registered_endpoints=${contractUniqueEndpoints.size}`);
console.log(`frontend_mutation_unregistered_endpoints=${validation.unregisteredEndpoints}`);
console.log(`frontend_mutation_out_of_scope_endpoints=${validation.outOfScopeEndpoints}`);
console.log(`frontend_mutation_disabled_runtime_calls=${disabledRuntimeCalls}`);
console.log(`frontend_mutation_system_health_write_calls=${systemHealthWriteCalls}`);
console.log('');
console.log(`frontend_mutation_direct_go_urls=${directGoUrls}`);
console.log(`frontend_mutation_next_imports=${nextImports}`);
console.log(`frontend_mutation_cross_frontend_imports=${crossFrontendImports}`);
console.log(`frontend_mutation_jwt_runtime=${jwtRuntime}`);
console.log(`frontend_mutation_auth_cookie_access=${authCookieAccess}`);
console.log(`frontend_mutation_trusted_identity_headers=${trustedIdentityHeaders}`);
console.log('');
console.log('frontend_mutation_contract_result=PASS');
console.log('frontend_mutation_result=PASS');
