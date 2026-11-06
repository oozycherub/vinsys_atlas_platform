package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"atlas.dev/go-platform/pgtx"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

type tenantRepo struct {
	tx     pgx.Tx
	tenant string
}

const bundleCols = `question_id, question_version, object_key, checksum, test_count, sample_count, checker,
  checker_language_id, checker_source, limits, languages, reference_language_id, reference_source,
  status, status_detail, verified_at, created_at`

func scanBundle(row pgx.Row, tenant string) (*app.Bundle, error) {
	var b app.Bundle
	var checksum []byte
	var checker, limits []byte
	var checkerLang *int16
	var refLang int16
	if err := row.Scan(&b.QuestionID, &b.Version, &b.ObjectKey, &checksum, &b.TestCount, &b.SampleCount, &checker,
		&checkerLang, &b.CheckerSource, &limits, &b.Languages, &refLang, &b.ReferenceSource,
		&b.Status, &b.StatusDetail, &b.VerifiedAt, &b.CreatedAt); err != nil {
		return nil, notFound(err)
	}
	b.TenantID = tenant
	copy(b.Checksum[:], checksum)
	b.ReferenceLangID = int(refLang)
	if checkerLang != nil {
		v := int(*checkerLang)
		b.CheckerLanguageID = &v
	}
	if err := json.Unmarshal(checker, &b.Checker); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(limits, &b.Limits); err != nil {
		return nil, err
	}
	return &b, nil
}

func (r *tenantRepo) GetBundle(ctx context.Context, questionID string, version int) (*app.Bundle, error) {
	if !IsUUID(questionID) {
		return nil, app.ErrNotFound
	}
	return scanBundle(r.tx.QueryRow(ctx, `SELECT `+bundleCols+` FROM test_case_bundles
		WHERE tenant_id = current_tenant_id() AND question_id = $1 AND question_version = $2`, questionID, version), r.tenant)
}

func (r *tenantRepo) UpsertBundle(ctx context.Context, b app.Bundle) error {
	checker, _ := json.Marshal(b.Checker)
	limits, _ := json.Marshal(b.Limits)
	_, err := r.tx.Exec(ctx, `
		INSERT INTO test_case_bundles (tenant_id, question_id, question_version, object_key, checksum, test_count,
		  sample_count, checker, checker_language_id, checker_source, limits, languages, reference_language_id,
		  reference_source, status, status_detail, verified_at, created_at)
		VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13, 'pending', NULL, NULL, $14)
		ON CONFLICT (tenant_id, question_id, question_version) DO UPDATE SET
		  object_key = EXCLUDED.object_key, checksum = EXCLUDED.checksum, test_count = EXCLUDED.test_count,
		  sample_count = EXCLUDED.sample_count, checker = EXCLUDED.checker,
		  checker_language_id = EXCLUDED.checker_language_id, checker_source = EXCLUDED.checker_source,
		  limits = EXCLUDED.limits, languages = EXCLUDED.languages,
		  reference_language_id = EXCLUDED.reference_language_id, reference_source = EXCLUDED.reference_source,
		  status = 'pending', status_detail = NULL, verified_at = NULL
		WHERE test_case_bundles.status <> 'verified'`,
		b.QuestionID, b.Version, b.ObjectKey, b.Checksum[:], b.TestCount, b.SampleCount, string(checker),
		b.CheckerLanguageID, b.CheckerSource, string(limits), b.Languages, b.ReferenceLangID, b.ReferenceSource, b.CreatedAt)
	return err
}

func (r *tenantRepo) SetBundleStatus(ctx context.Context, questionID string, version int, status string, detail *string, at time.Time) error {
	_, err := r.tx.Exec(ctx, `UPDATE test_case_bundles SET status = $3::bundle_status, status_detail = $4,
		verified_at = CASE WHEN $3 = 'verified' THEN $5::timestamptz END
		WHERE tenant_id = current_tenant_id() AND question_id = $1 AND question_version = $2 AND status = 'pending'`,
		questionID, version, status, detail, at)
	return err
}

const subCols = `tenant_id, submission_id, session_id, assessment_id, candidate_id, question_id, question_version,
  language_id, mode, lane, idempotency_key, source_code, source_sha256, stdin, status, status_detail, tests_passed,
  tests_total, score_ratio, max_cpu_time_ms, max_memory_kb, compile_output, run_stdout, run_stderr, worker_id,
  attempt_count, similarity_max, similar_submission_id, queued_at, started_at, finished_at`

