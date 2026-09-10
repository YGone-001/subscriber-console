package profile

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
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

// Handler provides HTTP handlers for profile endpoints.
type Handler struct {
	repo    ProfileReadWriter
	limiter *ratelimit.Limiter
	audit   AuditWriter
}

// NewHandler creates a new profile Handler.
func NewHandler(repo ProfileReadWriter, limiter *ratelimit.Limiter, auditWriter AuditWriter) *Handler {
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
	now := time.Now().UTC().Format(time.RFC3339)
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
		"preconditionHash": computePreconditionHash(nil),
	}

	// Insert profile
	if err := h.repo.InsertProfileCreateOnly(r.Context(), doc); err != nil {
		if err == ErrProfileExists {
			response.Error(w, http.StatusConflict, "Profile already exists", "PROFILE_EXISTS")
			return
		}
		response.InternalError(w)
		return
	}

	// Save version record (best-effort, log failure but don't fail the request)
	versionRecord := bson.M{
		"versionId":       generateVersionID(),
		"profileName":     req.Name,
		"profileSnapshot": doc,
		"action":          "CREATE",
		"savedAt":         now,
		"savedBy":         p.Username,
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

	// Write audit record (best-effort)
	h.writeAudit(r.Context(), "PROFILE_CREATE", "profile", req.Name, p.Username, doc, "success", nil)

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

	// Load existing profile
	existing, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}

	// Compute preconditionHash from existing
	preconditionHash := computePreconditionHash(existing)

	// Build updated document (merge body into existing or create default)
	now := time.Now().UTC().Format(time.RFC3339)
	updated := bson.M{
		"name":      name,
		"title":     name,
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
		"preconditionHash": preconditionHash,
	}

	// Merge body fields into updated document
	for k, v := range body {
		if k != "name" && k != "preconditionHash" {
			updated[k] = v
		}
	}
	updated["updatedBy"] = p.Username
	updated["updatedAt"] = now
	updated["preconditionHash"] = computePreconditionHash(updated)

	// Perform CAS update (or insert if profile doesn't exist yet)
	if err := h.repo.ReplaceProfileCAS(r.Context(), name, existing, updated); err != nil {
		if err == ErrProfilePreconditionChanged {
			response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_PRECONDITION_CHANGED")
			return
		}
		response.InternalError(w)
		return
	}

	// Save version record (best-effort)
	versionRecord := bson.M{
		"versionId":       generateVersionID(),
		"profileName":     name,
		"profileSnapshot": existing,
		"action":          "UPDATE",
		"savedAt":         now,
		"savedBy":         p.Username,
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

	// Write audit record (best-effort)
	h.writeAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, existing, "success", nil)

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
	if existing == nil {
		response.NotFound(w)
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
			response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_PRECONDITION_CHANGED")
			return
		}
		response.InternalError(w)
		return
	}

	// Save version record (best-effort)
	now := time.Now().UTC().Format(time.RFC3339)
	versionRecord := bson.M{
		"versionId":       generateVersionID(),
		"profileName":     name,
		"profileSnapshot": existing,
		"action":          "DELETE",
		"savedAt":         now,
		"savedBy":         p.Username,
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

	// Write audit record (best-effort)
	h.writeAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, existing, "success", nil)

	response.JSON(w, http.StatusOK, DeleteProfileResponse{
		Message: "Profile deleted successfully",
	})
}

// computePreconditionHash computes a SHA-256 hash of the profile document for CAS.
func computePreconditionHash(doc bson.M) string {
	if doc == nil {
		return sha256Hex("{}")
	}
	// Remove preconditionHash before hashing
	cleaned := bson.M{}
	for k, v := range doc {
		if k != "preconditionHash" && k != "_id" {
			cleaned[k] = v
		}
	}
	data, _ := json.Marshal(cleaned)
	return sha256Hex(string(data))
}

// sha256Hex computes the SHA-256 hex digest of a string.
func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", h)
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

// writeAudit writes an audit record (best-effort).
func (h *Handler) writeAudit(ctx context.Context, action, targetType, targetName, username string, snapshot any, result string, errDetails error) {
	if h.audit == nil {
		return
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
	}

	if snapshot != nil {
		input.Before = snapshot
	}

	if errDetails != nil {
		input.Error = &audit.ErrorInput{
			Code:    "WRITE_FAILED",
			Message: errDetails.Error(),
		}
	}

	// Best-effort audit write
	h.audit.WriteBestEffort(input)
}
