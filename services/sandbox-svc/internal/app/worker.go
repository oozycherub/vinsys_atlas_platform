package app

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"atlas.dev/sandbox-svc/internal/domain"
)

// Queue timing (PRD §2.2c step 4).
const (
	LeaseTTL          = 60 * time.Second
	HeartbeatInterval = 10 * time.Second
	MaxAttempts       = 3
)

// Topics this service produces.
const (
	TopicJudged    = "sandbox.submission.judged.v1"
	TopicViolation = "proctoring.violation.raised.v1"
)

// BundleCache loads test cases by object key and checks their checksum (cached on the node).
type BundleCache interface {
	Load(ctx context.Context, key string, checksum [32]byte) (domain.BundleContent, error)
}

// Worker claims jobs fairly and judges them.
type Worker struct {
	ID        string
	Store     Store
	Bundles   BundleCache
	Judge     *Judge
	Clock     Clock
	Log       *slog.Logger
	Languages map[int]domain.Language // the languages this worker's image serves
	// TenantWeight gives a tenant's share (by plan); nil means equal shares.
	TenantWeight func(tenantID string) int

	lanes   *domain.FairScheduler
	tenants map[domain.Lane]*domain.FairScheduler
}

func (w *Worker) init() {
	if w.lanes != nil {
		return
	}
	w.lanes = domain.NewFairScheduler(func(k string) int { return domain.LaneWeights[k] })
	w.tenants = map[domain.Lane]*domain.FairScheduler{}
	if w.TenantWeight == nil {
		w.TenantWeight = func(string) int { return 1 }
	}
}

func (w *Worker) languageIDs() []int {
	ids := make([]int, 0, len(w.Languages))
	for id := range w.Languages {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}

// RunOnce claims and processes at most one job. It reports whether there was work.
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	w.init()
	var job *Submission
	err := w.Store.InSystem(ctx, func(r SystemRepo) error {
		heads, err := r.QueueHeads(ctx, w.languageIDs())
		if err != nil || len(heads) == 0 {
			return err
		}
		byLane := map[domain.Lane][]string{}
		var lanes []string
		for _, h := range heads {
			if _, seen := byLane[h.Lane]; !seen {
				lanes = append(lanes, string(h.Lane))
			}
			byLane[h.Lane] = append(byLane[h.Lane], h.TenantID)
		}
		lane := domain.Lane(w.lanes.Pick(lanes))
		sched := w.tenants[lane]
		if sched == nil {
			sched = domain.NewFairScheduler(w.TenantWeight)
			w.tenants[lane] = sched
		}
		tenant := sched.Pick(byLane[lane])
		job, err = r.Claim(ctx, lane, tenant, w.languageIDs(), w.ID, w.Clock.Now().Add(LeaseTTL))
		return err
	})
	if err != nil || job == nil {
		return job != nil, err
	}
	w.process(ctx, *job)
	return true, nil
}

// Run loops until ctx ends, sleeping briefly when the queue is empty.
func (w *Worker) Run(ctx context.Context, idle time.Duration) {
	for ctx.Err() == nil {
		worked, err := w.RunOnce(ctx)
		if err != nil {
			w.Log.Error("claim failed", "err", err)
		}
		if !worked || err != nil {
			select {
			case <-ctx.Done():
			case <-time.After(idle):
			}
		}
	}
}

func (w *Worker) process(ctx context.Context, job Submission) {
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go w.heartbeat(jobCtx, cancel, job.ID)
	log := w.Log.With("submission_id", job.ID, "tenant_id", job.TenantID, "mode", job.Mode, "attempt", job.AttemptCount)

	completion, verifyStatus, err := w.execute(jobCtx, job)
	if jobCtx.Err() != nil && ctx.Err() == nil {
		log.Warn("lease lost; another worker will retry")
		return
	}
	var sandboxErr *ErrSandbox
	if errors.As(err, &sandboxErr) {
		if job.AttemptCount < MaxAttempts {
			log.Warn("sandbox fault; job released", "err", err)
			if rerr := w.Store.InSystem(ctx, func(r SystemRepo) error { return r.Release(ctx, job.ID, w.ID) }); rerr != nil {
				log.Error("release failed", "err", rerr)
			}
			return
		}
		log.Error("sandbox fault on the last attempt; internal_error (not charged)", "err", err)
		completion, verifyStatus, err = internalError(), "reference_failed", nil
	}
	if err != nil {
		log.Error("job failed", "err", err)
		return
	}
	if err := w.finish(ctx, job, completion, verifyStatus); err != nil {
		log.Error("completion failed", "err", err)
	}
}

