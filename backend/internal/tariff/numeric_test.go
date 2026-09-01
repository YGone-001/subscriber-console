package tariff

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestNumericInt64(t *testing.T) {
	tests := []struct {
		name  string
		input any
		want  int64
	}{
		{"int32 zero", int32(0), 0},
		{"int32 one", int32(1), 1},
		{"int32 1024", int32(1024), 1024},
		{"int32 max", int32(2147483647), 2147483647},

		{"int64 zero", int64(0), 0},
		{"int64 one", int64(1), 1},
		{"int64 1024", int64(1024), 1024},
		{"int64 2147483648", int64(2147483648), 2147483648},
		{"int64 10737418240", int64(10737418240), 10737418240},

		{"float64 zero", float64(0), 0},
		{"float64 one", float64(1), 1},
		{"float64 1024.5", float64(1024.5), 1024},

		{"Decimal128 zero", bson.NewDecimal128(0, 0), 0},
		{"Decimal128 one", bson.NewDecimal128(0, 1), 1},
		{"Decimal128 1024", bson.NewDecimal128(0, 1024), 1024},

		{"nil", nil, 0},
		{"string ignored", "12345", 0},
		{"bool ignored", true, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := numericInt64(tt.input)
			if got != tt.want {
				t.Errorf("numericInt64(%v) = %d, want %d", tt.input, got, tt.want)
			}
		})
	}
}

func TestNormalizeRulesEmpty(t *testing.T) {
	doc := bson.M{"plan_id": "test", "name": "Test"}
	rules := normalizeRules(doc, "test")
	if len(rules) != 0 {
		t.Errorf("expected 0 rules, got %d", len(rules))
	}
}

func TestNormalizeRulesNil(t *testing.T) {
	doc := bson.M{"plan_id": "test", "rules": nil}
	rules := normalizeRules(doc, "test")
	if len(rules) != 0 {
		t.Errorf("expected 0 rules, got %d", len(rules))
	}
}

func TestNormalizeRulesPopulated(t *testing.T) {
	doc := bson.M{
		"plan_id": "test-plan",
		"rules": bson.A{
			bson.M{
				"rating_group": int32(1),
				"currency":     "USD",
				"rates":        "0.01",
				"rates_type":   int32(2),
				"rule_id":      "rule-1",
				"apn":          "internet",
				"unit":         "bytes",
				"priority":     int32(100),
				"status":       "active",
			},
			bson.M{
				"rating_group":       int64(2),
				"service_identifier": int64(100),
				"rule_id":            "rule-2",
				"quota_per_grant":    int64(1073741824),
				"validity_time":      int32(86400),
				"volume_threshold":   int64(1048576),
			},
		},
	}

	rules := normalizeRules(doc, "test-plan")
	if len(rules) != 2 {
		t.Fatalf("expected 2 rules, got %d", len(rules))
	}

	r1 := rules[0]
	if r1.RatingGroupID != 1 {
		t.Errorf("rule1 RatingGroupID = %d, want 1", r1.RatingGroupID)
	}
	if r1.Currency != "USD" {
		t.Errorf("rule1 Currency = %q, want USD", r1.Currency)
	}
	if r1.PlanID != "test-plan" {
		t.Errorf("rule1 PlanID = %q, want test-plan", r1.PlanID)
	}
	if r1.Priority != 100 {
		t.Errorf("rule1 Priority = %d, want 100", r1.Priority)
	}

	r2 := rules[1]
	if r2.RatingGroupID != 2 {
		t.Errorf("rule2 RatingGroupID = %d, want 2", r2.RatingGroupID)
	}
	if r2.ServiceIdentifier != 100 {
		t.Errorf("rule2 ServiceIdentifier = %d, want 100", r2.ServiceIdentifier)
	}
	if r2.QuotaPerGrant != 1073741824 {
		t.Errorf("rule2 QuotaPerGrant = %d, want 1073741824", r2.QuotaPerGrant)
	}
	if r2.ValidityTime != 86400 {
		t.Errorf("rule2 ValidityTime = %d, want 86400", r2.ValidityTime)
	}
}

func TestDetectConflictsNone(t *testing.T) {
	rules := []RatingPolicy{
		{RatingGroupID: 1, APN: "internet", ServiceIdentifier: 0, RuleID: "r1"},
		{RatingGroupID: 2, APN: "internet", ServiceIdentifier: 0, RuleID: "r2"},
	}
	conflicts := detectConflicts(rules)
	if len(conflicts) != 0 {
		t.Errorf("expected 0 conflicts, got %d", len(conflicts))
	}
}

func TestDetectConflictsDuplicate(t *testing.T) {
	rules := []RatingPolicy{
		{RatingGroupID: 1, APN: "internet", ServiceIdentifier: 0, RuleID: "r1"},
		{RatingGroupID: 1, APN: "internet", ServiceIdentifier: 0, RuleID: "r2"},
	}
	conflicts := detectConflicts(rules)
	if len(conflicts) != 1 {
		t.Fatalf("expected 1 conflict, got %d", len(conflicts))
	}
	if conflicts[0].Type != "duplicate" {
		t.Errorf("conflict type = %q, want duplicate", conflicts[0].Type)
	}
}

func TestDetectConflictsDifferentAPN(t *testing.T) {
	rules := []RatingPolicy{
		{RatingGroupID: 1, APN: "internet", ServiceIdentifier: 0, RuleID: "r1"},
		{RatingGroupID: 1, APN: "ims", ServiceIdentifier: 0, RuleID: "r2"},
	}
	conflicts := detectConflicts(rules)
	if len(conflicts) != 0 {
		t.Errorf("expected 0 conflicts (different APN), got %d", len(conflicts))
	}
}

func TestSummarizePlan(t *testing.T) {
	doc := bson.M{
		"plan_id":          "plan_test",
		"name":             "Test Plan",
		"description":      "A test plan",
		"status":           "active",
		"quota_per_grant":  int64(1073741824),
		"validity_time":    int32(86400),
		"volume_threshold": int64(1048576),
		"rules": bson.A{
			bson.M{"rating_group": int32(1)},
			bson.M{"rating_group": int32(2)},
			bson.M{"rating_group": int32(3)},
		},
	}

	summary := summarizePlan(doc, 42)

	if summary.PlanID != "plan_test" {
		t.Errorf("PlanID = %q, want plan_test", summary.PlanID)
	}
	if summary.Name != "Test Plan" {
		t.Errorf("Name = %q, want Test Plan", summary.Name)
	}
	if summary.RulesCount != 3 {
		t.Errorf("RulesCount = %d, want 3", summary.RulesCount)
	}
	if summary.SubscriberCount != 42 {
		t.Errorf("SubscriberCount = %d, want 42", summary.SubscriberCount)
	}
	if summary.IsDefault {
		t.Error("IsDefault should be false for plan_test")
	}
	if summary.QuotaPerGrant != 1073741824 {
		t.Errorf("QuotaPerGrant = %d, want 1073741824", summary.QuotaPerGrant)
	}
	if summary.ValidityTime != 86400 {
		t.Errorf("ValidityTime = %d, want 86400", summary.ValidityTime)
	}
}
