package profile

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/subscriber"
)

// Repository provides access to profile data.
type Repository struct {
	profiles    *mongo.Collection
	versions    *mongo.Collection
	subscribers *mongo.Collection

	// statsMu guards the short-lived snapshot of the subscriber counters that
	// feeds the template list. That aggregation visits every subscriber document,
	// so serving it from the cache for one bounded window keeps list latency flat
	// as the subscriber population grows instead of paying a full scan per read.
	statsMu    sync.Mutex
	statsCache *subscriberStatsSnapshot
}

// subscriberStatsTTL bounds how long a cached counter snapshot may answer the
// template list. It is a display-only figure; the delete guard and the
// per-profile stats read never consume the snapshot, so no governance decision
// is ever taken on cached data.
const subscriberStatsTTL = 30 * time.Second

// subscriberStatsSnapshot is one observed result of profileSubscriberCounts.
type subscriberStatsSnapshot struct {
	counts    map[string]profileSubscriberStats
	expiresAt time.Time
}

// NewRepository creates a new profile Repository.
func NewRepository(profiles, versions, subscribers *mongo.Collection) *Repository {
	return &Repository{
		profiles:    profiles,
		versions:    versions,
		subscribers: subscribers,
	}
}

// The template list may be ordered by any of these projected fields. The set is
// closed on purpose: a silently ignored spelling would answer a request for one
// ranking with another one, and an ordered list reads as a truthful claim.
const (
	ProfileSortName            = "name"
	ProfileSortTitle           = "title"
	ProfileSortCreatedAt       = "createdAt"
	ProfileSortUpdatedAt       = "updatedAt"
	ProfileSortSubscriberCount = "subscriberCount"
	ProfileSortSliceCount      = "sliceCount"
	ProfileSortSessionCount    = "sessionCount"
	ProfileSortPccRuleCount    = "pccRuleCount"
)

// Closed vocabulary for the billing filter; anything else is a client mistake.
const (
	ProfileBillingConfigured = "configured"
	ProfileBillingMissing    = "missing"
	ProfileBillingUnlinked   = "unlinked"
)

// profileListMaxLimit bounds one page. There is no default page size on the
// server: a request without `limit` still receives the whole (filtered) list, so
// clients that predate pagination keep their response unchanged.
const profileListMaxLimit = 200

// ErrInvalidProfileCursor reports a cursor that does not belong to the requested
// ranking, so the handler can refuse instead of resuming at an arbitrary row.
var ErrInvalidProfileCursor = fmt.Errorf("invalid cursor")

// ProfileListOrder is the requested row order for the template list. Its zero
// value is the historical order - name ascending - so a request that names no
// order yields exactly the rows clients have always received.
type ProfileListOrder struct {
	Field string
	Desc  bool
}

// ProfileListRequest is everything the list read may vary by. An empty request is
// the historical one: every template, name ascending, no cursor.
type ProfileListRequest struct {
	Order           ProfileListOrder
	Limit           int    // 0 = unbounded
	Cursor          string // opaque keyset from a previous page
	Query           string // lowercase name/title contains
	Billing         string // "", configured, missing, unlinked
	IncludeArchived bool   // default excludes archived templates
}

// ProfileListPage carries one page plus the summary of the whole (filtered)
// collection, so a paginated client never has to infer totals from the page.
type ProfileListPage struct {
	Items      []ProfileListItem
	Summary    ProfileSummary
	NextCursor string
	HasMore    bool
}

