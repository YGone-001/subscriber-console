/*
 * NF Health workspace component contracts.
 *
 * Each extracted presentation component is rendered on its own with typed props
 * and deterministic data. Nothing here reaches the network, owns a URL or starts
 * a timer: the components receive what the page projected and render it.
 *
 * What these tests prove is the rendering contract - identity, ordering, evidence
 * vocabulary, authorization-driven affordances and the explicit unavailable
 * states. Interaction (drawer, detail navigation, cursor walk, collection
 * mutation, polling and request races) is proven in the browser acceptance suite
 * against the real production build, because this runtime has no DOM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { NfHealthTargetCards } from '../src/features/nf-health/NfHealthTargetCards';
import { NfHealthTargetsTable } from '../src/features/nf-health/NfHealthTargetsTable';
import { NfHealthInterfaceMatrix } from '../src/features/nf-health/NfHealthInterfaceMatrix';
import { NfHealthFilterToolbar } from '../src/features/nf-health/NfHealthFilterToolbar';
import { readHealthFilters } from '../src/features/nf-health/nf-health-filters';
import type {
  HealthTargetSummary,
  InterfaceMatrixRow,
} from '../src/features/nf-health/nf-health-types';
import type { RuntimeComponent } from '../src/features/runtime/runtime-types';
import { en } from '../src/lib/locales/en';

function render(element: React.ReactElement, path = '/nf-health'): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(MemoryRouter, { initialEntries: [path] }, element),
    ),
  );
}

const noop = () => undefined;
const identityHref = (targetId: string) => `/nf-health/${targetId}`;

/* The opening tag of the button whose visible label is `label`. Reading the tag
 * backwards from the label is the only reliable way to assert a `disabled`
 * attribute in static markup, where attribute order is not guaranteed. */
function buttonTagFor(markup: string, label: string): string {
  const at = markup.indexOf(`>${label}<`);
  assert.ok(at > -1, `button label not rendered: ${label}`);
  const start = markup.lastIndexOf('<button', at);
  assert.ok(start > -1, `no button element owns the label: ${label}`);
  return markup.slice(start, at);
}

/* Labels of the options React marked as selected. */
function selectedOptionLabels(markup: string): string[] {
  const labels: string[] = [];
  for (const match of markup.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)) {
    if (/\bselected\b/.test(match[1])) labels.push(match[2]);
  }
  return labels;
}

