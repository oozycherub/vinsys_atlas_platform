// Package httpapi exposes the judge API over HTTP (openapi.yaml).
package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"atlas.dev/go-platform/auth"
	"atlas.dev/go-platform/httpx"
	"atlas.dev/go-platform/pgtx"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

// Body limits: 1 MB by default; bundles carry up to 32 MB of test cases (contract).
const (
	DefaultBodyLimit = 1 << 20
	BundleBodyLimit  = 40 << 20
)

// Server wires routes to the API.
type Server struct {
	API      *app.API
	Verifier auth.Verifier
	Log      *slog.Logger
}

// Handler returns the HTTP handler with middleware.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", s.ready)
	route := func(pattern string, h httpx.Handler) {
		mux.Handle(pattern, httpx.Bearer(s.Verifier, s.Log, mapError, h))
	}
	route("GET /v1/sandbox/languages", s.languages)
	route("PUT /v1/test-case-bundles/{questionId}/versions/{version}", s.putBundle)
	route("GET /v1/test-case-bundles/{questionId}/versions/{version}", s.getBundle)
	route("POST /v1/sessions/{sessionId}/questions/{questionId}/runs", s.createRun)
	route("GET /v1/runs/{runId}", s.getRun)
	route("POST /v1/sessions/{sessionId}/questions/{questionId}/submissions", s.createSubmission)
	route("GET /v1/submissions/{submissionId}", s.getSubmission)
	return httpx.RequestContext(s.Log, mux)
}

var kindStatus = map[string]int{
	"rule": 422, "conflict": 409, "not_found": 404, "throttled": 429, "forbidden": 403,
	"bad_request": 400, "precondition_required": 428,
}

// mapError turns domain rule errors into problem documents.
func mapError(err error) *httpx.Error {
	var rule *domain.RuleError
	if !errors.As(err, &rule) {
		return nil
	}
	kind := rule.Kind
	if kind == "" {
		kind = "rule"
	}
	return &httpx.Error{Status: kindStatus[kind], Code: rule.Code, Detail: rule.Message, RetryAfter: rule.RetryAfterSec, Extensions: rule.Extensions}
}

func writeJSON(w http.ResponseWriter, status int, v any) { httpx.WriteJSON(w, status, v) }

func decodeBody(w http.ResponseWriter, r *http.Request, limit int64, v any) error {
	return httpx.DecodeBody(w, r, limit, v)
}

func badRequest(msg string) error { return httpx.BadRequest("%s", msg) }

func pathUUID(r *http.Request, name string) (string, error) { return httpx.PathUUID(r, name) }

func tenantParam(r *http.Request) (string, error) { return httpx.TenantParam(r) }

func isUUID(s string) bool { return pgtx.IsUUID(s) }

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.API.Ready(ctx); err != nil {
		httpx.Problem(w, r, 503, "NOT_READY", "The database is not reachable.", nil)
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"status": "ready"})
}
