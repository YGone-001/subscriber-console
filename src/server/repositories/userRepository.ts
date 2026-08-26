import { Document, MongoServerError } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';
import type { SysUser } from '@/types/iam';

export type UserDocument = Pick<SysUser, 'username' | 'role' | 'status' | 'createdAt' | 'createdBy' | 'displayName' | 'email' | 'security' | 'updatedAt' | 'locked'> & {
  passwordHash: string;
};

export type SafeUserDocument = Omit<UserDocument, 'passwordHash'>;

function collection() {
  return getAppCollection<UserDocument & Document>(mongoCollections.users);
}

function stripPassword(user: UserDocument & Record<string, unknown>): SafeUserDocument {
  const { passwordHash, _id, ...safeUser } = user;
  void passwordHash;
  void _id;
  return safeUser;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export async function listUsers() {
  const docs = await collection();
  const users = await docs.find({}).sort({ username: 1 }).toArray();
  return users.map(stripPassword);
}

export async function getUser(username: string) {
  const docs = await collection();
  return docs.findOne({ username });
}

export async function getSafeUser(username: string) {
  const user = await getUser(username);
  return user ? stripPassword(user) : null;
}

export async function createUser(user: UserDocument) {
  const docs = await collection();
  try {
    await docs.insertOne(user);
    return user;
  } catch (error) {
    if (isDuplicateKey(error)) throw new Error('USER_EXISTS');
    throw error;
  }
}

export async function ensureUser(user: UserDocument) {
  const docs = await collection();
  await docs.updateOne({ username: user.username }, { $setOnInsert: user }, { upsert: true });
  return user;
}

export async function updateUser(username: string, updates: Partial<UserDocument>) {
  const docs = await collection();
  const existing = await docs.findOne({ username });
  if (!existing) return null;

  const { security, ...fields } = updates;
  const changes: Record<string, unknown> = { ...fields, username, updatedAt: new Date().toISOString() };
  for (const [key, value] of Object.entries(security || {})) {
    if (key !== 'sessionVersion') changes[`security.${key}`] = value;
  }
  const revoke = updates.role !== undefined || updates.status !== undefined || updates.passwordHash !== undefined || security !== undefined || updates.locked !== undefined;
  const next = await docs.findOneAndUpdate({ username }, {
    $set: changes,
    ...(revoke ? { $inc: { 'security.sessionVersion': 1 } } : {}),
  }, { returnDocument: 'after' });
  if (!next) return null;
  return { existing, next };
}

export async function recordFailedLogin(username: string) {
  const docs = await collection();
  await docs.updateOne({ username }, { $inc: { 'security.failedLoginAttempts': 1 } });
}

export async function recordSuccessfulLogin(user: UserDocument, ip: string) {
  const docs = await collection();
  // Do not issue a fresh session if the account changed during bcrypt verification.
  return docs.findOneAndUpdate({
    username: user.username, passwordHash: user.passwordHash, role: user.role, status: 'active', locked: { $ne: true },
    $expr: { $eq: [{ $ifNull: ['$security.sessionVersion', 0] }, user.security?.sessionVersion ?? 0] },
  }, { $set: { 'security.lastLoginAt': new Date().toISOString(), 'security.lastLoginIp': ip, 'security.failedLoginAttempts': 0 } }, { returnDocument: 'after' });
}

export function safeUser(user: UserDocument & Record<string, unknown>): SafeUserDocument {
  return stripPassword(user);
}
