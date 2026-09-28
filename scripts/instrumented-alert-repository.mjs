import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const __filename = fileURLToPath(import.meta.url);
const baseJiti = createJiti(__filename, {
  interopDefault: true,
  alias: {
    '@': path.resolve(path.dirname(__filename), '../frontend/src'),
    'next/server': path.resolve(path.dirname(__filename), '../frontend/node_modules/next/server.js'),
  },
});

const { getAppCollection, mongoCollections } = baseJiti('../frontend/src/lib/mongo.ts');

export let alertReadCount = 0;
export let failAlertReads = false;

export function resetAlertCounters() {
  alertReadCount = 0;
  failAlertReads = false;
}

export function getAlertReadCount() {
  return alertReadCount;
}

export function setFailAlertReads(fail) {
  failAlertReads = Boolean(fail);
}

export async function appendAlert(alert) {
  const docs = await getAppCollection(mongoCollections.alerts);
  await docs.insertOne(alert);
}

function stripMongoId(doc) {
  const output = { ...doc };
  delete output._id;
  return output;
}

export async function listAlerts(limit = 101) {
  alertReadCount++;
  if (failAlertReads) {
    throw new Error('Deterministic test-isolated alert repository read failure');
  }
  const docs = await getAppCollection(mongoCollections.alerts);
  const alerts = await docs.find({}).sort({ timestamp: -1 }).limit(limit).toArray();
  const [activeCriticalCount, activeWarningCount, activeCount] = await Promise.all([
    docs.countDocuments({ is_acknowledged: false, level: 'CRITICAL' }),
    docs.countDocuments({ is_acknowledged: false, level: 'WARNING' }),
    docs.countDocuments({ is_acknowledged: false }),
  ]);
  return { alerts: alerts.map(stripMongoId), activeCriticalCount, activeWarningCount, activeCount };
}
