package notify

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/configdrift"
	"subscriber/internal/configsnapshots"
	"time"
)

func subjectMatches(kinds []string, kind string) bool {
	if len(kinds) == 0 {
		return kind == "nf_alert"
	}
	for _, v := range kinds {
		if v == kind {
			return true
		}
	}
	return false
}
func validateSubjects(kinds, sourceIDs []string) error {
	if len(kinds) > 2 || len(sourceIDs) > 128 {
		return invalid("NOTIFY_INVALID_SUBJECT", "Subject filters exceed their bounds")
	}
	seen := map[string]bool{}
	for _, v := range kinds {
		if (v != "nf_alert" && v != "config_drift") || seen[v] {
			return invalid("NOTIFY_INVALID_SUBJECT", "Unsupported or duplicate subject kind")
		}
		seen[v] = true
	}
	for _, id := range sourceIDs {
		if !configsnapshots.ValidID(id) {
			return invalid("NOTIFY_INVALID_SUBJECT", "Source IDs must be canonical UUIDs")
		}
	}
	if len(sourceIDs) > 0 && !seen["config_drift"] {
		return invalid("NOTIFY_INVALID_SUBJECT", "Source filters require explicit configuration drift subscription")
	}
	return nil
}
func configMatches(r Escalation, a configdrift.Alert) bool {
	if !r.Enabled || !subjectMatches(r.SubjectKinds, "config_drift") {
		return false
	}
	severity := false
	for _, v := range r.Severities {
		severity = severity || v == a.Severity
	}
	if !severity {
		return false
	}
	if len(r.SourceIDs) == 0 {
		return true
	}
	for _, v := range r.SourceIDs {
		if v == a.SourceID {
			return true
		}
	}
	return false
}

// NotifyConfigDrift is a reliable, idempotent outbox observer. It returns storage
// errors to the source replay journal and performs no network I/O.
func (r *Repository) NotifyConfigDrift(ctx context.Context, a configdrift.Alert, event string) error {
	if event != "opened" && (event != "resolved" || a.EndReason != "returned_to_baseline") {
		return nil
	}
	rules, e := r.ListEscalations(ctx)
	if e != nil {
		return e
	}
	if len(rules) > MaxEscalations {
		return errors.New("notification subscription bound exceeded")
	}
	now := r.now().UTC()
	for _, rule := range rules {
		if !configMatches(rule, a) {
			continue
		}
		for _, id := range rule.ChannelIDs {
			if e = r.enqueueConfig(ctx, a, event, id, now, time.Time{}); e != nil {
				return e
			}
		}
		if event == "opened" && rule.EscalateAfterSeconds > 0 {
			for _, id := range rule.EscalateChannelIDs {
				if e = r.enqueueConfig(ctx, a, DeliveryEventEscalate, id, now, now.Add(time.Duration(rule.EscalateAfterSeconds)*time.Second)); e != nil {
					return e
				}
			}
		}
	}
	return nil
}
func (r *Repository) enqueueConfig(ctx context.Context, a configdrift.Alert, event, channel string, now, notBefore time.Time) error {
	key := "config_drift:" + a.ID + ":" + event + ":" + channel
	sum := sha256.Sum256([]byte(key))
	id := hex.EncodeToString(sum[:16])
	next := now
	if !notBefore.IsZero() {
		next = notBefore
	}
	occurred := a.OpenedAt
	if event == "resolved" && a.ResolvedAt != nil {
		occurred = *a.ResolvedAt
	}
	doc := Delivery{ID: id, DeliveryKey: key, SubjectKind: "config_drift", SubjectID: a.ID, SourceID: a.SourceID, SourceName: a.SourceName, ResourceID: a.ResourceID, PayloadVersion: 1, Event: event, Severity: a.Severity, TriggerCount: a.TriggerCount, OccurredAt: occurred.Format(time.RFC3339Nano), ChannelID: channel, Status: DeliveryPending, NotBefore: notBefore, NextAttemptAt: next, CreatedAt: now.Format(time.RFC3339Nano)}
	_, e := r.deliveries.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$setOnInsert": doc}, options.UpdateOne().SetUpsert(true))
	return e
}

// SubjectStateReader preserves NF alert identity while routing the new kind.
type SubjectStateReader interface {
	SubjectState(context.Context, string, string) (string, error)
}
type subjectStateReader struct {
	nf     AlertStateReader
	config interface {
		Alert(context.Context, string) (*configdrift.Alert, error)
	}
}

func NewSubjectStateReader(nf AlertStateReader, config interface {
	Alert(context.Context, string) (*configdrift.Alert, error)
}) AlertStateReader {
	return &subjectStateReader{nf, config}
}
func (r *subjectStateReader) AlertState(ctx context.Context, id string) (string, error) {
	return r.nf.AlertState(ctx, id)
}
func (r *subjectStateReader) SubjectState(ctx context.Context, kind, id string) (string, error) {
	switch kind {
	case "", "nf_alert":
		if r.nf == nil {
			return "", errors.New("NF alert state reader unavailable")
		}
		return r.nf.AlertState(ctx, id)
	case "config_drift":
		a, e := r.config.Alert(ctx, id)
		if e != nil {
			return "", e
		}
		if a == nil {
			return "", errors.New("configuration alert unavailable")
		}
		return a.State, nil
	default:
		return "", errors.New("unknown notification subject")
	}
}
