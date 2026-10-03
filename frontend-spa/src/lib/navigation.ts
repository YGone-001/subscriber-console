import { Activity, CreditCard, FileText, Gauge, LayoutDashboard, Radio, UserCog, Users, Wallet, Zap, type LucideIcon } from 'lucide-react';
import migrationRoutes from '../../migration-routes.json';
import type { CanonicalRole } from '../types/auth';
import { hasNavigationPermission } from './permissions';

type MigrationRoute = (typeof migrationRoutes)[number];

export type NavigationRoute = MigrationRoute & {
  labelKey: string;
  icon: LucideIcon;
  group?: 'ocs' | 'system';
  visible?: boolean;
  permission?: 'users.read';
};

const presentation: Record<string, Omit<NavigationRoute, keyof MigrationRoute>> = {
  '/': { labelKey: 'nav_dashboard', icon: LayoutDashboard, visible: true },
  '/ocs': { labelKey: 'nav_ocs', icon: Zap },
  '/ocs/balances': { labelKey: 'nav_balances', icon: Wallet, group: 'ocs', visible: true },
  '/ocs/contracts': { labelKey: 'nav_contracts', icon: Users, group: 'ocs', visible: true },
  '/ocs/dashboard': { labelKey: 'nav_ocs_dashboard', icon: LayoutDashboard },
  '/ocs/sessions': { labelKey: 'nav_ocs_sessions', icon: Activity },
  '/ocs/subscribers': { labelKey: 'nav_ocs_subscribers', icon: Users },
  '/ocs/tariffs': { labelKey: 'nav_tariffs', icon: CreditCard, group: 'ocs', visible: true },
  '/ocs/usage': { labelKey: 'nav_ocs_usage', icon: Gauge },
  '/profile': { labelKey: 'nav_profile', icon: FileText, visible: true },
  '/rating': { labelKey: 'nav_rating', icon: Radio, visible: true },
  '/rating/plans': { labelKey: 'nav_rating_plans', icon: CreditCard },
  '/rating/rules': { labelKey: 'nav_rating_rules', icon: FileText },
  '/roles': { labelKey: 'nav_roles', icon: UserCog },
  '/subscribers': { labelKey: 'nav_subscribers', icon: Users, visible: true },
  '/system-health': { labelKey: 'nav_health', icon: Activity, visible: true },
  '/users': { labelKey: 'nav_users', icon: UserCog, group: 'system', visible: true, permission: 'users.read' },
  '/users/create': { labelKey: 'nav_user_create', icon: UserCog, permission: 'users.read' },
};

export const APP_ROUTES: NavigationRoute[] = migrationRoutes.map((route) => ({
  ...route,
  ...(presentation[route.targetRoute] ?? { labelKey: 'nav_dashboard', icon: FileText }),
}));

export const SPA_ROUTE_PATTERNS = APP_ROUTES.map((route) => route.targetRoute);

export function getNavigationRoute(pathname: string): NavigationRoute | undefined {
  return [...APP_ROUTES]
    .sort((left, right) => right.targetRoute.length - left.targetRoute.length)
    .find((route) => matchesRoute(route.targetRoute, pathname));
}

export function matchesRoute(pattern: string, pathname: string): boolean {
  const expression = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
  return expression.test(pathname);
}

export function getVisibleNavigation(role: CanonicalRole | undefined): NavigationRoute[] {
  return APP_ROUTES.filter((route) => route.visible && hasNavigationPermission(role, route.permission));
}

export function getBreadcrumbs(pathname: string): Array<{ labelKey: string; path?: string; current: boolean }> {
  const route = getNavigationRoute(pathname);
  if (!route || route.targetRoute === '/') return [{ labelKey: 'breadcrumbs_home', current: true }];
  const crumbs: Array<{ labelKey: string; path?: string; current: boolean }> = [{ labelKey: 'breadcrumbs_home', path: '/', current: false }];
  const segments = pathname.split('/').filter(Boolean);
  const accumulated: string[] = [];
  for (const segment of segments) {
    accumulated.push(segment);
    const candidate = `/${accumulated.join('/')}`;
    const found = getNavigationRoute(candidate);
    const isDynamicValue = Boolean(found?.targetRoute.split('/').at(-1)?.startsWith(':'));
    crumbs.push({ labelKey: isDynamicValue ? segment : (found?.labelKey ?? segment), path: candidate, current: candidate === pathname });
  }
  return crumbs;
}