func internalError() Completion {
	detail := "INTERNAL_ERROR"
	return Completion{Summary: domain.Summary{Verdict: domain.InternalError}, Detail: &detail}
}

func (w *Worker) heartbeat(ctx context.Context, lost context.CancelFunc, id string) {
	t := time.NewTicker(HeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			var held bool
			err := w.Store.InSystem(ctx, func(r SystemRepo) (err error) {
				held, err = r.Heartbeat(ctx, id, w.ID, w.Clock.Now().Add(LeaseTTL))
				return err
			})
			if err == nil && !held {
				lost()
				return
			}
		}
	}
}

// execute judges the job. verifyStatus is set for reference verifications.
func (w *Worker) execute(ctx context.Context, job Submission) (Completion, string, error) {
	var bundle *Bundle
	err := w.Store.InTenant(ctx, job.TenantID, func(r TenantRepo) (err error) {
		bundle, err = r.GetBundle(ctx, job.QuestionID, job.QuestionVersion)
		return err
	})
	if err != nil {
		return Completion{}, "", &ErrSandbox{Cause: fmt.Errorf("load bundle: %w", err)}
	}
	lang, ok := w.Languages[job.LanguageID]
	if !ok {
		return Completion{}, "", &ErrSandbox{Cause: fmt.Errorf("language %d not served here", job.LanguageID)}
	}
	content, err := w.Bundles.Load(ctx, bundle.ObjectKey, bundle.Checksum)
	if err != nil {
		return Completion{}, "", &ErrSandbox{Cause: fmt.Errorf("load test cases: %w", err)}
	}
	in := JudgeInput{Lang: lang, Overrides: bundle.Limits, Source: job.Source, Compare: true, Checker: bundle.Checker}
	if bundle.Checker.Kind == domain.CheckCustom && bundle.CheckerLanguageID != nil && bundle.CheckerSource != nil {
		cl, ok := w.Languages[*bundle.CheckerLanguageID]
		if !ok {
			return Completion{}, "", &ErrSandbox{Cause: fmt.Errorf("checker language %d not served here", *bundle.CheckerLanguageID)}
		}
		in.CustomChecker = &CustomChecker{Lang: cl, Source: *bundle.CheckerSource}
	}

	switch job.Mode {
	case "run":
		in.KeepOutput = true
		if job.Stdin != nil {
			in.Cases, in.Compare = []domain.TestCase{{ID: "stdin", Input: *job.Stdin}}, false
		} else {
			for _, tc := range content.Tests {
				if !tc.Hidden {
					in.Cases = append(in.Cases, tc)
				}
			}
			if len(in.Cases) == 0 {
				in.Cases, in.Compare = []domain.TestCase{{ID: "empty"}}, false
			}
		}
		out, err := w.Judge.Run(ctx, in)
		return completionOf(out), "", err
	case "verify":
		in.Cases = content.Tests
		var runs [][]domain.Verdict
		var last JudgeOutput
		for i := 0; i < domain.VerifyRuns; i++ {
			out, err := w.Judge.Run(ctx, in)
			if err != nil {
				return Completion{}, "", err
			}
			verdicts := make([]domain.Verdict, len(out.Cases))
			for k, c := range out.Cases {
				verdicts[k] = c.Verdict
			}
			if out.Summary.Verdict == domain.CompilationError {
				verdicts = []domain.Verdict{domain.CompilationError}
			}
			runs, last = append(runs, verdicts), out
		}
		status, detail := domain.VerifyOutcome(runs)
		if status == "" {
			return Completion{}, "", fault("verification hit a sandbox fault")
		}
		c := completionOf(last)
		if detail != "" {
			c.Detail = &detail
		}
		return c, status, nil
	default: // submit
		in.Cases = content.Tests
		out, err := w.Judge.Run(ctx, in)
		return completionOf(out), "", err
	}
}

