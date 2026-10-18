package nfalert

import (
	"errors"
	"strings"
	"testing"

	"subscriber/internal/nfhealth"
)

func TestValidateUUID(t *testing.T) {
	if err := ValidateUUID("0192f0c0-a000-7000-8000-000000000000"); err != nil {
		t.Fatalf("valid uuid rejected: %v", err)
	}
	for _, id := range []string{"", "abc", "0192f0c0-a000-7000-8000", "not-a-uuid", "0192F0C0-A000-7000-8000-000000000000extra"} {
		if err := ValidateUUID(id); err == nil {
			t.Fatalf("invalid uuid accepted: %q", id)
		}
	}
}

func TestValidateRuleName(t *testing.T) {
	if err := ValidateRuleName("AMF unhealthy"); err != nil {
		t.Fatalf("valid name rejected: %v", err)
	}
	if err := ValidateRuleName("  padded  "); err != nil {
		t.Fatalf("trimmed valid name rejected: %v", err)
	}
	if err := ValidateRuleName(""); err == nil {
		t.Fatal("empty name accepted")
	}
	if err := ValidateRuleName(strings.Repeat("x", 129)); err == nil {
		t.Fatal("overlong name accepted")
	}
}

func TestValidateRuleFieldsStateCondition(t *testing.T) {
	cond := func(scope, state string) *RuleCondition { return &RuleCondition{Scope: scope, State: state} }

	if err := ValidateRuleFields("n", ConditionTypeState, cond(ScopeOverall, nfhealth.StateUnhealthy), SeverityCritical, 0); err != nil {
		t.Fatalf("valid state rule rejected: %v", err)
	}
	if err := ValidateRuleFields("n", ConditionTypeState, nil, SeverityCritical, 0); err == nil {
		t.Fatal("state condition without payload accepted")
	}
	for _, scope := range []string{"", "everything", "layer1"} {
		if err := ValidateRuleFields("n", ConditionTypeState, cond(scope, nfhealth.StateUnhealthy), SeverityCritical, 0); err == nil {
			t.Fatalf("invalid scope accepted: %q", scope)
		}
	}
	// States the engine can never satisfy must be rejected for every scope.
	for _, scope := range CanonicalConditionScopes {
		for _, state := range []string{nfhealth.StateHealthy, nfhealth.StateStale, nfhealth.StateNotConfigured, ""} {
			if err := ValidateRuleFields("n", ConditionTypeState, cond(scope, state), SeverityCritical, 0); err == nil {
				t.Fatalf("non-alarmable state accepted: scope=%q state=%q", scope, state)
			}
		}
	}
}

func TestValidateRuleFieldsRunFailed(t *testing.T) {
	if err := ValidateRuleFields("n", ConditionTypeRunFailed, nil, SeverityCritical, 0); err != nil {
		t.Fatalf("valid run_failed rule rejected: %v", err)
	}
	// A payload on a payload-free condition type is contract drift and must
	// be rejected rather than silently ignored.
	payload := &RuleCondition{Scope: ScopeOverall, State: nfhealth.StateUnhealthy}
	if err := ValidateRuleFields("n", ConditionTypeRunFailed, payload, SeverityCritical, 0); err == nil {
		t.Fatal("run_failed with condition payload accepted")
	}
	if err := ValidateRuleFields("n", "threshold", nil, SeverityCritical, 0); err == nil {
		t.Fatal("unknown condition type accepted")
	}
}

func TestValidateRuleFieldsSeverityAndCooldown(t *testing.T) {
	cond := &RuleCondition{Scope: ScopeOverall, State: nfhealth.StateUnhealthy}
	for _, sev := range CanonicalSeverities {
		if err := ValidateRuleFields("n", ConditionTypeState, cond, sev, 0); err != nil {
			t.Fatalf("valid severity rejected: %v", err)
		}
	}
	for _, sev := range []string{"", "fatal", "criticality"} {
		if err := ValidateRuleFields("n", ConditionTypeState, cond, sev, 0); err == nil {
			t.Fatalf("invalid severity accepted: %q", sev)
		}
	}
	for _, cooldown := range []int{MinCooldownSeconds, MaxCooldownSeconds} {
		if err := ValidateRuleFields("n", ConditionTypeState, cond, SeverityCritical, cooldown); err != nil {
			t.Fatalf("valid cooldown rejected: %v", err)
		}
	}
	for _, cooldown := range []int{-1, MinCooldownSeconds - 1, MaxCooldownSeconds + 1} {
		if err := ValidateRuleFields("n", ConditionTypeState, cond, SeverityCritical, cooldown); err == nil {
			t.Fatalf("invalid cooldown accepted: %d", cooldown)
		}
	}
	// Zero means "use the default" and is resolved by NormalizeCooldown.
	if err := ValidateRuleFields("n", ConditionTypeState, cond, SeverityCritical, 0); err != nil {
		t.Fatalf("zero cooldown (default) rejected: %v", err)
	}
}

func TestNormalizeCooldown(t *testing.T) {
	if got, err := NormalizeCooldown(0); err != nil || got != DefaultCooldownSeconds {
		t.Fatalf("zero must normalize to default, got %d, %v", got, err)
	}
	if got, err := NormalizeCooldown(60); err != nil || got != 60 {
		t.Fatalf("valid cooldown rejected, got %d, %v", got, err)
	}
	if _, err := NormalizeCooldown(59); err == nil {
		t.Fatal("below-minimum cooldown accepted")
	}
	if _, err := NormalizeCooldown(86401); err == nil {
		t.Fatal("above-maximum cooldown accepted")
	}
}

