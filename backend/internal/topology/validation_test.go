package topology

import (
	"strings"
	"testing"
)

func TestValidateRelationshipType(t *testing.T) {
	for _, rel := range CanonicalRelationshipTypes {
		if err := ValidateRelationshipType(rel); err != nil {
			t.Errorf("canonical relationship %q must be accepted, got %v", rel, err)
		}
	}
	if len(CanonicalRelationshipTypes) != 9 {
		t.Fatalf("there must be exactly nine canonical relationship types, got %d", len(CanonicalRelationshipTypes))
	}
	if err := ValidateRelationshipType("manages"); err == nil {
		t.Error("non-canonical relationship type must be rejected")
	}
}

func TestValidateLifecycleState(t *testing.T) {
	if len(CanonicalLifecycleStates) != 2 {
		t.Fatalf("there must be exactly two lifecycle states, got %d", len(CanonicalLifecycleStates))
	}
	if err := ValidateLifecycleState(LifecycleActive); err != nil {
		t.Errorf("active must be accepted: %v", err)
	}
	if err := ValidateLifecycleState(LifecycleRetired); err != nil {
		t.Errorf("retired must be accepted: %v", err)
	}
	if err := ValidateLifecycleState("deleted"); err == nil {
		t.Error("unknown lifecycle state must be rejected")
	}
}

func TestValidateUUIDv4(t *testing.T) {
	valid := []string{
		"2f1a6a52-6c7f-4f8a-9f2b-0f7d4a1c8e33",
		"6ba7b811-9dad-41d1-80b4-00c04fd430c8",
	}
	for _, id := range valid {
		if err := ValidateUUIDv4(id); err != nil {
			t.Errorf("%q must be a valid UUID v4: %v", id, err)
		}
	}
	invalid := []string{
		"",
		"not-a-uuid",
		"6ba7b810-9dad-11d1-80b4-00c04fd430c8", // v1
		"6ba7b810-9dad-31d1-80b4-00c04fd430c8", // v3
		"2f1a6a52-6c7f-4f8a-1f2b-0f7d4a1c8e33", // wrong variant
	}
	for _, id := range invalid {
		if err := ValidateUUIDv4(id); err == nil {
			t.Errorf("%q must be rejected", id)
		}
	}
}

func TestValidateCreateRequest(t *testing.T) {
	from := "2f1a6a52-6c7f-4f8a-9f2b-0f7d4a1c8e33"
	to := "8c9d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f"

	ok := &CreateEdgeRequest{RelationshipType: RelationshipDependsOn, FromResourceID: from, ToResourceID: to}
	if err := ValidateCreateRequest(ok); err != nil {
		t.Fatalf("valid create request must pass: %v", err)
	}

	self := &CreateEdgeRequest{RelationshipType: RelationshipDependsOn, FromResourceID: from, ToResourceID: from}
	if err := ValidateCreateRequest(self); err == nil || !strings.Contains(err.Error(), ErrSelfEdge.Error()) {
		t.Errorf("self-edge must be rejected with ErrSelfEdge, got %v", err)
	}

	badRel := &CreateEdgeRequest{RelationshipType: "peer_of", FromResourceID: from, ToResourceID: to}
	if err := ValidateCreateRequest(badRel); err == nil {
		t.Error("non-canonical relationship must be rejected")
	}

	badID := &CreateEdgeRequest{RelationshipType: RelationshipDependsOn, FromResourceID: "nope", ToResourceID: to}
	if err := ValidateCreateRequest(badID); err == nil {
		t.Error("malformed fromResourceId must be rejected")
	}
}

