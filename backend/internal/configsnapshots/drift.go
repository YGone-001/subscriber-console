package configsnapshots

import (
	"context"
	"errors"
	"subscriber/internal/auth"
	"time"
)

const MaxDriftJournal = 256

// DriftPolicy shares the source lease. A control and its journal input commit
// in the same source-document CAS as capture and baseline.
type DriftPolicy struct {
	Enabled   bool      `json:"enabled" bson:"enabled"`
	Severity  string    `json:"severity" bson:"severity"`
	Revision  int64     `json:"revision" bson:"revision"`
	UpdatedAt time.Time `json:"updatedAt" bson:"updatedAt"`
	UpdatedBy string    `json:"updatedBy" bson:"updatedBy"`
}
type DriftPolicyRequest struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	Enabled          *bool  `json:"enabled"`
	Severity         string `json:"severity"`
}

// DriftInput never contains configuration content or private fingerprints.
// Sequence is publication order under the source lease, not wall-clock order.
type DriftInput struct {
	Version          int         `json:"version" bson:"version"`
	Sequence         int64       `json:"sequence" bson:"sequence"`
	Kind             string      `json:"kind" bson:"kind"`
	SourceID         string      `json:"sourceId" bson:"sourceId"`
	SourceName       string      `json:"sourceName" bson:"sourceName"`
	ResourceID       string      `json:"resourceId" bson:"resourceId"`
	Generation       string      `json:"generation" bson:"generation"`
	Profile          string      `json:"profile" bson:"profile"`
	BaselineID       string      `json:"baselineId" bson:"baselineId"`
	BaselineRevision int64       `json:"baselineRevision" bson:"baselineRevision"`
	Policy           DriftPolicy `json:"policy" bson:"policy"`
	ObservationID    string      `json:"observationId" bson:"observationId"`
	SnapshotID       string      `json:"snapshotId" bson:"snapshotId"`
	Status           string      `json:"status" bson:"status"`
	Comparison       string      `json:"comparison" bson:"comparison"`
	Reason           string      `json:"reason" bson:"reason"`
	At               time.Time   `json:"at" bson:"at"`
}

