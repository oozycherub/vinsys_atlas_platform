package test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"atlas.dev/go-platform/auth"
	"atlas.dev/go-platform/logging"
	"atlas.dev/go-platform/pgtx"
	"atlas.dev/go-platform/testkit"

	"atlas.dev/proctoring-svc/internal/adapters/blob"
	"atlas.dev/proctoring-svc/internal/adapters/crypto"
	"atlas.dev/proctoring-svc/internal/adapters/httpapi"
	"atlas.dev/proctoring-svc/internal/adapters/postgres"
	"atlas.dev/proctoring-svc/internal/adapters/tenants"
	"atlas.dev/proctoring-svc/internal/app"
	"atlas.dev/proctoring-svc/internal/domain"
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
	t         *testing.T
	db        *testkit.DB
	svc       *app.Service
	srv       *httptest.Server
	blobs     *blob.Memory
	clock     *clock
	retention *tenants.Static
	handlers  *app.Handlers
	maint     *app.Maintenance
	assess    string // assessment-svc token
	infer     string // cv-inference token
}

func setup(t *testing.T) *env {
	t.Helper()
	db := testkit.NewDB(t, "0001_foundation.sql", "0014_proctoring.sql")
	cipher, err := crypto.NewAESGCM(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, db: db, blobs: blob.NewMemory(), clock: &clock{now: time.Now().UTC().Truncate(time.Millisecond)}, retention: &tenants.Static{Days: map[string]int{}}}
	e.svc = &app.Service{Store: &postgres.Store{Pool: db.Pool}, Blobs: e.blobs, Cipher: cipher, Retention: e.retention,
		Clock: e.clock, Log: logging.Discard(), NewID: pgtx.NewID}
	verifier, err := auth.NewJWTVerifier(context.Background(), testkit.Issuer, testkit.Audience, "", testkit.Secret, nil)
	if err != nil {
		t.Fatal(err)
	}
	e.srv = httptest.NewServer((&httpapi.Server{S: e.svc, Verifier: verifier, Log: logging.Discard()}).Handler())
	t.Cleanup(e.srv.Close)
	e.handlers = &app.Handlers{S: e.svc}
	e.maint = &app.Maintenance{S: e.svc, LogRetention: 365 * 24 * time.Hour}
	e.assess = testkit.Token(t, "svc_assessment", nil, []string{"service"}, []string{app.ScopeSessions}, time.Hour)
	e.infer = testkit.Token(t, "svc_cv_inference", nil, []string{"service"}, []string{app.ScopeInference}, time.Hour)
	return e
}

type reply struct {
	Status int
	Body   map[string]any
	Header http.Header
}

func (e *env) do(method, path, auth string, body any, headers ...string) reply {
	e.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		r = bytes.NewReader(b)
	case string:
		r = bytes.NewBufferString(b)
	default:
		data, _ := json.Marshal(b)
		r = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, r)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	out := reply{Status: res.StatusCode, Header: res.Header, Body: map[string]any{}}
	data, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(data, &out.Body)
	return out
}

func bearer(tok string) string { return "Bearer " + tok }

// candidate is a stand-in for the browser SDK: it signs and chains envelopes.
type candidate struct {
	e         *env
	tenant    string
	session   string
	assess    string
	person    string
	token     string
	key       []byte
	epoch     int
	seq       int64
	prev      string
	clientLag time.Duration // the client clock runs this far behind the server
}

func (e *env) start(tenant string, rules *domain.Rules, extra map[string]any) (*candidate, reply) {
	c := &candidate{e: e, tenant: tenant, session: pgtx.NewID(), assess: pgtx.NewID(), person: pgtx.NewID()}
	r := c.restart(rules, extra)
	return c, r
}

func (c *candidate) restart(rules *domain.Rules, extra map[string]any) reply {
	body := map[string]any{"assessment_id": c.assess, "candidate_id": c.person,
		"consent": map[string]any{"biometrics": true, "version": "2026-11"}}
	if rules != nil {
		body["rules"] = rules
	}
	for k, v := range extra {
		body[k] = v
	}
	r := c.e.do("PUT", "/v1/proctoring/sessions/"+c.session+"?tenant_id="+c.tenant, bearer(c.e.assess), body)
	if r.Status == 200 {
		c.token = r.Body["proctor_token"].(string)
		c.key, _ = base64.StdEncoding.DecodeString(r.Body["session_key"].(string))
		c.epoch = int(r.Body["key_epoch"].(float64))
		c.seq = int64(r.Body["next_seq"].(float64)) - 1
		c.prev = r.Body["prev_hash"].(string)
	}
	return r
}

