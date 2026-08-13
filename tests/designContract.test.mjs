import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
const sidecar = JSON.parse(readFileSync(new URL('../.impeccable/design.json', import.meta.url), 'utf8'));

test('DESIGN.md records the implemented responsive and touch contracts', () => {
  assert.match(design, /44×44px/);
  assert.match(design, /data-label/);
  assert.match(design, /记录卡/);
  assert.match(design, /980px 以下/);
  assert.match(design, /off-canvas/);
  assert.match(design, /pointer: coarse/);
});

test('DESIGN.md separates operational states and rendering performance rules', () => {
  for (const role of ['Selection', 'Information', 'Success / Healthy', 'Warning', 'Danger', 'Neutral']) {
    assert.match(design, new RegExp(role.replace('/', '\\/')));
  }

  assert.match(design, /The Compositor Motion Rule/);
  assert.match(design, /不得过渡 width、height、max-height、padding 或 margin/);
  assert.match(design, /普通卡片、工具条、登录卡和持久工作面不使用 backdrop blur/);
  assert.match(design, /prefers-reduced-motion/);
});

test('design sidecar is valid UTF-8 metadata aligned with current tokens and components', () => {
  assert.equal(sidecar.schemaVersion, 2);
  assert.equal(sidecar.title, 'Design System: xCloud');
  assert.equal(sidecar.extensions.colorMeta['operational-info-day'].canonical, '#176f91');
  assert.equal(sidecar.extensions.breakpoints.find(item => item.name === 'dense-table-cards')?.value, '760px');
  assert.equal(sidecar.components.some(component => component.name === 'Icon Action' && component.css.includes('44px')), true);
  assert.equal(sidecar.components.some(component => component.name === 'Dense Mobile Record'), true);
  assert.equal(sidecar.narrative.rules.some(rule => rule.name === 'The Compositor Motion Rule'), true);
  assert.doesNotMatch(JSON.stringify(sidecar), /[�]/);
});
