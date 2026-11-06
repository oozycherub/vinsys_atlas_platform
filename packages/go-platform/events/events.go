// Package events holds the transport-neutral event types shared by Go services: what a consumer
// receives (a Debezium outbox record) and what a producer writes to the outbox.
package events

import "encoding/json"

// Consumed is one delivered event.
type Consumed struct {
	EventID  string
	Topic    string
	TenantID string
	Payload  json.RawMessage
}

// Outgoing is an outbox event, written in the same transaction as the change it announces
// (MASTER_ORCHESTRATION_PROMPT §4.4).
type Outgoing struct {
	Topic         string
	AggregateType string
	AggregateID   string
	Payload       any
}

// PoisonError marks a payload that fails validation; transports dead-letter it.
type PoisonError struct{ Reason string }

func (e *PoisonError) Error() string { return "poison event: " + e.Reason }

// Decode unmarshals a payload after checking required fields are present.
func Decode(e Consumed, v any, required ...string) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(e.Payload, &fields); err != nil {
		return &PoisonError{Reason: "payload is not a JSON object"}
	}
	for _, f := range required {
		if _, ok := fields[f]; !ok {
			return &PoisonError{Reason: "missing " + f}
		}
	}
	if err := json.Unmarshal(e.Payload, v); err != nil {
		return &PoisonError{Reason: err.Error()}
	}
	return nil
}
