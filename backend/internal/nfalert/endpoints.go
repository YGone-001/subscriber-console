package nfalert

import (
	"errors"
	"net/http"
	"strings"

	"subscriber/internal/response"
)

// MetaResponse is the GET /api/nf-alerts/meta payload.
type MetaResponse struct {
	SchemaVersion          int      `json:"schemaVersion"`
	AlertStates            []string `json:"alertStates"`
	Severities             []string `json:"severities"`
	ConditionTypes         []string `json:"conditionTypes"`
	ConditionScopes        []string `json:"conditionScopes"`
	StateConditionValues   []string `json:"stateConditionValues"`
	ResolveReasons         []string `json:"resolveReasons"`
	MinCooldownSeconds     int      `json:"minCooldownSeconds"`
	MaxCooldownSeconds     int      `json:"maxCooldownSeconds"`
	DefaultCooldownSeconds int      `json:"defaultCooldownSeconds"`
	RunStatuses            []string `json:"runStatuses"`
}

// Meta handles GET /api/nf-alerts/meta.
func (h *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-alerts/meta")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:meta:"+p.Username, 120, 60) {
		return
	}
	response.JSON(w, http.StatusOK, MetaResponse{
		SchemaVersion:          SchemaVersion,
		AlertStates:            CanonicalAlertStates,
		Severities:             CanonicalSeverities,
		ConditionTypes:         CanonicalConditionTypes,
		ConditionScopes:        CanonicalConditionScopes,
		StateConditionValues:   CanonicalStateConditionValues,
		ResolveReasons:         CanonicalResolveReasons,
		MinCooldownSeconds:     MinCooldownSeconds,
		MaxCooldownSeconds:     MaxCooldownSeconds,
		DefaultCooldownSeconds: DefaultCooldownSeconds,
		RunStatuses:            []string{"success", "partial", "failed"},
	})
}

// ListRulesResponse is the GET /api/nf-alerts/rules payload.
type ListRulesResponse struct {
	Rules []AlertRule `json:"rules"`
	Page  PageInfo    `json:"page"`
}