function optionLabels(markup: string): string[] {
  return [...markup.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((match) => match[1]);
}

function summary(overrides: Partial<HealthTargetSummary> = {}): HealthTargetSummary {
  return {
    targetId: 'target-a',
    schemaVersion: 1,
    resourceId: 'resource-a',
    name: 'AMF core-01 metrics',
    collectorProfile: 'http_metrics',
    metricsEndpoint: 'http://127.0.0.5:9090/metrics',
    serviceUnit: 'amfd',
    serviceKind: 'process',
    collectionMode: 'scheduled',
    intervalSeconds: 120,
    enabled: true,
    domain: '5gc',
    nfType: 'AMF',
    identityState: 'inventory_authoritative',
    revision: 1,
    createdAt: '2026-10-09T06:00:00Z',
    createdBy: 'operator1',
    updatedAt: '2026-10-09T10:00:00Z',
    updatedBy: 'operator1',
    lastAttemptAt: '2026-10-09T11:00:00Z',
    lastSuccessAt: '2026-10-09T11:00:00Z',
    lastMeasuredAt: '2026-10-09T11:00:00Z',
    coverage: { l1Measured: true, l2Measured: true, l3Measured: true, l3Available: true },
    freshness: {
      state: 'fresh',
      policySeconds: 600,
      basis: 'measurement_age',
      evaluatedAt: '2026-10-09T11:01:00Z',
    },
    overallState: 'healthy',
    ...overrides,
  };
}

function matrixRow(overrides: Partial<InterfaceMatrixRow> = {}): InterfaceMatrixRow {
  return {
    targetId: 'target-a',
    name: 'AMF core-01 metrics',
    nfType: 'AMF',
    domain: '5gc',
    overallState: 'healthy',
    freshness: 'fresh',
    lastMeasuredAt: '2026-10-09T11:00:00Z',
    cells: {
      metrics: { state: 'healthy', httpStatus: 200, responseMs: 12 },
      sbi: { state: 'unhealthy', httpStatus: 503, responseMs: 8, reason: 'http_5xx' },
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------ card wall -- */

test('the card wall keeps the server order inside every domain group', () => {
  const markup = render(
    createElement(NfHealthTargetCards, {
      groups: [
        {
          domain: '5gc',
          label: '5GC',
          targets: [
            summary({ targetId: 'target-a' }),
            summary({ targetId: 'target-b', name: 'SMF core-01 metrics', nfType: 'SMF' }),
          ],
        },
        {
          domain: 'ims',
          label: 'IMS',
          targets: [summary({ targetId: 'target-c', name: 'PCSCF core-01 metrics', domain: 'ims', nfType: 'PCSCF' })],
        },
      ],
      detailHref: identityHref,
      onOpenTarget: noop,
      resolveRuntimeComponent: noop,
    }),
  );
  const first = markup.indexOf('data-nf-health-card="target-a"');
  const second = markup.indexOf('data-nf-health-card="target-b"');
  const third = markup.indexOf('data-nf-health-card="target-c"');
  assert.ok(first > -1 && second > -1 && third > -1, 'every target must render a card');
  assert.ok(first < second, 'the server order inside a domain must be preserved');
  assert.ok(second < third, 'domain groups must render in the received order');
  assert.ok(markup.indexOf('5GC') < markup.indexOf('IMS'), 'group headings follow the group order');
});

test('a card carries the target identity and the server layer evidence', () => {
  const markup = render(
    createElement(NfHealthTargetCards, {
      groups: [{ domain: '5gc', label: '5GC', targets: [summary()] }],
      detailHref: identityHref,
      onOpenTarget: noop,
      resolveRuntimeComponent: noop,
    }),
  );
  assert.ok(markup.includes('data-nf-health-card="target-a"'), 'the card is keyed by targetId');
  assert.ok(markup.includes('AMF core-01 metrics'), 'the target name is rendered');
  assert.ok(markup.includes('>AMF<'), 'the NF type is rendered');
  assert.ok(markup.includes(`L1 · ${en.nf_health_layer_measured}`), 'a measured L1 layer says measured');
  assert.ok(markup.includes(`L2 · ${en.nf_health_layer_measured}`), 'a measured L2 layer says measured');
  assert.ok(markup.includes(`L3 · ${en.nf_health_layer_measured}`), 'a measured L3 layer says measured');
  assert.ok(markup.includes(en.nf_health_state_healthy), 'the overall state comes from the server projection');
  assert.ok(markup.includes('/nf-health/target-a'), 'the card links to the detail page');
});

test('an unsupported layer is not configured and an unmeasured layer is unknown', () => {
  const markup = render(
    createElement(NfHealthTargetCards, {
      groups: [
        {
          domain: '5gc',
          label: '5GC',
          targets: [
            summary({ coverage: { l1Measured: true, l2Measured: false, l3Measured: false, l3Available: false } }),
          ],
        },
      ],
      detailHref: identityHref,
      onOpenTarget: noop,
      resolveRuntimeComponent: noop,
    }),
  );
  assert.ok(markup.includes(`L2 · ${en.nf_health_state_unknown}`), 'an attempted but absent measurement is unknown');
  assert.ok(
    markup.includes(`L3 · ${en.nf_health_state_not_configured}`),
    'a layer with no exporter is not configured, never healthy',
  );
  assert.ok(
    !markup.includes(`L3 · ${en.nf_health_layer_measured}`),
    'an unsupported layer is never reported as measured',
  );
});

test('an unavailable utilization measurement is never rendered as zero', () => {
  const markup = render(
    createElement(NfHealthTargetCards, {
      groups: [{ domain: '5gc', label: '5GC', targets: [summary()] }],
      detailHref: identityHref,
      onOpenTarget: noop,
      resolveRuntimeComponent: () => undefined,
    }),
  );
  assert.ok(markup.includes(en.ops_metric_unavailable), 'missing runtime evidence stays unavailable');
  assert.ok(!markup.includes('0%'), 'a missing measurement is never a zero percent bar');
  assert.ok(!markup.includes('role="meter"'), 'no meter is drawn without a measurement');
});

test('runtime evidence supplied by the page is rendered as measured utilization', () => {
  const runtime = {
    memoryAvailable: true,
    memoryPercent: 42,
    cpuAvailable: true,
    cpuPercent: 91,
  } as unknown as RuntimeComponent;
  const markup = render(
    createElement(NfHealthTargetCards, {
      groups: [{ domain: '5gc', label: '5GC', targets: [summary()] }],
      detailHref: identityHref,
      onOpenTarget: noop,
      resolveRuntimeComponent: () => runtime,
    }),
  );
  assert.ok(markup.includes('42%'), 'the memory measurement is rendered');
  assert.ok(markup.includes('91%'), 'the CPU measurement is rendered');
  assert.ok(markup.includes('role="meter"'), 'a real measurement draws an accessible meter');
});

/* --------------------------------------------------------- audit table -- */

test('the audit table keeps the accepted column inventory', () => {
  const markup = render(
    createElement(NfHealthTargetsTable, {
      targets: [summary()],
      canConfigure: true,
      collectingId: null,
      onCollect: noop,
      targetHref: identityHref,
      onOpenDetail: noop,
    }),
  );
  const headers = [
    en.nf_health_col_name,
    en.nf_health_col_nf_type,
    en.nf_health_col_mode,
    en.nf_health_col_l1,
    en.nf_health_col_l2,
    en.nf_health_col_l3,
    en.nf_health_col_last_measured,
    en.nf_health_evidence_freshness,
    en.nf_health_col_collection_status,
    en.nf_health_col_actions,
  ];
  let previous = -1;
  for (const header of headers) {
    const at = markup.indexOf(header);
    assert.ok(at > -1, `missing column header: ${header}`);
    assert.ok(at > previous, `column header out of order: ${header}`);
    previous = at;
  }
  assert.ok(markup.includes('target-a'), 'the target id is shown for audit');
  assert.ok(markup.includes(en.nf_health_mode_scheduled), 'the collection mode is shown');
  assert.ok(
    markup.includes(`<caption class="sr-only">${en.nf_health_targets_caption}</caption>`),
    'the table has an accessible caption',
  );
  assert.ok(markup.includes('scope="col"'), 'headers are announced as column headers');
});

test('a read-only principal gets no collection affordance', () => {
  const readOnly = render(
    createElement(NfHealthTargetsTable, {
      targets: [summary()],
      canConfigure: false,
      collectingId: null,
      onCollect: noop,
      targetHref: identityHref,
      onOpenDetail: noop,
    }),
  );
  assert.ok(
    buttonTagFor(readOnly, en.nf_health_collect_action).includes('disabled'),
    'the collection control is disabled without core.configure',
  );

  const operator = render(
    createElement(NfHealthTargetsTable, {
      targets: [summary()],
      canConfigure: true,
      collectingId: null,
      onCollect: noop,
      targetHref: identityHref,
      onOpenDetail: noop,
    }),
  );
  assert.ok(
    !buttonTagFor(operator, en.nf_health_collect_action).includes('disabled'),
    'an authorized operator can request a collection',
  );
});

test('a collection in flight cannot be fired twice', () => {
  const markup = render(
    createElement(NfHealthTargetsTable, {
      targets: [summary()],
      canConfigure: true,
      collectingId: 'target-a',
      onCollect: noop,
      targetHref: identityHref,
      onOpenDetail: noop,
    }),
  );
  assert.ok(markup.includes(en.nf_health_collecting), 'the row states that a collection is running');
  assert.ok(
    buttonTagFor(markup, en.nf_health_collecting).includes('disabled'),
    'the running collection disables its own trigger',
  );
});

test('a legacy identity is labelled instead of silently accepted', () => {
  const markup = render(
    createElement(NfHealthTargetsTable, {
      targets: [summary({ resourceId: undefined, identityState: 'legacy_unresolved' })],
      canConfigure: true,
      collectingId: null,
      onCollect: noop,
      targetHref: identityHref,
      onOpenDetail: noop,
    }),
  );
  assert.ok(markup.includes(en.nf_health_identity_legacy), 'an unbound target is labelled legacy');
});

test('freshness and the collection outcome stay independent columns', () => {
  const markup = render(
    createElement(NfHealthTargetsTable, {
      targets: [
        summary({
          targetId: 'fresh-but-failed',
          freshness: { state: 'fresh', policySeconds: 600, basis: 'measurement_age', evaluatedAt: '2026-10-09T11:01:00Z' },
          lastError: 'connection refused',
        }),
        summary({
          targetId: 'stale-but-succeeded',
          freshness: { state: 'stale', policySeconds: 60, basis: 'measurement_age', evaluatedAt: '2026-10-09T11:01:00Z' },
          lastSuccessAt: '2026-10-09T11:00:00Z',
          lastError: undefined,
        }),
        summary({
          targetId: 'never-measured',
          freshness: { state: 'not_monitored', policySeconds: 0, basis: 'no_policy', evaluatedAt: '2026-10-09T11:01:00Z' },
          lastSuccessAt: undefined,
          lastMeasuredAt: undefined,
          lastError: undefined,
        }),
      ],
      canConfigure: true,
      collectingId: null,
      onCollect: noop,
      targetHref: identityHref,
      onOpenDetail: noop,
    }),
  );
  assert.ok(markup.includes(en.nf_health_state_healthy), 'a fresh measurement keeps its healthy freshness label');
  assert.ok(markup.includes(en.nf_health_status_failed), 'the failed attempt is reported separately');
  assert.ok(markup.includes(en.nf_health_state_stale), 'a stale measurement is labelled stale');
  assert.ok(markup.includes(en.nf_health_status_success), 'the successful attempt is reported separately');
  assert.ok(markup.includes(en.nf_health_state_not_configured), 'a target with no measurement policy is not configured');
  assert.ok(markup.includes(en.nf_health_status_never), 'a target that never ran says so');
});

/* ------------------------------------------------------ interface matrix -- */

test('the matrix renders exactly the server-provided interface columns', () => {
  const markup = render(
    createElement(NfHealthInterfaceMatrix, {
      columns: ['metrics', 'sbi'],
      rows: [matrixRow()],
      detailHref: identityHref,
    }),
  );
  assert.ok(markup.includes(en.nf_health_probe_family_metrics), 'the server column is rendered');
  assert.ok(markup.includes(en.nf_health_probe_family_sbi), 'the second server column is rendered');
  assert.ok(
    !markup.includes(`>${en.nf_health_probe_family_oam}</th>`),
    'a family the server did not return is not invented',
  );
  assert.ok(
    !markup.includes(`>${en.nf_health_probe_family_health}</th>`),
    'no column is synthesized',
  );
  assert.ok(markup.includes('data-nf-health-cell="target-a:metrics"'), 'each cell is keyed by target and family');
  assert.ok(markup.includes('data-nf-health-cell="target-a:sbi"'), 'the second cell is keyed too');
});

test('a matrix cell the server did not return is not configured, never healthy', () => {
  const markup = render(
    createElement(NfHealthInterfaceMatrix, {
      columns: ['metrics', 'oam'],
      rows: [matrixRow({ cells: { metrics: { state: 'healthy' } } })],
      detailHref: identityHref,
    }),
  );
  const start = markup.indexOf('data-nf-health-cell="target-a:oam"');
  assert.ok(start > -1, 'the undeclared family still gets a cell');
  const cellBody = markup.slice(start, markup.indexOf('</td>', start));
  assert.ok(cellBody.includes(en.nf_health_state_not_configured), 'an absent interface family is not configured');
  assert.ok(!cellBody.includes(en.nf_health_state_healthy), 'an absent interface family is never healthy');
});

test('a matrix cell keeps its measurement evidence and its own state', () => {
  const markup = render(
    createElement(NfHealthInterfaceMatrix, {
      columns: ['metrics', 'sbi'],
      rows: [matrixRow()],
      detailHref: identityHref,
    }),
  );
  assert.ok(markup.includes('HTTP 503'), 'the HTTP status stays attached as evidence');
  assert.ok(markup.includes('8 ms'), 'the response time stays attached as evidence');
  assert.ok(markup.includes('http_5xx'), 'the reason stays attached as evidence');
  assert.ok(markup.includes(en.nf_health_state_unhealthy), 'the measured unhealthy state is rendered');
  assert.ok(markup.includes('data-nf-health-matrix-row="target-a"'), 'the row is keyed by target');
});

test('the matrix row links to the detail page with the list context', () => {
  const markup = render(
    createElement(NfHealthInterfaceMatrix, {
      columns: ['metrics'],
      rows: [matrixRow()],
      detailHref: (targetId) => `/nf-health/${targetId}?returnTo=%2Fnf-health%3Fview%3Dinterfaces`,
    }),
  );
  assert.ok(
    markup.includes('/nf-health/target-a?returnTo=%2Fnf-health%3Fview%3Dinterfaces'),
    'the detail link preserves the list URL',
  );
});

/* -------------------------------------------------------- filter toolbar -- */

const EMPTY_FILTERS = readHealthFilters({});

function renderToolbar(filters: ReturnType<typeof readHealthFilters>, searchInput: string, filtersActive: boolean) {
  return render(
    createElement(NfHealthFilterToolbar, {
      filters,
      searchInput,
      onSearchInputChange: noop,
      onSearchSubmit: noop,
      onFilterChange: noop,
      onClearFilters: noop,
      disabled: false,
      filtersActive,
    }),
  );
}

test('the toolbar renders the accepted URL vocabulary and nothing else', () => {
  const markup = renderToolbar(EMPTY_FILTERS, '', false);
  const labels = [
    en.nf_health_filter_enabled,
    en.nf_health_filter_domain,
    en.nf_health_filter_overall,
    en.nf_health_filter_layers,
    en.nf_health_filter_freshness,
    en.nf_health_filter_collection,
    en.nf_health_filter_sort,
  ];
  for (const label of labels) {
    assert.ok(markup.includes(label), `missing filter control: ${label}`);
  }
  assert.equal(
    (markup.match(/<select/g) ?? []).length,
    labels.length,
    'the toolbar exposes exactly the seven URL filters',
  );
  assert.ok(markup.includes('role="search"'), 'the search box is a search landmark');
  assert.ok(markup.includes(en.nf_health_search_placeholder), 'the search box is labelled');
  const options = optionLabels(markup);
  for (const outcome of [en.nf_health_enabled, en.nf_health_disabled]) {
    assert.ok(options.includes(outcome), `the collection-state filter offers ${outcome}`);
  }
  for (const state of [en.nf_health_state_degraded, en.nf_health_state_unhealthy]) {
    assert.ok(options.includes(state), `the overall-state filter offers ${state}`);
  }
  for (const freshness of [en.nf_health_freshness_fresh, en.nf_health_freshness_stale]) {
    assert.ok(options.includes(freshness), `the freshness filter offers ${freshness}`);
  }
  for (const outcome of [en.nf_health_collection_failed, en.nf_health_collection_succeeded]) {
    assert.ok(options.includes(outcome), `the collection-outcome filter offers ${outcome}`);
  }
  assert.ok(options.includes(en.nf_health_sort_risk) && options.includes(en.nf_health_sort_updated), 'both sort orders are offered');
});

test('the toolbar reflects the URL filters it was given', () => {
  const filters = readHealthFilters({
    q: 'amf',
    enabled: 'true',
    domain: '5gc',
    state: 'degraded',
    layers: 'l2',
    collection: 'failed',
    sort: 'updated',
  });
  const markup = renderToolbar(filters, 'amf', true);
  assert.ok(markup.includes('value="amf"'), 'the committed search term is rendered');
  const selected = selectedOptionLabels(markup);
  assert.ok(selected.includes(en.nf_health_enabled), 'the enabled filter is selected');
  assert.ok(selected.includes(en.ops_domain_5gc), 'the domain filter is selected');
  assert.ok(selected.includes(en.nf_health_state_degraded), 'the overall state filter is selected');
  assert.ok(selected.includes(en.nf_health_layer_l2_measured_filter), 'the layer filter is selected');
  assert.ok(selected.includes(en.nf_health_collection_failed), 'the collection filter is selected');
  assert.ok(selected.includes(en.nf_health_sort_updated), 'the sort order is selected');
  assert.ok(selected.includes(en.nf_health_filter_all_freshness), 'the untouched filter keeps its all-values option');
  assert.equal(selected.length, 7, 'every select reports exactly one selected option');
});

test('the search box renders the draft, not the committed term', () => {
  const filters = readHealthFilters({ q: 'committed' });
  const markup = renderToolbar(filters, 'committed-typing', true);
  assert.ok(markup.includes('value="committed-typing"'), 'the newer draft is what the operator sees');
  assert.ok(!markup.includes('value="committed"'), 'a late URL echo cannot replace the draft');
});

test('clearing filters is only offered when a filter is active', () => {
  const inactive = renderToolbar(EMPTY_FILTERS, '', false);
  assert.ok(
    buttonTagFor(inactive, en.nf_health_clear_filters).includes('disabled'),
    'nothing to clear, nothing to click',
  );

  const active = renderToolbar(readHealthFilters({ q: 'amf' }), 'amf', true);
  assert.ok(
    !buttonTagFor(active, en.nf_health_clear_filters).includes('disabled'),
    'an active filter can be cleared',
  );
});
