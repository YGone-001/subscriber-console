package configdrift

import (
	"context"
	"encoding/json"
	"errors"
	"subscriber/internal/configsnapshots"
	"testing"
	"time"
)

func input(n int64, kind, comparison string) configsnapshots.DriftInput {
	return configsnapshots.DriftInput{Version: 1, Sequence: n, Kind: kind, SourceID: "10000000-0000-4000-8000-000000000001", ResourceID: "20000000-0000-4000-8000-000000000001", SourceName: "Synthetic MME", Generation: "g1", Profile: "metadata-only-v1", BaselineID: "30000000-0000-4000-8000-000000000001", BaselineRevision: 2, Policy: configsnapshots.DriftPolicy{Enabled: true, Severity: "warning", Revision: 1}, ObservationID: stableID("obs" + string(rune(n))), SnapshotID: stableID(comparison), Status: "ok", Comparison: comparison, At: time.Date(2026, 11, 13, 0, 0, int(n), 0, time.UTC)}
}
func step(t *testing.T, s *State, in configsnapshots.DriftInput) {
	t.Helper()
	s.Pending = nil
	if e := reduce(s, in); e != nil {
		t.Fatal(e)
	}
}
func TestDriftEpisodeRetainsBaselineAndOpeningSeverity(t *testing.T) {
	s := &State{}
	step(t, s, input(1, "policy", ""))
	if s.Current != nil {
		t.Fatal("policy replayed old measurement")
	}
	step(t, s, input(2, "observation", "visible_changed"))
	id := s.Current.ID
	if s.Current.State != "active" || !s.Pending.Notify || s.Current.TriggerCount != 1 {
		t.Fatal("drift not opened")
	}
	next := input(3, "observation", "visible_changed")
	next.Policy.Severity = "critical"
	step(t, s, next)
	if s.Current.ID != id || s.Current.TriggerCount != 2 || s.Current.Severity != "warning" || s.Pending.Notify {
		t.Fatal("duplicate drift reopened or changed severity")
	}
	step(t, s, input(4, "observation", "unprojected_changed"))
	if s.Current.ID != id {
		t.Fatal("metadata drift reopened")
	}
	step(t, s, input(5, "observation", "unchanged"))
	if s.Current != nil || s.Pending.Alert.EndReason != "returned_to_baseline" || !s.Pending.Notify {
		t.Fatal("baseline return did not recover")
	}
	step(t, s, input(6, "observation", "visible_changed"))
	if s.Current.ID == id {
		t.Fatal("new drift reused closed episode")
	}
}
func TestUnavailableAndIncompatibleCannotRecover(t *testing.T) {
	for _, status := range []string{"unreadable", "changed_during_read", "publication_pending", "ok"} {
		t.Run(status, func(t *testing.T) {
			s := &State{}
			step(t, s, input(1, "observation", "unprojected_changed"))
			old := s.Current.ID
			last := *s.Evaluation.LastVerified
			in := input(2, "observation", "incompatible")
			in.Status = status
			step(t, s, in)
			if s.Current == nil || s.Current.ID != old || s.Pending != nil || *s.Evaluation.LastVerified != last {
				t.Fatal("unavailable evidence recovered or overwrote verified fact")
			}
		})
	}
}
func TestAdministrativeEndIsNotRecovery(t *testing.T) {
	for _, tc := range []struct {
		kind, reason    string
		clear, disabled bool
	}{{"baseline", "baseline_superseded", false, false}, {"baseline", "baseline_removed", true, false}, {"policy", "policy_disabled", false, true}, {"environment", "source_withdrawn", false, false}, {"environment", "resource_retired", false, false}} {
		t.Run(tc.reason, func(t *testing.T) {
			s := &State{}
			step(t, s, input(1, "observation", "visible_changed"))
			in := input(2, tc.kind, "")
			in.Reason = tc.reason
			if tc.clear {
				in.BaselineID = ""
			}
			if tc.disabled {
				in.Policy.Enabled = false
			}
			step(t, s, in)
			if s.Current != nil || s.Pending.Notify || s.Pending.Alert.EndReason != tc.reason {
				t.Fatal("administrative closure forged recovery")
			}
		})
	}
}
func TestCycleFenceAndOrdering(t *testing.T) {
	s := &State{}
	step(t, s, input(1, "observation", "visible_changed"))
	in := input(2, "observation", "unchanged")
	in.BaselineRevision++
	step(t, s, in)
	if s.Current == nil || s.Pending != nil || s.Evaluation.State != "comparison_unavailable" {
		t.Fatal("wrong cycle recovered")
	}
	if reduce(s, input(4, "observation", "unchanged")) == nil {
		t.Fatal("gap accepted")
	}
}

