package analytics

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository provides read-only access to analytics data.
type Repository struct {
	subscribers  *mongo.Collection
	balances     *mongo.Collection
	sessions     *mongo.Collection
	reservations *mongo.Collection
	usageRecords *mongo.Collection
	ocsSubs      *mongo.Collection
	tariffPlans  *mongo.Collection
}

// NewRepository creates a Repository with the required collections.
func NewRepository(
	subscribers, balances, sessions, reservations, usageRecords, ocsSubs, tariffPlans *mongo.Collection,
) *Repository {
	return &Repository{
		subscribers:  subscribers,
		balances:     balances,
		sessions:     sessions,
		reservations: reservations,
		usageRecords: usageRecords,
		ocsSubs:      ocsSubs,
		tariffPlans:  tariffPlans,
	}
}

const defaultPlanID = "plan_default_10gb"

// usageWindowHours is the fixed trailing window for usage trend and top usage.
const usageWindowHours = 24

// invariantSampleLimit bounds the balance invariant scan. The response states
// how many accounts were actually checked so a sample is never reported as a
// platform-wide 100% claim.
const invariantSampleLimit = 500

// ComputeMetrics computes the full analytics metrics.
// Matches the Node.js computeAnalyticsMetrics() aggregation pipeline.
func (r *Repository) ComputeMetrics(ctx context.Context) (*AnalyticsMetrics, error) {
	// Run all aggregations in parallel
	type balanceResult struct {
		data *OcsBalanceMetrics
		top5 []Top5Entry
		plmn []NameValue
		err  error
	}
	type sessionResult struct {
		data *OcsSessionMetrics
		err  error
	}
	type reservationResult struct {
		data *OcsReservationMetrics
		err  error
	}
	type usageResult struct {
		data          *OcsUsageMetrics
		trend         []UsageTrendPoint
		top           []TopUsageEntry
		latest        string
		windowRecords int
		windowTotal   int64
		err           error
	}
	type tariffResult struct {
		data []TariffPlanDistItem
		err  error
	}
	type policyResult struct {
		id  int64
		ok  bool
		err error
	}

	balCh := make(chan balanceResult, 1)
	sesCh := make(chan sessionResult, 1)
	resCh := make(chan reservationResult, 1)
	useCh := make(chan usageResult, 1)
	tarCh := make(chan tariffResult, 1)
	polCh := make(chan policyResult, 1)

	go func() {
		d, t, p, err := r.computeBalanceMetrics(ctx)
		balCh <- balanceResult{d, t, p, err}
	}()
	go func() {
		d, err := r.computeSessionMetrics(ctx)
		sesCh <- sessionResult{d, err}
	}()
	go func() {
		d, err := r.computeReservationMetrics(ctx)
		resCh <- reservationResult{d, err}
	}()
	go func() {
		d, trend, top, latest, windowRecords, windowTotal, err := r.computeUsageMetrics(ctx)
		useCh <- usageResult{
			data:          d,
			trend:         trend,
			top:           top,
			latest:        latest,
			windowRecords: windowRecords,
			windowTotal:   windowTotal,
			err:           err,
		}
	}()
	go func() {
		d, err := r.computeTariffPlanDist(ctx)
		tarCh <- tariffResult{d, err}
	}()
	go func() {
		id, ok, err := r.firstActiveRatingPolicyID(ctx)
		polCh <- policyResult{id, ok, err}
	}()

	bal := <-balCh
	ses := <-sesCh
	res := <-resCh
	use := <-useCh
	tar := <-tarCh
	pol := <-polCh

	if bal.err != nil {
		return nil, fmt.Errorf("balance metrics: %w", bal.err)
	}
	if ses.err != nil {
		return nil, fmt.Errorf("session metrics: %w", ses.err)
	}
	if res.err != nil {
		return nil, fmt.Errorf("reservation metrics: %w", res.err)
	}
	if use.err != nil {
		return nil, fmt.Errorf("usage metrics: %w", use.err)
	}
	if tar.err != nil {
		return nil, fmt.Errorf("tariff plan dist: %w", tar.err)
	}
	if pol.err != nil {
		return nil, fmt.Errorf("rating policy: %w", pol.err)
	}

	// ratesDist mirrors the Node.js firstActiveRatingPolicy() derivation.
	ratesDist := []NameValue{}
	if pol.ok {
		ratesDist = []NameValue{{
			Name:  fmt.Sprintf("Group #%d", pol.id),
			Value: int64(bal.data.TotalSubscribers),
		}}
	}

	return &AnalyticsMetrics{
		// Legacy field: remaining data available, not consumed traffic.
		TotalTraffic:    int(bal.data.TotalDataAvailable),
		PlmnDist:        bal.plmn,
		RatesDist:       ratesDist,
		Top5:            bal.top5,
		Timestamp:       time.Now().UnixMilli(),
		OcsBalances:     *bal.data,
		OcsSessions:     *ses.data,
		OcsReservations: *res.data,
		TariffPlanDist:  tar.data,
		OcsUsage:        *use.data,

		UsageWindowHours:       usageWindowHours,
		UsageWindowRecords:     use.windowRecords,
		UsageWindowTotalOctets: use.windowTotal,
		UsageTrend:             use.trend,
		TopUsage:               use.top,
		LatestUsageAt:          use.latest,
	}, nil
}

