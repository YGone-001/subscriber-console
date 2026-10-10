#!/usr/bin/env node
/**
 * NF Health UI/UX acceptance contract.
 *
 * A separate contract from the backend NF Health model contract. It proves the
 * NF Health frontend is a native xCloud module rather than an isolated surface:
 *
 * - Both NF Health routes are registered and reachable through the shared router
 * - Navigation integration is active (sidebar derives from the shared authority)
 * - NF Health reuses the current shared UI primitives
 * - NF Health shares the xCloud stylesheet and design-token system
 * - No independent theme system and no competing navigation registry exist
 * - No raw API calls, no hardcoded production nodes and no false live-health labels
 * - Layer state is never collapsed into a healthy claim for unmeasured evidence
 * - No vendor product-name tokens appear in NF Health UI source or locale strings
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const source = resolve(frontend, 'src');
const featureDir = resolve(source, 'features/nf-health');
const read = (relativePath) => readFileSync(resolve(source, relativePath), 'utf8');

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

// 1. Routes
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
const healthRoutes = routes.filter((entry) => entry.route.startsWith('/nf-health'));
check('NFH-UI-01', healthRoutes.length === 2, `nf_health_routes=${healthRoutes.length}`);
check('NFH-UI-02', routes.length === 32, `frontend_route_count=${routes.length}`);
check(
  'NFH-UI-03',
  healthRoutes.some((r) => r.route === '/nf-health') && healthRoutes.some((r) => r.route === '/nf-health/:targetId'),
  'nf_health_route_paths=/nf-health,/nf-health/:targetId',
);
check(
  'NFH-UI-04',
  healthRoutes.find((r) => r.route === '/nf-health/:targetId')?.dynamicParameters?.includes('targetId') === true,
  'nf_health_dynamic_parameter=targetId',
);

const routerSource = read('router/router.tsx');
check('NFH-UI-05', routerSource.includes('NfHealthPage') && routerSource.includes('NfHealthDetailPage'), 'router_registration=both_pages');
check('NFH-UI-06', routerSource.includes("'/nf-health'") && routerSource.includes("'/nf-health/:targetId'"), 'router_paths=both');

// 2. Navigation
const navigationSource = read('lib/navigation.ts');
check('NFH-UI-07', navigationSource.includes("route: '/nf-health'") && navigationSource.includes("route: '/nf-health/:targetId'"), 'navigation_authority=nf_health_registered');
check('NFH-UI-08', navigationSource.includes("labelKey: 'nav_nf_health'") && navigationSource.includes('visible: true'), 'nf_health_navigation_visible=true');

const sidebarSource = read('app/components/AppSidebar.tsx');
const tabBarSource = read('app/components/NavigationTabBar.tsx');
const breadcrumbSource = read('app/components/NavigationBreadcrumbs.tsx');
const paletteSource = read('app/components/CommandPalette.tsx');
check('NFH-UI-09', sidebarSource.includes('getSidebarGroups'), 'sidebar=shared_authority');
check('NFH-UI-10', /getVisibleNavigation|canAccessNavigationRoute/.test(tabBarSource), 'tab_bar=shared_authority');
check('NFH-UI-11', breadcrumbSource.includes('getBreadcrumbs'), 'breadcrumbs=shared_authority');
check('NFH-UI-12', /getVisibleNavigation|filterNavigation/.test(paletteSource), 'command_palette=shared_authority');

// 3. Shared UI primitives
const featureFiles = [
  'features/nf-health/NfHealthPage.tsx',
  'features/nf-health/NfHealthDetailPage.tsx',
  'features/nf-health/NfHealthTargetDialog.tsx',
  'features/nf-health/nf-health-api.ts',
  'features/nf-health/nf-health-types.ts',
];
for (const file of featureFiles) {
  check(`NFH-UI-13:${file}`, existsSync(resolve(source, file)), `nf_health_file_present=${file}`);
}
const featureText = featureFiles.map((file) => read(file)).join('\n');
for (const [primitive, importPath] of [
  ['PageHeader', "components/ui/PageHeader'"],
  ['Dialog', "components/ui/Dialog'"],
  ['Field', "components/ui/Field'"],
  ['ErrorState', "components/ui/StatePanel'"],
  ['EmptyState', "components/ui/OperationFeedback'"],
  ['OperationFeedback', "components/ui/OperationFeedback'"],
  ['LoadingSkeleton', "components/ui/LoadingSkeleton'"],
]) {
  check(`NFH-UI-14:${primitive}`, featureText.includes(primitive) && featureText.includes(importPath), `nf_health_reuses_${primitive}=true`);
}

// 4. Design system
const cssPath = 'styles/modules/nf-health.module.css';
check('NFH-UI-15', existsSync(resolve(source, cssPath)), `nf_health_css_module_present=${cssPath}`);
const cssModule = existsSync(resolve(source, cssPath)) ? read(cssPath) : '';
check('NFH-UI-16', /var\(--[a-z0-9-]+\)/.test(cssModule), 'nf_health_css=design_tokens');
check('NFH-UI-17', !/#([0-9a-fA-F]{3,8})\b/.test(cssModule), 'nf_health_css=zero_raw_hex');
check('NFH-UI-18', !/rgba?\(/.test(cssModule), 'nf_health_css=zero_rgb_literals');
check('NFH-UI-19', !/createContext|ThemeProvider|data-theme/.test(featureText), 'nf_health_theme=shared_authority');

// 5. Security and honesty
check('NFH-UI-20', !/(?<![\w.])fetch\s*\(/.test(featureText), 'nf_health_raw_fetch=0');
check('NFH-UI-21', !/127\.0\.0\.1:18888/.test(featureText), 'nf_health_direct_go_urls=0');
check('NFH-UI-22', !/\bjose\b|document\.cookie|X-User-Role/.test(featureText), 'nf_health_auth_runtime=0');
check('NFH-UI-23', !/method:\s*['"]DELETE['"]/.test(featureText), 'nf_health_hard_delete_calls=0');
check(
  'NFH-UI-24',
  /l1Measured|l2Measured|l3Measured|layers\.process|not_configured/.test(featureText),
  'nf_health_layer_coverage_present=true',
);
check(
  'NFH-UI-25',
  /lastMeasuredAt|Last measured|last_measured/.test(featureText),
  'nf_health_freshness_present=true',
);
check(
  'NFH-UI-26',
  /Collect Now|nf_health_collect_action|collect_now/.test(featureText),
  'nf_health_manual_collection_present=true',
);

const localeEn = read('lib/locales/en.ts');
const localeZh = read('lib/locales/zh.ts');
const productTokens = /open5gs|kamailio|freeswitch|asterisk/i;
check('NFH-UI-27', !productTokens.test(featureText), 'nf_health_source_product_tokens=0');
check('NFH-UI-28', !productTokens.test(localeEn) && !productTokens.test(localeZh), 'locale_product_tokens=0');
check('NFH-UI-29', localeEn.includes('nav_nf_health') && localeZh.includes('nav_nf_health'), 'locale_keys=bilingual');
check(
  'NFH-UI-30',
  localeEn.includes('nf_health_title') && localeZh.includes('nf_health_title'),
  'locale_coverage=core_strings',
);
check(
  'NFH-UI-31',
  /not operational health|does not mean|HTTP 200|missing metric|never zero/i.test(localeEn) &&
    /不等于|不代表|缺失指标|绝不补零|HTTP 200/.test(localeZh),
  'nf_health_semantic_separation_copy=present',
);

// 6. Contract JSON present
const contract = JSON.parse(readFileSync(resolve(frontend, 'nf-health-contract.json'), 'utf8'));
check('NFH-UI-32', contract.routes.length === 2, `contract_routes=${contract.routes.length}`);
check('NFH-UI-33', contract.apis.length === 10, `contract_apis=${contract.apis.length}`);
check('NFH-UI-34', contract.collectorProfiles?.[0] === 'http_metrics', 'collector_profile=http_metrics');

// 7. Responsive layout guardrails
check('NFH-UI-35', Boolean(cssModule.match(/@media \(max-width: 900px\)/)), 'nf_health_css=column_breakpoint_present');
check(
  'NFH-UI-36',
  !/\.search\s*\{[^}]*flex:\s*\d+\s+\d+\s+\d+px/.test(cssModule.split('@media')[1] ?? ''),
  'nf_health_css=search_no_pixel_basis_in_column_layout',
);

// 8. Dialog integrity: actions stay reachable while the body scrolls.
const dialogSource = read('features/nf-health/NfHealthTargetDialog.tsx');
const modalBodyIdx = dialogSource.indexOf('styles.modalBody');
const formActionsIdx = dialogSource.indexOf('styles.formActions');
check(
  'NFH-UI-37',
  modalBodyIdx >= 0 && formActionsIdx > modalBodyIdx,
  'dialog_actions_outside_scrolling_body=true',
);
const bodyRegion = dialogSource.slice(modalBodyIdx, formActionsIdx);
const bodyClosesBeforeActions = bodyRegion.lastIndexOf('</div>') >= 0;
check('NFH-UI-38', bodyClosesBeforeActions, 'dialog_body_closes_before_action_row=true');
check(
  'NFH-UI-39',
  /max-height/.test(cssModule) && /overflow-y:\s*auto/.test(cssModule),
  'dialog_body_scrolls_independently=true',
);
check(
  'NFH-UI-40',
  /\.formActions\s*\{[^}]*flex:\s*0\s+0\s+auto/.test(cssModule),
  'dialog_action_row_pinned=true',
);

// 9. Freshness is server-derived and surfaced consistently.
const listSource = read('features/nf-health/NfHealthPage.tsx');
const detailSource = read('features/nf-health/NfHealthDetailPage.tsx');
const typesSource = read('features/nf-health/nf-health-types.ts');
check('NFH-UI-41', /freshness/.test(typesSource) && /FreshnessState/.test(typesSource), 'freshness_types_declared=true');
check('NFH-UI-42', /target\.freshness/.test(listSource) || /freshness\?\.state/.test(listSource), 'overview_uses_server_freshness=true');
check('NFH-UI-43', /freshness/.test(detailSource), 'detail_uses_server_freshness=true');
check(
  'NFH-UI-44',
  !/FRESH_WINDOW_MS|Date\.now\(\)\s*-\s*\d{4,}/.test(listSource),
  'freshness_not_computed_client_side=true',
);
check(
  'NFH-UI-45',
  /nf_health_state_stale/.test(listSource) || /badgeStale/.test(listSource),
  'stale_is_visibly_labeled=true',
);

let failed = 0;
for (const item of invariants) {
  const status = item.ok ? 'PASS' : 'FAIL';
  if (!item.ok) failed += 1;
  console.log(`${status} ${item.id} ${item.detail}`);
}
console.log(`\nNF Health UI/UX acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${invariants.length - failed}/${invariants.length})`);
if (failed > 0) process.exit(1);