// parseProfileListOrder resolves the sort and order parameters. Absent or empty
// input yields the historical order; an unrecognised value is reported so the
// handler can refuse instead of guessing. A recency or volume ranking is asked
// highest-first by default, a name ranking alphabetically, and an explicit
// order always wins.
func parseProfileListOrder(sortRaw, orderRaw string) (ProfileListOrder, error) {
	field := strings.TrimSpace(sortRaw)
	if field == "" {
		field = ProfileSortName
	}
	switch field {
	case ProfileSortName, ProfileSortTitle, ProfileSortCreatedAt, ProfileSortUpdatedAt,
		ProfileSortSubscriberCount, ProfileSortSliceCount, ProfileSortSessionCount, ProfileSortPccRuleCount:
	default:
		return ProfileListOrder{}, fmt.Errorf(
			"sort must be name, title, createdAt, updatedAt, subscriberCount, sliceCount, sessionCount or pccRuleCount")
	}

	direction := strings.TrimSpace(orderRaw)
	if direction != "" && direction != "asc" && direction != "desc" {
		return ProfileListOrder{}, fmt.Errorf("order must be asc or desc")
	}
	desc := field != ProfileSortName && field != ProfileSortTitle
	if direction != "" {
		desc = direction == "desc"
	}
	return ProfileListOrder{Field: field, Desc: desc}, nil
}

// parseProfileListLimit reads the optional page size. Absent means "the whole
// filtered list", which is what every client written before pagination expects.
func parseProfileListLimit(raw string) (int, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(trimmed)
	if err != nil || value < 1 || value > profileListMaxLimit {
		return 0, fmt.Errorf("limit must be an integer between 1 and %d", profileListMaxLimit)
	}
	return value, nil
}

// parseProfileBillingFilter validates the billing facet.
func parseProfileBillingFilter(raw string) (string, error) {
	switch value := strings.TrimSpace(raw); value {
	case "", ProfileBillingConfigured, ProfileBillingMissing, ProfileBillingUnlinked:
		return value, nil
	default:
		return "", fmt.Errorf("billing must be configured, missing or unlinked")
	}
}

// profileCursor is the position of the last row a client received: the sort value
// plus the name that settles ties.
type profileCursor struct {
	Field string `json:"f"`
	Desc  bool   `json:"d"`
	Value string `json:"v"`
	Name  string `json:"n"`
}

func encodeProfileCursor(order ProfileListOrder, item ProfileListItem) string {
	payload, err := json.Marshal(profileCursor{
		Field: order.Field,
		Desc:  order.Desc,
		Value: profileSortValue(order.Field, item),
		Name:  item.Name,
	})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeProfileCursor(order ProfileListOrder, raw string) (profileCursor, error) {
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return profileCursor{}, ErrInvalidProfileCursor
	}
	var cursor profileCursor
	if err := json.Unmarshal(payload, &cursor); err != nil {
		return profileCursor{}, ErrInvalidProfileCursor
	}
	// A cursor is only meaningful inside the ranking it was issued for.
	if cursor.Field != order.Field || cursor.Desc != order.Desc || cursor.Name == "" {
		return profileCursor{}, ErrInvalidProfileCursor
	}
	if cursor.Value == "" && order.Field != ProfileSortCreatedAt && order.Field != ProfileSortUpdatedAt {
		return profileCursor{}, ErrInvalidProfileCursor
	}
	return cursor, nil
}

// afterCursor reports whether item sits strictly past the cursor in this ranking.
func afterCursor(order ProfileListOrder, cursor profileCursor, item ProfileListItem) bool {
	comparison := compareProfileField(order.Field, item, cursor.Value)
	if order.Desc {
		comparison = -comparison
	}
	if comparison != 0 {
		return comparison > 0
	}
	return item.Name > cursor.Name
}

// matchesProfileRequest applies the asked-for facets to a projected row. The
// console used to filter these on the client over the whole list; paging means the
// server has to own the predicate, and it is the same one.
func matchesProfileRequest(request ProfileListRequest, item ProfileListItem) bool {
	if query := strings.ToLower(strings.TrimSpace(request.Query)); query != "" {
		if !strings.Contains(strings.ToLower(item.Name), query) &&
			!strings.Contains(strings.ToLower(item.Title), query) {
			return false
		}
	}
	switch request.Billing {
	case ProfileBillingConfigured:
		return item.OCSDefaultsConfigured
	case ProfileBillingMissing:
		return !item.OCSDefaultsConfigured
	case ProfileBillingUnlinked:
		return item.SubscriberCount == 0
	default:
		return true
	}
}

