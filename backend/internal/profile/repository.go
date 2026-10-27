package profile

import (
	"context"
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository provides access to profile data.
type Repository struct {
	profiles    *mongo.Collection
	versions    *mongo.Collection
	subscribers *mongo.Collection
}

// NewRepository creates a new profile Repository.
func NewRepository(profiles, versions, subscribers *mongo.Collection) *Repository {
	return &Repository{
		profiles:    profiles,
		versions:    versions,
		subscribers: subscribers,
	}
}

// ListProfiles returns all profiles with global summary.
func (r *Repository) ListProfiles(ctx context.Context) ([]ProfileListItem, ProfileSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	cursor, err := r.profiles.Find(ctx, bson.M{}, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, ProfileSummary{}, err
	}
	defer cursor.Close(ctx)

	var rawDocs []bson.M
	if err := cursor.All(ctx, &rawDocs); err != nil {
		return nil, ProfileSummary{}, err
	}

	statsMap, statsErr := r.profileSubscriberCounts(ctx)
	completeness := SubscriberStatsComplete
	if statsErr != nil {
		statsMap = map[string]profileSubscriberStats{}
		completeness = SubscriberStatsUnavailable
	}

	profiles := make([]ProfileListItem, 0, len(rawDocs))
	for _, doc := range rawDocs {
		name := stringField(doc, "name")
		stats := statsMap[name]
		title := stringField(doc, "title")
		if title == "" {
			title = name
		}
		sessionCount, pccRuleCount := profileContentSummary(doc)
		profiles = append(profiles, ProfileListItem{
			Name:                  name,
			Title:                 title,
			SliceCount:            sliceCount(doc),
			CreatedAt:             jsonDateOrNull(doc, "createdAt"),
			UpdatedAt:             jsonDateOrNull(doc, "updatedAt"),
			UpdatedBy:             firstStringField(doc, "updatedBy", "createdBy"),
			SubscriberCount:       stats.total,
			ImpactedSubscribers:   stats.total,
			ActiveSubscribers:     stats.active,
			SuspendedSubscribers:  stats.suspended,
			RestrictedSubscribers: stats.restricted,
			SessionCount:          sessionCount,
			PccRuleCount:          pccRuleCount,
			OCSDefaultsConfigured: hasOCSDefaults(doc),
			AccessRestriction:     optionalIntField(doc, "access_restriction_data"),
			AMBR:                  profileAMBR(doc),
		})
	}

	// Summary mirrors Node summarizeProfiles(): derived from the profile list
	// so both response sections stay consistent.
	summary := ProfileSummary{
		TotalProfiles:               len(profiles),
		SubscriberStatsCompleteness: completeness,
	}
	for _, p := range profiles {
		summary.TotalGovernedSubscribers += p.SubscriberCount
		summary.ActiveSubscribers += p.ActiveSubscribers
		summary.SuspendedSubscribers += p.SuspendedSubscribers
		summary.RestrictedSubscribers += p.RestrictedSubscribers
		if p.SubscriberCount == 0 {
			summary.UnassignedProfiles++
		}
	}

	return profiles, summary, nil
}

// GetProfile returns a single profile by name, or nil if not found.
func (r *Repository) GetProfile(ctx context.Context, name string) (bson.M, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := r.profiles.FindOne(ctx, bson.M{"name": name}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Convert BSON to map, hiding _id
	delete(doc, "_id")
	return doc, nil
}

// GetProfileVersion returns a specific version by profileName and versionId.
// Returns nil if not found.
func (r *Repository) GetProfileVersion(ctx context.Context, profileName, versionId string) (bson.M, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := r.versions.FindOne(ctx, bson.M{
		"profileName": profileName,
		"versionId":   versionId,
	}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return doc, nil
}

// GetProfileStats returns subscriber statistics for a profile.
// Queries xcloud.subscribers (cross-domain read, no writes).
func (r *Repository) GetProfileStats(ctx context.Context, profileName string) (ProfileStats, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := profileAttributionFilter(profileName)

	// Count by status
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: filter}},
		{{Key: "$group", Value: bson.M{
			"_id":   nil,
			"total": bson.M{"$sum": 1},
			"active": bson.M{"$sum": bson.M{
				"$cond": bson.A{
					bson.M{"$or": bson.A{
						bson.M{"$eq": bson.A{"$access_restriction_data", 32}},
						bson.M{"$eq": bson.A{"$access_restriction_data", 0}},
						bson.M{"$not": bson.A{"$access_restriction_data"}},
						bson.M{"$eq": bson.A{"$access_restriction_data", nil}},
					}},
					1, 0,
				},
			}},
			"suspended": bson.M{"$sum": bson.M{
				"$cond": bson.A{
					bson.M{"$eq": bson.A{"$access_restriction_data", 255}},
					1, 0,
				},
			}},
			"restricted": bson.M{"$sum": bson.M{
				"$cond": bson.A{
					bson.M{"$and": bson.A{
						bson.M{"$gt": bson.A{"$access_restriction_data", 0}},
						bson.M{"$ne": bson.A{"$access_restriction_data", 32}},
						bson.M{"$ne": bson.A{"$access_restriction_data", 255}},
					}},
					1, 0,
				},
			}},
		}}},
	}

	cursor, err := r.subscribers.Aggregate(ctx, pipeline)
	if err != nil {
		return ProfileStats{ProfileName: profileName, SampleImsis: []string{}}, err
	}
	defer cursor.Close(ctx)

	stats := ProfileStats{
		ProfileName: profileName,
		SampleImsis: []string{},
	}

	if cursor.Next(ctx) {
		var agg struct {
			Total      int `bson:"total"`
			Active     int `bson:"active"`
			Suspended  int `bson:"suspended"`
			Restricted int `bson:"restricted"`
		}
		if err := cursor.Decode(&agg); err == nil {
			stats.TotalSubscribers = agg.Total
			stats.ActiveSubscribers = agg.Active
			stats.SuspendedSubscribers = agg.Suspended
			stats.RestrictedSubscribers = agg.Restricted
		}
	}

	// Sample IMSIs
	sampleCursor, err := r.subscribers.Find(ctx, filter,
		options.Find().SetSort(bson.D{{Key: "imsi", Value: 1}}).SetLimit(10).SetProjection(bson.M{"imsi": 1}))
	if err == nil {
		defer sampleCursor.Close(ctx)
		for sampleCursor.Next(ctx) {
			var doc bson.M
			if sampleCursor.Decode(&doc) == nil {
				if imsi, ok := doc["imsi"]; ok {
					stats.SampleImsis = append(stats.SampleImsis, stringify(imsi))
				}
			}
		}
	}

	return stats, nil
}

