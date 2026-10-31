export type UESourceState = 'ok' | 'unavailable' | 'not_configured' | 'invalid_config';

export type UESource = {
  id: string;
  state: UESourceState;
  reason?: string;
  itemCount: number;
};

export type UEENB = {
  enbId: number;
  cellId: number;
  status: string;
};

export type UELocation = {
  plmn: string;
  tac: number;
  timestamp: number;
};

export type UEAMBR = {
  downlink: number;
  uplink: number;
};

export type UEQoSFlow = {
  ebi: number;
  qci: number;
};

export type UEPDN = {
  apn: string;
  qci: number;
  ebi: number;
  pduState: string;
  qosFlows?: UEQoSFlow[];
  ipv4?: string;
  ipv6?: string;
};

export type UEInfo = {
  supi: string;
  msisdn?: string;
  sipUri?: string;
  domain: string;
  rat: string;
  cmState: string;
  mmState: string;
  enb?: UEENB;
  location?: UELocation;
  ambr?: UEAMBR;
  pdn?: UEPDN[];
  pdnCount: number;
};

export type UESummary = {
  total: number;
  registered: number | null;
  idle: number | null;
  connected: number | null;
  stateUnreported: number;
  epc5gcOnlineUsers: number | null;
  imsOnlineUsers: number | null;
  totalSubscribers: number | null;
  totalIMSUsers: number | null;
};

export type UEPagination = {
  limit: number;
  offset: number;
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type UEInfoResponse = {
  generatedAt: string;
  configured: boolean;
  complete: boolean;
  summary: UESummary;
  sources: UESource[];
  items: UEInfo[];
  pagination: UEPagination;
};

export type UEQuery = {
  summary?: boolean;
  q?: string;
  domain?: '' | 'EPS' | '5GS';
  state?: '' | 'registered' | 'idle' | 'connected' | 'unknown';
  limit?: number;
  cursor?: string;
};
