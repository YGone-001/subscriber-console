import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { UEInfoPage } from '../src/features/ue-info/UEInfoPage';
import {
  buildUEInfoPath,
  formatBandwidth,
  formatUETimestamp,
  hasUnavailableSource,
  readUEDomainFilter,
  readUEStateFilter,
  sourceLabelKey,
  ueStateToken,
} from '../src/features/ue-info/ue-info-model';
import type { UEInfo, UEInfoResponse } from '../src/features/ue-info/types';

const ue = (overrides: Partial<UEInfo> = {}): UEInfo => ({
  supi: '460020000000001',
  msisdn: '18800000001',
  sipUri: '',
  domain: 'EPS',
  rat: 'E-UTRA',
  cmState: 'idle',
  mmState: 'registered',
  pdnCount: 0,
  ...overrides,
});

test('the UE API path carries only the requested query values', () => {
  assert.equal(buildUEInfoPath(), '/api/ue-info');
  assert.equal(buildUEInfoPath({ summary: true }), '/api/ue-info?summary=1');
  assert.equal(
    buildUEInfoPath({ q: '46002', domain: '5GS', state: 'connected', limit: 50, cursor: 'MTAw' }),
    '/api/ue-info?q=46002&domain=5GS&state=connected&limit=50&cursor=MTAw',
  );
});

test('UE URL filters only accept the canonical vocabulary', () => {
  assert.equal(readUEDomainFilter('EPS'), 'EPS');
  assert.equal(readUEDomainFilter('5GS'), '5GS');
  assert.equal(readUEDomainFilter('2G'), '');
  assert.equal(readUEDomainFilter(undefined), '');
  assert.equal(readUEStateFilter('connected'), 'connected');
  assert.equal(readUEStateFilter('unknown'), 'unknown');
  assert.equal(readUEStateFilter('active'), '');
  assert.equal(readUEStateFilter(undefined), '');
});

test('bandwidth formatting never fabricates a missing measurement', () => {
  assert.equal(formatBandwidth(null), '—');
  assert.equal(formatBandwidth(undefined), '—');
  assert.equal(formatBandwidth(0), '0 bps');
  assert.equal(formatBandwidth(1_500_000), '1.5 Mbps');
  assert.equal(formatBandwidth(2_000_000_000), '2.0 Gbps');
});

test('UE state tokens follow MM before CM', () => {
  assert.equal(ueStateToken(ue()), 'registered');
  assert.equal(ueStateToken(ue({ mmState: '', cmState: 'connected' })), 'connected');
  assert.equal(ueStateToken(ue({ mmState: '', cmState: 'idle' })), 'idle');
  assert.equal(ueStateToken(ue({ mmState: '', cmState: '' })), 'unknown');
});

test('source availability and labels are deterministic', () => {
  const response = {
    sources: [
      { id: 'mme', state: 'ok', itemCount: 1 },
      { id: 'amf', state: 'unavailable', reason: 'timeout', itemCount: 0 },
    ],
  } as unknown as UEInfoResponse;
  assert.equal(hasUnavailableSource(response), true);
  assert.equal(hasUnavailableSource({ ...response, sources: [response.sources[0]] }), false);
  assert.equal(sourceLabelKey('smf_metrics'), 'ue_source_smf_metrics');
  assert.equal(sourceLabelKey('unexpected'), 'ue_source_unknown');
});

test('timestamps render as an explicit unavailable value when absent', () => {
  assert.equal(formatUETimestamp(null), '—');
  assert.equal(formatUETimestamp(0), '—');
  assert.notEqual(formatUETimestamp(1_700_000_000), '—');
});

test('the UE page renders its localized shell without network access', () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(I18nProvider, null, createElement(UEInfoPage)),
    ),
  );
  assert.ok(html.includes('UE Info'));
  assert.ok(html.includes('Total UEs'));
  assert.ok(html.includes('UE list'));
  assert.equal(html.split('data-operations-nav="workbench"').length - 1, 1, 'the workbench tab strip must render once');
  assert.equal(html.split('data-operations-refresh="page"').length - 1, 1, 'the frame owns the only refresh entry');
});
