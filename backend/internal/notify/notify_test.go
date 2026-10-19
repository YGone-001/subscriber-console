package notify

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"subscriber/internal/nfalert"
)

func TestValidateChannel(t *testing.T) {
	if err := ValidateChannel("ops", ChannelKindWebhook, "https://hooks.example.com/alert", "secret"); err != nil {
		t.Fatalf("a valid webhook channel must be accepted: %v", err)
	}
	if err := ValidateChannel("ops", ChannelKindWebhook, "http://127.0.0.1:9000/hook", ""); err != nil {
		t.Fatalf("a loopback http channel is accepted for local sinks: %v", err)
	}

	cases := map[string][4]string{
		"missing name":     {"", ChannelKindWebhook, "https://x.example/hook", ""},
		"bad kind":         {"ops", "slack", "https://x.example/hook", ""},
		"plain http":       {"ops", ChannelKindWebhook, "http://x.example/hook", ""},
		"credentials":      {"ops", ChannelKindWebhook, "https://u:p@x.example/hook", ""},
		"fragment":         {"ops", ChannelKindWebhook, "https://x.example/hook#frag", ""},
		"missing host":     {"ops", ChannelKindWebhook, "https:///hook", ""},
		"missing url":      {"ops", ChannelKindWebhook, "", ""},
		"oversized secret": {"ops", ChannelKindWebhook, "https://x.example/hook", strings.Repeat("s", MaxDeliverySecretBytes+1)},
	}
	for name, args := range cases {
		if err := ValidateChannel(args[0], args[1], args[2], args[3]); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestValidateEscalation(t *testing.T) {
	valid := CreateEscalationRequest{
		Name:                 "critical to ops",
		Severities:           []string{nfalert.SeverityCritical},
		ChannelIDs:           []string{"ch-1"},
		EscalateAfterSeconds: 300,
		EscalateChannelIDs:   []string{"ch-2"},
	}
	if err := ValidateEscalation(valid); err != nil {
		t.Fatalf("a valid escalation must be accepted: %v", err)
	}
	validNoEscalation := valid
	validNoEscalation.EscalateAfterSeconds = 0
	validNoEscalation.EscalateChannelIDs = nil
	if err := ValidateEscalation(validNoEscalation); err != nil {
		t.Fatalf("an escalation without a delay is accepted: %v", err)
	}

	cases := map[string]CreateEscalationRequest{
		"no severity":      {Name: "x", ChannelIDs: []string{"ch"}},
		"bad severity":     {Name: "x", Severities: []string{"nope"}, ChannelIDs: []string{"ch"}},
		"no channels":      {Name: "x", Severities: []string{nfalert.SeverityCritical}},
		"delay no channel": {Name: "x", Severities: []string{nfalert.SeverityCritical}, ChannelIDs: []string{"ch"}, EscalateAfterSeconds: 300},
	}
	for name, req := range cases {
		if err := ValidateEscalation(req); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestEscalationMatches(t *testing.T) {
	rule := Escalation{
		Enabled:    true,
		Severities: []string{nfalert.SeverityCritical, nfalert.SeverityWarning},
		RuleIDs:    []string{"rule-1"},
	}
	event := nfalert.AlertEvent{Severity: nfalert.SeverityCritical, RuleID: "rule-1"}
	if !escalationMatches(rule, event) {
		t.Fatal("a matching severity and rule must match")
	}
	if escalationMatches(rule, nfalert.AlertEvent{Severity: nfalert.SeverityInfo, RuleID: "rule-1"}) {
		t.Fatal("an unmatched severity must not match")
	}
	if escalationMatches(rule, nfalert.AlertEvent{Severity: nfalert.SeverityCritical, RuleID: "rule-9"}) {
		t.Fatal("an unmatched rule must not match")
	}

	all := Escalation{Enabled: true, Severities: []string{nfalert.SeverityCritical}}
	if !escalationMatches(all, nfalert.AlertEvent{Severity: nfalert.SeverityCritical, RuleID: "any"}) {
		t.Fatal("an empty rule list matches every rule")
	}
	if escalationMatches(Escalation{Enabled: false, Severities: []string{nfalert.SeverityCritical}}, event) {
		t.Fatal("a disabled escalation never matches")
	}
}

func TestBackoffDelay(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	first := backoffDelay(1, now)
	if first.Sub(now) != DeliveryBaseBackoff {
		t.Fatalf("first retry must be the base backoff, got %v", first.Sub(now))
	}
	capped := backoffDelay(20, now)
	if capped.Sub(now) != DeliveryMaxBackoff {
		t.Fatalf("backoff must cap at the maximum, got %v", capped.Sub(now))
	}
}

func TestSignBody(t *testing.T) {
	body := []byte(`{"event":"opened"}`)
	secret := "s3cret"
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	if got := signBody(secret, body); got != want {
		t.Fatalf("signature must be a hex HMAC-SHA256: got %s want %s", got, want)
	}
}

func TestWebhookSender(t *testing.T) {
	var received []byte
	var signature, idempotency string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		signature = r.Header.Get("X-Notification-Signature")
		idempotency = r.Header.Get("Idempotency-Key")
		received = make([]byte, r.ContentLength)
		_, _ = r.Body.Read(received)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	channel := &NotificationChannel{URL: server.URL + "/hook", Secret: "s3cret"}
	delivery := &Delivery{ID: "d-1", DeliveryKey: "k-1", Event: "opened", AlertID: "a-1", Severity: "critical"}
	sender := NewWebhookSender(nil)
	if err := sender.Send(context.Background(), channel, delivery); err != nil {
		t.Fatalf("send: %v", err)
	}
	if !strings.Contains(string(received), `"alertId":"a-1"`) {
		t.Fatalf("the payload must carry the alert identity: %s", received)
	}
	if !strings.HasPrefix(signature, "sha256=") {
		t.Fatalf("the request must be signed: %q", signature)
	}
	if idempotency != "k-1" {
		t.Fatalf("the idempotency key must be forwarded: %q", idempotency)
	}

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer failing.Close()
	if err := sender.Send(context.Background(), &NotificationChannel{URL: failing.URL}, delivery); err == nil {
		t.Fatal("a non-2xx response must be a delivery error")
	}
}

/* ------------------------------------------------------------------ worker -- */

type fakeStore struct {
	channel  *NotificationChannel
	sent     bool
	skipped  bool
	failed   string
	failOpen bool
}

func (f *fakeStore) ClaimDue(context.Context, time.Time) (*Delivery, error) { return nil, nil }
func (f *fakeStore) GetChannel(context.Context, string) (*NotificationChannel, error) {
	if f.failOpen {
		return nil, nil
	}
	return f.channel, nil
}
func (f *fakeStore) MarkSent(context.Context, string, time.Time) error { f.sent = true; return nil }
func (f *fakeStore) MarkSkipped(context.Context, string, time.Time) error {
	f.skipped = true
	return nil
}
func (f *fakeStore) MarkFailed(context.Context, string, int, string, time.Time) error {
	f.failed = "failed"
	return nil
}

type fakeSender struct {
	err     error
	payload *WebhookPayload
}

func (f *fakeSender) Send(_ context.Context, _ *NotificationChannel, d *Delivery) error {
	f.payload = &WebhookPayload{DeliveryID: d.ID, Event: d.Event, AlertID: d.AlertID}
	return f.err
}

type fakeState struct{ state string }

func (f *fakeState) AlertState(context.Context, string) (string, error) { return f.state, nil }

func TestWorkerDeliversAndMarksSent(t *testing.T) {
	store := &fakeStore{channel: &NotificationChannel{Enabled: true, URL: "https://x.example/hook"}}
	sender := &fakeSender{}
	worker := NewWorker(store, sender, nil, nil)

	worker.deliver(&Delivery{ID: "d-1", Event: "opened", AlertID: "a-1"})
	if !store.sent || sender.payload == nil {
		t.Fatalf("a successful send must mark the delivery sent: sent=%v payload=%#v", store.sent, sender.payload)
	}
}

func TestWorkerRetriesOnSendError(t *testing.T) {
	store := &fakeStore{channel: &NotificationChannel{Enabled: true}}
	sender := &fakeSender{err: context.DeadlineExceeded}
	worker := NewWorker(store, sender, nil, nil)

	worker.deliver(&Delivery{ID: "d-1", Event: "opened"})
	if store.failed != "failed" || store.sent {
		t.Fatalf("a failed send must be retried, not marked sent: %#v", store)
	}
}

func TestWorkerSkipsEscalationAfterRecovery(t *testing.T) {
	store := &fakeStore{channel: &NotificationChannel{Enabled: true}}
	sender := &fakeSender{}
	worker := NewWorker(store, sender, &fakeState{state: nfalert.AlertStateResolved}, nil)

	worker.deliver(&Delivery{ID: "d-1", Event: DeliveryEventEscalate, AlertID: "a-1"})
	if !store.skipped || store.sent || sender.payload != nil {
		t.Fatalf("a resolved escalation must be skipped, not sent: %#v", store)
	}
}

func TestWorkerFailsWhenChannelUnavailable(t *testing.T) {
	store := &fakeStore{failOpen: true}
	worker := NewWorker(store, &fakeSender{}, nil, nil)

	worker.deliver(&Delivery{ID: "d-1", Event: "opened"})
	if store.failed != "failed" {
		t.Fatal("a missing channel must be a retryable failure")
	}
}
