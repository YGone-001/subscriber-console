package runtimeinv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// RateLimiter is the shared rate-limiting surface.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// AuditWriter is the bounded best-effort audit surface.
type AuditWriter interface {
	WriteBestEffort(input audit.WriteAuditInput)
}

const maxBodyBytes = 32 << 10

// Handler serves the runtime discovery API surface.
type Handler struct {
	service      *Service
	bootstrapper *Bootstrapper
	limiter      RateLimiter
	auditWriter  AuditWriter
	inventory    InventoryGateway
	targets      TargetGateway
}

// NewHandler constructs the runtime discovery handler.
func NewHandler(service *Service, bootstrapper *Bootstrapper, limiter RateLimiter, auditWriter AuditWriter, inventory InventoryGateway, targets TargetGateway) *Handler {
	return &Handler{
		service:      service,
		bootstrapper: bootstrapper,
		limiter:      limiter,
		auditWriter:  auditWriter,
		inventory:    inventory,
		targets:      targets,
	}
}

func decodeStrictJSON(r io.Reader, maxBytes int64, dst any) error {
	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return fmt.Errorf("failed to read request body: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return errors.New("request body is empty")
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("unexpected trailing content after JSON")
	}
	return nil
}

func (h *Handler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "runtime.denied",
		Module: "runtime",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Request:   &audit.RequestInput{Method: method, Path: path},
		Result:    "denied",
		RiskLevel: "low",
	})
}

func (h *Handler) requireRead(w http.ResponseWriter, r *http.Request, method, path string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	return p
}

func (h *Handler) requireConfigure(w http.ResponseWriter, r *http.Request, method, path string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.configure") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	return p
}

// ComponentMeta is the static registry projection.
type ComponentMeta struct {
	ComponentID      string   `json:"componentId"`
	DisplayName      string   `json:"displayName"`
	ProcessName      string   `json:"processName"`
	MatchMethod      string   `json:"matchMethod"`
	Category         string   `json:"category"`
	Domain           string   `json:"domain"`
	Role             string   `json:"role"`
	NFTType          string   `json:"nfType,omitempty"`
	Templates        []string `json:"templates"`
	CNMSCompatible   bool     `json:"cnmsCompatible"`
	Monitoring       string   `json:"monitoring"`
	MonitoringReason string   `json:"monitoringReason,omitempty"`
}

// MetaResponse is the GET /api/runtime/meta payload.
type MetaResponse struct {
	ProfileID                string          `json:"profileId"`
	ProfileVersion           int             `json:"profileVersion"`
	Templates                []string        `json:"templates"`
	Categories               []string        `json:"categories"`
	Statuses                 []string        `json:"statuses"`
	MatchMethods             []string        `json:"matchMethods"`
	JavaLaunchTokens         []string        `json:"javaLaunchTokens"`
	ScannerEnabled           bool            `json:"scannerEnabled"`
	ScanIntervalSeconds      int             `json:"scanIntervalSeconds"`
	FreshnessSeconds         int             `json:"freshnessSeconds"`
	MinManualIntervalSeconds int             `json:"minManualIntervalSeconds"`
	Host                     HostIdentity    `json:"host"`
	Registry                 Counts          `json:"registry"`
	Components               []ComponentMeta `json:"components"`
	LastScan                 *ScanMetadata   `json:"lastScan,omitempty"`
	BootstrapEnabled         bool            `json:"bootstrapEnabled"`
	MonitoringStates         []string        `json:"monitoringStates"`
}

// Meta handles GET /api/runtime/meta.
func (h *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/runtime/meta")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "runtime:meta:"+p.Username, 120, 60) {
		return
	}
	registry := h.service.Registry()
	components := registry.Components()
	meta := MetaResponse{
		ProfileID:                ProfileCNMSCompat,
		ProfileVersion:           ProfileVersion,
		Templates:                TemplateIDs,
		Categories:               CanonicalCategories,
		Statuses:                 CanonicalStatuses,
		MatchMethods:             []string{MatchExactProcess, MatchJavaCommandLine},
		JavaLaunchTokens:         ApprovedJavaTokens(),
		ScannerEnabled:           h.service.Enabled(),
		ScanIntervalSeconds:      int(h.service.Interval().Seconds()),
		FreshnessSeconds:         h.service.FreshnessSeconds(),
		MinManualIntervalSeconds: h.service.MinManualIntervalSeconds(),
		Host:                     h.service.Host(),
		Registry:                 registry.Counts(),
		Components:               make([]ComponentMeta, 0, len(components)),
		BootstrapEnabled:         h.bootstrapper.Ready(),
		MonitoringStates:         []string{MonitoringSupported, MonitoringNotSupported},
	}
	for _, component := range components {
		meta.Components = append(meta.Components, ComponentMeta{
			ComponentID:      component.ID,
			DisplayName:      component.DisplayName,
			ProcessName:      component.ProcessName,
			MatchMethod:      component.MatchMethod,
			Category:         component.Category,
			Domain:           component.Domain,
			Role:             component.Role,
			NFTType:          component.NFTType,
			Templates:        component.Templates,
			CNMSCompatible:   component.CNMSCompatible,
			Monitoring:       component.Monitoring,
			MonitoringReason: component.MonitoringReason,
		})
	}
	if snapshot := h.service.Snapshot(); snapshot != nil {
		scan := snapshot.Scan
		meta.LastScan = &scan
	}
	response.JSON(w, http.StatusOK, meta)
}

