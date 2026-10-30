import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (relative: string) => readFileSync(join(SRC, relative), 'utf8');
const exists = (relative: string) => existsSync(join(SRC, relative));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every ported primitive, with the export form it must expose. */
const PRIMITIVES: Array<{ path: string; defaultExport?: string; namedExports: string[] }> = [
  { path: 'components/ui/ChartDataTable.tsx', namedExports: ['ChartDataTable'] },
  { path: 'components/ui/DataTablePagination.tsx', namedExports: ['DataTablePagination'] },
  { path: 'components/ui/DataTableState.tsx', namedExports: ['DataTableStateRow'] },
  { path: 'components/ui/Dialog.tsx', namedExports: ['Dialog'] },
  { path: 'components/ui/Field.tsx', namedExports: ['Field'] },
  { path: 'components/ui/MetricStrip.tsx', defaultExport: 'MetricStrip', namedExports: ['MetricStripItem'] },
  { path: 'components/ui/PageHeader.tsx', defaultExport: 'ConsolePageHeader', namedExports: ['PageHeader'] },
  { path: 'components/ui/RefreshButton.tsx', defaultExport: 'RefreshButton', namedExports: [] },
  { path: 'components/ui/SectionHeader.tsx', defaultExport: 'SectionHeader', namedExports: [] },
  { path: 'components/ui/SortableTableHeader.tsx', namedExports: ['SortableTableHeader'] },
  { path: 'components/ui/UnsavedChangesGuard.tsx', namedExports: ['UnsavedChangesDialog', 'useUnsavedChangesGuard'] },
  { path: 'components/ui/ViewSwitch.tsx', namedExports: ['ViewSwitch', 'ViewSwitchOption'] },
  { path: 'components/ui/chartPrimitives.tsx', namedExports: ['CHART_SERIES_COLORS', 'ChartSummary'] },
  { path: 'components/ui/useDialogFocus.ts', namedExports: ['useDialogFocus'] },
  { path: 'components/ocs/OcsPageShell.tsx', defaultExport: 'OcsPageShell', namedExports: [] },
  { path: 'components/health/SubsystemCard.tsx', defaultExport: 'SubsystemCard', namedExports: ['SubsystemMetric'] },
];

/** CSS modules the primitives depend on, copied verbatim from the reference. */
const UI_MODULES = [
  'ChartDataTable.module.css',
  'ConsolePrimitives.module.css',
  'DataTablePagination.module.css',
  'DataTableState.module.css',
  'Field.module.css',
  'SortableTableHeader.module.css',
  'UnsavedChangesGuard.module.css',
];

test('every ported primitive exists and exposes its documented exports', () => {
  for (const primitive of PRIMITIVES) {
    assert.ok(exists(primitive.path), `missing primitive: ${primitive.path}`);
    const source = read(primitive.path);

    if (primitive.defaultExport) {
      assert.match(
        source,
        new RegExp(`export default function ${primitive.defaultExport}\\b`),
        `${primitive.path} must default-export ${primitive.defaultExport}`,
      );
    }
    for (const named of primitive.namedExports) {
      assert.match(
        source,
        new RegExp(`export (function|const|interface|type) ${named}\\b`),
        `${primitive.path} must export ${named}`,
      );
    }
  }
});

