// Package postgres implements proctoring-svc's Store over pgx (tenant RLS, system transactions).
package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"atlas.dev/go-platform/events"
	"atlas.dev/go-platform/pgtx"

	"atlas.dev/proctoring-svc/internal/app"
)

// Store opens transactions on a pool connected as atlas_app.
type Store struct{ Pool *pgxpool.Pool }

// InTenant runs fn in the tenant's transaction.
func (s *Store) InTenant(ctx context.Context, tenantID string, fn func(app.TenantRepo) error) error {
	return pgtx.InTenant(ctx, s.Pool, tenantID, func(tx pgx.Tx) error {
		return fn(&tenantRepo{tx: tx, tenant: tenantID})
	})
}

// InSystem runs fn in a system transaction.
func (s *Store) InSystem(ctx context.Context, fn func(app.SystemRepo) error) error {
	return pgtx.InSystem(ctx, s.Pool, func(tx pgx.Tx) error { return fn(&systemRepo{tx: tx}) })
}

// InSystemThenTenant starts as a system transaction and may switch to one tenant.
func (s *Store) InSystemThenTenant(ctx context.Context, fn func(app.SystemRepo, func(string) (app.TenantRepo, error)) error) error {
	return pgtx.InSystem(ctx, s.Pool, func(tx pgx.Tx) error {
		bound := ""
		return fn(&systemRepo{tx: tx}, func(tenantID string) (app.TenantRepo, error) {
			if bound != "" && bound != tenantID {
				return nil, errors.New("a transaction can serve one tenant")
			}
			if err := pgtx.SetTenant(ctx, tx, tenantID); err != nil {
				return nil, err
			}
			bound = tenantID
			return &tenantRepo{tx: tx, tenant: tenantID}, nil
		})
	})
}

// Ping checks connectivity.
func (s *Store) Ping(ctx context.Context) error { return s.Pool.Ping(ctx) }

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return app.ErrNotFound
	}
	return err
}

type tenantRepo struct {
	tx     pgx.Tx
	tenant string
}

const sessionCols = `tenant_id::text, session_id::text, assessment_id::text, candidate_id::text, status,
  proctor_token_hash, key_ring, current_epoch, rules, disabled_rules, consent, id_verification,
  reference_embeddings, reference_status, last_seq, coalesce(last_client_hash, ''), last_log_hash, state,
  trust_score, band, revision, started_at, last_event_at, submitted_at, finalized_at, frames_purged_at, lock_version`

func scanSession(row pgx.Row) (*app.Session, error) {
	var s app.Session
	var keyRing, rules, consent, state []byte
	var score *int16
	if err := row.Scan(&s.TenantID, &s.ID, &s.AssessmentID, &s.CandidateID, &s.Status, &s.TokenHash, &keyRing,
		&s.CurrentEpoch, &rules, &s.DisabledRules, &consent, &s.IDVerification, &s.References, &s.ReferenceStatus,
		&s.LastSeq, &s.LastClientHash, &s.LastLogHash, &state, &score, &s.Band, &s.Revision, &s.StartedAt,
		&s.LastEventAt, &s.SubmittedAt, &s.FinalizedAt, &s.FramesPurgedAt, &s.LockVersion); err != nil {
		return nil, notFound(err)
	}
	if score != nil {
		v := int(*score)
		s.TrustScore = &v
	}
	for _, x := range []struct {
		raw []byte
		v   any
	}{{keyRing, &s.KeyRing}, {rules, &s.Rules}, {consent, &s.Consent}, {state, &s.State}} {
		if err := json.Unmarshal(x.raw, x.v); err != nil {
			return nil, err
		}
	}
	return &s, nil
}

func (r *tenantRepo) GetSession(ctx context.Context, id string, forUpdate bool) (*app.Session, error) {
	if !pgtx.IsUUID(id) {
		return nil, app.ErrNotFound
	}
	q := `SELECT ` + sessionCols + ` FROM proctoring_sessions WHERE tenant_id = current_tenant_id() AND session_id = $1`
	if forUpdate {
		q += ` FOR UPDATE`
	}
	return scanSession(r.tx.QueryRow(ctx, q, id))
}

