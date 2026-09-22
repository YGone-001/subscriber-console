import type { Permission } from '@/lib/permissions';
import type { RiskLevel } from '@/types/governance';

/** The authoritative subscriber mutation catalog used by direct write routes. */
export const SUBSCRIBER_OPERATIONS = {
  CREATE: 'SUBSCRIBER_CREATE',
  UPDATE: 'SUBSCRIBER_UPDATE',
  DELETE: 'SUBSCRIBER_DELETE',
  BATCH_CREATE: 'SUBSCRIBER_BATCH_CREATE',
  BATCH_UPDATE: 'SUBSCRIBER_BATCH_UPDATE',
  BULK_DELETE: 'SUBSCRIBER_BULK_DELETE',
  IMPORT: 'SUBSCRIBER_IMPORT',
  PROFILE_APPLY: 'SUBSCRIBER_PROFILE_APPLY',
} as const;

export type SubscriberOperation = typeof SUBSCRIBER_OPERATIONS[keyof typeof SUBSCRIBER_OPERATIONS];
export type SubscriberOperationDefinition = {
  action: SubscriberOperation;
  permission: Permission;
  riskLevel: RiskLevel;
  executionMode: 'automatic' | 'manual';
  snapshotStrategy: 'none' | 'single-state' | 'batch-precondition' | 'normalized-import';
};

export const subscriberOperationRegistry: Readonly<Record<SubscriberOperation, SubscriberOperationDefinition>> = {
  SUBSCRIBER_CREATE: { action: 'SUBSCRIBER_CREATE', permission: 'subscribers.write', riskLevel: 'medium', executionMode: 'automatic', snapshotStrategy: 'none' },
  SUBSCRIBER_UPDATE: { action: 'SUBSCRIBER_UPDATE', permission: 'subscribers.write', riskLevel: 'high', executionMode: 'automatic', snapshotStrategy: 'single-state' },
  SUBSCRIBER_DELETE: { action: 'SUBSCRIBER_DELETE', permission: 'subscribers.write', riskLevel: 'high', executionMode: 'automatic', snapshotStrategy: 'single-state' },
  SUBSCRIBER_BATCH_CREATE: { action: 'SUBSCRIBER_BATCH_CREATE', permission: 'subscribers.write', riskLevel: 'high', executionMode: 'automatic', snapshotStrategy: 'batch-precondition' },
  SUBSCRIBER_BATCH_UPDATE: { action: 'SUBSCRIBER_BATCH_UPDATE', permission: 'subscribers.write', riskLevel: 'high', executionMode: 'automatic', snapshotStrategy: 'batch-precondition' },
  SUBSCRIBER_BULK_DELETE: { action: 'SUBSCRIBER_BULK_DELETE', permission: 'subscribers.write', riskLevel: 'critical', executionMode: 'automatic', snapshotStrategy: 'batch-precondition' },
  SUBSCRIBER_IMPORT: { action: 'SUBSCRIBER_IMPORT', permission: 'subscribers.write', riskLevel: 'high', executionMode: 'automatic', snapshotStrategy: 'normalized-import' },
  SUBSCRIBER_PROFILE_APPLY: { action: 'SUBSCRIBER_PROFILE_APPLY', permission: 'subscribers.write', riskLevel: 'high', executionMode: 'automatic', snapshotStrategy: 'single-state' },
};

export function evaluateSubscriberOperation(operation: SubscriberOperation) {
  return { allowed: true, ...subscriberOperationRegistry[operation], operation, executable: true };
}

/** Actor-aware governance evaluation.
 * In Phase 5.7-C direct operation model, all valid operations execute directly.
 */
export function evaluateSubscriberOperationForActor(operation: SubscriberOperation, _role: string) {
	void _role;
  const base = subscriberOperationRegistry[operation];
  return {
    allowed: true,
    ...base,
    operation,
    governanceMode: 'DIRECT_GOVERNED' as const,
    executable: true,
  };
}
