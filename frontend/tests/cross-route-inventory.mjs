/*
 * The FE-C3 route inventory.
 *
 * TEST-ONLY. Nothing in this module is imported by production runtime code.
 *
 * The route contract (frontend/route-contract.json) is the single authority for
 * WHICH routes exist. This module adds the review metadata the FE-C3 audit
 * needs: how a route is classified, which fixture identity exercises it, which
 * read drives its surface and what the expected access behaviour is.
 *
 * The route LIST is read from the contract file at runtime, never duplicated
 * here, so this file can never become a second independent routing authority.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTE_IDENTITIES } from './cross-route-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');

/** The frozen route contract. */
export const ROUTE_CONTRACT = JSON.parse(
  readFileSync(path.join(frontendRoot, 'route-contract.json'), 'utf8'),
);

/**
 * Compatibility redirects.
 *
 * Read from the production redirect authority so the acceptance expectation
 * and the application behaviour cannot drift apart.
 */
export const COMPATIBILITY_REDIRECTS = (() => {
  const source = readFileSync(path.join(frontendRoot, 'src/router/redirects.ts'), 'utf8');
  const redirects = {};
  for (const match of source.matchAll(/'([^']+)':\s*'([^']+)'/g)) {
    redirects[match[1]] = match[2];
  }
  return redirects;
})();

/**
 * Per-route review metadata.
 *
 * `class` is the FE-C3 route classification:
 *   primary      a primary interactive page
 *   detail       a dynamic detail page
 *   form         a create/edit page
 *   auth         an authentication page
 *   redirect     a compatibility redirect
 *   conditional  a permission-gated or data-dependent route
 */
