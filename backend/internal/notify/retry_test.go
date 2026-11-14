package notify

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"subscriber/internal/auth"
)

type fakeDeliveryRetrier struct {
	delivery *Delivery
	err      error
	gotID    string
}

func (f *fakeDeliveryRetrier) RetryDelivery(_ context.Context, id string, _ time.Time) (*Delivery, error) {
	f.gotID = id
	return f.delivery, f.err
}

func retryRequest(id, role string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/nf-notifications/deliveries/"+id+"/retry", nil)
	req.SetPathValue("deliveryId", id)
	return req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		Username:       "ops",
		NormalizedRole: role,
	}))
}

func retryResponseCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v (%s)", err, rec.Body.String())
	}
	return body.Code
}

func TestValidateDeliveryID(t *testing.T) {
	valid := []string{
		"0192f0c0-a000-7000-8000-0000000000a1",
		"0192F0C0-A000-7000-8000-0000000000A1",
		strings.Repeat("a", 32),
	}
	for _, id := range valid {
		if err := ValidateDeliveryID(id); err != nil {
			t.Fatalf("%q must be accepted: %v", id, err)
		}
	}
	invalidIDs := []string{"", "   ", "abc", strings.Repeat("a", 31), strings.Repeat("a", 33), "../../etc/passwd", "0192f0c0-a000-7000-8000-0000000000zz"}
	for _, id := range invalidIDs {
		if err := ValidateDeliveryID(id); err == nil {
			t.Fatalf("%q must be rejected", id)
		}
	}
}

func TestRetryDeliveryHandlerRequeuesTerminalFailure(t *testing.T) {
	id := "0192f0c0-a000-7000-8000-0000000000a1"
	retrier := &fakeDeliveryRetrier{delivery: &Delivery{ID: id, Status: DeliveryPending}}
	h := &Handler{retrier: retrier}
	rec := httptest.NewRecorder()

	h.RetryDelivery(rec, retryRequest(id, "operator"))
	if rec.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if retrier.gotID != id {
		t.Fatalf("retry target = %q, want %q", retrier.gotID, id)
	}
}

func TestRetryDeliveryHandlerRejectsNonRetryableState(t *testing.T) {
	id := "0192f0c0-a000-7000-8000-0000000000a1"
	h := &Handler{retrier: &fakeDeliveryRetrier{err: errDeliveryNotRetryable}}
	rec := httptest.NewRecorder()

	h.RetryDelivery(rec, retryRequest(id, "operator"))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
	if code := retryResponseCode(t, rec); code != "NOTIFY_DELIVERY_NOT_RETRYABLE" {
		t.Fatalf("code = %q", code)
	}
}

func TestRetryDeliveryHandlerRejectsBadIDAndRole(t *testing.T) {
	id := "0192f0c0-a000-7000-8000-0000000000a1"
	h := &Handler{retrier: &fakeDeliveryRetrier{}}

	rec := httptest.NewRecorder()
	h.RetryDelivery(rec, retryRequest("not-a-delivery", "operator"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed id status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	rec = httptest.NewRecorder()
	h.RetryDelivery(rec, retryRequest(id, "viewer"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}
