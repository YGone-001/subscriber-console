package knowledge

import (
	"reflect"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestAuditStrings(t *testing.T) {
	tests := []struct {
		name  string
		input any
		want  []string
	}{
		{
			name:  "nil input",
			input: nil,
			want:  nil,
		},
		{
			name:  "nil slice of string",
			input: ([]string)(nil),
			want:  nil,
		},
		{
			name:  "nil slice of any",
			input: ([]any)(nil),
			want:  nil,
		},
		{
			name:  "nil bson.A",
			input: (bson.A)(nil),
			want:  nil,
		},
		{
			name:  "empty slice of string",
			input: []string{},
			want:  []string{},
		},
		{
			name:  "empty slice of any",
			input: []any{},
			want:  []string{},
		},
		{
			name:  "empty bson.A",
			input: bson.A{},
			want:  []string{},
		},
		{
			name:  "valid slice of string",
			input: []string{"a.txt", "b.txt"},
			want:  []string{"a.txt", "b.txt"},
		},
		{
			name:  "valid slice of any",
			input: []any{"a.txt", "b.txt"},
			want:  []string{"a.txt", "b.txt"},
		},
		{
			name:  "valid bson.A from mongo driver decode",
			input: bson.A{"a.txt", "b.txt"},
			want:  []string{"a.txt", "b.txt"},
		},
		{
			name:  "bson.A preserves ordering",
			input: bson.A{"first.log", "second.pcap", "third.json"},
			want:  []string{"first.log", "second.pcap", "third.json"},
		},
		{
			name:  "bson.A with mixed types ignores non-strings",
			input: bson.A{"valid.txt", 12345, true, nil, "another.pdf"},
			want:  []string{"valid.txt", "another.pdf"},
		},
		{
			name:  "slice of any with mixed types",
			input: []any{nil, "only_string.txt", false, 3.14},
			want:  []string{"only_string.txt"},
		},
		{
			name:  "bson.A with no strings returns empty slice",
			input: bson.A{1, 2, 3, true},
			want:  []string{},
		},
		{
			name:  "unsupported string primitive returns nil",
			input: "a.txt",
			want:  nil,
		},
		{
			name:  "unsupported int primitive returns nil",
			input: 42,
			want:  nil,
		},
		{
			name:  "unsupported map returns nil",
			input: map[string]any{"file": "a.txt"},
			want:  nil,
		},
		{
			name:  "unsupported int slice returns nil",
			input: []int{1, 2, 3},
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := auditStrings(tt.input)
			if tt.want == nil {
				if got != nil {
					t.Fatalf("auditStrings(%#v) = %#v; want nil", tt.input, got)
				}
				return
			}
			if got == nil {
				t.Fatalf("auditStrings(%#v) = nil; want %#v", tt.input, tt.want)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("auditStrings(%#v) = %#v; want %#v", tt.input, got, tt.want)
			}
		})
	}
}

func TestAuditStringsDefensiveCopy(t *testing.T) {
	orig := []string{"orig.txt"}
	got := auditStrings(orig)
	got[0] = "mutated.txt"
	if orig[0] != "orig.txt" {
		t.Fatalf("expected defensive copy, but orig was mutated to %q", orig[0])
	}
}

func TestAuditOperationProjection(t *testing.T) {
	doc := bson.M{
		"id":        "audit-123",
		"timestamp": "2026-11-15T00:00:01.000Z",
		"action":    "knowledge.file.attach",
		"actor":     "operator",
		"actorContext": bson.M{
			"role": "operator",
		},
		"result": "success",
		"metadata": bson.M{
			"operation": "attach",
			"files":     bson.A{"a.txt", "b.txt"},
		},
		"oldData": bson.M{
			"revision": int64(1),
			"status":   "published",
		},
		"newData": bson.M{
			"revision": int64(2),
			"status":   "published",
		},
	}

	metadata := auditMap(doc["metadata"])
	files := auditStrings(metadata["files"])
	if len(files) != 2 || files[0] != "a.txt" || files[1] != "b.txt" {
		t.Fatalf("unexpected files projection: %+v", files)
	}
}