// firstActiveRatingPolicyID mirrors the Node.js firstActiveRatingPolicy()
// behavior: among the default tariff plan rules with rating_group > 0 (sorted
// by rating_group ascending), the first rule whose normalized status is active
// (or the first rule when none is active) provides the rating group id.
func (r *Repository) firstActiveRatingPolicyID(ctx context.Context) (int64, bool, error) {
	var doc bson.M
	err := r.tariffPlans.FindOne(ctx, bson.M{"plan_id": defaultPlanID}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("find default plan: %w", err)
	}

	rules := asDocumentList(doc["rules"])
	type candidate struct {
		id     int64
		active bool
	}
	candidates := make([]candidate, 0, len(rules))
	for _, rule := range rules {
		id := numericInt64(rule["rating_group"])
		if id <= 0 {
			continue
		}
		candidates = append(candidates, candidate{id: id, active: isActiveStatus(rule["status"])})
	}
	if len(candidates) == 0 {
		return 0, false, nil
	}

	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].id < candidates[j].id })
	for _, c := range candidates {
		if c.active {
			return c.id, true, nil
		}
	}
	return candidates[0].id, true, nil
}

// isActiveStatus matches Node.js normalizePolicy() status handling:
// a missing/empty status defaults to 'active'; only 'active' counts as active.
func isActiveStatus(v interface{}) bool {
	if v == nil {
		return true
	}
	s, ok := v.(string)
	if !ok {
		return false
	}
	return s == "" || s == "active"
}

// ComputeSparkline returns the current subscriber count and the real hourly
// usage series for the same trailing window as ComputeMetrics.
//
// The previous implementation generated a random walk anchored at the current
// balance. That produced plausible-looking trends that were not measurements;
// the endpoint now returns real usage buckets and an explicitly empty
// subscriber history (no authoritative subscriber time series exists).
func (r *Repository) ComputeSparkline(ctx context.Context) (*SparklineResponse, error) {
	subCount, err := r.subscribers.CountDocuments(ctx, bson.M{})
	if err != nil {
		return nil, fmt.Errorf("count subscribers: %w", err)
	}

	now := time.Now().UTC()
	start := now.Truncate(time.Hour).Add(-time.Duration(usageWindowHours-1) * time.Hour)
	buckets, err := r.usageBuckets(ctx, start)
	if err != nil {
		return nil, err
	}

	trend, _, total := buildUsageTrend(start, usageWindowHours, buckets)
	traffic := make([]int64, 0, len(trend))
	for _, point := range trend {
		traffic = append(traffic, point.Octets)
	}

	return &SparklineResponse{
		Subscribers:     []int64{},
		Traffic:         traffic,
		CurrentSubCount: int(subCount),
		CurrentTraffic:  total,
	}, nil
}

