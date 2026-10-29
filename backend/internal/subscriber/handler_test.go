package subscriber

import (
	"encoding/json"
	"net/url"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/credential"
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

func testInt64Ptr(value int64) *int64 {
	return &value
}

func TestNormalizeTraffic(t *testing.T) {
	traffic := normalizeTraffic(int64(1000), int64(300), int64(700))
	if traffic.Total == nil || *traffic.Total != 1000 ||
		traffic.Used == nil || *traffic.Used != 300 ||
		traffic.Balance == nil || *traffic.Balance != 700 {
		t.Errorf("normalizeTraffic(1000, 300, 700) = %+v", traffic)
	}

	// A zero total is a real value, not a prompt to derive one from the balance.
	traffic = normalizeTraffic(int64(0), int64(0), int64(500))
	if traffic.Total == nil || *traffic.Total != 0 {
		t.Errorf("normalizeTraffic(0, 0, 500).Total = %v, want 0", traffic.Total)
	}

	traffic = normalizeTraffic(nil, nil, int64(500))
	if traffic.Total != nil || traffic.Used != nil || traffic.Balance == nil || *traffic.Balance != 500 {
		t.Errorf("normalizeTraffic(nil, nil, 500) = %+v", traffic)
	}
}

func TestNormalizeSMS(t *testing.T) {
	sms := normalizeSMS(int64(100), int64(20), int64(80))
	if sms.Total == nil || *sms.Total != 100 ||
		sms.Used == nil || *sms.Used != 20 ||
		sms.Balance == nil || *sms.Balance != 80 {
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
	if !isLowTraffic(SubscriberRow{Traffic: TrafficSnapshot{Balance: testInt64Ptr(0)}, Provisioning: SubscriberProvisioning{Balance: true}}) {
		t.Error("provisioned balance 0 should be low traffic")
	}
	if isLowTraffic(SubscriberRow{Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}, Provisioning: SubscriberProvisioning{Balance: true}}) {
		t.Error("balance 100 should not be low traffic")
	}
	if isLowTraffic(SubscriberRow{Traffic: TrafficSnapshot{Balance: testInt64Ptr(0)}}) {
		t.Error("missing balance record must be unprovisioned, not low traffic")
	}
}

func TestClassifyBalance(t *testing.T) {
	tests := []struct {
		name       string
		hasBalance bool
		available  *int64
		threshold  int64
		want       string
	}{
		{"missing record", false, nil, 1073741824, balanceStateMissing},
		{"unknown available", true, nil, 1073741824, balanceStateUnknown},
		{"exhausted", true, testInt64Ptr(0), 1073741824, balanceStateExhausted},
		{"low at threshold", true, testInt64Ptr(1073741824), 1073741824, balanceStateLow},
		{"low below threshold", true, testInt64Ptr(1024), 1073741824, balanceStateLow},
		{"normal above threshold", true, testInt64Ptr(1073741825), 1073741824, balanceStateNormal},
		{"threshold disabled", true, testInt64Ptr(1024), 0, balanceStateNormal},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyBalance(tt.hasBalance, tt.available, tt.threshold); got != tt.want {
				t.Fatalf("classifyBalance = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestMatchesStatusFilter(t *testing.T) {
	row := SubscriberRow{Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}, Provisioning: SubscriberProvisioning{Balance: true}}
	if !matchesStatusFilter(row, "all") {
		t.Error("all should match")
	}
	if !matchesStatusFilter(row, "active") {
		t.Error("active should match Active")
	}
	if matchesStatusFilter(row, "restricted") {
		t.Error("restricted should not match Active")
	}

	restrictedRow := SubscriberRow{Status: "Suspended", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}, Provisioning: SubscriberProvisioning{Balance: true}}
	if !matchesStatusFilter(restrictedRow, "restricted") {
		t.Error("restricted should match Suspended")
	}

	lowRow := SubscriberRow{Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(0)}, Provisioning: SubscriberProvisioning{Balance: true}}
	if !matchesStatusFilter(lowRow, "lowTraffic") {
		t.Error("lowTraffic should match provisioned balance 0")
	}
}

func TestXcloudToLegacyState(t *testing.T) {
	// Nil doc returns nil
	if xcloudToLegacyState(nil) != nil {
		t.Error("nil doc should return nil")
	}

	doc := bson.M{
		"imsi":     "460001234567890",
		"security": bson.M{"k": "00112233445566778899aabbccddeeff", "opc": "E8ED289DEBA952E4283B54E88E6183CA"},
		"slice":    []any{bson.M{"sst": 1}},
		"ambr":     bson.M{"dl": 10000000, "ul": 10000000},
	}

	state := xcloudToLegacyState(doc)
	if state == nil {
		t.Fatal("xcloudToLegacyState should not return nil")
	}

	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}

	sub4G, ok := decoded["sub4G"].(map[string]any)
	if !ok {
		t.Fatal("sub4G must be present")
	}

	// Node parity: nullish defaults.
	if sub4G["access_restriction_data"] != float64(32) {
		t.Errorf("access_restriction_data = %v, want 32", sub4G["access_restriction_data"])
	}
	if sub4G["network_access_mode"] != float64(0) {
		t.Errorf("network_access_mode = %v, want 0", sub4G["network_access_mode"])
	}
	if sub4G["allowedVisitedPlmns"] != "all" {
		t.Errorf("allowedVisitedPlmns = %v, want all", sub4G["allowedVisitedPlmns"])
	}
	if sub4G["profile_name"] != "" {
		t.Errorf("profile_name = %v, want empty string", sub4G["profile_name"])
	}

	// Node parity: normalizeAmbr falls back to {value:1, unit:3} because the
	// document stores ambr.dl/ambr.ul instead of downlink/uplink records.
	ambr, _ := sub4G["ambr"].(map[string]any)
	downlink, _ := ambr["downlink"].(map[string]any)
	if downlink["value"] != float64(1) || downlink["unit"] != float64(3) {
		t.Errorf("ambr.downlink = %v, want {value:1 unit:3}", downlink)
	}

	msisdnList, ok := sub4G["msisdnList"].([]any)
	if !ok || len(msisdnList) != 0 {
		t.Errorf("msisdnList = %v, want []", sub4G["msisdnList"])
	}

	sliceList, ok := sub4G["sliceList"].([]any)
	if !ok || len(sliceList) != 1 {
		t.Fatalf("sliceList = %v, want one slice", sub4G["sliceList"])
	}
	slice, _ := sliceList[0].(map[string]any)
	if slice["default_indicator"] != true || slice["sd"] != "000001" || slice["sst"] != float64(1) {
		t.Errorf("slice = %v", slice)
	}
	if sessionList, ok := slice["session_list"].([]any); !ok || len(sessionList) != 0 {
		t.Errorf("session_list = %v, want []", slice["session_list"])
	}

	// pcrf4G mirrors sub4G.sliceList.
	pcrf4G, _ := decoded["pcrf4G"].(map[string]any)
	if pcrfSlices, ok := pcrf4G["sliceList"].([]any); !ok || len(pcrfSlices) != 1 {
		t.Errorf("pcrf4G.sliceList = %v, want one slice", pcrf4G["sliceList"])
	}

	auth4G, _ := decoded["auth4G"].(map[string]any)
	if auth4G["k"] != "00112233445566778899aabbccddeeff" {
		t.Errorf("auth4G.k = %v", auth4G["k"])
	}
	if auth4G["opc"] != "E8ED289DEBA952E4283B54E88E6183CA" {
		t.Errorf("auth4G.opc = %v", auth4G["opc"])
	}
	if auth4G["sqn"] != float64(0) {
		t.Errorf("auth4G.sqn = %v, want 0", auth4G["sqn"])
	}
	if auth4G["amf"] != "8000" {
		t.Errorf("auth4G.amf = %v, want 8000", auth4G["amf"])
	}
	if _, exists := auth4G["op"]; exists {
		t.Error("auth4G.op must be dropped when absent (Node undefined semantics)")
	}
}