test('ported primitives carry no Next.js runtime coupling', () => {
  const files = walk(join(SRC, 'components'));
  const offenders: string[] = [];
  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    if (/from\s+['"]next\//.test(source)) offenders.push(`${file}: next/* import`);
    if (/^\s*['"]use client['"]/.test(source)) offenders.push(`${file}: use client directive`);
    if (/from\s+['"]@\//.test(source)) offenders.push(`${file}: @/ alias`);
  }
  assert.deepEqual(offenders, [], `framework coupling found:\n${offenders.join('\n')}`);
});

test('the router adapter replaces next/navigation with react-router', () => {
  const guard = read('components/ui/UnsavedChangesGuard.tsx');
  assert.match(guard, /from 'react-router-dom'/);
  assert.match(guard, /useNavigate\(\)/);
  assert.match(guard, /navigate\(pendingNavigation\)/);
  assert.doesNotMatch(guard, /useRouter/);
  assert.doesNotMatch(guard, /router\.push/);
});

test('every CSS-module import in components/ resolves to an existing stylesheet', () => {
  const files = walk(join(SRC, 'components'));
  const missing: string[] = [];
  let imports = 0;
  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+\.module\.css)['"]/g)) {
      imports++;
      const target = resolve(dirname(file), match[1]);
      if (!existsSync(target)) missing.push(`${file} -> ${match[1]}`);
    }
  }
  assert.ok(imports > 0, 'expected at least one CSS-module import in components/');
  assert.deepEqual(missing, [], `unresolved CSS-module imports:\n${missing.join('\n')}`);
});

test('the ported UI CSS modules are present and non-empty', () => {
  for (const name of UI_MODULES) {
    const relative = `styles/modules/${name}`;
    assert.ok(exists(relative), `missing CSS module: ${relative}`);
    assert.ok(read(relative).trim().length > 0, `empty CSS module: ${relative}`);
  }
});

test('PageHeader keeps the earlier local API working (forward compatibility)', () => {
  const source = read('components/ui/PageHeader.tsx');
  assert.match(source, /export default function ConsolePageHeader/);
  assert.match(source, /export function PageHeader\(/);
  assert.match(source, /subtitle\?: string/);
  assert.match(source, /description \?\? subtitle/);
});

test('PageHeader consumers resolve through the module in either export form', () => {
  // The dashboard uses the reference default export; the named adapter stays
  // available for any earlier caller.
  assert.match(
    read('features/operations/OperationsOverviewPage.tsx'),
    /import PageHeader from '\.\.\/\.\.\/components\/ui\/PageHeader'/,
  );
  assert.match(
    read('components/ui/PageHeader.tsx'),
    /export function PageHeader\(/,
  );
});

test('operations surfaces compose the shared view switch and KPI strip', () => {
  const surfaces = [
    'features/inventory/InventoryPage.tsx',
    'features/discovery/DiscoveryPage.tsx',
    'features/nf-health/NfHealthPage.tsx',
    'features/nf-alerts/NfAlertsPage.tsx',
    'features/operations/OperationsOverviewPage.tsx',
    'features/topology/TopologyPage.tsx',
  ];
  for (const surface of surfaces) {
    const source = read(surface);
    assert.match(source, /from '\.\.\/\.\.\/components\/ui\/ViewSwitch'/, `${surface} must import the shared switch`);
    assert.match(source, /ViewSwitch/, `${surface} must render the shared switch`);
    assert.doesNotMatch(source, /styles\.viewToggle/, `${surface} must not fork the switch markup`);
  }

  const kpiSurfaces = [
    'features/inventory/NetworkElementView.tsx',
    'features/discovery/DiscoveryPage.tsx',
    'features/nf-health/NfHealthPage.tsx',
    'features/nf-alerts/NfAlertsPage.tsx',
  ];
  for (const surface of kpiSurfaces) {
    const source = read(surface);
    assert.match(source, /MetricStrip/, `${surface} must render KPIs through MetricStrip`);
    assert.doesNotMatch(source, /styles\.kpiCard|styles\.kpiStrip/, `${surface} must not fork KPI cards`);
  }
});

test('OCS business surfaces compose shared primitives instead of duplicating them', () => {
  const shell = read('components/ocs/OcsPageShell.tsx');
  assert.match(shell, /import PageHeader from '..\/ui\/PageHeader'/);
  assert.match(shell, /import RefreshButton from '..\/ui\/RefreshButton'/);

  const surfaces = [
    { path: 'components/ocs/contracts/OcsContractsPanel.tsx', paginated: true },
    { path: 'components/ocs/balances/OcsBalancePlaceholder.tsx', paginated: true },
    { path: 'components/ocs/tariffs/OcsTariffGovernancePanel.tsx', paginated: false },
  ];
  for (const surface of surfaces) {
    const source = read(surface.path);
    assert.match(source, /MetricStrip/);
    if (surface.paginated) assert.match(source, /DataTablePagination/);
    assert.match(source, /SortableTableHeader/);
    assert.match(source, /DataTableStateRow/);
    assert.doesNotMatch(source, /function (DataTablePagination|SortableTableHeader|MetricStrip)/, `${surface.path} must not fork a shared primitive`);
  }

  for (const dialog of [
    'components/ocs/contracts/CreateContractDialog.tsx',
    'components/ocs/contracts/OcsContractDetail.tsx',
    'components/ocs/common/ConfirmDialog.tsx',
  ]) {
    assert.match(read(dialog), /\.\.\/\.\.\/ui\/Dialog|\.\.\/\.\.\/\.\.\/ui\/Dialog/, `${dialog} must mount through the shared Dialog`);
  }
});

test('ocs.css remains one shared business stylesheet with consumers outside the OCS pages', () => {
  assert.match(read('styles/app.css'), /@import '\.\/ocs\.css'/);
  for (const consumer of [
    'components/TrafficAdjustmentModal.tsx',
    'components/analytics/OcsHealthPanel.tsx',
    'features/profiles/components/ProfileViewMode.tsx',
    'features/subscribers/components/subscriber/SubscriberViewMode.tsx',
    'features/retention/RetentionPage.tsx',
  ]) {
    assert.match(read(consumer), /ocs-/, `${consumer} is an ocs.css consumer; a piecemeal module split would break it`);
  }
});
