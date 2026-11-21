package nfalert

import (
	"go.mongodb.org/mongo-driver/v2/bson"
	"testing"
	"time"
)

func durationRule(trigger, recover int) *AlertRule {
	c := rssCondition("gt", 100, 50)
	c.DurationSeconds = trigger
	c.RecoveryDurationSeconds = recover
	return &AlertRule{RuleID: "rule", Revision: 1, MetricCondition: c}
}
func TestMetricTimingObservationClock(t *testing.T) {
	rule := durationRule(120, 120)
	at := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	state, first := advanceMetricTiming(metricTiming{}, rule, "epoch", 90, at, "one", "trigger", "")
	if first.Action != "" || first.Status.Phase != "pending" || first.Status.Observations != 1 {
		t.Fatalf("first %+v", first)
	}
	state, duplicate := advanceMetricTiming(state, rule, "epoch", 90, at, "one", "trigger", "")
	if duplicate.Action != "" || state.Observations != 1 {
		t.Fatal("duplicate advanced time")
	}
	state, second := advanceMetricTiming(state, rule, "epoch", 90, at.Add(time.Minute), "two", "trigger", "")
	if second.Action != "" || second.ElapsedSeconds != 60 {
		t.Fatalf("second %+v", second)
	}
	_, ready := advanceMetricTiming(state, rule, "epoch", 90, at.Add(2*time.Minute), "three", "trigger", "")
	if ready.Action != "open" || ready.Observations != 3 || ready.ElapsedSeconds != 120 || ready.FirstSampleID != "one" {
		t.Fatalf("ready %+v", ready)
	}
}
func TestMetricTimingBreaksAndExactBoundaries(t *testing.T) {
	at := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name               string
		gap                time.Duration
		identity, decision string
		revision           int64
		want               int
	}{
		{"exact_gap", 90 * time.Second, "epoch", "trigger", 1, 90},
		{"gap_exceeded", 90*time.Second + time.Nanosecond, "epoch", "trigger", 1, 0},
		{"incarnation", time.Minute, "restarted", "trigger", 1, 0},
		{"policy_version", time.Minute, "epoch", "trigger", 2, 0},
		{"hysteresis", time.Minute, "epoch", "hold", 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rule := durationRule(120, 120)
			state, _ := advanceMetricTiming(metricTiming{}, rule, "epoch", 90, at, "first", "trigger", "")
			rule.Revision = tc.revision
			next, out := advanceMetricTiming(state, rule, tc.identity, 90, at.Add(tc.gap), "second", tc.decision, "")
			if out.Action != "" || out.ElapsedSeconds != tc.want {
				t.Fatalf("%+v", out)
			}
			if tc.decision == "hold" && (!next.Since.IsZero() || next.Observations != 0) {
				t.Fatal("hysteresis retained pending time")
			}
		})
	}
	rule := durationRule(120, 120)
	state, _ := advanceMetricTiming(metricTiming{}, rule, "epoch", 90, at, "one", "trigger", "")
	state, _ = advanceMetricTiming(state, rule, "epoch", 90, at.Add(time.Minute), "two", "trigger", "")
	_, out := advanceMetricTiming(state, rule, "epoch", 90, at.Add(120*time.Second-time.Nanosecond), "three", "trigger", "")
	if out.Action != "" {
		t.Fatal("rounded duration fired early")
	}
}
func TestMetricTimingRecoveryAndAlertIdentity(t *testing.T) {
	rule := durationRule(0, 60)
	at := time.Now().UTC()
	state, first := advanceMetricTiming(metricTiming{}, rule, "epoch", 90, at, "one", "recover", "alert-one")
	if first.Status.Phase != "recovering" || first.Action != "" {
		t.Fatalf("first %+v", first)
	}
	state, changed := advanceMetricTiming(state, rule, "epoch", 90, at.Add(time.Minute), "two", "recover", "alert-two")
	if changed.Action != "" || changed.ElapsedSeconds != 0 {
		t.Fatal("recovery timer moved to another incident")
	}
	_, out := advanceMetricTiming(state, rule, "epoch", 90, at.Add(2*time.Minute), "three", "recover", "alert-two")
	if out.Action != "recover" {
		t.Fatalf("recovery %+v", out)
	}
	_, immediate := advanceMetricTiming(metricTiming{}, rule, "", 90, at, "zero", "trigger", "")
	if immediate.Action != "open" {
		t.Fatal("zero duration lost compatibility")
	}
}
func TestMetricDurationBounds(t *testing.T) {
	for _, n := range []int{-1, 3601} {
		c := rssCondition("gt", 100, 50)
		c.DurationSeconds = n
		if ValidateMetricCondition(ConditionTypeMetricThreshold, "target", "", c) == nil {
			t.Fatal("invalid trigger duration accepted")
		}
		c.DurationSeconds = 0
		c.RecoveryDurationSeconds = n
		if ValidateMetricCondition(ConditionTypeMetricThreshold, "target", "", c) == nil {
			t.Fatal("invalid recovery duration accepted")
		}
	}
	c := rssCondition("gt", 100, 50)
	c.DurationSeconds = 3600
	c.RecoveryDurationSeconds = 3600
	if err := ValidateMetricCondition(ConditionTypeMetricThreshold, "target", "", c); err != nil {
		t.Fatal(err)
	}
}

func TestMetricTimingExactMongoClockEncoding(t *testing.T) {
	at := time.Date(2026, 11, 21, 0, 0, 0, 987654321, time.UTC)
	rule := durationRule(120, 120)
	timing, _ := advanceMetricTiming(metricTiming{}, rule, "epoch", 90, at, "first", "trigger", "")
	timing, _ = advanceMetricTiming(timing, rule, "epoch", 90, at.Add(time.Minute), "second", "trigger", "")
	raw, err := bson.Marshal(metricState{ID: "r", LastAt: metricInstant{at.Add(time.Minute)}, LastOutcomeAt: metricInstant{at.Add(time.Minute)}, Timing: timing})
	if err != nil {
		t.Fatal(err)
	}
	var restored metricState
	if err := bson.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if !restored.Timing.Since.Equal(at) || !restored.LastAt.Equal(at.Add(time.Minute)) {
		t.Fatal("clock lost nanosecond precision")
	}
	_, early := advanceMetricTiming(restored.Timing, rule, "epoch", 90, at.Add(120*time.Second-time.Nanosecond), "third", "trigger", "")
	if early.Action != "" {
		t.Fatal("Mongo roundtrip fired before deadline")
	}
	legacy, _ := bson.Marshal(bson.M{"_id": "r", "lastAt": at})
	if err := bson.Unmarshal(legacy, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.LastAt.Before(at) {
		t.Fatal("legacy watermark rounded down")
	}
}
