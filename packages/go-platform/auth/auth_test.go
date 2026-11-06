package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestJWKSVerifier(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	jwks := map[string]any{"keys": []map[string]any{{
		"kty": "RSA", "kid": "k1", "alg": "RS256", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(jwks) }))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	v, err := NewJWTVerifier(ctx, "https://id", "atlas-api", srv.URL, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	sign := func(claims jwt.MapClaims, method jwt.SigningMethod, k any) string {
		tok := jwt.NewWithClaims(method, claims)
		tok.Header["kid"] = "k1"
		s, _ := tok.SignedString(k)
		return s
	}
	base := func() jwt.MapClaims {
		return jwt.MapClaims{"sub": "svc", "iss": "https://id", "aud": "atlas-api", "roles": []string{"service"},
			"scopes": []string{"sandbox:execute"}, "tid": "", "exp": time.Now().Add(time.Hour).Unix()}
	}
	p, err := v.Verify(ctx, sign(base(), jwt.SigningMethodRS256, key))
	if err != nil || p.Subject != "svc" || p.TenantID != nil || p.Scopes[0] != "sandbox:execute" {
		t.Fatalf("valid token: %+v %v", p, err)
	}
	for name, mutate := range map[string]func(jwt.MapClaims){
		"issuer":   func(c jwt.MapClaims) { c["iss"] = "https://evil" },
		"audience": func(c jwt.MapClaims) { c["aud"] = "other" },
		"expired":  func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Hour).Unix() },
		"no exp":   func(c jwt.MapClaims) { delete(c, "exp") },
		"role":     func(c jwt.MapClaims) { c["roles"] = []string{"root"} },
		"no roles": func(c jwt.MapClaims) { c["roles"] = []string{} },
		"no sub":   func(c jwt.MapClaims) { delete(c, "sub") },
	} {
		c := base()
		mutate(c)
		if _, err := v.Verify(ctx, sign(c, jwt.SigningMethodRS256, key)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	// HS256 with a shared secret is not accepted by a JWKS verifier (algorithm confusion).
	if _, err := v.Verify(ctx, sign(base(), jwt.SigningMethodHS256, []byte("x"))); err == nil {
		t.Fatal("HS256 accepted by the JWKS verifier")
	}
	if _, err := NewJWTVerifier(ctx, "i", "a", "", "short", nil); err == nil {
		t.Fatal("short secret accepted")
	}
	fixed := time.Now().Add(2 * time.Hour)
	hs, _ := NewJWTVerifier(ctx, "https://id", "atlas-api", "", "test-only-shared-secret-at-least-32-chars!", func() time.Time { return fixed })
	c := base()
	if _, err := hs.Verify(ctx, sign(c, jwt.SigningMethodHS256, []byte("test-only-shared-secret-at-least-32-chars!"))); err == nil {
		t.Fatal("the injected clock must make this token expired")
	}
}

func TestPrincipalHelpers(t *testing.T) {
	p := Principal{Roles: []string{"service"}, Scopes: []string{"a"}}
	if !p.IsService("a") || p.IsService("b") || !p.HasAnyRole("x", "service") || p.HasAnyRole("x") {
		t.Fatal("helpers")
	}
}
