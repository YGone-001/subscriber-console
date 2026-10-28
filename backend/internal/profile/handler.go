package profile

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/credential"
	"subscriber/internal/middleware"
	"subscriber/internal/response"
	"subscriber/internal/subscriber"
)

var validProfileName = regexp.MustCompile(`^[a-zA-Z0-9_\s-]+$`)

// newProfileName is the creation-time policy: no tab or newline, no leading or
// trailing space, and bounded length. The read path keeps the historical
// pattern so an existing odd-named template stays reachable.
var newProfileName = regexp.MustCompile(`^[a-zA-Z0-9_-](?:[a-zA-Z0-9_ -]{0,62}[a-zA-Z0-9_-])?$`)

// reservedProfileName is an SPA route segment a template key would shadow: the
// detail route is /profile/:name, so a template named "new" could never open.
var reservedProfileName = regexp.MustCompile(`(?i)^new$`)

func validNewProfileName(name string) bool {
	return newProfileName.MatchString(name) && !reservedProfileName.MatchString(name)
}

// cloneProfileFields are the content fields a clone copies verbatim. Identity,
// timestamps and the write counter are rebuilt instead.
var cloneProfileFields = []string{
	"description", "auth", "ambr", "access_restriction_data", "sliceList", "ocsDefaults",
}

// exportFilename keeps a download name inside the characters a Content-Disposition
// header may carry unquoted; the stored key itself is never rewritten.
func exportFilename(name string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '_'
		}
	}, name)
}

// ProfileReader defines the read interface for profile data.
type ProfileReader interface {
	ListProfiles(ctx context.Context, order ProfileListOrder) ([]ProfileListItem, ProfileSummary, error)
	GetProfile(ctx context.Context, name string) (bson.M, error)
	GetProfileVersion(ctx context.Context, profileName, versionId string) (bson.M, error)
	GetProfileStats(ctx context.Context, name string) (ProfileStats, error)
	ListProfileVersions(ctx context.Context, name string, limit int) ([]ProfileVersionSummary, error)
	// ListSubscribersAttributedTo and ListSubscribersByImsis back the drift probe.
	// They return whole documents for in-memory comparison only, bounded.
	ListSubscribersAttributedTo(ctx context.Context, profileName string, limit int) ([]bson.M, error)
	ListSubscribersByImsis(ctx context.Context, imsis []string, limit int) ([]bson.M, error)
}

// ProfileWriter defines the write interface for profile data.
type ProfileWriter interface {
	InsertProfileCreateOnly(ctx context.Context, doc bson.M) error
	ReplaceProfileCAS(ctx context.Context, name string, expected bson.M, updated bson.M) error
	DeleteProfileCAS(ctx context.Context, name string, expected bson.M) error
	SaveProfileVersion(ctx context.Context, record bson.M) error
	CountSubscribersByProfile(ctx context.Context, profileName string) (int64, error)
}

// ProfileReadWriter combines read and write interfaces.
type ProfileReadWriter interface {
	ProfileReader
	ProfileWriter
}

// AuditWriter defines the interface for writing audit records.
type AuditWriter interface {
	WriteBestEffort(input audit.WriteAuditInput)
	WriteStrict(ctx context.Context, input audit.WriteAuditInput) error
}

// RateLimiter defines the interface for rate limiting.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// Handler provides HTTP handlers for profile endpoints.
type Handler struct {
	repo    ProfileReadWriter
	limiter RateLimiter
	audit   AuditWriter
	// denials receives authorization-denied evidence for the read permission
	// gate. It is the concrete audit writer; nil only in unit tests.
	denials *audit.Writer
	// userRepo backs the fresh-actor revalidation on every template write. It is
	// wired after construction; an unwired handler fails closed.
	userRepo UserRepository
}

// UseUserRepository wires the account store the write endpoints revalidate the
// actor against.
func (h *Handler) UseUserRepository(repo UserRepository) { h.userRepo = repo }

// NewHandler creates a new profile Handler. The optional denial writer records
// read-permission refusals; unit tests may omit it.
func NewHandler(repo ProfileReadWriter, limiter RateLimiter, auditWriter AuditWriter, denials ...*audit.Writer) *Handler {
	h := &Handler{repo: repo, limiter: limiter, audit: auditWriter}
	if len(denials) > 0 {
		h.denials = denials[0]
	}
	return h
}

// maskedCredential is the placeholder this projection replaced: a string that
// looks like a key can be displayed as one, compared as one, stored as one, and
// copied into a subscriber by a governed apply. It is no longer emitted, and it
// is never accepted as write input.
const maskedCredential = "[MASKED]"

var credentialKeys = []string{"k", "op", "opc"}

// carriesMaskedCredential reports whether a document holds the retired
// placeholder in a credential field. The sentinel is never real material, so it
// is not a legal value in any document that becomes a live template.
func carriesMaskedCredential(doc any) bool {
	material := fieldOf(doc, "auth")
	if material == nil {
		return false
	}
	for _, key := range credentialKeys {
		if text, _ := fieldOf(material, key).(string); text == maskedCredential {
			return true
		}
	}
	return false
}

// projectCredentialState describes the auth block of a decoded profile document
// for its reader and withholds the material itself when the reader may not see
// it. The state rides inside the block so the response keeps its stored section
// shape; the block is rebuilt as a whole because bson.D cannot grow in place,
// and the state is computed before deletion because presence is what it reports.
func projectCredentialState(doc any, canSeeMaterial bool) {
	stored := asDocument(fieldOf(doc, "auth"))
	if stored == nil {
		return
	}
	visibility := credential.VisibilityMasked
	if canSeeMaterial {
		visibility = credential.VisibilityPlaintext
	}

	projected := bson.M{}
	for key, value := range stored {
		if key == credential.StateKey || (!canSeeMaterial && credential.IsMaterial(key)) {
			continue
		}
		projected[key] = value
	}
	projected[credential.StateKey] = credential.Describe(map[string]any(stored), visibility)

	replaceFieldOf(doc, "auth", projected)
}

// List handles GET /api/profiles
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "profiles.read", h.denials) {
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:list:"+p.Username, 90, 60) {
		return
	}

	// Only sort and order are read; every other query parameter stays ignored,
	// as it has been, so a client cannot be newly refused for input this
	// endpoint always tolerated.
	query := r.URL.Query()
	order, orderErr := parseProfileListOrder(query.Get("sort"), query.Get("order"))
	if orderErr != nil {
		response.BadRequest(w, orderErr.Error(), "INVALID_QUERY_PARAMETER")
		return
	}

	profiles, summary, err := h.repo.ListProfiles(r.Context(), order)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileListResponse{
		Profiles: profiles,
		Summary:  summary,
	})
}

// Meta handles GET /api/profiles/meta.
func (h *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// The meta payload carries the credential-visibility decision, so it is a
	// template read and gated as one, like every other profile read.
	if !audit.RequirePermissionWithAudit(w, r, p, "profiles.read", h.denials) {
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:meta:"+p.Username, 120, 60) {
		return
	}

	_, canRestore := auth.CapabilityDecision(p, "profile_rollback")
	credentialVisibility := "masked"
	plaintext := auth.HasPermission(p, "subscribers.write")
	if plaintext {
		credentialVisibility = "plaintext"
	}
	canWrite := auth.HasPermission(p, "profiles.write")

	response.JSON(w, http.StatusOK, ProfileMetaResponse{
		Capabilities: ProfileCapabilities{
			CanWrite:             canWrite,
			CanRestore:           canRestore,
			CredentialVisibility: credentialVisibility,
			CanEditCredentials:   canWrite && plaintext,
		},
		AccessRestriction: ProfileAccessRestrictionMeta{
			Unrestricted: 0,
			Suspended:    255,
			Bits: []ProfileAccessRestrictionBit{
				{Value: 128, Key: "nr"},
				{Value: 16, Key: "eutran"},
				{Value: 1, Key: "utran"},
				{Value: 2, Key: "geran"},
				{Value: 32, Key: "non3gpp"},
				{Value: 4, Key: "gan"},
				{Value: 8, Key: "ihspa"},
				{Value: 64, Key: "nbiot"},
			},
		},
	})
}

