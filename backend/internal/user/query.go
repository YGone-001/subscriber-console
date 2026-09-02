package user

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// allowedUserQueryKeys are the only permitted query parameter keys.
var allowedUserQueryKeys = map[string]bool{
	"page": true, "pageSize": true, "search": true, "q": true,
	"role": true, "status": true, "sort": true, "order": true,
}

// allowedRoles includes both legacy and normalized governance roles.
var allowedRoles = map[string]bool{
	"root": true, "super_admin": true, "ops_admin": true,
	"operator": true, "auditor": true, "viewer": true,
}

// allowedStatuses are the only valid status filter values.
var allowedStatuses = map[string]bool{
	"active": true, "disabled": true, "locked": true,
}

// userSortFieldMap maps API sort names to MongoDB field names.
var userSortFieldMap = map[string]string{
	"username": "username", "displayName": "displayName", "role": "role",
	"status": "status", "createdAt": "createdAt", "lastLoginAt": "security.lastLoginAt",
}

// escapeUserSearch escapes special regex characters in user search input.
// Matches Node escapeUserSearch() exactly: value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
func escapeUserSearch(value string) string {
	var result []rune
	for _, c := range value {
		switch c {
		case '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			result = append(result, '\\', c)
		default:
			result = append(result, c)
		}
	}
	return string(result)
}

// parseUserQueryStrict validates and parses query parameters, returning an error for any invalid input.
// Matches Node parseUserQuery() exactly — rejects unknown keys, duplicates, out-of-range values.
func parseUserQueryStrict(params map[string][]string) (UserQuery, error) {
	// Check for unknown keys and duplicate values
	for key, vals := range params {
		if !allowedUserQueryKeys[key] {
			return UserQuery{}, fmt.Errorf("INVALID_QUERY")
		}
		if len(vals) != 1 {
			return UserQuery{}, fmt.Errorf("INVALID_QUERY")
		}
	}

	get := func(key string) string {
		if vals, ok := params[key]; ok && len(vals) == 1 {
			return vals[0]
		}
		return ""
	}

	// Parse page
	page := 1
	if raw := get("page"); raw != "" {
		if !regexp.MustCompile(`^[1-9]\d*$`).MatchString(raw) {
			return UserQuery{}, fmt.Errorf("INVALID_QUERY")
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n > 100000 {
			return UserQuery{}, fmt.Errorf("INVALID_QUERY")
		}
		page = n
	}

	// Parse pageSize
	pageSize := 20
	if raw := get("pageSize"); raw != "" {
		if !regexp.MustCompile(`^[1-9]\d*$`).MatchString(raw) {
			return UserQuery{}, fmt.Errorf("INVALID_QUERY")
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			return UserQuery{}, fmt.Errorf("INVALID_QUERY")
		}
		pageSize = n
	}

	// Parse role
	role := get("role")
	if role != "" && !allowedRoles[role] {
		return UserQuery{}, fmt.Errorf("INVALID_QUERY")
	}

	// Parse status
	status := get("status")
	if status != "" && !allowedStatuses[status] {
		return UserQuery{}, fmt.Errorf("INVALID_QUERY")
	}

	// Parse sort
	sort := get("sort")
	if sort == "" {
		sort = "createdAt"
	}
	if _, ok := userSortFieldMap[sort]; !ok {
		return UserQuery{}, fmt.Errorf("INVALID_QUERY")
	}

	// Parse order — case-sensitive, only "asc" or "desc"
	order := get("order")
	if order == "" {
		order = "desc"
	}
	if order != "asc" && order != "desc" {
		return UserQuery{}, fmt.Errorf("INVALID_QUERY")
	}

	// Parse search — search takes precedence over q
	search := strings.TrimSpace(get("search"))
	if search == "" {
		search = strings.TrimSpace(get("q"))
	}
	if len(search) > 100 {
		return UserQuery{}, fmt.Errorf("INVALID_QUERY")
	}

	return UserQuery{
		Page:     page,
		PageSize: pageSize,
		Role:     role,
		Status:   status,
		Sort:     sort,
		Order:    order,
		Search:   search,
	}, nil
}
