package topology

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/inventory"
)

// Containment traversal bounds. These are deliberately larger than one UI page
// but still small enough to keep a request bounded; a reached bound is reported
// as partial, never as absence.
const (
	MaxContainmentEdges = 5000
	MaxContainmentNodes = 5000
)

// descendantsCacheTTL bounds how long a subtree resolution stays fresh. The
// value is short enough that an edge change is visible within seconds and long
// enough that a burst of subtree-root requests cannot trigger a burst of
// full-graph traversals.
const descendantsCacheTTL = 3 * time.Second

// descendantsCacheEntry is one cached subtree resolution.
type descendantsCacheEntry struct {
	ids       []string
	truncated bool
	expiresAt time.Time
}

// invalidateDescendantsCache drops every cached subtree after a write. The
// cache is small and correctness matters more than hit rate, so a single edge
// write clears the whole map rather than trying to identify affected roots.
func (r *Repository) invalidateDescendantsCache() {
	r.descendantsMu.Lock()
	r.descendantsCache = make(map[string]descendantsCacheEntry)
	r.descendantsMu.Unlock()
}

// ListAllContains returns every active `contains` edge up to maxEdges in one
// bounded indexed read. The returned boolean is true when the bound was
// reached, so a caller never treats the missing tail as absence.
func (r *Repository) ListAllContains(ctx context.Context, maxEdges int) ([]Edge, bool, error) {
	return r.listAllActiveEdges(ctx, "contains", maxEdges)
}

// ListAllActiveEdges returns every active edge of any relationship type up to
// maxEdges. The topology canvas shows every declared relationship, so the
// "unlinked resource" count must use the same population the canvas draws;
// counting only `contains` edges would report a resource as unlinked while the
// canvas visibly links it.
func (r *Repository) ListAllActiveEdges(ctx context.Context, maxEdges int) ([]Edge, bool, error) {
	return r.listAllActiveEdges(ctx, "", maxEdges)
}

// listAllActiveEdges performs one bounded indexed read. An empty
// relationshipType means every relationship type.
func (r *Repository) listAllActiveEdges(ctx context.Context, relationshipType string, maxEdges int) ([]Edge, bool, error) {
	if maxEdges <= 0 || maxEdges > MaxContainmentEdges {
		maxEdges = MaxContainmentEdges
	}
	filter := bson.M{"lifecycleState": "active"}
	if relationshipType != "" {
		filter["relationshipType"] = relationshipType
	}
	opts := options.Find().
		SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(maxEdges + 1))
	cursor, err := r.edges.Find(ctx, filter, opts)
	if err != nil {
		return nil, false, err
	}
	defer cursor.Close(ctx)
	var edges []Edge
	if err := cursor.All(ctx, &edges); err != nil {
		return nil, false, err
	}
	truncated := len(edges) > maxEdges
	if truncated {
		edges = edges[:maxEdges]
	}
	return edges, truncated, nil
}

// Descendants returns the root resource and every resource reachable through
// active `contains` edges. The traversal is bounded; truncated is true when the
// bound was reached, so a caller must not treat the missing tail as absent.
// Results are cached for a short TTL so a burst of subtree-root requests does
// not trigger a burst of full-graph traversals.
func (r *Repository) Descendants(ctx context.Context, root string, maxNodes int) ([]string, bool, error) {
	if err := inventory.ValidateResourceID(root); err != nil {
		return nil, false, err
	}
	if maxNodes <= 0 || maxNodes > MaxContainmentNodes {
		maxNodes = MaxContainmentNodes
	}

	cacheKey := root
	r.descendantsMu.RLock()
	if entry, ok := r.descendantsCache[cacheKey]; ok && time.Now().Before(entry.expiresAt) {
		r.descendantsMu.RUnlock()
		ids := make([]string, len(entry.ids))
		copy(ids, entry.ids)
		return ids, entry.truncated, nil
	}
	r.descendantsMu.RUnlock()

	edges, edgesTruncated, err := r.ListAllContains(ctx, MaxContainmentEdges)
	if err != nil {
		return nil, false, err
	}
	children := make(map[string][]string)
	for _, edge := range edges {
		if edge.RelationshipType != "contains" || edge.LifecycleState != "active" {
			continue
		}
		children[edge.FromResourceID] = append(children[edge.FromResourceID], edge.ToResourceID)
	}

	seen := map[string]bool{root: true}
	order := []string{root}
	truncated := edgesTruncated
	for index := 0; index < len(order); index++ {
		parent := order[index]
		for _, child := range children[parent] {
			if child == "" || seen[child] {
				continue
			}
			if len(order) >= maxNodes {
				truncated = true
				break
			}
			seen[child] = true
			order = append(order, child)
		}
		if truncated && len(order) >= maxNodes {
			break
		}
	}

	r.descendantsMu.Lock()
	r.descendantsCache[cacheKey] = descendantsCacheEntry{
		ids:       order,
		truncated: truncated,
		expiresAt: time.Now().Add(descendantsCacheTTL),
	}
	r.descendantsMu.Unlock()

	return order, truncated, nil
}
