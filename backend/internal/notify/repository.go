package notify

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/nfalert"
)

// Repository persists channels, escalation rules and the delivery ledger.
//
// Collections (xcloud_ops):
//   - app_nf_notification_channels
//   - app_nf_notification_escalations
//   - app_nf_notification_deliveries
type Repository struct {
	channels    *mongo.Collection
	escalations *mongo.Collection
	deliveries  *mongo.Collection
	logger      *slog.Logger
	now         func() time.Time
}

// NewRepository constructs the notification persistence adapter and creates
// the idempotency index best-effort.
func NewRepository(channels, escalations, deliveries *mongo.Collection, logger *slog.Logger) *Repository {
	repo := &Repository{
		channels:    channels,
		escalations: escalations,
		deliveries:  deliveries,
		logger:      logger,
		now:         func() time.Time { return time.Now().UTC() },
	}
	repo.ensureIndexes(context.Background())
	return repo
}

func (r *Repository) ensureIndexes(ctx context.Context) {
	if _, err := r.deliveries.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "deliveryKey", Value: 1}},
		Options: options.Index().SetUnique(true),
	}); err != nil && r.logger != nil {
		r.logger.Warn("notification delivery index creation failed", "error", err)
	}
}

// SetClock installs an injectable time source for tests.
func (r *Repository) SetClock(now func() time.Time) {
	if now != nil {
		r.now = now
	}
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

/* ----------------------------------------------------------------- channels -- */

func (r *Repository) ListChannels(ctx context.Context) ([]NotificationChannel, error) {
	cursor, err := r.channels.Find(ctx, bson.M{}, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var docs []NotificationChannel
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	if docs == nil {
		docs = []NotificationChannel{}
	}
	return docs, nil
}

func (r *Repository) GetChannel(ctx context.Context, id string) (*NotificationChannel, error) {
	var doc NotificationChannel
	err := r.channels.FindOne(ctx, bson.M{"_id": id}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, errNotFound
		}
		return nil, err
	}
	return &doc, nil
}

func (r *Repository) CreateChannel(ctx context.Context, req *CreateChannelRequest, actor string) (*NotificationChannel, error) {
	now := r.now().UTC().Format(time.RFC3339Nano)
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	doc := NotificationChannel{
		ID:        newUUID(),
		Name:      strings.TrimSpace(req.Name),
		Kind:      req.Kind,
		Enabled:   enabled,
		URL:       strings.TrimSpace(req.URL),
		Secret:    req.Secret,
		Revision:  1,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if _, err := r.channels.InsertOne(ctx, doc); err != nil {
		return nil, err
	}
	_ = actor
	return &doc, nil
}

func (r *Repository) UpdateChannel(ctx context.Context, id string, req *UpdateChannelRequest, actor string) (*NotificationChannel, *NotificationChannel, error) {
	existing, err := r.GetChannel(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, errRevisionConflict
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	set := bson.M{
		"name":      strings.TrimSpace(req.Channel.Name),
		"url":       strings.TrimSpace(req.Channel.URL),
		"enabled":   req.Channel.Enabled,
		"updatedAt": now,
		"revision":  req.ExpectedRevision + 1,
	}
	if strings.TrimSpace(req.Channel.Secret) != "" {
		set["secret"] = req.Channel.Secret
	}
	res := r.channels.FindOneAndUpdate(ctx,
		bson.M{"_id": id, "revision": req.ExpectedRevision},
		bson.M{"$set": set},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var updated NotificationChannel
	if err := res.Decode(&updated); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil, errRevisionConflict
		}
		return nil, nil, err
	}
	_ = actor
	return &updated, existing, nil
}

func (r *Repository) DeleteChannel(ctx context.Context, id string) error {
	res, err := r.channels.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return errNotFound
	}
	return nil
}

/* -------------------------------------------------------------- escalations -- */

func (r *Repository) ListEscalations(ctx context.Context) ([]Escalation, error) {
	cursor, err := r.escalations.Find(ctx, bson.M{}, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var docs []Escalation
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	if docs == nil {
		docs = []Escalation{}
	}
	return docs, nil
}

func (r *Repository) GetEscalation(ctx context.Context, id string) (*Escalation, error) {
	var doc Escalation
	err := r.escalations.FindOne(ctx, bson.M{"_id": id}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, errNotFound
		}
		return nil, err
	}
	return &doc, nil
}

func (r *Repository) CreateEscalation(ctx context.Context, req *CreateEscalationRequest, actor string) (*Escalation, error) {
	now := r.now().UTC().Format(time.RFC3339Nano)
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	doc := Escalation{
		ID:                   newUUID(),
		Name:                 strings.TrimSpace(req.Name),
		Enabled:              enabled,
		Severities:           append([]string(nil), req.Severities...),
		RuleIDs:              append([]string(nil), req.RuleIDs...),
		ChannelIDs:           append([]string(nil), req.ChannelIDs...),
		EscalateAfterSeconds: req.EscalateAfterSeconds,
		EscalateChannelIDs:   append([]string(nil), req.EscalateChannelIDs...),
		Revision:             1,
		CreatedAt:            now,
		UpdatedAt:            now,
	}
	if _, err := r.escalations.InsertOne(ctx, doc); err != nil {
		return nil, err
	}
	_ = actor
	return &doc, nil
}

func (r *Repository) UpdateEscalation(ctx context.Context, id string, req *UpdateEscalationRequest, actor string) (*Escalation, *Escalation, error) {
	existing, err := r.GetEscalation(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, errRevisionConflict
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	mut := req.Escalation
	set := bson.M{
		"name":                 strings.TrimSpace(mut.Name),
		"enabled":              mut.Enabled,
		"severities":           append([]string(nil), mut.Severities...),
		"ruleIds":              append([]string(nil), mut.RuleIDs...),
		"channelIds":           append([]string(nil), mut.ChannelIDs...),
		"escalateAfterSeconds": mut.EscalateAfterSeconds,
		"escalateChannelIds":   append([]string(nil), mut.EscalateChannelIDs...),
		"updatedAt":            now,
		"revision":             req.ExpectedRevision + 1,
	}
	res := r.escalations.FindOneAndUpdate(ctx,
		bson.M{"_id": id, "revision": req.ExpectedRevision},
		bson.M{"$set": set},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var updated Escalation
	if err := res.Decode(&updated); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil, errRevisionConflict
		}
		return nil, nil, err
	}
	_ = actor
	return &updated, existing, nil
}

func (r *Repository) DeleteEscalation(ctx context.Context, id string) error {
	res, err := r.escalations.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return err
	}
	if res.DeletedCount == 0 {
		return errNotFound
	}
	return nil
}

