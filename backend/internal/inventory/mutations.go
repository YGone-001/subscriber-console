package inventory

import (
	"context"
	"errors"
	"net/http"

	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
)

// MutationService is the governed write boundary. The account store is always
// consulted immediately before repository writes, including legacy entrypoints.
type MutationService struct {
	repo   ResourceRepository
	actors governance.ActorRepository
}

func NewMutationService(repo ResourceRepository, actors governance.ActorRepository) *MutationService {
	return &MutationService{repo: repo, actors: actors}
}

func writeMutationError(w http.ResponseWriter, err error) bool {
	var e *governance.HTTPError
	if !errors.As(err, &e) {
		return false
	}
	response.Error(w, e.Status, e.Message, e.Code)
	return true
}

func (s *MutationService) actor(ctx context.Context, p *auth.Principal) (string, error) {
	if p == nil {
		return "", &governance.HTTPError{Status: 401, Code: "AUTH_INVALID_TOKEN", Message: "Unauthorized"}
	}
	a, err := governance.RevalidateFreshActor(ctx, s.actors, p)
	if err != nil {
		return "", err
	}
	if !auth.HasPermission(p, "core.configure") {
		return "", &governance.HTTPError{Status: 403, Code: "PERMISSION_DENIED", Message: "Forbidden"}
	}
	return a.Username, nil
}

func (s *MutationService) Create(ctx context.Context, p *auth.Principal, req *CreateResourceRequest) (*Resource, error) {
	attrs, scopeErr := PrepareOperationalScopeChange(req.Kind, nil, req.Attributes)
	if err := scopeErr; err != nil {
		return nil, &governance.HTTPError{Status: http.StatusBadRequest, Code: "VALIDATION_FAILED", Message: err.Error()}
	}
	req.Attributes = attrs
	actor, err := s.actor(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.repo.Create(ctx, req, actor)
}

func (s *MutationService) Update(ctx context.Context, p *auth.Principal, id string, req *UpdateResourceRequest) (*Resource, *Resource, error) {
	before, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	attrs, scopeErr := PrepareOperationalScopeChange(req.Resource.Kind, before.Attributes, req.Resource.Attributes)
	if err := scopeErr; err != nil {
		return nil, nil, &governance.HTTPError{Status: 400, Code: "VALIDATION_FAILED", Message: err.Error()}
	}
	req.Resource.Attributes = attrs
	actor, err := s.actor(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	return s.repo.Update(ctx, id, req, actor)
}

func (s *MutationService) Retire(ctx context.Context, p *auth.Principal, id string, req *RetireResourceRequest) (*Resource, *Resource, error) {
	actor, err := s.actor(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	return s.repo.Retire(ctx, id, req, actor)
}
