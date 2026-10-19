package nflogs

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// sourceIDPattern is the only shape a client may reference. Anything else is
// rejected before a lookup happens.
var sourceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// entry is one resolved source. Path and Unit never leave the process.
type entry struct {
	ID          string
	Name        string
	Kind        string
	Path        string
	Unit        string
	ResourceIDs []string
}

// Registry is the fixed id -> source table.
//
// The table is built from operator configuration, rescanned on every listing so
// a newly rotated file appears and a deleted one turns unreadable, and never
// accepts a path or a unit name from a request. A declared source wins over a
// scanned file with the same id; scanning only fills the gaps.
type Registry struct {
	dir      string
	mu       sync.RWMutex
	entries  map[string]entry
	explicit map[string]string
	units    map[string]string
	bindings map[string][]string
	journal  UnitReader
}

// NewRegistry builds the source table.
//
//	dir       directory scanned for regular *.log files (may be empty)
//	explicit  comma-separated "sourceId=/absolute/path" pairs
//	units     comma-separated "sourceId=systemd-unit" pairs
//	bindings  comma-separated "sourceId=resourceId|resourceId" mappings
func NewRegistry(dir, explicit, units, bindings string) (*Registry, error) {
	registry := &Registry{
		dir:      strings.TrimSpace(dir),
		entries:  map[string]entry{},
		explicit: map[string]string{},
		units:    map[string]string{},
		bindings: map[string][]string{},
		journal:  newJournalctlReader(),
	}

	for _, pair := range splitList(explicit) {
		id, path, ok := strings.Cut(pair, "=")
		id = strings.TrimSpace(id)
		path = strings.TrimSpace(path)
		if !ok || !sourceIDPattern.MatchString(id) || !filepath.IsAbs(path) {
			return nil, fmt.Errorf("invalid log source %q: want sourceId=/absolute/path", pair)
		}
		if _, exists := registry.explicit[id]; exists {
			return nil, fmt.Errorf("duplicate log source id %q", id)
		}
		registry.explicit[id] = path
	}

	for _, pair := range splitList(units) {
		id, unit, ok := strings.Cut(pair, "=")
		id = strings.TrimSpace(id)
		unit = strings.TrimSpace(unit)
		if !ok || !sourceIDPattern.MatchString(id) || !unitNamePattern.MatchString(unit) {
			return nil, fmt.Errorf("invalid unit log source %q: want sourceId=unit-name", pair)
		}
		if _, exists := registry.explicit[id]; exists {
			return nil, fmt.Errorf("duplicate log source id %q", id)
		}
		if _, exists := registry.units[id]; exists {
			return nil, fmt.Errorf("duplicate log source id %q", id)
		}
		registry.units[id] = unit
	}

	for _, pair := range splitList(bindings) {
		id, list, ok := strings.Cut(pair, "=")
		id = strings.TrimSpace(id)
		if !ok || !sourceIDPattern.MatchString(id) {
			return nil, fmt.Errorf("invalid log source binding %q: want sourceId=resourceId|resourceId", pair)
		}
		for _, resourceID := range strings.Split(list, "|") {
			resourceID = strings.TrimSpace(resourceID)
			if resourceID == "" {
				continue
			}
			registry.bindings[id] = append(registry.bindings[id], resourceID)
		}
		if len(registry.bindings[id]) > 16 {
			return nil, fmt.Errorf("log source %q binds more than 16 resources", id)
		}
	}

	registry.Refresh()
	if len(registry.entries) > MaxSources {
		return nil, fmt.Errorf("log sources exceed the maximum of %d", MaxSources)
	}
	return registry, nil
}

