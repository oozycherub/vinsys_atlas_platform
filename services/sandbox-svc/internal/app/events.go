package app

import (
	"atlas.dev/go-platform/events"
	"context"
	"fmt"
	"log/slog"
	"slices"
	"time"
)

// Consumer name for de-duplication (processed_events) and the erasure acknowledgement.
const (
	ConsumerName = "sandbox-svc.events"
	ServiceName  = "sandbox-svc"
)

// Consumed topics.
const (
	TopicPublished        = "assessment.assessment.published.v1"
	TopicErasureRequested = "privacy.erasure.requested.v1"
	TopicErasureAck       = "privacy.erasure.acknowledged.v1"
	TopicTenantPurged     = "tenant.tenant.purged.v1"
)

// ConsumedEvent is one delivered event (Debezium outbox record).
type ConsumedEvent = events.Consumed

// PoisonError marks payloads that fail validation; transports dead-letter them.
type PoisonError = events.PoisonError

// Handlers implements the consumer side (docs/prompts/09 §5).
type Handlers struct {
	Store Store
	Blobs BlobStore
	Clock Clock
	Log   *slog.Logger
	API   *API // language registry
}

// Topics lists the subscribed topics.
func (h *Handlers) Topics() []string {
	return []string{TopicPublished, TopicErasureRequested, TopicTenantPurged}
}

// Handle processes one event exactly once (de-duplicated on event id in the same transaction).
// It returns false for duplicates and unknown topics.
func (h *Handlers) Handle(ctx context.Context, e ConsumedEvent) (bool, error) {
	if !slices.Contains(h.Topics(), e.Topic) {
		return false, nil
	}
	var after func()
	first := false
	err := h.Store.InSystemThenTenant(ctx, func(sys SystemRepo, tenant func(string) (TenantRepo, error)) error {
		var err error
		if first, err = sys.FirstDelivery(ctx, ConsumerName, e.EventID); err != nil || !first {
			return err
		}
		switch e.Topic {
		case TopicPublished:
			return h.published(ctx, sys, e)
		case TopicErasureRequested:
			return h.erasure(ctx, tenant, e)
		default:
			after, err = h.purged(ctx, tenant, e)
			return err
		}
	})
	if err == nil && after != nil {
		after()
	}
	return first, err
}

func decode(e ConsumedEvent, v any, required ...string) error {
	return events.Decode(e, v, required...)
}

// published pre-warms the images of the languages a newly published assessment offers.
func (h *Handlers) published(ctx context.Context, sys SystemRepo, e ConsumedEvent) error {
	var p struct {
		CodingLanguages []string `json:"coding_languages"`
	}
	if err := decode(e, &p, "tenant_id", "assessment_id"); err != nil {
		return err
	}
	if len(p.CodingLanguages) == 0 {
		return nil
	}
	langs, err := sys.Languages(ctx)
	if err != nil {
		return err
	}
	var ids []int
	for _, l := range langs {
		if slices.Contains(p.CodingLanguages, l.Slug) && l.Enabled {
			ids = append(ids, l.ID)
		}
	}
	return sys.MarkDemand(ctx, ids, h.Clock.Now())
}

// erasure deletes a candidate's code and results, then acknowledges if asked to.
func (h *Handlers) erasure(ctx context.Context, tenant func(string) (TenantRepo, error), e ConsumedEvent) error {
	var p struct {
		TenantID        string   `json:"tenant_id"`
		RequestID       string   `json:"request_id"`
		CandidateID     string   `json:"candidate_id"`
		AckRequiredFrom []string `json:"ack_required_from"`
	}
	if err := decode(e, &p, "tenant_id", "request_id", "candidate_id", "ack_required_from"); err != nil {
		return err
	}
	r, err := tenant(p.TenantID)
	if err != nil {
		return err
	}
	n, err := r.DeleteCandidate(ctx, p.CandidateID)
	if err != nil {
		return err
	}
	h.Log.Info("erasure applied", "tenant_id", p.TenantID, "request_id", p.RequestID, "submissions", n)
	if !slices.Contains(p.AckRequiredFrom, ServiceName) {
		return nil
	}
	return r.AppendOutbox(ctx, p.TenantID, Event{
		Topic: TopicErasureAck, AggregateType: "privacy_request", AggregateID: p.RequestID,
		Payload: map[string]any{
			"tenant_id": p.TenantID, "request_id": p.RequestID, "service": ServiceName,
			"occurred_at": h.Clock.Now().UTC().Format(time.RFC3339Nano),
		},
	})
}

// purged deletes all of a tenant's rows; the stored bundles go after the commit.
func (h *Handlers) purged(ctx context.Context, tenant func(string) (TenantRepo, error), e ConsumedEvent) (func(), error) {
	var p struct {
		TenantID string `json:"tenant_id"`
	}
	if err := decode(e, &p, "tenant_id"); err != nil {
		return nil, err
	}
	r, err := tenant(p.TenantID)
	if err != nil {
		return nil, err
	}
	keys, err := r.PurgeTenant(ctx)
	if err != nil {
		return nil, err
	}
	return func() {
		if err := h.Blobs.Delete(context.WithoutCancel(ctx), keys); err != nil {
			h.Log.Error("bundle deletion after purge failed", "tenant_id", p.TenantID, "err", fmt.Sprint(err))
		}
	}, nil
}
