/*
 * Reconciliation panel contract.
 *
 * The advisory diff between the configured evidence and the persisted ledger is
 * now an operator surface. These assertions pin two things: the grouping never
 * counts an unconfirmed interface as agreement, and the panel never presents a
 * truncated read as a clean topology.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { TopologyReconciliationPanel } from '../src/features/topology/components/TopologyReconciliationPanel';
import {
  reconciliationGroups,
  reconciliationSummary,
} from '../src/features/topology/live-topology-model';
import type {
  LiveReconciliation,
  LiveReconciliationItem,
  LiveTopologyResponse,
} from '../src/features/topology/live-topology-types';

function response(block: LiveReconciliation | undefined): LiveTopologyResponse {
  return { reconciliation: block } as unknown as LiveTopologyResponse;
}

function item(over: Partial<LiveReconciliationItem> = {}): LiveReconciliationItem {
  return {
    fromResourceId: 'r-smf',
    toResourceId: 'r-upf',
    fromComponentId: 'smf',
    toComponentId: 'upf',
    relationshipType: 'connects_to',
    ...over,
  };
}

function block(over: Partial<LiveReconciliation> = {}): LiveReconciliation {
  return {
    available: true,
    complete: true,
    rulesVersion: 'interface-v1',
    configuredLinks: 2,
    declaredEdges: 2,
    matchedCount: 2,
    matched: [],
    undeclaredEvidence: [],
    unevidencedDeclarations: [],
    ...over,
  };
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(I18nProvider, null, node));
}

test('an unavailable ledger produces no grouping and therefore no panel', () => {
  const unavailable = block({ available: false });
  assert.equal(reconciliationGroups(response(unavailable)), null);
  assert.equal(reconciliationGroups(undefined), null);
});

test('a partial interface verdict is a difference, never an agreement', () => {
  const data = response(block({
    matched: [
      item({
        configuredEdgeId: 'configured:smf:upf',
        interfaceVerdict: 'partial',
        interfaceMatch: 'agrees',
        interfaceCoverage: [
          { interface: 'N4', evidence: true, declared: true, status: 'matched' },
          { interface: 'N6', evidence: false, declared: true, status: 'declaration_only' },
        ],
        declaredClaims: [
          { edgeId: 'edge-1', relationshipType: 'connects_to', direction: 'forward', interfaceNames: ['N4', 'N6'] },
        ],
      }),
      item({
        fromComponentId: 'pcf',
        toComponentId: 'pcrf',
        relationshipType: 'connects_to',
        configuredEdgeId: 'configured:pcf:pcrf',
        interfaceVerdict: 'agrees',
        interfaceMatch: 'agrees',
        interfaceCoverage: [{ interface: 'Gx', evidence: true, declared: true, status: 'matched' }],
      }),
    ],
  }));

  const groups = reconciliationGroups(data);
  assert.ok(groups, 'an available ledger must group');
  assert.equal(groups.agreed, 1, 'only the fully confirmed pair counts as agreement');
  assert.equal(groups.disagreed.length, 1, 'the partly confirmed pair must be listed as a difference');
  assert.equal(groups.disagreed[0].verdict, 'partial');
  assert.equal(groups.disagreed[0].interfaceMatch, 'agrees', 'the legacy grade stays visible beside the verdict');
  assert.deepEqual(
    groups.disagreed[0].interfaces.map((entry) => `${entry.name}:${entry.status}`),
    ['N4:matched', 'N6:declaration_only'],
  );
  assert.equal(groups.disagreed[0].claims, 1, 'covering relationships stay countable');
});

test('the summary names the rule version and counts partial pairs', () => {
  const summary = reconciliationSummary(response(block({
    matched: [
      item({ interfaceVerdict: 'partial', interfaceMatch: 'agrees' }),
      item({ interfaceVerdict: 'differs', interfaceMatch: 'differs' }),
    ],
  })));
  assert.ok(summary);
  assert.equal(summary.partial, 1);
  assert.equal(summary.differing, 1);
  assert.equal(summary.rulesVersion, 'interface-v1');
});

test('the panel lists every difference and offers a locate control', () => {
  let located = '';
  const markup = render(createElement(TopologyReconciliationPanel, {
    summary: reconciliationSummary(response(block({
      matched: [item({ configuredEdgeId: 'configured:smf:upf', interfaceVerdict: 'partial' })],
      undeclaredEvidence: [item({ fromComponentId: 'mme', toComponentId: 'sgwc', configuredEdgeId: 'configured:mme:sgwc' })],
      unevidencedDeclarations: [item({ fromComponentId: 'hss', toComponentId: 'mme', edgeId: 'edge-h-m' })],
    })))!,
    groups: reconciliationGroups(response(block({
      matched: [item({ configuredEdgeId: 'configured:smf:upf', interfaceVerdict: 'partial' })],
      undeclaredEvidence: [item({ fromComponentId: 'mme', toComponentId: 'sgwc', configuredEdgeId: 'configured:mme:sgwc' })],
      unevidencedDeclarations: [item({ fromComponentId: 'hss', toComponentId: 'mme', edgeId: 'edge-h-m' })],
    })))!,
    onLocate: (componentId: string) => {
      located = componentId;
    },
  }));

  assert.ok(markup.includes('data-reconciliation="true"'), 'the panel must identify itself');
  assert.ok(markup.includes('data-recon-group="undeclared"'));
  assert.ok(markup.includes('data-recon-group="unevidenced"'));
  assert.ok(markup.includes('data-recon-group="disagreed"'));
  assert.ok(markup.includes('data-recon-verdict="partial"'), 'the verdict must be visible per row');
  assert.ok(markup.includes('data-recon-rules="interface-v1"'), 'the rule version must be visible');
  assert.ok(markup.includes('mme'), 'a row must name its endpoints');
  assert.ok(markup.includes('Locate on the graph'), 'a difference must be locatable on the canvas');
  assert.equal(located, '', 'rendering alone must never select anything');
});

test('a truncated ledger read is stated as a lower bound, not a clean topology', () => {
  const truncated = block({ complete: false });
  const markup = render(createElement(TopologyReconciliationPanel, {
    summary: reconciliationSummary(response(truncated))!,
    groups: reconciliationGroups(response(truncated))!,
  }));

  assert.ok(markup.includes('data-recon-completeness="partial"'));
  assert.ok(markup.includes('lower bound'), 'a truncated read must say the diff is not a total');
  assert.ok(markup.includes('in the part of the ledger that was read'), 'an empty list must be scoped to what was read');
});
test('the declared canvas can locate a difference by Inventory identity', () => {
  const data = response(block({
    undeclaredEvidence: [item({
      fromComponentId: 'mme',
      toComponentId: 'sgwc',
      configuredEdgeId: 'configured:mme:sgwc',
    })],
  }));
  const markup = render(createElement(TopologyReconciliationPanel, {
    summary: reconciliationSummary(data)!,
    groups: reconciliationGroups(data)!,
    onLocateResource: () => {},
  }));

  assert.ok(markup.includes('data-recon-group="undeclared"'), 'the diff must be listed on the declared canvas');
  assert.ok(
    markup.includes('Locate on the graph'),
    'an Inventory-backed row must offer the locate control even without a component locator',
  );
});

test('the declared canvas renders the advisory diff and never writes the ledger', () => {
  const source = readFileSync(new URL('../src/features/topology/ActualTopologyView.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('useTopologyReconciliation()'), 'the diff must come from the live projection');
  assert.ok(source.includes('<TopologyReconciliationPanel'), 'the declared canvas must render the diff');
  assert.ok(
    source.includes('onLocateResource={(resourceId) =>'),
    'locating a difference selects the Inventory resource on this canvas',
  );
  assert.ok(!source.includes('createTopologyEdge('), 'the diff view must not register relationships by itself');
});