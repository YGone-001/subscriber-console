package user

import (
	"context"
	"fmt"
	"math"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository reads from xcloud_ops.app_users and xcloud_ops.app_audit_logs.
type Repository struct {
	users *mongo.Collection
	audit *mongo.Collection
}

// NewRepository creates a user repository from the xcloud_ops database.
func NewRepository(db *mongo.Database) *Repository {
	return &Repository{
		users: db.Collection("app_users"),
		audit: db.Collection("app_audit_logs"),
	}
}

// FindAll returns all users sorted by username.
func (r *Repository) FindAll(ctx context.Context) ([]SafeUser, error) {
	cursor, err := r.users.Find(ctx, bson.M{}, options.Find().SetSort(bson.D{{Key: "username", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var results []SafeUser
	for cursor.Next(ctx) {
		var doc userDoc
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		results = append(results, toSafeUser(doc))
	}
	if results == nil {
		results = []SafeUser{}
	}
	return results, nil
}

// FindByUsername returns a single safe user or nil.
func (r *Repository) FindByUsername(ctx context.Context, username string) (*SafeUser, error) {
	res := r.users.FindOne(ctx, bson.M{"username": username})
	if err := res.Err(); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	var doc userDoc
	if err := res.Decode(&doc); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	su := toSafeUser(doc)
	return &su, nil
}

// FindByUsernameIdentity returns the full user identity including Mongo _id.
// Used by governance/workflow code that needs the actual Mongo ID for userId.
// Matches Node: userId = String(account._id ?? account.username)
func (r *Repository) FindByUsernameIdentity(ctx context.Context, username string) (*UserIdentity, error) {
	res := r.users.FindOne(ctx, bson.M{"username": username})
	if err := res.Err(); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	var doc userDoc
	if err := res.Decode(&doc); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	su := toSafeUser(doc)
	mongoID := stringifyMongoID(doc.MongoID)
	if mongoID == "" {
		mongoID = su.Username
	}
	return &UserIdentity{SafeUser: su, MongoID: mongoID}, nil
}

// stringifyMongoID converts a Mongo _id to string.
func stringifyMongoID(id interface{}) string {
	if id == nil {
		return ""
	}
	switch v := id.(type) {
	case string:
		return v
	case bson.ObjectID:
		return v.Hex()
	default:
		return fmt.Sprintf("%v", id)
	}
}

// QueryResult holds paginated user query results.
type QueryResult struct {
	Items      []SafeUser `json:"items"`
	Pagination Pagination `json:"pagination"`
	Stats      UserStats  `json:"stats"`
}

// QueryUsers runs a paginated, filtered query against app_users.
// Matches Node queryUsers() contract exactly.
func (r *Repository) QueryUsers(ctx context.Context, q UserQuery) (*QueryResult, error) {
	filter := buildUserFilter(q)

	// Count filtered results for pagination
	filteredTotal, err := r.users.CountDocuments(ctx, filter)
	if err != nil {
		return nil, err
	}

	// Pagination: totalPages = max(1, ceil(total/pageSize)), page = min(requested, totalPages)
	totalPages := int(math.Max(1, math.Ceil(float64(filteredTotal)/float64(q.PageSize))))
	page := int(math.Min(float64(q.Page), float64(totalPages)))

	// Sort field mapping
	sortField := q.Sort
	if sortField == "lastLoginAt" {
		sortField = "security.lastLoginAt"
	}
	sortDir := -1
	if q.Order == "asc" {
		sortDir = 1
	}

	skip := int64((page - 1) * q.PageSize)
	limit := int64(q.PageSize)

	// Find with projection (exclude passwordHash) and stable sort (field + _id tiebreaker)
	cursor, err := r.users.Find(ctx, filter, options.Find().
		SetProjection(bson.M{"passwordHash": 0}).
		SetSort(bson.D{
			{Key: sortField, Value: sortDir},
			{Key: "_id", Value: 1},
		}).
		SetSkip(skip).
		SetLimit(limit))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var items []SafeUser
	for cursor.Next(ctx) {
		var doc userDoc
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		items = append(items, toSafeUser(doc))
	}
	if items == nil {
		items = []SafeUser{}
	}

	// Global stats (not filtered)
	stats, err := r.computeGlobalStats(ctx)
	if err != nil {
		return nil, err
	}

	return &QueryResult{
		Items: items,
		Pagination: Pagination{
			Page:       page,
			PageSize:   q.PageSize,
			Total:      int(filteredTotal),
			TotalPages: totalPages,
		},
		Stats: *stats,
	}, nil
}

// computeGlobalStats returns global user counts matching Node exactly.
func (r *Repository) computeGlobalStats(ctx context.Context) (*UserStats, error) {
	stats := &UserStats{}

	// total = COUNT(all users)
	total, err := r.users.CountDocuments(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	stats.Total = int(total)

	// active = status=active AND locked != true
	active, err := r.users.CountDocuments(ctx, bson.M{
		"status": "active",
		"locked": bson.M{"$ne": true},
	})
	if err != nil {
		return nil, err
	}
	stats.Active = int(active)

	// administrators = role IN [root, super_admin, ops_admin]
	adminRoles := bson.A{"root", "super_admin", "ops_admin"}
	admins, err := r.users.CountDocuments(ctx, bson.M{"role": bson.M{"$in": adminRoles}})
	if err != nil {
		return nil, err
	}
	stats.Administrators = int(admins)

	// locked = status=locked OR locked=true
	locked, err := r.users.CountDocuments(ctx, bson.M{
		"$or": bson.A{
			bson.M{"status": "locked"},
			bson.M{"locked": true},
		},
	})
	if err != nil {
		return nil, err
	}
	stats.Locked = int(locked)

	return stats, nil
}

// ListAuditLogsForUser returns recent audit logs for a user.
// Matches Node listAuditLogsForUser() filter exactly:
// - actor == username
// - actorContext.username == username
// - resource.type == "user" AND resource.id == username
// - targetId == "SYS_USER:" + username
func (r *Repository) ListAuditLogsForUser(ctx context.Context, username string) ([]AuditLog, error) {
	sysUserTarget := "SYS_USER:" + username
	filter := bson.M{
		"$or": bson.A{
			bson.M{"actor": username},
			bson.M{"actorContext.username": username},
			bson.M{"resource.type": "user", "resource.id": username},
			bson.M{"targetId": sysUserTarget},
		},
	}
	cursor, err := r.audit.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "timestamp", Value: -1}}).
		SetLimit(10))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var results []AuditLog
	for cursor.Next(ctx) {
		var doc auditLogDoc
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		results = append(results, toAuditLog(doc))
	}
	if results == nil {
		results = []AuditLog{}
	}
	return results, nil
}

// UserQuery holds parsed query parameters.
type UserQuery struct {
	Page     int
	PageSize int
	Search   string
	Role     string
	Status   string
	Sort     string
	Order    string
}

// buildUserFilter constructs a MongoDB filter from the query.
// Matches Node queryUsers() filter logic exactly.
func buildUserFilter(q UserQuery) bson.M {
	filter := bson.M{}

	// Role filter: root and super_admin both expand to $in
	if q.Role != "" {
		if q.Role == "root" || q.Role == "super_admin" {
			filter["role"] = bson.M{"$in": bson.A{"root", "super_admin"}}
		} else {
			filter["role"] = q.Role
		}
	}

	// Status filter: locked is special (status=locked OR locked=true)
	if q.Status != "" {
		if q.Status == "locked" {
			filter["$or"] = bson.A{
				bson.M{"status": "locked"},
				bson.M{"locked": true},
			}
		} else {
			// active or disabled: status matches AND not locked
			filter["status"] = q.Status
			filter["locked"] = bson.M{"$ne": true}
		}
	}

	// Search filter: escaped regex on username and displayName only
	if q.Search != "" {
		escaped := escapeUserSearch(q.Search)
		filter["$and"] = bson.A{
			bson.M{
				"$or": bson.A{
					bson.M{"username": bson.M{"$regex": escaped, "$options": "i"}},
					bson.M{"displayName": bson.M{"$regex": escaped, "$options": "i"}},
				},
			},
		}
	}

	return filter
}
