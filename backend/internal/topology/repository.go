package topology

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"subscriber/internal/audit"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var (
	uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

	ErrEdgeNotFound         = errors.New("TOPOLOGY_EDGE_NOT_FOUND")
	ErrRevisionConflict     = errors.New("TOPOLOGY_REVISION_CONFLICT")
	ErrEdgeRetired          = errors.New("TOPOLOGY_EDGE_RETIRED")
	ErrDuplicateActiveEdge  = errors.New("TOPOLOGY_DUPLICATE_ACTIVE_EDGE")
	ErrEndpointNotFound     = errors.New("TOPOLOGY_ENDPOINT_NOT_FOUND")
	ErrEndpointRetired      = errors.New("TOPOLOGY_ENDPOINT_RETIRED")
	ErrRootResourceNotFound = errors.New("TOPOLOGY_ROOT_RESOURCE_NOT_FOUND")
	ErrInvalidCursor        = errors.New("INVALID_CURSOR")

	// ErrIncompatibleCursorUse wraps ErrInvalidCursor so that a cursor replayed
	// against a different filter set is reported with the same INVALID_CURSOR
	// error code as a malformed cursor, rather than falling through to a 500.
	ErrIncompatibleCursorUse = fmt.Errorf("%w: cursor was produced under a different filter set", ErrInvalidCursor)
)

// InventoryResolver is the narrow read-only Inventory projection topology needs.
//
// Inventory remains the sole owner of resource identity, classification and
// lifecycle. Topology never writes to the inventory collection and never stores
// a second copy of those facts inside an edge document.
type InventoryResolver interface {
	Resolve(ctx context.Context, resourceID string) (*ResourceProjection, error)
	ResolveMany(ctx context.Context, resourceIDs []string) (map[string]ResourceProjection, error)
}

// MongoInventoryResolver reads the narrow projection from app_inventory_resources.
type MongoInventoryResolver struct {
	collection *mongo.Collection
}

// NewMongoInventoryResolver creates the read-only Inventory resolver.
func NewMongoInventoryResolver(collection *mongo.Collection) *MongoInventoryResolver {
	return &MongoInventoryResolver{collection: collection}
}

type inventoryProjectionDoc struct {
	ResourceID     string `bson:"_id"`
	Kind           string `bson:"kind"`
	Name           string `bson:"name"`
	DisplayName    string `bson:"displayName"`
	Domain         string `bson:"domain"`
	Role           string `bson:"role"`
	LifecycleState string `bson:"lifecycleState"`
}

func toProjection(doc inventoryProjectionDoc) ResourceProjection {
	return ResourceProjection{
		ResourceID:     doc.ResourceID,
		Kind:           doc.Kind,
		Name:           doc.Name,
		DisplayName:    doc.DisplayName,
		Domain:         doc.Domain,
		Role:           doc.Role,
		LifecycleState: doc.LifecycleState,
	}
}

// Resolve returns the Inventory projection for a single resource id.
func (r *MongoInventoryResolver) Resolve(ctx context.Context, resourceID string) (*ResourceProjection, error) {
	if !uuidRegex.MatchString(resourceID) {
		return nil, ErrEndpointNotFound
	}
	var doc inventoryProjectionDoc
	err := r.collection.FindOne(ctx, bson.M{"_id": resourceID}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrEndpointNotFound
		}
		return nil, fmt.Errorf("failed to resolve inventory resource: %w", err)
	}
	projection := toProjection(doc)
	return &projection, nil
}

