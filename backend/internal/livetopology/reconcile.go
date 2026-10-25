package livetopology

import (
	"context"
	"sort"
	"strings"
)

// DeclaredEdge is the minimal persisted-relationship fact the reconciliation
// needs. The live projection reads the ledger and never writes any of it back.
type DeclaredEdge struct {
	EdgeID           string
	FromResourceID   string
	ToResourceID     string
	RelationshipType string
	LifecycleState   string
	InterfaceNames   []string
}

// DeclaredLedger reads the persisted relationship ledger. complete is false when
// the reader could not return the whole ledger: a truncated set must never be
// presented as a clean diff, so it caps the reconciliation at partial instead.
type DeclaredLedger interface {
	ListDeclared(ctx context.Context) (edges []DeclaredEdge, complete bool, err error)
}

// Interface match grades between a configured link and the declaration that
// covers the same resource pair. Absence of annotation on either side is its own
// state and is never reported as a disagreement.
const (
	InterfaceMatchAgrees      = "agrees"
	InterfaceMatchDiffers     = "differs"
	InterfaceMatchUnannotated = "unannotated"
)

const (
	ReconciliationReasonUnavailable = "ledger_unavailable"

	lifecycleActive  = "active"
	lifecycleRetired = "retired"
)

// ReconciliationItem is one side of a diff. It never claims a relationship is
// wrong: a declaration without configured evidence may simply be a link this
// manifest does not describe, and a configured link may be deliberately
// undeclared.
type ReconciliationItem struct {
	FromResourceID         string   `json:"fromResourceId"`
	ToResourceID           string   `json:"toResourceId"`
	FromComponentID        string   `json:"fromComponentId,omitempty"`
	ToComponentID          string   `json:"toComponentId,omitempty"`
	ConfiguredEdgeID       string   `json:"configuredEdgeId,omitempty"`
	EdgeID                 string   `json:"edgeId,omitempty"`
	RelationshipType       string   `json:"relationshipType,omitempty"`
	InterfaceNames         []string `json:"interfaceNames,omitempty"`
	DeclaredInterfaceNames []string `json:"declaredInterfaceNames,omitempty"`
	InterfaceMatch         string   `json:"interfaceMatch,omitempty"`
	Protocol               string   `json:"protocol,omitempty"`
	SourceFiles            []string `json:"sourceFiles,omitempty"`
	Retired                bool     `json:"retired,omitempty"`
}

// Reconciliation compares the persisted ledger with the configured evidence in
// this projection. Both sets stay exactly as authoritative as they were: the
// comparison is advisory and changes nothing.
type Reconciliation struct {
	Available               bool                 `json:"available"`
	Reason                  string               `json:"reason,omitempty"`
	Complete                bool                 `json:"complete"`
	ConfiguredLinks         int                  `json:"configuredLinks"`
	DeclaredEdges           int                  `json:"declaredEdges"`
	MatchedCount            int                  `json:"matchedCount"`
	Matched                 []ReconciliationItem `json:"matched"`
	UndeclaredEvidence      []ReconciliationItem `json:"undeclaredEvidence"`
	UnevidencedDeclarations []ReconciliationItem `json:"unevidencedDeclarations"`
}