// profileSortValue renders the ranking value of one row. The cursor stores the
// same textual form, so a resumed page compares exactly what the first page did.
func profileSortValue(field string, item ProfileListItem) string {
	switch field {
	case ProfileSortName:
		return item.Name
	case ProfileSortTitle:
		return item.Title
	case ProfileSortCreatedAt:
		return asSortableText(item.CreatedAt)
	case ProfileSortUpdatedAt:
		return asSortableText(item.UpdatedAt)
	case ProfileSortSubscriberCount:
		return strconv.Itoa(item.SubscriberCount)
	case ProfileSortSessionCount:
		return strconv.Itoa(item.SessionCount)
	case ProfileSortPccRuleCount:
		return strconv.Itoa(item.PccRuleCount)
	default:
		return strconv.Itoa(item.SliceCount)
	}
}

// compareProfileField compares one row against a stored ranking value.
func compareProfileField(field string, item ProfileListItem, value string) int {
	switch field {
	case ProfileSortSubscriberCount, ProfileSortSliceCount, ProfileSortSessionCount, ProfileSortPccRuleCount:
		left, leftErr := strconv.Atoi(profileSortValue(field, item))
		right, rightErr := strconv.Atoi(value)
		if leftErr != nil || rightErr != nil {
			return 0
		}
		return compareInts(left, right)
	default:
		return strings.Compare(profileSortValue(field, item), value)
	}
}

func profileFieldPresent(field string, item ProfileListItem) bool {
	switch field {
	case ProfileSortCreatedAt:
		return optionalStringPresent(item.CreatedAt)
	case ProfileSortUpdatedAt:
		return optionalStringPresent(item.UpdatedAt)
	default:
		return true
	}
}

// compareProfileItems orders two rows in the requested ranking. A row without the
// compared date is reported last in either direction - absence is not the oldest
// value - and the name always settles ties.
func compareProfileItems(order ProfileListOrder, left, right ProfileListItem) int {
	leftPresent, rightPresent := profileFieldPresent(order.Field, left), profileFieldPresent(order.Field, right)
	if leftPresent != rightPresent {
		if leftPresent {
			return -1
		}
		return 1
	}
	comparison := compareProfileField(order.Field, left, profileSortValue(order.Field, right))
	if order.Desc {
		comparison = -comparison
	}
	if comparison != 0 {
		return comparison
	}
	return strings.Compare(left.Name, right.Name)
}

// sortProfileItems applies the resolved order to the projected rows.
func sortProfileItems(items []ProfileListItem, order ProfileListOrder) {
	sort.SliceStable(items, func(i, j int) bool {
		return compareProfileItems(order, items[i], items[j]) < 0
	})
}

func asSortableText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func optionalStringPresent(value any) bool {
	return asSortableText(value) != ""
}

func compareInts(left, right int) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	default:
		return 0
	}
}

func profileListFilter(includeArchived bool) bson.M {
	if includeArchived {
		return bson.M{}
	}
	return bson.M{"archived": bson.M{"$ne": true}}
}

func profileArchived(doc bson.M) bool {
	archived, _ := doc["archived"].(bool)
	return archived
}

