package nfhealth

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"subscriber/internal/response"
)

type MetricAnalysisReader interface {
	MetricAnalyses(context.Context, MetricAnalysisQuery, time.Time) (*MetricAnalysisView, error)
}

func (h *Handler) SetMetricAnalysis(reader MetricAnalysisReader) {
	h.metricAnalysis = reader
}

// GetMetricAnalysis serves stored baseline comparisons for one target. It is a
// pure read: no evaluation, collection, repair or write happens here.
func (h *Handler) GetMetricAnalysis(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:metric-analysis:"+p.Username, 60, 60) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	id := r.PathValue("targetId")
	if err := ValidateUUIDv4(id); err != nil {
		writeValidation(w, err)
		return
	}
	if _, err := h.repo.GetTarget(ctx, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, 404, "NF Health target not found", "NF_HEALTH_TARGET_NOT_FOUND")
		} else {
			response.InternalError(w)
		}
		return
	}
	if h.metricAnalysis == nil {
		response.Error(w, 503, "Metric analysis is unavailable", "NF_METRIC_ANALYSIS_UNAVAILABLE")
		return
	}
	values := r.URL.Query()
	for name, list := range values {
		switch name {
		case "metric", "from", "to", "limit", "cursor":
		default:
			response.BadRequest(w, "unsupported query parameter", "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
		if len(list) != 1 {
			response.BadRequest(w, "duplicate query parameter", "NF_METRIC_ANALYSIS_INVALID")
			return
		}
	}
	now := time.Now().UTC()
	to := now.Add(-MetricAggregateGrace).Truncate(time.Hour)
	from := to.Add(-7 * 24 * time.Hour)
	var e1, e2 error
	if raw := values.Get("to"); raw != "" {
		to, e1 = time.Parse(time.RFC3339, raw)
	}
	if raw := values.Get("from"); raw != "" {
		from, e2 = time.Parse(time.RFC3339, raw)
	}
	limit := 200
	var e3 error
	if raw := values.Get("limit"); raw != "" {
		limit, e3 = strconv.Atoi(raw)
	}
	metric := values.Get("metric")
	if metric == "" {
		metric = MetricAggregateMetric
	}
	request := MetricAnalysisQuery{TargetID: id, Metric: metric, From: from.UTC(), To: to.UTC(), Limit: limit, Cursor: values.Get("cursor")}
	if e1 != nil || e2 != nil || e3 != nil || validateMetricAnalysis(request, now) != nil {
		response.BadRequest(w, "invalid analysis window or metric", "NF_METRIC_ANALYSIS_INVALID")
		return
	}
	view, err := h.metricAnalysis.MetricAnalyses(ctx, request, now)
	if errors.Is(err, ErrMetricAnalysisInvalid) {
		response.BadRequest(w, "invalid analysis cursor or scope", "NF_METRIC_ANALYSIS_INVALID")
		return
	}
	if errors.Is(err, ErrMetricAnalysisChanged) {
		response.Error(w, 409, "Metric analysis changed; restart pagination", "NF_METRIC_ANALYSIS_CHANGED")
		return
	}
	if err != nil {
		response.Error(w, 503, "Metric analysis unavailable", "NF_METRIC_ANALYSIS_UNAVAILABLE")
		return
	}
	response.JSON(w, 200, view)
}