// ListRules handles GET /api/nf-alerts/rules.
func (h *Handler) ListRules(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-alerts/rules")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:rules:list:"+p.Username, 120, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		if param != "q" && param != "limit" && param != "cursor" && param != "enabled" {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	enabled := strings.TrimSpace(q.Get("enabled"))
	if enabled != "" && enabled != "true" && enabled != "false" {
		response.BadRequest(w, "enabled must be true or false", "INVALID_QUERY_PARAMETER")
		return
	}
	cursor, err := decodeCursor(q.Get("cursor"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	// The keyset cursor is authoritative: a client-supplied limit change
	// across pages would break the sort key contract, so cursor and limit
	// cannot be combined.
	if cursor.At != "" && q.Get("limit") != "" {
		response.BadRequest(w, "cursor cannot be combined with limit", "UNSUPPORTED_QUERY_COMBINATION")
		return
	}
	if cursor.At != "" {
		limit = DefaultPageLimit
	}

	rules, next, hasMore, err := h.repo.ListRules(r.Context(), RuleListFilter{
		Query:   strings.TrimSpace(q.Get("q")),
		Enabled: enabled,
		Limit:   limit,
		Cursor:  strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		writeValidation(w, err)
		return
	}
	if rules == nil {
		rules = []AlertRule{}
	}
	response.JSON(w, http.StatusOK, ListRulesResponse{
		Rules: rules,
		Page: PageInfo{
			Limit:      limit,
			NextCursor: next,
			HasMore:    hasMore,
		},
	})
}

// CreateRule handles POST /api/nf-alerts/rules.
func (h *Handler) CreateRule(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-alerts/rules")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:rules:create:"+p.Username, 20, 60) {
		return
	}
	var req CreateRuleRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST_BODY")
		return
	}
	req.TargetID = strings.TrimSpace(req.TargetID)
	req.ResourceID = strings.TrimSpace(req.ResourceID)
	if err := ValidateTargetScope(req.TargetID, req.ResourceID); err != nil {
		writeValidation(w, err)
		return
	}
	if err := ValidateRuleFields(req.Name, req.ConditionType, req.Condition, req.Severity, req.CooldownSeconds); err != nil {
		writeValidation(w, err)
		return
	}
	rule, err := h.repo.CreateRule(r.Context(), &req, p.Username)
	if err != nil {
		writeValidation(w, err)
		return
	}
	h.auditWrite(p, "nf_alert.rule.created", "nf_alert_rule", rule.RuleID, map[string]any{
		"name":          rule.Name,
		"conditionType": rule.ConditionType,
		"severity":      rule.Severity,
	})
	response.JSON(w, http.StatusCreated, rule)
}

// GetRule handles GET /api/nf-alerts/rules/{ruleId}.
func (h *Handler) GetRule(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-alerts/rules/{ruleId}")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:rules:get:"+p.Username, 120, 60) {
		return
	}
	ruleID := r.PathValue("ruleId")
	if err := ValidateUUID(ruleID); err != nil {
		writeValidation(w, err)
		return
	}
	rule, err := h.repo.GetRule(r.Context(), ruleID)
	if err != nil {
		writeRuleNotFound(w, err)
		return
	}
	response.JSON(w, http.StatusOK, rule)
}

// UpdateRule handles PUT /api/nf-alerts/rules/{ruleId}.
func (h *Handler) UpdateRule(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "PUT", "/api/nf-alerts/rules/{ruleId}")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:rules:update:"+p.Username, 30, 60) {
		return
	}
	ruleID := r.PathValue("ruleId")
	if err := ValidateUUID(ruleID); err != nil {
		writeValidation(w, err)
		return
	}
	var req UpdateRuleRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST_BODY")
		return
	}
	if err := ValidateRuleFields(req.Rule.Name, req.Rule.ConditionType, req.Rule.Condition, req.Rule.Severity, req.Rule.CooldownSeconds); err != nil {
		writeValidation(w, err)
		return
	}
	before, after, err := h.repo.UpdateRule(r.Context(), ruleID, &req, p.Username)
	if err != nil {
		if err == ErrNotFound {
			writeRuleNotFound(w, err)
			return
		}
		writeValidation(w, err)
		return
	}
	h.auditWrite(p, "nf_alert.rule.updated", "nf_alert_rule", ruleID, map[string]any{
		"name":          after.Name,
		"conditionType": after.ConditionType,
		"severity":      after.Severity,
		"revision":      after.Revision,
	})
	_ = before
	response.JSON(w, http.StatusOK, after)
}

// DeleteRule handles DELETE /api/nf-alerts/rules/{ruleId}.
func (h *Handler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "DELETE", "/api/nf-alerts/rules/{ruleId}")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:rules:delete:"+p.Username, 20, 60) {
		return
	}
	ruleID := r.PathValue("ruleId")
	if err := ValidateUUID(ruleID); err != nil {
		writeValidation(w, err)
		return
	}
	rule, resolved, err := h.repo.DeleteRule(r.Context(), ruleID, p.Username)
	if err != nil {
		writeRuleNotFound(w, err)
		return
	}
	h.auditWrite(p, "nf_alert.rule.deleted", "nf_alert_rule", ruleID, map[string]any{
		"name":           rule.Name,
		"resolvedAlerts": len(resolved),
	})
	response.JSON(w, http.StatusOK, map[string]any{
		"deleted":        true,
		"ruleId":         ruleID,
		"resolvedAlerts": len(resolved),
	})
}

// ListAlertsResponse is the GET /api/nf-alerts payload.
type ListAlertsResponse struct {
	Alerts []Alert  `json:"alerts"`
	Page   PageInfo `json:"page"`
}

