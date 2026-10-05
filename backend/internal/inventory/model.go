package inventory

import "time"

// SchemaVersion defines the authoritative schema version for inventory resources.
const SchemaVersion = 1

// Resource kinds (20 canonical kinds).
const (
	KindRegion                  = "region"
	KindSite                    = "site"
	KindCluster                 = "cluster"
	KindHost                    = "host"
	KindVirtualMachine          = "virtual_machine"
	KindContainer               = "container"
	KindPod                     = "pod"
	KindNetworkElement          = "network_element"
	KindNetworkFunction         = "network_function"
	KindNetworkFunctionInstance = "network_function_instance"
	KindInterface               = "interface"
	KindIPAddress               = "ip_address"
	KindServiceEndpoint         = "service_endpoint"
	KindPLMN                    = "plmn"
	KindDNN                     = "dnn"
	KindNetworkSlice            = "network_slice"
	KindService                 = "service"
	KindConfiguration           = "configuration"
	KindSoftwareVersion         = "software_version"
	KindDeployment              = "deployment"
)

// Telecom & platform domains (10 canonical domains).
const (
	DomainPlatform  = "platform"
	DomainRAN       = "ran"
	DomainEPC       = "epc"
	DomainIMS       = "ims"
	Domain5GC       = "5gc"
	DomainCharging  = "charging"
	DomainTransport = "transport"
	DomainCloud     = "cloud"
	DomainShared    = "shared"
	DomainOther     = "other"
)

// Lifecycle states (4 canonical states).
const (
	LifecyclePlanned     = "planned"
	LifecycleActive      = "active"
	LifecycleMaintenance = "maintenance"
	LifecycleRetired     = "retired"
)

// Management endpoint protocols (14 canonical protocols).
const (
	ProtocolHTTP     = "http"
	ProtocolHTTPS    = "https"
	ProtocolSSH      = "ssh"
	ProtocolSNMP     = "snmp"
	ProtocolNETCONF  = "netconf"
	ProtocolRESTCONF = "restconf"
	ProtocolGNMI     = "gnmi"
	ProtocolSBI      = "sbi"
	ProtocolSIP      = "sip"
	ProtocolDiameter = "diameter"
	ProtocolPFCP     = "pfcp"
	ProtocolGTP      = "gtp"
	ProtocolNGAP     = "ngap"
	ProtocolOther    = "other"
)

// Management endpoint address types (3 canonical types).
const (
	AddressTypeIPv4 = "ipv4"
	AddressTypeIPv6 = "ipv6"
	AddressTypeFQDN = "fqdn"
)

// Canonical lists for reflection and metadata endpoints.
var CanonicalKinds = []string{
	KindRegion,
	KindSite,
	KindCluster,
	KindHost,
	KindVirtualMachine,
	KindContainer,
	KindPod,
	KindNetworkElement,
	KindNetworkFunction,
	KindNetworkFunctionInstance,
	KindInterface,
	KindIPAddress,
	KindServiceEndpoint,
	KindPLMN,
	KindDNN,
	KindNetworkSlice,
	KindService,
	KindConfiguration,
	KindSoftwareVersion,
	KindDeployment,
}

var CanonicalDomains = []string{
	DomainPlatform,
	DomainRAN,
	DomainEPC,
	DomainIMS,
	Domain5GC,
	DomainCharging,
	DomainTransport,
	DomainCloud,
	DomainShared,
	DomainOther,
}

var CanonicalLifecycleStates = []string{
	LifecyclePlanned,
	LifecycleActive,
	LifecycleMaintenance,
	LifecycleRetired,
}

var CanonicalProtocols = []string{
	ProtocolHTTP,
	ProtocolHTTPS,
	ProtocolSSH,
	ProtocolSNMP,
	ProtocolNETCONF,
	ProtocolRESTCONF,
	ProtocolGNMI,
	ProtocolSBI,
	ProtocolSIP,
	ProtocolDiameter,
	ProtocolPFCP,
	ProtocolGTP,
	ProtocolNGAP,
	ProtocolOther,
}

var CanonicalAddressTypes = []string{
	AddressTypeIPv4,
	AddressTypeIPv6,
	AddressTypeFQDN,
}

// SoftwareMetadata describes software version metadata.
type SoftwareMetadata struct {
	Product string `json:"product,omitempty" bson:"product,omitempty"`
	Version string `json:"version,omitempty" bson:"version,omitempty"`
	Build   string `json:"build,omitempty" bson:"build,omitempty"`
}

// ManagementEndpoint describes an endpoint for network or platform element management.
type ManagementEndpoint struct {
	Name        string `json:"name" bson:"name"`
	Protocol    string `json:"protocol" bson:"protocol"`
	AddressType string `json:"addressType" bson:"addressType"`
	Address     string `json:"address" bson:"address"`
	Port        int    `json:"port" bson:"port"`
	Path        string `json:"path,omitempty" bson:"path,omitempty"`
}

// SourceMetadata describes server-owned provenance for an inventory resource.
type SourceMetadata struct {
	Kind       string `json:"kind" bson:"kind"`
	System     string `json:"system" bson:"system"`
	Authority  string `json:"authority" bson:"authority"`
	ExternalID string `json:"externalId,omitempty" bson:"externalId,omitempty"`
}

