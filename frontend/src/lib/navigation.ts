import { Activity, BellRing, BookOpen, Boxes, Briefcase, CreditCard, FileText, Gauge, HeartPulse, LayoutDashboard, Network, Radar, Radio, ScrollText, Settings, Smartphone, UserCog, Users, Wallet, Zap, type LucideIcon } from 'lucide-react';
import type { CanonicalRole } from '../types/auth';
import { hasNavigationPermission } from './permissions';

export type NavigationRoute = {
  route: string;
  dynamicParameters: string[];
  targetRoute: string;
  labelKey: string;
  icon: LucideIcon;
  group?: 'business' | 'network' | 'platform';
  visible?: boolean;
  permission?: 'users.read';
};

export const APP_ROUTES: NavigationRoute[] = [
  { route: '/', targetRoute: '/', dynamicParameters: [], labelKey: 'nav_dashboard', icon: LayoutDashboard, visible: true },
  { route: '/login', targetRoute: '/login', dynamicParameters: [], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/inventory', targetRoute: '/inventory', dynamicParameters: [], labelKey: 'nav_inventory', icon: Boxes, group: 'network', visible: true },
  { route: '/inventory/:resourceId', targetRoute: '/inventory/:resourceId', dynamicParameters: ['resourceId'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/inventory/create', targetRoute: '/inventory/create', dynamicParameters: [], labelKey: 'nav_inventory_create', icon: Boxes },
  { route: '/topology', targetRoute: '/topology', dynamicParameters: [], labelKey: 'nav_topology', icon: Network, group: 'network', visible: true },
  { route: '/topology/:resourceId', targetRoute: '/topology/:resourceId', dynamicParameters: ['resourceId'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/discovery', targetRoute: '/discovery', dynamicParameters: [], labelKey: 'nav_discovery', icon: Radar, group: 'network', visible: true },
  { route: '/discovery/sources/:sourceId', targetRoute: '/discovery/sources/:sourceId', dynamicParameters: ['sourceId'], labelKey: 'nav_discovery', icon: FileText },
  { route: '/nf-health', targetRoute: '/nf-health', dynamicParameters: [], labelKey: 'nav_nf_health', icon: HeartPulse, group: 'network', visible: true },
  { route: '/nf-health/:targetId', targetRoute: '/nf-health/:targetId', dynamicParameters: ['targetId'], labelKey: 'nav_nf_health', icon: FileText },
  { route: '/nf-alerts', targetRoute: '/nf-alerts', dynamicParameters: [], labelKey: 'nav_nf_alerts', icon: BellRing, group: 'network', visible: true },
  { route: '/ue-info', targetRoute: '/ue-info', dynamicParameters: [], labelKey: 'nav_ue_info', icon: Smartphone, group: 'network', visible: true },
  { route: '/logs', targetRoute: '/logs', dynamicParameters: [], labelKey: 'nav_logs', icon: ScrollText, group: 'platform', visible: true },
  { route: '/knowledge', targetRoute: '/knowledge', dynamicParameters: [], labelKey: 'nav_knowledge', icon: BookOpen, group: 'platform', visible: true },
  { route: '/knowledge/new', targetRoute: '/knowledge/new', dynamicParameters: [], labelKey: 'nav_knowledge_new', icon: BookOpen },
  { route: '/knowledge/:entryId', targetRoute: '/knowledge/:entryId', dynamicParameters: ['entryId'], labelKey: 'nav_knowledge', icon: BookOpen },
  { route: '/knowledge/:entryId/edit', targetRoute: '/knowledge/:entryId/edit', dynamicParameters: ['entryId'], labelKey: 'nav_knowledge_edit', icon: BookOpen },
  { route: '/ocs', targetRoute: '/ocs', dynamicParameters: [], labelKey: 'nav_ocs', icon: Zap },
  { route: '/ocs/balances', targetRoute: '/ocs/balances', dynamicParameters: [], labelKey: 'nav_ocs_balances', icon: Wallet, group: 'business', visible: true },
  { route: '/ocs/balances/:imsi', targetRoute: '/ocs/balances/:imsi', dynamicParameters: ['imsi'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/ocs/contracts', targetRoute: '/ocs/contracts', dynamicParameters: [], labelKey: 'nav_ocs_contracts', icon: Users, group: 'business', visible: true },
  { route: '/ocs/contracts/:imsi', targetRoute: '/ocs/contracts/:imsi', dynamicParameters: ['imsi'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/ocs/dashboard', targetRoute: '/ocs/dashboard', dynamicParameters: [], labelKey: 'nav_ocs_dashboard', icon: LayoutDashboard },
  { route: '/ocs/sessions', targetRoute: '/ocs/sessions', dynamicParameters: [], labelKey: 'nav_ocs_sessions', icon: Activity },
  { route: '/ocs/subscribers', targetRoute: '/ocs/subscribers', dynamicParameters: [], labelKey: 'nav_ocs_subscribers', icon: Users },
  { route: '/ocs/tariffs', targetRoute: '/ocs/tariffs', dynamicParameters: [], labelKey: 'nav_ocs_tariffs', icon: CreditCard, group: 'business', visible: true },
  { route: '/ocs/tariffs/:planId', targetRoute: '/ocs/tariffs/:planId', dynamicParameters: ['planId'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/ocs/usage', targetRoute: '/ocs/usage', dynamicParameters: [], labelKey: 'nav_ocs_usage', icon: Gauge },
  { route: '/profile', targetRoute: '/profile', dynamicParameters: [], labelKey: 'nav_profile', icon: FileText, group: 'business', visible: true },
  { route: '/profile/new', targetRoute: '/profile/new', dynamicParameters: [], labelKey: 'nav_profile_new', icon: FileText },
  { route: '/profile/:name', targetRoute: '/profile/:name', dynamicParameters: ['name'], labelKey: 'nav_profile', icon: FileText },
  { route: '/rating', targetRoute: '/rating', dynamicParameters: [], labelKey: 'nav_rating', icon: Radio, visible: true },
  { route: '/rating/plans', targetRoute: '/rating/plans', dynamicParameters: [], labelKey: 'nav_rating_plans', icon: CreditCard },
  { route: '/rating/rules', targetRoute: '/rating/rules', dynamicParameters: [], labelKey: 'nav_rating_rules', icon: FileText },
  { route: '/roles', targetRoute: '/roles', dynamicParameters: [], labelKey: 'nav_roles', icon: UserCog },
  { route: '/subscribers', targetRoute: '/subscribers', dynamicParameters: [], labelKey: 'nav_subscriber', icon: Users, group: 'business', visible: true },
  { route: '/system-health', targetRoute: '/system-health', dynamicParameters: [], labelKey: 'nav_system_health', icon: Activity, group: 'platform', visible: true },
  { route: '/users', targetRoute: '/users', dynamicParameters: [], labelKey: 'nav_system_users', icon: UserCog, group: 'platform', visible: true, permission: 'users.read' },
  { route: '/users/:username', targetRoute: '/users/:username', dynamicParameters: ['username'], labelKey: 'nav_dashboard', icon: FileText },
  { route: '/users/create', targetRoute: '/users/create', dynamicParameters: [], labelKey: 'nav_user_create', icon: UserCog, permission: 'users.read' },
];

export const SPA_ROUTE_PATTERNS = APP_ROUTES.map((route) => route.route);

export function getNavigationRoute(pathname: string): NavigationRoute | undefined {
  const exact = APP_ROUTES.find((route) => route.route === pathname);
  if (exact) return exact;
  return [...APP_ROUTES]
    .filter((route) => route.route.includes(':'))
    .sort((left, right) => right.route.length - left.route.length)
    .find((route) => matchesRoute(route.route, pathname));
}

export function matchesRoute(pattern: string, pathname: string): boolean {
  const expression = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
  return expression.test(pathname);
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const labelKey = isDynamicValue
      ? (UUID_SEGMENT.test(segment) ? 'breadcrumbs_detail' : segment)
      : (found?.labelKey ?? segment);
    crumbs.push({ labelKey, path: candidate, current: candidate === pathname });
  }
  return crumbs;
}

/** Shell geometry contract. Values mirror the compact desktop shell CSS. */
export const SHELL_GEOMETRY = {
  expandedWidth: 212,
  collapsedWidth: 58,
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
 * Canonical child order for the three sidebar domains. Routes outside an order
 * list sort last so a newly added surface never displaces a canonical entry.
 */
const BUSINESS_CHILD_ORDER = ['/subscribers', '/profile', '/ocs/tariffs', '/ocs/contracts', '/ocs/balances'];
const NETWORK_CHILD_ORDER = ['/inventory', '/topology', '/discovery', '/nf-health', '/nf-alerts', '/ue-info'];
const PLATFORM_CHILD_ORDER = ['/system-health', '/users', '/logs', '/knowledge'];

/**
 * Grouped sidebar model derived from the current navigation authority.
 *
 * Four first-level entries: the dashboard plus business, network and platform
 * domains. Domain groups keep one expansion level and a flat child list.
 *
 * A group is only produced when at least one of its routes is visible for the
 * given role, so unauthorised groups never reach the presentation layer. The
 * reference sidebar renders no Rating entry because those routes redirect to
 * the tariff surface.
 */
export function getSidebarGroups(role: CanonicalRole | undefined): SidebarGroup[] {
  const routes = getVisibleNavigation(role);
  const find = (target: string) => routes.find((route) => route.targetRoute === target);
  const childrenFor = (name: 'business' | 'network' | 'platform', order: string[]) => {
    const rank = (route: NavigationRoute) => {
      const index = order.indexOf(route.targetRoute);
      return index === -1 ? order.length : index;
    };
    return routes
      .filter((route) => route.group === name)
      .sort((left, right) => rank(left) - rank(right) || left.targetRoute.localeCompare(right.targetRoute));
  };
  const groups: SidebarGroup[] = [];

  const dashboard = find('/');
  if (dashboard) {
    groups.push({
      key: dashboard.labelKey,
      match: dashboard.targetRoute,
      target: dashboard.targetRoute,
      icon: dashboard.icon,
      children: [],
    });
  }

  const businessChildren = childrenFor('business', BUSINESS_CHILD_ORDER);
  if (businessChildren.length > 0) {
    groups.push({
      key: 'nav_business',
      match: businessChildren[0].targetRoute,
      target: businessChildren[0].targetRoute,
      icon: Briefcase,
      children: businessChildren,
    });
  }

  const networkChildren = childrenFor('network', NETWORK_CHILD_ORDER);
  if (networkChildren.length > 0) {
    groups.push({
      key: 'nav_network_ops',
      match: networkChildren[0].targetRoute,
      target: networkChildren[0].targetRoute,
      icon: Network,
      children: networkChildren,
    });
  }

  const platformChildren = childrenFor('platform', PLATFORM_CHILD_ORDER);
  if (platformChildren.length > 0) {
    groups.push({
      key: 'nav_platform',
      match: platformChildren[0].targetRoute,
      target: platformChildren[0].targetRoute,
      icon: Settings,
      children: platformChildren,
    });
  }

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
