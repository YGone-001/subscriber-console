package alert

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Test vectors are built from code points so this source file stays pure ASCII.

const (
	cjkCodePoint   = 0x4E2D  // CJK ideograph, 1 UTF-16 code unit, 3 UTF-8 bytes
	emojiCodePoint = 0x1F600 // supplementary plane, 2 UTF-16 code units, 4 UTF-8 bytes
)

func repeatRune(r rune, n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteRune(r)
	}
	return b.String()
}

func utf16Units(s string) int {
	units := 0
	for _, r := range s {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

func assertValidUTF8(t *testing.T, label, s string) {
	t.Helper()
	if !utf8.ValidString(s) {
		t.Errorf("%s: output must remain valid UTF-8, got bytes %x", label, []byte(s))
	}
}

// TestTruncateUTF16_MatchesJavaScriptSlice pins truncateUTF16 to
// String.prototype.slice(0, 80) observable behaviour across the mandatory
// Unicode matrix: ASCII, CJK, emoji/surrogate pairs, mixed runs, the 79 / 80 /
// 81 UTF-16-code-unit boundaries, and a boundary that splits a surrogate pair.
func TestTruncateUTF16_MatchesJavaScriptSlice(t *testing.T) {
	const maxUnits = 80
	replacement := string(rune(0xFFFD))
	emoji := string(rune(emojiCodePoint))

	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "ascii 79 units unchanged",
			in:   repeatRune('a', 79),
			want: repeatRune('a', 79),
		},
		{
			name: "ascii exactly 80 units unchanged",
			in:   repeatRune('a', 80),
			want: repeatRune('a', 80),
		},
		{
			name: "ascii 81 units truncated to 80",
			in:   repeatRune('a', 81),
			want: repeatRune('a', 80),
		},
		{
			name: "cjk 79 units unchanged",
			in:   repeatRune(rune(cjkCodePoint), 79),
			want: repeatRune(rune(cjkCodePoint), 79),
		},
		{
			name: "cjk exactly 80 units unchanged",
			in:   repeatRune(rune(cjkCodePoint), 80),
			want: repeatRune(rune(cjkCodePoint), 80),
		},
		{
			name: "cjk 81 units truncated to 80",
			in:   repeatRune(rune(cjkCodePoint), 81),
			want: repeatRune(rune(cjkCodePoint), 80),
		},
		{
			name: "emoji exactly 80 units unchanged",
			in:   repeatRune(rune(emojiCodePoint), 40),
			want: repeatRune(rune(emojiCodePoint), 40),
		},
		{
			name: "emoji 82 units truncated to 40 emoji",
			in:   repeatRune(rune(emojiCodePoint), 41),
			want: repeatRune(rune(emojiCodePoint), 40),
		},
		{
			name: "mixed ascii+cjk exactly 80 units unchanged",
			in:   repeatRune('a', 40) + repeatRune(rune(cjkCodePoint), 40),
			want: repeatRune('a', 40) + repeatRune(rune(cjkCodePoint), 40),
		},
		{
			name: "mixed ascii+cjk 81 units drops trailing cjk",
			in:   repeatRune('a', 40) + repeatRune(rune(cjkCodePoint), 41),
			want: repeatRune('a', 40) + repeatRune(rune(cjkCodePoint), 40),
		},
		{
			name: "mixed ascii+emoji exactly 80 units unchanged",
			in:   repeatRune('a', 78) + emoji,
			want: repeatRune('a', 78) + emoji,
		},
		{
			name: "mixed ascii+emoji 81 units drops trailing ascii",
			in:   repeatRune('a', 78) + emoji + "b",
			want: repeatRune('a', 78) + emoji,
		},
		{
			name: "surrogate boundary at 80 units keeps whole pair",
			in:   repeatRune('a', 78) + emoji + repeatRune('b', 5),
			want: repeatRune('a', 78) + emoji,
		},
		{
			name: "surrogate pair split at 80 units becomes U+FFFD",
			in:   repeatRune('a', 79) + emoji,
			want: repeatRune('a', 79) + replacement,
		},
		{
			name: "surrogate pair split with trailing text becomes U+FFFD",
			in:   repeatRune('a', 79) + emoji + repeatRune('b', 10),
			want: repeatRune('a', 79) + replacement,
		},
		{
			name: "surrogate pair split by cjk prefix becomes U+FFFD",
			in:   repeatRune(rune(cjkCodePoint), 79) + emoji + "tail",
			want: repeatRune(rune(cjkCodePoint), 79) + replacement,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := truncateUTF16(tc.in, maxUnits)
			if got != tc.want {
				t.Fatalf("truncateUTF16 mismatch\n got units=%d bytes=%x\nwant units=%d bytes=%x",
					utf16Units(got), []byte(got), utf16Units(tc.want), []byte(tc.want))
			}
			assertValidUTF8(t, tc.name, got)

			// The result must never exceed the budget, and must never be shorter
			// than the budget unless the input itself was shorter.
			if utf16Units(got) > maxUnits {
				t.Errorf("result has %d UTF-16 units, want at most %d", utf16Units(got), maxUnits)
			}
			if inUnits := utf16Units(tc.in); inUnits >= maxUnits && utf16Units(got) != maxUnits {
				t.Errorf("input had %d units so result must be exactly %d units, got %d", inUnits, maxUnits, utf16Units(got))
			}
			if inUnits := utf16Units(tc.in); inUnits < maxUnits && got != tc.in {
				t.Errorf("input shorter than budget must be returned unchanged")
			}
		})
	}
}

