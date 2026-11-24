import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

/*
 * FE-C3 accessibility and responsive regression guards.
 *
 * These are source-level contract tests. Each one pins a defect that was
 * reproduced in a real browser during FE-C3, so the fix cannot silently
 * regress without a failing test.
 */

const SRC = resolve(new URL('../src/', import.meta.url).pathname);
const read = (relative) => readFileSync(join(SRC, relative), 'utf8');
const readSource = (relative) => resolve(SRC, relative);

test('the sortable table header keeps a real, valid keyboard focus ring', () => {
  const css = read('styles/modules/SortableTableHeader.module.css');
  /*
   * --focus-ring is a box-shadow token (`0 0 0 3px color-mix(...)`). Using it
   * as the colour of the `outline` shorthand made the whole declaration
   * invalid, so the header had NO visible focus indicator when reached by
   * keyboard. The rule must use a colour token.
   */
  assert.doesNotMatch(css, /outline:\s*[^;]*var\(--focus-ring\)/, 'the outline must not use the box-shadow focus token as a colour');
  assert.match(css, /\.button:focus-visible\s*{[^}]*outline:\s*2px solid var\(--sys-color-action-primary\)/, 'the sort button must declare a 2px semantic focus outline');
});

test('the subscriber create/edit form associates every control with a label', () => {
  const source = read('features/subscribers/components/subscriber/SubscriberEditMode.tsx');

  /* Every visible form control must be reachable from its label, either by
   * htmlFor/id or by an explicit aria-label for composite inputs. */
  const ids = [...source.matchAll(/htmlFor="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length >= 20, `expected the form to associate its controls, saw ${ids.length}`);
  for (const id of ids) {
    assert.match(source, new RegExp(`id="${id}"`), `control ${id} must carry the matching id`);
  }

  /* The identity fields carry validation copy, so they must expose it. */
  assert.match(source, /id="sub-edit-imsi"[\s\S]{0,400}aria-describedby=/, 'IMSI must reference its validation message');
  assert.match(source, /id="sub-edit-msisdn"[\s\S]{0,400}aria-describedby=/, 'MSISDN must reference its validation message');
  assert.match(source, /aria-invalid=/, 'validated fields must expose aria-invalid');

  /* Composite number+unit inputs need a name on each half. */
  assert.match(source, /aria-label=\{t\("sub_traffic_total_quota"\) \+ " " \+ t\("ocs_unit_label"\)\}/, 'the byte unit selector must be named');
});

test('the notification centre exposes a keyboard operable control per item', () => {
  const source = read('app/components/NotificationCenter.tsx');
  /*
   * The row was a bare <div onClick>: a keyboard user could open the panel but
   * could never activate a notification. The row stays a pointer convenience;
   * the explicit affordance is a real button with an accessible name.
   */
  assert.match(source, /<button\s+type="button"\s+className="notif-card-link"/, 'the notification link must be a real button');
  assert.match(source, /aria-label=\{`\$\{t\('notif_view_details'\)\}: \$\{item\.title\}`\}/, 'the notification button must name its target');
  assert.doesNotMatch(source, /<div className="notif-card-link"/, 'the notification link must not be a plain div');
});

test('the command palette announces the highlighted row and the active category', () => {
  const palette = read('app/components/CommandPalette.tsx');
  /* Arrow keys only move a visual highlight while focus stays in the search
   * field, so the active row has to be announced. */
  assert.match(palette, /aria-current=\{selected \? 'true' : undefined\}/, 'the highlighted palette row must be announced');
  assert.match(palette, /aria-pressed=\{activeCategory === category\}/, 'the palette category tabs must report their state');
});

test('the NF alerts module defines every badge class its components use', () => {
  const css = read('styles/modules/nf-alerts.module.css');
  const components = [
    'features/nf-alerts/NfAlertEvidenceDrawer.tsx',
    'features/nf-alerts/NotificationSettingsDialog.tsx',
  ];
  const used = new Set();
  for (const path of components) {
    for (const match of read(path).matchAll(/styles\.(badge[A-Za-z]+|probeEditorEmpty)/g)) used.add(match[1]);
  }
  assert.ok(used.size > 0, 'expected the nf-alerts components to reference badge classes');
  for (const name of used) {
    assert.match(css, new RegExp(`\\.${name}\\b`), `nf-alerts.module.css must define .${name}`);
  }
});

test('every CSS-module class a component references is defined in that module', () => {
  const files = [
    'features/knowledge/KnowledgeEditorPage.tsx',
    'features/topology/ResourceTopologyPage.tsx',
    'features/topology/components/TopologyLedgerPanel.tsx',
    'components/ui/DataTablePagination.tsx',
    'features/nf-alerts/NfAlertEvidenceDrawer.tsx',
    'features/nf-alerts/NotificationSettingsDialog.tsx',
  ];
  for (const path of files) {
    const source = read(path);
    const imported = source.match(/import styles from '([^']+\.module\.css)'/);
    assert.ok(imported, `${path} must import its own CSS module`);
    const cssPath = resolve(dirname(readSource(path)), imported[1]);
    const css = readFileSync(cssPath, 'utf8');
    for (const match of source.matchAll(/styles\.([A-Za-z][A-Za-z0-9]*)/g)) {
      const name = match[1];
      assert.match(css, new RegExp(`\\.${name}\\b`), `${path} references styles.${name}, which its CSS module does not define`);
    }
  }
});

test('the balance adjustment review table uses localized labels, not raw keys', () => {
  const modal = read('components/ocs/balances/AdjustBalanceModal.tsx');
  for (const raw of ["t('metric')", "t('total')", "t('available')", "t('refreshing')"]) {
    assert.ok(!modal.includes(raw), `${raw} renders a raw dictionary key`);
  }
  for (const key of ['ocs_balance_review_metric', 'ocs_balance_review_total', 'ocs_balance_review_available', 'ocs_balance_review_refreshing']) {
    assert.ok(modal.includes(key), `the review table must use ${key}`);
  }
  const en = read('lib/locales/en.ts');
  const zh = read('lib/locales/zh.ts');
  for (const key of ['ocs_balance_review_metric', 'ocs_balance_review_total', 'ocs_balance_review_available', 'ocs_balance_review_refreshing']) {
    assert.match(en, new RegExp(`\\b${key}:\\s*"[^"]+"`), `en.ts must translate ${key}`);
    assert.match(zh, new RegExp(`\\b${key}:\\s*"[^"]+"`), `zh.ts must translate ${key}`);
  }
});