// Get handles GET /api/profiles/:name
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "profiles.read", h.denials) {
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:detail:"+p.Username, 120, 60) {
		return
	}

	profile, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}
	if profile == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Profile not found"})
		return
	}

	// Same predicate as the credentialVisibility capability bit served by Meta:
	// template plaintext is provisioning material, so the subscriber write
	// permission decides visibility, aligned with the subscriber detail
	// auth4G projection.
	projectCredentialState(profile, auth.HasPermission(p, "subscribers.write"))

	// Templates written before the write counter existed carry no revision at
	// all, which left a client holding nothing to precondition on: its save was
	// unconditionally last-write-wins. Projecting the counter as a number keeps
	// the detail consistent with versions' current.revision and makes the
	// compare-and-swap guard live from the first edit, without touching the
	// stored document.
	profile["revision"] = profileRevision(profile)

	stats, err := h.repo.GetProfileStats(r.Context(), name)
	if err != nil {
		// The template itself was read fine; only the attribution failed. Keep
		// the detail available and mark the statistics unavailable.
		response.JSON(w, http.StatusOK, ProfileDetailResponse{
			Profile:           profile,
			StatsCompleteness: SubscriberStatsUnavailable,
		})
		return
	}

	response.JSON(w, http.StatusOK, ProfileDetailResponse{
		Profile:           profile,
		Stats:             &stats,
		StatsCompleteness: SubscriberStatsComplete,
	})
}

// Stats handles GET /api/profiles/:name/stats
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "profiles.read", h.denials) {
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:stats:"+p.Username, 120, 60) {
		return
	}

	// Check profile exists
	profile, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}
	if profile == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Profile not found"})
		return
	}

	stats, err := h.repo.GetProfileStats(r.Context(), name)
	if err != nil {
		// The template exists; only the subscriber attribution failed. Report it
		// as unavailable rather than failing the read or serving zeroes.
		response.JSON(w, http.StatusOK, ProfileStatsResponse{Completeness: SubscriberStatsUnavailable})
		return
	}

	response.JSON(w, http.StatusOK, ProfileStatsResponse{Stats: &stats, Completeness: SubscriberStatsComplete})
}

// Versions handles GET /api/profiles/:name/versions
func (h *Handler) Versions(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "profiles.read", h.denials) {
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:versions:"+p.Username, 120, 60) {
		return
	}

	// Detail branch: callers that pass no versionId keep the list contract.
	if versionID := r.URL.Query().Get("versionId"); versionID != "" {
		version, err := h.repo.GetProfileVersion(r.Context(), name, versionID)
		if err != nil {
			response.InternalError(w)
			return
		}
		if version == nil {
			response.JSON(w, http.StatusNotFound, map[string]string{"error": "Profile version not found"})
			return
		}
		delete(version, "_id")
		// The snapshot embeds the full stored profile, credentials included.
		projectCredentialState(version["profile"], auth.HasPermission(p, "subscribers.write"))
		response.JSON(w, http.StatusOK, ProfileVersionDetailResponse{Version: version})
		return
	}

	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	// Get current profile summary
	currentProfile, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}

	var currentSummary *ProfileCurrentSummary
	if currentProfile != nil {
		cs := ProfileCurrentSummary{
			Title: name,
		}
		if t, ok := currentProfile["title"].(string); ok && t != "" {
			cs.Title = t
		}
		cs.UpdatedAt = firstNonNullDate(currentProfile, "updatedAt", "createdAt")
		cs.UpdatedBy = firstStringField(currentProfile, "updatedBy", "createdBy")
		cs.SliceCount = sliceCount(currentProfile)
		cs.Revision = profileRevision(currentProfile)
		currentSummary = &cs
	}

	versions, err := h.repo.ListProfileVersions(r.Context(), name, limit)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileVersionsResponse{
		Versions:      versions,
		Current:       currentSummary,
		ProfileExists: currentProfile != nil,
	})
}

// ── Write Handlers ──────────────────────────────────────────────────────────

// profileDriftLimit bounds one drift probe so a template with a large
// population cannot turn a read into an unbounded scan.
const profileDriftLimit = 200

var validImsiDigits = regexp.MustCompile(`^[0-9]{15}$`)

// DriftPrecheck handles POST /api/profiles/:name/drift-precheck.
//
// It is a semantic read: it compares each linked subscriber's stored
// provisioning with the document the governed apply would produce, using the
// same projection, and writes nothing. Because it must read subscriber
// authentication material to answer, it is gated on the subscriber write
// capability — the same predicate that decides whether template credentials are
// plaintext — rather than on the template read permission alone.
func (h *Handler) DriftPrecheck(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "profiles.read", h.denials) {
		return
	}
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.denials) {
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:drift:"+p.Username, 30, 60) {
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	var body ProfileDriftRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			response.BadRequest(w, "Invalid request body", "INVALID_REQUEST")
			return
		}
	}
	if len(body.Imsis) > profileDriftLimit {
		response.Error(w, http.StatusBadRequest, fmt.Sprintf("At most %d IMSIs may be probed at once", profileDriftLimit), "DRIFT_LIMIT_EXCEEDED")
		return
	}
	for _, imsi := range body.Imsis {
		if !validImsiDigits.MatchString(imsi) {
			response.Error(w, http.StatusBadRequest, "Invalid IMSI format", "INVALID_IMSI")
			return
		}
	}

	profile, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}
	if profile == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Profile not found"})
		return
	}

	var docs []bson.M
	if len(body.Imsis) > 0 {
		docs, err = h.repo.ListSubscribersByImsis(r.Context(), body.Imsis, profileDriftLimit)
	} else {
		docs, err = h.repo.ListSubscribersAttributedTo(r.Context(), name, profileDriftLimit)
	}
	if err != nil {
		response.InternalError(w)
		return
	}

	truncated := len(docs) > profileDriftLimit
	if truncated {
		docs = docs[:profileDriftLimit]
	}

	resp := ProfileDriftResponse{
		ProfileName: name,
		Truncated:   truncated,
		Results:     make([]ProfileDriftEntry, 0, len(docs)),
	}
	seen := make(map[string]bool, len(docs))
	for _, doc := range docs {
		imsi, _ := doc["imsi"].(string)
		state, changed := subscriber.ProfileDrift(doc, profile, name)
		if imsi == "" {
			// A document without a usable IMSI cannot be attributed; report it
			// rather than silently dropping it.
			state = DriftStateUnknown
		}
		seen[imsi] = true
		resp.Checked++
		switch state {
		case subscriber.DriftInSync:
			resp.InSync++
		case DriftStateUnknown:
			resp.Unknown++
		default:
			resp.Changed++
		}
		resp.Results = append(resp.Results, ProfileDriftEntry{Imsi: imsi, State: state, Changed: changed})
	}
	// An explicitly requested IMSI with no document is unknown, never in sync.
	for _, imsi := range body.Imsis {
		if seen[imsi] {
			continue
		}
		resp.Checked++
		resp.Unknown++
		resp.Results = append(resp.Results, ProfileDriftEntry{Imsi: imsi, State: DriftStateUnknown})
	}

	response.JSON(w, http.StatusOK, resp)
}

