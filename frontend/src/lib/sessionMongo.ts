import { Collection, Document, MongoClient, MongoClientOptions } from 'mongodb';

/**
 * Minimal read-only MongoDB support for proxy session validation.
 *
 * This is the only surviving frontend runtime Mongo entry point after the business
 * backend removal. It intentionally exposes exactly two capabilities: read-only access
 * to the xcloud_ops.app_users session-validation collection, plus a test-only
 * best-effort teardown helper.
 *
 * It must never grow generic query helpers, business collections (xcloud subscribers,
 * OCS, profiles, ratings, audit logs, alerts) or write operations.
 */

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/xcloud';
const DEFAULT_APP_DB = 'xcloud_ops';

const globalForSessionMongo = global as unknown as {
  sessionMongoClientPromise?: Promise<MongoClient>;
};

function mongoUri(): string {
  return process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
}

function appDbName(): string {
  return process.env.MONGODB_APP_DB || DEFAULT_APP_DB;
}

function clientOptions(): MongoClientOptions {
  return {
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
    minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE || 0),
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
  };
}

async function getSessionMongoClient(): Promise<MongoClient> {
  if (!globalForSessionMongo.sessionMongoClientPromise) {
    const client = new MongoClient(mongoUri(), clientOptions());
    globalForSessionMongo.sessionMongoClientPromise = client.connect();
  }
  return globalForSessionMongo.sessionMongoClientPromise;
}

/** Read-only handle for the xcloud_ops.app_users session-validation collection. */
export async function getSessionUsersCollection<T extends Document = Document>(): Promise<Collection<T>> {
  const client = await getSessionMongoClient();
  return client.db(appDbName()).collection<T>('app_users');
}

/** Best-effort teardown for test harnesses; never called from production request paths. */
export async function closeSessionMongoClient(): Promise<void> {
  const pending = globalForSessionMongo.sessionMongoClientPromise;
  if (!pending) return;
  globalForSessionMongo.sessionMongoClientPromise = undefined;
  try {
    const client = await pending;
    await client.close();
  } catch {
    // Best-effort: teardown must never throw.
  }
}