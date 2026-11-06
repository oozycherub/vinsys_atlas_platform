package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientCredentials(t *testing.T) {
	calls := 0
	status := 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		user, pass, _ := r.BasicAuth()
		if user != "svc_x" || pass != "s3cret" || r.FormValue("grant_type") != "client_credentials" || r.FormValue("scope") != "a b" {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":120}`))
	}))
	defer srv.Close()
	now := time.Now()
	c := &ClientCredentials{TokenURL: srv.URL, ClientID: "svc_x", ClientSecret: "s3cret", Scopes: []string{"a", "b"}, Now: func() time.Time { return now }}
	for i := 0; i < 3; i++ {
		if tok, err := c.Token(context.Background()); err != nil || tok != "tok" {
			t.Fatal(tok, err)
		}
	}
	if calls != 1 {
		t.Fatalf("cached: %d calls", calls)
	}
	now = now.Add(61 * time.Second) // 120 s token, refreshed a minute early
	_, _ = c.Token(context.Background())
	if calls != 2 {
		t.Fatalf("refresh: %d calls", calls)
	}
	bad := &ClientCredentials{TokenURL: srv.URL, ClientID: "nope", ClientSecret: "x"}
	if _, err := bad.Token(context.Background()); err == nil {
		t.Fatal("401 accepted")
	}
	status = 200
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer empty.Close()
	if _, err := (&ClientCredentials{TokenURL: empty.URL}).Token(context.Background()); err == nil {
		t.Fatal("empty token accepted")
	}
	if _, err := (&ClientCredentials{TokenURL: "http://127.0.0.1:1"}).Token(context.Background()); err == nil {
		t.Fatal("unreachable")
	}
	if _, err := (&ClientCredentials{TokenURL: "::bad"}).Token(context.Background()); err == nil {
		t.Fatal("bad url")
	}
}
