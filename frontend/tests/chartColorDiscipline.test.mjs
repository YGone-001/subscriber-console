import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(projectRoot, 'src');
const GLOBALS_FILE = 'app/globals.css';

function read(relativePath) {
  return readFileSync(path.join(sourceRoot, relativePath), 'utf8');
}

function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.(?:tsx?|css)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/*
 * Chart color discipline: --chart-1..6 are the categorical series palette and
 * exist for graphical data marks only. Consumption is limited to the
 * visualization layer, namely:
 *   - the palette module that feeds chart marks (chartPrimitives.tsx)
 *   - visualization tiles that render micro-charts plus their matching series
 *     identity accents (AnalyticsCockpit.tsx)
 *   - the stylesheet carrying mark fills, split segments, series/state dots
 *     and telemetry tile identity tints (analytics.css)
 * Chrome surfaces (icons on non-visualization cards, badges, pills, text
 * values, selection highlights, workflow states) must resolve through
 * semantic families instead (--primary / --status-* / --text-*).
 */
const CHART_VISUALIZATION_MODULES = new Set([
  'components/ui/chartPrimitives.tsx',
  'components/AnalyticsCockpit.tsx',
  'components/analytics.css',
]);

const chartReference = () => /--chart-[1-6](?![0-9])/g;

function themeBlock(css, theme) {
  const match = css.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`));
  assert.ok(match, `[data-theme="${theme}"] block must exist`);
  return match[1];
}

function hexToken(block, token) {
  const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `${token} must be defined as a hex value`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(hex.slice(offset + 1, offset + 3), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('chart palette is defined once per theme with distinct light and dark values', () => {
  const css = read(GLOBALS_FILE);
  assert.doesNotMatch(css, /var\(--chart-/, 'globals.css defines the palette and must never consume it');

  for (let index = 1; index <= 6; index += 1) {
    const definitions = css.match(new RegExp(`--chart-${index}:\\s*[^;]+;`, 'g')) ?? [];
    assert.equal(definitions.length, 2, `--chart-${index} must be mapped in both themes`);
    assert.equal(new Set(definitions).size, 2, `--chart-${index} light and dark values must differ`);
  }
});

test('chart tokens are consumed only by the visualization modules', () => {
  const offenders = [];
  const consumers = new Set();

  for (const file of listSourceFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
    const hits = readFileSync(file, 'utf8').match(chartReference());
    if (!hits) continue;
    consumers.add(relative);
    if (relative !== GLOBALS_FILE && !CHART_VISUALIZATION_MODULES.has(relative)) {
      offenders.push(`${relative} (${hits.length})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `chart palette leaked into non-visualization surfaces: ${offenders.join(', ')}`,
  );

  for (const visualizationModule of CHART_VISUALIZATION_MODULES) {
    assert.ok(consumers.has(visualizationModule), `${visualizationModule} must consume the chart palette as a visualization module`);
  }
});

test('chart palettes enumerate design tokens only', () => {
  const primitives = read('components/ui/chartPrimitives.tsx');
  assert.doesNotMatch(primitives, /#[0-9a-fA-F]{3,8}\b/, 'palette entries must be tokens, never literals');

  const seriesBlock = primitives.match(/CHART_SERIES_COLORS = \[([\s\S]*?)\]/)[1];
  const seriesEntries = seriesBlock.match(/"[^"]+"/g) ?? [];
  const seriesTokens = new Set();
  for (const entry of seriesEntries) {
    const token = entry.match(/^"var\((--chart-[1-6])\)"$/);
    assert.ok(token, `series palette entry must be a chart token: ${entry}`);
    seriesTokens.add(token[1]);
  }
  assert.deepEqual(
    [...seriesTokens].sort(),
    ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6'],
    'the categorical series palette must enumerate all six chart tokens',
  );

  const planBlock = primitives.match(/PLAN_CHART_COLORS = \[([\s\S]*?)\]/)[1];
  for (const entry of planBlock.match(/"[^"]+"/g) ?? []) {
    assert.match(
      entry,
      /^"var\(--(?:chart-[1-6]|status-(?:info|warning))\)"$/,
      `plan palette entry must be a chart or status token: ${entry}`,
    );
  }
});

test('chart hues stay legible as graphical marks on both theme surfaces', () => {
  const css = read(GLOBALS_FILE);

  for (const theme of ['light', 'dark']) {
    const block = themeBlock(css, theme);
    const marks = Array.from({ length: 6 }, (_, index) => hexToken(block, `--chart-${index + 1}`));
    for (const backdrop of ['--surface', '--background']) {
      const canvas = hexToken(block, backdrop);
      for (const mark of marks) {
        assert.ok(
          contrastRatio(mark, canvas) >= 3,
          `${theme} ${mark} must meet 3:1 non-text contrast against ${backdrop} (${contrastRatio(mark, canvas).toFixed(2)})`,
        );
      }
    }
  }
});

test('audited chrome surfaces resolve through semantic families', () => {
  const systemHealth = read('app/(dashboard)/system-health/page.tsx');
  assert.match(systemHealth, /icon=\{<Zap size=\{20\} color="var\(--primary\)" \/>\}/);
  assert.match(systemHealth, /icon=\{<Layers size=\{20\} color="var\(--primary\)" \/>\}/);
  assert.match(systemHealth, /icon=\{<ShieldCheck size=\{20\} color="var\(--primary\)" \/>\}/);

  const noc = read('components/NocSentinel.css');
  assert.match(noc, /\.noc-workflow-pill\.assigned\s*\{[\s\S]*?var\(--status-info\)/);

  const datahub = read('components/datahub.css');
  assert.match(datahub, /\.dh-badge-duplicate\s*\{[\s\S]*?var\(--status-info-soft\)/);
  assert.match(datahub, /\.dh-badge-duplicate\s*\{[\s\S]*?var\(--status-info\)/);

  const ocs = read('app/(dashboard)/ocs/ocs.css');
  assert.match(ocs, /\.ocs-badge\.interface-ro\s*\{[\s\S]*?var\(--primary\)/);
  assert.match(ocs, /\.ocs-text-info\s*\{\s*color:\s*var\(--status-info\);\s*\}/);
  assert.match(ocs, /\.ocs-text-primary\s*\{\s*color:\s*var\(--primary\);\s*\}/);
  assert.doesNotMatch(ocs, /ocs-text-chart/);

  const usagePanel = read('components/ocs/OcsUsagePanel.tsx');
  assert.match(usagePanel, /ocs-text-info/);
  assert.match(usagePanel, /ocs-text-primary/);
  assert.doesNotMatch(usagePanel, /ocs-text-chart/);

  const rating = read('components/rating/hooks/useRatingManagement.tsx');
  assert.match(rating, /key === "sms"[\s\S]*?var\(--status-info\)/);

  const plmn = read('components/analytics/PlmnDistributionChart.tsx');
  assert.match(plmn, /<Server size=\{18\} color="var\(--primary\)" \/>/);
});