package balance

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/auth"
)

type denyingRateLimiter struct{}

func (d *denyingRateLimiter) Enforce(w http.ResponseWriter, _ *http.Request, _ string, _ int, _ int) bool {
	w.WriteHeader(http.StatusTooManyRequests)
	return false
}

func adjustmentRequest(imsi, username, role string, withPrincipal bool) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/ocs/balances/"+imsi+"/adjustments", nil)
	r.SetPathValue("imsi", imsi)
	if !withPrincipal {
		return r
	}
	p := &auth.Principal{
		Username:       username,
		Role:           role,
		NormalizedRole: auth.NormalizeRole(role),
	}
	return r.WithContext(auth.ContextWithPrincipal(r.Context(), p))
}

func TestHandler_Adjustments_RequiresPrincipal(t *testing.T) {
	h := NewHandler(nil, &mockRateLimiter{allowed: true}, nil, nil)
	rec := httptest.NewRecorder()

	h.Adjustments(rec, adjustmentRequest("417010000000001", "", "", false))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestHandler_Adjustments_RejectsMalformedIMSI(t *testing.T) {
	h := NewHandler(nil, &mockRateLimiter{allowed: true}, nil, nil)
	rec := httptest.NewRecorder()

	h.Adjustments(rec, adjustmentRequest("abc-123", "op1", "operator", true))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if body := rec.Body.String(); !strings.Contains(body, "INVALID_IMSI") {
		t.Fatalf("body = %s, want INVALID_IMSI", body)
	}
}

func TestHandler_Adjustments_DeniesRoleWithoutReadPermission(t *testing.T) {
	h := NewHandler(nil, &mockRateLimiter{allowed: true}, nil, nil)
	rec := httptest.NewRecorder()

	h.Adjustments(rec, adjustmentRequest("417010000000001", "guest1", "guest", true))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestHandler_Adjustments_HonoursRateLimit(t *testing.T) {
	h := NewHandler(nil, &denyingRateLimiter{}, nil, nil)
	rec := httptest.NewRecorder()

	h.Adjustments(rec, adjustmentRequest("417010000000001", "op1", "operator", true))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}
}

func TestMapAdjustmentDoc_ProjectsMetadataWithoutLeakingTheRecord(t *testing.T) {
	doc := bson.M{
		"_id":          "adj-1",
		"timestamp":    "2026-10-01T08:00:00.000Z",
		"action":       "BALANCE_ADJUST",
		"result":       "success",
		"reason":       "goodwill credit",
		"actor":        "op1",
		"actorContext": bson.M{"username": "op1", "role": "operator"},
		"metadata": bson.M{
			"bucket":        "data",
			"operation":     "credit",
			"amount":        int32(1073741824),
			"ticketId":      "INC100234",
			"beforeVersion": int64(3),
			"afterVersion":  int64(4),
		},
	}

	record := mapAdjustmentDoc(doc)

	if record.ID != "adj-1" || record.CreatedAt != "2026-10-01T08:00:00.000Z" {
		t.Fatalf("identity = %+v", record)
	}
	if record.Actor != "op1" || record.Role != "operator" {
		t.Fatalf("actor = %q/%q", record.Actor, record.Role)
	}
	if record.Bucket != "data" || record.Operation != "credit" || record.TicketID != "INC100234" {
		t.Fatalf("intent = %+v", record)
	}
	if record.Amount == nil || *record.Amount != 1073741824 {
		t.Fatalf("amount = %v", record.Amount)
	}
	if record.BeforeVersion == nil || *record.BeforeVersion != 3 || record.AfterVersion == nil || *record.AfterVersion != 4 {
		t.Fatalf("versions = %v/%v", record.BeforeVersion, record.AfterVersion)
	}
}

func TestMapAdjustmentDoc_SurvivesMissingNestedDocuments(t *testing.T) {
	record := mapAdjustmentDoc(bson.M{"_id": "adj-2", "timestamp": "2026-10-01T08:00:00.000Z"})

	if record.Amount != nil || record.BeforeVersion != nil || record.AfterVersion != nil {
		t.Fatalf("absent metadata must stay absent: %+v", record)
	}
	if record.Actor != "" || record.Bucket != "" {
		t.Fatalf("absent nested fields must stay empty: %+v", record)
	}
}

func TestMapAdjustmentDoc_AcceptsBsonDSubdocuments(t *testing.T) {
	doc := bson.M{
		"_id":          "adj-3",
		"actor":        "op2",
		"actorContext": bson.D{{Key: "username", Value: "op2"}, {Key: "role", Value: "admin"}},
		"metadata": bson.D{
			{Key: "bucket", Value: "sms"},
			{Key: "operation", Value: "debit"},
			{Key: "amount", Value: float64(5)},
		},
	}

	record := mapAdjustmentDoc(doc)

	if record.Actor != "op2" || record.Role != "admin" {
		t.Fatalf("actor = %q/%q", record.Actor, record.Role)
	}
	if record.Amount == nil || *record.Amount != 5 {
		t.Fatalf("amount = %v", record.Amount)
	}
}

func TestMapAdjustmentDoc_FallsBackToActorContextWhenDisplayNameIsAbsent(t *testing.T) {
	record := mapAdjustmentDoc(bson.M{
		"_id":          "adj-4",
		"actorContext": bson.M{"username": "op3", "role": "viewer"},
	})

	if record.Actor != "op3" || record.Role != "viewer" {
		t.Fatalf("actor = %q/%q", record.Actor, record.Role)
	}
}
