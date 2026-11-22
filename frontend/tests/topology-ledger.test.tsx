/*
 * Topology ledger ownership contracts.
 *
 * Covers the parts of the ledger surface that can be asserted without a DOM: the
 * query identity, the cursor walk, the mutation-failure classification and the
 * rendered contracts of the extracted toolbar and body.
 *
 * Deliberately out of scope here, and proven in the browser acceptance suite
 * instead: an out-of-order read being rejected at runtime (T5), a real cursor
 * round-trip against the server (T4), and a real 409 leaving the dialog open with
 * the draft intact (T7). This runtime has no DOM, so a hook's effect ordering
 * cannot be exercised; asserting it here would be theatre.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { MutationApiError } from '../src/lib/api/mutation-client';
import {
  cursorBack,
  cursorForward,
  topologyLedgerQueryKey,
  type TopologyLedgerQuery,
} from '../src/features/topology/use-topology-ledger';
import {
  describeMutationError,
  isRevisionConflict,
} from '../src/features/topology/use-topology-edge-workflows';
import { TopologyLedgerToolbar } from '../src/features/topology/components/TopologyLedgerToolbar';
import { TopologyLedgerPanel } from '../src/features/topology/components/TopologyLedgerPanel';
import type { ResourceProjection, TopologyEdge } from '../src/features/topology/topology-types';
import { en } from '../src/lib/locales/en';

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, null, createElement(MemoryRouter, { initialEntries: ['/topology'] }, element)),
  );
}

const noop = () => undefined;

/* The opening tag of the button whose visible label is `label`. Attribute order
 * is not guaranteed in static markup, so the tag is read backwards from the
 * label instead of assuming a fixed offset. */
function buttonTagFor(markup: string, label: string): string {
  const at = markup.indexOf(`>${label}<`);
  assert.ok(at > -1, `button label not rendered: ${label}`);
  const start = markup.lastIndexOf('<button', at);
  assert.ok(start > -1, `no button element owns the label: ${label}`);
  return markup.slice(start, at);
}

const QUERY: TopologyLedgerQuery = {
  lifecycleState: 'active',
  relationshipType: '',
  fromResourceId: '',
  toResourceId: '',
};

function edge(overrides: Partial<TopologyEdge> = {}): TopologyEdge {
  return {
    edgeId: 'edge-1',
    schemaVersion: 1,
    relationshipType: 'depends_on',
    fromResourceId: 'r-from',
    toResourceId: 'r-to',
    description: 'declared dependency',
    labels: {},
    attributes: {},
    interfaceNames: ['N7'],
    lifecycleState: 'active',
    source: { kind: 'declared', system: 'xcloud', authority: 'operator' },
    revision: 3,
    createdAt: '2026-10-01T00:00:00Z',
    createdBy: 'operator1',
    updatedAt: '2026-10-02T00:00:00Z',
    updatedBy: 'operator1',
    ...overrides,
  };
}

const DIRECTORY: Record<string, ResourceProjection> = {
  'r-from': { resourceId: 'r-from', kind: 'network_function', name: 'smf-01', displayName: 'SMF 01', domain: '5gc', lifecycleState: 'active' },
  'r-to': { resourceId: 'r-to', kind: 'network_function', name: 'pcf-01', displayName: 'PCF 01', domain: '5gc', lifecycleState: 'active' },
};

/* ------------------------------------------------------------ query identity -- */

test('the query identity changes with every field that narrows the ledger', () => {
  const base = topologyLedgerQueryKey(QUERY);
  assert.equal(topologyLedgerQueryKey({ ...QUERY }), base, 'an identical query keeps the same identity');
  for (const patch of [
    { lifecycleState: 'retired' },
    { relationshipType: 'depends_on' },
    { fromResourceId: 'r-from' },
    { toResourceId: 'r-to' },
  ]) {
    assert.notEqual(
      topologyLedgerQueryKey({ ...QUERY, ...patch }),
      base,
      `a change to ${Object.keys(patch)[0]} must invalidate the cursor trail`,
    );
  }
});

/* ---------------------------------------------------------------- cursor walk -- */

test('the cursor walk records the page it leaves and returns to it', () => {
  const first = cursorForward([], undefined, 'page-2');
  assert.deepEqual(first, { history: [''], cursor: 'page-2' }, 'the first page is recorded as the empty cursor');

  const second = cursorForward(first.history, first.cursor, 'page-3');
  assert.deepEqual(second, { history: ['', 'page-2'], cursor: 'page-3' });

  const backOne = cursorBack(second.history);
  assert.deepEqual(backOne, { history: [''], cursor: 'page-2' }, 'one step back re-requests the previous cursor');

  const backToFirst = cursorBack(backOne?.history ?? []);
  assert.deepEqual(
    backToFirst,
    { history: [], cursor: undefined },
    'the first page is the absence of a cursor, never an empty cursor parameter',
  );
  assert.equal(cursorBack([]), null, 'there is nothing before the first page');
});

/* ------------------------------------------------------ mutation classification -- */

