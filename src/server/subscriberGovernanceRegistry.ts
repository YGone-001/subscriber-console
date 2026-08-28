import type { Permission } from '@/lib/permissions';
import type { ApprovalAction } from '@/server/repositories/approvalRepository';
import type { RiskLevel } from '@/types/governance';

/** The authoritative subscriber mutation catalog.  HTTP routes use this before
 * they create a change or mutate state; the execution layer uses the same list
 * to make a missing executor a startup/test failure instead of a user-visible
 * approval dead end. */
export const SUBSCRIBER_OPERATIONS = {
  CREATE: 'SUBSCRIBER_CREATE',
  UPDATE: 'SUBSCRIBER_UPDATE',
  DELETE: 'SUBSCRIBER_DELETE',
  BATCH_CREATE: 'SUBSCRIBER_BATCH_CREATE',
  BATCH_UPDATE: 'SUBSCRIBER_BATCH_UPDATE',
  BULK_DELETE: 'SUBSCRIBER_BULK_DELETE',
  IMPORT: 'SUBSCRIBER_IMPORT',
  IMPORT_OVERWRITE: 'SUBSCRIBER_IMPORT_OVERWRITE',
} as const;

export type SubscriberOperation = typeof SUBSCRIBER_OPERATIONS[keyof typeof SUBSCRIBER_OPERATIONS];
export type SubscriberOperationDefinition = {
  action: SubscriberOperation;
  permission: Permission;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  requiresIndependentReviewer: boolean;
  executionMode: 'automatic' | 'manual';
  snapshotStrategy: 'none' | 'single-state' | 'batch-precondition' | 'normalized-import';
};

export const subscriberOperationRegistry: Readonly<Record<SubscriberOperation, SubscriberOperationDefinition>> = {
  SUBSCRIBER_CREATE: { action: 'SUBSCRIBER_CREATE', permission: 'subscribers.write', riskLevel: 'medium', requiresApproval: false, requiresIndependentReviewer: false, executionMode: 'automatic', snapshotStrategy: 'none' },
  SUBSCRIBER_UPDATE: { action: 'SUBSCRIBER_UPDATE', permission: 'subscribers.write', riskLevel: 'high', requiresApproval: true, requiresIndependentReviewer: true, executionMode: 'automatic', snapshotStrategy: 'single-state' },
  SUBSCRIBER_DELETE: { action: 'SUBSCRIBER_DELETE', permission: 'subscribers.write', riskLevel: 'high', requiresApproval: true, requiresIndependentReviewer: true, executionMode: 'automatic', snapshotStrategy: 'single-state' },
  SUBSCRIBER_BATCH_CREATE: { action: 'SUBSCRIBER_BATCH_CREATE', permission: 'subscribers.write', riskLevel: 'high', requiresApproval: true, requiresIndependentReviewer: true, executionMode: 'automatic', snapshotStrategy: 'batch-precondition' },
  SUBSCRIBER_BATCH_UPDATE: { action: 'SUBSCRIBER_BATCH_UPDATE', permission: 'subscribers.write', riskLevel: 'high', requiresApproval: true, requiresIndependentReviewer: true, executionMode: 'automatic', snapshotStrategy: 'batch-precondition' },
  SUBSCRIBER_BULK_DELETE: { action: 'SUBSCRIBER_BULK_DELETE', permission: 'subscribers.write', riskLevel: 'critical', requiresApproval: true, requiresIndependentReviewer: true, executionMode: 'automatic', snapshotStrategy: 'batch-precondition' },
  SUBSCRIBER_IMPORT: { action: 'SUBSCRIBER_IMPORT', permission: 'subscribers.write', riskLevel: 'high', requiresApproval: true, requiresIndependentReviewer: true, executionMode: 'automatic', snapshotStrategy: 'normalized-import' },
  SUBSCRIBER_IMPORT_OVERWRITE: { action: 'SUBSCRIBER_IMPORT_OVERWRITE', permission: 'subscribers.write', riskLevel: 'critical', requiresApproval: true, requiresIndependentReviewer: true, executionMode: 'automatic', snapshotStrategy: 'normalized-import' },
};

export function evaluateSubscriberOperation(operation: SubscriberOperation) {
  return { allowed: true, ...subscriberOperationRegistry[operation], operation, executable: !subscriberOperationRegistry[operation].requiresApproval || subscriberOperationRegistry[operation].executionMode === 'automatic' };
}

export const governedSubscriberApprovalActions = Object.values(subscriberOperationRegistry)
  .filter((definition) => definition.requiresApproval && definition.executionMode === 'automatic')
  .map((definition) => definition.action) as ApprovalAction[];

export function assertGovernedOperationCoverage(executableActions: readonly string[]) {
  const available = new Set(executableActions);
  const missing = governedSubscriberApprovalActions.filter((action) => !available.has(action));
  if (missing.length > 0) throw new Error(`GOVERNED_OPERATION_EXECUTOR_MISSING:${missing.join(',')}`);
}