func TestValidateTargetScope(t *testing.T) {
	if err := ValidateTargetScope("", ""); err != nil {
		t.Fatalf("global scope rejected: %v", err)
	}
	if err := ValidateTargetScope("0192f0c0-a000-7000-8000-000000000000", ""); err != nil {
		t.Fatalf("target scope rejected: %v", err)
	}
	if err := ValidateTargetScope("", "0192f0c0-a000-7000-8000-000000000001"); err != nil {
		t.Fatalf("resource scope rejected: %v", err)
	}
	if err := ValidateTargetScope("0192f0c0-a000-7000-8000-000000000000", "0192f0c0-a000-7000-8000-000000000001"); err == nil {
		t.Fatal("both dimensions set accepted")
	}
	if err := ValidateTargetScope("abc", ""); err == nil {
		t.Fatal("malformed targetId accepted")
	}
	if err := ValidateTargetScope("", "not-a-uuid"); err == nil {
		t.Fatal("malformed resourceId accepted")
	}
}

func TestValidateLimit(t *testing.T) {
	if got, err := ValidateLimit(""); err != nil || got != DefaultPageLimit {
		t.Fatalf("empty limit must default, got %d, %v", got, err)
	}
	if got, err := ValidateLimit("1"); err != nil || got != 1 {
		t.Fatalf("limit 1 rejected, got %d, %v", got, err)
	}
	if got, err := ValidateLimit("200"); err != nil || got != MaxPageLimit {
		t.Fatalf("limit 200 rejected, got %d, %v", got, err)
	}
	for _, raw := range []string{"0", "-1", "abc", "1.5", "201", "99999999999"} {
		if _, err := ValidateLimit(raw); err == nil {
			t.Fatalf("invalid limit accepted: %q", raw)
		}
	}
}

func TestMapValidationError(t *testing.T) {
	code, msg := MapValidationError(validationError("NF_ALERT_INVALID_RULE_NAME", "bad name"))
	if code != "NF_ALERT_INVALID_RULE_NAME" || msg != "bad name" {
		t.Fatalf("mapping mismatch: %q %q", code, msg)
	}
	code, msg = MapValidationError(errors.New("boom"))
	if code != "NF_ALERT_INVALID" || msg != "invalid request" {
		t.Fatalf("fallback mapping mismatch: %q %q", code, msg)
	}
}

// TestMetaVocabularyMatchesSelectableStates guards the meta contract: every
// advertised state value must be selectable for every advertised scope, and
// the scope-allowed states must all appear in the meta vocabulary.
func TestMetaVocabularyMatchesSelectableStates(t *testing.T) {
	advertised := map[string]bool{}
	for _, v := range CanonicalStateConditionValues {
		advertised[v] = true
	}
	if len(advertised) != len(CanonicalStateConditionValues) {
		t.Fatal("duplicate values in state condition vocabulary")
	}
	for _, scope := range CanonicalConditionScopes {
		allowed := ScopeAllowedStates(scope)
		if len(allowed) == 0 {
			t.Fatalf("scope %q has no selectable states", scope)
		}
		for _, state := range allowed {
			if !advertised[state] {
				t.Fatalf("selectable state %q (scope %q) missing from meta vocabulary", state, scope)
			}
			if !StateSelectable(scope, state) {
				t.Fatalf("StateSelectable disagrees with ScopeAllowedStates: %q %q", scope, state)
			}
		}
		for _, state := range CanonicalStateConditionValues {
			if !StateSelectable(scope, state) {
				t.Fatalf("advertised state %q not selectable for scope %q", state, scope)
			}
		}
	}
}

func TestCanonicalVocabularies(t *testing.T) {
	if len(CanonicalAlertStates) != 3 || CanonicalAlertStates[0] != AlertStateActive {
		t.Fatalf("alert states vocabulary mismatch: %v", CanonicalAlertStates)
	}
	if len(CanonicalSeverities) != 3 || CanonicalSeverities[0] != SeverityCritical {
		t.Fatalf("severities vocabulary mismatch: %v", CanonicalSeverities)
	}
	if len(CanonicalConditionTypes) != 2 {
		t.Fatalf("condition types vocabulary mismatch: %v", CanonicalConditionTypes)
	}
	if len(CanonicalResolveReasons) != 3 {
		t.Fatalf("resolve reasons vocabulary mismatch: %v", CanonicalResolveReasons)
	}
}

func TestCursorRoundTrip(t *testing.T) {
	encoded := encodeCursor("2026-10-18T10:00:00Z", "id-1")
	if encoded == nil {
		t.Fatal("encodeCursor returned nil")
	}
	data, err := decodeCursor(*encoded)
	if err != nil {
		t.Fatalf("decodeCursor failed: %v", err)
	}
	if data.At != "2026-10-18T10:00:00Z" || data.ID != "id-1" {
		t.Fatalf("cursor round trip mismatch: %+v", data)
	}
	if _, err := decodeCursor(""); err != nil {
		t.Fatalf("empty cursor must be accepted: %v", err)
	}
	if _, err := decodeCursor("!!!not-base64!!!"); err == nil {
		t.Fatal("malformed cursor accepted")
	}
	if got := encodeCursor("", "id"); got != nil {
		t.Fatalf("incomplete cursor must encode to nil, got %v", got)
	}
}
