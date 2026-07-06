export interface Ambr {
  downlink: { unit: number; value: number };
  uplink: { unit: number; value: number };
}

export interface Arp {
  priorityLevel: number;
  preemptCap: string; // e.g., "NOT_PREEMPT"
  preemptVuln: string; // e.g., "NOT_PREEMPTABLE"
}

export interface Qos {
  _5qi?: number;
  index?: number;
  arp: Arp;
}

export interface Session {
  name: string;
  type: number;
  pgwIpv4?: string;
  pgwIpv6?: string;
  qos: Qos;
  ambr: Ambr;
  pcc_rule?: unknown[];
}

export interface Slice {
  default_indicator: boolean;
  sst: number;
  sd: string;
  session_list: Session[];
}

export interface Auth4GData {
  k: string;
  opValue: string;
  sqn: number;
  amf: string;
}

export interface Rating {
  rating_group_id: number;
  currency: string;
  rates: number;
  rates_type: number;
}

export interface Sub4G {
  access_restriction_data: number;
  allowedVisitedPlmns: string;
  msisdnList: { msisdn: string }[];
  network_access_mode: number;
  ambr: Ambr;
  sliceList: Slice[];
}
