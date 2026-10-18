package nfalert

import (
	"context"
	"log/slog"

	"subscriber/internal/nfhealth"
)

// SchedulerHook adapts the NF Health scheduler collection callback to the
// evaluation engine. It is a best-effort observer: evaluation failures are
// logged and never propagated, so a rule evaluation problem can never fail
// the already-recorded measurement.
type SchedulerHook struct {
	evaluator *Evaluator
	logger    *slog.Logger
}

// NewSchedulerHook constructs the scheduler-to-engine adapter.
func NewSchedulerHook(evaluator *Evaluator, logger *slog.Logger) *SchedulerHook {
	return &SchedulerHook{evaluator: evaluator, logger: logger}
}

// OnCollectionRecorded evaluates alert rules for one freshly recorded
// collection outcome.
func (h *SchedulerHook) OnCollectionRecorded(ctx context.Context, target *nfhealth.HealthTarget, result *nfhealth.CollectionResult) {
	if h == nil || h.evaluator == nil {
		return
	}
	outcome, err := h.evaluator.EvaluateTargets(ctx, []EvaluationInput{{
		Target: target,
		Result: result,
	}})
	if err != nil {
		if h.logger != nil {
			h.logger.Warn("nf alert evaluation failed", "targetId", targetIDOf(target), "error", err)
		}
		return
	}
	if h.logger != nil && outcome != nil && (outcome.Opened > 0 || outcome.Recovered > 0) {
		h.logger.Info("nf alert evaluation outcome",
			"targetId", targetIDOf(target),
			"opened", outcome.Opened,
			"recounted", outcome.Recounted,
			"recovered", outcome.Recovered,
		)
	}
}

func targetIDOf(target *nfhealth.HealthTarget) string {
	if target == nil {
		return ""
	}
	return target.TargetID
}
