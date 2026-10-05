export type ResourceKind =
  | 'region'
  | 'site'
  | 'cluster'
  | 'host'
  | 'virtual_machine'
  | 'container'
  | 'pod'
  | 'network_element'
  | 'network_function'
  | 'network_function_instance'
  | 'interface'
  | 'ip_address'
  | 'service_endpoint'
  | 'plmn'
  | 'dnn'
  | 'network_slice'
  | 'service'
  | 'configuration'
  | 'software_version'
  | 'deployment';

export type TelecomDomain =
  | 'platform'
  | 'ran'
  | 'epc'
  | 'ims'
  | '5gc'
  | 'charging'
  | 'transport'
  | 'cloud'
  | 'shared'
  | 'other';

export type LifecycleState =
  | 'planned'
  | 'active'
  | 'maintenance'
  | 'retired';

export type ManagementProtocol =
  | 'http'
  | 'https'
  | 'ssh'
  | 'snmp'
  | 'netconf'
  | 'restconf'
  | 'gnmi'
  | 'sbi'
  | 'sip'
  | 'diameter'
  | 'pfcp'
  | 'gtp'
  | 'ngap'
  | 'other';

export type AddressType = 'ipv4' | 'ipv6' | 'fqdn';

export interface SoftwareMetadata {
  product?: string;
  version?: string;
  build?: string;
}

export interface ManagementEndpoint {
  name: string;
  protocol: ManagementProtocol | string;
  addressType: AddressType | string;
  address: string;
  port: number;
  path?: string;
}

export interface SourceMetadata {
  kind: string;
  system: string;
  authority: string;
  externalId?: string;
}

export interface Resource {
  resourceId: string;
  schemaVersion: number;
  kind: ResourceKind | string;
  name: string;
  displayName?: string;
  description?: string;
  domain: TelecomDomain | string;
  role?: string;
  lifecycleState: LifecycleState | string;
  vendor?: string;
  model?: string;
  software?: SoftwareMetadata;
  managementEndpoints?: ManagementEndpoint[];
  capabilities?: string[];
  labels?: Record<string, string>;
  attributes?: Record<string, unknown>;
  source: SourceMetadata;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CreateResourceRequest {
  kind: string;
  name: string;
  displayName?: string;
  description?: string;
  domain: string;
  role?: string;
  lifecycleState?: string;
  vendor?: string;
  model?: string;
  software?: SoftwareMetadata;
  managementEndpoints?: ManagementEndpoint[];
  capabilities?: string[];
  labels?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

export interface MutableResource {
  kind: string;
  name: string;
  displayName?: string;
  description?: string;
  domain: string;
  role?: string;
  lifecycleState?: string;
  vendor?: string;
  model?: string;
  software?: SoftwareMetadata;
  managementEndpoints?: ManagementEndpoint[];
  capabilities?: string[];
  labels?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

export interface UpdateResourceRequest {
  expectedRevision: number;
  resource: MutableResource;
}

export interface RetireResourceRequest {
  expectedRevision: number;
  reason: string;
}

export interface MetaResponse {
  schemaVersion: number;
  kinds: string[];
  domains: string[];
  lifecycleStates: string[];
  managementProtocols: string[];
  addressTypes: string[];
}

export type InventoryMetaResponse = MetaResponse;

export interface PageInfo {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListResourcesResponse {
  resources: Resource[];
  page: PageInfo;
}

export interface ResourceListQueryParams {
  kind?: string;
  domain?: string;
  lifecycleState?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}
