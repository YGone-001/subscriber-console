package subscriber

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
)

// recordingEvidenceStore captures every audit record so a test can inspect the serialized
// content for credential values. Section 55 requires checking the actual written values rather than
// asserting that a schema field is absent.
type recordingEvidenceStore struct {
	records []audit.AuditWriteRecord
}

func (r *recordingEvidenceStore) Insert(_ context.Context, rec audit.AuditWriteRecord) error {
	r.records = append(r.records, rec)
	return nil
}

func (r *recordingEvidenceStore) FindByMongoID(_ context.Context, _ string) (*audit.AuditWriteRecord, error) {
	return nil, nil
}

func (r *recordingEvidenceStore) serialized() string {
	data, _ := json.Marshal(r.records)
	return string(data)
}

// readSecurity loads the persisted security block straight from MongoDB.
//
// Nested documents come back as bson.D from the driver, so the block is flattened into a plain
// map before assertions. A null field is present with a nil value - which is the distinction the
// OP / OPc mapping depends on, so absent and null must not be conflated.
func readSecurity(t *testing.T, repo *Repository, imsi string) map[string]any {
	t.Helper()
	doc, err := repo.FindSubscriberByImsi(context.Background(), imsi)
	if err != nil {
		t.Fatalf("reload subscriber %s: %v", imsi, err)
	}
	if doc == nil {
		t.Fatalf("subscriber %s not found", imsi)
	}

	raw, ok := doc["security"]
	if !ok {
		t.Fatalf("subscriber %s has no security block", imsi)
	}

	out := map[string]any{}
	switch sec := raw.(type) {
	case bson.D:
		for _, e := range sec {
			out[e.Key] = e.Value
		}
	case bson.M:
		for k, v := range sec {
			out[k] = v
		}
	default:
		t.Fatalf("unexpected security block type %T", raw)
	}
	return out
}

// securitySQN normalizes the persisted SQN, which the driver may surface as int32 or int64.
func securitySQN(t *testing.T, sec map[string]any) int64 {
	t.Helper()
	switch v := sec["sqn"].(type) {
	case int64:
		return v
	case int32:
		return int64(v)
	case int:
		return int64(v)
	default:
		t.Fatalf("unexpected sqn type %T (%v)", sec["sqn"], sec["sqn"])
		return 0
	}
}

// --- Section 50: repository persistence exact mapping ---

