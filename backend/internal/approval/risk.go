package approval

// RiskAssessment is the server-owned risk evaluation for an approval action.
type RiskAssessment struct {
	Level    RiskLevel `json:"level"`
	Reasons  []string  `json:"reasons"`
	PolicyID string    `json:"policyId"`
}

// ApprovalRiskPolicyID is the identifier for the current risk policy.
const ApprovalRiskPolicyID = "approval-risk-v1"

// riskRule is the internal risk rule structure (without policyId).
type riskRule struct {
	level   RiskLevel
	reasons []string
}

// riskCatalog is the server-owned risk catalog. Callers submit a supported
// action, never a risk level. Unknown operations fail safe as high risk.
var riskCatalog = map[string]riskRule{
	"ACCESS_REQUEST":              {level: RiskHigh, reasons: []string{"Changes an account authorization boundary"}},
	"POLICY_CHANGE":               {level: RiskHigh, reasons: []string{"Changes live subscriber policy assignment"}},
	"TRAFFIC_ADJUSTMENT":          {level: RiskHigh, reasons: []string{"Changes a charging balance"}},
	"TARIFF_PLAN_CREATE":          {level: RiskHigh, reasons: []string{"Adds a charging tariff plan"}},
	"TARIFF_PLAN_UPDATE":          {level: RiskHigh, reasons: []string{"Changes an active charging tariff plan"}},
	"TARIFF_PLAN_DELETE":          {level: RiskCritical, reasons: []string{"Removes a charging tariff plan"}},
	"TARIFF_PLAN_RULE_CREATE":     {level: RiskHigh, reasons: []string{"Adds a charging tariff rule"}},
	"TARIFF_PLAN_RULE_UPDATE":     {level: RiskHigh, reasons: []string{"Changes an active charging tariff rule"}},
	"TARIFF_PLAN_RULE_DELETE":     {level: RiskCritical, reasons: []string{"Removes a charging tariff rule"}},
	"TARIFF_PLAN_RULE_TOGGLE":     {level: RiskHigh, reasons: []string{"Changes a charging tariff rule state"}},
	"RATING_CREATE":               {level: RiskMedium, reasons: []string{"Adds a charging rule without removing an existing rule"}},
	"RATING_UPDATE":               {level: RiskHigh, reasons: []string{"Changes an active charging rule"}},
	"RATING_DELETE":               {level: RiskCritical, reasons: []string{"Removes an active charging rule"}},
	"TARIFF_PLAN_MIGRATE":         {level: RiskCritical, reasons: []string{"Moves multiple subscribers between tariff plans"}},
	"PROFILE_RESTORE":             {level: RiskHigh, reasons: []string{"Restores a previous configuration snapshot"}},
	"SYSTEM_HEAL":                 {level: RiskHigh, reasons: []string{"Writes corrective state to a managed resource"}},
	"SUBSCRIBER_BATCH_CREATE":     {level: RiskHigh, reasons: []string{"Creates multiple subscriber records"}},
	"SUBSCRIBER_BATCH_UPDATE":     {level: RiskHigh, reasons: []string{"Changes live core subscriber access or AMBR settings in bulk"}},
	"SUBSCRIBER_CREATE":           {level: RiskMedium, reasons: []string{"Creates a new subscriber record"}},
	"SUBSCRIBER_UPDATE":           {level: RiskHigh, reasons: []string{"Changes governed core subscriber configuration"}},
	"SUBSCRIBER_DELETE":           {level: RiskHigh, reasons: []string{"Physically deletes subscriber provisioning"}},
	"SUBSCRIBER_IMPORT":           {level: RiskHigh, reasons: []string{"Imports new subscriber records only"}},
	"SUBSCRIBER_IMPORT_OVERWRITE": {level: RiskCritical, reasons: []string{"Imports records that overwrite existing subscribers"}},
	"SUBSCRIBER_BULK_DELETE":      {level: RiskCritical, reasons: []string{"Deletes multiple subscriber records"}},
	"SUBSCRIBER_PROFILE_APPLY":    {level: RiskHigh, reasons: []string{"Applies a profile to live subscriber configuration"}},
}

// AssessApprovalRisk evaluates the risk for a given action.
// Unknown actions fail safe as high risk.
func AssessApprovalRisk(action string) RiskAssessment {
	rule, ok := riskCatalog[action]
	if !ok {
		return RiskAssessment{
			Level:    RiskHigh,
			Reasons:  []string{"Operation is not present in the approved risk catalog; fail-safe review is required"},
			PolicyID: ApprovalRiskPolicyID,
		}
	}
	reasons := make([]string, len(rule.reasons))
	copy(reasons, rule.reasons)
	return RiskAssessment{
		Level:    rule.level,
		Reasons:  reasons,
		PolicyID: ApprovalRiskPolicyID,
	}
}

// RequiresIndependentReviewer returns true if the risk level requires
// an independent reviewer (requester cannot approve/reject own request).
// low/medium → self-review MAY be allowed.
// high/critical → requester CANNOT approve/reject own request.
func RequiresIndependentReviewer(risk RiskLevel) bool {
	return risk == RiskHigh || risk == RiskCritical
}

// IsSupportedApprovalAction returns true if the action is in the risk catalog.
func IsSupportedApprovalAction(value string) bool {
	_, ok := riskCatalog[value]
	return ok
}

// SupportedApprovalActions returns all actions in the risk catalog.
func SupportedApprovalActions() []string {
	actions := make([]string, 0, len(riskCatalog))
	for k := range riskCatalog {
		actions = append(actions, k)
	}
	return actions
}
