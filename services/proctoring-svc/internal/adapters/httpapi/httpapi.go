// Package httpapi exposes proctoring-svc over HTTP (openapi.yaml).
package httpapi

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"atlas.dev/go-platform/auth"
	"atlas.dev/go-platform/httpx"
	"atlas.dev/go-platform/pgtx"

	"atlas.dev/proctoring-svc/internal/app"
	"atlas.dev/proctoring-svc/internal/domain"
)

// Body limits (decompressed): event batches 1 MB, inference results 64 KB.
const (
	EventsLimit    = 1 << 20
	InferenceLimit = 64 << 10
	SmallLimit     = 16 << 10
)

// Server wires routes.
type Server struct {
	S        *app.Service
	Verifier auth.Verifier
	Log      *slog.Logger
}

var kindStatus = map[string]int{
	"rule": 422, "conflict": 409, "not_found": 404, "forbidden": 403, "unauthenticated": 401,
	"bad_request": 400, "throttled": 429,
}

func mapError(err error) *httpx.Error {
	var rule *domain.RuleError
	switch {
	case errors.As(err, &rule):
		kind := rule.Kind
		if kind == "" {
			kind = "rule"
		}
		return &httpx.Error{Status: kindStatus[kind], Code: rule.Code, Detail: rule.Message}
	case errors.Is(err, app.ErrNotFound):
		return &httpx.Error{Status: 404, Code: "NOT_FOUND", Detail: "Not found."}
	case errors.Is(err, app.ErrConflict):
		return &httpx.Error{Status: 409, Code: "CONCURRENT_UPDATE", Detail: "The session changed; retry."}
	}
	return nil
}

// Handler returns the routes with middleware.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.S.Store.Ping(ctx); err != nil {
			httpx.Problem(w, r, 503, "NOT_READY", "The database is not reachable.", nil)
			return
		}
		httpx.WriteJSON(w, 200, map[string]string{"status": "ready"})
	})
	bearer := func(h httpx.Handler) http.Handler { return httpx.Bearer(s.Verifier, s.Log, mapError, h) }
	public := func(h func(http.ResponseWriter, *http.Request) error) http.Handler {
		return httpx.Public(s.Log, mapError, h)
	}
	// assessment-svc (service token)
	mux.Handle("PUT /v1/proctoring/sessions/{sessionId}", bearer(s.start))
	// candidate client (proctor token)
	mux.Handle("POST /v1/proctoring/sessions/{sessionId}/events", public(s.events))
	mux.Handle("POST /v1/proctoring/sessions/{sessionId}/frames:initiateUpload", public(s.initiateUpload))
	// cv-inference (service token)
	mux.Handle("POST /v1/proctoring/frames/{frameAction}", bearer(s.inference))
	// staff
	mux.Handle("GET /v1/proctoring/sessions/{sessionId}/timeline", bearer(s.timeline))
	mux.Handle("POST /v1/proctoring/flags/{flagAction}", bearer(s.review))
	mux.Handle("PUT /v1/proctoring/sessions/{sessionId}/accommodations", bearer(s.accommodate))
	return httpx.RequestContext(s.Log, mux)
}

type startBody struct {
	AssessmentID   string         `json:"assessment_id"`
	CandidateID    string         `json:"candidate_id"`
	Rules          *domain.Rules  `json:"rules"`
	Consent        map[string]any `json:"consent"`
	IDVerification bool           `json:"id_verification"`
}

func (s *Server) start(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	sid, err := httpx.PathUUID(r, "sessionId")
	if err != nil {
		return err
	}
	tenant, err := httpx.TenantParam(r)
	if err != nil {
		return err
	}
	if tenant, err = httpx.TenantFor(p, tenant); err != nil {
		return err
	}
	var b startBody
	if err := httpx.DecodeBody(w, r, SmallLimit, &b); err != nil {
		return err
	}
	if !pgtx.IsUUID(b.AssessmentID) || !pgtx.IsUUID(b.CandidateID) || b.Consent == nil {
		return httpx.BadRequest("assessment_id, candidate_id and consent are required.")
	}
	res, err := s.S.Start(r.Context(), p, tenant, sid, app.StartInput{AssessmentID: b.AssessmentID, CandidateID: b.CandidateID,
		Rules: b.Rules, Consent: b.Consent, IDVerification: b.IDVerification})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, res)
	return nil
}

// candidate authenticates the proctor token and returns (tenant, session).
func (s *Server) candidate(r *http.Request) (string, string, error) {
	sid, err := httpx.PathUUID(r, "sessionId")
	if err != nil {
		return "", "", err
	}
	tenant, err := s.S.Authenticate(r.Context(), sid, r.Header.Get("Authorization"))
	return tenant, sid, err
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) error {
	tenant, sid, err := s.candidate(r)
	if err != nil {
		return err
	}
	var body io.Reader = http.MaxBytesReader(w, r.Body, EventsLimit)
	if strings.EqualFold(r.Header.Get("Content-Encoding"), "gzip") {
		gz, err := gzip.NewReader(body)
		if err != nil {
			return httpx.BadRequest("The body is not valid gzip.")
		}
		defer gz.Close()
		body = io.LimitReader(gz, 2*EventsLimit+1) // zip-bomb guard
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return httpx.BadRequest("The request body is too large.")
	}
	if len(data) > 2*EventsLimit {
		return httpx.BadRequest("The decompressed body is too large.")
	}
	var b struct {
		SentAt float64           `json:"sent_at"`
		Events []json.RawMessage `json:"events"`
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return httpx.BadRequest("The body must be {sent_at, events}.")
	}
	res, err := s.S.Ingest(r.Context(), tenant, sid, app.Batch{SentAt: b.SentAt, Events: b.Events})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, res)
	return nil
}

