package approval

import (
	"context"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/user"
)

// DecisionStore abstracts approval persistence for Workflow testing.
// Production: *Repository satisfies this via Mongo FindOneAndUpdate.
type DecisionStore interface {
	GetApproval(ctx context.Context, id string) (*ApprovalDocument, error)
	TransitionApproval(ctx context.Context, input TransitionInput) (*TransitionResult, error)
}

// IdentityReader abstracts user identity lookup for Workflow testing.
// Production: *user.Repository satisfies this.
type IdentityReader interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// StrictAuditWriter abstracts strict audit writing for Workflow testing.
// Production: *audit.Writer satisfies this.
type StrictAuditWriter interface {
	WriteStrict(ctx context.Context, input audit.WriteAuditInput) error
}