func jsonOf(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func (r *tenantRepo) InsertSession(ctx context.Context, s *app.Session) error {
	_, err := r.tx.Exec(ctx, `INSERT INTO proctoring_sessions (tenant_id, session_id, assessment_id, candidate_id,
		  status, proctor_token_hash, key_ring, current_epoch, rules, disabled_rules, consent, id_verification,
		  reference_status, state, started_at)
		VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13::jsonb, $14)`,
		s.ID, s.AssessmentID, s.CandidateID, s.Status, s.TokenHash, jsonOf(s.KeyRing), s.CurrentEpoch, jsonOf(s.Rules),
		nonNil(s.DisabledRules), jsonOf(s.Consent), s.IDVerification, s.ReferenceStatus, jsonOf(s.State), s.StartedAt)
	return err
}

func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func (r *tenantRepo) SaveSession(ctx context.Context, s *app.Session) error {
	tag, err := r.tx.Exec(ctx, `UPDATE proctoring_sessions SET status = $3, proctor_token_hash = $4, key_ring = $5::jsonb,
		  current_epoch = $6, disabled_rules = $7, reference_embeddings = $8, reference_status = $9, last_seq = $10,
		  last_client_hash = nullif($11, ''), last_log_hash = $12, state = $13::jsonb, trust_score = $14, band = $15,
		  revision = $16, last_event_at = $17, submitted_at = $18, finalized_at = $19, frames_purged_at = $20,
		  clock_offset_ms = $21, lock_version = lock_version + 1
		WHERE tenant_id = current_tenant_id() AND session_id = $1 AND lock_version = $2`,
		s.ID, s.LockVersion, s.Status, s.TokenHash, jsonOf(s.KeyRing), s.CurrentEpoch, nonNil(s.DisabledRules),
		s.References, s.ReferenceStatus, s.LastSeq, s.LastClientHash, s.LastLogHash, jsonOf(s.State), s.TrustScore,
		s.Band, s.Revision, s.LastEventAt, s.SubmittedAt, s.FinalizedAt, s.FramesPurgedAt, s.State.Clock.OffsetMs)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return app.ErrConflict
	}
	s.LockVersion++
	return nil
}

func (r *tenantRepo) ClaimSeq(ctx context.Context, sessionID string, seq int64) (bool, error) {
	tag, err := r.tx.Exec(ctx, `INSERT INTO proctoring_event_seqs (tenant_id, session_id, seq) VALUES (current_tenant_id(), $1, $2)
		ON CONFLICT (session_id, seq) DO NOTHING`, sessionID, seq)
	return tag.RowsAffected() == 1, err
}

func (r *tenantRepo) AppendLog(ctx context.Context, s *app.Session, row *app.LogRow) error {
	row.SessionID = s.ID
	row.PrevHash = s.LastLogHash
	row.EventHash = app.LogHash(s.LastLogHash, row)
	if row.Payload == nil {
		row.Payload = map[string]any{}
	}
	err := r.tx.QueryRow(ctx, `INSERT INTO proctoring_logs (tenant_id, session_id, source, seq, event_type, severity,
		  occurred_at, received_at, frame_id, model_version, payload, prev_hash, event_hash)
		VALUES (current_tenant_id(), $1, $2::proctor_source, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
		RETURNING log_id`,
		row.SessionID, row.Source, row.Seq, row.EventType, row.Severity, row.OccurredAt, row.ReceivedAt, row.FrameID,
		row.ModelVersion, jsonOf(row.Payload), row.PrevHash, row.EventHash).Scan(&row.LogID)
	if err != nil {
		return err
	}
	s.LastLogHash = row.EventHash
	return nil
}

const logCols = `log_id, session_id::text, source::text, seq, event_type, severity, occurred_at, received_at,
  frame_id::text, model_version, payload, prev_hash, event_hash`

func scanLog(row pgx.Row) (app.LogRow, error) {
	var l app.LogRow
	var payload []byte
	if err := row.Scan(&l.LogID, &l.SessionID, &l.Source, &l.Seq, &l.EventType, &l.Severity, &l.OccurredAt,
		&l.ReceivedAt, &l.FrameID, &l.ModelVersion, &payload, &l.PrevHash, &l.EventHash); err != nil {
		return l, notFound(err)
	}
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	err := dec.Decode(&l.Payload)
	l.OccurredAt, l.ReceivedAt = l.OccurredAt.UTC(), l.ReceivedAt.UTC()
	return l, err
}

func (r *tenantRepo) GetLog(ctx context.Context, logID int64) (*app.LogRow, error) {
	l, err := scanLog(r.tx.QueryRow(ctx, `SELECT `+logCols+` FROM proctoring_logs WHERE tenant_id = current_tenant_id() AND log_id = $1`, logID))
	if err != nil {
		return nil, err
	}
	return &l, nil
}

