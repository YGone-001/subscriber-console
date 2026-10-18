// Package config loads application configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all application configuration.
type Config struct {
	// HTTP server
	HTTPAddr        string // listen address, e.g. "127.0.0.1:18888"
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	IdleTimeout     time.Duration
	ShutdownTimeout time.Duration

	// MongoDB
	MongoURI      string // connection URI
	MongoDBXCloud string // database name for HSS/OCS data
	MongoDBOps    string // database name for xcloud_ops data

	// Discovery (read-only NF observation)
	DiscoveryAllowedTargets string // comma-separated host:port allowlist
	DiscoveryTLSCAFile      string // optional CA bundle for h2_tls NRF

	// NF Health (read-only telemetry collection)
	NFHealthAllowedTargets       string // comma-separated host:port metrics destinations
	NFHealthServiceUnits         string // comma-separated approved service units / process names
	NFHealthTLSCAFile            string // optional CA bundle for https metrics endpoints
	NFHealthLocalProcessBindings string // comma-separated resourceId=unit local bindings

	// Runtime discovery (read-only local process recognition)
	LocalNFDiscoveryEnabled         bool   // background scanner enabled
	LocalNFDiscoveryIntervalSeconds int    // scan interval in seconds
	LocalNFDiscoveryProcRoot        string // procfs root (default /proc)
	LocalNFDiscoveryExpected        string // comma-separated component ids explicitly expected
}

// Load reads configuration from environment variables with sensible defaults.
func Load() (*Config, error) {
	cfg := &Config{
		HTTPAddr:        envOrDefault("HTTP_ADDR", "127.0.0.1:18888"),
		ReadTimeout:     envDurationOrDefault("HTTP_READ_TIMEOUT", 15*time.Second),
		WriteTimeout:    envDurationOrDefault("HTTP_WRITE_TIMEOUT", 30*time.Second),
		IdleTimeout:     envDurationOrDefault("HTTP_IDLE_TIMEOUT", 120*time.Second),
		ShutdownTimeout: envDurationOrDefault("HTTP_SHUTDOWN_TIMEOUT", 10*time.Second),
		MongoURI:        envOrDefault("MONGODB_URI", "mongodb://127.0.0.1:27017"),
		MongoDBXCloud:   envOrDefault("MONGODB_XCLOUD_DB", "xcloud"),
		MongoDBOps:      envOrDefault("MONGODB_APP_DB", "xcloud_ops"),

		DiscoveryAllowedTargets: os.Getenv("DISCOVERY_ALLOWED_TARGETS"),
		DiscoveryTLSCAFile:      os.Getenv("DISCOVERY_TLS_CA_FILE"),

		NFHealthAllowedTargets: os.Getenv("NF_HEALTH_ALLOWED_TARGETS"),
		NFHealthServiceUnits:   os.Getenv("NF_HEALTH_SERVICE_UNITS"),
		NFHealthTLSCAFile:      os.Getenv("NF_HEALTH_TLS_CA_FILE"),

		NFHealthLocalProcessBindings: os.Getenv("NF_HEALTH_LOCAL_PROCESS_BINDINGS"),

		LocalNFDiscoveryEnabled:         envBoolOrDefault("LOCAL_NF_DISCOVERY_ENABLED", true),
		LocalNFDiscoveryIntervalSeconds: envIntOrDefault("LOCAL_NF_DISCOVERY_INTERVAL_SECONDS", 10),
		LocalNFDiscoveryProcRoot:        envOrDefault("LOCAL_NF_DISCOVERY_PROC_ROOT", "/proc"),
		LocalNFDiscoveryExpected:        os.Getenv("LOCAL_NF_DISCOVERY_EXPECTED"),
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

// envIntOrDefault reads a positive integer, falling back on any invalid value.
func envIntOrDefault(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// envBoolOrDefault reads a boolean flag, falling back on any invalid value.
func envBoolOrDefault(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return parsed
}