// ResolveMany returns the Inventory projections for a batch of resource ids.
// Missing ids are simply absent from the returned map.
func (r *MongoInventoryResolver) ResolveMany(ctx context.Context, resourceIDs []string) (map[string]ResourceProjection, error) {
	result := map[string]ResourceProjection{}
	if len(resourceIDs) == 0 {
		return result, nil
	}
	unique := make([]string, 0, len(resourceIDs))
	seen := map[string]bool{}
	for _, id := range resourceIDs {
		if id == "" || seen[id] || !uuidRegex.MatchString(id) {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	if len(unique) == 0 {
		return result, nil
	}
	cursor, err := r.collection.Find(ctx, bson.M{"_id": bson.M{"$in": unique}})
	if err != nil {
		return nil, fmt.Errorf("failed to resolve inventory resources: %w", err)
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc inventoryProjectionDoc
		if err := cursor.Decode(&doc); err != nil {
			return nil, fmt.Errorf("failed to decode inventory resource projection: %w", err)
		}
		result[doc.ResourceID] = toProjection(doc)
	}
	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("inventory projection cursor error: %w", err)
	}
	return result, nil
}

// CursorData is the opaque cursor payload. The signature binds a cursor to the
// filter set it was produced under so it cannot be replayed against a different
// query.
type CursorData struct {
	UpdatedAt string `json:"u"`
	ID        string `json:"i"`
	Signature string `json:"f"`
}

// ListFilter contains the allowlisted query parameters for listing edges.
type ListFilter struct {
	FromResourceID   string
	ToResourceID     string
	RelationshipType string
	LifecycleState   string
	Limit            int
	Cursor           string
}

// NeighborFilter contains the allowlisted query parameters for one-hop queries.
type NeighborFilter struct {
	RootResourceID   string
	Direction        string
	RelationshipType string
	LifecycleState   string
	Limit            int
	Cursor           string
}

// Repository persists topology edges in xcloud_ops.app_topology_edges and reads
// Inventory projections through the narrow resolver.
type Repository struct {
	edges     *mongo.Collection
	inventory InventoryResolver
}

// NewRepository creates a new topology repository.
func NewRepository(edges *mongo.Collection, inventory InventoryResolver) *Repository {
	return &Repository{edges: edges, inventory: inventory}
}

// NewMongoRepository creates a topology repository bound to the inventory
// collection (convenience wiring for the production server).
func NewMongoRepository(edges *mongo.Collection, inventoryCollection *mongo.Collection) *Repository {
	return NewRepository(edges, NewMongoInventoryResolver(inventoryCollection))
}

func filterSignature(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	return hex.EncodeToString(sum[:8])
}

func encodeCursor(data CursorData) (string, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(raw), nil
}

func decodeCursor(cursor string) (*CursorData, error) {
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, ErrInvalidCursor
	}
	var data CursorData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, ErrInvalidCursor
	}
	if data.UpdatedAt == "" || data.ID == "" {
		return nil, ErrInvalidCursor
	}
	return &data, nil
}

// validateEndpoints ensures both endpoints exist and are not retired.
//
// Concurrency boundary: endpoint existence is checked before the insert. A
// concurrent Inventory retirement between the check and the insert is NOT
// prevented by a database-level foreign key - MongoDB provides no such
// guarantee. The check narrows, but does not eliminate, that race window.
func (r *Repository) validateEndpoints(ctx context.Context, fromID, toID string) error {
	projections, err := r.inventory.ResolveMany(ctx, []string{fromID, toID})
	if err != nil {
		return err
	}
	from, ok := projections[fromID]
	if !ok {
		return fmt.Errorf("%w: fromResourceId", ErrEndpointNotFound)
	}
	to, ok := projections[toID]
	if !ok {
		return fmt.Errorf("%w: toResourceId", ErrEndpointNotFound)
	}
	if from.LifecycleState == "retired" {
		return fmt.Errorf("%w: fromResourceId", ErrEndpointRetired)
	}
	if to.LifecycleState == "retired" {
		return fmt.Errorf("%w: toResourceId", ErrEndpointRetired)
	}
	return nil
}

// Create inserts a new active topology edge.
func (r *Repository) Create(ctx context.Context, req *CreateEdgeRequest, actor string) (*Edge, error) {
	if err := r.validateEndpoints(ctx, req.FromResourceID, req.ToResourceID); err != nil {
		return nil, err
	}

	now := CurrentTimestamp()
	edge := &Edge{
		EdgeID:           audit.GenerateUUID(),
		SchemaVersion:    SchemaVersion,
		RelationshipType: req.RelationshipType,
		FromResourceID:   req.FromResourceID,
		ToResourceID:     req.ToResourceID,
		Description:      req.Description,
		Labels:           req.Labels,
		Attributes:       req.Attributes,
		LifecycleState:   LifecycleActive,
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

	if _, err := r.edges.InsertOne(ctx, edge); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return nil, ErrDuplicateActiveEdge
		}
		return nil, fmt.Errorf("failed to insert topology edge: %w", err)
	}

	return edge, nil
}

// GetByID retrieves a single edge by its UUID. Retired edges remain readable.
func (r *Repository) GetByID(ctx context.Context, edgeID string) (*Edge, error) {
	if !uuidRegex.MatchString(edgeID) {
		return nil, ErrEdgeNotFound
	}
	var edge Edge
	err := r.edges.FindOne(ctx, bson.M{"_id": edgeID}).Decode(&edge)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrEdgeNotFound
		}
		return nil, fmt.Errorf("failed to find topology edge: %w", err)
	}
	return &edge, nil
}

