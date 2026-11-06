package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"atlas.dev/go-platform/auth"
	"atlas.dev/go-platform/events"

	"atlas.dev/proctoring-svc/internal/domain"
)

// --- Finaliser -----------------------------------------------------------------------------------

// Finalize computes the Trust Score when the assessment session ends (and again, with a higher
// revision, after reviews or late inference). Red sessions need a human: no AI-only rejection.
func (s *Service) Finalize(ctx context.Context, tenant, sessionID string, revise bool) error {
	now := s.Clock.Now()
	var evidence []Frame
	err := s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		sess, err := r.GetSession(ctx, sessionID, true)
		if errors.Is(err, ErrNotFound) {
			return nil // proctoring never started for this session
		}
		if err != nil {
			return err
		}
		if sess.Status == "finalized" && !revise {
			return nil // redelivered event
		}
		score, breakdown := domain.TrustScore(sess.State.Engine.Counts)
		band := domain.BandOf(score)
		b := string(band)
		sess.TrustScore, sess.Band, sess.Revision = &score, &b, sess.Revision+1
		if sess.Status != "finalized" {
			sess.Status, sess.FinalizedAt, sess.SubmittedAt = "finalized", &now, &now
		}
		if err := s.log(ctx, r, sess, "server", "finalized", 0, now, map[string]any{
			"trust_score": score, "band": b, "revision": sess.Revision, "breakdown": breakdown,
		}); err != nil {
			return err
		}
		if err := r.SaveSession(ctx, sess); err != nil {
			return err
		}
		frames, err := r.Frames(ctx, sessionID)
		if err != nil {
			return err
		}
		for _, f := range frames {
			if f.Flagged && f.EvidenceKey == nil && f.DeletedAt == nil {
				evidence = append(evidence, f)
			}
		}
		return r.AppendOutbox(ctx, events.Outgoing{
			Topic: TopicFinalized, AggregateType: "assessment_session", AggregateID: sess.ID,
			Payload: map[string]any{
				"tenant_id": tenant, "session_id": sess.ID, "assessment_id": sess.AssessmentID,
				"trust_score": score, "band": b, "review_required": domain.NeedsReview(band),
				"breakdown": breakdown, "revision": sess.Revision, "occurred_at": now.Format(time.RFC3339Nano),
			},
		})
	})
	if err != nil {
		return err
	}
	return s.keepEvidence(ctx, tenant, evidence)
}

