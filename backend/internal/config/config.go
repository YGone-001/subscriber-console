// Package config loads application configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"time"
)

// Config holds all application configuration.
type Config struct {
	// HTTP server
	HTTPAddr        string // listen address, e.g. ":8080"
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	IdleTimeout     time.Duration
	ShutdownTimeout time.Duration

	// MongoDB
	MongoURI      string // connection URI
	MongoDBXCloud string // database name for HSS/OCS data
	MongoDBOps    string // database name for xcloud_ops data
}

// Load reads configuration from environment variables with sensible defaults.
func Load() (*Config, error) {
	cfg := &Config{
		HTTPAddr:        envOrDefault("HTTP_ADDR", ":8080"),
		ReadTimeout:     envDurationOrDefault("HTTP_READ_TIMEOUT", 15*time.Second),
		WriteTimeout:    envDurationOrDefault("HTTP_WRITE_TIMEOUT", 30*time.Second),
		IdleTimeout:     envDurationOrDefault("HTTP_IDLE_TIMEOUT", 120*time.Second),
		ShutdownTimeout: envDurationOrDefault("HTTP_SHUTDOWN_TIMEOUT", 10*time.Second),
		MongoURI:        envOrDefault("MONGODB_URI", "mongodb://127.0.0.1:27017"),
		MongoDBXCloud:   envOrDefault("MONGODB_XCLOUD_DB", "xcloud"),
		MongoDBOps:      envOrDefault("MONGODB_APP_DB", "xcloud_ops"),
	}

	if cfg.MongoURI == "" {
		return nil, fmt.Errorf("MONGODB_URI is required")
	}

	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envDurationOrDefault(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return fallback
	}
	return d
}
