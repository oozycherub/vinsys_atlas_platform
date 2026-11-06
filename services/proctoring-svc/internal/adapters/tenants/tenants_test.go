package tenants

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRetentionFromTenantService(t *testing.T) {
	calls := 0
	body := `{"tenant_id":"t1","retention_policy":{"proctoring_frames_days":14}}`
	status := 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer tok" || r.URL.Path != "/v1/tenants/t1/settings" {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	r := &Retention{BaseURL: srv.URL + "/", Token: func(context.Context) (string, error) { return "tok", nil }}
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if d, err := r.FrameDays(ctx, "t1"); err != nil || d != 14 {
			t.Fatal(d, err)
		}
	}
	if calls != 1 {
		t.Fatalf("cached: %d calls", calls)
	}
	r.Invalidate("t1")
	body = `{"retention_policy":{}}`
	if d, _ := r.FrameDays(ctx, "t1"); d != DefaultFrameDays || calls != 2 {
		t.Fatal("default after invalidation")
	}
	r.Invalidate("t1")
	status = 500
	if _, err := r.FrameDays(ctx, "t1"); err == nil {
		t.Fatal("5xx")
	}
	status, body = 200, "nope"
	if _, err := r.FrameDays(ctx, "t1"); err == nil {
		t.Fatal("bad json")
	}
	bad := &Retention{BaseURL: srv.URL, Token: func(context.Context) (string, error) { return "", errors.New("no token") }}
	if _, err := bad.FrameDays(ctx, "t1"); err == nil {
		t.Fatal("token error")
	}
	down := &Retention{BaseURL: "http://127.0.0.1:1", Token: func(context.Context) (string, error) { return "tok", nil }}
	if _, err := down.FrameDays(ctx, "t1"); err == nil {
		t.Fatal("unreachable")
	}
	s := &Static{Days: map[string]int{"a": 3}}
	if d, _ := s.FrameDays(ctx, "a"); d != 3 {
		t.Fatal("static")
	}
	if d, _ := s.FrameDays(ctx, "b"); d != DefaultFrameDays {
		t.Fatal("static default")
	}
}
