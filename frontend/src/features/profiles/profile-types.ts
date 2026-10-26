/*
 * Read/DTO shapes for the template surface. They mirror the Go responses; no
 * field is inferred on the client.
 */

export type ProfileAmbrSide = { unit?: number; value?: number };

export type ProfileRecord = {
  name?: string;
  title?: string;
  auth?: { k?: string; opc?: string; op?: string; amf?: string };
  ambr?: { downlink?: ProfileAmbrSide | null; uplink?: ProfileAmbrSide | null } | null;
  access_restriction_data?: number | null;
  sliceList?: unknown[];
  ocsDefaults?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  createdBy?: string;
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
  current: { title?: string; updatedAt?: string; updatedBy?: string; sliceCount?: number } | null;
};

export type ProfileMetaResponse = {
  capabilities: {
    canWrite: boolean;
    canRestore: boolean;
    credentialVisibility: 'plaintext' | 'masked';
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
