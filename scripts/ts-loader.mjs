/**
 * Custom ESM loader that resolves @/ path aliases from tsconfig.json.
 * Use with: node --import ./scripts/register-paths.mjs --experimental-strip-types
 */
import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cwd } from 'node:process';

const ROOT = cwd();

export async function resolve(specifier, context, nextResolve) {
  // Resolve @/ aliases
  if (specifier.startsWith('@/')) {
    const base = pathResolve(ROOT, 'src', specifier.slice(2));

    // Try extensions in order: .ts, .tsx, .js, .jsx, then bare
    const candidates = [base + '.ts', base + '.tsx', base + '.js', base + '.jsx', base];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }

    // Try as directory with index
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const indexFile = pathResolve(base, 'index' + ext);
      if (existsSync(indexFile)) {
        return { url: pathToFileURL(indexFile).href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}
