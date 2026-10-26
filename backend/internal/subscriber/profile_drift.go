package subscriber

import (
	"go.mongodb.org/mongo-driver/v2/bson"
)

// Drift states for the template probe. They describe how a subscriber's stored
// provisioning stands against a template, never a health claim.
const (
	DriftInSync  = "in_sync"
	DriftChanged = "changed"
)

// ProfileDrift compares one subscriber document with the document a template
// apply would produce. It uses the same projection as the governed apply, so the
// probe cannot disagree with what an apply would actually do. It writes nothing.
//
// Embedded `_id` values are excluded: the slice conversion mints fresh ObjectIds
// on every write, so comparing them would report permanent drift on a subscriber
// whose provisioning content already matches the template. That churn is a defect
// of the apply path itself, not a fact the operator can act on here.
func ProfileDrift(current bson.M, profile bson.M, profileName string) (string, []string) {
	effective := BuildSubscriberAfterProfileApply(current, profile, profileName)

	var changed []string
	if securityMaterialChanged(current, effective) {
		changed = append(changed, "security")
	}
	for _, field := range []string{"ambr", "slice", "access_restriction_data"} {
		if stableJSON(provisioningComparable(current[field])) != stableJSON(provisioningComparable(effective[field])) {
			changed = append(changed, field)
		}
	}
	if getProfileName(current) != profileName {
		changed = append(changed, "profile_name")
	}
	if len(changed) == 0 {
		return DriftInSync, nil
	}
	return DriftChanged, changed
}

// provisioningComparable deep-copies a provisioning value without the embedded
// document identifiers, preserving every other field and type distinction.
func provisioningComparable(value any) any {
	switch typed := value.(type) {
	case bson.M:
		out := make(bson.M, len(typed))
		for key, item := range typed {
			if key == "_id" {
				continue
			}
			out[key] = provisioningComparable(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if key == "_id" {
				continue
			}
			out[key] = provisioningComparable(item)
		}
		return out
	case bson.D:
		out := make(bson.D, 0, len(typed))
		for _, elem := range typed {
			if elem.Key == "_id" {
				continue
			}
			out = append(out, bson.E{Key: elem.Key, Value: provisioningComparable(elem.Value)})
		}
		return out
	case bson.A:
		out := make(bson.A, 0, len(typed))
		for _, item := range typed {
			out = append(out, provisioningComparable(item))
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, provisioningComparable(item))
		}
		return out
	default:
		return value
	}
}