func (r *tenantRepo) Logs(ctx context.Context, sessionID string, limit int) ([]app.LogRow, error) {
	rows, err := r.tx.Query(ctx, `SELECT `+logCols+` FROM proctoring_logs
		WHERE tenant_id = current_tenant_id() AND session_id = $1 ORDER BY log_id LIMIT $2`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (app.LogRow, error) { return scanLog(row) })
}

const frameCols = `tenant_id::text, frame_id::text, session_id::text, kind, object_key, captured_at, triggered, status,
  flagged, evidence_key, deleted_at`

func scanFrame(row pgx.Row) (app.Frame, error) {
	var f app.Frame
	err := row.Scan(&f.TenantID, &f.ID, &f.SessionID, &f.Kind, &f.ObjectKey, &f.CapturedAt, &f.Triggered, &f.Status,
		&f.Flagged, &f.EvidenceKey, &f.DeletedAt)
	f.CapturedAt = f.CapturedAt.UTC()
	return f, notFound(err)
}

func (r *tenantRepo) InsertFrame(ctx context.Context, f app.Frame) error {
	_, err := r.tx.Exec(ctx, `INSERT INTO proctoring_frames (tenant_id, frame_id, session_id, kind, object_key, captured_at, triggered, status)
		VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
		f.ID, f.SessionID, f.Kind, f.ObjectKey, f.CapturedAt, f.Triggered, f.Status)
	return err
}

func (r *tenantRepo) GetFrame(ctx context.Context, id string) (*app.Frame, error) {
	if !pgtx.IsUUID(id) {
		return nil, app.ErrNotFound
	}
	f, err := scanFrame(r.tx.QueryRow(ctx, `SELECT `+frameCols+` FROM proctoring_frames WHERE tenant_id = current_tenant_id() AND frame_id = $1 FOR UPDATE`, id))
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (r *tenantRepo) SaveFrame(ctx context.Context, f app.Frame) error {
	_, err := r.tx.Exec(ctx, `UPDATE proctoring_frames SET status = $2, flagged = $3, evidence_key = $4, deleted_at = $5, captured_at = $6
		WHERE tenant_id = current_tenant_id() AND frame_id = $1`, f.ID, f.Status, f.Flagged, f.EvidenceKey, f.DeletedAt, f.CapturedAt)
	return err
}

func (r *tenantRepo) Frames(ctx context.Context, sessionID string) ([]app.Frame, error) {
	rows, err := r.tx.Query(ctx, `SELECT `+frameCols+` FROM proctoring_frames WHERE tenant_id = current_tenant_id() AND session_id = $1 ORDER BY captured_at`, sessionID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (app.Frame, error) { return scanFrame(row) })
}

func (r *tenantRepo) CountFrames(ctx context.Context, sessionID string) (int, error) {
	var n int
	err := r.tx.QueryRow(ctx, `SELECT count(*) FROM proctoring_frames WHERE tenant_id = current_tenant_id() AND session_id = $1`, sessionID).Scan(&n)
	return n, err
}

func (r *tenantRepo) InsertReview(ctx context.Context, v app.Review) (bool, error) {
	tag, err := r.tx.Exec(ctx, `INSERT INTO proctoring_reviews (tenant_id, log_id, session_id, rule, decision, reviewer, comment, decided_at)
		VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) ON CONFLICT (log_id) DO NOTHING`,
		v.LogID, v.SessionID, v.Rule, v.Decision, v.Reviewer, v.Comment, v.DecidedAt)
	return tag.RowsAffected() == 1, err
}

func (r *tenantRepo) Reviews(ctx context.Context, sessionID string) ([]app.Review, error) {
	rows, err := r.tx.Query(ctx, `SELECT log_id, session_id::text, rule, decision, reviewer, comment, decided_at
		FROM proctoring_reviews WHERE tenant_id = current_tenant_id() AND session_id = $1 ORDER BY log_id`, sessionID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (app.Review, error) {
		var v app.Review
		err := row.Scan(&v.LogID, &v.SessionID, &v.Rule, &v.Decision, &v.Reviewer, &v.Comment, &v.DecidedAt)
		v.DecidedAt = v.DecidedAt.UTC()
		return v, err
	})
}

func (r *tenantRepo) GetAccommodation(ctx context.Context, sessionID string) (*app.Accommodation, error) {
	var a app.Accommodation
	err := r.tx.QueryRow(ctx, `SELECT session_id::text, disabled_rules, reason, granted_by, granted_at
		FROM proctoring_accommodations WHERE tenant_id = current_tenant_id() AND session_id = $1`, sessionID).
		Scan(&a.SessionID, &a.DisabledRules, &a.Reason, &a.GrantedBy, &a.GrantedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return &a, nil
}

func (r *tenantRepo) UpsertAccommodation(ctx context.Context, a app.Accommodation) error {
	_, err := r.tx.Exec(ctx, `INSERT INTO proctoring_accommodations (tenant_id, session_id, disabled_rules, reason, granted_by, granted_at)
		VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
		ON CONFLICT (session_id) DO UPDATE SET disabled_rules = EXCLUDED.disabled_rules, reason = EXCLUDED.reason,
		  granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at`,
		a.SessionID, a.DisabledRules, a.Reason, a.GrantedBy, a.GrantedAt)
	return err
}

func (r *tenantRepo) SessionsOfCandidate(ctx context.Context, candidateID string) ([]string, error) {
	rows, err := r.tx.Query(ctx, `SELECT session_id::text FROM proctoring_sessions WHERE tenant_id = current_tenant_id() AND candidate_id = $1`, candidateID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (r *tenantRepo) AllSessions(ctx context.Context) ([]string, error) {
	rows, err := r.tx.Query(ctx, `SELECT session_id::text FROM proctoring_sessions WHERE tenant_id = current_tenant_id()`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (r *tenantRepo) EraseSessions(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if _, err := r.tx.Exec(ctx, `SELECT proctoring_erase_sessions($1::uuid[])`, ids); err != nil {
		return err
	}
	for _, table := range []string{"proctoring_reviews", "proctoring_frames", "proctoring_event_seqs", "proctoring_accommodations", "proctoring_sessions"} {
		if _, err := r.tx.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = current_tenant_id() AND session_id = ANY($1::uuid[])`, ids); err != nil {
			return err
		}
	}
	return nil
}