func TestCreateSubscriberWithAuthentication_OPcModePersistsExactSecurity(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	auth, err := ParseCreateAuthenticationMaterial(map[string]any{
		"k": "00112233445566778899aabbccddeeff", "opc": "aabbccddeeff00112233445566778899",
		"amf": "8000", "sqn": 0,
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	const imsi = "417010000000001"
	if _, err := repo.CreateSubscriberWithAuthentication(context.Background(), imsi, nil, nil, auth); err != nil {
		t.Fatalf("create: %v", err)
	}

	sec := readSecurity(t, repo, imsi)
	if sec["k"] != "00112233445566778899AABBCCDDEEFF" {
		t.Errorf("security.k = %v", sec["k"])
	}
	if sec["op"] != nil {
		t.Errorf("security.op must be null in OPc mode, got %v", sec["op"])
	}
	if sec["opc"] != "AABBCCDDEEFF00112233445566778899" {
		t.Errorf("security.opc = %v", sec["opc"])
	}
	if sec["amf"] != "8000" {
		t.Errorf("security.amf = %v", sec["amf"])
	}
	if got := securitySQN(t, sec); got != 0 {
		t.Errorf("security.sqn = %d, want 0", got)
	}
}

func TestCreateSubscriberWithAuthentication_OPModePersistsExactSecurity(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	auth, err := ParseCreateAuthenticationMaterial(map[string]any{
		"k": testK, "op": "ffeeddccbbaa99887766554433221100", "amf": "8a0b", "sqn": 1719756,
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	const imsi = "417010000000002"
	if _, err := repo.CreateSubscriberWithAuthentication(context.Background(), imsi, nil, nil, auth); err != nil {
		t.Fatalf("create: %v", err)
	}

	sec := readSecurity(t, repo, imsi)
	if sec["k"] != testK {
		t.Errorf("security.k = %v", sec["k"])
	}
	if sec["op"] != "FFEEDDCCBBAA99887766554433221100" {
		t.Errorf("security.op = %v", sec["op"])
	}
	if sec["opc"] != nil {
		t.Errorf("security.opc must be null in OP mode, got %v", sec["opc"])
	}
	if sec["amf"] != "8A0B" {
		t.Errorf("security.amf = %v (must be canonical uppercase)", sec["amf"])
	}
	if got := securitySQN(t, sec); got != 1719756 {
		t.Errorf("security.sqn = %d, want 1719756", got)
	}
}

// TestCreateSubscriber_LegacyDefaultsWhenAuthAbsent is the backward compatibility proof at the
// persistence layer: no auth4G keeps the server defaults byte for byte.
func TestCreateSubscriber_LegacyDefaultsWhenAuthAbsent(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	const imsi = "417010000000003"
	if _, err := repo.CreateSubscriberFromLegacy(context.Background(), imsi, nil, nil); err != nil {
		t.Fatalf("create: %v", err)
	}

	sec := readSecurity(t, repo, imsi)
	if sec["k"] != "000102030405060708090A0B0C0D0E0F" {
		t.Errorf("default k changed: %v", sec["k"])
	}
	if sec["op"] != nil {
		t.Errorf("default op changed: %v", sec["op"])
	}
	if sec["opc"] != "00000000000000000000000000000000" {
		t.Errorf("default opc changed: %v", sec["opc"])
	}
	if sec["amf"] != "8000" {
		t.Errorf("default amf changed: %v", sec["amf"])
	}
	if got := securitySQN(t, sec); got != 1719756 {
		t.Errorf("default sqn changed: %d", got)
	}
}

// --- Section 51: lab credential reuse ---

// TestCreateSubscriber_LabCredentialReuseAcrossImsis proves there is no unintended uniqueness
// enforcement on K / OPc / AMF / SQN. Two different IMSIs may carry identical authentication
// material in the current lab environment.
func TestCreateSubscriber_LabCredentialReuseAcrossImsis(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	shared := map[string]any{
		"k": "00112233445566778899AABBCCDDEEFF", "opc": "AABBCCDDEEFF00112233445566778899",
		"amf": "8000", "sqn": 0,
	}

	for _, imsi := range []string{"417010000000011", "417010000000012"} {
		auth, err := ParseCreateAuthenticationMaterial(shared)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if _, err := repo.CreateSubscriberWithAuthentication(context.Background(), imsi, nil, nil, auth); err != nil {
			t.Fatalf("create %s must succeed with reused credentials: %v", imsi, err)
		}
	}

	first := readSecurity(t, repo, "417010000000011")
	second := readSecurity(t, repo, "417010000000012")
	for _, field := range []string{"k", "opc", "amf", "sqn"} {
		if first[field] != second[field] {
			t.Errorf("field %s differs between IMSIs: %v vs %v", field, first[field], second[field])
		}
	}
	if first["k"] != "00112233445566778899AABBCCDDEEFF" {
		t.Errorf("reused k not persisted as supplied: %v", first["k"])
	}
}

// --- Sections 53, 56, and 57: HTTP create with auth4G ---

func newCreateHandler(t *testing.T, store *recordingEvidenceStore) (*WriteHandler, *Repository, func()) {
	t.Helper()
	repo, cleanup := ocsTestRepo(t)
	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: audit.NewWriter(store, audit.WriterConfig{}),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "admin"),
		},
	}
	return h, repo, cleanup
}

func postCreate(t *testing.T, h *WriteHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "admin"))
	w := httptest.NewRecorder()
	h.Create(w, r)
	return w
}

// TestHandleCreate_WithAuth4G_PersistsAndReturns201 is the real HTTP integration proof: the
// request goes through the handler, the subscriber is inserted, and the persisted document is
// loaded back from MongoDB to check the exact values.
func TestHandleCreate_WithAuth4G_PersistsAndReturns201(t *testing.T) {
	store := &recordingEvidenceStore{}
	h, repo, cleanup := newCreateHandler(t, store)
	defer cleanup()

	body := `{"imsi":"417010000000021","auth4G":{"k":"00112233445566778899aabbccddeeff",` +
		`"opc":"aabbccddeeff00112233445566778899","amf":"8000","sqn":0}}`

	w := postCreate(t, h, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", w.Code, w.Body.String())
	}

	sec := readSecurity(t, repo, "417010000000021")
	if sec["k"] != "00112233445566778899AABBCCDDEEFF" {
		t.Errorf("persisted k = %v", sec["k"])
	}
	if sec["opc"] != "AABBCCDDEEFF00112233445566778899" {
		t.Errorf("persisted opc = %v", sec["opc"])
	}
	if sec["op"] != nil {
		t.Errorf("persisted op must be null, got %v", sec["op"])
	}
	if got := securitySQN(t, sec); got != 0 {
		t.Errorf("persisted sqn = %d", got)
	}
}

