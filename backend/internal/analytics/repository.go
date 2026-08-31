package analytics

import (
	"context"
	"fmt"
	"math"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
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
		data *OcsUsageMetrics
		err  error
	}
	type tariffResult struct {
		data []TariffPlanDistItem
		err  error
	}

	balCh := make(chan balanceResult, 1)
	sesCh := make(chan sessionResult, 1)
	resCh := make(chan reservationResult, 1)
	useCh := make(chan usageResult, 1)
	tarCh := make(chan tariffResult, 1)

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
		d, err := r.computeUsageMetrics(ctx)
		useCh <- usageResult{d, err}
	}()
	go func() {
		d, err := r.computeTariffPlanDist(ctx)
		tarCh <- tariffResult{d, err}
	}()

	bal := <-balCh
	ses := <-sesCh
	res := <-resCh
	use := <-useCh
	tar := <-tarCh

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

	return &AnalyticsMetrics{
		TotalTraffic:    int(bal.data.TotalDataAvailable),
		PlmnDist:        bal.plmn,
		RatesDist:       []NameValue{}, // Will be populated if policy exists
		Top5:            bal.top5,
		Timestamp:       time.Now().UnixMilli(),
		OcsBalances:     *bal.data,
		OcsSessions:     *ses.data,
		OcsReservations: *res.data,
		TariffPlanDist:  tar.data,
		OcsUsage:        *use.data,
	}, nil
}

// ComputeSparkline computes the sparkline basis.
func (r *Repository) ComputeSparkline(ctx context.Context) (*SparklineResponse, error) {
	subCount, err := r.subscribers.CountDocuments(ctx, bson.M{})
	if err != nil {
		return nil, fmt.Errorf("count subscribers: %w", err)
	}

	// Get total data available for traffic
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":           nil,
			"totalDataAvail": bson.M{"$sum": "$data_available"},
		}}},
	}
	cursor, err := r.balances.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("aggregate balances: %w", err)
	}
	defer cursor.Close(ctx)

	var results []struct {
		TotalDataAvail int64 `bson:"totalDataAvail"`
	}
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	var traffic int64
	if len(results) > 0 {
		traffic = results[0].TotalDataAvail
	}

	return &SparklineResponse{
		CurrentSubCount: int(subCount),
		CurrentTraffic:  traffic,
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

	// Balance invariant check (sample 500)
	brokenCount := 0
	sampleCursor, err := r.balances.Find(ctx, bson.M{}, nil)
	if err == nil {
		defer sampleCursor.Close(ctx)
		count := 0
		for sampleCursor.Next(ctx) && count < 500 {
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
			count++
		}
	}

	metrics := &OcsBalanceMetrics{
		TotalSubscribers:     totalSubs,
		TotalDataAllocated:   totalDataAlloc,
		TotalDataUsed:        totalDataUsed,
		TotalDataReserved:    totalDataReserved,
		TotalDataAvailable:   totalDataAvail,
		DataUtilizationRate:  utilRate,
		TotalVoiceAllocated:  numericInt64(bSum["totalVoiceAllocated"]),
		TotalVoiceUsed:       numericInt64(bSum["totalVoiceUsed"]),
		TotalVoiceReserved:   numericInt64(bSum["totalVoiceReserved"]),
		TotalVoiceAvailable:  numericInt64(bSum["totalVoiceAvailable"]),
		TotalSmsAllocated:    numericInt64(bSum["totalSmsAllocated"]),
		TotalSmsUsed:         numericInt64(bSum["totalSmsUsed"]),
		TotalSmsAvailable:    numericInt64(bSum["totalSmsAvailable"]),
		ValidInvariantCount:  int(math.Max(0, float64(totalSubs-brokenCount))),
		BrokenInvariantCount: brokenCount,
		AllInvariantsOk:      brokenCount == 0,
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
			"plmn": bson.M{"$substrCP": bson.A{bson.M{"$ifNull": bson.A{"$imsi", "45400"}}, 0, 5}},
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
			"_id":          nil,
			"total":        bson.M{"$sum": 1},
			"active":       bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "active"}}, 1, 0}}},
			"settled":      bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "settled"}}, 1, 0}}},
			"released":     bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "released"}}, 1, 0}}},
			"orphaned":     bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$state", "orphaned"}}, 1, 0}}},
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

func (r *Repository) computeUsageMetrics(ctx context.Context) (*OcsUsageMetrics, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":             nil,
			"totalRecords":    bson.M{"$sum": 1},
			"chargedRecords":  bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$charged", true}}, 1, 0}}},
			"totalInputOctets":  bson.M{"$sum": "$input_octets"},
			"totalOutputOctets": bson.M{"$sum": "$output_octets"},
			"totalOctets":       bson.M{"$sum": "$total_octets"},
		}}},
	}

	cursor, err := r.usageRecords.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("usage aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	uSum := bson.M{}
	if len(results) > 0 {
		uSum = results[0]
	}

	return &OcsUsageMetrics{
		TotalRecords:      numericInt(uSum["totalRecords"]),
		ChargedRecords:    numericInt(uSum["chargedRecords"]),
		TotalInputOctets:  numericInt64(uSum["totalInputOctets"]),
		TotalOutputOctets: numericInt64(uSum["totalOutputOctets"]),
		TotalOctets:       numericInt64(uSum["totalOctets"]),
	}, nil
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
