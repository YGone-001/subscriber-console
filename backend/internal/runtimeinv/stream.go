/*
 * Runtime snapshot SSE stream.
 *
 * The runtime stream is served by a single sample broadcast: one goroutine
 * re-reads the shared service snapshot on a fixed cadence and fans the frame
 * out to every connected subscriber. A browser connection never starts a scan
 * and never adds sampling work; the scanner stays the one shared local process
 * observer per backend instance.
 *
 * Integrity rules:
 *   - the payload is the same freshness-projected snapshot the observations
 *     endpoint serves, with associations attached;
 *   - a failed association lookup marks every association unresolved instead
 *     of silently dropping them;
 *   - when no snapshot exists yet, the placeholder snapshot is served so the
 *     client renders an honest not-scanned state instead of a fabricated one;
 *   - a stalled subscriber is dropped by its bounded channel rather than
 *     holding the broadcast loop.
 */
package runtimeinv

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"subscriber/internal/auth"
	"subscriber/internal/response"
)

const (
	streamSampleInterval = 5 * time.Second
	streamHeartbeatAt    = 15 * time.Second
	streamSubscriberBuff = 4
)

// SessionRevalidator verifies that an already-connected session stays valid.
type SessionRevalidator interface {
	ValidateSession(ctx context.Context, claims *auth.Claims) (*auth.Principal, error)
}

// streamFrame is one broadcast sample.
type streamFrame struct {
	Timestamp            string    `json:"timestamp"`
	Snapshot             *Snapshot `json:"snapshot"`
	AssociationsComplete bool      `json:"associationsComplete"`
}

// StreamHandler serves GET /api/runtime/stream with a shared sample loop.
type StreamHandler struct {
	service   *Service
	sessions  SessionRevalidator
	inventory InventoryGateway
	targets   TargetGateway

	sampleEvery time.Duration
	heartbeatAt time.Duration
	now         func() time.Time

	mu    sync.Mutex
	last  *streamFrame
	subs  map[chan streamFrame]struct{}
	quit  chan struct{}
	start sync.Once
}

// NewStreamHandler constructs the runtime stream handler.
func NewStreamHandler(service *Service, sessions SessionRevalidator, inventory InventoryGateway, targets TargetGateway) *StreamHandler {
	return &StreamHandler{
		service:     service,
		sessions:    sessions,
		inventory:   inventory,
		targets:     targets,
		sampleEvery: streamSampleInterval,
		heartbeatAt: streamHeartbeatAt,
		now:         time.Now,
		subs:        map[chan streamFrame]struct{}{},
		quit:        make(chan struct{}),
	}
}

// Start begins the single shared sample loop. It is idempotent and safe to
// call once during server wiring; the loop stops with the server context.
func (h *StreamHandler) Start(ctx context.Context) {
	h.start.Do(func() {
		go h.broadcastLoop(ctx)
	})
}

// ServeHTTP streams read-only runtime snapshot frames for an authenticated
// session.
func (h *StreamHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		response.Forbidden(w, "Forbidden")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}
	// Long-lived response: clear only this response write deadline and keep
	// the server-wide WriteTimeout for every other route.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	events := make(chan streamFrame, streamSubscriberBuff)
	h.mu.Lock()
	h.subs[events] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.subs, events)
		h.mu.Unlock()
	}()

	writeEvent := func(frame *streamFrame) bool {
		data, err := json.Marshal(frame)
		if err != nil {
			return false
		}
		if _, err := w.Write([]byte("event: snapshot\ndata: " + string(data) + "\n\n")); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	writeComment := func(comment string) bool {
		if _, err := w.Write([]byte(":" + comment + "\n\n")); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Replay the latest known frame so a late subscriber is immediately
	// consistent with everyone else.
	h.mu.Lock()
	last := h.last
	h.mu.Unlock()
	if last != nil {
		if !writeEvent(last) {
			return
		}
	} else if !writeComment("waiting") {
		return
	}

	claims := &auth.Claims{Username: p.Username, Role: p.Role, SV: p.SessionVersion}
	lastHeartbeat := h.now()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-h.quit:
			return
		case frame, ok := <-events:
			if !ok {
				return
			}
			if !writeEvent(&frame) {
				return
			}
		}

		// Revalidate the session only when the heartbeat window has elapsed;
		// snapshot frames themselves keep the connection visibly alive.
		if h.now().Sub(lastHeartbeat) < h.heartbeatAt {
			continue
		}
		lastHeartbeat = h.now()
		if _, err := h.sessions.ValidateSession(r.Context(), claims); err != nil {
			// The reason is intentionally not exposed to the client.
			_, _ = w.Write([]byte("event: session_expired\ndata: {}\n\n"))
			flusher.Flush()
			return
		}
		if !writeComment("ping") {
			return
		}
	}
}

