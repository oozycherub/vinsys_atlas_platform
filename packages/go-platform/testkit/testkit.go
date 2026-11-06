// Package testkit gives Go service tests a real Postgres database per test package (chosen
// migrations applied as the owner, the service connected as atlas_app so RLS applies) and signed
// HS256 tokens.
package testkit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"atlas.dev/go-platform/pgtx"
)

// Test token settings.
const (
	Secret   = "test-only-shared-secret-at-least-32-chars!"
	Issuer   = "https://id.atlas.test"
	Audience = "atlas-api"
)

// RepoRoot is the monorepo root.
func RepoRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..")
}

// OwnerURL is the test cluster (a scratch Postgres 16 started by the gate script).
func OwnerURL() string {
	if u := os.Getenv("ATLAS_TEST_PG_URL"); u != "" {
		return u
	}
	return "postgres://atlas_owner@127.0.0.1:5544/postgres?sslmode=disable"
}

// DB is a fresh database.
type DB struct {
	Pool   *pgxpool.Pool // atlas_app: what the service uses
	Owner  *pgx.Conn     // bypasses RLS: assertions only
	Name   string
	AppURL string
}

// NewDB creates a database and applies the named migrations (e.g. "0001_foundation.sql"). It
// fails, never skips, when Postgres is unreachable.
func NewDB(t testing.TB, migrations ...string) *DB {
	t.Helper()
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, OwnerURL())
	if err != nil {
		t.Fatalf("test Postgres unreachable at %s (run the gate script): %v", OwnerURL(), err)
	}
	defer admin.Close(ctx)
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "atlas_test_" + hex.EncodeToString(b)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	ownerURL := strings.Replace(OwnerURL(), "/postgres", "/"+name, 1)
	owner, err := pgx.Connect(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations {
		sql, err := os.ReadFile(filepath.Join(RepoRoot(), "db", "migrations", m))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := owner.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("%s: %v", m, err)
		}
	}
	if _, err := owner.Exec(ctx, "ALTER ROLE atlas_app LOGIN PASSWORD 'atlas_app_test'"); err != nil {
		t.Fatal(err)
	}
	appURL := strings.Replace(ownerURL, "atlas_owner@", "atlas_app:atlas_app_test@", 1)
	pool, err := pgtx.Open(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		owner.Close(ctx)
		if a, err := pgx.Connect(ctx, OwnerURL()); err == nil {
			_, _ = a.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
			a.Close(ctx)
		}
	})
	return &DB{Pool: pool, Owner: owner, Name: name, AppURL: appURL}
}

// Token signs a test JWT.
func Token(t testing.TB, sub string, tid *string, roles, scopes []string, ttl time.Duration) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": Issuer, "aud": Audience, "roles": roles, "scopes": scopes,
		"exp": time.Now().Add(ttl).Unix(), "iat": time.Now().Unix(),
	}
	if tid != nil {
		claims["tid"] = *tid
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(Secret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}
