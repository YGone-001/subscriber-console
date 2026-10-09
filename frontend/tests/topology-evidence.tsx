/*
 * Rendered Topology evidence.
 *
 * Renders the production Topology surfaces server-side from clearly identified
 * test fixtures into standalone HTML documents under the git-ignored
 * `reports/ops/topology-evidence/` output directory. Every document inlines the
 * real design tokens and the real Topology module stylesheet, so the output is
 * inspectable rendered evidence rather than a source dump.
 *
 * These are rendered HTML documents, not pixel screenshots.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { TopologyGraph } from '../src/features/topology/components/TopologyGraph';
import { TopologyEdgeTable } from '../src/features/topology/components/TopologyEdgeTable';
import { TopologyEdgeForm } from '../src/features/topology/components/TopologyEdgeForm';
import { TopologyEdgeDetail } from '../src/features/topology/components/TopologyEdgeDetail';
import { TopologyPage } from '../src/features/topology/TopologyPage';
import { ResourceTopologyPage } from '../src/features/topology/ResourceTopologyPage';
import type { Neighbor, ResourceProjection, TopologyEdge } from '../src/features/topology/topology-types';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const outDir = resolve(frontendRoot, '..', 'reports', 'ops', 'topology-evidence');
mkdirSync(outDir, { recursive: true });

const SMF = '2f1a6a52-6c7f-4f8a-9f2b-0f7d4a1c8e33';
const PCF = '8c9d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const AMF = '3a4b5c6d-7e8f-4a1b-9c2d-3e4f5a6b7c8d';
const UPF = '4b5c6d7e-8f9a-4b1c-8d2e-3f4a5b6c7d8e';

const projection = (resourceId: string, name: string, domain = '5gc'): ResourceProjection => ({
  resourceId,
  kind: 'network_function',
  name,
  displayName: name,
  domain,
  role: 'nf',
  lifecycleState: 'active',
});

const edge = (overrides: Partial<TopologyEdge> = {}): TopologyEdge => ({
  edgeId: '11111111-2222-4333-8444-555555555555',
  schemaVersion: 1,
  relationshipType: 'depends_on',
  fromResourceId: SMF,
  toResourceId: PCF,
  description: 'SMF depends on PCF',
  labels: { env: 'prod' },
  attributes: { priority: 1 },
  lifecycleState: 'active',
  source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
  revision: 1,
  createdAt: '2026-10-09T00:00:00Z',
  createdBy: 'operator1',
  updatedAt: '2026-10-09T00:00:00Z',
  updatedBy: 'operator1',
  ...overrides,
});

const root = projection(SMF, 'smf-01');
const neighbors: Neighbor[] = [
  { edge: edge(), direction: 'outbound', neighborResource: projection(PCF, 'pcf-01') },
  {
    edge: edge({ edgeId: '22222222-3333-4444-8555-666666666666', relationshipType: 'connects_to', fromResourceId: AMF, toResourceId: SMF }),
    direction: 'inbound',
    neighborResource: projection(AMF, 'amf-01'),
  },
  {
    edge: edge({ edgeId: '33333333-4444-4555-8666-777777777777', relationshipType: 'uses', fromResourceId: SMF, toResourceId: UPF }),
    direction: 'outbound',
    neighborResource: projection(UPF, 'upf-01'),
  },
];
const directory: Record<string, ResourceProjection> = {
  [SMF]: root,
  [PCF]: projection(PCF, 'pcf-01'),
  [AMF]: projection(AMF, 'amf-01'),
  [UPF]: projection(UPF, 'upf-01'),
};

const STYLE_FILES = [
  'tokens.css', 'base.css', 'globals.css', 'shell.css', 'components.css', 'pages.css', 'utilities.css',
];
const stylesheet = [
  ...STYLE_FILES.map((file) => readFileSync(resolve(frontendRoot, 'src/styles', file), 'utf8')),
  readFileSync(resolve(frontendRoot, 'src/styles/modules/topology.module.css'), 'utf8'),
].join('\n');

function document_(title: string, theme: 'light' | 'dark', width: number, body: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
${stylesheet}
body { margin: 0; padding: 1rem; background: var(--surface-subtle); }
.evidence-banner { margin-bottom: 1rem; padding: 0.6rem 0.85rem; border: 1px dashed var(--surface-border); border-radius: var(--ref-radius-control); color: var(--text-secondary); font-size: var(--ref-font-size-label-strong); }
.evidence-frame { width: ${width}px; max-width: 100%; }
</style>
</head>
<body>
<p class="evidence-banner">TEST FIXTURE EVIDENCE - rendered from fixtures, not live data. Rendered HTML document, not a pixel screenshot.</p>
<div class="evidence-frame">
${body}
</div>
</body>
</html>
`;
}

function renderInProviders(element: ReactElement, path: string, pattern: string): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        I18nProvider,
        null,
        createElement(
          AuthProvider,
          null,
          createElement(Routes, null, createElement(Route, { path: pattern, element })),
        ),
      ),
    ),
  );
}

function wrap(element: ReactElement): ReactElement {
  return createElement(I18nProvider, null, element);
}

const artifacts: Array<{ name: string; html: string }> = [];

function emit(name: string, title: string, theme: 'light' | 'dark', width: number, body: string) {
  artifacts.push({ name, html: document_(title, theme, width, body) });
}

const graphBody = renderToStaticMarkup(wrap(createElement(TopologyGraph, { root, neighbors })));
const tableBody = renderToStaticMarkup(
  wrap(createElement(TopologyEdgeTable, {
    edges: neighbors.map((n) => n.edge),
    directory,
    caption: 'Topology relationships',
    canConfigure: true,
  })),
);
const detailBody = renderToStaticMarkup(
  wrap(createElement(TopologyEdgeDetail, { edge: edge(), directory, canConfigure: true })),
);
const createFormBody = renderToStaticMarkup(
  wrap(createElement(TopologyEdgeForm, {
    mode: 'create',
    relationshipTypes: ['contains', 'runs_on', 'depends_on', 'connects_to', 'routes_to', 'registers_with', 'serves', 'uses', 'exposes'],
    submitting: false,
    serverError: null,
    onCancel: () => {},
  })),
);
const editFormBody = renderToStaticMarkup(
  wrap(createElement(TopologyEdgeForm, {
    mode: 'edit',
    relationshipTypes: ['depends_on'],
    initialEdge: edge(),
    submitting: false,
    serverError: null,
    onCancel: () => {},
  })),
);
const listPageBody = renderInProviders(createElement(TopologyPage), '/topology', '/topology');
const resourcePageBody = renderInProviders(
  createElement(ResourceTopologyPage),
  `/topology/${SMF}`,
  '/topology/:resourceId',
);

emit('topology-list-desktop-light.html', 'Topology list - desktop light', 'light', 1440, listPageBody);
emit('topology-list-desktop-dark.html', 'Topology list - desktop dark', 'dark', 1440, listPageBody);
emit('topology-list-mobile.html', 'Topology list - mobile', 'light', 390, listPageBody);
emit('topology-graph-desktop-light.html', 'Topology graph - desktop light', 'light', 1440, `<section class="dash-card">${graphBody}</section>${detailBody}`);
emit('topology-graph-desktop-dark.html', 'Topology graph - desktop dark', 'dark', 1440, `<section class="dash-card">${graphBody}</section>${detailBody}`);
emit('topology-graph-mobile.html', 'Topology graph - mobile (table fallback)', 'light', 390, `<section class="dash-card">${graphBody}${tableBody}</section>`);
emit('topology-table-desktop-light.html', 'Topology relationship table - desktop light', 'light', 1440, `<section class="dash-card">${tableBody}</section>`);
emit('topology-create-dialog.html', 'Topology create dialog', 'light', 1440, `<div class="modal-content">${createFormBody}</div>`);
emit('topology-edit-dialog.html', 'Topology edit dialog', 'light', 1440, `<div class="modal-content">${editFormBody}</div>`);
emit('topology-resource-desktop-light.html', 'Resource topology - desktop light', 'light', 1440, resourcePageBody);
emit('topology-resource-desktop-dark.html', 'Resource topology - desktop dark', 'dark', 1440, resourcePageBody);
emit('topology-resource-mobile.html', 'Resource topology - mobile', 'light', 390, resourcePageBody);

for (const artifact of artifacts) {
  writeFileSync(join(outDir, artifact.name), artifact.html, 'utf8');
}

console.log(`topology_evidence_dir=${outDir}`);
console.log(`topology_evidence_artifacts=${artifacts.length}`);
console.log('topology_evidence_kind=rendered_html');
console.log('topology_visual_screenshots=NOT_CAPTURED');
console.log('topology_evidence_result=PASS');