// TestLegacyStateWritableSubsetPassesUpdateValidation pins the invariant that the
// writable part of the legacy read projection uses the same QoS precedence as
// normalizeSessionQos(): the projection emits qos.index=0 while the real QCI
// travels in _5qi. The read-only projection keys (profile_name,
// allowedVisitedPlmns) are not writable and must be refused, because the update
// builder would otherwise persist them as top-level fields.
func TestLegacyStateWritableSubsetPassesUpdateValidation(t *testing.T) {
	doc := bson.M{
		"imsi": "460001234567890",
		"slice": []any{
			bson.M{
				"sst": 1,
				"session": []any{
					bson.M{
						"name": "internet",
						"type": 1,
						"qos": bson.M{
							"index": 9,
							"arp":   bson.M{"priority_level": 9},
						},
						"ambr": bson.M{
							"downlink": bson.M{"value": 1, "unit": 3},
							"uplink":   bson.M{"value": 1, "unit": 3},
						},
					},
				},
			},
		},
	}

	state := xcloudToLegacyState(doc)
	if state == nil {
		t.Fatal("xcloudToLegacyState should not return nil")
	}

	writable := map[string]any{}
	for _, key := range []string{"access_restriction_data", "network_access_mode", "ambr", "msisdnList", "sliceList"} {
		if value, ok := state.Sub4G[key]; ok {
			writable[key] = value
		}
	}
	if err := ValidateSubscriberUpdatePayload(UpdatePayload{Sub4G: writable}); err != nil {
		t.Fatalf("writable projection subset must be accepted by update validation: %v", err)
	}

	if err := ValidateSubscriberUpdatePayload(UpdatePayload{Sub4G: state.Sub4G}); err == nil {
		t.Fatal("read-only projection keys must be refused by update validation")
	}
}

