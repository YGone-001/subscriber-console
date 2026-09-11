package profile

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

var validProfileName = regexp.MustCompile(`^[a-zA-Z0-9_\s-]+$`)

// ProfileReader defines the read interface for profile data.
type ProfileReader interface {
	ListProfiles(ctx context.Context) ([]ProfileListItem, ProfileSummary, error)
	GetProfile(ctx context.Context, name string) (bson.M, error)
	GetProfileStats(ctx context.Context, name string) (ProfileStats, error)
	ListProfileVersions(ctx context.Context, name string, limit int) ([]ProfileVersionSummary, error)
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
}

// NewHandler creates a new profile Handler.
func NewHandler(repo ProfileReadWriter, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{repo: repo, limiter: limiter, audit: auditWriter}
}

// List handles GET /api/profiles
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:list:"+p.Username, 90, 60) {
		return
	}

	profiles, summary, err := h.repo.ListProfiles(r.Context())
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileListResponse{
		Profiles: profiles,
		Summary:  summary,
	})
}

// Get handles GET /api/profiles/:name
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
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

	stats, err := h.repo.GetProfileStats(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileDetailResponse{
		Profile: profile,
		Stats:   &stats,
	})
}

// Stats handles GET /api/profiles/:name/stats
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
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
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileStatsResponse{Stats: stats})
}

// Versions handles GET /api/profiles/:name/versions
func (h *Handler) Versions(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
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
		if u, ok := currentProfile["updatedAt"].(string); ok {
			cs.UpdatedAt = u
		} else if c, ok := currentProfile["createdAt"].(string); ok {
			cs.UpdatedAt = c
		}
		if u, ok := currentProfile["updatedBy"].(string); ok {
			cs.UpdatedBy = u
		} else if c, ok := currentProfile["createdBy"].(string); ok {
			cs.UpdatedBy = c
		}
		if sl, ok := currentProfile["sliceList"].(bson.A); ok {
			cs.SliceCount = len(sl)
		}
		currentSummary = &cs
	}

	versions, err := h.repo.ListProfileVersions(r.Context(), name, limit)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileVersionsResponse{
		Versions: versions,
		Current:  currentSummary,
	})
}

// ── Write Handlers ──────────────────────────────────────────────────────────

// Create handles POST /api/profiles
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Check profiles.write permission (super_admin, ops_admin)
	if !auth.HasPermission(p, "profiles.write") {
		response.Forbidden(w, "Insufficient permissions")
		return
	}

	// Rate limit: 20/60s
	if !h.limiter.Enforce(w, r, "profiles:create:"+p.Username, 20, 60) {
		return
	}

	// Parse request body
	var req CreateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "Invalid request body", "INVALID_REQUEST")
		return
	}

	// Validate profile name
	if !validProfileName.MatchString(req.Name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	// Build default profile document (matches Node defaultProfile exactly)
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	doc := bson.M{
		"name":      req.Name,
		"title":     req.Name,
		"createdAt": now,
		"createdBy": p.Username,
		"updatedAt": now,
		"updatedBy": p.Username,
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

	// Insert profile
	if err := h.repo.InsertProfileCreateOnly(r.Context(), doc); err != nil {
		if err == ErrProfileExists {
			response.Error(w, http.StatusConflict, "Profile already exists", "PROFILE_EXISTS")
			return
		}
		// Storage failure
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
		"profileName": req.Name,
		"profile":     doc,
		"action":      "CREATE",
		"savedAt":     now,
		"savedBy":     p.Username,
		"title":       req.Name,
		"sliceCount":  countSliceList(doc),
	}
	if err := h.repo.SaveProfileVersion(r.Context(), versionRecord); err != nil {
		// Profile was created but version save failed - partial write
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile created but version save failed",
			"code":      "PROFILE_CREATE_PARTIAL_WRITE",
			"committed": true,
		})
		return
	}

	// Write strict audit record
	if err := h.writeStrictAudit(r.Context(), "PROFILE_CREATE", "profile", req.Name, p.Username, nil, doc, "success", nil, true); err != nil {
		response.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "Audit unavailable",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": true,
		})
		return
	}

	response.JSON(w, http.StatusCreated, CreateProfileResponse{
		Message: "Profile created successfully",
		Name:    req.Name,
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
		response.Forbidden(w, "Insufficient permissions")
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

	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

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
	} else {
		// Missing profile: build sparse legacy-compatible document
		updated = bson.M{
			"name":      name,
			"title":     name,
			"createdAt": now,
			"createdBy": p.Username,
			"updatedAt": now,
			"updatedBy": p.Username,
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
		// CAS update for existing profile
		if err := h.repo.ReplaceProfileCAS(r.Context(), name, existing, updated); err != nil {
			if err == ErrProfilePreconditionChanged {
				response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_UPDATE_PRECONDITION_CHANGED")
				return
			}
			// Storage failure
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
				// Concurrent creator won
				response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_UPDATE_PRECONDITION_CHANGED")
				return
			}
			// Storage failure
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
			"sliceCount":  countSliceList(existing),
		}
		if err := h.repo.SaveProfileVersion(r.Context(), versionRecord); err != nil {
			// Profile was updated but version save failed - partial write
			response.JSON(w, http.StatusInternalServerError, map[string]any{
				"error":     "Profile updated but version save failed",
				"code":      "PROFILE_UPDATE_PARTIAL_WRITE",
				"committed": true,
			})
			return
		}
	}

	// Write strict audit record
	if err := h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, existing, updated, "success", nil, true); err != nil {
		response.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "Audit unavailable",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": true,
		})
		return
	}

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
		response.Forbidden(w, "Insufficient permissions")
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
		if err := h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, nil, nil, "no_op", nil, false); err != nil {
			response.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":     "Audit unavailable",
				"code":      "AUDIT_UNAVAILABLE",
				"committed": false,
			})
			return
		}
		response.JSON(w, http.StatusOK, DeleteProfileResponse{
			Message: "Profile deleted successfully",
		})
		return
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
			response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_DELETE_PRECONDITION_CHANGED")
			return
		}
		// Storage failure
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile deletion failed",
			"code":      "PROFILE_DELETE_FAILED",
			"committed": false,
		})
		return
	}

	// Save version record
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	versionRecord := bson.M{
		"versionId":   generateVersionID(),
		"profileName": name,
		"profile":     existing,
		"action":      "DELETE",
		"savedAt":     now,
		"savedBy":     p.Username,
		"title":       existing["title"],
		"sliceCount":  countSliceList(existing),
	}
	if err := h.repo.SaveProfileVersion(r.Context(), versionRecord); err != nil {
		// Profile was deleted but version save failed - partial write
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile deleted but version save failed",
			"code":      "PROFILE_DELETE_PARTIAL_WRITE",
			"committed": true,
		})
		return
	}

	// Write strict audit record
	if err := h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, existing, nil, "success", nil, true); err != nil {
		response.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "Audit unavailable",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": true,
		})
		return
	}

	response.JSON(w, http.StatusOK, DeleteProfileResponse{
		Message: "Profile deleted successfully",
	})
}

