// Command config-drift-init explicitly manages configuration drift indexes.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/configdrift"
)

func main() {
	apply := flag.Bool("apply", false, "Create indexes after reviewing the dry run")
	flag.Parse()
	fmt.Println("xcloud_ops: configuration drift source, resource, lifecycle and event indexes; no data mutation")
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
	if e = configdrift.NewRepository(client.Database(opsDatabase())).Initialize(ctx); e != nil {
		fmt.Fprintln(os.Stderr, "Configuration drift index creation failed")
		os.Exit(1)
	}
	fmt.Println("Configuration drift indexes ready")
}

func opsDatabase() string {
	if name := os.Getenv("MONGODB_APP_DB"); name != "" {
		return name
	}
	return "xcloud_ops"
}
