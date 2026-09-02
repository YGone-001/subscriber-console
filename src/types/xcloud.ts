import type { Long, ObjectId } from 'mongodb';

export type XcloudBitrate = {
  value: number;
  unit: number;
};

export type XcloudAmbr = {
  downlink: XcloudBitrate;
  uplink: XcloudBitrate;
};

export type XcloudArp = {
  priority_level: number;
  pre_emption_capability: number;
  pre_emption_vulnerability: number;
};

export type XcloudQos = {
  index: number;
  arp: XcloudArp;
  mbr?: XcloudAmbr;
  gbr?: XcloudAmbr;
};

export type XcloudPccRule = {
  flow?: Array<{
    direction: number;
    description: string;
  }>;
  qos?: XcloudQos;
};

export type XcloudSession = {
  _id?: ObjectId;
  name: string;
  type?: number;
  qos?: XcloudQos;
  ambr?: XcloudAmbr;
  ue?: {
    ipv4?: string;
    ipv6?: string;
  };
  smf?: {
    ipv4?: string;
    ipv6?: string;
  };
  pcc_rule?: XcloudPccRule[];
  lbo_roaming_allowed?: boolean;
};

export type XcloudSlice = {
  _id?: ObjectId;
  sst: number;
  sd?: string;
  default_indicator?: boolean;
  session?: XcloudSession[];
};

export type XcloudSecurity = {
  k?: string;
  op?: string | null;
  opc?: string | null;
  amf?: string;
  rand?: string;
  sqn?: Long | number;
};

export type SubscriberWebuiMeta = {
  profile_name?: string;
  created_at?: Date;
  updated_at?: Date;
};

export type XcloudSubscriberDocument = {
  _id?: ObjectId;
  __v?: number;
  schema_version: number;
  imsi: string;
  msisdn: string[];
  imeisv: string | string[];
  mme_host?: string | string[];
  mme_realm?: string;
  mme_timestamp?: number;
  mm_realm?: string[];
  purge_flag?: boolean | boolean[];
  security: XcloudSecurity;
  ambr: XcloudAmbr;
  slice: XcloudSlice[];
  access_restriction_data: number;
  subscriber_status: number;
  operator_determined_barring?: number;
  network_access_mode: number;
  subscribed_rau_tau_timer: number;
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
  ocsTariffPlan?: Record<string, unknown> | null;
};
