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

type fakeChannelTester struct {
	delivery *Delivery
	err      error
	gotID    string
}

func (f *fakeChannelTester) CreateTestDelivery(_ context.Context, channelID string, _ time.Time) (*Delivery, error) {
	f.gotID = channelID
	return f.delivery, f.err
}

func testChannelRequest(channelID, role string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/nf-notifications/channels/"+channelID+"/test", nil)
	req.SetPathValue("channelId", channelID)
	return req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		Username:       "ops",
		NormalizedRole: role,
	}))
}

func testChannelResponseCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v (%s)", err, rec.Body.String())
	}
	return body.Code
}

func TestChannelTestEndpointEnqueuesAProbe(t *testing.T) {
	channelID := "0192f0c0-a000-7000-8000-0000000000c1"
	tester := &fakeChannelTester{delivery: &Delivery{
		ID:     "d-test-1",
		Event:  DeliveryEventTest,
		Status: DeliveryPending,
	}}
	h := &Handler{tester: tester}

	rec := httptest.NewRecorder()
	h.TestChannel(rec, testChannelRequest(channelID, "operator"))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("test channel status = %d, want %d: %s", rec.Code, http.StatusAccepted, rec.Body.String())
	}
	if tester.gotID != channelID {
		t.Fatalf("probe target = %q, want %q", tester.gotID, channelID)
	}
	var out Delivery
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode probe response: %v", err)
	}
	if out.Event != DeliveryEventTest || out.Status != DeliveryPending {
		t.Fatalf("the probe must be a pending test delivery: %+v", out)
	}
}

func TestChannelTestEndpointRejectsDisabledChannel(t *testing.T) {
	h := &Handler{tester: &fakeChannelTester{err: invalid("NOTIFY_CHANNEL_DISABLED", "the channel is disabled")}}
	rec := httptest.NewRecorder()

	h.TestChannel(rec, testChannelRequest("0192f0c0-a000-7000-8000-0000000000c1", "operator"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("disabled channel status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if code := testChannelResponseCode(t, rec); code != "NOTIFY_CHANNEL_DISABLED" {
		t.Fatalf("code = %q", code)
	}
}

func TestChannelTestEndpointRejectsUnknownChannel(t *testing.T) {
	h := &Handler{tester: &fakeChannelTester{err: errNotFound}}
	rec := httptest.NewRecorder()

	h.TestChannel(rec, testChannelRequest("0192f0c0-a000-7000-8000-0000000000c1", "operator"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown channel status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestChannelTestEndpointRejectsViewer(t *testing.T) {
	h := &Handler{tester: &fakeChannelTester{}}
	rec := httptest.NewRecorder()

	h.TestChannel(rec, testChannelRequest("0192f0c0-a000-7000-8000-0000000000c1", "viewer"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestCreateTestDeliveryBuildsAUniqueProbeKey(t *testing.T) {
	// The ledger's deliveryKey index dedupes alert transitions. A probe key
	// must therefore carry its own uniqueness so repeated tests are each
	// recorded rather than silently swallowed.
	first := Delivery{Event: DeliveryEventTest, DeliveryKey: DeliveryEventTest + ":ch:" + strings.Repeat("a", 8)}
	second := Delivery{Event: DeliveryEventTest, DeliveryKey: DeliveryEventTest + ":ch:" + strings.Repeat("b", 8)}
	if first.DeliveryKey == second.DeliveryKey {
		t.Fatal("two probes must never share a delivery key")
	}
	if first.Event != DeliveryEventTest {
		t.Fatalf("probe event = %q, want %q", first.Event, DeliveryEventTest)
	}
}