func scanSubmission(row pgx.Row) (*app.Submission, error) {
	var s app.Submission
	var lang int16
	var mode, lane, status string
	var sha []byte
	var passed, total *int16
	if err := row.Scan(&s.TenantID, &s.ID, &s.SessionID, &s.AssessmentID, &s.CandidateID, &s.QuestionID, &s.QuestionVersion,
		&lang, &mode, &lane, &s.IdempotencyKey, &s.Source, &sha, &s.Stdin, &status, &s.StatusDetail, &passed,
		&total, &s.ScoreRatio, &s.MaxCPUms, &s.MaxMemoryKB, &s.CompileOutput, &s.RunStdout, &s.RunStderr, &s.WorkerID,
		&s.AttemptCount, &s.SimilarityMax, &s.SimilarID, &s.QueuedAt, &s.StartedAt, &s.FinishedAt); err != nil {
		return nil, notFound(err)
	}
	s.LanguageID, s.Mode, s.Lane, s.Status = int(lang), mode, domain.Lane(lane), domain.Verdict(status)
	copy(s.SourceSHA256[:], sha)
	if passed != nil {
		v := int(*passed)
		s.TestsPassed = &v
	}
	if total != nil {
		v := int(*total)
		s.TestsTotal = &v
	}
	return &s, nil
}

func (r *tenantRepo) InsertSubmission(ctx context.Context, s app.Submission) (app.Submission, bool, error) {
	tag, err := r.tx.Exec(ctx, `
		INSERT INTO coding_submissions (tenant_id, submission_id, session_id, assessment_id, candidate_id, question_id,
		  question_version, language_id, mode, lane, idempotency_key, source_code, source_sha256, stdin, status, queued_at)
		VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8::submission_mode, $9::judge_lane, $10, $11, $12, $13, 'queued', $14)
		ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
		s.ID, s.SessionID, s.AssessmentID, s.CandidateID, s.QuestionID, s.QuestionVersion, s.LanguageID, s.Mode,
		string(s.Lane), s.IdempotencyKey, s.Source, s.SourceSHA256[:], s.Stdin, s.QueuedAt)
	if err != nil {
		return app.Submission{}, false, err
	}
	created := tag.RowsAffected() == 1
	got, err := scanSubmission(r.tx.QueryRow(ctx, `SELECT `+subCols+` FROM coding_submissions
		WHERE tenant_id = current_tenant_id() AND idempotency_key = $1`, s.IdempotencyKey))
	if err != nil {
		return app.Submission{}, false, err
	}
	return *got, created, nil
}

func (r *tenantRepo) GetSubmission(ctx context.Context, id string) (*app.Submission, error) {
	if !IsUUID(id) {
		return nil, app.ErrNotFound
	}
	return scanSubmission(r.tx.QueryRow(ctx, `SELECT `+subCols+` FROM coding_submissions
		WHERE tenant_id = current_tenant_id() AND submission_id = $1`, id))
}

func (r *tenantRepo) LockSession(ctx context.Context, sessionID string) error {
	_, err := r.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('sandbox-run:' || $1, 0))`, sessionID)
	return err
}

func (r *tenantRepo) LastRunAt(ctx context.Context, sessionID string) (*time.Time, error) {
	var at *time.Time
	err := r.tx.QueryRow(ctx, `SELECT max(queued_at) FROM coding_submissions
		WHERE tenant_id = current_tenant_id() AND session_id = $1 AND mode = 'run'`, sessionID).Scan(&at)
	return at, err
}

