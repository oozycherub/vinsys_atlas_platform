package test

import (
	"encoding/json"

	"atlas.dev/go-platform/events"
	"atlas.dev/go-platform/pgtx"
)

func eventOf(topic, tenant string, raw json.RawMessage) events.Consumed {
	return events.Consumed{EventID: pgtx.NewID(), Topic: topic, TenantID: tenant, Payload: raw}
}
