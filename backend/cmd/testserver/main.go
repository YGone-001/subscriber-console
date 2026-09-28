// Package main is the entry point for the dedicated test-only failure server harness.
// It wires existing production platform handlers to deterministically failing dependencies
// without exposing any runtime fault-injection mechanism in the production binary.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
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

	testAlerts := &testAlertReader{
		realRepo: alert.NewRepository(mc.Ops.Collection("app_alerts")),
	}
	testAlerts.failReads.Store(false)

	testSessions := &testSessionValidator{
		realValidator: sessionValidator,
	}

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

	rawNotificationHandler := notification.NewHandler(testAlerts, testSessions)
	instrumentedNotification := &testNotificationHandler{
		handler: authMiddleware(rawNotificationHandler),
	}

	mux.Handle("GET /api/alerts", authMiddleware(http.HandlerFunc(alertHandler.List)))
	mux.Handle("POST /api/alerts/acknowledge", authMiddleware(http.HandlerFunc(alertHandler.Acknowledge)))
	mux.Handle("POST /api/alerts/workflow", authMiddleware(http.HandlerFunc(alertHandler.Workflow)))
	mux.Handle("GET /api/notifications/stream", instrumentedNotification)
	mux.Handle("POST /api/analytics/init", authMiddleware(http.HandlerFunc(analyticsHandler.Init)))
	mux.Handle("GET /api/system/health", authMiddleware(http.HandlerFunc(systemHandler.SystemHealth)))
	mux.Handle("GET /api/system/mongo/health", authMiddleware(http.HandlerFunc(systemHandler.MongoHealth)))
	mux.Handle("GET /api/system/audit/status", authMiddleware(http.HandlerFunc(systemHandler.AuditStatus)))
	mux.Handle("POST /api/system/audit/scan", authMiddleware(http.HandlerFunc(systemHandler.AuditScan)))

	// Dedicated test control endpoints for test-only failure harness
	mux.HandleFunc("GET /testonly/counters", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{
			"alertReads":         testAlerts.readCount.Load(),
			"sessionValidations": testSessions.valCount.Load(),
			"activeHandlers":     instrumentedNotification.activeHandlers.Load(),
		})
	})
	mux.HandleFunc("POST /testonly/fail-alerts", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Fail bool `json:"fail"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			testAlerts.failReads.Store(req.Fail)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"fail": testAlerts.failReads.Load()})
	})
	mux.HandleFunc("POST /testonly/reset-counters", func(w http.ResponseWriter, r *http.Request) {
		testAlerts.readCount.Store(0)
		testSessions.valCount.Store(0)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})

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

	serverCtx, serverCancel := context.WithCancel(context.Background())
	defer serverCancel()

	srv := &http.Server{
		Addr:         cfg.HTTPAddr,
		Handler:      finalHandler,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
		BaseContext: func(net.Listener) context.Context {
			return serverCtx
		},
	}
	srv.RegisterOnShutdown(serverCancel)

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

type testAlertReader struct {
	realRepo  *alert.Repository
	readCount atomic.Int64
	failReads atomic.Bool
}

func (r *testAlertReader) ListAlerts(ctx context.Context, limit int64) (*alert.ListAlertsResponse, error) {
	r.readCount.Add(1)
	if r.failReads.Load() {
		return nil, errors.New("simulated alert repository failure")
	}
	return r.realRepo.ListAlerts(ctx, limit)
}

type testSessionValidator struct {
	realValidator *auth.SessionValidator
	valCount      atomic.Int64
}

func (v *testSessionValidator) ValidateSession(ctx context.Context, claims *auth.Claims) (*auth.Principal, error) {
	v.valCount.Add(1)
	return v.realValidator.ValidateSession(ctx, claims)
}

type testNotificationHandler struct {
	handler        http.Handler
	activeHandlers atomic.Int64
}

func (h *testNotificationHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.activeHandlers.Add(1)
	defer h.activeHandlers.Add(-1)
	h.handler.ServeHTTP(w, r)
}
