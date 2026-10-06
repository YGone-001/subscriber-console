/*
 * OCS shared component pack: presentation fixtures.
 *
 * These are the states the ported OCS components must render. They are rendered
 * server-side from fixtures, with `fetch` replaced by a throwing stub, so the
 * suite proves two things at once: every state renders, and none of them reaches
 * for the network. Data access belongs to the read client, never to a
 * presentational component.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import OcsStatusBadge from '../src/components/ocs/common/OcsStatusBadge';
import OcsConfirmDialog from '../src/components/ocs/common/ConfirmDialog';
import OcsDetailDrawer from '../src/components/ocs/OcsDetailDrawer';
import OcsPageShell from '../src/components/ocs/OcsPageShell';

/** Render inside the i18n provider and fail the test if anything calls fetch. */
function render(element: ReactElement): string {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('a presentational OCS component must not call fetch');
  }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(createElement(I18nProvider, null, element));
    assert.equal(calls, 0, 'rendering must not perform any network access');
    return markup;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* --------------------------------------------------------- status badge -- */

test('the status badge maps every supported lifecycle status to its own class', () => {
  const cases: Array<[string, string]> = [
    ['active', 'ocs-status-active'],
    ['suspended', 'ocs-status-suspended'],
    ['disabled', 'ocs-status-disabled'],
    ['terminated', 'ocs-status-terminated'],
    ['pending', 'ocs-status-pending'],
    ['executing', 'ocs-status-executing'],
    ['failed', 'ocs-status-failed'],
  ];
  for (const [status, expectedClass] of cases) {
    const markup = render(createElement(OcsStatusBadge, { status }));
    assert.match(markup, /class="ocs-status-badge /, `${status} must keep the base badge class`);
    assert.match(markup, new RegExp(expectedClass), `${status} must use ${expectedClass}`);
  }
});

test('the status badge is case-insensitive and survives an unknown or empty status', () => {
  assert.match(render(createElement(OcsStatusBadge, { status: 'ACTIVE' })), /ocs-status-active/);
  const unknown = render(createElement(OcsStatusBadge, { status: 'quarantined' }));
  assert.match(unknown, /class="ocs-status-badge"/, 'an unknown status keeps only the base class');
  assert.match(unknown, /quarantined/, 'an unknown status is shown verbatim rather than blanked');

  const empty = render(createElement(OcsStatusBadge, { status: '' }));
  assert.match(empty, /class="ocs-status-badge"/);
  assert.match(empty, /aria-label="[^"]+"/, 'an empty status still carries an accessible label');
});

test('the status badge appends a caller class instead of replacing the vocabulary', () => {
  const markup = render(createElement(OcsStatusBadge, { status: 'active', className: 'ocs-inline' }));
  assert.match(markup, /class="ocs-status-badge ocs-status-active ocs-inline"/);
});

/* ------------------------------------------------------- confirm dialog -- */

test('the confirm dialog renders its title, message and both actions', () => {
  const markup = render(createElement(OcsConfirmDialog, {
    title: 'Terminate contract', message: 'This cannot be undone.',
    onConfirm: () => {}, onCancel: () => {},
  }));
  assert.match(markup, /class="ocs-dialog-overlay"/);
  assert.match(markup, /role="alertdialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /Terminate contract/);
  assert.match(markup, /This cannot be undone\./);
  assert.match(markup, /ocs-btn ocs-btn-secondary/);
  assert.match(markup, /ocs-btn ocs-btn-primary/, 'a non-danger dialog uses the primary action style');
  assert.doesNotMatch(markup, /ocs-dialog-danger-icon/, 'a non-danger dialog shows no warning icon');
});

test('the danger confirm dialog switches the action style and shows the warning icon', () => {
  const markup = render(createElement(OcsConfirmDialog, {
    title: 'Delete plan', message: 'Permanent.', danger: true, confirmLabel: 'Delete',
    onConfirm: () => {}, onCancel: () => {},
  }));
  assert.match(markup, /ocs-dialog-danger-icon/);
  assert.match(markup, /ocs-btn ocs-btn-danger/);
  assert.match(markup, /Delete/);
});

test('a loading confirm dialog disables both actions', () => {
  const markup = render(createElement(OcsConfirmDialog, {
    title: 'Suspending', message: 'In flight.', loading: true,
    onConfirm: () => {}, onCancel: () => {},
  }));
  const disabled = markup.match(/<button[^>]*\sdisabled/g) ?? [];
  assert.equal(disabled.length, 2, 'both actions must be disabled while the operation is in flight');
});

/* -------------------------------------------------------- detail drawer -- */

test('the detail drawer renders nothing without data', () => {
  const markup = render(createElement(OcsDetailDrawer, { title: 'Balance', data: null, onClose: () => {} }));
  assert.equal(markup, '', 'a null record must not open the drawer');
});

test('the detail drawer renders structured attributes and the raw payload', () => {
  const markup = render(createElement(OcsDetailDrawer, {
    title: 'Balance 417010000000001',
    data: { imsi: '417010000000001', version: 10 },
    fields: [{ label: 'IMSI', value: '417010000000001' }, { label: 'Version', value: 10 }],
    onClose: () => {},
  }));
  assert.match(markup, /ocs-drawer-backdrop/);
  assert.match(markup, /ocs-drawer-content/);
  assert.match(markup, /ocs-detail-grid/);
  assert.match(markup, /ocs-detail-item-label/);
  assert.match(markup, /ocs-detail-item-value ocs-mono/);
  assert.match(markup, /ocs-json-view/);
  assert.match(markup, /417010000000001/);
  assert.match(markup, /ocs-drawer-title/, 'the drawer keeps its titled header');
});

test('the detail drawer omits the structured section when no fields are supplied', () => {
  const markup = render(createElement(OcsDetailDrawer, {
    title: 'Contract', data: { imsi: '417010000000002' }, onClose: () => {},
  }));
  assert.doesNotMatch(markup, /ocs-detail-grid/);
  assert.match(markup, /ocs-json-view/, 'the raw payload section is always present');
});

test('the detail drawer escapes an ObjectId-shaped value instead of stringifying an object', () => {
  const markup = render(createElement(OcsDetailDrawer, {
    title: 'Contract', data: { id: { $oid: '6aacfca52bb6e37e6b08346a' } }, onClose: () => {},
  }));
  assert.doesNotMatch(markup, /\[object Object\]/);
});

/* ---------------------------------------------------------- page shell --- */

function shell(overrides: Partial<Parameters<typeof OcsPageShell>[0]> = {}) {
  return createElement(OcsPageShell, {
    eyebrow: 'OCS', title: 'Balances', description: 'OCS balance records.',
    loading: false, onRefresh: () => {},
    kpiGrid: createElement('div', { className: 'ocs-kpi-grid' }, 'kpi'),
    controls: createElement('div', { className: 'ocs-controls' }, 'controls'),
    tableContent: createElement('table', { className: 'ocs-table' }, createElement('tbody', null)),
    pagination: createElement('div', { className: 'ocs-pagination' }, 'pagination'),
    ...overrides,
  });
}

test('the page shell renders the header, controls, table slot and pagination', () => {
  const markup = render(shell());
  assert.match(markup, /class="container ocs-container"/);
  assert.match(markup, /ocs-readonly-banner/, 'the read-only notice is on by default');
  assert.match(markup, /ocs-header-actions/);
  assert.match(markup, /ocs-kpi-grid/);
  assert.match(markup, /ocs-controls/);
  assert.match(markup, /class="dash-card ocs-table-card"/);
  assert.match(markup, /ocs-table-wrapper/);
  assert.match(markup, /ocs-pagination/);
});

test('the page shell hides the read-only notice when the surface is writable', () => {
  const markup = render(shell({ readonly: false }));
  assert.doesNotMatch(markup, /ocs-readonly-banner/);
});

test('the page shell reflects a loading refresh without changing its structure', () => {
  const markup = render(shell({ loading: true }));
  assert.match(markup, /class="[^"]*spin[^"]*"/, 'the refresh affordance shows its loading state');
  assert.match(markup, /<button[^>]*disabled/, 'the refresh action is disabled while loading');
  assert.match(markup, /ocs-table-wrapper/, 'the table slot stays mounted while refreshing');
});

test('the page shell composes empty, error and forbidden state nodes without data access', () => {
  for (const [label, node] of [
    ['empty', createElement('div', { className: 'ocs-empty-state' }, 'No balance records')],
    ['error', createElement('div', { className: 'ocs-error-state' }, 'The service could not be reached')],
    ['forbidden', createElement('div', { className: 'ocs-forbidden-state' }, 'You do not have permission')],
  ] as const) {
    const markup = render(shell({ tableContent: node }));
    assert.match(markup, /ocs-table-wrapper/, `${label} state must render inside the table slot`);
    assert.ok(markup.includes(node.props.className), `${label} state node must be rendered verbatim`);
  }
});
