import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = join(projectRoot, 'src');

function collectFiles(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(absolutePath, extensions);
    return extensions.has(extname(entry.name)) ? [absolutePath] : [];
  });
}

test('application UI colors are sourced from the global semantic token contract', () => {
  const uiFiles = collectFiles(sourceRoot, new Set(['.css', '.ts', '.tsx']));

  for (const file of uiFiles) {
    const projectPath = relative(projectRoot, file).replaceAll('\\', '/');
    if (projectPath === 'src/app/globals.css') continue;

    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /#[\da-f]{3,8}\b|rgba?\s*\(|(?:color|background|border(?:-color)?|fill|stroke)\s*:\s*(?:white|black|red|blue|green|orange|purple)\b|(?:color|backgroundColor|borderColor|fill|stroke)\s*:\s*["'](?:white|black|red|blue|green|orange|purple)["']/i,
      `${projectPath} contains a component-local color literal`,
    );
  }
});

test('global color literals are confined to centralized token declarations', () => {
  const globalStylesPath = join(sourceRoot, 'app', 'globals.css');
  const globalStyles = readFileSync(globalStylesPath, 'utf8');
  const lines = globalStyles.split(/\r?\n/);
  const colorLiteral = /#[\da-f]{3,8}\b|rgba?\s*\(|(?:color|background|border(?:-color)?|fill|stroke)\s*:\s*(?:white|black|red|blue|green|orange|purple)\b/i;
  const allowedScopes = new Set([':root', '[data-theme="light"]', '[data-theme="dark"]']);
  let activeScope = '';
  let depth = 0;

  for (const [index, line] of lines.entries()) {
    if (depth === 0 && line.includes('{')) activeScope = line.slice(0, line.indexOf('{')).trim();

    if (colorLiteral.test(line)) {
      assert.match(
        line,
        /^\s*--[\w-]+\s*:/,
        `src/app/globals.css:${index + 1} contains a color literal outside a token declaration`,
      );
      assert.equal(
        allowedScopes.has(activeScope),
        true,
        `src/app/globals.css:${index + 1} declares a color literal in unsupported scope ${activeScope}`,
      );
    }

    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (depth === 0) activeScope = '';
  }

  for (const token of ['--scrollbar-thumb', '--scrollbar-thumb-hover', '--search-icon']) {
    assert.equal(
      globalStyles.match(new RegExp(`${token}:`, 'g'))?.length,
      2,
      `${token} must define matching light and dark theme values`,
    );
  }
});

test('application typography and corner radii use the global reference tokens', () => {
  const uiFiles = collectFiles(sourceRoot, new Set(['.css', '.ts', '.tsx']));

  for (const file of uiFiles) {
    const projectPath = relative(projectRoot, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf8');

    if (extname(file) === '.css') {
      assert.doesNotMatch(
        source,
        /font-size\s*:(?!\s*var\()[^;]+;/i,
        `${projectPath} contains a font-size literal`,
      );
      assert.doesNotMatch(
        source,
        /border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:(?!\s*(?:var\(|inherit\b|0(?:\s|;)))[^;]+;/i,
        `${projectPath} contains a border-radius literal`,
      );
    }

    assert.doesNotMatch(
      source,
      /(?:fontSize|borderRadius)\s*:\s*(?:["'](?!var\()[^"']+["']|\d+(?:\.\d+)?)/,
      `${projectPath} contains an inline typography or radius literal`,
    );
    assert.doesNotMatch(
      source,
      /var\(--radius-/,
      `${projectPath} references a retired radius alias`,
    );
  }
});

test('responsive width queries stay inside the documented breakpoint vocabulary', () => {
  const designRules = readFileSync(join(projectRoot, 'docs/design-system-rules.md'), 'utf8');
  const approvedBreakpoints = new Set([560, 640, 760, 768, 900, 980, 1180, 1440]);
  const grandfatheredBreakpoints = new Map([
    ['src/app/globals.css', new Set([780, 1100, 1400])],
    ['src/app/(dashboard)/users/users.css', new Set([700, 860])],
    ['src/components/analytics.css', new Set([480])],
  ]);

  for (const value of approvedBreakpoints) {
    assert.equal(designRules.includes(`${value}px`), true, `${value}px must be documented`);
  }

  for (const file of collectFiles(sourceRoot, new Set(['.css']))) {
    const projectPath = relative(projectRoot, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf8');
    const widthQueries = source.matchAll(/@media\s*\(\s*(?:min|max)-width:\s*(\d+)px\s*\)/g);

    for (const match of widthQueries) {
      const value = Number(match[1]);
      const isApproved = approvedBreakpoints.has(value);
      const isGrandfathered = grandfatheredBreakpoints.get(projectPath)?.has(value) ?? false;
      assert.equal(
        isApproved || isGrandfathered,
        true,
        `${projectPath} introduces undocumented ${value}px breakpoint`,
      );
    }
  }
});
