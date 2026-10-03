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
const contractPath = resolve(spa, 'read-parity-contract.json');
const legacyContractPath = resolve(spa, 'read-parity-contracts.json');
const routes = JSON.parse(readFileSync(resolve(spa, 'migration-routes.json'), 'utf8'));
const contracts = JSON.parse(readFileSync(contractPath, 'utf8'));
const allowedModes = new Set(['migrated-read', 'read-parity', 'redirect']);
const expectedRedirects = {
  '/ocs': '/ocs/tariffs', '/ocs/dashboard': '/ocs/tariffs', '/ocs/sessions': '/ocs/tariffs', '/ocs/usage': '/ocs/tariffs',
  '/ocs/subscribers': '/ocs/contracts', '/rating': '/ocs/tariffs', '/rating/plans': '/ocs/tariffs', '/rating/rules': '/ocs/tariffs', '/roles': '/users',
};
const routeInventory = new Map(routes.map((route) => [route.targetRoute, route]));
const expectedContractRoutes = new Set(routes.filter((route) => route.status === 'migrated' || route.status === 'read-parity').map((route) => route.targetRoute));
const goGetRoutes = new Set(deriveGoRegistrations(root).keys.filter((key) => key.startsWith('GET ')));

const walk = (directory, files = []) => { for (const name of readdirSync(directory)) { const file = resolve(directory, name); if (statSync(file).isDirectory()) walk(file, files); else files.push(file); } return files; };
const count = (items, predicate) => items.filter(predicate).length;
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isExistingSource = (value) => {
  if (typeof value !== 'string' || !value.startsWith('frontend/src/')) return false;
  const file = resolve(root, value);
  return relative(productionSource, file) !== '' && !relative(productionSource, file).startsWith('..') && existsSync(file) && statSync(file).isFile();
};

function validateContracts(entries) {
  const result = {
    schemaErrors: 0,
    duplicateRoutes: 0,
    missingRoutes: 0,
    unknownRoutes: 0,
    invalidSources: 0,
    unregisteredGetEndpoints: 0,
    nonGetEndpoints: 0,
    deferredMutationErrors: 0,
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
    const { route, mode, source: entrySource, readEndpoints, deferredMutations, redirectTo, staticReads, sourceComponents } = entry;
    if (typeof route !== 'string') addSchemaError();
    else routesSeen.set(route, (routesSeen.get(route) ?? 0) + 1);
    if (typeof mode !== 'string' || !allowedModes.has(mode)) addSchemaError();
    if (!isExistingSource(entrySource)) {
      result.invalidSources += 1;
      addSchemaError();
    }
    if (!isStringArray(readEndpoints)) addSchemaError();
    if (!isStringArray(deferredMutations)) addSchemaError();
    if (sourceComponents !== undefined && (!isStringArray(sourceComponents) || sourceComponents.some((item) => !isExistingSource(item)))) {
      result.invalidSources += 1;
      addSchemaError();
    }
    if (staticReads !== undefined && (!isStringArray(staticReads) || staticReads.some((item) => item.startsWith('/api/')))) addSchemaError();

    if (Array.isArray(readEndpoints)) {
      for (const endpoint of readEndpoints) {
        if (typeof endpoint !== 'string') {
          addSchemaError();
          continue;
        }
        if (!endpoint.startsWith('GET ')) {
          result.nonGetEndpoints += 1;
          addSchemaError();
          continue;
        }
        if (!/^GET \/api\/[^\s]+$/.test(endpoint)) {
          addSchemaError();
          continue;
        }
        if (!goGetRoutes.has(endpoint)) result.unregisteredGetEndpoints += 1;
      }
    }

    if (mode === 'redirect') {
      if (typeof redirectTo !== 'string' || expectedRedirects[route] !== redirectTo) addSchemaError();
      if (!Array.isArray(readEndpoints) || readEndpoints.length !== 0) addSchemaError();
      if (!Array.isArray(deferredMutations) || deferredMutations.length !== 0) addSchemaError();
    } else {
      if (redirectTo !== undefined) addSchemaError();
      if (mode === 'read-parity' && (!Array.isArray(deferredMutations) || deferredMutations.length === 0)) result.deferredMutationErrors += 1;
    }

    if (typeof route === 'string') {
      const inventory = routeInventory.get(route);
      if (!inventory || !expectedContractRoutes.has(route)) result.unknownRoutes += 1;
      else if ((inventory.status === 'read-parity' && mode !== 'read-parity') || (inventory.status === 'migrated' && route === '/' && mode !== 'migrated-read') || (inventory.status === 'migrated' && route !== '/' && mode !== 'redirect')) addSchemaError();
    }
  }

  for (const [route, occurrences] of routesSeen) if (occurrences > 1) result.duplicateRoutes += occurrences - 1;
  for (const route of expectedContractRoutes) if (!routesSeen.has(route)) result.missingRoutes += 1;
  return result;
}

