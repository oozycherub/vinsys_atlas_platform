// Package postgres implements the app's Store over pgx. Every unit of work is one transaction;
// tenant work sets app.tenant_id (RLS), queue work sets app.system (MASTER_ORCHESTRATION_PROMPT §4.3).
package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"atlas.dev/go-platform/pgtx"

	"atlas.dev/sandbox-svc/internal/app"
)

// IsUUID reports whether s is a canonical UUID.
func IsUUID(s string) bool { return pgtx.IsUUID(s) }

// Store opens transactions on a pool connected as atlas_app (no BYPASSRLS).
type Store struct{ Pool *pgxpool.Pool }

// Open connects to url.
func Open(ctx context.Context, url string) (*Store, error) {
	pool, err := pgtx.Open(ctx, url)
	if err != nil {
		return nil, err
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) tx(ctx context.Context, fn func(pgx.Tx) error) error {
	return pgtx.Tx(ctx, s.Pool, fn)
}

func setTenant(ctx context.Context, tx pgx.Tx, tenantID string) error {
	return pgtx.SetTenant(ctx, tx, tenantID)
}

// InTenant runs fn in a transaction bound to the tenant.
func (s *Store) InTenant(ctx context.Context, tenantID string, fn func(app.TenantRepo) error) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		if err := setTenant(ctx, tx, tenantID); err != nil {
			return err
		}
		return fn(&tenantRepo{tx: tx, tenant: tenantID})
	})
}

// InSystem runs fn in a system transaction (app.system = 'on').
func (s *Store) InSystem(ctx context.Context, fn func(app.SystemRepo) error) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		if err := pgtx.SetSystem(ctx, tx); err != nil {
			return err
		}
		return fn(&systemRepo{tx: tx})
	})
}

// InSystemThenTenant runs fn in one transaction that starts as a system transaction and may
// switch to a tenant context (once) for the event's tenant.
func (s *Store) InSystemThenTenant(ctx context.Context, fn func(app.SystemRepo, func(string) (app.TenantRepo, error)) error) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		if err := pgtx.SetSystem(ctx, tx); err != nil {
			return err
		}
		bound := ""
		return fn(&systemRepo{tx: tx}, func(tenantID string) (app.TenantRepo, error) {
			if bound != "" && bound != tenantID {
				return nil, errors.New("a transaction can serve one tenant")
			}
			// Tenant work inside an event handler runs with tenant RLS only (system off).
			if err := setTenant(ctx, tx, tenantID); err != nil {
				return nil, err
			}
			bound = tenantID
			return &tenantRepo{tx: tx, tenant: tenantID}, nil
		})
	})
}

// Ping checks connectivity.
func (s *Store) Ping(ctx context.Context) error { return s.Pool.Ping(ctx) }

// Close releases the pool.
func (s *Store) Close() { s.Pool.Close() }

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return app.ErrNotFound
	}
	return err
}
