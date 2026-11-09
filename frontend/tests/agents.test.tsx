import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AgentEvidence } from '../src/features/agents/AgentsPage';
import { bytes, metadataFromForm, metricCells, visibleComponentState } from '../src/features/agents/agents-model';
import type { AgentObservation } from '../src/features/agents/agents-api';
import { getNavigationRoute, getVisibleNavigation } from '../src/lib/navigation';

const observation: AgentObservation = {
  collectedAt: '2026-11-09T00:00:00Z', hostName: 'node-a', platform: 'linux',
  version: 'test', visibility: 'host', scanComplete: true,
  metrics: { cpuPercent: 0, memoryTotalBytes: null, memoryAvailableBytes: null, diskTotalBytes: null, diskAvailableBytes: null, uptimeSeconds: null },
  components: [{ componentId: 'mme', runtimeStatus: 'running', verified: true, primaryPid: 123, workerCount: 1, cpuPercent: null, memoryRssBytes: null }],
};

test('agent measurements preserve explicit zero and do not fill absent values', () => {
  assert.deepEqual(metricCells(observation.metrics), { cpu: '0.0%', memory: null, disk: null });
  assert.equal(bytes(null), null);
  assert.equal(bytes(0), '0 B');
  assert.equal(metricCells({ ...observation.metrics, memoryTotalBytes: 1024, memoryAvailableBytes: 2048 }).memory, null);
});

test('disconnected collector evidence never turns the last running NF into stopped', () => {
  assert.equal(visibleComponentState(observation, 'stale', 'running'), 'stale');
  assert.equal(visibleComponentState({ ...observation, scanComplete: false }, 'fresh', 'stopped'), 'unknown');
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(AgentEvidence, { observation, freshness: 'stale' })));
  assert.match(html, /data-state="stale"/);
  assert.doesNotMatch(html, /data-state="stopped"/);
  assert.match(html, /123/);
  assert.match(html, /0\.0%/);
});

test('operator assignment preserves PLMN leading zeroes and does not derive identity from host labels', () => {
  const form = new FormData();
  form.set('name', 'Node A'); form.set('networkKey', 'partner-a');
  form.set('plmns', '00101, 001001');
  const request = metadataFromForm(form);
  assert.deepEqual(request.scope.plmns, ['00101', '001001']);
  assert.equal(request.scope.hostResourceId, '');
  assert.equal(request.scope.siteResourceId, '');
  assert.equal('agentId' in request, false);
});

test('agent management and machine transport have separate declared authentication', () => {
  const contract = JSON.parse(readFileSync(new URL('../agents-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.machineCookieFallback, false);
  assert.equal(contract.inventoryWrites, false);
  assert.equal(contract.businessWrites, false);
  assert.equal(contract.freshActorRequired, true);
  assert.equal(contract.managementWriteCapability, 'user_admin');
  const source = readFileSync(new URL('../../backend/cmd/server/main.go', import.meta.url), 'utf8');
  for (const endpoint of [...contract.managementEndpoints, ...contract.machineEndpoints]) {
    assert.ok(source.includes(`mux.Handle("${endpoint}"`), endpoint);
  }
});

test('agent routes are reachable from the existing platform navigation for all read roles', () => {
  for (const role of ['admin', 'operator', 'viewer'] as const) {
    assert.ok(getVisibleNavigation(role).some((route) => route.route === '/agents'));
  }
  assert.equal(getNavigationRoute('/agents/node-id')?.route, '/agents/:agentId');
});
