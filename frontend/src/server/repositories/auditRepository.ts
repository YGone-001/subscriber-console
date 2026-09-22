import { MongoServerError, ObjectId } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';
import { sanitizeAuditRecord } from '@/lib/audit/record';
import type { AuditLogRecord } from '@/types/audit';

type StoredAuditLog = AuditLogRecord & { _id: ObjectId | string };

function collection() {
  return getAppCollection<StoredAuditLog>(mongoCollections.auditLogs);
}

/** Append-only internal operation logging. No user-facing read or export API depends on this module. */
export async function appendAuditLog(log: AuditLogRecord) {
  const docs = await collection();
  try {
    await docs.insertOne({ ...sanitizeAuditRecord(log), _id: log.id });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000
      && error.keyPattern?._id === 1 && error.keyValue?._id === log.id) return;
    throw error;
  }
}
