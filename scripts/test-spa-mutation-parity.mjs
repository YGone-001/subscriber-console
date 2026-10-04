#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spa = resolve(root, 'frontend-spa');
const source = resolve(spa, 'src');
const productionSource = resolve(root, 'frontend/src');
const contractPath = resolve(spa, 'mutation-parity-contract.json');
const routes = JSON.parse(readFileSync(resolve(spa, 'migration-routes.json'), 'utf8'));
const contracts = JSON.parse(readFileSync(contractPath, 'utf8'));
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
  return relative(productionSource, file) !== '' && !relative(productionSource, file).startsWith('..') && existsSync(file) && statSync(file).isFile();
};

const routeInventory = new Map(routes.map((route) => [route.targetRoute, route]));
const expectedContractRoutes = new Set(routes.filter((route) => route.status === 'mutation-parity').map((route) => route.targetRoute));

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
    const { route, mode, source: entrySource, operations, preflightOperations, disabledOperations } = entry;
    if (typeof route !== 'string') {
      addSchemaError();
    } else {
      routesSeen.set(route, (routesSeen.get(route) ?? 0) + 1);
    }

    if (route === '/system-health') {
      result.unknownRoutes += 1;
      addSchemaError();
    }

    if (mode !== 'mutation-parity') addSchemaError();
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
      } else if (inventory.status !== 'mutation-parity') {
        addSchemaError();
      }
    }

    if (Array.isArray(operations)) {
      for (const op of operations) {
        if (!op || typeof op !== 'object') {
          addSchemaError();
          continue;
        }
        const { name, request, confirmation } = op;
        if (typeof name !== 'string' || typeof confirmation !== 'boolean') addSchemaError();
        if (typeof request !== 'string') {
          addSchemaError();
          continue;
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

const sourceFiles = walk(source).filter((file) => /\.(ts|tsx)$/.test(file));
const sourceText = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const featureFiles = walk(resolve(source, 'features')).filter((file) => /\.(ts|tsx)$/.test(file));
const featureText = featureFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const countMatches = (text, expression) => (text.match(expression) ?? []).length;
const statusCount = (status) => count(routes, (route) => route.status === status);

const validation = validateMutationContracts(contracts);

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
const disabledRuntimePatterns = [
  /\/api\/ocs\/balances\/[^/]+\/reset/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"]\/api\/ratings/,
  /\/api\/subscribers\/policy/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"][^'"]*\/tariff-plans[^'"]*import/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"][^'"]*\/migrate/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"][^'"]*\/rules/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"]\/api\/system\/audit\/heal/,
  /(?:postJson|putJson|patchJson|deleteJson)\(['"]\/api\/system\/audit\/batch-heal/,
];

let disabledRuntimeCalls = 0;
for (const pattern of disabledRuntimePatterns) {
  disabledRuntimeCalls += countMatches(featureText, pattern);
}

// Verify Route Inventory
assert.equal(routes.length, 23);
assert.equal(statusCount('foundation'), 1);
assert.equal(statusCount('migrated'), 10);
assert.equal(statusCount('mutation-parity'), 11);
assert.equal(statusCount('read-parity'), 1);
assert.equal(statusCount('pending'), 0);

// Verify Contract Checks
assert.equal(contracts.length, 11);
assert.equal(validation.duplicateRoutes, 0);
assert.equal(validation.missingRoutes, 0);
assert.equal(validation.unknownRoutes, 0);
assert.equal(validation.invalidSources, 0);
assert.equal(validation.schemaErrors, 0);

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

// Negative Sentinel Coverage
const sampleValid = contracts[0];
assert.ok(sampleValid);
assert.ok(validateMutationContracts([{ ...sampleValid, route: '/unknown' }]).unknownRoutes > 0, 'unknown route sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, source: 'invalid/source/file.tsx' }]).invalidSources > 0, 'invalid source sentinel must fail');
assert.ok(validateMutationContracts([sampleValid, { ...sampleValid }]).duplicateRoutes > 0, 'duplicate route sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, operations: [{ name: 'invalid', request: 'POST /api/unknown', confirmation: false }] }]).unregisteredEndpoints > 0, 'unregistered endpoint sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, operations: [{ name: 'disabled', request: 'POST /api/subscribers/policy', confirmation: false }] }]).disabledEndpoints > 0, 'disabled endpoint sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, operations: [{ name: 'get in mutation', request: 'GET /api/subscribers', confirmation: false }] }]).nonMutationEndpoints > 0, 'GET in mutation sentinel must fail');
assert.ok(validateMutationContracts([{ ...sampleValid, route: '/system-health' }]).unknownRoutes > 0, 'system-health in mutation contract sentinel must fail');

// Report machine evidence
console.log(`spa_mutation_route_total=${routes.length}`);
console.log(`spa_mutation_foundation_routes=${statusCount('foundation')}`);
console.log(`spa_mutation_migrated_routes=${statusCount('migrated')}`);
console.log(`spa_mutation_parity_routes=${statusCount('mutation-parity')}`);
console.log(`spa_mutation_read_parity_routes=${statusCount('read-parity')}`);
console.log(`spa_mutation_pending_routes=${statusCount('pending')}`);
console.log('');
console.log(`spa_mutation_contract_entries=${contracts.length}`);
console.log(`spa_mutation_contract_duplicate_routes=${validation.duplicateRoutes}`);
console.log(`spa_mutation_contract_missing_routes=${validation.missingRoutes}`);
console.log(`spa_mutation_contract_unknown_routes=${validation.unknownRoutes}`);
console.log(`spa_mutation_contract_invalid_sources=${validation.invalidSources}`);
console.log('');
console.log(`spa_mutation_enabled_registered_endpoints=${contractUniqueEndpoints.size}`);
console.log(`spa_mutation_unregistered_endpoints=${validation.unregisteredEndpoints}`);
console.log(`spa_mutation_out_of_scope_endpoints=${validation.outOfScopeEndpoints}`);
console.log(`spa_mutation_disabled_runtime_calls=${disabledRuntimeCalls}`);
console.log('');
console.log(`spa_mutation_system_health_write_calls=${systemHealthWriteCalls}`);
console.log('');
console.log(`spa_mutation_direct_go_urls=${directGoUrls}`);
console.log(`spa_mutation_next_imports=${nextImports}`);
console.log(`spa_mutation_cross_frontend_imports=${crossFrontendImports}`);
console.log(`spa_mutation_jwt_runtime=${jwtRuntime}`);
console.log(`spa_mutation_auth_cookie_access=${authCookieAccess}`);
console.log(`spa_mutation_trusted_identity_headers=${trustedIdentityHeaders}`);
console.log('');
console.log('spa_mutation_result=PASS');