func (c *candidate) clientNow() float64 {
	return float64(c.e.clock.Now().Add(-c.clientLag).UnixMilli())
}

// envelope builds a signed event; mutate may tamper with the signed map before signing.
func (c *candidate) envelope(typ string, payload map[string]any) json.RawMessage {
	c.seq++
	unsigned := map[string]any{"session_id": c.session, "seq": c.seq, "type": typ, "client_ts": c.clientNow(),
		"key_epoch": c.epoch, "payload": payload, "prev_hash": c.prev}
	canon := canonical(c.e.t, unsigned)
	mac := domain.Sign(c.key, canon)
	unsigned["mac"] = mac
	full := canonical(c.e.t, unsigned)
	sum := sha256.Sum256(full)
	c.prev = hex.EncodeToString(sum[:])
	wire, _ := json.Marshal(unsigned)
	return wire
}

func canonical(t *testing.T, v any) []byte {
	raw, _ := json.Marshal(v)
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m any
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	out, err := domain.Canonical(m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (c *candidate) send(events ...json.RawMessage) reply {
	return c.e.do("POST", "/v1/proctoring/sessions/"+c.session+"/events", "Proctor "+c.token,
		map[string]any{"sent_at": c.clientNow(), "events": events})
}

func (c *candidate) upload(kind string) string {
	ct := "image/jpeg"
	if kind == "audio" {
		ct = "audio/webm"
	}
	r := c.e.do("POST", "/v1/proctoring/sessions/"+c.session+"/frames:initiateUpload", "Proctor "+c.token,
		map[string]any{"kind": kind, "content_type": ct})
	if r.Status != 201 {
		c.e.t.Fatalf("upload: %d %v", r.Status, r.Body)
	}
	id := r.Body["frame_id"].(string)
	key := r.Body["upload"].(map[string]any)["fields"].(map[string]any)["key"].(string)
	c.e.blobs.Put(key, []byte("jpeg"))
	if s := c.send(c.envelope("frame", map[string]any{"frame_id": id})); s.Status != 200 {
		c.e.t.Fatalf("frame event: %d %v", s.Status, s.Body)
	}
	return id
}

func embedding(seed int) []float32 {
	v := make([]float32, app.EmbeddingDims)
	for i := range v {
		v[i] = float32(math.Sin(float64(i*(seed+1)) + float64(seed)))
	}
	return v
}

func (c *candidate) infer(frameID string, body map[string]any) reply {
	return c.e.do("POST", "/v1/proctoring/frames/"+frameID+":inference?tenant_id="+c.tenant, bearer(c.e.infer), body)
}

func frame(faces int, emb []float32, objects ...string) map[string]any {
	objs := []map[string]any{}
	for _, o := range objects {
		objs = append(objs, map[string]any{"label": o, "score": 0.9})
	}
	b := map[string]any{"quality": map[string]any{"luminance": 120, "blur_variance": 300}, "faces": faces, "objects": objs,
		"model_versions": map[string]string{"retinaface": "r0.25@1", "arcface": "r100@1", "yolo": "yolo11s-proctor@3.2"}}
	if emb != nil {
		b["embedding"] = emb
	}
	return b
}

type outboxRow struct {
	Topic   string
	Payload map[string]any
}

func (e *env) outbox(topic string) []outboxRow {
	e.t.Helper()
	rows, err := e.db.Owner.Query(context.Background(), `SELECT topic, payload FROM outbox_events WHERE topic = $1 ORDER BY created_at, event_id`, topic)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		var raw []byte
		_ = rows.Scan(&r.Topic, &raw)
		_ = json.Unmarshal(raw, &r.Payload)
		out = append(out, r)
	}
	return out
}

func (e *env) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.db.Owner.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *env) staff(tenant string, roles ...string) string {
	return bearer(testkit.Token(e.t, "staff-"+roles[0], &tenant, roles, nil, time.Hour))
}

func (e *env) timeline(tenant, session string) map[string]any {
	e.t.Helper()
	r := e.do("GET", "/v1/proctoring/sessions/"+session+"/timeline", e.staff(tenant, "reviewer"), nil)
	if r.Status != 200 {
		e.t.Fatalf("timeline: %d %v", r.Status, r.Body)
	}
	return r.Body
}

func (e *env) event(topic, tenant string, payload map[string]any) error {
	raw, _ := json.Marshal(payload)
	_, err := e.handlers.Handle(context.Background(), eventOf(topic, tenant, raw))
	return err
}