// TestSummaryFacetCounts pins the status-strip contract: the Total card is the
// result size, and every other card is a switch preview counted with its own
// facet omitted. The previous contract counted every card over the search set
// only, so a filtered view showed a card total that contradicted the pagination
// footer.
func TestSummaryFacetCounts(t *testing.T) {
	provisioned := SubscriberProvisioning{Contract: true, Balance: true, TariffPlan: true}
	rows := []SubscriberRow{
		{IMSI: "460000000000001", Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}, Provisioning: provisioned},
		{IMSI: "460000000000002", Status: "Suspended", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}, Provisioning: provisioned},
		{IMSI: "460000000000003", Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(0)}, Provisioning: provisioned}, // exhausted
		{IMSI: "460000000000004", Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(200)}, Provisioning: provisioned},
		{IMSI: "460000000000005", Status: "Active"}, // no OCS records: unprovisioned, not low traffic
		{
			IMSI: "460000000000006", Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(50)},
			Provisioning: provisioned, BalanceState: balanceStateLow, BalanceThreshold: 100,
		},
	}

	// No filters: every card describes the whole set.
	unfiltered := buildFacetSummary(rows, SubscriberListFilters{})
	if unfiltered.Total != 6 || unfiltered.Active != 5 || unfiltered.Restricted != 1 {
		t.Fatalf("unfiltered status cards = %+v, want total 6 / active 5 / restricted 1", unfiltered)
	}
	if unfiltered.LowTraffic != 1 || unfiltered.LowBalance != 1 || unfiltered.Unprovisioned != 1 {
		t.Fatalf("unfiltered balance cards = %+v, want exhausted 1 / low 1 / unprovisioned 1", unfiltered)
	}

	// Access filtered to active: the Access card equals the result size, and the
	// Restricted card still answers "how many would I get by switching".
	activeOnly := buildFacetSummary(rows, SubscriberListFilters{Status: "active"})
	if activeOnly.Total != 5 {
		t.Errorf("active view total = %d, want 5", activeOnly.Total)
	}
	if activeOnly.Active != 5 {
		t.Errorf("active card = %d, want 5 (it is the current selection)", activeOnly.Active)
	}
	if activeOnly.Restricted != 1 {
		t.Errorf("restricted card = %d, want 1 (switch preview)", activeOnly.Restricted)
	}

	// Balance filtered to low: the Low Balance card equals the result size, and the
	// access cards describe that same result.
	lowOnly := buildFacetSummary(rows, SubscriberListFilters{BalanceStatus: balanceStateLow})
	if lowOnly.Total != 1 || lowOnly.LowBalance != 1 {
		t.Errorf("low view = %+v, want total 1 and low balance 1", lowOnly)
	}
	if lowOnly.Active != 1 || lowOnly.Restricted != 0 {
		t.Errorf("low view access cards = active %d / restricted %d, want 1 / 0", lowOnly.Active, lowOnly.Restricted)
	}
	if lowOnly.Unprovisioned != 0 {
		t.Errorf("low view unprovisioned = %d, want 0", lowOnly.Unprovisioned)
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
		{IMSI: "460000000000001", Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}},
		{IMSI: "460000000000002", Status: "Suspended", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}},
		{IMSI: "460000000000003", Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}},
		{IMSI: "460000000000004", Status: "Suspended", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}},
		{IMSI: "460000000000005", Status: "Active", Traffic: TrafficSnapshot{Balance: testInt64Ptr(100)}},
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

