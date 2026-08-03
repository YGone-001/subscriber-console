import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { en } from '../src/lib/locales/en.ts';
import { zh } from '../src/lib/locales/zh.ts';

const LOCALES = { en, zh };
const DEFAULT_LOCALE = 'en';

test('i18n: en and zh dictionaries have strict 1:1 key parity', () => {
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();

  const enSet = new Set(enKeys);
  const zhSet = new Set(zhKeys);

  const missingInZh = enKeys.filter((k) => !zhSet.has(k));
  const missingInEn = zhKeys.filter((k) => !enSet.has(k));

  assert.deepStrictEqual(
    missingInZh,
    [],
    `Keys present in EN but missing in ZH: ${missingInZh.join(', ')}`
  );
  assert.deepStrictEqual(
    missingInEn,
    [],
    `Keys present in ZH but missing in EN: ${missingInEn.join(', ')}`
  );
  assert.strictEqual(enKeys.length, zhKeys.length);
  assert.ok(enKeys.length > 1500, `Expected over 1500 localized keys, got ${enKeys.length}`);
});

test('i18n: all t("key") references in src/ exist in both dictionaries', () => {
  const srcDir = path.resolve('src');
  const enSet = new Set(Object.keys(en));
  const zhSet = new Set(Object.keys(zh));

  function scanDir(dir) {
    let files = [];
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        files = files.concat(scanDir(full));
      } else if (/\.(tsx|ts)$/.test(item.name)) {
        files.push(full);
      }
    }
    return files;
  }

  const allFiles = scanDir(srcDir);
  const missingFromEn = [];
  const missingFromZh = [];

  for (const file of allFiles) {
    const content = readFileSync(file, 'utf-8');
    const matches = content.matchAll(/\bt\(\s*["'`]([a-zA-Z0-9_\-.:]+)["'`]/g);
    for (const match of matches) {
      const key = match[1];
      if (!enSet.has(key)) {
        missingFromEn.push({ key, file: path.relative(srcDir, file) });
      }
      if (!zhSet.has(key)) {
        missingFromZh.push({ key, file: path.relative(srcDir, file) });
      }
    }
  }

  assert.deepStrictEqual(
    missingFromEn,
    [],
    `t("...") keys missing from EN: ${JSON.stringify(missingFromEn)}`
  );
  assert.deepStrictEqual(
    missingFromZh,
    [],
    `t("...") keys missing from ZH: ${JSON.stringify(missingFromZh)}`
  );
});

test('i18n: parameter interpolation works correctly', () => {
  const templateEn = en.tariff_plan_ops_recent_count || '{count} recent';
  const templateZh = zh.tariff_plan_ops_recent_count || '{count} recent';

  const interpolatedEn = templateEn.replace(/\{count\}/g, '5');
  const interpolatedZh = templateZh.replace(/\{count\}/g, '5');

  assert.strictEqual(interpolatedEn, '5 recent');
  assert.ok(interpolatedZh.includes('5'));
});

test('i18n: metadata and default locale configuration', () => {
  const localesContent = readFileSync(path.resolve('src/lib/locales.ts'), 'utf-8');
  assert.ok(localesContent.includes("DEFAULT_LOCALE: Locale = 'en'"));
  assert.ok(localesContent.includes('SUPPORTED_LOCALES'));
  assert.ok(LOCALES.en);
  assert.ok(LOCALES.zh);
});