// List queries edges with the allowlisted filters and keyset cursor pagination.
func (r *Repository) List(ctx context.Context, filter ListFilter) ([]Edge, *string, bool, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	filterDoc := bson.M{}
	if filter.FromResourceID != "" {
		filterDoc["fromResourceId"] = filter.FromResourceID
	}
	if filter.ToResourceID != "" {
		filterDoc["toResourceId"] = filter.ToResourceID
	}
	if filter.RelationshipType != "" {
		filterDoc["relationshipType"] = filter.RelationshipType
	}
	if filter.LifecycleState != "" {
		filterDoc["lifecycleState"] = filter.LifecycleState
	}

	signature := filterSignature(
		filter.FromResourceID, filter.ToResourceID,
		filter.RelationshipType, filter.LifecycleState,
	)

	if filter.Cursor != "" {
		cursor, err := decodeCursor(filter.Cursor)
		if err != nil {
			return nil, nil, false, err
		}
		if cursor.Signature != signature {
			return nil, nil, false, ErrIncompatibleCursorUse
		}
		filterDoc = combineWithCursor(filterDoc, cursor)
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(limit + 1))

	cursor, err := r.edges.Find(ctx, filterDoc, opts)
	if err != nil {
		return nil, nil, false, fmt.Errorf("failed to query topology edges: %w", err)
	}
	defer cursor.Close(ctx)

	var items []Edge
	for cursor.Next(ctx) {
		var edge Edge
		if err := cursor.Decode(&edge); err != nil {
			return nil, nil, false, fmt.Errorf("failed to decode topology edge: %w", err)
		}
		items = append(items, edge)
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
		encoded, err := encodeCursor(CursorData{UpdatedAt: last.UpdatedAt, ID: last.EdgeID, Signature: signature})
		if err != nil {
			return nil, nil, false, err
		}
		nextCursor = &encoded
	}

	if items == nil {
		items = []Edge{}
	}

	return items, nextCursor, hasMore, nil
}

func combineWithCursor(base bson.M, cursor *CursorData) bson.M {
	cursorFilter := bson.M{
		"$or": []bson.M{
			{"updatedAt": bson.M{"$lt": cursor.UpdatedAt}},
			{"updatedAt": cursor.UpdatedAt, "_id": bson.M{"$gt": cursor.ID}},
		},
	}
	if len(base) == 0 {
		return cursorFilter
	}
	return bson.M{"$and": []bson.M{base, cursorFilter}}
}

// Update performs an atomic CAS replacement of mutable metadata.
func (r *Repository) Update(ctx context.Context, edgeID string, req *UpdateEdgeRequest, actor string) (*Edge, *Edge, error) {
	if !uuidRegex.MatchString(edgeID) {
		return nil, nil, ErrEdgeNotFound
	}

	existing, err := r.GetByID(ctx, edgeID)
	if err != nil {
		return nil, nil, err
	}
	if existing.LifecycleState == LifecycleRetired {
		return nil, nil, ErrEdgeRetired
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}

	now := CurrentTimestamp()
	updateFilter := bson.M{
		"_id":            edgeID,
		"revision":       req.ExpectedRevision,
		"lifecycleState": bson.M{"$ne": LifecycleRetired},
	}
	updateDoc := bson.M{
		"$set": bson.M{
			"description": req.Edge.Description,
			"labels":      req.Edge.Labels,
			"attributes":  req.Edge.Attributes,
			"updatedAt":   now,
			"updatedBy":   actor,
			"revision":    req.ExpectedRevision + 1,
		},
	}

	result, err := r.edges.UpdateOne(ctx, updateFilter, updateDoc)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to update topology edge: %w", err)
	}
	if result.MatchedCount == 0 {
		cur, err := r.GetByID(ctx, edgeID)
		if err != nil {
			return nil, nil, err
		}
		if cur.LifecycleState == LifecycleRetired {
			return nil, nil, ErrEdgeRetired
		}
		return nil, nil, ErrRevisionConflict
	}

	updated, err := r.GetByID(ctx, edgeID)
	if err != nil {
		return nil, nil, err
	}
	return existing, updated, nil
}

// Retire transitions an edge to the terminal retired state using atomic CAS.
func (r *Repository) Retire(ctx context.Context, edgeID string, req *RetireEdgeRequest, actor string) (*Edge, *Edge, error) {
	if !uuidRegex.MatchString(edgeID) {
		return nil, nil, ErrEdgeNotFound
	}

	existing, err := r.GetByID(ctx, edgeID)
	if err != nil {
		return nil, nil, err
	}
	if existing.LifecycleState == LifecycleRetired {
		return nil, nil, ErrEdgeRetired
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}

	now := CurrentTimestamp()
	updateFilter := bson.M{
		"_id":            edgeID,
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

	result, err := r.edges.UpdateOne(ctx, updateFilter, updateDoc)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to retire topology edge: %w", err)
	}
	if result.MatchedCount == 0 {
		cur, err := r.GetByID(ctx, edgeID)
		if err != nil {
			return nil, nil, err
		}
		if cur.LifecycleState == LifecycleRetired {
			return nil, nil, ErrEdgeRetired
		}
		return nil, nil, ErrRevisionConflict
	}

	retired, err := r.GetByID(ctx, edgeID)
	if err != nil {
		return nil, nil, err
	}
	return existing, retired, nil
}

