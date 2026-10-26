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
func ProfileDrift(current bson.M, profile bson.M, profileName string) (string, []string) {
	effective := BuildSubscriberAfterProfileApply(current, profile, profileName)

	var changed []string
	if securityMaterialChanged(current, effective) {
		changed = append(changed, "security")
	}
	for _, field := range []string{"ambr", "slice", "access_restriction_data"} {
		if stableJSON(current[field]) != stableJSON(effective[field]) {
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