// profileAttributionFilter is the single attribution rule of the template
// surface: a subscriber counts as linked when any of the four legacy fields
// names the template. Statistics and the drift probe must not diverge on it.
func profileAttributionFilter(profileName string) bson.M {
	return bson.M{
		"$or": bson.A{
			bson.M{"webui_meta.profile_name": profileName},
			bson.M{"webui_meta.profile": profileName},
			bson.M{"profile_name": profileName},
			bson.M{"profile": profileName},
		},
	}
}

// ListSubscribersAttributedTo loads the provisioning documents of the
// subscribers linked to a template. It fetches limit + 1 documents so the caller
// can tell a complete read from a truncated one. The documents are compared in
// memory and never serialized into a response.
func (r *Repository) ListSubscribersAttributedTo(ctx context.Context, profileName string, limit int) ([]bson.M, error) {
	return r.findSubscribers(ctx, profileAttributionFilter(profileName), limit)
}

// ListSubscribersByImsis loads the provisioning documents of an explicit IMSI
// set under the same bound.
func (r *Repository) ListSubscribersByImsis(ctx context.Context, imsis []string, limit int) ([]bson.M, error) {
	if len(imsis) == 0 {
		return nil, nil
	}
	return r.findSubscribers(ctx, bson.M{"imsi": bson.M{"$in": imsis}}, limit)
}