// Neighbors returns strictly ONE HOP of relationships relative to the root.
// No recursive traversal, multi-hop impact analysis or shortest path is
// implemented.
func (r *Repository) Neighbors(ctx context.Context, filter NeighborFilter) (*NeighborsResponse, error) {
	root, err := r.inventory.Resolve(ctx, filter.RootResourceID)
	if err != nil {
		if errors.Is(err, ErrEndpointNotFound) {
			return nil, ErrRootResourceNotFound
		}
		return nil, err
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	rootMatch := bson.M{}
	switch filter.Direction {
	case DirectionOutbound:
		rootMatch["fromResourceId"] = filter.RootResourceID
	case DirectionInbound:
		rootMatch["toResourceId"] = filter.RootResourceID
	default:
		rootMatch["$or"] = []bson.M{
			{"fromResourceId": filter.RootResourceID},
			{"toResourceId": filter.RootResourceID},
		}
	}

	filterDoc := bson.M{"$and": []bson.M{rootMatch}}
	if filter.RelationshipType != "" {
		filterDoc["$and"] = append(filterDoc["$and"].([]bson.M), bson.M{"relationshipType": filter.RelationshipType})
	}
	if filter.LifecycleState != "" {
		filterDoc["$and"] = append(filterDoc["$and"].([]bson.M), bson.M{"lifecycleState": filter.LifecycleState})
	}

	signature := filterSignature(
		filter.RootResourceID, filter.Direction,
		filter.RelationshipType, filter.LifecycleState,
	)

	if filter.Cursor != "" {
		cursor, err := decodeCursor(filter.Cursor)
		if err != nil {
			return nil, err
		}
		if cursor.Signature != signature {
			return nil, ErrIncompatibleCursorUse
		}
		cursorFilter := bson.M{
			"$or": []bson.M{
				{"updatedAt": bson.M{"$lt": cursor.UpdatedAt}},
				{"updatedAt": cursor.UpdatedAt, "_id": bson.M{"$gt": cursor.ID}},
			},
		}
		filterDoc["$and"] = append(filterDoc["$and"].([]bson.M), cursorFilter)
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(limit + 1))

	cursor, err := r.edges.Find(ctx, filterDoc, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to query topology neighbors: %w", err)
	}
	defer cursor.Close(ctx)

	var edges []Edge
	for cursor.Next(ctx) {
		var edge Edge
		if err := cursor.Decode(&edge); err != nil {
			return nil, fmt.Errorf("failed to decode topology edge: %w", err)
		}
		edges = append(edges, edge)
	}
	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("neighbor cursor iteration error: %w", err)
	}

	hasMore := false
	var nextCursor *string
	if len(edges) > limit {
		hasMore = true
		edges = edges[:limit]
		last := edges[limit-1]
		encoded, err := encodeCursor(CursorData{UpdatedAt: last.UpdatedAt, ID: last.EdgeID, Signature: signature})
		if err != nil {
			return nil, err
		}
		nextCursor = &encoded
	}

	neighborIDs := make([]string, 0, len(edges))
	for _, edge := range edges {
		if edge.FromResourceID == filter.RootResourceID {
			neighborIDs = append(neighborIDs, edge.ToResourceID)
		}
		if edge.ToResourceID == filter.RootResourceID {
			neighborIDs = append(neighborIDs, edge.FromResourceID)
		}
	}

	projections, err := r.inventory.ResolveMany(ctx, neighborIDs)
	if err != nil {
		return nil, err
	}

	neighbors := make([]Neighbor, 0, len(edges))
	for _, edge := range edges {
		neighborID := edge.ToResourceID
		direction := DirectionOutbound
		if edge.FromResourceID == filter.RootResourceID {
			neighborID = edge.ToResourceID
			direction = DirectionOutbound
		} else if edge.ToResourceID == filter.RootResourceID {
			neighborID = edge.FromResourceID
			direction = DirectionInbound
		}
		projection, ok := projections[neighborID]
		if !ok {
			projection = ResourceProjection{ResourceID: neighborID, LifecycleState: "unknown"}
		}
		neighbors = append(neighbors, Neighbor{
			Edge:             edge,
			Direction:        direction,
			NeighborResource: projection,
		})
	}

	sort.SliceStable(neighbors, func(i, j int) bool {
		if neighbors[i].Edge.UpdatedAt != neighbors[j].Edge.UpdatedAt {
			return neighbors[i].Edge.UpdatedAt > neighbors[j].Edge.UpdatedAt
		}
		return neighbors[i].Edge.EdgeID < neighbors[j].Edge.EdgeID
	})

	return &NeighborsResponse{
		RootResource: *root,
		Neighbors:    neighbors,
		Page: PageInfo{
			Limit:      limit,
			NextCursor: nextCursor,
			HasMore:    hasMore,
		},
	}, nil
}
