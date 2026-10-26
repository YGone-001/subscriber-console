package profile

// ProfileListResponse matches GET /api/profiles response shape.
type ProfileListResponse struct {
	Profiles []ProfileListItem `json:"profiles"`
	Summary  ProfileSummary    `json:"summary"`
}

// ProfileListItem matches Node ProfileListItem from listProfiles().
type ProfileListItem struct {
	Name                  string `json:"name"`
	Title                 string `json:"title"`
	SliceCount            int    `json:"sliceCount"`
	CreatedAt             any    `json:"createdAt"`
	UpdatedAt             any    `json:"updatedAt"`
	UpdatedBy             any    `json:"updatedBy"`
	SubscriberCount       int    `json:"subscriberCount"`
	ImpactedSubscribers   int    `json:"impactedSubscribers"`
	ActiveSubscribers     int    `json:"activeSubscribers"`
	SuspendedSubscribers  int    `json:"suspendedSubscribers"`
	RestrictedSubscribers int    `json:"restrictedSubscribers"`
	SessionCount          int    `json:"sessionCount"`
	PccRuleCount          int    `json:"pccRuleCount"`
	OCSDefaultsConfigured bool   `json:"ocsDefaultsConfigured"`
	// AccessRestriction is null when the template carries no
	// access_restriction_data, which is distinct from an explicit 0.
	AccessRestriction *int                `json:"accessRestriction"`
	AMBR              *ProfileAmbrSummary `json:"ambr"`
}

// ProfileAmbrSummary is the UE-AMBR a template declares, when declared.
type ProfileAmbrSummary struct {
	Downlink *ProfileAmbrSide `json:"downlink"`
	Uplink   *ProfileAmbrSide `json:"uplink"`
}

// ProfileAmbrSide is one direction of a UE-AMBR.
type ProfileAmbrSide struct {
	Unit  int   `json:"unit"`
	Value int64 `json:"value"`
}

// Subscriber statistics completeness states for GET /api/profiles.
const (
	SubscriberStatsComplete    = "complete"
	SubscriberStatsUnavailable = "unavailable"
)

// ProfileSummary matches Node ProfileGlobalSummary from summarizeProfiles().
type ProfileSummary struct {
	TotalProfiles            int `json:"totalProfiles"`
	TotalGovernedSubscribers int `json:"totalGovernedSubscribers"`
	ActiveSubscribers        int `json:"activeSubscribers"`
	SuspendedSubscribers     int `json:"suspendedSubscribers"`
	RestrictedSubscribers    int `json:"restrictedSubscribers"`
	UnassignedProfiles       int `json:"unassignedProfiles"`
	// SubscriberStatsCompleteness reports whether the subscriber counter
	// aggregation ran. Unavailable counts must be presented as unavailable,
	// never as zero.
	SubscriberStatsCompleteness string `json:"subscriberStatsCompleteness"`
}

// ProfileDetailResponse matches GET /api/profiles/:name response shape.
type ProfileDetailResponse struct {
	Profile map[string]any `json:"profile"`
	Stats   *ProfileStats  `json:"stats"`
	// StatsCompleteness reports whether the subscriber attribution ran. A failed
	// aggregation must not fail the whole read, and must never read as zeroes.
	StatsCompleteness string `json:"statsCompleteness"`
}

// ProfileStatsResponse matches GET /api/profiles/:name/stats response shape.
type ProfileStatsResponse struct {
	Stats        *ProfileStats `json:"stats"`
	Completeness string        `json:"completeness"`
}

// ProfileStats holds subscriber statistics for a profile.
type ProfileStats struct {
	ProfileName           string   `json:"profileName"`
	TotalSubscribers      int      `json:"totalSubscribers"`
	ActiveSubscribers     int      `json:"activeSubscribers"`
	SuspendedSubscribers  int      `json:"suspendedSubscribers"`
	RestrictedSubscribers int      `json:"restrictedSubscribers"`
	SampleImsis           []string `json:"sampleImsis"`
}

// ProfileVersionsResponse matches GET /api/profiles/:name/versions response shape.
type ProfileVersionsResponse struct {
	Versions []ProfileVersionSummary `json:"versions"`
	Current  *ProfileCurrentSummary  `json:"current"`
	// ProfileExists reports whether the template is still stored. Deleting a
	// template keeps its snapshots, so the history can still be read and used to
	// bring it back; the flag keeps that difference visible.
	ProfileExists bool `json:"profileExists"`
}

// ProfileVersionDetailResponse matches the versionId branch of
// GET /api/profiles/:name/versions.
type ProfileVersionDetailResponse struct {
	Version map[string]any `json:"version"`
}

// ProfileMetaResponse matches GET /api/profiles/meta.
type ProfileMetaResponse struct {
	Capabilities      ProfileCapabilities          `json:"capabilities"`
	AccessRestriction ProfileAccessRestrictionMeta `json:"accessRestriction"`
}

// ProfileCapabilities reports what the requesting principal may do with a
// template. The server is the authority; the UI only mirrors it.
type ProfileCapabilities struct {
	CanWrite             bool   `json:"canWrite"`
	CanRestore           bool   `json:"canRestore"`
	CredentialVisibility string `json:"credentialVisibility"`
}

// ProfileAccessRestrictionMeta is the 3GPP access-restriction vocabulary.
type ProfileAccessRestrictionMeta struct {
	Unrestricted int                           `json:"unrestricted"`
	Suspended    int                           `json:"suspended"`
	Bits         []ProfileAccessRestrictionBit `json:"bits"`
}

// ProfileAccessRestrictionBit is one named bit of access_restriction_data.
type ProfileAccessRestrictionBit struct {
	Value int    `json:"value"`
	Key   string `json:"key"`
}

// ProfileVersionSummary is a summarized version record.
type ProfileVersionSummary struct {
	VersionID   string `json:"versionId"`
	ProfileName string `json:"profileName,omitempty"`
	Action      string `json:"action"`
	SavedAt     string `json:"savedAt,omitempty"`
	SavedBy     string `json:"savedBy,omitempty"`
	Title       string `json:"title,omitempty"`
	SliceCount  int    `json:"sliceCount"`
}

// ProfileCurrentSummary is the current profile summary shown in versions list.
type ProfileCurrentSummary struct {
	Title      string `json:"title"`
	UpdatedAt  any    `json:"updatedAt"`
	UpdatedBy  any    `json:"updatedBy"`
	SliceCount int    `json:"sliceCount"`
	// Revision is the write counter a client preconditions its next save on.
	Revision int64 `json:"revision"`
}

// ── Write Request/Response Types ────────────────────────────────────────────

// CreateProfileResponse matches POST /api/profiles response shape.
type CreateProfileResponse struct {
	Message string `json:"message"`
	Name    string `json:"name"`
}

// UpdateProfileResponse matches PUT /api/profiles/:name response shape.
type UpdateProfileResponse struct {
	Message string `json:"message"`
}

// DeleteProfileResponse matches DELETE /api/profiles/:name response shape.
type DeleteProfileResponse struct {
	Message string `json:"message"`
}