func (r *Repository) computeBalanceMetrics(ctx context.Context) (*OcsBalanceMetrics, []Top5Entry, []NameValue, error) {
	// Balance aggregation
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":                 nil,
			"totalSubscribers":    bson.M{"$sum": 1},
			"totalDataAllocated":  bson.M{"$sum": "$data_total"},
			"totalDataUsed":       bson.M{"$sum": "$data_used"},
			"totalDataReserved":   bson.M{"$sum": "$data_reserved"},
			"totalDataAvailable":  bson.M{"$sum": "$data_available"},
			"totalVoiceAllocated": bson.M{"$sum": bson.M{"$ifNull": bson.A{"$voice_total", 3600}}},
			"totalVoiceUsed":      bson.M{"$sum": bson.M{"$ifNull": bson.A{"$voice_used", 0}}},
			"totalVoiceReserved":  bson.M{"$sum": bson.M{"$ifNull": bson.A{"$voice_reserved", 0}}},
			"totalVoiceAvailable": bson.M{"$sum": bson.M{"$ifNull": bson.A{"$voice_available", 3600}}},
			"totalSmsAllocated":   bson.M{"$sum": bson.M{"$ifNull": bson.A{"$sms_total", 100}}},
			"totalSmsUsed":        bson.M{"$sum": bson.M{"$ifNull": bson.A{"$sms_used", 0}}},
			"totalSmsAvailable":   bson.M{"$sum": bson.M{"$ifNull": bson.A{"$sms_available", 100}}},
			"voiceDefaulted": bson.M{"$sum": bson.M{"$cond": bson.A{
				bson.M{"$or": bson.A{
					bson.M{"$eq": bson.A{bson.M{"$type": "$voice_total"}, "missing"}},
					bson.M{"$eq": bson.A{"$voice_total", nil}},
				}},
				1, 0,
			}}},
			"smsDefaulted": bson.M{"$sum": bson.M{"$cond": bson.A{
				bson.M{"$or": bson.A{
					bson.M{"$eq": bson.A{bson.M{"$type": "$sms_total"}, "missing"}},
					bson.M{"$eq": bson.A{"$sms_total", nil}},
				}},
				1, 0,
			}}},
		}}},
	}

	cursor, err := r.balances.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("balance aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var balResults []bson.M
	if err := cursor.All(ctx, &balResults); err != nil {
		return nil, nil, nil, fmt.Errorf("decode balance: %w", err)
	}

	bSum := bson.M{}
	if len(balResults) > 0 {
		bSum = balResults[0]
	}

	totalSubs := numericInt(bSum["totalSubscribers"])
	totalDataAlloc := numericInt64(bSum["totalDataAllocated"])
	totalDataUsed := numericInt64(bSum["totalDataUsed"])
	totalDataReserved := numericInt64(bSum["totalDataReserved"])
	totalDataAvail := numericInt64(bSum["totalDataAvailable"])

	var utilRate float64
	if totalDataAlloc > 0 {
		utilRate = math.Round(float64(totalDataUsed)/float64(totalDataAlloc)*10000) / 100
	}

	// Balance invariant check. The scan is bounded and the response states the
	// exact number of accounts checked; an empty or failed scan never becomes a
	// platform-wide "all invariants OK" claim.
	brokenCount := 0
	invariantChecked := 0
	invariantScanComplete := false
	sampleCursor, err := r.balances.Find(ctx, bson.M{}, options.Find().SetLimit(invariantSampleLimit))
	if err == nil {
		defer sampleCursor.Close(ctx)
		for sampleCursor.Next(ctx) {
			var doc bson.M
			if err := sampleCursor.Decode(&doc); err != nil {
				continue
			}
			dTot := numericInt64(doc["data_total"])
			dUsed := numericInt64(doc["data_used"])
			dRes := numericInt64(doc["data_reserved"])
			dAvail := numericInt64(doc["data_available"])
			if dTot != (dUsed + dRes + dAvail) {
				brokenCount++
			}
			invariantChecked++
		}
		invariantScanComplete = sampleCursor.Err() == nil
	}

	metrics := &OcsBalanceMetrics{
		TotalSubscribers:         totalSubs,
		TotalDataAllocated:       totalDataAlloc,
		TotalDataUsed:            totalDataUsed,
		TotalDataReserved:        totalDataReserved,
		TotalDataAvailable:       totalDataAvail,
		DataUtilizationRate:      utilRate,
		TotalVoiceAllocated:      numericInt64(bSum["totalVoiceAllocated"]),
		TotalVoiceUsed:           numericInt64(bSum["totalVoiceUsed"]),
		TotalVoiceReserved:       numericInt64(bSum["totalVoiceReserved"]),
		TotalVoiceAvailable:      numericInt64(bSum["totalVoiceAvailable"]),
		TotalSmsAllocated:        numericInt64(bSum["totalSmsAllocated"]),
		TotalSmsUsed:             numericInt64(bSum["totalSmsUsed"]),
		TotalSmsAvailable:        numericInt64(bSum["totalSmsAvailable"]),
		ValidInvariantCount:      int(math.Max(0, float64(invariantChecked-brokenCount))),
		BrokenInvariantCount:     brokenCount,
		AllInvariantsOk:          invariantScanComplete && invariantChecked > 0 && brokenCount == 0,
		InvariantChecked:         invariantChecked,
		InvariantSampleLimit:     invariantSampleLimit,
		InvariantScope:           "data_balance",
		VoiceAllocationDefaulted: numericInt(bSum["voiceDefaulted"]),
		SmsAllocationDefaulted:   numericInt(bSum["smsDefaulted"]),
	}

	// Top 5
	top5Cursor, err := r.balances.Find(ctx,
		bson.M{"data_available": bson.M{"$gt": 0}},
		nil,
	)
	if err != nil {
		return metrics, nil, nil, nil
	}
	defer top5Cursor.Close(ctx)

	top5 := []Top5Entry{}
	for top5Cursor.Next(ctx) {
		var doc bson.M
		if err := top5Cursor.Decode(&doc); err != nil {
			continue
		}
		top5 = append(top5, Top5Entry{
			Imsi:         fmt.Sprintf("%v", doc["imsi"]),
			Balance:      numericInt64(doc["data_available"]),
			VoiceBalance: numericInt64(doc["voice_available"]),
			SmsBalance:   numericInt64(doc["sms_available"]),
		})
		if len(top5) >= 5 {
			break
		}
	}

	// PLMN distribution
	plmnPipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.M{"data_available": bson.M{"$gt": 0}}}},
		{{Key: "$project", Value: bson.M{
			"plmn":           bson.M{"$substrCP": bson.A{bson.M{"$ifNull": bson.A{"$imsi", "45400"}}, 0, 5}},
			"data_available": 1,
		}}},
		{{Key: "$group", Value: bson.M{"_id": "$plmn", "value": bson.M{"$sum": "$data_available"}}}},
		{{Key: "$sort", Value: bson.M{"value": -1}}},
		{{Key: "$limit", Value: 10}},
	}
	plmnCursor, err := r.balances.Aggregate(ctx, plmnPipeline)
	if err != nil {
		return metrics, top5, nil, nil
	}
	defer plmnCursor.Close(ctx)

	plmn := []NameValue{}
	for plmnCursor.Next(ctx) {
		var doc struct {
			ID    string `bson:"_id"`
			Value int64  `bson:"value"`
		}
		if err := plmnCursor.Decode(&doc); err != nil {
			continue
		}
		plmn = append(plmn, NameValue{Name: doc.ID, Value: doc.Value})
	}

	return metrics, top5, plmn, nil
}

