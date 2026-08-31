// Package mongo provides a MongoDB client with dual-database support.
//
// subscriber-console uses two databases:
//   - open5gs: HSS subscriber data, OCS billing data
//   - xcloud_ops: Console operations (users, approvals, audit, alerts, etc.)
package mongo

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

// Client wraps a MongoDB connection with two database handles.
type Client struct {
	cli    *mongo.Client
	Open5GS *mongo.Database // HSS/OCS data
	Ops     *mongo.Database // xcloud_ops data
}

// Connect establishes a MongoDB connection and returns a Client with two database handles.
func Connect(ctx context.Context, uri, open5gsDB, opsDB string) (*Client, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	cli, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return nil, fmt.Errorf("mongo connect: %w", err)
	}

	if err := cli.Ping(ctx, readpref.Primary()); err != nil {
		return nil, fmt.Errorf("mongo ping: %w", err)
	}

	return &Client{
		cli:     cli,
		Open5GS: cli.Database(open5gsDB),
		Ops:     cli.Database(opsDB),
	}, nil
}

// Ping verifies the connection is alive.
func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.cli.Ping(ctx, readpref.Primary())
}

// Close disconnects the client.
func (c *Client) Close(ctx context.Context) error {
	return c.cli.Disconnect(ctx)
}
