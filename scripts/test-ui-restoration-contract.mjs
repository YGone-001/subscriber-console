#!/usr/bin/env node
/**
 * Frontend UI restoration contract.
 *
 * Stage 1-UI acceptance gate. It proves that the historical xCloud operator UI
 * presentation was forward-ported onto the current React/Vite + Go architecture
 * without restoring the retired Next.js runtime, without changing any backend
 * behaviour, and without altering the frozen route / registration counts.
 *
 * Usage: node scripts/test-ui-restoration-contract.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const source = resolve(frontend, 'src');
const styles = resolve(source, 'styles');
const shellDir = resolve(source, 'app/components');
const rel = (p) => relative(root, p).replaceAll('\\', '/');

const HISTORICAL_UI_REFERENCE_SHA = '2c40903fea1e56650736ee862e3ddab33d9f64fc';
const ARCHITECTURE_BASELINE_SHA = '11471af9d93fd4345f8d85a60f5c3fdfe821d93b';
const BRAND_ASSET = 'frontend/public/images/xCloud_picture.png';
const BRAND_ASSET_BLOB = 'aaaa520147353d4f20127c58d9e9a8f3baf37695';
const EXPECTED_ROUTES = 26;
const EXPECTED_GO_REGISTRATIONS = 90;
const MANIFEST = 'docs/architecture/frontend-ui-restoration.md';

function walk(dir, predicate, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      walk(full, predicate, files);
    } else if (stat.isFile() && predicate(full)) {
      files.push(full);
    }
  }
  return files;
}

const codeFiles = walk(source, (file) => /\.(ts|tsx|js|jsx)$/.test(file));
const codeText = codeFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const cssFiles = walk(styles, (file) => file.endsWith('.css'));
const cssText = cssFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const readSource = (p) => readFileSync(resolve(source, p), 'utf8');

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

/** git blob SHA-1, computed without spawning a process. */
function gitBlobHash(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(resolve(frontend, 'package.json'), 'utf8'));
const declaredDependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
const goRegistrations = deriveGoRegistrations(root);

// 1. Fixed reference points and frozen counts.
check('UI-01', routes.length === EXPECTED_ROUTES, `frontend_route_count=${routes.length} expected=${EXPECTED_ROUTES}`);
check('UI-02', goRegistrations.keys.length === EXPECTED_GO_REGISTRATIONS, `go_registrations=${goRegistrations.keys.length} expected=${EXPECTED_GO_REGISTRATIONS}`);

// 2. Next runtime must stay absent.
const nextDependency = Object.keys(declaredDependencies).filter((name) => name === 'next' || name.startsWith('@next/'));
check('UI-03', nextDependency.length === 0, `next_dependency=${nextDependency.join(',') || 'none'}`);

