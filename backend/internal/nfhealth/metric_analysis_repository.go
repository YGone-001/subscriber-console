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

func (r *Repository) metricAnalyses() *mongo.Collection {
	return r.targets.Database().Collection("app_nf_metric_analysis")
}

func (r *Repository) metricAnalysis(ctx context.Context, id string) (*MetricAnalysis, error) {
	var out MetricAnalysis
	err := r.metricAnalyses().FindOne(ctx, bson.M{"_id": id}).Decode(&out)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &out, err
}

// saveMetricAnalysis replaces the whole bounded record under revision CAS.
// Repeated evaluation of the same inputs cannot append or duplicate a record.
func (r *Repository) saveMetricAnalysis(ctx context.Context, analysis *MetricAnalysis, prior *MetricAnalysis) error {
	// Read the expected revision before mutating the record: a caller may pass
	// the same pointer as both the new and the previous record.
	expected := int64(0)
	if prior != nil {
		expected = prior.Revision
	}
	analysis.Revision = expected + 1
	if prior == nil {
		_, err := r.metricAnalyses().InsertOne(ctx, analysis)
		return err
	}
	res, err := r.metricAnalyses().ReplaceOne(ctx, bson.M{"_id": analysis.ID, "revision": expected}, analysis)
	if err == nil && res.MatchedCount != 1 {
		return ErrRevisionConflict
	}
	return err
}

type MetricAnalysisQuery struct {
	TargetID, Metric, Kind, Cursor string
	From, To                       time.Time
	Limit                          int
}

// metricAnalysisKindScope resolves a record kind into its algorithm and policy.
// Baseline and trend evidence share one collection but never share an identity.
func metricAnalysisKindScope(kind string) (version, policy string, ok bool) {
	switch kind {
	case "", "baseline":
		return MetricAnalysisVersion, MetricAnalysisPolicyVersion, true
	case "trend":
		return MetricTrendVersion, MetricTrendPolicyVersion, true
	}
	return "", "", false
}

type MetricAnalysisView struct {
	TargetID          string           `json:"targetId"`
	Metric            string           `json:"metric"`
	Kind              string           `json:"kind"`
	AlgorithmVersion  string           `json:"algorithmVersion"`
	PolicyVersion     string           `json:"policyVersion"`
	From              time.Time        `json:"from"`
	To                time.Time        `json:"to"`
	BaselineHours     int              `json:"baselineHours,omitempty"`
	ScoreThreshold    float64          `json:"scoreThreshold,omitempty"`
	MinAbsoluteChange float64          `json:"minAbsoluteChange,omitempty"`
	WindowHours       int              `json:"windowHours,omitempty"`
	MinTrendChange    float64          `json:"minTrendChange,omitempty"`
	MinFit            float64          `json:"minFit,omitempty"`
	Items             []MetricAnalysis `json:"items"`
	Page              PageInfo         `json:"page"`
}

var ErrMetricAnalysisInvalid = errors.New("invalid metric analysis request")
var ErrMetricAnalysisChanged = errors.New("metric analysis changed; restart pagination")

func validateMetricAnalysis(q MetricAnalysisQuery, now time.Time) error {
	if _, _, ok := metricAnalysisKindScope(q.Kind); !ok {
		return fmt.Errorf("%w: unknown analysis kind", ErrMetricAnalysisInvalid)
	}
	if !MetricAnalysisMetricApproved(q.Metric) || q.Limit < 1 || q.Limit > 200 || q.From.IsZero() ||
		!q.From.Equal(q.From.UTC().Truncate(time.Hour)) || !q.To.Equal(q.To.UTC().Truncate(time.Hour)) || !q.To.After(q.From) ||
		q.To.Sub(q.From) > time.Duration(MetricAnalysisRetentionDays)*24*time.Hour || q.To.After(now.UTC().Add(-MetricAggregateGrace).Truncate(time.Hour)) {
		return fmt.Errorf("%w: require an analyzable metric, aligned closed hours, a window within %d days and limit 1-200", ErrMetricAnalysisInvalid, MetricAnalysisRetentionDays)
	}
	return nil
}

