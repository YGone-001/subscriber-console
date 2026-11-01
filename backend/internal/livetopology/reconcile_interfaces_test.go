package livetopology

import "testing"

func coverageByInterface(item ReconciliationItem) map[string]string {
	out := make(map[string]string, len(item.InterfaceCoverage))
	for _, entry := range item.InterfaceCoverage {
		out[entry.Interface] = entry.Status
	}
	return out
}

func matchedItem(t *testing.T, got *Reconciliation, fromComponent, toComponent string) ReconciliationItem {
	t.Helper()
	for _, item := range got.Matched {
		if item.FromComponentID == fromComponent && item.ToComponentID == toComponent {
			return item
		}
	}
	t.Fatalf("expected a matched pair %s->%s, got %+v", fromComponent, toComponent, got.Matched)
	return ReconciliationItem{}
}

/* A pair with one confirmed reference point must not be summarised as a full
 * agreement. The legacy `interfaceMatch` keeps its original meaning. */
func TestInterfaceVerdictIsPartialWhenDeclarationsOutrunEvidence(t *testing.T) {
	nodes := []Node{node("smf", "r-smf"), node("upf", "r-upf")}
	edges := []Edge{evidenceEdge("smf", "upf", []string{"N4"})}
	declared := []DeclaredEdge{declaredEdges("r-smf", "r-upf", "connects_to", "edge-1", []string{"N4", "N6"})}

	got := Reconcile(nodes, edges, declared, true, nil)
	if got.RulesVersion != InterfaceRulesVersion {
		t.Fatalf("the verdict must name its rule version, got %q", got.RulesVersion)
	}
	item := matchedItem(t, got, "smf", "upf")
	if item.InterfaceMatch != InterfaceMatchAgrees {
		t.Fatalf("the legacy pair grade must stay unchanged, got %q", item.InterfaceMatch)
	}
	if item.InterfaceVerdict != InterfaceVerdictPartial {
		t.Fatalf("an uncovered declaration makes the pair partial, got %q", item.InterfaceVerdict)
	}
	statuses := coverageByInterface(item)
	if statuses["N4"] != InterfaceStatusMatched {
		t.Fatalf("N4 is both configured and declared, got %q", statuses["N4"])
	}
	if statuses["N6"] != InterfaceStatusDeclarationOnly {
		t.Fatalf("N6 is declared without coverage, got %q", statuses["N6"])
	}
}

/* A configured reference point that no declaration covers is a different state
 * from a declaration this evidence does not cover. Both make the pair partial;
 * neither may be reported as a full agreement. */
func TestInterfaceVerdictIsPartialWhenEvidenceOutrunsDeclarations(t *testing.T) {
	nodes := []Node{node("sgwc", "r-sgwc"), node("sgwu", "r-sgwu")}
	edges := []Edge{evidenceEdge("sgwc", "sgwu", []string{"Sxa", "Sxb"})}
	declared := []DeclaredEdge{declaredEdges("r-sgwc", "r-sgwu", "connects_to", "edge-2", []string{"Sxa"})}

	got := Reconcile(nodes, edges, declared, true, nil)
	item := matchedItem(t, got, "sgwc", "sgwu")
	if item.InterfaceVerdict != InterfaceVerdictPartial {
		t.Fatalf("an undeclared configured interface makes the pair partial, got %q", item.InterfaceVerdict)
	}
	statuses := coverageByInterface(item)
	if statuses["Sxa"] != InterfaceStatusMatched {
		t.Fatalf("Sxa is configured and declared, got %q", statuses["Sxa"])
	}
	if statuses["Sxb"] != InterfaceStatusEvidenceOnly {
		t.Fatalf("Sxb is configured but not declared, got %q", statuses["Sxb"])
	}
}

func TestInterfaceVerdictDiffersWhenBothSidesAreAnnotatedAndDisjoint(t *testing.T) {
	nodes := []Node{node("a", "r-a"), node("b", "r-b")}
	edges := []Edge{evidenceEdge("a", "b", []string{"N4"})}
	declared := []DeclaredEdge{declaredEdges("r-a", "r-b", "connects_to", "edge-3", []string{"Sxb"})}

	got := Reconcile(nodes, edges, declared, true, nil)
	item := matchedItem(t, got, "a", "b")
	if item.InterfaceVerdict != InterfaceMatchDiffers {
		t.Fatalf("disjoint annotations must differ, got %q", item.InterfaceVerdict)
	}
}