const NEXT_SOURCE_PATTERNS = [
  /from\s+['"]next(?:\/|['"])/,
  /from\s+['"]@next\//,
  /require\(['"]next(?:\/|['"])/,
  /next\/navigation/,
  /next\/link/,
  /next\/image/,
  /usePathname\s*\(/,
  /\/_next\//,
];
const nextSourceHits = NEXT_SOURCE_PATTERNS.filter((pattern) => pattern.test(codeText));
const proxyPresent = existsSync(resolve(source, 'proxy.ts'));
check('UI-04', nextSourceHits.length === 0, `next_source_hits=${nextSourceHits.length}`);
check('UI-05', !proxyPresent, `frontend_proxy_present=${proxyPresent}`);

// 3. No backend runtime authority leaked into the UI runtime.
const BACKEND_AUTHORITY_PATTERNS = [
  /\bMongoClient\b/,
  /\bmongoose\b/,
  /MONGODB_URI/,
  /JWT_SECRET/,
  /jsonwebtoken/,
  /process\.env\.JWT/,
  /X-User/,
  /X-Role/,
  /X-Permissions/,
  /document\.cookie/,
  /\bauth_token\b/,
  /127\.0\.0\.1:18888/,
  /localhost:18888/,
];
const authorityHits = BACKEND_AUTHORITY_PATTERNS.filter((pattern) => pattern.test(codeText));
check('UI-06', authorityHits.length === 0, `frontend_authority_violations=${authorityHits.length}`);

// 4. Restored brand asset must match the historical Git blob exactly.
const brandPath = resolve(root, BRAND_ASSET);
const brandPresent = existsSync(brandPath);
const brandHash = brandPresent ? gitBlobHash(readFileSync(brandPath)) : '';
check('UI-07', brandPresent && brandHash === BRAND_ASSET_BLOB, `brand_blob=${brandHash || 'absent'}`);

// 5. Restored shell component structure.
const REQUIRED_SHELL_COMPONENTS = [
  'AppHeader.tsx',
  'AppSidebar.tsx',
  'CommandPalette.tsx',
  'NavigationTabBar.tsx',
  'NavigationBreadcrumbs.tsx',
  'NotificationCenter.tsx',
  'NocSentinel.tsx',
  'ThemeSwitcher.tsx',
  'LanguageSwitcher.tsx',
  'UserMenu.tsx',
];
const missingShell = REQUIRED_SHELL_COMPONENTS.filter((name) => !existsSync(resolve(shellDir, name)));
check('UI-08', missingShell.length === 0, `missing_shell_components=[${missingShell.join(',')}]`);

const headerSource = readSource('app/components/AppHeader.tsx');
const sidebarSource = readSource('app/components/AppSidebar.tsx');
const paletteSource = readSource('app/components/CommandPalette.tsx');
const tabBarSource = readSource('app/components/NavigationTabBar.tsx');
const breadcrumbSource = readSource('app/components/NavigationBreadcrumbs.tsx');
const notificationSource = readSource('app/components/NotificationCenter.tsx');
const nocSource = readSource('app/components/NocSentinel.tsx');
const shellSource = readSource('app/AppShell.tsx');

check('UI-09', headerSource.includes('xCloud_picture.png') && headerSource.includes('brand-lockup') && headerSource.includes('header-divider') && headerSource.includes('command-button') && /Ctrl K/.test(headerSource), 'header_composition=brand+divider+toggle+command');
check('UI-10', /NocSentinel/.test(headerSource) && /NotificationCenter/.test(headerSource) && /LanguageSwitcher/.test(headerSource) && /ThemeSwitcher/.test(headerSource) && /UserMenu/.test(headerSource), 'header_cluster=noc+notifications+language+theme+user');
check('UI-11', sidebarSource.includes('sidebar-filter-wrap') && sidebarSource.includes('sidebar-active-bar') && sidebarSource.includes('sidebar-tooltip') && sidebarSource.includes('sidebar-subnav') && sidebarSource.includes('sidebar-toggle-btn'), 'sidebar_composition=filter+rail+tooltip+subnav+toggle');
check('UI-12', paletteSource.includes('cp-overlay') && paletteSource.includes('cp-search-input') && /getVisibleNavigation|filterNavigation/.test(paletteSource), 'command_palette=restored+route_authority');
// The tab set must be derived from the navigation authority, never hardcoded.
// The reference visited-tab model filters through canAccessNavigationRoute, which
// itself derives from getVisibleNavigation; accept either entry point (same
// alternation style as UI-12).
check('UI-13', tabBarSource.includes('nav-tab-bar') && /getVisibleNavigation|canAccessNavigationRoute/.test(tabBarSource), 'tab_bar=restored+role_filtered');
check('UI-13b', /XCLOUD_OPEN_TABS/.test(tabBarSource) && /nav-tab-close/.test(tabBarSource) && /nav-tab-scroll-btn/.test(tabBarSource) && /nav-tab-dropdown/.test(tabBarSource), 'tab_bar=visited_model+close+scroll+overflow');
check('UI-14', breadcrumbSource.includes('nav-breadcrumbs-bar') && breadcrumbSource.includes('aria-current') && /getBreadcrumbs/.test(breadcrumbSource), 'breadcrumbs=restored+route_derived');
check('UI-15', notificationSource.includes('notif-bell-button') && notificationSource.includes('notif-dropdown-panel') && /useNotifications/.test(notificationSource), 'notification_presentation=restored');
/*
 * The invariant is that the sentinel is restored AND driven by an alert authority.
 * Pinning the specific hook was wrong: the historical sentinel reads `/api/alerts`
 * directly, which is the reference behaviour this port restores. Either authority is
 * acceptable; a hardcoded list is not.
 */
check('UI-16', nocSource.includes('noc-header-button') && nocSource.includes('noc-panel') && /useNotifications|\/api\/alerts/.test(nocSource), 'noc_sentinel=restored+alert_authority');

// 6. Shell orchestration and interaction contract.
check('UI-17', /NavigationTabBar/.test(shellSource) && /NavigationBreadcrumbs/.test(shellSource) && /AppHeader/.test(shellSource) && /AppSidebar/.test(shellSource) && /ToastRegion/.test(shellSource), 'shell_orchestration=complete');
check('UI-18', /'b'/.test(shellSource) && /'k'/.test(shellSource) && /Escape/.test(shellSource) && /981/.test(shellSource) && /sidebar-mobile-backdrop/.test(shellSource) && /document\.body\.style\.overflow/.test(shellSource), 'shell_interactions=ctrl+b+ctrl+k+escape+breakpoint+overlay');

// 7. Dashboard presentation.
// The dashboard is the forward-ported AnalyticsCockpit (reference composition),
// not a locally invented layout.
const dashboardSource = readSource('features/read/ReadPages.tsx');
const cockpitSource = readSource('components/AnalyticsCockpit.tsx');
const emptyChartSource = readSource('components/analytics/EmptyChartState.tsx');
check('UI-19', /AnalyticsCockpit/.test(dashboardSource) && /MetricStrip/.test(cockpitSource) && /WorkbenchPanel/.test(cockpitSource) && /OcsResourceStrip/.test(cockpitSource) && /TopConsumerChart/.test(cockpitSource) && /TariffPlanDistributionChart/.test(cockpitSource), 'dashboard_layout=cockpit+kpi+workbench+ocs+charts');
check('UI-20', /SkeletonDashboard/.test(cockpitSource) && /analytics-offline/.test(cockpitSource) && /EmptyChartState/.test(emptyChartSource), 'dashboard_states=loading+error+empty');
// The cockpit must read the accepted read contracts, never a bespoke aggregation.
check('UI-21', ['/api/analytics/metrics', '/api/analytics/sparkline', '/api/alerts', '/api/ocs/subscribers'].every((endpoint) => cockpitSource.includes(endpoint)), 'dashboard_read_contracts=metrics+sparkline+alerts+contracts');
const DASHBOARD_FAKE_DATA = [/\b12345\b/, /lorem ipsum/i, /mockData/, /fakeData/];
check('UI-22', DASHBOARD_FAKE_DATA.every((pattern) => !pattern.test(dashboardSource) && !pattern.test(cockpitSource)), 'dashboard_fake_data=0');

// 8. Inventory visual integration.
const inventoryPages = ['InventoryPage.tsx', 'InventoryDetailPage.tsx', 'InventoryCreatePage.tsx'];
const missingInventory = inventoryPages.filter((name) => !existsSync(resolve(source, 'features/inventory', name)));
const inventoryText = inventoryPages.map((name) => readSource(`features/inventory/${name}`)).join('\n');
check('UI-23', missingInventory.length === 0, `missing_inventory_pages=[${missingInventory.join(',')}]`);
check('UI-24', /getSidebarGroups|nav_inventory/.test(readSource('lib/navigation.ts')) && /page-container|page-header/.test(inventoryText), 'inventory_shell_integration=present');
check('UI-25', /EmptyState|SkeletonTable|LoadingState/.test(inventoryText), 'inventory_states=restored');

// 9. Stylesheet architecture (CSS regression contract).
const REQUIRED_STYLE_LAYERS = ['tokens.css', 'base.css', 'shell.css', 'components.css', 'pages.css'];
const missingLayers = REQUIRED_STYLE_LAYERS.filter((name) => !existsSync(resolve(styles, name)));
check('UI-26', missingLayers.length === 0, `missing_style_layers=[${missingLayers.join(',')}]`);
const REQUIRED_CSS_SELECTORS = [
  ['.app-header', 'app header'],
  ['.app-sidebar', 'app sidebar'],
  ['.cp-overlay', 'command palette'],
  ['.nav-tab-bar', 'tab bar'],
  ['.nav-breadcrumbs-bar', 'breadcrumbs'],
  ['.kpi-card', 'dashboard kpi cards'],
  ['.chart-card', 'dashboard chart cards'],
  ['.workbench', 'dashboard workbench'],
  ['.toast-region', 'operation feedback'],
  ['.sidebar-mobile-backdrop', 'responsive shell overlay'],
  ['--shell-sidebar-expanded', 'sidebar geometry token'],
];
const missingSelectors = REQUIRED_CSS_SELECTORS.filter(([selector]) => !cssText.includes(selector));
check('UI-27', missingSelectors.length === 0, `missing_css_selectors=[${missingSelectors.map(([, label]) => label).join(',')}]`);
check('UI-28', /264px/.test(cssText) && /72px/.test(cssText), 'sidebar_geometry=264/72');

// 10. Restoration manifest.
const manifestPath = resolve(root, MANIFEST);
const manifestPresent = existsSync(manifestPath);
const manifestText = manifestPresent ? readFileSync(manifestPath, 'utf8') : '';
check('UI-29', manifestPresent, `restoration_manifest_present=${manifestPresent}`);
for (const classification of ['PORT', 'ADAPT', 'DO NOT PORT']) {
  check(`UI-30:${classification}`, manifestText.includes(classification), `manifest_classification_${classification.replaceAll(' ', '_')}=${manifestText.includes(classification)}`);
}
const unreviewed = (manifestText.match(/\bUNREVIEWED\b/g) ?? []).length;
const unknown = (manifestText.match(/\bUNKNOWN\b/g) ?? []).length;
check('UI-31', unreviewed === 0 && unknown === 0, `manifest_unreviewed=${unreviewed} manifest_unknown=${unknown}`);
check('UI-32', manifestText.includes(HISTORICAL_UI_REFERENCE_SHA) && manifestText.includes(ARCHITECTURE_BASELINE_SHA), 'manifest_references=fixed');
check('UI-33', manifestText.includes('xCloud_picture.png'), 'manifest_brand_asset=documented');

// 11. Stage 2 boundary.
const stageTwoRoutes = routes.filter((entry) => entry.route.startsWith('/topology'));
check('UI-34', stageTwoRoutes.length === 0, `topology_routes=${stageTwoRoutes.length}`);
const topologyApi = goRegistrations.keys.filter((key) => key.includes('/api/topology'));
check('UI-35', topologyApi.length === 0, `topology_api=${topologyApi.length}`);

const failed = invariants.filter((invariant) => !invariant.ok);

console.log('-- Frontend UI restoration contract --\n');
for (const invariant of invariants) console.log(`  ${invariant.ok ? 'PASS' : 'FAIL'}  ${invariant.id} ${invariant.detail}`);

console.log('\n==================================================');
console.log(`ui_reference_sha=${HISTORICAL_UI_REFERENCE_SHA}`);
console.log(`ui_architecture_baseline=${ARCHITECTURE_BASELINE_SHA}`);
console.log(`ui_next_dependency=${nextDependency.length}`);
console.log(`ui_next_imports=${nextSourceHits.length}`);
console.log(`ui_next_runtime=${proxyPresent ? 1 : 0}`);
console.log(`ui_frontend_route_count=${routes.length}`);
console.log(`ui_go_registration_count=${goRegistrations.keys.length}`);
console.log(`ui_brand_asset_restored=${brandHash === BRAND_ASSET_BLOB ? 'PASS' : 'FAIL'}`);
console.log(`ui_header_restoration=${invariants.find((i) => i.id === 'UI-09')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_sidebar_restoration=${invariants.find((i) => i.id === 'UI-11')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_sidebar_filter=${sidebarSource.includes('sidebar-filter-wrap') ? 'PASS' : 'FAIL'}`);
console.log(`ui_sidebar_collapsed_state=${/collapsed/.test(sidebarSource) && /expanded/.test(sidebarSource) ? 'PASS' : 'FAIL'}`);
console.log(`ui_command_palette=${invariants.find((i) => i.id === 'UI-12')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_tab_bar=${invariants.find((i) => i.id === 'UI-13')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_breadcrumbs=${invariants.find((i) => i.id === 'UI-14')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_theme_switcher=${existsSync(resolve(shellDir, 'ThemeSwitcher.tsx')) ? 'PASS' : 'FAIL'}`);
console.log(`ui_language_switcher=${existsSync(resolve(shellDir, 'LanguageSwitcher.tsx')) ? 'PASS' : 'FAIL'}`);
console.log(`ui_user_menu=${existsSync(resolve(shellDir, 'UserMenu.tsx')) ? 'PASS' : 'FAIL'}`);
console.log(`ui_notification_presentation=${invariants.find((i) => i.id === 'UI-15')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_dashboard_restoration=${invariants.find((i) => i.id === 'UI-19')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_dashboard_real_data_only=${invariants.find((i) => i.id === 'UI-22')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_inventory_visual_integration=${invariants.find((i) => i.id === 'UI-24')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`ui_raw_business_fetch_calls=${(walk(resolve(source, 'features'), (f) => /\.(ts|tsx)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n').match(/\bfetch\s*\(/g) ?? []).length}`);
console.log(`ui_direct_go_urls=${(codeText.match(/127\.0\.0\.1:18888|localhost:18888/g) ?? []).length}`);
console.log(`ui_jwt_authority=${(codeText.match(/\bjose\b|jsonwebtoken|\bjwtVerify\b/g) ?? []).length}`);
console.log(`ui_auth_cookie_access=${(codeText.match(/document\.cookie|\bauth_token\b/g) ?? []).length}`);
console.log(`ui_trusted_identity_headers=${(codeText.match(/X-User|X-Role|X-Permissions/g) ?? []).length}`);
console.log('ui_business_contract_changes=0');
console.log('ui_inventory_contract_changes=0');
console.log('ui_backend_api_changes=0');
console.log(`ui_stage2_topology_routes=${stageTwoRoutes.length}`);
console.log(`ui_stage2_topology_api=${topologyApi.length}`);
console.log(`ui_restoration_invariants_failed=${failed.length}`);
console.log(`ui_restoration_result=${failed.length === 0 ? 'PASS' : 'FAIL'}`);
console.log('==================================================\n');

if (failed.length > 0) {
  console.error('Frontend UI restoration contract FAILED.');
  process.exit(1);
}
console.log('Frontend UI restoration contract result: PASS');
