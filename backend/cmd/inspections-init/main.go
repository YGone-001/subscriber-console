// Command inspections-init creates only the scheduled-inspection indexes.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/inspections"
)

func main() {
	apply := flag.Bool("apply", false, "Create only inspection indexes after reviewing the dry run")
	flag.Parse()
	fmt.Println("Inspection indexes: plans directory/due/request; runs occurrence/request/directory/lease/terminal TTL. No source data changes.")
	if !*apply {
		fmt.Println("DRY_RUN: no database connection made")
		return
	}
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		fmt.Fprintln(os.Stderr, "MONGODB_URI is required")
		os.Exit(1)
	}
	name := os.Getenv("MONGODB_APP_DB")
	if name == "" {
		name = "xcloud_ops"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client, e := mongo.Connect(options.Client().ApplyURI(uri))
	if e != nil {
		fmt.Fprintln(os.Stderr, "Mongo connection failed")
		os.Exit(1)
	}
	defer client.Disconnect(context.Background())
	db := client.Database(name)
	for collection, indexes := range map[string][]mongo.IndexModel{"app_inspection_plans": inspections.PlanIndexes(), "app_inspection_runs": inspections.RunIndexes()} {
		if _, e = db.Collection(collection).Indexes().CreateMany(ctx, indexes); e != nil {
			fmt.Fprintln(os.Stderr, "Inspection index creation failed")
			os.Exit(1)
		}
	}
	fmt.Println("Inspection indexes ready; no plans enabled and no runs created")
}
