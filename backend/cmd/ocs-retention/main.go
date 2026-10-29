package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/audit"
	"subscriber/internal/config"
	"subscriber/internal/retention"
)

func main() {
	apply := flag.Bool("apply", false, "physically purge eligible terminated contracts; default is a dry-run")
	reason := flag.String("reason", "", "operator reason recorded in the purge audit")
	confirm := flag.String("confirm", "", "must equal the configured confirmation phrase when applying")
	imsi := flag.String("imsi", "", "purge one explicitly named terminated contract (maintenance escape hatch)")
	limit := flag.Int("limit", 1000, "maximum contracts to purge in one run")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		fail(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	client, err := mongo.Connect(options.Client().ApplyURI(cfg.MongoURI))
	if err != nil {
		fail(err)
	}
	defer func() { _ = client.Disconnect(context.Background()) }()

	xcloud := client.Database(cfg.MongoDBXCloud)
	ops := client.Database(cfg.MongoDBOps)
	writer := audit.NewWriter(audit.NewMongoEvidenceStore(ops.Collection("app_audit_logs")), audit.WriterConfig{})
	defer writer.CloseNow()

	service := retention.NewService(
		retention.NewRepository(
			xcloud.Collection("ocs_subscribers"),
			xcloud.Collection("ocs_balances"),
			ops.Collection("ocs_balance_adjustments"),
		),
		writer,
		cfg.OCSTerminatedRetentionDays,
	)

	if !*apply {
		var payload any
		if *imsi != "" {
			candidate, err := service.PreviewTarget(ctx, *imsi)
			if err != nil {
				fail(err)
			}
			payload = candidate
		} else {
			preview, err := service.Preview(ctx, *limit)
			if err != nil {
				fail(err)
			}
			payload = preview
		}
		printJSON(payload)
		return
	}

	opts := retention.PurgeOptions{
		Apply:        true,
		Reason:       *reason,
		Confirmation: *confirm,
		IMSI:         *imsi,
		Limit:        *limit,
		Actor:        audit.ActorInput{Type: "system", Username: "ocs-retention-cli", Role: "admin"},
	}
	var result retention.PurgeResult
	if *imsi != "" {
		result, err = service.PurgeTarget(ctx, *imsi, opts)
	} else {
		result, err = service.Purge(ctx, opts)
	}
	if err != nil {
		fail(err)
	}
	printJSON(result)
	if len(result.Warnings) > 0 {
		os.Exit(2)
	}
}

func printJSON(value any) {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fail(err)
	}
	fmt.Println(string(encoded))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "ocs-retention:", err)
	os.Exit(1)
}