// Clone handles POST /api/profiles/:name/clone
// It copies the source template into a new key in one write, producing a single
// CREATE snapshot. The source is left untouched.
func (h *Handler) Clone(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !auth.HasPermission(p, "profiles.write") {
		audit.RecordPermissionDenied(h.denials, r, p, audit.DenialMetadata{Permission: "profiles.write"})
		response.Forbidden(w, "Insufficient permissions")
		return
	}
	if _, actorErr := RevalidateFreshActor(r.Context(), h.userRepo, p); actorErr != nil {
		response.Error(w, actorErr.Status, actorErr.Message, actorErr.Code)
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:clone:"+p.Username, 20, 60) {
		return
	}

	sourceName := r.PathValue("name")
	if !validProfileName.MatchString(sourceName) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	var body struct {
		Name  string `json:"name"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.BadRequest(w, "Invalid request body", "INVALID_REQUEST")
		return
	}
	target := strings.TrimSpace(body.Name)
	if !validNewProfileName(target) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}
	if target == sourceName {
		response.Error(w, http.StatusBadRequest, "The clone target must differ from the source", "PROFILE_CLONE_TARGET_SAME")
		return
	}

	source, err := h.repo.GetProfile(r.Context(), sourceName)
	if err != nil {
		response.InternalError(w)
		return
	}
	if source == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Profile not found"})
		return
	}

	now := nowProfileTime()
	doc := bson.M{
		"name":      target,
		"title":     target,
		"createdAt": now,
		"createdBy": p.Username,
		"updatedAt": now,
		"updatedBy": p.Username,
		"revision":  int64(1),
	}
	for _, field := range cloneProfileFields {
		if value, ok := source[field]; ok {
			doc[field] = value
		}
	}
	if title := strings.TrimSpace(body.Title); title != "" {
		// The display title defaults to the new key rather than copying the
		// source's, so two templates never share one name on screen.
		doc["title"] = title
	}

	if err := h.repo.InsertProfileCreateOnly(r.Context(), doc); err != nil {
		if err == ErrProfileExists {
			response.Error(w, http.StatusConflict, "Profile already exists", "PROFILE_EXISTS")
			return
		}
		h.writeStrictAudit(r.Context(), "PROFILE_CLONE", "profile", target, p.Username, p.NormalizedRole, nil, nil, "failed", "FAILED_NO_MUTATION", false, err)
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile creation failed",
			"code":      "PROFILE_CREATE_FAILED",
			"committed": false,
		})
		return
	}

	versionRecord := bson.M{
		"versionId":   generateVersionID(),
		"profileName": target,
		"profile":     doc,
		"action":      "CREATE",
		"savedAt":     now,
		"savedBy":     p.Username,
		"title":       firstStringField(doc, "title", "name"),
		"sliceCount":  sliceCount(doc),
	}
	if err := h.repo.SaveProfileVersion(r.Context(), versionRecord); err != nil {
		h.writeStrictAudit(r.Context(), "PROFILE_CLONE", "profile", target, p.Username, p.NormalizedRole, nil, doc, "failed", "PARTIAL_WRITE", true, err)
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile created but version save failed",
			"code":      "PROFILE_CREATE_PARTIAL_WRITE",
			"committed": true,
		})
		return
	}

	h.writeStrictAudit(r.Context(), "PROFILE_CLONE", "profile", target, p.Username, p.NormalizedRole, source, doc, "success", "SUCCESS", true, nil)
	response.JSON(w, http.StatusCreated, CreateProfileResponse{
		Message: "Profile cloned successfully",
		Name:    target,
	})
}

// Export handles GET /api/profiles/:name/export
//
// The download carries the template content as JSON. Authentication material is
// subject to the same visibility predicate as the detail read, so a role that
// cannot see plaintext credentials cannot export them either.
func (h *Handler) Export(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "profiles.read", h.denials) {
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:export:"+p.Username, 30, 60) {
		return
	}

	profile, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}
	if profile == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Profile not found"})
		return
	}

	canSeeCredentials := auth.HasPermission(p, "subscribers.write")
	exported := deepCopyBsonM(profile)
	projectCredentialState(exported, canSeeCredentials)
	delete(exported, "_id")
	delete(exported, "revision")

	visibility := credential.VisibilityMasked
	if canSeeCredentials {
		visibility = credential.VisibilityPlaintext
	}

	payload := map[string]any{
		"version":      1,
		"exported_at":  nowProfileTime(),
		"exported_by":  p.Username,
		"profile_name": name,
		// The manifest states what the reader actually got, so a masked export is
		// never mistaken for a complete backup.
		"credentials": map[string]any{"visibility": visibility},
		"profile":     exported,
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="profile-`+exportFilename(name)+`.json"`)
	w.Header().Set("Cache-Control", "no-store")
	// Written directly rather than through response.JSON: the export contract
	// pins the bare `application/json` media type, as the tariff export does.
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Error("profile_export_encode_failed", "profile", name, "error", err)
	}
}

