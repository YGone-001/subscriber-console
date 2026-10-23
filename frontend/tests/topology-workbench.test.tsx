/*
 * Shared topology workbench contract.
 *
 * The shell, toolbar and inspector are the structure every graph source moves
 * into. These assertions cover the controlled surface (evidence, completeness,
 * toolbar, canvas, inspector, status) and verify that the runtime view actually
 * adopted it instead of keeping a second canvas/detail layout.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { TopologyGraphShell } from '../src/features/topology/components/TopologyGraphShell';
import { TopologyGraphToolbar } from '../src/features/topology/components/TopologyGraphToolbar';
import { TopologyInspector } from '../src/features/topology/components/TopologyInspector';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(I18nProvider, null, node));
}

/* ---------------------------------------------------------------- shell -- */

test('the shell renders identity, evidence, completeness, toolbar, canvas, inspector and status', () => {
  const markup = render(createElement(TopologyGraphShell, {
    titleId: 'workbench-title',
    title: 'Runtime and configured',
    subtitle: 'Runtime observation plus explicit configuration',
    evidence: 'Runtime observation + explicit configuration',
    completeness: 'partial',
    summary: createElement('span', { 'data-testid': 'summary' }, '5 running'),
    notice: createElement('p', null, 'Config incomplete'),
    toolbar: createElement('button', { type: 'button' }, 'Fit'),
    inspector: createElement('p', null, 'Node detail'),
    inspectorLabel: 'Selected component',
    onCloseInspector: () => {},
    legend: createElement('span', null, 'Configured evidence'),
    status: createElement('span', null, 'Runtime 5'),
    footer: createElement('table', null, createElement('tbody', null, createElement('tr', null, createElement('td', null, 'edge')))),
  }, createElement('div', { 'data-testid': 'canvas' }, 'Canvas')));

  assert.ok(markup.includes('id="workbench-title"'), 'the shell must own the graph heading');
  assert.ok(markup.includes('data-topology-shell="true"'));
  assert.ok(markup.includes('data-graph-evidence="true"'), 'the evidence badge must be explicit');
  assert.ok(markup.includes('data-completeness="partial"'), 'read completeness must be visible');
  assert.ok(markup.includes('data-testid="summary"'), 'the summary slot must render');
  assert.ok(markup.includes('Config incomplete'), 'the notice slot must render');
  assert.ok(markup.includes('>Fit<'), 'the toolbar slot must render');
  assert.ok(markup.includes('data-testid="canvas"'), 'the canvas slot must render');
  assert.ok(markup.includes('data-inspector-open="true"'), 'the inspector must take the side rail');
  assert.ok(markup.includes('data-topology-inspector="true"'));
  assert.ok(markup.includes('aria-label="Selected component"'), 'the inspector must be labelled');
  assert.ok(markup.includes('Node detail'), 'the inspector content must render');
  assert.ok(markup.includes('Configured evidence'), 'the legend must render');
  assert.ok(markup.includes('Runtime 5'), 'the status slot must render');
  assert.ok(markup.includes('<table'), 'the equivalent list belongs in the footer');
});

test('the shell gives the canvas the full width when nothing is selected', () => {
  const markup = render(createElement(TopologyGraphShell, {
    titleId: 'workbench-title',
    title: 'Runtime and configured',
  }, createElement('div', null, 'Canvas')));

  assert.ok(!markup.includes('data-topology-inspector'), 'a closed inspector must not render an empty rail');
  assert.ok(!markup.includes('data-inspector-open'), 'the canvas must stay full width without a selection');
});

/* -------------------------------------------------------------- toolbar -- */