// ListProfiles returns one page of templates plus the summary of the whole
// collection. An unrequested page (no limit, no cursor) is the historical
// response: every template in name order.
func (r *Repository) ListProfiles(ctx context.Context, request ProfileListRequest) (ProfileListPage, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	cursor, err := r.profiles.Find(ctx, profileListFilter(request.IncludeArchived), options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return ProfileListPage{}, err
	}
	defer cursor.Close(ctx)

	var rawDocs []bson.M
	if err := cursor.All(ctx, &rawDocs); err != nil {
		return ProfileListPage{}, err
	}

	// A ranking by the subscriber counter cannot ride the short-lived snapshot: the
	// page would then be ordered by a value the response no longer shows. The live
	// aggregation is one full pass and is only paid when that ranking is asked for.
	statsMap, statsErr := r.cachedSubscriberCounts(ctx, r.profileSubscriberCounts)
	if request.Order.Field == ProfileSortSubscriberCount {
		statsMap, statsErr = r.profileSubscriberCounts(ctx)
	}
	completeness := SubscriberStatsComplete
	if statsErr != nil {
		if request.Order.Field == ProfileSortSubscriberCount {
			return ProfileListPage{}, statsErr
		}
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
			Archived:              profileArchived(doc),
			AccessRestriction:     optionalIntField(doc, "access_restriction_data"),
			AMBR:                  profileAMBR(doc),
		})
	}

	// Summary mirrors Node summarizeProfiles(): derived from the whole collection,
	// so the metric strip keeps describing the platform rather than the page.
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
		if !p.OCSDefaultsConfigured {
			summary.ProfilesWithoutBilling++
		}
	}

	matched := make([]ProfileListItem, 0, len(profiles))
	for _, item := range profiles {
		if matchesProfileRequest(request, item) {
			matched = append(matched, item)
		}
	}
	sortProfileItems(matched, request.Order)

	page := matched
	if strings.TrimSpace(request.Cursor) != "" {
		position, cursorErr := decodeProfileCursor(request.Order, request.Cursor)
		if cursorErr != nil {
			return ProfileListPage{}, cursorErr
		}
		start := len(matched)
		for index, item := range matched {
			if afterCursor(request.Order, position, item) {
				start = index
				break
			}
		}
		page = matched[start:]
	}

	pageResult := ProfileListPage{Items: page, Summary: summary}
	if request.Limit > 0 && len(page) > request.Limit {
		pageResult.Items = page[:request.Limit]
		pageResult.HasMore = true
		pageResult.NextCursor = encodeProfileCursor(request.Order, pageResult.Items[len(pageResult.Items)-1])
	}
	if pageResult.Items == nil {
		pageResult.Items = make([]ProfileListItem, 0)
	}
	return pageResult, nil
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

