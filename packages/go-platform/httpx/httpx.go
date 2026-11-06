// Package httpx holds HTTP plumbing shared by Go services: RFC 9457 problem documents, request
// ids, strict JSON bodies, bearer authentication and error mapping (MASTER_ORCHESTRATION_PROMPT
// §4.6, §4.11, §4.12).
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"atlas.dev/go-platform/auth"
	"atlas.dev/go-platform/pgtx"
)

type ctxKey int

const (
	keyRequestID ctxKey = iota
	keyPrincipal
)

var requestIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{8,128}$`)

// RequestID returns the request's id.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(keyRequestID).(string)
	return id
}

// Error is an application error with a stable code; Status picks the HTTP status.
type Error struct {
	Status     int
	Code       string
	Detail     string
	RetryAfter int
	Extensions map[string]any
}

func (e *Error) Error() string { return e.Code + ": " + e.Detail }

// Errorf builds an Error.
func Errorf(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Detail: fmt.Sprintf(format, args...)}
}

// Mapper converts a service's own error types (domain rule errors) to an Error; nil if unknown.
type Mapper func(error) *Error

var titles = map[int]string{
	400: "Bad request", 401: "Authentication required", 403: "Forbidden", 404: "Not found",
	409: "Conflict", 412: "Precondition failed", 413: "Payload too large", 422: "Unprocessable entity",
	428: "Precondition required", 429: "Too many requests", 500: "Internal error", 503: "Service unavailable",
}

// Problem writes an RFC 9457 document. No stack traces cross the wire.
func Problem(w http.ResponseWriter, r *http.Request, status int, code, detail string, ext map[string]any) {
	title := titles[status]
	if title == "" {
		title = http.StatusText(status)
	}
	body := map[string]any{
		"type":     "https://errors.atlas.dev/" + strings.ToLower(strings.ReplaceAll(code, "_", "-")),
		"title":    title,
		"status":   status,
		"detail":   detail,
		"instance": r.URL.Path,
		"code":     code,
	}
	if id := RequestID(r.Context()); id != "" {
		body["request_id"] = id
	}
	for k, v := range ext {
		body[k] = v
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// WriteJSON writes a JSON response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Fail maps err to a problem document; unknown errors are logged and become 500.
func Fail(w http.ResponseWriter, r *http.Request, log *slog.Logger, mapper Mapper, err error) {
	var e *Error
	if !errors.As(err, &e) && mapper != nil {
		e = mapper(err)
	}
	if e == nil && pgtx.IsCheckViolation(err) {
		e = &Error{Status: 422, Code: "CONSTRAINT_VIOLATION", Detail: "The request violates a data constraint."}
	}
	if e == nil {
		log.Error("request failed", "request_id", RequestID(r.Context()), "err", err)
		Problem(w, r, 500, "INTERNAL", "An unexpected error occurred.", nil)
		return
	}
	ext := map[string]any{}
	for k, v := range e.Extensions {
		ext[k] = v
	}
	if e.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(e.RetryAfter))
		ext["retry_after"] = e.RetryAfter
	}
	Problem(w, r, e.Status, e.Code, e.Detail, ext)
}

// BadRequest is a 400 VALIDATION_FAILED.
func BadRequest(format string, args ...any) *Error {
	return Errorf(400, "VALIDATION_FAILED", format, args...)
}

// DecodeBody parses one strict JSON object (unknown fields rejected) under a size limit.
func DecodeBody(w http.ResponseWriter, r *http.Request, limit int64, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return BadRequest("The request body is too large.")
		}
		return BadRequest("The request body is not valid JSON for this operation: %s", err.Error())
	}
	if dec.More() {
		return BadRequest("The request body must be one JSON object.")
	}
	return nil
}

// PathUUID reads a UUID path value or fails with 400.
func PathUUID(r *http.Request, name string) (string, error) {
	v := r.PathValue(name)
	if !pgtx.IsUUID(v) {
		return "", BadRequest("%s must be a UUID.", name)
	}
	return v, nil
}

// TenantParam reads the optional tenant_id query parameter.
func TenantParam(r *http.Request) (string, error) {
	t := r.URL.Query().Get("tenant_id")
	if t != "" && !pgtx.IsUUID(t) {
		return "", BadRequest("tenant_id must be a UUID.")
	}
	return t, nil
}

// TenantFor resolves the tenant: tenant users act on their own tenant; service and platform
// principals must name it (tenant identity never comes from a body).
func TenantFor(p auth.Principal, requested string) (string, error) {
	if p.TenantID != nil {
		if requested != "" && requested != *p.TenantID {
			return "", Errorf(403, "FORBIDDEN", "You cannot act on another tenant.")
		}
		return *p.TenantID, nil
	}
	if requested == "" {
		return "", Errorf(400, "TENANT_REQUIRED", "tenant_id is required for this caller.")
	}
	return requested, nil
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

// Flush lets streaming handlers flush through the recorder.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// RequestContext assigns (or keeps) x-request-id, recovers panics and logs every request.
func RequestContext(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("x-request-id")
		if !requestIDRe.MatchString(id) {
			id = newRequestID()
		}
		w.Header().Set("x-request-id", id)
		r = r.WithContext(context.WithValue(r.Context(), keyRequestID, id))
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		defer func() {
			if v := recover(); v != nil {
				log.Error("panic", "request_id", id, "panic", fmt.Sprint(v))
				Problem(rec, r, 500, "INTERNAL", "An unexpected error occurred.", nil)
			}
			log.Info("request", "request_id", id, "method", r.Method, "path", r.URL.Path, "status", rec.status, "ms", time.Since(start).Milliseconds())
		}()
		next.ServeHTTP(rec, r)
	})
}

func newRequestID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = (b[6]&0x0f)|0x40, (b[8]&0x3f)|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// Handler is an authenticated handler; returned errors become problem documents.
type Handler func(w http.ResponseWriter, r *http.Request, p auth.Principal) error

// Bearer wraps h with bearer-token authentication (deny by default).
func Bearer(v auth.Verifier, log *slog.Logger, mapper Mapper, h Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" {
			Problem(w, r, 401, "UNAUTHENTICATED", "A valid bearer token is required.", nil)
			return
		}
		p, err := v.Verify(r.Context(), strings.TrimSpace(token))
		if err != nil {
			Problem(w, r, 401, "UNAUTHENTICATED", "The bearer token is invalid or expired.", nil)
			return
		}
		if err := h(w, r.WithContext(context.WithValue(r.Context(), keyPrincipal, p)), p); err != nil {
			Fail(w, r, log, mapper, err)
		}
	})
}

// Public wraps an unauthenticated handler (health probes, token-in-path flows).
func Public(log *slog.Logger, mapper Mapper, h func(w http.ResponseWriter, r *http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			Fail(w, r, log, mapper, err)
		}
	})
}