// Create handles POST /api/profiles
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Check profiles.write permission (super_admin, ops_admin)
	if !auth.HasPermission(p, "profiles.write") {
		// Record the refusal like the read guards do, keeping the existing body.
		audit.RecordPermissionDenied(h.denials, r, p, audit.DenialMetadata{Permission: "profiles.write"})
		response.Forbidden(w, "Insufficient permissions")
		return
	}

	// The token claim alone is stale: revalidate the account before mutating.
	if _, actorErr := RevalidateFreshActor(r.Context(), h.userRepo, p); actorErr != nil {
		response.Error(w, actorErr.Status, actorErr.Message, actorErr.Code)
		return
	}

	// Rate limit: 20/60s
	if !h.limiter.Enforce(w, r, "profiles:create:"+p.Username, 20, 60) {
		return
	}

	// Parse request body. The create payload is the update allow-list plus the
	// name, so a template is written once instead of default-then-overwrite.
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.BadRequest(w, "Invalid request body", "INVALID_REQUEST")
		return
	}

	name, _ := body["name"].(string)

	// Validate profile name
	if !validNewProfileName(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	content := make(map[string]any, len(body))
	for key, value := range body {
		if key == "name" {
			continue
		}
		content[key] = value
	}
	if err := validateProfileUpdateBody(content); err != nil {
		h.writeStrictAudit(r.Context(), "PROFILE_CREATE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "failed", "INVALID_INPUT", false, err)
		response.JSON(w, http.StatusBadRequest, map[string]any{
			"error":     err.Error(),
			"code":      "INVALID_PROFILE_CREATE",
			"committed": false,
		})
		return
	}

	// Build default profile document (matches Node defaultProfile exactly)
	now := nowProfileTime()
	doc := bson.M{
		"name":      name,
		"title":     name,
		"createdAt": now,
		"createdBy": p.Username,
		"updatedAt": now,
		"updatedBy": p.Username,
		// Monotonic write counter; clients may precondition on it.
		"revision": int64(1),
		"auth": bson.M{
			"k":   "00000000000000000000000000000000",
			"opc": "00000000000000000000000000000000",
			"amf": "8000",
		},
		"ambr": bson.M{
			"downlink": bson.M{"unit": 2, "value": 10},
			"uplink":   bson.M{"unit": 2, "value": 10},
		},
		"sliceList": bson.A{
			bson.M{
				"default_indicator": true,
				"sd":                "000001",
				"sst":               int32(1),
				"session_list": bson.A{
					bson.M{
						"name": "internet",
						"type": int32(1),
						"qos": bson.M{
							"_5qi":  int32(9),
							"index": int32(0),
							"arp": bson.M{
								"priorityLevel": int32(9),
								"preemptCap":    "NOT_PREEMPT",
								"preemptVuln":   "NOT_PREEMPTABLE",
							},
						},
						"ambr": bson.M{
							"downlink": bson.M{"unit": int32(3), "value": int32(1)},
							"uplink":   bson.M{"unit": int32(3), "value": int32(1)},
						},
						"pcc_rule": bson.A{},
						"pgwIpv4":  "127.0.0.4",
						"pgwIpv6":  "",
					},
					bson.M{
						"name": "ims",
						"type": int32(3),
						"qos": bson.M{
							"_5qi":  int32(5),
							"index": int32(0),
							"arp": bson.M{
								"priorityLevel": int32(1),
								"preemptCap":    "NOT_PREEMPT",
								"preemptVuln":   "NOT_PREEMPTABLE",
							},
						},
						"ambr": bson.M{
							"downlink": bson.M{"unit": int32(3), "value": int32(1)},
							"uplink":   bson.M{"unit": int32(3), "value": int32(1)},
						},
						"pcc_rule": bson.A{},
						"pgwIpv4":  "127.0.0.4",
						"pgwIpv6":  "",
					},
				},
			},
		},
		"ocsDefaults": bson.M{
			"planId":         "plan_default_10gb",
			"trafficTotal":   int64(10737418240),
			"trafficBalance": int64(10737418240),
			"smsTotal":       int32(100),
			"smsBalance":     int32(100),
		},
	}

	// Optional content overlays the default, under the same field rules as the
	// update path; an empty content set leaves the historical default document
	// byte for byte.
	for key, value := range content {
		if isAllowedProfileField(key) {
			doc[key] = value
		}
	}
	doc["name"] = name

	// Insert profile
	if err := h.repo.InsertProfileCreateOnly(r.Context(), doc); err != nil {
		if err == ErrProfileExists {
			response.Error(w, http.StatusConflict, "Profile already exists", "PROFILE_EXISTS")
			return
		}
		// Storage failure - audit FAILED_NO_MUTATION
		h.writeStrictAudit(r.Context(), "PROFILE_CREATE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "failed", "FAILED_NO_MUTATION", false, err)
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile creation failed",
			"code":      "PROFILE_CREATE_FAILED",
			"committed": false,
		})
		return
	}

	// Save version record
	versionRecord := bson.M{
		"versionId":   generateVersionID(),
		"profileName": name,
		"profile":     doc,
		"action":      "CREATE",
		"savedAt":     now,
		"savedBy":     p.Username,
		"title":       firstStringField(doc, "title", "name"),
		"sliceCount":  sliceCount(doc),
	}
	if err := h.repo.SaveProfileVersion(r.Context(), versionRecord); err != nil {
		// Profile was created but version save failed - partial write
		h.writeStrictAudit(r.Context(), "PROFILE_CREATE", "profile", name, p.Username, p.NormalizedRole, nil, doc, "failed", "PARTIAL_WRITE", true, err)
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile created but version save failed",
			"code":      "PROFILE_CREATE_PARTIAL_WRITE",
			"committed": true,
		})
		return
	}

	// Write strict audit record (non-gating)
	h.writeStrictAudit(r.Context(), "PROFILE_CREATE", "profile", name, p.Username, p.NormalizedRole, nil, doc, "success", "SUCCESS", true, nil)

	response.JSON(w, http.StatusCreated, CreateProfileResponse{
		Message: "Profile created successfully",
		Name:    name,
	})
}

// Update handles PUT /api/profiles/:name
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Check profiles.write permission
	if !auth.HasPermission(p, "profiles.write") {
		// Record the refusal like the read guards do, keeping the existing body.
		audit.RecordPermissionDenied(h.denials, r, p, audit.DenialMetadata{Permission: "profiles.write"})
		response.Forbidden(w, "Insufficient permissions")
		return
	}

	// The token claim alone is stale: revalidate the account before mutating.
	if _, actorErr := RevalidateFreshActor(r.Context(), h.userRepo, p); actorErr != nil {
		response.Error(w, actorErr.Status, actorErr.Message, actorErr.Code)
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	// Rate limit: 30/60s
	if !h.limiter.Enforce(w, r, "profiles:update:"+p.Username, 30, 60) {
		return
	}

	// Parse request body
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.BadRequest(w, "Invalid request body", "INVALID_REQUEST")
		return
	}

	// The precondition is not a stored field: lift it out before the content
	// allow-list runs, so a client can never write `expectedRevision` into the
	// template document.
	expected, hasExpected, validExpected := expectedRevisionFrom(body)
	delete(body, "expectedRevision")
	if !validExpected {
		response.JSON(w, http.StatusBadRequest, map[string]any{
			"error":     "expectedRevision must be a number",
			"code":      "INVALID_PROFILE_UPDATE",
			"committed": false,
		})
		return
	}

	// Validate body fields (fail-closed)
	if err := validateProfileUpdateBody(body); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]any{
			"error":     err.Error(),
			"code":      "INVALID_PROFILE_UPDATE",
			"committed": false,
		})
		return
	}

	// Load existing profile
	existing, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}

	currentRevision := profileRevision(existing)
	// A precondition against a template that is no longer there must not
	// resurrect it as a sparse shell.
	if hasExpected && (existing == nil || expected != currentRevision) {
		h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "REVISION_CONFLICT", false, ErrProfilePreconditionChanged)
		response.JSON(w, http.StatusConflict, map[string]any{
			"error":            "The template changed since it was loaded; reload before saving",
			"code":             "PROFILE_REVISION_CONFLICT",
			"expectedRevision": expected,
			"currentRevision":  currentRevision,
			"committed":        false,
		})
		return
	}

	now := nowProfileTime()

	var updated bson.M

	if existing != nil {
		// Existing profile: copy existing, apply only allowed fields from body
		updated = deepCopyBsonM(existing)
		for k, v := range body {
			if isAllowedProfileField(k) {
				updated[k] = v
			}
		}
		// Force immutable/system fields
		updated["name"] = name
		updated["updatedBy"] = p.Username
		updated["updatedAt"] = now
		updated["revision"] = currentRevision + 1
	} else {
		// Missing profile: build sparse legacy-compatible document
		updated = bson.M{
			"name":      name,
			"title":     name,
			"createdAt": now,
			"createdBy": p.Username,
			"updatedAt": now,
			"updatedBy": p.Username,
			"revision":  int64(1),
		}
		// Apply only allowed fields from body
		for k, v := range body {
			if isAllowedProfileField(k) {
				updated[k] = v
			}
		}
	}

	// Perform CAS update or insert if profile doesn't exist
	if existing != nil {
		// A submission that carries the content the template already has is a
		// true no-op: it must not advance the revision, archive an identical
		// snapshot, or invalidate other clients' preconditions.
		if profileContentFingerprint(existing) == profileContentFingerprint(updated) {
			h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "success", "NO_EFFECT", false, nil)
			response.JSON(w, http.StatusOK, UpdateProfileResponse{
				Message:        "Profile already carries the submitted content",
				Classification: "NO_EFFECT",
			})
			return
		}

		if err := h.repo.ReplaceProfileCAS(r.Context(), name, existing, updated); err != nil {
			if err == ErrProfilePreconditionChanged {
				// Audit PRECONDITION_CHANGED
				h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "PRECONDITION_CHANGED", false, err)
				response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_UPDATE_PRECONDITION_CHANGED")
				return
			}
			// Storage failure - audit FAILED_NO_MUTATION
			h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "FAILED_NO_MUTATION", false, err)
			response.JSON(w, http.StatusInternalServerError, map[string]any{
				"error":     "Profile update failed",
				"code":      "PROFILE_UPDATE_FAILED",
				"committed": false,
			})
			return
		}
	} else {
		// Insert for missing profile (legacy upsert behavior)
		if err := h.repo.InsertProfileCreateOnly(r.Context(), updated); err != nil {
			if err == ErrProfileExists {
				// Concurrent creator won - audit PRECONDITION_CHANGED
				h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "failed", "PRECONDITION_CHANGED", false, err)
				response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_UPDATE_PRECONDITION_CHANGED")
				return
			}
			// Storage failure - audit FAILED_NO_MUTATION
			h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "failed", "FAILED_NO_MUTATION", false, err)
			response.JSON(w, http.StatusInternalServerError, map[string]any{
				"error":     "Profile update failed",
				"code":      "PROFILE_UPDATE_FAILED",
				"committed": false,
			})
			return
		}
	}

	// Save version record (only if updating existing profile)
	if existing != nil {
		versionRecord := bson.M{
			"versionId":   generateVersionID(),
			"profileName": name,
			"profile":     existing,
			"action":      "UPDATE",
			"savedAt":     now,
			"savedBy":     p.Username,
			"title":       existing["title"],
			"sliceCount":  sliceCount(existing),
		}
		if err := h.repo.SaveProfileVersion(r.Context(), versionRecord); err != nil {
			// Profile was updated but version save failed - partial write
			h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, updated, "failed", "PARTIAL_WRITE", true, err)
			response.JSON(w, http.StatusInternalServerError, map[string]any{
				"error":     "Profile updated but version save failed",
				"code":      "PROFILE_UPDATE_PARTIAL_WRITE",
				"committed": true,
			})
			return
		}
	}

	// Write strict audit record (non-gating)
	h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, updated, "success", "SUCCESS", true, nil)

	response.JSON(w, http.StatusOK, UpdateProfileResponse{
		Message: "Profile updated successfully",
	})
}