func (r *Repository) findSubscribers(ctx context.Context, filter bson.M, limit int) ([]bson.M, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	cursor, err := r.subscribers.Find(ctx, filter,
		options.Find().SetSort(bson.D{{Key: "imsi", Value: 1}}).SetLimit(int64(limit)+1))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	docs := make([]bson.M, 0, limit)
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		docs = append(docs, doc)
		if len(docs) > limit {
			// One over the bound: the caller reports truncation instead of a
			// partial list that looks complete.
			return docs, nil
		}
	}
	return docs, cursor.Err()
}

// ListProfileVersions returns version history for a profile.
func (r *Repository) ListProfileVersions(ctx context.Context, profileName string, limit int) ([]ProfileVersionSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 20
	}

	// Match Node ordering: sorted by savedAt descending (most recent first)
	cursor, err := r.versions.Find(ctx,
		bson.M{"profileName": profileName},
		options.Find().SetSort(bson.D{{Key: "savedAt", Value: -1}}).SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var versions []ProfileVersionSummary
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		v := ProfileVersionSummary{
			VersionID:   stringField(doc, "versionId"),
			ProfileName: stringField(doc, "profileName"),
			Action:      stringField(doc, "action"),
			SavedAt:     timeField(doc, "savedAt"),
			SavedBy:     stringField(doc, "savedBy"),
			Title:       stringField(doc, "title"),
			SliceCount:  int(aggregationInt(doc["sliceCount"])),
		}
		// Records written before the counter was projected carry no sliceCount;
		// the stored snapshot remains authoritative.
		if v.SliceCount == 0 {
			if snapshot := asDocument(doc["profile"]); snapshot != nil {
				v.SliceCount = arrayLen(snapshot["sliceList"])
			}
		}
		versions = append(versions, v)
	}

	if versions == nil {
		versions = []ProfileVersionSummary{}
	}

	return versions, nil
}

// profileSubscriberStats holds per-profile subscriber counters.
type profileSubscriberStats struct {
	total      int
	active     int
	suspended  int
	restricted int
}

// profileSubscriberCounts mirrors Node getProfileSubscriberCounts(): a single
// aggregation over xcloud.subscribers keyed by the coalesced profile name.
func (r *Repository) profileSubscriberCounts(ctx context.Context) (map[string]profileSubscriberStats, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$project", Value: bson.M{
			"profileName": bson.M{"$ifNull": bson.A{
				"$webui_meta.profile_name",
				bson.M{"$ifNull": bson.A{
					"$webui_meta.profile",
					bson.M{"$ifNull": bson.A{
						"$profile_name",
						bson.M{"$ifNull": bson.A{"$profile", ""}},
					}},
				}},
			}},
			"access_restriction_data": 1,
		}}},
		{{Key: "$match", Value: bson.M{"profileName": bson.M{"$exists": true, "$ne": ""}}}},
		{{Key: "$group", Value: bson.M{
			"_id":              "$profileName",
			"totalSubscribers": bson.M{"$sum": 1},
			"activeSubscribers": bson.M{"$sum": bson.M{"$cond": bson.A{
				bson.M{"$or": bson.A{
					bson.M{"$eq": bson.A{"$access_restriction_data", 32}},
					bson.M{"$eq": bson.A{"$access_restriction_data", 0}},
					bson.M{"$not": bson.A{"$access_restriction_data"}},
					bson.M{"$eq": bson.A{"$access_restriction_data", nil}},
				}},
				1, 0,
			}}},
			"suspendedSubscribers": bson.M{"$sum": bson.M{"$cond": bson.A{
				bson.M{"$eq": bson.A{"$access_restriction_data", 255}}, 1, 0,
			}}},
			"restrictedSubscribers": bson.M{"$sum": bson.M{"$cond": bson.A{
				bson.M{"$and": bson.A{
					bson.M{"$gt": bson.A{"$access_restriction_data", 0}},
					bson.M{"$ne": bson.A{"$access_restriction_data", 32}},
					bson.M{"$ne": bson.A{"$access_restriction_data", 255}},
				}},
				1, 0,
			}}},
		}}},
	}

	cursor, err := r.subscribers.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		return nil, err
	}

	statsMap := make(map[string]profileSubscriberStats, len(results))
	for _, item := range results {
		id, ok := item["_id"].(string)
		if !ok {
			continue
		}
		key := strings.TrimSpace(id)
		if key == "" {
			continue
		}
		statsMap[key] = profileSubscriberStats{
			total:      int(aggregationInt(item["totalSubscribers"])),
			active:     int(aggregationInt(item["activeSubscribers"])),
			suspended:  int(aggregationInt(item["suspendedSubscribers"])),
			restricted: int(aggregationInt(item["restrictedSubscribers"])),
		}
	}
	return statsMap, nil
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func stringField(doc bson.M, key string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func timeField(doc bson.M, key string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.DateTime:
		return t.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	case string:
		// Version snapshots store savedAt as an ISO string, the same shape the
		// profile documents carry; without this branch the version list loses
		// every timestamp.
		return strings.TrimSpace(t)
	default:
		return ""
	}
}

