package nflogs

import (
	"strings"
	"testing"
)

func TestSanitizeLineMasksSubscriberIdentities(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "imsi",
			in:   "attaching ue imsi=460001234567890 done",
			want: "attaching ue imsi=[imsi] done",
		},
		{
			name: "impi keeps the realm out of the output",
			in:   "auth 460001234567890@ims.example.com accepted",
			want: "auth [impi] accepted",
		},
		{
			name: "msisdn",
			in:   "sms to +8613800138000 queued",
			want: "sms to [msisdn] queued",
		},
		{
			name: "ipv4 keeps the network part",
			in:   "peer 10.20.30.40 connected",
			want: "peer 10.20.*.* connected",
		},
		{
			name: "credentials",
			in:   "login password=hunter2 token: abc123 ok",
			want: "login password=[redacted] token: [redacted] ok",
		},
		{
			name: "ansi colour is removed",
			in:   "\x1b[31mERROR\x1b[0m boom",
			want: "ERROR boom",
		},
		{
			name: "carriage return is removed",
			in:   "line one\r",
			want: "line one",
		},
		{
			name: "tabs survive",
			in:   "key\tvalue",
			want: "key\tvalue",
		},
	}

	for _, tc := range cases {
		if got := SanitizeLine(tc.in); got != tc.want {
			t.Fatalf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}

func TestSanitizeLineTruncatesAtTheByteCeiling(t *testing.T) {
	long := strings.Repeat("a", MaxLineBytes*2)
	got := SanitizeLine(long)
	if len(got) > MaxLineBytes+len(truncatedTag) {
		t.Fatalf("line must stay bounded: %d bytes", len(got))
	}
	if !strings.HasSuffix(got, truncatedTag) {
		t.Fatalf("a truncated line must say so: %q", got[len(got)-20:])
	}
}

func TestSanitizeLineKeepsUtf8Boundaries(t *testing.T) {
	// Three-byte runes: truncating at a byte offset would split one.
	long := strings.Repeat("日", MaxLineBytes)
	got := SanitizeLine(long)
	if !strings.HasSuffix(got, truncatedTag) {
		t.Fatal("expected truncation")
	}
	for _, r := range strings.TrimSuffix(got, truncatedTag) {
		if r == '\uFFFD' {
			t.Fatal("truncation must not split a rune")
		}
	}
}

func TestDetectLevel(t *testing.T) {
	cases := map[string]string{
		"2026-10-19 ERROR failed to connect":  LevelError,
		"[WARN] queue depth high":             LevelWarn,
		"level=debug request dump":            LevelDebug,
		"INFO started":                        LevelInfo,
		"FATAL cannot continue":               LevelError,
		"plain line without a level":          LevelInfo,
		"user reported an error in the field": LevelInfo,
	}
	for line, want := range cases {
		if got := DetectLevel(line); got != want {
			t.Fatalf("%q: got %s want %s", line, got, want)
		}
	}
}

func TestLevelAllowedIsAMinimum(t *testing.T) {
	if !LevelAllowed("", LevelDebug) {
		t.Fatal("an empty filter admits everything")
	}
	if !LevelAllowed(LevelWarn, LevelError) {
		t.Fatal("a minimum of warn admits errors")
	}
	if LevelAllowed(LevelWarn, LevelInfo) {
		t.Fatal("a minimum of warn rejects info")
	}
	if LevelAllowed(LevelError, LevelWarn) {
		t.Fatal("a minimum of error rejects warnings")
	}
}

func TestMatchesKeywordIsLiteral(t *testing.T) {
	if !MatchesKeyword("Timeout", "read timeout after 3s") {
		t.Fatal("matching is case-insensitive")
	}
	// A regular-expression metacharacter must be treated as text, never
	// compiled into a pattern.
	if MatchesKeyword("a.*b", "aXXb") {
		t.Fatal("the keyword is a literal substring")
	}
	if !MatchesKeyword("", "anything") {
		t.Fatal("an empty keyword admits everything")
	}
}