// keepEvidence copies flagged frames to t/{tid}/evidence/ (kept with the assessment report;
// t/{tid}/proctor/ expires after the frame retention). Failures are retried by maintenance.
func (s *Service) keepEvidence(ctx context.Context, tenant string, frames []Frame) error {
	for _, f := range frames {
		dst := strings.Replace(f.ObjectKey, "/proctor/", "/evidence/", 1)
		if err := s.Blobs.Copy(ctx, f.ObjectKey, dst); err != nil {
			s.Log.Warn("evidence copy failed; will retry", "frame_id", f.ID, "err", err)
			continue
		}
		err := s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
			cur, err := r.GetFrame(ctx, f.ID)
			if err != nil {
				return err
			}
			cur.EvidenceKey = &dst
			return r.SaveFrame(ctx, *cur)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// --- Timeline and reviews ------------------------------------------------------------------------

// TimelineEntry is one log row as reviewers see it.
type TimelineEntry struct {
	LogID      int64          `json:"log_id"`
	Source     string         `json:"source"`
	Seq        *int64         `json:"seq,omitempty"`
	EventType  string         `json:"event_type"`
	Severity   int            `json:"severity"`
	OccurredAt time.Time      `json:"occurred_at"`
	Payload    map[string]any `json:"payload"`
	FrameURL   *string        `json:"frame_url,omitempty"`
	Review     *Review        `json:"review,omitempty"`
}

// Timeline is the evidence view of one session (reviewer roles).
type Timeline struct {
	SessionID       string          `json:"session_id"`
	Status          string          `json:"status"`
	TrustScore      int             `json:"trust_score"`
	Band            string          `json:"band"`
	Breakdown       map[string]int  `json:"breakdown"`
	Revision        int             `json:"revision"`
	ReferenceStatus string          `json:"reference_status"`
	DisabledRules   []string        `json:"disabled_rules"`
	ChainValid      bool            `json:"chain_valid"`
	Entries         []TimelineEntry `json:"entries"`
}

// GetTimeline returns the log with signed frame URLs (15 min) and review decisions.
func (s *Service) GetTimeline(ctx context.Context, p auth.Principal, tenantParam, sessionID string) (Timeline, error) {
	if !p.HasAnyRole(ReaderRoles...) && !p.HasRole("super_admin") {
		return Timeline{}, fail("forbidden", "FORBIDDEN", "Your role cannot read proctoring evidence.")
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Timeline{}, err
	}
	var t Timeline
	err = s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		sess, err := r.GetSession(ctx, sessionID, false)
		if err != nil {
			return err
		}
		rows, err := r.Logs(ctx, sessionID, 5000)
		if err != nil {
			return err
		}
		frames, err := r.Frames(ctx, sessionID)
		if err != nil {
			return err
		}
		reviews, err := r.Reviews(ctx, sessionID)
		if err != nil {
			return err
		}
		byFrame := map[string]Frame{}
		for _, f := range frames {
			byFrame[f.ID] = f
		}
		byLog := map[int64]Review{}
		for _, rv := range reviews {
			byLog[rv.LogID] = rv
		}
		score, breakdown := domain.TrustScore(sess.State.Engine.Counts)
		t = Timeline{SessionID: sess.ID, Status: sess.Status, TrustScore: score, Band: string(domain.BandOf(score)),
			Breakdown: breakdown, Revision: sess.Revision, ReferenceStatus: sess.ReferenceStatus,
			DisabledRules: append([]string{}, sess.DisabledRules...), ChainValid: VerifyChain(rows)}
		for _, row := range rows {
			e := TimelineEntry{LogID: row.LogID, Source: row.Source, Seq: row.Seq, EventType: row.EventType,
				Severity: row.Severity, OccurredAt: row.OccurredAt, Payload: row.Payload}
			if rv, ok := byLog[row.LogID]; ok {
				rv := rv
				e.Review = &rv
			}
			if row.FrameID != nil {
				if f, ok := byFrame[*row.FrameID]; ok && f.DeletedAt == nil {
					key := f.ObjectKey
					if f.EvidenceKey != nil {
						key = *f.EvidenceKey
					}
					url, err := s.Blobs.PresignGet(ctx, key, SignedURLTTL)
					if err != nil {
						return err
					}
					e.FrameURL = &url
				}
			}
			t.Entries = append(t.Entries, e)
		}
		return nil
	})
	return t, err
}

// ReviewFlag records a reviewer's decision on a flag. Dismissals remove the flag from the Trust
// Score; a finalized session is re-finalized (revision + 1). Labels feed active learning.
func (s *Service) ReviewFlag(ctx context.Context, p auth.Principal, tenantParam string, logID int64, decision string, comment *string) (Review, error) {
	if !p.HasAnyRole(ReviewerRoles...) {
		return Review{}, fail("forbidden", "FORBIDDEN", "Your role cannot review proctoring flags.")
	}
	if decision != "confirmed" && decision != "dismissed" {
		return Review{}, fail("bad_request", "VALIDATION_FAILED", "decision must be confirmed or dismissed.")
	}
	if comment != nil && len(*comment) > 2000 {
		return Review{}, fail("bad_request", "VALIDATION_FAILED", "comment is limited to 2000 characters.")
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Review{}, err
	}
	now := s.Clock.Now()
	var rv Review
	var refinalize bool
	var sessionID string
	err = s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		row, err := r.GetLog(ctx, logID)
		if errors.Is(err, ErrNotFound) || (err == nil && !strings.HasPrefix(row.EventType, "violation:")) {
			return fail("not_found", "FLAG_NOT_FOUND", "No such flag.")
		}
		if err != nil {
			return err
		}
		sess, err := r.GetSession(ctx, row.SessionID, true)
		if err != nil {
			return err
		}
		rule := strings.TrimPrefix(row.EventType, "violation:")
		rv = Review{LogID: logID, SessionID: sess.ID, Rule: rule, Decision: decision, Reviewer: p.Subject, Comment: comment, DecidedAt: now}
		created, err := r.InsertReview(ctx, rv)
		if err != nil {
			return err
		}
		if !created {
			return fail("conflict", "ALREADY_REVIEWED", "This flag has already been reviewed.")
		}
		if decision == "dismissed" {
			sig, _ := row.Payload["signal"].(string)
			sess.State.Engine.Dismiss(domain.Signal(sig))
		}
		if err := s.log(ctx, r, sess, "review", "review:"+decision, 0, now, map[string]any{
			"log_id": logID, "rule": rule, "reviewer": p.Subject,
		}); err != nil {
			return err
		}
		refinalize, sessionID = sess.Status == "finalized", sess.ID
		return r.SaveSession(ctx, sess)
	})
	if err != nil || !refinalize {
		return rv, err
	}
	return rv, s.Finalize(ctx, tenant, sessionID, true)
}

