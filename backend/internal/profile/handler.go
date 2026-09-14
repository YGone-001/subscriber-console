package profile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/approval"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

var validProfileName = regexp.MustCompile(`^[a-zA-Z0-9_\s-]+$`)

// ProfileReader defines the read interface for profile data.
type ProfileReader interface {
	ListProfiles(ctx context.Context) ([]ProfileListItem, ProfileSummary, error)
	GetProfile(ctx context.Context, name string) (bson.M, error)
	GetProfileVersion(ctx context.Context, profileName, versionId string) (bson.M, error)
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

// ApprovalCreateStore abstracts approval persistence for profile governance.
type ApprovalCreateStore interface {
	CreateApprovalRequest(ctx context.Context, input approval.CreateApprovalInput) (*approval.ApprovalDocument, error)
}

// Handler provides HTTP handlers for profile endpoints.
type Handler struct {
	repo         ProfileReadWriter
	approvalRepo ApprovalCreateStore
	limiter      RateLimiter
	audit        AuditWriter
}

// NewHandler creates a new profile Handler.
func NewHandler(repo ProfileReadWriter, approvalRepo ApprovalCreateStore, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{repo: repo, approvalRepo: approvalRepo, limiter: limiter, audit: auditWriter}
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
		// Storage failure - audit FAILED_NO_MUTATION
		if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_CREATE", "profile", req.Name, p.Username, p.NormalizedRole, nil, nil, "failed", "FAILED_NO_MUTATION", false, err); auditErr != nil {
			response.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":     "Audit unavailable",
				"code":      "AUDIT_UNAVAILABLE",
				"committed": false,
			})
			return
		}
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
		if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_CREATE", "profile", req.Name, p.Username, p.NormalizedRole, nil, doc, "failed", "PARTIAL_WRITE", true, err); auditErr != nil {
			response.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":     "Audit unavailable",
				"code":      "AUDIT_UNAVAILABLE",
				"committed": true,
			})
			return
		}
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile created but version save failed",
			"code":      "PROFILE_CREATE_PARTIAL_WRITE",
			"committed": true,
		})
		return
	}

	// Write strict audit record
	if err := h.writeStrictAudit(r.Context(), "PROFILE_CREATE", "profile", req.Name, p.Username, p.NormalizedRole, nil, doc, "success", "SUCCESS", true, nil); err != nil {
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
				// Audit PRECONDITION_CHANGED
				if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "PRECONDITION_CHANGED", false, err); auditErr != nil {
					response.JSON(w, http.StatusServiceUnavailable, map[string]any{
						"error":     "Audit unavailable",
						"code":      "AUDIT_UNAVAILABLE",
						"committed": false,
					})
					return
				}
				response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_UPDATE_PRECONDITION_CHANGED")
				return
			}
			// Storage failure - audit FAILED_NO_MUTATION
			if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "FAILED_NO_MUTATION", false, err); auditErr != nil {
				response.JSON(w, http.StatusServiceUnavailable, map[string]any{
					"error":     "Audit unavailable",
					"code":      "AUDIT_UNAVAILABLE",
					"committed": false,
				})
				return
			}
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
				if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "failed", "PRECONDITION_CHANGED", false, err); auditErr != nil {
					response.JSON(w, http.StatusServiceUnavailable, map[string]any{
						"error":     "Audit unavailable",
						"code":      "AUDIT_UNAVAILABLE",
						"committed": false,
					})
					return
				}
				response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_UPDATE_PRECONDITION_CHANGED")
				return
			}
			// Storage failure - audit FAILED_NO_MUTATION
			if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "failed", "FAILED_NO_MUTATION", false, err); auditErr != nil {
				response.JSON(w, http.StatusServiceUnavailable, map[string]any{
					"error":     "Audit unavailable",
					"code":      "AUDIT_UNAVAILABLE",
					"committed": false,
				})
				return
			}
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
			if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, updated, "failed", "PARTIAL_WRITE", true, err); auditErr != nil {
				response.JSON(w, http.StatusServiceUnavailable, map[string]any{
					"error":     "Audit unavailable",
					"code":      "AUDIT_UNAVAILABLE",
					"committed": true,
				})
				return
			}
			response.JSON(w, http.StatusInternalServerError, map[string]any{
				"error":     "Profile updated but version save failed",
				"code":      "PROFILE_UPDATE_PARTIAL_WRITE",
				"committed": true,
			})
			return
		}
	}

	// Write strict audit record
	if err := h.writeStrictAudit(r.Context(), "PROFILE_UPDATE", "profile", name, p.Username, p.NormalizedRole, existing, updated, "success", "SUCCESS", true, nil); err != nil {
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
		if err := h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, nil, nil, "no_op", "NO_OP", false, nil); err != nil {
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
			// Audit PRECONDITION_CHANGED
			if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "PRECONDITION_CHANGED", false, err); auditErr != nil {
				response.JSON(w, http.StatusServiceUnavailable, map[string]any{
					"error":     "Audit unavailable",
					"code":      "AUDIT_UNAVAILABLE",
					"committed": false,
				})
				return
			}
			response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_DELETE_PRECONDITION_CHANGED")
			return
		}
		// Storage failure - audit FAILED_NO_MUTATION
		if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "FAILED_NO_MUTATION", false, err); auditErr != nil {
			response.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":     "Audit unavailable",
				"code":      "AUDIT_UNAVAILABLE",
				"committed": false,
			})
			return
		}
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile deletion failed",
			"code":      "PROFILE_DELETE_FAILED",
			"committed": false,
		})
		return
	}

	// Save version record
	now := time.Now().UTC()
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
		if auditErr := h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "failed", "PARTIAL_WRITE", true, err); auditErr != nil {
			response.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":     "Audit unavailable",
				"code":      "AUDIT_UNAVAILABLE",
				"committed": true,
			})
			return
		}
		response.JSON(w, http.StatusInternalServerError, map[string]any{
			"error":     "Profile deleted but version save failed",
			"code":      "PROFILE_DELETE_PARTIAL_WRITE",
			"committed": true,
		})
		return
	}

	// Write strict audit record
	if err := h.writeStrictAudit(r.Context(), "PROFILE_DELETE", "profile", name, p.Username, p.NormalizedRole, existing, nil, "success", "SUCCESS", true, nil); err != nil {
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

// Restore handles POST /api/profiles/:name/versions/:versionId/restore
func (h *Handler) Restore(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	name := r.PathValue("name")
	versionId := r.PathValue("versionId")

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
		if decision == "approval" {
			// Create approval for operator
			h.handleRestoreApproval(w, r, p, name, versionId)
			return
		}
		response.Error(w, http.StatusForbidden, "Permission denied", "FORBIDDEN")
		return
	}

	// Direct execution for super_admin/root/ops_admin
	h.executeDirectRestore(w, r, p, name, versionId)
}

