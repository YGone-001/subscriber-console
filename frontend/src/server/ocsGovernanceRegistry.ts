import type { Permission } from '@/lib/permissions';
import type { RiskLevel } from '@/types/governance';

/**
 * Canonical classification of every human-triggered OCS write. Runtime charging
 * writers are deliberately represented here too: they never enter approval and
 * are not callable from an administrative HTTP route.
 */
export const OCS_OPERATIONS = {
  BALANCE_ADJUST: 'OCS_BALANCE_ADJUST',
  BALANCE_RESET: 'OCS_BALANCE_RESET',
  TARIFF_PLAN_CREATE: 'OCS_TARIFF_PLAN_CREATE',
  TARIFF_PLAN_UPDATE: 'OCS_TARIFF_PLAN_UPDATE',
  TARIFF_PLAN_DELETE: 'OCS_TARIFF_PLAN_DELETE',
  TARIFF_RULE_CREATE: 'OCS_TARIFF_RULE_CREATE',
  TARIFF_RULE_UPDATE: 'OCS_TARIFF_RULE_UPDATE',
  TARIFF_RULE_DELETE: 'OCS_TARIFF_RULE_DELETE',
  TARIFF_RULE_TOGGLE: 'OCS_TARIFF_RULE_TOGGLE',
  PLAN_ASSIGN: 'OCS_PLAN_ASSIGN',
  PLAN_MIGRATE: 'OCS_PLAN_MIGRATE',
  RATING_CREATE: 'OCS_RATING_CREATE',
  RATING_UPDATE: 'OCS_RATING_UPDATE',
  RATING_DELETE: 'OCS_RATING_DELETE',
  RUNTIME_RESERVE: 'OCS_RUNTIME_RESERVE',
  RUNTIME_CONSUME: 'OCS_RUNTIME_CONSUME',
  RUNTIME_RELEASE: 'OCS_RUNTIME_RELEASE',
  RUNTIME_USAGE: 'OCS_RUNTIME_USAGE',
} as const;

export type OcsOperation = typeof OCS_OPERATIONS[keyof typeof OCS_OPERATIONS];
export type OcsExecutionClass = 'administrative' | 'runtime';
export type OcsGovernanceMode = 'RUNTIME_INTERNAL' | 'DIRECT_GOVERNED' | 'DISABLED';

export type OcsOperationDefinition = {
  operation: OcsOperation;
  permission: Permission;
  riskLevel: RiskLevel;
  governanceMode: OcsGovernanceMode;
  executionClass: OcsExecutionClass;
  humanExecutable: boolean;
  executionMode: 'automatic' | 'manual' | 'none';
  disabledCode?: string;
  snapshotStrategy: 'none' | 'balance-version' | 'resource-version' | 'migration-precondition';
};

const admin = (operation: OcsOperation, permission: Permission, riskLevel: RiskLevel, snapshotStrategy: OcsOperationDefinition['snapshotStrategy']): OcsOperationDefinition => ({
  operation, permission, riskLevel, snapshotStrategy,
  governanceMode: 'DIRECT_GOVERNED', executionClass: 'administrative',
  humanExecutable: true, executionMode: 'automatic',
});

const runtime = (operation: OcsOperation): OcsOperationDefinition => ({
  operation, permission: 'ocs.runtime.execute', riskLevel: 'high', snapshotStrategy: 'none',
  governanceMode: 'RUNTIME_INTERNAL', executionClass: 'runtime',
  humanExecutable: false, executionMode: 'none',
});

const disabled = (definition: OcsOperationDefinition, disabledCode: string): OcsOperationDefinition => ({
  ...definition, governanceMode: 'DISABLED', humanExecutable: false, executionMode: 'none', disabledCode,
});

