import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { GroupCoverageNotice, GroupOverview } from '../src/features/groups/GroupsPage';
import { GROUP_MACHINE_PATTERN, GROUP_NETWORK_PATTERN, GROUP_TABS, groupFilter, groupSearch, mutableGroupResource, parseOperationalScopes, patchGroupSearch, reportGroupLink, type GroupSummary } from '../src/features/groups/groups-model';
import { reportQuery, reportSearch } from '../src/features/ops-reports/reports-model';
import type { Resource } from '../src/features/inventory/inventory-types';
import { groupsEn, groupsZh } from '../src/lib/locales/site-network';

test('group scope changes reset every section cursor without dropping malformed selectors', () => {
  const current = new URLSearchParams({ networkKey: 'a', plmn: 'malformed', directoryCursor: 'd', hostDirectoryCursor: 'h', networkSitesCursor: 's', arbitrary: 'untrusted' });
  for (const tab of GROUP_TABS) current.set(`${tab}Cursor`, 'old');
  const next = patchGroupSearch(current, { siteResourceId: 'site-b' });
  assert.equal(next.get('networkKey'), 'a'); assert.equal(next.get('plmn'), 'malformed'); assert.equal(next.has('arbitrary'), false);
  for (const tab of GROUP_TABS) assert.equal(next.has(`${tab}Cursor`), false);
  assert.equal(next.has('directoryCursor'), false);
  assert.equal(next.has('hostDirectoryCursor'), false); assert.equal(next.has('networkSitesCursor'), false);
  assert.equal(groupFilter(next).plmn, 'malformed');
});
test('tab navigation keeps independent cursors and resource identifiers in the URL', () => {
  const next = patchGroupSearch(new URLSearchParams('resourcesCursor=one&agentsCursor=two&siteResourceId=site-a'), { tab: 'agents' }, false);
  assert.equal(next.get('resourcesCursor'), 'one'); assert.equal(next.get('agentsCursor'), 'two'); assert.equal(next.get('siteResourceId'), 'site-a');
});
test('network declarations preserve five and six digit PLMNs and reject ambiguous input', () => {
  const declarations = parseOperationalScopes([{ networkKey: 'lab.a', operatorName: ' A ', plmns: ['00101', '001001'] }]);
  assert.deepEqual(declarations, [{ networkKey: 'lab.a', operatorName: 'A', plmns: ['00101', '001001'] }]);
  for (const value of [null, 'legacy', [{ networkKey: 'a', plmns: ['00101', '00101'] }], [{ networkKey: 'a' }, { networkKey: 'a' }], [{ networkKey: 'A' }], [{ networkKey: 'a', operatorName: 'A\n' }], [{ networkKey: 'a', secret: 'x' }]]) assert.equal(parseOperationalScopes(value), null);
});
test('resource update projection keeps unowned fields and excludes server authority', () => {
  const attributes = { future: { entries: [0, null, ''] }, xcloudOperationalScopes: [{ networkKey: 'a' }] };
  const resource = { resourceId: 'resource-a', kind: 'host', name: 'host-a', domain: 'platform', lifecycleState: 'active', revision: 3, source: { authority: 'authoritative' }, attributes, labels: { team: 'ops' }, capabilities: ['nf_health'] } as Resource;
  const mutable = mutableGroupResource(resource);
  assert.deepEqual(mutable.attributes, attributes); assert.deepEqual(mutable.labels, resource.labels); assert.equal('source' in mutable, false); assert.equal('revision' in mutable, false);
});
test('workbench links retain the same selectors through report requests and exports', () => {
  const filter = { networkKey: 'lab.a', siteResourceId: 'site-a', operatorName: 'A & B', plmn: '001001', includeRetired: '1' };
  const link = reportGroupLink(filter); const params = new URLSearchParams(link.split('?')[1]);
  const request = reportQuery(params); const serialized = new URLSearchParams(reportSearch(request));
  for (const [key, value] of Object.entries(filter)) assert.equal(serialized.get(key), value);
  assert.equal(serialized.get('period'), '24h');
  assert.equal(new URLSearchParams(reportSearch({ ...request, includeRetired: true, scopeFingerprint: 'fingerprint' })).get('includeRetired'), '1');
  assert.equal(new URLSearchParams(groupSearch(filter)).get('operatorName'), 'A & B');
});
test('partial sources and null counts are rendered honestly without synthetic zero measurements', () => {
  const summary: GroupSummary = { generatedAt: '2026-11-11T00:00:00Z', scope: { filter: {}, fingerprint: 'a', inventory: { completeness: 'partial', reason: 'scope_limit', observedCount: 1000 }, topology: { completeness: 'complete', reason: '', observedCount: 0 } }, counts: { hosts: null, monitored: null, configSources: null }, sources: { inventory: { completeness: 'partial', reason: 'scope_limit', observedCount: 1000 } }, consistency: 'eventual_across_collections', configurationScope: 'controller_local_declared_sources' };
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(GroupOverview, { summary, onTab: () => undefined })));
  assert.match(html, /Unavailable|\u4e0d\u53ef\u7528/); assert.doesNotMatch(html, /<dd>0<\/dd>/); assert.match(html, /1,000|1000/);
  const unavailable = renderToStaticMarkup(createElement(I18nProvider, null, createElement(GroupCoverageNotice, { coverage: { completeness: 'unavailable', reason: 'topology_unavailable', observedCount: 0 } })));
  assert.doesNotMatch(unavailable, /Complete read/);
});
test('group UI locale dictionaries have the same keys', () => { assert.deepEqual(Object.keys(groupsEn).sort(), Object.keys(groupsZh).sort()); });
test('native browser patterns accept literal hyphens under Unicode-set semantics', () => {
  const machine = new RegExp(`^(?:${GROUP_MACHINE_PATTERN})$`, 'v'); const network = new RegExp(`^(?:${GROUP_NETWORK_PATTERN})$`, 'v');
  assert.equal(machine.test('site-01.core:a'), true); assert.equal(machine.test('site with spaces'), false);
  assert.equal(network.test('operator-a.lab_1'), true); assert.equal(network.test('Operator-a'), false);
});
