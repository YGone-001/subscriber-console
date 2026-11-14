package knowledge

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeListSort(t *testing.T) {
	cases := []struct {
		sort      string
		order     string
		wantSort  string
		wantOrder string
		wantErr   bool
	}{
		{"", "", "updatedAt", "desc", false},
		{"title", "", "title", "asc", false},
		{"protocol", "", "protocol", "asc", false},
		{"createdAt", "", "createdAt", "desc", false},
		{"updatedAt", "asc", "updatedAt", "asc", false},
		{"title", "desc", "title", "desc", false},
		{"bogus", "", "", "", true},
		{"title", "sideways", "", "", true},
	}
	for _, tc := range cases {
		s, o, err := NormalizeListSort(tc.sort, tc.order)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("NormalizeListSort(%q,%q) expected error", tc.sort, tc.order)
			}
			continue
		}
		if err != nil || s != tc.wantSort || o != tc.wantOrder {
			t.Fatalf("NormalizeListSort(%q,%q) = %q,%q,%v; want %q,%q", tc.sort, tc.order, s, o, err, tc.wantSort, tc.wantOrder)
		}
	}
}

func encodeCursor(t *testing.T, c CursorData) string {
	t.Helper()
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal cursor: %v", err)
	}
	return base64.URLEncoding.EncodeToString(b)
}

func TestBuildListFilterRejectsCursorSortMismatch(t *testing.T) {
	cursor := encodeCursor(t, CursorData{Sort: "title", Order: "asc", Value: "abc", ID: validEntryID})
	_, err := buildListFilter(ListFilter{Cursor: cursor, Sort: "updatedAt", Order: "desc"})
	if err == nil || !strings.Contains(err.Error(), "cursor") {
		t.Fatalf("expected cursor sort mismatch error, got %v", err)
	}
}

func TestBuildListFilterAcceptsMatchingCursor(t *testing.T) {
	cursor := encodeCursor(t, CursorData{Sort: "title", Order: "asc", Value: "abc", ID: validEntryID})
	doc, err := buildListFilter(ListFilter{Cursor: cursor, Sort: "title", Order: "asc"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(doc) == 0 {
		t.Fatalf("expected a keyset filter, got empty document")
	}
}

func TestBuildListFilterHonorsLegacyCursor(t *testing.T) {
	cursor := encodeCursor(t, CursorData{UpdatedAt: "2024-01-01T00:00:00Z", ID: validEntryID})
	doc, err := buildListFilter(ListFilter{Cursor: cursor, Sort: "updatedAt", Order: "desc"})
	if err != nil {
		t.Fatalf("legacy cursor must be accepted for default sort: %v", err)
	}
	if len(doc) == 0 {
		t.Fatalf("expected a keyset filter, got empty document")
	}
}

func TestBuildListFilterRejectsLegacyCursorUnderOtherSort(t *testing.T) {
	cursor := encodeCursor(t, CursorData{UpdatedAt: "2024-01-01T00:00:00Z", ID: validEntryID})
	_, err := buildListFilter(ListFilter{Cursor: cursor, Sort: "title", Order: "asc"})
	if err == nil || !strings.Contains(err.Error(), "cursor") {
		t.Fatalf("legacy cursor must not be reusable under a different sort, got %v", err)
	}
}