// Delete handles DELETE /api/profiles/:name
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Check profiles.write permission
	if !auth.HasPermission(p, "profiles.write") {
		// Record the refusal like the read guards do, keeping the existing body.
		audit.RecordPermissionDenied(h.denials, r, p, audit.DenialMetadata{Permission: "profiles.write"})
		response.Forbidden(w, "Insufficient permissions")
		return
	}

	// The token claim alone is stale: revalidate the account before mutating.
	if _, actorErr := RevalidateFreshActor(r.Context(), h.userRepo, p); actorErr != nil {
		response.Error(w, actorErr.Status, actorErr.Message, actorErr.Code)
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	// Rate limit: 20/60s
	if !h.limiter.Enforce(w, r, "profiles:delete:"+p.Username, 20, 60) {
		return
	}

	// Check if profile exists and load it
	existing, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}

	// Missing profile is idempotent 200 (matches Node behavior)
	if existing == nil {
		// Write audit for no-op
		h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "no_op", "NO_OP", false, nil)
		response.JSON(w, http.StatusOK, DeleteProfileResponse{
			Message: "Profile deleted successfully",
		})
		return
	}

	// An optional precondition stops a delete issued from a stale view from
	// removing a template someone else has just rewritten.
	if raw := r.URL.Query().Get("expectedRevision"); raw != "" {
		expected, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil {
			response.JSON(w, http.StatusBadRequest, map[string]any{
				"error":     "expectedRevision must be an integer",
				"code":      "INVALID_PROFILE_DELETE",
				"committed": false,
			})
			return
		}
		if current := profileRevision(existing); expected != current {
			h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "REVISION_CONFLICT", false, ErrProfilePreconditionChanged)
			response.JSON(w, http.StatusConflict, map[string]any{
				"error":            "The template changed since it was loaded; reload before deleting",
				"code":             "PROFILE_REVISION_CONFLICT",
				"expectedRevision": expected,
				"currentRevision":  current,
				"committed":        false,
			})
			return
		}
	}

	// Check if profile is in use by subscribers
	force := r.URL.Query().Get("force") == "true"
	if !force {
		count, err := h.repo.CountSubscribersByProfile(r.Context(), name)
		if err != nil {
			response.InternalError(w)
			return
		}
		if count > 0 {
			response.Error(w, http.StatusConflict, fmt.Sprintf("Profile is in use by %d subscriber(s)", count), "PROFILE_IN_USE")
			return
		}
	}

	// Perform CAS delete
	if err := h.repo.DeleteProfileCAS(r.Context(), name, existing); err != nil {
		if err == ErrProfilePreconditionChanged {
			// Audit PRECONDITION_CHANGED
			h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "PRECONDITION_CHANGED", false, err)
			response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_DELETE_PRECONDITION_CHANGED")
			return
		}
		// Storage failure - audit FAILED_NO_MUTATION
		h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "FAILED_NO_MUTATION", false, err)
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile deletion failed",
			"code":      "PROFILE_DELETE_FAILED",
			"committed": false,
		})
		return
	}

	// Save version record
	now := nowProfileTime()
	versionRecord := bson.M{
		"versionId":   generateVersionID(),
		"profileName": name,
		"profile":     existing,
		"action":      "DELETE",
		"savedAt":     now,
		"savedBy":     p.Username,
		"title":       existing["title"],
		"sliceCount":  sliceCount(existing),
	}
	if err := h.repo.SaveProfileVersion(r.Context(), versionRecord); err != nil {
		// Profile was deleted but version save failed - partial write
		h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "PARTIAL_WRITE", true, err)
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile deleted but version save failed",
			"code":      "PROFILE_DELETE_PARTIAL_WRITE",
			"committed": true,
		})
		return
	}

	// Write strict audit record (non-gating)
	h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "success", "SUCCESS", true, nil)

	response.JSON(w, http.StatusOK, DeleteProfileResponse{
		Message: "Profile deleted successfully",
	})
}

// Restore handles POST /api/profiles/:name/versions/:versionId/restore
func (h *Handler) Restore(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	name := r.PathValue("name")
	versionId := r.PathValue("versionId")

	// A restore reads a stored snapshot, which carries template credential
	// material, so the template read gate applies before the capability check.
	if !audit.RequirePermissionWithAudit(w, r, p, "profiles.read", h.denials) {
		return
	}

	slog.Info("profile_restore_start",
		"operation", "PROFILE_RESTORE",
		"request_id", middleware.RequestIDFromContext(r.Context()),
		"method", r.Method,
		"path", r.URL.Path,
		"principal", p.Username,
		"role", p.NormalizedRole,
		"profile", name,
		"version_id", versionId,
	)

	// Rate limit: 10/60s
	if !h.limiter.Enforce(w, r, "profiles:restore:"+p.Username, 10, 60) {
		return
	}

	// Validate profile name
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	// Check capability
	decision, allowed := auth.CapabilityDecision(p, "profile_rollback")
	if !allowed {
		// The refusal keeps its historical body; the evidence is recorded like
		// the other template guards do.
		audit.RecordPermissionDenied(h.denials, r, p, audit.DenialMetadata{Capability: "profile_rollback", Decision: decision})
		response.Error(w, http.StatusForbidden, "Permission denied", "FORBIDDEN")
		return
	}

	// A restore rewrites the live template, so the actor is revalidated like on
	// any other template write.
	if _, actorErr := RevalidateFreshActor(r.Context(), h.userRepo, p); actorErr != nil {
		response.Error(w, actorErr.Status, actorErr.Message, actorErr.Code)
		return
	}

	// Direct execution for admin/operator
	h.executeDirectRestore(w, r, p, name, versionId)
}

