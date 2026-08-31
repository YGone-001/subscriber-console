// Package rating provides read-only rating API handlers.
package rating

// RatingPolicy matches the existing API response shape.
type RatingPolicy struct {
	RatingGroupID    int    `json:"rating_group_id"`
	Currency         string `json:"currency"`
	Rates            string `json:"rates"`
	RatesType        int    `json:"rates_type"`
	PlanID           string `json:"plan_id"`
	RuleID           string `json:"rule_id"`
	Apn              string `json:"apn"`
	ServiceIdentifier int   `json:"service_identifier"`
	ChargingType     string `json:"charging_type"`
	Unit             string `json:"unit"`
	QuotaPerGrant    int64  `json:"quota_per_grant"`
	ValidityTime     int    `json:"validity_time"`
	VolumeThreshold  int64  `json:"volume_threshold"`
	Priority         int    `json:"priority"`
	Status           string `json:"status"`
}

// RatingListResponse matches the existing API response shape.
type RatingListResponse struct {
	Ratings []RatingPolicy `json:"ratings"`
}
