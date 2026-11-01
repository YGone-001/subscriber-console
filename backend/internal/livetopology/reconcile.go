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

// A coarse pair match is not an interface match. The verdict below refines the
// pair-level grade without changing it: `agrees` means every configured
// interface is declared and every declared interface is configured, `partial`
// means some interface is confirmed while the rest stays uncovered on one side,
// and `differs` means both sides are annotated but share no interface. A
// declaration that no evidence covers is never graded as an error on its own.
const (
	InterfaceVerdictPartial = "partial"

	InterfaceStatusMatched         = "matched"
	InterfaceStatusEvidenceOnly    = "evidence_only"
	InterfaceStatusDeclarationOnly = "declaration_only"

	ClaimDirectionForward = "forward"
	ClaimDirectionReverse = "reverse"

	// InterfaceRulesVersion names the comparison rules behind InterfaceVerdict
	// and InterfaceCoverage. A consumer that caches a verdict must key it on this
	// version so a rule change is never read as a data change.
	InterfaceRulesVersion = "interface-v1"
)

// InterfaceCoverage is the per-interface result inside one resource pair. Every
// interface is graded on its own so a pair with one confirmed reference point is
// never summarised as a full agreement.
type InterfaceCoverage struct {
	Interface string `json:"interface"`
	Evidence  bool   `json:"evidence"`
	Declared  bool   `json:"declared"`
	Status    string `json:"status"`
}

// DeclaredClaim is one persisted relationship that covers the pair. The ledger
// may hold several types or directions for the same two resources; a coarse
// match must not hide them behind the first one it happens to read.
type DeclaredClaim struct {
	EdgeID           string   `json:"edgeId"`
	RelationshipType string   `json:"relationshipType"`
	Direction        string   `json:"direction,omitempty"`
	InterfaceNames   []string `json:"interfaceNames,omitempty"`
}

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
	FromResourceID         string              `json:"fromResourceId"`
	ToResourceID           string              `json:"toResourceId"`
	FromComponentID        string              `json:"fromComponentId,omitempty"`
	ToComponentID          string              `json:"toComponentId,omitempty"`
	ConfiguredEdgeID       string              `json:"configuredEdgeId,omitempty"`
	EdgeID                 string              `json:"edgeId,omitempty"`
	RelationshipType       string              `json:"relationshipType,omitempty"`
	InterfaceNames         []string            `json:"interfaceNames,omitempty"`
	DeclaredInterfaceNames []string            `json:"declaredInterfaceNames,omitempty"`
	InterfaceMatch         string              `json:"interfaceMatch,omitempty"`
	InterfaceVerdict       string              `json:"interfaceVerdict,omitempty"`
	InterfaceCoverage      []InterfaceCoverage `json:"interfaceCoverage,omitempty"`
	DeclaredClaims         []DeclaredClaim     `json:"declaredClaims,omitempty"`
	Protocol               string              `json:"protocol,omitempty"`
	SourceFiles            []string            `json:"sourceFiles,omitempty"`
	Retired                bool                `json:"retired,omitempty"`
}

