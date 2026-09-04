package subscriber

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	hex32Pattern        = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	hex4Pattern         = regexp.MustCompile(`^[0-9a-fA-F]{4}$`)
	hex1To6             = regexp.MustCompile(`^[0-9a-fA-F]{1,6}$`)
	sessionName         = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,63}$`)
	msisdnDigits        = regexp.MustCompile(`^\d+$`)
	plmnDigits          = regexp.MustCompile(`^\d{5,6}$`)
	tariffPlanIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
)

// ValidateImsi validates an IMSI string.
// Matches Node validateImsi() exactly.
func ValidateImsi(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("IMSI is required")
	}
	if len(value) != 15 {
		return "", fmt.Errorf("IMSI must be exactly 15 digits")
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return "", fmt.Errorf("IMSI must be exactly 15 digits")
		}
	}
	return value, nil
}

// ValidateTariffPlanId validates a tariff plan ID format.
// Matches Node isValidTariffPlanId() exactly: /^[A-Za-z0-9_.-]{1,64}$/
func ValidateTariffPlanId(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil // empty is allowed (will default)
	}
	if !tariffPlanIDPattern.MatchString(value) {
		return &SubscriberGovernanceError{Code: "INVALID_PLAN_ID"}
	}
	return nil
}

// UpdatePayload holds the subscriber update request body.
// Matches Node LegacySubscriberUpdatePayload shape.
type UpdatePayload struct {
	Sub4G      map[string]any `json:"sub4G"`
	Auth4G     map[string]any `json:"auth4G"`
	OcsTraffic map[string]any `json:"ocsTraffic"`
}

// ValidateSubscriberUpdatePayload validates the update payload.
// Matches Node validateSubscriberUpdatePayload() exactly.
func ValidateSubscriberUpdatePayload(payload UpdatePayload) error {
	if payload.Auth4G != nil {
		auth := payload.Auth4G
		if err := validateOptionalHex(auth, "k", 32); err != nil {
			return err
		}
		if err := validateOptionalHex(auth, "op", 32); err != nil {
			return err
		}
		if err := validateOptionalHex(auth, "opc", 32); err != nil {
			return err
		}
		if err := validateOptionalHex(auth, "amf", 4); err != nil {
			return err
		}
		if err := validateOptionalInteger(auth, "sqn", 0, 9007199254740991); err != nil {
			return err
		}
	}

	if payload.Sub4G != nil {
		sub := payload.Sub4G
		if err := validateOptionalInteger(sub, "access_restriction_data", 0, 255); err != nil {
			return err
		}
		if err := validateOptionalInteger(sub, "network_access_mode", 0, 2); err != nil {
			return err
		}
		if err := validateAmbr(sub, "ambr"); err != nil {
			return err
		}
		if err := validateMsisdnList(sub); err != nil {
			return err
		}
		if err := validateSliceList(sub); err != nil {
			return err
		}
	}

	if payload.OcsTraffic != nil {
		ocs := payload.OcsTraffic
		if v, ok := ocs["plmn"]; ok && v != nil {
			s := fmt.Sprintf("%v", v)
			if !plmnDigits.MatchString(s) {
				return fmt.Errorf("ocsTraffic.plmn must be 5 or 6 digits")
			}
		}
		numericFields := []string{"traffic_total", "traffic_balance", "voice_total", "voice_balance", "sms_total", "sms_balance"}
		for _, field := range numericFields {
			if err := validateOptionalNonNegativeNumber(ocs, field); err != nil {
				return err
			}
		}
	}

	return nil
}

func validateOptionalHex(m map[string]any, key string, expectedLen int) error {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	s := strings.TrimSpace(fmt.Sprintf("%v", v))
	if s == "" {
		return nil
	}
	pattern := hex32Pattern
	if expectedLen == 4 {
		pattern = hex4Pattern
	}
	if !pattern.MatchString(s) {
		return fmt.Errorf("auth4G.%s must be %d hexadecimal characters", key, expectedLen)
	}
	return nil
}

func validateOptionalInteger(m map[string]any, key string, min, max int64) error {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	n, ok := toInt64(v)
	if !ok || n < min || n > max {
		return fmt.Errorf("%s must be an integer between %d and %d", key, min, max)
	}
	return nil
}

func validateOptionalNonNegativeNumber(m map[string]any, key string) error {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	n, ok := toFloat64(v)
	if !ok || n < 0 {
		return fmt.Errorf("%s must be a non-negative number", key)
	}
	return nil
}

func validateAmbr(m map[string]any, key string) error {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	ambr, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	for _, dir := range []string{"downlink", "uplink"} {
		dirVal, ok := ambr[dir]
		if !ok || dirVal == nil {
			continue
		}
		dirMap, ok := dirVal.(map[string]any)
		if !ok {
			continue
		}
		if err := validateOptionalNonNegativeNumber(dirMap, "value"); err != nil {
			return fmt.Errorf("%s.%s.%w", key, dir, err)
		}
		if err := validateOptionalInteger(dirMap, "unit", 0, 4); err != nil {
			return fmt.Errorf("%s.%s.%w", key, dir, err)
		}
	}
	return nil
}

func validateMsisdnList(m map[string]any) error {
	v, ok := m["msisdnList"]
	if !ok || v == nil {
		return nil
	}
	list, ok := v.([]any)
	if !ok {
		return fmt.Errorf("sub4G.msisdnList must be an array")
	}
	for i, item := range list {
		itemMap, ok := item.(map[string]any)
		if !ok {
			continue
		}
		msisdn, ok := itemMap["msisdn"]
		if !ok || msisdn == nil {
			continue
		}
		s := fmt.Sprintf("%v", msisdn)
		if s != "" && !msisdnDigits.MatchString(s) {
			return fmt.Errorf("sub4G.msisdnList[%d].msisdn must contain digits only", i)
		}
	}
	return nil
}

func validateSliceList(m map[string]any) error {
	v, ok := m["sliceList"]
	if !ok || v == nil {
		return nil
	}
	list, ok := v.([]any)
	if !ok {
		return fmt.Errorf("sub4G.sliceList must be an array")
	}
	if len(list) > 16 {
		return fmt.Errorf("sub4G.sliceList cannot contain more than 16 slices")
	}
	for i, item := range list {
		slice, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if err := validateOptionalInteger(slice, "sst", 1, 255); err != nil {
			return fmt.Errorf("sub4G.sliceList[%d].%w", i, err)
		}
		if v, ok := slice["sd"]; ok && v != nil {
			s := fmt.Sprintf("%v", v)
			if s != "" && !hex1To6.MatchString(s) {
				return fmt.Errorf("sub4G.sliceList[%d].sd must be 1 to 6 hexadecimal characters", i)
			}
		}
		if err := validateSessionList(slice, i); err != nil {
			return err
		}
	}
	return nil
}

func validateSessionList(slice map[string]any, sliceIndex int) error {
	v, ok := slice["session_list"]
	if !ok || v == nil {
		return nil
	}
	list, ok := v.([]any)
	if !ok {
		return fmt.Errorf("sub4G.sliceList[%d].session_list must be an array", sliceIndex)
	}
	if len(list) > 32 {
		return fmt.Errorf("sub4G.sliceList[%d].session_list cannot contain more than 32 sessions", sliceIndex)
	}
	for j, item := range list {
		session, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if v, ok := session["name"]; ok && v != nil {
			s := fmt.Sprintf("%v", v)
			if s != "" && !sessionName.MatchString(s) {
				return fmt.Errorf("session %d.%d name contains invalid characters", sliceIndex+1, j+1)
			}
		}
		if err := validateOptionalInteger(session, "type", 1, 5); err != nil {
			return fmt.Errorf("session %d.%d.%w", sliceIndex+1, j+1, err)
		}
		if err := validateQos(session, sliceIndex, j); err != nil {
			return err
		}
		if err := validateAmbr(session, "ambr"); err != nil {
			return fmt.Errorf("session %d.%d.%w", sliceIndex+1, j+1, err)
		}
	}
	return nil
}

func validateQos(session map[string]any, sliceIndex, sessionIndex int) error {
	qos, ok := session["qos"]
	if !ok || qos == nil {
		return nil
	}
	qosMap, ok := qos.(map[string]any)
	if !ok {
		return nil
	}
	// _5qi or index
	for _, key := range []string{"_5qi", "index"} {
		if err := validateOptionalInteger(qosMap, key, 1, 255); err != nil {
			return fmt.Errorf("session %d.%d.qos.%w", sliceIndex+1, sessionIndex+1, err)
		}
	}
	arp, ok := qosMap["arp"]
	if !ok || arp == nil {
		return nil
	}
	arpMap, ok := arp.(map[string]any)
	if !ok {
		return nil
	}
	for _, key := range []string{"priorityLevel", "arpPriority", "priority_level"} {
		if err := validateOptionalInteger(arpMap, key, 1, 15); err != nil {
			return fmt.Errorf("session %d.%d.arp.%w", sliceIndex+1, sessionIndex+1, err)
		}
	}
	return nil
}

// toInt64 converts various numeric types to int64.
func toInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case float64:
		if n == float64(int64(n)) {
			return int64(n), true
		}
		return 0, false
	case float32:
		if float64(n) == float64(int64(n)) {
			return int64(n), true
		}
		return 0, false
	default:
		return 0, false
	}
}

// toFloat64 converts various numeric types to float64.
func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case float32:
		return float64(n), true
	case float64:
		return n, true
	default:
		return 0, false
	}
}
