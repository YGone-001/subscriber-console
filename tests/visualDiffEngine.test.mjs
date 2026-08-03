import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  computeObjectDiff,
  computeLineDiff,
  generateUnifiedPatch,
  formatDiffValue,
  humanizePath,
} from '../src/lib/diffEngine.ts';

test('diffEngine correctly computes deep object diffs', () => {
  const oldDoc = {
    imsi: '001010000000001',
    slice: [
      {
        sst: 1,
        sd: '000001',
        session: [{ dnn: 'internet', ambr: { downlink: 10000000, uplink: 5000000 } }],
      },
    ],
    status: 'ACTIVE',
    notes: 'Legacy profile',
  };

  const newDoc = {
    imsi: '001010000000001',
    slice: [
      {
        sst: 1,
        sd: '000001',
        session: [{ dnn: 'internet', ambr: { downlink: 50000000, uplink: 10000000 } }],
      },
    ],
    status: 'SUSPENDED',
    tier: 'VIP',
  };

  const result = computeObjectDiff(oldDoc, newDoc);

  assert.equal(result.summary.hasChanges, true);
  assert.equal(result.summary.added, 1); // tier: 'VIP'
  assert.equal(result.summary.removed, 1); // notes: 'Legacy profile'
  assert.equal(result.summary.modified, 3); // status, downlink, uplink

  const statusDiff = result.fields.find((f) => f.path === 'status');
  assert.ok(statusDiff);
  assert.equal(statusDiff.type, 'modified');
  assert.equal(statusDiff.oldValue, 'ACTIVE');
  assert.equal(statusDiff.newValue, 'SUSPENDED');

  const tierDiff = result.fields.find((f) => f.path === 'tier');
  assert.ok(tierDiff);
  assert.equal(tierDiff.type, 'added');
  assert.equal(tierDiff.newValue, 'VIP');

  const notesDiff = result.fields.find((f) => f.path === 'notes');
  assert.ok(notesDiff);
  assert.equal(notesDiff.type, 'removed');
});

test('diffEngine formats telecom bitrates and data byte amounts', () => {
  assert.equal(formatDiffValue(100000000, 'ambr.downlink'), '100.0 Mbps');
  assert.equal(formatDiffValue(1000000000, 'bitrate'), '1.0 Gbps');
  assert.equal(formatDiffValue(true), 'true');
  assert.equal(formatDiffValue(null), '—');
  assert.equal(humanizePath('slice[0].session[0].ambr.downlink'), 'Downlink');
});

test('diffEngine calculates line diffs and unified patch', () => {
  const oldText = '{\n  "imsi": "001",\n  "status": "ACTIVE"\n}';
  const newText = '{\n  "imsi": "001",\n  "status": "SUSPENDED"\n}';

  const lines = computeLineDiff(oldText, newText);
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => l.type === 'del' && l.content.includes('ACTIVE')));
  assert.ok(lines.some((l) => l.type === 'add' && l.content.includes('SUSPENDED')));

  const patch = generateUnifiedPatch({ a: 1 }, { a: 2 }, 'TestPatch');
  assert.ok(patch.includes('--- TestPatch'));
  assert.ok(patch.includes('+++ TestPatch'));
  assert.ok(patch.includes('-   "a": 1'));
  assert.ok(patch.includes('+   "a": 2'));
});

test('VisualDiffViewer component and CSS files exist', () => {
  const componentPath = path.resolve('src/components/VisualDiffViewer.tsx');
  const cssPath = path.resolve('src/components/diff-viewer.css');
  assert.ok(existsSync(componentPath), 'VisualDiffViewer.tsx should exist');
  assert.ok(existsSync(cssPath), 'diff-viewer.css should exist');
});

test('Diff translation keys are aligned across en.ts and zh.ts', () => {
  const enContent = readFileSync(path.resolve('src/lib/locales/en.ts'), 'utf-8');
  const zhContent = readFileSync(path.resolve('src/lib/locales/zh.ts'), 'utf-8');

  const requiredKeys = [
    'diff_viewer_title',
    'diff_stat_added',
    'diff_stat_modified',
    'diff_stat_removed',
    'diff_no_changes',
    'diff_mode_semantic',
    'diff_mode_split',
    'diff_mode_unified',
    'diff_search_ph',
    'diff_changes_only',
    'diff_copy_patch',
    'diff_no_differences_found',
  ];

  for (const key of requiredKeys) {
    assert.ok(enContent.includes(`${key}:`), `en.ts should contain key ${key}`);
    assert.ok(zhContent.includes(`${key}:`), `zh.ts should contain key ${key}`);
  }
});
