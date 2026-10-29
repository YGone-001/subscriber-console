package retention

import (
	"context"
	"errors"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/audit"
)

const ConfirmationPhrase = "PURGE TERMINATED OCS"

var (
	ErrRetentionDisabled  = errors.New("terminated-contract retention is disabled")
	ErrConfirmationNeeded = errors.New("confirmation phrase is required")
	ErrReasonRequired     = errors.New("reason is required")
	ErrNotTerminated      = errors.New("contract is not terminated")
	ErrContractNotFound   = errors.New("terminated contract not found")
)

type Settings struct {
	RetentionDays int    `json:"retentionDays"`
	Enabled       bool   `json:"enabled"`
	Cutoff        string `json:"cutoff,omitempty"`
	Confirmation  string `json:"confirmation"`
}

type Candidate struct {
	IMSI         string `json:"imsi"`
	TerminatedAt string `json:"terminatedAt"`
	AgeDays      int    `json:"ageDays"`
}

type Preview struct {
	Settings      Settings    `json:"settings"`
	EligibleCount int         `json:"eligibleCount"`
	Candidates    []Candidate `json:"candidates"`
}

type PurgeResult struct {
	DryRun            bool     `json:"dryRun"`
	Requested         int      `json:"requested"`
	PurgedContracts   int      `json:"purgedContracts"`
	PurgedBalances    int      `json:"purgedBalances"`
	PurgedAdjustments int      `json:"purgedAdjustments"`
	Skipped           []string `json:"skipped"`
	Warnings          []string `json:"warnings"`
}

type PurgeCounts struct {
	Contracts   int64
	Balances    int64
	Adjustments int64
}

type PurgeOptions struct {
	Apply        bool
	Reason       string
	Confirmation string
	IMSI         string
	Limit        int
	Actor        audit.ActorInput
}

type Repository struct {
	contracts   *mongo.Collection
	balances    *mongo.Collection
	adjustments *mongo.Collection
}

func NewRepository(contracts, balances, adjustments *mongo.Collection) *Repository {
	return &Repository{contracts: contracts, balances: balances, adjustments: adjustments}
}

// ListCandidates returns terminated contracts that have a parseable timestamp
// at or before the cutoff. A contract without a timestamp has no provable age
// and is therefore not eligible.
func (r *Repository) ListCandidates(ctx context.Context, cutoff time.Time) ([]Candidate, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	cursor, err := r.contracts.Find(ctx, bson.M{"status": "terminated"}, options.Find().SetSort(bson.D{{Key: "updated_at", Value: 1}}))
	if err != nil {
		return nil, 0, err
	}
	defer cursor.Close(ctx)

	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, 0, err
	}

	now := time.Now().UTC()
	all := make([]Candidate, 0, len(docs))
	for _, doc := range docs {
		imsi, _ := doc["imsi"].(string)
		if imsi == "" {
			continue
		}
		updated, ok := contractTime(doc["updated_at"])
		if !ok || updated.After(cutoff) {
			continue
		}
		all = append(all, Candidate{
			IMSI:         imsi,
			TerminatedAt: updated.UTC().Format(time.RFC3339),
			AgeDays:      int(now.Sub(updated).Hours() / 24),
		})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].TerminatedAt < all[j].TerminatedAt })
	return all, len(all), nil
}

func (r *Repository) GetCandidate(ctx context.Context, imsi string) (*Candidate, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := r.contracts.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	status, _ := doc["status"].(string)
	if status != "terminated" {
		return nil, ErrNotTerminated
	}
	updated, ok := contractTime(doc["updated_at"])
	if !ok {
		return &Candidate{IMSI: imsi, TerminatedAt: ""}, nil
	}
	return &Candidate{
		IMSI:         imsi,
		TerminatedAt: updated.UTC().Format(time.RFC3339),
		AgeDays:      int(time.Since(updated).Hours() / 24),
	}, nil
}

// PurgeContract removes the adjustments, balance and contract for one
// terminated contract. It never touches app_audit_logs or the subscriber
// identity. A missing or non-terminated contract is refused; repeated calls are
// idempotent at the candidate level.
func (r *Repository) PurgeContract(ctx context.Context, imsi string) (PurgeCounts, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	var doc bson.M
	err := r.contracts.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return PurgeCounts{}, nil
	}
	if err != nil {
		return PurgeCounts{}, err
	}
	status, _ := doc["status"].(string)
	if status != "terminated" {
		return PurgeCounts{}, ErrNotTerminated
	}

	adjustmentResult, err := r.adjustments.DeleteMany(ctx, bson.M{"imsi": imsi})
	if err != nil {
		return PurgeCounts{}, err
	}
	balanceResult, err := r.balances.DeleteOne(ctx, bson.M{"imsi": imsi})
	if err != nil {
		return PurgeCounts{}, err
	}
	contractResult, err := r.contracts.DeleteOne(ctx, bson.M{"imsi": imsi, "status": "terminated"})
	if err != nil {
		return PurgeCounts{}, err
	}
	if contractResult.DeletedCount == 0 {
		return PurgeCounts{}, ErrNotTerminated
	}
	return PurgeCounts{
		Contracts:   contractResult.DeletedCount,
		Balances:    balanceResult.DeletedCount,
		Adjustments: adjustmentResult.DeletedCount,
	}, nil
}

func contractTime(value any) (time.Time, bool) {
	switch typed := value.(type) {
	case time.Time:
		return typed.UTC(), true
	case bson.DateTime:
		return typed.Time().UTC(), true
	case string:
		parsed, err := time.Parse(time.RFC3339Nano, typed)
		if err != nil {
			return time.Time{}, false
		}
		return parsed.UTC(), true
	default:
		return time.Time{}, false
	}
}