// TestLegacyDetailSections verifies the legacy detail response always carries
// all six sections of findSubscriberLegacyState() on the wire.
func TestLegacyDetailSections(t *testing.T) {
	doc := bson.M{
		"imsi":     "460001234567890",
		"security": bson.M{"k": "00112233445566778899aabbccddeeff"},
		"slice":    []any{bson.M{"sst": 1}},
	}

	state := xcloudToLegacyState(doc)
	if state == nil {
		t.Fatal("xcloudToLegacyState should not return nil")
	}

	// OCS sections are attached by FindSubscriberLegacyState; even when they are
	// nil, the keys must be present (Node always returns them, possibly null).
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}

	for _, key := range []string{"sub4G", "pcrf4G", "auth4G", "ocsImsi", "ocsTraffic", "ocsTariffPlan"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("legacy detail response must contain %q", key)
		}
	}
	if len(decoded) != 6 {
		t.Errorf("legacy detail response must have exactly 6 sections, got %d", len(decoded))
	}
}

func TestComputeLastActiveUsesLatestTimestamp(t *testing.T) {
	doc := bson.M{
		"updated_at": "2026-01-01T00:00:00.000Z",
	}
	ocsSub := bson.M{
		"updated_at": "2026-03-01T00:00:00.000Z",
	}
	balance := bson.M{
		"updated_at": "2026-02-01T00:00:00.000Z",
	}

	got := computeLastActive(doc, ocsSub, balance)
	want := "2026-03-01T00:00:00.000Z"
	if got != want {
		t.Fatalf("computeLastActive = %q, want %q", got, want)
	}
}

func TestComputeLastActiveUnknownIsEmpty(t *testing.T) {
	if got := computeLastActive(bson.M{}, nil, nil); got != "" {
		t.Fatalf("missing timestamps must return empty, got %q", got)
	}
}

func TestComputeLastActiveAcceptsTimeValues(t *testing.T) {
	older := time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)

	got := computeLastActive(bson.M{"updated_at": newer}, bson.M{"updated_at": older}, nil)
	want := "2026-04-01T00:00:00.000Z"
	if got != want {
		t.Fatalf("computeLastActive = %q, want %q", got, want)
	}
}

