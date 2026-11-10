// Package opsreports projects bounded operational evidence without writes.
package opsreports

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

type Query struct {
	From       time.Time `json:"from"`
	To         time.Time `json:"to"`
	ResourceID string    `json:"resourceId"`
	Domain     string    `json:"domain"`
	Severity   string    `json:"severity"`
	Cursor     string    `json:"-"`
	Limit      int       `json:"-"`
}
type Section struct {
	Completeness string `json:"completeness"`
	Scope        string `json:"scope"`
	Reason       string `json:"reason"`
	Data         any    `json:"data"`
}
type Report struct {
	GeneratedAt time.Time        `json:"generatedAt"`
	Query       Query            `json:"query"`
	Consistency string           `json:"consistency"`
	Alerts      Section          `json:"alerts"`
	Metrics     Section          `json:"metrics"`
	Config      Section          `json:"config"`
	Agents      Section          `json:"agents"`
	AlertRows   []map[string]any `json:"-"`
	MetricRows  []map[string]any `json:"-"`
	ConfigRows  []map[string]any `json:"-"`
	RowsLimited map[string]bool  `json:"-"`
}
type Page struct {
	GeneratedAt  time.Time        `json:"generatedAt"`
	Query        Query            `json:"query"`
	Items        []map[string]any `json:"items"`
	NextCursor   *string          `json:"nextCursor"`
	HasMore      bool             `json:"hasMore"`
	Completeness string           `json:"completeness"`
	Reason       string           `json:"reason"`
}

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var cursorPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func ParseQuery(values url.Values, now time.Time) (Query, error) {
	q := Query{To: now.UTC().Truncate(time.Second), Limit: 50}
	for k, v := range values {
		if len(v) != 1 {
			return q, fmt.Errorf("duplicate query parameter")
		}
		switch k {
		case "from", "to", "period", "resourceId", "domain", "severity", "cursor", "limit", "section":
		default:
			return q, fmt.Errorf("unsupported query parameter")
		}
	}
	var e error
	if values.Has("to") {
		q.To, e = time.Parse(time.RFC3339, values.Get("to"))
		if e != nil {
			return q, fmt.Errorf("invalid UTC window")
		}
	}
	q.From = q.To.Add(-24 * time.Hour)
	if values.Has("period") {
		if values.Has("from") || values.Has("to") {
			return q, fmt.Errorf("relative and absolute windows are mutually exclusive")
		}
		switch values.Get("period") {
		case "1h":
			q.From = q.To.Add(-time.Hour)
		case "24h":
		case "7d":
			q.From = q.To.Add(-7 * 24 * time.Hour)
		default:
			return q, fmt.Errorf("unsupported relative window")
		}
	}
	if values.Has("from") {
		q.From, e = time.Parse(time.RFC3339, values.Get("from"))
		if e != nil {
			return q, fmt.Errorf("invalid UTC window")
		}
	}
	q.From = q.From.UTC()
	q.To = q.To.UTC()
	if !q.From.Before(q.To) || q.To.Sub(q.From) > 7*24*time.Hour || q.To.After(now.Add(time.Second)) {
		return q, fmt.Errorf("window must be positive, no more than seven days, and not in the future")
	}
	q.ResourceID = values.Get("resourceId")
	q.Domain = values.Get("domain")
	q.Severity = values.Get("severity")
	q.Cursor = values.Get("cursor")
	if (q.ResourceID != "" && !uuid.MatchString(q.ResourceID)) || (q.Domain != "" && q.Domain != "epc" && q.Domain != "5gc" && q.Domain != "ims" && q.Domain != "charging") || (q.Severity != "" && q.Severity != "critical" && q.Severity != "warning" && q.Severity != "info") || (q.Cursor != "" && !cursorPattern.MatchString(q.Cursor)) {
		return q, fmt.Errorf("invalid filter")
	}
	if values.Has("limit") {
		q.Limit, e = strconv.Atoi(values.Get("limit"))
		if e != nil || q.Limit < 1 || q.Limit > 200 {
			return q, fmt.Errorf("invalid page limit")
		}
	}
	return q, nil
}
func rowID(value string) string { s := sha256.Sum256([]byte(value)); return hex.EncodeToString(s[:]) }