// Accommodate disables rules for one session (accessibility, PRD §2.3d), before or during it.
func (s *Service) Accommodate(ctx context.Context, p auth.Principal, tenantParam, sessionID string, rules []string, reason string) (Accommodation, error) {
	if !p.HasAnyRole(GrantorRoles...) {
		return Accommodation{}, fail("forbidden", "FORBIDDEN", "Your role cannot grant accommodations.")
	}
	if !domain.ValidAccommodation(rules) {
		return Accommodation{}, fail("rule", "INVALID_ACCOMMODATION", "disabled_rules must be among %s.", strings.Join(domain.DisableableRules, ", "))
	}
	reason = strings.TrimSpace(reason)
	if len(reason) < 3 || len(reason) > 500 {
		return Accommodation{}, fail("bad_request", "VALIDATION_FAILED", "reason must be 3–500 characters.")
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Accommodation{}, err
	}
	sorted := append([]string(nil), rules...)
	slices.Sort(sorted)
	a := Accommodation{SessionID: sessionID, DisabledRules: slices.Compact(sorted), Reason: reason, GrantedBy: p.Subject, GrantedAt: s.Clock.Now()}
	err = s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		if err := r.UpsertAccommodation(ctx, a); err != nil {
			return err
		}
		sess, err := r.GetSession(ctx, sessionID, true)
		if errors.Is(err, ErrNotFound) {
			return nil // applied when proctoring starts
		}
		if err != nil {
			return err
		}
		sess.DisabledRules = a.DisabledRules
		if err := s.log(ctx, r, sess, "server", "accommodation_applied", 0, a.GrantedAt, map[string]any{
			"disabled_rules": a.DisabledRules, "reason": a.Reason, "granted_by": a.GrantedBy,
		}); err != nil {
			return err
		}
		return r.SaveSession(ctx, sess)
	})
	return a, err
}

func tenantFor(p auth.Principal, requested string) (string, error) {
	if p.TenantID != nil {
		if requested != "" && requested != *p.TenantID {
			return "", fail("forbidden", "FORBIDDEN", "You cannot act on another tenant.")
		}
		return *p.TenantID, nil
	}
	if requested == "" {
		return "", fail("bad_request", "TENANT_REQUIRED", "tenant_id is required for this caller.")
	}
	return requested, nil
}

// --- Log hash chain ------------------------------------------------------------------------------

// LogHash is sha256(prev_hash || canonical row): any edit or deletion of a row breaks the chain.
func LogHash(prev []byte, row *LogRow) []byte {
	body, _ := json.Marshal(struct {
		Session  string         `json:"s"`
		Source   string         `json:"src"`
		Seq      *int64         `json:"seq"`
		Type     string         `json:"t"`
		Severity int            `json:"sev"`
		At       string         `json:"at"`
		Frame    *string        `json:"f"`
		Model    *string        `json:"m"`
		Payload  map[string]any `json:"p"`
	}{row.SessionID, row.Source, row.Seq, row.EventType, row.Severity, row.OccurredAt.UTC().Format(time.RFC3339Nano), row.FrameID, row.ModelVersion, row.Payload})
	h := sha256.New()
	h.Write(prev)
	h.Write(body)
	return h.Sum(nil)
}

// VerifyChain recomputes the chain over rows in insertion order.
func VerifyChain(rows []LogRow) bool {
	sorted := append([]LogRow(nil), rows...)
	slices.SortFunc(sorted, func(a, b LogRow) int { return int(a.LogID - b.LogID) })
	var prev []byte
	for i := range sorted {
		if string(sorted[i].PrevHash) != string(prev) || string(LogHash(prev, &sorted[i])) != string(sorted[i].EventHash) {
			return false
		}
		prev = sorted[i].EventHash
	}
	return true
}
