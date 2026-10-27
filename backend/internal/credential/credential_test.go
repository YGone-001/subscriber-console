package credential

import "testing"

func TestConfiguredDistinguishesMaterialFromAbsence(t *testing.T) {
	cases := []struct {
		label string
		value any
		want  bool
	}{
		{"real material", "465b2ce5b8a37f2e19d4a6c8b0e2f417", true},
		{"empty string", "", false},
		{"all-zero placeholder", "00000000000000000000000000000000", false},
		{"absent", nil, false},
		{"non-string", 42, false},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			if got := Configured(tc.value); got != tc.want {
				t.Errorf("Configured(%v) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestDescribeReportsEveryMaterialField(t *testing.T) {
	state := Describe(map[string]any{
		"k":   "465b2ce5b8a37f2e19d4a6c8b0e2f417",
		"opc": "00000000000000000000000000000000",
		"amf": "8000",
	}, VisibilityMasked)

	if state.Visibility != VisibilityMasked {
		t.Errorf("visibility: got %q", state.Visibility)
	}
	if state.K != FieldConfigured {
		t.Errorf("k: expected configured, got %q", state.K)
	}
	if state.Opc != FieldNotConfigured {
		t.Errorf("opc: expected not_configured for an all-zero fill, got %q", state.Opc)
	}
	if state.Op != FieldNotConfigured {
		t.Errorf("op: expected not_configured when absent, got %q", state.Op)
	}
}

func TestIsMaterialCoversOnlyKeyMaterial(t *testing.T) {
	for _, key := range []string{"k", "op", "opc"} {
		if !IsMaterial(key) {
			t.Errorf("%s must be treated as key material", key)
		}
	}
	// AMF and the sequence number are parameters, not permanent keys: withholding
	// them would break the reader's ability to reason about the subscriber.
	for _, key := range []string{"amf", "sqn", "n", StateKey} {
		if IsMaterial(key) {
			t.Errorf("%s must not be withheld", key)
		}
	}
}
