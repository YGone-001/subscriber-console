import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

const globalsCss = read("../src/app/globals.css");
const layoutCss = read("../src/app/(dashboard)/layout.css");
const commandPaletteCss = read("../src/components/CommandPalette.css");

test("dashboard polish removes decorative grid and bounce language", () => {
  const sources = [globalsCss, layoutCss, commandPaletteCss, read("../src/components/OperationFeedback.css")].join("\n");

  assert.doesNotMatch(layoutCss, /48px 48px|bounceIn/);
  assert.doesNotMatch(sources, /--ease-(?:spring|bounce)|var\(--ease-(?:spring|bounce)\)/);
  assert.match(layoutCss, /\.layout-main\s*\{[\s\S]*?background:\s*var\(--background\)/);
  assert.match(layoutCss, /\.notif-badge\s*\{[\s\S]*?animation:\s*reducedFade 160ms var\(--ease-decelerate\) both/);
});

test("selection and card polish no longer depend on decorative accent strips", () => {
  assert.doesNotMatch(globalsCss, /\.imsi-card::before/);
  assert.doesNotMatch(commandPaletteCss, /border-left(?:-color)?:/);
  assert.match(commandPaletteCss, /\.cp-item-row-selected\s*\{[\s\S]*?background:\s*var\(--selection-soft\)/);
});

test("operational data typography follows the documented Cascadia Mono stack", () => {
  const dataSurfaces = [
    read("../src/components/analytics.css"),
    read("../src/components/diff-viewer.css"),
    read("../src/components/NocSentinel.css"),
  ].join("\n");

  assert.doesNotMatch(dataSurfaces, /JetBrains Mono|Jetbrains Mono|Cascadia Code/);
  assert.match(dataSurfaces, /font-family:\s*"Cascadia Mono", "SFMono-Regular", Consolas, monospace/);
});

test("floating actions use semantic classes instead of inline brand colors", () => {
  const subscribersPage = read("../src/app/(dashboard)/subscribers/page.tsx");

  assert.match(subscribersPage, /className="fab fab-secondary"/);
  assert.doesNotMatch(subscribersPage, /background:\s*"#6366f1"/);
  assert.match(globalsCss, /\.fab-secondary\s*\{[\s\S]*?background-color:\s*var\(--status-info\)/);
});

test("the global notification stream stays idle on the unauthenticated login route", () => {
  const provider = read("../src/components/NotificationProvider.tsx");

  assert.match(provider, /const pathname = usePathname\(\)/);
  assert.match(provider, /visibleConnectionStatus:\s*ConnectionStatus = pathname === "\/login" \? "disconnected" : connectionStatus/);
  assert.match(provider, /if \(pathname === "\/login"\) \{[\s\S]*?return/);
  assert.match(provider, /\[pathname, addNotification, showToast\]/);
});
