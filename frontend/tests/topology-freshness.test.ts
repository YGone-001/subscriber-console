/*
 * Source-time freshness contract.
 *
 * A topology canvas is read on demand, so the page must say when the evidence it
 * shows was produced. These assertions pin the age arithmetic, the policy
 * boundary, and the three states the chip can render: fresh, stale and unknown.
 * An unknown source time is never rendered as fresh.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { TopologyFreshnessChip } from '../src/features/topology/components/TopologyFreshnessChip';
import {
  TOPOLOGY_FRESHNESS_POLICY_SECONDS,
  freshnessState,
  parseSourceTime,
  sourceAgeSeconds,
  sourceTimeLabel,
} from '../src/features/topology/topology-freshness';

const NOW = Date.parse('2026-11-01T12:00:00Z');

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(I18nProvider, null, node));
}

test('age is measured from the server source time', () => {
  assert.equal(sourceAgeSeconds('2026-11-01T11:59:00Z', NOW), 60);
  assert.equal(sourceAgeSeconds('2026-11-01T12:00:30Z', NOW), 0, 'a future source time never reports a negative age');
  assert.equal(sourceAgeSeconds('', NOW), null);
  assert.equal(sourceAgeSeconds('not-a-date', NOW), null);
  assert.equal(parseSourceTime('2026-11-01T11:59:00Z'), Date.parse('2026-11-01T11:59:00Z'));
  assert.equal(sourceTimeLabel('2026-11-01T11:59:00Z'), '2026-11-01T11:59:00Z');
  assert.equal(sourceTimeLabel('not-a-date'), '', 'an unparsable time has no label to show');
});

test('the policy boundary is inclusive and unknown stays unknown', () => {
  assert.equal(freshnessState(null), 'unknown');
  assert.equal(freshnessState(0), 'fresh');
  assert.equal(freshnessState(TOPOLOGY_FRESHNESS_POLICY_SECONDS), 'fresh', 'the boundary itself is still inside policy');
  assert.equal(freshnessState(TOPOLOGY_FRESHNESS_POLICY_SECONDS + 1), 'stale');
});

test('the chip states the source time and its age', () => {
  const markup = render(createElement(TopologyFreshnessChip, {
    sourceTime: '2026-11-01T11:59:00Z',
    now: NOW,
  }));
  assert.ok(markup.includes('data-freshness="fresh"'));
  assert.ok(markup.includes('2026-11-01T11:59:00Z'), 'the exact server time must be visible');
  assert.ok(markup.includes('60'), 'the age must be visible');
});

test('stale evidence says to refresh before deciding', () => {
  const markup = render(createElement(TopologyFreshnessChip, {
    sourceTime: '2026-11-01T11:50:00Z',
    now: NOW,
  }));
  assert.ok(markup.includes('data-freshness="stale"'));
  assert.ok(markup.includes('stale'), 'the stale state must be explicit');
});

test('an absent source time is reported as unknown, never as fresh', () => {
  const markup = render(createElement(TopologyFreshnessChip, { sourceTime: undefined, now: NOW }));
  assert.ok(markup.includes('data-freshness="unknown"'));
  assert.ok(!markup.includes('data-freshness="fresh"'));
  assert.ok(!markup.includes('data-source-time'), 'nothing may be invented when the server sent no time');
});