// handleRestoreApproval creates an approval request for operator restore.
func (h *Handler) handleRestoreApproval(w http.ResponseWriter, r *http.Request, p *auth.Principal, name, versionId string) {
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

	// Create approval request
	approvalInput := approval.CreateApprovalInput{
		Action:    "PROFILE_RESTORE",
		Requester: p.Username,
		RequesterContext: &approval.GovernanceActor{
			Type:     "user",
			Username: p.Username,
			Role:     p.NormalizedRole,
		},
		TargetID:             fmt.Sprintf("profile:%s", name),
		Summary:              fmt.Sprintf("Restore profile %s from version %s", name, versionId),
		OperationFingerprint: intent.OperationFingerprint,
		Payload: map[string]interface{}{
			"version":               "profile-restore-v2",
			"name":                  name,
			"versionId":             versionId,
			"requester":             p.Username,
			"sourceVersionHash":     intent.SourceVersionHash,
			"currentState":          intent.CurrentState,
			"currentProfileHash":    intent.CurrentProfileHash,
			"effectiveRestoredHash": intent.EffectiveRestoredHash,
			"operationFingerprint":  intent.OperationFingerprint,
		},
	}

	approvalDoc, err := h.approvalRepo.CreateApprovalRequest(r.Context(), approvalInput)
	if err != nil {
		response.InternalError(w)
		return
	}

	// Audit approval creation using restore-specific audit
	_ = h.writeRestoreAudit(r.Context(), p, name, intent, nil, "APPROVAL_GOVERNED", false, nil)

	response.JSON(w, http.StatusAccepted, map[string]interface{}{
		"message":  "Approval required before profile restore",
		"approval": approvalDoc,
	})
}

