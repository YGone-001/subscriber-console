import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

/*
 * FE-C4 Gate A regression guards.
 *
 * FE-C3 left three interaction-contract defects open: the closed mobile drawer
 * stayed tabbable, the user menu advertised an ARIA menu model it did not
 * implement, and the command palette gave screen-reader users no way to learn
 * which highlighted result Enter would activate. These tests pin the corrected
 * contracts at the source boundary; the browser acceptance harness
 * (tests/cross-route-ux-acceptance.mjs, Layer 2h) proves the runtime behaviour.
 */

const SRC = resolve(new URL('../src/', import.meta.url).pathname);
const read = (relative) => readFileSync(join(SRC, relative), 'utf8');

test('the closed mobile drawer is inert and aria-hidden from one derived condition', () => {
  const sidebar = read('app/components/AppSidebar.tsx');

  /* One condition must drive both attributes, so they cannot drift apart. */
  assert.match(
    sidebar,
    /aria-hidden=\{isMobileShell && !sidebarOpen \? true : undefined\}/,
    'the drawer must derive aria-hidden from the mobile-closed state',
  );
  assert.match(
    sidebar,
    /inert=\{isMobileShell && !sidebarOpen\}/,
    'the drawer must be inert exactly while the mobile drawer is closed',
  );

  /* The desktop collapsed rail is only narrowed; it must stay interactive. */
  assert.doesNotMatch(sidebar, /inert=\{!sidebarOpen\}/, 'inert must not be keyed on collapse alone');
  assert.doesNotMatch(sidebar, /inert=\{!sidebarOpen \? true : undefined\}/, 'inert must be scoped to the mobile shell');
});

test('the shell restores focus to the header trigger when the mobile drawer closes', () => {
  const shell = read('app/AppShell.tsx');
  const header = read('app/components/AppHeader.tsx');

  assert.match(shell, /headerToggleRef/, 'the shell must own a ref to the header toggle');
  assert.match(shell, /toggleRef=\{headerToggleRef\}/, 'the header toggle ref must be wired through');
  assert.match(
    shell,
    /!desktop && !sidebarOpen && wasOpenMobileDrawer/,
    'focus restoration must only fire when a mobile drawer was open and then closed',
  );
  assert.match(shell, /headerToggleRef\.current\?\.focus\(\)/, 'closing the drawer must focus the header trigger');

  /* The header must forward the ref to the real toggle button, not a wrapper. */
  assert.match(header, /toggleRef\?: Ref<HTMLButtonElement>/, 'the header must accept the toggle ref');
  assert.match(header, /ref=\{toggleRef\}/, 'the toggle button must carry the ref');
});

test('the user menu uses a disclosure contract, not an unimplemented menu role', () => {
  const menu = read('app/components/UserMenu.tsx');

  assert.doesNotMatch(menu, /role="menu"/, 'the user menu must not advertise menu semantics');
  assert.doesNotMatch(menu, /role="menuitem"/, 'the user menu must not advertise menuitem semantics');
  assert.match(menu, /aria-expanded=\{open\}/, 'the trigger must expose its expanded state');
  assert.match(menu, /aria-controls=\{PANEL_ID\}/, 'the trigger must point at the panel it controls');
  assert.match(menu, /id=\{PANEL_ID\}/, 'the panel must carry the controlling id');
  assert.match(menu, /role="group"/, 'the popover may group its native buttons without claiming menu semantics');

  /* Every item stays a native button reachable by ordinary Tab. */
  const itemButtons = [...menu.matchAll(/className="dropdown-item[^"]*"/g)];
  assert.ok(itemButtons.length >= 3, `expected native dropdown buttons, saw ${itemButtons.length}`);
  assert.match(menu, /triggerRef\.current\?\.focus\(\)/, 'Escape must restore focus to the trigger');
});

test('the narrow header keeps the language control and collapses only the theme segment', () => {
  const css = read('styles/shell.css');

  /* Both mobile rules must preserve the language control explicitly. */
  const languageExceptions = css.match(/\.header-right > \.hover-glass:not\(#lang-switcher-btn\)/g) ?? [];
  assert.ok(languageExceptions.length >= 2, `expected both mobile hover-glass rules to spare #lang-switcher-btn, saw ${languageExceptions.length}`);

  /* A generic hover-glass rule would hide the language control again. */
  assert.doesNotMatch(css, /\.header-right > \.hover-glass\s*{[^}]*display:\s*none;/, 'no rule may hide every header hover-glass control');

  /* The 3-way theme segment is the control that must collapse on very narrow screens. */
  assert.match(
    css,
    /@media \(max-width: 480px\)\s*{\s*\.theme-switcher\s*{\s*display:\s*none;/,
    'below 480px the theme segment must collapse to keep the header controls from overlapping',
  );
});

test('the command palette keeps its button list and announces the active result', () => {
  const palette = read('app/components/CommandPalette.tsx');

  /* The chosen model stays dialog + search + native buttons. */
  assert.match(palette, /className=\{`cp-item-row/, 'results must stay real buttons');
  assert.doesNotMatch(palette, /role="listbox"/, 'the palette must not half-implement a listbox');

  /* Selection is exposed in two ways that match the actual interaction. */
  assert.match(palette, /aria-current=\{selected \? 'true' : undefined\}/, 'the highlighted row must be announced');
  assert.match(palette, /role="status" aria-live="polite" aria-atomic="true"/, 'the active result must be announced politely');
  assert.match(palette, /t\('cp_active_result'\)/, 'the announcement must be localized');
});
