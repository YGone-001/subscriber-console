/*
 * Inventory route composition tests.
 *
 * Renders the real routes and asserts operator-observable output:
 *   - /inventory is the network-element overview with a table/card density switch;
 *   - density is a presentation key, not a peer task;
 *   - /inventory/assets and /inventory/runtime are independent routes;
 *   - pre-split `view=` links resolve to the canonical route without dropping
 *     filters or the cursor;
 *   - no route performs network access during render.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { InventoryPage } from '../src/features/inventory/InventoryPage';
import { InventoryAssetsPage } from '../src/features/inventory/InventoryAssetsPage';
import { InventoryRuntimePage } from '../src/features/inventory/InventoryRuntimePage';
import { inventoryLegacyRedirect } from '../src/features/inventory/inventory-view';

function renderRoute(path: string, routePath: string, element: ReactElement): string {
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
            createElement(Routes, null, createElement(Route, { path: routePath, element })),
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

const renderInventory = (path: string) => renderRoute(path, '/inventory', createElement(InventoryPage));

test('the default inventory route is the network-element overview', () => {
  const markup = renderInventory('/inventory');
  assert.ok(markup.includes('data-density="table"'), 'the density switch must expose the table');
  assert.ok(markup.includes('aria-pressed="true"'), 'the active density must be pressed');
  assert.ok(markup.includes('Resources'), 'the KPI strip must render from the summary projection');
  assert.ok(markup.includes('Network functions'), 'the network-function KPI must be explicit');
});

test('density is a presentation of the same projection', () => {
  const cards = renderInventory('/inventory?density=cards');
  assert.ok(cards.includes('data-density="cards"'), 'the card density must be selectable');
  assert.ok(!cards.includes('<table'), 'the card density must not render the table as well');

  const table = renderInventory('/inventory');
  assert.ok(table.includes('data-density="table"'));
  assert.ok(table.includes('data-density="cards"'), 'the switch still offers the card density');
});

test('the asset ledger is its own route', () => {
  const markup = renderRoute(
    '/inventory/assets',
    '/inventory/assets',
    createElement(InventoryAssetsPage),
  );
  assert.ok(markup.includes('type="search"'), 'the ledger search must render');
  assert.ok(markup.includes('data-workspace-mode="standard"'), 'the ledger keeps the standard chrome');
  assert.equal(markup.split('data-operations-nav="workbench"').length - 1, 1, 'the ledger keeps one tab strip');
  assert.equal(markup.split('data-operations-refresh="page"').length - 1, 1, 'the ledger keeps one refresh entry');
});

test('runtime observation is its own route', () => {
  const markup = renderRoute(
    '/inventory/runtime',
    '/inventory/runtime',
    createElement(InventoryRuntimePage),
  );
  assert.ok(markup.includes('Host observation'), 'the runtime surface must render');
  assert.equal(markup.split('data-operations-nav="workbench"').length - 1, 1, 'runtime keeps one tab strip');
});

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('the UI never emits pre-split inventory view links', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const redirectModule = resolve(srcDir, 'features/inventory/inventory-view.ts');
  const offenders = walkSourceFiles(srcDir).filter((file) => (
    file !== redirectModule && /\/inventory\?view=/.test(readFileSync(file, 'utf8'))
  ));
  assert.deepEqual(
    offenders,
    [],
    'only the redirect resolver may mention a pre-split inventory view link',
  );
});

test('pre-split task links resolve to the canonical routes', () => {
  assert.equal(inventoryLegacyRedirect('?view=assets'), '/inventory/assets');
  assert.equal(inventoryLegacyRedirect('?view=list'), '/inventory/assets');
  assert.equal(inventoryLegacyRedirect('?view=runtime'), '/inventory/runtime');
  assert.equal(inventoryLegacyRedirect('?view=network'), '/inventory');
  assert.equal(inventoryLegacyRedirect('?view=cards'), '/inventory?density=cards');
  assert.equal(inventoryLegacyRedirect('?view=cards&density=table'), '/inventory?density=table');
  assert.equal(inventoryLegacyRedirect('?view=assets&q=smf&kind=network_function&cursor=abc'), '/inventory/assets?q=smf&kind=network_function&cursor=abc');
  assert.equal(inventoryLegacyRedirect('?q=smf'), null, 'a link without a task value needs no redirect');
  assert.equal(inventoryLegacyRedirect('?view=unknown'), null);
});
