import { getAppCollection, mongoCollections } from '@/lib/mongo';
import type { SyslogLevel } from '@/lib/syslog';

export type AlertDocument = {
  id: string;
  timestamp: string;
  level: SyslogLevel;
  imsi: string;
  reason: string;
  is_acknowledged: boolean;
};

const ALERT_LIMIT = 10000;

function collection() {
  return getAppCollection<AlertDocument>(mongoCollections.alerts);
}

function stripMongoId<T extends Record<string, unknown>>(doc: T): T {
  const output = { ...doc };
  delete output._id;
  return output;
}

export async function appendAlert(alert: AlertDocument) {
  const docs = await collection();
  await docs.insertOne(alert);

  const stale = await docs
    .find({}, { projection: { id: 1 } })
    .sort({ timestamp: -1 })
    .skip(ALERT_LIMIT)
    .toArray();

  if (stale.length > 0) {
    await docs.deleteMany({ id: { $in: stale.map((item) => item.id) } });
  }
}

export async function listAlerts(limit = 101) {
  const docs = await collection();
  const alerts = await docs.find({}).sort({ timestamp: -1 }).limit(limit).toArray();
  const [activeCriticalCount, activeWarningCount, activeCount] = await Promise.all([
    docs.countDocuments({ is_acknowledged: false, level: 'CRITICAL' }),
    docs.countDocuments({ is_acknowledged: false, level: 'WARNING' }),
    docs.countDocuments({ is_acknowledged: false }),
  ]);

  return { alerts: alerts.map(stripMongoId), activeCriticalCount, activeWarningCount, activeCount };
}

export async function acknowledgeAlerts(ids: string[]) {
  const docs = await collection();
  const result = await docs.updateMany(
    { id: { $in: ids }, is_acknowledged: false },
    { $set: { is_acknowledged: true } }
  );
  return result.modifiedCount;
}
