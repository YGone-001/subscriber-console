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
  { path: 'components/ui/IconButton.tsx', namedExports: ['IconButton'] },
  { path: 'components/ui/InlineNotice.tsx', namedExports: ['InlineNotice', 'ErrorNotice'] },
  { path: 'components/ui/MetricStrip.tsx', defaultExport: 'MetricStrip', namedExports: ['MetricStripItem'] },
  { path: 'components/ui/PageHeader.tsx', defaultExport: 'ConsolePageHeader', namedExports: ['PageHeader'] },
  { path: 'components/ui/RefreshButton.tsx', defaultExport: 'RefreshButton', namedExports: [] },
  { path: 'components/ui/SectionHeader.tsx', defaultExport: 'SectionHeader', namedExports: [] },
  { path: 'components/ui/SortableTableHeader.tsx', namedExports: ['SortableTableHeader'] },
  { path: 'components/ui/UnsavedChangesGuard.tsx', namedExports: ['UnsavedChangesDialog', 'useUnsavedChangesGuard'] },
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
  'InlineNotice.module.css',
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
    read('features/read/ReadPages.tsx'),
    /import PageHeader from '\.\.\/\.\.\/components\/ui\/PageHeader'/,
  );
  assert.match(
    read('components/ui/PageHeader.tsx'),
    /export function PageHeader\(/,
  );
});
