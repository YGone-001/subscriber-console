#!/usr/bin/env node
/**
 * Topology UI/UX acceptance contract.
 *
 * A separate contract from the backend Topology model contract. It proves the
 * Stage 2 frontend delivery is a native xCloud module rather than an isolated
 * surface:
 *
 * - Both Topology routes are registered and reachable through the shared router
 * - Navigation integration is active (sidebar, tab bar, breadcrumbs, palette)
 * - The sidebar exposes Topology as a platform-management entry
 * - Breadcrumbs and the command palette derive Topology from the shared authority
 * - Topology reuses the current shared UI primitives
 * - Topology shares the xCloud stylesheet and design-token system
 * - The existing Header and Sidebar composition is unchanged
 * - No independent theme system and no competing navigation registry exist
 * - No raw API calls, no hardcoded production nodes and no false live-health labels
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const source = resolve(frontend, 'src');
const topologyDir = resolve(source, 'features/topology');
const read = (relativePath) => readFileSync(resolve(source, relativePath), 'utf8');

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

// 1. Routes registered
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
const topologyRoutes = routes.filter((entry) => entry.route.startsWith('/topology'));
check('TOP-UI-01', topologyRoutes.length === 2, `topology_routes=${topologyRoutes.length}`);
check('TOP-UI-02', routes.length === 30, `frontend_route_count=${routes.length}`);
check(
  'TOP-UI-03',
  topologyRoutes.some((r) => r.route === '/topology') && topologyRoutes.some((r) => r.route === '/topology/:resourceId'),
  'topology_route_paths=/topology,/topology/:resourceId',
);
check(
  'TOP-UI-04',
  topologyRoutes.find((r) => r.route === '/topology/:resourceId')?.dynamicParameters?.includes('resourceId') === true,
  'topology_dynamic_parameter=resourceId',
);

const routerSource = read('router/router.tsx');
check('TOP-UI-05', routerSource.includes('TopologyPage') && routerSource.includes('ResourceTopologyPage'), 'router_registration=both_pages');
check('TOP-UI-06', routerSource.includes("'/topology'") && routerSource.includes("'/topology/:resourceId'"), 'router_paths=both');

// 2. Navigation integration
const navigationSource = read('lib/navigation.ts');
check('TOP-UI-07', navigationSource.includes("route: '/topology'") && navigationSource.includes("route: '/topology/:resourceId'"), 'navigation_authority=topology_registered');
check('TOP-UI-08', navigationSource.includes("labelKey: 'nav_topology'") && navigationSource.includes('visible: true'), 'topology_navigation_visible=true');
check('TOP-UI-09', /push\(find\('\/topology'\)\)/.test(navigationSource), 'sidebar_group=topology_entry_present');
check('TOP-UI-10', navigationSource.includes("push(find('/inventory'));"), 'sidebar_order=adjacent_to_inventory');

// The sidebar, tab bar, breadcrumbs and palette all derive from the shared authority,
// so no per-surface registration is required or permitted.
const sidebarSource = read('app/components/AppSidebar.tsx');
const tabBarSource = read('app/components/NavigationTabBar.tsx');
const breadcrumbSource = read('app/components/NavigationBreadcrumbs.tsx');
const paletteSource = read('app/components/CommandPalette.tsx');
check('TOP-UI-11', sidebarSource.includes('getSidebarGroups'), 'sidebar=shared_authority');
check('TOP-UI-12', /getVisibleNavigation|canAccessNavigationRoute/.test(tabBarSource), 'tab_bar=shared_authority');
check('TOP-UI-13', breadcrumbSource.includes('getBreadcrumbs'), 'breadcrumbs=shared_authority');
check('TOP-UI-14', /getVisibleNavigation|filterNavigation/.test(paletteSource), 'command_palette=shared_authority');

// 3. Shared UI primitives reused
const topologyFiles = [
  'features/topology/TopologyPage.tsx',
  'features/topology/ResourceTopologyPage.tsx',
  'features/topology/components/TopologyEdgeForm.tsx',
  'features/topology/components/TopologyEdgeTable.tsx',
  'features/topology/components/TopologyGraph.tsx',
  'features/topology/components/TopologyEdgeDetail.tsx',
  'features/topology/components/TopologyResourcePicker.tsx',
];
for (const file of topologyFiles) {
  check(`TOP-UI-15:${file}`, existsSync(resolve(source, file)), `topology_file_present=${file}`);
}
const topologyText = topologyFiles.map((file) => read(file)).join('\n');
for (const [primitive, importPath] of [
  ['PageHeader', "components/ui/PageHeader'"],
  ['Dialog', "components/ui/Dialog'"],
  ['Field', "components/ui/Field'"],
  ['ErrorState', "components/ui/StatePanel'"],
  ['EmptyState', "components/ui/OperationFeedback'"],
  ['LoadingRows', "components/ui/OperationFeedback'"],
  ['LoadingState', "components/ui/StatePanel'"],
]) {
  check(`TOP-UI-16:${primitive}`, topologyText.includes(primitive) && topologyText.includes(importPath), `topology_reuses_${primitive}=true`);
}

// 4. Stylesheet / token system
const topologyCss = read('styles/modules/topology.module.css');
check('TOP-UI-17', /var\(--(surface|text|ref|space|sys-color|primary|font)/.test(topologyCss), 'topology_css=uses_shared_tokens');
check('TOP-UI-18', !/^\s*--[a-z-]+\s*:/m.test(topologyCss), 'topology_css=defines_no_new_tokens');
check('TOP-UI-19', !/#[0-9a-fA-F]{3,6}\b/.test(topologyCss.replace(/color-mix\([^)]*\)/g, '')), 'topology_css=no_hardcoded_palette');
check('TOP-UI-20', topologyCss.includes('prefers-reduced-motion'), 'topology_css=reduced_motion_supported');
check('TOP-UI-21', /@media \(max-width: (1180|768|640)px\)/.test(topologyCss), 'topology_css=responsive_breakpoints');
check('TOP-UI-22', topologyCss.includes('display: none'), 'topology_css=mobile_graph_fallback');

// The global stylesheet architecture must be untouched by this stage.
for (const layer of ['tokens.css', 'base.css', 'shell.css', 'components.css', 'pages.css']) {
  check(`TOP-UI-23:${layer}`, existsSync(resolve(source, 'styles', layer)), `style_layer_present=${layer}`);
}

// 5. Existing Header / Sidebar composition unchanged
const headerSource = read('app/components/AppHeader.tsx');
check(
  'TOP-UI-24',
  headerSource.includes('xCloud_picture.png') && headerSource.includes('brand-lockup') && headerSource.includes('command-button') && /Ctrl K/.test(headerSource),
  'header_composition=unchanged',
);
check(
  'TOP-UI-25',
  sidebarSource.includes('sidebar-filter-wrap') && sidebarSource.includes('sidebar-active-bar') && sidebarSource.includes('sidebar-subnav') && sidebarSource.includes('sidebar-toggle-btn'),
  'sidebar_composition=unchanged',
);
check(
  'TOP-UI-26',
  !headerSource.includes('topology') && !sidebarSource.includes('topology') && !sidebarSource.includes('Topology'),
  'shell_hardcodes_no_topology_branch=true',
);

// 6. No independent theme system, no competing navigation registry
const shellSource = read('app/AppShell.tsx');
check('TOP-UI-27', /ThemeProvider/.test(read('providers/AppProviders.tsx')), 'single_theme_provider=true');
check('TOP-UI-28', !topologyText.includes('ThemeProvider') && !topologyText.includes('prefers-color-scheme'), 'topology_has_no_theme_system=true');
check('TOP-UI-29', !topologyText.includes('APP_ROUTES') && !topologyText.includes('createBrowserRouter'), 'topology_has_no_parallel_routing=true');
check('TOP-UI-30', /XCLOUD_THEME_PREFERENCE/.test(shellSource) || existsSync(resolve(source, 'providers/ThemeProvider.tsx')), 'theme_authority=shared');

// 7. No raw API calls and no hardcoded production nodes
let rawFetch = 0;
let absoluteGoUrl = 0;
let autoRetry = 0;
let hardcodedNodeArray = 0;
for (const file of topologyFiles) {
  const content = read(file);
  rawFetch += (content.match(/\bfetch\s*\(/g) ?? []).length;
  absoluteGoUrl += (content.match(/127\.0\.0\.1:18888|localhost:18888|http:\/\/127\./g) ?? []).length;
  autoRetry += (content.match(/retryCount|autoRetry|maxRetries/g) ?? []).length;
  hardcodedNodeArray += (content.match(/NF_NODES|NF_LINKS|INTERFACE_MAP|STATIC_NODES/g) ?? []).length;
}
check('TOP-UI-31', rawFetch === 0, `topology_raw_fetch=${rawFetch}`);
check('TOP-UI-32', absoluteGoUrl === 0, `topology_absolute_backend_urls=${absoluteGoUrl}`);
check('TOP-UI-33', autoRetry === 0, `topology_automatic_retries=${autoRetry}`);
check('TOP-UI-34', hardcodedNodeArray === 0, `topology_hardcoded_node_tables=${hardcodedNodeArray}`);

// 8. No false live-health labelling
const FALSE_HEALTH_PATTERNS = [
  /['"`]healthy['"`]/i,
  /['"`]unhealthy['"`]/i,
  /['"`]online['"`]/i,
  /['"`]offline['"`]/i,
  /['"`]reachable['"`]/i,
  /['"`]operational['"`]/i,
  />\s*Healthy\s*</i,
];
const falseHealthHits = FALSE_HEALTH_PATTERNS.filter((pattern) => pattern.test(topologyText));
check('TOP-UI-35', falseHealthHits.length === 0, `topology_false_live_health_labels=${falseHealthHits.length}`);
check(
  'TOP-UI-36',
  topologyText.includes('topology_declared_notice'),
  'topology_declared_state_disclosure=present',
);

// 9. Complete operator workflow coverage in the production surface
const pageSource = read('features/topology/TopologyPage.tsx');
const resourcePageSource = read('features/topology/ResourceTopologyPage.tsx');
check('TOP-UI-37', pageSource.includes('topology_create_relationship'), 'workflow=create_action_present');
check('TOP-UI-38', pageSource.includes('TopologyEdgeForm'), 'workflow=create_edit_form_present');
check('TOP-UI-39', pageSource.includes('retireTopologyEdge'), 'workflow=retire_present');
check('TOP-UI-40', pageSource.includes('TOPOLOGY_REVISION_CONFLICT') && pageSource.includes('topology_reload'), 'workflow=stale_revision_reload_path');
check('TOP-UI-41', pageSource.includes('hasPermission(user, \'core.configure\')'), 'workflow=role_aware_mutation_control');
check('TOP-UI-42', resourcePageSource.includes('TopologyGraph'), 'workflow=one_hop_graph_present');
check('TOP-UI-43', resourcePageSource.includes('TopologyEdgeTable'), 'workflow=accessible_equivalent_table_present');
check('TOP-UI-44', resourcePageSource.includes('TopologyEdgeDetail'), 'workflow=selected_relationship_detail_present');
check('TOP-UI-45', resourcePageSource.includes("direction"), 'workflow=direction_filter_present');
check('TOP-UI-46', resourcePageSource.includes('DOMAIN_FILTER_BUCKETS'), 'workflow=domain_presentation_filters_present');

// 10. States coverage
for (const [state, token] of [
  ['loading', 'LoadingRows'],
  ['empty', 'topology_empty_title'],
  ['no_filter_results', 'topology_empty_search_title'],
  ['error', 'ErrorState'],
  ['unknown_resource', 'topology_unknown_resource_title'],
  ['permission_denied', 'topology_permission_denied'],
  ['duplicate_conflict', 'topology_duplicate_edge'],
  ['stale_revision', 'topology_stale_revision_body'],
]) {
  check(`TOP-UI-47:${state}`, pageSource.includes(token) || resourcePageSource.includes(token), `topology_state_${state}=present`);
}

// 11. i18n completeness for the new surface
const enSource = read('lib/locales/en.ts');
const zhSource = read('lib/locales/zh.ts');
const REQUIRED_KEYS = [
  'nav_topology', 'topology_title', 'topology_description', 'topology_create_relationship',
  'topology_from_resource', 'topology_to_resource', 'topology_relationship', 'topology_lifecycle',
  'topology_direction', 'topology_revision', 'topology_updated_at', 'topology_retire',
  'topology_declared_notice', 'topology_empty_title', 'topology_empty_search_title',
  'topology_unknown_resource_title', 'topology_duplicate_edge', 'topology_stale_revision_body',
  'topology_permission_denied', 'topology_rel_depends_on', 'topology_rel_runs_on',
];
const missingEn = REQUIRED_KEYS.filter((key) => !new RegExp(`\\b${key}:`).test(enSource));
const missingZh = REQUIRED_KEYS.filter((key) => !new RegExp(`\\b${key}:`).test(zhSource));
check('TOP-UI-48', missingEn.length === 0, `missing_en_keys=[${missingEn.join(',')}]`);
check('TOP-UI-49', missingZh.length === 0, `missing_zh_keys=[${missingZh.join(',')}]`);
check('TOP-UI-50', /[\u4e00-\u9fff]/.test(zhSource.slice(zhSource.indexOf('nav_topology'))), 'topology_zh_localization=chinese_characters_present');

const failed = invariants.filter((invariant) => !invariant.ok);

console.log('-- Topology UI/UX acceptance contract --\n');
for (const invariant of invariants) {
  console.log(`  ${invariant.ok ? 'PASS' : 'FAIL'}  ${invariant.id} ${invariant.detail}`);
}

console.log('\n==================================================');
console.log(`topology_ui_routes=${topologyRoutes.length}`);
console.log(`topology_ui_frontend_route_count=${routes.length}`);
console.log(`topology_ui_navigation=${invariants.find((i) => i.id === 'TOP-UI-09')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_sidebar=${invariants.find((i) => i.id === 'TOP-UI-11')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_breadcrumbs=${invariants.find((i) => i.id === 'TOP-UI-13')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_command_palette=${invariants.find((i) => i.id === 'TOP-UI-14')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_shared_components=${invariants.find((i) => i.id === 'TOP-UI-16:PageHeader')?.ok && invariants.find((i) => i.id === 'TOP-UI-16:Dialog')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_token_system=${invariants.find((i) => i.id === 'TOP-UI-17')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_no_independent_theme=${invariants.find((i) => i.id === 'TOP-UI-28')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_no_parallel_navigation=${invariants.find((i) => i.id === 'TOP-UI-29')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_existing_shell_unchanged=${invariants.find((i) => i.id === 'TOP-UI-24')?.ok && invariants.find((i) => i.id === 'TOP-UI-25')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_responsive=${invariants.find((i) => i.id === 'TOP-UI-21')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_i18n=${invariants.find((i) => i.id === 'TOP-UI-48')?.ok && invariants.find((i) => i.id === 'TOP-UI-49')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_ui_accessibility_equivalent=${invariants.find((i) => i.id === 'TOP-UI-43')?.ok ? 'PASS' : 'FAIL'}`);
console.log(`topology_fake_live_health=${falseHealthHits.length}`);
console.log(`topology_static_cnms_node_authority=${hardcodedNodeArray}`);
console.log(`topology_ui_invariants_failed=${failed.length}`);
console.log(`topology_ui_result=${failed.length === 0 ? 'PASS' : 'FAIL'}`);
console.log('==================================================\n');

if (failed.length > 0) {
  console.error('Topology UI/UX acceptance contract FAILED.');
  process.exit(1);
}
console.log('Topology UI/UX acceptance contract result: PASS');
