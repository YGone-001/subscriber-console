package imsreg

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"subscriber/internal/inventory"
)

type Service struct {
	catalog   Catalog
	configErr error
	reader    Reader
	groups    GroupResolver
	gate      chan struct{}
	key       [32]byte
	now       func() time.Time
}

func NewService(c Catalog, configErr error, reader Reader, groups GroupResolver) *Service {
	s := &Service{catalog: c, configErr: configErr, reader: reader, groups: groups, gate: make(chan struct{}, 4), now: time.Now}
	if _, err := rand.Read(s.key[:]); err != nil {
		s.configErr = configError()
	}
	return s
}
func (s *Service) Read(ctx context.Context, q Query) (Response, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	out := Response{GeneratedAt: s.now().UTC(), CatalogSources: []SourceLabel{}, ConfigurationState: "ok", Completeness: "complete", ScopeMeaning: "source_organization", Consistency: "eventually_consistent_database_observation", Sources: []SourceStatus{}, Items: []Identity{}, Pagination: Pagination{Limit: q.Limit}}
	if q.Limit < 1 || q.Limit > 200 {
		return out, &ReadError{"invalid_query"}
	}
	if s.configErr != nil {
		out.ConfigurationState = "invalid_config"
		out.Completeness = "unavailable"
		return out, nil
	}
	if len(s.catalog.Sources) == 0 {
		out.ConfigurationState = "not_configured"
		out.Completeness = "unavailable"
		return out, nil
	}
	for _, source := range s.catalog.Sources {
		out.CatalogSources = append(out.CatalogSources, SourceLabel{source.ID, source.Name})
	}
	if q.SourceID != "" {
		found := false
		for _, source := range s.catalog.Sources {
			found = found || source.ID == q.SourceID
		}
		if !found {
			return out, &ReadError{"source_not_found"}
		}
	}
	f := q.Filter
	f.Domain = "ims"
	if s.groups == nil {
		out.Completeness = "unavailable"
		return out, nil
	}
	scope, e := s.groups.ResolveGroupScope(ctx, f)
	if e != nil {
		return out, e
	}
	out.Scope = scope
	last, err := s.after(q, scope.Fingerprint)
	if err != nil {
		return out, err
	}
	scopeComplete := scope.Inventory.Completeness == "complete" && scope.Topology.Completeness == "complete"
	if !scopeComplete {
		out.Completeness = "partial"
		if scope.Inventory.Completeness == "unavailable" || scope.Topology.Completeness == "unavailable" {
			out.Completeness = "unavailable"
		}
	}
	resources := map[string]inventory.Resource{}
	for _, r := range scope.Resources {
		resources[r.ResourceID] = r
	}
	selected := []Source{}
	for _, source := range s.catalog.Sources {
		if q.SourceID != "" && source.ID != q.SourceID {
			continue
		}
		r, ok := resources[source.ResourceID]
		if !ok && q.Filter.HasGroups() && scopeComplete {
			continue
		}
		status := SourceStatus{ID: source.ID, Name: source.Name, ResourceID: source.ResourceID, Authority: source.Authority, Persistence: source.Persistence, Evidence: "database", State: "ok", Completeness: "complete", Freshness: "unknown", IdentityState: "not_configured"}
		if source.HSS != nil {
			status.IdentityState = "not_requested"
		}
		if !ok || r.LifecycleState == inventory.LifecycleRetired || r.Domain != "ims" || (r.Kind != inventory.KindNetworkFunction && r.Kind != inventory.KindNetworkFunctionInstance) {
			status.State = "unavailable"
			status.Reason = "resource_unresolved"
			status.Completeness = "unavailable"
			out.Completeness = "partial"
			out.Sources = append(out.Sources, status)
			continue
		}
		if source.Persistence != "write_back" {
			status.State = "unavailable"
			status.Reason = "persistence_not_current"
			status.Completeness = "unavailable"
			out.Completeness = "partial"
			out.Sources = append(out.Sources, status)
			continue
		}
		selected = append(selected, source)
		out.Sources = append(out.Sources, status)
	}
	statuses := map[string]int{}
	for i := range out.Sources {
		statuses[out.Sources[i].ID] = i
	}
	type fetched struct {
		source      Source
		observation Observation
		err         error
	}
	channel := make(chan fetched, len(selected))
	var wg sync.WaitGroup
	for _, source := range selected {
		wg.Add(1)
		go func(source Source) {
			defer wg.Done()
			select {
			case s.gate <- struct{}{}:
				defer func() { <-s.gate }()
			case <-ctx.Done():
				channel <- fetched{source: source, err: &ReadError{"timeout"}}
				return
			}
			sub, stop := context.WithTimeout(ctx, 2*time.Second)
			defer stop()
			if s.reader == nil {
				channel <- fetched{source: source, err: &ReadError{"database_unavailable"}}
				return
			}
			observation, err := s.reader.Read(sub, source, max(1, MaxRows/max(1, 2*len(selected))))
			channel <- fetched{source, observation, err}
		}(source)
	}
	wg.Wait()
	close(channel)
	all := []Identity{}
	sourceByID := map[string]Source{}
	for entry := range channel {
		at := statuses[entry.source.ID]
		status := &out.Sources[at]
		sourceByID[entry.source.ID] = entry.source
		if entry.err != nil {
			status.State = "unavailable"
			status.Reason = reason(entry.err)
			if status.Reason == "unsupported_schema" {
				status.State = "unsupported_schema"
			}
			status.Completeness = "unavailable"
			out.Completeness = "partial"
			continue
		}
		status.ReadAt = &entry.observation.ReadAt
		status.ObservedIdentities = len(entry.observation.Items)
		if !entry.observation.Complete {
			status.Completeness = "partial"
			status.Reason = entry.observation.Reason
			if status.Reason == "" {
				status.Reason = "row_limit"
			}
			out.Completeness = "partial"
		}
		for _, item := range entry.observation.Items {
			if q.Search != "" && !strings.Contains(strings.ToLower(item.PublicIdentity), strings.ToLower(q.Search)) {
				continue
			}
			if q.State != "" && item.State != q.State {
				continue
			}
			all = append(all, item)
		}
	}
	sort.Slice(out.Sources, func(i, j int) bool { return out.Sources[i].ID < out.Sources[j].ID })
	sort.Slice(all, func(i, j int) bool { return all[i].Key < all[j].Key })
	activeBindings := map[string]bool{}
	readable := false
	for _, source := range out.Sources {
		readable = readable || source.State == "ok"
	}
	if len(out.Sources) > 0 && !readable {
		out.Completeness = "unavailable"
	}
	for _, item := range all {
		out.Observed.PublicIdentities++
		if item.State == "active_binding_observed" {
			out.Observed.ActivePublicIdentities++
		}
		for _, b := range item.Bindings {
			if b.State == "active" {
				activeBindings[item.SourceID+":"+b.Key] = true
			}
		}
	}
	out.Observed.ActiveBindings = len(activeBindings)
	if out.Completeness == "complete" {
		out.Counts = Counts{intPtr(out.Observed.PublicIdentities), intPtr(out.Observed.ActivePublicIdentities), intPtr(out.Observed.ActiveBindings)}
		out.Pagination.Total = intPtr(len(all))
	}
	if q.Summary {
		return out, nil
	}
	start := sort.Search(len(all), func(i int) bool { return all[i].Key > last })
	end := min(start+q.Limit, len(all))
	out.Items = append(out.Items, all[start:end]...)
	if end < len(all) && end > start {
		cursor := s.cursor(q, scope.Fingerprint, all[end-1].Key, s.now().Add(5*time.Minute).Unix())
		out.Pagination.NextCursor = &cursor
		out.Pagination.HasMore = true
	}
	// HSS enrichment is optional and independent from binding coverage. Only the
	// selected page is enriched, with at most one batch per fifty identities.
	for sourceID, source := range sourceByID {
		if source.HSS == nil {
			continue
		}
		indices := []int{}
		items := []Identity{}
		for i, item := range out.Items {
			if item.SourceID == sourceID {
				indices = append(indices, i)
				items = append(items, item)
			}
		}
		if len(items) == 0 {
			continue
		}
		sub, stop := context.WithTimeout(ctx, 2*time.Second)
		state, err := s.reader.Enrich(sub, source, items)
		stop()
		if err != nil {
			state = "unavailable"
		}
		for i, at := range indices {
			if err != nil {
				out.Items[at].IdentityState = "unavailable"
			} else {
				out.Items[at] = items[i]
			}
		}
		for i := range out.Sources {
			if out.Sources[i].ID == sourceID {
				out.Sources[i].IdentityState = state
			}
		}
	}
	projected := 0
	for i := range out.Items {
		remaining := MaxBindings - projected
		if len(out.Items[i].Bindings) > remaining {
			out.Items[i].Bindings = out.Items[i].Bindings[:max(0, remaining)]
			out.Completeness = "partial"
			out.Counts = Counts{}
			out.Pagination.Total = nil
			for j := range out.Sources {
				if out.Sources[j].ID == out.Items[i].SourceID {
					out.Sources[j].Completeness = "partial"
					out.Sources[j].Reason = "binding_limit"
				}
			}
		}
		projected += len(out.Items[i].Bindings)
	}
	return out, nil
}
func reason(err error) string {
	var e *ReadError
	if errors.As(err, &e) {
		return e.Reason
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "timeout"
	}
	return "database_unavailable"
}
func intPtr(n int) *int { return &n }
func (s *Service) contextDigest(q Query, scope string) string {
	q.Cursor = ""
	q.Summary = false
	b, _ := json.Marshal([]any{q, scope, s.catalog, AdapterVersion})
	v := sha256.Sum256(b)
	return hex.EncodeToString(v[:])
}
func (s *Service) cursor(q Query, scope, last string, expires int64) string {
	payload := strconv.FormatInt(expires, 10) + "." + s.contextDigest(q, scope) + "." + hex.EncodeToString([]byte(last))
	mac := hmac.New(sha256.New, s.key[:])
	_, _ = mac.Write([]byte(payload))
	return payload + "." + hex.EncodeToString(mac.Sum(nil))
}
func (s *Service) after(q Query, scope string) (string, error) {
	if q.Cursor == "" {
		return "", nil
	}
	parts := strings.Split(q.Cursor, ".")
	if len(parts) != 4 || len(q.Cursor) > 1024 {
		return "", &ReadError{"invalid_cursor"}
	}
	expires, e := strconv.ParseInt(parts[0], 10, 64)
	last, e2 := hex.DecodeString(parts[2])
	if e != nil || e2 != nil {
		return "", &ReadError{"invalid_cursor"}
	}
	expected := s.cursor(q, scope, string(last), expires)
	if !hmac.Equal([]byte(expected), []byte(q.Cursor)) || expires < s.now().Unix() {
		return "", &ReadError{"cursor_changed"}
	}
	return string(last), nil
}
func (q Query) String() string { return fmt.Sprintf("IMS query (limit=%d)", q.Limit) }
