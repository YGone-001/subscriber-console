package nfhealth

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func (r *Repository) metricAggregates() *mongo.Collection {
	return r.targets.Database().Collection("app_nf_metric_aggregates")
}

func (r *Repository) metricAggregate(ctx context.Context, id string) (*MetricAggregateBucket, error) {
	var out MetricAggregateBucket
	err := r.metricAggregates().FindOne(ctx, bson.M{"_id": id}).Decode(&out)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &out, err
}

// Replace the entire bounded bucket. Repeated worker visits cannot add counts.
func (r *Repository) saveMetricAggregate(ctx context.Context, bucket *MetricAggregateBucket, prior int64) error {
	return r.saveMetricAggregateRetained(ctx, bucket, prior, 0)
}

// retention stamps the bucket for the declared TTL index. A zero retention
// writes no expiry; it never extends raw sample retention.
func (r *Repository) saveMetricAggregateRetained(ctx context.Context, bucket *MetricAggregateBucket, prior int64, retention time.Duration) error {
	if retention > 0 {
		bucket.ExpiresAt = bucket.End.Add(retention).UTC()
	}
	bucket.Revision = prior + 1
	if prior == 0 {
		_, err := r.metricAggregates().InsertOne(ctx, bucket)
		return err
	}
	res, err := r.metricAggregates().ReplaceOne(ctx, bson.M{"_id": bucket.ID, "revision": prior}, bucket)
	if err == nil && res.MatchedCount != 1 {
		return ErrRevisionConflict
	}
	return err
}

// metricAggregateHours reads published hourly buckets inside a bounded window.
// It performs one bounded index read and never triggers collection or a write.
// Buckets written before the period field existed carry no period and are still
// read as hourly evidence.
func (r *Repository) metricAggregateHours(ctx context.Context, targetID string, from, to time.Time) ([]MetricAggregateBucket, error) {
	limit := int(to.Sub(from)/time.Hour) + 1
	if limit < 1 || limit > MetricBackfillWindowHours+1 {
		return nil, fmt.Errorf("invalid hourly aggregate window")
	}
	filter := bson.M{
		"targetId":         targetID,
		"metric":           MetricAggregateMetric,
		"series":           "unlabeled",
		"algorithmVersion": MetricAggregateVersion,
		"period":           bson.M{"$in": bson.A{MetricHourPeriod, nil}},
		"bucketStart":      bson.M{"$gte": from.UTC(), "$lt": to.UTC()},
	}
	cursor, err := r.metricAggregates().Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "bucketStart", Value: 1}}).SetLimit(int64(limit)))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := []MetricAggregateBucket{}
	if err := cursor.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

type MetricHistoryQuery struct {
	TargetID, Metric, Series, Resolution, Cursor string
	From, To                                     time.Time
	Limit                                        int
}
type MetricHistoryView struct {
	MetricType    string    `json:"metricType"`
	Metric        string    `json:"metric"`
	Series        string    `json:"series"`
	Resolution    string    `json:"resolution"`
	Period        string    `json:"period"`
	Unit          string    `json:"unit"`
	Subject       string    `json:"subject"`
	Version       string    `json:"algorithmVersion"`
	From          time.Time `json:"from"`
	To            time.Time `json:"to"`
	Watermark     string    `json:"watermark"`
	RetentionDays int       `json:"retentionDays"`
	Complete      bool      `json:"complete"`
	// MissingBuckets counts expected buckets with no published document.
	// IncompleteBuckets counts published buckets whose bounded source read was
	// not known-complete. Both are explicit: a gap is never a measured zero.
	MissingBuckets    int `json:"missingBuckets"`
	IncompleteBuckets int `json:"incompleteBuckets"`
	// ExpiredBuckets counts expected buckets with no document whose raw
	// evidence is already past its own retention. They cannot be reconstructed
	// and are reported instead of being published as zero.
	ExpiredBuckets int `json:"expiredBuckets"`
	// MissingHours is retained for older clients and is only meaningful for
	// hourly resolution.
	MissingHours int                     `json:"missingHours,omitempty"`
	Buckets      []MetricAggregateBucket `json:"buckets"`
	Page         PageInfo                `json:"page"`
}
type metricHistoryCursor struct {
	Scope, Watermark string
	Offset           int
}

