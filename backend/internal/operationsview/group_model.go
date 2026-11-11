package operationsview

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"subscriber/internal/inventory"
)

const (
	GroupMaxResources = 1000
	GroupMaxEdges     = 5000
	GroupMaxDepth     = 8
	GroupMaxAgents    = 1000
)

type GroupFilter struct {
	NetworkKey     string `json:"networkKey"`
	SiteResourceID string `json:"siteResourceId"`
	HostResourceID string `json:"hostResourceId"`
	OperatorName   string `json:"operatorName"`
	PLMN           string `json:"plmn"`
	Domain         string `json:"domain"`
	IncludeRetired bool   `json:"includeRetired"`
}

func (f GroupFilter) HasGroups() bool {
	return f.NetworkKey != "" || f.SiteResourceID != "" || f.HostResourceID != "" || f.OperatorName != "" || f.PLMN != "" || f.IncludeRetired
}

var groupUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func ParseGroupFilter(v url.Values) (GroupFilter, error) {
	f := GroupFilter{NetworkKey: v.Get("networkKey"), SiteResourceID: v.Get("siteResourceId"), HostResourceID: v.Get("hostResourceId"), OperatorName: strings.TrimSpace(v.Get("operatorName")), PLMN: v.Get("plmn"), Domain: v.Get("domain"), IncludeRetired: v.Get("includeRetired") == "1"}
	for _, k := range []string{"networkKey", "siteResourceId", "hostResourceId", "operatorName", "plmn", "domain", "includeRetired"} {
		if len(v[k]) > 1 {
			return f, fmt.Errorf("duplicate group selector")
		}
	}
	if f.NetworkKey != "" && !inventory.NetworkKeyPattern.MatchString(f.NetworkKey) {
		return f, fmt.Errorf("invalid network key")
	}
	for _, id := range []string{f.SiteResourceID, f.HostResourceID} {
		if id != "" && !groupUUID.MatchString(id) {
			return f, fmt.Errorf("invalid group resource UUID")
		}
	}
	if f.PLMN != "" && !inventory.PLMNPattern.MatchString(f.PLMN) {
		return f, fmt.Errorf("invalid PLMN")
	}
	if !utf8.ValidString(f.OperatorName) || utf8.RuneCountInString(f.OperatorName) > 128 || strings.IndexFunc(f.OperatorName, unicode.IsControl) >= 0 {
		return f, fmt.Errorf("invalid operator name")
	}
	if f.Domain != "" {
		found := false
		for _, d := range inventory.CanonicalDomains {
			found = found || d == f.Domain
		}
		if !found {
			return f, fmt.Errorf("invalid domain")
		}
	}
	if v.Has("includeRetired") && v.Get("includeRetired") != "0" && v.Get("includeRetired") != "1" {
		return f, fmt.Errorf("invalid lifecycle selector")
	}
	return f, nil
}

type GroupQuery struct {
	GroupFilter
	GroupBy  string `json:"groupBy"`
	Section  string `json:"section"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"`
	Q        string `json:"q"`
	Cursor   string `json:"-"`
	Limit    int    `json:"-"`
}

