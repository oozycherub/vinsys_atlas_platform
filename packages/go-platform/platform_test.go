package platform_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"atlas.dev/go-platform/auth"
	"atlas.dev/go-platform/events"
	"atlas.dev/go-platform/httpx"
	"atlas.dev/go-platform/logging"
	"atlas.dev/go-platform/pgtx"
	"atlas.dev/go-platform/testkit"
)

func TestEventsDecode(t *testing.T) {
	var v struct {
		A int `json:"a"`
	}
	e := events.Consumed{Payload: json.RawMessage(`{"a":1}`)}
	if err := events.Decode(e, &v, "a"); err != nil || v.A != 1 {
		t.Fatal(err)
	}
	var poison *events.PoisonError
	for _, raw := range []string{`[1]`, `{"b":1}`, `{"a":"x"}`} {
		if err := events.Decode(events.Consumed{Payload: json.RawMessage(raw)}, &v, "a"); !errors.As(err, &poison) {
			t.Errorf("%s: %v", raw, err)
		}
	}
	if (&events.PoisonError{Reason: "r"}).Error() != "poison event: r" {
		t.Fatal("message")
	}
}

type reply struct {
	StatusCode int
	Header     http.Header
}

func serve(t *testing.T, h http.Handler, method, path, body string, headers ...string) (reply, map[string]any) {
	t.Helper()
	srv := httptest.NewServer(h)
	defer srv.Close()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	_ = json.Unmarshal(data, &out)
	return reply{StatusCode: res.StatusCode, Header: res.Header}, out
}

func TestHTTPX(t *testing.T) {
	log := logging.NewTo(io.Discard, "test", "debug")
	v, err := auth.NewJWTVerifier(context.Background(), testkit.Issuer, testkit.Audience, "", testkit.Secret, nil)
	if err != nil {
		t.Fatal(err)
	}
	mapper := func(err error) *httpx.Error {
		if errors.Is(err, io.EOF) {
			return &httpx.Error{Status: 429, Code: "SLOW_DOWN", Detail: "wait", RetryAfter: 3}
		}
		return nil
	}
	mux := http.NewServeMux()
	mux.Handle("POST /things/{id}", httpx.Bearer(v, log, mapper, func(w http.ResponseWriter, r *http.Request, p auth.Principal) error {
		id, err := httpx.PathUUID(r, "id")
		if err != nil {
			return err
		}
		tparam, err := httpx.TenantParam(r)
		if err != nil {
			return err
		}
		tenant, err := httpx.TenantFor(p, tparam)
		if err != nil {
			return err
		}
		var body struct {
			N int `json:"n"`
		}
		if err := httpx.DecodeBody(w, r, 64, &body); err != nil {
			return err
		}
		switch body.N {
		case 1:
			return io.EOF
		case 2:
			return errors.New("boom")
		case 3:
			panic("kaboom")
		}
		httpx.WriteJSON(w, 201, map[string]any{"id": id, "tenant": tenant, "rid": httpx.RequestID(r.Context())})
		return nil
	}))
	mux.Handle("GET /open", httpx.Public(log, nil, func(http.ResponseWriter, *http.Request) error {
		return httpx.Errorf(409, "TAKEN", "already %s", "there")
	}))
	h := httpx.RequestContext(log, mux)
	tid := "0192f0c1-0000-7000-8000-000000000001"
	user := testkit.Token(t, "u", &tid, []string{"recruiter"}, nil, time.Hour)
	svc := testkit.Token(t, "s", nil, []string{"service"}, []string{"x"}, time.Hour)
	id := "0192f0c1-0000-7000-8000-000000000002"
	bearer := func(tok string) []string {
		return []string{"Authorization", "Bearer " + tok, "x-request-id", "req-abcdefgh"}
	}

	res, body := serve(t, h, "POST", "/things/"+id, `{"n":0}`, bearer(user)...)
	if res.StatusCode != 201 || body["tenant"] != tid || body["rid"] != "req-abcdefgh" || res.Header.Get("x-request-id") != "req-abcdefgh" {
		t.Fatalf("ok: %d %v", res.StatusCode, body)
	}
	cases := []struct {
		path, body string
		hdr        []string
		status     int
		code       string
	}{
		{"/things/" + id, `{"n":0}`, nil, 401, "UNAUTHENTICATED"},
		{"/things/" + id, `{"n":0}`, []string{"Authorization", "Bearer nope"}, 401, "UNAUTHENTICATED"},
		{"/things/x", `{"n":0}`, bearer(user), 400, "VALIDATION_FAILED"},
		{"/things/" + id + "?tenant_id=bad", `{"n":0}`, bearer(user), 400, "VALIDATION_FAILED"},
		{"/things/" + id + "?tenant_id=" + id, `{"n":0}`, bearer(user), 403, "FORBIDDEN"},
		{"/things/" + id, `{"n":0}`, bearer(svc), 400, "TENANT_REQUIRED"},
		{"/things/" + id, `{"n":0,"x":1}`, bearer(user), 400, "VALIDATION_FAILED"},
		{"/things/" + id, `{"n":0}{"n":1}`, bearer(user), 400, "VALIDATION_FAILED"},
		{"/things/" + id, `{"n":` + strings.Repeat("0", 100) + `}`, bearer(user), 400, "VALIDATION_FAILED"},
		{"/things/" + id, `{"n":1}`, bearer(user), 429, "SLOW_DOWN"},
		{"/things/" + id, `{"n":2}`, bearer(user), 500, "INTERNAL"},
		{"/things/" + id, `{"n":3}`, bearer(user), 500, "INTERNAL"},
	}
	for i, c := range cases {
		res, body := serve(t, h, "POST", c.path, c.body, c.hdr...)
		if res.StatusCode != c.status || body["code"] != c.code || res.Header.Get("Content-Type") != "application/problem+json" {
			t.Errorf("case %d: %d %v", i, res.StatusCode, body)
		}
	}
	res, body = serve(t, h, "POST", "/things/"+id, `{"n":1}`, bearer(user)...)
	if res.Header.Get("Retry-After") != "3" || body["retry_after"] != 3.0 || body["type"] != "https://errors.atlas.dev/slow-down" || body["instance"] != "/things/"+id {
		t.Fatalf("problem document %v %v", res.Header, body)
	}
	res, body = serve(t, h, "GET", "/open", "")
	if res.StatusCode != 409 || body["detail"] != "already there" || body["title"] != "Conflict" || len(res.Header.Get("x-request-id")) != 36 {
		t.Fatalf("public: %d %v", res.StatusCode, body)
	}
	if (&httpx.Error{Code: "A", Detail: "b"}).Error() != "A: b" {
		t.Fatal("error text")
	}
	logging.New("svc", "info").Debug("hidden")
	logging.Discard().Info("x")
}

