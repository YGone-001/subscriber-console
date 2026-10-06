/*
 * Import-graph reachability, shared by both sides of the parity measurement.
 *
 * The metric only makes sense if BOTH sides are filtered the same way. Filtering only
 * the current checkout credits the reference for surfaces the historical application
 * itself never rendered - `AnalyticsCockpit` never imported `analytics/KpiCard`, the
 * balances route rendered `OcsBalancePlaceholder` rather than `OcsDetailDrawer`, and
 * the sessions/usage routes redirect to tariffs. Those files are orphans INSIDE the
 * historical graph, so they must fall out of the denominator on their own.
 *
 * Resolution covers every specifier form the codebase uses:
 *   - static `import ... from '...'`
 *   - dynamic `import('...')`
 *   - `export ... from '...'`
 *   - relative paths (`./x`, `../x`)
 *   - the `@/` alias
 *   - `.ts` / `.tsx` / `.jsx` / `.js` and `/index.*`
 */
import fs from 'node:fs';
import path from 'node:path';

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

/** Every module specifier written in a file, whatever the form. */
export function collectSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

function resolveFile(candidate) {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  for (const extension of EXTENSIONS) {
    const withExtension = candidate + extension;
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) return withExtension;
  }
  for (const extension of EXTENSIONS) {
    const asIndex = path.join(candidate, `index${extension}`);
    if (fs.existsSync(asIndex) && fs.statSync(asIndex).isFile()) return asIndex;
  }
  return null;
}

/**
 * Resolves one specifier to an absolute file, or null when it leaves the source tree
 * (a package, an asset, or a stylesheet).
 */
export function resolveSpecifier(fromFile, specifier, srcRoot) {
  if (specifier.startsWith('@/')) return resolveFile(path.join(srcRoot, specifier.slice(2)));
  if (specifier.startsWith('.')) return resolveFile(path.resolve(path.dirname(fromFile), specifier));
  return null;
}

/**
 * Every source file reachable from the given entries.
 *
 * `skip` receives a source-relative path and lets the caller drop whole subtrees the
 * approved scope already excludes, so the walk does not traverse retired surfaces.
 */
export function buildImportGraph({ srcRoot, entries, skip = () => false }) {
  const visited = new Set();
  const queue = [...entries];

  while (queue.length) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const relative = path.relative(srcRoot, file).replace(/\\/g, '/');
    if (skip(relative)) continue;
    if (!/\.(tsx|ts|jsx|js)$/.test(file)) continue;

    visited.add(file);
    for (const specifier of collectSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveSpecifier(file, specifier, srcRoot);
      if (resolved) queue.push(resolved);
    }
  }
  return visited;
}

/*
 * ---------------------------------------------------------------------------
 * SYNTAX-AWARE CLASS EXTRACTION
 *
 * A `className` value is either a plain string literal or a template literal. In a
 * template literal the static text is interrupted by `${...}` expressions, and a
 * token that touches that boundary is INCOMPLETE:
 *
 *   className={`ocs-feedback-${feedback.type}`}
 *
 * only ever produces `ocs-feedback-success` / `ocs-feedback-error` at runtime. The
 * fragment `ocs-feedback-` is not a class the application can render, so it must not
 * enter the vocabulary - neither as a target nor as a missing token.
 *
 * A token is complete only when both of its edges sit on a real boundary: the start of
 * the segment, a whitespace run, or the end of the segment where that end is itself
 * followed/preceded by whitespace rather than an interpolation.
 *
 * Plain string literals have no interpolation, so every token in them is complete.
 */

const TOKEN_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Splits a template literal body into static segments and the interpolation slots. */
function splitTemplateSegments(body) {
  const segments = [];
  let buffer = '';
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '$' && body[index + 1] === '{') {
      segments.push({ text: buffer, closedByInterpolation: true });
      buffer = '';
      /* Skip the balanced expression. */
      let depth = 1;
      index += 2;
      while (index < body.length && depth > 0) {
        if (body[index] === '{') depth += 1;
        else if (body[index] === '}') depth -= 1;
        index += 1;
      }
      index -= 1;
      segments.push({ text: '', openedByInterpolation: true });
      continue;
    }
    buffer += body[index];
  }
  segments.push({ text: buffer, closedByInterpolation: false });
  return segments;
}

/**
 * Class names defined by a set of stylesheets.
 *
 * Syntax alone cannot settle a token that touches an interpolation boundary, because
 * two real patterns look identical:
 *
 *   className={`subsystem-metric-val${metric.tone ? ` ${metric.tone}` : ""}`}
 *       `subsystem-metric-val` is a COMPLETE class, concatenated with an optional suffix
 *
 *   className={`ocs-feedback-${feedback.type}`}
 *       `ocs-feedback-` is an INCOMPLETE fragment; only the concatenation exists
 *
 * The tie-breaker is the stylesheet: a class the application can render must be defined
 * somewhere. A boundary-touching token therefore counts only when a stylesheet defines
 * it, which keeps the real class and drops the fragment without guessing.
 */
export function collectStylesheetClasses(cssFiles) {
  const classes = new Set();
  for (const file of cssFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) classes.add(match[1]);
  }
  return classes;
}

/**
 * Tokens of one `className` value.
 *
 * `expression` is the raw value between the delimiters: for a plain literal the
 * contents, for a template literal the body without its backticks.
 * `knownClasses` is the stylesheet vocabulary used to settle boundary-touching tokens.
 */
export function classTokensOfExpression(expression, isTemplate, knownClasses = null) {
  const tokens = new Set();

  if (!isTemplate) {
    for (const token of expression.split(/\s+/)) {
      if (TOKEN_PATTERN.test(token)) tokens.add(token);
    }
    return tokens;
  }

  const settled = (token) => !knownClasses || knownClasses.has(token);

  for (const segment of splitTemplateSegments(expression)) {
    const text = segment.text;
    if (!text) continue;

    const leadingBoundary = Boolean(segment.openedByInterpolation) && !/^\s/.test(text);
    const trailingBoundary = Boolean(segment.closedByInterpolation) && !/\s$/.test(text);

    const parts = text.split(/\s+/).filter(Boolean);
    parts.forEach((part, index) => {
      if (!TOKEN_PATTERN.test(part)) return;
      const touchesBoundary =
        (index === 0 && leadingBoundary) || (index === parts.length - 1 && trailingBoundary);
      if (touchesBoundary && !settled(part)) return;
      tokens.add(part);
    });
  }

  return tokens;
}

/** Every (file, token) pair contributed by a set of files. */
export function classPairsOf(files, knownClasses = null) {
  const pairs = [];
  for (const file of files) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/className=(\{`|["'])([\s\S]*?)(`\}|["'])/g)) {
      const isTemplate = match[1] === '{`';
      const body = match[2];
      for (const token of classTokensOfExpression(body, isTemplate, knownClasses)) pairs.push({ file, token });
    }
  }
  return pairs;
}

/** Class tokens used by a set of files, with incomplete interpolation fragments removed. */
export function classVocabularyOf(files, knownClasses = null) {
  return new Set(classPairsOf(files, knownClasses).map((pair) => pair.token));
}

/** The source files that introduce each class token, for grouped reporting. */
export function classSourcesOf(files, knownClasses = null) {
  const sources = new Map();
  for (const pair of classPairsOf(files, knownClasses)) {
    if (!sources.has(pair.token)) sources.set(pair.token, []);
    sources.get(pair.token).push(pair.file);
  }
  return sources;
}