// executeDirectRestore executes the restore directly for privileged roles.
func (h *Handler) executeDirectRestore(w http.ResponseWriter, r *http.Request, p *auth.Principal, name, versionId string) {
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

	// Assert frozen v2 (re-read and verify hashes match)
	assertion, err := h.assertFrozenRestoreV2(r.Context(), p, name, versionId, intent)
	if err != nil {
		response.InternalError(w)
		return
	}
	if assertion == nil {
		// Source version or current profile drifted
		_ = h.writeRestoreAudit(r.Context(), p, name, intent, nil, "PRECONDITION_CHANGED", false, nil)
		response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_RESTORE_PRECONDITION_CHANGED")
		return
	}

	// Execute frozen restore v2
	result, err := h.executeFrozenRestoreV2(r.Context(), p, name, intent)
	if err != nil {
		if err == ErrProfilePreconditionChanged {
			_ = h.writeRestoreAudit(r.Context(), p, name, intent, nil, "PRECONDITION_CHANGED", false, err)
			response.Error(w, http.StatusConflict, "Profile was modified since loaded", "PROFILE_RESTORE_PRECONDITION_CHANGED")
			return
		}
		// Check if it's a partial write error
		if err == ErrRestorePartialWrite {
			_ = h.writeRestoreAudit(r.Context(), p, name, intent, intent.EffectiveRestored, "PARTIAL_WRITE", true, err)
			response.JSON(w, http.StatusInternalServerError, map[string]interface{}{
				"error":     "Profile restored but version save failed",
				"code":      "PROFILE_RESTORE_PARTIAL_WRITE",
				"committed": true,
			})
			return
		}
		// Storage failure
		_ = h.writeRestoreAudit(r.Context(), p, name, intent, nil, "FAILED_NO_MUTATION", false, err)
		response.JSON(w, http.StatusInternalServerError, map[string]interface{}{
			"error":     "Profile restore failed",
			"code":      "PROFILE_RESTORE_FAILED",
			"committed": false,
		})
		return
	}

	// Success - strict audit
	if auditErr := h.writeRestoreAudit(r.Context(), p, name, intent, result, "SUCCESS", true, nil); auditErr != nil {
		response.JSON(w, http.StatusServiceUnavailable, map[string]interface{}{
			"error":     "Audit unavailable",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": true,
		})
		return
	}

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
	now := time.Now().UTC()

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
			"sliceCount":  countSliceList(intent.CurrentProfile),
		}
		if err := h.repo.SaveProfileVersion(ctx, versionRecord); err != nil {
			// Partial write - profile was restored but version save failed
			return nil, ErrRestorePartialWrite
		}
	}

	return intent.EffectiveRestored, nil
}

// writeRestoreAudit writes a restore-specific audit record with full metadata.
func (h *Handler) writeRestoreAudit(ctx context.Context, p *auth.Principal, name string, intent *RestoreIntent, restored bson.M, classification string, committed bool, errDetails error) error {
	if h.audit == nil {
		return nil
	}

	governanceMode := "DIRECT_GOVERNED"
	if p.NormalizedRole == "operator" {
		governanceMode = "APPROVAL_GOVERNED"
	}

	result := "success"
	level := "info"
	if classification == "APPROVAL_GOVERNED" {
		result = "approval_governed"
	} else if classification == "PRECONDITION_CHANGED" || classification == "FAILED_NO_MUTATION" {
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
			"approvalRequired":     p.NormalizedRole == "operator",
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

	return h.audit.WriteStrict(ctx, input)
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
	nowISO := now.Format("2006-01-02T15:04:05.000Z")

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
	for i := range b {
		b[i] = byte(time.Now().UnixNano() >> (8 * i))
	}
	return fmt.Sprintf("%x", b)
}

// writeStrictAudit writes a strict audit record and returns error on failure.
func (h *Handler) writeStrictAudit(ctx context.Context, action, targetType, targetName, username, role string, before, after any, result string, classification string, committed bool, errDetails error) error {
	if h.audit == nil {
		return nil
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
			"approvalRequired":  false,
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
