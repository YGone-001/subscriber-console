package discovery

import (
	"context"
	"strings"
)

// MonitoringAssociationResolver resolves the monitoring association of the
// Inventory resources linked by one bounded candidate page. The batch shape is
// mandatory: exactly one lookup per page, never one lookup per candidate.
//
// The resolved association is evidence about an existing
// candidate-resource-target chain. The resolver never creates or mutates a
// target, never reaches the runtime plane and never invents an identity: an NF
// type match is never treated as a monitoring association.
type MonitoringAssociationResolver interface {
	ResolveMonitoringTargets(ctx context.Context, resourceIDs []string) (map[string]string, error)
}

// MonitoringAssociationResolverFunc adapts a plain function to the resolver
// interface so the wiring layer can bind the authoritative NF Health lookup
// without the discovery package depending on that domain.
type MonitoringAssociationResolverFunc func(ctx context.Context, resourceIDs []string) (map[string]string, error)

// ResolveMonitoringTargets implements MonitoringAssociationResolver.
func (f MonitoringAssociationResolverFunc) ResolveMonitoringTargets(ctx context.Context, resourceIDs []string) (map[string]string, error) {
	return f(ctx, resourceIDs)
}

// enrichMonitoringAssociation projects the candidate-resource-target chain onto
// one bounded candidate page.
//
// Rules:
//   - one bounded batch lookup for the distinct linked resource ids of the page;
//   - an unlinked candidate keeps no association summary (the link column states
//     that fact, and absence of the projection must never read as unmonitored);
//   - a failed lookup marks every linked candidate of the page unresolved, which
//     is never downgraded to unmonitored: absence is not established;
//   - a nil resolver (unwired, e.g. focused tests) leaves the page unprojected.
func enrichMonitoringAssociation(ctx context.Context, resolver MonitoringAssociationResolver, candidates []NFObservation) {
	if resolver == nil || len(candidates) == 0 {
		return
	}

	seen := make(map[string]struct{}, len(candidates))
	ids := make([]string, 0, len(candidates))
	for i := range candidates {
		linked := candidates[i].LinkedResourceID
		if linked == nil {
			continue
		}
		id := strings.TrimSpace(*linked)
		if id == "" {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return
	}
	if len(ids) > CandidateMonitoringBound {
		ids = ids[:CandidateMonitoringBound]
	}

	targets, err := resolver.ResolveMonitoringTargets(ctx, ids)
	unresolved := err != nil
	if targets == nil {
		targets = map[string]string{}
	}

	for i := range candidates {
		linked := candidates[i].LinkedResourceID
		if linked == nil {
			continue
		}
		id := strings.TrimSpace(*linked)
		if id == "" {
			continue
		}
		switch {
		case unresolved:
			candidates[i].MonitoringAssociation = &CandidateMonitoringAssociation{State: CandidateUnresolved}
		default:
			if targetID, ok := targets[id]; ok && strings.TrimSpace(targetID) != "" {
				candidates[i].MonitoringAssociation = &CandidateMonitoringAssociation{State: CandidateMonitored, TargetID: targetID}
			} else {
				candidates[i].MonitoringAssociation = &CandidateMonitoringAssociation{State: CandidateUnmonitored}
			}
		}
	}
}
