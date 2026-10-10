package nfhealth

import (
	"errors"
	"math"
	"strconv"
	"strings"
)

// ParseOutcome reports the result of a bounded Prometheus text exposition parse.
type ParseOutcome struct {
	Samples []MetricSample
	// FamiliesSeen records every metric family name encountered, whether or not
	// it is registry-supported. Used only for diagnostics.
	FamiliesSeen map[string]string
	// Dropped counts series that were rejected by the registry or bounds.
	Dropped int
	// Malformed counts lines that could not be parsed.
	Malformed int
	// CounterResets records counter families whose value decreased relative to
	// a previously observed baseline supplied by the caller.
	CounterResets []string
}

// ParsePrometheusText parses a bounded Prometheus text exposition body.
//
// It recognizes HELP/TYPE metadata, sample syntax with optional labels, and
// rejects NaN and infinity. Only registry-supported families are emitted.
// A counter value is never presented as a rate.
func ParsePrometheusText(body []byte, collectedAt string, previous map[string]float64) (*ParseOutcome, error) {
	if len(body) == 0 {
		return nil, errors.New("empty metrics body")
	}
	if len(body) > MaxResponseBytes {
		return nil, errors.New("metrics body exceeds maximum size")
	}

	out := &ParseOutcome{
		Samples:      make([]MetricSample, 0, 32),
		FamiliesSeen: map[string]string{},
	}

	help := map[string]string{}
	types := map[string]string{}

	lines := strings.Split(string(body), "\n")
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			meta := strings.TrimSpace(strings.TrimPrefix(line, "#"))
			fields := strings.Fields(meta)
			if len(fields) >= 3 {
				switch strings.ToLower(fields[0]) {
				case "help":
					help[fields[1]] = strings.Join(fields[2:], " ")
				case "type":
					types[strings.ToLower(fields[1])] = strings.ToLower(fields[2])
				}
			}
			continue
		}

		name, labels, valueText, ok := splitSampleLine(line)
		if !ok {
			out.Malformed++
			continue
		}
		if len(name) > MaxMetricNameLen {
			out.Malformed++
			continue
		}

		value, ok := parseFiniteNumber(valueText)
		if !ok {
			out.Malformed++
			continue
		}

		family := familyName(name)
		out.FamiliesSeen[family] = types[family]
		def, supported := LookupMetric(family)
		if !supported {
			out.Dropped++
			continue
		}

		// Counter reset detection against a caller-supplied baseline.
		if def.Type == "counter" && previous != nil {
			if prev, seen := previous[family]; seen && value < prev {
				out.CounterResets = append(out.CounterResets, family)
			}
		}

		safe := SanitizeLabels(labels)
		if len(safe) == 0 {
			safe = nil
		}

		metricType := def.Type
		if t, ok := types[family]; ok && (t == "counter" || t == "gauge") {
			metricType = t
		}

		out.Samples = append(out.Samples, MetricSample{
			Key:            family,
			Value:          value,
			Unit:           def.Unit,
			Type:           metricType,
			Source:         "metrics_endpoint",
			CollectedAt:    collectedAt,
			Interpretation: def.Interpretation,
			Labels:         safe,
		})
		if len(out.Samples) >= MaxMetricSamples {
			break
		}
	}

	if len(out.Samples) == 0 && len(out.FamiliesSeen) == 0 && out.Malformed == 0 {
		return nil, errors.New("metrics body contained no recognizable series")
	}
	return out, nil
}

// familyName strips the base suffix from a sample name, because only the
// registry-supported family identity is persisted.
func familyName(sampleName string) string {
	return sampleName
}

// splitSampleLine splits `name{labels} value` or `name value`.
func splitSampleLine(line string) (string, map[string]string, string, bool) {
	// Find the last whitespace-separated token as the value.
	idx := strings.LastIndexAny(line, " \t")
	if idx <= 0 {
		return "", nil, "", false
	}
	namePart := strings.TrimSpace(line[:idx])
	valuePart := strings.TrimSpace(line[idx+1:])
	// Drop optional trailing timestamp.
	if sp := strings.IndexAny(valuePart, " \t"); sp > 0 {
		valuePart = valuePart[:sp]
	}
	if namePart == "" || valuePart == "" {
		return "", nil, "", false
	}

	var labels map[string]string
	if brace := strings.IndexByte(namePart, '{'); brace >= 0 {
		if !strings.HasSuffix(namePart, "}") {
			return "", nil, "", false
		}
		labelBody := namePart[brace+1 : len(namePart)-1]
		namePart = namePart[:brace]
		labels = parseLabels(labelBody)
	}
	if namePart == "" {
		return "", nil, "", false
	}
	return namePart, labels, valuePart, true
}

// parseLabels parses a bounded comma-separated label set.
func parseLabels(body string) map[string]string {
	if strings.TrimSpace(body) == "" {
		return nil
	}
	out := map[string]string{}
	parts := splitLabelPairs(body)
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		eq := strings.IndexByte(part, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(part[:eq])
		val := strings.TrimSpace(part[eq+1:])
		val = strings.Trim(val, `"`)
		if key == "" {
			continue
		}
		out[key] = val
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// splitLabelPairs splits on commas that are not inside quotes.
func splitLabelPairs(body string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	for _, r := range body {
		switch r {
		case '"':
			inQuote = !inQuote
			cur.WriteRune(r)
		case ',':
			if inQuote {
				cur.WriteRune(r)
			} else {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// parseFiniteNumber rejects NaN, infinity and malformed numeric values.
func parseFiniteNumber(raw string) (float64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, false
	}
	lower := strings.ToLower(raw)
	if lower == "nan" || lower == "+nan" || lower == "-nan" ||
		lower == "inf" || lower == "+inf" || lower == "-inf" ||
		lower == "infinity" || lower == "+infinity" || lower == "-infinity" {
		return 0, false
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, false
	}
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// DetectCounterReset reports whether a counter family decreased relative to the
// previously observed value. Callers use this when displaying derived rates.
func DetectCounterReset(previous, current float64) bool {
	return current < previous
}
