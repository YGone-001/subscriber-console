import { Document, MongoServerError, type Filter } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';
import type { SysUser } from '@/types/iam';
import { isSuperAdmin } from '@/lib/permissions';
import { UserManagementError } from '@/lib/userManagementPolicy';
import { withUserManagementLock } from '@/server/userManagementLock';
import { escapeUserSearch, USER_SORT_FIELDS, type UserQuery } from '@/lib/userQuery';

export type UserDocument = Pick<SysUser, 'username' | 'role' | 'status' | 'createdAt' | 'createdBy' | 'displayName' | 'email' | 'security' | 'updatedAt' | 'locked'> & {
  passwordHash: string;
};

export type SafeUserDocument = Omit<UserDocument, 'passwordHash'>;

function collection() {
  return getAppCollection<UserDocument & Document>(mongoCollections.users);
}

function stripPassword(user: UserDocument & Record<string, unknown>): SafeUserDocument {
  return { username: user.username, displayName: user.displayName, email: user.email, role: user.role,
    status: user.status, createdAt: user.createdAt, createdBy: user.createdBy, updatedAt: user.updatedAt,
    security: user.security, locked: user.locked };
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

export async function createUser(user: UserDocument, authorize?: () => Promise<void>) {
  return withUserManagementLock(async () => {
  const docs = await collection();
  if (authorize) await authorize();
  try {
    await docs.insertOne(user, { writeConcern: { w: 'majority' } });
    return user;
  } catch (error) {
    if (isDuplicateKey(error)) throw new UserManagementError('USER_EXISTS', 409);
    throw error;
  }
  });
}

export async function ensureUser(user: UserDocument) {
  const docs = await collection();
  await docs.updateOne({ username: user.username }, { $setOnInsert: user }, { upsert: true });
  return user;
}

export async function updateUser(username: string, updates: Partial<UserDocument>, authorize?: (existing: UserDocument) => Promise<void>) {
  return withUserManagementLock(async () => {
  const docs = await collection();
  const existing = await docs.findOne({ username });
  if (!existing) return null;
  if (authorize) await authorize(existing);

  const nextState = { ...existing, ...updates };
  if (isSuperAdmin(existing.role) && existing.status === 'active' && !existing.locked &&
      (!isSuperAdmin(nextState.role) || nextState.status !== 'active' || nextState.locked)) {
    const activeAdmins = await docs.countDocuments({ role: { $in: ['root', 'super_admin'] }, status: 'active', locked: { $ne: true } });
    if (activeAdmins <= 1) throw new UserManagementError('LAST_ACTIVE_ADMIN', 409);
  }

  const { security, ...fields } = updates;
  const changes: Record<string, unknown> = { ...fields, username, updatedAt: new Date().toISOString() };
  if (updates.passwordHash !== undefined) changes['security.passwordChangedAt'] = new Date().toISOString();
  for (const [key, value] of Object.entries(security || {})) {
    if (key !== 'sessionVersion') changes[`security.${key}`] = value;
  }
  const revoke = updates.role !== undefined || updates.status !== undefined || updates.passwordHash !== undefined || security !== undefined || updates.locked !== undefined;
  const next = await docs.findOneAndUpdate({ username }, {
    $set: changes,
    ...(updates.status !== undefined && updates.status !== 'locked' ? { $unset: { 'security.lockedAt': '', 'security.lockReason': '' } as const } : {}),
    ...(revoke ? { $inc: { 'security.sessionVersion': 1 } } : {}),
  }, { returnDocument: 'after', writeConcern: { w: 'majority' } });
  if (!next) return null;
  return { existing, next };
  });
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

export async function queryUsers(query: UserQuery) {
  const docs = await collection();
  const filter: Filter<UserDocument> = {};
  if (query.role) filter.role = isSuperAdmin(query.role) ? { $in: ['root', 'super_admin'] } : query.role as SysUser['role'];
  if (query.status === 'locked') filter.$or = [{ status: 'locked' }, { locked: true }];
  else if (query.status) { filter.status = query.status as SysUser['status']; filter.locked = { $ne: true }; }
  if (query.search) filter.$and = [{ $or: [{ username: { $regex: escapeUserSearch(query.search), $options: 'i' } }, { displayName: { $regex: escapeUserSearch(query.search), $options: 'i' } }] }];
  const total = await docs.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const [items, totalUsers, active, administrators, locked] = await Promise.all([
    docs.find(filter, { projection: { passwordHash: 0 } }).sort({ [USER_SORT_FIELDS[query.sort]]: query.order === 'asc' ? 1 : -1, _id: 1 }).skip((page - 1) * query.pageSize).limit(query.pageSize).toArray(),
    docs.countDocuments({}), docs.countDocuments({ status: 'active', locked: { $ne: true } }),
    docs.countDocuments({ role: { $in: ['root', 'super_admin', 'ops_admin'] } }),
    docs.countDocuments({ $or: [{ status: 'locked' }, { locked: true }] }),
  ]);
  return { items: items.map(stripPassword), pagination: { page, pageSize: query.pageSize, total, totalPages }, stats: { total: totalUsers, active, administrators, locked } };
}