func (r *Repository) computeSessionMetrics(ctx context.Context) (*OcsSessionMetrics, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":     nil,
			"total":   bson.M{"$sum": 1},
			"active":  bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "active"}}, 1, 0}}},
			"closing": bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "closing"}}, 1, 0}}},
			"closed":  bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "closed"}}, 1, 0}}},
			"granted": bson.M{"$sum": "$granted_total"},
			"used":    bson.M{"$sum": "$used_total"},
			"gy":      bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$interface_type", "gy"}}, 1, 0}}},
			"ro":      bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$interface_type", "ro"}}, 1, 0}}},
		}}},
	}

	cursor, err := r.sessions.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("session aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	sSum := bson.M{}
	if len(results) > 0 {
		sSum = results[0]
	}

	// APN distribution
	apnPipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{"_id": bson.M{"$ifNull": bson.A{"$apn", "internet"}}, "count": bson.M{"$sum": 1}}}},
		{{Key: "$sort", Value: bson.M{"count": -1}}},
		{{Key: "$limit", Value: 8}},
	}
	apnCursor, err := r.sessions.Aggregate(ctx, apnPipeline)
	if err != nil {
		return nil, fmt.Errorf("apn aggregate: %w", err)
	}
	defer apnCursor.Close(ctx)

	apnDist := []ApnCount{}
	for apnCursor.Next(ctx) {
		var doc struct {
			ID    string `bson:"_id"`
			Count int    `bson:"count"`
		}
		if err := apnCursor.Decode(&doc); err != nil {
			continue
		}
		apn := doc.ID
		if apn == "" {
			apn = "internet"
		}
		apnDist = append(apnDist, ApnCount{Apn: apn, Count: doc.Count})
	}
	if len(apnDist) == 0 {
		apnDist = []ApnCount{}
	}

	return &OcsSessionMetrics{
		TotalSessions:      numericInt(sSum["total"]),
		ActiveSessions:     numericInt(sSum["active"]),
		ClosingSessions:    numericInt(sSum["closing"]),
		ClosedSessions:     numericInt(sSum["closed"]),
		TotalGrantedOctets: numericInt64(sSum["granted"]),
		TotalUsedOctets:    numericInt64(sSum["used"]),
		InterfaceGyCount:   numericInt(sSum["gy"]),
		InterfaceRoCount:   numericInt(sSum["ro"]),
		ApnDistribution:    apnDist,
	}, nil
}