var ErrMetricHistoryInvalid = errors.New("invalid metric history request")
var ErrMetricHistoryChanged = errors.New("metric history changed; restart pagination")

// metricHistoryScope resolves the read resolution into its storage period,
// algorithm version, bucket step and read limit. Only registered resolutions
// are readable; unknown values never fall back to a default.
func metricHistoryScope(resolution string) (period, version string, step time.Duration, maxDays int, ok bool) {
	switch resolution {
	case MetricHourPeriod:
		return MetricHourPeriod, MetricAggregateVersion, time.Hour, MaxMetricHourHistoryDays, true
	case MetricDayPeriod:
		return MetricDayPeriod, MetricDayAggregateVersion, 24 * time.Hour, MaxMetricDayHistoryDays, true
	}
	return "", "", 0, 0, false
}

func metricRetentionDays(period string) int {
	if period == MetricDayPeriod {
		return DefaultMetricDayRetentionDays
	}
	return DefaultMetricHourRetentionDays
}

func validateMetricHistory(q MetricHistoryQuery, now time.Time) error {
	_, _, step, maxDays, ok := metricHistoryScope(q.Resolution)
	if !ok || q.Metric != MetricAggregateMetric || q.Series != "unlabeled" || q.Limit < 1 || q.Limit > 200 || q.From.IsZero() ||
		!q.From.Equal(q.From.UTC().Truncate(step)) || !q.To.Equal(q.To.UTC().Truncate(step)) || !q.To.After(q.From) ||
		q.To.Sub(q.From) > time.Duration(maxDays)*24*time.Hour {
		return fmt.Errorf("%w: require approved metric, unlabeled series, aligned buckets, a window within %d days and limit 1-200", ErrMetricHistoryInvalid, maxDays)
	}
	cutoff := now.UTC().Add(-MetricAggregateGrace)
	if step == 24*time.Hour {
		// The current day is readable while still partial; its bucket reports
		// day_not_closed instead of pretending the day is complete.
		cutoff = cutoff.Truncate(24 * time.Hour).Add(24 * time.Hour)
	} else {
		cutoff = cutoff.Truncate(time.Hour)
	}
	if q.To.After(cutoff) {
		return fmt.Errorf("%w: window includes an unclosed bucket", ErrMetricHistoryInvalid)
	}
	return nil
}