// Reconcile diffs configured links against declared edges. Matching is by
// unordered resource pair because configuration files state a peer without
// declaring which side of the reference point documented it.
func Reconcile(nodes []Node, edges []Edge, declared []DeclaredEdge, complete bool, err error) *Reconciliation {
	out := &Reconciliation{
		Matched:                 []ReconciliationItem{},
		UndeclaredEvidence:      []ReconciliationItem{},
		UnevidencedDeclarations: []ReconciliationItem{},
	}
	if err != nil {
		out.Reason = ReconciliationReasonUnavailable
		return out
	}
	out.Available = true
	out.Complete = complete

	resourceOf := make(map[string]string, len(nodes))
	componentOf := make(map[string]string, len(nodes))
	for _, node := range nodes {
		if node.InventoryResourceID == "" {
			continue
		}
		resourceOf[node.ComponentID] = node.InventoryResourceID
		componentOf[node.InventoryResourceID] = node.ComponentID
	}

	active := make(map[string]DeclaredEdge)
	retired := make(map[string]DeclaredEdge)
	for _, edge := range declared {
		key := pairKey(edge.FromResourceID, edge.ToResourceID)
		switch edge.LifecycleState {
		case lifecycleActive:
			if _, seen := active[key]; !seen {
				active[key] = edge
				out.DeclaredEdges++
			}
		case lifecycleRetired:
			if _, seen := retired[key]; !seen {
				retired[key] = edge
			}
		}
	}

	evidenced := make(map[string]bool, len(edges))
	for _, edge := range edges {
		from := resourceOf[edge.FromComponentID]
		to := resourceOf[edge.ToComponentID]
		if from == "" || to == "" {
			// Evidence whose endpoint is not an Inventory resource cannot be
			// reconciled at all, so it is counted out rather than guessed in.
			continue
		}
		out.ConfiguredLinks++
		key := pairKey(from, to)
		evidenced[key] = true

		item := ReconciliationItem{
			FromResourceID:   from,
			ToResourceID:     to,
			FromComponentID:  edge.FromComponentID,
			ToComponentID:    edge.ToComponentID,
			ConfiguredEdgeID: edge.EdgeID,
			InterfaceNames:   edge.InterfaceNames,
			Protocol:         edge.Protocol,
			SourceFiles:      edge.SourceFiles,
			RelationshipType: edge.RelationshipType,
		}
		if declaredEdge, ok := active[key]; ok {
			out.MatchedCount++
			item.EdgeID = declaredEdge.EdgeID
			item.RelationshipType = declaredEdge.RelationshipType
			item.DeclaredInterfaceNames = declaredEdge.InterfaceNames
			item.InterfaceMatch = matchInterfaces(edge.InterfaceNames, declaredEdge.InterfaceNames)
			out.Matched = append(out.Matched, item)
			continue
		}
		if declaredEdge, ok := retired[key]; ok {
			item.EdgeID = declaredEdge.EdgeID
			item.RelationshipType = declaredEdge.RelationshipType
			item.Retired = true
		}
		out.UndeclaredEvidence = append(out.UndeclaredEvidence, item)
	}

	for key, declaredEdge := range active {
		if evidenced[key] {
			continue
		}
		out.UnevidencedDeclarations = append(out.UnevidencedDeclarations, ReconciliationItem{
			FromResourceID:         declaredEdge.FromResourceID,
			ToResourceID:           declaredEdge.ToResourceID,
			FromComponentID:        componentOf[declaredEdge.FromResourceID],
			ToComponentID:          componentOf[declaredEdge.ToResourceID],
			EdgeID:                 declaredEdge.EdgeID,
			RelationshipType:       declaredEdge.RelationshipType,
			DeclaredInterfaceNames: declaredEdge.InterfaceNames,
		})
	}

	sortItems(out.Matched)
	sortItems(out.UndeclaredEvidence)
	sortItems(out.UnevidencedDeclarations)
	return out
}

func pairKey(a, b string) string {
	if b < a {
		a, b = b, a
	}
	return a + "|" + b
}

func matchInterfaces(evidence, declared []string) string {
	if len(evidence) == 0 || len(declared) == 0 {
		return InterfaceMatchUnannotated
	}
	for _, left := range evidence {
		for _, right := range declared {
			if strings.EqualFold(strings.TrimSpace(left), strings.TrimSpace(right)) {
				return InterfaceMatchAgrees
			}
		}
	}
	return InterfaceMatchDiffers
}

func sortItems(items []ReconciliationItem) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].FromResourceID != items[j].FromResourceID {
			return items[i].FromResourceID < items[j].FromResourceID
		}
		return items[i].ToResourceID < items[j].ToResourceID
	})
}
