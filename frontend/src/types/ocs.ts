/**
 * Frontend-facing OCS record shapes returned by the Go production API.
 *
 * These declarations were relocated out of the removed Next.js business backend
 * (`frontend/src/server/repositories/ocsOperationsRepository.ts`) so the OCS UI
 * panels keep a typed view of the Go-owned `/api/ocs/*` responses.
 */

export type OcsBalanceRecord = {
  id: string;
  imsi: string;
  plan_id: string;
  status: string;
  data_total: number;
  data_used: number;
  data_reserved: number;
  data_available: number;
  voice_total: number;
  voice_used: number;
  voice_reserved: number;
  voice_available: number;
  sms_total: number;
  sms_used: number;
  sms_available: number;
  money_balance: number;
  version: number;
  data_invariant_ok: boolean;
  voice_invariant_ok: boolean;
  sms_invariant_ok: boolean;
  invariant_ok: boolean;
  created_at?: string;
  updated_at?: string;
  cycle_start_at?: string;
  cycle_reset_at?: string;
};

export type OcsSessionRecord = {
  id: string;
  session_id: string;
  imsi: string;
  apn: string;
  state: 'active' | 'closing' | 'closed' | string;
  interface_type: 'gy' | 'ro' | string;
  cc_request_number: number;
  granted_total: number;
  used_total: number;
  rating_group?: number;
  service_identifier?: number;
  tariff_rule_id?: string;
  charging_type?: string;
  calling_party?: string;
  called_party?: string;
  service_context_id?: string;
  granted_seconds?: number;
  used_seconds?: number;
  cleanup_token?: string;
  cleanup_stage?: string;
  cleanup_updated_at?: string;
  close_reason?: string;
  started_at?: string;
  last_update_at?: string;
  closed_at?: string;
};

export type OcsReservationRecord = {
  id: string;
  session_id: string;
  imsi: string;
  apn: string;
  charging_type: string;
  interface_type?: string;
  grant_cc_request_type: string;
  grant_cc_request_number: number;
  reserved_octets: number;
  used_octets: number;
  released_octets: number;
  overuse_octets: number;
  granted_octets: number;
  granted_seconds?: number;
  used_seconds?: number;
  result_code: number;
  state: 'active' | 'settled' | 'released' | 'closed' | 'orphaned' | string;
  rating_group?: number;
  service_identifier?: number;
  tariff_rule_id?: string;
  orphan_reason?: string;
  cleanup_token?: string;
  created_at?: string;
  updated_at?: string;
  settled_at?: string;
  closed_at?: string;
  orphaned_at?: string;
};

export type OcsUsageRecord = {
  id: string;
  session_id: string;
  imsi: string;
  apn: string;
  cc_request_type: 'UPDATE' | 'TERMINATION' | string;
  cc_request_number: number;
  input_octets: number;
  output_octets: number;
  total_octets: number;
  charging_type?: string;
  interface_type?: string;
  charged: boolean;
  result_code?: number;
  granted_octets?: number;
  granted_seconds?: number;
  used_seconds?: number;
  granted_events?: number;
  used_events?: number;
  service_context_id?: string;
  rating_group?: number;
  service_identifier?: number;
  tariff_rule_id?: string;
  created_at?: string;
};