func (r *Repository) computeReservationMetrics(ctx context.Context) (*OcsReservationMetrics, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":           nil,
			"total":         bson.M{"$sum": 1},
			"active":        bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "active"}}, 1, 0}}},
			"settled":       bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "settled"}}, 1, 0}}},
			"released":      bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "released"}}, 1, 0}}},
			"orphaned":      bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "orphaned"}}, 1, 0}}},
			"totalReserved": bson.M{"$sum": "$reserved_octets"},
			"totalReleased": bson.M{"$sum": "$released_octets"},
			"totalUsed":     bson.M{"$sum": "$used_octets"},
		}}},
	}

	cursor, err := r.reservations.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("reservation aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	rSum := bson.M{}
	if len(results) > 0 {
		rSum = results[0]
	}

	return &OcsReservationMetrics{
		TotalReservations:    numericInt(rSum["total"]),
		ActiveReservations:   numericInt(rSum["active"]),
		SettledReservations:  numericInt(rSum["settled"]),
		ReleasedReservations: numericInt(rSum["released"]),
		OrphanedReservations: numericInt(rSum["orphaned"]),
		TotalReservedOctets:  numericInt64(rSum["totalReserved"]),
		TotalReleasedOctets:  numericInt64(rSum["totalReleased"]),
		TotalUsedOctets:      numericInt64(rSum["totalUsed"]),
	}, nil
}

func (r *Repository) computeUsageMetrics(ctx context.Context) (*OcsUsageMetrics, []UsageTrendPoint, []TopUsageEntry, string, int, int64, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":               nil,
			"totalRecords":      bson.M{"$sum": 1},
			"chargedRecords":    bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$charged", true}}, 1, 0}}},
			"totalInputOctets":  bson.M{"$sum": "$input_octets"},
			"totalOutputOctets": bson.M{"$sum": "$output_octets"},
			"totalOctets":       bson.M{"$sum": "$total_octets"},
		}}},
	}

	cursor, err := r.usageRecords.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, nil, nil, "", 0, 0, fmt.Errorf("usage aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		return nil, nil, nil, "", 0, 0, fmt.Errorf("decode: %w", err)
	}

	uSum := bson.M{}
	if len(results) > 0 {
		uSum = results[0]
	}

	latest, err := r.latestUsageAt(ctx)
	if err != nil {
		return nil, nil, nil, "", 0, 0, err
	}

	now := time.Now().UTC()
	end := now.Truncate(time.Hour)
	start := end.Add(-time.Duration(usageWindowHours-1) * time.Hour)
	buckets, err := r.usageBuckets(ctx, start)
	if err != nil {
		return nil, nil, nil, "", 0, 0, err
	}

	trend, windowRecords, windowTotal := buildUsageTrend(start, usageWindowHours, buckets)

	top, err := r.topUsage(ctx, start, windowTotal)
	if err != nil {
		return nil, nil, nil, "", 0, 0, err
	}

	return &OcsUsageMetrics{
		TotalRecords:      numericInt(uSum["totalRecords"]),
		ChargedRecords:    numericInt(uSum["chargedRecords"]),
		TotalInputOctets:  numericInt64(uSum["totalInputOctets"]),
		TotalOutputOctets: numericInt64(uSum["totalOutputOctets"]),
		TotalOctets:       numericInt64(uSum["totalOctets"]),
	}, trend, top, latest, windowRecords, windowTotal, nil
}