// Complete finishes a running job. With a worker id, the worker must still hold the lease; with
// an empty id (the reaper), the lease must have expired.
func (r *tenantRepo) Complete(ctx context.Context, id, workerID string, c app.Completion, at time.Time) (bool, error) {
	s := c.Summary
	// An internal error has no score (never charged); every other verdict records one.
	var passed, total *int
	var ratio *float64
	if s.Verdict != domain.InternalError {
		passed, total, ratio = &s.TestsPassed, &s.TestsTotal, &s.Ratio
	}
	var maxCPU, maxMem *int
	if len(c.Cases) > 0 {
		maxCPU, maxMem = &s.MaxCPUms, &s.MaxMemoryKB
	}
	tag, err := r.tx.Exec(ctx, `
		UPDATE coding_submissions SET status = $3::judge_verdict, status_detail = $4, tests_passed = $5, tests_total = $6,
		  score_ratio = $7, max_cpu_time_ms = $8, max_memory_kb = $9, compile_output = $10, run_stdout = $11,
		  run_stderr = $12, finished_at = $13, lease_until = NULL
		WHERE tenant_id = current_tenant_id() AND submission_id = $1 AND status = 'running'
		  AND (($2 <> '' AND worker_id = $2) OR ($2 = '' AND lease_until < $13))`,
		id, workerID, string(s.Verdict), c.Detail, passed, total, ratio, maxCPU, maxMem,
		c.CompileOutput, c.RunStdout, c.RunStderr, at)
	if err != nil || tag.RowsAffected() == 0 {
		return false, err
	}
	batch := &pgx.Batch{}
	for i, cr := range c.Cases {
		var stdout *string
		if cr.Stdout != "" {
			stdout = &cr.Stdout
		}
		var detail *string
		if cr.Detail != "" {
			detail = &cr.Detail
		}
		w := cr.Weight
		if w <= 0 {
			w = 1
		}
		batch.Queue(`INSERT INTO coding_test_results (tenant_id, submission_id, test_case_id, ordinal, is_hidden, verdict,
			detail, cpu_time_ms, wall_time_ms, memory_kb, exit_code, signal, stdout_excerpt, weight)
			VALUES (current_tenant_id(), $1, $2, $3, $4, $5::judge_verdict, $6, $7, $8, $9, $10, $11, $12, $13)`,
			id, cr.TestCaseID, i+1, cr.Hidden, string(cr.Verdict), detail, cr.CPUms, cr.WallMs, cr.MemoryKB,
			cr.ExitCode, cr.Signal, stdout, w)
	}
	if batch.Len() > 0 {
		if err := r.tx.SendBatch(ctx, batch).Close(); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (r *tenantRepo) Results(ctx context.Context, id string) ([]domain.CaseResult, error) {
	rows, err := r.tx.Query(ctx, `SELECT test_case_id, is_hidden, weight, verdict, coalesce(detail, ''), cpu_time_ms,
		wall_time_ms, memory_kb, exit_code, signal, coalesce(stdout_excerpt, '')
		FROM coding_test_results WHERE tenant_id = current_tenant_id() AND submission_id = $1 ORDER BY ordinal`, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.CaseResult, error) {
		var c domain.CaseResult
		var verdict string
		var cpu, wall, mem, exit *int
		var sig *int16
		err := row.Scan(&c.TestCaseID, &c.Hidden, &c.Weight, &verdict, &c.Detail, &cpu, &wall, &mem, &exit, &sig, &c.Stdout)
		c.Verdict = domain.Verdict(verdict)
		c.CPUms, c.WallMs, c.MemoryKB, c.ExitCode = val(cpu), val(wall), val(mem), exit
		if sig != nil {
			v := int(*sig)
			c.Signal = &v
		}
		return c, err
	})
}

func val(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func (r *tenantRepo) InsertFingerprint(ctx context.Context, assessmentID, questionID string, f app.Fingerprint) error {
	_, err := r.tx.Exec(ctx, `INSERT INTO code_fingerprints (tenant_id, submission_id, assessment_id, question_id, session_id, hashes)
		VALUES (current_tenant_id(), $1, $2, $3, $4, $5) ON CONFLICT (submission_id) DO NOTHING`,
		f.SubmissionID, assessmentID, questionID, f.SessionID, f.Hashes)
	return err
}

func (r *tenantRepo) Fingerprints(ctx context.Context, assessmentID, questionID, excludeSession string) ([]app.Fingerprint, error) {
	rows, err := r.tx.Query(ctx, `SELECT submission_id, session_id, hashes FROM code_fingerprints
		WHERE tenant_id = current_tenant_id() AND assessment_id = $1 AND question_id = $2 AND session_id <> $3`,
		assessmentID, questionID, excludeSession)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (app.Fingerprint, error) {
		var f app.Fingerprint
		err := row.Scan(&f.SubmissionID, &f.SessionID, &f.Hashes)
		return f, err
	})
}

func (r *tenantRepo) SetSimilarity(ctx context.Context, id string, similarity float64, otherID string) error {
	_, err := r.tx.Exec(ctx, `UPDATE coding_submissions SET similarity_max = round($2::numeric, 3), similar_submission_id = $3
		WHERE tenant_id = current_tenant_id() AND submission_id = $1`, id, similarity, otherID)
	return err
}

func (r *tenantRepo) DeleteCandidate(ctx context.Context, candidateID string) (int, error) {
	tag, err := r.tx.Exec(ctx, `DELETE FROM coding_submissions WHERE tenant_id = current_tenant_id() AND candidate_id = $1`, candidateID)
	return int(tag.RowsAffected()), err
}

func (r *tenantRepo) PurgeTenant(ctx context.Context) ([]string, error) {
	rows, err := r.tx.Query(ctx, `DELETE FROM test_case_bundles WHERE tenant_id = current_tenant_id() RETURNING object_key`)
	if err != nil {
		return nil, err
	}
	keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	if _, err := r.tx.Exec(ctx, `DELETE FROM coding_submissions WHERE tenant_id = current_tenant_id()`); err != nil {
		return nil, err
	}
	return keys, nil
}

func (r *tenantRepo) AppendOutbox(ctx context.Context, tenantID string, e app.Event) error {
	return pgtx.AppendOutbox(ctx, r.tx, tenantID, e)
}

type systemRepo struct{ tx pgx.Tx }

func (r *systemRepo) Languages(ctx context.Context) ([]domain.Language, error) {
	rows, err := r.tx.Query(ctx, `SELECT language_id, slug, name, image_digest, source_file, coalesce(compile_cmd, ''),
		run_cmd, cpu_multiplier::float8, mem_multiplier::float8, is_enabled FROM sandbox_languages ORDER BY language_id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Language, error) {
		var l domain.Language
		var id int16
		err := row.Scan(&id, &l.Slug, &l.Name, &l.ImageDigest, &l.SourceFile, &l.CompileCmd, &l.RunCmd,
			&l.CPUMultiplier, &l.MemMultiplier, &l.Enabled)
		l.ID = int(id)
		return l, err
	})
}

func (r *systemRepo) QueueHeads(ctx context.Context, languageIDs []int) ([]app.QueueHead, error) {
	rows, err := r.tx.Query(ctx, `SELECT DISTINCT lane::text, tenant_id FROM coding_submissions
		WHERE status = 'queued' AND language_id = ANY($1::smallint[])`, languageIDs)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (app.QueueHead, error) {
		var h app.QueueHead
		var lane string
		err := row.Scan(&lane, &h.TenantID)
		h.Lane = domain.Lane(lane)
		return h, err
	})
}

func (r *systemRepo) Claim(ctx context.Context, lane domain.Lane, tenantID string, languageIDs []int, workerID string, leaseUntil time.Time) (*app.Submission, error) {
	s, err := scanSubmission(r.tx.QueryRow(ctx, `
		UPDATE coding_submissions SET status = 'running', worker_id = $4, lease_until = $5,
		  attempt_count = attempt_count + 1, started_at = coalesce(started_at, now())
		WHERE submission_id = (
		  SELECT submission_id FROM coding_submissions
		  WHERE status = 'queued' AND lane = $1::judge_lane AND tenant_id = $2 AND language_id = ANY($3::smallint[])
		  ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING `+subCols, string(lane), tenantID, languageIDs, workerID, leaseUntil))
	if errors.Is(err, app.ErrNotFound) {
		return nil, nil
	}
	return s, err
}

func (r *systemRepo) Heartbeat(ctx context.Context, id, workerID string, leaseUntil time.Time) (bool, error) {
	tag, err := r.tx.Exec(ctx, `UPDATE coding_submissions SET lease_until = $3
		WHERE submission_id = $1 AND worker_id = $2 AND status = 'running'`, id, workerID, leaseUntil)
	return tag.RowsAffected() == 1, err
}

func (r *systemRepo) Release(ctx context.Context, id, workerID string) error {
	_, err := r.tx.Exec(ctx, `UPDATE coding_submissions SET status = 'queued', worker_id = NULL, lease_until = NULL
		WHERE submission_id = $1 AND worker_id = $2 AND status = 'running'`, id, workerID)
	return err
}

func (r *systemRepo) Expired(ctx context.Context, now time.Time) ([]app.ExpiredJob, error) {
	rows, err := r.tx.Query(ctx, `SELECT tenant_id, submission_id, attempt_count FROM coding_submissions
		WHERE status = 'running' AND lease_until < $1 ORDER BY lease_until LIMIT 500`, now)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (app.ExpiredJob, error) {
		var j app.ExpiredJob
		err := row.Scan(&j.TenantID, &j.ID, &j.Attempts)
		return j, err
	})
}

func (r *systemRepo) Requeue(ctx context.Context, id string, now time.Time) (bool, error) {
	tag, err := r.tx.Exec(ctx, `UPDATE coding_submissions SET status = 'queued', worker_id = NULL, lease_until = NULL
		WHERE submission_id = $1 AND status = 'running' AND lease_until < $2`, id, now)
	return tag.RowsAffected() == 1, err
}

func (r *systemRepo) PurgeRuns(ctx context.Context, before time.Time) (int, error) {
	tag, err := r.tx.Exec(ctx, `DELETE FROM coding_submissions WHERE mode = 'run' AND queued_at < $1
		AND status NOT IN ('queued', 'running')`, before)
	return int(tag.RowsAffected()), err
}

func (r *systemRepo) MarkDemand(ctx context.Context, languageIDs []int, at time.Time) error {
	if len(languageIDs) == 0 {
		return nil
	}
	_, err := r.tx.Exec(ctx, `INSERT INTO sandbox_language_demand (language_id, last_published_at)
		SELECT unnest($1::smallint[]), $2
		ON CONFLICT (language_id) DO UPDATE SET last_published_at = greatest(sandbox_language_demand.last_published_at, EXCLUDED.last_published_at)`,
		languageIDs, at)
	return err
}

func (r *systemRepo) FirstDelivery(ctx context.Context, consumer, eventID string) (bool, error) {
	return pgtx.FirstDelivery(ctx, r.tx, consumer, eventID)
}