// ObservationsResponse is the GET /api/runtime/observations payload.
type ObservationsResponse struct {
	Snapshot *Snapshot `json:"snapshot"`
	// AssociationsComplete reports whether the Inventory and NF Health
	// association projection was readable. When false, every association is
	// reported as unresolved rather than absent.
	AssociationsComplete bool `json:"associationsComplete"`
}

// Observations handles GET /api/runtime/observations. It serves the cached
// snapshot and never starts a scan.
func (h *Handler) Observations(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/runtime/observations")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "runtime:observations:"+p.Username, 240, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		if param != "template" {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	template := strings.TrimSpace(q.Get("template"))
	if template != "" && !ValidTemplate(template) {
		response.BadRequest(w, "template is not supported", "INVALID_TEMPLATE")
		return
	}

	snapshot := h.service.Snapshot()
	if snapshot == nil {
		response.InternalError(w)
		return
	}
	if template != "" {
		snapshot = filterSnapshot(snapshot, template)
	}
	complete := h.attachAssociations(r.Context(), snapshot)
	response.JSON(w, http.StatusOK, ObservationsResponse{Snapshot: snapshot, AssociationsComplete: complete})
}

// filterSnapshot applies a deployment template view filter. Filtering never
// changes a component's runtime status.
func filterSnapshot(snapshot *Snapshot, template string) *Snapshot {
	out := *snapshot
	out.Components = make([]Observation, 0, len(snapshot.Components))
	for _, observation := range snapshot.Components {
		for _, candidate := range observation.Templates {
			if candidate == template {
				out.Components = append(out.Components, observation)
				break
			}
		}
	}
	out.Counts = countStatuses(out.Components)
	return &out
}

