package notify

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"subscriber/internal/configdrift"
	"testing"
)

func TestExplicitConfigurationSubscription(t *testing.T) {
	a := configdrift.Alert{SourceID: "source-a", Severity: "warning"}
	legacy := Escalation{Enabled: true, Severities: []string{"warning"}}
	if configMatches(legacy, a) {
		t.Fatal("legacy NF subscription received configuration events")
	}
	legacy.SubjectKinds = []string{"config_drift"}
	legacy.SourceIDs = []string{"source-b"}
	if configMatches(legacy, a) {
		t.Fatal("source scope widened")
	}
	legacy.SourceIDs = []string{"source-a"}
	if !configMatches(legacy, a) {
		t.Fatal("explicit subject did not match")
	}
	if validateSubjects([]string{"unknown"}, nil) == nil || validateSubjects(nil, []string{"source-a"}) == nil {
		t.Fatal("invalid subject accepted")
	}
}

type configState struct {
	state string
	err   error
}

func (r *configState) Alert(context.Context, string) (*configdrift.Alert, error) {
	if r.err != nil {
		return nil, r.err
	}
	return &configdrift.Alert{State: r.state}, nil
}
func TestConfigurationEscalationSkipsOnlyVerifiedClosure(t *testing.T) {
	for _, closed := range []bool{false, true} {
		store := &fakeStore{channel: &NotificationChannel{Enabled: true}}
		sender := &fakeSender{}
		state := &configState{state: "resolved"}
		if !closed {
			state.err = errors.New("synthetic lookup interruption")
		}
		worker := NewWorker(store, sender, NewSubjectStateReader(&fakeState{state: "active"}, state), nil)
		worker.deliver(&Delivery{ID: "d", Event: DeliveryEventEscalate, SubjectKind: "config_drift", SubjectID: "config-id"})
		if closed {
			if !store.skipped || sender.payload != nil {
				t.Fatal("closed escalation sent")
			}
		} else if store.failed == "" || store.skipped || sender.payload != nil {
			t.Fatal("unknown state treated as resolved or active")
		}
	}
}
func TestConfigurationWebhookHasVersionedSubjectWithoutNfIdentity(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if e := json.NewDecoder(r.Body).Decode(&got); e != nil {
			t.Error(e)
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	e := NewWebhookSender(srv.Client()).Send(context.Background(), &NotificationChannel{URL: srv.URL}, &Delivery{ID: "d", SubjectKind: "config_drift", SubjectID: "config-id", SourceID: "source-id", ResourceID: "resource-id", PayloadVersion: 1, Event: "opened"})
	if e != nil {
		t.Fatal(e)
	}
	if got["subjectKind"] != "config_drift" || got["subjectId"] != "config-id" || got["schemaVersion"] != float64(1) {
		t.Fatal(got)
	}
	for _, k := range []string{"alertId", "targetId", "ruleId", "fingerprint", "projection"} {
		if _, ok := got[k]; ok {
			t.Fatal("configuration payload invented NF identity or leaked content", k)
		}
	}
}
