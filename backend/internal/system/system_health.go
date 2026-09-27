package system

import (
	"context"
	"fmt"
	"math"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type hssSubscriberSample struct {
	k       string
	opc     string
	slices  []any
	profile string
}

// CheckComprehensiveSystemHealth evaluates all subsystems and calculates a composite score.
func CheckComprehensiveSystemHealth(ctx context.Context, xcloudDb, appDb *mongo.Database) (*ComprehensiveSystemHealth, error) {
	// 1. Run Mongo Health Check
	mongoReport, err := CheckMongoHealth(ctx, xcloudDb, appDb)
	if err != nil {
		return nil, fmt.Errorf("mongo health check failed: %w", err)
	}

	// 2. Telemetry aggregations
	balanceColl := xcloudDb.Collection("ocs_balances")
	sessionColl := xcloudDb.Collection("ocs_sessions")
	resColl := xcloudDb.Collection("ocs_reservations")
	tariffColl := xcloudDb.Collection("ocs_tariff_plans")
	subColl := xcloudDb.Collection("subscribers")
	profileColl := appDb.Collection("app_profiles")
	userColl := appDb.Collection("app_users")
	alertColl := appDb.Collection("app_alerts")
	auditColl := appDb.Collection("app_audit_logs")

	// Balance aggregation
	balanceAggPipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "totalSubscribers", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "totalAllocated", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$data_total", 0}}}}}},
			{Key: "totalUsed", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$data_used", 0}}}}}},
			{Key: "totalReserved", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$data_reserved", 0}}}}}},
			{Key: "totalAvailable", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$data_available", 0}}}}}},
		}}},
	}
	var balanceAggResult []bson.M
	bCursor, err := balanceColl.Aggregate(ctx, balanceAggPipeline)
	if err == nil {
		_ = bCursor.All(ctx, &balanceAggResult)
	}

	// Balance samples (limit 500)
	var balanceSamples []bson.M
	sampleCursor, err := balanceColl.Find(ctx, bson.M{}, options.Find().SetLimit(500))
	if err == nil {
		_ = sampleCursor.All(ctx, &balanceSamples)
	}

	// Sessions aggregation
	sessionAggPipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "active", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$state", "active"}}}, 1, 0}}}}}},
			{Key: "closing", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$state", "closing"}}}, 1, 0}}}}}},
		}}},
	}
	var sessionAggResult []bson.M
	sCursor, err := sessionColl.Aggregate(ctx, sessionAggPipeline)
	if err == nil {
		_ = sCursor.All(ctx, &sessionAggResult)
	}

	// Reservations aggregation
	resAggPipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "active", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$state", "active"}}}, 1, 0}}}}}},
			{Key: "orphaned", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$state", "orphaned"}}}, 1, 0}}}}}},
			{Key: "totalReservedOctets", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$reserved_octets", 0}}}}}},
		}}},
	}
	var resAggResult []bson.M
	rCursor, err := resColl.Aggregate(ctx, resAggPipeline)
	if err == nil {
		_ = rCursor.All(ctx, &resAggResult)
	}

	// Tariff plans count
	tariffPlanCount, _ := tariffColl.CountDocuments(ctx, bson.M{})

	// HSS subscribers sample (limit 1000)
	var hssDocs []bson.M
	subCursor, err := subColl.Find(ctx, bson.M{}, options.Find().
		SetProjection(bson.D{
			{Key: "imsi", Value: 1},
			{Key: "security", Value: 1},
			{Key: "slice", Value: 1},
			{Key: "profile", Value: 1},
			{Key: "profile_name", Value: 1},
			{Key: "webui_meta.profile_name", Value: 1},
		}).
		SetLimit(1000))
	if err == nil {
		_ = subCursor.All(ctx, &hssDocs)
	}
	hssSubscribers := make([]hssSubscriberSample, 0, len(hssDocs))
	for _, doc := range hssDocs {
		var k, opc string
		if sec, ok := doc["security"].(bson.M); ok {
			k, _ = sec["k"].(string)
			opc, _ = sec["opc"].(string)
		} else if secD, ok := doc["security"].(bson.D); ok {
			for _, elem := range secD {
				if elem.Key == "k" {
					k, _ = elem.Value.(string)
				} else if elem.Key == "opc" {
					opc, _ = elem.Value.(string)
				}
			}
		}

		var slices []any
		if sl, ok := doc["slice"].(bson.A); ok {
			slices = sl
		}

		prof := ""
		if meta, ok := doc["webui_meta"].(bson.M); ok {
			prof, _ = meta["profile_name"].(string)
		} else if metaD, ok := doc["webui_meta"].(bson.D); ok {
			for _, elem := range metaD {
				if elem.Key == "profile_name" {
					prof, _ = elem.Value.(string)
				}
			}
		}
		if prof == "" {
			prof, _ = doc["profile_name"].(string)
		}
		if prof == "" {
			prof, _ = doc["profile"].(string)
		}

		hssSubscribers = append(hssSubscribers, hssSubscriberSample{
			k:       k,
			opc:     opc,
			slices:  slices,
			profile: prof,
		})
	}

	// Active profiles
	var profileDocs []bson.M
	pCursor, err := profileColl.Find(ctx, bson.M{}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err == nil {
		_ = pCursor.All(ctx, &profileDocs)
	}
	activeProfileSet := make(map[string]bool, len(profileDocs))
	for _, p := range profileDocs {
		if name, ok := p["name"].(string); ok && name != "" {
			activeProfileSet[name] = true
		}
	}

	// App users count
	usersCount, _ := userColl.CountDocuments(ctx, bson.M{})

	// Active Alerts aggregation
	alertAggPipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "unacknowledged", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$is_acknowledged", false}}}, 1, 0}}}}}},
			{Key: "critical", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$and", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$is_acknowledged", false}}}, bson.D{{Key: "$eq", Value: bson.A{"$level", "CRITICAL"}}}}}}, 1, 0}}}}}},
			{Key: "warning", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$and", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$is_acknowledged", false}}}, bson.D{{Key: "$eq", Value: bson.A{"$level", "WARNING"}}}}}}, 1, 0}}}}}},
		}}},
	}
	var alertAggResult []bson.M
	aCursor, err := alertColl.Aggregate(ctx, alertAggPipeline)
	if err == nil {
		_ = aCursor.All(ctx, &alertAggResult)
	}

	// Recent audit logs count (last 24h)
	oneDayAgo := time.Now().Add(-24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	auditLogCount, _ := auditColl.CountDocuments(ctx, bson.M{"timestamp": bson.M{"$gte": oneDayAgo}})

	// Balance invariant check
	brokenInvariantsCount := 0
	for _, b := range balanceSamples {
		tot := toInt(b["data_total"])
		used := toInt(b["data_used"])
		res := toInt(b["data_reserved"])
		avail := toInt(b["data_available"])
		if tot != (used + res + avail) {
			brokenInvariantsCount++
		}
	}

	// Database subsystem evaluation
	dbMissingCollections := len(mongoReport.MissingCollections)
	dbMissingIndexes := len(mongoReport.MissingIndexes)
	var dbStatus SubsystemStatus = StatusHealthy
	if !mongoReport.OK || dbMissingCollections > 0 || dbMissingIndexes > 0 {
		if dbMissingCollections > 0 {
			dbStatus = StatusCritical
		} else {
			dbStatus = StatusDegraded
		}
	}

	latencyMs := int64(0)
	if mongoReport.LatencyMs != nil {
		latencyMs = *mongoReport.LatencyMs
	}

	existingCount := 0
	for _, c := range mongoReport.Collections {
		if c.Exists {
			existingCount++
		}
	}

	databaseSubsystem := DatabaseSubsystemHealth{
		Status:                  dbStatus,
		LatencyMs:               latencyMs,
		XCloudDB:                xcloudDb.Name(),
		AppDB:                   appDb.Name(),
		Ready:                   mongoReport.OK,
		TotalCollections:        len(mongoReport.Collections),
		ExistingCollections:     existingCount,
		MissingCollectionsCount: dbMissingCollections,
		MissingIndexesCount:     dbMissingIndexes,
		Report:                  *mongoReport,
	}

	// OCS subsystem evaluation
	var bData bson.M
	if len(balanceAggResult) > 0 {
		bData = balanceAggResult[0]
	}
	var sData bson.M
	if len(sessionAggResult) > 0 {
		sData = sessionAggResult[0]
	}
	var rData bson.M
	if len(resAggResult) > 0 {
		rData = resAggResult[0]
	}

	totalAllocated := toInt(bData["totalAllocated"])
	totalUsed := toInt(bData["totalUsed"])
	var utilizationRate float64
	if totalAllocated > 0 {
		utilizationRate = math.Round((float64(totalUsed)/float64(totalAllocated))*10000) / 100
	}
	orphanedReservations := toInt(rData["orphaned"])

	var ocsStatus SubsystemStatus = StatusHealthy
	if brokenInvariantsCount > 0 || tariffPlanCount == 0 {
		ocsStatus = StatusCritical
	} else if orphanedReservations > 0 || utilizationRate > 90 {
		ocsStatus = StatusDegraded
	}

	ocsSubsystem := OcsSubsystemHealth{
		Status:                ocsStatus,
		TotalSubscribers:      toInt(bData["totalSubscribers"]),
		TotalAllocatedOctets:  totalAllocated,
		TotalUsedOctets:       totalUsed,
		TotalReservedOctets:   toInt(rData["totalReservedOctets"]),
		TotalAvailableOctets:  toInt(bData["totalAvailable"]),
		UtilizationRate:       utilizationRate,
		InvariantsOk:          brokenInvariantsCount == 0,
		BrokenInvariantsCount: brokenInvariantsCount,
		ActiveSessions:        toInt(sData["active"]),
		ClosingSessions:       toInt(sData["closing"]),
		ActiveReservations:    toInt(rData["active"]),
		OrphanedReservations:  orphanedReservations,
		ActiveTariffPlans:     tariffPlanCount,
	}

	// HSS subsystem evaluation
	var missingCredentialsCount int64
	var missingSlicesCount int64
	var danglingProfilesCount int64
	for _, sub := range hssSubscribers {
		if sub.k == "" || sub.opc == "" {
			missingCredentialsCount++
		}
		if len(sub.slices) == 0 {
			missingSlicesCount++
		}
		if sub.profile != "" && !activeProfileSet[sub.profile] {
			danglingProfilesCount++
		}
	}

	var hssStatus SubsystemStatus = StatusHealthy
	if missingCredentialsCount > 0 || missingSlicesCount > 0 {
		hssStatus = StatusCritical
	} else if danglingProfilesCount > 0 {
		hssStatus = StatusDegraded
	}

	validCreds := int64(len(hssSubscribers)) - missingCredentialsCount
	if validCreds < 0 {
		validCreds = 0
	}
	validSlices := int64(len(hssSubscribers)) - missingSlicesCount
	if validSlices < 0 {
		validSlices = 0
	}

	hssSubsystem := HssSubsystemHealth{
		Status:                  hssStatus,
		TotalSubscribers:        int64(len(hssSubscribers)),
		ValidCredentialsCount:   validCreds,
		MissingCredentialsCount: missingCredentialsCount,
		ValidSlicesCount:        validSlices,
		MissingSlicesCount:      missingSlicesCount,
		ActiveProfilesCount:     int64(len(profileDocs)),
		DanglingProfilesCount:   danglingProfilesCount,
	}

	// Security subsystem evaluation
	var alertStats bson.M
	if len(alertAggResult) > 0 {
		alertStats = alertAggResult[0]
	}
	rootUserConfigured := usersCount > 0
	criticalAlerts := toInt(alertStats["critical"])
	warningAlerts := toInt(alertStats["warning"])

	var securityStatus SubsystemStatus = StatusHealthy
	if !rootUserConfigured || criticalAlerts > 0 {
		securityStatus = StatusCritical
	} else if warningAlerts > 0 {
		securityStatus = StatusDegraded
	}

	securitySubsystem := SecuritySubsystemHealth{
		Status:                    securityStatus,
		RootUserConfigured:        rootUserConfigured,
		ActiveUsersCount:          usersCount,
		UnacknowledgedAlertsCount: toInt(alertStats["unacknowledged"]),
		CriticalAlertsCount:       criticalAlerts,
		WarningAlertsCount:        warningAlerts,
		RecentAuditLogsCount:      auditLogCount,
	}

	// Recommendations and actionable items
	recommendations := make([]string, 0)
	actionableItemsCount := 0

	if dbMissingCollections > 0 || dbMissingIndexes > 0 {
		recommendations = append(recommendations, fmt.Sprintf("Run MongoDB index initialization (npm run mongo:init) to restore %d missing indexes", dbMissingIndexes))
		actionableItemsCount++
	}
	if brokenInvariantsCount > 0 {
		recommendations = append(recommendations, fmt.Sprintf("Resolve %d OCS balance invariant inconsistencies", brokenInvariantsCount))
		actionableItemsCount++
	}
	if orphanedReservations > 0 {
		recommendations = append(recommendations, fmt.Sprintf("Clean up %d orphaned in-flight quota reservations", orphanedReservations))
		actionableItemsCount++
	}
	if missingCredentialsCount > 0 || missingSlicesCount > 0 {
		recommendations = append(recommendations, fmt.Sprintf("Fix %d malformed HSS subscriber records", missingCredentialsCount+missingSlicesCount))
		actionableItemsCount++
	}
	if danglingProfilesCount > 0 {
		recommendations = append(recommendations, fmt.Sprintf("Rebind %d subscribers referencing missing profile templates", danglingProfilesCount))
		actionableItemsCount++
	}
	if criticalAlerts > 0 {
		recommendations = append(recommendations, fmt.Sprintf("Acknowledge and triage %d critical operational alerts in NOC", criticalAlerts))
		actionableItemsCount++
	}

	// Score calculation
	score := 100
	if dbStatus == StatusCritical {
		score -= 35
	} else if dbStatus == StatusDegraded {
		score -= 15
	}

	if ocsStatus == StatusCritical {
		score -= 25
	} else if ocsStatus == StatusDegraded {
		score -= 10
	}

	if hssStatus == StatusCritical {
		score -= 20
	} else if hssStatus == StatusDegraded {
		score -= 8
	}

	if securityStatus == StatusCritical {
		score -= 20
	} else if securityStatus == StatusDegraded {
		score -= 10
	}

	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}

	var overallStatus SubsystemStatus
	if score >= 90 && dbStatus == StatusHealthy && ocsStatus == StatusHealthy {
		overallStatus = StatusHealthy
	} else if score < 70 || dbStatus == StatusCritical || ocsStatus == StatusCritical {
		overallStatus = StatusCritical
	} else {
		overallStatus = StatusDegraded
	}

	totalAnomaliesDetected := brokenInvariantsCount + int(orphanedReservations) + int(missingCredentialsCount) + int(missingSlicesCount) + int(danglingProfilesCount) + int(criticalAlerts)

	return &ComprehensiveSystemHealth{
		Status:    overallStatus,
		Score:     score,
		CheckedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Subsystems: SystemSubsystems{
			Database:  databaseSubsystem,
			OCSEngine: ocsSubsystem,
			HSSCore:   hssSubsystem,
			Security:  securitySubsystem,
		},
		Summary: HealthSummary{
			TotalAnomaliesDetected: totalAnomaliesDetected,
			ActionableItemsCount:   actionableItemsCount,
			Recommendations:        recommendations,
		},
	}, nil
}
