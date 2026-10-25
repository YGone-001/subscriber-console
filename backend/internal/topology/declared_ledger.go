package topology

import (
	"context"
	"errors"

	"subscriber/internal/livetopology"
)

// declaredLedgerLimit bounds the reconciliation read. The ledger is small by
// design, but the read stays bounded and reports truncation rather than
// presenting a partial set as the whole truth.
const declaredLedgerLimit = 200

// ErrDeclaredLedgerUnavailable reports that no ledger could be read for
// reconciliation. The runtime projection degrades to omitting the block; it
// never fails because of it.
var ErrDeclaredLedgerUnavailable = errors.New("topology: declared ledger unavailable")

// ledgerLister is the slice of the repository the reconciliation view needs.
type ledgerLister interface {
	List(ctx context.Context, filter ListFilter) ([]Edge, *string, bool, error)
}

// DeclaredLedger exposes the persisted relationship ledger to the read-only
// runtime projection so declarations can be reconciled against configured
// evidence. It is a read adapter only: it cannot create, update or retire an
// edge.
type DeclaredLedger struct {
	repo ledgerLister
}

func NewDeclaredLedger(repo ledgerLister) *DeclaredLedger {
	return &DeclaredLedger{repo: repo}
}

// ListDeclared returns the ledger in one bounded read. complete is false when
// more edges exist than the bound, which caps reconciliation at partial.
func (d *DeclaredLedger) ListDeclared(ctx context.Context) ([]livetopology.DeclaredEdge, bool, error) {
	if d == nil || d.repo == nil {
		return nil, false, ErrDeclaredLedgerUnavailable
	}
	items, _, hasMore, err := d.repo.List(ctx, ListFilter{Limit: declaredLedgerLimit})
	if err != nil {
		return nil, false, err
	}
	edges := make([]livetopology.DeclaredEdge, 0, len(items))
	for _, edge := range items {
		edges = append(edges, livetopology.DeclaredEdge{
			EdgeID:           edge.EdgeID,
			FromResourceID:   edge.FromResourceID,
			ToResourceID:     edge.ToResourceID,
			RelationshipType: edge.RelationshipType,
			LifecycleState:   edge.LifecycleState,
			InterfaceNames:   edge.InterfaceNames,
		})
	}
	return edges, !hasMore, nil
}
