// Package main is the entry point for the subscriber-console Go backend.
//
// Phase 1: Foundation — health endpoints, MongoDB client, middleware, graceful shutdown.
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

	"github.com/YGone-001/subscriber-console/backend/internal/config"
	"github.com/YGone-001/subscriber-console/backend/internal/handler"
	mongoClient "github.com/YGone-001/subscriber-console/backend/internal/mongo"
	"github.com/YGone-001/subscriber-console/backend/internal/middleware"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

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

	// Build handler
	mux := http.NewServeMux()

	// Health endpoints (no auth, no middleware)
	mux.HandleFunc("GET /healthz", handler.Health)
	mux.HandleFunc("GET /readyz", handler.Ready(mc))

	// API routes (future phases will add business handlers here)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		response.NotFound(w)
	})

	// Apply middleware chain
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

	logger.Info("server starting", "addr", cfg.HTTPAddr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}

	<-done
	logger.Info("server stopped")

	// Allow MongoDB connection to drain
	time.Sleep(100 * time.Millisecond)
}
