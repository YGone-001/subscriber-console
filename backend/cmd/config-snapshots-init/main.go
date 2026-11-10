// config-snapshots-init creates only the explicitly requested platform indexes.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/config"
	"subscriber/internal/configsnapshots"
)

func main() {
	apply := flag.Bool("apply", false, "create configuration observation indexes; default is dry-run")
	flag.Parse()
	if !*apply {
		fmt.Println("dry-run: app_config_snapshots and app_config_observations: sourceId + collectedAt descending + _id descending; no TTL on snapshots")
		return
	}
	cfg, e := config.Load()
	if e != nil {
		fmt.Fprintln(os.Stderr, "configuration unavailable")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, e := mongo.Connect(options.Client().ApplyURI(cfg.MongoURI))
	if e != nil {
		fmt.Fprintln(os.Stderr, "Mongo unavailable")
		os.Exit(1)
	}
	defer client.Disconnect(context.Background())
	if e = configsnapshots.NewRepository(client.Database(cfg.MongoDBOps)).Initialize(ctx); e != nil {
		fmt.Fprintln(os.Stderr, "index initialization failed")
		os.Exit(1)
	}
	fmt.Println("configuration observation indexes initialized")
}