func sliceCount(doc bson.M) int {
	v, ok := doc["sliceList"]
	if !ok || v == nil {
		return 0
	}
	if arr, ok := v.(bson.A); ok {
		return len(arr)
	}
	return 0
}

// asDocument adapts a decoded nested document to bson.M. The driver returns
// nested documents as bson.M, bson.D or map[string]any depending on the target.
//
// Read-only by contract: for bson.D the returned map is a copy, so writing
// through it detaches from the document the response marshals. Projecting a
// masked or otherwise rewritten field must go through setFieldOf instead.
func asDocument(v any) bson.M {
	switch doc := v.(type) {
	case bson.M:
		return doc
	case map[string]any:
		return bson.M(doc)
	case bson.D:
		converted := make(bson.M, len(doc))
		for _, elem := range doc {
			converted[elem.Key] = elem.Value
		}
		return converted
	}
	return nil
}

// fieldOf reads one field from a decoded document of any shape and returns the
// live value, so callers can descend into nested documents and still mutate
// them in place. It is the read counterpart of setFieldOf.
func fieldOf(doc any, key string) any {
	switch d := doc.(type) {
	case bson.M:
		return d[key]
	case map[string]any:
		return d[key]
	case bson.D:
		for i := range d {
			if d[i].Key == key {
				return d[i].Value
			}
		}
	}
	return nil
}

// setFieldOf rewrites a field inside a decoded document of any shape, in place.
// bson.D must be mutated through its element slice: copying it into a map first
// would leave the marshalled response untouched and turn the write into a
// silent no-op. Missing keys are not created; false reports "nothing rewritten".
func setFieldOf(doc any, key string, value any) bool {
	switch d := doc.(type) {
	case bson.M:
		if _, ok := d[key]; !ok {
			return false
		}
		d[key] = value
		return true
	case map[string]any:
		if _, ok := d[key]; !ok {
			return false
		}
		d[key] = value
		return true
	case bson.D:
		for i := range d {
			if d[i].Key == key {
				d[i].Value = value
				return true
			}
		}
	}
	return false
}

// arrayLen reports the length of a decoded array regardless of element type.
func arrayLen(v any) int {
	return len(asArray(v))
}

// asArray adapts a decoded array to []any regardless of the concrete type.
func asArray(v any) []any {
	switch arr := v.(type) {
	case bson.A:
		return arr
	case []any:
		return arr
	}
	return nil
}

// numericInt64 converts a decoded BSON numeric value.
func numericInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case float64:
		return int64(n), true
	case float32:
		return int64(n), true
	}
	return 0, false
}