func TestExtractSubscriberMSISDN(t *testing.T) {
	tests := []struct {
		name   string
		xcloud bson.M
		ocs    bson.M
		want   string
	}{
		{
			name:   "msisdnList object",
			xcloud: bson.M{"msisdnList": bson.A{bson.M{"msisdn": "18800000001"}}},
			want:   "18800000001",
		},
		{
			name:   "msisdn array",
			xcloud: bson.M{"msisdn": bson.A{"18800000002"}},
			want:   "18800000002",
		},
		{
			name:   "ocs fallback",
			xcloud: bson.M{},
			ocs:    bson.M{"msisdn": "18800000003"},
			want:   "18800000003",
		},
		{
			name:   "missing",
			xcloud: bson.M{},
			want:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractSubscriberMSISDN(tt.xcloud, tt.ocs); got != tt.want {
				t.Fatalf("extractSubscriberMSISDN = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestMatchesFiltersContractProvisioningAndBalance(t *testing.T) {
	provisioned := SubscriberProvisioning{Contract: true, Balance: true, TariffPlan: true}
	row := SubscriberRow{
		IMSI:           "460000000000001",
		Status:         "Active",
		ContractStatus: "suspended",
		Policy:         "plan_a",
		Provisioning:   provisioned,
		Traffic:        TrafficSnapshot{Balance: testInt64Ptr(0)},
	}

	if !matchesFilters(row, SubscriberListFilters{Status: "active", ContractStatus: "suspended", Provisioning: "complete", PlanID: "plan_a", BalanceStatus: "exhausted"}) {
		t.Fatal("row should match all additive filters")
	}
	if matchesFilters(row, SubscriberListFilters{ContractStatus: "active"}) {
		t.Fatal("contract status mismatch must not match")
	}
	if matchesFilters(row, SubscriberListFilters{Provisioning: "missing_balance"}) {
		t.Fatal("complete provisioning must not match missing_balance")
	}
	if matchesFilters(row, SubscriberListFilters{PlanID: "plan_b"}) {
		t.Fatal("plan mismatch must not match")
	}
	if matchesFilters(row, SubscriberListFilters{BalanceStatus: "available"}) {
		t.Fatal("exhausted balance must not match available")
	}

	lowRow := SubscriberRow{
		IMSI:             "460000000000003",
		Status:           "Active",
		Provisioning:     provisioned,
		Traffic:          TrafficSnapshot{Balance: testInt64Ptr(100)},
		BalanceState:     balanceStateLow,
		BalanceThreshold: 1024,
	}
	if !matchesFilters(lowRow, SubscriberListFilters{BalanceStatus: "low"}) {
		t.Fatal("low balance should match the low filter")
	}
	if matchesFilters(lowRow, SubscriberListFilters{BalanceStatus: "exhausted"}) {
		t.Fatal("low balance must not match exhausted")
	}
	if !matchesFilters(lowRow, SubscriberListFilters{BalanceStatus: "available"}) {
		t.Fatal("legacy available filter should include low balances")
	}

	normalRow := SubscriberRow{
		IMSI:             "460000000000004",
		Status:           "Active",
		Provisioning:     provisioned,
		Traffic:          TrafficSnapshot{Balance: testInt64Ptr(2048)},
		BalanceState:     balanceStateNormal,
		BalanceThreshold: 1024,
	}
	if !matchesFilters(normalRow, SubscriberListFilters{BalanceStatus: "normal"}) {
		t.Fatal("normal balance should match the normal filter")
	}

	unprovisioned := SubscriberRow{IMSI: "460000000000002", Status: "Active"}
	if !matchesFilters(unprovisioned, SubscriberListFilters{Provisioning: "incomplete", ContractStatus: "none", BalanceStatus: "missing"}) {
		t.Fatal("unprovisioned row should match incomplete/none/missing filters")
	}
}

func TestRedactAuthMaterial(t *testing.T) {
	state := &LegacySubscriberState{
		Auth4G: map[string]any{
			"k":   "00112233445566778899aabbccddeeff",
			"opc": "E8ED289DEBA952E4283B54E88E6183CA",
			"amf": "8000",
			"sqn": 0,
		},
	}

	projectAuthMaterial(state, false)
	if _, ok := state.Auth4G["k"]; ok {
		t.Fatal("k must be withheld for read-only roles")
	}
	if _, ok := state.Auth4G["opc"]; ok {
		t.Fatal("opc must be withheld for read-only roles")
	}
	if state.Auth4G["amf"] != "8000" {
		t.Fatal("non-secret AMF must remain")
	}
	if state.Auth4G["sqn"] != 0 {
		t.Fatal("the sequence number is not key material and must remain")
	}
	// Withheld is not the same as absent: the reader is told which is which.
	state4G, ok := state.Auth4G[credential.StateKey].(credential.State)
	if !ok {
		t.Fatalf("expected a credential state, got %T", state.Auth4G[credential.StateKey])
	}
	if state4G.Visibility != credential.VisibilityMasked {
		t.Errorf("visibility: expected masked, got %q", state4G.Visibility)
	}
	if state4G.K != credential.FieldConfigured || state4G.Opc != credential.FieldConfigured {
		t.Errorf("configured keys must be reported as configured: %+v", state4G)
	}
	if state4G.Op != credential.FieldNotConfigured {
		t.Errorf("an absent op must be reported not_configured, got %q", state4G.Op)
	}

	privileged := &LegacySubscriberState{Auth4G: map[string]any{"k": "key", "opc": "opc"}}
	projectAuthMaterial(privileged, true)
	if privileged.Auth4G["k"] != "key" || privileged.Auth4G["opc"] != "opc" {
		t.Fatal("privileged roles must retain authentication material")
	}
	if privileged.Auth4G[credential.StateKey].(credential.State).Visibility != credential.VisibilityPlaintext {
		t.Error("a privileged reader must be told the material is plaintext")
	}

	// A subscriber with no authentication block gains nothing from the projection.
	empty := &LegacySubscriberState{}
	projectAuthMaterial(empty, false)
	if empty.Auth4G != nil {
		t.Error("an absent auth4G block must stay absent")
	}
}

func TestParseSubscriberListFilters(t *testing.T) {
	defaults := parseSubscriberListFilters(url.Values{})
	if defaults.SearchBy != "imsi" || defaults.Status != "all" {
		t.Fatalf("defaults = %+v, want imsi/all", defaults)
	}

	legacy := parseSubscriberListFilters(url.Values{"status": {"lowTraffic"}})
	if legacy.Status != "all" || legacy.BalanceStatus != "exhausted" {
		t.Fatalf("legacy lowTraffic = %+v, want all/exhausted", legacy)
	}

	full := parseSubscriberListFilters(url.Values{
		"searchBy":       {"auto"},
		"status":         {"active"},
		"contractStatus": {"suspended"},
		"provisioning":   {"missing_balance"},
		"balanceStatus":  {"low"},
		"planId":         {"plan_a"},
	})
	if full.SearchBy != "auto" || full.Status != "active" || full.ContractStatus != "suspended" ||
		full.Provisioning != "missing_balance" || full.BalanceStatus != "low" || full.PlanID != "plan_a" {
		t.Fatalf("full filters = %+v", full)
	}

	invalid := parseSubscriberListFilters(url.Values{
		"searchBy":       {"email"},
		"status":         {"unknown"},
		"contractStatus": {"disabled"},
		"provisioning":   {"broken"},
		"balanceStatus":  {"zero"},
	})
	if invalid.SearchBy != "imsi" || invalid.Status != "all" || invalid.ContractStatus != "" ||
		invalid.Provisioning != "" || invalid.BalanceStatus != "" {
		t.Fatalf("invalid filters must be ignored, got %+v", invalid)
	}
}

func TestToSubscriberRowProvisioningSignals(t *testing.T) {
	doc := bson.M{
		"imsi":       "460000000000001",
		"msisdnList": bson.A{bson.M{"msisdn": "18800000001"}},
	}
	ocsSub := bson.M{
		"imsi":    "460000000000001",
		"status":  "active",
		"plan_id": "plan_a",
	}
	balance := bson.M{"imsi": "460000000000001", "data_total": int64(100), "data_available": int64(0)}
	plan := bson.M{"plan_id": "plan_a", "name": "Plan A", "status": "active", "volume_threshold": int64(100)}

	row := toSubscriberRow(doc, ocsSub, balance, plan)
	if row.MSISDN != "18800000001" {
		t.Fatalf("MSISDN = %q, want 18800000001", row.MSISDN)
	}
	if row.ContractStatus != "active" {
		t.Fatalf("ContractStatus = %q, want active", row.ContractStatus)
	}
	if !row.Provisioning.Contract || !row.Provisioning.Balance || !row.Provisioning.TariffPlan {
		t.Fatalf("provisioning flags = %+v, want all true", row.Provisioning)
	}
	if row.BalanceState != balanceStateExhausted || !isLowTraffic(row) {
		t.Fatalf("zero balance state = %q, want exhausted", row.BalanceState)
	}
	if row.BalanceThreshold != 100 {
		t.Fatalf("BalanceThreshold = %d, want 100", row.BalanceThreshold)
	}

	lowBalance := bson.M{"imsi": "460000000000001", "data_total": int64(100), "data_available": int64(50)}
	lowRow := toSubscriberRow(doc, ocsSub, lowBalance, plan)
	if lowRow.BalanceState != balanceStateLow || !isLowBalance(lowRow) {
		t.Fatalf("low balance state = %q, want low", lowRow.BalanceState)
	}
	if isLowTraffic(lowRow) {
		t.Fatal("low balance must not be classified as exhausted")
	}

	orphan := toSubscriberRow(doc, nil, nil, plan)
	if orphan.Provisioning.Contract || orphan.Provisioning.Balance || orphan.Provisioning.TariffPlan {
		t.Fatalf("orphan provisioning flags = %+v, want all false", orphan.Provisioning)
	}
	if isLowTraffic(orphan) {
		t.Fatal("orphan row must not be treated as low traffic")
	}
}

// A row must report the same binding the attribution filter matches, whichever
// field the document records it in. The projection used to read only
// webui_meta.profile_name, so a legacy-bound subscriber looked unbound in the
// list while the template that counted it listed it as linked.
func TestSubscriberRowProjectsEveryBindingField(t *testing.T) {
	cases := []struct {
		field string
		doc   bson.M
		want  string
	}{
		{"webui_meta.profile_name", bson.M{"imsi": "460000000000001", "webui_meta": bson.M{"profile_name": "tpl_a"}}, "tpl_a"},
		{"webui_meta.profile", bson.M{"imsi": "460000000000001", "webui_meta": bson.M{"profile": "tpl_b"}}, "tpl_b"},
		{"profile_name", bson.M{"imsi": "460000000000001", "profile_name": "tpl_c"}, "tpl_c"},
		{"profile", bson.M{"imsi": "460000000000001", "profile": "tpl_d"}, "tpl_d"},
	}
	for _, testCase := range cases {
		row := toSubscriberRow(testCase.doc, nil, nil, nil)
		if row.Profile != testCase.want {
			t.Fatalf("row bound through %s reports Profile=%q, want %q", testCase.field, row.Profile, testCase.want)
		}
	}

	unbound := toSubscriberRow(bson.M{"imsi": "460000000000002"}, nil, nil, nil)
	if unbound.Profile != "" {
		t.Fatalf("an unbound subscriber must report an empty binding, got %q", unbound.Profile)
	}
}

func TestParseSubscriberListFiltersProfile(t *testing.T) {
	filters := parseSubscriberListFilters(url.Values{
		"profile": {"  tpl_a  "},
		"planId":  {"plan_b"},
	})
	if filters.ProfileFilter != "tpl_a" {
		t.Fatalf("ProfileFilter = %q, want tpl_a", filters.ProfileFilter)
	}
	if filters.PlanID != "plan_b" {
		t.Fatalf("PlanID = %q, want plan_b", filters.PlanID)
	}

	if empty := parseSubscriberListFilters(url.Values{}); empty.ProfileFilter != "" {
		t.Fatalf("default ProfileFilter = %q, want empty", empty.ProfileFilter)
	}
}

func TestProfileNameMatchFilter(t *testing.T) {
	if profileNameMatchFilter("") != nil {
		t.Fatal("empty profile name must leave the query untouched")
	}

	condition := profileNameMatchFilter("tpl_a")
	or, ok := condition["$or"].(bson.A)
	if !ok || len(or) != 4 {
		t.Fatalf("profile match condition = %v, want a 4-branch $or", condition)
	}
	seen := map[string]bool{}
	for _, branch := range or {
		doc, ok := branch.(bson.M)
		if !ok || len(doc) != 1 {
			t.Fatalf("$or branch %v must be a single-field match", branch)
		}
		for key, value := range doc {
			if value != "tpl_a" {
				t.Fatalf("$or branch %q must match the requested name", key)
			}
			seen[key] = true
		}
	}
	for _, key := range []string{"webui_meta.profile_name", "webui_meta.profile", "profile_name", "profile"} {
		if !seen[key] {
			t.Fatalf("profile match condition must cover %q, got %v", key, seen)
		}
	}
}