// executeDirectRestore executes the restore directly.
func (h *Handler) executeDirectRestore(w http.ResponseWriter, r *http.Request, p *auth.Principal, name, versionId string) {
	reqID := middleware.RequestIDFromContext(r.Context())
	slog.Info("profile_restore_direct_execute",
		"operation", "PROFILE_RESTORE",
		"request_id", reqID,
		"principal", p.Username,
		"governance_mode", "DIRECT_GOVERNED",
		"profile", name,
		"version_id", versionId,
	)
	// Prepare frozen v2 intent
	intent, err := h.prepareFrozenRestoreV2(r.Context(), p, name, versionId)
	if err != nil {
		response.InternalError(w)
		return
	}
	if intent == nil {
		response.Error(w, http.StatusNotFound, "Version not found", "VERSION_NOT_FOUND")
		return
	}
	if carriesMaskedCredential(intent.EffectiveRestored) {
		// The read projection substitutes the sentinel for material the reader
		// may not see. A snapshot carrying it must never be promoted into the
		// live template, where a governed apply would copy it into a
		// subscriber's security block. Zero writes have happened at this point.
		h.writeStrictAudit(r.Context(), "PROFILE_RESTORE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "failed", "MASKED_CREDENTIAL_MATERIAL", false, nil)
		response.JSON(w, http.StatusBadRequest, map[string]any{
			"error":     "Profile restore refused",
			"code":      "PROFILE_RESTORE_MASKED_MATERIAL",
			"committed": false,
		})
		return
	}

	// Assert frozen v2 (re-read and verify hashes match)
	assertion, err := h.assertFrozenRestoreV2(r.Context(), p, name, versionId, intent)
	if err != nil {
		response.InternalError(w)
		return
	}
	if assertion == nil {
		// Source version or current profile drifted
		slog.Warn("profile_restore_drift",
			"operation", "PROFILE_RESTORE",
			"request_id", reqID,
			"principal", p.Username,
			"governance_mode", "DIRECT_GOVERNED",
			"profile", name,
			"result", "PRECONDITION_CHANGED",
		)
		h.writeRestoreAudit(r.Context(), p, name, intent, nil, "PRECONDITION_CHANGED", false, nil)
		response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_RESTORE_PRECONDITION_CHANGED")
		return
	}

	// Execute frozen restore v2
	result, err := h.executeFrozenRestoreV2(r.Context(), p, name, intent)
	if err != nil {
		if err == ErrProfilePreconditionChanged {
			h.writeRestoreAudit(r.Context(), p, name, intent, nil, "PRECONDITION_CHANGED", false, err)
			response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_RESTORE_PRECONDITION_CHANGED")
			return
		}
		// Check if it's a partial write error
		if err == ErrRestorePartialWrite {
			h.writeRestoreAudit(r.Context(), p, name, intent, intent.EffectiveRestored, "PARTIAL_WRITE", true, err)
			response.JSON(w, http.StatusInternalServerError, map[string]interface{}{
				"error":     "Profile restored but version save failed",
				"code":      "PROFILE_RESTORE_PARTIAL_WRITE",
				"committed": true,
			})
			return
		}
		// Storage failure
		h.writeRestoreAudit(r.Context(), p, name, intent, nil, "FAILED_NO_MUTATION", false, err)
		response.JSON(w, http.StatusInternalServerError, map[string]interface{}{
			"error":     "Profile restore failed",
			"code":      "PROFILE_RESTORE_FAILED",
			"committed": false,
		})
		return
	}

	// Success - strict audit (non-gating)
	h.writeRestoreAudit(r.Context(), p, name, intent, result, "SUCCESS", true, nil)

	slog.Info("profile_restore_success",
		"operation", "PROFILE_RESTORE",
		"request_id", reqID,
		"principal", p.Username,
		"governance_mode", "DIRECT_GOVERNED",
		"profile", name,
		"result", "success",
	)

	// The restored document is returned whole. It is not masked here: rollback
	// is a capability only the roles that also hold subscribers.write receive,
	// so the audience of this response is inside the credential-visibility set.
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"message": "Profile restored successfully",
		"profile": result,
	})
}

// RestoreIntent holds the frozen v2 restore intent.
type RestoreIntent struct {
	Version               string  `json:"version"`
	ProfileName           string  `json:"profileName"`
	VersionId             string  `json:"versionId"`
	SourceVersionHash     string  `json:"sourceVersionHash"`
	CurrentState          string  `json:"currentState"`
	CurrentProfileHash    *string `json:"currentProfileHash"`
	EffectiveRestoredHash string  `json:"effectiveRestoredHash"`
	OperationFingerprint  string  `json:"operationFingerprint"`
	CurrentProfile        bson.M  `json:"-"`
	EffectiveRestored     bson.M  `json:"-"`
	VersionDoc            bson.M  `json:"-"`
}

// RestoreResult holds the result of a successful restore.
type RestoreResult struct {
	Current  bson.M `json:"current"`
	Restored bson.M `json:"restored"`
	Version  bson.M `json:"version"`
}

var ErrRestorePartialWrite = fmt.Errorf("profile restored but version save failed")

// prepareFrozenRestoreV2 prepares the frozen v2 restore intent.
func (h *Handler) prepareFrozenRestoreV2(ctx context.Context, p *auth.Principal, name, versionId string) (*RestoreIntent, error) {
	// Load version
	versionDoc, err := h.repo.GetProfileVersion(ctx, name, versionId)
	if err != nil {
		return nil, err
	}
	if versionDoc == nil {
		return nil, nil
	}

	// Compute sourceVersionHash
	sourceVersionHash, err := computeProfileHash(versionDoc["profile"])
	if err != nil {
		return nil, err
	}

	// Load current profile
	current, err := h.repo.GetProfile(ctx, name)
	if err != nil {
		return nil, err
	}

	// Compute currentState and currentProfileHash
	currentState := "absent"
	var currentProfileHash *string
	if current != nil {
		currentState = "present"
		hash, err := computeProfileHash(current)
		if err != nil {
			return nil, err
		}
		currentProfileHash = &hash
	}

	// Build effective restored profile
	restored := buildEffectiveRestoredProfile(current, versionDoc, name, p.Username)

	// Compute effectiveRestoredHash
	effectiveRestoredHash, err := computeProfileHash(restored)
	if err != nil {
		return nil, err
	}

	// Compute operationFingerprint
	fingerprint, err := computeOperationFingerprint(map[string]interface{}{
		"operation":             "PROFILE_RESTORE",
		"profileName":           name,
		"versionId":             versionId,
		"sourceVersionHash":     sourceVersionHash,
		"currentState":          currentState,
		"currentProfileHash":    currentProfileHash,
		"effectiveRestoredHash": effectiveRestoredHash,
	})
	if err != nil {
		return nil, err
	}

	return &RestoreIntent{
		Version:               "profile-restore-v2",
		ProfileName:           name,
		VersionId:             versionId,
		SourceVersionHash:     sourceVersionHash,
		CurrentState:          currentState,
		CurrentProfileHash:    currentProfileHash,
		EffectiveRestoredHash: effectiveRestoredHash,
		OperationFingerprint:  fingerprint,
		CurrentProfile:        current,
		EffectiveRestored:     restored,
		VersionDoc:            versionDoc,
	}, nil
}

