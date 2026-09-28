// Package main is the entry point for the dedicated test-only failure server harness.
// It wires existing production platform handlers to deterministically failing dependencies
// without exposing any runtime fault-injection mechanism in the production binary.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/alert"
	"subscriber/internal/analytics"
	"subscriber/internal/auth"
	"subscriber/internal/config"
	"subscriber/internal/handler"
	"subscriber/internal/middleware"
	mongoClient "subscriber/internal/mongo"
	"subscriber/internal/notification"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
	"subscriber/internal/system"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// JWT secret
	jwtSecretBytes, err := auth.ValidateSecret(os.Getenv("JWT_SECRET"))
	if err != nil {
		logger.Error("invalid JWT_SECRET", "error", err)
		os.Exit(1)
	}

	// Connect to real MongoDB for session validation and rate limiting
	ctx := context.Background()
	mc, err := mongoClient.Connect(ctx, cfg.MongoURI, cfg.MongoDBXCloud, cfg.MongoDBOps)
	if err != nil {
		logger.Error("failed to connect to MongoDB", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := mc.Close(ctx); err != nil {
			logger.Error("failed to close MongoDB connection", "error", err)
		}
	}()

	sessionValidator := auth.NewSessionValidator(mc.Ops.Collection("app_users"))
	limiter := ratelimit.NewLimiter(mc.Ops.Collection("app_rate_limits"))

	// Create a disconnected MongoDB client for deterministic repository failure
	failingClient, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		logger.Error("failed to create disconnected mongo client", "error", err)
		os.Exit(1)
	}
	_ = failingClient.Disconnect(ctx)

	failingXCloud := failingClient.Database("disconnected_xcloud")
	failingOps := failingClient.Database("disconnected_ops")

	// Wire platform read handlers with failing dependencies
	alertRepo := alert.NewRepository(failingOps.Collection("app_alerts"))
	alertHandler := alert.NewHandler(alertRepo, limiter)
	notificationHandler := notification.NewHandler(alertRepo, sessionValidator)

	analyticsRepo := analytics.NewRepository(
		failingXCloud.Collection("subscribers"),
		failingXCloud.Collection("ocs_balances"),
		failingXCloud.Collection("ocs_sessions"),
		failingXCloud.Collection("ocs_reservations"),
		failingXCloud.Collection("ocs_usage_records"),
		failingXCloud.Collection("ocs_subscribers"),
		failingXCloud.Collection("ocs_tariff_plans"),
	)
	analyticsHandler := analytics.NewHandler(analyticsRepo, limiter)

	systemHandler := system.NewHandler(failingXCloud, failingOps, limiter)

	mux := http.NewServeMux()

	// Health endpoints
	mux.HandleFunc("GET /healthz", handler.Health)
	mux.HandleFunc("GET /readyz", handler.Ready(mc))

	// Auth-protected read endpoints
	authMiddleware := auth.Middleware(jwtSecretBytes, sessionValidator, logger)

	mux.Handle("GET /api/alerts", authMiddleware(http.HandlerFunc(alertHandler.List)))
	mux.Handle("POST /api/alerts/acknowledge", authMiddleware(http.HandlerFunc(alertHandler.Acknowledge)))
	mux.Handle("POST /api/alerts/workflow", authMiddleware(http.HandlerFunc(alertHandler.Workflow)))
	mux.Handle("GET /api/notifications/stream", authMiddleware(notificationHandler))
	mux.Handle("POST /api/analytics/init", authMiddleware(http.HandlerFunc(analyticsHandler.Init)))
	mux.Handle("GET /api/system/health", authMiddleware(http.HandlerFunc(systemHandler.SystemHealth)))
	mux.Handle("GET /api/system/mongo/health", authMiddleware(http.HandlerFunc(systemHandler.MongoHealth)))
	mux.Handle("GET /api/system/audit/status", authMiddleware(http.HandlerFunc(systemHandler.AuditStatus)))
	mux.Handle("POST /api/system/audit/scan", authMiddleware(http.HandlerFunc(systemHandler.AuditScan)))

	// Catch-all
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		response.NotFound(w)
	})

	finalHandler := middleware.Chain(
		mux,
		middleware.RequestID,
		middleware.Recovery(logger),
		middleware.AccessLog(logger),
		middleware.Security,
	)

	srv := &http.Server{
		Addr:         cfg.HTTPAddr,
		Handler:      finalHandler,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}

	done := make(chan struct{})
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		logger.Info("received signal, shutting down test failure server", "signal", sig)

		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("HTTP shutdown error", "error", err)
		}
		close(done)
	}()

	logger.Info("test failure server listening", "addr", cfg.HTTPAddr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("test failure server error", "error", err)
		os.Exit(1)
	}

	<-done
	logger.Info("test failure server stopped")
}
