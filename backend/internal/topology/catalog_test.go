package topology

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestInterfaceCatalogIntegrity(t *testing.T) {
	if err := validateInterfaceCatalog(); err != nil {
		t.Fatalf("catalog integrity failed: %v", err)
	}
	if strings.TrimSpace(CatalogVersion) == "" {
		t.Fatal("catalogVersion must not be empty")
	}
	if len(InterfaceCatalog) != 46 {
		t.Fatalf("v1 catalog must contain 46 entries, got %d", len(InterfaceCatalog))
	}

	counts := map[InterfaceCategory]int{}
	for _, entry := range InterfaceCatalog {
		counts[entry.Category]++
		if entry.Scope != InterfaceScopeNFNF {
			t.Errorf("v1 interface %s must be nf_nf, got %s", entry.Name, entry.Scope)
		}
		for _, pair := range entry.Endpoints {
			for _, role := range pair {
				if role != strings.ToLower(role) || strings.ContainsAny(role, "-_.") {
					t.Errorf("interface %s must use the stored compact role token, got %q", entry.Name, role)
				}
			}
		}
	}
	if counts[InterfaceCategoryReferencePoint] != 37 {
		t.Errorf("catalog must contain 37 reference points, got %d", counts[InterfaceCategoryReferencePoint])
	}
	if counts[InterfaceCategorySBI] != 9 {
		t.Errorf("catalog must contain 9 SBI interfaces, got %d", counts[InterfaceCategorySBI])
	}

	s5, ok := lookupInterface("S5")
	if !ok {
		t.Fatal("S5 must be present")
	}
	if !hasEndpoint(s5, "sgwc", "pgwc") || !hasEndpoint(s5, "sgwu", "pgwu") {
		t.Errorf("S5 must use compact SGW/PGW role tokens: %+v", s5.Endpoints)
	}
	if _, ok := lookupInterface("S8"); !ok {
		t.Fatal("S8 must be a separate controlled name")
	}

	mw, ok := lookupInterface("Mw")
	if !ok {
		t.Fatal("Mw must be present")
	}
	for _, pair := range [][2]string{{"pcscf", "icscf"}, {"icscf", "scscf"}, {"pcscf", "scscf"}} {
		if !hasEndpoint(mw, pair[0], pair[1]) {
			t.Errorf("Mw must suggest %s/%s, got %+v", pair[0], pair[1], mw.Endpoints)
		}
	}

	n26, ok := lookupInterface("N26")
	if !ok {
		t.Fatal("N26 must be present")
	}
	if !reflect.DeepEqual(n26.Domains, []string{"5gc", "epc"}) {
		t.Errorf("N26 must span 5gc and epc, got %v", n26.Domains)
	}

	ro, ok := lookupInterface("Ro")
	if !ok {
		t.Fatal("Ro must be present")
	}
	if len(ro.Endpoints) != 0 {
		t.Errorf("Ro endpoint roles vary by deployment and must not be fixed: %+v", ro.Endpoints)
	}

	nnrf, ok := lookupInterface("Nnrf")
	if !ok {
		t.Fatal("Nnrf must be present")
	}
	if nnrf.Category != InterfaceCategorySBI || nnrf.ProducerRole != "nrf" || len(nnrf.Endpoints) != 0 {
		t.Errorf("Nnrf must be an SBI entry produced by nrf without fixed endpoints: %+v", nnrf)
	}

	for _, reserved := range []string{"N28", "N40", "N41", "N42", "Nchf"} {
		if _, ok := lookupInterface(reserved); ok {
			t.Errorf("CHF interface %s must remain out of v1", reserved)
		}
	}
}

func hasEndpoint(entry InterfaceEntry, left, right string) bool {
	for _, pair := range entry.Endpoints {
		if len(pair) == 2 && pair[0] == left && pair[1] == right {
			return true
		}
	}
	return false
}

func TestValidateInterfaceNames(t *testing.T) {
	got, err := ValidateInterfaceNames(nil)
	if err != nil {
		t.Fatalf("nil interfaceNames must be valid: %v", err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("nil interfaceNames must normalize to an empty non-nil array, got %#v", got)
	}

	got, err = ValidateInterfaceNames([]string{" N11 ", "N11", "Nnrf"})
	if err != nil {
		t.Fatalf("valid interfaceNames must pass: %v", err)
	}
	if !reflect.DeepEqual(got, []string{"N11", "Nnrf"}) {
		t.Errorf("trim and dedupe failed: %#v", got)
	}

	got, err = ValidateInterfaceNames([]string{"N11", "N11", "N11"})
	if err != nil || !reflect.DeepEqual(got, []string{"N11"}) {
		t.Errorf("duplicates must collapse before the maximum check: %#v, %v", got, err)
	}

	for _, tc := range []struct {
		name  string
		names []string
	}{
		{"unknown", []string{"N99"}},
		{"blank", []string{""}},
		{"whitespace", []string{"   "}},
		{"case mismatch", []string{"n11"}},
		{"reserved CHF", []string{"Nchf"}},
		{"too many", []string{"N4", "N7", "N8", "N9", "N10", "N11", "N12", "N13", "N14"}},
	} {
		if _, err := ValidateInterfaceNames(tc.names); !errors.Is(err, ErrInvalidInterfaceName) {
			t.Errorf("%s: expected ErrInvalidInterfaceName, got %v", tc.name, err)
		}
	}

	eight := []string{"N4", "N7", "N8", "N9", "N10", "N11", "N12", "N13"}
	if _, err := ValidateInterfaceNames(eight); err != nil {
		t.Errorf("eight distinct interface names must be accepted: %v", err)
	}
}

func TestEdgeMarshalJSONAlwaysIncludesInterfaceNamesArray(t *testing.T) {
	raw, err := json.Marshal(Edge{})
	if err != nil {
		t.Fatalf("marshal legacy edge: %v", err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal marshaled edge: %v", err)
	}
	if string(payload["interfaceNames"]) != "[]" {
		t.Errorf("legacy edge must serialize interfaceNames as [], got %s", payload["interfaceNames"])
	}

	raw, err = json.Marshal(Edge{InterfaceNames: []string{"N11"}})
	if err != nil {
		t.Fatalf("marshal edge with interface names: %v", err)
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal marshaled edge: %v", err)
	}
	if string(payload["interfaceNames"]) != `["N11"]` {
		t.Errorf("interfaceNames must serialize as an array, got %s", payload["interfaceNames"])
	}
}
