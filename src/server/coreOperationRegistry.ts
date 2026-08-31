import type { Permission } from '@/lib/permissions';
import type { RiskLevel } from '@/types/governance';

/**
 * Phase 8 authority for human-triggered core-network operational actions.
 *
 * The current repository has no managed NF runtime target and no trusted
 * restart/reload/heal executor. Keep both registries intentionally empty:
 * inventing an SSH, shell, or service-control path would create an unsafe
 * capability rather than govern an existing one.
 */
export type CoreOperationGovernanceMode =
  | 'DIRECT_GOVERNED'
  | 'APPROVAL_GOVERNED'
  | 'RUNTIME_INTERNAL'
  | 'DISABLED';

export type CoreOperationDefinition = {
  operation: string;
  targetType: string;
  governanceMode: CoreOperationGovernanceMode;
  executionMode: 'automatic' | 'none';
  riskLevel: RiskLevel;
  permission: Permission;
  requiresIndependentReviewer: boolean;
  requiresMaintenanceWindow: boolean;
  executorId?: string;
  disabledCode?: string;
};

export type ManagedCoreTarget = {
  id: string;
  type: string;
  displayName: string;
  operations: readonly string[];
  executorBinding?: string;
};

/**
 * Do not add AMF/SMF/UPF/IMS names here merely because they are common
 * network functions. A target may be registered only after this console has
 * an existing, server-owned, trusted binding to that real managed instance.
 */
export const coreManagedTargetRegistry: readonly ManagedCoreTarget[] = [];

/**
 * No current operational HTTP write has a production NF executor. Future
 * definitions must be entered here before routes, policy, executor, or UI
 * expose them.
 */
export const coreOperationRegistry: readonly CoreOperationDefinition[] = [];

export function getManagedCoreTarget(targetId: unknown): ManagedCoreTarget | undefined {
  return typeof targetId === 'string'
    ? coreManagedTargetRegistry.find((target) => target.id === targetId)
    : undefined;
}

export function getCoreOperationDefinition(operation: unknown): CoreOperationDefinition | undefined {
  return typeof operation === 'string'
    ? coreOperationRegistry.find((definition) => definition.operation === operation)
    : undefined;
}

/**
 * An automatic approval operation is valid only when a production executor
 * was registered by server-owned code. This makes a missing executor a
 * startup/test failure instead of an approval that can never safely run.
 */
export function assertCoreOperationCoverage(
  executorIds: readonly string[],
  definitions: readonly CoreOperationDefinition[] = coreOperationRegistry,
) {
  const available = new Set(executorIds);
  const missing = definitions
    .filter((definition) => definition.governanceMode === 'APPROVAL_GOVERNED' && definition.executionMode === 'automatic')
    .filter((definition) => !definition.executorId || !available.has(definition.executorId))
    .map((definition) => definition.operation);

  if (missing.length > 0) {
    throw new Error(`CORE_OPERATION_EXECUTOR_MISSING:${missing.join(',')}`);
  }
}

/** Explicit Phase 8.5 readiness signal: there is no production core executor yet. */
export const automaticCoreOperationExecutorIds: readonly string[] = [];

export function assertCoreOperationExecutorCoverage() {
  assertCoreOperationCoverage(automaticCoreOperationExecutorIds);
}

assertCoreOperationExecutorCoverage();
