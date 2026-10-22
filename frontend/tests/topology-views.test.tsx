/*
 * UX-3 contract tests: topology view decoupling.
 *
 * Reference: docs/analyze/cnms-port-assessment-2026-10-18.md section 6.2 and the
 * UX-3 row of section 8.
 *
 * The four views are exclusive: the actual topology canvas, reference
 * architecture canvas, relationship ledger and runtime hierarchy never render
 * at the same time. The reference canvas reads the bounded role projection
 * instead of an arbitrary Inventory page, and an ambiguous role claims no
 * binding.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { TopologyPage } from '../src/features/topology/TopologyPage';
import { ARCHITECTURE_ROLE_TOKENS } from '../src/features/topology/reference-architecture';
import { operationsResourcesPath } from '../src/features/operations/operations-resources';
import { en } from '../src/lib/locales/en';
import { zh } from '../src/lib/locales/zh';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function renderTopology(path: string): string {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('a topology view must not call fetch during render');
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
            createElement(Routes, null, createElement(Route, { path: '/topology', element: createElement(TopologyPage) })),
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

/* --------------------------------------------------------------- views -- */

test('the topology page defaults to the actual topology view', () => {
  const markup = renderTopology('/topology');
  assert.ok(markup.includes('data-topology-view="actual"'), 'the actual view must be present in the switch');
  assert.ok(markup.includes('data-topology-view="architecture"'), 'the view switch must render');
  assert.ok(markup.includes('aria-pressed="true"'), 'the default view must be pressed');
  assert.ok(markup.includes('id="actual-topology-title"'), 'the actual topology section must render');
  assert.ok(!markup.includes('id="architecture-title"'), 'the reference canvas must not render by default');
});

test('the ledger is not rendered behind the actual topology', () => {
  const markup = renderTopology('/topology');
  assert.ok(!markup.includes('topology-filter-from'), 'the from-resource filter belongs to the ledger view');
  assert.ok(!markup.includes('topology-filter-to'), 'the to-resource filter belongs to the ledger view');
});

test('the runtime hierarchy is not rendered behind the actual topology', () => {
  const markup = renderTopology('/topology');
  assert.ok(!markup.includes('data-testid="runtime-hierarchy"'), 'the runtime tree belongs to its own view');
});

test('the ledger view renders its own filters and no canvas', () => {
  const markup = renderTopology('/topology?view=relationships');
  assert.ok(markup.includes('data-topology-view="relationships"'));
  assert.ok(markup.includes('topology-filter-from'));
  assert.ok(markup.includes('topology-filter-to'));
  assert.ok(!markup.includes('id="architecture-title"'), 'the reference canvas must not render on the ledger view');
  assert.ok(!markup.includes('id="actual-topology-title"'), 'the actual canvas must not render on the ledger view');
});

test('the runtime view renders its own disclaimer', () => {
  const markup = renderTopology('/topology?view=runtime');
  assert.ok(markup.includes('data-topology-view="runtime"'));
  assert.ok(
    markup.includes('Observed local runtime hierarchy'),
    'the runtime view must state that it is not a protocol relationship',
  );
  assert.ok(!markup.includes('id="architecture-title"'), 'the reference canvas must not render on the runtime view');
  assert.ok(!markup.includes('id="actual-topology-title"'), 'the actual canvas must not render on the runtime view');
});

