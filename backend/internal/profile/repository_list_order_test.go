package profile

import (
	"errors"
	"reflect"
	"testing"
)

// The list order is a claim about the templates, so an unrecognised spelling must
// be refused rather than answered with a different ranking.
func TestParseProfileListOrderRefusesUnknownValues(t *testing.T) {
	cases := []struct {
		name      string
		sort      string
		order     string
		wantError bool
	}{
		{"unknown field", "riskScore", "", true},
		{"unknown direction", "name", "sideways", true},
		{"empty direction is accepted", "name", "", false},
		{"whitespace only falls back to the default", "  ", "  ", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseProfileListOrder(tc.sort, tc.order)
			if tc.wantError && err == nil {
				t.Fatalf("expected a refusal for sort=%q order=%q", tc.sort, tc.order)
			}
			if !tc.wantError && err != nil {
				t.Fatalf("unexpected refusal: %v", err)
			}
		})
	}
}

// Absent parameters have to reproduce the order every client has always received:
// name ascending. Anything else would silently change the response.
func TestParseProfileListOrderDefaultsToTheHistoricalOrder(t *testing.T) {
	got, err := parseProfileListOrder("", "")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got != (ProfileListOrder{Field: ProfileSortName, Desc: false}) {
		t.Errorf("default order: %+v", got)
	}
}

// A recency or volume ranking is read highest-first; an explicit direction wins
// over that convention.
func TestParseProfileListOrderPerFieldDefaults(t *testing.T) {
	for _, field := range []string{ProfileSortUpdatedAt, ProfileSortSubscriberCount, ProfileSortSliceCount} {
		got, err := parseProfileListOrder(field, "")
		if err != nil {
			t.Fatalf("parse %s: %v", field, err)
		}
		if !got.Desc {
			t.Errorf("%s must default to descending, got %+v", field, got)
		}
		if asc, err := parseProfileListOrder(field, "asc"); err != nil || asc.Desc {
			t.Errorf("%s with an explicit asc must ascend: %+v err %v", field, asc, err)
		}
	}
	if ascDefault, err := parseProfileListOrder(ProfileSortName, ""); err != nil || ascDefault.Desc {
		t.Errorf("name must default to ascending: %+v err %v", ascDefault, err)
	}
	if descName, err := parseProfileListOrder(ProfileSortName, "desc"); err != nil || !descName.Desc {
		t.Errorf("an explicit desc must reverse the name ranking: %+v", descName)
	}
}

func listRows() []ProfileListItem {
	return []ProfileListItem{
		{Name: "beta", UpdatedAt: "2026-01-02T00:00:00.000Z", SubscriberCount: 5, SliceCount: 1},
		{Name: "alpha", UpdatedAt: nil, SubscriberCount: 5, SliceCount: 3},
		{Name: "delta", UpdatedAt: "2026-01-03T00:00:00.000Z", SubscriberCount: 2, SliceCount: 3},
		{Name: "charlie", UpdatedAt: "2026-01-02T00:00:00.000Z", SubscriberCount: 9, SliceCount: 0},
	}
}

func names(items []ProfileListItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Name)
	}
	return out
}

func TestSortProfileItemsByProjectedFields(t *testing.T) {
	cases := []struct {
		name  string
		order ProfileListOrder
		want  []string
	}{
		{"historical", ProfileListOrder{Field: ProfileSortName}, []string{"alpha", "beta", "charlie", "delta"}},
		{"name descending", ProfileListOrder{Field: ProfileSortName, Desc: true}, []string{"delta", "charlie", "beta", "alpha"}},
		{"most subscribers first, ties by name", ProfileListOrder{Field: ProfileSortSubscriberCount, Desc: true}, []string{"charlie", "alpha", "beta", "delta"}},
		{"fewest subscribers, ties by name", ProfileListOrder{Field: ProfileSortSubscriberCount}, []string{"delta", "alpha", "beta", "charlie"}},
		{"most slices first", ProfileListOrder{Field: ProfileSortSliceCount, Desc: true}, []string{"alpha", "delta", "beta", "charlie"}},
		{"newest first with the undated row last", ProfileListOrder{Field: ProfileSortUpdatedAt, Desc: true}, []string{"delta", "beta", "charlie", "alpha"}},
		{"oldest first keeps the undated row last", ProfileListOrder{Field: ProfileSortUpdatedAt}, []string{"beta", "charlie", "delta", "alpha"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			items := listRows()
			sortProfileItems(items, tc.order)
			if got := names(items); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("order %+v: got %v want %v", tc.order, got, tc.want)
			}
		})
	}
}

