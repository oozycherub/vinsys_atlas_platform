// Package testkit provides a real Postgres per test package (migrations applied, RLS on),
// signed test tokens and a scripted fake box.
package testkit

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	platform "atlas.dev/go-platform/testkit"

	"atlas.dev/sandbox-svc/internal/adapters/postgres"
)

// Test token settings (shared with every Go service).
const (
	Secret   = platform.Secret
	Issuer   = platform.Issuer
	Audience = platform.Audience
)

// DB is a fresh database with this service's migrations.
type DB struct {
	Store  *postgres.Store
	Owner  *pgx.Conn // bypasses RLS: assertions only
	Name   string
	AppURL string
}

// NewDB creates a database with migrations 0001 and 0012, connected as atlas_app.
func NewDB(t testing.TB) *DB {
	t.Helper()
	db := platform.NewDB(t, "0001_foundation.sql", "0012_sandbox.sql")
	return &DB{Store: &postgres.Store{Pool: db.Pool}, Owner: db.Owner, Name: db.Name, AppURL: db.AppURL}
}

// Token signs a test JWT.
func Token(t testing.TB, sub string, tid *string, roles, scopes []string, ttl time.Duration) string {
	return platform.Token(t, sub, tid, roles, scopes, ttl)
}
