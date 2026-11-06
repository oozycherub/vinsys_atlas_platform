package kafka

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"

	"atlas.dev/go-platform/events"
	"atlas.dev/go-platform/logging"
)

type recorder struct {
	mu       sync.Mutex
	got      []string
	failOnce map[string]bool
}

func (r *recorder) Topics() []string { return []string{"t.thing.done.v1"} }

func (r *recorder) Handle(_ context.Context, e events.Consumed) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failOnce[e.EventID] {
		r.failOnce[e.EventID] = false
		return false, errors.New("database briefly unavailable")
	}
	if string(e.Payload) == `{"poison":true}` {
		return false, &events.PoisonError{Reason: "bad"}
	}
	r.got = append(r.got, e.EventID)
	return true, nil
}

func (r *recorder) seen() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.got...)
}

// The consume loop against an in-memory Kafka: events are handled in order, a failing handler is
// retried (the offset does not move), poison records go to the dead-letter topic, and committed
// offsets mean a restart does not reprocess.
func TestRunAgainstInMemoryKafka(t *testing.T) {
	cluster, err := kfake.NewCluster(kfake.SeedTopics(1, "t.thing.done.v1", "dlq"))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	brokers := cluster.ListenAddrs()
	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers...))
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	ids := []string{"0192f0c1-0000-7000-8000-000000000001", "0192f0c1-0000-7000-8000-000000000002", "0192f0c1-0000-7000-8000-000000000003"}
	send := func(id, value string) {
		rec := &kgo.Record{Topic: "t.thing.done.v1", Value: []byte(value), Headers: []kgo.RecordHeader{{Key: "event_id", Value: []byte(id)}}}
		if err := producer.ProduceSync(context.Background(), rec).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	send(ids[0], `{"n":1}`)
	send(ids[1], `{"poison":true}`)
	send(ids[2], `"{\"n\":3}"`) // Debezium may string-encode the jsonb value
	send("not-a-uuid", `{}`)    // poison too (bad header)

	h := &recorder{failOnce: map[string]bool{ids[2]: true}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, brokers, "group-a", "dlq", h, logging.Discard()) }()
	deadline := time.Now().Add(15 * time.Second)
	for len(h.seen()) < 2 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	got := h.seen()
	if len(got) != 2 || got[0] != ids[0] || got[1] != ids[2] {
		t.Fatalf("handled %v", got)
	}
	// Two poison records reached the dead-letter topic.
	dlq, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.ConsumeTopics("dlq"), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	if err != nil {
		t.Fatal(err)
	}
	defer dlq.Close()
	var dead int
	for dead < 2 && time.Now().Before(deadline) {
		fetches := dlq.PollRecords(ctx, 10)
		dead += fetches.NumRecords()
	}
	if dead != 2 {
		t.Fatalf("dead letters %d", dead)
	}
	time.Sleep(200 * time.Millisecond) // let the last commit land
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// Restarting the same group resumes after the committed offsets: nothing is handled again.
	h2 := &recorder{}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	_ = Run(ctx2, brokers, "group-a", "dlq", h2, logging.Discard())
	if len(h2.seen()) != 0 {
		t.Fatalf("reprocessed %v", h2.seen())
	}
	if err := Run(context.Background(), nil, "g", "dlq", h2, logging.Discard()); err == nil {
		t.Fatal("no brokers must fail")
	}
}
