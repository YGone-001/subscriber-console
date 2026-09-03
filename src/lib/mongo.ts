import { Collection, Db, Document, MongoClient, MongoClientOptions } from 'mongodb';

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/xcloud';
const DEFAULT_XCLOUD_DB = 'xcloud';
const DEFAULT_APP_DB = 'xcloud_ops';

const globalForMongo = global as unknown as {
  mongoClientPromise?: Promise<MongoClient>;
};

function mongoUri(): string {
  return process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
}

export function mongoDbName(): string {
  return xcloudDbName();
}

export function xcloudDbName(): string {
  return process.env.MONGODB_XCLOUD_DB || DEFAULT_XCLOUD_DB;
}

export function appDbName(): string {
  return process.env.MONGODB_APP_DB || DEFAULT_APP_DB;
}

export function mongoDbNames() {
  return {
    xcloud: xcloudDbName(),
    app: appDbName(),
  };
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

export function getXcloudDb(): Promise<Db> {
  return getMongoDb(xcloudDbName());
}

export function getAppDb(): Promise<Db> {
  return getMongoDb(appDbName());
}

export async function getMongoCollection<T extends Document = Document>(
  name: string,
  dbName = mongoDbName()
): Promise<Collection<T>> {
  const db = await getMongoDb(dbName);
  return db.collection<T>(name);
}

export async function getXcloudCollection<T extends Document = Document>(
  name: string
): Promise<Collection<T>> {
  const db = await getXcloudDb();
  return db.collection<T>(name);
}

export async function getAppCollection<T extends Document = Document>(
  name: string
): Promise<Collection<T>> {
  const db = await getAppDb();
  return db.collection<T>(name);
}

export const mongoCollections = {
  subscribers: 'subscribers',
  ocsTariffPlans: 'ocs_tariff_plans',
  ocsSubscribers: 'ocs_subscribers',
  ocsBalances: 'ocs_balances',
  ocsSessions: 'ocs_sessions',
  ocsReservations: 'ocs_reservations',
  ocsUsageRecords: 'ocs_usage_records',
  ocsEvents: 'ocs_events',
  ocsConfig: 'ocs_config',
  ocsBalanceAdjustments: 'ocs_balance_adjustments',
  profiles: 'app_profiles',
  profileVersions: 'app_profile_versions',
  ratings: 'app_ratings',
  users: 'app_users',
  approvals: 'app_approvals',
  sequences: 'app_sequences',
  auditLogs: 'app_audit_logs',
  alerts: 'app_alerts',
  rateLimits: 'app_rate_limits',
  metrics: 'app_metrics',
} as const;
