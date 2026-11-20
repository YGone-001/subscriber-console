package inventory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"testing"

	"subscriber/internal/auth"
)

type runtimeUpdateRepo struct {
	*mockRepo
	writes int
}

func (r *runtimeUpdateRepo) Update(ctx context.Context, id string, req *UpdateResourceRequest, actor string) (*Resource, *Resource, error) {
	before, after, err := r.mockRepo.Update(ctx, id, req, actor)
	if err == nil {
		r.writes++
		after.Attributes = req.Resource.Attributes
	}
	return before, after, err
}

func runtimeAttributes() map[string]any {
	return map[string]any{"runtime.componentId": "amf", "runtime.processName": "amfd", "runtime.hostId": "host-test", "runtime.source": "xcloud-runtime"}
}

func TestRuntimeMetadataSurvivesGovernedResourceUpdates(t *testing.T) {
	mergedOverflow := map[string]any{}
	for index := 0; index < 125; index++ {
		mergedOverflow[fmt.Sprintf("field%d", index)] = "value"
	}
	for _, test := range []struct {
		name       string
		attributes map[string]any
		role       string
		revision   int64
		status     int
	}{
		{"roundtrip", runtimeAttributes(), "operator", 1, 200},
		{"omitted", nil, "operator", 1, 200},
		{"scope assignment", map[string]any{OperationalScopesAttribute: []any{map[string]any{"networkKey": "lab-a", "operatorName": "", "plmns": []any{}}}}, "operator", 1, 200},
		{"forged identity", map[string]any{"runtime.hostId": "different-host"}, "operator", 1, 400},
		{"unknown dotted key", map[string]any{"runtime.command": "bad"}, "operator", 1, 400},
		{"nested exception", map[string]any{"nested": runtimeAttributes()}, "operator", 1, 400},
		{"invalid value", map[string]any{"runtime.hostId": map[string]any{"value": "bad"}}, "operator", 1, 400},
		{"merged bounds", mergedOverflow, "operator", 1, 400},
		{"stale revision", runtimeAttributes(), "operator", 2, 409},
		{"viewer", runtimeAttributes(), "viewer", 1, 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := &runtimeUpdateRepo{mockRepo: newMockRepo()}
			res, err := repo.Create(context.Background(), &CreateResourceRequest{Kind: KindNetworkFunction, Name: "amf-test", Domain: Domain5GC, Attributes: runtimeAttributes()}, "bootstrap")
			if err != nil {
				t.Fatal(err)
			}
			res.Source = SourceMetadata{Kind: "discovered", System: "xcloud-runtime", Authority: "authoritative", ExternalID: "xrt:host-test:amf:amfd"}
			before, _ := json.Marshal(res)
			request := UpdateResourceRequest{ExpectedRevision: test.revision, Resource: MutableResource{Kind: res.Kind, Name: res.Name, Domain: res.Domain, LifecycleState: res.LifecycleState, Attributes: test.attributes}}
			body, _ := json.Marshal(request)
			r := httptest.NewRequest("PUT", "/api/inventory/resources/"+res.ResourceID, bytes.NewReader(body))
			r.SetPathValue("resourceId", res.ResourceID)
			r = r.WithContext(auth.ContextWithPrincipal(r.Context(), makePrincipal(test.role)))
			w := httptest.NewRecorder()
			NewHandler(repo, nil, &dummyAuditWriter{}, activeActors{}).Update(w, r)
			if w.Code != test.status {
				t.Fatalf("status %d, want %d: %s", w.Code, test.status, w.Body.String())
			}
			if test.status != 200 {
				after, _ := json.Marshal(res)
				if repo.writes != 0 || !bytes.Equal(before, after) {
					t.Fatal("rejected update changed stored resource")
				}
				return
			}
			if repo.writes != 1 || res.Revision != 2 {
				t.Fatal("update did not retain governed CAS")
			}
			for key, value := range runtimeAttributes() {
				if res.Attributes[key] != value {
					t.Fatalf("lost runtime attribute %s", key)
				}
			}
			if res.Source.ExternalID != "xrt:host-test:amf:amfd" {
				t.Fatal("runtime source identity changed")
			}
			if test.name == "scope assignment" {
				scopes, err := OperationalScopes(res.Attributes)
				if err != nil || len(scopes) != 1 || scopes[0].NetworkKey != "lab-a" {
					t.Fatalf("lost scope: %v", err)
				}
			}
		})
	}
}

func TestRuntimeAttributeExceptionCannotCreateIdentityOrBypassFreshActor(t *testing.T) {
	repo := &runtimeUpdateRepo{mockRepo: newMockRepo()}
	res, _ := repo.Create(context.Background(), &CreateResourceRequest{Kind: KindHost, Name: "manual-host", Domain: DomainPlatform}, "operator")
	req := &UpdateResourceRequest{ExpectedRevision: 1, Resource: MutableResource{Kind: res.Kind, Name: res.Name, Domain: res.Domain, LifecycleState: res.LifecycleState, Attributes: runtimeAttributes()}}
	if _, _, err := NewMutationService(repo, activeActors{}).Update(context.Background(), makePrincipal("operator"), res.ResourceID, req); err == nil || repo.writes != 0 {
		t.Fatal("manual resource accepted forged runtime identity")
	}
	res.Attributes = runtimeAttributes()
	req.Resource.Attributes = runtimeAttributes()
	if _, _, err := NewMutationService(repo, changedActor{status: "disabled", role: "operator"}).Update(context.Background(), makePrincipal("operator"), res.ResourceID, req); err == nil || repo.writes != 0 {
		t.Fatal("runtime metadata bypassed fresh actor validation")
	}
	if !reflect.DeepEqual(res.Attributes, runtimeAttributes()) {
		t.Fatal("validation mutated original attributes")
	}
	if err := ValidateCreateRequest(&CreateResourceRequest{Kind: KindHost, Name: "new-host", Domain: DomainPlatform, Attributes: runtimeAttributes()}); err == nil {
		t.Fatal("creation accepted client-authored runtime attributes")
	}
}
