package inventory

import (
	"context"
	"errors"
	"fmt"
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
	preserved, err := preserveRuntimeAttributes(before.Attributes, req.Resource.Attributes)
	if err != nil {
		return nil, nil, &governance.HTTPError{Status: 400, Code: "VALIDATION_FAILED", Message: err.Error()}
	}
	attrs, scopeErr := PrepareOperationalScopeChange(req.Resource.Kind, before.Attributes, preserved)
	if err := scopeErr; err != nil {
		return nil, nil, &governance.HTTPError{Status: 400, Code: "VALIDATION_FAILED", Message: err.Error()}
	}
	req.Resource.Attributes = attrs
	if err := validateAttributes(attrs, true); err != nil {
		return nil, nil, &governance.HTTPError{Status: 400, Code: "VALIDATION_FAILED", Message: err.Error()}
	}
	actor, err := s.actor(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	return s.repo.Update(ctx, id, req, actor)
}

// Runtime identity metadata is read-only even when a client omits attributes.
// Copy the request map so validation cannot mutate a fetched resource snapshot.
func preserveRuntimeAttributes(before, incoming map[string]any) (map[string]any, error) {
	var out map[string]any
	if incoming != nil {
		out = make(map[string]any, len(incoming))
	}
	for key, value := range incoming {
		if runtimeAttribute(key) {
			stored, exists := before[key].(string)
			text, stringValue := value.(string)
			if !exists || !stringValue || stored != text {
				return nil, fmt.Errorf("runtime attribute %q is read-only", key)
			}
		}
		out[key] = value
	}
	for key, value := range before {
		if runtimeAttribute(key) {
			if out == nil {
				out = make(map[string]any)
			}
			out[key] = value
		}
	}
	return out, nil
}

func (s *MutationService) Retire(ctx context.Context, p *auth.Principal, id string, req *RetireResourceRequest) (*Resource, *Resource, error) {
	actor, err := s.actor(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	return s.repo.Retire(ctx, id, req, actor)
}