// assertFrozenRestoreV2 re-reads and verifies that the intent is still valid.
func (h *Handler) assertFrozenRestoreV2(ctx context.Context, p *auth.Principal, name, versionId string, intent *RestoreIntent) (*RestoreIntent, error) {
	// Re-read version and recompute hash
	versionDoc, err := h.repo.GetProfileVersion(ctx, name, versionId)
	if err != nil {
		return nil, err
	}
	if versionDoc == nil {
		return nil, nil
	}

	sourceVersionHash, err := computeProfileHash(versionDoc["profile"])
	if err != nil {
		return nil, err
	}
	if sourceVersionHash != intent.SourceVersionHash {
		return nil, nil // Source version drifted
	}

	// Re-read current profile
	current, err := h.repo.GetProfile(ctx, name)
	if err != nil {
		return nil, err
	}

	// Verify current state matches
	if intent.CurrentState == "present" {
		if current == nil {
			return nil, nil // Current profile disappeared
		}
		currentHash, err := computeProfileHash(current)
		if err != nil {
			return nil, err
		}
		if intent.CurrentProfileHash == nil || currentHash != *intent.CurrentProfileHash {
			return nil, nil // Current profile changed
		}
	} else {
		if current != nil {
			return nil, nil // Current profile appeared
		}
	}

	return intent, nil
}

// executeFrozenRestoreV2 executes the restore operation.
func (h *Handler) executeFrozenRestoreV2(ctx context.Context, p *auth.Principal, name string, intent *RestoreIntent) (bson.M, error) {
	now := nowProfileTime()

	if intent.CurrentState == "present" {
		// CAS update for existing profile
		if err := h.repo.ReplaceProfileCAS(ctx, name, intent.CurrentProfile, intent.EffectiveRestored); err != nil {
			if err == ErrProfilePreconditionChanged {
				return nil, ErrProfilePreconditionChanged
			}
			return nil, err
		}
	} else {
		// Insert for missing profile
		if err := h.repo.InsertProfileCreateOnly(ctx, intent.EffectiveRestored); err != nil {
			if err == ErrProfileExists {
				return nil, ErrProfilePreconditionChanged
			}
			return nil, err
		}
	}

	// Save RESTORE version (pre-restore current profile)
	if intent.CurrentProfile != nil {
		versionRecord := bson.M{
			"versionId":   generateVersionID(),
			"profileName": name,
			"profile":     intent.CurrentProfile,
			"action":      "RESTORE",
			"savedAt":     now,
			"savedBy":     p.Username,
			"title":       intent.CurrentProfile["title"],
			"sliceCount":  sliceCount(intent.CurrentProfile),
		}
		if err := h.repo.SaveProfileVersion(ctx, versionRecord); err != nil {
			// Partial write - profile was restored but version save failed
			return nil, ErrRestorePartialWrite
		}
	}

	return intent.EffectiveRestored, nil
}

// writeRestoreAudit writes a restore-specific audit record with full metadata.
func (h *Handler) writeRestoreAudit(ctx context.Context, p *auth.Principal, name string, intent *RestoreIntent, restored bson.M, classification string, committed bool, errDetails error) {
	if h.audit == nil {
		return
	}

	governanceMode := "DIRECT_GOVERNED"

	result := "success"
	level := "info"
	if classification == "PRECONDITION_CHANGED" || classification == "FAILED_NO_MUTATION" {
		result = "failed"
		level = "error"
	} else if classification == "PARTIAL_WRITE" {
		result = "partial_write"
		level = "warn"
	}

	input := audit.WriteAuditInput{
		Action: "PROFILE_RESTORE",
		Module: "profiles",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.NormalizedRole,
		},
		Resource: &audit.ResourceInput{
			Type: "profile",
			Name: name,
		},
		Result: result,
		Level:  level,
		Metadata: map[string]interface{}{
			"governanceMode":       governanceMode,
			"actorRole":            p.NormalizedRole,
			"mutationCommitted":    committed,
			"classification":       classification,
			"operationFingerprint": intent.OperationFingerprint,
			"sourceVersionHash":    intent.SourceVersionHash,
			"currentProfileHash":   intent.CurrentProfileHash,
			"versionId":            intent.VersionId,
		},
	}

	// Use safe snapshot (redact secrets)
	if intent.CurrentProfile != nil {
		input.Before = safeProfileSnapshot(intent.CurrentProfile)
	}
	if restored != nil {
		input.After = safeProfileSnapshot(restored)
	}

	if errDetails != nil {
		input.Error = &audit.ErrorInput{
			Code:    classification,
			Message: errDetails.Error(),
		}
	}

	if err := h.audit.WriteStrict(ctx, input); err != nil {
		slog.Error("profile_restore_audit_write_failed",
			"operation", "PROFILE_RESTORE",
			"profile", name,
			"error", err,
		)
	}
}

// computeProfileHash computes SHA256 of stable JSON of a profile (excluding _id).
func computeProfileHash(profile interface{}) (string, error) {
	if profile == nil {
		return "", nil
	}

	// Remove _id if present
	cleaned := removeField(profile, "_id")

	data, err := json.Marshal(cleaned)
	if err != nil {
		return "", err
	}

	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

// writeManagedProfileFields are stamped by the writer itself, so they never
// count as a content change.
var writeManagedProfileFields = []string{"_id", "updatedAt", "updatedBy", "revision"}

// profileContentFingerprint renders a profile document as canonical JSON: the
// decoded shape and the key order of a stored document must not read as a
// change against a submission that carries the same content.
func profileContentFingerprint(doc bson.M) string {
	canonical := make(map[string]any, len(doc))
	for key, value := range doc {
		if slices.Contains(writeManagedProfileFields, key) {
			continue
		}
		canonical[key] = canonicalProfileValue(value)
	}
	data, err := json.Marshal(canonical)
	if err != nil {
		// An unmarshalable document cannot be compared; treat it as changed so
		// the write still happens instead of silently dropping the submission.
		return "\x00uncomparable"
	}
	return string(data)
}

func canonicalProfileValue(value any) any {
	switch v := value.(type) {
	case bson.D:
		canonical := make(map[string]any, len(v))
		for _, elem := range v {
			canonical[elem.Key] = canonicalProfileValue(elem.Value)
		}
		return canonical
	case bson.M:
		canonical := make(map[string]any, len(v))
		for key, item := range v {
			canonical[key] = canonicalProfileValue(item)
		}
		return canonical
	case map[string]any:
		canonical := make(map[string]any, len(v))
		for key, item := range v {
			canonical[key] = canonicalProfileValue(item)
		}
		return canonical
	case bson.A:
		return canonicalProfileItems(v)
	case []any:
		return canonicalProfileItems(v)
	default:
		return v
	}
}

func canonicalProfileItems(items []any) []any {
	canonical := make([]any, 0, len(items))
	for _, item := range items {
		canonical = append(canonical, canonicalProfileValue(item))
	}
	return canonical
}

// computeOperationFingerprint computes SHA256 of stable JSON of the operation.
func computeOperationFingerprint(data map[string]interface{}) (string, error) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return "", err
	}

	hash := sha256.Sum256(jsonData)
	return hex.EncodeToString(hash[:]), nil
}

// removeField recursively removes a field from a BSON document.
func removeField(doc interface{}, field string) interface{} {
	switch v := doc.(type) {
	case bson.M:
		result := bson.M{}
		for k, val := range v {
			if k == field {
				continue
			}
			result[k] = removeField(val, field)
		}
		return result
	case bson.A:
		result := bson.A{}
		for _, val := range v {
			result = append(result, removeField(val, field))
		}
		return result
	default:
		return doc
	}
}

