package runtimeinv

import (
	"strings"
)

// approvedJavaTokens is the reviewed, server-owned launch identity vocabulary
// for the IMS HSS java component. These tokens come from the CNMS reference
// implementation (HSSContainer, imsHss, FHoSS) and are treated as a
// compatibility hint that must be combined with executable verification and a
// launch-position check.
var approvedJavaTokens = []string{"HSSContainer", "imsHss", "FHoSS"}

// javaMatch is the outcome of the bounded command-line identity check.
type javaMatch struct {
	// Matched reports that an approved token was found anywhere in the bounded
	// command-line projection.
	Matched bool
	// Verified reports that the token occupies a launch-identity position.
	Verified bool
	// Token is the approved token that matched. The raw command line is never
	// retained, persisted or returned.
	Token string
	// Reason explains an unverified outcome.
	Reason string
}

// matchJavaLaunchIdentity evaluates a bounded argv projection.
//
// Rules (documented compatibility contract):
//   - argv[0] is the executable and is ignored.
//   - An argument that starts with "-" is a JVM option, never a launch
//     identity. A token that appears only inside options (for example
//     "-Dnote=FHoSS") is ambiguous and stays unverified.
//   - A positional argument is a launch identity (main class, jar path or
//     classpath entry). A token that appears as a whole path/class segment of a
//     positional argument verifies the component.
//   - The argument following "-jar" is always a launch identity.
//
// Whole-segment matching prevents "HSSContainerManagerHelper" or
// "FHoSS-test-notes" from being accepted as an IMS HSS launch identity.
func matchJavaLaunchIdentity(argv []string) javaMatch {
	if len(argv) <= 1 {
		return javaMatch{Reason: ReasonCommandUnreadable}
	}
	matchedToken := ""
	verifiedToken := ""
	for index := 1; index < len(argv); index++ {
		arg := argv[index]
		token, ok := approvedTokenInArgument(arg)
		if !ok {
			continue
		}
		if matchedToken == "" {
			matchedToken = token
		}
		launchPosition := !strings.HasPrefix(arg, "-")
		if index > 1 && argv[index-1] == "-jar" {
			launchPosition = true
		}
		if launchPosition {
			verifiedToken = token
			break
		}
	}
	if verifiedToken != "" {
		return javaMatch{Matched: true, Verified: true, Token: verifiedToken}
	}
	if matchedToken != "" {
		return javaMatch{Matched: true, Verified: false, Token: matchedToken, Reason: ReasonTokenNotLaunchIdentity}
	}
	return javaMatch{Reason: ReasonLaunchIdentityAbsent}
}

// approvedTokenInArgument reports whether an argument carries an approved token
// as a whole path, class or archive segment.
func approvedTokenInArgument(arg string) (string, bool) {
	if arg == "" {
		return "", false
	}
	segments := strings.FieldsFunc(arg, func(r rune) bool {
		switch r {
		case '/', '\\', '.', ':', '!', '=', ',', ';':
			return true
		default:
			return false
		}
	})
	for _, segment := range segments {
		trimmed := strings.TrimSpace(segment)
		if trimmed == "" {
			continue
		}
		for _, token := range approvedJavaTokens {
			if strings.EqualFold(trimmed, token) {
				return token, true
			}
		}
	}
	return "", false
}

// ApprovedJavaTokens returns the reviewed launch identity vocabulary. The list
// is server-owned and read-only for callers.
func ApprovedJavaTokens() []string {
	out := make([]string, len(approvedJavaTokens))
	copy(out, approvedJavaTokens)
	return out
}
