// Package kafka feeds Debezium outbox records (infra/debezium) into the event handlers.
package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"atlas.dev/go-platform/events"
	"atlas.dev/go-platform/pgtx"
)

// Handler is a service's consumer: it de-duplicates and applies events in one transaction.
type Handler interface {
	Topics() []string
	Handle(ctx context.Context, e events.Consumed) (bool, error)
}

// Parse maps a record to an event: event_id and tenant_id headers, payload in the value (the
// router may JSON-encode the jsonb column as a string, which is unwrapped once).
func Parse(topic string, headers map[string]string, value []byte) (events.Consumed, error) {
	id, tenant := headers["event_id"], headers["tenant_id"]
	if !pgtx.IsUUID(id) {
		return events.Consumed{}, &events.PoisonError{Reason: "missing or invalid event_id header"}
	}
	if tenant != "" && !pgtx.IsUUID(tenant) {
		return events.Consumed{}, &events.PoisonError{Reason: "invalid tenant_id header"}
	}
	payload := json.RawMessage(value)
	var asString string
	if json.Unmarshal(value, &asString) == nil {
		payload = json.RawMessage(asString)
	}
	if !json.Valid(payload) {
		return events.Consumed{}, &events.PoisonError{Reason: "value is not JSON"}
	}
	return events.Consumed{EventID: id, Topic: topic, TenantID: tenant, Payload: payload}, nil
}

// Run consumes until ctx ends. Offsets are committed only after the handler's transaction
// commits; a failing handler is retried; poison records go to deadLetterTopic.
func Run(ctx context.Context, brokers []string, group, deadLetterTopic string, h Handler, log *slog.Logger) error {
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...), kgo.ConsumerGroup(group), kgo.ConsumeTopics(h.Topics()...),
		kgo.DisableAutoCommit(), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		return err
	}
	defer client.Close()
	for ctx.Err() == nil {
		fetches := client.PollFetches(ctx)
		if errs := fetches.Errors(); len(errs) > 0 && ctx.Err() == nil {
			log.Error("kafka fetch failed", "err", errs[0].Err)
			time.Sleep(time.Second)
			continue
		}
		var done []*kgo.Record
		fetches.EachRecord(func(rec *kgo.Record) {
			if ctx.Err() != nil {
				return
			}
			headers := map[string]string{}
			for _, hd := range rec.Headers {
				headers[hd.Key] = string(hd.Value)
			}
			handled := false
			for attempt := 1; ctx.Err() == nil && !handled; attempt++ {
				e, err := Parse(rec.Topic, headers, rec.Value)
				if err == nil {
					_, err = h.Handle(ctx, e)
				}
				var poison *events.PoisonError
				if errors.As(err, &poison) {
					log.Warn("poison event dead-lettered", "topic", rec.Topic, "reason", poison.Reason)
					dl := &kgo.Record{Topic: deadLetterTopic, Key: rec.Key, Value: rec.Value, Headers: rec.Headers}
					if perr := client.ProduceSync(ctx, dl).FirstErr(); perr != nil {
						log.Error("dead-letter failed", "err", perr)
						time.Sleep(time.Second)
						continue
					}
					handled = true
					continue
				}
				if err != nil {
					log.Error("event handler failed; retrying", "topic", rec.Topic, "attempt", attempt, "err", err)
					time.Sleep(min(time.Duration(attempt)*time.Second, 30*time.Second))
					continue
				}
				handled = true
			}
			if handled {
				done = append(done, rec)
			}
		})
		if len(done) > 0 {
			if err := client.CommitRecords(ctx, done...); err != nil && ctx.Err() == nil {
				log.Error("offset commit failed", "err", err)
			}
		}
	}
	return nil
}