// ListAlerts handles GET /api/nf-alerts.
func (h *Handler) ListAlerts(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-alerts")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:list:"+p.Username, 120, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		switch param {
		case "state", "scope", "severity", "assignedTo", "sort", "q", "limit", "cursor", "alertId":
		default:
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	if q.Has("alertId") {
		if len(q) != 1 || len(q["alertId"]) != 1 {
			response.BadRequest(w, "alertId cannot be combined with list filters", "UNSUPPORTED_QUERY_COMBINATION")
			return
		}
		if err := ValidateUUID(q.Get("alertId")); err != nil {
			writeValidation(w, err)
			return
		}
		alert, err := h.repo.GetAlert(r.Context(), q.Get("alertId"))
		if err != nil {
			writeAlertNotFound(w, err)
			return
		}
		response.JSON(w, http.StatusOK, ListAlertsResponse{Alerts: []Alert{*alert}, Page: PageInfo{Limit: 1}})
		return
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	state := strings.TrimSpace(q.Get("state"))
	scope := strings.TrimSpace(q.Get("scope"))
	severity := strings.TrimSpace(q.Get("severity"))
	assignedTo := strings.TrimSpace(q.Get("assignedTo"))
	sortOrder := strings.TrimSpace(q.Get("sort"))
	if err := ValidateAlertStateFilter(state); err != nil {
		writeValidation(w, err)
		return
	}
	if err := ValidateAlertSeverityFilter(severity); err != nil {
		writeValidation(w, err)
		return
	}
	if err := ValidateAlertAssigneeFilter(assignedTo); err != nil {
		writeValidation(w, err)
		return
	}
	if scope != "" && scope != AlertScopeOpen && scope != AlertScopeHistory {
		response.BadRequest(w, "scope must be open or history", "INVALID_QUERY_PARAMETER")
		return
	}
	// "open, but only resolved" is a contradiction, not a filter.
	if scope != "" && state != "" {
		response.BadRequest(w, "scope cannot be combined with state", "UNSUPPORTED_QUERY_COMBINATION")
		return
	}
	if sortOrder == "" {
		sortOrder = AlertSortUpdated
	}
	if sortOrder != AlertSortUpdated && sortOrder != AlertSortRisk {
		response.BadRequest(w, "sort must be updated or risk", "INVALID_QUERY_PARAMETER")
		return
	}
	cursor, err := decodeCursor(q.Get("cursor"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	if cursor.At != "" && q.Get("limit") != "" {
		response.BadRequest(w, "cursor cannot be combined with limit", "UNSUPPORTED_QUERY_COMBINATION")
		return
	}
	if cursor.At != "" {
		limit = DefaultPageLimit
	}

	alerts, next, hasMore, err := h.repo.ListAlerts(r.Context(), AlertListFilter{
		State:      state,
		Scope:      scope,
		Severity:   severity,
		AssignedTo: assignedTo,
		Sort:       sortOrder,
		Query:      strings.TrimSpace(q.Get("q")),
		Limit:      limit,
		Cursor:     strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		writeValidation(w, err)
		return
	}
	if alerts == nil {
		alerts = []Alert{}
	}
	response.JSON(w, http.StatusOK, ListAlertsResponse{
		Alerts: alerts,
		Page: PageInfo{
			Limit:      limit,
			NextCursor: next,
			HasMore:    hasMore,
		},
	})
}

// AcknowledgeAlert handles POST /api/nf-alerts/{alertId}/acknowledge.
func (h *Handler) AcknowledgeAlert(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-alerts/{alertId}/acknowledge")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:acknowledge:"+p.Username, 30, 60) {
		return
	}
	alertID := r.PathValue("alertId")
	if err := ValidateUUID(alertID); err != nil {
		writeValidation(w, err)
		return
	}
	alert, err := h.repo.AcknowledgeAlert(r.Context(), alertID, p.Username)
	if err != nil {
		writeAlertNotFound(w, err)
		return
	}
	h.auditWrite(p, "nf_alert.alert.acknowledged", "nf_alert_instance", alertID, map[string]any{
		"ruleId": alert.RuleID,
		"state":  alert.State,
	})
	response.JSON(w, http.StatusOK, alert)
}

// BulkAlertRequest is the bounded body for bulk acknowledge/assign. The
// reason is required so a bulk action cannot silently drop its audit context.
type BulkAlertRequest struct {
	AlertIDs   []string `json:"alertIds"`
	AssignedTo string   `json:"assignedTo,omitempty"`
	Reason     string   `json:"reason"`
}

// BulkAlertResult reports the outcome for one requested alert id.
type BulkAlertResult struct {
	AlertID string `json:"alertId"`
	OK      bool   `json:"ok"`
	State   string `json:"state,omitempty"`
	Error   string `json:"error,omitempty"`
}

// BulkAlertResponse is the per-item outcome of a bulk action.
type BulkAlertResponse struct {
	Results   []BulkAlertResult `json:"results"`
	Succeeded int               `json:"succeeded"`
	Failed    int               `json:"failed"`
}

const (
	bulkMaxAlerts = 50
	bulkMinReason = 3
	bulkMaxReason = 500
)

func normalizeBulkAlertIDs(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return nil, validationError("NF_ALERT_INVALID_BULK_REQUEST", "alertIds must contain at least one alert id")
	}
	if len(raw) > bulkMaxAlerts {
		return nil, validationError("NF_ALERT_INVALID_BULK_REQUEST", "alertIds accepts at most 50 identifiers")
	}
	seen := make(map[string]bool, len(raw))
	ids := make([]string, 0, len(raw))
	for _, value := range raw {
		id := strings.TrimSpace(value)
		if err := ValidateUUID(id); err != nil {
			return nil, err
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, nil
}

func bulkErrorCode(err error) string {
	if errors.Is(err, ErrAlertResolved) {
		return "NF_ALERT_INSTANCE_RESOLVED"
	}
	if errors.Is(err, ErrAlertNotFound) {
		return "NF_ALERT_INSTANCE_NOT_FOUND"
	}
	if errors.Is(err, ErrAlertTransition) {
		return "NF_ALERT_INVALID_TRANSITION"
	}
	var validation *ErrValidation
	if errors.As(err, &validation) {
		return validation.Code
	}
	return "NF_ALERT_INTERNAL"
}

func (h *Handler) BulkAcknowledge(w http.ResponseWriter, r *http.Request) {
	h.bulkAlertAction(w, r, false)
}

func (h *Handler) BulkAssign(w http.ResponseWriter, r *http.Request) {
	h.bulkAlertAction(w, r, true)
}

func (h *Handler) bulkAlertAction(w http.ResponseWriter, r *http.Request, assign bool) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-alerts/bulk")
	if p == nil {
		return
	}
	action := "acknowledge"
	auditAction := "nf_alert.bulk.acknowledged"
	if assign {
		action = "assign"
		auditAction = "nf_alert.bulk.assigned"
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:bulk:"+action+":"+p.Username, 20, 60) {
		return
	}
	var req BulkAlertRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST_BODY")
		return
	}
	ids, err := normalizeBulkAlertIDs(req.AlertIDs)
	if err != nil {
		writeValidation(w, err)
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if len([]rune(reason)) < bulkMinReason || len([]rune(reason)) > bulkMaxReason {
		response.BadRequest(w, "reason must be between 3 and 500 characters", "NF_ALERT_INVALID_BULK_REASON")
		return
	}
	if assign {
		req.AssignedTo = strings.TrimSpace(req.AssignedTo)
		if req.AssignedTo == "" || len([]rune(req.AssignedTo)) > 120 {
			response.BadRequest(w, "assignedTo must be a non-empty value of at most 120 characters", "NF_ALERT_INVALID_ASSIGNEE")
			return
		}
	}

	results := make([]BulkAlertResult, 0, len(ids))
	succeeded := 0
	for _, id := range ids {
		var alert *Alert
		var actErr error
		if assign {
			alert, actErr = h.repo.AssignAlert(r.Context(), id, req.AssignedTo)
		} else {
			alert, actErr = h.repo.AcknowledgeAlert(r.Context(), id, p.Username)
		}
		if actErr != nil {
			results = append(results, BulkAlertResult{AlertID: id, OK: false, Error: bulkErrorCode(actErr)})
			continue
		}
		succeeded++
		results = append(results, BulkAlertResult{AlertID: id, OK: true, State: alert.State})
	}
	h.auditWrite(p, auditAction, "nf_alert_bulk", "bulk", map[string]any{
		"alertIds":   ids,
		"reason":     reason,
		"assignedTo": req.AssignedTo,
		"count":      len(ids),
		"succeeded":  succeeded,
	})
	response.JSON(w, http.StatusOK, BulkAlertResponse{
		Results:   results,
		Succeeded: succeeded,
		Failed:    len(ids) - succeeded,
	})
}

// AssignAlert handles POST /api/nf-alerts/{alertId}/assign.
func (h *Handler) AssignAlert(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-alerts/{alertId}/assign")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:assign:"+p.Username, 30, 60) {
		return
	}
	alertID := r.PathValue("alertId")
	if err := ValidateUUID(alertID); err != nil {
		writeValidation(w, err)
		return
	}
	var req struct {
		AssignedTo string `json:"assignedTo"`
	}
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST_BODY")
		return
	}
	req.AssignedTo = strings.TrimSpace(req.AssignedTo)
	if req.AssignedTo == "" || len(req.AssignedTo) > 120 {
		response.BadRequest(w, "assignedTo must be a non-empty value of at most 120 characters", "NF_ALERT_INVALID_ASSIGNEE")
		return
	}
	alert, err := h.repo.AssignAlert(r.Context(), alertID, req.AssignedTo)
	if err != nil {
		writeAlertNotFound(w, err)
		return
	}
	h.auditWrite(p, "nf_alert.alert.assigned", "nf_alert_instance", alertID, map[string]any{
		"ruleId":     alert.RuleID,
		"assignedTo": alert.AssignedTo,
		"state":      alert.State,
	})
	response.JSON(w, http.StatusOK, alert)
}

// RecoverAlert handles POST /api/nf-alerts/{alertId}/recover.
func (h *Handler) RecoverAlert(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-alerts/{alertId}/recover")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:recover:"+p.Username, 30, 60) {
		return
	}
	alertID := r.PathValue("alertId")
	if err := ValidateUUID(alertID); err != nil {
		writeValidation(w, err)
		return
	}
	alert, err := h.repo.RecoverAlert(r.Context(), alertID)
	if err != nil {
		writeAlertNotFound(w, err)
		return
	}
	h.auditWrite(p, "nf_alert.alert.recovering", "nf_alert_instance", alertID, map[string]any{
		"ruleId": alert.RuleID,
		"state":  alert.State,
	})
	response.JSON(w, http.StatusOK, alert)
}

// ResolveAlert handles POST /api/nf-alerts/{alertId}/resolve.
func (h *Handler) ResolveAlert(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-alerts/{alertId}/resolve")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-alerts:resolve:"+p.Username, 30, 60) {
		return
	}
	alertID := r.PathValue("alertId")
	if err := ValidateUUID(alertID); err != nil {
		writeValidation(w, err)
		return
	}
	alert, err := h.repo.ResolveAlert(r.Context(), alertID, p.Username)
	if err != nil {
		writeAlertNotFound(w, err)
		return
	}
	h.auditWrite(p, "nf_alert.alert.resolved", "nf_alert_instance", alertID, map[string]any{
		"ruleId": alert.RuleID,
		"reason": alert.ResolvedReason,
	})
	response.JSON(w, http.StatusOK, alert)
}
