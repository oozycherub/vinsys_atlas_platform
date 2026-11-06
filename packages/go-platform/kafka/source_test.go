package kafka

import (
	"errors"
	"testing"

	"atlas.dev/go-platform/events"
)

func TestParse(t *testing.T) {
	id, tenant := "0192f0c1-0000-7000-8000-000000000001", "0192f0c1-0000-7000-8000-000000000002"
	e, err := Parse("t.x.y.v1", map[string]string{"event_id": id, "tenant_id": tenant}, []byte(`{"a":1}`))
	if err != nil || e.EventID != id || e.TenantID != tenant || string(e.Payload) != `{"a":1}` {
		t.Fatalf("plain: %+v %v", e, err)
	}
	// Debezium may encode the jsonb column as a JSON string: unwrapped once.
	e, err = Parse("t.x.y.v1", map[string]string{"event_id": id}, []byte(`"{\"a\":2}"`))
	if err != nil || string(e.Payload) != `{"a":2}` || e.TenantID != "" {
		t.Fatalf("string-encoded: %+v %v", e, err)
	}
	var poison *events.PoisonError
	for _, c := range []struct {
		headers map[string]string
		value   string
	}{
		{map[string]string{}, `{}`},
		{map[string]string{"event_id": "x"}, `{}`},
		{map[string]string{"event_id": id, "tenant_id": "nope"}, `{}`},
		{map[string]string{"event_id": id}, `{not json`},
	} {
		if _, err := Parse("t", c.headers, []byte(c.value)); !errors.As(err, &poison) {
			t.Errorf("%v %s: %v", c.headers, c.value, err)
		}
	}
}
