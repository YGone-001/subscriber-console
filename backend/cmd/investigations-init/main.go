// Command investigations-init manages indexes for the investigation record only.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func main() {
	apply := flag.Bool("apply", false, "Create indexes after reviewing the dry run")
	flag.Parse()
	indexes := []mongo.IndexModel{}
	for _, field := range []string{"", "alertId", "resourceId", "status"} {
		keys := bson.D{}
		name := "updatedAt_id"
		if field != "" {
			keys = append(keys, bson.E{Key: field, Value: 1})
			name = field + "_" + name
		}
		keys = append(keys, bson.E{Key: "updatedAt", Value: -1}, bson.E{Key: "_id", Value: -1})
		indexes = append(indexes, mongo.IndexModel{Keys: keys, Options: options.Index().SetName(name)})
	}
	fmt.Println("xcloud_ops.app_investigations: updatedAt/_id, alertId, resourceId, status indexes; no data mutation")
	if !*apply {
		fmt.Println("DRY_RUN: no database connection made")
		return
	}
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		fmt.Fprintln(os.Stderr, "MONGODB_URI is required")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client, e := mongo.Connect(options.Client().ApplyURI(uri))
	if e != nil {
		fmt.Fprintln(os.Stderr, "Mongo connection failed")
		os.Exit(1)
	}
	defer client.Disconnect(context.Background())
	if _, e = client.Database(opsDatabase()).Collection("app_investigations").Indexes().CreateMany(ctx, indexes); e != nil {
		fmt.Fprintln(os.Stderr, "Investigation index creation failed")
		os.Exit(1)
	}
	fmt.Println("Investigation indexes ready")
}

func opsDatabase() string {
	if name := os.Getenv("MONGODB_APP_DB"); name != "" {
		return name
	}
	return "xcloud_ops"
}