// profileAttributionFilter is the template surface's use of the subscriber
// attribution rule, owned by the subscriber package so statistics, the drift
// probe and the subscriber list filter cannot diverge on it. An empty template
// name never widens into an unrestricted match: it reports no subscribers.
func profileAttributionFilter(profileName string) bson.M {
	if strings.TrimSpace(profileName) == "" {
		return bson.M{"$expr": bson.M{"$literal": false}}
	}
	return subscriber.ProfileAttributionFilter(profileName)
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

	// Match Node ordering: sorted by savedAt descending (most recent first).
	// The sort runs on a normalized key because legacy snapshots stored a
	// native date while the current writers store an ISO string, and a direct
	// sort on a mixed-type field groups by type before it orders by time.
	cursor, err := r.versions.Aggregate(ctx, bson.A{
		bson.M{"$match": bson.M{"profileName": profileName}},
		bson.M{"$addFields": bson.M{"savedAtKey": savedAtSortKey()}},
		bson.M{"$sort": bson.M{"savedAtKey": -1}},
		bson.M{"$limit": int64(limit)},
	})
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

// cachedSubscriberCounts serves the template-list counters from the snapshot,
// refreshing it at most once per subscriberStatsTTL. Holding statsMu across the
// refresh also coalesces concurrent list reads into a single aggregation. The
// returned map is read-only for callers.
func (r *Repository) cachedSubscriberCounts(
	ctx context.Context,
	fetch func(context.Context) (map[string]profileSubscriberStats, error),
) (map[string]profileSubscriberStats, error) {
	r.statsMu.Lock()
	defer r.statsMu.Unlock()

	if r.statsCache != nil && time.Now().Before(r.statsCache.expiresAt) {
		return r.statsCache.counts, nil
	}

	counts, err := fetch(ctx)
	if err != nil {
		// A failed aggregation is reported to the caller, which degrades the list
		// to subscriberStatsCompleteness=unavailable. It is not replayed for the
		// whole window: one blip in the account store must not blank the counters
		// until the TTL would have expired.
		r.statsCache = nil
		return nil, err
	}

	r.statsCache = &subscriberStatsSnapshot{
		counts:    counts,
		expiresAt: time.Now().Add(subscriberStatsTTL),
	}
	return counts, nil
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

// profileTimeLayout is the single timestamp form the profile domain stores and
// serves: fixed-width UTC with millisecond precision, so a lexicographic
// comparison is also a chronological one.
const profileTimeLayout = "2006-01-02T15:04:05.000Z"

// nowProfileTime stamps a version snapshot. Every writer must use this so the
// history sorts on one type; the legacy Node writer used this same ISO string,
// while some Go writers stored a native date, and a mixed-type index sorts by
// type before time.
func nowProfileTime() string {
	return time.Now().UTC().Format(profileTimeLayout)
}

// savedAtDateFormat is the $dateToString spelling of profileTimeLayout: MongoDB
// formats dates with strftime tokens, so passing the Go layout here would
// render the same literal for every date and collapse the ordering.
const savedAtDateFormat = "%Y-%m-%dT%H:%M:%S.%LZ"

// savedAtSortKey projects any stored savedAt form onto the canonical string so
// a sort or a retention prune orders legacy dates and ISO strings together.
func savedAtSortKey() bson.M {
	return bson.M{"$switch": bson.M{
		"branches": bson.A{
			bson.M{
				"case": bson.M{"$eq": bson.A{bson.M{"$type": "$savedAt"}, "date"}},
				"then": bson.M{"$dateToString": bson.M{
					"format":   savedAtDateFormat,
					"date":     "$savedAt",
					"timezone": "UTC",
				}},
			},
		},
		"default": bson.M{"$ifNull": bson.A{"$savedAt", ""}},
	}}
}

func timeField(doc bson.M, key string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format(profileTimeLayout)
	case bson.DateTime:
		return t.Time().UTC().Format(profileTimeLayout)
	case string:
		// Version snapshots store savedAt as an ISO string, the same shape the
		// profile documents carry; without this branch the version list loses
		// every timestamp.
		return strings.TrimSpace(t)
	default:
		return ""
	}
}

func sliceCount(doc any) int {
	return arrayLen(fieldOf(doc, "sliceList"))
}

// asDocument adapts a decoded nested document to bson.M. The driver returns
// nested documents as bson.M, bson.D or map[string]any depending on the target.
//
// Read-only by contract: for bson.D the returned map is a copy, so writing
// through it detaches from the document the response marshals. Projecting a
// rewritten field must go through replaceFieldOf instead.
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

// replaceFieldOf swaps the value of a field inside a decoded document of any
// shape. It never grows the document: bson.D is a slice value, so a projection
// rewrites the whole field instead of appending into it.
func replaceFieldOf(doc any, key string, value any) bool {
	switch d := doc.(type) {
	case bson.M:
		d[key] = value
		return true
	case map[string]any:
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

// fieldOf reads one field from a decoded document of any shape and returns the
// live value, so a caller can descend into a nested document before rewriting
// the field that holds it.
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
		return t.UTC().Format(profileTimeLayout)
	case bson.DateTime:
		return t.Time().UTC().Format(profileTimeLayout)
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

	// Find versions beyond the limit. The same normalized key the history read
	// uses decides which records are stale: sorting a mixed-type field would
	// keep the newest date-typed snapshot and delete newer string-typed ones.
	cursor, err := r.versions.Aggregate(ctx, bson.A{
		bson.M{"$match": bson.M{"profileName": profileName}},
		bson.M{"$addFields": bson.M{"savedAtKey": savedAtSortKey()}},
		bson.M{"$sort": bson.M{"savedAtKey": -1}},
		bson.M{"$skip": int64(ProfileVersionLimit)},
		bson.M{"$project": bson.M{"versionId": 1}},
	})
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
