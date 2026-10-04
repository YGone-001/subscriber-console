import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const spaRoot = resolve(import.meta.dirname, '..');
const srcDir = resolve(spaRoot, 'src');

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(full)) files.push(full);
  }
  return files;
}

const allSource = walk(srcDir).map((f) => readFileSync(f, 'utf8')).join('\n');

test('absolute denylist mutation endpoints are completely absent from SPA source', () => {
  const forbiddenPatterns = [
    { name: 'balance reset', pattern: /\/api\/ocs\/balances\/[^/]+\/reset/ },
    { name: 'subscriber policy assignment', pattern: /\/api\/subscribers\/policy/ },
    { name: 'ratings write post', pattern: /postJson\(['"]\/api\/ratings/ },
    { name: 'ratings write put', pattern: /putJson\(['"]\/api\/ratings/ },
    { name: 'ratings write delete', pattern: /deleteJson\(['"]\/api\/ratings/ },
    { name: 'tariff rules write post', pattern: /postJson\(['"][^'"]*\/rules/ },
    { name: 'tariff rules write put', pattern: /putJson\(['"][^'"]*\/rules/ },
    { name: 'tariff rules write delete', pattern: /deleteJson\(['"][^'"]*\/rules/ },
    { name: 'tariff import mutation', pattern: /postJson\(['"][^'"]*\/tariff-plans[^'"]*import/ },
    { name: 'tariff migrate mutation', pattern: /postJson\(['"][^'"]*\/migrate/ },
    { name: 'system heal mutation', pattern: /postJson\(['"]\/api\/system\/audit\/heal/ },
    { name: 'system batch-heal mutation', pattern: /postJson\(['"]\/api\/system\/audit\/batch-heal/ },
  ];

  for (const { name, pattern } of forbiddenPatterns) {
    assert.doesNotMatch(allSource, pattern, `forbidden operation must be absent: ${name}`);
  }
});
