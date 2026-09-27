package system

import (
	"context"
	"fmt"
	"strconv"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const defaultOcsPlanID = "default-standard"

func parseCursorOffset(cursor string) int64 {
	offset, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil || offset < 0 {
		return 0
	}
	return offset
}

func getString(doc bson.M, key string) string {
	if val, ok := doc[key].(string); ok {
		return val
	}
	return ""
}

// ScanSubscriberDocuments performs an audit scan over subscriber documents across phases.
// Supported phases: "reservation", "tariff", "ocs", "sub" (default). Strictly read-only.
func ScanSubscriberDocuments(ctx context.Context, xcloudDb, appDb *mongo.Database, cursorStr, phase string) (*AuditScanResponse, error) {
	offset := parseCursorOffset(cursorStr)
	limit := int64(1000)
	anomalies := make([]SystemAnomaly, 0)

	// Phase: reservation
	if phase == "reservation" {
		resColl := xcloudDb.Collection("ocs_reservations")
		sessColl := xcloudDb.Collection("ocs_sessions")

		var reservations []bson.M
		cursor, err := resColl.Find(ctx, bson.M{}, options.Find().SetSkip(offset).SetLimit(limit))
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)
		if err := cursor.All(ctx, &reservations); err != nil {
			return nil, err
		}

		if len(reservations) > 0 {
			sessionIDs := make([]string, 0, len(reservations))
			for _, r := range reservations {
				sid := getString(r, "session_id")
				if sid != "" {
					sessionIDs = append(sessionIDs, sid)
				}
			}

			activeSessionIDs := make(map[string]bool)
			if len(sessionIDs) > 0 {
				var activeSessions []bson.M
				sCursor, err := sessColl.Find(ctx, bson.M{"session_id": bson.M{"$in": sessionIDs}})
				if err == nil {
					_ = sCursor.All(ctx, &activeSessions)
					for _, s := range activeSessions {
						sid := getString(s, "session_id")
						if sid != "" {
							activeSessionIDs[sid] = true
						}
					}
				}
			}

			for _, res := range reservations {
				sid := getString(res, "session_id")
				state := getString(res, "state")
				if sid == "" || !activeSessionIDs[sid] || state == "orphaned" {
					imsi := getString(res, "imsi")
					if imsi == "" {
						imsi = "UNKNOWN"
					}
					resID := getString(res, "reservation_id")
					if resID == "" {
						resID = "unknown"
					}
					anomalies = append(anomalies, SystemAnomaly{
						IMSI:     imsi,
						Type:     "orphan_reservation",
						Details:  fmt.Sprintf("Orphaned quota reservation [%s] with missing active session", resID),
						Severity: "warning",
						Category: "reservation",
					})
				}
			}
		}

		nextCursor := "0"
		if int64(len(reservations)) == limit {
			nextCursor = strconv.FormatInt(offset+limit, 10)
		}

		return &AuditScanResponse{
			NextCursor:   nextCursor,
			ScannedCount: len(reservations),
			Anomalies:    anomalies,
		}, nil
	}

	// Phase: tariff
	if phase == "tariff" {
		ocsSubColl := xcloudDb.Collection("ocs_subscribers")
		tariffPlansColl := xcloudDb.Collection("ocs_tariff_plans")

		var ocsSubs []bson.M
		cursor, err := ocsSubColl.Find(ctx, bson.M{}, options.Find().SetSkip(offset).SetLimit(limit))
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)
		if err := cursor.All(ctx, &ocsSubs); err != nil {
			return nil, err
		}

		var allPlans []bson.M
		pCursor, err := tariffPlansColl.Find(ctx, bson.M{})
		if err == nil {
			_ = pCursor.All(ctx, &allPlans)
		}
		planIDSet := make(map[string]bool, len(allPlans))
		for _, p := range allPlans {
			pid := getString(p, "plan_id")
			if pid != "" {
				planIDSet[pid] = true
			}
		}

		for _, sub := range ocsSubs {
			planID := getString(sub, "plan_id")
			if planID == "" || !planIDSet[planID] {
				planDisplay := planID
				if planDisplay == "" {
					planDisplay = "none"
				}
				anomalies = append(anomalies, SystemAnomaly{
					IMSI:     getString(sub, "imsi"),
					Type:     "invalid_tariff",
					Details:  fmt.Sprintf("Subscriber assigned to invalid or missing tariff plan: %s", planDisplay),
					Severity: "warning",
					Category: "tariff",
				})
			}
		}

		nextCursor := "0"
		if int64(len(ocsSubs)) == limit {
			nextCursor = strconv.FormatInt(offset+limit, 10)
		}

		return &AuditScanResponse{
			NextCursor:   nextCursor,
			ScannedCount: len(ocsSubs),
			Anomalies:    anomalies,
		}, nil
	}

	// Phase: ocs
	if phase == "ocs" {
		subColl := xcloudDb.Collection("subscribers")
		ocsSubColl := xcloudDb.Collection("ocs_subscribers")
		balanceColl := xcloudDb.Collection("ocs_balances")
		tariffPlansColl := xcloudDb.Collection("ocs_tariff_plans")

		var rows []bson.M
		cursor, err := subColl.Find(ctx, bson.M{}, options.Find().
			SetProjection(bson.D{{Key: "imsi", Value: 1}}).
			SetSort(bson.D{{Key: "imsi", Value: 1}}).
			SetSkip(offset).
			SetLimit(limit))
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)
		if err := cursor.All(ctx, &rows); err != nil {
			return nil, err
		}

		imsis := make([]string, 0, len(rows))
		for _, r := range rows {
			imsi := getString(r, "imsi")
			if imsi != "" {
				imsis = append(imsis, imsi)
			}
		}

		ocsByImsi := make(map[string]bson.M)
		if len(imsis) > 0 {
			var ocsSubs []bson.M
			cur, err := ocsSubColl.Find(ctx, bson.M{"imsi": bson.M{"$in": imsis}})
			if err == nil {
				_ = cur.All(ctx, &ocsSubs)
				for _, s := range ocsSubs {
					ocsByImsi[getString(s, "imsi")] = s
				}
			}
		}

		balanceByImsi := make(map[string]bson.M)
		if len(imsis) > 0 {
			var balances []bson.M
			cur, err := balanceColl.Find(ctx, bson.M{"imsi": bson.M{"$in": imsis}})
			if err == nil {
				_ = cur.All(ctx, &balances)
				for _, b := range balances {
					balanceByImsi[getString(b, "imsi")] = b
				}
			}
		}

		for _, row := range rows {
			imsi := getString(row, "imsi")
			ocsSub, hasOcsSub := ocsByImsi[imsi]
			balance, hasBalance := balanceByImsi[imsi]

			if !hasOcsSub || !hasBalance {
				missingPart := ""
				if !hasOcsSub {
					missingPart += "ocs_subscribers"
				}
				if !hasOcsSub && !hasBalance {
					missingPart += " and "
				}
				if !hasBalance {
					missingPart += "ocs_balances"
				}
				anomalies = append(anomalies, SystemAnomaly{
					IMSI:     imsi,
					Type:     "missing_config",
					Details:  fmt.Sprintf("Missing %s", missingPart),
					Severity: "critical",
					Category: "ocs",
				})
				continue
			}

			planID := getString(ocsSub, "plan_id")
			if planID == "" {
				planID = defaultOcsPlanID
			}

			var plan bson.M
			err := tariffPlansColl.FindOne(ctx, bson.M{"plan_id": planID}).Decode(&plan)
			if err != nil {
				anomalies = append(anomalies, SystemAnomaly{
					IMSI:     imsi,
					Type:     "invalid_tariff",
					Details:  fmt.Sprintf("Missing tariff plan %s", planID),
					Severity: "warning",
					Category: "tariff",
				})
				continue
			}

			tot := toInt(balance["data_total"])
			used := toInt(balance["data_used"])
			res := toInt(balance["data_reserved"])
			avail := toInt(balance["data_available"])
			if tot != used+res+avail {
				anomalies = append(anomalies, SystemAnomaly{
					IMSI:     imsi,
					Type:     "balance_mismatch",
					Details:  fmt.Sprintf("OCS data balance invariant mismatch: total (%d) != used (%d) + reserved (%d) + available (%d)", tot, used, res, avail),
					Severity: "critical",
					Category: "ocs",
				})
			}

			// Voice balance
			if balance["voice_total"] == nil || balance["voice_used"] == nil ||
				balance["voice_reserved"] == nil || balance["voice_available"] == nil {
				anomalies = append(anomalies, SystemAnomaly{
					IMSI:     imsi,
					Type:     "balance_mismatch",
					Details:  "OCS voice balance fields missing",
					Severity: "warning",
					Category: "ocs",
				})
			} else {
				vTot := toInt(balance["voice_total"])
				vUsed := toInt(balance["voice_used"])
				vRes := toInt(balance["voice_reserved"])
				vAvail := toInt(balance["voice_available"])
				if vTot != vUsed+vRes+vAvail {
					anomalies = append(anomalies, SystemAnomaly{
						IMSI:     imsi,
						Type:     "balance_mismatch",
						Details:  "OCS voice balance invariant mismatch",
						Severity: "critical",
						Category: "ocs",
					})
				}
			}

			// SMS balance
			if balance["sms_total"] == nil || balance["sms_used"] == nil || balance["sms_available"] == nil {
				anomalies = append(anomalies, SystemAnomaly{
					IMSI:     imsi,
					Type:     "balance_mismatch",
					Details:  "OCS SMS balance fields missing",
					Severity: "warning",
					Category: "ocs",
				})
			} else {
				sTot := toInt(balance["sms_total"])
				sUsed := toInt(balance["sms_used"])
				sAvail := toInt(balance["sms_available"])
				if sTot != sUsed+sAvail {
					anomalies = append(anomalies, SystemAnomaly{
						IMSI:     imsi,
						Type:     "balance_mismatch",
						Details:  "OCS SMS balance invariant mismatch",
						Severity: "critical",
						Category: "ocs",
					})
				}
			}
		}

		nextCursor := "0"
		if int64(len(rows)) == limit {
			nextCursor = strconv.FormatInt(offset+limit, 10)
		}

		return &AuditScanResponse{
			NextCursor:   nextCursor,
			ScannedCount: len(rows),
			Anomalies:    anomalies,
		}, nil
	}

	// Default Phase: sub
	subColl := xcloudDb.Collection("subscribers")
	profileColl := appDb.Collection("app_profiles")

	var rows []bson.M
	cursor, err := subColl.Find(ctx, bson.M{}, options.Find().
		SetProjection(bson.D{
			{Key: "imsi", Value: 1},
			{Key: "security", Value: 1},
			{Key: "slice", Value: 1},
			{Key: "ambr", Value: 1},
			{Key: "profile", Value: 1},
			{Key: "profile_name", Value: 1},
			{Key: "webui_meta.profile_name", Value: 1},
		}).
		SetSort(bson.D{{Key: "imsi", Value: 1}}).
		SetSkip(offset).
		SetLimit(limit))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}

	var profiles []bson.M
	pCursor, err := profileColl.Find(ctx, bson.M{})
	if err == nil {
		_ = pCursor.All(ctx, &profiles)
	}
	profileNameSet := make(map[string]bool, len(profiles))
	for _, p := range profiles {
		name := getString(p, "name")
		if name != "" {
			profileNameSet[name] = true
		}
	}

	for _, row := range rows {
		imsi := getString(row, "imsi")

		var k, opc string
		if sec, ok := row["security"].(bson.M); ok {
			k = getString(sec, "k")
			opc = getString(sec, "opc")
		} else if secD, ok := row["security"].(bson.D); ok {
			for _, elem := range secD {
				if elem.Key == "k" {
					k, _ = elem.Value.(string)
				} else if elem.Key == "opc" {
					opc, _ = elem.Value.(string)
				}
			}
		}

		var sliceCount int
		if sl, ok := row["slice"].(bson.A); ok {
			sliceCount = len(sl)
		}
		hasAmbr := row["ambr"] != nil

		if k == "" || opc == "" || sliceCount == 0 || !hasAmbr {
			anomalies = append(anomalies, SystemAnomaly{
				IMSI:     imsi,
				Type:     "missing_config",
				Details:  "Missing HSS subscriber authentication or slice config",
				Severity: "critical",
				Category: "hss",
			})
		}

		assignedProfile := ""
		if meta, ok := row["webui_meta"].(bson.M); ok {
			assignedProfile = getString(meta, "profile_name")
		} else if metaD, ok := row["webui_meta"].(bson.D); ok {
			for _, elem := range metaD {
				if elem.Key == "profile_name" {
					assignedProfile, _ = elem.Value.(string)
				}
			}
		}
		if assignedProfile == "" {
			assignedProfile = getString(row, "profile_name")
		}
		if assignedProfile == "" {
			assignedProfile = getString(row, "profile")
		}

		if assignedProfile != "" && !profileNameSet[assignedProfile] {
			anomalies = append(anomalies, SystemAnomaly{
				IMSI:     imsi,
				Type:     "dangling_profile",
				Details:  fmt.Sprintf("Subscriber references deleted or non-existent profile template: %s", assignedProfile),
				Severity: "warning",
				Category: "profile",
			})
		}
	}

	nextCursor := "0"
	if int64(len(rows)) == limit {
		nextCursor = strconv.FormatInt(offset+limit, 10)
	}

	return &AuditScanResponse{
		NextCursor:   nextCursor,
		ScannedCount: len(rows),
		Anomalies:    anomalies,
	}, nil
}