// MetricAnalyses lists stored analysis records newest first. It is a bounded
// read: it never recomputes, collects or repairs anything.
func (r *Repository) MetricAnalyses(ctx context.Context, q MetricAnalysisQuery, now time.Time) (*MetricAnalysisView, error) {
	if err := validateMetricAnalysis(q, now); err != nil {
		return nil, err
	}
	q.From, q.To = q.From.UTC(), q.To.UTC()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	expected := int(q.To.Sub(q.From) / time.Hour)
	kind := q.Kind
	if kind == "" {
		kind = "baseline"
	}
	version, policy, _ := metricAnalysisKindScope(kind)
	filter := bson.M{"targetId": q.TargetID, "metric": q.Metric, "series": "unlabeled", "algorithmVersion": version, "bucketStart": bson.M{"$gte": q.From, "$lt": q.To}}
	if kind == "baseline" {
		// Records written before the trend kind existed carry no kind at all.
		filter["kind"] = bson.M{"$in": bson.A{"baseline", nil}}
	} else {
		filter["kind"] = kind
	}
	rows, err := r.metricAnalyses().Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "bucketStart", Value: -1}, {Key: "_id", Value: 1}}).SetLimit(int64(expected+1)).SetProjection(bson.M{"_id": 1, "revision": 1, "bucketStart": 1}))
	if err != nil {
		return nil, err
	}
	defer rows.Close(ctx)
	var manifest []MetricAnalysis
	if err := rows.All(ctx, &manifest); err != nil {
		return nil, err
	}
	if len(manifest) > expected {
		return nil, ErrMetricAnalysisChanged
	}
	scope := windowHash(q.TargetID, q.Metric, q.From.Format(time.RFC3339), q.To.Format(time.RFC3339), fmt.Sprint(q.Limit))
	raw, _ := json.Marshal(manifest)
	watermark := windowHash(scope, string(raw))
	offset := 0
	if q.Cursor != "" {
		if len(q.Cursor) > 2048 {
			return nil, fmt.Errorf("%w: invalid analysis cursor", ErrMetricAnalysisInvalid)
		}
		decoded, err := hex.DecodeString(q.Cursor)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid analysis cursor", ErrMetricAnalysisInvalid)
		}
		var cursor metricHistoryCursor
		if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.Scope != scope || cursor.Offset < 0 {
			return nil, fmt.Errorf("%w: invalid analysis cursor", ErrMetricAnalysisInvalid)
		}
		if cursor.Watermark != watermark {
			return nil, ErrMetricAnalysisChanged
		}
		if cursor.Offset >= len(manifest) {
			return nil, ErrMetricAnalysisInvalid
		}
		offset = cursor.Offset
	}
	end := offset + q.Limit
	if end > len(manifest) {
		end = len(manifest)
	}
	out := &MetricAnalysisView{
		TargetID: q.TargetID, Metric: q.Metric, Kind: kind, AlgorithmVersion: version, PolicyVersion: policy,
		From: q.From, To: q.To, Items: []MetricAnalysis{}, Page: PageInfo{Limit: q.Limit},
	}
	if kind == "trend" {
		out.WindowHours, out.MinTrendChange, out.MinFit = MetricTrendWindowHours, MetricTrendMinChange, MetricTrendMinFit
	} else {
		out.BaselineHours, out.ScoreThreshold, out.MinAbsoluteChange = MetricAnalysisBaselineHours, MetricAnalysisScoreThreshold, MetricAnalysisMinAbsoluteChange
	}
	ids := []string{}
	for _, item := range manifest[offset:end] {
		ids = append(ids, item.ID)
	}
	if len(ids) > 0 {
		data, err := r.metricAnalyses().Find(ctx, bson.M{"_id": bson.M{"$in": ids}}, options.Find().SetSort(bson.D{{Key: "bucketStart", Value: -1}, {Key: "_id", Value: 1}}).SetLimit(int64(q.Limit+1)))
		if err != nil {
			return nil, err
		}
		defer data.Close(ctx)
		if err := data.All(ctx, &out.Items); err != nil {
			return nil, err
		}
		if len(out.Items) != len(ids) {
			return nil, ErrMetricAnalysisChanged
		}
		for i, item := range out.Items {
			if item.ID != manifest[offset+i].ID || item.Revision != manifest[offset+i].Revision {
				return nil, ErrMetricAnalysisChanged
			}
		}
	}
	// Hourly buckets are retained for 30 days, so an older analysis can no
	// longer be re-verified against its own evidence.
	expiredBefore := now.UTC().AddDate(0, 0, -DefaultMetricHourRetentionDays)
	for i := range out.Items {
		out.Items[i].EvidenceExpired = out.Items[i].BucketStart.Before(expiredBefore)
	}
	if end < len(manifest) {
		out.Page.HasMore = true
		raw, _ := json.Marshal(metricHistoryCursor{Scope: scope, Watermark: watermark, Offset: end})
		next := hex.EncodeToString(raw)
		out.Page.NextCursor = &next
	}
	return out, nil
}