func ParseGroupQuery(v url.Values) (GroupQuery, error) {
	f, e := ParseGroupFilter(v)
	q := GroupQuery{GroupFilter: f, GroupBy: v.Get("groupBy"), Section: v.Get("section"), Kind: v.Get("kind"), Severity: v.Get("severity"), Q: strings.TrimSpace(v.Get("q")), Cursor: v.Get("cursor"), Limit: 50}
	if e != nil {
		return q, e
	}
	for k, values := range v {
		if len(values) != 1 {
			return q, fmt.Errorf("duplicate query parameter")
		}
		switch k {
		case "networkKey", "siteResourceId", "hostResourceId", "operatorName", "plmn", "domain", "includeRetired", "groupBy", "section", "kind", "severity", "q", "cursor", "limit":
		default:
			return q, fmt.Errorf("unsupported query parameter")
		}
	}
	if q.GroupBy == "" {
		q.GroupBy = "site"
	}
	if q.GroupBy != "site" && q.GroupBy != "network" {
		return q, fmt.Errorf("invalid grouping")
	}
	if q.Section == "" {
		q.Section = "resources"
	}
	switch q.Section {
	case "resources", "agents", "alerts", "config", "issues":
	default:
		return q, fmt.Errorf("invalid section")
	}
	if q.Kind != "" {
		ok := false
		for _, k := range inventory.CanonicalKinds {
			ok = ok || q.Kind == k
		}
		if !ok {
			return q, fmt.Errorf("invalid resource kind")
		}
	}
	if q.Severity != "" && q.Severity != "critical" && q.Severity != "warning" && q.Severity != "info" {
		return q, fmt.Errorf("invalid severity")
	}
	if !utf8.ValidString(q.Q) || utf8.RuneCountInString(q.Q) > 128 || strings.IndexFunc(q.Q, unicode.IsControl) >= 0 {
		return q, fmt.Errorf("invalid search")
	}
	if v.Has("limit") {
		q.Limit, e = strconv.Atoi(v.Get("limit"))
		if e != nil || q.Limit < 1 || q.Limit > 200 {
			return q, fmt.Errorf("invalid page limit")
		}
	}
	if len(q.Cursor) > 1024 {
		return q, fmt.Errorf("invalid cursor")
	}
	return q, nil
}

type GroupEntry struct {
	Key  string `json:"key" bson:"_id"`
	Name string `json:"name" bson:"name"`
	Kind string `json:"kind" bson:"kind"`
}
type GroupIssue struct {
	ID         string `json:"id"`
	Code       string `json:"code"`
	ResourceID string `json:"resourceId"`
	AgentID    string `json:"agentId,omitempty"`
	RelatedID  string `json:"relatedId,omitempty"`
}
type GroupCoverage struct {
	Completeness  string `json:"completeness"`
	Reason        string `json:"reason"`
	ObservedCount int    `json:"observedCount"`
}
type GroupScope struct {
	Filter      GroupFilter          `json:"filter"`
	Resources   []inventory.Resource `json:"-"`
	IDs         []string             `json:"-"`
	Issues      []GroupIssue         `json:"-"`
	Inventory   GroupCoverage        `json:"inventory"`
	Topology    GroupCoverage        `json:"topology"`
	Fingerprint string               `json:"fingerprint"`
}
type GroupSummary struct {
	GeneratedAt        time.Time                `json:"generatedAt"`
	Scope              GroupScope               `json:"scope"`
	Counts             map[string]*int          `json:"counts"`
	Sources            map[string]GroupCoverage `json:"sources"`
	Consistency        string                   `json:"consistency"`
	ConfigurationScope string                   `json:"configurationScope"`
	ControllerRole     string                   `json:"controllerRole"`
}
type GroupPage struct {
	GeneratedAt time.Time     `json:"generatedAt"`
	Scope       GroupScope    `json:"scope"`
	Items       []any         `json:"items"`
	Coverage    GroupCoverage `json:"coverage"`
	NextCursor  *string       `json:"nextCursor"`
	HasMore     bool          `json:"hasMore"`
}
type groupRow struct {
	id    string
	value any
}

func groupDigest(v any) string {
	b, _ := json.Marshal(v)
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
func groupCursor(q GroupQuery, fingerprint, last string) string {
	q.Cursor = ""
	q.Limit = 0
	return groupDigest([]any{q, fingerprint}) + "." + hex.EncodeToString([]byte(last))
}
func groupAfter(q GroupQuery, fingerprint string) (string, error) {
	if q.Cursor == "" {
		return "", nil
	}
	parts := strings.Split(q.Cursor, ".")
	if len(parts) != 2 || len(parts[0]) != 64 {
		return "", fmt.Errorf("invalid cursor")
	}
	b, e := hex.DecodeString(parts[1])
	if e != nil || !utf8.Valid(b) {
		return "", fmt.Errorf("invalid cursor")
	}
	if groupCursor(q, fingerprint, string(b)) != q.Cursor {
		return "", fmt.Errorf("scope_changed")
	}
	return string(b), nil
}
