package approval

import "net/http"

// ApprovalWorkflowError represents an approval workflow error with
// structured code, HTTP status, and optional committed flag.
// Matches Node ApprovalWorkflowError exactly.
type ApprovalWorkflowError struct {
	Code      string            `json:"code"`
	Status    int               `json:"-"`
	Approval  *ApprovalDocument `json:"approval,omitempty"`
	Committed bool              `json:"committed,omitempty"`
}

func (e *ApprovalWorkflowError) Error() string {
	return e.Code
}

// ErrorResponse returns the JSON-serializable error body.
// Matches Node workflowErrorResponse() shape.
func (e *ApprovalWorkflowError) ErrorResponse() map[string]interface{} {
	resp := map[string]interface{}{
		"error": e.Code,
		"code":  e.Code,
	}
	if e.Approval != nil {
		resp["approval"] = e.Approval
	}
	if e.Committed {
		resp["committed"] = true
	}
	return resp
}

// WorkflowErrorResponse converts any error into a workflow error response.
// Matches Node workflowErrorResponse() exactly.
func WorkflowErrorResponse(err error) (int, map[string]interface{}) {
	if awe, ok := err.(*ApprovalWorkflowError); ok {
		return awe.Status, awe.ErrorResponse()
	}
	code := "APPROVAL_OPERATION_FAILED"
	status := http.StatusInternalServerError
	if err != nil && len(err.Error()) > 8 && err.Error()[:8] == "ACCOUNT_" {
		code = err.Error()
		status = http.StatusUnauthorized
	}
	return status, map[string]interface{}{
		"error": code,
		"code":  code,
	}
}
