package auth

import "testing"

// TestHasPermissionAuditRead verifies audit.read permission matches Node ROLE_PERMISSIONS.
func TestHasPermissionAuditRead(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{"super_admin", true},
		{"ops_admin", true},
		{"operator", true},
		{"auditor", true},
		{"viewer", true},
		{"unknown", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		got := HasPermission(p, "audit.read")
		if got != tt.want {
			t.Errorf("HasPermission(%q, audit.read) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

// TestHasPermissionAuditSourceIP verifies audit.source-ip.read-full permission.
func TestHasPermissionAuditSourceIP(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{"super_admin", true},
		{"ops_admin", false}, // ops_admin does NOT have audit.source-ip.read-full
		{"operator", false},
		{"auditor", true},
		{"viewer", false},
		{"unknown", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		got := HasPermission(p, "audit.source-ip.read-full")
		if got != tt.want {
			t.Errorf("HasPermission(%q, audit.source-ip.read-full) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

// TestHasPermissionUsersRead verifies users.read permission.
func TestHasPermissionUsersRead(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{"super_admin", true},
		{"ops_admin", true},
		{"operator", false}, // operator does NOT have users.read
		{"auditor", true},
		{"viewer", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		got := HasPermission(p, "users.read")
		if got != tt.want {
			t.Errorf("HasPermission(%q, users.read) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

// TestHasPermissionNilPrincipal verifies nil principal returns false.
func TestHasPermissionNilPrincipal(t *testing.T) {
	if HasPermission(nil, "audit.read") {
		t.Error("HasPermission(nil, audit.read) should be false")
	}
}

// TestHasPermissionUnknownPermission verifies unknown permission returns false.
func TestHasPermissionUnknownPermission(t *testing.T) {
	p := &Principal{NormalizedRole: "super_admin"}
	if HasPermission(p, "nonexistent.permission") {
		t.Error("HasPermission(super_admin, nonexistent.permission) should be false")
	}
}

// TestPermissionsFor verifies permissionsFor returns correct permissions per role.
func TestPermissionsFor(t *testing.T) {
	tests := []struct {
		role     string
		wantPerm string
		wantNot  string
	}{
		{"super_admin", "audit.source-ip.read-full", ""},
		{"ops_admin", "audit.read", "audit.source-ip.read-full"},
		{"operator", "subscribers.write", "users.read"},
		{"auditor", "audit.source-ip.read-full", "subscribers.write"},
		{"viewer", "audit.read", "audit.export"},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		perms := PermissionsFor(p)
		permSet := make(map[string]bool)
		for _, perm := range perms {
			permSet[perm] = true
		}
		if !permSet[tt.wantPerm] {
			t.Errorf("PermissionsFor(%q) missing %q", tt.role, tt.wantPerm)
		}
		if tt.wantNot != "" && permSet[tt.wantNot] {
			t.Errorf("PermissionsFor(%q) should not include %q", tt.role, tt.wantNot)
		}
	}
}

// TestPermissionsForNilPrincipal verifies nil principal returns nil.
func TestPermissionsForNilPrincipal(t *testing.T) {
	if PermissionsFor(nil) != nil {
		t.Error("PermissionsFor(nil) should return nil")
	}
}
