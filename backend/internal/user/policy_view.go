package user

import (
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
)

// assignableRoles returns roles that the actor can assign to others.
// Matches Node assignableRoles() exactly.
func assignableRoles(actorRole string) []string {
	// Check if actor has users.create or users.role.change
	p := &auth.Principal{NormalizedRole: actorRole}
	if !auth.HasPermission(p, "users.create") && !auth.HasPermission(p, "users.role.change") {
		return nil
	}
	switch actorRole {
	case "super_admin":
		return []string{"root", "ops_admin", "operator", "auditor", "viewer"}
	case "ops_admin":
		return []string{"operator", "auditor", "viewer"}
	default:
		return nil
	}
}

// userOperation represents a management operation on a user.
type userOperation string

const (
	opUpdate        userOperation = "update"
	opRoleChange    userOperation = "role.change"
	opDisable       userOperation = "disable"
	opDelete        userOperation = "delete"
	opEnable        userOperation = "enable"
	opLock          userOperation = "lock"
	opUnlock        userOperation = "unlock"
	opPasswordReset userOperation = "password.reset"
)

// operationPermission maps operations to their required permission.
// Matches Node USER_OPERATION_PERMISSIONS exactly.
var operationPermission = map[userOperation]string{
	opUpdate:        "users.update",
	opRoleChange:    "users.role.change",
	opDisable:       "users.disable",
	opDelete:        "users.delete",
	opEnable:        "users.disable",
	opLock:          "users.disable",
	opUnlock:        "users.unlock",
	opPasswordReset: "users.reset-password",
}

// userManagementActions returns the operations the actor can perform on the target.
// Matches Node userManagementActions() exactly: filters operations by checkUserManagementPolicy,
// excluding "create" and "delete".
func userManagementActions(actorRole, targetRole, actorUsername, targetUsername string) []string {
	operations := []userOperation{
		opUpdate, opRoleChange, opDisable, opEnable, opLock, opUnlock, opPasswordReset,
	}

	var actions []string
	for _, op := range operations {
		if canPerformOperation(actorRole, targetRole, actorUsername, targetUsername, op) {
			actions = append(actions, string(op))
		}
	}
	return actions
}

// canPerformOperation checks if an actor can perform an operation on a target.
// Matches Node checkUserManagementPolicy() exactly.
func canPerformOperation(actorRole, targetRole, actorUsername, targetUsername string, op userOperation) bool {
	// Check permission
	perm, ok := operationPermission[op]
	if !ok {
		return false
	}
	p := &auth.Principal{NormalizedRole: actorRole}
	if !auth.HasPermission(p, perm) {
		return false
	}

	// Self-protection rules (only when target exists)
	if actorUsername == targetUsername && targetUsername != "" {
		if op == opDisable || op == opLock {
			return false
		}
		if op == opDelete {
			return false
		}
		if op == opRoleChange {
			return false
		}
	}

	// Target role protection
	if targetRole != "" {
		if actorRole != "super_admin" && (targetRole == "super_admin" || targetRole == "ops_admin") {
			return false
		}
	}

	// For role.change, check that a valid target role would be assignable
	if op == opRoleChange {
		// We check with "viewer" as a representative target role (Node does this)
		assignable := assignableRoles(actorRole)
		hasAssignable := false
		for _, r := range assignable {
			if auth.NormalizeRole(r) != "" {
				hasAssignable = true
				break
			}
		}
		if !hasAssignable {
			return false
		}
	}

	return true
}
