package domain

// RuleError is a domain rule violation with a stable code (MASTER_ORCHESTRATION_PROMPT §4.6).
// The HTTP layer maps Kind to a status; Kind defaults to "rule" (422).
type RuleError struct {
	Code    string
	Message string
	Kind    string // rule | conflict | not_found | throttled | forbidden
	// RetryAfterSec is set for throttled errors (429 Retry-After).
	RetryAfterSec int
	// Extensions are extra problem+json members.
	Extensions map[string]any
}

func (e *RuleError) Error() string { return e.Code + ": " + e.Message }

// NotFound builds a not_found RuleError.
func NotFound(code, message string) *RuleError {
	return &RuleError{Code: code, Message: message, Kind: "not_found"}
}

// Conflict builds a conflict RuleError (409).
func Conflict(code, message string) *RuleError {
	return &RuleError{Code: code, Message: message, Kind: "conflict"}
}
