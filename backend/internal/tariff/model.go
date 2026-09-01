package tariff

// PlanListResponse matches GET /api/tariff-plans response shape.
type PlanListResponse struct {
	Plans []PlanSummary `json:"plans"`
}

// PlanSummary matches Node TariffPlanSummary.
type PlanSummary struct {
	PlanID          string `json:"plan_id"`
	Name            string `json:"name"`
	Description     string `json:"description"`
	Status          string `json:"status"`
	QuotaPerGrant   int64  `json:"quota_per_grant,omitempty"`
	ValidityTime    int    `json:"validity_time,omitempty"`
	VolumeThreshold int64  `json:"volume_threshold,omitempty"`
	RulesCount      int    `json:"rulesCount"`
	SubscriberCount int    `json:"subscriberCount"`
	IsDefault       bool   `json:"isDefault"`
	CreatedAt       string `json:"created_at,omitempty"`
	UpdatedAt       string `json:"updated_at,omitempty"`
}

// PlanDetailResponse matches GET /api/tariff-plans/:planId response shape.
type PlanDetailResponse struct {
	Plan PlanDetail `json:"plan"`
}

// PlanDetail extends PlanSummary with rules.
type PlanDetail struct {
	PlanSummary
	Rules []RatingPolicy `json:"rules"`
}

// RatingPolicy matches Node RatingPolicy (normalized rule).
type RatingPolicy struct {
	RatingGroupID     int64  `json:"rating_group_id"`
	Currency          string `json:"currency"`
	Rates             string `json:"rates"`
	RatesType         int    `json:"rates_type"`
	PlanID            string `json:"plan_id"`
	RuleID            string `json:"rule_id"`
	APN               string `json:"apn"`
	ServiceIdentifier int64  `json:"service_identifier"`
	ChargingType      string `json:"charging_type"`
	Unit              string `json:"unit"`
	QuotaPerGrant     int64  `json:"quota_per_grant"`
	ValidityTime      int    `json:"validity_time"`
	VolumeThreshold   int64  `json:"volume_threshold"`
	Priority          int    `json:"priority"`
	Status            string `json:"status"`
}

// RulesResponse matches GET /api/tariff-plans/:planId/rules response shape.
type RulesResponse struct {
	PlanID    string         `json:"plan_id"`
	Rules     []RatingPolicy `json:"rules"`
	Conflicts []RuleConflict `json:"conflicts"`
	Count     int            `json:"count"`
}

// RuleConflict represents a conflict between rules.
type RuleConflict struct {
	RuleID1 string `json:"ruleId1"`
	RuleID2 string `json:"ruleId2"`
	Type    string `json:"type"`
	Message string `json:"message"`
}

// ExportResponse matches Node normalizeTariffPlanExport shape.
type ExportResponse struct {
	Version         string         `json:"version"`
	ExportedAt      string         `json:"exported_at"`
	PlanID          string         `json:"plan_id"`
	Name            string         `json:"name"`
	Description     string         `json:"description"`
	Status          string         `json:"status"`
	QuotaPerGrant   int64          `json:"quota_per_grant"`
	ValidityTime    int            `json:"validity_time"`
	VolumeThreshold int64          `json:"volume_threshold"`
	Rules           []RatingPolicy `json:"rules"`
}

// OperationsResponse matches GET /api/tariff-plans/:planId/operations response shape.
type OperationsResponse struct {
	Summary OperationsSummary `json:"summary"`
	History []AuditLogEntry   `json:"history"`
}

// OperationsSummary matches Node buildTariffPlanOperationsSummary shape.
type OperationsSummary struct {
	TotalPlans                int     `json:"totalPlans"`
	ActivePlans               int     `json:"activePlans"`
	DisabledPlans             int     `json:"disabledPlans"`
	TotalLinkedSubscribers    int     `json:"totalLinkedSubscribers"`
	SelectedLinkedSubscribers int     `json:"selectedLinkedSubscribers"`
	SelectedSharePct          float64 `json:"selectedSharePct"`
	RecentActivityCount       int     `json:"recentActivityCount"`
	LastChangedAt             *string `json:"lastChangedAt"`
}

// AuditLogEntry represents an audit log record.
type AuditLogEntry struct {
	ID        string `json:"id"`
	Action    string `json:"action"`
	Module    string `json:"module"`
	Result    string `json:"result"`
	RiskLevel string `json:"riskLevel"`
	Actor     string `json:"actor"`
	CreatedAt string `json:"createdAt,omitempty"`
}

// SubscribersResponse matches GET /api/tariff-plans/:planId/subscribers response shape.
type SubscribersResponse struct {
	Subscribers []SubscriberEntry `json:"subscribers"`
	Total       int64             `json:"total"`
	PlanID      string            `json:"plan_id"`
}

// SubscriberEntry represents a subscriber on a tariff plan.
type SubscriberEntry struct {
	IMSI      string `json:"imsi"`
	MSISDN    string `json:"msisdn,omitempty"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// MigratePreviewResponse matches GET /api/tariff-plans/:planId/migrate response shape.
type MigratePreviewResponse struct {
	Preview MigratePreview `json:"preview"`
}

// MigratePreview holds dry-run migration results.
type MigratePreview struct {
	SourcePlanID    string `json:"sourcePlanId"`
	TargetPlanID    string `json:"targetPlanId"`
	SubscriberCount int64  `json:"subscriberCount"`
}
