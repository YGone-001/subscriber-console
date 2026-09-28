package notification_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"subscriber/internal/alert"
	"subscriber/internal/auth"
	"subscriber/internal/notification"
)

type dummyAlertReader struct{}

func (d *dummyAlertReader) ListAlerts(ctx context.Context, limit int64) (*alert.ListAlertsResponse, error) {
	return &alert.ListAlertsResponse{
		Alerts:              []alert.AlertDocument{},
		ActiveCriticalCount: 0,
		ActiveWarningCount:  0,
		ActiveCount:         0,
	}, nil
}

type dummySessionRevalidator struct{}

func (d *dummySessionRevalidator) ValidateSession(ctx context.Context, claims *auth.Claims) (*auth.Principal, error) {
	return &auth.Principal{
		Username: claims.Username,
		Role:     claims.Role,
	}, nil
}

func TestGracefulShutdown(t *testing.T) {
	var handlerActive atomic.Int64

	handler := notification.NewHandler(&dummyAlertReader{}, &dummySessionRevalidator{})
	wrappedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerActive.Add(1)
		defer handlerActive.Add(-1)
		p := &auth.Principal{
			Username: "shutdown_user",
			Role:     "admin",
		}
		handler.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), p)))
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}

	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()

	srv := &http.Server{
		Handler: wrappedHandler,
		BaseContext: func(net.Listener) context.Context {
			return rootCtx
		},
	}

	serverErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
		close(serverErr)
	}()

	addr := listener.Addr().String()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("failed to dial: %v", err)
	}
	defer conn.Close()

	reqStr := "GET /api/notifications/stream HTTP/1.1\r\nHost: " + addr + "\r\nAccept: text/event-stream\r\n\r\n"
	if _, err := conn.Write([]byte(reqStr)); err != nil {
		t.Fatalf("failed to write request: %v", err)
	}

	reader := bufio.NewReader(conn)
	var sawInit bool
	deadline := time.Now().Add(5 * time.Second)
	_ = conn.SetReadDeadline(deadline)

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		if strings.HasPrefix(line, "event: init") {
			sawInit = true
			break
		}
	}

	if !sawInit {
		t.Fatalf("did not receive init event before timeout")
	}

	if handlerActive.Load() != 1 {
		t.Fatalf("expected handlerActive == 1, got %d", handlerActive.Load())
	}
	fmt.Println("handler_active_before_shutdown=true")

	// Trigger graceful shutdown
	fmt.Println("shutdown_requested=true")
	rootCancel()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	shutdownErr := srv.Shutdown(shutdownCtx)
	if shutdownErr != nil {
		t.Fatalf("srv.Shutdown error: %v", shutdownErr)
	}
	fmt.Println("server_shutdown_completed=true")

	// Read from conn until EOF / connection closed
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, err := reader.ReadByte()
		if err != nil {
			break
		}
	}
	fmt.Println("connection_closed=true")

	// Verify handler has exited
	for i := 0; i < 20; i++ {
		if handlerActive.Load() == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if handlerActive.Load() != 0 {
		t.Fatalf("expected handlerActive == 0, got %d", handlerActive.Load())
	}
	fmt.Println("handler_exited=true")
}
