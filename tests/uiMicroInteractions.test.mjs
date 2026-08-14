import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

test("globals.css defines micro-interaction tokens and easing curves", () => {
  const globalsCss = fs.readFileSync(path.join(rootDir, "src", "app", "globals.css"), "utf8");
  assert.match(globalsCss, /--ease-spring:\s*cubic-bezier\(/);
  assert.match(globalsCss, /--ease-bounce:\s*cubic-bezier\(/);
  assert.match(globalsCss, /--duration-fast:/);
  assert.match(globalsCss, /--focus-ring:/);
});

test("globals.css implements tactile button physics and focus-visible states", () => {
  const globalsCss = fs.readFileSync(path.join(rootDir, "src", "app", "globals.css"), "utf8");
  assert.match(globalsCss, /\.btn:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(/);
  assert.match(globalsCss, /\.btn:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/);
  assert.match(globalsCss, /\.copy-btn:hover\s*\{[^}]*transform:\s*scale\(/);
});

test("globals.css implements smooth shimmer wave and live breathing pulse", () => {
  const globalsCss = fs.readFileSync(path.join(rootDir, "src", "app", "globals.css"), "utf8");
  assert.match(globalsCss, /@keyframes\s+shimmerWave/);
  assert.match(globalsCss, /\.skeleton-loader/);
  assert.match(globalsCss, /@keyframes\s+livePulse/);
  assert.match(globalsCss, /\.pulse-live/);
});

test("globals.css provides accessible prefers-reduced-motion overrides", () => {
  const globalsCss = fs.readFileSync(path.join(rootDir, "src", "app", "globals.css"), "utf8");
  assert.match(globalsCss, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
  assert.doesNotMatch(globalsCss, /animation-duration:\s*0\.01ms/);
  assert.doesNotMatch(globalsCss, /transition-duration:\s*0\.01ms/);
  assert.match(globalsCss, /animation:\s*reducedFade 120ms/);
  assert.match(globalsCss, /transition-property:\s*background-color, color, border-color, box-shadow, opacity/);
  assert.match(globalsCss, /\.progress-bar-value,[\s\S]*?animation:\s*none\s*!important/);
});

test("layout.css and OperationFeedback.css support micro-physics and spring transitions", () => {
  const layoutCss = fs.readFileSync(path.join(rootDir, "src", "app", "(dashboard)", "layout.css"), "utf8");
  const opCss = fs.readFileSync(path.join(rootDir, "src", "components", "OperationFeedback.css"), "utf8");

  assert.match(layoutCss, /\.icon-button:active/);
  assert.match(layoutCss, /\.command-button:active/);
  assert.match(layoutCss, /\.sidebar-link:active/);

  assert.match(opCss, /@keyframes\s+feedbackModalPop/);
  assert.match(opCss, /@keyframes\s+feedbackBackdropFade/);
});