// broadcastLoop samples the shared snapshot once per interval and fans the
// frame out to every subscriber.
func (h *StreamHandler) broadcastLoop(ctx context.Context) {
	ticker := time.NewTicker(h.sampleEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			close(h.quit)
			return
		case <-ticker.C:
		}
		frame := h.sample()
		if frame == nil {
			continue
		}
		h.mu.Lock()
		h.last = frame
		subs := make([]chan streamFrame, 0, len(h.subs))
		for ch := range h.subs {
			subs = append(subs, ch)
		}
		h.mu.Unlock()
		for _, ch := range subs {
			select {
			case ch <- *frame:
			default:
				// A full subscriber queue means a stalled client; drop this
				// frame for it. The replayed latest frame on reconnect keeps
				// the client eventually consistent.
			}
		}
	}
}

// sample builds one broadcast frame from the shared snapshot.
func (h *StreamHandler) sample() *streamFrame {
	snapshot := h.service.Snapshot()
	if snapshot == nil {
		return nil
	}
	snapshot = cloneSnapshotForStream(snapshot)
	complete := h.attachAssociations(context.Background(), snapshot)
	return &streamFrame{
		Timestamp:            h.now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Snapshot:             snapshot,
		AssociationsComplete: complete,
	}
}

// attachAssociations fills Inventory and NF Health associations with two
// bounded batch lookups. A failed lookup marks every association unresolved.
// This mirrors the observations projection so the stream and the polled
// endpoint never disagree.
func (h *StreamHandler) attachAssociations(ctx context.Context, snapshot *Snapshot) bool {
	if h.inventory == nil || h.targets == nil {
		markUnresolved(snapshot)
		return false
	}
	keys := make([]string, 0, len(snapshot.Components))
	for _, observation := range snapshot.Components {
		keys = append(keys, RuntimeKey(snapshot.Host.HostID, observation.ComponentID, observation.ProcessName))
	}
	discovered, err := h.inventory.FindDiscovered(ctx, SourceSystem, keys)
	if err != nil {
		markUnresolved(snapshot)
		return false
	}
	resourceIDs := make([]string, 0, len(discovered))
	for _, resource := range discovered {
		resourceIDs = append(resourceIDs, resource.ResourceID)
	}
	targets := map[string]string{}
	if len(resourceIDs) > 0 {
		found, terr := h.targets.FindByResources(ctx, resourceIDs)
		if terr != nil {
			markUnresolved(snapshot)
			return false
		}
		targets = found
	}
	for index := range snapshot.Components {
		observation := &snapshot.Components[index]
		key := RuntimeKey(snapshot.Host.HostID, observation.ComponentID, observation.ProcessName)
		if resource, ok := discovered[key]; ok {
			observation.InventoryAssociation = AssociationProjection{State: AssociationAssociated, ID: resource.ResourceID}
			if targetID, ok := targets[resource.ResourceID]; ok {
				observation.NFHealthAssociation = AssociationProjection{State: AssociationAssociated, ID: targetID}
			} else {
				observation.NFHealthAssociation = AssociationProjection{State: AssociationAbsent}
			}
			continue
		}
		observation.InventoryAssociation = AssociationProjection{State: AssociationAbsent}
		observation.NFHealthAssociation = AssociationProjection{State: AssociationAbsent}
	}
	return true
}

// cloneSnapshotForStream copies the shallow projection so association writes
// never mutate the cached snapshot shared with the observations endpoint.
func cloneSnapshotForStream(snapshot *Snapshot) *Snapshot {
	out := *snapshot
	out.Components = make([]Observation, len(snapshot.Components))
	copy(out.Components, snapshot.Components)
	return &out
}
