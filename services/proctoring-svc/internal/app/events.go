package app

import (
	"context"
	"slices"
	"strings"
	"time"

	"atlas.dev/go-platform/events"
)

// Consumer name for de-duplication and the erasure acknowledgement.
const (
	ConsumerName = "proctoring-svc.events"
	ServiceName  = "proctoring-svc"
)

// Consumed topics (docs/prompts/10 §5).
const (
	TopicSessionStarted    = "assessment.session.started.v1"
	TopicSessionSubmitted  = "assessment.session.submitted.v1"
	TopicSessionTerminated = "assessment.session.terminated.v1"
	TopicSettingsUpdated   = "tenant.tenant.settings_updated.v1"
	TopicErasureRequested  = "privacy.erasure.requested.v1"
	TopicTenantPurged      = "tenant.tenant.purged.v1"
)

// Handlers implements the consumer side.
type Handlers struct{ S *Service }

// Topics lists the subscribed topics.
func (h *Handlers) Topics() []string {
	return []string{TopicSessionStarted, TopicSessionSubmitted, TopicSessionTerminated, TopicSettingsUpdated,
		TopicErasureRequested, TopicTenantPurged}
}

// Handle applies one event. Finalising and cache invalidation are idempotent, so they run first
// and the de-duplication marker is written after; erasure and purge mark and act in one
// transaction (objects are deleted after it commits).
func (h *Handlers) Handle(ctx context.Context, e events.Consumed) (bool, error) {
	if !slices.Contains(h.Topics(), e.Topic) {
		return false, nil
	}
	s := h.S
	switch e.Topic {
	case TopicSessionSubmitted, TopicSessionTerminated:
		var p struct {
			TenantID  string `json:"tenant_id"`
			SessionID string `json:"session_id"`
		}
		if err := events.Decode(e, &p, "tenant_id", "session_id"); err != nil {
			return false, err
		}
		if err := s.Finalize(ctx, p.TenantID, p.SessionID, false); err != nil {
			return false, err
		}
		return h.mark(ctx, e)
	case TopicSettingsUpdated:
		var p struct {
			TenantID    string   `json:"tenant_id"`
			ChangedKeys []string `json:"changed_keys"`
		}
		if err := events.Decode(e, &p, "tenant_id", "changed_keys"); err != nil {
			return false, err
		}
		if slices.ContainsFunc(p.ChangedKeys, func(k string) bool { return strings.HasPrefix(k, "retention_policy") }) {
			s.Retention.Invalidate(p.TenantID)
		}
		return h.mark(ctx, e)
	case TopicErasureRequested:
		return h.erasure(ctx, e)
	case TopicTenantPurged:
		return h.purge(ctx, e)
	default: // session started: nothing to do until the candidate starts proctoring
		var p struct{}
		if err := events.Decode(e, &p, "tenant_id", "session_id"); err != nil {
			return false, err
		}
		return h.mark(ctx, e)
	}
}

func (h *Handlers) mark(ctx context.Context, e events.Consumed) (first bool, err error) {
	err = h.S.Store.InSystem(ctx, func(r SystemRepo) error {
		first, err = r.FirstDelivery(ctx, ConsumerName, e.EventID)
		return err
	})
	return first, err
}

// erasure deletes the candidate's proctoring data (logs, frames, biometric references), then the
// stored objects, and acknowledges when asked to.
func (h *Handlers) erasure(ctx context.Context, e events.Consumed) (bool, error) {
	var p struct {
		TenantID        string   `json:"tenant_id"`
		RequestID       string   `json:"request_id"`
		CandidateID     string   `json:"candidate_id"`
		AckRequiredFrom []string `json:"ack_required_from"`
	}
	if err := events.Decode(e, &p, "tenant_id", "request_id", "candidate_id", "ack_required_from"); err != nil {
		return false, err
	}
	s := h.S
	var ids []string
	first := false
	err := s.Store.InSystemThenTenant(ctx, func(sys SystemRepo, tenant func(string) (TenantRepo, error)) error {
		var err error
		if first, err = sys.FirstDelivery(ctx, ConsumerName, e.EventID); err != nil || !first {
			return err
		}
		r, err := tenant(p.TenantID)
		if err != nil {
			return err
		}
		if ids, err = r.SessionsOfCandidate(ctx, p.CandidateID); err != nil {
			return err
		}
		if err := r.EraseSessions(ctx, ids); err != nil {
			return err
		}
		if !slices.Contains(p.AckRequiredFrom, ServiceName) {
			return nil
		}
		return r.AppendOutbox(ctx, events.Outgoing{
			Topic: TopicErasureAck, AggregateType: "privacy_request", AggregateID: p.RequestID,
			Payload: map[string]any{"tenant_id": p.TenantID, "request_id": p.RequestID, "service": ServiceName,
				"occurred_at": s.Clock.Now().Format(time.RFC3339Nano)},
		})
	})
	if err != nil || !first {
		return first, err
	}
	for _, id := range ids {
		for _, prefix := range []string{"proctor", "evidence"} {
			if err := s.Blobs.DeletePrefix(context.WithoutCancel(ctx), "t/"+p.TenantID+"/"+prefix+"/"+id+"/"); err != nil {
				s.Log.Error("erasure: object deletion failed", "tenant_id", p.TenantID, "err", err)
			}
		}
	}
	return true, nil
}

func (h *Handlers) purge(ctx context.Context, e events.Consumed) (bool, error) {
	var p struct {
		TenantID string `json:"tenant_id"`
	}
	if err := events.Decode(e, &p, "tenant_id"); err != nil {
		return false, err
	}
	s := h.S
	first := false
	err := s.Store.InSystemThenTenant(ctx, func(sys SystemRepo, tenant func(string) (TenantRepo, error)) error {
		var err error
		if first, err = sys.FirstDelivery(ctx, ConsumerName, e.EventID); err != nil || !first {
			return err
		}
		r, err := tenant(p.TenantID)
		if err != nil {
			return err
		}
		ids, err := r.AllSessions(ctx)
		if err != nil {
			return err
		}
		return r.EraseSessions(ctx, ids)
	})
	if err != nil || !first {
		return first, err
	}
	for _, prefix := range []string{"proctor", "evidence"} {
		if err := s.Blobs.DeletePrefix(context.WithoutCancel(ctx), "t/"+p.TenantID+"/"+prefix+"/"); err != nil {
			s.Log.Error("purge: object deletion failed", "tenant_id", p.TenantID, "err", err)
		}
	}
	return true, nil
}
