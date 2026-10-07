package subscriber

import (
	"fmt"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// CreateAuthenticationMaterial is the bounded, validated representation of operator-supplied
// authentication material for subscriber creation.
//
// It exists so that unvalidated request maps never reach persistence. The create path accepts an
// arbitrary JSON object for auth4G, and passing that map straight down to the BSON document would
// let an unknown or malformed field become part of a subscriber. Only the five fields below are
// representable here, and every value in a value of this type has already passed validation and
// been canonicalized.
//
// Exactly one of OP / OPc is non-nil. Both nil is rejected at parse time, and so is both set.
type CreateAuthenticationMaterial struct {
	K   string
	OP  *string
	OPc *string
	AMF string
	SQN int64
}

// createAuthAllowedFields is the complete set of keys auth4G may contain. Anything else is
// rejected rather than ignored, so a typo in a credential field fails loudly instead of silently
// provisioning a default.
var createAuthAllowedFields = map[string]struct{}{
	"k":   {},
	"op":  {},
	"opc": {},
	"amf": {},
	"sqn": {},
}

// ParseCreateAuthenticationMaterial validates the optional auth4G object of a create request.
//
// Returns (nil, nil) when auth4G is absent, which is the backward-compatible path: the caller
// then keeps the server's existing default authentication behaviour untouched.
//
// Errors name the offending field and its required format but never echo the supplied value, so a
// rejected credential cannot leak through an error response or a log line.
func ParseCreateAuthenticationMaterial(raw map[string]any) (*CreateAuthenticationMaterial, error) {
	if raw == nil {
		return nil, nil
	}

	for key := range raw {
		if _, ok := createAuthAllowedFields[key]; !ok {
			return nil, fmt.Errorf("auth4G.%s is not a supported field", key)
		}
	}

	k, err := requireCreateHex(raw, "k", 32)
	if err != nil {
		return nil, err
	}

	op, opc, err := resolveCreateOPFields(raw)
	if err != nil {
		return nil, err
	}

	amf, err := requireCreateHex(raw, "amf", 4)
	if err != nil {
		return nil, err
	}

	sqn, err := requireCreateSQN(raw)
	if err != nil {
		return nil, err
	}

	return &CreateAuthenticationMaterial{K: *k, OP: op, OPc: opc, AMF: *amf, SQN: sqn}, nil
}

// resolveCreateOPFields enforces the exactly-one-of rule between op and opc.
//
// Each of the two is optional on its own - only the pair is constrained - so both are read with
// the optional reader and the requirement is applied to the combination. Reading them as
// individually required would reject a valid OPc-only request for "missing op".
func resolveCreateOPFields(raw map[string]any) (*string, *string, error) {
	op, opErr := readCreateHex(raw, "op", 32)
	if opErr != nil {
		return nil, nil, opErr
	}
	opc, opcErr := readCreateHex(raw, "opc", 32)
	if opcErr != nil {
		return nil, nil, opcErr
	}

	switch {
	case op != nil && opc != nil:
		return nil, nil, fmt.Errorf("auth4G must supply exactly one of op or opc, not both")
	case op == nil && opc == nil:
		return nil, nil, fmt.Errorf("auth4G must supply exactly one of op or opc")
	}
	return op, opc, nil
}

// requireCreateHex reads a mandatory hexadecimal field.
func requireCreateHex(raw map[string]any, key string, expectedLen int) (*string, error) {
	value, err := readCreateHex(raw, key, expectedLen)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, fmt.Errorf("auth4G.%s is required", key)
	}
	return value, nil
}

// readCreateHex reads a hexadecimal field that may be absent, canonicalizing it to uppercase.
// Returns (nil, nil) when the key is absent or null. Case is the only transformation applied -
// the hexadecimal content itself is never altered.
func readCreateHex(raw map[string]any, key string, expectedLen int) (*string, error) {
	v, ok := raw[key]
	if !ok || v == nil {
		return nil, nil
	}
	s, isString := v.(string)
	if !isString {
		return nil, fmt.Errorf("auth4G.%s must be a string of %d hexadecimal characters", key, expectedLen)
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}

	pattern := hex32Pattern
	if expectedLen == 4 {
		pattern = hex4Pattern
	}
	if !pattern.MatchString(s) {
		return nil, fmt.Errorf("auth4G.%s must be %d hexadecimal characters", key, expectedLen)
	}

	canonical := strings.ToUpper(s)
	return &canonical, nil
}

// requireCreateSQN reads the required SQN. Zero is a valid sequence number and must not be
// treated as absent, which is why this checks key presence rather than truthiness.
func requireCreateSQN(raw map[string]any) (int64, error) {
	v, ok := raw["sqn"]
	if !ok || v == nil {
		return 0, fmt.Errorf("auth4G.sqn is required")
	}
	n, isInteger := toInt64(v)
	if !isInteger || n < 0 || n > 9007199254740991 {
		return 0, fmt.Errorf("auth4G.sqn must be an integer between 0 and 9007199254740991")
	}
	return n, nil
}

// ApplyTo overwrites the authentication fields of a freshly built default subscriber document.
//
// Called between building the default document and the single InsertOne, so the subscriber never
// exists in a default-credential state that a later write has to correct.
//
// Only the five authentication fields are touched. Every other default - AMBR, slices, sessions,
// access restriction, network access mode, MME realm and host - is left exactly as built.
func (m *CreateAuthenticationMaterial) ApplyTo(doc bson.M) {
	if m == nil {
		return
	}
	security, ok := doc["security"].(bson.M)
	if !ok {
		security = bson.M{}
	}

	security["k"] = m.K
	// op and opc are written as explicit null rather than omitted, matching the shape the default
	// builder already produces and the read model expects.
	if m.OP != nil {
		security["op"] = *m.OP
		security["opc"] = nil
	} else {
		security["op"] = nil
		security["opc"] = *m.OPc
	}
	security["amf"] = m.AMF
	security["sqn"] = m.SQN

	doc["security"] = security
}

// AuthenticationMode reports which of OP / OPc the material carries, for non-secret audit
// metadata. It deliberately exposes the mode only, never a value.
func (m *CreateAuthenticationMaterial) AuthenticationMode() string {
	if m == nil {
		return ""
	}
	if m.OP != nil {
		return "op"
	}
	return "opc"
}
