import {
  Activity,
  CreditCard,
  Gauge,
  GitBranch,
  History,
  LayoutDashboard,
  Radio,
  Receipt,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { UserRole } from "@/lib/authz";
import { hasPermission, type Permission } from '@/lib/permissions';

export type NavigationGroup = "ocs" | "rating" | "governance" | "system";

export interface NavigationRoute {
  path: string;
  labelKey: string;
  commandLabelKey?: string;
  commandDescriptionKey: string;
  icon: LucideIcon;
  group?: NavigationGroup;
  groupLabelKey?: string;
  groupPath?: string;
  allowedRoles?: readonly UserRole[];
  permission?: Permission;
  showInCommandPalette?: boolean;
}

export const NAVIGATION_ROUTES: readonly NavigationRoute[] = [
  { path: "/", labelKey: "nav_dashboard", commandLabelKey: "cp_nav_dashboard", commandDescriptionKey: "cp_nav_dashboard_desc", icon: LayoutDashboard },
  { path: "/subscribers", labelKey: "nav_subscriber", commandLabelKey: "cp_nav_subscribers", commandDescriptionKey: "cp_nav_subscribers_desc", icon: Users },
  { path: "/ocs/balances", labelKey: "nav_ocs_balances", commandDescriptionKey: "ocs_balances_desc", icon: Wallet, group: "ocs", groupLabelKey: "nav_ocs", groupPath: "/ocs/balances" },
  { path: "/ocs/sessions", labelKey: "nav_ocs_sessions", commandDescriptionKey: "ocs_sessions_desc", icon: Radio, group: "ocs", groupLabelKey: "nav_ocs", groupPath: "/ocs/balances" },
  { path: "/ocs/usage", labelKey: "nav_ocs_usage", commandDescriptionKey: "ocs_usage_desc", icon: Receipt, group: "ocs", groupLabelKey: "nav_ocs", groupPath: "/ocs/balances" },
  { path: "/profile", labelKey: "nav_profile", commandLabelKey: "cp_nav_profiles", commandDescriptionKey: "cp_nav_profiles_desc", icon: CreditCard },
  { path: "/rating", labelKey: "nav_rating", commandLabelKey: "nav_rating", commandDescriptionKey: "cp_nav_rating_plans_desc", icon: Gauge, showInCommandPalette: false },
  { path: "/rating/plans", labelKey: "nav_rating_plans", commandLabelKey: "cp_nav_rating_plans", commandDescriptionKey: "cp_nav_rating_plans_desc", icon: Gauge, group: "rating", groupLabelKey: "nav_rating", groupPath: "/rating" },
  { path: "/rating/rules", labelKey: "nav_rating_rules", commandLabelKey: "cp_nav_rating_rules", commandDescriptionKey: "cp_nav_rating_rules_desc", icon: GitBranch, group: "rating", groupLabelKey: "nav_rating", groupPath: "/rating" },
  { path: "/approvals", labelKey: "nav_approvals", commandDescriptionKey: "approvals_center_desc", icon: GitBranch, group: "governance", groupLabelKey: "nav_operations_governance", groupPath: "/approvals" },
  { path: "/audit-logs", labelKey: "nav_audit_logs", commandLabelKey: "cp_nav_audit", commandDescriptionKey: "cp_nav_audit_desc", icon: History, group: "governance", groupLabelKey: "nav_operations_governance", groupPath: "/approvals" },
  { path: "/users", labelKey: "nav_system_users", commandDescriptionKey: "users_mgmt_desc", icon: UserCog, group: "system", groupLabelKey: "nav_system_settings", groupPath: "/users", permission: 'users.read' },
  { path: "/system-health", labelKey: "nav_system_health", commandLabelKey: "cp_nav_health", commandDescriptionKey: "cp_nav_health_desc", icon: Activity },
] as const;

const ROUTES_BY_PATH = new Map(NAVIGATION_ROUTES.map((route) => [route.path, route]));
const ROUTES_BY_MATCH_PRIORITY = [...NAVIGATION_ROUTES].sort((left, right) => right.path.length - left.path.length);

export function getNavigationRoute(path: string) {
  return ROUTES_BY_PATH.get(path);
}

export function routeMatchesPath(pathname: string, routePath: string) {
  if (routePath === "/") return pathname === "/";
  return pathname === routePath || pathname.startsWith(`${routePath}/`);
}

export function resolveNavigationRoute(pathname: string) {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTES_BY_PATH.get(normalizedPath) || ROUTES_BY_MATCH_PRIORITY.find((route) => routeMatchesPath(normalizedPath, route.path));
}

export function canAccessNavigationRoute(route: NavigationRoute, role?: UserRole) {
  if (route.permission) return hasPermission({ role }, route.permission);
  return !route.allowedRoles || (role ? route.allowedRoles.includes(role) : false);
}

export function getAccessibleNavigationRoutes(role?: UserRole) {
  return NAVIGATION_ROUTES.filter((route) => canAccessNavigationRoute(route, role));
}
