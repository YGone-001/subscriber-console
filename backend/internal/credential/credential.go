// Package credential defines how stored authentication material is described to
// readers who may not see it.
//
// A projection never substitutes a placeholder value for withheld material: a
// string that looks like a key can be displayed as one, compared as one, stored
// as one, and copied into a subscriber by a governed apply. The material keys
// are removed instead, and the reader is told, per field, whether the field
// carries material. Presence and confidentiality therefore stay separate facts.
package credential

// Visibility values reported to the client.
const (
	VisibilityPlaintext = "plaintext"
	VisibilityMasked    = "masked"
)

// Per-field states. A field is either carrying material that the reader may or
// may not see, or it is not carrying material at all.
const (
	FieldConfigured    = "configured"
	FieldNotConfigured = "not_configured"
)

// Key is one authentication field whose material is governed by visibility.
type Key string

// Keys names the permanent credential material. AMF and sequence numbers are
// not secret key material and are never withheld.
var Keys = []Key{"k", "op", "opc"}

// State reports what the reader can infer about the credential block without
// seeing any of it.
type State struct {
	Visibility string `json:"visibility"`
	K          string `json:"k"`
	Op         string `json:"op"`
	Opc        string `json:"opc"`
}

// StateKey names the projected state field inside a credential block. It is a
// response field, never a stored one.
const StateKey = "credentialState"

// IsMaterial reports whether a field of a credential block holds permanent key
// material, as opposed to a non-secret parameter such as AMF or a sequence
// number.
func IsMaterial(key string) bool {
	for _, candidate := range Keys {
		if string(candidate) == key {
			return true
		}
	}
	return false
}

// Configured reports whether a stored value carries material. An empty value
// and an all-zero fill are both "not configured": a zero-filled field is a
// placeholder the writer never provisioned, not a secret.
func Configured(value any) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	if text == "" {
		return false
	}
	allZero := true
	for _, char := range text {
		if char != '0' {
			allZero = false
			break
		}
	}
	return !allZero
}

// Describe builds the state of a credential block from its values. It reads
// only presence, so it is safe to call for every reader.
func Describe(material map[string]any, visibility string) State {
	state := State{Visibility: visibility}
	for _, key := range Keys {
		field := FieldNotConfigured
		if Configured(material[string(key)]) {
			field = FieldConfigured
		}
		switch key {
		case "k":
			state.K = field
		case "op":
			state.Op = field
		case "opc":
			state.Opc = field
		}
	}
	return state
}
