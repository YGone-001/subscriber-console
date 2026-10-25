package livetopology

import "subscriber/internal/runtimeinv"

// Evidence levels are deliberately separate. A configured relationship is
// read from deployment configuration; it is never promoted to an observed or
// healthy connection claim.
const (
	EvidenceConfigured = "configured"
)

// Edge states describe runtime presence of both configured endpoints.
const (
	EdgeActive   = "active"
	EdgePartial  = "partial"
	EdgeInactive = "inactive"
	EdgeUnknown  = "unknown"
)

type Endpoint struct {
	Protocol   string `json:"protocol"`
	Address    string `json:"address,omitempty"`
	Port       int    `json:"port,omitempty"`
	SourceFile string `json:"sourceFile,omitempty"`
}

type Node struct {
	ComponentID         string     `json:"componentId"`
	DisplayName         string     `json:"displayName"`
	ProcessName         string     `json:"processName"`
	Role                string     `json:"role,omitempty"`
	NFType              string     `json:"nfType,omitempty"`
	Domain              string     `json:"domain,omitempty"`
	RuntimeStatus       string     `json:"runtimeStatus"`
	StatusReason        string     `json:"statusReason,omitempty"`
	InventoryResourceID string     `json:"inventoryResourceId,omitempty"`
	Listeners           []Endpoint `json:"listeners,omitempty"`
}

type Edge struct {
	EdgeID           string   `json:"edgeId"`
	FromComponentID  string   `json:"fromComponentId"`
	ToComponentID    string   `json:"toComponentId"`
	RelationshipType string   `json:"relationshipType"`
	InterfaceNames   []string `json:"interfaceNames"`
	Protocol         string   `json:"protocol"`
	Evidence         string   `json:"evidence"`
	State            string   `json:"state"`
	FromEndpoint     Endpoint `json:"fromEndpoint"`
	ToEndpoint       Endpoint `json:"toEndpoint"`
	SourceFiles      []string `json:"sourceFiles"`
}

type UnavailableSource struct {
	ComponentID string `json:"componentId,omitempty"`
	File        string `json:"file,omitempty"`
	Reason      string `json:"reason"`
}

type UnresolvedPeer struct {
	ComponentID string `json:"componentId"`
	Protocol    string `json:"protocol"`
	Peer        string `json:"peer"`
	Reason      string `json:"reason"`
}

type ConfigStatus struct {
	ManifestConfigured bool                `json:"manifestConfigured"`
	SourceCount        int                 `json:"sourceCount"`
	AvailableSources   int                 `json:"availableSources"`
	Unavailable        []UnavailableSource `json:"unavailable,omitempty"`
	Complete           bool                `json:"complete"`
}

type RuntimeSummary struct {
	Total            int `json:"total"`
	Running          int `json:"running"`
	Stopped          int `json:"stopped"`
	Unverified       int `json:"unverified"`
	PermissionDenied int `json:"permissionDenied"`
	Unknown          int `json:"unknown"`
	Stale            int `json:"stale"`
	NotDetected      int `json:"notDetected"`
	Expected         int `json:"expected"`
}

type Summary struct {
	NodeCount           int `json:"nodeCount"`
	EdgeCount           int `json:"edgeCount"`
	ConfiguredEdgeCount int `json:"configuredEdgeCount"`
	UnresolvedPeerCount int `json:"unresolvedPeerCount"`
}

type Host struct {
	HostID   string `json:"hostId"`
	HostName string `json:"hostName,omitempty"`
}

type Response struct {
	GeneratedAt    string           `json:"generatedAt"`
	Host           Host             `json:"host"`
	Runtime        RuntimeSummary   `json:"runtime"`
	Config         ConfigStatus     `json:"config"`
	Nodes          []Node           `json:"nodes"`
	Edges          []Edge           `json:"edges"`
	Unresolved     []UnresolvedPeer `json:"unresolvedPeers,omitempty"`
	Summary        Summary          `json:"summary"`
	Reconciliation *Reconciliation  `json:"reconciliation,omitempty"`
}

func runtimeSummary(snapshot *runtimeinv.Snapshot) RuntimeSummary {
	if snapshot == nil {
		return RuntimeSummary{}
	}
	c := snapshot.Counts
	return RuntimeSummary{
		Total:            c.Total,
		Running:          c.Running,
		Stopped:          c.Stopped,
		Unverified:       c.Unverified,
		PermissionDenied: c.PermissionDenied,
		Unknown:          c.Unknown,
		Stale:            c.Stale,
		NotDetected:      c.NotDetected,
		Expected:         c.Expected,
	}
}
