package inventory

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"subscriber/internal/audit"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// discovered.go implements the narrowly scoped, server-authoritative creation
// path for resources that were discovered from a verified local process
// identity.
//
// It deliberately does not reuse the manual Create method: a discovered
// resource must never be labelled as manually authored, and its provenance
// carries the stable bootstrap identity used for idempotency.

// SourceKindDiscovered marks a resource created from a verified runtime
// observation.
const SourceKindDiscovered = "discovered"

// DiscoveredCreateRequest is the server-owned description of a discovered
// resource.
type DiscoveredCreateRequest struct {
	Kind           string
	Name           string
	DisplayName    string
	Description    string
	Domain         string
	Role           string
	LifecycleState string
	Labels         map[string]string
	Attributes     map[string]any
}

// MaxCompatibleCandidates bounds the compatible-resource lookup used to detect
// an ambiguous adoption.
const MaxCompatibleCandidates = 5

// CreateDiscovered inserts a discovered resource, or returns the existing
// resource that already carries the same provenance key.
//
// Concurrency safety comes from the database: the partial unique index
// uniq_inventory_source_external_id guarantees one document per
// (source.system, source.externalId). A duplicate insert is therefore resolved
// by re-reading the winner instead of creating a second resource.
func (r *Repository) CreateDiscovered(
	ctx context.Context,
	req *DiscoveredCreateRequest,
	actor string,
	system string,
	externalID string,
) (*Resource, bool, error) {
	key := strings.TrimSpace(externalID)
	if key == "" {
		return nil, false, errors.New("INVENTORY_DISCOVERED_KEY_REQUIRED")
	}
	state := strings.TrimSpace(req.LifecycleState)
	if state == "" {
		// A running process is not proof that the production service carries
		// traffic, so a discovered resource is never created as active.
		state = LifecyclePlanned
	}
	now := CurrentTimestamp()
	resource := &Resource{
		ResourceID:     audit.GenerateUUID(),
		SchemaVersion:  SchemaVersion,
		Kind:           req.Kind,
		Name:           req.Name,
		NameNormalized: strings.ToLower(req.Name),
		DisplayName:    req.DisplayName,
		Description:    req.Description,
		Domain:         req.Domain,
		Role:           req.Role,
		LifecycleState: state,
		Labels:         req.Labels,
		Attributes:     req.Attributes,
		Source: SourceMetadata{
			Kind:       SourceKindDiscovered,
			System:     strings.TrimSpace(system),
			Authority:  "authoritative",
			ExternalID: key,
		},
		Revision:  1,
		CreatedAt: now,
		CreatedBy: actor,
		UpdatedAt: now,
		UpdatedBy: actor,
	}
	if _, err := r.collection.InsertOne(ctx, resource); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			existing, found, ferr := r.FindByExternalID(ctx, system, key)
			if ferr != nil {
				return nil, false, ferr
			}
			if found {
				return existing, false, nil
			}
		}
		return nil, false, err
	}
	return resource, true, nil
}

// FindByExternalID resolves one resource by server-owned provenance.
func (r *Repository) FindByExternalID(ctx context.Context, system, externalID string) (*Resource, bool, error) {
	found, err := r.FindByExternalIDs(ctx, system, []string{externalID})
	if err != nil {
		return nil, false, err
	}
	resource, ok := found[strings.TrimSpace(externalID)]
	if !ok {
		return nil, false, nil
	}
	return &resource, true, nil
}

// FindByExternalIDs resolves a bounded set of provenance keys in one query.
func (r *Repository) FindByExternalIDs(ctx context.Context, system string, externalIDs []string) (map[string]Resource, error) {
	out := map[string]Resource{}
	if len(externalIDs) == 0 {
		return out, nil
	}
	keys := make([]string, 0, len(externalIDs))
	seen := make(map[string]struct{}, len(externalIDs))
	for _, id := range externalIDs {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		if _, duplicate := seen[trimmed]; duplicate {
			continue
		}
		seen[trimmed] = struct{}{}
		keys = append(keys, trimmed)
	}
	if len(keys) == 0 {
		return out, nil
	}
	filter := bson.M{
		"source.system":     strings.TrimSpace(system),
		"source.externalId": bson.M{"$in": keys},
	}
	cursor, err := r.collection.Find(ctx, filter)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var resource Resource
		if err := cursor.Decode(&resource); err != nil {
			return nil, err
		}
		out[resource.Source.ExternalID] = resource
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// FindCompatible returns the existing monitored resources for a canonical
// domain and role. The lookup is bounded: it exists to decide whether an
// observation can be adopted onto an existing resource, or whether the
// association is ambiguous and must not be adopted automatically.
func (r *Repository) FindCompatible(ctx context.Context, domain, role string) ([]Resource, error) {
	trimmedDomain := strings.TrimSpace(domain)
	trimmedRole := strings.TrimSpace(role)
	if trimmedDomain == "" || trimmedRole == "" {
		return nil, nil
	}
	filter := bson.M{
		"kind":           bson.M{"$in": []string{KindNetworkFunction, KindNetworkFunctionInstance}},
		"domain":         trimmedDomain,
		"role":           bson.M{"$regex": "^" + regexp.QuoteMeta(trimmedRole) + "$", "$options": "i"},
		"lifecycleState": bson.M{"$ne": LifecycleRetired},
	}
	opts := options.Find().
		SetLimit(MaxCompatibleCandidates).
		SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: 1}})
	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]Resource, 0, MaxCompatibleCandidates)
	for cursor.Next(ctx) {
		var resource Resource
		if err := cursor.Decode(&resource); err != nil {
			return nil, err
		}
		out = append(out, resource)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