/* --------------------------------------------------------------- deliveries -- */

// ListDeliveries returns a keyset-paginated slice of the delivery ledger,
// most recent first.
func (r *Repository) ListDeliveries(ctx context.Context, filter DeliveryListFilter) ([]Delivery, *string, bool, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	query := bson.M{}
	if filter.AlertID != "" {
		query["alertId"] = filter.AlertID
	}
	if filter.Status != "" {
		query["status"] = filter.Status
	}
	opts := options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}}).
		SetLimit(int64(limit) + 1)
	cursorData, err := decodeDeliveryCursor(filter.Cursor)
	if err != nil {
		return nil, nil, false, err
	}
	if cursorData.At != "" {
		query["$or"] = bson.A{
			bson.M{"createdAt": bson.M{"$lt": cursorData.At}},
			bson.M{"createdAt": cursorData.At, "_id": bson.M{"$lt": cursorData.ID}},
		}
	}
	cursor, err := r.deliveries.Find(ctx, query, opts)
	if err != nil {
		return nil, nil, false, err
	}
	defer cursor.Close(ctx)
	var docs []Delivery
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, nil, false, err
	}
	hasMore := len(docs) > limit
	if hasMore {
		docs = docs[:limit]
	}
	var next *string
	if hasMore && len(docs) > 0 {
		last := docs[len(docs)-1]
		next = encodeDeliveryCursor(last.CreatedAt, last.ID)
	}
	return docs, next, hasMore, nil
}

/* ------------------------------------------------------------------- enqueue -- */

// NotifyAlert implements nfalert.AlertEventSink. It resolves the matching
// escalation rules and enqueues one idempotent delivery per channel. It is a
// best-effort observer: no failure here can block the alert write that called
// it, and it never performs network egress.
func (r *Repository) NotifyAlert(ctx context.Context, event nfalert.AlertEvent) {
	if r == nil || r.deliveries == nil {
		return
	}
	rules, err := r.ListEscalations(ctx)
	if err != nil {
		if r.logger != nil {
			r.logger.Warn("notification escalation resolution failed", "error", err)
		}
		return
	}
	now := r.now().UTC()
	for _, rule := range rules {
		if !escalationMatches(rule, event) {
			continue
		}
		for _, channelID := range rule.ChannelIDs {
			r.enqueue(ctx, event, channelID, now, time.Time{})
		}
		if event.Event == nfalert.AlertEventOpened && rule.EscalateAfterSeconds > 0 {
			notBefore := now.Add(time.Duration(rule.EscalateAfterSeconds) * time.Second)
			escalation := event
			escalation.Event = DeliveryEventEscalate
			for _, channelID := range rule.EscalateChannelIDs {
				r.enqueue(ctx, escalation, channelID, now, notBefore)
			}
		}
	}
}

func escalationMatches(rule Escalation, event nfalert.AlertEvent) bool {
	if !rule.Enabled {
		return false
	}
	severityHit := false
	for _, severity := range rule.Severities {
		if severity == event.Severity {
			severityHit = true
			break
		}
	}
	if !severityHit {
		return false
	}
	if len(rule.RuleIDs) == 0 {
		return true
	}
	for _, ruleID := range rule.RuleIDs {
		if ruleID == event.RuleID {
			return true
		}
	}
	return false
}