export const ocsOperationRegistry: Readonly<Record<OcsOperation, OcsOperationDefinition>> = {
  OCS_BALANCE_ADJUST: admin(OCS_OPERATIONS.BALANCE_ADJUST, 'ocs.balance.adjust', 'high', 'balance-version'),
  OCS_BALANCE_RESET: disabled(admin(OCS_OPERATIONS.BALANCE_RESET, 'ocs.balance.reset', 'critical', 'balance-version'), 'OCS_BALANCE_RESET_NOT_SUPPORTED'),
  OCS_TARIFF_PLAN_CREATE: disabled(admin(OCS_OPERATIONS.TARIFF_PLAN_CREATE, 'ocs.tariff.write', 'high', 'none'), 'OCS_TARIFF_CREATE_NOT_SUPPORTED'),
  OCS_TARIFF_PLAN_UPDATE: disabled(admin(OCS_OPERATIONS.TARIFF_PLAN_UPDATE, 'ocs.tariff.write', 'high', 'resource-version'), 'OCS_TARIFF_UPDATE_NOT_SUPPORTED'),
  OCS_TARIFF_PLAN_DELETE: disabled(admin(OCS_OPERATIONS.TARIFF_PLAN_DELETE, 'ocs.tariff.write', 'critical', 'resource-version'), 'OCS_TARIFF_DELETE_NOT_SUPPORTED'),
  OCS_TARIFF_RULE_CREATE: disabled(admin(OCS_OPERATIONS.TARIFF_RULE_CREATE, 'ocs.tariff.write', 'high', 'resource-version'), 'OCS_TARIFF_RULE_CREATE_NOT_SUPPORTED'),
  OCS_TARIFF_RULE_UPDATE: disabled(admin(OCS_OPERATIONS.TARIFF_RULE_UPDATE, 'ocs.tariff.write', 'high', 'resource-version'), 'OCS_TARIFF_RULE_UPDATE_NOT_SUPPORTED'),
  OCS_TARIFF_RULE_DELETE: disabled(admin(OCS_OPERATIONS.TARIFF_RULE_DELETE, 'ocs.tariff.write', 'critical', 'resource-version'), 'OCS_TARIFF_RULE_DELETE_NOT_SUPPORTED'),
  OCS_TARIFF_RULE_TOGGLE: disabled(admin(OCS_OPERATIONS.TARIFF_RULE_TOGGLE, 'ocs.tariff.write', 'high', 'resource-version'), 'OCS_TARIFF_RULE_TOGGLE_NOT_SUPPORTED'),
  OCS_PLAN_ASSIGN: disabled(admin(OCS_OPERATIONS.PLAN_ASSIGN, 'ocs.plan.assign', 'high', 'migration-precondition'), 'OCS_PLAN_ASSIGN_NOT_SUPPORTED'),
  OCS_PLAN_MIGRATE: disabled(admin(OCS_OPERATIONS.PLAN_MIGRATE, 'ocs.plan.assign', 'critical', 'migration-precondition'), 'OCS_PLAN_MIGRATION_NOT_SUPPORTED'),
  OCS_RATING_CREATE: disabled(admin(OCS_OPERATIONS.RATING_CREATE, 'ocs.rating.write', 'high', 'none'), 'OCS_RATING_CREATE_NOT_SUPPORTED'),
  OCS_RATING_UPDATE: disabled(admin(OCS_OPERATIONS.RATING_UPDATE, 'ocs.rating.write', 'high', 'resource-version'), 'OCS_RATING_UPDATE_NOT_SUPPORTED'),
  OCS_RATING_DELETE: disabled(admin(OCS_OPERATIONS.RATING_DELETE, 'ocs.rating.write', 'critical', 'resource-version'), 'OCS_RATING_DELETE_NOT_SUPPORTED'),
  OCS_RUNTIME_RESERVE: runtime(OCS_OPERATIONS.RUNTIME_RESERVE),
  OCS_RUNTIME_CONSUME: runtime(OCS_OPERATIONS.RUNTIME_CONSUME),
  OCS_RUNTIME_RELEASE: runtime(OCS_OPERATIONS.RUNTIME_RELEASE),
  OCS_RUNTIME_USAGE: runtime(OCS_OPERATIONS.RUNTIME_USAGE),
};

export function evaluateOcsOperation(operation: OcsOperation) {
  const definition = ocsOperationRegistry[operation];
  return { ...definition, executable: definition.governanceMode !== 'DISABLED' && (definition.executionClass === 'runtime' || definition.humanExecutable) };
}