// buildEffectiveRestoredProfile builds the effective restored profile from version and current.
// Uses deterministic clock for test parity when provided.
func buildEffectiveRestoredProfile(current bson.M, versionDoc bson.M, name, actor string, clock ...time.Time) bson.M {
	versionProfile, _ := versionDoc["profile"].(bson.M)
	if versionProfile == nil {
		versionProfile = bson.M{}
	}

	// Strip subscriber identity fields
	stripped := stripSubscriberIdentityFields(versionProfile)

	// Build restored document
	restored := bson.M{}
	for k, v := range stripped {
		restored[k] = v
	}

	// Server-controlled fields
	restored["name"] = name
	restored["title"] = versionProfile["title"]
	if restored["title"] == nil || restored["title"] == "" {
		restored["title"] = name
	}

	var now time.Time
	if len(clock) > 0 {
		now = clock[0]
	} else {
		now = time.Now().UTC()
	}
	// Format as ISO string with milliseconds to match Node behavior
	nowISO := now.Format(profileTimeLayout)

	if versionProfile["createdAt"] != nil {
		restored["createdAt"] = versionProfile["createdAt"]
	} else if current != nil && current["createdAt"] != nil {
		restored["createdAt"] = current["createdAt"]
	} else {
		restored["createdAt"] = nowISO
	}

	if versionProfile["createdBy"] != nil {
		restored["createdBy"] = versionProfile["createdBy"]
	} else if current != nil && current["createdBy"] != nil {
		restored["createdBy"] = current["createdBy"]
	} else {
		restored["createdBy"] = actor
	}

	restored["updatedAt"] = nowISO
	restored["updatedBy"] = actor
	// A restore is a write like any other, so it advances the counter: a client
	// holding a pre-restore revision can no longer overwrite blindly.
	restored["revision"] = profileRevision(current) + 1
	restored["restoredFromVersionId"] = versionDoc["versionId"]
	restored["restoredFromSavedAt"] = versionDoc["savedAt"]

	return restored
}

// stripSubscriberIdentityFields removes subscriber identity fields from a profile.
func stripSubscriberIdentityFields(doc bson.M) bson.M {
	result := bson.M{}
	for k, v := range doc {
		if k == "imsi" || k == "msisdn" || k == "msisdnList" {
			continue
		}
		result[k] = v
	}
	return result
}

// generateVersionID generates a unique version ID.
func generateVersionID() string {
	return fmt.Sprintf("%d-%s", time.Now().UnixNano(), randomHex(8))
}

// randomHex generates a random hex string of the given byte length.
func randomHex(n int) string {
	b := make([]byte, n)
	// crypto/rand.Read never returns a non-nil error on the supported platforms.
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// writeStrictAudit writes an audit record and logs on failure without gating.
func (h *Handler) writeStrictAudit(ctx context.Context, action, targetType, targetName, username, role string, before, after any, result string, classification string, committed bool, errDetails error) {
	if h.audit == nil {
		return
	}

	input := audit.WriteAuditInput{
		Action: action,
		Module: "profiles",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: username,
			Role:     role,
		},
		Resource: &audit.ResourceInput{
			Type: targetType,
			Name: targetName,
		},
		Result: result,
		Level:  "info",
		Metadata: map[string]interface{}{
			"governanceMode":    "DIRECT_GOVERNED",
			"actorRole":         role,
			"mutationCommitted": committed,
			"classification":    classification,
		},
	}

	// Use safe snapshot (redact secrets)
	if before != nil {
		input.Before = safeProfileSnapshot(before)
	}
	if after != nil {
		input.After = safeProfileSnapshot(after)
	}

	if errDetails != nil {
		input.Error = &audit.ErrorInput{
			Code:    classification,
			Message: errDetails.Error(),
		}
	}

	if err := h.audit.WriteStrict(ctx, input); err != nil {
		slog.Error("profile_audit_write_failed",
			"action", action,
			"target", targetName,
			"error", err,
		)
	}
}

// safeProfileSnapshot creates a safe snapshot with secrets redacted.
func safeProfileSnapshot(profile any) map[string]interface{} {
	if profile == nil {
		return nil
	}

	doc := asDocument(profile)
	if doc == nil {
		return map[string]interface{}{"_type": "unknown"}
	}

	safe := map[string]interface{}{}

	// Copy safe fields
	for _, field := range []string{"name", "title", "access_restriction_data", "ambr", "sliceList", "ocsDefaults", "createdAt", "createdBy", "updatedAt", "updatedBy"} {
		if v, ok := doc[field]; ok {
			safe[field] = v
		}
	}

	// Add authConfigured indicator (no raw secrets). The auth child of a stored
	// document decodes as bson.D, so it is read through the shape authority: a
	// plain bson.M assertion silently dropped this for every real read.
	if material := asDocument(fieldOf(doc, "auth")); material != nil {
		safe["authConfigured"] = credential.Configured(material["k"])
	}

	return safe
}

// isAllowedProfileField checks if a field is allowed in the PUT body.
func isAllowedProfileField(field string) bool {
	allowed := map[string]bool{
		"title":                   true,
		"description":             true,
		"auth":                    true,
		"ambr":                    true,
		"access_restriction_data": true,
		"sliceList":               true,
		"ocsDefaults":             true,
	}
	return allowed[field]
}

// validateProfileUpdateBody validates the PUT body fields.
// Returns error if any unknown or forbidden field is present.
func validateProfileUpdateBody(body map[string]any) error {
	for field := range body {
		// Check allowed fields
		if isAllowedProfileField(field) {
			continue
		}
		// Reject unknown fields
		return fmt.Errorf("unknown field: %s", field)
	}
	// The read path substitutes the masking sentinel for credential material.
	// Echoing it back would store it as a real key and the governed apply would
	// copy it into a subscriber's security block, so the sentinel is never valid
	// write input.
	if authValue, ok := body["auth"].(map[string]any); ok {
		for _, key := range credentialKeys {
			if text, _ := authValue[key].(string); text == maskedCredential {
				return fmt.Errorf("auth.%s: masked credential material cannot be written back", key)
			}
		}
		// The credential state is computed for the reader, never stored. An
		// exported document now carries it inside auth, so a copy-paste round
		// trip must not plant a projection field in the live template, where it
		// would pollute content comparison and version diffs.
		if _, projected := authValue[credential.StateKey]; projected {
			return fmt.Errorf("auth.%s: projected credential state cannot be written back", credential.StateKey)
		}
	}
	return nil
}

// deepCopyBsonM creates a deep copy of a bson.M document.
func deepCopyBsonM(src bson.M) bson.M {
	if src == nil {
		return nil
	}
	dst := bson.M{}
	for k, v := range src {
		dst[k] = deepCopyBsonValue(v)
	}
	return dst
}

// deepCopyBsonValue creates a deep copy of a BSON value.
func deepCopyBsonValue(v any) any {
	switch val := v.(type) {
	case bson.M:
		return deepCopyBsonM(val)
	case map[string]any:
		cp := make(map[string]any, len(val))
		for key, item := range val {
			cp[key] = deepCopyBsonValue(item)
		}
		return cp
	case bson.D:
		// The decoded shape is preserved: rebuilding an ordered snapshot as a
		// map would reorder the exported document.
		cp := make(bson.D, len(val))
		for i, elem := range val {
			cp[i] = bson.E{Key: elem.Key, Value: deepCopyBsonValue(elem.Value)}
		}
		return cp
	case bson.A:
		cp := make(bson.A, len(val))
		for i, item := range val {
			cp[i] = deepCopyBsonValue(item)
		}
		return cp
	case []any:
		cp := make([]any, len(val))
		for i, item := range val {
			cp[i] = deepCopyBsonValue(item)
		}
		return cp
	default:
		return v
	}
}
