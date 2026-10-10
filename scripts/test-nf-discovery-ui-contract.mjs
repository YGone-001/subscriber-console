#!/usr/bin/env node
/**
 * NF Discovery UI/UX acceptance contract.
 *
 * A separate contract from the backend Discovery model contract. It proves the
 * Discovery frontend is a native xCloud module rather than an isolated surface:
 *
 * - Both Discovery routes are registered and reachable through the shared router
 * - Navigation integration is active (sidebar derives from the shared authority)
 * - Discovery reuses the current shared UI primitives
 * - Discovery shares the xCloud stylesheet and design-token system
 * - No independent theme system and no competing navigation registry exist
 * - No raw API calls, no hardcoded production nodes and no false live-health labels
 * - Observation state is never presented as operational health
 * - No vendor product-name tokens appear in Discovery UI source or locale strings
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const source = resolve(frontend, 'src');
const discoveryDir = resolve(source, 'features/discovery');
const read = (relativePath) => readFileSync(resolve(source, relativePath), 'utf8');

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

// 1. Routes
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
const discoveryRoutes = routes.filter((entry) => entry.route.startsWith('/discovery'));
check('DISC-UI-01', discoveryRoutes.length === 2, `discovery_routes=${discoveryRoutes.length}`);
check('DISC-UI-02', routes.length === 30, `frontend_route_count=${routes.length}`);
check(
  'DISC-UI-03',
  discoveryRoutes.some((r) => r.route === '/discovery') && discoveryRoutes.some((r) => r.route === '/discovery/sources/:sourceId'),
  'discovery_route_paths=/discovery,/discovery/sources/:sourceId',
);
check(
  'DISC-UI-04',
  discoveryRoutes.find((r) => r.route === '/discovery/sources/:sourceId')?.dynamicParameters?.includes('sourceId') === true,
  'discovery_dynamic_parameter=sourceId',
);

const routerSource = read('router/router.tsx');
check('DISC-UI-05', routerSource.includes('DiscoveryPage') && routerSource.includes('DiscoverySourceDetailPage'), 'router_registration=both_pages');
check('DISC-UI-06', routerSource.includes("'/discovery'") && routerSource.includes("'/discovery/sources/:sourceId'"), 'router_paths=both');

// 2. Navigation
const navigationSource = read('lib/navigation.ts');
check('DISC-UI-07', navigationSource.includes("route: '/discovery'") && navigationSource.includes("route: '/discovery/sources/:sourceId'"), 'navigation_authority=discovery_registered');
check('DISC-UI-08', navigationSource.includes("labelKey: 'nav_discovery'") && navigationSource.includes('visible: true') && navigationSource.includes("push(find('/discovery'))"), 'discovery_navigation_visible=true');

const sidebarSource = read('app/components/AppSidebar.tsx');
const tabBarSource = read('app/components/NavigationTabBar.tsx');
const breadcrumbSource = read('app/components/NavigationBreadcrumbs.tsx');
const paletteSource = read('app/components/CommandPalette.tsx');
check('DISC-UI-09', sidebarSource.includes('getSidebarGroups'), 'sidebar=shared_authority');
check('DISC-UI-10', /getVisibleNavigation|canAccessNavigationRoute/.test(tabBarSource), 'tab_bar=shared_authority');
check('DISC-UI-11', breadcrumbSource.includes('getBreadcrumbs'), 'breadcrumbs=shared_authority');
check('DISC-UI-12', /getVisibleNavigation|filterNavigation/.test(paletteSource), 'command_palette=shared_authority');

// 3. Shared UI primitives
const discoveryFiles = [
  'features/discovery/DiscoveryPage.tsx',
  'features/discovery/DiscoverySourceDetailPage.tsx',
  'features/discovery/discovery-api.ts',
  'features/discovery/discovery-types.ts',
  'features/discovery/discovery-builders.ts',
  'features/discovery/discovery-validation.ts',
];
for (const file of discoveryFiles) {
  check(`DISC-UI-13:${file}`, existsSync(resolve(source, file)), `discovery_file_present=${file}`);
}
const discoveryText = discoveryFiles.map((file) => read(file)).join('\n');
for (const [primitive, importPath] of [
  ['PageHeader', "components/ui/PageHeader'"],
  ['Dialog', "components/ui/Dialog'"],
  ['Field', "components/ui/Field'"],
  ['ErrorState', "components/ui/StatePanel'"],
  ['EmptyState', "components/ui/OperationFeedback'"],
  ['OperationFeedback', "components/ui/OperationFeedback'"],
  ['LoadingSkeleton', "components/ui/LoadingSkeleton'"],
]) {
  check(`DISC-UI-14:${primitive}`, discoveryText.includes(primitive) && discoveryText.includes(importPath), `discovery_reuses_${primitive}=true`);
}

// 4. Design system
const cssModule = read('styles/modules/discovery.module.css');
check('DISC-UI-15', /var\(--[a-z0-9-]+\)/.test(cssModule), 'discovery_css=design_tokens');
check('DISC-UI-16', !/#([0-9a-fA-F]{3,8})\b/.test(cssModule), 'discovery_css=zero_raw_hex');
check('DISC-UI-17', !/rgba?\(/.test(cssModule), 'discovery_css=zero_rgb_literals');
check('DISC-UI-18', !/createContext|ThemeProvider|data-theme/.test(discoveryText), 'discovery_theme=shared_authority');

// 5. Security and honesty
check('DISC-UI-19', !/(?<![\w.])fetch\s*\(/.test(discoveryText), 'discovery_raw_fetch=0');
check('DISC-UI-20', !/127\.0\.0\.1:18888/.test(discoveryText), 'discovery_direct_go_urls=0');
check('DISC-UI-21', !/\bjose\b|document\.cookie|X-User-Role/.test(discoveryText), 'discovery_auth_runtime=0');
check('DISC-UI-22', !/method:\s*['"]DELETE['"]/.test(discoveryText), 'discovery_hard_delete_calls=0');
check(
  'DISC-UI-23',
  /observationState|discovery_state_seen|discovery_state_missing/.test(discoveryText),
  'discovery_observation_state_present=true',
);
check(
  'DISC-UI-24',
  /discovery_observation_not_health|not operational health|不等于运行健康/.test(discoveryText + read('lib/locales/en.ts') + read('lib/locales/zh.ts')),
  'discovery_health_separation_disclosed=true',
);

const localeEn = read('lib/locales/en.ts');
const localeZh = read('lib/locales/zh.ts');
const productTokens = /open5gs|kamailio|freeswitch|asterisk/i;
check('DISC-UI-25', !productTokens.test(discoveryText), 'discovery_source_product_tokens=0');
check('DISC-UI-26', !productTokens.test(localeEn) && !productTokens.test(localeZh), 'locale_product_tokens=0');
check('DISC-UI-27', localeEn.includes('nav_discovery') && localeZh.includes('nav_discovery'), 'locale_keys=bilingual');
check(
  'DISC-UI-28',
  localeEn.includes('discovery_title') && localeZh.includes('discovery_title')
    && localeEn.includes('discovery_link_intro') && localeZh.includes('discovery_link_intro'),
  'locale_coverage=core_strings',
);
check(
  'DISC-UI-29',
  /Linking writes discovery metadata only/.test(localeEn) && /关联仅写入发现侧元数据/.test(localeZh),
  'discovery_link_boundary_copy=present',
);

// 6. Contract JSON present
const contract = JSON.parse(readFileSync(resolve(frontend, 'nf-discovery-contract.json'), 'utf8'));
check('DISC-UI-30', contract.routes.length === 2, `contract_routes=${contract.routes.length}`);
check('DISC-UI-31', contract.apis.length === 12, `contract_apis=${contract.apis.length}`);

// 7. Responsive search toolbar geometry
// The desktop `.search { flex: 1 1 320px }` basis becomes a vertical extent in
// column layout and renders a 320px-tall pill. The column breakpoint must
// override it with an auto-sized basis and keep the normal control height.
const columnBreakpoint = cssModule.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
check('DISC-UI-32', Boolean(columnBreakpoint), 'discovery_css=column_breakpoint_present');
const columnRules = columnBreakpoint ? columnBreakpoint[1] : '';
check(
  'DISC-UI-33',
  /\.search\s*\{[^}]*flex:\s*0 0 auto/.test(columnRules) || /\.search\s*\{[^}]*flex:\s*1 1 auto/.test(columnRules),
  'discovery_css=search_auto_flex_basis_in_column_layout',
);
check(
  'DISC-UI-34',
  !/\.search\s*\{[^}]*flex:\s*\d+\s+\d+\s+\d+px/.test(columnRules),
  'discovery_css=search_no_pixel_basis_in_column_layout',
);
check(
  'DISC-UI-35',
  /\.search\s*\{[^}]*min-height:\s*var\(--control-height\)/.test(cssModule),
  'discovery_css=search_preserves_control_height',
);

let failed = 0;
for (const item of invariants) {
  const status = item.ok ? 'PASS' : 'FAIL';
  if (!item.ok) failed += 1;
  console.log(`${status} ${item.id} ${item.detail}`);
}
console.log(`\nDiscovery UI/UX acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${invariants.length - failed}/${invariants.length})`);
if (failed > 0) process.exit(1);
