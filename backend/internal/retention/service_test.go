package retention

import (
	"testing"
	"time"
)

func TestSettingsReflectRetentionWindow(t *testing.T) {
	service := NewService(nil, nil, 365)
	service.now = func() time.Time { return time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC) }
	settings := service.Settings()
	if !settings.Enabled || settings.RetentionDays != 365 {
		t.Fatalf("settings = %+v, want enabled 365-day window", settings)
	}
	if settings.Cutoff != "2025-10-29T12:00:00Z" {
		t.Fatalf("cutoff = %q", settings.Cutoff)
	}
	if settings.Confirmation != ConfirmationPhrase {
		t.Fatalf("confirmation = %q", settings.Confirmation)
	}

	disabled := NewService(nil, nil, 0)
	if disabled.Settings().Enabled {
		t.Fatal("zero retention days must disable physical cleanup")
	}
}

func TestDataClassesDescribeEveryRetentionMode(t *testing.T) {
	policies := NewService(nil, nil, 365).DataClasses()
	if len(policies) != 6 {
		t.Fatalf("expected six data classes, got %d", len(policies))
	}
	foundOCS := false
	for _, policy := range policies {
		if policy.Key == "ocs_terminated_contracts" {
			foundOCS = true
			if !policy.Purgeable || policy.Mode != "manual_purge" || policy.RetentionDays != 365 {
				t.Fatalf("unexpected OCS policy: %+v", policy)
			}
		}
		if policy.Key == "nf_health_samples" && policy.Mode != "ttl" {
			t.Fatalf("NF health samples must be TTL-governed: %+v", policy)
		}
		if policy.Key == "knowledge_unbound_attachments" && policy.Mode != "janitor" {
			t.Fatalf("knowledge attachments must be janitor-governed: %+v", policy)
		}
	}
	if !foundOCS {
		t.Fatal("OCS terminated-contract policy must be present")
	}
}

func TestPurgeValidation(t *testing.T) {
	service := NewService(nil, nil, 365)
	valid := PurgeOptions{Reason: "retention test", Confirmation: ConfirmationPhrase}
	if err := service.validate(valid); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
	if err := service.validate(PurgeOptions{Reason: "x"}); err != ErrConfirmationNeeded {
		t.Fatalf("missing confirmation = %v", err)
	}
	if err := service.validate(PurgeOptions{Confirmation: ConfirmationPhrase}); err != ErrReasonRequired {
		t.Fatalf("missing reason = %v", err)
	}
	if err := NewService(nil, nil, 0).validate(valid); err != ErrRetentionDisabled {
		t.Fatalf("disabled service = %v", err)
	}
}

func TestClampLimit(t *testing.T) {
	if got := clampLimit(0); got != 100 {
		t.Fatalf("clampLimit(0) = %d", got)
	}
	if got := clampLimit(5000); got != 1000 {
		t.Fatalf("clampLimit(5000) = %d", got)
	}
	if got := clampLimit(25); got != 25 {
		t.Fatalf("clampLimit(25) = %d", got)
	}
}

func TestContractTimeAcceptsStoredShapes(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	for _, value := range []any{now, now.Format(time.RFC3339Nano)} {
		parsed, ok := contractTime(value)
		if !ok || !parsed.Equal(now) {
			t.Fatalf("contractTime(%v) = %v/%v", value, parsed, ok)
		}
	}
	if _, ok := contractTime(nil); ok {
		t.Fatal("nil timestamp must not be eligible")
	}
}
