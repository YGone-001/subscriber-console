import { redis } from '@/lib/redis';

export const PROFILE_VERSION_LIMIT = 50;

export type ProfileVersionAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE';

export type ProfileVersionRecord = {
  versionId: string;
  profileName: string;
  savedAt: string;
  savedBy: string;
  action: ProfileVersionAction;
  title?: string;
  sliceCount: number;
  profile: any;
};

export type ProfileVersionSummary = Omit<ProfileVersionRecord, 'profile'>;

export function profileVersionKey(name: string) {
  return `PROFILE_VERSION:${name}`;
}

export function buildProfileVersion(
  profileName: string,
  profile: any,
  savedBy: string,
  action: ProfileVersionAction
): ProfileVersionRecord {
  return {
    versionId: crypto.randomUUID(),
    profileName,
    savedAt: new Date().toISOString(),
    savedBy,
    action,
    title: profile?.title || profileName,
    sliceCount: Array.isArray(profile?.sliceList) ? profile.sliceList.length : 0,
    profile,
  };
}

export async function saveProfileVersion(
  profileName: string,
  profile: any,
  savedBy: string,
  action: ProfileVersionAction
) {
  if (!profile) return null;
  const record = buildProfileVersion(profileName, profile, savedBy, action);
  const pipeline = redis.pipeline();
  pipeline.lpush(profileVersionKey(profileName), JSON.stringify(record));
  pipeline.ltrim(profileVersionKey(profileName), 0, PROFILE_VERSION_LIMIT - 1);
  await pipeline.exec();
  return record;
}

export async function listProfileVersions(profileName: string, limit = PROFILE_VERSION_LIMIT) {
  const max = Math.min(Math.max(limit, 1), PROFILE_VERSION_LIMIT);
  const raw = await redis.lrange(profileVersionKey(profileName), 0, max - 1);
  return raw
    .map(item => {
      try {
        return JSON.parse(item) as ProfileVersionRecord;
      } catch {
        return null;
      }
    })
    .filter((item): item is ProfileVersionRecord => item !== null);
}

export async function getProfileVersion(profileName: string, versionId: string) {
  const versions = await listProfileVersions(profileName, PROFILE_VERSION_LIMIT);
  return versions.find(version => version.versionId === versionId) || null;
}

export function summarizeProfileVersion(record: ProfileVersionRecord): ProfileVersionSummary {
  const { profile, ...summary } = record;
  return summary;
}