// profileContentSummary counts sessions and PCC rules across a template's
// slices, so the list can describe what a template actually contains.
func profileContentSummary(doc bson.M) (sessionCount, pccRuleCount int) {
	for _, sliceValue := range asArray(doc["sliceList"]) {
		sliceDoc := asDocument(sliceValue)
		if sliceDoc == nil {
			continue
		}
		for _, sessionValue := range asArray(sliceDoc["session_list"]) {
			sessionCount++
			if sessionDoc := asDocument(sessionValue); sessionDoc != nil {
				pccRuleCount += arrayLen(sessionDoc["pcc_rule"])
			}
		}
	}
	return sessionCount, pccRuleCount
}

// hasOCSDefaults reports whether the template declares billing defaults. An
// empty object counts as not configured.
func hasOCSDefaults(doc bson.M) bool {
	return len(asDocument(doc["ocsDefaults"])) > 0
}

// optionalIntField returns nil when the field is absent or not numeric, keeping
// "missing" distinct from an explicit zero.
func optionalIntField(doc bson.M, key string) *int {
	value, ok := numericInt64(doc[key])
	if !ok {
		return nil
	}
	converted := int(value)
	return &converted
}

// profileAMBR projects a template's UE-AMBR, or nil when it declares none.
func profileAMBR(doc bson.M) *ProfileAmbrSummary {
	ambrDoc := asDocument(doc["ambr"])
	if ambrDoc == nil {
		return nil
	}
	downlink := profileAMBRSide(ambrDoc["downlink"])
	uplink := profileAMBRSide(ambrDoc["uplink"])
	if downlink == nil && uplink == nil {
		return nil
	}
	return &ProfileAmbrSummary{Downlink: downlink, Uplink: uplink}
}

func profileAMBRSide(v any) *ProfileAmbrSide {
	side := asDocument(v)
	if side == nil {
		return nil
	}
	value, ok := numericInt64(side["value"])
	if !ok {
		return nil
	}
	unit, ok := numericInt64(side["unit"])
	if !ok {
		return nil
	}
	return &ProfileAmbrSide{Unit: int(unit), Value: value}
}

// jsonDateOrNull mirrors Node truthy-or-null date handling: Date values become
// ISO strings, non-empty strings pass through, everything else becomes null.
func jsonDateOrNull(doc bson.M, key string) any {
	v, ok := doc[key]
	if !ok || v == nil {
		return nil
	}
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.DateTime:
		return t.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	case string:
		if t == "" {
			return nil
		}
		return t
	default:
		return nil
	}
}

// firstStringField returns the first non-empty string field, or nil.
func firstStringField(doc bson.M, keys ...string) any {
	for _, key := range keys {
		if s := stringField(doc, key); s != "" {
			return s
		}
	}
	return nil
}

// firstNonNullDate returns the first date-like field as JSON value, or null.
func firstNonNullDate(doc bson.M, keys ...string) any {
	for _, key := range keys {
		if v := jsonDateOrNull(doc, key); v != nil {
			return v
		}
	}
	return nil
}

// aggregationInt converts aggregation-produced numeric values.
func aggregationInt(v any) int64 {
	switch val := v.(type) {
	case int32:
		return int64(val)
	case int64:
		return val
	case float64:
		return int64(val)
	default:
		return 0
	}
}

// profileRevision reads the monotonic write counter of a stored template. A
// template created before the counter existed reads as revision 0, so its first
// write moves it to 1.
func profileRevision(doc bson.M) int64 {
	switch value := doc["revision"].(type) {
	case int64:
		return value
	case int32:
		return int64(value)
	case float64:
		return int64(value)
	default:
		return 0
	}
}

