package config

import (
	"os"
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	// Clear env vars to test defaults
	os.Unsetenv("HTTP_ADDR")
	os.Unsetenv("MONGODB_URI")
	os.Unsetenv("MONGODB_OPEN5GS_DB")
	os.Unsetenv("MONGODB_APP_DB")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if cfg.HTTPAddr != ":8080" {
		t.Errorf("HTTPAddr = %q, want %q", cfg.HTTPAddr, ":8080")
	}
	if cfg.MongoURI != "mongodb://127.0.0.1:27017" {
		t.Errorf("MongoURI = %q, want %q", cfg.MongoURI, "mongodb://127.0.0.1:27017")
	}
	if cfg.MongoDBOpen5GS != "open5gs" {
		t.Errorf("MongoDBOpen5GS = %q, want %q", cfg.MongoDBOpen5GS, "open5gs")
	}
	if cfg.MongoDBOps != "xcloud_ops" {
		t.Errorf("MongoDBOps = %q, want %q", cfg.MongoDBOps, "xcloud_ops")
	}
	if cfg.ReadTimeout != 15*time.Second {
		t.Errorf("ReadTimeout = %v, want %v", cfg.ReadTimeout, 15*time.Second)
	}
	if cfg.WriteTimeout != 30*time.Second {
		t.Errorf("WriteTimeout = %v, want %v", cfg.WriteTimeout, 30*time.Second)
	}
	if cfg.IdleTimeout != 120*time.Second {
		t.Errorf("IdleTimeout = %v, want %v", cfg.IdleTimeout, 120*time.Second)
	}
	if cfg.ShutdownTimeout != 10*time.Second {
		t.Errorf("ShutdownTimeout = %v, want %v", cfg.ShutdownTimeout, 10*time.Second)
	}
}

func TestLoadFromEnv(t *testing.T) {
	t.Setenv("HTTP_ADDR", ":9090")
	t.Setenv("MONGODB_URI", "mongodb://mongo:27017")
	t.Setenv("MONGODB_OPEN5GS_DB", "test_open5gs")
	t.Setenv("MONGODB_APP_DB", "test_ops")
	t.Setenv("HTTP_READ_TIMEOUT", "5s")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if cfg.HTTPAddr != ":9090" {
		t.Errorf("HTTPAddr = %q, want %q", cfg.HTTPAddr, ":9090")
	}
	if cfg.MongoURI != "mongodb://mongo:27017" {
		t.Errorf("MongoURI = %q, want %q", cfg.MongoURI, "mongodb://mongo:27017")
	}
	if cfg.MongoDBOpen5GS != "test_open5gs" {
		t.Errorf("MongoDBOpen5GS = %q, want %q", cfg.MongoDBOpen5GS, "test_open5gs")
	}
	if cfg.MongoDBOps != "test_ops" {
		t.Errorf("MongoDBOps = %q, want %q", cfg.MongoDBOps, "test_ops")
	}
	if cfg.ReadTimeout != 5*time.Second {
		t.Errorf("ReadTimeout = %v, want %v", cfg.ReadTimeout, 5*time.Second)
	}
}

func TestEnvOrDefault(t *testing.T) {
	if got := envOrDefault("NONEXISTENT_KEY_XYZ", "fallback"); got != "fallback" {
		t.Errorf("envOrDefault() = %q, want %q", got, "fallback")
	}

	t.Setenv("TEST_KEY_XYZ", "from_env")
	if got := envOrDefault("TEST_KEY_XYZ", "fallback"); got != "from_env" {
		t.Errorf("envOrDefault() = %q, want %q", got, "from_env")
	}
}

func TestEnvDurationOrDefault(t *testing.T) {
	if got := envDurationOrDefault("NONEXISTENT_DUR_XYZ", 5*time.Second); got != 5*time.Second {
		t.Errorf("envDurationOrDefault() = %v, want %v", got, 5*time.Second)
	}

	t.Setenv("TEST_DUR_XYZ", "10s")
	if got := envDurationOrDefault("TEST_DUR_XYZ", 5*time.Second); got != 10*time.Second {
		t.Errorf("envDurationOrDefault() = %v, want %v", got, 10*time.Second)
	}

	// Invalid duration falls back to default
	t.Setenv("TEST_DUR_BAD", "not-a-duration")
	if got := envDurationOrDefault("TEST_DUR_BAD", 5*time.Second); got != 5*time.Second {
		t.Errorf("envDurationOrDefault() = %v, want %v", got, 5*time.Second)
	}
}
