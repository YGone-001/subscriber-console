import { Collection, Db, Document, MongoClient, MongoClientOptions } from 'mongodb';

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/open5gs';
const DEFAULT_MONGODB_DB = 'open5gs';

const globalForMongo = global as unknown as {
  mongoClientPromise?: Promise<MongoClient>;
};

function mongoUri(): string {
  return process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
}

export function mongoDbName(): string {
  return process.env.MONGODB_DB || DEFAULT_MONGODB_DB;
}

function clientOptions(): MongoClientOptions {
  return {
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
    minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE || 0),
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
  };
}

export async function getMongoClient(): Promise<MongoClient> {
  if (!globalForMongo.mongoClientPromise) {
    const client = new MongoClient(mongoUri(), clientOptions());
    globalForMongo.mongoClientPromise = client.connect();
  }

  return globalForMongo.mongoClientPromise;
}

export async function getMongoDb(dbName = mongoDbName()): Promise<Db> {
  const client = await getMongoClient();
  return client.db(dbName);
}

export async function getMongoCollection<T extends Document = Document>(
  name: string,
  dbName = mongoDbName()
): Promise<Collection<T>> {
  const db = await getMongoDb(dbName);
  return db.collection<T>(name);
}

export const mongoCollections = {
  subscribers: 'subscribers',
  profiles: 'app_profiles',
  profileVersions: 'app_profile_versions',
  ratings: 'app_ratings',
  users: 'app_users',
  auditLogs: 'app_audit_logs',
  alerts: 'app_alerts',
  rateLimits: 'app_rate_limits',
  metrics: 'app_metrics',
} as const;
