/*
 * One-off scan: untranslated copy and unresolved dictionary keys.
 *
 * Two failure modes the acceptance criteria name explicitly:
 *   1. hard-coded English (or Chinese) text rendered directly in JSX;
 *   2. a `t("some_key")` call whose key is missing from BOTH dictionaries, so the
 *      raw key would render on a production page.
 *
 * Usage: node scripts/scan-untranslated.mjs [dir ...]
 */
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = 'C:/Users/YGone/Desktop/program/subscriber-console';
const SRC = path.join(PROJECT, 'frontend', 'src');
const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((dir) => path.join(SRC, dir))
  : [SRC];

/* Tokens that are legitimately identical in both locales. */
const ALLOWED_LITERALS = new Set([
  'IMSI', 'MSISDN', 'ICCID', 'IMEI', 'OK', 'API', 'URL', 'URI', 'ID', 'IP', 'IPv4', 'IPv6',
  'JSON', 'CSV', 'XML', 'HTML', 'SQL', 'HTTP', 'HTTPS', 'TCP', 'UDP', 'DNS', 'TLS', 'JWT',
  'MCC', 'MNC', 'PLMN', 'AMBR', 'QoS', 'QCI', '5QI', 'ARP', 'SD', 'SST', 'DNN', 'PCC', 'APN',
  'OCS', 'HSS', 'MME', 'PGW', 'SGW', 'eNB', 'gNB', 'UE', 'SIM', 'Gx', 'Gy', 'Ro', 'S6a',
  'xCloud', 'NOC', 'RBAC', 'IAM', 'CAS', 'UI', 'UX', 'CPU', 'RAM', 'TTL', 'BGSAVE', 'RDB', 'AOF',
  'MongoDB', 'Redis', 'Go', 'Node', 'Vite', 'React', 'TSV', 'PDF', 'XLSX', 'UTF-8',
]);

const dictionaryKeys = (() => {
  const keys = new Set();
  for (const file of ['lib/locales/en.ts', 'lib/locales/zh.ts', 'lib/locales.ts']) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    /* Dictionary entries share lines, so match any `key: 'value'` pair rather than
     * requiring the key to start a line. */
    for (const match of source.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*['"`]/g)) keys.add(match[1]);
  }
  return keys;
})();

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

const literalHits = [];
const keyHits = [];

for (const dir of targets) {
  for (const file of walk(dir)) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');

    for (const match of source.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}[^<>{}\n]*)</g)) {
      const text = match[1].trim();
      if (!text || ALLOWED_LITERALS.has(text)) continue;
      /* Only flag text that looks like prose, not an identifier or a symbol. */
      if (!/^[A-Za-z][A-Za-z0-9 ,.'()/%:-]*$/.test(text)) continue;
      if (/^[a-z][a-z0-9_]*$/.test(text)) continue;
      literalHits.push(`${rel}: ${text.slice(0, 90)}`);
    }

    for (const match of source.matchAll(/\bt\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
      if (!dictionaryKeys.has(match[1])) keyHits.push(`${rel}: ${match[1]}`);
    }
  }
}

console.log(`untranslated_literals=${literalHits.length}`);
for (const hit of literalHits) console.log('  ', hit);
console.log(`unresolved_keys=${keyHits.length}`);
for (const hit of [...new Set(keyHits)]) console.log('  ', hit);
