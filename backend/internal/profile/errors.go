package profile

import "errors"

var (
	// ErrProfileExists indicates a profile with the same name already exists.
	ErrProfileExists = errors.New("PROFILE_EXISTS")

	// ErrProfilePreconditionChanged indicates the profile was modified since loaded.
	ErrProfilePreconditionChanged = errors.New("PROFILE_PRECONDITION_CHANGED")

	// ErrProfileInUse indicates the profile is in use by subscribers and cannot be deleted.
	ErrProfileInUse = errors.New("PROFILE_IN_USE")
)
