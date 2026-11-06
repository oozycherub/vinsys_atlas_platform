package test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"atlas.dev/go-platform/auth"
	"atlas.dev/sandbox-svc/internal/adapters/blob"

	"atlas.dev/sandbox-svc/internal/adapters/httpapi"
	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
	"atlas.dev/sandbox-svc/internal/testkit"
)

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type env struct {
	t        *testing.T
	db       *testkit.DB
	api      *app.API
	srv      *httptest.Server
	blobs    *blob.Memory
	clock    *clock
	pool     *testkit.FakePool
	langs    map[int]domain.Language
	maint    *app.Maintenance
	handlers *app.Handlers
	svc      string // service token (assessment-svc)
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func setup(t *testing.T) *env {
	t.Helper()
	db := testkit.NewDB(t)
	e := &env{t: t, db: db, blobs: blob.NewMemory(), clock: &clock{now: time.Now().UTC()}, pool: &testkit.FakePool{}}
	e.api = &app.API{Store: db.Store, Blobs: e.blobs, Clock: e.clock, NewID: newID}
	verifier, err := auth.NewJWTVerifier(context.Background(), testkit.Issuer, testkit.Audience, "", testkit.Secret, nil)
	if err != nil {
		t.Fatal(err)
	}
	e.srv = httptest.NewServer((&httpapi.Server{API: e.api, Verifier: verifier, Log: quiet}).Handler())
	t.Cleanup(e.srv.Close)
	all, err := e.api.Languages(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e.langs = map[int]domain.Language{}
	for _, l := range all {
		if l.Enabled {
			e.langs[l.ID] = l
		}
	}
	e.maint = &app.Maintenance{Store: db.Store, Clock: e.clock, Log: quiet}
	e.handlers = &app.Handlers{Store: db.Store, Blobs: e.blobs, Clock: e.clock, Log: quiet, API: e.api}
	e.svc = testkit.Token(t, "svc_assessment", nil, []string{"service"}, []string{app.ScopeExecute, app.ScopeBundles}, time.Hour)
	return e
}

func (e *env) worker(id string) *app.Worker {
	return &app.Worker{
		ID: id, Store: e.db.Store, Bundles: &blob.Cache{Store: e.blobs, Dir: e.t.TempDir()},
		Judge: &app.Judge{Pool: e.pool}, Clock: e.clock, Log: quiet, Languages: e.langs,
	}
}

// drain processes queued jobs until none is left.
func (e *env) drain() int {
	e.t.Helper()
	w := e.worker("w-drain")
	n := 0
	for {
		worked, err := w.RunOnce(context.Background())
		if err != nil {
			e.t.Fatal(err)
		}
		if !worked {
			return n
		}
		n++
		if n > 5000 {
			e.t.Fatal("queue never drained")
		}
	}
}

type resp struct {
	Status int
	Body   map[string]any
	Header http.Header
}

func (e *env) do(method, path, token string, body any, headers ...string) resp {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		if s, ok := body.(string); ok {
			r = bytes.NewBufferString(s)
		} else {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, r)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	out := resp{Status: res.StatusCode, Header: res.Header, Body: map[string]any{}}
	data, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(data, &out.Body)
	return out
}

type tests []map[string]any

func sampleTests() tests {
	return tests{
		{"input": "1 2", "expected": "3", "hidden": false},
		{"input": "5 5", "expected": "10", "hidden": true, "weight": 3},
		{"input": "0 0", "expected": "0"},
	}
}

func (e *env) putBundle(tenant, qid string, version int, ref string, extra map[string]any) resp {
	body := map[string]any{
		"languages": []string{"python", "cpp"}, "tests": sampleTests(),
		"reference_solution": map[string]any{"language": "python", "source": ref},
	}
	for k, v := range extra {
		body[k] = v
	}
	return e.do("PUT", "/v1/test-case-bundles/"+qid+"/versions/"+itoa(version)+"?tenant_id="+tenant, e.svc, body)
}

// verifiedQuestion registers a bundle and runs its verification.
func (e *env) verifiedQuestion(tenant string) string {
	e.t.Helper()
	qid := newID()
	if r := e.putBundle(tenant, qid, 1, "SUM", nil); r.Status != 201 {
		e.t.Fatalf("bundle: %d %v", r.Status, r.Body)
	}
	e.drain()
	if r := e.do("GET", "/v1/test-case-bundles/"+qid+"/versions/1?tenant_id="+tenant, e.svc, nil); r.Body["status"] != "verified" {
		e.t.Fatalf("bundle not verified: %v", r.Body)
	}
	return qid
}

type session struct{ tenant, id, candidate, assessment string }

func newSession(tenant string) session {
	return session{tenant: tenant, id: newID(), candidate: newID(), assessment: newID()}
}

func (e *env) submit(s session, qid, lang, source, key string) resp {
	return e.do("POST", "/v1/sessions/"+s.id+"/questions/"+qid+"/submissions?tenant_id="+s.tenant, e.svc,
		map[string]any{"language": lang, "source": source, "question_version": 1, "candidate_id": s.candidate, "assessment_id": s.assessment},
		"Idempotency-Key", key)
}

func (e *env) run(s session, qid, lang, source string, stdin *string) resp {
	body := map[string]any{"language": lang, "source": source, "question_version": 1, "candidate_id": s.candidate}
	if stdin != nil {
		body["stdin"] = *stdin
	}
	return e.do("POST", "/v1/sessions/"+s.id+"/questions/"+qid+"/runs?tenant_id="+s.tenant, e.svc, body)
}

func (e *env) submission(tenant, id string) map[string]any {
	return e.do("GET", "/v1/submissions/"+id+"?tenant_id="+tenant, e.svc, nil).Body
}

type outboxRow struct {
	Topic   string
	Tenant  string
	Payload map[string]any
}

func (e *env) outbox(topic string) []outboxRow {
	e.t.Helper()
	rows, err := e.db.Owner.Query(context.Background(), `SELECT topic, tenant_id::text, payload FROM outbox_events WHERE topic = $1 ORDER BY created_at, event_id`, topic)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		var raw []byte
		if err := rows.Scan(&r.Topic, &r.Tenant, &raw); err != nil {
			e.t.Fatal(err)
		}
		_ = json.Unmarshal(raw, &r.Payload)
		out = append(out, r)
	}
	return out
}

func (e *env) scalar(sql string, args ...any) any {
	e.t.Helper()
	var v any
	if err := e.db.Owner.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		e.t.Fatal(err)
	}
	return v
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
