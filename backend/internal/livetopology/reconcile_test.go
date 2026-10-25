package livetopology

import (
	"context"
	"errors"
	"testing"
)

func node(componentID, resourceID string) Node {
	return Node{ComponentID: componentID, InventoryResourceID: resourceID}
}

func evidenceEdge(fromComponent, toComponent string, interfaces []string) Edge {
	return Edge{
		EdgeID:          "configured:" + fromComponent + ":" + toComponent,
		FromComponentID: fromComponent,
		ToComponentID:   toComponent,
		InterfaceNames:  interfaces,
		Protocol:        "diameter",
		Evidence:        EvidenceConfigured,
	}
}

func declared(resourceFrom, resourceTo, state string, interfaces []string) DeclaredEdge {
	return DeclaredEdge{
		EdgeID:           "edge-" + resourceFrom + "-" + resourceTo,
		FromResourceID:   resourceFrom,
		ToResourceID:     resourceTo,
		RelationshipType: "connects_to",
		LifecycleState:   state,
		InterfaceNames:   interfaces,
	}
}

func TestReconcileMatchesConfiguredLinkWithDeclaration(t *testing.T) {
	nodes := []Node{node("mme", "r-mme"), node("sgwc", "r-sgwc")}
	edges := []Edge{evidenceEdge("mme", "sgwc", []string{"S11"})}
	declared := []DeclaredEdge{declared("r-mme", "r-sgwc", lifecycleActive, []string{"S11"})}

	got := Reconcile(nodes, edges, declared, true, nil)
	if !got.Available || !got.Complete {
		t.Fatalf("reconciliation must be available and complete, got %+v", got)
	}
	if got.MatchedCount != 1 || got.ConfiguredLinks != 1 || got.DeclaredEdges != 1 {
		t.Fatalf("expected one matched link, got %+v", got)
	}
	if len(got.UndeclaredEvidence) != 0 || len(got.UnevidencedDeclarations) != 0 {
		t.Fatalf("a matched pair must not appear in either diff, got %+v", got)
	}
}

func TestReconcileTreatsDirectionAsUnordered(t *testing.T) {
	nodes := []Node{node("pcscf", "r-pcscf"), node("pcrf", "r-pcrf")}
	// The declaration points the other way than the configuration file does.
	edges := []Edge{evidenceEdge("pcscf", "pcrf", []string{"Rx"})}
	declared := []DeclaredEdge{declared("r-pcrf", "r-pcscf", lifecycleActive, []string{"Rx"})}

	got := Reconcile(nodes, edges, declared, true, nil)
	if got.MatchedCount != 1 || len(got.UndeclaredEvidence) != 0 {
		t.Fatalf("reference points are directional in the spec but the pair match must be unordered, got %+v", got)
	}
}

func TestReconcileGradesInterfaceAnnotation(t *testing.T) {
	nodes := []Node{node("a", "r-a"), node("b", "r-b"), node("c", "r-c")}
	edges := []Edge{
		evidenceEdge("a", "b", []string{"S11"}),
		evidenceEdge("a", "c", []string{"S5"}),
		evidenceEdge("b", "c", nil),
	}
	declared := []DeclaredEdge{
		declared("r-a", "r-b", lifecycleActive, []string{"S11"}),
		declared("r-a", "r-c", lifecycleActive, []string{"Sxa"}),
		declared("r-b", "r-c", lifecycleActive, nil),
	}

	got := Reconcile(nodes, edges, declared, true, nil)
	if got.MatchedCount != 3 {
		t.Fatalf("all three pairs are declared, so all three must match: %+v", got)
	}
	grades := map[string]string{}
	for _, item := range got.Matched {
		grades[item.FromComponentID+"->"+item.ToComponentID] = item.InterfaceMatch
	}
	if grades["a->b"] != InterfaceMatchAgrees {
		t.Fatalf("identical reference points must agree, got %q", grades["a->b"])
	}
	if grades["a->c"] != InterfaceMatchDiffers {
		t.Fatalf("S5 against Sxa must be reported as differing, got %q", grades["a->c"])
	}
	if grades["b->c"] != InterfaceMatchUnannotated {
		t.Fatalf("a pair with no interface names on either side must be unannotated, not differing, got %q", grades["b->c"])
	}
	// A differing grade is advisory metadata on a matched pair: it never moves
	// the pair into an undeclared or unevidenced bucket.
	if len(got.UndeclaredEvidence) != 0 || len(got.UnevidencedDeclarations) != 0 {
		t.Fatalf("matched pairs must not appear in either diff, got %+v", got)
	}
}

