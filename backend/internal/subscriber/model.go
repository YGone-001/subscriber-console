// Package subscriber provides read-only subscriber list, detail, search, and batch precheck APIs.
//
// The read models reproduce the public subscriber and search API contract.
package subscriber

import "go.mongodb.org/mongo-driver/v2/bson"

// --- Subscriber List ---

// SubscriberListResult is the generic list response.
type SubscriberListResult[T any] struct {
	Subscribers []T                `json:"subscribers"`
	Total       int                `json:"total"`
	Page        int                `json:"page"`
	Limit       int                `json:"limit"`
	Summary     *SubscriberSummary `json:"summary,omitempty"`
	MatchedBy   string             `json:"matchedBy,omitempty"`
	MatchSource string             `json:"matchSource,omitempty"`
}

// SubscriberSummary provides aggregate status counts.
type SubscriberSummary struct {
	Total         int `json:"total"`
	Active        int `json:"active"`
	Restricted    int `json:"restricted"`
	LowTraffic    int `json:"lowTraffic"`
	LowBalance    int `json:"lowBalance"`
	Unprovisioned int `json:"unprovisioned"`
}

// SubscriberProvisioning reports whether the OCS provisioning records exist.
// Missing records are evidence, not zeros: callers must render an explicit
// "not configured" state instead of a default plan or quota.
type SubscriberProvisioning struct {
	Contract   bool `json:"contract"`
	Balance    bool `json:"balance"`
	TariffPlan bool `json:"tariffPlan"`
}

// SubscriberListFilters carries the additive list query filters. The legacy
// status filter remains supported; the other fields are opt-in.
type SubscriberListFilters struct {
	SearchBy       string
	Status         string
	ContractStatus string
	Provisioning   string
	PlanID         string
	BalanceStatus  string
	ProfileFilter  string
}

// SubscriberRow is the enriched row for detail=true mode.
type SubscriberRow struct {
	IMSI             string                 `json:"imsi"`
	MSISDN           string                 `json:"msisdn"`
	Status           string                 `json:"status"`
	ContractStatus   string                 `json:"contractStatus,omitempty"`
	BalanceState     string                 `json:"balanceState"`
	BalanceThreshold int64                  `json:"balanceThreshold,omitempty"`
	ARD              int                    `json:"ard"`
	PLMN             string                 `json:"plmn"`
	Profile          string                 `json:"profile"`
	Policy           string                 `json:"policy"`
	PolicyName       string                 `json:"policyName,omitempty"`
	PolicyStatus     string                 `json:"policyStatus,omitempty"`
	Provisioning     SubscriberProvisioning `json:"provisioning"`
	Traffic          TrafficSnapshot        `json:"traffic"`
	SMS              SMSSnapshot            `json:"sms"`
	LastActive       string                 `json:"lastActive"`
}

// TrafficSnapshot holds traffic balance data. A missing field is unknown, not
// zero: the list must not claim a remaining percentage it never measured.
type TrafficSnapshot struct {
	Total   *int64 `json:"total"`
	Used    *int64 `json:"used"`
	Balance *int64 `json:"balance"`
}

// SMSSnapshot holds SMS balance data.
type SMSSnapshot struct {
	Total   *int64 `json:"total"`
	Used    *int64 `json:"used"`
	Balance *int64 `json:"balance"`
}

// --- MSISDN Lookup ---

// MsisdnLookupResult is the MSISDN lookup response.
type MsisdnLookupResult struct {
	Exists bool    `json:"exists"`
	IMSI   *string `json:"imsi"`
	Source *string `json:"source"`
}

// --- Subscriber Detail ---

// LegacySubscriberState is the full detail response matching findSubscriberLegacyState().
type LegacySubscriberState struct {
	Sub4G         map[string]any `json:"sub4G"`
	Pcrf4G        map[string]any `json:"pcrf4G"`
	Auth4G        map[string]any `json:"auth4G"`
	OcsImsi       map[string]any `json:"ocsImsi"`
	OcsTraffic    map[string]any `json:"ocsTraffic"`
	OcsTariffPlan map[string]any `json:"ocsTariffPlan"`
}

// --- Search ---

// SearchResult is a single search result item.
type SearchResult struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Desc  string `json:"desc"`
	Type  string `json:"type"` // "imsi" or "profile"
	Path  string `json:"path"`
}

// SearchResponse is the search API response.
type SearchResponse struct {
	Results []SearchResult `json:"results"`
}

// --- Batch Precheck ---

// BatchPrecheckResult is the batch precheck response.
type BatchPrecheckResult struct {
	ConflictCount int      `json:"conflictCount"`
	ConflictImsis []string `json:"conflictImsis"`
	TotalCount    int      `json:"totalCount"`
}

// --- Internal BSON models ---

// xcloudSubscriberDoc is the raw BSON subscriber document from the xcloud.subscribers collection.
// We use bson.M for flexible access since xcloud documents have variable schemas.
type xcloudSubscriberDoc struct {
	ID                            bson.ObjectID `bson:"_id,omitempty"`
	IMSI                          string        `bson:"imsi"`
	MSISDN                        []string      `bson:"msisdn"`
	AccessRestrictionData         any           `bson:"access_restriction_data"`
	NetworkAccessMode             any           `bson:"network_access_mode"`
	SubscriberStatus              any           `bson:"subscriber_status"`
	OperatorID                    any           `bson:"operator_id"`
	SequenceNumber                any           `bson:"sequence_number"`
	AuthenticationManagementField any           `bson:"authentication_management_field"`
	MobileCountryCode             any           `bson:"mobile_country_code"`
	MobileNetworkCode             any           `bson:"mobile_network_code"`
	RAND                          any           `bson:"rand"`
	WebuiMeta                     any           `bson:"webui_meta"`
}

// ocsSubscriberDoc is the raw BSON document from xcloud.ocs_subscribers.
type ocsSubscriberDoc struct {
	IMSI     string `bson:"imsi"`
	MSISDN   string `bson:"msisdn"`
	Status   string `bson:"status"`
	PlanID   string `bson:"plan_id"`
	UpdateAt any    `bson:"updated_at"`
	CreateAt any    `bson:"created_at"`
}

// ocsBalanceDoc is the raw BSON document from xcloud.ocs_balances.
type ocsBalanceDoc struct {
	IMSI           string `bson:"imsi"`
	DataTotal      any    `bson:"data_total"`
	DataUsed       any    `bson:"data_used"`
	DataReserved   any    `bson:"data_reserved"`
	DataAvailable  any    `bson:"data_available"`
	VoiceTotal     any    `bson:"voice_total"`
	VoiceUsed      any    `bson:"voice_used"`
	VoiceReserved  any    `bson:"voice_reserved"`
	VoiceAvailable any    `bson:"voice_available"`
	SmsTotal       any    `bson:"sms_total"`
	SmsUsed        any    `bson:"sms_used"`
	SmsAvailable   any    `bson:"sms_available"`
	UpdateAt       any    `bson:"updated_at"`
}

// ocsTariffPlanDoc is the raw BSON document from xcloud.ocs_tariff_plans.
type ocsTariffPlanDoc struct {
	PlanID string `bson:"plan_id"`
	Name   string `bson:"name"`
	Status string `bson:"status"`
}

// profileDoc is the raw BSON document from xcloud_ops.app_profiles.
type profileDoc struct {
	Name  string `bson:"name"`
	Title string `bson:"title"`
}
