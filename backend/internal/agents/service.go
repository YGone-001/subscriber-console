package agents

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/inventory"
)

type Failure struct {
	Status        int
	Code, Message string
}

func (e *Failure) Error() string                  { return e.Message }
func fail(status int, code, message string) error { return &Failure{status, code, message} }

type ResourceReader interface {
	GetByID(context.Context, string) (*inventory.Resource, error)
}
type AuditWriter interface{ WriteBestEffort(audit.WriteAuditInput) }
type LocalSource interface{ View() LocalView }

type Service struct {
	repo      Repository
	actors    governance.ActorRepository
	resources ResourceReader
	local     LocalSource
	audit     AuditWriter
	clock     func() time.Time
}

func NewService(repo Repository, actors governance.ActorRepository, resources ResourceReader, local LocalSource, writer AuditWriter) *Service {
	return &Service{repo: repo, actors: actors, resources: resources, local: local, audit: writer, clock: time.Now}
}
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	return hex.EncodeToString(b), err
}
func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func (s *Service) now() time.Time { return s.clock().UTC() }

func (s *Service) actor(ctx context.Context, p *auth.Principal) (*governance.FreshActor, error) {
	if p == nil {
		return nil, fail(401, "AUTH_INVALID_TOKEN", "Unauthorized")
	}
	if !auth.HasCapability(p, "user_admin") {
		return nil, fail(403, "PERMISSION_DENIED", "Only administrators can manage collector access")
	}
	a, err := governance.RevalidateFreshActor(ctx, s.actors, p)
	if err != nil {
		return nil, fail(err.Status, err.Code, err.Message)
	}
	return a, nil
}
func (s *Service) checkResources(ctx context.Context, m Metadata) error {
	refs := []struct{ id, kind string }{{m.Scope.SiteResourceID, inventory.KindSite}, {m.Scope.HostResourceID, inventory.KindHost}}
	for _, ref := range refs {
		if ref.id == "" {
			continue
		}
		if s.resources == nil {
			return fail(503, "AGENT_RESOURCE_UNAVAILABLE", "Inventory is unavailable")
		}
		resource, err := s.resources.GetByID(ctx, ref.id)
		if err != nil || resource == nil {
			return fail(400, "AGENT_RESOURCE_INVALID", "Referenced Inventory resource is unavailable")
		}
		if resource.Kind != ref.kind || resource.LifecycleState == inventory.LifecycleRetired {
			return fail(400, "AGENT_RESOURCE_INVALID", "Referenced Inventory resource has an incompatible kind or lifecycle")
		}
	}
	return nil
}
func (s *Service) log(actor *governance.FreshActor, action string, r *Record) {
	if s.audit == nil {
		return
	}
	s.audit.WriteBestEffort(audit.WriteAuditInput{
		Action: action, Module: "agents", TargetID: r.AgentID, Result: "success", RiskLevel: "medium",
		Actor:    audit.ActorInput{Type: "user", Username: actor.Username, Role: actor.NormalizedRole, UserID: actor.UserID},
		Resource: &audit.ResourceInput{Type: "collector_agent", ID: r.AgentID, Name: r.Name},
		Metadata: map[string]interface{}{"networkKey": r.Scope.NetworkKey, "enabled": r.Enabled, "revision": r.Revision},
	})
}
func (s *Service) Create(ctx context.Context, p *auth.Principal, req CreateRequest) (*CredentialResponse, error) {
	actor, err := s.actor(ctx, p)
	if err != nil {
		return nil, err
	}
	if err = validateMetadata(&req.Metadata); err != nil {
		return nil, fail(400, "AGENT_VALIDATION_ERROR", err.Error())
	}
	if err = s.checkResources(ctx, req.Metadata); err != nil {
		return nil, err
	}
	id, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	token, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	now := s.now()
	r := &Record{AgentID: id, Metadata: req.Metadata, Enabled: true, Revision: 1, CreatedAt: now, UpdatedAt: now, CreatedBy: actor.Username, KeyHash: digest(token)}
	if err = s.repo.Create(ctx, r); err != nil {
		return nil, err
	}
	s.log(actor, "agents.create", r)
	return &CredentialResponse{Agent: project(r, now, true), Token: token}, nil
}
func (s *Service) Update(ctx context.Context, p *auth.Principal, id string, req UpdateRequest) (*View, error) {
	actor, err := s.actor(ctx, p)
	if err != nil {
		return nil, err
	}
	if !idPattern.MatchString(id) || req.ExpectedRevision < 1 || req.Enabled == nil {
		return nil, fail(400, "AGENT_VALIDATION_ERROR", "Invalid agent or revision")
	}
	if err = validateMetadata(&req.Metadata); err != nil {
		return nil, fail(400, "AGENT_VALIDATION_ERROR", err.Error())
	}
	if err = s.checkResources(ctx, req.Metadata); err != nil {
		return nil, err
	}
	r, err := s.repo.Update(ctx, id, req, s.now())
	if err != nil {
		return nil, err
	}
	s.log(actor, "agents.update", r)
	v := project(r, s.now(), true)
	return &v, nil
}
func (s *Service) Rotate(ctx context.Context, p *auth.Principal, id string, revision int64) (*CredentialResponse, error) {
	actor, err := s.actor(ctx, p)
	if err != nil {
		return nil, err
	}
	if !idPattern.MatchString(id) || revision < 1 {
		return nil, fail(400, "AGENT_VALIDATION_ERROR", "Invalid agent or revision")
	}
	token, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	r, err := s.repo.Rotate(ctx, id, revision, digest(token), s.now())
	if err != nil {
		return nil, err
	}
	s.log(actor, "agents.rotate_credential", r)
	return &CredentialResponse{Agent: project(r, s.now(), true), Token: token}, nil
}
func (s *Service) List(ctx context.Context, q ListQuery) (*ListResponse, error) {
	if q.Limit < 1 || q.Limit > MaxPageSize || !textValid(q.Q, 128) || (q.Cursor != "" && !idPattern.MatchString(q.Cursor)) {
		return nil, fail(400, "AGENT_INVALID_QUERY", "Invalid list query")
	}
	out := &ListResponse{
		Agents: []View{}, Completeness: "complete", ProtocolVersion: ProtocolVersion,
		StaleAfterSeconds: StaleAfterSeconds, OfflineAfterSeconds: OfflineAfterSeconds,
		Controller: LocalView{Role: "controller", Transport: "in_process", EvidenceFreshness: "unavailable"},
	}
	if s.local != nil {
		out.Controller = s.local.View()
	}
	page, err := s.repo.List(ctx, q, s.now())
	if err != nil {
		out.Completeness = "unavailable"
		return out, nil
	}
	out.Summary = &page.Summary
	out.NextCursor = page.NextCursor
	out.HasMore = page.HasMore
	for i := range page.Records {
		out.Agents = append(out.Agents, project(&page.Records[i], s.now(), false))
	}
	return out, nil
}
func (s *Service) Get(ctx context.Context, id string) (*View, error) {
	if !idPattern.MatchString(id) {
		return nil, fail(400, "AGENT_INVALID_ID", "Invalid agent identifier")
	}
	r, err := s.repo.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	v := project(r, s.now(), true)
	return &v, nil
}
func (s *Service) Authenticate(ctx context.Context, id, token string) (*Record, error) {
	if !idPattern.MatchString(id) || len(token) != 64 || !idPattern.MatchString(token[:32]) || !idPattern.MatchString(token[32:]) {
		return nil, ErrUnauthorized
	}
	r, err := s.repo.Get(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	got := digest(token)
	if !r.Enabled || subtle.ConstantTimeCompare([]byte(got), []byte(r.KeyHash)) != 1 {
		return nil, ErrUnauthorized
	}
	return r, nil
}
func (s *Service) StartSession(ctx context.Context, r *Record, req SessionRequest) (*SessionResponse, error) {
	if req.ProtocolVersion != ProtocolVersion {
		return nil, fail(400, "AGENT_PROTOCOL_UNSUPPORTED", "Unsupported collector protocol")
	}
	session, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	now := s.now()
	expiry := now.Add(time.Hour)
	if err = s.repo.StartSession(ctx, r.AgentID, r.KeyHash, digest(session), expiry, now); err != nil {
		return nil, err
	}
	return &SessionResponse{session, expiry, ReportIntervalSeconds, ProtocolVersion}, nil
}
func (s *Service) Accept(ctx context.Context, r *Record, req ReportRequest) (bool, error) {
	now := s.now()
	if req.ProtocolVersion != ProtocolVersion {
		return false, fail(400, "AGENT_PROTOCOL_UNSUPPORTED", "Unsupported collector protocol")
	}
	if req.Sequence < 1 || req.Sequence > 9007199254740991 || len(req.SessionID) != 64 {
		return false, ErrSession
	}
	sessionHash := digest(req.SessionID)
	if r.SessionHash != sessionHash || !r.SessionExpiresAt.After(now) {
		return false, ErrSession
	}
	if err := validateObservation(&req.Observation, now); err != nil {
		return false, fail(400, "AGENT_REPORT_INVALID", err.Error())
	}
	data, err := json.Marshal(req.Observation)
	if err != nil {
		return false, fmt.Errorf("encode bounded observation: %w", err)
	}
	return s.repo.Accept(ctx, r.AgentID, r.KeyHash, sessionHash, req.Sequence, digest(string(data)), &req.Observation, now)
}

func statusFor(err error) (int, string, string) {
	var f *Failure
	if errors.As(err, &f) {
		return f.Status, f.Code, f.Message
	}
	switch {
	case errors.Is(err, ErrNotFound):
		return 404, "AGENT_NOT_FOUND", "Collector not found"
	case errors.Is(err, ErrConflict):
		return 409, "AGENT_REVISION_CONFLICT", "Collector was changed by another operation"
	case errors.Is(err, ErrUnauthorized):
		return 401, "AGENT_AUTH_INVALID", "Collector credential is invalid"
	case errors.Is(err, ErrSession):
		return 409, "AGENT_SESSION_INVALID", "Collector session must be renewed"
	case errors.Is(err, ErrSequence):
		return 409, "AGENT_SEQUENCE_CONFLICT", "Collector report is out of order"
	default:
		return http.StatusServiceUnavailable, "AGENT_STORE_UNAVAILABLE", "Collector storage is unavailable"
	}
}
