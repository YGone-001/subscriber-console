package tariff

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/user"
)

type deleteGuardLimiter struct{}

func (deleteGuardLimiter) Enforce(http.ResponseWriter, *http.Request, string, int, int) bool {
	return true
}

type deleteGuardUserRepo struct{}

func (deleteGuardUserRepo) FindByUsernameIdentity(_ context.Context, username string) (*user.UserIdentity, error) {
	return &user.UserIdentity{
		SafeUser: user.SafeUser{Username: username, Role: "admin", Status: "active"},
		MongoID:  "usr_" + username,
	}, nil
}

type deleteGuardEvidence struct{}

func (deleteGuardEvidence) Insert(context.Context, audit.AuditWriteRecord) error { return nil }
func (deleteGuardEvidence) FindByMongoID(context.Context, string) (*audit.AuditWriteRecord, error) {
	return nil, nil
}

func TestDelete_RejectsPlanBoundToSubscribers(t *testing.T) {
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Skipf("MongoDB not available at %s: %v", uri, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		t.Skipf("MongoDB ping failed: %v", err)
		return
	}

	dbName := "xcloud_test_tariff_delete_guard"
	plans := client.Database(dbName).Collection("ocs_tariff_plans")
	subs := client.Database(dbName).Collection("ocs_subscribers")
	audits := client.Database(dbName + "_ops").Collection("app_audit_logs")
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_ = client.Database(dbName).Drop(cleanupCtx)
		_ = client.Database(dbName + "_ops").Drop(cleanupCtx)
		_ = client.Disconnect(cleanupCtx)
	}()

	const planID = "plan_delete_guard"
	const imsi = "417019999999991"
	if _, err := plans.InsertOne(context.Background(), bson.M{"plan_id": planID, "name": "Guard plan", "status": "active"}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	if _, err := subs.InsertOne(context.Background(), bson.M{"imsi": imsi, "plan_id": planID, "status": "active"}); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}

	handler := NewWriteHandler(
		NewRepository(plans, subs, audits),
		deleteGuardLimiter{},
		deleteGuardUserRepo{},
		audit.NewWriter(deleteGuardEvidence{}, audit.WriterConfig{}),
	)
	principal := &auth.Principal{
		Username:       "admin",
		Role:           "admin",
		NormalizedRole: auth.NormalizeRole("admin"),
	}
	request := func() *http.Request {
		r := httptest.NewRequest(http.MethodDelete, "/api/tariff-plans/"+planID, nil)
		r.SetPathValue("planId", planID)
		return r.WithContext(auth.ContextWithPrincipal(r.Context(), principal))
	}

	first := httptest.NewRecorder()
	handler.Delete(first, request())
	if first.Code != http.StatusConflict {
		t.Fatalf("delete bound plan status = %d, want 409; body=%s", first.Code, first.Body.String())
	}
	var firstBody map[string]any
	if err := json.NewDecoder(first.Body).Decode(&firstBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if firstBody["code"] != "TARIFF_PLAN_DELETE_IN_USE" {
		t.Fatalf("code = %v, want TARIFF_PLAN_DELETE_IN_USE", firstBody["code"])
	}
	if count, err := plans.CountDocuments(context.Background(), bson.M{"plan_id": planID}); err != nil || count != 1 {
		t.Fatalf("bound plan must remain after refusal, count=%d err=%v", count, err)
	}

	if _, err := subs.DeleteMany(context.Background(), bson.M{"plan_id": planID}); err != nil {
		t.Fatalf("remove binding: %v", err)
	}
	second := httptest.NewRecorder()
	handler.Delete(second, request())
	if second.Code != http.StatusOK {
		t.Fatalf("delete unbound plan status = %d, want 200; body=%s", second.Code, second.Body.String())
	}
	if count, err := plans.CountDocuments(context.Background(), bson.M{"plan_id": planID}); err != nil || count != 0 {
		t.Fatalf("unbound plan should be gone, count=%d err=%v", count, err)
	}
}
