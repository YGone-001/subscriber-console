package user

import (
	"context"
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

// QueryResult holds paginated user query results.
type QueryResult struct {
	Items      []SafeUser `json:"items"`
	Pagination Pagination `json:"pagination"`
	Stats      UserStats  `json:"stats"`
}

// QueryUsers runs a paginated, filtered query against app_users.
func (r *Repository) QueryUsers(ctx context.Context, q UserQuery) (*QueryResult, error) {
	filter := buildUserFilter(q)

	total, err := r.users.CountDocuments(ctx, filter)
	if err != nil {
		return nil, err
	}

	sortDir := 1
	if q.Order == "desc" {
		sortDir = -1
	}
	sortField := q.Sort
	if sortField == "lastLoginAt" {
		sortField = "security.lastLoginAt"
	}

	skip := int64((q.Page - 1) * q.PageSize)
	limit := int64(q.PageSize)

	cursor, err := r.users.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: sortField, Value: sortDir}}).
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

	// Stats
	stats, err := r.computeStats(ctx)
	if err != nil {
		return nil, err
	}
	stats.Total = int(total)

	totalPages := int(math.Ceil(float64(total) / float64(q.PageSize)))

	return &QueryResult{
		Items: items,
		Pagination: Pagination{
			Page:       q.Page,
			PageSize:   q.PageSize,
			Total:      int(total),
			TotalPages: totalPages,
		},
		Stats: *stats,
	}, nil
}

func (r *Repository) computeStats(ctx context.Context) (*UserStats, error) {
	stats := &UserStats{}

	active, err := r.users.CountDocuments(ctx, bson.M{"status": "active"})
	if err != nil {
		return nil, err
	}
	stats.Active = int(active)

	adminRoles := bson.A{"root", "super_admin", "ops_admin"}
	admins, err := r.users.CountDocuments(ctx, bson.M{"role": bson.M{"$in": adminRoles}})
	if err != nil {
		return nil, err
	}
	stats.Administrators = int(admins)

	locked, err := r.users.CountDocuments(ctx, bson.M{"locked": true})
	if err != nil {
		return nil, err
	}
	stats.Locked = int(locked)

	return stats, nil
}

// ListAuditLogsForUser returns recent audit logs for a user (as actor or target).
func (r *Repository) ListAuditLogsForUser(ctx context.Context, username string) ([]AuditLog, error) {
	filter := bson.M{
		"$or": bson.A{
			bson.M{"actor": username},
			bson.M{"resource.id": username},
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

func buildUserFilter(q UserQuery) bson.M {
	filter := bson.M{}

	if q.Role != "" {
		if q.Role == "super_admin" {
			filter["role"] = bson.M{"$in": bson.A{"root", "super_admin"}}
		} else {
			filter["role"] = q.Role
		}
	}

	if q.Status != "" {
		filter["status"] = q.Status
	}

	if q.Search != "" {
		filter["$or"] = bson.A{
			bson.M{"username": bson.M{"$regex": q.Search, "$options": "i"}},
			bson.M{"displayName": bson.M{"$regex": q.Search, "$options": "i"}},
			bson.M{"email": bson.M{"$regex": q.Search, "$options": "i"}},
		}
	}

	return filter
}
