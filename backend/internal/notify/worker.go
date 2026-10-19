package notify

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"subscriber/internal/nfalert"
)

// AlertStateReader resolves an alert's current lifecycle state. It is the only
// dependency the worker needs to suppress a late escalation.
type AlertStateReader interface {
	AlertState(ctx context.Context, alertID string) (string, error)
}

// alertStateReader adapts the NF alert repository to the worker.
type alertStateReader struct {
	alerts interface {
		GetAlert(ctx context.Context, alertID string) (*nfalert.Alert, error)
	}
}

// NewAlertStateReader wraps an alert lookup for the escalation check.
func NewAlertStateReader(alerts interface {
	GetAlert(ctx context.Context, alertID string) (*nfalert.Alert, error)
}) AlertStateReader {
	return &alertStateReader{alerts: alerts}
}

func (r *alertStateReader) AlertState(ctx context.Context, alertID string) (string, error) {
	alert, err := r.alerts.GetAlert(ctx, alertID)
	if err != nil {
		return "", err
	}
	if alert == nil {
		return nfalert.AlertStateResolved, nil
	}
	return alert.State, nil
}

// DeliveryStore is the delivery-ledger surface the worker needs. The concrete
// Repository satisfies it; tests substitute a fake.
type DeliveryStore interface {
	ClaimDue(ctx context.Context, now time.Time) (*Delivery, error)
	GetChannel(ctx context.Context, id string) (*NotificationChannel, error)
	MarkSent(ctx context.Context, id string, completedAt time.Time) error
	MarkSkipped(ctx context.Context, id string, completedAt time.Time) error
	MarkFailed(ctx context.Context, id string, attempts int, cause string, now time.Time) error
}

// Worker is the single place that sends notifications. It polls the delivery
// ledger for due work, sends one bounded webhook at a time and applies the
// retry and dead-letter policy. It is the only component allowed to perform
// outbound network egress on the alert's behalf.
type Worker struct {
	store        DeliveryStore
	sender       Sender
	state        AlertStateReader
	pollInterval time.Duration
	logger       *slog.Logger
	now          func() time.Time

	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewWorker constructs the delivery worker.
func NewWorker(store DeliveryStore, sender Sender, state AlertStateReader, logger *slog.Logger) *Worker {
	return &Worker{
		store:        store,
		sender:       sender,
		state:        state,
		pollInterval: WorkerPollInterval,
		logger:       logger,
		now:          func() time.Time { return time.Now().UTC() },
	}
}

// Start launches the worker goroutine once.
func (w *Worker) Start(ctx context.Context) {
	w.mu.Lock()
	if w.running {
		w.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	w.running = true
	w.mu.Unlock()

	w.wg.Add(1)
	go w.loop(runCtx)
}

// Stop cancels the poll loop and waits for in-flight sends to finish.
func (w *Worker) Stop() {
	w.mu.Lock()
	if !w.running {
		w.mu.Unlock()
		return
	}
	cancel := w.cancel
	w.running = false
	w.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	w.wg.Wait()
}

func (w *Worker) loop(ctx context.Context) {
	defer w.wg.Done()
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.processOnce(ctx)
		}
	}
}

func (w *Worker) processOnce(ctx context.Context) {
	for i := 0; i < WorkerBatchSize; i++ {
		delivery, err := w.store.ClaimDue(ctx, w.now())
		if err != nil {
			if w.logger != nil {
				w.logger.Warn("notification claim failed", "error", err)
			}
			return
		}
		if delivery == nil {
			return
		}
		w.deliver(delivery)
	}
}

// deliver performs one send. It uses a fresh context so a single slow channel
// cannot stall the poll loop, but the webhook send still carries its own
// bounded timeout.
func (w *Worker) deliver(delivery *Delivery) {
	sendCtx, cancel := context.WithTimeout(context.Background(), WebhookTimeout+2*time.Second)
	defer cancel()

	channel, err := w.store.GetChannel(sendCtx, delivery.ChannelID)
	if err != nil || channel == nil || !channel.Enabled {
		_ = w.store.MarkFailed(sendCtx, delivery.ID, delivery.Attempts, "channel is unavailable or disabled", w.now())
		return
	}

	// A delayed escalation that found the alert already closed is skipped, not
	// sent: an escalation after recovery would be a false alarm.
	if delivery.Event == DeliveryEventEscalate && w.state != nil {
		if state, err := w.state.AlertState(sendCtx, delivery.AlertID); err == nil && state == nfalert.AlertStateResolved {
			_ = w.store.MarkSkipped(sendCtx, delivery.ID, w.now())
			return
		}
	}

	if err := w.sender.Send(sendCtx, channel, delivery); err != nil {
		_ = w.store.MarkFailed(sendCtx, delivery.ID, delivery.Attempts, err.Error(), w.now())
		return
	}
	_ = w.store.MarkSent(sendCtx, delivery.ID, w.now())
}
