package nfhealth

import (
	"errors"
	"strings"
	"testing"
)

var errParse = errors.New("parse failure")

func TestParsePrometheusTextSupportedFamilies(t *testing.T) {
	body := []byte(`# HELP gnb connected radio access nodes
# TYPE gnb gauge
gnb 3
# TYPE amf_session gauge
amf_session 12
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 1048576
`)
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Samples) != 3 {
		t.Fatalf("expected 3 samples, got %d", len(out.Samples))
	}
	byKey := map[string]MetricSample{}
	for _, s := range out.Samples {
		byKey[s.Key] = s
	}
	if byKey["gnb"].Value != 3 {
		t.Fatalf("expected gnb=3, got %+v", byKey["gnb"])
	}
	if byKey["process_resident_memory_bytes"].Unit != "bytes" {
		t.Fatalf("expected bytes unit, got %+v", byKey["process_resident_memory_bytes"])
	}
}

func TestParsePrometheusTextDropsUnregisteredFamilies(t *testing.T) {
	body := []byte("# TYPE unknown_family counter\nunknown_family 1\ngnb 2\n")
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Dropped != 1 {
		t.Fatalf("expected 1 dropped family, got %d", out.Dropped)
	}
	if len(out.Samples) != 1 || out.Samples[0].Key != "gnb" {
		t.Fatalf("expected only gnb sample, got %+v", out.Samples)
	}
}

func TestParsePrometheusTextRejectsNaNAndInfinity(t *testing.T) {
	body := []byte("gnb NaN\namf_session +Inf\nran_ue 4\n")
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Malformed < 2 {
		t.Fatalf("expected NaN/Inf to be malformed, got %d", out.Malformed)
	}
	for _, s := range out.Samples {
		if s.Key == "gnb" || s.Key == "amf_session" {
			t.Fatalf("NaN/Inf samples must not be emitted: %+v", s)
		}
	}
}

func TestParsePrometheusTextDropsSensitiveLabels(t *testing.T) {
	body := []byte(`gnb{imsi="001010000000001",nf="amf"} 2
`)
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Samples) != 1 {
		t.Fatalf("expected one sample, got %d", len(out.Samples))
	}
	labels := out.Samples[0].Labels
	if labels == nil {
		t.Fatalf("expected safe labels to survive")
	}
	if _, ok := labels["imsi"]; ok {
		t.Fatalf("sensitive label must be dropped: %+v", labels)
	}
	if labels["nf"] != "amf" {
		t.Fatalf("safe label must survive: %+v", labels)
	}
}

func TestParsePrometheusTextDetectsCounterReset(t *testing.T) {
	body := []byte("fivegs_amffunction_rm_reginitreq 5\n")
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", map[string]float64{
		"fivegs_amffunction_rm_reginitreq": 10,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.CounterResets) != 1 {
		t.Fatalf("expected one counter reset, got %+v", out.CounterResets)
	}
}

func TestDetectCounterReset(t *testing.T) {
	if !DetectCounterReset(10, 5) {
		t.Fatal("expected reset when value decreases")
	}
	if DetectCounterReset(5, 10) {
		t.Fatal("expected no reset when value increases")
	}
}

func TestParsePrometheusTextRejectsEmptyBody(t *testing.T) {
	if _, err := ParsePrometheusText(nil, "t", nil); err == nil {
		t.Fatal("expected error for empty body")
	}
}

func TestParsePrometheusTextRejectsOversizedBody(t *testing.T) {
	big := []byte(strings.Repeat("gnb 1\n", MaxResponseBytes))
	if _, err := ParsePrometheusText(big, "t", nil); err == nil {
		t.Fatal("expected error for oversized body")
	}
}

func TestParsePrometheusTextCounterNeverPresentedAsRate(t *testing.T) {
	body := []byte("fivegs_amffunction_rm_reginitreq 42\n")
	out, err := ParsePrometheusText(body, "t", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Samples[0].Type != "counter" {
		t.Fatalf("expected counter type, got %s", out.Samples[0].Type)
	}
	if out.Samples[0].Value != 42 {
		t.Fatalf("counter value must remain an absolute value, got %v", out.Samples[0].Value)
	}
}
