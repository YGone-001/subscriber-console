package ueinfo

import "testing"

func TestParseSources(t *testing.T) {
	sources, err := ParseSources("mme=127.0.0.2:9090,amf=127.0.0.5:9090,smf=127.0.0.4:9090")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sources.MME != "127.0.0.2:9090" || sources.AMF != "127.0.0.5:9090" || sources.SMF != "127.0.0.4:9090" {
		t.Fatalf("unexpected sources: %+v", sources)
	}
	if !sources.Configured() {
		t.Fatal("configured sources must report true")
	}
}

func TestParseSourcesEmpty(t *testing.T) {
	sources, err := ParseSources("  ")
	if err != nil {
		t.Fatalf("empty configuration must be valid: %v", err)
	}
	if sources.Configured() {
		t.Fatal("empty configuration must not be configured")
	}
}

func TestParseSourcesRejectsInvalidEntries(t *testing.T) {
	cases := []string{
		"mme",
		"mme=127.0.0.2",
		"mme=http://127.0.0.2:9090",
		"mme=127.0.0.2:9090/path",
		"mme=127.0.0.2:0",
		"mme=127.0.0.2:99999",
		"mme=127.0.0.2:9090,mme=127.0.0.3:9090",
		"unknown=127.0.0.2:9090",
		"mme=127.0.0.2:9090,",
	}
	for _, input := range cases {
		if _, err := ParseSources(input); err == nil {
			t.Fatalf("expected rejection for %q", input)
		}
	}
}
