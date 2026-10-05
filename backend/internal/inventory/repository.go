package inventory

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"subscriber/internal/audit"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var (
	uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

	ErrNotFound         = errors.New("INVENTORY_RESOURCE_NOT_FOUND")
	ErrRevisionConflict = errors.New("INVENTORY_REVISION_CONFLICT")
	ErrRetiredConflict  = errors.New("INVENTORY_RESOURCE_RETIRED")
	ErrKindImmutable    = errors.New("INVENTORY_KIND_IMMUTABLE")
)

// CursorData represents cursor state encoded in opaque cursor strings.
type CursorData struct {
	UpdatedAt string `json:"u"`
	ID        string `json:"i"`
}

// ListFilter contains query parameters for listing resources.
type ListFilter struct {
	Kind           string
	Domain         string
	LifecycleState string
	Query          string
	Limit          int
	Cursor         string
}

// Repository handles persistence of inventory resources in xcloud_ops.app_inventory_resources.
type Repository struct {
	collection *mongo.Collection
}

// NewRepository creates a new inventory repository.
func NewRepository(collection *mongo.Collection) *Repository {
	return &Repository{collection: collection}
}

// Create inserts a new inventory resource.
func (r *Repository) Create(ctx context.Context, req *CreateResourceRequest, actor string) (*Resource, error) {
	caps, err := NormalizeCapabilities(req.Capabilities)
	if err != nil {
		return nil, err
	}

	state := req.LifecycleState
	if state == "" {
		state = LifecycleActive
	}

	now := CurrentTimestamp()
	res := &Resource{
		ResourceID:          audit.GenerateUUID(),
		SchemaVersion:       SchemaVersion,
		Kind:                req.Kind,
		Name:                req.Name,
		NameNormalized:      strings.ToLower(req.Name),
		DisplayName:         req.DisplayName,
		Description:         req.Description,
		Domain:              req.Domain,
		Role:                req.Role,
		LifecycleState:      state,
		Vendor:              req.Vendor,
		Model:               req.Model,
		Software:            req.Software,
		ManagementEndpoints: req.ManagementEndpoints,
		Capabilities:        caps,
		Labels:              req.Labels,
		Attributes:          req.Attributes,
		Source: SourceMetadata{
			Kind:      "manual",
			System:    "xcloud",
			Authority: "authoritative",
		},
		Revision:  1,
		CreatedAt: now,
		CreatedBy: actor,
		UpdatedAt: now,
		UpdatedBy: actor,
	}

	if _, err := r.collection.InsertOne(ctx, res); err != nil {
		return nil, fmt.Errorf("failed to insert inventory resource: %w", err)
	}

	return res, nil
}

// GetByID retrieves a single resource by its UUID.
func (r *Repository) GetByID(ctx context.Context, id string) (*Resource, error) {
	if !uuidRegex.MatchString(id) {
		return nil, ErrNotFound
	}

	var res Resource
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&res)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("failed to find resource: %w", err)
	}

	return &res, nil
}

// List queries resources with filters and keyset cursor pagination.
func (r *Repository) List(ctx context.Context, filter ListFilter) ([]Resource, *string, bool, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	filterDoc := bson.M{}
	if filter.Kind != "" {
		filterDoc["kind"] = filter.Kind
	}
	if filter.Domain != "" {
		filterDoc["domain"] = filter.Domain
	}
	if filter.LifecycleState != "" {
		filterDoc["lifecycleState"] = filter.LifecycleState
	}

	if filter.Query != "" {
		q := strings.TrimSpace(filter.Query)
		if uuidRegex.MatchString(q) {
			filterDoc["_id"] = q
		} else {
			filterDoc["nameNormalized"] = bson.M{
				"$regex":   "^" + regexp.QuoteMeta(strings.ToLower(q)),
				"$options": "i",
			}
		}
	}

	if filter.Cursor != "" {
		cursorBytes, err := base64.URLEncoding.DecodeString(filter.Cursor)
		if err != nil {
			return nil, nil, false, errors.New("invalid pagination cursor encoding")
		}
		var cur CursorData
		if err := json.Unmarshal(cursorBytes, &cur); err != nil || cur.UpdatedAt == "" || cur.ID == "" {
			return nil, nil, false, errors.New("invalid pagination cursor payload")
		}

		cursorFilter := bson.M{
			"$or": []bson.M{
				{"updatedAt": bson.M{"$lt": cur.UpdatedAt}},
				{
					"updatedAt": cur.UpdatedAt,
					"_id":       bson.M{"$gt": cur.ID},
				},
			},
		}

		if len(filterDoc) == 0 {
			filterDoc = cursorFilter
		} else {
			filterDoc = bson.M{
				"$and": []bson.M{filterDoc, cursorFilter},
			}
		}
	}

	// Canonical order: updatedAt DESC, _id ASC
	opts := options.Find().
		SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(limit + 1))

	cursor, err := r.collection.Find(ctx, filterDoc, opts)
	if err != nil {
		return nil, nil, false, fmt.Errorf("failed to query inventory resources: %w", err)
	}
	defer cursor.Close(ctx)

	var items []Resource
	for cursor.Next(ctx) {
		var item Resource
		if err := cursor.Decode(&item); err != nil {
			return nil, nil, false, fmt.Errorf("failed to decode inventory resource: %w", err)
		}
		items = append(items, item)
	}
	if err := cursor.Err(); err != nil {
		return nil, nil, false, fmt.Errorf("cursor iteration error: %w", err)
	}

	hasMore := false
	var nextCursor *string

	if len(items) > limit {
		hasMore = true
		items = items[:limit]
		last := items[limit-1]
		cData := CursorData{
			UpdatedAt: last.UpdatedAt,
			ID:        last.ResourceID,
		}
		cBytes, _ := json.Marshal(cData)
		encoded := base64.URLEncoding.EncodeToString(cBytes)
		nextCursor = &encoded
	}

	if items == nil {
		items = []Resource{}
	}

	return items, nextCursor, hasMore, nil
}