func TestValidateLabels(t *testing.T) {
	if err := ValidateLabels(map[string]string{"env": "prod", "a/b": "c"}); err != nil {
		t.Errorf("valid labels must pass: %v", err)
	}
	if err := ValidateLabels(map[string]string{"env.prod": "x"}); err == nil {
		t.Error("label key containing dot must be rejected")
	}
	if err := ValidateLabels(map[string]string{"$secret": "x"}); err == nil {
		t.Error("label key starting with $ must be rejected")
	}
	if err := ValidateLabels(map[string]string{"Env": "x"}); err == nil {
		t.Error("uppercase label key must be rejected")
	}
	if err := ValidateLabels(map[string]string{"env": strings.Repeat("a", 129)}); err == nil {
		t.Error("label value exceeding 128 bytes must be rejected")
	}
	tooMany := map[string]string{}
	for i := 0; i < 33; i++ {
		tooMany[string(rune('a'+i%26))+string(rune('0'+i/26))] = "v"
	}
	if err := ValidateLabels(tooMany); err == nil {
		t.Error("more than 32 labels must be rejected")
	}
}

func TestValidateAttributes(t *testing.T) {
	if err := ValidateAttributes(nil); err != nil {
		t.Errorf("nil attributes must pass: %v", err)
	}
	if err := ValidateAttributes(map[string]any{"region": "cn-north"}); err != nil {
		t.Errorf("valid attributes must pass: %v", err)
	}
	if err := ValidateAttributes(map[string]any{"admin_password": "x"}); err == nil {
		t.Error("sensitive key must be rejected")
	}
	if err := ValidateAttributes(map[string]any{"api-key": "x"}); err == nil {
		t.Error("normalized sensitive key (api-key) must be rejected")
	}
	if err := ValidateAttributes(map[string]any{"a.b": "x"}); err == nil {
		t.Error("attribute key containing dot must be rejected")
	}
	if err := ValidateAttributes(map[string]any{"$where": "x"}); err == nil {
		t.Error("attribute key starting with $ must be rejected")
	}
	if err := ValidateAttributes(map[string]any{"v": strings.Repeat("a", 2049)}); err == nil {
		t.Error("attribute string exceeding 2048 characters must be rejected")
	}
	arr := make([]any, 129)
	if err := ValidateAttributes(map[string]any{"list": arr}); err == nil {
		t.Error("attribute array exceeding 128 items must be rejected")
	}
}

func TestCheckForbiddenServerFields(t *testing.T) {
	for _, field := range []string{"edgeId", "schemaVersion", "source", "revision", "lifecycleState", "createdAt", "createdBy", "updatedAt", "updatedBy"} {
		raw := []byte(`{"relationshipType":"depends_on","` + field + `":"x"}`)
		if err := CheckForbiddenServerFields(raw); err == nil {
			t.Errorf("server-owned field %q must be rejected", field)
		}
	}
	nested := []byte(`{"expectedRevision":1,"edge":{"description":"d","source":{"system":"spoof"}}}`)
	if err := CheckForbiddenServerFields(nested); err == nil {
		t.Error("nested server-owned field must be rejected")
	}
	clean := []byte(`{"relationshipType":"depends_on","fromResourceId":"a","toResourceId":"b"}`)
	if err := CheckForbiddenServerFields(clean); err != nil {
		t.Errorf("clean body must pass: %v", err)
	}
}

func TestValidateUpdateAndRetireRequests(t *testing.T) {
	if err := ValidateUpdateRequest(&UpdateEdgeRequest{ExpectedRevision: 1}); err != nil {
		t.Errorf("valid update request must pass: %v", err)
	}
	if err := ValidateUpdateRequest(&UpdateEdgeRequest{ExpectedRevision: 0}); err == nil {
		t.Error("expectedRevision <= 0 must be rejected")
	}
	if err := ValidateRetireRequest(&RetireEdgeRequest{ExpectedRevision: 2, Reason: " no longer applicable "}); err != nil {
		t.Errorf("valid retire request must pass: %v", err)
	}
	if err := ValidateRetireRequest(&RetireEdgeRequest{ExpectedRevision: 2, Reason: "   "}); err == nil {
		t.Error("blank retire reason must be rejected")
	}
	if err := ValidateRetireRequest(&RetireEdgeRequest{ExpectedRevision: 2, Reason: strings.Repeat("x", 513)}); err == nil {
		t.Error("retire reason exceeding 512 characters must be rejected")
	}
}
