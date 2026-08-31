// Package handler provides HTTP request handlers.
package handler

import (
	"net/http"

	"github.com/YGone-001/subscriber-console/backend/internal/mongo"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

// Health handles GET /healthz — liveness probe, no dependencies checked.
func Health(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// Ready handles GET /readyz — readiness probe, pings MongoDB.
func Ready(mc *mongo.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := mc.Ping(r.Context()); err != nil {
			response.Error(w, http.StatusServiceUnavailable, "MongoDB not ready", "NOT_READY")
			return
		}
		response.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}
