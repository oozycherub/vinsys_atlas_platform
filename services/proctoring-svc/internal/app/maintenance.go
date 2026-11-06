package app

import (
	"context"
	"time"
)

// Maintenance settings.
const (
	PartitionsAhead = 3                // months (PRD: premake = 3)
	NetworkGapAfter = 30 * time.Second // no events for 30 s: network_gap (not a violation)
)

// Maintenance runs the periodic jobs.
type Maintenance struct {
	S *Service
	// LogRetention is the maximum retention of any tenant's proctoring logs; whole monthly
	// partitions older than it are dropped.
	LogRetention time.Duration
}

// Report says what one tick did.
type Report struct {
	PartitionsCreated int
	PartitionsDropped []string
	FramesPurged      int
	EvidenceCopied    int
	NetworkGaps       int
}

// Tick runs every job once.
func (m *Maintenance) Tick(ctx context.Context) (Report, error) {
	s := m.S
	now := s.Clock.Now()
	var rep Report
	var due, silent, evidence []Session
	err := s.Store.InSystem(ctx, func(r SystemRepo) (err error) {
		if rep.PartitionsCreated, err = r.EnsurePartitions(ctx, PartitionsAhead); err != nil {
			return err
		}
		if m.LogRetention > 0 {
			if rep.PartitionsDropped, err = r.DropPartitions(ctx, now.Add(-m.LogRetention)); err != nil {
				return err
			}
		}
		if due, err = r.RetentionDue(ctx, 200); err != nil {
			return err
		}
		if silent, err = r.Silent(ctx, now.Add(-NetworkGapAfter), 500); err != nil {
			return err
		}
		evidence, err = r.EvidencePending(ctx, 100)
		return err
	})
	if err != nil {
		return rep, err
	}
	for _, sess := range due {
		n, err := m.purgeFrames(ctx, sess, now)
		if err != nil {
			s.Log.Warn("frame retention failed", "session_id", sess.ID, "err", err)
			continue
		}
		rep.FramesPurged += n
	}
	for _, sess := range silent {
		if err := m.markGap(ctx, sess, now); err != nil {
			s.Log.Warn("network gap marking failed", "session_id", sess.ID, "err", err)
			continue
		}
		rep.NetworkGaps++
	}
	for _, sess := range evidence {
		var frames []Frame
		err := s.Store.InTenant(ctx, sess.TenantID, func(r TenantRepo) (err error) {
			all, err := r.Frames(ctx, sess.ID)
			for _, f := range all {
				if f.Flagged && f.EvidenceKey == nil && f.DeletedAt == nil {
					frames = append(frames, f)
				}
			}
			return err
		})
		if err == nil {
			err = s.keepEvidence(ctx, sess.TenantID, frames)
		}
		if err != nil {
			s.Log.Warn("evidence copy failed", "session_id", sess.ID, "err", err)
			continue
		}
		rep.EvidenceCopied += len(frames)
	}
	return rep, nil
}

// purgeFrames deletes a finalized session's unflagged frames and its biometric references once
// the tenant's frame retention has passed (flagged evidence stays with the report).
func (m *Maintenance) purgeFrames(ctx context.Context, sess Session, now time.Time) (int, error) {
	s := m.S
	days, err := s.Retention.FrameDays(ctx, sess.TenantID)
	if err != nil {
		return 0, err
	}
	if sess.FinalizedAt == nil || now.Before(sess.FinalizedAt.Add(time.Duration(days)*24*time.Hour)) {
		return 0, nil
	}
	var keys []string
	err = s.Store.InTenant(ctx, sess.TenantID, func(r TenantRepo) error {
		cur, err := r.GetSession(ctx, sess.ID, true)
		if err != nil {
			return err
		}
		frames, err := r.Frames(ctx, sess.ID)
		if err != nil {
			return err
		}
		for _, f := range frames {
			if f.DeletedAt != nil {
				continue
			}
			keys = append(keys, f.ObjectKey)
			if f.EvidenceKey == nil {
				f.DeletedAt = &now
				if err := r.SaveFrame(ctx, f); err != nil {
					return err
				}
			}
		}
		cur.References, cur.ReferenceStatus, cur.State.References = nil, "deleted", 0
		cur.FramesPurgedAt = &now
		if err := s.log(ctx, r, cur, "server", "retention_applied", 0, now, map[string]any{"frames": len(keys), "frame_days": days}); err != nil {
			return err
		}
		return r.SaveSession(ctx, cur)
	})
	if err != nil {
		return 0, err
	}
	if err := s.Blobs.Delete(ctx, keys); err != nil {
		return 0, err
	}
	return len(keys), nil
}

func (m *Maintenance) markGap(ctx context.Context, sess Session, now time.Time) error {
	s := m.S
	return s.Store.InTenant(ctx, sess.TenantID, func(r TenantRepo) error {
		cur, err := r.GetSession(ctx, sess.ID, true)
		if err != nil || cur.State.NetworkGap || cur.Status != "active" {
			return err
		}
		cur.State.NetworkGap = true
		since := cur.StartedAt
		if cur.LastEventAt != nil {
			since = *cur.LastEventAt
		}
		if err := s.log(ctx, r, cur, "server", "network_gap", 0, now, map[string]any{"silent_since": since.Format(time.RFC3339Nano)}); err != nil {
			return err
		}
		return r.SaveSession(ctx, cur)
	})
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
			if _, err := m.Tick(ctx); err != nil {
				m.S.Log.Error("maintenance failed", "err", err)
			}
		}
	}
}