func completionOf(out JudgeOutput) Completion {
	return Completion{Summary: out.Summary, Cases: out.Cases, CompileOutput: out.CompileOutput, RunStdout: out.Stdout, RunStderr: out.Stderr}
}

// finish writes results, the verdict and the event in one transaction (PRD §2.2c step 5).
func (w *Worker) finish(ctx context.Context, job Submission, c Completion, verifyStatus string) error {
	now := w.Clock.Now()
	var done bool
	err := w.Store.InTenant(ctx, job.TenantID, func(r TenantRepo) (err error) {
		done, err = r.Complete(ctx, job.ID, w.ID, c, now)
		if err != nil || !done {
			return err
		}
		switch job.Mode {
		case "verify":
			return r.SetBundleStatus(ctx, job.QuestionID, job.QuestionVersion, verifyStatus, c.Detail, now)
		case "submit":
			return r.AppendOutbox(ctx, job.TenantID, judgedEvent(job, c.Summary, now))
		}
		return nil
	})
	if err != nil || !done || job.Mode != "submit" || c.Summary.Verdict == domain.InternalError {
		return err
	}
	return w.checkSimilarity(ctx, job)
}

func judgedEvent(job Submission, s domain.Summary, now time.Time) Event {
	return Event{
		Topic: TopicJudged, AggregateType: "submission", AggregateID: job.ID,
		Payload: map[string]any{
			"tenant_id": job.TenantID, "session_id": deref(job.SessionID), "question_id": job.QuestionID,
			"submission_id": job.ID, "verdict": string(s.Verdict), "tests_passed": s.TestsPassed,
			"tests_total": s.TestsTotal, "score_ratio": s.Ratio,
			"submitted_at": job.QueuedAt.UTC().Format(time.RFC3339Nano), "judged_at": now.UTC().Format(time.RFC3339Nano),
		},
	}
}

// checkSimilarity fingerprints the submission and compares it with other sessions' submissions
// of the same assessment question (PRD §2.2b, plagiarism). Above the threshold both sessions
// are flagged for human review: a signal, never an automatic fail.
func (w *Worker) checkSimilarity(ctx context.Context, job Submission) error {
	if job.AssessmentID == nil || job.SessionID == nil {
		return nil
	}
	hashes := domain.Fingerprint(job.Source)
	if len(hashes) < domain.MinFingerprints {
		return nil
	}
	return w.Store.InTenant(ctx, job.TenantID, func(r TenantRepo) error {
		others, err := r.Fingerprints(ctx, *job.AssessmentID, job.QuestionID, *job.SessionID)
		if err != nil {
			return err
		}
		if err := r.InsertFingerprint(ctx, *job.AssessmentID, job.QuestionID, Fingerprint{SubmissionID: job.ID, SessionID: *job.SessionID, Hashes: hashes}); err != nil {
			return err
		}
		best, bestSession, bestID := 0.0, "", ""
		for _, o := range others {
			if s := domain.Similarity(hashes, o.Hashes); s > best {
				best, bestSession, bestID = s, o.SessionID, o.SubmissionID
			}
		}
		if bestID == "" {
			return nil
		}
		if err := r.SetSimilarity(ctx, job.ID, best, bestID); err != nil {
			return err
		}
		if best <= domain.SimilarityThreshold {
			return nil
		}
		now := w.Clock.Now().UTC().Format(time.RFC3339Nano)
		for _, session := range []string{*job.SessionID, bestSession} {
			if err := r.AppendOutbox(ctx, job.TenantID, Event{
				Topic: TopicViolation, AggregateType: "assessment_session", AggregateID: session,
				Payload: map[string]any{
					"tenant_id": job.TenantID, "session_id": session, "rule": "code_similarity",
					"severity": 2, "action": "review", "trust_score": nil, "occurred_at": now,
				},
			}); err != nil {
				return err
			}
		}
		return nil
	})
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// SourceHash is the sha256 of the source (stored; also the default idempotency material).
func SourceHash(source string) [32]byte { return sha256.Sum256([]byte(source)) }
