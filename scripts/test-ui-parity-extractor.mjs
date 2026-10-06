#!/usr/bin/env node
/*
 * Class-extractor contract.
 *
 * The parity metric is only as honest as its tokeniser, so the tokeniser has fixed
 * tests. The two cases that motivated the syntax-aware rule look identical in source
 * and must be told apart:
 *
 *   className={`ocs-feedback-${feedback.type}`}        -> `ocs-feedback-` is a FRAGMENT
 *   className={`subsystem-metric-val${metric.tone}`}   -> `subsystem-metric-val` is COMPLETE
 *
 * Syntax alone cannot decide, so a boundary-touching token counts only when a
 * stylesheet defines it. Interpolation VARIABLE names (`status`, `tone`, `danger`, ...)
 * must never be emitted at all - the previous tokeniser split on the interpolation
 * marker and counted them as classes.
 *
 * Usage: node scripts/test-ui-parity-extractor.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classTokensOfExpression } from './lib/ui-parity-graph.mjs';

/** Only these are "defined in a stylesheet" for the fixtures below. */
const STYLESHEET = new Set(['subsystem-metric-val', 'notif-type-icon', 'success', 'critical', 'warning', 'info']);

const tokens = (expression, isTemplate = true) =>
  [...classTokensOfExpression(expression, isTemplate, STYLESHEET)];

test('a fragment touching an interpolation boundary is dropped', () => {
  assert.deepEqual(tokens('ocs-feedback-${feedback.type}'), []);
  assert.deepEqual(tokens('op-notice-icon-${tone}'), []);
  assert.deepEqual(tokens('cp-badge-${item.type}'), []);
  assert.deepEqual(tokens('profile-domain-${profile.domain}'), []);
});

test('the real classes the fragment would have produced are still detected', () => {
  /* Both are covered explicitly in the current markup; they must count. */
  assert.ok(tokens('ocs-feedback-success', false).includes('ocs-feedback-success'));
  assert.ok(tokens('ocs-feedback-error', false).includes('ocs-feedback-error'));
});

test('a complete class concatenated with an interpolation is kept when a stylesheet defines it', () => {
  /* `subsystem-metric-val` is a real class; the interpolation only appends an optional suffix. */
  assert.deepEqual(tokens('subsystem-metric-val${metric.tone ? ` ${metric.tone}` : ""}'), ['subsystem-metric-val']);
});

test('a boundary-touching token no stylesheet defines is dropped', () => {
  assert.deepEqual(tokens('never-defined-anywhere${value}'), []);
});

test('interpolation variable names are never emitted as classes', () => {
  for (const expression of [
    'notif-status-dot ${status}',
    'badge ${tone}',
    'analytics-kpi-card ${danger ? "danger" : ""}',
    'panel ${compact ? "compact" : ""}',
    '${pathname} selected',
  ]) {
    const found = tokens(expression);
    for (const name of ['status', 'tone', 'danger', 'compact', 'pathname']) {
      assert.ok(!found.includes(name), `"${name}" must not be emitted from ${expression}`);
    }
  }
});

test('static tokens on both sides of an interpolation survive', () => {
  assert.deepEqual(tokens('a b ${x} c d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(tokens('${x} noc-panel'), ['noc-panel']);
  assert.deepEqual(tokens('noc-panel ${x}'), ['noc-panel']);
});

test('a plain string literal is taken whole, interpolation rules do not apply', () => {
  assert.deepEqual(tokens('notif-type-icon success', false), ['notif-type-icon', 'success']);
  assert.deepEqual(tokens('btn btn-outline', false), ['btn', 'btn-outline']);
});

test('nested braces inside an interpolation do not leak static text', () => {
  assert.deepEqual(tokens('wrap ${items.map((item) => ({ id: item.id }))} tail'), ['wrap', 'tail']);
});

test('non-class content is rejected', () => {
  assert.deepEqual(tokens('${styles.foo} ${other}', false), []);
  assert.deepEqual(tokens('UPPER case_underscore 123', false), []);
});

console.log('ui_parity_extractor_selftest=PASS');
