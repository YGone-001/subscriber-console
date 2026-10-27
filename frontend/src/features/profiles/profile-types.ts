/*
 * Read/DTO shapes for the template surface. They mirror the Go responses; no
 * field is inferred on the client.
 */
import type { CredentialState } from '../../types/credential';

export type ProfileAmbrSide = { unit?: number; value?: number };

export type ProfileRecord = {
  name?: string;
  title?: string;
  auth?: { k?: string; opc?: string; op?: string; amf?: string; credentialState?: CredentialState };
  ambr?: { downlink?: ProfileAmbrSide | null; uplink?: ProfileAmbrSide | null } | null;
  access_restriction_data?: number | null;
  sliceList?: unknown[];
  ocsDefaults?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  createdBy?: string;
  /** Monotonic write counter; a save preconditions on the value it loaded. */
  revision?: number;
};

export type ProfileStats = {
  profileName: string;
  totalSubscribers: number;
  activeSubscribers: number;
  suspendedSubscribers: number;
  restrictedSubscribers: number;
  sampleImsis: string[];
};

export type ProfileDetailResponse = {
  profile: ProfileRecord;
  stats: ProfileStats | null;
  /** `unavailable` means the subscriber attribution failed, not that no
   * subscriber uses the template. */
  statsCompleteness?: 'complete' | 'unavailable';
};

export type ProfileListItem = {
  name: string;
  title?: string;
  sliceCount?: number;
  sessionCount?: number;
  pccRuleCount?: number;
  ocsDefaultsConfigured?: boolean;
  accessRestriction?: number | null;
  ambr?: { downlink?: ProfileAmbrSide | null; uplink?: ProfileAmbrSide | null } | null;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  subscriberCount?: number;
  impactedSubscribers?: number;
  activeSubscribers?: number;
  suspendedSubscribers?: number;
  restrictedSubscribers?: number;
};

export type ProfileGlobalSummary = {
  totalProfiles: number;
  totalGovernedSubscribers: number;
  activeSubscribers: number;
  suspendedSubscribers: number;
  restrictedSubscribers: number;
  unassignedProfiles: number;
  subscriberStatsCompleteness?: 'complete' | 'unavailable';
};

export type ProfilesResponse = {
  profiles: ProfileListItem[];
  summary?: ProfileGlobalSummary;
};

export type ProfileVersionSummary = {
  versionId: string;
  profileName?: string;
  action: string;
  savedAt?: string;
  savedBy?: string;
  title?: string;
  sliceCount?: number;
};

export type ProfileVersionDetail = ProfileVersionSummary & { profile?: ProfileRecord };

export type ProfileVersionsResponse = {
  versions: ProfileVersionSummary[];
  current: { title?: string; updatedAt?: string; updatedBy?: string; sliceCount?: number; revision?: number } | null;
  /** A deleted template keeps its snapshots, so a restore can bring it back. */
  profileExists?: boolean;
};

export type ProfileMetaResponse = {
  capabilities: {
    canWrite: boolean;
    canRestore: boolean;
    credentialVisibility: 'plaintext' | 'masked';
    canEditCredentials: boolean;
  };
  accessRestriction: {
    unrestricted: number;
    suspended: number;
    bits: Array<{ value: number; key: string }>;
  };
};

export type TariffPlanOption = { plan_id: string; name?: string; status?: string };

export type TariffPlansResponse = { plans?: TariffPlanOption[] };

export type RatingRule = {
  rule_id?: string;
  apn?: string;
  rating_group_id?: number;
  service_identifier?: number;
  charging_type?: string;
  unit?: string;
};

export type RatingsResponse = { ratings?: RatingRule[] };