func (r *Repository) MetricHistory(ctx context.Context, q MetricHistoryQuery, now time.Time) (*MetricHistoryView, error) {
	if err := validateMetricHistory(q, now); err != nil {
		return nil, err
	}
	// Normalise the window to UTC once: bucket keys decoded from BSON are UTC
	// and the slot loop compares them by value.
	q.From, q.To = q.From.UTC(), q.To.UTC()
	period, version, step, _, _ := metricHistoryScope(q.Resolution)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	expected := int(q.To.Sub(q.From) / step)
	filter := bson.M{"targetId": q.TargetID, "metric": q.Metric, "series": q.Series, "algorithmVersion": version, "bucketStart": bson.M{"$gte": q.From, "$lt": q.To}}
	if period == MetricHourPeriod {
		filter["period"] = bson.M{"$in": bson.A{MetricHourPeriod, nil}}
	} else {
		filter["period"] = period
	}
	// A small manifest detects revisions and newly published buckets on later
	// pages. It is bounded to the requested window and never reads raw samples
	// or causes a write.
	rows, err := r.metricAggregates().Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "bucketStart", Value: 1}}).SetLimit(int64(expected+1)).SetProjection(bson.M{"_id": 1, "revision": 1, "bucketStart": 1, "sourceComplete": 1}))
	if err != nil {
		return nil, err
	}
	defer rows.Close(ctx)
	var manifest []MetricAggregateBucket
	if err := rows.All(ctx, &manifest); err != nil {
		return nil, err
	}
	if len(manifest) > expected {
		return nil, ErrMetricHistoryChanged
	}
	scope := windowHash(q.TargetID, q.Metric, q.Series, q.Resolution, q.From.UTC().Format(time.RFC3339), q.To.UTC().Format(time.RFC3339), fmt.Sprint(q.Limit))
	raw, _ := json.Marshal(manifest)
	watermark := windowHash(scope, string(raw))
	offset := 0
	if q.Cursor != "" {
		if len(q.Cursor) > 2048 {
			return nil, fmt.Errorf("%w: invalid metric cursor", ErrMetricHistoryInvalid)
		}
		raw, err := hex.DecodeString(q.Cursor)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid metric cursor", ErrMetricHistoryInvalid)
		}
		var cursor metricHistoryCursor
		if err := json.Unmarshal(raw, &cursor); err != nil || cursor.Scope != scope || cursor.Offset < 0 {
			return nil, fmt.Errorf("%w: invalid metric cursor", ErrMetricHistoryInvalid)
		}
		if cursor.Watermark != watermark {
			return nil, ErrMetricHistoryChanged
		}
		if cursor.Offset >= len(manifest) {
			return nil, ErrMetricHistoryInvalid
		}
		offset = cursor.Offset
	}
	end := offset + q.Limit
	if end > len(manifest) {
		end = len(manifest)
	}
	out := &MetricHistoryView{MetricType: "gauge", Metric: q.Metric, Series: q.Series, Resolution: q.Resolution, Period: period, Unit: "bytes", Subject: "exporter_process", Version: version, From: q.From, To: q.To, Watermark: watermark, RetentionDays: metricRetentionDays(period), Buckets: []MetricAggregateBucket{}, Complete: true, MissingBuckets: expected - len(manifest), Page: PageInfo{Limit: q.Limit}}
	if period == MetricHourPeriod {
		out.MissingHours = out.MissingBuckets
	}
	present := make(map[time.Time]bool, len(manifest))
	for _, m := range manifest {
		present[m.Start.UTC()] = true
		if !m.SourceComplete {
			out.IncompleteBuckets++
		}
	}
	// Buckets older than the raw sample policy can never be reconstructed from
	// evidence, so an absent slot there is reported as expired rather than as a
	// transient backlog.
	rawCutoff := now.Add(-time.Duration(DefaultRetentionDays) * 24 * time.Hour)
	for slot := q.From; slot.Before(q.To); slot = slot.Add(step) {
		if !present[slot] && slot.Before(rawCutoff) {
			out.ExpiredBuckets++
		}
	}
	out.Complete = out.MissingBuckets == 0 && out.IncompleteBuckets == 0
	ids := []string{}
	for _, m := range manifest[offset:end] {
		ids = append(ids, m.ID)
	}
	if len(ids) > 0 {
		data, err := r.metricAggregates().Find(ctx, bson.M{"_id": bson.M{"$in": ids}}, options.Find().SetSort(bson.D{{Key: "bucketStart", Value: 1}}).SetLimit(int64(q.Limit+1)))
		if err != nil {
			return nil, err
		}
		defer data.Close(ctx)
		if err := data.All(ctx, &out.Buckets); err != nil {
			return nil, err
		}
		if len(out.Buckets) != len(ids) {
			return nil, ErrMetricHistoryChanged
		}
		for i, b := range out.Buckets {
			if b.ID != manifest[offset+i].ID || b.Revision != manifest[offset+i].Revision {
				return nil, ErrMetricHistoryChanged
			}
		}
	}
	if end < len(manifest) {
		out.Page.HasMore = true
		raw, _ := json.Marshal(metricHistoryCursor{Scope: scope, Watermark: watermark, Offset: end})
		next := hex.EncodeToString(raw)
		out.Page.NextCursor = &next
	}
	return out, nil
}
