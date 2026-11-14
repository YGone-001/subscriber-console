package topology

import (
	"context"

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

// ListAllContains returns every active `contains` edge up to maxEdges in one
// bounded indexed read. The returned boolean is true when the bound was
// reached, so a caller never treats the missing tail as absence.
func (r *Repository) ListAllContains(ctx context.Context, maxEdges int) ([]Edge, bool, error) {
	if maxEdges <= 0 || maxEdges > MaxContainmentEdges {
		maxEdges = MaxContainmentEdges
	}
	opts := options.Find().
		SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(maxEdges + 1))
	cursor, err := r.edges.Find(ctx, bson.M{
		"relationshipType": "contains",
		"lifecycleState":   "active",
	}, opts)
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
func (r *Repository) Descendants(ctx context.Context, root string, maxNodes int) ([]string, bool, error) {
	if err := inventory.ValidateResourceID(root); err != nil {
		return nil, false, err
	}
	if maxNodes <= 0 || maxNodes > MaxContainmentNodes {
		maxNodes = MaxContainmentNodes
	}
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
	return order, truncated, nil
}
