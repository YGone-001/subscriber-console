// Package main is the entry point for the subscriber-console Go backend.
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

	"subscriber/internal/analytics"
	"subscriber/internal/approval"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/balance"
	"subscriber/internal/config"
	"subscriber/internal/handler"
	"subscriber/internal/middleware"
	mongoClient "subscriber/internal/mongo"
	"subscriber/internal/ocs"
	"subscriber/internal/profile"
	"subscriber/internal/ratelimit"
	"subscriber/internal/rating"
	"subscriber/internal/response"
	"subscriber/internal/subscriber"
	"subscriber/internal/tariff"
	"subscriber/internal/user"
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
	logger.Info("mongodb connected", "uri", cfg.MongoURI, "xcloud_db", cfg.MongoDBXCloud, "ops_db", cfg.MongoDBOps)

	// Initialize components
	sessionValidator := auth.NewSessionValidator(mc.Ops.Collection("app_users"))
	limiter := ratelimit.NewLimiter(mc.Ops.Collection("app_rate_limits"))

	// Audit Writer — bounded async writer for authorization.denied evidence
	auditCollection := mc.Ops.Collection("app_audit_logs")
	auditWriter := audit.NewWriterLegacy(auditCollection, audit.WriterConfig{
		QueueSize:   256,
		WorkerCount: 2,
		Logger:      logger,
	})

	// Audit (read-side repository + handler with denial audit)
	auditRepo := audit.NewRepository(auditCollection)
	auditHandler := audit.NewHandler(auditRepo, limiter, auditWriter)

	// Analytics
	analyticsRepo := analytics.NewRepository(
		mc.XCloud.Collection("subscribers"),
		mc.XCloud.Collection("ocs_balances"),
		mc.XCloud.Collection("ocs_sessions"),
		mc.XCloud.Collection("ocs_reservations"),
		mc.XCloud.Collection("ocs_usage_records"),
		mc.XCloud.Collection("ocs_subscribers"),
		mc.XCloud.Collection("ocs_tariff_plans"),
	)
	analyticsHandler := analytics.NewHandler(analyticsRepo, limiter)

	// Ratings
	ratingRepo := rating.NewRepository(mc.XCloud.Collection("ocs_rating_policies"))
	ratingHandler := rating.NewHandler(ratingRepo, limiter)

	// Profiles
	profileRepo := profile.NewRepository(
		mc.Ops.Collection("app_profiles"),
		mc.Ops.Collection("app_profile_versions"),
		mc.XCloud.Collection("subscribers"),
	)

	// OCS
	ocsRepo := ocs.NewRepository(
		mc.XCloud.Collection("ocs_balances"),
		mc.XCloud.Collection("ocs_sessions"),
		mc.XCloud.Collection("ocs_reservations"),
		mc.XCloud.Collection("ocs_usage_records"),
		mc.XCloud.Collection("ocs_subscribers"),
		mc.XCloud.Collection("ocs_tariff_plans"),
	)
	ocsHandler := ocs.NewHandler(ocsRepo, limiter)

	// Auth/User reads (with audit writer for denial evidence)
	userRepo := user.NewRepository(mc.Ops)
	userHandler := user.NewHandler(userRepo, limiter, auditWriter)

	// Approvals (read + CAS decision transitions + creation; execute remains with Node)
	approvalRepo := approval.NewRepository(
		mc.Ops.Collection("app_approvals"),
		mc.Ops.Collection("app_audit_logs"),
		mc.Ops.Collection("app_sequences"),
	)
	approvalWorkflow := approval.NewWorkflow(approvalRepo, userRepo, auditWriter)
	approvalCreator := approval.NewApprovalCreator(approvalRepo, auditWriter)
	approvalHandler := approval.NewHandler(approvalRepo, limiter, auditWriter, approvalWorkflow, approvalCreator, userRepo)

	// Tariff Plans
	tariffRepo := tariff.NewRepository(
		mc.XCloud.Collection("ocs_tariff_plans"),
		mc.XCloud.Collection("ocs_subscribers"),
		mc.Ops.Collection("app_audit_logs"),
	)
	tariffHandler := tariff.NewHandler(tariffRepo, limiter)
	tariffWriteHandler := tariff.NewWriteHandler(tariffRepo, limiter, userRepo, approvalCreator, auditWriter)

	// OCS Balances
	balanceRepo := balance.NewRepository(
		mc.XCloud.Collection("ocs_balances"),
		mc.XCloud.Collection("ocs_subscribers"),
		mc.Ops.Collection("app_approvals"),
		mc.Ops.Collection("app_audit_logs"),
	)
	balanceHandler := balance.NewHandler(balanceRepo, limiter, userRepo, approvalCreator, auditWriter)

	// OCS Subscriber Contract write handler
	ocsSubscriberWriteHandler := ocs.NewSubscriberWriteHandler(ocsRepo, limiter, userRepo, approvalCreator, auditWriter)

	// Subscribers
	subscriberRepo := subscriber.NewRepository(
		mc.XCloud.Collection("subscribers"),
		mc.XCloud.Collection("ocs_subscribers"),
		mc.XCloud.Collection("ocs_balances"),
		mc.XCloud.Collection("ocs_tariff_plans"),
		mc.Ops.Collection("app_profiles"),
	)
	subscriberHandler := subscriber.NewHandler(subscriberRepo, limiter, auditWriter)

	// Profile handler (with approval repo for restore governance)
	profileHandler := profile.NewHandler(profileRepo, approvalRepo, limiter, auditWriter)

	// Build handler
	mux := http.NewServeMux()

	// Health endpoints (no auth)
	mux.HandleFunc("GET /healthz", handler.Health)
	mux.HandleFunc("GET /readyz", handler.Ready(mc))

	// Auth-protected read endpoints
	authMiddleware := auth.Middleware(jwtSecretBytes, sessionValidator, logger)

	// Audit (export remains with Next.js — requires stateful audit evidence persistence)
	mux.Handle("GET /api/audit", authMiddleware(http.HandlerFunc(auditHandler.List)))
	mux.Handle("GET /api/audit/{id}", authMiddleware(http.HandlerFunc(auditHandler.Get)))

	// Analytics
	mux.Handle("GET /api/analytics/metrics", authMiddleware(http.HandlerFunc(analyticsHandler.Metrics)))
	mux.Handle("GET /api/analytics/sparkline", authMiddleware(http.HandlerFunc(analyticsHandler.Sparkline)))

	// Ratings
	mux.Handle("GET /api/ratings", authMiddleware(http.HandlerFunc(ratingHandler.List)))
	mux.Handle("GET /api/ratings/{id}", authMiddleware(http.HandlerFunc(ratingHandler.Get)))

	// Profiles
	mux.Handle("GET /api/profiles", authMiddleware(http.HandlerFunc(profileHandler.List)))
	mux.Handle("GET /api/profiles/{name}", authMiddleware(http.HandlerFunc(profileHandler.Get)))
	mux.Handle("GET /api/profiles/{name}/stats", authMiddleware(http.HandlerFunc(profileHandler.Stats)))
	mux.Handle("GET /api/profiles/{name}/versions", authMiddleware(http.HandlerFunc(profileHandler.Versions)))

	// Profile write endpoints (governance: super_admin/root/ops_admin→DIRECT)
	mux.Handle("POST /api/profiles", authMiddleware(http.HandlerFunc(profileHandler.Create)))
	mux.Handle("PUT /api/profiles/{name}", authMiddleware(http.HandlerFunc(profileHandler.Update)))
	mux.Handle("DELETE /api/profiles/{name}", authMiddleware(http.HandlerFunc(profileHandler.Delete)))
	mux.Handle("POST /api/profiles/{name}/versions/{versionId}/restore", authMiddleware(http.HandlerFunc(profileHandler.Restore)))

	// OCS Balances (read + governed adjustment)
	mux.Handle("GET /api/ocs/balances", authMiddleware(http.HandlerFunc(balanceHandler.List)))
	mux.Handle("GET /api/ocs/balances/{imsi}", authMiddleware(http.HandlerFunc(balanceHandler.Get)))
	mux.Handle("POST /api/ocs/balances/{imsi}/adjust", authMiddleware(http.HandlerFunc(balanceHandler.Adjust)))
	mux.Handle("POST /api/ocs/balances/{imsi}/reset", authMiddleware(http.HandlerFunc(balanceHandler.Reset)))

	// OCS Charging Plane (read-only telemetry)
	mux.Handle("GET /api/ocs/sessions", authMiddleware(http.HandlerFunc(ocsHandler.Sessions)))
	mux.Handle("GET /api/ocs/usage", authMiddleware(http.HandlerFunc(ocsHandler.Usage)))
	mux.Handle("GET /api/ocs/reservations", authMiddleware(http.HandlerFunc(ocsHandler.Reservations)))
	mux.Handle("GET /api/ocs/subscribers", authMiddleware(http.HandlerFunc(ocsHandler.Subscribers)))

	// Tariff Plans
	mux.Handle("GET /api/tariff-plans", authMiddleware(http.HandlerFunc(tariffHandler.List)))
	mux.Handle("GET /api/tariff-plans/{planId}", authMiddleware(http.HandlerFunc(tariffHandler.Get)))
	mux.Handle("GET /api/tariff-plans/{planId}/export", authMiddleware(http.HandlerFunc(tariffHandler.Export)))
	mux.Handle("GET /api/tariff-plans/{planId}/operations", authMiddleware(http.HandlerFunc(tariffHandler.Operations)))
	mux.Handle("GET /api/tariff-plans/{planId}/rules", authMiddleware(http.HandlerFunc(tariffHandler.Rules)))
	mux.Handle("GET /api/tariff-plans/{planId}/subscribers", authMiddleware(http.HandlerFunc(tariffHandler.Subscribers)))
	mux.Handle("GET /api/tariff-plans/{planId}/migrate", authMiddleware(http.HandlerFunc(tariffHandler.Migrate)))

	// Tariff Plan write endpoints (governance: super_admin/root→DIRECT, operator→APPROVAL)
	mux.Handle("POST /api/tariff-plans", authMiddleware(http.HandlerFunc(tariffWriteHandler.Create)))
	mux.Handle("PUT /api/tariff-plans/{planId}", authMiddleware(http.HandlerFunc(tariffWriteHandler.Update)))
	mux.Handle("DELETE /api/tariff-plans/{planId}", authMiddleware(http.HandlerFunc(tariffWriteHandler.Delete)))
	mux.Handle("POST /api/tariff-plans/{planId}/clone", authMiddleware(http.HandlerFunc(tariffWriteHandler.Clone)))
	mux.Handle("POST /api/tariff-plans/{planId}/enable", authMiddleware(http.HandlerFunc(tariffWriteHandler.Enable)))
	mux.Handle("POST /api/tariff-plans/{planId}/disable", authMiddleware(http.HandlerFunc(tariffWriteHandler.Disable)))

	// OCS Subscriber Contract write endpoints (governance: super_admin/root→DIRECT, operator→APPROVAL)
	mux.Handle("POST /api/ocs/subscribers", authMiddleware(http.HandlerFunc(ocsSubscriberWriteHandler.Create)))
	mux.Handle("PATCH /api/ocs/subscribers/{imsi}", authMiddleware(http.HandlerFunc(ocsSubscriberWriteHandler.UpdateTariff)))
	mux.Handle("POST /api/ocs/subscribers/{imsi}/suspend", authMiddleware(http.HandlerFunc(ocsSubscriberWriteHandler.Suspend)))
	mux.Handle("POST /api/ocs/subscribers/{imsi}/resume", authMiddleware(http.HandlerFunc(ocsSubscriberWriteHandler.Resume)))
	mux.Handle("DELETE /api/ocs/subscribers/{imsi}", authMiddleware(http.HandlerFunc(ocsSubscriberWriteHandler.Terminate)))

	// Subscribers (list, detail, search, batch precheck)
	mux.Handle("GET /api/subscribers", authMiddleware(http.HandlerFunc(subscriberHandler.List)))
	mux.Handle("GET /api/subscribers/{imsi}", authMiddleware(http.HandlerFunc(subscriberHandler.Detail)))
	mux.Handle("GET /api/search", authMiddleware(http.HandlerFunc(subscriberHandler.Search)))
	mux.Handle("POST /api/subscribers/batch/precheck", authMiddleware(http.HandlerFunc(subscriberHandler.BatchPrecheck)))

	// Subscriber write endpoints (governance: super_admin→DIRECT, operator→APPROVAL)
	subscriberWriteHandler := subscriber.NewWriteHandler(subscriberRepo, limiter, userRepo, approvalCreator, approvalRepo, auditWriter)
	mux.Handle("POST /api/subscribers", authMiddleware(http.HandlerFunc(subscriberWriteHandler.Create)))
	mux.Handle("PUT /api/subscribers/{imsi}", authMiddleware(http.HandlerFunc(subscriberWriteHandler.Update)))
	mux.Handle("DELETE /api/subscribers/{imsi}", authMiddleware(http.HandlerFunc(subscriberWriteHandler.Delete)))
	mux.Handle("POST /api/subscribers/batch", authMiddleware(http.HandlerFunc(subscriberWriteHandler.BatchCreate)))
	mux.Handle("POST /api/subscribers/batch-update", authMiddleware(http.HandlerFunc(subscriberWriteHandler.BatchUpdate)))
	mux.Handle("POST /api/subscribers/bulk-delete", authMiddleware(http.HandlerFunc(subscriberWriteHandler.BulkDelete)))
	mux.Handle("POST /api/subscribers/import", authMiddleware(http.HandlerFunc(subscriberWriteHandler.Import)))
	mux.Handle("POST /api/subscribers/{imsi}/profile", authMiddleware(http.HandlerFunc(subscriberWriteHandler.ProfileApply)))

	// Auth/User reads
	mux.Handle("GET /api/auth/me", authMiddleware(http.HandlerFunc(userHandler.AuthMe)))
	mux.Handle("GET /api/auth/permissions", authMiddleware(http.HandlerFunc(userHandler.AuthPermissions)))
	mux.Handle("GET /api/auth/users", authMiddleware(http.HandlerFunc(userHandler.UserList)))
	mux.Handle("GET /api/auth/users/{username}", authMiddleware(http.HandlerFunc(userHandler.UserDetail)))
	mux.Handle("GET /api/users", authMiddleware(http.HandlerFunc(userHandler.UserList)))
	mux.Handle("GET /api/users/{username}", authMiddleware(http.HandlerFunc(userHandler.UserDetail)))

	// Approvals (read + CAS decision transitions + ACCESS_REQUEST creation; execute remains with Node)
	mux.Handle("GET /api/approvals", authMiddleware(http.HandlerFunc(approvalHandler.List)))
	mux.Handle("GET /api/approvals/{id}/audit", authMiddleware(http.HandlerFunc(approvalHandler.AuditTrail)))
	mux.Handle("GET /api/approvals/{id}", authMiddleware(http.HandlerFunc(approvalHandler.Detail)))
	// ACCESS_REQUEST creation (viewer → operator)
	mux.Handle("POST /api/approvals", authMiddleware(http.HandlerFunc(approvalHandler.CreateAccessRequest)))
	// Explicit decision endpoints (registered before legacy for specificity)
	mux.Handle("POST /api/approvals/{id}/approve", authMiddleware(http.HandlerFunc(approvalHandler.Approve)))
	mux.Handle("POST /api/approvals/{id}/reject", authMiddleware(http.HandlerFunc(approvalHandler.Reject)))
	mux.Handle("POST /api/approvals/{id}/cancel", authMiddleware(http.HandlerFunc(approvalHandler.Cancel)))
	// Legacy compatibility: POST /api/approvals/{id}
	mux.Handle("POST /api/approvals/{id}", authMiddleware(http.HandlerFunc(approvalHandler.Decision)))

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

		// 1. Stop accepting new requests, drain in-flight handlers
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("server shutdown error", "error", err)
		}

		// 2. Now safe to close audit writer — no more handlers can enqueue
		writerCtx, writerCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer writerCancel()
		if err := auditWriter.Close(writerCtx); err != nil {
			logger.Error("audit writer close timeout", "error", err)
		}
		close(done)
	}()

	logger.Info("server starting", "addr", cfg.HTTPAddr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}

	<-done
	logger.Info("server stopped")
	time.Sleep(100 * time.Millisecond)
}
