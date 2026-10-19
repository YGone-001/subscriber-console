/*
 * Inventory view composition tests (UX-2).
 *
 * Renders the real route from the URL and asserts operator-observable output:
 *   - the default view is the master-detail network view with a KPI strip;
 *   - the card wall is a separate view, never stacked under the table;
 *   - every view still renders exactly one tab strip and one refresh control;
 *   - no view performs network access during render.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { InventoryPage } from '../src/features/inventory/InventoryPage';

function renderInventory(path: string): string {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('an inventory view must not call fetch during render');
  }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(
            AuthProvider,
            null,
            createElement(Routes, null, createElement(Route, { path: '/inventory', element: createElement(InventoryPage) })),
          ),
        ),
      ),
    );
    assert.equal(calls, 0, 'rendering must not perform network access');
    return markup;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('the default inventory view is the master-detail network view', () => {
  const markup = renderInventory('/inventory');
  assert.ok(markup.includes('data-view-mode="network"'), 'the view switch must expose the network view');
  assert.ok(markup.includes('aria-pressed="true"'), 'the active view must be pressed');
  assert.ok(markup.includes('Resources'), 'the KPI strip must render from the summary projection');
  assert.ok(markup.includes('Network functions'), 'the network-function KPI must be explicit');
});

test('every inventory view renders exactly one tab strip and one refresh control', () => {
  for (const view of ['network', 'cards', 'assets', 'runtime']) {
    const markup = renderInventory(`/inventory?view=${view}`);
    assert.equal(
      markup.split('data-operations-refresh="page"').length - 1,
      1,
      `${view} must expose exactly one refresh control`,
    );
    assert.equal(
      markup.split('data-operations-nav="workbench"').length - 1,
      1,
      `${view} must expose exactly one tab strip`,
    );
  }
});

test('the card view is a separate view, not a second representation', () => {
  const cards = renderInventory('/inventory?view=cards');
  assert.ok(cards.includes('data-view-mode="cards"'));
  assert.ok(!cards.includes('<table'), 'the card view must not render the table as well');

  const network = renderInventory('/inventory?view=network');
  assert.ok(network.includes('data-view-mode="network"'));
  assert.ok(network.includes('data-view-mode="cards"'), 'the switch still offers the card view');
});

test('the legacy list view alias still resolves to the ledger', () => {
  const markup = renderInventory('/inventory?view=list');
  assert.ok(markup.includes('data-view-mode="assets"'), 'the ledger switch must be rendered');
  assert.ok(markup.includes('type="search"'), 'the ledger search must render');
});