func TestPgtx(t *testing.T) {
	db := testkit.NewDB(t, "0001_foundation.sql")
	ctx := context.Background()
	tenant := pgtx.NewID()
	if !pgtx.IsUUID(tenant) || pgtx.IsUUID("x") {
		t.Fatal("uuid")
	}
	err := pgtx.InTenant(ctx, db.Pool, tenant, func(tx pgx.Tx) error {
		return pgtx.AppendOutbox(ctx, tx, tenant, events.Outgoing{
			Topic: "x.thing.happened.v1", AggregateType: "thing", AggregateID: tenant, Payload: map[string]int{"n": 1},
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	// RLS: another tenant cannot write this tenant's events.
	err = pgtx.InTenant(ctx, db.Pool, pgtx.NewID(), func(tx pgx.Tx) error {
		return pgtx.AppendOutbox(ctx, tx, tenant, events.Outgoing{Topic: "x.thing.happened.v1", AggregateType: "t", AggregateID: tenant})
	})
	if err == nil {
		t.Fatal("cross-tenant outbox write allowed")
	}
	var n int
	_ = db.Owner.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND headers->>'tenant_id' = $1::text`, tenant).Scan(&n)
	if n != 1 {
		t.Fatalf("outbox rows %d", n)
	}
	if err := pgtx.InTenant(ctx, db.Pool, "nope", func(pgx.Tx) error { return nil }); err == nil {
		t.Fatal("invalid tenant accepted")
	}
	err = pgtx.InSystem(ctx, db.Pool, func(tx pgx.Tx) error {
		first, err := pgtx.FirstDelivery(ctx, tx, "c", tenant)
		if err != nil || !first {
			return errors.New("first delivery")
		}
		again, _ := pgtx.FirstDelivery(ctx, tx, "c", tenant)
		if again {
			return errors.New("duplicate accepted")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Errors roll back.
	_ = pgtx.InSystem(ctx, db.Pool, func(tx pgx.Tx) error {
		_, _ = pgtx.FirstDelivery(ctx, tx, "c", pgtx.NewID())
		return errors.New("rollback")
	})
	_ = db.Owner.QueryRow(ctx, `SELECT count(*) FROM processed_events`).Scan(&n)
	if n != 1 {
		t.Fatalf("rolled-back work persisted: %d", n)
	}
	_, err = db.Owner.Exec(ctx, `INSERT INTO idempotency_keys (scope, idempotency_key, request_hash) VALUES ('s', 'short', 'h')`)
	if !pgtx.IsCheckViolation(err) || pgtx.IsUniqueViolation(err) {
		t.Fatalf("check violation: %v", err)
	}
	_, _ = db.Owner.Exec(ctx, `INSERT INTO idempotency_keys (scope, idempotency_key, request_hash) VALUES ('s', 'key-12345', 'h')`)
	_, err = db.Owner.Exec(ctx, `INSERT INTO idempotency_keys (scope, idempotency_key, request_hash) VALUES ('s', 'key-12345', 'h')`)
	if !pgtx.IsUniqueViolation(err) {
		t.Fatalf("unique violation: %v", err)
	}
	if _, err := pgtx.Open(ctx, "::bad"); err == nil {
		t.Fatal("bad url")
	}
}
