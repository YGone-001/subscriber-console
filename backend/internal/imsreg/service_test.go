package imsreg

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"subscriber/internal/auth"
	"subscriber/internal/inventory"
	"subscriber/internal/operationsview"
)

const resourceA = "10000000-0000-4000-8000-000000000001"
const resourceB = "10000000-0000-4000-8000-000000000002"

type fakeGroups struct{ scope operationsview.GroupScope }

func (g fakeGroups) ResolveGroupScope(context.Context, operationsview.GroupFilter) (operationsview.GroupScope, error) {
	return g.scope, nil
}

type fakeReader struct {
	observations map[string]Observation
	failures     map[string]error
}

func (r fakeReader) Read(_ context.Context, s Source, _ int) (Observation, error) {
	return r.observations[s.ID], r.failures[s.ID]
}
func (r fakeReader) Enrich(context.Context, Source, []Identity) (string, error) {
	return "unavailable", errors.New("private database detail")
}
func testSource(id, resource string) Source {
	return Source{ID: id, Name: id, Authority: id, ResourceID: resource, Persistence: "write_back", SCSCF: Connection{Address: "127.0.0.1:3306", Database: "test_" + id, User: "observer", PasswordEnv: "IMS_TEST_PASSWORD"}}
}
func testGroups(ids ...string) fakeGroups {
	g := fakeGroups{scope: operationsview.GroupScope{Fingerprint: "revision-1", Inventory: operationsview.GroupCoverage{Completeness: "complete"}, Topology: operationsview.GroupCoverage{Completeness: "complete"}}}
	for _, id := range ids {
		g.scope.IDs = append(g.scope.IDs, id)
		g.scope.Resources = append(g.scope.Resources, inventory.Resource{ResourceID: id, Domain: "ims", Kind: inventory.KindNetworkFunctionInstance, LifecycleState: "active"})
	}
	return g
}
func record(source, key, uri, contact string) Identity {
	return Identity{Key: source + ":" + key, SourceID: source, PublicIdentity: uri, State: "active_binding_observed", Bindings: []Binding{{Key: contact, State: "active"}}, PrivateIdentities: []string{}, MSISDNs: []string{}}
}
func testQuery() Query { return Query{Limit: 50} }

