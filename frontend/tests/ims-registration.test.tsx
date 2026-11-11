import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { IMSIdentityEvidence, IMSSourceCard, IMSSourceSelect } from '../src/features/ims-registration/IMSRegistrationsPage';
import { clearIMSQuery, groupIMSLink, imsGroupReturn, imsQuery, patchIMSQuery, type IMSIdentity, type IMSSource } from '../src/features/ims-registration/ims-model';
import { imsEn, imsZh } from '../src/lib/locales/ims-registration';

test('IMS scope intersects the same explicit group selectors and preserves PLMN digits', () => {
  const url = groupIMSLink({ networkKey: 'a', plmn: '001001', siteResourceId: 'site-a', domain: 'ims', includeRetired: '1' }, '/inventory/groups?tab=resources&plmn=001001');
  const params = new URLSearchParams(url.split('?')[1]);
  const query = new URL(imsQuery(params), 'https://example.test');
  assert.equal(query.searchParams.get('plmn'), '001001');
  assert.equal(query.searchParams.get('siteResourceId'), 'site-a');
  assert.equal(query.searchParams.has('domain'), false);
  assert.equal(query.searchParams.has('includeRetired'), false);
  assert.equal(query.searchParams.has('returnTo'), false);
  assert.equal(imsGroupReturn(params), '/inventory/groups?tab=resources&plmn=001001');
});
test('IMS filter changes reset the cursor and discard unsupported parameters', () => {
  const next = patchIMSQuery(new URLSearchParams('cursor=old&networkKey=a&plmn=invalid&sql=unsafe'), { sourceId: 'b' });
  assert.equal(next.has('cursor'), false); assert.equal(next.has('sql'), false);
  assert.equal(next.get('plmn'), 'invalid'); assert.equal(next.get('networkKey'), 'a');
  assert.equal(imsQuery(next, true).includes('limit='), false);
});
test('group return context rejects external and cross-entity destinations', () => {
  for (const value of ['https://example.test', '//example.test', '/inventory/groups-other', '/users', '/inventory/groups?x=1\n']) assert.equal(imsGroupReturn(new URLSearchParams({ returnTo: value })), '/inventory/groups');
  const reset = clearIMSQuery(new URLSearchParams({ sourceId: 'a', q: 'alice', returnTo: '/inventory/groups?networkKey=a' }));
  assert.equal(reset.toString(), 'returnTo=%2Finventory%2Fgroups%3FnetworkKey%3Da');
});
test('source cards distinguish memory-only data and unknown evidence time', () => {
  const source = { id: 'a', name: 'Source A', persistence: 'memory_only', state: 'unavailable', reason: 'persistence_not_current', completeness: 'unavailable', readAt: null, sourceAsOf: null, freshness: 'unknown', identityState: 'not_configured' } as IMSSource;
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(IMSSourceCard, { source })));
  assert.match(html, /memory-only|\u5185\u5b58/); assert.match(html, /Unknown|\u672a\u77e5/);
  assert.doesNotMatch(html, /<dd>0<\/dd>/);
});
test('a provisioned SIP identity does not render as current registration success', () => {
  const item: IMSIdentity = { key: 'a:1', sourceId: 'a', resourceId: '', publicIdentity: 'sip:alice@ims.test', state: 'unknown', identityState: 'unmapped', bindings: [], privateIdentities: [], msisdns: [], readAt: '2026-11-11T00:00:00Z' };
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(IMSIdentityEvidence, { item })));
  assert.match(html, /Insufficient|\u8bc1\u636e\u4e0d\u8db3/); assert.doesNotMatch(html, />Registered<|>\u5df2\u6ce8\u518c</);
});
test('IMS dictionaries have matching translations for every owned key', () => { assert.deepEqual(Object.keys(imsEn).sort(), Object.keys(imsZh).sort()); });
test('a URL-selected source remains selected while its catalog is loading', () => {
  for (const sources of [[], [{ id: 'a', name: 'Source A' }, { id: 'b', name: 'Source B' }]]) {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(IMSSourceSelect, { sourceId: 'b', sources })));
    assert.match(html, /<option value="b" selected=""/);
    assert.doesNotMatch(html, /<option value="" selected=""/);
  }
});