func (s *Server) initiateUpload(w http.ResponseWriter, r *http.Request) error {
	tenant, sid, err := s.candidate(r)
	if err != nil {
		return err
	}
	var b struct {
		Kind        string `json:"kind"`
		ContentType string `json:"content_type"`
		Triggered   bool   `json:"triggered"`
	}
	if err := httpx.DecodeBody(w, r, SmallLimit, &b); err != nil {
		return err
	}
	id, up, err := s.S.InitiateUpload(r.Context(), tenant, sid, app.UploadInput{Kind: b.Kind, ContentType: b.ContentType, Triggered: b.Triggered})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 201, map[string]any{"frame_id": id, "upload": up})
	return nil
}

// action splits "{id}:{verb}".
func action(r *http.Request, name, verb string) (string, error) {
	id, v, ok := strings.Cut(r.PathValue(name), ":")
	if !ok || v != verb {
		return "", httpx.Errorf(404, "NOT_FOUND", "No such operation.")
	}
	return id, nil
}

type inferenceBody struct {
	ModelVersions map[string]string `json:"model_versions"`
	Quality       *struct {
		Luminance    float64 `json:"luminance"`
		BlurVariance float64 `json:"blur_variance"`
	} `json:"quality"`
	Faces     int                `json:"faces"`
	Embedding []float32          `json:"embedding"`
	HeadPose  map[string]float64 `json:"head_pose"`
	Objects   []struct {
		Label string  `json:"label"`
		Score float64 `json:"score"`
	} `json:"objects"`
	PHash string `json:"phash"`
	Audio *struct {
		Speakers int     `json:"speakers"`
		SpeechS  float64 `json:"speech_s"`
		WindowS  float64 `json:"window_s"`
	} `json:"audio"`
	Error string `json:"error"`
}

func (s *Server) inference(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	id, err := action(r, "frameAction", "inference")
	if err != nil {
		return err
	}
	if !pgtx.IsUUID(id) {
		return httpx.BadRequest("frame id must be a UUID.")
	}
	tenant, err := httpx.TenantParam(r)
	if err != nil {
		return err
	}
	if tenant, err = httpx.TenantFor(p, tenant); err != nil {
		return err
	}
	var b inferenceBody
	if err := httpx.DecodeBody(w, r, InferenceLimit, &b); err != nil {
		return err
	}
	in := app.InferenceResult{ModelVersions: b.ModelVersions, Faces: b.Faces, Embedding: b.Embedding, HeadPose: b.HeadPose,
		PHash: b.PHash, Error: b.Error}
	if b.Quality != nil {
		in.Luminance, in.BlurVariance = b.Quality.Luminance, b.Quality.BlurVariance
	}
	for _, o := range b.Objects {
		in.Objects = append(in.Objects, o.Label)
	}
	if b.Audio != nil {
		in.Speakers, in.SpeechS, in.WindowS = b.Audio.Speakers, b.Audio.SpeechS, b.Audio.WindowS
	}
	if err := s.S.Inference(r.Context(), p, tenant, id, in); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (s *Server) timeline(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	sid, err := httpx.PathUUID(r, "sessionId")
	if err != nil {
		return err
	}
	tenant, err := httpx.TenantParam(r)
	if err != nil {
		return err
	}
	t, err := s.S.GetTimeline(r.Context(), p, tenant, sid)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, t)
	return nil
}

func (s *Server) review(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	raw, err := action(r, "flagAction", "review")
	if err != nil {
		return err
	}
	logID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || logID < 1 {
		return httpx.BadRequest("flag id must be a positive integer.")
	}
	tenant, err := httpx.TenantParam(r)
	if err != nil {
		return err
	}
	var b struct {
		Decision string  `json:"decision"`
		Comment  *string `json:"comment"`
	}
	if err := httpx.DecodeBody(w, r, SmallLimit, &b); err != nil {
		return err
	}
	rv, err := s.S.ReviewFlag(r.Context(), p, tenant, logID, b.Decision, b.Comment)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"flag_id": rv.LogID, "session_id": rv.SessionID, "rule": rv.Rule,
		"decision": rv.Decision, "reviewer": rv.Reviewer, "decided_at": rv.DecidedAt})
	return nil
}

func (s *Server) accommodate(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
	sid, err := httpx.PathUUID(r, "sessionId")
	if err != nil {
		return err
	}
	tenant, err := httpx.TenantParam(r)
	if err != nil {
		return err
	}
	var b struct {
		DisabledRules []string `json:"disabled_rules"`
		Reason        string   `json:"reason"`
	}
	if err := httpx.DecodeBody(w, r, SmallLimit, &b); err != nil {
		return err
	}
	a, err := s.S.Accommodate(r.Context(), p, tenant, sid, b.DisabledRules, b.Reason)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"session_id": a.SessionID, "disabled_rules": a.DisabledRules,
		"reason": a.Reason, "granted_by": a.GrantedBy, "granted_at": a.GrantedAt})
	return nil
}
