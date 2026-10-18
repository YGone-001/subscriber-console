package nfhealth

import (
	"context"
	"errors"
	"strings"
)

// runtimeTargetRepo is the narrow persistence surface required to create or
// reuse an automatically bootstrapped monitoring target. It deliberately does
// not widen the handler-facing repository interface.
type runtimeTargetRepo interface {
	CreateTarget(ctx context.Context, req *CreateTargetRequest, actor string) (*HealthTarget, error)
	GetTargetByResourceID(ctx context.Context, resourceID string) (*HealthTarget, error)
}

// RuntimeTargetRequest is a server-generated monitoring proposal.
//
// Every field is derived by the trusted backend from a verified runtime
// observation and a validated Inventory resource. No field is taken from a
// browser request.
type RuntimeTargetRequest struct {
	ResourceID      string
	Name            string
	ServiceUnit     string
	CollectionMode  string
	IntervalSeconds int
}

// EnsureRuntimeTarget creates one process_only monitoring target for an adopted
// local network-function instance, or returns the existing one.
//
// The existing authorization chain is preserved in full:
//   - the request must validate against the collector profile rules,
//   - the Inventory identity is resolved server-side,
//   - the local process must match the resource domain and NF type,
//   - the local process must be covered by a server-authorized binding.
//
// A duplicate target is never an error: the existing target is returned so the
// bootstrap stays idempotent.
func EnsureRuntimeTarget(
	ctx context.Context,
	repo runtimeTargetRepo,
	dest *DestinationAllowlist,
	units *ServiceUnitAllowlist,
	bindings *ProcessBindingRegistry,
	resolvers IdentityResolvers,
	req RuntimeTargetRequest,
	actor string,
) (string, bool, error) {
	resourceID := strings.TrimSpace(req.ResourceID)
	if resourceID == "" {
		return "", false, validationError("NF_HEALTH_RESOURCE_REQUIRED", "an inventory resource association is required")
	}
	if existing, err := repo.GetTargetByResourceID(ctx, resourceID); err == nil && existing != nil {
		return existing.TargetID, false, nil
	}

	enabled := true
	interval := req.IntervalSeconds
	if interval == 0 {
		interval = DefaultIntervalSeconds
	}
	mode := strings.TrimSpace(req.CollectionMode)
	if mode == "" {
		mode = CollectionScheduled
	}
	create := &CreateTargetRequest{
		ResourceID:       resourceID,
		Name:             strings.TrimSpace(req.Name),
		CollectorProfile: CollectorProcessOnly,
		ServiceUnit:      strings.TrimSpace(req.ServiceUnit),
		ServiceKind:      "process",
		CollectionMode:   mode,
		IntervalSeconds:  interval,
		Enabled:          &enabled,
	}
	if err := ValidateCreateTargetRequest(create, dest, units, bindings); err != nil {
		return "", false, err
	}
	resolved, err := ResolveTargetIdentity(ctx, create, resolvers)
	if err != nil {
		return "", false, err
	}
	if err := ValidateResolvedTargetCompatibility(create, resolved, bindings); err != nil {
		return "", false, err
	}
	create.ResolvedDomain = resolved.Domain
	create.ResolvedNFType = resolved.NFType

	target, err := repo.CreateTarget(ctx, create, actor)
	if err != nil {
		if errors.Is(err, ErrDuplicate) {
			if existing, gerr := repo.GetTargetByResourceID(ctx, resourceID); gerr == nil && existing != nil {
				return existing.TargetID, false, nil
			}
		}
		return "", false, err
	}
	return target.TargetID, true, nil
}
