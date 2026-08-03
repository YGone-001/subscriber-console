import { Document, MongoServerError } from 'mongodb';
import { getAppCollection, getOpen5gsCollection, mongoCollections } from '@/lib/mongo';
import { sessionQosPreset } from '@/lib/imsQosPresets';

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

export type ProfileSubscriberStats = {
  totalSubscribers: number;
  activeSubscribers: number;
  suspendedSubscribers: number;
  restrictedSubscribers: number;
};

export type ProfileListItem = {
  name: string;
  title: string;
  sliceCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  subscriberCount: number;
  impactedSubscribers: number;
  activeSubscribers: number;
  suspendedSubscribers: number;
  restrictedSubscribers: number;
};

export type ProfileStatsDetail = {
  profileName: string;
  totalSubscribers: number;
  activeSubscribers: number;
  suspendedSubscribers: number;
  restrictedSubscribers: number;
  sampleImsis: string[];
};

export type ProfileGlobalSummary = {
  totalProfiles: number;
  totalGovernedSubscribers: number;
  activeSubscribers: number;
  suspendedSubscribers: number;
  restrictedSubscribers: number;
  unassignedProfiles: number;
};

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

function open5gsSubscribersCollection() {
  return getOpen5gsCollection<Document>(mongoCollections.subscribers);
}

export function defaultProfile(name: string, user: string): ProfileDocument {
  const timestamp = nowIso();
  const defaultSessionPreset = sessionQosPreset(9);
  const imsSessionPreset = sessionQosPreset(5);

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
                priorityLevel: defaultSessionPreset?.arpPriorityLevel ?? 9,
                preemptCap: 'NOT_PREEMPT',
                preemptVuln: 'NOT_PREEMPTABLE',
              },
            },
            ambr: defaultSessionPreset?.sessionAmbr || {
              downlink: { unit: 3, value: 1 },
              uplink: { unit: 3, value: 1 },
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
            ambr: imsSessionPreset?.sessionAmbr || {
              downlink: { unit: 3, value: 1 },
              uplink: { unit: 3, value: 1 },
            },
            pcc_rule: [],
            pgwIpv4: '127.0.0.4',
            pgwIpv6: '',
          },
        ],
      },
    ],
    ocsDefaults: {
      planId: 'plan_default_10gb',
      trafficTotal: 10737418240,
      trafficBalance: 10737418240,
      smsTotal: 100,
      smsBalance: 100,
    },
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

export async function getProfileSubscriberCounts(): Promise<Map<string, ProfileSubscriberStats>> {
  const collection = await open5gsSubscribersCollection();

  const pipeline = [
    {
      $project: {
        imsi: 1,
        profileName: {
          $ifNull: [
            '$webui_meta.profile_name',
            {
              $ifNull: [
                '$webui_meta.profile',
                {
                  $ifNull: ['$profile_name', { $ifNull: ['$profile', ''] }]
                }
              ]
            }
          ]
        },
        access_restriction_data: 1,
      },
    },
    {
      $match: {
        profileName: { $exists: true, $ne: '' },
      },
    },
    {
      $group: {
        _id: '$profileName',
        totalSubscribers: { $sum: 1 },
        activeSubscribers: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ['$access_restriction_data', 32] },
                  { $eq: ['$access_restriction_data', 0] },
                  { $not: ['$access_restriction_data'] },
                  { $eq: ['$access_restriction_data', null] },
                ],
              },
              1,
              0,
            ],
          },
        },
        suspendedSubscribers: {
          $sum: {
            $cond: [
              { $eq: ['$access_restriction_data', 255] },
              1,
              0,
            ],
          },
        },
        restrictedSubscribers: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gt: ['$access_restriction_data', 0] },
                  { $ne: ['$access_restriction_data', 32] },
                  { $ne: ['$access_restriction_data', 255] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ];

  const results = await collection.aggregate<{
    _id: string;
    totalSubscribers: number;
    activeSubscribers: number;
    suspendedSubscribers: number;
    restrictedSubscribers: number;
  }>(pipeline).toArray();

  const map = new Map<string, ProfileSubscriberStats>();
  for (const item of results) {
    if (typeof item._id === 'string' && item._id.trim()) {
      map.set(item._id.trim(), {
        totalSubscribers: Number(item.totalSubscribers || 0),
        activeSubscribers: Number(item.activeSubscribers || 0),
        suspendedSubscribers: Number(item.suspendedSubscribers || 0),
        restrictedSubscribers: Number(item.restrictedSubscribers || 0),
      });
    }
  }
  return map;
}

