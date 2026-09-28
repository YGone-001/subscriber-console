package remediation

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestBuildDefaultXcloudSubscriber(t *testing.T) {
	doc := buildDefaultXcloudSubscriber("417001234567890", nil)

	if doc["imsi"] != "417001234567890" {
		t.Errorf("expected imsi 417001234567890, got %v", doc["imsi"])
	}
	if doc["imeisv"] != "8672710677532401" {
		t.Errorf("expected default imeisv, got %v", doc["imeisv"])
	}
	if doc["mme_host"] != "mme.epc.mnc000.mcc417.3gppnetwork.org" {
		t.Errorf("expected mme_host mme.epc.mnc000.mcc417.3gppnetwork.org, got %v", doc["mme_host"])
	}
	if doc["mme_realm"] != "epc.mnc000.mcc417.3gppnetwork.org" {
		t.Errorf("expected mme_realm epc.mnc000.mcc417.3gppnetwork.org, got %v", doc["mme_realm"])
	}

	sec, ok := doc["security"].(bson.M)
	if !ok {
		t.Fatalf("expected security bson.M, got %T", doc["security"])
	}
	if sec["k"] != "000102030405060708090A0B0C0D0E0F" {
		t.Errorf("expected default k, got %v", sec["k"])
	}
	if sec["opc"] != "00000000000000000000000000000000" {
		t.Errorf("expected zero opc, got %v", sec["opc"])
	}
	if sec["sqn"] != int64(1719756) {
		t.Errorf("expected default sqn 1719756, got %v", sec["sqn"])
	}

	slices, ok := doc["slice"].([]any)
	if !ok || len(slices) == 0 {
		t.Fatalf("expected non-empty slice array, got %v", doc["slice"])
	}
}

func TestBuildDefaultXcloudSubscriber_UnknownImsi(t *testing.T) {
	doc := buildDefaultXcloudSubscriber("UNKNOWN", nil)
	if doc["imsi"] != "UNKNOWN" {
		t.Errorf("expected imsi UNKNOWN, got %v", doc["imsi"])
	}
	if doc["mme_host"] != "mme.epc.mnc0NO.mccUNK.3gppnetwork.org" {
		t.Errorf("expected mme_host for UNKNOWN, got %v", doc["mme_host"])
	}
}

func TestBuildDefaultXcloudSubscriber_WithProfile(t *testing.T) {
	prof := bson.M{
		"name": "test-prof",
		"ambr": bson.M{
			"downlink": bson.M{"value": 500, "unit": 2},
			"uplink":   bson.M{"value": 200, "unit": 2},
		},
	}
	doc := buildDefaultXcloudSubscriber("417001234567890", prof)
	ambr, ok := doc["ambr"].(bson.M)
	if !ok {
		t.Fatalf("expected ambr bson.M, got %T", doc["ambr"])
	}
	dl, _ := ambr["downlink"].(bson.M)
	if dl["value"] != 500 || dl["unit"] != 2 {
		t.Errorf("expected custom ambr downlink, got %v", dl)
	}
}