// TestHandleCreate_ResponseDoesNotLeakCredentials covers Section 56.
func TestHandleCreate_ResponseDoesNotLeakCredentials(t *testing.T) {
	store := &recordingEvidenceStore{}
	h, _, cleanup := newCreateHandler(t, store)
	defer cleanup()

	const kSentinel = "11111111111111111111111111111111"
	const opcSentinel = "22222222222222222222222222222222"
	body := `{"imsi":"417010000000022","auth4G":{"k":"` + kSentinel + `","opc":"` + opcSentinel + `","amf":"8000","sqn":7}}`

	w := postCreate(t, h, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", w.Code, w.Body.String())
	}

	payload := w.Body.String()
	if strings.Contains(payload, kSentinel) {
		t.Errorf("create response leaks K: %s", payload)
	}
	if strings.Contains(payload, opcSentinel) {
		t.Errorf("create response leaks OPc: %s", payload)
	}
	if strings.Contains(strings.ToLower(payload), `"security"`) {
		t.Errorf("create response contains a security object: %s", payload)
	}
}

// TestHandleCreate_AuditDoesNotLeakCredentials covers Section 55. The sentinel values are searched for in
// the serialized audit records, not merely asserted absent from a schema.
func TestHandleCreate_AuditDoesNotLeakCredentials(t *testing.T) {
	store := &recordingEvidenceStore{}
	h, _, cleanup := newCreateHandler(t, store)
	defer cleanup()

	const kSentinel = "11111111111111111111111111111111"
	const opcSentinel = "22222222222222222222222222222222"
	body := `{"imsi":"417010000000023","auth4G":{"k":"` + kSentinel + `","opc":"` + opcSentinel + `","amf":"8000","sqn":7}}`

	if w := postCreate(t, h, body); w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", w.Code, w.Body.String())
	}
	if len(store.records) == 0 {
		t.Fatal("expected at least one audit record")
	}

	serialized := store.serialized()
	if strings.Contains(serialized, kSentinel) {
		t.Errorf("audit record leaks K: %s", serialized)
	}
	if strings.Contains(serialized, opcSentinel) {
		t.Errorf("audit record leaks OPc: %s", serialized)
	}
	// The non-secret provisioning facts are allowed and expected.
	if !strings.Contains(serialized, "operator_supplied") {
		t.Errorf("audit should record authenticationProvisioning=operator_supplied: %s", serialized)
	}
}

// TestHandleCreate_InvalidAuth4G_CreatesNothing covers Section 57.
func TestHandleCreate_InvalidAuth4G_CreatesNothing(t *testing.T) {
	store := &recordingEvidenceStore{}
	h, repo, cleanup := newCreateHandler(t, store)
	defer cleanup()

	cases := []struct {
		name string
		auth string
	}{
		{"k too short", `{"k":"0011","opc":"` + testOPc + `","amf":"8000","sqn":0}`},
		{"both op and opc", `{"k":"` + testK + `","op":"` + testOP + `","opc":"` + testOPc + `","amf":"8000","sqn":0}`},
		{"neither op nor opc", `{"k":"` + testK + `","amf":"8000","sqn":0}`},
		{"unknown field", `{"k":"` + testK + `","opc":"` + testOPc + `","amf":"8000","sqn":0,"password":"x"}`},
		{"amf too short", `{"k":"` + testK + `","opc":"` + testOPc + `","amf":"80","sqn":0}`},
		{"sqn negative", `{"k":"` + testK + `","opc":"` + testOPc + `","amf":"8000","sqn":-1}`},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			imsi := "4170100000001" + string(rune('0'+i))
			w := postCreate(t, h, `{"imsi":"`+imsi+`","auth4G":`+tc.auth+`}`)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), tc.auth) {
				t.Errorf("error response echoes the supplied auth block: %s", w.Body.String())
			}

			doc, err := repo.FindSubscriberByImsi(context.Background(), imsi)
			if err != nil {
				t.Fatalf("lookup: %v", err)
			}
			if doc != nil {
				t.Errorf("subscriber %s must not exist after invalid credential input", imsi)
			}
		})
	}
}

// TestHandleCreate_AuthAbsentStillWorks is the HTTP-level backward compatibility check.
func TestHandleCreate_AuthAbsentStillWorks(t *testing.T) {
	store := &recordingEvidenceStore{}
	h, repo, cleanup := newCreateHandler(t, store)
	defer cleanup()

	w := postCreate(t, h, `{"imsi":"417010000000031","msisdn":"963932000031"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", w.Code, w.Body.String())
	}

	sec := readSecurity(t, repo, "417010000000031")
	if sec["k"] != "000102030405060708090A0B0C0D0E0F" {
		t.Errorf("legacy default k changed: %v", sec["k"])
	}

	serialized := store.serialized()
	if !strings.Contains(serialized, "server_default") {
		t.Errorf("audit should record authenticationProvisioning=server_default: %s", serialized)
	}
}
