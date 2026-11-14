import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { NfAlertRuleDialog } from '../src/features/nf-alerts/NfAlertRuleDialog';
import type { AlertRule } from '../src/features/nf-alerts/nf-alerts-types';

function render(rule: AlertRule | null) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(NfAlertRuleDialog, {
        open: true,
        meta: null,
        rule,
        onClose: () => {},
        onSaved: () => {},
        onFormError: () => {},
      }),
    ),
  );
}

test('a new rule selects its scope instead of accepting raw UUIDs', () => {
  const markup = render(null);
  assert.ok(markup.includes('id="nf-alerts-scope-mode"'), 'the scope selector must render');
  assert.ok(markup.includes('All targets'));
  assert.ok(markup.includes('One health target'));
  assert.ok(markup.includes('One resource'));
  assert.ok(!markup.includes('nf-alerts-target"'), 'no raw target UUID input is rendered');
  assert.ok(!markup.includes('nf-alerts-resource"'), 'no raw resource UUID input is rendered');
});

test('an existing rule shows its immutable target identity', () => {
  const rule = {
    ruleId: 'rule-1',
    name: 'AMF process unhealthy',
    enabled: true,
    targetId: '0192f0c0-a000-7000-8000-0000000000a1',
    conditionType: 'state',
    condition: { scope: 'process', state: 'unhealthy' },
    severity: 'critical',
    cooldownSeconds: 300,
    revision: 1,
  } as unknown as AlertRule;
  const markup = render(rule);
  assert.ok(markup.includes('0192f0c0-a000-7000-8000-0000000000a1'));
  assert.ok(!markup.includes('id="nf-alerts-scope-mode"'), 'edit must not offer retargeting');
});