test('the toolbar exposes controlled search, zoom and fullscreen controls', () => {
  const markup = render(createElement(TopologyGraphToolbar, {
    search: { value: 'amf', onChange: () => {}, label: 'Search components', placeholder: 'Search components' },
    filters: createElement('select', { 'aria-label': 'Domain' }, createElement('option', null, 'All domains')),
    actions: createElement('a', { href: '/topology?view=actual&source=reference' }, 'Reference'),
    zoom: {
      value: 1,
      min: 0.5,
      max: 1.75,
      onIn: () => {},
      onOut: () => {},
      onFit: () => {},
      onReset: () => {},
    },
    fullscreen: { active: false, onToggle: () => {} },
  }));

  assert.ok(markup.includes('data-topology-toolbar="true"'));
  assert.ok(markup.includes('type="search"'), 'search must be a controlled input');
  assert.ok(markup.includes('value="amf"'), 'search must reflect the controlled value');
  assert.ok(markup.includes('Search components'), 'search must have an accessible name');
  assert.ok(markup.includes('aria-label="Domain"'), 'filters must render in the toolbar');
  assert.ok(markup.includes('href="/topology?view=actual&amp;source=reference"'), 'actions must render in the toolbar');
  for (const action of ['zoom-out', 'zoom-in', 'fit', 'reset', 'fullscreen']) {
    assert.ok(markup.includes(`data-action="${action}"`), `${action} must be an explicit control`);
  }
  assert.ok(markup.includes('100%'), 'the current zoom must be visible');
  assert.ok(markup.includes('aria-label="Zoom out"'), 'zoom controls must be named');
});

test('the toolbar omits controls the view does not provide', () => {
  const markup = render(createElement(TopologyGraphToolbar, {
    search: { value: '', onChange: () => {}, label: 'Search', placeholder: 'Search' },
  }));
  assert.ok(!markup.includes('data-action="zoom-in"'), 'zoom belongs to views that own a viewport');
  assert.ok(!markup.includes('data-action="fullscreen"'), 'fullscreen belongs to views that own a viewport');
  assert.ok(!markup.includes('role="group"'), 'an empty control group must not render');
});

/* ------------------------------------------------------------ inspector -- */

test('the inspector is a labelled container with one close control', () => {
  const markup = render(createElement(TopologyInspector, {
    label: 'Selected component',
    onClose: () => {},
  }, createElement('p', null, 'SMF-01')));

  assert.ok(markup.includes('data-topology-inspector="true"'));
  assert.ok(markup.includes('aria-label="Selected component"'));
  assert.ok(markup.includes('aria-label="Close inspector"'), 'the close control must be named');
  assert.ok(markup.includes('SMF-01'));
});

test('the inspector omits the close control when the view owns no selection', () => {
  const markup = render(createElement(TopologyInspector, { label: 'Details' }, createElement('p', null, 'Empty')));
  assert.ok(!markup.includes('Close inspector'));
});

