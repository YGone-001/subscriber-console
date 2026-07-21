import { Document, MongoServerError } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';

export const PROFILE_VERSION_LIMIT = 50;

export type ProfileVersionAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE';

export type ProfileDocument = Document & {
  name: string;
  title?: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  auth?: Record<string, unknown>;
  ambr?: unknown;
  msisdnList?: unknown[];
  access_restriction_data?: number;
  sliceList?: unknown[];
  ocsDefaults?: Record<string, unknown>;
  restoredFromVersionId?: string;
  restoredFromSavedAt?: string;
};

export type ProfileVersionRecord = {
  versionId: string;
  profileName: string;
  savedAt: string;
  savedBy: string;
  action: ProfileVersionAction;
  title?: string;
  sliceCount: number;
  profile: ProfileDocument;
};

export type ProfileVersionSummary = Omit<ProfileVersionRecord, 'profile'>;

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function nowIso(): string {
  return new Date().toISOString();
}

function profilesCollection() {
  return getAppCollection<ProfileDocument>(mongoCollections.profiles);
}

function versionsCollection() {
  return getAppCollection<ProfileVersionRecord & Document>(mongoCollections.profileVersions);
}

export function defaultProfile(name: string, user: string): ProfileDocument {
  const timestamp = nowIso();

  return {
    name,
    title: name,
    createdAt: timestamp,
    createdBy: user,
    updatedAt: timestamp,
    updatedBy: user,
    auth: {
      k: '00000000000000000000000000000000',
      opc: '00000000000000000000000000000000',
      amf: '8000',
    },
    ambr: {
      downlink: { unit: 2, value: 10 },
      uplink: { unit: 2, value: 10 },
    },
    sliceList: [
      {
        default_indicator: true,
        sd: '000001',
        sst: 1,
        session_list: [
          {
            name: 'internet',
            type: 1,
            qos: {
              _5qi: 9,
              index: 0,
              arp: {
                priorityLevel: 8,
                preemptCap: 'NOT_PREEMPT',
                preemptVuln: 'NOT_PREEMPTABLE',
              },
            },
            ambr: {
              downlink: { unit: 2, value: 10 },
              uplink: { unit: 2, value: 10 },
            },
            pcc_rule: [],
            pgwIpv4: '127.0.0.4',
            pgwIpv6: '',
          },
          {
            name: 'ims',
            type: 3,
            qos: {
              _5qi: 5,
              index: 0,
              arp: {
                priorityLevel: 1,
                preemptCap: 'NOT_PREEMPT',
                preemptVuln: 'NOT_PREEMPTABLE',
              },
            },
            ambr: {
              downlink: { unit: 2, value: 10 },
              uplink: { unit: 2, value: 10 },
            },
            pcc_rule: [],
            pgwIpv4: '127.0.0.4',
            pgwIpv6: '',
          },
        ],
      },
    ],
  };
}

function stripSubscriberIdentityFields<T extends Record<string, unknown>>(profile: T): T {
  const rest = { ...profile };
  delete rest.msisdnList;
  delete rest.msisdn;
  delete rest.imsi;
  return rest as T;
}

function stripMongoId<T extends Record<string, unknown>>(doc: T | null): T | null {
  if (!doc) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...rest } = doc;
  return stripSubscriberIdentityFields(rest) as T;
}

export async function listProfiles() {
  const collection = await profilesCollection();
  const docs = await collection.find({}).sort({ name: 1 }).toArray();

  return docs.map((doc) => ({
    name: doc.name,
    title: doc.title || doc.name,
    sliceCount: Array.isArray(doc.sliceList) ? doc.sliceList.length : 0,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    updatedBy: doc.updatedBy || doc.createdBy || null,
  }));
}

export async function getProfile(name: string): Promise<ProfileDocument | null> {
  const collection = await profilesCollection();
  return stripMongoId(await collection.findOne({ name }));
}

export async function createProfile(name: string, user: string): Promise<ProfileDocument> {
  const collection = await profilesCollection();
  const profile = defaultProfile(name, user);

  try {
    await collection.insertOne(profile);
    await saveProfileVersion(name, profile, user, 'CREATE');
    return profile;
  } catch (error) {
    if (isDuplicateKey(error)) throw new Error('PROFILE_EXISTS');
    throw error;
  }
}

