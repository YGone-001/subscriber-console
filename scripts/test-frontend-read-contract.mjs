#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const source = resolve(frontend, 'src');
const contractPath = resolve(frontend, 'read-contract.json');
const legacyParityContractPath = resolve(frontend, 'read-parity-contract.json');
const legacyPluralContractPath = resolve(frontend, 'read-parity-contracts.json');
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
const contracts = JSON.parse(readFileSync(contractPath, 'utf8'));
const allowedModes = new Set(['read', 'redirect']);
const expectedRedirects = {
  '/ocs': '/ocs/tariffs', '/ocs/dashboard': '/ocs/tariffs', '/ocs/sessions': '/ocs/tariffs', '/ocs/usage': '/ocs/tariffs',
  '/ocs/subscribers': '/ocs/contracts', '/rating': '/ocs/tariffs', '/rating/plans': '/ocs/tariffs', '/rating/rules': '/ocs/tariffs', '/roles': '/users',
};
const routeInventory = new Map(routes.map((route) => [route.route, route]));
const expectedContractRoutes = new Set(
  routes
    .filter((route) => route.route !== '/login' && route.route !== '/users/create')
    .map((route) => route.route)
);
const goGetRoutes = new Set(deriveGoRegistrations(root).keys.filter((key) => key.startsWith('GET ')));

const walk = (directory, files = []) => {
  if (!existsSync(directory)) return files;
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

function validateContracts(entries) {
  const result = {
    schemaErrors: 0,
    duplicateRoutes: 0,
    missingRoutes: 0,
    unknownRoutes: 0,
    invalidSources: 0,
    unregisteredGetEndpoints: 0,
    nonGetEndpoints: 0,
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
    const { route, mode, source: entrySource, readEndpoints, redirectTo, staticReads, disabledMutations } = entry;
    if (typeof route !== 'string') addSchemaError();
    else routesSeen.set(route, (routesSeen.get(route) ?? 0) + 1);
    if (typeof mode !== 'string' || !allowedModes.has(mode)) addSchemaError();
    if (!isExistingSource(entrySource)) {
      result.invalidSources += 1;
      addSchemaError();
    }
    if (!isStringArray(readEndpoints)) addSchemaError();
    if (disabledMutations !== undefined && !isStringArray(disabledMutations)) addSchemaError();
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
    } else {
      if (redirectTo !== undefined) addSchemaError();
    }

    if (typeof route === 'string') {
      const inventory = routeInventory.get(route);
      if (!inventory || !expectedContractRoutes.has(route)) result.unknownRoutes += 1;
    }
  }

  for (const [route, occurrences] of routesSeen) if (occurrences > 1) result.duplicateRoutes += occurrences - 1;
  for (const route of expectedContractRoutes) if (!routesSeen.has(route)) result.missingRoutes += 1;
  return result;
}

const sourceFiles = walk(source).filter((file) => /\.(ts|tsx)$/.test(file));
const sourceText = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const countMatches = (text, expression) => (text.match(expression) ?? []).length;
const modeCount = (mode) => count(contracts, (contract) => contract.mode === mode);
const validation = validateContracts(contracts);
const legacyParityContractPresent = existsSync(legacyParityContractPath) ? 1 : 0;
const legacyPluralContractPresent = existsSync(legacyPluralContractPath) ? 1 : 0;
const redirects = readFileSync(resolve(source, 'router/redirects.ts'), 'utf8');

const nextImports = countMatches(sourceText, /from 'next\/|next\//g);
const crossFrontendImports = countMatches(sourceText, /\.\.\/\.\.\/frontend\//g);
const directGoUrls = countMatches(sourceText, /127\.0\.0\.1:18888|localhost:18888/g);
const jwtRuntime = countMatches(sourceText, /jose|jsonwebtoken/g);
const authCookieAccess = countMatches(sourceText, /document\.cookie|auth_token/g);
const trustedIdentityHeaders = countMatches(sourceText, /X-User|X-Role|X-Permissions/g);

assert.equal(routes.length, 28, 'route contract must contain 28 routes');
for (const [from, to] of Object.entries(expectedRedirects)) assert.match(redirects, new RegExp(`'${from}': '${to}'`));
assert.equal(Object.keys(expectedRedirects).length, 9);
assert.equal(contracts.length, 26);
assert.equal(modeCount('read'), 17);
assert.equal(modeCount('redirect'), 9);
for (const [key, value] of Object.entries(validation)) assert.equal(value, 0, `contract validation failed: ${key}=${value}`);
assert.equal(legacyParityContractPresent, 0, 'legacy parity contract must be absent');
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

const readClient = readFileSync(resolve(source, 'lib/api/read-client.ts'), 'utf8');
assert.match(readClient, /method: 'GET'/);
for (const token of ['postJson', 'putJson', 'patchJson', 'deleteJson']) assert.ok(!readClient.includes(token), `read client exposes mutation helper: ${token}`);
assert.equal(nextImports, 0);
assert.equal(crossFrontendImports, 0);
assert.equal(directGoUrls, 0);
assert.equal(jwtRuntime, 0);
assert.equal(authCookieAccess, 0);
assert.equal(trustedIdentityHeaders, 0);

console.log(`frontend_read_route_total=${routes.length}`);
console.log(`frontend_read_redirect_routes=${Object.keys(expectedRedirects).length}`);
console.log(`frontend_read_contract_entries=${contracts.length}`);
console.log(`frontend_read_contract_read=${modeCount('read')}`);
console.log(`frontend_read_contract_redirect=${modeCount('redirect')}`);
console.log(`frontend_read_contract_schema_errors=${validation.schemaErrors}`);
console.log(`frontend_read_contract_duplicate_routes=${validation.duplicateRoutes}`);
console.log(`frontend_read_contract_missing_routes=${validation.missingRoutes}`);
console.log(`frontend_read_contract_unknown_routes=${validation.unknownRoutes}`);
console.log(`frontend_read_contract_invalid_sources=${validation.invalidSources}`);
console.log(`frontend_read_contract_unregistered_get_endpoints=${validation.unregisteredGetEndpoints}`);
console.log(`frontend_read_contract_non_get_endpoints=${validation.nonGetEndpoints}`);
console.log(`frontend_read_legacy_parity_contract_present=${legacyParityContractPresent}`);
console.log(`frontend_read_legacy_plural_contract_present=${legacyPluralContractPresent}`);
console.log(`frontend_read_next_imports=${nextImports}`);
console.log(`frontend_read_cross_frontend_imports=${crossFrontendImports}`);
console.log(`frontend_read_direct_go_urls=${directGoUrls}`);
console.log(`frontend_read_jwt_runtime=${jwtRuntime}`);
console.log(`frontend_read_auth_cookie_access=${authCookieAccess}`);
console.log(`frontend_read_trusted_identity_headers=${trustedIdentityHeaders}`);
console.log('frontend_read_contract_result=PASS');
console.log('frontend_read_result=PASS');