test('the inspector becomes a focus-managed portal drawer on narrow screens', () => {
  const source = read('../src/features/topology/components/TopologyInspector.tsx');
  assert.match(source, /createPortal/, 'the overlay must escape the page stacking context');
  assert.match(source, /\(max-width: 1100px\)/, 'only narrow screens use the overlay');
  assert.match(source, /role=\{narrow \? 'dialog'/, 'the overlay must announce itself as a dialog');
  assert.match(source, /event\.key !== 'Escape'/, 'Escape must close the inspector');
  assert.match(source, /panelRef\.current\?\.focus\(\)/, 'opening moves focus into the inspector');
  assert.match(source, /inspectorBackdrop/, 'the overlay must be dismissible by pointer');
});

/* ---------------------------------------------------------- inspections -- */

test('the declared and runtime views inspect nodes and relationships in place', () => {
  const actual = read('../src/features/topology/ActualTopologyView.tsx');
  assert.match(actual, /TopologyInspector/, 'declared nodes and edges use the shared inspector');
  assert.match(actual, /TopologyEdgeDetail/, 'declared relationships reuse the edge detail content');
  assert.match(actual, /onSelectEdge=\{selectEdge\}/, 'declared edges are selectable');
  assert.match(actual, /closeInspector/, 'closing restores focus');
  assert.match(actual, /data-related-edge=/, 'node detail links to adjacent relationships');

  const live = read('../src/features/topology/LiveTopologyView.tsx');
  assert.match(live, /LiveEdgeDetail/, 'configured relationships have their own inspector content');
  assert.match(live, /onSelectEdge=\{selectEdge\}/);
  assert.match(live, /onCloseInspector=\{closeInspector\}/);
  assert.match(live, /data-related-edge=/, 'runtime node detail links to its configured relationships');

  const canvas = read('../src/features/topology/components/ActualTopologyCanvas.tsx');
  assert.match(canvas, /role=\{onSelectEdge \? 'button'/, 'relationships must be keyboard reachable');
  assert.match(canvas, /data-edge-selected/, 'the selected relationship must stay marked');
  assert.match(canvas, /event\.key === 'Enter'/, 'relationships must open with Enter or Space');
});

test('the architecture view presents role detail through the shared inspector', () => {
  const source = read('../src/features/topology/ArchitectureView.tsx');
  assert.match(source, /TopologyInspector/, 'roles must use the shared inspector');
  assert.match(source, /ArchitectureRoleDetail/, 'role content must be reusable');
  assert.ok(!source.includes('<ArchitectureDetailDrawer'), 'the one-off overlay must no longer own the view');
  assert.match(source, /closeRoleInspector/, 'role close must restore focus');
  assert.match(source, /restoreRoleFocus/);
  assert.match(source, /data-inspector-open/, 'the inspector must take the side rail');
});

/* --------------------------------------------------------------- live ---- */

test('the runtime view is presented through the shared workbench', () => {
  const source = read('../src/features/topology/LiveTopologyView.tsx');
  assert.match(source, /TopologyGraphShell/, 'the runtime graph must use the shared shell');
  assert.match(source, /TopologyGraphToolbar/, 'search and canvas controls must use the shared toolbar');
  assert.match(source, /inspector=\{selectedEdge \?/, 'node and edge detail must use one contextual inspector');
  assert.match(source, /onCloseInspector=\{closeInspector\}/, 'the inspector must restore focus on close');
  assert.match(source, /fitView/, 'the view must fit its own layout');
  assert.match(source, /toggleFullscreen/, 'the view must own fullscreen state');
  assert.match(source, /completeness=\{completeness\}/, 'config completeness must stay explicit');
  assert.match(source, /liveConfigCompleteness/, 'completeness must distinguish unavailable, partial and complete reads');
  assert.ok(!source.includes('styles.liveBody'), 'the old canvas/detail grid must be gone');
  assert.ok(!source.includes('styles.liveToolbar'), 'the old page-local toolbar must be gone');
});

test('the runtime view pans, reveals labels deliberately and reports the view state', () => {
  const source = read('../src/features/topology/LiveTopologyView.tsx');
  assert.match(source, /onPointerDown=\{beginPan\}/, 'the canvas must be pannable by dragging');
  assert.match(source, /setPointerCapture/, 'a drag must keep receiving pointer moves');
  assert.match(source, /\[data-resource-id\], \[data-lane-focus\]/, 'panning must not start on a node or lane control');
  assert.match(source, /data-action="toggle-interface-labels"/, 'show-all labels must remain an explicit option');
  assert.match(source, /showAllInterfaceNames=\{showAllInterfaceNames\}/, 'label density must be controlled by the view');
  assert.match(source, /onFocusResource=\{setFocusedResourceId\}/, 'keyboard focus must reveal labels');
  assert.match(source, /onHoverResource=\{setHoveredResourceId\}/, 'node hover must reveal labels');
  assert.match(source, /onHoverEdge=\{setHoveredEdgeId\}/, 'edge hover must reveal labels');
  assert.match(source, /LABEL_DETAIL_MIN_ZOOM/, 'the detail zoom threshold must gate show-all labels');
  assert.match(source, /data-hidden-label-count=\{labelVisibility.hiddenCount\}/, 'the status bar must report hidden labels');
  assert.match(source, /data-live-zoom=/, 'the status bar must report the current zoom');
});
