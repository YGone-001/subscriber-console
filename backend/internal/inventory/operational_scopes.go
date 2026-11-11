package inventory

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const OperationalScopesAttribute = "xcloudOperationalScopes"

type OperationalScope struct {
	NetworkKey   string   `json:"networkKey" bson:"networkKey"`
	OperatorName string   `json:"operatorName" bson:"operatorName"`
	PLMNs        []string `json:"plmns" bson:"plmns"`
}

var NetworkKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
var PLMNPattern = regexp.MustCompile(`^[0-9]{5,6}$`)

func OperationalScopeKindSupported(kind string) bool {
	return kind == KindSite || kind == KindHost || kind == KindNetworkFunction || kind == KindNetworkFunctionInstance
}

func OperationalScopesForResource(r Resource) ([]OperationalScope, error) {
	if _, present := r.Attributes[OperationalScopesAttribute]; present && !OperationalScopeKindSupported(r.Kind) {
		return nil, fmt.Errorf("unsupported operational scope kind")
	}
	return OperationalScopes(r.Attributes)
}

// Decode the owned attribute branch into its JSON DTO. Other attributes retain
// their existing BSON representation and are never interpreted by this feature.
func (r *Resource) UnmarshalBSON(data []byte) error {
	type plain Resource
	var decoded plain
	if err := bson.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*r = Resource(decoded)
	if _, present := r.Attributes[OperationalScopesAttribute]; present {
		if scopes, err := OperationalScopes(r.Attributes); err == nil {
			r.Attributes[OperationalScopesAttribute] = scopes
		}
	}
	return nil
}

func canonicalScopeBytes(value any) []byte {
	raw, err := json.Marshal(scopeValue(value))
	if err != nil {
		return nil
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil {
		return nil
	}
	canonical, _ := json.Marshal(decoded)
	return canonical
}

func scopeValue(v any) any {
	switch x := v.(type) {
	case bson.D:
		out := map[string]any{}
		for _, e := range x {
			out[e.Key] = scopeValue(e.Value)
		}
		return out
	case bson.M:
		out := map[string]any{}
		for k, v := range x {
			out[k] = scopeValue(v)
		}
		return out
	case bson.A:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = scopeValue(v)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = scopeValue(v)
		}
		return out
	default:
		return v
	}
}

// OperationalScopes is a positive projection. Malformed declarations never
// establish membership and remain distinguishable from an absent declaration.
func OperationalScopes(attrs map[string]any) ([]OperationalScope, error) {
	v, present := attrs[OperationalScopesAttribute]
	if !present {
		return []OperationalScope{}, nil
	}
	raw, err := json.Marshal(scopeValue(v))
	if err != nil {
		return nil, fmt.Errorf("invalid operational scopes")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	var out []OperationalScope
	if err = d.Decode(&out); err != nil || out == nil || len(out) > 8 {
		return nil, fmt.Errorf("operational scopes must be an array of at most eight declarations")
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("invalid operational scopes")
	}
	seen := map[string]bool{}
	for i := range out {
		s := &out[i]
		s.OperatorName = strings.TrimSpace(s.OperatorName)
		if !NetworkKeyPattern.MatchString(s.NetworkKey) || seen[s.NetworkKey] {
			return nil, fmt.Errorf("network keys must be valid and unique within a resource")
		}
		seen[s.NetworkKey] = true
		if !utf8.ValidString(s.OperatorName) || utf8.RuneCountInString(s.OperatorName) > 128 || strings.IndexFunc(s.OperatorName, unicode.IsControl) >= 0 {
			return nil, fmt.Errorf("invalid operator name")
		}
		if len(s.PLMNs) > 16 {
			return nil, fmt.Errorf("at most sixteen PLMNs may be declared")
		}
		plmns := map[string]bool{}
		for _, p := range s.PLMNs {
			if !PLMNPattern.MatchString(p) || plmns[p] {
				return nil, fmt.Errorf("invalid or duplicate PLMN")
			}
			plmns[p] = true
		}
		if s.PLMNs == nil {
			s.PLMNs = []string{}
		}
	}
	return out, nil
}

// ValidateOperationalScopeChange preserves unchanged legacy attributes. A new
// or changed reserved branch is validated without rewriting unrelated metadata.
func ValidateOperationalScopeChange(kind string, before, after map[string]any) error {
	a, ap := after[OperationalScopesAttribute]
	b, bp := before[OperationalScopesAttribute]
	x := canonicalScopeBytes(a)
	y := canonicalScopeBytes(b)
	if ap == bp && bytes.Equal(x, y) {
		return nil
	}
	if !ap {
		return nil
	}
	if !OperationalScopeKindSupported(kind) {
		return fmt.Errorf("operational scopes are supported only for sites, hosts and network functions")
	}
	_, err := OperationalScopes(after)
	return err
}

func PrepareOperationalScopeChange(kind string, before, after map[string]any) (map[string]any, error) {
	if err := ValidateOperationalScopeChange(kind, before, after); err != nil {
		return nil, err
	}
	a, ap := after[OperationalScopesAttribute]
	b, bp := before[OperationalScopesAttribute]
	if !ap || ap == bp && bytes.Equal(canonicalScopeBytes(a), canonicalScopeBytes(b)) {
		return after, nil
	}
	scopes, err := OperationalScopes(after)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	for key, value := range after {
		out[key] = value
	}
	out[OperationalScopesAttribute] = scopes
	return out, nil
}
