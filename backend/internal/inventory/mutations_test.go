package inventory

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/governance"
	"subscriber/internal/user"
)

type activeActors struct{}

func (activeActors) FindByUsernameIdentity(_ context.Context, username string) (*user.UserIdentity, error) {
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: username, Role: strings.TrimPrefix(username, "test-"), Status: "active"}}, nil
}

type changedActor struct {
	status, role string
	locked       bool
	version      int
	fail         bool
}

func (a changedActor) FindByUsernameIdentity(_ context.Context, username string) (*user.UserIdentity, error) {
	if a.fail {
		return nil, errors.New("store down")
	}
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: username, Role: a.role, Status: a.status, Locked: a.locked, Security: &user.UserSecurity{SessionVersion: a.version}}}, nil
}

func TestMutationRevalidatesActorBeforeEveryWrite(t *testing.T) {
	for _, a := range []changedActor{{status: "disabled", role: "operator"}, {status: "active", role: "viewer"}, {status: "active", role: "operator", locked: true}, {status: "active", role: "operator", version: 1}, {fail: true}} {
		repo := newMockRepo()
		s := NewMutationService(repo, a)
		_, e := s.Create(context.Background(), makePrincipal("operator"), &CreateResourceRequest{Kind: KindSite, Name: "site-a", Domain: DomainPlatform})
		if e == nil || len(repo.items) != 0 {
			t.Fatal("stale actor reached repository")
		}
		var g *governance.HTTPError
		if !errors.As(e, &g) {
			t.Fatalf("missing controlled error: %v", e)
		}
	}
	repo := newMockRepo()
	s := NewMutationService(repo, nil)
	if _, e := s.Create(context.Background(), makePrincipal("operator"), &CreateResourceRequest{}); e == nil {
		t.Fatal("nil account store did not fail closed")
	}
}
func TestOperationalScopeValidationAndLegacyPreservation(t *testing.T) {
	valid := map[string]any{OperationalScopesAttribute: bson.A{bson.D{{Key: "networkKey", Value: "lab-a"}, {Key: "operatorName", Value: " A "}, {Key: "plmns", Value: bson.A{"00101", "001001"}}}}}
	rows, e := OperationalScopes(valid)
	if e != nil || len(rows) != 1 || rows[0].OperatorName != "A" || rows[0].PLMNs[0] != "00101" {
		t.Fatalf("BSON projection: %#v %v", rows, e)
	}
	invalid := map[string]any{OperationalScopesAttribute: "legacy"}
	if ValidateOperationalScopeChange(KindSite, invalid, invalid) != nil {
		t.Fatal("unchanged legacy declaration was blocked")
	}
	if ValidateOperationalScopeChange(KindSite, nil, invalid) == nil {
		t.Fatal("new malformed declaration accepted")
	}
	if ValidateOperationalScopeChange(KindService, nil, valid) == nil {
		t.Fatal("unsupported kind accepted")
	}
	for _, value := range []string{`null`, `[{"networkKey":"a","operatorName":"A","plmns":["00101","00101"]}]`, `[{"networkKey":"A","operatorName":"A","plmns":[]}]`, `[{"networkKey":"a","unknown":1}]`} {
		var v any
		if e := json.Unmarshal([]byte(value), &v); e != nil {
			t.Fatal(e)
		}
		if _, e := OperationalScopes(map[string]any{OperationalScopesAttribute: v}); e == nil {
			t.Fatalf("invalid declaration accepted: %s", value)
		}
	}
}

func TestOperationalScopeBSONRoundTripAndNormalizedWrite(t *testing.T) {
	attrs := map[string]any{OperationalScopesAttribute: []any{map[string]any{"networkKey": "a", "operatorName": " A ", "plmns": []any{"00101", "001001"}}}, "unrelated": map[string]any{"future": int32(7)}}
	prepared, e := PrepareOperationalScopeChange(KindHost, nil, attrs)
	if e != nil {
		t.Fatal(e)
	}
	scopes, e := OperationalScopes(prepared)
	if e != nil || scopes[0].OperatorName != "A" {
		t.Fatal("operator name not normalized before storage")
	}
	raw, e := bson.Marshal(Resource{Kind: KindHost, Attributes: prepared})
	if e != nil {
		t.Fatal(e)
	}
	var r Resource
	if e = bson.Unmarshal(raw, &r); e != nil {
		t.Fatal(e)
	}
	encoded, e := json.Marshal(r)
	if e != nil {
		t.Fatal(e)
	}
	var api struct {
		Attributes map[string]json.RawMessage `json:"attributes"`
	}
	if e = json.Unmarshal(encoded, &api); e != nil {
		t.Fatal(e)
	}
	var apiScopes []OperationalScope
	if e = json.Unmarshal(api.Attributes[OperationalScopesAttribute], &apiScopes); e != nil || apiScopes[0].PLMNs[1] != "001001" {
		t.Fatalf("BSON document escaped as a JSON key/value array: %s %v", encoded, e)
	}
	if r.Attributes["unrelated"] == nil {
		t.Fatal("unowned attribute was lost")
	}
}