// Resource represents a canonical inventory resource stored in MongoDB and returned by the API.
type Resource struct {
	ResourceID          string               `json:"resourceId" bson:"_id"`
	SchemaVersion       int                  `json:"schemaVersion" bson:"schemaVersion"`
	Kind                string               `json:"kind" bson:"kind"`
	Name                string               `json:"name" bson:"name"`
	NameNormalized      string               `json:"-" bson:"nameNormalized"`
	DisplayName         string               `json:"displayName,omitempty" bson:"displayName,omitempty"`
	Description         string               `json:"description,omitempty" bson:"description,omitempty"`
	Domain              string               `json:"domain" bson:"domain"`
	Role                string               `json:"role,omitempty" bson:"role,omitempty"`
	LifecycleState      string               `json:"lifecycleState" bson:"lifecycleState"`
	Vendor              string               `json:"vendor,omitempty" bson:"vendor,omitempty"`
	Model               string               `json:"model,omitempty" bson:"model,omitempty"`
	Software            *SoftwareMetadata    `json:"software,omitempty" bson:"software,omitempty"`
	ManagementEndpoints []ManagementEndpoint `json:"managementEndpoints,omitempty" bson:"managementEndpoints,omitempty"`
	Capabilities        []string             `json:"capabilities,omitempty" bson:"capabilities,omitempty"`
	Labels              map[string]string    `json:"labels,omitempty" bson:"labels,omitempty"`
	Attributes          map[string]any       `json:"attributes,omitempty" bson:"attributes,omitempty"`
	Source              SourceMetadata       `json:"source" bson:"source"`
	Revision            int64                `json:"revision" bson:"revision"`
	CreatedAt           string               `json:"createdAt" bson:"createdAt"`
	CreatedBy           string               `json:"createdBy" bson:"createdBy"`
	UpdatedAt           string               `json:"updatedAt" bson:"updatedAt"`
	UpdatedBy           string               `json:"updatedBy" bson:"updatedBy"`
}

// CreateResourceRequest defines the request body for POST /api/inventory/resources.
type CreateResourceRequest struct {
	Kind                string               `json:"kind"`
	Name                string               `json:"name"`
	DisplayName         string               `json:"displayName,omitempty"`
	Description         string               `json:"description,omitempty"`
	Domain              string               `json:"domain"`
	Role                string               `json:"role,omitempty"`
	LifecycleState      string               `json:"lifecycleState,omitempty"`
	Vendor              string               `json:"vendor,omitempty"`
	Model               string               `json:"model,omitempty"`
	Software            *SoftwareMetadata    `json:"software,omitempty"`
	ManagementEndpoints []ManagementEndpoint `json:"managementEndpoints,omitempty"`
	Capabilities        []string             `json:"capabilities,omitempty"`
	Labels              map[string]string    `json:"labels,omitempty"`
	Attributes          map[string]any       `json:"attributes,omitempty"`
}

// MutableResource represents the mutable state of a resource in update requests.
type MutableResource struct {
	Kind                string               `json:"kind"`
	Name                string               `json:"name"`
	DisplayName         string               `json:"displayName,omitempty"`
	Description         string               `json:"description,omitempty"`
	Domain              string               `json:"domain"`
	Role                string               `json:"role,omitempty"`
	LifecycleState      string               `json:"lifecycleState,omitempty"`
	Vendor              string               `json:"vendor,omitempty"`
	Model               string               `json:"model,omitempty"`
	Software            *SoftwareMetadata    `json:"software,omitempty"`
	ManagementEndpoints []ManagementEndpoint `json:"managementEndpoints,omitempty"`
	Capabilities        []string             `json:"capabilities,omitempty"`
	Labels              map[string]string    `json:"labels,omitempty"`
	Attributes          map[string]any       `json:"attributes,omitempty"`
}

// UpdateResourceRequest defines the request body for PUT /api/inventory/resources/{resourceId}.
type UpdateResourceRequest struct {
	ExpectedRevision int64           `json:"expectedRevision"`
	Resource         MutableResource `json:"resource"`
}

// RetireResourceRequest defines the request body for POST /api/inventory/resources/{resourceId}/retire.
type RetireResourceRequest struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	Reason           string `json:"reason"`
}

// MetaResponse defines the response payload for GET /api/inventory/meta.
type MetaResponse struct {
	SchemaVersion       int      `json:"schemaVersion"`
	Kinds               []string `json:"kinds"`
	Domains             []string `json:"domains"`
	LifecycleStates     []string `json:"lifecycleStates"`
	ManagementProtocols []string `json:"managementProtocols"`
	AddressTypes        []string `json:"addressTypes"`
}

// PageInfo represents pagination cursor metadata in list responses.
type PageInfo struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}

// ListResourcesResponse defines the response payload for GET /api/inventory/resources.
type ListResourcesResponse struct {
	Resources []Resource `json:"resources"`
	Page      PageInfo   `json:"page"`
}

// CurrentTimestamp returns an RFC3339 formatted UTC timestamp.
func CurrentTimestamp() string {
	return time.Now().UTC().Format(time.RFC3339)
}
