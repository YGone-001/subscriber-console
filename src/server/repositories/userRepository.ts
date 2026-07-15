import { Document, MongoServerError } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';
import type { UserRole } from '@/lib/authz';

export type UserDocument = {
  username: string;
  passwordHash: string;
  role: UserRole;
  status: 'active' | 'disabled';
  createdAt: string;
  createdBy: string;
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

  const next = { ...existing, ...updates, username };
  await docs.replaceOne({ username }, next);
  return { existing, next };
}

export async function deleteUser(username: string) {
  const docs = await collection();
  const existing = await docs.findOne({ username });
  if (!existing) return null;

  await docs.deleteOne({ username });
  return existing;
}

export function safeUser(user: UserDocument & Record<string, unknown>): SafeUserDocument {
  return stripPassword(user);
}