// Two identical requests must answer with the same sequence, or the operator reads
// a ranking that moved on its own.
func TestSortProfileItemsIsDeterministic(t *testing.T) {
	first := listRows()
	second := listRows()
	order := ProfileListOrder{Field: ProfileSortSliceCount, Desc: true}
	sortProfileItems(first, order)
	for range 12 {
		again := append([]ProfileListItem(nil), second...)
		sortProfileItems(again, order)
		if !reflect.DeepEqual(names(first), names(again)) {
			t.Fatalf("repeated sorting diverged: %v vs %v", names(first), names(again))
		}
	}
}

/* The page size and the billing facet are closed vocabularies: a typo must not be
 * answered with a differently shaped page. */
func TestParseProfileListLimitAndBilling(t *testing.T) {
	if got, err := parseProfileListLimit(""); err != nil || got != 0 {
		t.Errorf("an absent limit must stay unbounded, got %d err %v", got, err)
	}
	if got, err := parseProfileListLimit("50"); err != nil || got != 50 {
		t.Errorf("limit 50: got %d err %v", got, err)
	}
	for _, bad := range []string{"0", "-3", "201", "ten"} {
		if _, err := parseProfileListLimit(bad); err == nil {
			t.Errorf("limit %q must be refused", bad)
		}
	}
	for _, good := range []string{"", ProfileBillingConfigured, ProfileBillingMissing, ProfileBillingUnlinked} {
		if _, err := parseProfileBillingFilter(good); err != nil {
			t.Errorf("billing %q must be accepted: %v", good, err)
		}
	}
	if _, err := parseProfileBillingFilter("bogus"); err == nil {
		t.Error("an unknown billing facet must be refused")
	}
}

/* A cursor only means something inside the ranking it came from. */
func TestProfileCursorRoundTripsInsideItsRanking(t *testing.T) {
	order := ProfileListOrder{Field: ProfileSortSliceCount, Desc: true}
	cursor := encodeProfileCursor(order, ProfileListItem{Name: "beta", SliceCount: 3})
	if cursor == "" {
		t.Fatal("a cursor must encode")
	}
	decoded, err := decodeProfileCursor(order, cursor)
	if err != nil || decoded.Value != "3" || decoded.Name != "beta" {
		t.Fatalf("decoded %+v err %v", decoded, err)
	}
	if _, err := decodeProfileCursor(ProfileListOrder{Field: ProfileSortName}, cursor); !errors.Is(err, ErrInvalidProfileCursor) {
		t.Errorf("a cursor from another ranking must be refused, got %v", err)
	}
	if _, err := decodeProfileCursor(order, "not-a-cursor"); !errors.Is(err, ErrInvalidProfileCursor) {
		t.Errorf("garbage must be refused, got %v", err)
	}
}

func TestProfileListFacetsMatchTheClientPredicates(t *testing.T) {
	rows := []ProfileListItem{
		{Name: "gold", Title: "Gold 5G", OCSDefaultsConfigured: true, SubscriberCount: 3},
		{Name: "silver", Title: "Silver", OCSDefaultsConfigured: false, SubscriberCount: 0},
	}
	byQuery := filterForTest(rows, ProfileListRequest{Query: "gold"})
	if len(byQuery) != 1 || byQuery[0].Name != "gold" {
		t.Errorf("query must match name or title, got %v", names(byQuery))
	}
	if got := filterForTest(rows, ProfileListRequest{Billing: ProfileBillingConfigured}); len(got) != 1 || got[0].Name != "gold" {
		t.Errorf("configured facet: %v", names(got))
	}
	if got := filterForTest(rows, ProfileListRequest{Billing: ProfileBillingMissing}); len(got) != 1 || got[0].Name != "silver" {
		t.Errorf("missing facet: %v", names(got))
	}
	if got := filterForTest(rows, ProfileListRequest{Billing: ProfileBillingUnlinked}); len(got) != 1 || got[0].Name != "silver" {
		t.Errorf("unlinked facet: %v", names(got))
	}
}

func filterForTest(rows []ProfileListItem, request ProfileListRequest) []ProfileListItem {
	out := make([]ProfileListItem, 0, len(rows))
	for _, row := range rows {
		if matchesProfileRequest(request, row) {
			out = append(out, row)
		}
	}
	return out
}
