package subscriber

import "testing"

func TestValidateImsi_Valid(t *testing.T) {
	imsi, err := ValidateImsi("310260123456789")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imsi != "310260123456789" {
		t.Errorf("expected 310260123456789, got %s", imsi)
	}
}

func TestValidateImsi_TrimSpaces(t *testing.T) {
	imsi, err := ValidateImsi("  310260123456789  ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imsi != "310260123456789" {
		t.Errorf("expected 310260123456789, got %s", imsi)
	}
}

func TestValidateImsi_Empty(t *testing.T) {
	_, err := ValidateImsi("")
	if err == nil {
		t.Fatal("expected error for empty IMSI")
	}
}

func TestValidateImsi_TooShort(t *testing.T) {
	_, err := ValidateImsi("31026012345678")
	if err == nil {
		t.Fatal("expected error for short IMSI")
	}
}

func TestValidateImsi_TooLong(t *testing.T) {
	_, err := ValidateImsi("3102601234567890")
	if err == nil {
		t.Fatal("expected error for long IMSI")
	}
}

func TestValidateImsi_NonDigit(t *testing.T) {
	_, err := ValidateImsi("31026012345678a")
	if err == nil {
		t.Fatal("expected error for non-digit IMSI")
	}
}

func TestValidateSubscriberUpdatePayload_ValidAuth(t *testing.T) {
	payload := UpdatePayload{
		Auth4G: map[string]any{
			"k":   "00112233445566778899AABBCCDDEEFF",
			"op":  "00112233445566778899AABBCCDDEEFF",
			"opc": "00112233445566778899AABBCCDDEEFF",
			"amf": "8000",
			"sqn": 1000,
		},
	}
	if err := ValidateSubscriberUpdatePayload(payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateSubscriberUpdatePayload_InvalidK(t *testing.T) {
	payload := UpdatePayload{
		Auth4G: map[string]any{
			"k": "not-hex",
		},
	}
	if err := ValidateSubscriberUpdatePayload(payload); err == nil {
		t.Fatal("expected error for invalid k")
	}
}

func TestValidateSubscriberUpdatePayload_InvalidAmf(t *testing.T) {
	payload := UpdatePayload{
		Auth4G: map[string]any{
			"amf": "ZZZZ",
		},
	}
	if err := ValidateSubscriberUpdatePayload(payload); err == nil {
		t.Fatal("expected error for invalid amf")
	}
}

func TestValidateSubscriberUpdatePayload_ValidSlice(t *testing.T) {
	payload := UpdatePayload{
		Sub4G: map[string]any{
			"sliceList": []any{
				map[string]any{
					"sst": 1,
					"sd":  "AABBCC",
				},
			},
		},
	}
	if err := ValidateSubscriberUpdatePayload(payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateSubscriberUpdatePayload_TooManySlices(t *testing.T) {
	slices := make([]any, 17)
	for i := range slices {
		slices[i] = map[string]any{"sst": 1}
	}
	payload := UpdatePayload{
		Sub4G: map[string]any{
			"sliceList": slices,
		},
	}
	if err := ValidateSubscriberUpdatePayload(payload); err == nil {
		t.Fatal("expected error for too many slices")
	}
}

func TestValidateSubscriberUpdatePayload_InvalidPlmn(t *testing.T) {
	payload := UpdatePayload{
		OcsTraffic: map[string]any{
			"plmn": "abc",
		},
	}
	if err := ValidateSubscriberUpdatePayload(payload); err == nil {
		t.Fatal("expected error for invalid plmn")
	}
}

func TestValidateSubscriberUpdatePayload_NegativeTraffic(t *testing.T) {
	payload := UpdatePayload{
		OcsTraffic: map[string]any{
			"traffic_total": -1,
		},
	}
	if err := ValidateSubscriberUpdatePayload(payload); err == nil {
		t.Fatal("expected error for negative traffic")
	}
}

func TestValidateSubscriberUpdatePayload_EmptyPayload(t *testing.T) {
	if err := ValidateSubscriberUpdatePayload(UpdatePayload{}); err != nil {
		t.Fatalf("unexpected error for empty payload: %v", err)
	}
}
