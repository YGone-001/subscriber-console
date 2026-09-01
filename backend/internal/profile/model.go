package profile

// ProfileListResponse matches GET /api/profiles response shape.
type ProfileListResponse struct {
	Profiles []ProfileListItem `json:"profiles"`
	Summary  ProfileSummary    `json:"summary"`
}

// ProfileListItem represents a single profile in the list.
type ProfileListItem struct {
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	SliceCount  int    `json:"sliceCount"`
	CreatedAt   string `json:"createdAt,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
	CreatedBy   string `json:"createdBy,omitempty"`
	UpdatedBy   string `json:"updatedBy,omitempty"`
}

// ProfileSummary is the global summary object.
type ProfileSummary struct {
	TotalProfiles     int `json:"totalProfiles"`
	TotalSubscribers  int `json:"totalSubscribers"`
	ActiveSubscribers int `json:"activeSubscribers"`
}

// ProfileDetailResponse matches GET /api/profiles/:name response shape.
type ProfileDetailResponse struct {
	Profile map[string]any `json:"profile"`
	Stats   *ProfileStats  `json:"stats"`
}

// ProfileStatsResponse matches GET /api/profiles/:name/stats response shape.
type ProfileStatsResponse struct {
	Stats ProfileStats `json:"stats"`
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
}

// ProfileVersionSummary is a summarized version record.
type ProfileVersionSummary struct {
	VersionID string `json:"versionId"`
	Action    string `json:"action"`
	SavedAt   string `json:"savedAt,omitempty"`
	SavedBy   string `json:"savedBy,omitempty"`
	Title     string `json:"title,omitempty"`
}

// ProfileCurrentSummary is the current profile summary shown in versions list.
type ProfileCurrentSummary struct {
	Title      string `json:"title"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
	UpdatedBy  string `json:"updatedBy,omitempty"`
	SliceCount int    `json:"sliceCount"`
}