func normalizedDriftPolicy(p DriftPolicy) DriftPolicy {
	if p.Severity == "" {
		p.Severity = "warning"
	}
	return p
}
func (s *Service) driftInput(st *State, source Source, kind string) DriftInput {
	return DriftInput{Version: 1, Sequence: st.DriftSequence + 1, Kind: kind, SourceID: source.SourceID, SourceName: source.Name, ResourceID: source.ResourceID, Generation: source.Generation, Profile: source.Profile, BaselineID: st.BaselineID, BaselineRevision: st.Revision, Policy: normalizedDriftPolicy(st.DriftPolicy), At: s.now()}
}
func appendDrift(st *State, in DriftInput) error {
	if len(st.DriftQueue) >= MaxDriftJournal {
		return fail(503, "CONFIG_DRIFT_BACKLOG_FULL", "Configuration drift backlog is full; retry after the worker catches up")
	}
	if in.Sequence != st.DriftSequence+1 {
		return ErrConflict
	}
	st.DriftSequence = in.Sequence
	st.DriftQueue = append(st.DriftQueue, in)
	return nil
}
func (s *Service) DriftPolicy(ctx context.Context, id string) (DriftPolicy, error) {
	if !ValidID(id) {
		return DriftPolicy{}, fail(400, "CONFIG_INVALID_ID", "Invalid source ID")
	}
	st, e := s.repo.GetState(ctx, id)
	if errors.Is(e, ErrNotFound) {
		if _, ok := s.declared(id); ok {
			return normalizedDriftPolicy(DriftPolicy{}), nil
		}
	}
	if e != nil {
		return DriftPolicy{}, e
	}
	return normalizedDriftPolicy(st.DriftPolicy), nil
}
func (s *Service) SetDriftPolicy(ctx context.Context, p *auth.Principal, id string, req DriftPolicyRequest) (DriftPolicy, error) {
	actor, e := s.actor(ctx, p)
	if e != nil {
		return DriftPolicy{}, e
	}
	if !ValidID(id) || req.ExpectedRevision < 0 || req.Enabled == nil || (req.Severity != "warning" && req.Severity != "critical" && req.Severity != "info") {
		return DriftPolicy{}, fail(400, "CONFIG_DRIFT_INVALID_POLICY", "Explicit enabled, severity and expectedRevision are required")
	}
	source, ok := s.declared(id)
	if !ok {
		return DriftPolicy{}, fail(409, "CONFIG_SOURCE_NOT_REGISTERED", "Source is not registered")
	}
	if *req.Enabled && s.checkResource(ctx, source) != "valid" {
		return DriftPolicy{}, fail(409, "CONFIG_RESOURCE_UNAVAILABLE", "A current resource association is required")
	}
	st, release, e := s.lease(ctx, source)
	if e != nil {
		return DriftPolicy{}, e
	}
	defer release()
	if st.DriftPolicy.Revision != req.ExpectedRevision {
		return DriftPolicy{}, ErrConflict
	}
	st.DriftPolicy = DriftPolicy{Enabled: *req.Enabled, Severity: req.Severity, Revision: req.ExpectedRevision + 1, UpdatedAt: s.now(), UpdatedBy: actor}
	in := s.driftInput(st, source, "policy")
	if e = appendDrift(st, in); e != nil {
		return DriftPolicy{}, e
	}
	if _, e = s.actor(ctx, p); e != nil {
		return DriftPolicy{}, e
	}
	if *req.Enabled && s.checkResource(ctx, source) != "valid" {
		return DriftPolicy{}, fail(409, "CONFIG_RESOURCE_UNAVAILABLE", "Resource association changed")
	}
	if e = s.repo.Save(ctx, st); e != nil {
		return DriftPolicy{}, e
	}
	s.log(actor, "drift_policy", id, "success")
	return st.DriftPolicy, nil
}
func (s *Service) DriftSources(ctx context.Context) ([]string, error) {
	if repo, ok := s.repo.(interface {
		DriftSourceIDs(context.Context) ([]string, error)
	}); ok {
		return repo.DriftSourceIDs(ctx)
	}
	states, e := s.repo.States(ctx)
	if e != nil {
		return nil, e
	}
	out := []string{}
	for _, st := range states {
		if st.DriftPolicy.Revision > 0 || len(st.DriftQueue) > 0 {
			out = append(out, st.SourceID)
		}
	}
	return out, nil
}

// ConsumeDrift serializes replay with controls/publication. On error the input
// remains durable. Consumers deduplicate by source and sequence.
func (s *Service) ConsumeDrift(ctx context.Context, id string, consume func(context.Context, DriftInput) error) error {
	old, e := s.repo.GetState(ctx, id)
	if e != nil {
		return e
	}
	source, declared := s.declared(id)
	if !declared {
		source = old.Source
	}
	st, release, e := s.lease(ctx, source)
	if e != nil {
		return e
	}
	defer release()
	reason := ""
	env := source.Generation + ":" + source.ResourceID
	if s.catalog.State != "invalid_config" {
		if !declared {
			reason = "source_withdrawn"
			env = "withdrawn"
		} else if resource := s.checkResource(ctx, source); resource == "retired" {
			reason = "resource_retired"
			env = "retired"
		} else if source.Generation != st.Source.Generation {
			reason = "source_reconfigured"
		}
		if reason == "" && declared && s.checkResource(ctx, source) == "valid" && st.DriftEnvironment != env {
			st.DriftEnvironment = env
			if e = s.repo.Save(ctx, st); e != nil {
				return e
			}
		}
		if reason != "" && st.DriftEnvironment != env && len(st.DriftQueue) < MaxDriftJournal {
			in := s.driftInput(st, source, "environment")
			in.Reason = reason
			if e = appendDrift(st, in); e != nil {
				return e
			}
			st.DriftEnvironment = env
			if e = s.repo.Save(ctx, st); e != nil {
				return e
			}
		}
	}
	for n := 0; n < 32 && len(st.DriftQueue) > 0; n++ {
		if e = consume(ctx, st.DriftQueue[0]); e != nil {
			return e
		}
		st.DriftQueue = st.DriftQueue[1:]
		if e = s.repo.Save(ctx, st); e != nil {
			return e
		}
	}
	return nil
}