test('every topology view keeps one tab strip and one refresh control', () => {
  for (const view of ['actual', 'architecture', 'relationships', 'runtime']) {
    const markup = renderTopology(`/topology?view=${view}`);
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

/* ---------------------------------------------------------- data source -- */

test('the canvas reads the bounded role projection', () => {
  const source = read('../src/features/topology/ArchitectureView.tsx');
  assert.ok(source.includes('operationsResourcesPath('), 'the canvas must use the operations projection');
  assert.ok(source.includes('ARCHITECTURE_ROLE_TOKENS'), 'the projection must be scoped to skeleton roles');
  assert.ok(!source.includes('/api/inventory/resources?limit='), 'an arbitrary first Inventory page must be gone');
  assert.ok(!source.includes('/api/nf-health/targets?resourceIds='), 'the browser must not assemble the join');
});

test('every skeleton role token fits the bounded roles filter', () => {
  assert.ok(ARCHITECTURE_ROLE_TOKENS.length > 0);
  assert.ok(ARCHITECTURE_ROLE_TOKENS.length <= 64, 'the projection bounds roles at 64');
  assert.ok(ARCHITECTURE_ROLE_TOKENS.includes('amf'));
  assert.ok(ARCHITECTURE_ROLE_TOKENS.includes('smf'));
  const path = operationsResourcesPath({ roles: ARCHITECTURE_ROLE_TOKENS, limit: 200 });
  assert.ok(path.includes('roles='), 'roles must be sent as one bounded list');
  assert.ok(path.includes('limit=200'));
});

/* -------------------------------------------------------------- drawer -- */

test('the detail drawer offers resource, monitoring, alerts and logs but no restart', () => {
  const source = read('../src/features/topology/components/ArchitectureDetailDrawer.tsx');
  // Comments explain the absence; only executable code is scanned.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(source.includes("t('arch_entry_resource')"));
  assert.ok(source.includes("t('arch_entry_monitoring')"));
  assert.ok(source.includes("t('arch_entry_alerts')"));
  assert.ok(source.includes("t('arch_entry_logs')"));
  assert.ok(!/restart/i.test(code), 'the console must not offer a restart action');
  assert.ok(!/systemctl|mml/i.test(code), 'the console must not offer a write command');
});

test('an ambiguous role lists its candidates instead of claiming one', () => {
  const source = read('../src/features/topology/components/ArchitectureDetailDrawer.tsx');
  assert.ok(source.includes("node.binding === 'ambiguous'"));
  assert.ok(source.includes('node.candidates.map'));
});

test('the canvas exposes the binding state for keyboard and test parity', () => {
  const source = read('../src/features/topology/components/ArchitectureCanvas.tsx');
  assert.ok(source.includes('data-binding={node.binding}'));
  assert.ok(source.includes('role="button"'));
  assert.ok(source.includes("event.key === 'Enter'"));
});

test('the canvas has an equivalent list representation with the same state', () => {
  const source = read('../src/features/topology/ArchitectureView.tsx');
  assert.ok(source.includes('styles.nodeTable'), 'a text list must be available');
  assert.ok(source.includes('visible.nodes.map'), 'the list must cover every visible role');
  assert.ok(source.includes("t(stateLabelKey(node.tone))"), 'the list must carry the same state vocabulary');
  assert.ok(source.includes("t(bindingLabelKey(node.binding))"), 'the list must carry the binding state');
  assert.ok(source.includes('setSelectedRole(node.role)'), 'the list must open the same detail');
});

/* -------------------------------------------------- contract closure -- */

test('name-only matches are rendered as diagnostics, never as state', () => {
  const source = read('../src/features/topology/components/ArchitectureDetailDrawer.tsx');
  assert.ok(source.includes('node.suggestions.map'), 'the drawer must surface name-only matches');
  assert.ok(source.includes("t('arch_suggestions_title')"));
  assert.ok(source.includes("t('arch_suggestions_note')"));
  const start = source.indexOf('node.suggestions.length > 0');
  const end = source.indexOf("t('arch_detail_monitoring')");
  const block = source.slice(start, end);
  assert.ok(!block.includes('stateBadge'), 'a diagnostic must not render a health badge');
  assert.ok(!block.includes('node.targetId'), 'a diagnostic must not project a monitoring target');
});

test('unavailable entries stay keyboard reachable and explain themselves', () => {
  const source = read('../src/features/topology/components/ArchitectureDetailDrawer.tsx');
  assert.ok(source.includes('aria-disabled="true"'), 'the entry must announce that it is disabled');
  assert.ok(source.includes('aria-describedby={describedBy}'), 'the reason must be reachable from the control');
  assert.ok(!/disabled\s+title=/.test(source), 'a native disabled control hides its explanation from the keyboard');
  assert.ok(source.includes('arch-entry-logs-reason'), 'the log note must exist in the DOM');
});

test('the alerts entry is labelled as the global console', () => {
  assert.equal(en.arch_entry_alerts, 'Alert console');
  assert.equal(zh.arch_entry_alerts, '告警中心');
  assert.match(en.arch_entry_alerts_note, /global alert queue/);
  assert.match(zh.arch_entry_alerts_note, /全局告警队列/);
});

test('the log entry states that it is not implemented', () => {
  assert.equal(en.arch_entry_logs, 'Logs (not implemented)');
  assert.equal(zh.arch_entry_logs, '日志（尚未实施）');
  assert.match(en.arch_entry_logs_unavailable, /controlled log source/);
  assert.match(zh.arch_entry_logs_unavailable, /受控日志源/);
});

test('the unbound copy separates "no explicit binding" from "no resource"', () => {
  assert.match(en.arch_detail_unbound_body, /explicit role/);
  assert.match(en.arch_detail_unbound_body, /does not mean the network function is faulty/);
  assert.equal(en.arch_state_unregistered, 'No explicit binding');
  assert.equal(zh.arch_state_unregistered, '无显式绑定');
  assert.equal(zh.arch_detail_unbound_body, '该架构角色没有显式绑定的 Inventory 资源，这不表示网元故障。');
});

/* -------------------------------------------------------------- legend -- */

test('the legend is collapsed to one line with a dialog for the full vocabulary', () => {
  const source = read('../src/features/topology/ArchitectureView.tsx');
  assert.ok(source.includes('styles.legendCompact'), 'a compact legend line must render');
  assert.ok(source.includes('styles.legendToggle'), 'the full legend must be behind a control');
  assert.ok(source.includes('COMPACT_TONES'), 'the compact line must be a subset');
  assert.ok(source.includes('FULL_TONES'), 'the dialog must carry the full vocabulary');
});
