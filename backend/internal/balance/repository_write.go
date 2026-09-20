package balance

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

var (
	// ErrBalanceNotFound is returned when the balance document does not exist.
	ErrBalanceNotFound = errors.New("BALANCE_NOT_FOUND")

	// ErrPreconditionChanged is returned when the CAS version/fingerprint check fails.
	ErrPreconditionChanged = errors.New("BALANCE_PRECONDITION_CHANGED")

	// ErrInsufficientBalance is returned when debit exceeds available balance.
	ErrInsufficientBalance = errors.New("INSUFFICIENT_BALANCE")

	// ErrInvalidBucket is returned when an unsupported bucket is specified.
	ErrInvalidBucket = errors.New("INVALID_BUCKET")

	// ErrInvalidOperation is returned when an unsupported operation is specified.
	ErrInvalidOperation = errors.New("INVALID_OPERATION")

	// ErrInvalidAmount is returned when adjustment amount is not positive.
	ErrInvalidAmount = errors.New("INVALID_AMOUNT")

	// ErrInvariantViolation is returned when current balance violates invariants.
	ErrInvariantViolation = errors.New("BALANCE_INVARIANT_VIOLATION")
)

// AdjustmentResult holds before and after balance records from a CAS adjustment.
type AdjustmentResult struct {
	Before  BalanceRecord
	After   BalanceRecord
	Bucket  string
	Delta   int64
	Version int64
}

// AdjustBalanceCAS performs an atomic Compare-And-Swap balance adjustment.
// Validates invariant constraints and ensures no blind updates occur.
func (r *Repository) AdjustBalanceCAS(ctx context.Context, imsi string, expectedVersion int64, bucket string, operation string, amount int64) (*AdjustmentResult, error) {
	if amount <= 0 {
		return nil, ErrInvalidAmount
	}
	if operation != "credit" && operation != "debit" {
		return nil, ErrInvalidOperation
	}
	if bucket != "data" && bucket != "voice" && bucket != "sms" {
		return nil, ErrInvalidBucket
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// 1. Read current balance document
	var currentDoc bson.M
	err := r.balances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&currentDoc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, ErrBalanceNotFound
		}
		return nil, err
	}

	before := mapBalanceDoc(currentDoc, nil)
	if !before.InvariantOk {
		return nil, ErrInvariantViolation
	}

	// 2. Verify CAS precondition
	if before.Version != expectedVersion {
		return nil, ErrPreconditionChanged
	}

	// 3. Compute delta and target values
	delta := amount
	if operation == "debit" {
		delta = -amount
	}

	setFields := bson.M{}
	after := before

	switch bucket {
	case "data":
		newTotal := before.DataTotal + delta
		newAvailable := before.DataAvailable + delta
		if newAvailable < 0 || newTotal < (before.DataUsed+before.DataReserved) {
			return nil, ErrInsufficientBalance
		}
		setFields["data_total"] = newTotal
		setFields["data_available"] = newAvailable
		after.DataTotal = newTotal
		after.DataAvailable = newAvailable
	case "voice":
		newTotal := before.VoiceTotal + delta
		newAvailable := before.VoiceAvailable + delta
		if newAvailable < 0 || newTotal < (before.VoiceUsed+before.VoiceReserved) {
			return nil, ErrInsufficientBalance
		}
		setFields["voice_total"] = newTotal
		setFields["voice_available"] = newAvailable
		after.VoiceTotal = newTotal
		after.VoiceAvailable = newAvailable
	case "sms":
		newTotal := before.SmsTotal + delta
		newAvailable := before.SmsAvailable + delta
		if newAvailable < 0 || newTotal < before.SmsUsed {
			return nil, ErrInsufficientBalance
		}
		setFields["sms_total"] = newTotal
		setFields["sms_available"] = newAvailable
		after.SmsTotal = newTotal
		after.SmsAvailable = newAvailable
	}

	now := time.Now().UTC()
	nowISO := now.Format("2006-01-02T15:04:05.000Z")
	newVersion := expectedVersion + 1

	setFields["version"] = newVersion
	setFields["updated_at"] = nowISO

	after.Version = newVersion
	after.UpdatedAt = nowISO
	after.CheckInvariants()

	// 4. Atomic CAS update filter
	filter := bson.M{
		"imsi": imsi,
	}
	if expectedVersion == 0 {
		filter["$or"] = bson.A{
			bson.M{"version": 0},
			bson.M{"version": bson.M{"$exists": false}},
		}
	} else {
		filter["version"] = expectedVersion
	}

	update := bson.M{"$set": setFields}
	res, err := r.balances.UpdateOne(ctx, filter, update)
	if err != nil {
		return nil, fmt.Errorf("balance update failed: %w", err)
	}
	if res.MatchedCount == 0 {
		return nil, ErrPreconditionChanged
	}

	return &AdjustmentResult{
		Before:  before,
		After:   after,
		Bucket:  bucket,
		Delta:   delta,
		Version: newVersion,
	}, nil
}
