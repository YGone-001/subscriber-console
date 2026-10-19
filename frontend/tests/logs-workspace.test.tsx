/*
 * Log workspace contracts.
 *
 * The page may only ask for a registered source; the URL builder is the one
 * place that turns the bounded filter vocabulary into a request. These tests
 * exercise that builder and the view's bounded ring, and render the page to
 * confirm it never fetches during render and never claims a connection it does
 * not have.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { LogCenterPage } from '../src/features/logs/LogCenterPage';
import { logStreamPath } from '../src/features/logs/logs-api';
import { trimLogLines } from '../src/features/logs/use-log-stream';
import { MAX_VIEW_LINES, type LogLine } from '../src/features/logs/logs-types';
import { en } from '../src/lib/locales/en';
import { zh } from '../src/lib/locales/zh';

test('the stream path carries the source and the bounded filters', () => {
  assert.equal(
    logStreamPath({ sourceId: 'amf', tailLines: 100 }),
    '/api/nf-logs/stream?sourceId=amf&tailLines=100',
  );
  assert.equal(
    logStreamPath({ sourceId: 'amf', tailLines: 200, level: 'warn', keyword: 'timeout' }),
    '/api/nf-logs/stream?sourceId=amf&tailLines=200&level=warn&keyword=timeout',
  );
  assert.equal(
    logStreamPath({ sourceId: 'amf', tailLines: 50, follow: false }),
    '/api/nf-logs/stream?sourceId=amf&tailLines=50&follow=false',
  );
});

test('the keyword is sent as literal text, never as a pattern', () => {
  assert.equal(
    logStreamPath({ sourceId: 'amf', tailLines: 100, keyword: 'a.*b' }),
    '/api/nf-logs/stream?sourceId=amf&tailLines=100&keyword=a.*b',
  );
});

test('the view ring keeps the newest lines', () => {
  const lines: LogLine[] = Array.from({ length: MAX_VIEW_LINES + 5 }, (_unused, index) => ({
    seq: index + 1,
    level: 'info',
    text: `line-${index + 1}`,
  }));
  const trimmed = trimLogLines(lines);
  assert.equal(trimmed.length, MAX_VIEW_LINES);
  assert.equal(trimmed[0].text, 'line-6');
  assert.equal(trimmed[trimmed.length - 1].text, `line-${MAX_VIEW_LINES + 5}`);
});

test('the page renders its source picker without opening a connection', () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('the log page must not fetch during render');
  }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ['/logs'] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/logs', element: createElement(LogCenterPage) }),
          ),
        ),
      ),
    );
    assert.equal(calls, 0, 'rendering must not perform network access');
    assert.ok(markup.includes('data-logs-source="true"'), 'the source picker must render');
    assert.ok(markup.includes('data-logs-status="idle"'), 'no connection may be claimed before a source is chosen');
    assert.ok(markup.includes(en.logs_loading_sources), 'the first render states that sources are still loading');
    assert.ok(!markup.includes('data-logs-viewport'), 'no viewport is mounted without a source');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('both locales define the log workspace vocabulary', () => {
  for (const key of [
    'nav_logs',
    'logs_title',
    'logs_source_label',
    'logs_level_label',
    'logs_status_live',
    'logs_status_reconnecting',
    'logs_dropped',
    'logs_discarded',
    'logs_empty_sources_bound',
    'logs_view_for_resource',
  ]) {
    assert.ok(key in en, `en locale must define ${key}`);
    assert.ok(key in zh, `zh locale must define ${key}`);
  }
});