func TestInterfaceVerdictStaysUnannotatedWhenOneSideHasNoInterfaces(t *testing.T) {
	nodes := []Node{node("a", "r-a"), node("b", "r-b")}
	edges := []Edge{evidenceEdge("a", "b", nil)}
	declared := []DeclaredEdge{declaredEdges("r-a", "r-b", "connects_to", "edge-4", []string{"N4"})}

	got := Reconcile(nodes, edges, declared, true, nil)
	item := matchedItem(t, got, "a", "b")
	if item.InterfaceVerdict != InterfaceMatchUnannotated {
		t.Fatalf("missing annotation is its own state, got %q", item.InterfaceVerdict)
	}
	if statuses := coverageByInterface(item); statuses["N4"] != InterfaceStatusDeclarationOnly {
		t.Fatalf("the only annotation must still be listed, got %+v", item.InterfaceCoverage)
	}
}

/* Selecting one declaration per pair for the coarse grade must not discard the
 * others: a second type and the reverse direction are still reported. */
func TestDeclaredClaimsKeepEveryRelationOnTheSamePair(t *testing.T) {
	nodes := []Node{node("pcscf", "r-pcscf"), node("pcrf", "r-pcrf")}
	edges := []Edge{evidenceEdge("pcscf", "pcrf", []string{"Rx"})}
	declared := []DeclaredEdge{
		declaredEdges("r-pcscf", "r-pcrf", "connects_to", "edge-a", []string{"Rx"}),
		declaredEdges("r-pcrf", "r-pcscf", "depends_on", "edge-b", []string{"Rx"}),
		declaredEdges("r-pcscf", "r-pcrf", "connects_to", "edge-c", nil),
	}

	got := Reconcile(nodes, edges, declared, true, nil)
	if got.DeclaredEdges != 1 || got.MatchedCount != 1 {
		t.Fatalf("the coarse counts must keep their original per-pair meaning, got %+v", got)
	}
	item := matchedItem(t, got, "pcscf", "pcrf")
	if len(item.DeclaredClaims) != 3 {
		t.Fatalf("every active declaration must be retained, got %+v", item.DeclaredClaims)
	}
	byEdge := map[string]DeclaredClaim{}
	for _, claim := range item.DeclaredClaims {
		byEdge[claim.EdgeID] = claim
	}
	if byEdge["edge-a"].Direction != ClaimDirectionForward {
		t.Fatalf("a declaration in the evidence direction is forward, got %+v", byEdge["edge-a"])
	}
	if byEdge["edge-b"].Direction != ClaimDirectionReverse {
		t.Fatalf("a declaration against the evidence direction is reverse, got %+v", byEdge["edge-b"])
	}
	if byEdge["edge-b"].RelationshipType != "depends_on" {
		t.Fatalf("the claim must keep its own relationship type, got %+v", byEdge["edge-b"])
	}
}

/* Unevidenced declarations keep their claims but have no direction to report. */
func TestUnevidencedDeclarationsKeepClaimsWithoutInventingDirection(t *testing.T) {
	nodes := []Node{node("a", "r-a"), node("b", "r-b")}
	var edges []Edge
	declared := []DeclaredEdge{
		declaredEdges("r-a", "r-b", "connects_to", "edge-x", []string{"N4"}),
		declaredEdges("r-b", "r-a", "depends_on", "edge-y", []string{"N4"}),
	}

	got := Reconcile(nodes, edges, declared, true, nil)
	if len(got.UnevidencedDeclarations) != 1 {
		t.Fatalf("the pair must appear once, got %+v", got.UnevidencedDeclarations)
	}
	item := got.UnevidencedDeclarations[0]
	if len(item.DeclaredClaims) != 2 {
		t.Fatalf("both declarations must be retained, got %+v", item.DeclaredClaims)
	}
	for _, claim := range item.DeclaredClaims {
		if claim.Direction != "" {
			t.Fatalf("direction is undefined without evidence, got %+v", claim)
		}
	}
	if item.InterfaceVerdict != "" {
		t.Fatalf("an unevidenced pair has no interface verdict, got %q", item.InterfaceVerdict)
	}
}

func declaredEdges(from, to, relationshipType, edgeID string, interfaces []string) DeclaredEdge {
	return DeclaredEdge{
		EdgeID:           edgeID,
		FromResourceID:   from,
		ToResourceID:     to,
		RelationshipType: relationshipType,
		LifecycleState:   lifecycleActive,
		InterfaceNames:   interfaces,
	}
}