func (r *Repository) enqueue(ctx context.Context, event nfalert.AlertEvent, channelID string, now, notBefore time.Time) {
	key := event.AlertID + ":" + event.Event + ":" + channelID
	// Idempotency by key: a transition already enqueued (or delivered) is never
	// duplicated, so a replayed evaluation cannot double-send.
	var existing Delivery
	err := r.deliveries.FindOne(ctx, bson.M{"deliveryKey": key}).Decode(&existing)
	if err == nil {
		return
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		if r.logger != nil {
			r.logger.Warn("notification idempotency lookup failed", "error", err)
		}
		return
	}
	nextAttempt := now
	if !notBefore.IsZero() {
		nextAttempt = notBefore
	}
	doc := Delivery{
		ID:            newUUID(),
		DeliveryKey:   key,
		Event:         event.Event,
		AlertID:       event.AlertID,
		RuleID:        event.RuleID,
		RuleName:      event.RuleName,
		TargetID:      event.TargetID,
		TargetName:    event.TargetName,
		Severity:      event.Severity,
		TriggerCount:  event.TriggerCount,
		OccurredAt:    event.OccurredAt,
		ChannelID:     channelID,
		Status:        DeliveryPending,
		NotBefore:     notBefore,
		NextAttemptAt: nextAttempt,
		CreatedAt:     now.Format(time.RFC3339Nano),
	}
	if _, err := r.deliveries.InsertOne(ctx, doc); err != nil && !mongo.IsDuplicateKeyError(err) {
		if r.logger != nil {
			r.logger.Warn("notification delivery enqueue failed", "error", err, "deliveryKey", key)
		}
	}
}

/* --------------------------------------------------------------------- claim -- */

// ClaimDue atomically claims one due delivery for sending, or returns nil if
// another worker already took it.
func (r *Repository) ClaimDue(ctx context.Context, now time.Time) (*Delivery, error) {
	res := r.deliveries.FindOneAndUpdate(ctx,
		bson.M{
			"status":        bson.M{"$in": bson.A{DeliveryPending, DeliveryFailed}},
			"nextAttemptAt": bson.M{"$lte": now},
			"notBefore":     bson.M{"$lte": now},
		},
		bson.M{"$set": bson.M{"status": DeliverySending}},
		options.FindOneAndUpdate().SetSort(bson.D{{Key: "nextAttemptAt", Value: 1}}).SetReturnDocument(options.After),
	)
	var doc Delivery
	if err := res.Decode(&doc); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &doc, nil
}

// MarkSent finalizes a successful delivery.
func (r *Repository) MarkSent(ctx context.Context, id string, completedAt time.Time) error {
	_, err := r.deliveries.UpdateOne(ctx,
		bson.M{"_id": id},
		bson.M{"$set": bson.M{"status": DeliverySent, "completedAt": completedAt.Format(time.RFC3339Nano), "lastError": ""}},
	)
	return err
}

// MarkSkipped finalizes a delivery that no longer applies (for example an
// escalation that found the alert already resolved).
func (r *Repository) MarkSkipped(ctx context.Context, id string, completedAt time.Time) error {
	_, err := r.deliveries.UpdateOne(ctx,
		bson.M{"_id": id},
		bson.M{"$set": bson.M{"status": DeliverySkipped, "completedAt": completedAt.Format(time.RFC3339Nano), "lastError": ""}},
	)
	return err
}

// MarkFailed records a failed attempt and schedules the next retry, or marks
// the delivery dead once the attempt ceiling is reached.
func (r *Repository) MarkFailed(ctx context.Context, id string, attempts int, cause string, now time.Time) error {
	attempts++
	set := bson.M{"attempts": attempts, "lastError": cause}
	if attempts >= MaxDeliveryAttempts {
		set["status"] = DeliveryDead
		set["completedAt"] = now.Format(time.RFC3339Nano)
	} else {
		set["status"] = DeliveryFailed
		set["nextAttemptAt"] = backoffDelay(attempts, now)
	}
	_, err := r.deliveries.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": set})
	return err
}

func backoffDelay(attempts int, now time.Time) time.Time {
	if attempts <= 0 {
		attempts = 1
	}
	shift := attempts - 1
	if shift > 6 {
		shift = 6
	}
	delay := DeliveryBaseBackoff * time.Duration(1<<shift)
	if delay > DeliveryMaxBackoff {
		delay = DeliveryMaxBackoff
	}
	return now.Add(delay)
}

/* ------------------------------------------------------------------- cursor -- */

type deliveryCursor struct {
	At string `json:"at"`
	ID string `json:"id"`
}

func encodeDeliveryCursor(at, id string) *string {
	raw, _ := json.Marshal(deliveryCursor{At: at, ID: id})
	s := base64.RawURLEncoding.EncodeToString(raw)
	return &s
}

func decodeDeliveryCursor(cursor string) (deliveryCursor, error) {
	if cursor == "" {
		return deliveryCursor{}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return deliveryCursor{}, invalid("NOTIFY_INVALID_CURSOR", "cursor is malformed")
	}
	var data deliveryCursor
	if err := json.Unmarshal(raw, &data); err != nil {
		return deliveryCursor{}, invalid("NOTIFY_INVALID_CURSOR", "cursor is malformed")
	}
	return data, nil
}
