// Package auth verifies bearer JWTs (identity-svc, RS256/ES256 via JWKS; HS256 for local work)
// and maps them to a Principal, with the same rules as @atlas/platform's JwtVerifier.
package auth

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Principal is the verified caller (MASTER_ORCHESTRATION_PROMPT §4.3: tenant identity comes only
// from the token).
type Principal struct {
	Subject  string
	TenantID *string
	Roles    []string
	Scopes   []string
}

// HasRole reports whether the principal holds role.
func (p Principal) HasRole(role string) bool { return slices.Contains(p.Roles, role) }

// HasScope reports whether the principal holds scope.
func (p Principal) HasScope(scope string) bool { return slices.Contains(p.Scopes, scope) }

// HasAnyRole reports whether the principal holds one of roles.
func (p Principal) HasAnyRole(roles ...string) bool { return slices.ContainsFunc(roles, p.HasRole) }

// IsService reports a machine principal with the scope.
func (p Principal) IsService(scope string) bool { return p.HasRole("service") && p.HasScope(scope) }

// Verifier checks bearer tokens (same rules as @atlas/platform's JwtVerifier).
type Verifier interface {
	Verify(ctx context.Context, token string) (Principal, error)
}

// ErrUnauthenticated is returned for missing, invalid or expired tokens.
var ErrUnauthenticated = errors.New("unauthenticated")

var knownRoles = []string{"super_admin", "tenant_admin", "recruiter", "hiring_manager", "reviewer", "sme", "employee", "candidate", "service"}

type claims struct {
	jwt.RegisteredClaims
	TID    *string  `json:"tid"`
	Roles  []string `json:"roles"`
	Scopes []string `json:"scopes"`
}

// JWTVerifier verifies RS256/ES256 tokens from a JWKS, or HS256 with a shared secret (dev/tests).
type JWTVerifier struct {
	issuer, audience string
	keyFunc          jwt.Keyfunc
	methods          []string
	now              func() time.Time
}

// NewJWTVerifier builds a verifier. jwksURL wins over sharedSecret.
func NewJWTVerifier(ctx context.Context, issuer, audience, jwksURL, sharedSecret string, now func() time.Time) (*JWTVerifier, error) {
	v := &JWTVerifier{issuer: issuer, audience: audience, now: now}
	switch {
	case jwksURL != "":
		k, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
		if err != nil {
			return nil, err
		}
		v.keyFunc, v.methods = k.Keyfunc, []string{"RS256", "ES256"}
	case len(sharedSecret) >= 32:
		secret := []byte(sharedSecret)
		v.keyFunc, v.methods = func(*jwt.Token) (any, error) { return secret, nil }, []string{"HS256"}
	default:
		return nil, errors.New("a JWKS URL or a shared secret of at least 32 characters is required")
	}
	return v, nil
}

// Verify checks signature, issuer, audience and expiry, then maps the claims.
func (v *JWTVerifier) Verify(_ context.Context, token string) (Principal, error) {
	var c claims
	opts := []jwt.ParserOption{
		jwt.WithValidMethods(v.methods), jwt.WithIssuer(v.issuer), jwt.WithAudience(v.audience),
		jwt.WithLeeway(30 * time.Second), jwt.WithExpirationRequired(),
	}
	if v.now != nil {
		opts = append(opts, jwt.WithTimeFunc(v.now))
	}
	if _, err := jwt.ParseWithClaims(token, &c, v.keyFunc, opts...); err != nil {
		return Principal{}, ErrUnauthenticated
	}
	if c.Subject == "" || len(c.Roles) == 0 {
		return Principal{}, ErrUnauthenticated
	}
	for _, r := range c.Roles {
		if !slices.Contains(knownRoles, r) {
			return Principal{}, ErrUnauthenticated
		}
	}
	if c.TID != nil && *c.TID == "" {
		c.TID = nil
	}
	return Principal{Subject: c.Subject, TenantID: c.TID, Roles: c.Roles, Scopes: c.Scopes}, nil
}
