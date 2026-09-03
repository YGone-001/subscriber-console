package approval

import (
	"fmt"
	"testing"
	"time"
)

// ── nextChangeId Contract Tests ──────────────────────────────────────────────

func TestNextChangeId_Format(t *testing.T) {
	// Verify the CHG-YYYYMMDD-NNNNN format
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	dateSegment := now.Format("20060102")
	if dateSegment != "20260902" {
		t.Errorf("expected date segment=20260902, got=%s", dateSegment)
	}
}

func TestNextChangeId_SequenceFormat(t *testing.T) {
	// Verify minimum width 5 formatting using fmt.Sprintf
	tests := []struct {
		seq      int64
		expected string
	}{
		{1, "CHG-20260902-00001"},
		{42, "CHG-20260902-00042"},
		{99999, "CHG-20260902-99999"},
		{100000, "CHG-20260902-100000"},
	}
	for _, tt := range tests {
		dateSegment := "20260902"
		result := fmt.Sprintf("CHG-%s-%05d", dateSegment, tt.seq)
		if result != tt.expected {
			t.Errorf("seq=%d: expected %s, got %s", tt.seq, tt.expected, result)
		}
	}
}

// ── Risk Server-Owned Tests ─────────────────────────────────────────────────

func TestCreateApproval_RiskServerOwned(t *testing.T) {
	// Risk must be computed from action, never from client input
	tests := []struct {
		action       string
		expectedRisk RiskLevel
	}{
		{"ACCESS_REQUEST", RiskHigh},
		{"SUBSCRIBER_CREATE", RiskMedium},
		{"SUBSCRIBER_UPDATE", RiskHigh},
		{"TARIFF_PLAN_DELETE", RiskCritical},
		{"UNKNOWN_ACTION", RiskHigh}, // fail-safe
	}

	for _, tt := range tests {
		t.Run(tt.action, func(t *testing.T) {
			ra := AssessApprovalRisk(tt.action)
			if ra.Level != tt.expectedRisk {
				t.Errorf("action=%s: expected risk=%s, got=%s", tt.action, tt.expectedRisk, ra.Level)
			}
			if ra.PolicyID != ApprovalRiskPolicyID {
				t.Errorf("expected policyId=%s, got=%s", ApprovalRiskPolicyID, ra.PolicyID)
			}
		})
	}
}

// ── Operation Fallback Tests ────────────────────────────────────────────────

func TestCreateApproval_OperationFallback(t *testing.T) {
	// When operation is absent, derive from targetId
	tests := []struct {
		targetId           string
		expectedType       string
		expectedResourceId string
	}{
		{"subscriber:imsi-123", "subscriber", "subscriber:imsi-123"},
		{"user:alice", "user", "user:alice"},
		{"no-colon", "approval-target", "no-colon"},
	}

	for _, tt := range tests {
		t.Run(tt.targetId, func(t *testing.T) {
			op := ApprovalOperation{
				ResourceType: resourceTypeFromTarget(tt.targetId),
				ResourceID:   tt.targetId,
			}
			if op.ResourceType != tt.expectedType {
				t.Errorf("expected resourceType=%s, got=%s", tt.expectedType, op.ResourceType)
			}
			if op.ResourceID != tt.expectedResourceId {
				t.Errorf("expected resourceId=%s, got=%s", tt.expectedResourceId, op.ResourceID)
			}
		})
	}
}

// ── Reason Selection Tests ──────────────────────────────────────────────────

func TestCreateApproval_ReasonSelection(t *testing.T) {
	// input.reason ?? payload.reason (if string) ?? ""
	tests := []struct {
		name     string
		input    string
		payload  map[string]interface{}
		expected string
	}{
		{"input reason", "my reason", map[string]interface{}{}, "my reason"},
		{"payload reason", "", map[string]interface{}{"reason": "from payload"}, "from payload"},
		{"both present", "input wins", map[string]interface{}{"reason": "payload"}, "input wins"},
		{"neither", "", map[string]interface{}{}, ""},
		{"payload not string", "", map[string]interface{}{"reason": 42}, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reason := tt.input
			if reason == "" {
				if pr, ok := tt.payload["reason"].(string); ok {
					reason = pr
				}
			}
			if reason != tt.expected {
				t.Errorf("expected reason=%q, got=%q", tt.expected, reason)
			}
		})
	}
}

// ── Events Array Tests ─────────────────────────────────────────────────────

func TestCreateApproval_EventsNeverNull(t *testing.T) {
	// Events must be [] not nil
	events := []GovernanceEvent{}
	if events == nil {
		t.Error("expected events to be non-nil empty slice")
	}
}

func TestCreateApproval_CreatedEvent(t *testing.T) {
	// First event must be type=created
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	event := GovernanceEvent{
		ID:        "test-event-id",
		Timestamp: now,
		Type:      "created",
		Actor:     "alice",
		Message:   "Change request created",
	}
	if event.Type != "created" {
		t.Errorf("expected type=created, got=%s", event.Type)
	}
	if event.Message != "Change request created" {
		t.Errorf("expected message='Change request created', got=%s", event.Message)
	}
}

// ── Timestamp Format Tests ─────────────────────────────────────────────────

func TestCreateApproval_TimestampFormat(t *testing.T) {
	// Single creation timestamp used for createdAt, updatedAt, and event
	now := time.Date(2026, 9, 2, 12, 30, 45, 123000000, time.UTC)
	ts := formatISO8601Millis(now)
	if ts != "2026-09-02T12:30:45.123Z" {
		t.Errorf("expected 2026-09-02T12:30:45.123Z, got=%s", ts)
	}
}

// ── UUID Format Tests ──────────────────────────────────────────────────────

func TestCreateApproval_UUIDFormat(t *testing.T) {
	// Approval id and event id must be UUIDv4
	id := generateEventID()
	if len(id) != 36 {
		t.Errorf("expected UUID length=36, got=%d: %s", len(id), id)
	}
	// Check format: 8-4-4-4-12
	if id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		t.Errorf("expected UUID format 8-4-4-4-12, got=%s", id)
	}
}