type usageBucket struct {
	Octets  int64
	Records int
}

// buildUsageTrend expands sparse hourly aggregation rows into a complete,
// ordered window. Missing hours carry explicit zero values; the caller already
// knows whether the window contained any records at all.
func buildUsageTrend(start time.Time, hours int, buckets map[string]usageBucket) ([]UsageTrendPoint, int, int64) {
	if hours <= 0 {
		return []UsageTrendPoint{}, 0, 0
	}
	trend := make([]UsageTrendPoint, 0, hours)
	var windowTotal int64
	var windowRecords int
	for i := 0; i < hours; i++ {
		at := start.Add(time.Duration(i) * time.Hour)
		bucket := buckets[at.Format("2006-01-02T15:00:00Z")]
		trend = append(trend, UsageTrendPoint{
			Hour:   at.Format(time.RFC3339),
			Octets: bucket.Octets,
		})
		windowTotal += bucket.Octets
		windowRecords += bucket.Records
	}
	return trend, windowRecords, windowTotal
}

func (r *Repository) usageBuckets(ctx context.Context, start time.Time) (map[string]usageBucket, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.M{"created_at": bson.M{"$gte": start}}}},
		{{Key: "$group", Value: bson.M{
			"_id": bson.M{"$dateToString": bson.M{
				"format":   "%Y-%m-%dT%H:00:00Z",
				"date":     "$created_at",
				"timezone": "UTC",
			}},
			"octets":  bson.M{"$sum": "$total_octets"},
			"records": bson.M{"$sum": 1},
		}}},
		{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}},
	}

	cursor, err := r.usageRecords.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("usage trend aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var rows []struct {
		Hour    string `bson:"_id"`
		Octets  int64  `bson:"octets"`
		Records int    `bson:"records"`
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("decode usage trend: %w", err)
	}

	buckets := make(map[string]usageBucket, len(rows))
	for _, row := range rows {
		buckets[row.Hour] = usageBucket{Octets: row.Octets, Records: row.Records}
	}
	return buckets, nil
}

func (r *Repository) topUsage(ctx context.Context, start time.Time, windowTotal int64) ([]TopUsageEntry, error) {
	if windowTotal <= 0 {
		return []TopUsageEntry{}, nil
	}

	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.M{
			"created_at":   bson.M{"$gte": start},
			"total_octets": bson.M{"$gt": 0},
		}}},
		{{Key: "$group", Value: bson.M{
			"_id":  "$imsi",
			"used": bson.M{"$sum": "$total_octets"},
		}}},
		{{Key: "$sort", Value: bson.D{{Key: "used", Value: -1}}}},
		{{Key: "$limit", Value: 5}},
	}

	cursor, err := r.usageRecords.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("top usage aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var rows []struct {
		IMSI string `bson:"_id"`
		Used int64  `bson:"used"`
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("decode top usage: %w", err)
	}

	top := make([]TopUsageEntry, 0, len(rows))
	for _, row := range rows {
		if row.IMSI == "" {
			continue
		}
		top = append(top, TopUsageEntry{
			IMSI:       row.IMSI,
			UsedOctets: row.Used,
			Share:      math.Round(float64(row.Used)/float64(windowTotal)*1000) / 10,
		})
	}
	return top, nil
}

func (r *Repository) latestUsageAt(ctx context.Context) (string, error) {
	var doc struct {
		CreatedAt time.Time `bson:"created_at"`
	}
	err := r.usageRecords.FindOne(
		ctx,
		bson.M{"created_at": bson.M{"$exists": true}},
		options.FindOne().
			SetSort(bson.D{{Key: "created_at", Value: -1}}).
			SetProjection(bson.M{"created_at": 1}),
	).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("latest usage: %w", err)
	}
	if doc.CreatedAt.IsZero() {
		return "", nil
	}
	return doc.CreatedAt.UTC().Format(time.RFC3339), nil
}

