package subscriber

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestClampSearchLimit(t *testing.T) {
	tests := []struct {
		input string
		want  int
	}{
		{"", 8},
		{"0", 1},
		{"1", 1},
		{"8", 8},
		{"12", 12},
		{"13", 12},
		{"100", 12},
		{"abc", 8},
		{"-1", 1},
	}
	for _, tt := range tests {
		got := clampSearchLimit(tt.input)
		if got != tt.want {
			t.Errorf("clampSearchLimit(%q) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestValidateImsi(t *testing.T) {
	tests := []struct {
		value   string
		field   string
		wantErr bool
	}{
		{"", "IMSI", true},
		{"123456789012345", "IMSI", false},
		{"12345678901234", "IMSI", true},   // too short
		{"1234567890123456", "IMSI", true}, // too long
		{"12345678901234a", "IMSI", true},  // non-digit
	}
	for _, tt := range tests {
		_, err := validateImsi(tt.value, tt.field)
		if (err != nil) != tt.wantErr {
			t.Errorf("validateImsi(%q, %q) error = %v, wantErr %v", tt.value, tt.field, err, tt.wantErr)
		}
	}
}

func TestValidateBatchCount(t *testing.T) {
	tests := []struct {
		value   int
		wantErr bool
	}{
		{0, true},
		{1, false},
		{500, false},
		{1000, false},
		{1001, true},
	}
	for _, tt := range tests {
		_, err := validateBatchCount(tt.value)
		if (err != nil) != tt.wantErr {
			t.Errorf("validateBatchCount(%d) error = %v, wantErr %v", tt.value, err, tt.wantErr)
		}
	}
}

func TestSafePage(t *testing.T) {
	if safePage(0) != 1 {
		t.Errorf("safePage(0) = %d, want 1", safePage(0))
	}
	if safePage(-1) != 1 {
		t.Errorf("safePage(-1) = %d, want 1", safePage(-1))
	}
	if safePage(5) != 5 {
		t.Errorf("safePage(5) = %d, want 5", safePage(5))
	}
}

func TestSafeLimit(t *testing.T) {
	if safeLimit(0) != defaultListLimit {
		t.Errorf("safeLimit(0) = %d, want %d", safeLimit(0), defaultListLimit)
	}
	if safeLimit(100) != 100 {
		t.Errorf("safeLimit(100) = %d, want 100", safeLimit(100))
	}
	if safeLimit(300) != maxListLimit {
		t.Errorf("safeLimit(300) = %d, want %d", safeLimit(300), maxListLimit)
	}
}

func TestSubscriberFilter(t *testing.T) {
	// Empty query returns empty filter
	filter, valid := subscriberFilter("")
	if !valid {
		t.Error("subscriberFilter('') should be valid")
	}
	if filter == nil {
		t.Error("subscriberFilter('') should return non-nil filter")
	}

	// Valid digit query
	filter, valid = subscriberFilter("46000")
	if !valid {
		t.Error("subscriberFilter('46000') should be valid")
	}
	if filter == nil {
		t.Error("subscriberFilter('46000') should return non-nil filter")
	}

	// Non-digit query returns invalid
	_, valid = subscriberFilter("abc")
	if valid {
		t.Error("subscriberFilter('abc') should be invalid")
	}

	// Too long query returns invalid
	_, valid = subscriberFilter("1234567890123456")
	if valid {
		t.Error("subscriberFilter('1234567890123456') should be invalid")
	}
}

func TestStatusFromARD(t *testing.T) {
	if statusFromARD(255) != "Suspended" {
		t.Errorf("statusFromARD(255) = %q, want Suspended", statusFromARD(255))
	}
	if statusFromARD(1) != "Partial Restricted" {
		t.Errorf("statusFromARD(1) = %q, want Partial Restricted", statusFromARD(1))
	}
	if statusFromARD(32) != "Active" {
		t.Errorf("statusFromARD(32) = %q, want Active", statusFromARD(32))
	}
	if statusFromARD(0) != "Active" {
		t.Errorf("statusFromARD(0) = %q, want Active", statusFromARD(0))
	}
}

func TestNormalizeTraffic(t *testing.T) {
	// Normal case
	traffic := normalizeTraffic(int64(1000), int64(300), int64(700))
	if traffic.Total != 1000 || traffic.Used != 300 || traffic.Balance != 700 {
		t.Errorf("normalizeTraffic(1000, 300, 700) = %+v", traffic)
	}

	// Zero total defaults to balance
	traffic = normalizeTraffic(int64(0), int64(0), int64(500))
	if traffic.Total != 500 {
		t.Errorf("normalizeTraffic(0, 0, 500).Total = %d, want 500", traffic.Total)
	}

	// Total less than balance gets corrected
	traffic = normalizeTraffic(int64(100), int64(0), int64(500))
	if traffic.Total != 500 {
		t.Errorf("normalizeTraffic(100, 0, 500).Total = %d, want 500", traffic.Total)
	}
}

func TestNormalizeSMS(t *testing.T) {
	sms := normalizeSMS(int64(100), int64(20), int64(80))
	if sms.Total != 100 || sms.Used != 20 || sms.Balance != 80 {
		t.Errorf("normalizeSMS(100, 20, 80) = %+v", sms)
	}
}

func TestGenerateImsiRange(t *testing.T) {
	imsis := generateImsiRange("460001234567890", 3)
	if len(imsis) != 3 {
		t.Fatalf("generateImsiRange returned %d items, want 3", len(imsis))
	}
	if imsis[0] != "460001234567890" {
		t.Errorf("imsis[0] = %q, want 460001234567890", imsis[0])
	}
	if imsis[1] != "460001234567891" {
		t.Errorf("imsis[1] = %q, want 460001234567891", imsis[1])
	}
	if imsis[2] != "460001234567892" {
		t.Errorf("imsis[2] = %q, want 460001234567892", imsis[2])
	}
}

func TestEnsureImsiRange(t *testing.T) {
	// Valid range
	err := ensureImsiRange([]string{"460001234567890", "460001234567891"})
	if err != nil {
		t.Errorf("ensureImsiRange valid: %v", err)
	}

	// Overflow (too many digits)
	err = ensureImsiRange([]string{"1234567890123456"})
	if err == nil {
		t.Error("ensureImsiRange overflow should return error")
	}
}

func TestIsLowTraffic(t *testing.T) {
	if !isLowTraffic(SubscriberRow{Traffic: TrafficSnapshot{Balance: 0}}) {
		t.Error("balance 0 should be low traffic")
	}
	if isLowTraffic(SubscriberRow{Traffic: TrafficSnapshot{Balance: 100}}) {
		t.Error("balance 100 should not be low traffic")
	}
}

func TestMatchesStatusFilter(t *testing.T) {
	row := SubscriberRow{Status: "Active", Traffic: TrafficSnapshot{Balance: 100}}
	if !matchesStatusFilter(row, "all") {
		t.Error("all should match")
	}
	if !matchesStatusFilter(row, "active") {
		t.Error("active should match Active")
	}
	if matchesStatusFilter(row, "restricted") {
		t.Error("restricted should not match Active")
	}

	restrictedRow := SubscriberRow{Status: "Suspended", Traffic: TrafficSnapshot{Balance: 100}}
	if !matchesStatusFilter(restrictedRow, "restricted") {
		t.Error("restricted should match Suspended")
	}

	lowRow := SubscriberRow{Status: "Active", Traffic: TrafficSnapshot{Balance: 0}}
	if !matchesStatusFilter(lowRow, "lowTraffic") {
		t.Error("lowTraffic should match balance 0")
	}
}

func TestOpen5gsToLegacyState(t *testing.T) {
	// Nil doc returns nil
	if open5gsToLegacyState(nil) != nil {
		t.Error("nil doc should return nil")
	}

	// Basic doc
	doc := bson.M{
		"imsi":                            "460001234567890",
		"access_restriction_data":         int32(32),
		"network_access_mode":             int32(0),
		"subscriber_status":               int32(0),
		"sequence_number":                 int64(123456),
		"security_key":                    "00112233445566778899aabbccddeeff",
		"authentication_management_field": "8000",
	}

	state := open5gsToLegacyState(doc)
	if state == nil {
		t.Fatal("open5gsToLegacyState should not return nil")
	}
	if state.Sub4G == nil {
		t.Error("sub4G should not be nil")
	}
	if state.Auth4G == nil {
		t.Error("auth4G should not be nil")
	}
	if state.Pcrf4G == nil {
		t.Error("pcrf4G should not be nil")
	}
}

// TestSummaryPreFilter verifies that summary is computed from ALL matching rows
// before status filtering, while total is the post-filter count.
// This matches Node behavior: summary = pre-filter, total = post-filter.
func TestSummaryPreFilter(t *testing.T) {
	rows := []SubscriberRow{
		{IMSI: "460000000000001", Status: "Active", Traffic: TrafficSnapshot{Balance: 100}},
		{IMSI: "460000000000002", Status: "Suspended", Traffic: TrafficSnapshot{Balance: 100}},
		{IMSI: "460000000000003", Status: "Active", Traffic: TrafficSnapshot{Balance: 0}}, // low traffic
		{IMSI: "460000000000004", Status: "Active", Traffic: TrafficSnapshot{Balance: 200}},
	}

	// Summary is computed from ALL rows (pre-filter)
	summary := buildSummary(nil, rows)
	if summary.Total != 4 {
		t.Errorf("summary.Total = %d, want 4 (pre-filter)", summary.Total)
	}
	if summary.Active != 3 {
		t.Errorf("summary.Active = %d, want 3 (pre-filter)", summary.Active)
	}
	if summary.Restricted != 1 {
		t.Errorf("summary.Restricted = %d, want 1 (pre-filter)", summary.Restricted)
	}
	if summary.LowTraffic != 1 {
		t.Errorf("summary.LowTraffic = %d, want 1 (pre-filter)", summary.LowTraffic)
	}

	// After filtering to "active" only, total = 3 (post-filter)
	filtered := make([]SubscriberRow, 0)
	for _, row := range rows {
		if matchesStatusFilter(row, "active") {
			filtered = append(filtered, row)
		}
	}
	if len(filtered) != 3 {
		t.Errorf("filtered count = %d, want 3 (post-filter active)", len(filtered))
	}
}

// TestSortFallback verifies that invalid sortField falls back to "imsi".
func TestSortFallback(t *testing.T) {
	rows := []SubscriberRow{
		{IMSI: "460000000000003"},
		{IMSI: "460000000000001"},
		{IMSI: "460000000000002"},
	}

	// Invalid sortField should fallback to "imsi"
	sortSubscriberRows(rows, "invalid_field", "asc")
	if rows[0].IMSI != "460000000000001" {
		t.Errorf("sort fallback: rows[0].IMSI = %q, want 460000000000001", rows[0].IMSI)
	}
	if rows[2].IMSI != "460000000000003" {
		t.Errorf("sort fallback: rows[2].IMSI = %q, want 460000000000003", rows[2].IMSI)
	}
}

// TestSortDirectionDefault verifies that only "desc" is descending; all else is ascending.
func TestSortDirectionDefault(t *testing.T) {
	rows := []SubscriberRow{
		{IMSI: "460000000000001"},
		{IMSI: "460000000000003"},
		{IMSI: "460000000000002"},
	}

	// "desc" → descending
	sortSubscriberRows(rows, "imsi", "desc")
	if rows[0].IMSI != "460000000000003" {
		t.Errorf("desc sort: rows[0].IMSI = %q, want 460000000000003", rows[0].IMSI)
	}

	// "asc" → ascending
	sortSubscriberRows(rows, "imsi", "asc")
	if rows[0].IMSI != "460000000000001" {
		t.Errorf("asc sort: rows[0].IMSI = %q, want 460000000000001", rows[0].IMSI)
	}

	// anything else → ascending
	sortSubscriberRows(rows, "imsi", "random")
	if rows[0].IMSI != "460000000000001" {
		t.Errorf("default sort: rows[0].IMSI = %q, want 460000000000001", rows[0].IMSI)
	}
}

// TestPaginationAfterFilter verifies pagination operates on filtered results.
func TestPaginationAfterFilter(t *testing.T) {
	// 5 rows, 3 active, 2 suspended
	rows := []SubscriberRow{
		{IMSI: "460000000000001", Status: "Active", Traffic: TrafficSnapshot{Balance: 100}},
		{IMSI: "460000000000002", Status: "Suspended", Traffic: TrafficSnapshot{Balance: 100}},
		{IMSI: "460000000000003", Status: "Active", Traffic: TrafficSnapshot{Balance: 100}},
		{IMSI: "460000000000004", Status: "Suspended", Traffic: TrafficSnapshot{Balance: 100}},
		{IMSI: "460000000000005", Status: "Active", Traffic: TrafficSnapshot{Balance: 100}},
	}

	// Filter to "active" → 3 rows
	filtered := make([]SubscriberRow, 0)
	for _, row := range rows {
		if matchesStatusFilter(row, "active") {
			filtered = append(filtered, row)
		}
	}

	// Page 1, limit 2 → first 2 of 3
	total := len(filtered) // 3
	page := 1
	limit := 2
	start := (page - 1) * limit
	end := start + limit
	if start > total {
		start = total
	}
	if end > total {
		end = total
	}
	paged := filtered[start:end]
	if len(paged) != 2 {
		t.Errorf("page 1: len = %d, want 2", len(paged))
	}

	// Page 2, limit 2 → remaining 1
	page = 2
	start = (page - 1) * limit
	end = start + limit
	if start > total {
		start = total
	}
	if end > total {
		end = total
	}
	paged = filtered[start:end]
	if len(paged) != 1 {
		t.Errorf("page 2: len = %d, want 1", len(paged))
	}
}

// TestLegacyDetailSections verifies the legacy detail response has all required sections.
func TestLegacyDetailSections(t *testing.T) {
	doc := bson.M{
		"imsi":                            "460001234567890",
		"access_restriction_data":         int32(32),
		"network_access_mode":             int32(0),
		"subscriber_status":               int32(0),
		"sequence_number":                 int64(123456),
		"security_key":                    "00112233445566778899aabbccddeeff",
		"authentication_management_field": "8000",
	}

	state := open5gsToLegacyState(doc)
	if state == nil {
		t.Fatal("open5gsToLegacyState should not return nil")
	}

	// All sections must be present (not nil)
	if state.Sub4G == nil {
		t.Error("sub4G must not be nil")
	}
	if state.Pcrf4G == nil {
		t.Error("pcrf4G must not be nil")
	}
	if state.Auth4G == nil {
		t.Error("auth4G must not be nil")
	}

	// OCS sections are added by FindSubscriberLegacyState, not open5gsToLegacyState
	// So they would be nil here — that's expected
}