test('a revision conflict is recognised and never treated as a transport error', () => {
  assert.equal(isRevisionConflict(new MutationApiError(409, 'conflict', null, 'TOPOLOGY_REVISION_CONFLICT')), true);
  assert.equal(isRevisionConflict(new MutationApiError(500, 'boom')), false);
  assert.equal(isRevisionConflict(new Error('network')), false);
  assert.equal(isRevisionConflict(undefined), false);
});

test('each governed mutation error maps to its operator-facing reason', () => {
  const t = (key: string) => key;
  const cases: Array<[string, number, string]> = [
    ['TOPOLOGY_DUPLICATE_ACTIVE_EDGE', 409, 'topology_duplicate_edge'],
    ['TOPOLOGY_SELF_EDGE', 400, 'topology_self_edge'],
    ['TOPOLOGY_ENDPOINT_RETIRED', 409, 'topology_endpoint_retired'],
    ['TOPOLOGY_ENDPOINT_NOT_FOUND', 404, 'topology_endpoint_not_found'],
    ['TOPOLOGY_REVISION_CONFLICT', 409, 'topology_stale_revision_body'],
    ['TOPOLOGY_EDGE_RETIRED', 409, 'topology_edge_retired'],
  ];
  for (const [code, status, expected] of cases) {
    assert.equal(describeMutationError(new MutationApiError(status, 'raw', null, code), t), expected, code);
  }
  assert.equal(
    describeMutationError(new MutationApiError(403, 'Forbidden'), t),
    'topology_permission_denied',
    'a forbidden mutation is stated as a permission problem, not as the raw body',
  );
  assert.equal(describeMutationError(new Error('socket closed'), t), 'socket closed', 'an unknown failure keeps its message');
});

/* ------------------------------------------------------------------ toolbar -- */

function toolbar(overrides: Record<string, unknown> = {}) {
  return render(
    createElement(TopologyLedgerToolbar, {
      meta: {
        schemaVersion: 1,
        relationshipTypes: ['depends_on', 'connects_to'],
        lifecycleStates: ['active', 'retired'],
        interfaceCatalog: [],
      },
      relationshipType: '',
      lifecycleState: 'active',
      fromResourceId: '',
      toResourceId: '',
      readAt: '',
      loading: false,
      activeFilters: [],
      onRelationshipChange: noop,
      onLifecycleChange: noop,
      onFromChange: noop,
      onToChange: noop,
      onClearFilters: noop,
      ...overrides,
    } as never),
  );
}

test('the toolbar renders the accepted filter vocabulary and its disclosure', () => {
  const markup = toolbar();
  assert.ok(markup.includes(en.topology_relationship), 'the relationship filter is present');
  assert.ok(markup.includes(en.topology_lifecycle), 'the lifecycle filter is present');
  assert.ok(markup.includes(en.topology_all_relationships), 'an unfiltered relationship is the default');
  assert.ok(markup.includes(en.topology_state_active), 'the effective default lifecycle is shown');
  assert.ok(markup.includes('data-ledger-advanced-filters="true"'), 'the endpoint pickers sit behind their own disclosure');
  assert.ok(markup.includes('topology-filter-from'), 'the source endpoint picker is present');
  assert.ok(markup.includes('topology-filter-to'), 'the target endpoint picker is present');
});

test('the toolbar states when the ledger was last read, and only there', () => {
  const unknown = toolbar({ readAt: '' });
  assert.equal(
    (unknown.match(/data-freshness-mode="read"/g) ?? []).length,
    1,
    'the read time is stated exactly once',
  );
  assert.ok(unknown.includes('data-freshness="unknown"'), 'an unread ledger claims no read time');

  const read = toolbar({ readAt: '2026-10-09T12:00:00Z' });
  assert.ok(read.includes('data-freshness-mode="read"'), 'the chip stays a read-time chip');
  assert.ok(
    !read.includes('data-freshness="unknown"'),
    'a recorded read time is not reported as unknown',
  );
});

test('an applied endpoint filter is visible as a removable chip', () => {
  const markup = toolbar({
    fromResourceId: 'r-from',
    activeFilters: [{ key: 'from', label: 'From resource: SMF 01', clear: noop }],
  });
  assert.ok(markup.includes(en.topology_filter_active), 'the active filter group is announced');
  assert.ok(markup.includes('From resource: SMF 01'), 'the applied endpoint is named');
  assert.ok(
    (markup.match(/topology-filter-from/g) ?? []).length >= 1,
    'the disclosure holding that filter is still rendered',
  );
});

test('clearing filters is disabled while a read is in flight', () => {
  const idle = toolbar();
  const busy = toolbar({ loading: true });
  assert.ok(
    !buttonTagFor(idle, en.topology_clear_filters).includes('disabled'),
    'an idle ledger can be cleared',
  );
  assert.ok(
    buttonTagFor(busy, en.topology_clear_filters).includes('disabled'),
    'a read in flight blocks a second transition',
  );
});

/* -------------------------------------------------------------------- body -- */