func TestReconcileReportsEvidenceWithoutDeclaration(t *testing.T) {
	nodes := []Node{node("pgwc", "r-pgwc"), node("pgwu", "r-pgwu"), node("mme", "r-mme")}
	edges := []Edge{
		evidenceEdge("pgwc", "pgwu", []string{"Sxb"}),
		evidenceEdge("mme", "pgwc", nil),
	}
	declared := []DeclaredEdge{
		declared("r-pgwc", "r-pgwu", lifecycleActive, []string{"Sxb"}),
		declared("r-mme", "r-pgwc", lifecycleRetired, []string{"Gn"}),
	}

	got := Reconcile(nodes, edges, declared, true, nil)
	if got.MatchedCount != 1 {
		t.Fatalf("the declared pair must match, got %+v", got)
	}
	if len(got.UndeclaredEvidence) != 1 {
		t.Fatalf("exactly one configured link is undeclared, got %+v", got)
	}
	item := got.UndeclaredEvidence[0]
	if !item.Retired {
		t.Fatal("a link whose pair was declared and retired must be flagged as retired, not as never declared")
	}
	if item.EdgeID == "" {
		t.Fatal("the retired item must name the retired edge so the operator can see the prior decision")
	}
}

func TestReconcileReportsDeclarationWithoutEvidence(t *testing.T) {
	nodes := []Node{node("smf", "r-smf"), node("upf", "r-upf")}
	declared := []DeclaredEdge{declared("r-smf", "r-upf", lifecycleActive, []string{"N4"})}

	got := Reconcile(nodes, nil, declared, true, nil)
	if got.DeclaredEdges != 1 || got.MatchedCount != 0 {
		t.Fatalf("the declaration must stand alone, got %+v", got)
	}
	if len(got.UnevidencedDeclarations) != 1 {
		t.Fatalf("a declaration with no configured link must be reported, got %+v", got)
	}
	item := got.UnevidencedDeclarations[0]
	if item.FromComponentID != "smf" || item.ToComponentID != "upf" {
		t.Fatalf("the report must carry the components behind the resources, got %+v", item)
	}
}

func TestReconcileSkipsEvidenceWithoutInventoryIdentity(t *testing.T) {
	nodes := []Node{{ComponentID: "dra"}, node("smf", "r-smf")}
	edges := []Edge{evidenceEdge("dra", "smf", nil)}

	got := Reconcile(nodes, edges, nil, true, nil)
	if got.ConfiguredLinks != 0 {
		t.Fatalf("evidence that cannot be attributed to Inventory must not be reconciled, got %+v", got)
	}
}

func TestReconcileDegradesOnLedgerFailure(t *testing.T) {
	got := Reconcile([]Node{}, []Edge{}, nil, false, errors.New("boom"))
	if got.Available || got.Complete {
		t.Fatalf("a failed ledger read must be unavailable, got %+v", got)
	}
	if got.Reason != ReconciliationReasonUnavailable {
		t.Fatalf("expected %s, got %s", ReconciliationReasonUnavailable, got.Reason)
	}
	if len(got.UndeclaredEvidence) != 0 || len(got.UnevidencedDeclarations) != 0 {
		t.Fatal("a failed ledger read must produce no diff claims")
	}
}

func TestReconcileMarksPartialLedger(t *testing.T) {
	got := Reconcile([]Node{}, []Edge{}, nil, false, nil)
	if !got.Available {
		t.Fatal("a readable but truncated ledger is still available")
	}
	if got.Complete {
		t.Fatal("a truncated ledger must never claim a complete reconciliation")
	}
}

type fakeLedger struct {
	edges    []DeclaredEdge
	complete bool
	err      error
}

func (f fakeLedger) ListDeclared(context.Context) ([]DeclaredEdge, bool, error) {
	return f.edges, f.complete, f.err
}

func TestDeclaredLedgerContractIsSatisfiable(t *testing.T) {
	var ledger DeclaredLedger = fakeLedger{edges: []DeclaredEdge{declared("r-a", "r-b", lifecycleActive, []string{"S11"})}, complete: true}
	edges, complete, err := ledger.ListDeclared(context.Background())
	if err != nil || !complete || len(edges) != 1 {
		t.Fatalf("the ledger adapter must satisfy the projection contract, got %d edges complete=%v err=%v", len(edges), complete, err)
	}
}

func TestHandlerOmitsReconciliationWhenNoLedgerInstalled(t *testing.T) {
	handler := NewHandler(nil, "", nil)
	if handler.ledger != nil {
		t.Fatal("the ledger must stay optional so an unwired deployment keeps serving the projection")
	}
}
