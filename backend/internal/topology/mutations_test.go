package topology

import (
	"context"
	"strings"
	"testing"

	"subscriber/internal/user"
)

type activeActors struct{}

func (activeActors) FindByUsernameIdentity(_ context.Context, username string) (*user.UserIdentity, error) {
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: username, Role: strings.TrimPrefix(username, "test-"), Status: "active"}}, nil
}

type disabledActors struct{}

func (disabledActors) FindByUsernameIdentity(_ context.Context, username string) (*user.UserIdentity, error) {
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: username, Role: "operator", Status: "disabled"}}, nil
}
func TestTopologyMutationFailsClosed(t *testing.T) {
	repo := newMockRepo()
	s := NewMutationService(repo, disabledActors{})
	if _, e := s.Create(context.Background(), makePrincipal("operator"), &CreateEdgeRequest{}); e == nil || len(repo.items) != 0 {
		t.Fatal("disabled actor reached repository")
	}
	s = NewMutationService(repo, nil)
	if _, e := s.Create(context.Background(), makePrincipal("operator"), &CreateEdgeRequest{}); e == nil {
		t.Fatal("missing actor store accepted")
	}
}
