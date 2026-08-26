import { randomUUID } from 'node:crypto';
import { MongoServerError } from 'mongodb';
import { getAppCollection } from '@/lib/mongo';
import { UserManagementError } from '@/lib/userManagementPolicy';

type LifecycleLock = { _id: string; owner: string; acquiredAt: string };

/** Standalone-safe DB mutex: no TTL, lease expiry, or process-local ownership.
 * Unknown I/O failures retain the lock because a write may have committed.
 * Recovery requires quiescing writers and inspecting the invariant; see runbook.
 */
export async function withUserManagementLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = await getAppCollection<LifecycleLock>('system_governance_state');
  const owner = randomUUID();
  try {
    await locks.insertOne({ _id: 'user-lifecycle', owner, acquiredAt: new Date().toISOString() }, { writeConcern: { w: 'majority' } });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) throw new UserManagementError('USER_MANAGEMENT_BUSY', 503);
    throw error;
  }
  let safeToRelease = false;
  try {
    const result = await operation();
    safeToRelease = true;
    return result;
  } catch (error) {
    // These errors are raised before writes. Never auto-release on an ambiguous DB outcome.
    safeToRelease = error instanceof UserManagementError;
    throw error;
  } finally {
    if (safeToRelease) await locks.deleteOne({ _id: 'user-lifecycle', owner }, { writeConcern: { w: 'majority' } });
  }
}
