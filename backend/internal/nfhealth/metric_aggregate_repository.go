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

// Replace the entire bounded hour. Repeated worker visits cannot add counts.
func (r *Repository) saveMetricAggregate(ctx context.Context, bucket *MetricAggregateBucket, prior int64) error {
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

type MetricHistoryQuery struct {
	TargetID, Metric, Series, Resolution, Cursor string
	From, To                                     time.Time
	Limit                                        int
}
type MetricHistoryView struct {
	MetricType   string                  `json:"metricType"`
	Metric       string                  `json:"metric"`
	Series       string                  `json:"series"`
	Resolution   string                  `json:"resolution"`
	Unit         string                  `json:"unit"`
	Subject      string                  `json:"subject"`
	Version      string                  `json:"algorithmVersion"`
	From         time.Time               `json:"from"`
	To           time.Time               `json:"to"`
	Watermark    string                  `json:"watermark"`
	Complete     bool                    `json:"complete"`
	MissingHours int                     `json:"missingHours"`
	Buckets      []MetricAggregateBucket `json:"buckets"`
	Page         PageInfo                `json:"page"`
}
type metricHistoryCursor struct {
	Scope, Watermark string
	Offset           int
}

var ErrMetricHistoryInvalid = errors.New("invalid metric history request")
var ErrMetricHistoryChanged = errors.New("metric history changed; restart pagination")

func validateMetricHistory(q MetricHistoryQuery, now time.Time) error {
	if q.Metric != MetricAggregateMetric || q.Series != "unlabeled" || q.Resolution != "1h" || q.Limit < 1 || q.Limit > 200 || q.From.IsZero() || !q.From.Equal(q.From.Truncate(time.Hour)) || !q.To.Equal(q.To.Truncate(time.Hour)) || !q.To.After(q.From) || q.To.Sub(q.From) > 30*24*time.Hour || q.To.After(now.Add(-5*time.Minute).UTC().Truncate(time.Hour)) {
		return fmt.Errorf("%w: require approved metric, unlabeled series, closed UTC hours, <=30 days and limit 1-200", ErrMetricHistoryInvalid)
	}
	return nil
}

func (r *Repository) MetricHistory(ctx context.Context, q MetricHistoryQuery, now time.Time) (*MetricHistoryView, error) {
	if err := validateMetricHistory(q, now); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	filter := bson.M{"targetId": q.TargetID, "metric": q.Metric, "series": q.Series, "algorithmVersion": MetricAggregateVersion, "bucketStart": bson.M{"$gte": q.From, "$lt": q.To}}
	// A small manifest detects revisions and newly published hours on later pages.
	// It is bounded to 720 hours and never reads raw samples or causes a write.
	rows, err := r.metricAggregates().Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "bucketStart", Value: 1}}).SetLimit(721).SetProjection(bson.M{"_id": 1, "revision": 1, "bucketStart": 1, "sourceComplete": 1}))
	if err != nil {
		return nil, err
	}
	defer rows.Close(ctx)
	var manifest []MetricAggregateBucket
	if err := rows.All(ctx, &manifest); err != nil {
		return nil, err
	}
	if len(manifest) > 720 {
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
	out := &MetricHistoryView{MetricType: "gauge", Metric: q.Metric, Series: q.Series, Resolution: q.Resolution, Unit: "bytes", Subject: "exporter_process", Version: MetricAggregateVersion, From: q.From, To: q.To, Watermark: watermark, Buckets: []MetricAggregateBucket{}, Complete: true, MissingHours: int(q.To.Sub(q.From)/time.Hour) - len(manifest), Page: PageInfo{Limit: q.Limit}}
	if out.MissingHours > 0 {
		out.Complete = false
	}
	for _, m := range manifest {
		if !m.SourceComplete {
			out.Complete = false
		}
	}
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