// Each fake store boundary can fail after a durable earlier write. Reconstructing
// the service exercises restart replay, not merely a retry in the same instance.
type memoryStore struct {
	state           *State
	alerts          map[string]Alert
	events          map[string]Event
	failMaterialize bool
}

func clone[T any](in T) T {
	b, _ := json.Marshal(in)
	var out T
	_ = json.Unmarshal(b, &out)
	return out
}
func (r *memoryStore) State(_ context.Context, id string) (*State, error) {
	if r.state == nil {
		return &State{SourceID: id}, nil
	}
	v := clone(*r.state)
	return &v, nil
}
func (r *memoryStore) Save(_ context.Context, s *State, version int64) error {
	if r.state != nil && r.state.Version != version {
		return ErrConflict
	}
	s.Version = version + 1
	v := clone(*s)
	r.state = &v
	return nil
}
func (r *memoryStore) Materialize(_ context.Context, m *Mutation) error {
	if r.failMaterialize {
		r.failMaterialize = false
		return errors.New("synthetic projection interruption")
	}
	if r.alerts == nil {
		r.alerts = map[string]Alert{}
		r.events = map[string]Event{}
	}
	r.alerts[m.Alert.ID] = m.Alert
	r.events[m.Event.ID] = m.Event
	return nil
}
func (r *memoryStore) Alert(_ context.Context, id string) (*Alert, error) {
	v, ok := r.alerts[id]
	if !ok {
		return nil, ErrNotFound
	}
	return &v, nil
}
func (r *memoryStore) List(context.Context, ListQuery) (*ListView, error) { panic("unused") }
func (r *memoryStore) Events(context.Context, string, string, int) (*Page[Event], error) {
	panic("unused")
}

type notices struct {
	failed bool
	keys   map[string]bool
}

func (n *notices) NotifyConfigDrift(_ context.Context, a Alert, kind string) error {
	if n.failed {
		n.failed = false
		return errors.New("synthetic delivery ledger interruption")
	}
	if n.keys == nil {
		n.keys = map[string]bool{}
	}
	n.keys[a.ID+":"+kind] = true
	return nil
}
func TestProjectionAndNotificationCrashReplay(t *testing.T) {
	for _, point := range []string{"projection", "notification"} {
		t.Run(point, func(t *testing.T) {
			r := &memoryStore{failMaterialize: point == "projection"}
			sink := &notices{failed: point == "notification"}
			s := NewService(r, nil, nil, nil)
			s.SetSink(sink)
			in := input(1, "observation", "visible_changed")
			if s.Consume(context.Background(), in) == nil {
				t.Fatal("fault not exercised")
			}
			if r.state == nil || r.state.Pending == nil || r.state.Sequence != 1 {
				t.Fatal("durable recovery input missing")
			}
			restart := NewService(r, nil, nil, nil)
			restart.SetSink(sink)
			if e := restart.Consume(context.Background(), in); e != nil {
				t.Fatal(e)
			}
			if e := restart.Consume(context.Background(), in); e != nil {
				t.Fatal(e)
			}
			if len(r.alerts) != 1 || len(r.events) != 1 || len(sink.keys) != 1 || r.state.Pending != nil {
				t.Fatal("replay lost or duplicated an episode or intent")
			}
		})
	}
}
func TestCursorCannotWidenScope(t *testing.T) {
	q := ListQuery{SourceID: input(1, "policy", "").SourceID}
	v := encode(time.Now().UTC(), stableID("alert"), scope(q))
	q.ResourceID = input(1, "policy", "").ResourceID
	if _, e := after(*v, scope(q), "openedAt"); e == nil {
		t.Fatal("cross-filter cursor accepted")
	}
}