const ROUTE_METADATA = {
  '/': { class: 'primary', family: 'Dashboard', owner: 'features/read/ReadPages.tsx', label: 'Operations Overview', reads: ['/api/operations/summary', '/api/analytics/metrics', '/api/runtime/observations', '/api/ue-info', '/api/ims/registrations/summary'], ux: ['KPI strip', 'chart alternative table', 'NOC posture link', 'live-region posture'] },
  '/login': { class: 'auth', family: 'Authentication', owner: 'auth/LoginPage.tsx', label: 'Sign in', reads: [], ux: ['native validation', 'error alert region', 'password visibility'] },

  '/inventory': { class: 'primary', family: 'Inventory', owner: 'features/inventory/InventoryPage.tsx', label: 'Inventory', reads: ['/api/inventory/resources', '/api/inventory/meta'], ux: ['filter toolbar', 'data table', 'pagination', 'runtime panel'] },
  '/inventory/assets': { class: 'primary', family: 'Inventory', owner: 'features/inventory/InventoryAssetsPage.tsx', label: 'Inventory assets', reads: ['/api/inventory/resources'], ux: ['data table', 'pagination', 'column priority'] },
  '/inventory/runtime': { class: 'primary', family: 'Inventory', owner: 'features/inventory/InventoryRuntimePage.tsx', label: 'Runtime', reads: ['/api/runtime/observations', '/api/runtime/meta'], ux: ['component cards', 'verification state', 'evidence column'] },
  '/inventory/groups': { class: 'primary', family: 'Inventory', owner: 'features/groups/GroupsPage.tsx', label: 'Groups', reads: ['/api/operations/groups', '/api/operations/groups/summary'], ux: ['group table', 'membership dialog', 'summary metrics'] },
  '/inventory/:resourceId': { class: 'detail', family: 'Inventory', owner: 'features/inventory/InventoryDetailPage.tsx', label: 'Resource detail', reads: ['/api/inventory/resources/{resourceId}'], ux: ['description list', 'runtime association', 'drift card'] },
  '/inventory/create': { class: 'form', family: 'Inventory', owner: 'features/inventory/InventoryCreatePage.tsx', label: 'Create resource', reads: ['/api/inventory/meta'], ux: ['labeled fields', 'validation summary', 'unsaved-change guard'] },

  '/topology': { class: 'primary', family: 'Topology', owner: 'features/topology/TopologyPage.tsx', label: 'Topology', reads: ['/api/topology/edges', '/api/topology/live', '/api/topology/meta'], ux: ['three-mode navigation', 'graph evidence sources', 'ledger filters', 'URL atomicity'] },
  '/topology/:resourceId': { class: 'detail', family: 'Topology', owner: 'features/topology/ResourceTopologyPage.tsx', label: 'Resource topology', reads: ['/api/topology/resources/{resourceId}/neighbors'], ux: ['neighbor list', 'declared vs configured vs observed'] },

  '/discovery': { class: 'primary', family: 'Discovery', owner: 'features/discovery/DiscoveryPage.tsx', label: 'Discovery', reads: ['/api/discovery/sources', '/api/discovery/runs', '/api/discovery/candidates', '/api/discovery/meta'], ux: ['tab views', 'freshness chip', 'disabled-source state'] },
  '/discovery/sources/:sourceId': { class: 'detail', family: 'Discovery', owner: 'features/discovery/DiscoverySourceDetailPage.tsx', label: 'Source detail', reads: ['/api/discovery/sources/{sourceId}'], ux: ['source evidence', 'candidate list'] },

  '/nf-health': { class: 'primary', family: 'NF Health', owner: 'features/nf-health/NfHealthPage.tsx', label: 'NF Health', reads: ['/api/nf-health/targets', '/api/nf-health/meta'], ux: ['measurement vs health separation', 'shared read', 'pagination'] },
  '/nf-health/:targetId': { class: 'detail', family: 'NF Health', owner: 'features/nf-health/NfHealthDetailPage.tsx', label: 'Target detail', reads: ['/api/nf-health/targets/{targetId}', '/api/nf-health/targets/{targetId}/history'], ux: ['metric charts', 'history table', 'rule panel'] },
  '/nf-alerts': { class: 'primary', family: 'NF Health', owner: 'features/nf-alerts/NfAlertsPage.tsx', label: 'NF Alerts', reads: ['/api/nf-alerts', '/api/nf-alerts/meta', '/api/nf-alerts/rules'], ux: ['severity badge vocabulary', 'rule scope', 'acknowledgement workflow'] },
  '/ue-info': { class: 'primary', family: 'UE information', owner: 'features/ue-info/UEInfoPage.tsx', label: 'UE information', reads: ['/api/ue-info'], ux: ['state table', 'unavailable values', 'pagination'] },

  '/logs': { class: 'primary', family: 'Log Center', owner: 'features/logs/LogCenterPage.tsx', label: 'Log Center', reads: ['/api/nf-logs/sources', '/api/nf-logs/stream'], ux: ['bounded 2000-line rendering', 'live/reconnecting/unavailable states', 'row identity'] },

  '/ocs': { class: 'redirect', family: 'OCS', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /ocs/tariffs'] },
  '/ocs/balances': { class: 'primary', family: 'OCS', owner: 'features/ocs/balances/BalancesPage.tsx', label: 'Balances', reads: ['/api/ocs/balances'], ux: ['quota conservation metrics', 'adjustment dialog', 'pagination'] },
  '/ocs/balances/:imsi': { class: 'detail', family: 'OCS', owner: 'features/ocs/balances/BalanceDetailPage.tsx', label: 'Balance detail', reads: ['/api/ocs/balances/{imsi}'], ux: ['bucket table', 'invariant flags', 'adjustment history'] },
  '/ocs/contracts': { class: 'primary', family: 'OCS', owner: 'features/ocs/contracts/ContractsPage.tsx', label: 'Contracts', reads: ['/api/ocs/subscribers'], ux: ['contract table', 'create dialog', 'pagination'] },
  '/ocs/contracts/:imsi': { class: 'detail', family: 'OCS', owner: 'features/ocs/contracts/ContractDetailPage.tsx', label: 'Contract detail', reads: ['/api/ocs/subscribers?imsi='], ux: ['contract fields', 'operation history'] },
  '/ocs/dashboard': { class: 'redirect', family: 'OCS', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /ocs/tariffs'] },
  '/ocs/sessions': { class: 'redirect', family: 'OCS', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /ocs/tariffs'] },
  '/ocs/subscribers': { class: 'redirect', family: 'OCS', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /ocs/contracts'] },
  '/ocs/tariffs': { class: 'primary', family: 'OCS', owner: 'features/ocs/tariffs/TariffsPage.tsx', label: 'Tariff plans', reads: ['/api/tariff-plans'], ux: ['governance panel', 'clone dialog', 'enable/disable workflow'] },
  '/ocs/tariffs/:planId': { class: 'detail', family: 'OCS', owner: 'features/ocs/tariffs/TariffDetailPage.tsx', label: 'Tariff detail', reads: ['/api/tariff-plans/{planId}', '/api/tariff-plans/{planId}/rules', '/api/tariff-plans/{planId}/subscribers', '/api/tariff-plans/{planId}/operations'], ux: ['rule table', 'subscriber table', 'operation history'] },
  '/ocs/usage': { class: 'redirect', family: 'OCS', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /ocs/tariffs'] },

  '/profile': { class: 'primary', family: 'Profiles', owner: 'features/profiles/ProfilesPage.tsx', label: 'Profiles', reads: ['/api/profiles', '/api/profiles/meta'], ux: ['profile table', 'archive filter', 'export'] },
  '/profile/new': { class: 'form', family: 'Profiles', owner: 'features/profiles/ProfileDetailPage.tsx', label: 'Create profile', reads: ['/api/profiles/meta', '/api/tariff-plans'], ux: ['labeled fields', 'slice editor', 'unsaved-change guard'] },
  '/profile/:name': { class: 'detail', family: 'Profiles', owner: 'features/profiles/ProfileDetailPage.tsx', label: 'Profile detail', reads: ['/api/profiles/{name}', '/api/profiles/{name}/versions'], ux: ['view/edit modes', 'drift card', 'section nav'] },

  '/rating': { class: 'redirect', family: 'Profiles', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /ocs/tariffs'] },
  '/rating/plans': { class: 'redirect', family: 'Profiles', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /ocs/tariffs'] },
  '/rating/rules': { class: 'redirect', family: 'Profiles', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /ocs/tariffs'] },
  '/roles': { class: 'redirect', family: 'Users and roles', owner: 'router/redirects.ts', label: 'Compatibility alias', reads: [], ux: ['redirect to /users'] },

  '/subscribers': { class: 'primary', family: 'Subscribers', owner: 'features/subscribers/SubscribersPage.tsx', label: 'Subscribers', reads: ['/api/subscribers', '/api/profiles', '/api/tariff-plans'], ux: ['query ownership', 'selection ownership', 'sortable table', 'bulk selection', 'pagination'] },
  '/subscribers/new': { class: 'form', family: 'Subscribers', owner: 'features/subscribers/SubscriberDetailPage.tsx', label: 'Create subscriber', reads: ['/api/profiles', '/api/tariff-plans'], ux: ['IMSI/MSISDN validation', 'auth material fields', 'quota composer', 'unsaved-change guard'] },
  '/subscribers/:imsi': { class: 'detail', family: 'Subscribers', owner: 'features/subscribers/SubscriberDetailPage.tsx', label: 'Subscriber detail', reads: ['/api/subscribers/{imsi}'], ux: ['view/edit modes', 'provisioning state', 'traffic snapshot'] },

  '/system-health': { class: 'primary', family: 'System health', owner: 'features/system-health/SystemHealthPage.tsx', label: 'System health', reads: ['/api/system/health', '/api/system/audit/status'], ux: ['subsystem status', 'audit freshness'] },
  '/system/retention': { class: 'primary', family: 'System health', owner: 'features/retention/RetentionPage.tsx', label: 'OCS retention', reads: ['/api/system/retention/ocs'], ux: ['candidate table', 'dry-run confirmation', 'permission-gated'] },

  '/users': { class: 'primary', family: 'Users and roles', owner: 'features/users/UsersPage.tsx', label: 'Users', reads: ['/api/users'], ux: ['sortable table', 'bulk actions', 'drawer', 'permission-gated'] },
  '/users/:username': { class: 'detail', family: 'Users and roles', owner: 'features/users/UserDetailPage.tsx', label: 'User detail', reads: ['/api/users/{username}'], ux: ['basic info', 'security history', 'role change', 'permission-gated'] },
  '/users/create': { class: 'form', family: 'Users and roles', owner: 'features/users/UserCreatePage.tsx', label: 'Create user', reads: ['/api/users'], ux: ['password policy', 'role selection', 'permission-gated'] },

  '/knowledge': { class: 'primary', family: 'Knowledge', owner: 'features/knowledge/KnowledgePage.tsx', label: 'Knowledge', reads: ['/api/knowledge/entries', '/api/knowledge/meta'], ux: ['entry table', 'tag filter', 'markdown preview'] },
  '/knowledge/new': { class: 'form', family: 'Knowledge', owner: 'features/knowledge/KnowledgeEditorPage.tsx', label: 'Create entry', reads: ['/api/knowledge/meta'], ux: ['markdown editor', 'character counters', 'dirty state'] },
  '/knowledge/:entryId': { class: 'detail', family: 'Knowledge', owner: 'features/knowledge/KnowledgeDetailPage.tsx', label: 'Entry detail', reads: ['/api/knowledge/entries/{entryId}'], ux: ['markdown content', 'copy action', 'version list'] },
  '/knowledge/:entryId/edit': { class: 'form', family: 'Knowledge', owner: 'features/knowledge/KnowledgeEditorPage.tsx', label: 'Edit entry', reads: ['/api/knowledge/entries/{entryId}'], ux: ['markdown editor', 'dirty state', 'unsaved-change guard'] },

  '/agents': { class: 'primary', family: 'Agents', owner: 'features/agents/AgentsPage.tsx', label: 'Agents', reads: ['/api/agents'], ux: ['agent table', 'status badge', 'refresh'] },
  '/agents/:agentId': { class: 'detail', family: 'Agents', owner: 'features/agents/AgentsPage.tsx', label: 'Agent detail', reads: ['/api/agents/{agentId}'], ux: ['agent evidence', 'capability list'] },

  '/config-snapshots': { class: 'primary', family: 'Configuration snapshots', owner: 'features/config-snapshots/ConfigSnapshotsPage.tsx', label: 'Configuration snapshots', reads: ['/api/config-snapshots/sources', '/api/config-snapshots/meta'], ux: ['source table', 'drift integration'] },
  '/config-snapshots/:sourceId': { class: 'detail', family: 'Configuration snapshots', owner: 'features/config-snapshots/ConfigSnapshotsPage.tsx', label: 'Snapshot source detail', reads: ['/api/config-snapshots/sources/{sourceId}', '/api/config-snapshots/sources/{sourceId}/snapshots', '/api/config-snapshots/sources/{sourceId}/diff'], ux: ['snapshot list', 'diff view', 'drift panel'] },

  '/ops-reports': { class: 'primary', family: 'Operational reports', owner: 'features/ops-reports/OperationsReportsPage.tsx', label: 'Operational reports', reads: ['/api/ops-reports/summary', '/api/ops-reports/metrics', '/api/ops-reports/alerts'], ux: ['report summary', 'chart alternative table', 'export'] },

  '/ims-registrations': { class: 'primary', family: 'IMS registrations', owner: 'features/ims-registration/IMSRegistrationsPage.tsx', label: 'IMS registrations', reads: ['/api/ims/registrations', '/api/ims/registrations/summary'], ux: ['registration table', 'scope filter', 'consistency state'] },

  '/investigations': { class: 'primary', family: 'Investigations', owner: 'features/investigations/InvestigationsPage.tsx', label: 'Investigations', reads: ['/api/investigations', '/api/investigations/context'], ux: ['investigation table', 'evidence panel', 'filter toolbar'] },
  '/investigations/:investigationId': { class: 'detail', family: 'Investigations', owner: 'features/investigations/InvestigationsPage.tsx', label: 'Investigation detail', reads: ['/api/investigations/{investigationId}'], ux: ['evidence timeline', 'scope summary'] },

  '/inspections': { class: 'primary', family: 'Inspections', owner: 'features/inspections/InspectionsPages.tsx', label: 'Inspections', reads: ['/api/inspection-plans', '/api/inspection-runs', '/api/inspections/meta'], ux: ['plan table', 'run table', 'status badge'] },
  '/inspections/new': { class: 'form', family: 'Inspections', owner: 'features/inspections/InspectionsPages.tsx', label: 'New inspection', reads: ['/api/inspections/meta'], ux: ['labeled fields', 'scope selection', 'validation'] },
  '/inspections/plans/:planId': { class: 'detail', family: 'Inspections', owner: 'features/inspections/InspectionsPages.tsx', label: 'Inspection plan detail', reads: ['/api/inspection-plans/{planId}'], ux: ['plan definition', 'run history'] },
  '/inspections/runs/:runId': { class: 'detail', family: 'Inspections', owner: 'features/inspections/InspectionsPages.tsx', label: 'Inspection run detail', reads: ['/api/inspection-runs/{runId}', '/api/inspection-runs/{runId}/items'], ux: ['run status', 'evidence items', 'export'] },
};

/**
 * The fixture identity used for each dynamic route parameter.
 *
 * A parameter name can mean different things in different families: `planId`
 * is an OCS tariff plan on /ocs/tariffs/:planId and an inspection plan on
 * /inspections/plans/:planId. The identity therefore resolves per route.
 */
const PARAMETER_IDENTITIES = {
  imsi: ROUTE_IDENTITIES.imsi,
  msisdn: ROUTE_IDENTITIES.msisdn,
  resourceId: ROUTE_IDENTITIES.resourceId,
  sourceId: ROUTE_IDENTITIES.sourceId,
  targetId: ROUTE_IDENTITIES.targetId,
  planId: ROUTE_IDENTITIES.planId,
  name: ROUTE_IDENTITIES.profileName,
  username: ROUTE_IDENTITIES.username,
  entryId: ROUTE_IDENTITIES.entryId,
  agentId: ROUTE_IDENTITIES.agentId,
  investigationId: ROUTE_IDENTITIES.investigationId,
  runId: ROUTE_IDENTITIES.inspectionRunId,
};

/** Per-route overrides for a parameter whose meaning is family specific. */
const ROUTE_PARAMETER_IDENTITIES = {
  '/ocs/tariffs/:planId': { planId: ROUTE_IDENTITIES.planId },
  '/inspections/plans/:planId': { planId: ROUTE_IDENTITIES.inspectionPlanId },
  '/inspections/runs/:runId': { runId: ROUTE_IDENTITIES.inspectionRunId },
  '/config-snapshots/:sourceId': { sourceId: ROUTE_IDENTITIES.configSnapshotSourceId },
  '/discovery/sources/:sourceId': { sourceId: ROUTE_IDENTITIES.sourceId },
  '/nf-health/:targetId': { targetId: ROUTE_IDENTITIES.targetId },
  '/topology/:resourceId': { resourceId: ROUTE_IDENTITIES.topologyResourceId },
  '/inventory/:resourceId': { resourceId: ROUTE_IDENTITIES.resourceId },
  '/profile/:name': { name: ROUTE_IDENTITIES.profileName },
};

/** Resolve the fixture identity for one parameter of one route. */
function identityFor(route, parameter) {
  const override = ROUTE_PARAMETER_IDENTITIES[route]?.[parameter];
  if (override) return override;
  const identity = PARAMETER_IDENTITIES[parameter];
  if (!identity) throw new Error(`no fixture identity for dynamic parameter "${parameter}"`);
  return identity;
}

/** Routes whose access is gated by the users.read permission. */
export const PERMISSION_GATED_ROUTES = [
  '/users',
  '/users/:username',
  '/users/create',
  '/system/retention',
];

/**
 * Resolve a contract route to a concrete URL with deterministic identities.
 *
 * Accepts either a route pattern (`/subscribers/:imsi`) or a contract entry.
 */
export function concreteUrl(route) {
  const pattern = typeof route === 'string' ? route : route.route;
  return pattern.replace(/:([A-Za-z]+)/g, (_match, parameter) => {
    return encodeURIComponent(identityFor(pattern, parameter));
  });
}

/**
 * The URL a route is expected to land on.
 *
 * A dynamic route keeps its own concrete URL: the identity is part of the
 * route, so the resolved path must still contain it. A compatibility alias
 * lands on the destination the redirect authority declares.
 */
export function expectedPath(route) {
  const pattern = typeof route === 'string' ? route : route.route;
  const redirect = COMPATIBILITY_REDIRECTS[pattern];
  if (redirect) return redirect;
  return concreteUrl(pattern);
}

/**
 * The full route inventory.
 *
 * Every contract entry is classified. The list length must equal the contract
 * length: a missing entry means the contract grew without an audit row.
 */
export const ROUTE_INVENTORY = ROUTE_CONTRACT.map((entry) => {
  const metadata = ROUTE_METADATA[entry.route];
  if (!metadata) throw new Error(`route "${entry.route}" has no FE-C3 review metadata`);
  const redirect = COMPATIBILITY_REDIRECTS[entry.route];
  const gated = PERMISSION_GATED_ROUTES.includes(entry.route);
  return {
    route: entry.route,
    dynamicParameters: entry.dynamicParameters ?? [],
    /*
     * The classification is the FE-C3 route class. A permission-gated route is
     * classified `conditional` because its access behaviour, not its surface,
     * is what the audit has to prove; `surface` keeps the underlying page type.
     */
    classification: redirect ? 'redirect' : gated ? 'conditional' : metadata.class,
    surface: metadata.class,
    family: metadata.family,
    owner: metadata.owner,
    label: metadata.label,
    requiredData: metadata.reads,
    fixtureIdentity: entry.dynamicParameters?.length
      ? entry.dynamicParameters.map((parameter) => `${parameter}=${identityFor(entry.route, parameter)}`).join(', ')
      : 'n/a (static route)',
    accessBehavior: gated
      ? 'admin only (users.read); navigation hidden for other roles'
      : redirect
        ? `always redirects to ${redirect}`
        : 'all authenticated roles',
    uxFeatures: metadata.ux,
    expectedDestination: redirect ?? concreteUrl(entry.route),
  };
});

/** Route families represented in the inventory, in first-seen order. */
export const ROUTE_FAMILIES = [...new Set(ROUTE_INVENTORY.map((entry) => entry.family))];
