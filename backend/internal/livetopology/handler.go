package livetopology

import (
	"context"
	"net/http"

	"subscriber/internal/auth"
	"subscriber/internal/response"
	"subscriber/internal/runtimeinv"
)

type SnapshotProvider interface {
	Snapshot() *runtimeinv.Snapshot
}

// Associator resolves Inventory and NF Health links onto a snapshot. The live
// projection shares this authority with the runtime observations so a node never
// advertises an association the runtime surface denies.
type Associator interface {
	Attach(ctx context.Context, snapshot *runtimeinv.Snapshot) bool
}

type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

type Handler struct {
	provider  SnapshotProvider
	loader    *Loader
	limiter   RateLimiter
	associate Associator
}

func NewHandler(provider SnapshotProvider, manifestPath string, limiter RateLimiter) *Handler {
	return &Handler{
		provider: provider,
		loader:   NewLoader(manifestPath),
		limiter:  limiter,
	}
}

// SetAssociator installs the association authority. Intended for startup wiring;
// without it the projection still serves nodes, just without Inventory links.
func (h *Handler) SetAssociator(associate Associator) { h.associate = associate }

// Live handles GET /api/topology/live.
//
// It is a read-only composition of the current runtime snapshot and the
// operator-owned config manifest. It never writes Inventory, Topology, NF
// Health or Discovery state.
func (h *Handler) Live(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "topology:live:"+p.Username, 120, 60) {
		return
	}
	if len(r.URL.Query()) > 0 {
		response.BadRequest(w, "unsupported query parameter", "UNSUPPORTED_QUERY_PARAMETER")
		return
	}
	if h.provider == nil {
		response.Error(w, http.StatusServiceUnavailable, "Runtime snapshot unavailable", "TOPOLOGY_LIVE_UNAVAILABLE")
		return
	}
	snapshot := h.provider.Snapshot()
	if snapshot == nil {
		response.Error(w, http.StatusServiceUnavailable, "Runtime snapshot unavailable", "TOPOLOGY_LIVE_UNAVAILABLE")
		return
	}
	if h.associate != nil {
		h.associate.Attach(r.Context(), snapshot)
	}
	runtimeIDs := make(map[string]bool, len(snapshot.Components))
	for _, component := range snapshot.Components {
		runtimeIDs[component.ComponentID] = true
	}
	parsed, status := h.loader.Load(runtimeIDs)
	response.JSON(w, http.StatusOK, Build(snapshot, parsed, status))
}