const sourceFiles = walk(source).filter((file) => /\.(ts|tsx)$/.test(file));
const sourceText = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const featureFiles = walk(resolve(source, 'features')).filter((file) => /\.(ts|tsx)$/.test(file));
const featureText = featureFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const countMatches = (text, expression) => (text.match(expression) ?? []).length;
const statusCount = (status) => count(routes, (route) => route.status === status);
const modeCount = (mode) => count(contracts, (contract) => contract.mode === mode);
const validation = validateContracts(contracts);
const legacyPluralContractPresent = existsSync(legacyContractPath) ? 1 : 0;
const redirects = readFileSync(resolve(source, 'router/redirects.ts'), 'utf8');
const directFetchCalls = countMatches(featureText, /\bfetch\s*\(/g);
const businessPostCalls = countMatches(featureText, /method\s*:\s*['"]POST['"]/g);
const businessPutCalls = countMatches(featureText, /method\s*:\s*['"]PUT['"]/g);
const businessPatchCalls = countMatches(featureText, /method\s*:\s*['"]PATCH['"]/g);
const businessDeleteCalls = countMatches(featureText, /method\s*:\s*['"]DELETE['"]/g);
const nextImports = countMatches(sourceText, /from 'next\/|next\//g);
const crossFrontendImports = countMatches(sourceText, /\.\.\/\.\.\/frontend\//g);
const directGoUrls = countMatches(sourceText, /127\.0\.0\.1:18888|localhost:18888/g);
const jwtRuntime = countMatches(sourceText, /jose|jsonwebtoken/g);
const authCookieAccess = countMatches(sourceText, /document\.cookie|auth_token/g);
const trustedIdentityHeaders = countMatches(sourceText, /X-User|X-Role|X-Permissions/g);

assert.equal(routes.length, 23);
assert.equal(statusCount('foundation'), 1); assert.equal(statusCount('migrated'), 10); assert.equal(statusCount('read-parity'), 11); assert.equal(statusCount('pending'), 1);
assert.equal(routes.find((route) => route.targetRoute === '/login')?.status, 'foundation');
assert.equal(routes.find((route) => route.targetRoute === '/users/create')?.status, 'pending');
for (const [from, to] of Object.entries(expectedRedirects)) assert.match(redirects, new RegExp(`'${from}': '${to}'`));
assert.equal(Object.keys(expectedRedirects).length, 9);
assert.equal(contracts.length, 21);
assert.equal(modeCount('migrated-read'), 1); assert.equal(modeCount('read-parity'), 11); assert.equal(modeCount('redirect'), 9);
for (const [key, value] of Object.entries(validation)) assert.equal(value, 0, `contract validation failed: ${key}=${value}`);
assert.equal(legacyPluralContractPresent, 0, 'legacy plural contract must be absent');

const validDashboard = contracts.find((contract) => contract.route === '/');
assert.ok(validDashboard);
assert.ok(validateContracts([{ ...validDashboard, source: undefined }]).schemaErrors > 0, 'missing source sentinel must fail');
assert.ok(validateContracts([{ ...validDashboard, readEndpoints: ['POST /api/analytics/metrics'] }]).nonGetEndpoints > 0, 'non-GET endpoint sentinel must fail');
assert.ok(validateContracts([validDashboard, { ...validDashboard }]).duplicateRoutes > 0, 'duplicate route sentinel must fail');
assert.ok(validateContracts([{ ...validDashboard, route: '/unknown' }]).unknownRoutes > 0, 'unknown route sentinel must fail');
const redirectContract = contracts.find((contract) => contract.mode === 'redirect');
assert.ok(redirectContract);
assert.ok(validateContracts([{ ...redirectContract, redirectTo: '/unknown' }]).schemaErrors > 0, 'bad redirect target sentinel must fail');

assert.equal(directFetchCalls, 0, 'business features must use the read client');
assert.equal(businessPostCalls, 0, 'business POST must be absent');
assert.equal(businessPutCalls, 0, 'business PUT must be absent');
assert.equal(businessPatchCalls, 0, 'business PATCH must be absent');
assert.equal(businessDeleteCalls, 0, 'business DELETE must be absent');
const readClient = readFileSync(resolve(source, 'lib/api/read-client.ts'), 'utf8');
assert.match(readClient, /method: 'GET'/);
for (const token of ['postJson', 'putJson', 'patchJson', 'deleteJson']) assert.ok(!readClient.includes(token), `read client exposes mutation helper: ${token}`);
assert.equal(nextImports, 0); assert.equal(crossFrontendImports, 0); assert.equal(directGoUrls, 0); assert.equal(jwtRuntime, 0); assert.equal(authCookieAccess, 0); assert.equal(trustedIdentityHeaders, 0);

console.log(`spa_read_route_total=${routes.length}`);
console.log(`spa_read_foundation_routes=${statusCount('foundation')}`);
console.log(`spa_read_migrated_routes=${statusCount('migrated')}`);
console.log(`spa_read_parity_routes=${statusCount('read-parity')}`);
console.log(`spa_read_pending_routes=${statusCount('pending')}`);
console.log(`spa_read_redirect_routes=${Object.keys(expectedRedirects).length}`);
console.log(`spa_read_contract_entries=${contracts.length}`);
console.log(`spa_read_contract_migrated_read=${modeCount('migrated-read')}`);
console.log(`spa_read_contract_read_parity=${modeCount('read-parity')}`);
console.log(`spa_read_contract_redirect=${modeCount('redirect')}`);
console.log(`spa_read_contract_schema_errors=${validation.schemaErrors}`);
console.log(`spa_read_contract_duplicate_routes=${validation.duplicateRoutes}`);
console.log(`spa_read_contract_missing_routes=${validation.missingRoutes}`);
console.log(`spa_read_contract_unknown_routes=${validation.unknownRoutes}`);
console.log(`spa_read_contract_invalid_sources=${validation.invalidSources}`);
console.log(`spa_read_contract_unregistered_get_endpoints=${validation.unregisteredGetEndpoints}`);
console.log(`spa_read_contract_non_get_endpoints=${validation.nonGetEndpoints}`);
console.log(`spa_read_contract_deferred_mutation_errors=${validation.deferredMutationErrors}`);
console.log(`spa_read_legacy_plural_contract_present=${legacyPluralContractPresent}`);
console.log(`spa_read_business_direct_fetch_calls=${directFetchCalls}`);
console.log(`spa_read_business_post_calls=${businessPostCalls}`);
console.log(`spa_read_business_put_calls=${businessPutCalls}`);
console.log(`spa_read_business_patch_calls=${businessPatchCalls}`);
console.log(`spa_read_business_delete_calls=${businessDeleteCalls}`);
console.log(`spa_read_next_imports=${nextImports}`);
console.log(`spa_read_cross_frontend_imports=${crossFrontendImports}`);
console.log(`spa_read_direct_go_urls=${directGoUrls}`);
console.log(`spa_read_jwt_runtime=${jwtRuntime}`);
console.log(`spa_read_auth_cookie_access=${authCookieAccess}`);
console.log(`spa_read_trusted_identity_headers=${trustedIdentityHeaders}`);
console.log('spa_read_parity_result=PASS');
