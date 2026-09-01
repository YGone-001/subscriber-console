// Package main is the entry point for the subscriber-console Go backend.
//
// Phase 2: Read-only API migration — auth compatibility, audit, analytics, ratings.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/YGone-001/subscriber-console/backend/internal/analytics"
	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/config"
	"github.com/YGone-001/subscriber-console/backend/internal/handler"
	"github.com/YGone-001/subscriber-console/backend/internal/middleware"
	mongoClient "github.com/YGone-001/subscriber-console/backend/internal/mongo"
	"github.com/YGone-001/subscriber-console/backend/internal/ocs"
	"github.com/YGone-001/subscriber-console/backend/internal/profile"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/rating"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
	"github.com/YGone-001/subscriber-console/backend/internal/subscriber"
	"github.com/YGone-001/subscriber-console/backend/internal/tariff"
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
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		logger.Error("JWT_SECRET is required")
		os.Exit(1)
	}
	jwtSecretBytes := []byte(jwtSecret)

	// Connect to MongoDB
	ctx := context.Background()
	mc, err := mongoClient.Connect(ctx, cfg.MongoURI, cfg.MongoDBOpen5GS, cfg.MongoDBOps)
	if err != nil {
		logger.Error("failed to connect to MongoDB", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := mc.Close(ctx); err != nil {
			logger.Error("failed to close MongoDB connection", "error", err)
		}
	}()
	logger.Info("mongodb connected", "uri", cfg.MongoURI, "open5gs_db", cfg.MongoDBOpen5GS, "ops_db", cfg.MongoDBOps)

	// Initialize components
	sessionValidator := auth.NewSessionValidator(mc.Ops.Collection("app_users"))
	limiter := ratelimit.NewLimiter(mc.Ops.Collection("app_rate_limits"))

	// Audit
	auditRepo := audit.NewRepository(mc.Ops.Collection("app_audit_logs"))
	auditHandler := audit.NewHandler(auditRepo, limiter)

	// Analytics
	analyticsRepo := analytics.NewRepository(
		mc.Open5GS.Collection("subscribers"),
		mc.Open5GS.Collection("ocs_balances"),
		mc.Open5GS.Collection("ocs_sessions"),
		mc.Open5GS.Collection("ocs_reservations"),
		mc.Open5GS.Collection("ocs_usage_records"),
		mc.Open5GS.Collection("ocs_subscribers"),
		mc.Open5GS.Collection("ocs_tariff_plans"),
	)
	analyticsHandler := analytics.NewHandler(analyticsRepo, limiter)

	// Ratings
	ratingRepo := rating.NewRepository(mc.Open5GS.Collection("ocs_rating_policies"))
	ratingHandler := rating.NewHandler(ratingRepo, limiter)

	// Profiles
	profileRepo := profile.NewRepository(
		mc.Ops.Collection("app_profiles"),
		mc.Ops.Collection("app_profile_versions"),
		mc.Open5GS.Collection("subscribers"),
	)
	profileHandler := profile.NewHandler(profileRepo, limiter)

	// OCS
	ocsRepo := ocs.NewRepository(
		mc.Open5GS.Collection("ocs_balances"),
		mc.Open5GS.Collection("ocs_sessions"),
		mc.Open5GS.Collection("ocs_reservations"),
		mc.Open5GS.Collection("ocs_usage_records"),
	)
	ocsHandler := ocs.NewHandler(ocsRepo, limiter)

	// Tariff Plans
	tariffRepo := tariff.NewRepository(
		mc.Open5GS.Collection("ocs_tariff_plans"),
		mc.Open5GS.Collection("ocs_subscribers"),
		mc.Ops.Collection("app_audit_logs"),
	)
	tariffHandler := tariff.NewHandler(tariffRepo, limiter)

	// Subscribers (Phase 2C)
	subscriberRepo := subscriber.NewRepository(
		mc.Open5GS.Collection("subscribers"),
		mc.Open5GS.Collection("ocs_subscribers"),
		mc.Open5GS.Collection("ocs_balances"),
		mc.Open5GS.Collection("ocs_tariff_plans"),
		mc.Ops.Collection("app_profiles"),
	)
	subscriberHandler := subscriber.NewHandler(subscriberRepo, limiter)

	// Build handler
	mux := http.NewServeMux()

	// Health endpoints (no auth)
	mux.HandleFunc("GET /healthz", handler.Health)
	mux.HandleFunc("GET /readyz", handler.Ready(mc))

	// Auth-protected read endpoints
	authMiddleware := auth.Middleware(jwtSecretBytes, sessionValidator, logger)

	// Phase 2A: Audit (export remains with Next.js — requires stateful audit evidence persistence)
	mux.Handle("GET /api/audit", authMiddleware(http.HandlerFunc(auditHandler.List)))
	mux.Handle("GET /api/audit/{id}", authMiddleware(http.HandlerFunc(auditHandler.Get)))

	// Phase 2A: Analytics
	mux.Handle("GET /api/analytics/metrics", authMiddleware(http.HandlerFunc(analyticsHandler.Metrics)))
	mux.Handle("GET /api/analytics/sparkline", authMiddleware(http.HandlerFunc(analyticsHandler.Sparkline)))

	// Phase 2A: Ratings
	mux.Handle("GET /api/ratings", authMiddleware(http.HandlerFunc(ratingHandler.List)))
	mux.Handle("GET /api/ratings/{id}", authMiddleware(http.HandlerFunc(ratingHandler.Get)))

	// Phase 2B: Profiles
	mux.Handle("GET /api/profiles", authMiddleware(http.HandlerFunc(profileHandler.List)))
	mux.Handle("GET /api/profiles/{name}", authMiddleware(http.HandlerFunc(profileHandler.Get)))
	mux.Handle("GET /api/profiles/{name}/stats", authMiddleware(http.HandlerFunc(profileHandler.Stats)))
	mux.Handle("GET /api/profiles/{name}/versions", authMiddleware(http.HandlerFunc(profileHandler.Versions)))

	// Phase 2B: OCS
	mux.Handle("GET /api/ocs/balances", authMiddleware(http.HandlerFunc(ocsHandler.Balances)))
	mux.Handle("GET /api/ocs/sessions", authMiddleware(http.HandlerFunc(ocsHandler.Sessions)))
	mux.Handle("GET /api/ocs/usage", authMiddleware(http.HandlerFunc(ocsHandler.Usage)))
	mux.Handle("GET /api/ocs/reservations", authMiddleware(http.HandlerFunc(ocsHandler.Reservations)))

	// Phase 2B: Tariff Plans
	mux.Handle("GET /api/tariff-plans", authMiddleware(http.HandlerFunc(tariffHandler.List)))
	mux.Handle("GET /api/tariff-plans/{planId}", authMiddleware(http.HandlerFunc(tariffHandler.Get)))
	mux.Handle("GET /api/tariff-plans/{planId}/export", authMiddleware(http.HandlerFunc(tariffHandler.Export)))
	mux.Handle("GET /api/tariff-plans/{planId}/operations", authMiddleware(http.HandlerFunc(tariffHandler.Operations)))
	mux.Handle("GET /api/tariff-plans/{planId}/rules", authMiddleware(http.HandlerFunc(tariffHandler.Rules)))
	mux.Handle("GET /api/tariff-plans/{planId}/subscribers", authMiddleware(http.HandlerFunc(tariffHandler.Subscribers)))
	mux.Handle("GET /api/tariff-plans/{planId}/migrate", authMiddleware(http.HandlerFunc(tariffHandler.Migrate)))

	// Phase 2C: Subscribers (list, detail, search, batch precheck)
	mux.Handle("GET /api/subscribers", authMiddleware(http.HandlerFunc(subscriberHandler.List)))
	mux.Handle("GET /api/subscribers/{imsi}", authMiddleware(http.HandlerFunc(subscriberHandler.Detail)))
	mux.Handle("GET /api/search", authMiddleware(http.HandlerFunc(subscriberHandler.Search)))
	mux.Handle("POST /api/subscribers/batch/precheck", authMiddleware(http.HandlerFunc(subscriberHandler.BatchPrecheck)))

	// Catch-all for unmigrated routes
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		response.NotFound(w)
	})

	// Apply middleware chain (without auth — auth is applied per-route)
	finalHandler := middleware.Chain(
		mux,
		middleware.RequestID,
		middleware.Recovery(logger),
		middleware.AccessLog(logger),
		middleware.Security,
	)

	// Configure HTTP server
	srv := &http.Server{
		Addr:         cfg.HTTPAddr,
		Handler:      finalHandler,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}

	// Graceful shutdown on SIGINT/SIGTERM
	done := make(chan struct{})
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		logger.Info("received signal, shutting down", "signal", sig)

		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("server shutdown error", "error", err)
		}
		close(done)
	}()

	logger.Info("server starting", "addr", cfg.HTTPAddr, "phase", "2")
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}

	<-done
	logger.Info("server stopped")
	time.Sleep(100 * time.Millisecond)
}