// AttachAssociations fills Inventory and NF Health associations with two bounded
// batch lookups. A failed lookup marks every association unresolved. The runtime
// observations and the live topology projection share it so both report the same
// association authority rather than resolving identities twice by different rules.
func AttachAssociations(ctx context.Context, snapshot *Snapshot, inventory InventoryGateway, health TargetGateway) bool {
	if inventory == nil || health == nil {
		return false
	}
	keys := make([]string, 0, len(snapshot.Components))
	for _, observation := range snapshot.Components {
		keys = append(keys, RuntimeKey(snapshot.Host.HostID, observation.ComponentID, observation.ProcessName))
	}
	discovered, err := inventory.FindDiscovered(ctx, SourceSystem, keys)
	if err != nil {
		markUnresolved(snapshot)
		return false
	}
	resourceIDs := make([]string, 0, len(discovered))
	for _, resource := range discovered {
		resourceIDs = append(resourceIDs, resource.ResourceID)
	}
	targetIDs := map[string]string{}
	if len(resourceIDs) > 0 {
		found, terr := health.FindByResources(ctx, resourceIDs)
		if terr != nil {
			markUnresolved(snapshot)
			return false
		}
		targetIDs = found
	}
	for index := range snapshot.Components {
		observation := &snapshot.Components[index]
		key := RuntimeKey(snapshot.Host.HostID, observation.ComponentID, observation.ProcessName)
		if resource, ok := discovered[key]; ok {
			observation.InventoryAssociation = AssociationProjection{State: AssociationAssociated, ID: resource.ResourceID}
			if targetID, ok := targetIDs[resource.ResourceID]; ok {
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

// attachAssociations resolves the associations through the handler's gateways.
func (h *Handler) attachAssociations(ctx context.Context, snapshot *Snapshot) bool {
	return AttachAssociations(ctx, snapshot, h.inventory, h.targets)
}

// AssociationResolver exposes AttachAssociations as a dependency other read
// projections can hold without importing the Inventory and NF Health gateways.
type AssociationResolver struct {
	Inventory InventoryGateway
	Health    TargetGateway
}

// Attach resolves Inventory and NF Health links onto the given snapshot.
func (a AssociationResolver) Attach(ctx context.Context, snapshot *Snapshot) bool {
	return AttachAssociations(ctx, snapshot, a.Inventory, a.Health)
}

func markUnresolved(snapshot *Snapshot) {
	for index := range snapshot.Components {
		observation := &snapshot.Components[index]
		observation.InventoryAssociation = AssociationProjection{State: AssociationUnresolved}
		observation.NFHealthAssociation = AssociationProjection{State: AssociationUnresolved}
	}
}

// Scan handles POST /api/runtime/scan.
func (h *Handler) Scan(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/runtime/scan")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "runtime:scan:"+p.Username, 6, 60) {
		return
	}
	snapshot, err := h.service.Rescan(r.Context())
	if err != nil {
		switch {
		case errors.Is(err, ErrScannerDisabled):
			response.Error(w, http.StatusConflict, "The runtime scanner is disabled.", "RUNTIME_SCANNER_DISABLED")
		case errors.Is(err, ErrScanInProgress):
			response.Error(w, http.StatusConflict, "A scan is already in progress.", "RUNTIME_SCAN_IN_PROGRESS")
		case errors.Is(err, ErrScanRateLimited):
			w.Header().Set("Retry-After", strconv.Itoa(h.service.MinManualIntervalSeconds()))
			response.Error(w, http.StatusTooManyRequests, "The manual scan interval has not elapsed.", "RUNTIME_SCAN_RATE_LIMITED")
		default:
			response.InternalError(w)
		}
		return
	}
	if h.auditWriter != nil {
		h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
			Action: "runtime.scan",
			Module: "runtime",
			Actor: audit.ActorInput{
				Type:     "user",
				Username: p.Username,
				Role:     p.Role,
			},
			Result:    "success",
			RiskLevel: "low",
			Metadata: map[string]any{
				"scanId":   snapshot.Scan.ScanID,
				"status":   snapshot.Scan.Status,
				"complete": snapshot.Scan.Complete,
			},
		})
	}
	complete := h.attachAssociations(r.Context(), snapshot)
	response.JSON(w, http.StatusOK, ObservationsResponse{Snapshot: snapshot, AssociationsComplete: complete})
}

// PreviewRequest is the body for POST /api/runtime/bootstrap/preview.
type PreviewRequest struct {
	Template     string   `json:"template"`
	ComponentIDs []string `json:"componentIds,omitempty"`
}

// ApplyRequest is the body for POST /api/runtime/bootstrap/apply.
type ApplyRequest struct {
	PlanID       string   `json:"planId"`
	Template     string   `json:"template"`
	ComponentIDs []string `json:"componentIds,omitempty"`
	Approve      bool     `json:"approve"`
}

// Preview handles POST /api/runtime/bootstrap/preview.
func (h *Handler) Preview(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/runtime/bootstrap/preview")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "runtime:bootstrap:preview:"+p.Username, 30, 60) {
		return
	}
	var req PreviewRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST")
		return
	}
	plan, err := h.bootstrapper.Plan(r.Context(), req.Template, req.ComponentIDs)
	if err != nil {
		writeBootstrapError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, plan)
}

// Apply handles POST /api/runtime/bootstrap/apply.
func (h *Handler) Apply(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/runtime/bootstrap/apply")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "runtime:bootstrap:apply:"+p.Username, 10, 60) {
		return
	}
	var req ApplyRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST")
		return
	}
	if !req.Approve {
		response.BadRequest(w, "approve must be true to apply a bootstrap plan", "APPROVAL_REQUIRED")
		return
	}
	result, err := h.bootstrapper.Apply(r.Context(), req.PlanID, req.Template, req.ComponentIDs, p.Username)
	if err != nil {
		writeBootstrapError(w, err)
		return
	}
	if h.auditWriter != nil {
		entries := make([]map[string]any, 0, len(result.Entries))
		for _, entry := range result.Entries {
			entries = append(entries, map[string]any{
				"componentId": entry.ComponentID,
				"action":      entry.Action,
				"resourceId":  entry.ResourceID,
				"targetId":    entry.TargetID,
			})
		}
		h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
			Action: "runtime.bootstrap.apply",
			Module: "runtime",
			Actor: audit.ActorInput{
				Type:     "user",
				Username: p.Username,
				Role:     p.Role,
			},
			Result:    "success",
			RiskLevel: "medium",
			Metadata: map[string]any{
				"planId":  result.PlanID,
				"hostId":  result.HostID,
				"counts":  result.Counts,
				"entries": entries,
			},
		})
	}
	response.JSON(w, http.StatusOK, result)
}

func writeBootstrapError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrBootstrapUnavailable):
		response.Error(w, http.StatusServiceUnavailable, "Runtime bootstrap is not available.", "RUNTIME_BOOTSTRAP_UNAVAILABLE")
	case errors.Is(err, ErrStalePreview):
		response.Error(w, http.StatusConflict,
			"The approved plan no longer matches the current runtime identity. Preview again.",
			"RUNTIME_BOOTSTRAP_STALE_PREVIEW")
	default:
		response.BadRequest(w, err.Error(), "INVALID_BOOTSTRAP_REQUEST")
	}
}