function panel(overrides: Record<string, unknown> = {}) {
  return render(
    createElement(TopologyLedgerPanel, {
      edges: [],
      directory: DIRECTORY,
      loading: false,
      error: null,
      canPageForward: false,
      pageIndex: 1,
      canConfigure: true,
      hasFilters: false,
      caption: 'Declared relationships',
      onRetry: noop,
      onNextPage: noop,
      onPrevPage: noop,
      onCreate: noop,
      onActivateRow: noop,
      onEdit: noop,
      onRetire: noop,
      onViewResource: noop,
      ...overrides,
    } as never),
  );
}

test('a failed read is reported as a failure, never as an empty ledger', () => {
  const markup = panel({ error: 'service unavailable', edges: [] });
  assert.ok(markup.includes('service unavailable'), 'the read failure is stated');
  assert.ok(!markup.includes(en.topology_empty_title), 'a failure is not presented as "no relationships"');
  assert.ok(!markup.includes(en.topology_empty_search_title), 'a failure is not presented as "no matches"');
});

test('the empty ledger distinguishes an unfiltered queue from a filtered miss', () => {
  const unfiltered = panel({ edges: [] });
  assert.ok(unfiltered.includes(en.topology_empty_title), 'an empty ledger says there are no relationships');
  assert.ok(!unfiltered.includes(en.topology_empty_search_title), 'it is not a search miss');

  const filtered = panel({ edges: [], hasFilters: true });
  assert.ok(filtered.includes(en.topology_empty_search_title), 'a filtered miss says so');
  assert.ok(!filtered.includes(en.topology_empty_title), 'it is not the unfiltered empty state');
});

test('the first read in flight shows loading rows instead of an empty result', () => {
  const markup = panel({ edges: [], loading: true });
  assert.ok(!markup.includes(en.topology_empty_title), 'a pending read is not an empty ledger');
  assert.ok(!markup.includes(en.topology_empty_search_title), 'a pending read is not a filtered miss');
});

test('the ledger table keeps its columns, endpoint names and declared state', () => {
  const markup = panel({ edges: [edge()] });
  assert.ok(markup.includes('SMF 01') && markup.includes('PCF 01'), 'endpoints are named from the Inventory directory');
  assert.ok(markup.includes(en.topology_from_resource), 'the source column is present');
  assert.ok(markup.includes(en.topology_to_resource), 'the target column is present');
  assert.ok(markup.includes(en.topology_lifecycle), 'the lifecycle column is present');
  assert.ok(markup.includes(en.topology_declared_note), 'a declared relationship says it is declared');
  assert.ok(markup.includes('N7'), 'the declared interface name is shown');
  assert.ok(markup.includes('data-surface="ledger"'), 'the ledger opts into the compact column set');
});

test('an unresolved endpoint shows its identifier instead of a guessed name', () => {
  const markup = panel({
    edges: [edge({ toResourceId: 'r-unknown' })],
    directory: { 'r-from': DIRECTORY['r-from'] },
  });
  assert.ok(markup.includes(en.topology_unresolved_resource), 'an unresolved endpoint is labelled unresolved');
  assert.ok(!markup.includes('r-unknown</strong>'), 'no name is invented for it');
});

test('a read-only principal sees the ledger but no mutation controls', () => {
  const viewer = panel({ edges: [edge()], canConfigure: false });
  assert.ok(viewer.includes(en.topology_from_resource), 'the ledger itself is readable');
  assert.ok(!viewer.includes(`>${en.topology_retire}<`), 'retire is not offered');
  assert.ok(!viewer.includes(`>${en.edit}<`), 'edit is not offered');

  const operator = panel({ edges: [edge()], canConfigure: true });
  assert.ok(operator.includes(`>${en.topology_retire}<`), 'an operator is offered retire');
  assert.ok(operator.includes(`>${en.edit}<`), 'an operator is offered edit');
});

test('a retired relationship is labelled retired and offers no mutation', () => {
  const markup = panel({ edges: [edge({ lifecycleState: 'retired' })], canConfigure: true });
  assert.ok(markup.includes(en.topology_state_retired), 'the terminal state is labelled');
  assert.ok(!markup.includes(`>${en.topology_retire}<`), 'a retired relationship cannot be retired twice');
});

test('the pager reflects the cursor position and the server page state', () => {
  const first = panel({ edges: [edge()], pageIndex: 1, canPageForward: false });
  assert.ok(first.includes(en.topology_showing_edges.replace('{count}', '1')), 'the page size is stated');
  assert.ok(
    buttonTagFor(first, en.topology_prev_page).includes('disabled'),
    'there is no previous page from the first page',
  );
  assert.ok(
    buttonTagFor(first, en.next).includes('disabled'),
    'the next page is unavailable when the server says there is none',
  );

  const second = panel({ edges: [edge()], pageIndex: 2, canPageForward: true });
  assert.ok(!buttonTagFor(second, en.topology_prev_page).includes('disabled'), 'a later page can go back');
  assert.ok(!buttonTagFor(second, en.next).includes('disabled'), 'a later page with more data can go forward');
});
