package opsreports

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type ReportRepository interface {
	Generate(context.Context, Query, string) *Report
}
type Service struct {
	repo         ReportRepository
	configMeta   func() map[string]any
	configCounts func(context.Context, string) (*map[string]int, error)
}

func NewService(repo ReportRepository, configMeta func() map[string]any) *Service {
	return &Service{repo: repo, configMeta: configMeta}
}
func (s *Service) SetConfigCounts(f func(context.Context, string) (*map[string]int, error)) {
	s.configCounts = f
}
func (s *Service) Generate(ctx context.Context, q Query, section string) *Report {
	r := s.repo.Generate(ctx, q, section)
	if (section == "" || section == "config") && s.configMeta != nil && s.configMeta()["catalogState"] != "configured" && len(r.ConfigRows) == 0 {
		r.Config = Section{Completeness: "unavailable", Scope: "requested_window", Reason: "config_sources_not_configured"}
	}
	if (section == "" || section == "config") && r.Config.Completeness != "unavailable" {
		if data, ok := r.Config.Data.(map[string]any); ok {
			data["currentNoBaseline"] = nil
			if q.Domain == "" && q.Severity == "" && s.configCounts != nil {
				counts, e := s.configCounts(ctx, q.ResourceID)
				if e == nil && counts != nil {
					data["currentNoBaseline"] = (*counts)["currentNoBaseline"]
				}
			}
		}
	}
	return r
}
func (s *Service) Page(ctx context.Context, q Query, section string) (*Page, error) {
	r := s.Generate(ctx, q, section)
	rows, status := r.AlertRows, r.Alerts
	if section == "metrics" {
		rows, status = r.MetricRows, r.Metrics
	}
	if status.Completeness == "unavailable" {
		return nil, fmt.Errorf("report source is unavailable")
	}
	if r.RowsLimited[section] {
		return nil, fmt.Errorf("report row budget exceeded; narrow the filters")
	}
	p := &Page{GeneratedAt: r.GeneratedAt, Query: q, Items: []map[string]any{}, Completeness: status.Completeness, Reason: status.Reason}
	for _, row := range rows {
		if fmt.Sprint(row["rowId"]) <= q.Cursor {
			continue
		}
		p.Items = append(p.Items, row)
		if len(p.Items) > q.Limit {
			p.Items = p.Items[:q.Limit]
			p.HasMore = true
			c := fmt.Sprint(p.Items[len(p.Items)-1]["rowId"])
			p.NextCursor = &c
			break
		}
	}
	return p, nil
}
func safeCSV(value any) string {
	if value == nil {
		return ""
	}
	var text string
	formulaCandidate := false
	switch v := value.(type) {
	case string:
		text = v
		formulaCandidate = true
	case time.Time:
		text = v.UTC().Format(time.RFC3339Nano)
	case bson.DateTime:
		text = v.Time().UTC().Format(time.RFC3339Nano)
	default:
		b, e := json.Marshal(v)
		if e != nil {
			return ""
		}
		text = string(b)
	}
	trimmed := strings.TrimLeftFunc(text, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	if formulaCandidate && trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + text
	}
	return text
}
func (s *Service) Export(ctx context.Context, q Query, section string) ([]byte, error) {
	if section != "alerts" && section != "metrics" && section != "config" {
		return nil, fmt.Errorf("unsupported export section")
	}
	r := s.Generate(ctx, q, section)
	rows, status := r.AlertRows, r.Alerts
	columns := []string{"ruleName", "resourceId", "targetId", "targetName", "severity", "state", "firstTriggeredAt", "acknowledgedAt", "resolvedAt", "resolvedReason"}
	if section == "metrics" {
		rows, status = r.MetricRows, r.Metrics
		columns = []string{"resourceId", "targetId", "key", "type", "unit", "category", "label_nf", "label_nftype", "label_nf_type", "label_function", "label_instance", "sampleCount", "first", "lastAt", "last", "min", "max", "mean"}
	}
	if section == "config" {
		rows, status = r.ConfigRows, r.Config
		columns = []string{"sourceId", "resourceId", "collectedAt", "status", "reason", "changed", "snapshotId"}
	}
	if status.Completeness == "unavailable" {
		return nil, fmt.Errorf("report source is unavailable")
	}
	if r.RowsLimited[section] || len(rows) > 10000 {
		return nil, fmt.Errorf("export row budget exceeded; narrow the filters")
	}
	var b bytes.Buffer
	b.Write([]byte{0xef, 0xbb, 0xbf})
	w := csv.NewWriter(&b)
	metadata := []string{"generatedAt", "from", "to", "timezone", "completeness", "sourceScope", "coverageReason", "filterResourceId", "filterDomain", "filterSeverity"}
	header := append(append([]string{}, metadata...), columns...)
	_ = w.Write(header)
	metadataValues := func(reason string) []string {
		return []string{safeCSV(r.GeneratedAt), safeCSV(q.From), safeCSV(q.To), "UTC", status.Completeness, status.Scope, reason, safeCSV(q.ResourceID), safeCSV(q.Domain), safeCSV(q.Severity)}
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		record := metadataValues(status.Reason)
		for _, key := range columns {
			record = append(record, safeCSV(row[key]))
		}
		if e := w.Write(record); e != nil {
			return nil, e
		}
		w.Flush()
		if w.Error() != nil {
			return nil, w.Error()
		}
		if b.Len() > 10<<20 {
			return nil, fmt.Errorf("export byte budget exceeded; narrow the filters")
		}
	}
	// An empty successful section still carries query metadata, not a fake sample.
	if len(rows) == 0 {
		record := make([]string, len(header))
		copy(record, metadataValues("no_matching_records"))
		_ = w.Write(record)
	}
	w.Flush()
	return b.Bytes(), w.Error()
}