// Reconciliation compares the persisted ledger with the configured evidence in
// this projection. Both sets stay exactly as authoritative as they were: the
// comparison is advisory and changes nothing.
type Reconciliation struct {
	Available               bool                 `json:"available"`
	Reason                  string               `json:"reason,omitempty"`
	Complete                bool                 `json:"complete"`
	RulesVersion            string               `json:"rulesVersion,omitempty"`
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
	out.RulesVersion = InterfaceRulesVersion

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
	activeAll := make(map[string][]DeclaredEdge)
	retired := make(map[string]DeclaredEdge)
	for _, edge := range declared {
		key := pairKey(edge.FromResourceID, edge.ToResourceID)
		switch edge.LifecycleState {
		case lifecycleActive:
			/* The coarse match keeps the first declaration per pair (its original
			 * meaning), while every declaration is retained for the interface
			 * level comparison: a second type or reverse direction on the same
			 * pair is evidence, not noise. */
			activeAll[key] = append(activeAll[key], edge)
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
			declaredNames := declaredInterfaceUnion(activeAll[key])
			item.InterfaceCoverage = interfaceCoverage(edge.InterfaceNames, declaredNames)
			item.InterfaceVerdict = interfaceVerdict(edge.InterfaceNames, declaredNames, item.InterfaceCoverage)
			item.DeclaredClaims = declaredClaims(from, to, activeAll[key])
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
			DeclaredClaims:         declaredClaims("", "", activeAll[key]),
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

func canonicalInterface(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// declaredInterfaceUnion lists every interface announced by any active
// declaration on the pair, in read order and without case duplicates.
func declaredInterfaceUnion(edges []DeclaredEdge) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(edges))
	for _, edge := range edges {
		for _, name := range edge.InterfaceNames {
			key := canonicalInterface(name)
			if key == "" {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, strings.TrimSpace(name))
		}
	}
	return out
}

// interfaceCoverage grades each interface on its own. The union of both sides is
// reported so a configured reference point that no declaration covers and a
// declaration that this evidence does not cover stay visibly different states.
func interfaceCoverage(evidence, declared []string) []InterfaceCoverage {
	if len(evidence) == 0 && len(declared) == 0 {
		return nil
	}
	index := make(map[string]int)
	out := make([]InterfaceCoverage, 0, len(evidence)+len(declared))
	add := func(name string, isEvidence bool) {
		key := canonicalInterface(name)
		if key == "" {
			return
		}
		if at, ok := index[key]; ok {
			if isEvidence {
				out[at].Evidence = true
			} else {
				out[at].Declared = true
			}
			return
		}
		item := InterfaceCoverage{Interface: strings.TrimSpace(name)}
		if isEvidence {
			item.Evidence = true
		} else {
			item.Declared = true
		}
		index[key] = len(out)
		out = append(out, item)
	}
	for _, name := range evidence {
		add(name, true)
	}
	for _, name := range declared {
		add(name, false)
	}
	for at := range out {
		switch {
		case out[at].Evidence && out[at].Declared:
			out[at].Status = InterfaceStatusMatched
		case out[at].Evidence:
			out[at].Status = InterfaceStatusEvidenceOnly
		default:
			out[at].Status = InterfaceStatusDeclarationOnly
		}
	}
	return out
}

// interfaceVerdict summarises the per-interface coverage of one pair. A
// declaration-only interface is not an error: the evidence may simply not
// describe it, so the pair is partial rather than wrong.
func interfaceVerdict(evidence, declared []string, coverage []InterfaceCoverage) string {
	if len(evidence) == 0 || len(declared) == 0 {
		return InterfaceMatchUnannotated
	}
	matched, evidenceOnly, declarationOnly := 0, 0, 0
	for _, item := range coverage {
		switch item.Status {
		case InterfaceStatusMatched:
			matched++
		case InterfaceStatusEvidenceOnly:
			evidenceOnly++
		default:
			declarationOnly++
		}
	}
	switch {
	case matched == 0:
		return InterfaceMatchDiffers
	case evidenceOnly == 0 && declarationOnly == 0:
		return InterfaceMatchAgrees
	default:
		return InterfaceVerdictPartial
	}
}

// declaredClaims keeps every active declaration on the pair, with the direction
// relative to the configured evidence. Direction is left empty when there is no
// evidence to compare against rather than being invented.
func declaredClaims(from, to string, edges []DeclaredEdge) []DeclaredClaim {
	if len(edges) == 0 {
		return nil
	}
	out := make([]DeclaredClaim, 0, len(edges))
	for _, edge := range edges {
		direction := ""
		if from != "" && to != "" {
			if edge.FromResourceID == from && edge.ToResourceID == to {
				direction = ClaimDirectionForward
			} else {
				direction = ClaimDirectionReverse
			}
		}
		out = append(out, DeclaredClaim{
			EdgeID:           edge.EdgeID,
			RelationshipType: edge.RelationshipType,
			Direction:        direction,
			InterfaceNames:   edge.InterfaceNames,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].EdgeID < out[j].EdgeID })
	return out
}

func sortItems(items []ReconciliationItem) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].FromResourceID != items[j].FromResourceID {
			return items[i].FromResourceID < items[j].FromResourceID
		}
		return items[i].ToResourceID < items[j].ToResourceID
	})
}
