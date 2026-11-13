package configdrift

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"subscriber/internal/configsnapshots"
)

func stableID(s string) string {
	h := sha256.Sum256([]byte(s))
	b := h[:16]
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	v := hex.EncodeToString(b)
	return v[:8] + "-" + v[8:12] + "-" + v[12:16] + "-" + v[16:20] + "-" + v[20:]
}
func evidence(in configsnapshots.DriftInput) Evidence {
	return Evidence{in.ObservationID, in.SnapshotID, in.Comparison, in.At, in.Sequence}
}

// reduce is independent from persistence, wall-clock ordering and network I/O.
func reduce(st *State, in configsnapshots.DriftInput) error {
	if in.Version != 1 || in.Sequence != st.Sequence+1 {
		return fail(409, "CONFIG_DRIFT_INPUT_ORDER", "Unknown input version or non-contiguous sequence")
	}
	st.Sequence = in.Sequence
	st.Input = in
	st.Evaluation.ProcessedSequence = in.Sequence
	st.Evaluation.EvaluatedAt = in.At
	set := func(state, why string) { st.Evaluation.State = state; st.Evaluation.Reason = why }
	closeAlert := func(why string) {
		if st.Current == nil {
			return
		}
		a := *st.Current
		if a.State == "resolved" {
			return
		}
		a.State = "resolved"
		a.EndReason = why
		a.ResolvedAt = &in.At
		a.Revision++
		st.Current = nil
		st.Pending = mutation(in, a, "resolved", why, why == "returned_to_baseline")
	}
	switch in.Kind {
	case "environment":
		closeAlert(in.Reason)
		set("comparison_unavailable", in.Reason)
		return nil
	case "baseline":
		why := "baseline_superseded"
		if in.BaselineID == "" {
			why = "baseline_removed"
		}
		closeAlert(why)
		if in.BaselineID == "" {
			set("not_armed", "no_baseline")
		} else {
			set("awaiting_observation", "baseline_changed")
		}
		return nil
	case "policy":
		if !in.Policy.Enabled {
			closeAlert("policy_disabled")
			set("disabled", "policy_disabled")
		} else if st.Current == nil {
			set("awaiting_observation", "policy_enabled")
		}
		return nil
	case "observation":
	default:
		return fail(409, "CONFIG_DRIFT_INPUT_KIND", "Unknown input kind")
	}
	if !in.Policy.Enabled {
		set("disabled", "policy_disabled")
		return nil
	}
	if in.ResourceID == "" {
		set("not_armed", "resource_unbound")
		return nil
	}
	if in.BaselineID == "" {
		set("not_armed", "no_baseline")
		return nil
	}
	if in.Status != "ok" {
		set("evaluation_unavailable", in.Status)
		return nil
	}
	if in.Comparison != "unchanged" && in.Comparison != "visible_changed" && in.Comparison != "unprojected_changed" {
		set("comparison_unavailable", in.Comparison)
		return nil
	}
	if st.Current != nil && (st.Current.Generation != in.Generation || st.Current.BaselineID != in.BaselineID || st.Current.BaselineRevision != in.BaselineRevision || st.Current.ResourceID != in.ResourceID) {
		set("comparison_unavailable", "cycle_mismatch")
		return nil
	}
	ev := evidence(in)
	st.Evaluation.LastVerified = &ev
	if in.Comparison == "unchanged" {
		set("in_sync", "")
		closeAlert("returned_to_baseline")
		return nil
	}
	set("drifted", in.Comparison)
	if st.Current == nil {
		a := Alert{ID: stableID(in.SourceID + ":" + strconv.FormatInt(in.Sequence, 10)), SourceID: in.SourceID, SourceName: in.SourceName, ResourceID: in.ResourceID, Generation: in.Generation, Profile: in.Profile, BaselineID: in.BaselineID, BaselineRevision: in.BaselineRevision, PolicyRevision: in.Policy.Revision, Severity: in.Policy.Severity, State: "active", Revision: 1, TriggerCount: 1, OpenedAt: in.At, Trigger: ev, Latest: ev}
		st.Current = &a
		st.Pending = mutation(in, a, "opened", "", true)
	} else {
		a := *st.Current
		a.Latest = ev
		a.TriggerCount++
		a.Revision++
		st.Current = &a
		st.Pending = mutation(in, a, "observed", "", false)
	}
	return nil
}
func mutation(in configsnapshots.DriftInput, a Alert, kind, reason string, notify bool) *Mutation {
	id := stableID(in.SourceID + ":" + strconv.FormatInt(in.Sequence, 10) + ":" + kind)
	return &Mutation{ID: id, Alert: a, Event: Event{ID: id, AlertID: a.ID, SourceID: a.SourceID, Kind: kind, Reason: reason, At: in.At, Evidence: evidence(in)}, Notify: notify}
}
