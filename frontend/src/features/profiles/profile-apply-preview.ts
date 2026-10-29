export type ProfileApplyPreview = {
  imsi: string;
  profileName: string;
  currentProfile: string;
  state: "in_sync" | "changed" | "unknown";
  changedGroups: string[];
  securityChanged: boolean;
  noEffect: boolean;
  previewToken: string;
};

export const PROFILE_APPLY_GROUP_LABEL_KEYS: Record<string, string> = {
  security: 'prof_apply_group_security',
  ambr: 'prof_apply_group_ambr',
  slice: 'prof_apply_group_slice',
  access_restriction_data: 'prof_apply_group_access',
  profile_name: 'prof_apply_group_binding',
};
