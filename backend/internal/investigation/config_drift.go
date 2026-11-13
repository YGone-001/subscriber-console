package investigation

import (
	"context"
	"subscriber/internal/configdrift"
	"time"
)

func anchorIdentity(alertID, kind, id string) (string, string, error) {
	if alertID != "" {
		if kind != "" || id != "" {
			return "", "", fail(400, "INVESTIGATION_ANCHOR_CONFLICT", "Use either alertId or anchorKind and anchorId")
		}
		kind = "nf_alert"
		id = alertID
	}
	if (kind != "nf_alert" && kind != "config_drift") || !validID(id) {
		return "", "", fail(400, "INVESTIGATION_INVALID_ID", "A supported anchor kind and UUID v4 are required")
	}
	return kind, id, nil
}
func recordAnchor(r *Record) (string, string) {
	if r.AnchorKind == "" {
		return "nf_alert", r.AlertID
	}
	return r.AnchorKind, r.AnchorID
}
func (s *Service) anchor(ctx context.Context, kind, id string) (*AlertFact, error) {
	if kind == "nf_alert" {
		return s.evidence.Anchor(ctx, id)
	}
	r, ok := s.evidence.(interface {
		DriftAnchor(context.Context, string) (*AlertFact, error)
	})
	if !ok {
		return nil, fail(503, "INVESTIGATION_ANCHOR_UNAVAILABLE", "Configuration drift evidence is unavailable")
	}
	return r.DriftAnchor(ctx, id)
}
func (r *MongoRepository) DriftAnchor(ctx context.Context, id string) (*AlertFact, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	a, e := configdrift.NewRepository(r.cases.Database()).Alert(ctx, id)
	if e != nil {
		if e == configdrift.ErrNotFound {
			return nil, ErrNotFound
		}
		return nil, e
	}
	out := &AlertFact{AnchorKind: "config_drift", AnchorID: a.ID, SourceID: a.SourceID, ResourceID: a.ResourceID, Name: a.SourceName, Severity: a.Severity, State: a.State, First: a.OpenedAt.Format(time.RFC3339Nano), Last: a.Latest.At.Format(time.RFC3339Nano), TriggerCount: a.TriggerCount, BaselineID: a.BaselineID, BaselineRevision: a.BaselineRevision, TriggerSnapshotID: a.Trigger.SnapshotID, LatestSnapshotID: a.Latest.SnapshotID, TriggerObservationID: a.Trigger.ObservationID, LatestObservationID: a.Latest.ObservationID, EndReason: a.EndReason}
	if a.AcknowledgedAt != nil {
		out.Acknowledged = a.AcknowledgedAt.Format(time.RFC3339Nano)
	}
	if a.ResolvedAt != nil {
		out.Resolved = a.ResolvedAt.Format(time.RFC3339Nano)
	}
	return out, nil
}
