package nfhealth

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"subscriber/internal/response"
)

type MetricHistoryReader interface {
	MetricHistory(context.Context, MetricHistoryQuery, time.Time) (*MetricHistoryView, error)
}

func (h *Handler) SetMetricHistory(reader MetricHistoryReader, worker *MetricAggregateWorker) {
	h.metricHistory = reader
	h.metricAggregateWorker = worker
}

func (h *Handler) GetMetricHistory(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:metric-history:"+p.Username, 60, 60) {
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
	if h.metricHistory == nil || h.metricAggregateWorker == nil || !h.metricAggregateWorker.Snapshot().Enabled {
		response.Error(w, 503, "Metric aggregation is disabled", "NF_METRIC_HISTORY_DISABLED")
		return
	}
	q := r.URL.Query()
	for name, values := range q {
		switch name {
		case "metric", "series", "resolution", "from", "to", "limit", "cursor":
		default:
			response.BadRequest(w, "unsupported query parameter", "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
		if len(values) != 1 {
			response.BadRequest(w, "duplicate query parameter", "NF_METRIC_HISTORY_INVALID")
			return
		}
	}
	from, e1 := time.Parse(time.RFC3339, q.Get("from"))
	to, e2 := time.Parse(time.RFC3339, q.Get("to"))
	limit := 200
	var e3 error
	if q.Get("limit") != "" {
		limit, e3 = strconv.Atoi(q.Get("limit"))
	}
	request := MetricHistoryQuery{TargetID: id, Metric: q.Get("metric"), Series: q.Get("series"), Resolution: q.Get("resolution"), From: from.UTC(), To: to.UTC(), Limit: limit, Cursor: q.Get("cursor")}
	if e1 != nil || e2 != nil || e3 != nil || validateMetricHistory(request, time.Now().UTC()) != nil {
		response.BadRequest(w, "invalid metric history window or series", "NF_METRIC_HISTORY_INVALID")
		return
	}
	view, err := h.metricHistory.MetricHistory(ctx, request, time.Now().UTC())
	if errors.Is(err, ErrMetricHistoryInvalid) {
		response.BadRequest(w, "invalid history cursor or scope", "NF_METRIC_HISTORY_INVALID")
		return
	}
	if errors.Is(err, ErrMetricHistoryChanged) {
		response.Error(w, 409, "Metric history changed; restart pagination", "NF_METRIC_HISTORY_CHANGED")
		return
	}
	if err != nil {
		response.Error(w, 503, "Metric history unavailable", "NF_METRIC_HISTORY_UNAVAILABLE")
		return
	}
	response.JSON(w, 200, view)
}
