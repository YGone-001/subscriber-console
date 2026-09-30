import { Document } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';

/**
 * Minimal read-only account snapshot required by proxy session validation.
 *
 * This is the only surviving Next.js runtime MongoDB access path. It must never
 * grow business-write capabilities: proxy authentication revalidates the JWT
 * principal against xcloud_ops.app_users on every protected request.
 */
export type SessionAccountDocument = {
  _id?: unknown;
  username: string;
  role: string;
  status?: string;
  locked?: boolean;
  security?: { sessionVersion?: number };
};

const SESSION_ACCOUNT_PROJECTION = {
  username: 1,
  role: 1,
  status: 1,
  locked: 1,
  'security.sessionVersion': 1,
} as const;

/** Read the session-validation account snapshot. Read-only: findOne with projection. */
export async function getSessionAccount(username: string): Promise<SessionAccountDocument | null> {
  const collection = await getAppCollection<SessionAccountDocument & Document>(mongoCollections.users);
  return collection.findOne({ username }, { projection: SESSION_ACCOUNT_PROJECTION });
}
