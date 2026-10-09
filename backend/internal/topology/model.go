package topology

import "time"

// SchemaVersion defines the authoritative schema version for topology edges.
const SchemaVersion = 1

// CollectionName is the single operational collection owned by topology.
// Topology owns EDGES only; Inventory remains the sole owner of NODES.
const CollectionName = "app_topology_edges"

// Canonical directed relationship types (9).
//
// These are manually declared logical relationships. They do NOT prove live
// interface connectivity, registration success or service health.
const (
	RelationshipContains      = "contains"
	RelationshipRunsOn        = "runs_on"
	RelationshipDependsOn     = "depends_on"
	RelationshipConnectsTo    = "connects_to"
	RelationshipRoutesTo      = "routes_to"
	RelationshipRegistersWith = "registers_with"
	RelationshipServes        = "serves"
	RelationshipUses          = "uses"
	RelationshipExposes       = "exposes"
)

// Canonical lifecycle states (2).
const (
	LifecycleActive  = "active"
	LifecycleRetired = "retired"
)

// Canonical neighbor query directions.
const (
	DirectionInbound  = "inbound"
	DirectionOutbound = "outbound"
	DirectionBoth     = "both"
)

// CanonicalLists for reflection through GET /api/topology/meta.
var CanonicalRelationshipTypes = []string{
	RelationshipContains,
	RelationshipRunsOn,
	RelationshipDependsOn,
	RelationshipConnectsTo,
	RelationshipRoutesTo,
	RelationshipRegistersWith,
	RelationshipServes,
	RelationshipUses,
	RelationshipExposes,
}

var CanonicalLifecycleStates = []string{
	LifecycleActive,
	LifecycleRetired,
}

var CanonicalDirections = []string{
	DirectionInbound,
	DirectionOutbound,
	DirectionBoth,
}

// SourceMetadata is server-owned provenance for a topology edge.
type SourceMetadata struct {
	Kind      string `json:"kind" bson:"kind"`
	System    string `json:"system" bson:"system"`
	Authority string `json:"authority" bson:"authority"`
}

// Edge is the canonical topology relationship between two Inventory resources.
//
// Edge endpoints reference existing Inventory UUIDs. Topology never stores a
// second copy of Inventory identity, classification or lifecycle.
type Edge struct {
	EdgeID           string            `json:"edgeId" bson:"_id"`
	SchemaVersion    int               `json:"schemaVersion" bson:"schemaVersion"`
	RelationshipType string            `json:"relationshipType" bson:"relationshipType"`
	FromResourceID   string            `json:"fromResourceId" bson:"fromResourceId"`
	ToResourceID     string            `json:"toResourceId" bson:"toResourceId"`
	Description      string            `json:"description,omitempty" bson:"description,omitempty"`
	Labels           map[string]string `json:"labels,omitempty" bson:"labels,omitempty"`
	Attributes       map[string]any    `json:"attributes,omitempty" bson:"attributes,omitempty"`
	LifecycleState   string            `json:"lifecycleState" bson:"lifecycleState"`
	Source           SourceMetadata    `json:"source" bson:"source"`
	Revision         int64             `json:"revision" bson:"revision"`
	CreatedAt        string            `json:"createdAt" bson:"createdAt"`
	CreatedBy        string            `json:"createdBy" bson:"createdBy"`
	UpdatedAt        string            `json:"updatedAt" bson:"updatedAt"`
	UpdatedBy        string            `json:"updatedBy" bson:"updatedBy"`
}

// CreateEdgeRequest is the request body for POST /api/topology/edges.
// Only these five fields are accepted; every server-owned field is rejected.
type CreateEdgeRequest struct {
	RelationshipType string            `json:"relationshipType"`
	FromResourceID   string            `json:"fromResourceId"`
	ToResourceID     string            `json:"toResourceId"`
	Description      string            `json:"description,omitempty"`
	Labels           map[string]string `json:"labels,omitempty"`
	Attributes       map[string]any    `json:"attributes,omitempty"`
}

// MutableEdge carries the only metadata an update may replace.
type MutableEdge struct {
	Description string            `json:"description,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Attributes  map[string]any    `json:"attributes,omitempty"`
}

// UpdateEdgeRequest is the request body for PUT /api/topology/edges/{edgeId}.
// Relationship identity is immutable and therefore not accepted here.
type UpdateEdgeRequest struct {
	ExpectedRevision int64       `json:"expectedRevision"`
	Edge             MutableEdge `json:"edge"`
}

// RetireEdgeRequest is the request body for POST /api/topology/edges/{edgeId}/retire.
type RetireEdgeRequest struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	Reason           string `json:"reason"`
}

// MetaResponse is the payload for GET /api/topology/meta.
type MetaResponse struct {
	SchemaVersion     int      `json:"schemaVersion"`
	RelationshipTypes []string `json:"relationshipTypes"`
	LifecycleStates   []string `json:"lifecycleStates"`
}

// PageInfo is the opaque cursor pagination metadata in list responses.
type PageInfo struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}

// ListEdgesResponse is the payload for GET /api/topology/edges.
type ListEdgesResponse struct {
	Edges []Edge   `json:"edges"`
	Page  PageInfo `json:"page"`
}

// ResourceProjection is a read-only hydrated view of an Inventory resource.
// It is derived at read time and never persisted inside a topology edge.
type ResourceProjection struct {
	ResourceID     string `json:"resourceId"`
	Kind           string `json:"kind"`
	Name           string `json:"name"`
	DisplayName    string `json:"displayName,omitempty"`
	Domain         string `json:"domain"`
	Role           string `json:"role,omitempty"`
	LifecycleState string `json:"lifecycleState"`
}

// Neighbor is a one-hop relationship entry relative to a requested root resource.
type Neighbor struct {
	Edge             Edge               `json:"edge"`
	Direction        string             `json:"direction"`
	NeighborResource ResourceProjection `json:"neighborResource"`
}

// NeighborsResponse is the payload for
// GET /api/topology/resources/{resourceId}/neighbors.
type NeighborsResponse struct {
	RootResource ResourceProjection `json:"rootResource"`
	Neighbors    []Neighbor         `json:"neighbors"`
	Page         PageInfo           `json:"page"`
}

// CurrentTimestamp returns an RFC3339 formatted UTC timestamp.
func CurrentTimestamp() string {
	return time.Now().UTC().Format(time.RFC3339)
}
