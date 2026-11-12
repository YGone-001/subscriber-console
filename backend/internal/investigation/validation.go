package investigation

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func validID(id string) bool { return uuidPattern.MatchString(id) }
func validText(v string, maxBytes int) bool {
	return utf8.ValidString(v) && len(v) <= maxBytes && !strings.ContainsAny(v, "\x00")
}
func parseWindow(from, to string, now time.Time) (time.Time, time.Time, error) {
	a, e := time.Parse(time.RFC3339Nano, from)
	if e != nil {
		return a, a, fail(400, "INVESTIGATION_INVALID_WINDOW", "A valid from and to time are required")
	}
	b, e := time.Parse(time.RFC3339Nano, to)
	if e != nil || !b.After(a) || b.Sub(a) > 24*time.Hour || b.After(now.Add(time.Minute)) {
		return a, b, fail(400, "INVESTIGATION_INVALID_WINDOW", "The time window must be ordered, at most 24 hours, and not in the future")
	}
	a, b = a.UTC().Truncate(time.Millisecond), b.UTC().Truncate(time.Millisecond)
	if !b.After(a) {
		return a, b, fail(400, "INVESTIGATION_INVALID_WINDOW", "The window must span distinct millisecond instants")
	}
	return a, b, nil
}
func validateUpdate(q *UpdateRequest) error {
	q.Title = strings.TrimSpace(q.Title)
	q.Notes = strings.TrimSpace(q.Notes)
	q.Conclusion = strings.TrimSpace(q.Conclusion)
	if q.ExpectedRevision < 1 || q.Title == "" || !validText(q.Title, 640) || utf8.RuneCountInString(q.Title) > 160 || !validText(q.Notes, 8192) || !validText(q.Conclusion, 4096) {
		return fail(400, "INVESTIGATION_INVALID_RECORD", "Record fields exceed their supported bounds")
	}
	if q.Status != "open" && q.Status != "investigating" && q.Status != "resolved" {
		return fail(400, "INVESTIGATION_INVALID_STATUS", "Unsupported investigation status")
	}
	if q.Status == "resolved" && utf8.RuneCountInString(q.Conclusion) < 3 {
		return fail(400, "INVESTIGATION_CONCLUSION_REQUIRED", "A human conclusion is required to resolve an investigation")
	}
	if len(q.KnowledgeIDs) > MaxKnowledge {
		return fail(400, "INVESTIGATION_INVALID_KNOWLEDGE", "Too many knowledge references")
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, id := range q.KnowledgeIDs {
		if !validID(id) {
			return fail(400, "INVESTIGATION_INVALID_KNOWLEDGE", "Knowledge references must be UUID v4")
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	sort.Strings(ids)
	q.KnowledgeIDs = ids
	return nil
}

type cursorData struct {
	At      time.Time `json:"at"`
	ID      string    `json:"id"`
	Query   string    `json:"query"`
	Expires int64     `json:"expires"`
}

func listFingerprint(q ListQuery) string {
	b, _ := json.Marshal([]string{q.Q, q.Status, q.AlertID, q.ResourceID})
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
func (s *Service) encodeCursor(q ListQuery, v Record) string {
	b, _ := json.Marshal(cursorData{v.UpdatedAt, v.ID, listFingerprint(q), s.now().Add(30 * time.Minute).Unix()})
	m := hmac.New(sha256.New, s.key)
	m.Write(b)
	return hex.EncodeToString(b) + "." + hex.EncodeToString(m.Sum(nil))
}
func (s *Service) decodeCursor(q ListQuery) (*cursorData, error) {
	if q.Cursor == "" {
		return nil, nil
	}
	bad := func() (*cursorData, error) {
		return nil, fail(400, "INVESTIGATION_INVALID_CURSOR", "Cursor is invalid, expired, or belongs to another filter")
	}
	if len(q.Cursor) > 2048 || len(s.key) < 32 {
		return bad()
	}
	parts := strings.Split(q.Cursor, ".")
	if len(parts) != 2 {
		return bad()
	}
	b, e := hex.DecodeString(parts[0])
	if e != nil {
		return bad()
	}
	sig, e := hex.DecodeString(parts[1])
	if e != nil {
		return bad()
	}
	m := hmac.New(sha256.New, s.key)
	m.Write(b)
	if !hmac.Equal(sig, m.Sum(nil)) {
		return bad()
	}
	var v cursorData
	if json.Unmarshal(b, &v) != nil || !validID(v.ID) || v.At.IsZero() || v.Query != listFingerprint(q) || v.Expires < s.now().Unix() || v.Expires > s.now().Add(31*time.Minute).Unix() {
		return bad()
	}
	return &v, nil
}
