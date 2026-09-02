import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
const password = process.env.PHASE5_BROWSER_PASSWORD;
if (!password) throw new Error('PHASE5_BROWSER_PASSWORD is required');
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';
const xcloudDbName = process.env.MONGODB_XCLOUD_DB || process.env.MONGODB_DB || 'xcloud';
const appDbName = process.env.MONGODB_APP_DB || 'xcloud_ops';
const imsis = ['460009999990001', '460009999990002'];
const users = ['phase5_requester', 'phase5_checker'];
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });

function subscriber(imsi) {
  return { imsi, msisdn: [], imeisv: '', security: { k: 'fixture', opc: 'fixture' }, ambr: { downlink: { value: 50, unit: 3 }, uplink: { value: 25, unit: 3 } }, slice: [], access_restriction_data: 32, subscriber_status: 0, network_access_mode: 0, subscribed_rau_tau_timer: 12, schema_version: 1 };
}

await client.connect();
try {
  const subscribers = client.db(xcloudDbName).collection('subscribers');
  const appUsers = client.db(appDbName).collection('app_users');
  if (process.argv.includes('--verify')) {
    const values = await subscribers.find({ imsi: { $in: imsis } }, { projection: { _id: 0, imsi: 1, access_restriction_data: 1 } }).sort({ imsi: 1 }).toArray();
    const approval = await client.db(appDbName).collection('app_approvals').findOne({ requester: 'phase5_requester', action: 'SUBSCRIBER_BATCH_UPDATE' }, { projection: { _id: 0, id: 1, changeId: 1, status: 1, execution: 1 } });
    const actions = approval ? await client.db(appDbName).collection('app_audit_logs').find({ approvalId: approval.id }, { projection: { _id: 0, action: 1, approvalId: 1, result: 1 } }).sort({ timestamp: 1 }).toArray() : [];
    console.log(JSON.stringify({ subscribers: values, approval, auditActions: actions }));
  } else if (process.argv.includes('--cleanup')) {
    await subscribers.deleteMany({ imsi: { $in: imsis } });
    await appUsers.deleteMany({ username: { $in: users } });
    console.log('Phase 5 browser fixtures removed; audit evidence was retained.');
  } else {
    const passwordHash = await bcrypt.hash(password, 10);
    await subscribers.deleteMany({ imsi: { $in: imsis } });
    await subscribers.insertMany(imsis.map(subscriber));
    await appUsers.deleteMany({ username: { $in: users } });
    await appUsers.insertMany([
      { username: 'phase5_requester', displayName: 'Phase 5 Requester', passwordHash, role: 'operator', status: 'active', security: { sessionVersion: 0 }, createdAt: new Date().toISOString() },
      { username: 'phase5_checker', displayName: 'Phase 5 Checker', passwordHash, role: 'ops_admin', status: 'active', security: { sessionVersion: 0 }, createdAt: new Date().toISOString() },
    ]);
    console.log(`Phase 5 browser fixtures ready: ${imsis.length} subscribers and independent requester/checker accounts.`);
  }
} finally { await client.close(); }