// Update performs an atomic CAS update replacing mutable fields.
func (r *Repository) Update(ctx context.Context, id string, req *UpdateResourceRequest, actor string) (*Resource, *Resource, error) {
	if !uuidRegex.MatchString(id) {
		return nil, nil, ErrNotFound
	}

	caps, err := NormalizeCapabilities(req.Resource.Capabilities)
	if err != nil {
		return nil, nil, err
	}

	// Fetch existing resource to verify existence, kind immutability, and state
	existing, err := r.GetByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	if existing.Kind != req.Resource.Kind {
		return nil, nil, ErrKindImmutable
	}
	if existing.LifecycleState == LifecycleRetired {
		return nil, nil, ErrRetiredConflict
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}

	now := CurrentTimestamp()
	updateFilter := bson.M{
		"_id":            id,
		"revision":       req.ExpectedRevision,
		"lifecycleState": bson.M{"$ne": LifecycleRetired},
	}

	updateDoc := bson.M{
		"$set": bson.M{
			"name":                req.Resource.Name,
			"nameNormalized":      strings.ToLower(req.Resource.Name),
			"displayName":         req.Resource.DisplayName,
			"description":         req.Resource.Description,
			"domain":              req.Resource.Domain,
			"role":                req.Resource.Role,
			"lifecycleState":      req.Resource.LifecycleState,
			"vendor":              req.Resource.Vendor,
			"model":               req.Resource.Model,
			"software":            req.Resource.Software,
			"managementEndpoints": req.Resource.ManagementEndpoints,
			"capabilities":        caps,
			"labels":              req.Resource.Labels,
			"attributes":          req.Resource.Attributes,
			"updatedAt":           now,
			"updatedBy":           actor,
			"revision":            req.ExpectedRevision + 1,
		},
	}

	result, err := r.collection.UpdateOne(ctx, updateFilter, updateDoc)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to update inventory resource: %w", err)
	}

	if result.MatchedCount == 0 {
		// Recheck current state for precise conflict reason
		cur, err := r.GetByID(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		if cur.LifecycleState == LifecycleRetired {
			return nil, nil, ErrRetiredConflict
		}
		return nil, nil, ErrRevisionConflict
	}

	updated, err := r.GetByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	return existing, updated, nil
}

// Retire marks a resource as terminal 'retired' state using atomic CAS.
func (r *Repository) Retire(ctx context.Context, id string, req *RetireResourceRequest, actor string) (*Resource, *Resource, error) {
	if !uuidRegex.MatchString(id) {
		return nil, nil, ErrNotFound
	}

	existing, err := r.GetByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	if existing.LifecycleState == LifecycleRetired {
		return nil, nil, ErrRetiredConflict
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}

	now := CurrentTimestamp()
	updateFilter := bson.M{
		"_id":            id,
		"revision":       req.ExpectedRevision,
		"lifecycleState": bson.M{"$ne": LifecycleRetired},
	}

	updateDoc := bson.M{
		"$set": bson.M{
			"lifecycleState": LifecycleRetired,
			"updatedAt":      now,
			"updatedBy":      actor,
			"revision":       req.ExpectedRevision + 1,
		},
	}

	result, err := r.collection.UpdateOne(ctx, updateFilter, updateDoc)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to retire inventory resource: %w", err)
	}

	if result.MatchedCount == 0 {
		cur, err := r.GetByID(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		if cur.LifecycleState == LifecycleRetired {
			return nil, nil, ErrRetiredConflict
		}
		return nil, nil, ErrRevisionConflict
	}

	retired, err := r.GetByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}

	return existing, retired, nil
}