// expectedRevisionFrom reads the optional client precondition. Absent or null
// means "no precondition", which keeps clients that predate the counter working;
// a malformed value is reported so the caller can fail closed.
func expectedRevisionFrom(body map[string]any) (value int64, present bool, valid bool) {
	raw, present := body["expectedRevision"]
	if !present || raw == nil {
		return 0, false, true
	}
	switch typed := raw.(type) {
	case float64:
		return int64(typed), true, true
	case int64:
		return typed, true, true
	default:
		return 0, true, false
	}
}

func stringify(v any) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	default:
		return fmt.Sprintf("%v", v)
	}
}

// ── Write Primitives ────────────────────────────────────────────────────────

const ProfileVersionLimit = 50

// InsertProfileCreateOnly inserts a new profile document using InsertOne.
// Returns PROFILE_EXISTS error if the profile name already exists.
func (r *Repository) InsertProfileCreateOnly(ctx context.Context, doc bson.M) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, err := r.profiles.InsertOne(ctx, doc)
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return ErrProfileExists
		}
		return err
	}
	return nil
}

// ReplaceProfileCAS replaces a profile document using CAS (expected document match).
// Returns nil on success, ErrProfilePreconditionChanged if the document changed,
// or other errors.
func (r *Repository) ReplaceProfileCAS(ctx context.Context, name string, expected bson.M, updated bson.M) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Build filter from expected document (match all fields except _id)
	filter := bson.M{"name": name}
	if expected != nil {
		// Use the full expected document as filter for CAS
		filter = bson.M{}
		for k, v := range expected {
			if k == "_id" {
				continue
			}
			filter[k] = v
		}
	}

	result, err := r.profiles.ReplaceOne(ctx, filter, updated)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return ErrProfilePreconditionChanged
	}
	return nil
}

// DeleteProfileCAS deletes a profile document using CAS.
// Returns nil on success, ErrProfilePreconditionChanged if the document changed,
// or other errors.
func (r *Repository) DeleteProfileCAS(ctx context.Context, name string, expected bson.M) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Build filter from expected document
	filter := bson.M{"name": name}
	if expected != nil {
		filter = bson.M{}
		for k, v := range expected {
			if k == "_id" {
				continue
			}
			filter[k] = v
		}
	}

	result, err := r.profiles.DeleteOne(ctx, filter)
	if err != nil {
		return err
	}
	if result.DeletedCount == 0 {
		return ErrProfilePreconditionChanged
	}
	return nil
}

// SaveProfileVersion saves a profile version record and prunes old versions.
func (r *Repository) SaveProfileVersion(ctx context.Context, record bson.M) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, err := r.versions.InsertOne(ctx, record)
	if err != nil {
		return err
	}

	// Prune old versions beyond the limit
	profileName, _ := record["profileName"].(string)
	if profileName == "" {
		return nil
	}

	// Find versions beyond the limit
	cursor, err := r.versions.Find(ctx,
		bson.M{"profileName": profileName},
		options.Find().
			SetSort(bson.D{{Key: "savedAt", Value: -1}}).
			SetSkip(int64(ProfileVersionLimit)).
			SetProjection(bson.M{"versionId": 1}),
	)
	if err != nil {
		return fmt.Errorf("query stale versions: %w", err)
	}
	defer cursor.Close(ctx)

	var staleIDs []string
	for cursor.Next(ctx) {
		var doc bson.M
		if cursor.Decode(&doc) == nil {
			if vid, ok := doc["versionId"].(string); ok {
				staleIDs = append(staleIDs, vid)
			}
		}
	}

	if len(staleIDs) > 0 {
		_, err = r.versions.DeleteMany(ctx, bson.M{"versionId": bson.M{"$in": staleIDs}})
		if err != nil {
			return fmt.Errorf("prune stale versions: %w", err)
		}
	}

	return nil
}

// CountSubscribersByProfile counts subscribers using a specific profile.
func (r *Repository) CountSubscribersByProfile(ctx context.Context, profileName string) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := profileAttributionFilter(profileName)

	return r.subscribers.CountDocuments(ctx, filter)
}