export async function getProfileStats(profileName: string): Promise<ProfileStatsDetail> {
  const collection = await open5gsSubscribersCollection();
  const filter = {
    $or: [
      { 'webui_meta.profile_name': profileName },
      { 'webui_meta.profile': profileName },
      { profile_name: profileName },
      { profile: profileName },
    ],
  };

  const [countPipelineResult, sampleDocs] = await Promise.all([
    collection.aggregate<{
      total: number;
      active: number;
      suspended: number;
      restricted: number;
    }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$access_restriction_data', 32] },
                    { $eq: ['$access_restriction_data', 0] },
                    { $not: ['$access_restriction_data'] },
                    { $eq: ['$access_restriction_data', null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          suspended: {
            $sum: {
              $cond: [
                { $eq: ['$access_restriction_data', 255] },
                1,
                0,
              ],
            },
          },
          restricted: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ['$access_restriction_data', 0] },
                    { $ne: ['$access_restriction_data', 32] },
                    { $ne: ['$access_restriction_data', 255] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]).toArray(),
    collection
      .find(filter, { projection: { imsi: 1 } })
      .sort({ imsi: 1 })
      .limit(10)
      .toArray(),
  ]);

  const stats = countPipelineResult[0] || { total: 0, active: 0, suspended: 0, restricted: 0 };

  return {
    profileName,
    totalSubscribers: Number(stats.total || 0),
    activeSubscribers: Number(stats.active || 0),
    suspendedSubscribers: Number(stats.suspended || 0),
    restrictedSubscribers: Number(stats.restricted || 0),
    sampleImsis: sampleDocs.map((doc) => String(doc.imsi)).filter(Boolean),
  };
}

export async function listProfiles(): Promise<ProfileListItem[]> {
  const collection = await profilesCollection();
  const [docs, statsMap] = await Promise.all([
    collection.find({}).sort({ name: 1 }).toArray(),
    getProfileSubscriberCounts(),
  ]);

  return docs.map((doc) => {
    const stats = statsMap.get(doc.name) || {
      totalSubscribers: 0,
      activeSubscribers: 0,
      suspendedSubscribers: 0,
      restrictedSubscribers: 0,
    };
    return {
      name: doc.name,
      title: doc.title || doc.name,
      sliceCount: Array.isArray(doc.sliceList) ? doc.sliceList.length : 0,
      createdAt: doc.createdAt || null,
      updatedAt: doc.updatedAt || null,
      updatedBy: doc.updatedBy || doc.createdBy || null,
      subscriberCount: stats.totalSubscribers,
      impactedSubscribers: stats.totalSubscribers,
      activeSubscribers: stats.activeSubscribers,
      suspendedSubscribers: stats.suspendedSubscribers,
      restrictedSubscribers: stats.restrictedSubscribers,
    };
  });
}

export async function getProfilesGlobalSummary(): Promise<ProfileGlobalSummary> {
  const profiles = await listProfiles();
  const totalProfiles = profiles.length;
  let totalGovernedSubscribers = 0;
  let activeSubscribers = 0;
  let suspendedSubscribers = 0;
  let restrictedSubscribers = 0;
  let unassignedProfiles = 0;

  for (const p of profiles) {
    totalGovernedSubscribers += p.subscriberCount;
    activeSubscribers += p.activeSubscribers;
    suspendedSubscribers += p.suspendedSubscribers;
    restrictedSubscribers += p.restrictedSubscribers;
    if (p.subscriberCount === 0) {
      unassignedProfiles += 1;
    }
  }

  return {
    totalProfiles,
    totalGovernedSubscribers,
    activeSubscribers,
    suspendedSubscribers,
    restrictedSubscribers,
    unassignedProfiles,
  };
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

export async function deleteProfile(name: string, user: string, force = false) {
  const collection = await profilesCollection();
  const existing = await getProfile(name);
  if (!existing) return null;

  const stats = await getProfileStats(name);
  if (stats.totalSubscribers > 0 && !force) {
    const error = new Error(`PROFILE_IN_USE:${stats.totalSubscribers}`);
    (error as unknown as { code?: string; subscriberCount?: number }).code = 'PROFILE_IN_USE';
    (error as unknown as { code?: string; subscriberCount?: number }).subscriberCount = stats.totalSubscribers;
    throw error;
  }

  await saveProfileVersion(name, existing, user, 'DELETE');
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