export async function updateProfile(name: string, body: Record<string, unknown>, user: string) {
  const collection = await profilesCollection();
  const existing = await getProfile(name);
  if (existing) {
    await saveProfileVersion(name, existing, user, 'UPDATE');
  }

  const updated: ProfileDocument = {
    ...(existing || { name }),
    ...body,
    name,
    title: String(body.title || existing?.title || name),
    createdAt: existing?.createdAt || nowIso(),
    createdBy: existing?.createdBy || user,
    updatedAt: nowIso(),
    updatedBy: user,
  };
  const sanitized = stripSubscriberIdentityFields(updated) as ProfileDocument;

  await collection.replaceOne({ name }, sanitized, { upsert: true });
  return { existing, updated: sanitized };
}

export async function deleteProfile(name: string, user: string) {
  const collection = await profilesCollection();
  const existing = await getProfile(name);
  if (existing) {
    await saveProfileVersion(name, existing, user, 'DELETE');
  }
  await collection.deleteOne({ name });
  return existing;
}

export function buildProfileVersion(
  profileName: string,
  profile: ProfileDocument,
  savedBy: string,
  action: ProfileVersionAction
): ProfileVersionRecord {
  const sanitizedProfile = stripSubscriberIdentityFields(profile) as ProfileDocument;
  return {
    versionId: crypto.randomUUID(),
    profileName,
    savedAt: nowIso(),
    savedBy,
    action,
    title: sanitizedProfile?.title || profileName,
    sliceCount: Array.isArray(sanitizedProfile?.sliceList) ? sanitizedProfile.sliceList.length : 0,
    profile: sanitizedProfile,
  };
}

export async function saveProfileVersion(
  profileName: string,
  profile: ProfileDocument | null,
  savedBy: string,
  action: ProfileVersionAction
) {
  if (!profile) return null;

  const collection = await versionsCollection();
  const record = buildProfileVersion(profileName, profile, savedBy, action);
  await collection.insertOne(record);

  const stale = await collection
    .find({ profileName }, { projection: { versionId: 1 } })
    .sort({ savedAt: -1 })
    .skip(PROFILE_VERSION_LIMIT)
    .toArray();

  if (stale.length > 0) {
    await collection.deleteMany({ versionId: { $in: stale.map((item) => item.versionId) } });
  }

  return record;
}

export async function listProfileVersions(profileName: string, limit = PROFILE_VERSION_LIMIT) {
  const max = Math.min(Math.max(limit, 1), PROFILE_VERSION_LIMIT);
  const collection = await versionsCollection();
  const versions = await collection
    .find({ profileName })
    .sort({ savedAt: -1 })
    .limit(max)
    .toArray();

  return versions.map((version) => stripMongoId(version) as ProfileVersionRecord);
}

export async function getProfileVersion(profileName: string, versionId: string) {
  const collection = await versionsCollection();
  return stripMongoId(await collection.findOne({ profileName, versionId })) as ProfileVersionRecord | null;
}

export function summarizeProfileVersion(record: ProfileVersionRecord): ProfileVersionSummary {
  const summary = { ...record };
  delete (summary as Partial<ProfileVersionRecord>).profile;
  return summary as ProfileVersionSummary;
}

export async function restoreProfileVersion(name: string, versionId: string, user: string) {
  const version = await getProfileVersion(name, versionId);
  if (!version) return null;

  const collection = await profilesCollection();
  const current = await getProfile(name);
  if (current) {
    await saveProfileVersion(name, current, user, 'RESTORE');
  }

  const restored: ProfileDocument = stripSubscriberIdentityFields({
    ...version.profile,
    name,
    title: version.profile?.title || name,
    createdAt: version.profile?.createdAt || current?.createdAt || nowIso(),
    createdBy: version.profile?.createdBy || current?.createdBy || user,
    updatedAt: nowIso(),
    updatedBy: user,
    restoredFromVersionId: version.versionId,
    restoredFromSavedAt: version.savedAt,
  }) as ProfileDocument;

  await collection.replaceOne({ name }, restored, { upsert: true });
  return { version, current, restored };
}
