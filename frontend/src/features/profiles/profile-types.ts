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
  /* Collection-wide count, so the strip keeps describing the platform while the
   * table pages through it. */
  profilesWithoutBilling?: number;
  subscriberStatsCompleteness?: 'complete' | 'unavailable';
};

export type ProfilesResponse = {
  profiles: ProfileListItem[];
  summary?: ProfileGlobalSummary;
  /** Keyset cursor for the next page; null on the last page. */
  nextCursor?: string | null;
  hasMore?: boolean;
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

/* --------------------------------------------------------------- workspace -- */

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export type ProfileAuthDraft = { k: string; opValue: string; amf: string };

export type ProfileAmbrDraft = { downlink: ProfileAmbrSide; uplink: ProfileAmbrSide };

/* Slice content is wide xCloud BSON: the editor touches a handful of keys and
 * the rest travels through untouched, so this is deliberately not narrowed. */
export type ProfileSliceDraft = Record<string, any>;

export type ProfileOcsDefaultsDraft = Record<string, any>;

export type ProfileAccessBit = { value: number; key: string };

export type ProfileKeyProblem = { code: 'nameRequired' | 'nameInvalid' | 'nameReserved' };

export type ProfileDataStatus = 'ready' | 'unavailable' | 'loading';

/*
 * The edit workspace's props. These were typed `any`, so a field the page forgot
 * to pass rendered as undefined instead of failing the build; naming them makes
 * the page's object literal a checked contract.
 */
export type ProfileEditState = {
  inputName: string;
  profileTitle: string;
  profileKey: string;
  profileKeyProblem: ProfileKeyProblem | null;
  authData: ProfileAuthDraft;
  canEditCredentials: boolean;
  usimType: 'opc' | 'op';
  ueAmbr: ProfileAmbrDraft;
  isAccessRestrictionsExpanded: boolean;
  accessRestriction: number | null;
  ocsDefaults: ProfileOcsDefaultsDraft;
  tariffPlanList: TariffPlanOption[];
  ratingList: RatingRule[];
  tariffPlanStatus: ProfileDataStatus;
  ratingStatus: ProfileDataStatus;
  accessBits: ProfileAccessBit[] | null;
  slices: ProfileSliceDraft[];
  newlyAddedSliceIndex: number | null;
  expandedSlices: number[];
};

export type ProfileEditActions = {
  setInputName: (value: string) => void;
  setProfileTitle: (value: string) => void;
  setProfileKey: (value: string) => void;
  setAuthData: (value: ProfileAuthDraft) => void;
  setUsimType: (value: 'opc' | 'op') => void;
  setUeAmbr: (value: ProfileAmbrDraft) => void;
  setIsAccessRestrictionsExpanded: (value: boolean | ((previous: boolean) => boolean)) => void;
  setAccessRestriction: (value: number | null) => void;
  setOcsDefaults: (value: ProfileOcsDefaultsDraft) => void;
  addSlice: () => void;
  handleSliceChange: (index: number, slice: ProfileSliceDraft) => void;
  removeSlice: (index: number) => void;
  toggleSliceExpanded: (index: number) => void;
  jumpToAnchor: (id: string) => void;
};

export type ProfileViewState = {
  authData: ProfileAuthDraft;
  credentialState: CredentialState | null;
  rawAuth: Record<string, unknown> | null;
  usimType: 'opc' | 'op';
  ocsDefaults: ProfileOcsDefaultsDraft;
  tariffPlanList: TariffPlanOption[];
  ratingList: RatingRule[];
  ratingStatus: ProfileDataStatus;
  ueAmbr: ProfileAmbrDraft;
  isAccessRestrictionsExpanded: boolean;
  setIsAccessRestrictionsExpanded: (value: boolean | ((previous: boolean) => boolean)) => void;
  accessRestriction: number | null;
  accessBits: ProfileAccessBit[] | null;
  slices: ProfileSliceDraft[];
  backendStats: ProfileStats | null;
  statsUnavailable: boolean;
};
