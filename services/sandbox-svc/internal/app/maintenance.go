package app

import (
	"context"
	"log/slog"
	"time"
)

// RunRetention: runs are not kept beyond 24 h (PRD §2.2b "Two modes").
const RunRetention = 24 * time.Hour

// Maintenance re-queues jobs whose worker died and purges old runs.
type Maintenance struct {
	Store Store
	Clock Clock
	Log   *slog.Logger
}

// Tick runs one pass. Jobs whose lease expired go back to the queue; after the third attempt
// they end as internal_error, which is never charged to the candidate (PRD §2.2d).
func (m *Maintenance) Tick(ctx context.Context) (requeued, failed, purged int, err error) {
	now := m.Clock.Now()
	var expired []ExpiredJob
	err = m.Store.InSystem(ctx, func(r SystemRepo) (err error) {
		if expired, err = r.Expired(ctx, now); err != nil {
			return err
		}
		for _, j := range expired {
			if j.Attempts >= MaxAttempts {
				continue
			}
			ok, err := r.Requeue(ctx, j.ID, now)
			if err != nil {
				return err
			}
			if ok {
				requeued++
			}
		}
		purged, err = r.PurgeRuns(ctx, now.Add(-RunRetention))
		return err
	})
	if err != nil {
		return requeued, failed, purged, err
	}
	for _, j := range expired {
		if j.Attempts < MaxAttempts {
			continue
		}
		ok, err := m.fail(ctx, j, now)
		if err != nil {
			return requeued, failed, purged, err
		}
		if ok {
			failed++
			m.Log.Error("job failed after the last attempt; internal_error (on-call alert)", "submission_id", j.ID, "tenant_id", j.TenantID)
		}
	}
	return requeued, failed, purged, nil
}

func (m *Maintenance) fail(ctx context.Context, j ExpiredJob, now time.Time) (bool, error) {
	var done bool
	err := m.Store.InTenant(ctx, j.TenantID, func(r TenantRepo) error {
		job, err := r.GetSubmission(ctx, j.ID)
		if err != nil {
			return err
		}
		c := internalError()
		if done, err = r.Complete(ctx, j.ID, "", c, now); err != nil || !done {
			return err
		}
		switch job.Mode {
		case "submit":
			return r.AppendOutbox(ctx, j.TenantID, judgedEvent(*job, c.Summary, now))
		case "verify":
			return r.SetBundleStatus(ctx, job.QuestionID, job.QuestionVersion, "reference_failed", c.Detail, now)
		}
		return nil
	})
	return done, err
}

// Run ticks until ctx ends.
func (m *Maintenance) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, _, _, err := m.Tick(ctx); err != nil {
				m.Log.Error("maintenance failed", "err", err)
			}
		}
	}
}
