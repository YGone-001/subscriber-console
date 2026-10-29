package balance

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestMapBalanceViewKeepsMissingValuesUnknown(t *testing.T) {
	view := mapBalanceView(bson.M{"imsi": "417010000000001"}, nil)

	if view.PlanID != nil || view.Status != nil {
		t.Fatalf("missing plan/status must stay nil, got plan=%v status=%v", view.PlanID, view.Status)
	}
	if view.DataTotal != nil || view.DataAvailable != nil || view.VoiceTotal != nil || view.SmsTotal != nil {
		t.Fatalf("missing measurements must stay nil, got %+v", view)
	}
	if view.Version != nil {
		t.Fatalf("missing version must stay nil, got %v", view.Version)
	}
	if view.InvariantOk != nil || view.DataInvariantOk != nil {
		t.Fatalf("an unknown bucket must not claim an invariant result, got %+v", view.InvariantOk)
	}
}

func TestMapBalanceViewPreservesZeroAndComputesKnownInvariants(t *testing.T) {
	doc := bson.M{
		"imsi":            "417010000000002",
		"data_total":      int64(0),
		"data_used":       int64(0),
		"data_reserved":   int64(0),
		"data_available":  int64(0),
		"voice_total":     int64(3600),
		"voice_used":      int64(0),
		"voice_reserved":  int64(0),
		"voice_available": int64(3600),
		"sms_total":       int64(100),
		"sms_used":        int64(0),
		"sms_available":   int64(100),
		"version":         int64(7),
	}
	view := mapBalanceView(doc, nil)

	if view.DataTotal == nil || *view.DataTotal != 0 {
		t.Fatalf("zero data_total must stay a real zero, got %v", view.DataTotal)
	}
	if view.Version == nil || *view.Version != 7 {
		t.Fatalf("version = %v, want 7", view.Version)
	}
	if view.DataInvariantOk == nil || !*view.DataInvariantOk {
		t.Fatalf("data invariant = %v, want true", view.DataInvariantOk)
	}
	if view.InvariantOk == nil || !*view.InvariantOk {
		t.Fatalf("overall invariant = %v, want true", view.InvariantOk)
	}
}

func TestMapBalanceViewDoesNotInventAnotherBucket(t *testing.T) {
	doc := bson.M{
		"imsi":           "417010000000003",
		"data_total":     int64(1000),
		"data_used":      int64(200),
		"data_reserved":  int64(100),
		"data_available": int64(700),
	}
	view := mapBalanceView(doc, map[string]bson.M{
		"417010000000003": {"plan_id": "plan_real", "status": "suspended"},
	})

	if view.DataInvariantOk == nil || !*view.DataInvariantOk {
		t.Fatalf("data invariant = %v, want true", view.DataInvariantOk)
	}
	if view.InvariantOk != nil {
		t.Fatalf("overall invariant must be unknown while voice/sms are absent, got %v", *view.InvariantOk)
	}
	if view.PlanID == nil || *view.PlanID != "plan_real" {
		t.Fatalf("plan = %v, want plan_real", view.PlanID)
	}
	if view.Status == nil || *view.Status != "suspended" {
		t.Fatalf("status = %v, want suspended", view.Status)
	}
}

func TestBalanceBucketFieldsPresent(t *testing.T) {
	complete := bson.M{
		"data_total": int64(1), "data_used": int64(0), "data_reserved": int64(0),
		"data_available": int64(1), "version": int64(1),
	}
	if !balanceBucketFieldsPresent(complete, "data") {
		t.Fatal("complete data bucket must be adjustable")
	}
	delete(complete, "data_reserved")
	if balanceBucketFieldsPresent(complete, "data") {
		t.Fatal("a bucket missing a field must not be adjustable")
	}
}