// generateVersionID generates a unique version ID.
func generateVersionID() string {
	return fmt.Sprintf("%d-%s", time.Now().UnixNano(), randomHex(8))
}

// randomHex generates a random hex string of the given byte length.
func randomHex(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(time.Now().UnixNano() >> (8 * i))
	}
	return fmt.Sprintf("%x", b)
}

// writeStrictAudit writes a strict audit record and returns error on failure.
func (h *Handler) writeStrictAudit(ctx context.Context, action, targetType, targetName, username string, before, after any, result string, errDetails error, committed bool) error {
	if h.audit == nil {
		return nil
	}

	input := audit.WriteAuditInput{
		Action: action,
		Module: "profiles",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: username,
		},
		Resource: &audit.ResourceInput{
			Type: targetType,
			Name: targetName,
		},
		Result: result,
		Level:  "info",
		Metadata: map[string]interface{}{
			"committed": committed,
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
			Code:    "WRITE_FAILED",
			Message: errDetails.Error(),
		}
	}

	return h.audit.WriteStrict(ctx, input)
}

// safeProfileSnapshot creates a safe snapshot with secrets redacted.
func safeProfileSnapshot(profile any) map[string]interface{} {
	if profile == nil {
		return nil
	}

	doc, ok := profile.(bson.M)
	if !ok {
		return map[string]interface{}{"_type": "unknown"}
	}

	safe := map[string]interface{}{}

	// Copy safe fields
	for _, field := range []string{"name", "title", "access_restriction_data", "ambr", "sliceList", "ocsDefaults", "createdAt", "createdBy", "updatedAt", "updatedBy"} {
		if v, ok := doc[field]; ok {
			safe[field] = v
		}
	}

	// Add authConfigured indicator (no raw secrets)
	if auth, ok := doc["auth"].(bson.M); ok {
		safe["authConfigured"] = auth["k"] != "" && auth["k"] != "00000000000000000000000000000000"
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

// countSliceList counts the number of slices in a profile.
func countSliceList(doc bson.M) int {
	if sl, ok := doc["sliceList"].(bson.A); ok {
		return len(sl)
	}
	return 0
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
	case bson.A:
		cp := make(bson.A, len(val))
		for i, item := range val {
			cp[i] = deepCopyBsonValue(item)
		}
		return cp
	default:
		return v
	}
}
