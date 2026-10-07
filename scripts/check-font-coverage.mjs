#!/usr/bin/env node
/*
 * Fail the build when the committed font subset no longer covers the source.
 *
 * The subset is generated from the source at the moment `npm run build:fonts` runs. Add UI text
 * afterwards without regenerating and the new characters are simply absent from the face - the
 * browser silently substitutes a system font and the page renders in mixed typography. Nothing
 * else in the pipeline notices: the build succeeds, the tests pass, and the defect only shows up
 * as a visual inconsistency that nobody can attribute to anything.
 *
 * This turns that silent degradation into a loud failure.
 *
 * It reads the `coverage.json` manifest written alongside the font rather than parsing the woff2.
 * That keeps the check free of fontTools and of the source font, so it runs on any platform and
 * without network - which matters because the whole point of the manifest is to work in
 * environments where regenerating the font is not possible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'frontend', 'src');
const MANIFEST = path.join(SRC, 'assets', 'fonts', 'coverage.json');
const FONT = path.join(SRC, 'assets', 'fonts', 'NotoSansSC-subset.woff2');

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, acc);
    else if (full.endsWith('.ts') || full.endsWith('.tsx') || full.endsWith('.css') || full.endsWith('.html')) acc.push(full);
  }
  return acc;
}

if (!fs.existsSync(MANIFEST)) {
  console.log('font_coverage=FAIL');
  console.log('  reason=manifest_missing');
  console.log('  detail=expected ' + path.relative(HERE, MANIFEST));
  console.log('  fix=npm run build:fonts (needs the Noto Sans SC variable font and fonttools[woff])');
  process.exit(1);
}

if (!fs.existsSync(FONT) || fs.statSync(FONT).size === 0) {
  console.log('font_coverage=FAIL');
  console.log('  reason=font_missing');
  console.log('  detail=expected a non-empty ' + path.relative(HERE, FONT));
  console.log('  fix=npm run build:fonts');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
if (!Array.isArray(manifest.ranges) || manifest.ranges.length === 0 || manifest.ranges.length % 2 !== 0) {
  console.log('font_coverage=FAIL');
  console.log('  reason=manifest_invalid');
  console.log('  detail=coverage.json must contain non-empty [start, end] range pairs');
  process.exit(1);
}

const covered = new Set();
for (let i = 0; i < manifest.ranges.length; i += 2) {
  const start = manifest.ranges[i];
  const end = manifest.ranges[i + 1];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 0x10ffff || start > end) {
    console.log('font_coverage=FAIL');
    console.log('  reason=manifest_invalid');
    console.log(`  detail=invalid coverage range at index ${i}`);
    process.exit(1);
  }
  for (let cp = start; cp <= end; cp += 1) covered.add(cp);
}

/* Same file set the subset builder uses, so the two cannot disagree about what "the source" is. */
const files = walk(SRC).filter((f) => !f.replace(/\\/g, '/').split('/').includes('assets'));

/*
 * Only glyph-bearing characters count. Control, format and separator code points never paint a
 * glyph, so a source file's CRLF line endings (U+000D) or a BOM (U+FEFF) must not be reported as
 * missing coverage - they are not, and could not be, in the font.
 */
const NON_PAINTING = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/u;

const missing = new Map();
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const ch of text) {
    if (NON_PAINTING.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if (!covered.has(cp)) {
      if (!missing.has(cp)) missing.set(cp, { ch, files: new Set() });
      missing.get(cp).files.add(path.relative(SRC, file).replace(/\\/g, '/'));
    }
  }
}

console.log('font_subset_font=' + manifest.font);
console.log('font_subset_coverage=' + manifest.coverage);
console.log('font_subset_codepoints=' + covered.size);
console.log('font_missing_codepoints=' + missing.size);

if (missing.size === 0) {
  console.log('font_coverage=PASS');
  process.exit(0);
}

console.log('font_coverage=FAIL');
console.log('  reason=subset_out_of_date');
console.log('  detail=the source contains characters the committed subset does not carry, so they would');
console.log('         render in a substituted system font and the page would show mixed typography');
for (const [cp, info] of [...missing.entries()].sort((a, b) => a[0] - b[0]).slice(0, 40)) {
  console.log('    U+%s %s  %s', cp.toString(16).toUpperCase().padStart(4, '0'), info.ch, [...info.files].join(', '));
}
if (missing.size > 40) console.log('    ... and %d more', missing.size - 40);
console.log('  fix=npm run build:fonts');
process.exit(1);
