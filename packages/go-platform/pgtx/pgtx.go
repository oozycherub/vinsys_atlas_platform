// Package pgtx runs units of work in one Postgres transaction with the tenant context RLS needs
// (MASTER_ORCHESTRATION_PROMPT §4.3), and writes outbox events in the caller's transaction (§4.4).
package pgtx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"atlas.dev/go-platform/events"
)

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsUUID reports whether s is a canonical UUID.
func IsUUID(s string) bool { return uuidRe.MatchString(s) }

// NewID returns a UUIDv7 (MASTER_ORCHESTRATION_PROMPT §4.8).
func NewID() string { return uuid.Must(uuid.NewV7()).String() }

// Open connects a pool. Connect as atlas_app (no BYPASSRLS) in every environment.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	// PgBouncer transaction pooling: no server-side prepared statements across transactions.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe
	return pgxpool.NewWithConfig(ctx, cfg)
}

// Tx runs fn in one transaction, rolling back on error.
func Tx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) (err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SetTenant binds the transaction to a tenant (transaction-scoped, PgBouncer-safe).
func SetTenant(ctx context.Context, tx pgx.Tx, tenantID string) error {
	if !IsUUID(tenantID) {
		return fmt.Errorf("tenant id must be a UUID")
	}
	_, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true), set_config('app.system', 'off', true)`, tenantID)
	return err
}

// SetSystem marks a platform-level transaction (app.system = 'on').
func SetSystem(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT set_config('app.system', 'on', true)`)
	return err
}

// InTenant runs fn in a transaction bound to the tenant.
func InTenant(ctx context.Context, pool *pgxpool.Pool, tenantID string, fn func(pgx.Tx) error) error {
	return Tx(ctx, pool, func(tx pgx.Tx) error {
		if err := SetTenant(ctx, tx, tenantID); err != nil {
			return err
		}
		return fn(tx)
	})
}

// InSystem runs fn in a system transaction.
func InSystem(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	return Tx(ctx, pool, func(tx pgx.Tx) error {
		if err := SetSystem(ctx, tx); err != nil {
			return err
		}
		return fn(tx)
	})
}

// FirstDelivery records (consumer, event) for exactly-once effects; false means a duplicate.
func FirstDelivery(ctx context.Context, tx pgx.Tx, consumer, eventID string) (bool, error) {
	tag, err := tx.Exec(ctx, `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
		ON CONFLICT (consumer, event_id) DO NOTHING`, consumer, eventID)
	return tag.RowsAffected() == 1, err
}

// AppendOutbox writes an event for the tenant in the caller's transaction.
func AppendOutbox(ctx context.Context, tx pgx.Tx, tenantID string, e events.Outgoing) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	payload, err := json.Marshal(e.Payload)
	if err != nil {
		return err
	}
	headers, _ := json.Marshal(map[string]string{"event_id": id.String(), "tenant_id": tenantID})
	_, err = tx.Exec(ctx, `INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id, topic, payload, headers)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
		id.String(), tenantID, e.AggregateType, e.AggregateID, e.Topic, string(payload), string(headers))
	return err
}

// IsCheckViolation reports a CHECK or NOT NULL violation.
func IsCheckViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && (pg.Code == "23514" || pg.Code == "23502")
}

// IsUniqueViolation reports a unique-key violation.
func IsUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}