func TestCountsUseIndependentContactAndPublicIdentityDenominators(t *testing.T) {
	a, b := testSource("a", resourceA), testSource("b", resourceB)
	r := fakeReader{observations: map[string]Observation{"a": {Complete: true, Items: []Identity{record("a", "1", "sip:same@ims.test", "shared"), record("a", "2", "tel:+12345", "shared")}}, "b": {Complete: true, Items: []Identity{record("b", "1", "sip:same@ims.test", "shared")}}}}
	s := NewService(Catalog{Version: 1, Sources: []Source{a, b}}, nil, r, testGroups(resourceA, resourceB))
	out, e := s.Read(context.Background(), testQuery())
	if e != nil {
		t.Fatal(e)
	}
	if out.Counts.ActiveBindings == nil || *out.Counts.ActiveBindings != 2 || *out.Counts.ActivePublicIdentities != 3 {
		t.Fatalf("separate denominators: %+v", out.Counts)
	}
	for _, source := range out.Sources {
		if source.Freshness != "unknown" || source.SourceAsOf != nil {
			t.Fatal("a read timestamp must not prove synchronization freshness")
		}
	}
}
func TestUnavailableAndTruncatedSourcesNeverFabricateTotals(t *testing.T) {
	for _, truncated := range []bool{false, true} {
		r := fakeReader{observations: map[string]Observation{"a": {Complete: !truncated, Items: []Identity{record("a", "1", "sip:a@ims.test", "1")}}}, failures: map[string]error{}}
		if !truncated {
			r.failures["a"] = errors.New("password or original SQL error must be private")
		}
		s := NewService(Catalog{Version: 1, Sources: []Source{testSource("a", resourceA)}}, nil, r, testGroups(resourceA))
		out, e := s.Read(context.Background(), testQuery())
		if e != nil {
			t.Fatal(e)
		}
		if out.Counts.ActiveBindings != nil || out.Pagination.Total != nil || out.Completeness == "complete" {
			t.Fatal("incomplete population exposed an exact total")
		}
		b, _ := json.Marshal(out)
		if strings.Contains(string(b), "password") {
			t.Fatal("raw error leaked")
		}
	}
}
func TestNoSourceAndInvalidConfigurationAreDistinct(t *testing.T) {
	for _, bad := range []bool{false, true} {
		var err error
		if bad {
			err = configError()
		}
		s := NewService(Catalog{}, err, nil, nil)
		out, e := s.Read(context.Background(), testQuery())
		if e != nil {
			t.Fatal(e)
		}
		expected := "not_configured"
		if bad {
			expected = "invalid_config"
		}
		if out.ConfigurationState != expected || out.Counts.ActiveBindings != nil || len(out.Items) != 0 {
			t.Fatal("configuration state was hidden")
		}
	}
}
func TestMemoryOnlySourceDoesNotReadHistoricalDatabaseRows(t *testing.T) {
	source := testSource("a", resourceA)
	source.Persistence = "memory_only"
	s := NewService(Catalog{Sources: []Source{source}}, nil, nil, testGroups(resourceA))
	out, e := s.Read(context.Background(), testQuery())
	if e != nil {
		t.Fatal(e)
	}
	if len(out.Sources) != 1 || out.Sources[0].Reason != "persistence_not_current" || out.Counts.ActiveBindings != nil {
		t.Fatal("memory-only source was treated as a current database population")
	}
}
func TestEmptyScopeDoesNotBroadenToAllSources(t *testing.T) {
	s := NewService(Catalog{Sources: []Source{testSource("a", resourceA)}}, nil, nil, testGroups())
	q := testQuery()
	q.Filter.NetworkKey = "elsewhere"
	out, e := s.Read(context.Background(), q)
	if e != nil {
		t.Fatal(e)
	}
	if len(out.Sources) != 0 || out.Counts.ActiveBindings == nil || *out.Counts.ActiveBindings != 0 {
		t.Fatal("empty intersection broadened the source set")
	}
}
func TestPartialScopeKeepsTotalsUnknown(t *testing.T) {
	g := testGroups(resourceA)
	g.scope.Topology.Completeness = "partial"
	s := NewService(Catalog{Sources: []Source{testSource("a", resourceA)}}, nil, fakeReader{observations: map[string]Observation{"a": {Complete: true}}}, g)
	out, e := s.Read(context.Background(), testQuery())
	if e != nil || out.Counts.PublicIdentities != nil {
		t.Fatal("partial topology established an exact population")
	}
}
func TestCursorBindsScopeFiltersAndExpires(t *testing.T) {
	r := fakeReader{observations: map[string]Observation{"a": {Complete: true, Items: []Identity{record("a", "1", "sip:a@ims.test", "1"), record("a", "2", "sip:b@ims.test", "2")}}}}
	s := NewService(Catalog{Sources: []Source{testSource("a", resourceA)}}, nil, r, testGroups(resourceA))
	q := testQuery()
	q.Limit = 1
	out, e := s.Read(context.Background(), q)
	if e != nil || out.Pagination.NextCursor == nil {
		t.Fatal("no next cursor")
	}
	q.Cursor = *out.Pagination.NextCursor
	second, e := s.Read(context.Background(), q)
	if e != nil || len(second.Items) != 1 || second.Items[0].Key != "a:2" {
		t.Fatal("cursor did not advance")
	}
	q.Search = "other"
	if _, e = s.Read(context.Background(), q); reason(e) != "cursor_changed" {
		t.Fatal("cursor accepted a new search")
	}
	q.Search = ""
	s.now = func() time.Time { return time.Now().Add(10 * time.Minute) }
	if _, e = s.Read(context.Background(), q); reason(e) != "cursor_changed" {
		t.Fatal("expired cursor accepted")
	}
}
func TestOptionalHSSFailureDoesNotEraseBindingEvidence(t *testing.T) {
	source := testSource("a", resourceA)
	source.HSS = &source.SCSCF
	r := fakeReader{observations: map[string]Observation{"a": {Complete: true, Items: []Identity{record("a", "1", "sip:a@ims.test", "1")}}}}
	s := NewService(Catalog{Sources: []Source{source}}, nil, r, testGroups(resourceA))
	out, e := s.Read(context.Background(), testQuery())
	if e != nil || out.Counts.ActiveBindings == nil || out.Items[0].IdentityState != "unavailable" {
		t.Fatal("optional identity lookup corrupted binding coverage")
	}
}
func TestQueryValidation(t *testing.T) {
	for _, raw := range []string{"q=x&q=y", "url=http://example.test", "limit=201", "sourceId=UPPER", "state=registered", "plmn=1234", "cursor=" + strings.Repeat("a", 1025)} {
		v, _ := url.ParseQuery(raw)
		if _, e := ParseQuery(v, false); e == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	v, _ := url.ParseQuery("plmn=001001&networkKey=network-a")
	q, e := ParseQuery(v, false)
	if e != nil || q.Filter.PLMN != "001001" {
		t.Fatal("PLMN leading zeros lost")
	}
}
func TestCatalogIsBoundedAndHasNoInlineCredentialSupport(t *testing.T) {
	c := Catalog{Version: 1, Sources: []Source{testSource("a", resourceA)}}
	b, _ := json.Marshal(c)
	if _, e := ParseCatalog(b); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{strings.Replace(string(b), "write_back", "invalid", 1), strings.Replace(string(b), "127.0.0.1:3306", "10.0.0.1:3306", 1), strings.TrimSuffix(string(b), "}") + `,"password":"secret"}`} {
		if _, e := ParseCatalog([]byte(bad)); e == nil {
			t.Fatal("unsafe source configuration accepted")
		}
	}
	c.Sources = append(c.Sources, c.Sources[0])
	b, _ = json.Marshal(c)
	if _, e := ParseCatalog(b); e == nil {
		t.Fatal("duplicate source accepted")
	}
}
func TestSafeURIProjectionDropsCredentialsAndRoutingParameters(t *testing.T) {
	if safeContact("<sip:alice@ims.test;token=private?Authorization=private>") != "sip:alice@ims.test" {
		t.Fatal("Contact positive projection failed")
	}
	for _, s := range []string{"sip:user:secret@ims.test", "http://example.test", "sip:x@ims.test\nsecret"} {
		if safeIdentity(s) {
			t.Fatal("unsafe identity accepted")
		}
	}
}
func TestHandlerAuthenticationAndNoStore(t *testing.T) {
	s := NewService(Catalog{}, nil, nil, nil)
	h := NewHandler(s, nil)
	for _, role := range []string{"", "admin", "operator", "viewer"} {
		req := httptest.NewRequest("GET", "/api/ims/registrations", nil)
		if role != "" {
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{Username: "test", Role: role, NormalizedRole: role}))
		}
		w := httptest.NewRecorder()
		h.Get(w, req)
		want := http.StatusOK
		if role == "" {
			want = http.StatusUnauthorized
		}
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("role %s: %d", role, w.Code)
		}
	}
}
