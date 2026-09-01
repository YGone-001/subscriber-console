package tariff

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

// Handler handles tariff plan HTTP requests.
type Handler struct {
	repo    *Repository
	limiter *ratelimit.Limiter
}

// NewHandler creates a new tariff Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// List returns all tariff plans.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.limiter.Enforce(w, r, "tariff-plans:list:"+p.Username, 90, 60) {
		return
	}

	plans, err := h.repo.ListPlans(r.Context())
	if err != nil {
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, map[string]any{"plans": plans})
}

// Get returns a single tariff plan.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.limiter.Enforce(w, r, "tariff-plans:get:"+p.Username, 120, 60) {
		return
	}

	planID := r.PathValue("planId")
	plan, err := h.repo.GetPlan(r.Context(), planID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if plan == nil {
		response.NotFound(w)
		return
	}
	response.JSON(w, http.StatusOK, map[string]any{"plan": plan})
}

// Export exports a tariff plan as JSON with Content-Disposition attachment.
func (h *Handler) Export(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.limiter.Enforce(w, r, "tariff-plans:export:"+p.Username, 30, 60) {
		return
	}

	planID := r.PathValue("planId")
	plan, err := h.repo.GetPlan(r.Context(), planID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if plan == nil {
		response.NotFound(w)
		return
	}

	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	export := ExportResponse{
		Version:         "1.0",
		ExportedAt:      now,
		PlanID:          plan.PlanID,
		Name:            plan.Name,
		Description:     plan.Description,
		Status:          plan.Status,
		QuotaPerGrant:   plan.QuotaPerGrant,
		ValidityTime:    plan.ValidityTime,
		VolumeThreshold: plan.VolumeThreshold,
		Rules:           plan.Rules,
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="tariff-plan-`+plan.PlanID+`.json"`)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(export)
}

// Operations returns operations summary and audit history.
func (h *Handler) Operations(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.limiter.Enforce(w, r, "tariff-plans:operations:"+p.Username, 90, 60) {
		return
	}

	planID := r.PathValue("planId")
	limit := 12
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	result, err := h.repo.GetPlanOperations(r.Context(), planID, limit)
	if err != nil {
		response.InternalError(w)
		return
	}
	if result == nil {
		response.NotFound(w)
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// Rules returns rules for a tariff plan.
func (h *Handler) Rules(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.limiter.Enforce(w, r, "tariff-plans:rules:"+p.Username, 120, 60) {
		return
	}

	planID := r.PathValue("planId")
	result, err := h.repo.GetPlanRules(r.Context(), planID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if result == nil {
		response.NotFound(w)
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// Subscribers returns subscribers for a tariff plan.
func (h *Handler) Subscribers(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.limiter.Enforce(w, r, "tariff-plans:subscribers:"+p.Username, 120, 60) {
		return
	}

	planID := r.PathValue("planId")
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	result, err := h.repo.ListPlanSubscribers(r.Context(), planID, limit)
	if err != nil {
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// Migrate returns a dry-run migration preview.
func (h *Handler) Migrate(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.limiter.Enforce(w, r, "tariff-plans:migrate:"+p.Username, 12, 60) {
		return
	}

	sourcePlanID := r.PathValue("planId")
	targetPlanID := strings.TrimSpace(r.URL.Query().Get("target"))
	if targetPlanID == "" {
		response.Error(w, http.StatusBadRequest, "target query parameter is required", "VALIDATION_ERROR")
		return
	}

	result, err := h.repo.DryRunMigrate(r.Context(), sourcePlanID, targetPlanID)
	if err != nil {
		msg := err.Error()
		code := http.StatusBadRequest
		errCode := "VALIDATION_ERROR"
		switch msg {
		case "SOURCE_PLAN_NOT_FOUND", "TARGET_PLAN_NOT_FOUND":
			code = http.StatusNotFound
			errCode = "NOT_FOUND"
			msg = "Tariff plan not found"
		case "TARIFF_PLAN_MIGRATE_SAME":
			msg = "Cannot migrate a tariff plan to itself"
		case "TARGET_PLAN_DISABLED":
			msg = "Target tariff plan is disabled"
		}
		response.Error(w, code, msg, errCode)
		return
	}
	response.JSON(w, http.StatusOK, result)
}
