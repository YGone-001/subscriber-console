import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const globalsCss = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

function extractBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{`, "m").exec(globalsCss);
  assert.ok(match, `${selector} block must exist in globals.css`);
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = open; index < globalsCss.length; index += 1) {
    const char = globalsCss[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return globalsCss.slice(open + 1, index);
    }
  }
  throw new Error(`Unterminated block: ${selector}`);
}

const lightBlock = extractBlock('[data-theme="light"]');
const darkBlock = extractBlock('[data-theme="dark"]');
const rootBlock = extractBlock(":root");

function tokensOf(block) {
  return new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function tokenNames(block) {
  return new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
}

const lightTokens = tokensOf(lightBlock);
const darkTokens = tokensOf(darkBlock);
const rootTokens = tokensOf(rootBlock);

function resolveToken(tokens, name) {
  let value = tokens.get(name);
  assert.ok(value !== undefined, `token ${name} must be defined`);
  let guard = 0;
  while (value.startsWith("var(")) {
    const reference = value.match(/^var\((--[\w-]+)\)$/);
    assert.ok(reference, `token ${name} must resolve through a simple var() reference, got "${value}"`);
    value = tokens.get(reference[1]);
    assert.ok(value !== undefined, `token ${name} references an undefined token`);
    guard += 1;
    assert.ok(guard < 8, `token ${name} has a circular var() reference`);
  }
  return value;
}

function relativeLuminance(hex) {
  const digits = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  assert.match(foreground, /^#[\da-f]{6}$/i, `foreground must be a 6-digit hex color, got "${foreground}"`);
  assert.match(background, /^#[\da-f]{6}$/i, `background must be a 6-digit hex color, got "${background}"`);
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const [high, low] = first > second ? [first, second] : [second, first];
  return (high + 0.05) / (low + 0.05);
}

test("spacing scale is defined in :root and drives the semantic layout tokens", () => {
  const scale = {
    "--space-4": "4px",
    "--space-8": "8px",
    "--space-12": "12px",
    "--space-16": "16px",
    "--space-20": "20px",
    "--space-24": "24px",
    "--space-32": "32px",
  };
  for (const [token, value] of Object.entries(scale)) {
    assert.equal(resolveToken(rootTokens, token), value, `${token} must be ${value}`);
  }
  assert.equal(resolveToken(rootTokens, "--space-page"), "24px", "--space-page must resolve through the scale");
  assert.equal(resolveToken(rootTokens, "--space-section"), "20px", "--space-section must resolve through the scale");

  for (const tokens of [lightTokens, darkTokens]) {
    for (const token of ["--space-page", "--space-section", "--control-height", "--table-row-height"]) {
      assert.ok(!tokens.has(token), `${token} is theme-independent and must not be defined inside a theme block`);
    }
  }
});

test("both themes define the same semantic token set (no single-theme gaps)", () => {
  const lightNames = tokenNames(lightBlock);
  const darkNames = tokenNames(darkBlock);
  const rootNames = tokenNames(rootBlock);

  const lightOnly = [...lightNames].filter((token) => !darkNames.has(token) && !rootNames.has(token));
  assert.deepEqual(lightOnly, [], `light-only tokens: ${lightOnly.join(", ")}`);

  const darkOnly = [...darkNames].filter((token) => !lightNames.has(token) && !rootNames.has(token));
  const unexpectedDarkOnly = darkOnly.filter((token) => !token.startsWith("--ant-"));
  assert.deepEqual(unexpectedDarkOnly, [], `unexpected dark-only tokens: ${unexpectedDarkOnly.join(", ")}`);
});

test("interaction state tokens are present in both themes", () => {
  const stateTokens = ["--surface-hover", "--selection-soft", "--selection-border", "--focus-ring"];
  for (const [theme, tokens] of [["light", lightTokens], ["dark", darkTokens]]) {
    for (const token of stateTokens) {
      assert.ok(tokens.has(token), `${token} must be defined in the ${theme} theme`);
    }
  }
});

test("core text and accent colors meet the WCAG contrast contract", () => {
  const bodyPairs = [
    ["--text-main", "--background"],
    ["--text-main", "--surface"],
    ["--text-secondary", "--background"],
    ["--text-secondary", "--surface"],
    ["--text-muted", "--background"],
    ["--text-muted", "--surface"],
  ];
  const accentTones = ["--primary", "--success", "--warning", "--danger", "--status-info"];

  for (const [theme, tokens] of [["light", lightTokens], ["dark", darkTokens]]) {
    for (const [foreground, background] of bodyPairs) {
      const ratio = contrastRatio(resolveToken(tokens, foreground), resolveToken(tokens, background));
      assert.ok(ratio >= 4.5, `${theme} ${foreground} on ${background} must reach 4.5:1, got ${ratio.toFixed(2)}:1`);
    }

    for (const tone of accentTones) {
      const onSurface = contrastRatio(resolveToken(tokens, tone), resolveToken(tokens, "--surface"));
      assert.ok(onSurface >= 4.5, `${theme} ${tone} on --surface must reach 4.5:1, got ${onSurface.toFixed(2)}:1`);
    }

    // Accent tones on the canvas are reserved for large values and UI emphasis (3:1);
    // normal-size body copy uses the --text-* tokens above.
    for (const tone of accentTones) {
      const onCanvas = contrastRatio(resolveToken(tokens, tone), resolveToken(tokens, "--background"));
      assert.ok(onCanvas >= 3, `${theme} ${tone} on --background must reach 3:1, got ${onCanvas.toFixed(2)}:1`);
    }
  }

  for (const [foreground, background] of [
    ["--login-text", "--login-surface"],
    ["--login-text-muted", "--login-surface"],
    ["--login-on-primary", "--login-primary"],
  ]) {
    const ratio = contrastRatio(resolveToken(lightTokens, foreground), resolveToken(lightTokens, background));
    assert.ok(ratio >= 4.5, `${foreground} on ${background} must reach 4.5:1, got ${ratio.toFixed(2)}:1`);
  }
});