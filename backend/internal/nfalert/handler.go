package nfalert

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// RateLimiter defines the interface for rate limiting HTTP requests.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// AuditWriter defines the interface for recording audit log entries.
type AuditWriter interface {
	WriteBestEffort(input audit.WriteAuditInput)
}

// RepositoryAPI is the handler-facing persistence surface.
type RepositoryAPI interface {
	CreateRule(ctx context.Context, req *CreateRuleRequest, actor string) (*AlertRule, error)
	GetRule(ctx context.Context, ruleID string) (*AlertRule, error)
	ListRules(ctx context.Context, filter RuleListFilter) ([]AlertRule, *string, bool, error)
	UpdateRule(ctx context.Context, ruleID string, req *UpdateRuleRequest, actor string) (*AlertRule, *AlertRule, error)
	DeleteRule(ctx context.Context, ruleID string, actor string) (*AlertRule, []Alert, error)
	GetAlert(ctx context.Context, alertID string) (*Alert, error)
	ListAlerts(ctx context.Context, filter AlertListFilter) ([]Alert, *string, bool, error)
	AcknowledgeAlert(ctx context.Context, alertID, actor string) (*Alert, error)
	ResolveAlert(ctx context.Context, alertID, actor string) (*Alert, error)
}

// Handler serves the NF alert API surface.
type Handler struct {
	repo        RepositoryAPI
	limiter     RateLimiter
	auditWriter AuditWriter
}

// NewHandler constructs the NF alert HTTP handler.
func NewHandler(repo RepositoryAPI, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{repo: repo, limiter: limiter, auditWriter: auditWriter}
}

const maxBodyBytes = 64 << 10

// decodeStrictJSON rejects unknown fields and trailing content.
func decodeStrictJSON(r io.Reader, maxBytes int64, dst any) error {
	limited := io.LimitReader(r, maxBytes+1)
	data, err := io.ReadAll(limited)
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
		Action: "nf_alert.denied",
		Module: "nf_alert",
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

func writeValidation(w http.ResponseWriter, err error) {
	// Sentinel errors carry their own conflict semantics; they are not
	// ErrValidation payloads and must not fall through to the generic 400.
	if errors.Is(err, ErrRevisionConflict) {
		response.Error(w, http.StatusConflict, "Revision conflict", "NF_ALERT_REVISION_CONFLICT")
		return
	}
	if errors.Is(err, ErrAlertResolved) {
		response.Error(w, http.StatusConflict, "Alert instance is already resolved", "NF_ALERT_INSTANCE_RESOLVED")
		return
	}
	code, message := MapValidationError(err)
	status := http.StatusBadRequest
	switch code {
	case "NF_ALERT_REVISION_CONFLICT":
		status = http.StatusConflict
	case "NF_ALERT_INSTANCE_RESOLVED":
		status = http.StatusConflict
	}
	response.Error(w, status, message, code)
}

func writeRuleNotFound(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrNotFound) {
		response.Error(w, http.StatusNotFound, "Alert rule not found", "NF_ALERT_RULE_NOT_FOUND")
		return
	}
	writeValidation(w, err)
}

func writeAlertNotFound(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrAlertNotFound) {
		response.Error(w, http.StatusNotFound, "Alert instance not found", "NF_ALERT_INSTANCE_NOT_FOUND")
		return
	}
	if errors.Is(err, ErrAlertResolved) {
		response.Error(w, http.StatusConflict, "Alert instance is already resolved", "NF_ALERT_INSTANCE_RESOLVED")
		return
	}
	response.Error(w, http.StatusInternalServerError, "Internal error", "NF_ALERT_INTERNAL")
}

func (h *Handler) auditWrite(p *auth.Principal, action, resourceType, resourceID string, meta map[string]any) {
	if h.auditWriter == nil {
		return
	}
	input := audit.WriteAuditInput{
		Action: action,
		Module: "nf_alert",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Resource: &audit.ResourceInput{
			Type: resourceType,
			ID:   resourceID,
		},
		Result:    "success",
		RiskLevel: "low",
		Metadata:  meta,
	}
	h.auditWriter.WriteBestEffort(input)
}