func (r *Repository) computeTariffPlanDist(ctx context.Context) ([]TariffPlanDistItem, error) {
	// Subscribers per plan
	subPipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":   bson.M{"$ifNull": bson.A{"$plan_id", defaultPlanID}},
			"count": bson.M{"$sum": 1},
		}}},
		{{Key: "$sort", Value: bson.M{"count": -1}}},
	}
	subCursor, err := r.ocsSubs.Aggregate(ctx, subPipeline)
	if err != nil {
		return nil, fmt.Errorf("sub aggregate: %w", err)
	}
	defer subCursor.Close(ctx)

	type planCount struct {
		PlanID string `bson:"_id"`
		Count  int    `bson:"count"`
	}
	var subResults []planCount
	if err := subCursor.All(ctx, &subResults); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	// All plans
	planCursor, err := r.tariffPlans.Find(ctx, bson.M{})
	if err != nil {
		return nil, fmt.Errorf("find plans: %w", err)
	}
	defer planCursor.Close(ctx)

	planMap := map[string]bson.M{}
	for planCursor.Next(ctx) {
		var doc bson.M
		if err := planCursor.Decode(&doc); err != nil {
			continue
		}
		if pid, ok := doc["plan_id"].(string); ok {
			planMap[pid] = doc
		}
	}

	totalSubs := 0
	for _, sc := range subResults {
		totalSubs += sc.Count
	}

	result := []TariffPlanDistItem{}
	for _, sc := range subResults {
		planID := sc.PlanID
		if planID == "" {
			planID = defaultPlanID
		}
		pct := 0.0
		if totalSubs > 0 {
			pct = math.Round(float64(sc.Count)/float64(totalSubs)*1000) / 10
		}
		planDoc := planMap[planID]
		name := planID
		status := "active"
		if planDoc != nil {
			if n, ok := planDoc["name"].(string); ok && n != "" {
				name = n
			}
			if s, ok := planDoc["status"].(string); ok {
				status = s
			}
		}
		result = append(result, TariffPlanDistItem{
			PlanID:          planID,
			Name:            name,
			SubscriberCount: sc.Count,
			Percentage:      pct,
			Status:          status,
		})
	}

	// If no subscribers but plans exist, list plans with 0
	if len(result) == 0 && len(planMap) > 0 {
		for pid, doc := range planMap {
			name := pid
			status := "active"
			if n, ok := doc["name"].(string); ok && n != "" {
				name = n
			}
			if s, ok := doc["status"].(string); ok {
				status = s
			}
			result = append(result, TariffPlanDistItem{
				PlanID:          pid,
				Name:            name,
				SubscriberCount: 0,
				Percentage:      0,
				Status:          status,
			})
		}
	}

	if len(result) == 0 {
		result = []TariffPlanDistItem{}
	}

	return result, nil
}

func numericInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case int32:
		return int(n)
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return 0
	}
}

func numericInt64(v interface{}) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	default:
		return 0
	}
}

// asDocument normalizes a dynamically decoded BSON document into a plain map.
// The driver decodes nested documents into bson.D by default (arrays become
// bson.A), so all shapes are tolerated.
func asDocument(v interface{}) (map[string]interface{}, bool) {
	switch m := v.(type) {
	case bson.M:
		return m, true
	case map[string]interface{}:
		return m, true
	case bson.D:
		out := make(map[string]interface{}, len(m))
		for _, elem := range m {
			out[elem.Key] = elem.Value
		}
		return out, true
	default:
		return nil, false
	}
}

// asDocumentList extracts a document array from a dynamically decoded BSON
// value, skipping non-document entries.
func asDocumentList(v interface{}) []map[string]interface{} {
	var items []interface{}
	switch a := v.(type) {
	case bson.A:
		items = a
	case []interface{}:
		items = a
	}
	out := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		if doc, ok := asDocument(item); ok {
			out = append(out, doc)
		}
	}
	return out
}