func TestTruncateUTF16_ZeroBudget(t *testing.T) {
	if got := truncateUTF16("abc", 0); got != "" {
		t.Errorf("maxUnits=0 must yield empty string, got %q", got)
	}
	if got := truncateUTF16("abc", -5); got != "" {
		t.Errorf("negative maxUnits must yield empty string, got %q", got)
	}
	if got := truncateUTF16("", 80); got != "" {
		t.Errorf("empty input must stay empty, got %q", got)
	}
}

// TestCleanText_TruncatesByUTF16NotBytes guards the regression where Go byte
// length was used instead of UTF-16 code units. A CJK string is 3 UTF-8 bytes
// per code unit, so byte truncation would cut mid-character and diverge from Node.
func TestCleanText_TruncatesByUTF16NotBytes(t *testing.T) {
	cjk := repeatRune(rune(cjkCodePoint), 100)
	got := cleanText(cjk)
	if got == nil {
		t.Fatal("expected non-nil result for CJK input")
	}
	if n := utf16Units(*got); n != 80 {
		t.Errorf("expected 80 UTF-16 units, got %d (bytes=%d)", n, len(*got))
	}
	if !utf8.ValidString(*got) {
		t.Errorf("truncated CJK output must be valid UTF-8, got %x", []byte(*got))
	}
	if want := repeatRune(rune(cjkCodePoint), 80); *got != want {
		t.Errorf("expected 80 whole CJK code points, got %x", []byte(*got))
	}

	emoji := repeatRune(rune(emojiCodePoint), 100)
	gotEmoji := cleanText(emoji)
	if gotEmoji == nil {
		t.Fatal("expected non-nil result for emoji input")
	}
	if n := utf16Units(*gotEmoji); n != 80 {
		t.Errorf("expected 80 UTF-16 units for emoji input, got %d", n)
	}
	if want := repeatRune(rune(emojiCodePoint), 40); *gotEmoji != want {
		t.Errorf("expected 40 whole emoji, got %x", []byte(*gotEmoji))
	}
}

// TestCleanText_SurrogateBoundaryStaysValidUTF8 proves the 80th UTF-16 unit
// intersecting a surrogate pair still yields valid UTF-8 with Node-identical
// persisted bytes (U+FFFD).
func TestCleanText_SurrogateBoundaryStaysValidUTF8(t *testing.T) {
	emoji := string(rune(emojiCodePoint))
	input := repeatRune('a', 79) + emoji + "trailing"
	got := cleanText(input)
	if got == nil {
		t.Fatal("expected non-nil result")
	}
	want := repeatRune('a', 79) + string(rune(0xFFFD))
	if *got != want {
		t.Fatalf("surrogate-boundary truncation mismatch\n got bytes=%x\nwant bytes=%x", []byte(*got), []byte(want))
	}
	assertValidUTF8(t, "surrogate-boundary", *got)
	if n := utf16Units(*got); n != 80 {
		t.Errorf("expected 80 UTF-16 units, got %d", n)
	}
}

// TestJSTrimSpace_MatchesStringPrototypeTrim pins the ECMAScript trim set.
// strings.TrimSpace diverges on U+0085 (Go trims, JS does not) and U+FEFF
// (JS trims, Go does not), so the alert domain uses jsTrimSpace instead.
func TestJSTrimSpace_MatchesStringPrototypeTrim(t *testing.T) {
	trimmedRunes := []rune{
		0x0009, 0x000A, 0x000B, 0x000C, 0x000D,
		0x0020, 0x00A0, 0x1680,
		0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
		0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
		0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
	}
	for _, r := range trimmedRunes {
		pad := string(r)
		got := jsTrimSpace(pad + "x" + pad)
		if got != "x" {
			t.Errorf("U+%04X should be trimmed by String.prototype.trim, got %q", r, got)
		}
	}

	untrimmedRunes := []rune{0x0085, 0x200B, 0x180E, 0x0000}
	for _, r := range untrimmedRunes {
		pad := string(r)
		got := jsTrimSpace(pad + "x" + pad)
		if got == "x" {
			t.Errorf("U+%04X must NOT be trimmed by String.prototype.trim", r)
		}
	}

	if got := jsTrimSpace("   \t\r\n"); got != "" {
		t.Errorf("whitespace-only input must trim to empty, got %q", got)
	}
	if got := jsTrimSpace("  hello  "); got != "hello" {
		t.Errorf("expected %q, got %q", "hello", got)
	}
	inner := "keep " + string(rune(cjkCodePoint)) + " inner"
	if got := jsTrimSpace(inner); got != inner {
		t.Errorf("inner content must be preserved, got %q", got)
	}
}

// TestCleanText_JSWhitespaceParity verifies the acknowledge/workflow cleaner
// treats Node-trimmed whitespace as empty and preserves Node-untrimmed padding.
func TestCleanText_JSWhitespaceParity(t *testing.T) {
	if cleanText(string(rune(0xFEFF))+string(rune(0xFEFF))) != nil {
		t.Error("U+FEFF padding must be trimmed to empty like Node")
	}
	if cleanText(string(rune(0x0085))+"x"+string(rune(0x0085))) == nil {
		t.Error("U+0085 is not trimmed by Node, so cleaned value must be preserved")
	}
	got := cleanText(string(rune(0x0085)) + "x" + string(rune(0x0085)))
	if got != nil && *got != string(rune(0x0085))+"x"+string(rune(0x0085)) {
		t.Errorf("U+0085 padding must survive cleaning, got %q", *got)
	}
}
