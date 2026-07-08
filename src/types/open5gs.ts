import type { Long, ObjectId } from 'mongodb';

export type Open5gsBitrate = {
  value: number;
  unit: number;
};

export type Open5gsAmbr = {
  downlink: Open5gsBitrate;
  uplink: Open5gsBitrate;
};

export type Open5gsArp = {
  priority_level: number;
  pre_emption_capability: number;
  pre_emption_vulnerability: number;
};

export type Open5gsQos = {
  index: number;
  arp: Open5gsArp;
  mbr?: Open5gsAmbr;
  gbr?: Open5gsAmbr;
};

export type Open5gsPccRule = {
  flow?: Array<{
    direction: number;
    description: string;
  }>;
  qos?: Open5gsQos;
};

export type Open5gsSession = {
  _id?: ObjectId;
  name: string;
  type?: number;
  qos?: Open5gsQos;
  ambr?: Open5gsAmbr;
  ue?: {
    ipv4?: string;
    ipv6?: string;
  };
  smf?: {
    ipv4?: string;
    ipv6?: string;
  };
  pcc_rule?: Open5gsPccRule[];
  lbo_roaming_allowed?: boolean;
};

export type Open5gsSlice = {
  _id?: ObjectId;
  sst: number;
  sd?: string;
  default_indicator?: boolean;
  session?: Open5gsSession[];
};

export type Open5gsSecurity = {
  k?: string;
  op?: string | null;
  opc?: string | null;
  amf?: string;
  rand?: string;
  sqn?: Long | number;
};

export type SubscriberOcsData = {
  traffic?: {
    traffic_total?: number;
    traffic_balance?: number;
    imsi?: string;
    plmn?: string;
  };
  imsi?: {
    account_id?: string;
    imsi?: string;
    withhold?: number;
    withholding_residue?: number;
    withholding_time?: number;
    last_update_time?: string | number | Date;
  };
  account?: {
    account_id?: string;
    balance?: string | number;
    currency?: string;
  };
  rating?: {
    rates_map?: Record<string, number | string>;
    imsi?: string;
  };
};

export type SubscriberWebuiMeta = {
  profile_name?: string;
  created_at?: Date;
  updated_at?: Date;
};

export type Open5gsSubscriberDocument = {
  _id?: ObjectId;
  __v?: number;
  schema_version: number;
  imsi: string;
  msisdn: string[];
  imeisv: string[];
  mme_host: string[];
  mm_realm: string[];
  purge_flag: boolean[];
  security: Open5gsSecurity;
  ambr: Open5gsAmbr;
  slice: Open5gsSlice[];
  access_restriction_data: number;
  subscriber_status: number;
  operator_determined_barring: number;
  network_access_mode: number;
  subscribed_rau_tau_timer: number;
  ocs?: SubscriberOcsData;
  webui_meta?: SubscriberWebuiMeta;
  created_at?: Date;
  updated_at?: Date;
};

export type LegacySubscriberState = {
  sub4G: Record<string, unknown> | null;
  pcrf4G: Record<string, unknown> | null;
  auth4G: Record<string, unknown> | null;
  ocsImsi: Record<string, unknown> | null;
  ocsTraffic: Record<string, unknown> | null;
  ocsImsiSet: Record<string, unknown> | null;
  ocsAccount: Record<string, unknown> | null;
};
