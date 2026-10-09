import { Activity, Boxes, CreditCard, FileText, Gauge, LayoutDashboard, Network, Radio, Settings, UserCog, Users, Wallet, Zap, type LucideIcon } from 'lucide-react';
import type { CanonicalRole } from '../types/auth';
import { hasNavigationPermission } from './permissions';

export type NavigationRoute = {
  route: string;
  dynamicParameters: string[];
  targetRoute: string;
  labelKey: string;
  icon: LucideIcon;
  group?: 'ocs' | 'system';
  visible?: boolean;
  permission?: 'users.read';
};

export const APP_ROUTES: NavigationRoute[] = [
  { route: '/', targetRoute: '/', dynamicParameters: [], labelKey: 'nav_dashboard', icon: LayoutDashboard, visible: true },
  { route: '/login', targetRoute: '/login', dynamicParameters: [], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/inventory', targetRoute: '/inventory', dynamicParameters: [], labelKey: 'nav_inventory', icon: Boxes, visible: true },
  { route: '/inventory/:resourceId', targetRoute: '/inventory/:resourceId', dynamicParameters: ['resourceId'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/inventory/create', targetRoute: '/inventory/create', dynamicParameters: [], labelKey: 'nav_inventory_create', icon: Boxes },
  { route: '/topology', targetRoute: '/topology', dynamicParameters: [], labelKey: 'nav_topology', icon: Network, visible: true },
  { route: '/topology/:resourceId', targetRoute: '/topology/:resourceId', dynamicParameters: ['resourceId'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/ocs', targetRoute: '/ocs', dynamicParameters: [], labelKey: 'nav_ocs', icon: Zap },
  { route: '/ocs/balances', targetRoute: '/ocs/balances', dynamicParameters: [], labelKey: 'nav_ocs_balances', icon: Wallet, group: 'ocs', visible: true },
  { route: '/ocs/balances/:imsi', targetRoute: '/ocs/balances/:imsi', dynamicParameters: ['imsi'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/ocs/contracts', targetRoute: '/ocs/contracts', dynamicParameters: [], labelKey: 'nav_ocs_contracts', icon: Users, group: 'ocs', visible: true },
  { route: '/ocs/contracts/:imsi', targetRoute: '/ocs/contracts/:imsi', dynamicParameters: ['imsi'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/ocs/dashboard', targetRoute: '/ocs/dashboard', dynamicParameters: [], labelKey: 'nav_ocs_dashboard', icon: LayoutDashboard },
  { route: '/ocs/sessions', targetRoute: '/ocs/sessions', dynamicParameters: [], labelKey: 'nav_ocs_sessions', icon: Activity },
  { route: '/ocs/subscribers', targetRoute: '/ocs/subscribers', dynamicParameters: [], labelKey: 'nav_ocs_subscribers', icon: Users },
  { route: '/ocs/tariffs', targetRoute: '/ocs/tariffs', dynamicParameters: [], labelKey: 'nav_ocs_tariffs', icon: CreditCard, group: 'ocs', visible: true },
  { route: '/ocs/tariffs/:planId', targetRoute: '/ocs/tariffs/:planId', dynamicParameters: ['planId'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/ocs/usage', targetRoute: '/ocs/usage', dynamicParameters: [], labelKey: 'nav_ocs_usage', icon: Gauge },
  { route: '/profile', targetRoute: '/profile', dynamicParameters: [], labelKey: 'nav_profile', icon: FileText, visible: true },
  { route: '/rating', targetRoute: '/rating', dynamicParameters: [], labelKey: 'nav_rating', icon: Radio, visible: true },
  { route: '/rating/plans', targetRoute: '/rating/plans', dynamicParameters: [], labelKey: 'nav_rating_plans', icon: CreditCard },
  { route: '/rating/rules', targetRoute: '/rating/rules', dynamicParameters: [], labelKey: 'nav_rating_rules', icon: FileText },
  { route: '/roles', targetRoute: '/roles', dynamicParameters: [], labelKey: 'nav_roles', icon: UserCog },
  { route: '/subscribers', targetRoute: '/subscribers', dynamicParameters: [], labelKey: 'nav_subscriber', icon: Users, visible: true },
  { route: '/system-health', targetRoute: '/system-health', dynamicParameters: [], labelKey: 'nav_system_health', icon: Activity, visible: true },
  { route: '/users', targetRoute: '/users', dynamicParameters: [], labelKey: 'nav_system_users', icon: UserCog, group: 'system', visible: true, permission: 'users.read' },
  { route: '/users/:username', targetRoute: '/users/:username', dynamicParameters: ['username'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/users/create', targetRoute: '/users/create', dynamicParameters: [], labelKey: 'nav_user_create', icon: UserCog, permission: 'users.read' },
];

export const SPA_ROUTE_PATTERNS = APP_ROUTES.map((route) => route.route);

export function getNavigationRoute(pathname: string): NavigationRoute | undefined {
  return [...APP_ROUTES]
    .sort((left, right) => right.route.length - left.route.length)
    .find((route) => matchesRoute(route.route, pathname));
}

export function matchesRoute(pattern: string, pathname: string): boolean {
  const expression = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
  return expression.test(pathname);
}

/**
 * Resolve a live pathname to its navigation route.
 *
 * Reference-compatible entry point used by the workspace tab bar and the
 * breadcrumb tool cluster: trailing slashes are normalised before the
 * longest-prefix match, so `/ocs/tariffs/` resolves to `/ocs/tariffs`.
 */
export function resolveNavigationRoute(pathname: string): NavigationRoute | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return getNavigationRoute(normalized);
}

/**
 * Whether the given role may reach the route.
 *
 * Presentation-side gate only: the backend remains the authorization authority.
 * Derived from the visible-route set so a single source of truth is preserved.
 */
export function canAccessNavigationRoute(route: NavigationRoute, role?: CanonicalRole): boolean {
  return getVisibleNavigation(role).some((candidate) => candidate.route === route.route);
}

export function getVisibleNavigation(role: CanonicalRole | undefined): NavigationRoute[] {
  return APP_ROUTES.filter((route) => route.visible && hasNavigationPermission(role, route.permission));
}

export function getBreadcrumbs(pathname: string): Array<{ labelKey: string; path?: string; current: boolean }> {
  const route = getNavigationRoute(pathname);
  if (!route || route.route === '/') return [{ labelKey: 'breadcrumbs_home', current: true }];
  const crumbs: Array<{ labelKey: string; path?: string; current: boolean }> = [{ labelKey: 'breadcrumbs_home', path: '/', current: false }];
  const segments = pathname.split('/').filter(Boolean);
  const accumulated: string[] = [];
  for (const segment of segments) {
    accumulated.push(segment);
    const candidate = `/${accumulated.join('/')}`;
    const found = getNavigationRoute(candidate);
    const isDynamicValue = Boolean(found?.route.split('/').at(-1)?.startsWith(':'));
    crumbs.push({ labelKey: isDynamicValue ? segment : (found?.labelKey ?? segment), path: candidate, current: candidate === pathname });
  }
  return crumbs;
}

/** Shell geometry contract. Values mirror the restored xCloud shell CSS. */
export const SHELL_GEOMETRY = {
  expandedWidth: 264,
  collapsedWidth: 72,
  breakpoint: 981,
} as const;

export type SidebarGroup = {
  key: string;
  match: string;
  target: string;
  icon: LucideIcon;
  children: NavigationRoute[];
};

/**
 * Canonical OCS sub-navigation order, matching the reference sidebar
 * (tariff plans -> contracts -> balances). Routes outside this list sort last
 * so a newly added OCS surface never displaces a canonical entry.
 */
const OCS_CHILD_ORDER = ['/ocs/tariffs', '/ocs/contracts', '/ocs/balances'];

/**
 * Grouped sidebar model derived from the current navigation authority.
 * A group is only produced when at least one of its routes is visible for the
 * given role, so unauthorised groups never reach the presentation layer.
 *
 * The reference sidebar renders no Rating entry: the rating routes redirect to
 * the tariff surface, so exposing them as a destination would be a dead link.
 * Inventory has no reference equivalent and is appended after System health.
 */
export function getSidebarGroups(role: CanonicalRole | undefined): SidebarGroup[] {
  const routes = getVisibleNavigation(role);
  const find = (target: string) => routes.find((route) => route.targetRoute === target);
  const group = (name: 'ocs' | 'system') => routes.filter((route) => route.group === name);
  const groups: SidebarGroup[] = [];

  const push = (route: NavigationRoute | undefined, match?: string) => {
    if (!route) return;
    groups.push({ key: route.labelKey, match: match ?? route.targetRoute, target: route.targetRoute, icon: route.icon, children: [] });
  };

  push(find('/'));
  push(find('/subscribers'));

  const rank = (route: NavigationRoute) => {
    const index = OCS_CHILD_ORDER.indexOf(route.targetRoute);
    return index === -1 ? OCS_CHILD_ORDER.length : index;
  };
  const ocsChildren = group('ocs').sort((left, right) => rank(left) - rank(right));
  if (ocsChildren.length > 0) {
    groups.push({ key: 'nav_ocs', match: '/ocs', target: '/ocs/tariffs', icon: Zap, children: ocsChildren });
  }

  push(find('/profile'));

  const systemChildren = group('system');
  if (systemChildren.length > 0) {
    groups.push({ key: 'nav_system_settings', match: '/users', target: systemChildren[0].targetRoute, icon: Settings, children: systemChildren });
  }

  push(find('/system-health'));
  push(find('/inventory'));
  push(find('/topology'));

  return groups;
}

/** Case-insensitive label/route filter used by the sidebar and command palette. */
export function filterNavigation(
  routes: NavigationRoute[],
  query: string,
  resolveLabel: (labelKey: string) => string,
): NavigationRoute[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return routes;
  return routes.filter((route) =>
    `${resolveLabel(route.labelKey)} ${route.targetRoute}`.toLowerCase().includes(needle));
}
