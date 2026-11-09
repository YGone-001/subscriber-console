// xcloud-agent is an outbound-only, read-only Linux collector.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"subscriber/internal/agentclient"
)

var version = "development"

func main() {
	configPath := flag.String("config", "/etc/xcloud-agent/config.json", "collector config file")
	flag.Parse()
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if runtime.GOOS != "linux" {
		logger.Error("the collector requires Linux")
		os.Exit(1)
	}
	cfg, token, err := agentclient.LoadConfig(*configPath)
	if err != nil {
		logger.Error("collector configuration rejected", "error", err)
		os.Exit(1)
	}
	client, err := agentclient.New(cfg, token)
	if err != nil {
		logger.Error("collector configuration rejected", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err = client.Run(ctx, logger, version); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("collector stopped", "error", err)
		os.Exit(1)
	}
}