func (r *tenantRepo) AppendOutbox(ctx context.Context, e events.Outgoing) error {
	return pgtx.AppendOutbox(ctx, r.tx, r.tenant, e)
}

type systemRepo struct{ tx pgx.Tx }

func (r *systemRepo) SessionByToken(ctx context.Context, sessionID string, tokenHash []byte) (string, error) {
	if !pgtx.IsUUID(sessionID) {
		return "", app.ErrNotFound
	}
	var tenant string
	err := r.tx.QueryRow(ctx, `SELECT tenant_id::text FROM proctoring_sessions WHERE session_id = $1 AND proctor_token_hash = $2`,
		sessionID, tokenHash).Scan(&tenant)
	return tenant, notFound(err)
}

func (r *systemRepo) FirstDelivery(ctx context.Context, consumer, eventID string) (bool, error) {
	return pgtx.FirstDelivery(ctx, r.tx, consumer, eventID)
}

func (r *systemRepo) sessions(ctx context.Context, where string, args ...any) ([]app.Session, error) {
	rows, err := r.tx.Query(ctx, `SELECT `+sessionCols+` FROM proctoring_sessions WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (app.Session, error) {
		s, err := scanSession(row)
		if err != nil {
			return app.Session{}, err
		}
		return *s, nil
	})
}

func (r *systemRepo) RetentionDue(ctx context.Context, limit int) ([]app.Session, error) {
	return r.sessions(ctx, `status = 'finalized' AND frames_purged_at IS NULL ORDER BY finalized_at LIMIT $1`, limit)
}

func (r *systemRepo) Silent(ctx context.Context, before time.Time, limit int) ([]app.Session, error) {
	return r.sessions(ctx, `status = 'active' AND coalesce(last_event_at, started_at) < $1
		AND coalesce((state->>'network_gap')::boolean, false) = false ORDER BY last_event_at LIMIT $2`, before, limit)
}

func (r *systemRepo) EvidencePending(ctx context.Context, limit int) ([]app.Session, error) {
	return r.sessions(ctx, `status = 'finalized' AND EXISTS (SELECT 1 FROM proctoring_frames f
		WHERE f.session_id = proctoring_sessions.session_id AND f.flagged AND f.evidence_key IS NULL AND f.deleted_at IS NULL)
		LIMIT $1`, limit)
}

func (r *systemRepo) EnsurePartitions(ctx context.Context, monthsAhead int) (int, error) {
	var n int
	err := r.tx.QueryRow(ctx, `SELECT proctoring_ensure_partitions($1)`, monthsAhead).Scan(&n)
	return n, err
}

func (r *systemRepo) DropPartitions(ctx context.Context, before time.Time) ([]string, error) {
	var dropped []string
	err := r.tx.QueryRow(ctx, `SELECT proctoring_drop_partitions($1::date)`, before.Format("2006-01-02")).Scan(&dropped)
	return dropped, err
}