// Refresh rebuilds the table from the configured directory and explicit pairs.
func (r *Registry) Refresh() {
	entries := map[string]entry{}

	if r.dir != "" {
		if dirEntries, err := os.ReadDir(r.dir); err == nil {
			for _, dirEntry := range dirEntries {
				name := dirEntry.Name()
				if dirEntry.IsDir() || !strings.HasSuffix(name, ".log") || strings.HasPrefix(name, ".") {
					continue
				}
				id := strings.TrimSuffix(name, ".log")
				if !sourceIDPattern.MatchString(id) {
					continue
				}
				path := filepath.Join(r.dir, name)
				info, err := os.Lstat(path)
				if err != nil || !info.Mode().IsRegular() {
					// Symlinks and special files are outside the boundary: a
					// link could point anywhere the process can read.
					continue
				}
				entries[id] = entry{ID: id, Name: name, Kind: SourceKindFile, Path: path}
			}
		}
	}

	// Declared sources win over scanned files: an operator who names an id
	// means that source, even when a file with the same base name exists.
	for id, path := range r.explicit {
		entries[id] = entry{ID: id, Name: filepath.Base(path), Kind: SourceKindFile, Path: path}
	}
	for id, unit := range r.units {
		entries[id] = entry{ID: id, Name: unit, Kind: SourceKindUnit, Unit: unit}
	}

	for id := range entries {
		if bound := r.bindings[id]; len(bound) > 0 {
			item := entries[id]
			item.ResourceIDs = append([]string(nil), bound...)
			entries[id] = item
		}
	}

	r.mu.Lock()
	r.entries = entries
	r.mu.Unlock()
}

// List refreshes and returns the current sources, sorted by name.
func (r *Registry) List() []Source {
	r.Refresh()
	r.mu.RLock()
	defer r.mu.RUnlock()

	sources := make([]Source, 0, len(r.entries))
	for _, item := range r.entries {
		sources = append(sources, r.describe(item))
	}
	sort.Slice(sources, func(i, j int) bool {
		if sources[i].Name == sources[j].Name {
			return sources[i].SourceID < sources[j].SourceID
		}
		return sources[i].Name < sources[j].Name
	})
	return sources
}

// Resolve maps a client-supplied id onto the fixed table. The returned path is
// never serialized.
func (r *Registry) Resolve(sourceID string) (entry, bool) {
	if !sourceIDPattern.MatchString(sourceID) {
		return entry{}, false
	}
	r.mu.RLock()
	item, ok := r.entries[sourceID]
	r.mu.RUnlock()
	if ok {
		return item, true
	}
	// A file may have appeared since the last listing; rescan once.
	r.Refresh()
	r.mu.RLock()
	defer r.mu.RUnlock()
	item, ok = r.entries[sourceID]
	return item, ok
}

// SourcesForResource returns the sources an operator explicitly bound to one
// Inventory resource. No name-based inference happens here.
func (r *Registry) SourcesForResource(resourceID string) []Source {
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil
	}
	r.Refresh()
	r.mu.RLock()
	defer r.mu.RUnlock()
	var matched []Source
	for _, item := range r.entries {
		for _, bound := range item.ResourceIDs {
			if bound == resourceID {
				matched = append(matched, r.describe(item))
				break
			}
		}
	}
	sort.Slice(matched, func(i, j int) bool { return matched[i].Name < matched[j].Name })
	return matched
}

func (r *Registry) describe(item entry) Source {
	source := Source{
		SourceID:    item.ID,
		Name:        item.Name,
		Kind:        item.Kind,
		Readable:    false,
		ResourceIDs: item.ResourceIDs,
	}
	if item.Kind == SourceKindUnit {
		if ok, note := r.journal.Available(); ok {
			source.Readable = true
		} else {
			source.Note = note
		}
		return source
	}
	info, err := os.Stat(item.Path)
	if err != nil {
		source.Note = "file is not readable"
		return source
	}
	if !info.Mode().IsRegular() {
		source.Note = "not a regular file"
		return source
	}
	source.SizeBytes = info.Size()
	source.UpdatedAt = info.ModTime().UTC().Format(time.RFC3339)
	source.Readable = true
	return source
}

func splitList(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
