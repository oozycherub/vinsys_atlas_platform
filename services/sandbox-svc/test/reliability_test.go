package test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
	"atlas.dev/sandbox-svc/internal/testkit"
)

func (e *env) claim(workerID string) *app.Submission {
	e.t.Helper()
	var job *app.Submission
	err := e.db.Store.InSystem(context.Background(), func(r app.SystemRepo) error {
		heads, err := r.QueueHeads(context.Background(), []int{71, 54})
		if err != nil || len(heads) == 0 {
			return err
		}
		job, err = r.Claim(context.Background(), heads[0].Lane, heads[0].TenantID, []int{71, 54}, workerID, e.clock.Now().Add(app.LeaseTTL))
		return err
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return job
}

// A worker that dies mid-job: the lease expires, the job is redelivered; after the third attempt
// it ends as internal_error, which is announced but never charged (no score).
func TestCrashedWorkersAndRedelivery(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	s := newSession(tenant)
	id := e.submit(s, qid, "python", "SUM", "crash-key-0001").Body["submission_id"].(string)

	for attempt := 1; attempt <= app.MaxAttempts; attempt++ {
		job := e.claim("dying-worker")
		if job == nil || job.ID != id || job.AttemptCount != attempt {
			t.Fatalf("attempt %d: claimed %+v", attempt, job)
		}
		// Not yet expired: nothing happens.
		if rq, failed, _, _ := e.maint.Tick(context.Background()); rq != 0 || failed != 0 {
			t.Fatal("reaped a live lease")
		}
		e.clock.Advance(app.LeaseTTL + time.Second)
		rq, failed, _, err := e.maint.Tick(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if attempt < app.MaxAttempts && (rq != 1 || failed != 0) {
			t.Fatalf("attempt %d: requeued %d failed %d", attempt, rq, failed)
		}
		if attempt == app.MaxAttempts && (rq != 0 || failed != 1) {
			t.Fatalf("last attempt: requeued %d failed %d", rq, failed)
		}
	}
	got := e.submission(tenant, id)
	if got["status"] != "internal_error" || got["score_ratio"] != nil || got["tests_passed"] != nil {
		t.Fatalf("after 3 attempts: %v", got)
	}
	events := e.outbox(app.TopicJudged)
	if len(events) != 1 || events[0].Payload["verdict"] != "internal_error" {
		t.Fatalf("judged events: %v", events)
	}
	if e.claim("other") != nil {
		t.Fatal("a failed job was claimed again")
	}
}

// A worker that lost its lease (another worker took over) cannot write its stale result.
func TestLostLeaseCannotComplete(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	id := e.submit(newSession(tenant), qid, "python", "SUM", "lease-key-0001").Body["submission_id"].(string)
	e.claim("slow-worker")
	e.clock.Advance(app.LeaseTTL + time.Second)
	if rq, _, _, _ := e.maint.Tick(context.Background()); rq != 1 {
		t.Fatal("not requeued")
	}
	complete := func(worker string) bool {
		var done bool
		err := e.db.Store.InTenant(context.Background(), tenant, func(r app.TenantRepo) (err error) {
			done, err = r.Complete(context.Background(), id, worker, app.Completion{Summary: domain.Summary{Verdict: domain.WrongAnswer}}, e.clock.Now())
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return done
	}
	// A new worker holds the job: neither the old owner nor the reaper (empty id, lease still
	// valid) may write a result.
	if job := e.claim("fresh-worker"); job == nil || job.ID != id {
		t.Fatal("not reclaimed")
	}
	if complete("slow-worker") || complete("") {
		t.Fatal("stale completion accepted while another worker holds the lease")
	}
	if e.scalar(`SELECT worker_id FROM coding_submissions WHERE submission_id = $1`, id) != "fresh-worker" {
		t.Fatal("ownership changed")
	}
	e.clock.Advance(app.LeaseTTL + time.Second)
	_, _, _, _ = e.maint.Tick(context.Background())
	e.drain() // a healthy worker judges it
	if complete("slow-worker") {
		t.Fatal("stale completion accepted after the job finished")
	}
	if e.submission(tenant, id)["status"] != "accepted" || len(e.outbox(app.TopicJudged)) != 1 {
		t.Fatal("result overwritten or announced twice")
	}
	// Heartbeats of the old owner fail too.
	var held bool
	_ = e.db.Store.InSystem(context.Background(), func(r app.SystemRepo) (err error) {
		held, err = r.Heartbeat(context.Background(), id, "slow-worker", e.clock.Now().Add(time.Minute))
		return err
	})
	if held {
		t.Fatal("old owner kept the lease")
	}
}

// Sandbox faults are retried, never charged; after the last attempt they are internal errors.
func TestSandboxFaultsAreRetried(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	id := e.submit(newSession(tenant), qid, "python", "SUM", "fault-key-0001").Body["submission_id"].(string)
	e.pool.FailAll.Store(true)
	w := e.worker("w-fault")
	for i := 0; i < app.MaxAttempts; i++ {
		if worked, err := w.RunOnce(context.Background()); !worked || err != nil {
			t.Fatalf("attempt %d: %v %v", i+1, worked, err)
		}
		status := e.scalar(`SELECT status::text FROM coding_submissions WHERE submission_id = $1`, id)
		if i < app.MaxAttempts-1 && status != "queued" {
			t.Fatalf("attempt %d: %v (should be released)", i+1, status)
		}
	}
	if got := e.submission(tenant, id); got["status"] != "internal_error" {
		t.Fatalf("after faults: %v", got)
	}
	// FAULT (status XX inside the box) is a sandbox fault too, not the candidate's error.
	e.pool.FailAll.Store(false)
	id2 := e.submit(newSession(tenant), qid, "python", "FAULT", "fault-key-0002").Body["submission_id"].(string)
	e.drain()
	if e.submission(tenant, id2)["status"] != "internal_error" {
		t.Fatal("box error charged to the candidate")
	}
}

func TestCustomChecker(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := newID()
	body := map[string]any{
		"languages": []string{"python"}, "tests": sampleTests(),
		"checker":            map[string]any{"kind": "custom", "language": "python", "source": "CHECK"},
		"reference_solution": map[string]any{"language": "python", "source": "SUM"},
	}
	if r := e.do("PUT", "/v1/test-case-bundles/"+qid+"/versions/1?tenant_id="+tenant, e.svc, body); r.Status != 201 {
		t.Fatalf("custom bundle: %d %v", r.Status, r.Body)
	}
	e.drain()
	if got := e.do("GET", "/v1/test-case-bundles/"+qid+"/versions/1?tenant_id="+tenant, e.svc, nil); got.Body["status"] != "verified" {
		t.Fatalf("custom verify: %v", got.Body)
	}
	s := newSession(tenant)
	ok := e.submit(s, qid, "python", "SUM", "chk-key-00001").Body["submission_id"].(string)
	bad := e.submit(s, qid, "python", "PRINT 9", "chk-key-00002").Body["submission_id"].(string)
	e.drain()
	if e.submission(tenant, ok)["status"] != "accepted" || e.submission(tenant, bad)["status"] != "wrong_answer" {
		t.Fatal("custom checker verdicts")
	}
	// A broken checker is the author's fault: never a WA for the candidate.
	broken := newID()
	body["checker"] = map[string]any{"kind": "custom", "language": "python", "source": "CHECKBROKEN"}
	e.do("PUT", "/v1/test-case-bundles/"+broken+"/versions/1?tenant_id="+tenant, e.svc, body)
	e.drain()
	if got := e.do("GET", "/v1/test-case-bundles/"+broken+"/versions/1?tenant_id="+tenant, e.svc, nil); got.Body["status"] != "reference_failed" {
		t.Fatalf("broken checker verification: %v", got.Body)
	}
	// Built-in float tolerance.
	ft := newID()
	e.do("PUT", "/v1/test-case-bundles/"+ft+"/versions/1?tenant_id="+tenant, e.svc, map[string]any{
		"languages": []string{"python"}, "tests": []map[string]any{{"input": "x", "expected": "0.3333333"}},
		"checker":            map[string]any{"kind": "float_tol", "tolerance": 1e-6},
		"reference_solution": map[string]any{"language": "python", "source": `PRINT 0.33333334`},
	})
	e.drain()
	if got := e.do("GET", "/v1/test-case-bundles/"+ft+"/versions/1?tenant_id="+tenant, e.svc, nil); got.Body["status"] != "verified" {
		t.Fatalf("float_tol: %v", got.Body)
	}
}

// Expected outputs never enter the box: only input.txt and the program are written.
func TestExpectedOutputNeverEntersTheBox(t *testing.T) {
	e := setup(t)
	tenant := newID()
	spy := &spyPool{FakePool: e.pool}
	qid := newID()
	e.putBundle(tenant, qid, 1, "SUM", map[string]any{"tests": []map[string]any{{"input": "1 2", "expected": "SECRET-EXPECTED-3"}}})
	w := e.worker("w-spy")
	w.Judge = &app.Judge{Pool: spy}
	for {
		worked, err := w.RunOnce(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !worked {
			break
		}
	}
	for _, f := range spy.written {
		if strings.Contains(f, "SECRET-EXPECTED") {
			t.Fatalf("expected output written into the box: %q", f)
		}
	}
	if len(spy.written) == 0 {
		t.Fatal("spy saw nothing")
	}
}

type spyPool struct {
	*testkit.FakePool
	written []string
}

func (s *spyPool) Acquire(ctx context.Context) (app.Box, error) {
	b, err := s.FakePool.Acquire(ctx)
	return &spyBox{Box: b, pool: s}, err
}

type spyBox struct {
	app.Box
	pool *spyPool
}

func (b *spyBox) WriteFile(name string, data []byte) error {
	b.pool.written = append(b.pool.written, name+"="+string(data))
	return b.Box.WriteFile(name, data)
}

// A bundle tampered with in object storage is refused (checksum), and the node cache avoids
// downloading the same bundle twice.
func TestBundleIntegrityAndCache(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	key := e.blobs.Keys()[0]
	w := e.worker("w-cache")
	s := newSession(tenant)
	e.submit(s, qid, "python", "SUM", "cache-key-0001")
	e.submit(s, qid, "python", "SUM", "cache-key-0002")
	gets := e.blobs.Gets
	for i := 0; i < 2; i++ {
		_, _ = w.RunOnce(context.Background())
	}
	if e.blobs.Gets-gets != 1 {
		t.Fatalf("bundle downloaded %d times for 2 jobs on one node", e.blobs.Gets-gets)
	}
	_ = e.blobs.Put(context.Background(), key, []byte(`{"tests":[{"id":"t1","input":"1","expected":"1"}]}`))
	id := e.submit(s, qid, "python", "SUM", "cache-key-0003").Body["submission_id"].(string)
	e.drain() // fresh node cache: downloads, detects tampering, retries, gives up
	if e.submission(tenant, id)["status"] != "internal_error" {
		t.Fatal("tampered bundle was used")
	}
}

func TestPlagiarism(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	assessment := newID()
	src := `
def solve(numbers):
    best = sorted(numbers, reverse=True)[:3]
    total = 0
    for value in best:
        total += value
    return total
data = list(map(int, input().split()))
print(solve(data))
`
	copied := strings.NewReplacer("solve", "f", "numbers", "xs", "best", "top", "total", "acc", "value", "v", "data", "arr").Replace(src)
	a, b, c := newSession(tenant), newSession(tenant), newSession(tenant)
	a.assessment, b.assessment, c.assessment = assessment, assessment, assessment
	e.submit(a, qid, "python", src, "plag-key-00001")
	e.drain()
	if len(e.outbox(app.TopicViolation)) != 0 {
		t.Fatal("first submission flagged")
	}
	id := e.submit(b, qid, "python", copied, "plag-key-00002").Body["submission_id"].(string)
	e.submit(c, qid, "python", `print(sum(map(int, input().split())))`, "plag-key-00003") // trivial
	e.drain()
	events := e.outbox(app.TopicViolation)
	if len(events) != 2 {
		t.Fatalf("violations: %v", events)
	}
	flagged := map[string]bool{}
	for _, ev := range events {
		p := ev.Payload
		if p["rule"] != "code_similarity" || p["action"] != "review" || p["trust_score"] != nil {
			t.Fatalf("violation payload %v", p)
		}
		flagged[p["session_id"].(string)] = true
	}
	if !flagged[a.id] || !flagged[b.id] || flagged[c.id] {
		t.Fatalf("flagged sessions %v", flagged)
	}
	staff := testkit.Token(t, "u", &tenant, []string{"recruiter"}, nil, time.Hour)
	if sim := e.do("GET", "/v1/submissions/"+id+"?view=staff", staff, nil).Body["similarity_max"]; sim == nil || sim.(float64) <= domain.SimilarityThreshold {
		t.Fatalf("similarity %v", sim)
	}
	// Same code in another assessment is not compared.
	d := newSession(tenant)
	e.submit(d, qid, "python", src, "plag-key-00004")
	e.drain()
	if len(e.outbox(app.TopicViolation)) != 2 {
		t.Fatal("compared across assessments")
	}
}

func event(topic, tenant string, payload map[string]any) app.ConsumedEvent {
	raw, _ := json.Marshal(payload)
	return app.ConsumedEvent{EventID: newID(), Topic: topic, TenantID: tenant, Payload: raw}
}

func TestEvents(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	s := newSession(tenant)
	e.submit(s, qid, "python", "SUM", "evt-key-000001")
	e.drain()

	// Published: pre-warm the offered languages; duplicates are ignored.
	pub := event(app.TopicPublished, tenant, map[string]any{"tenant_id": tenant, "assessment_id": newID(), "coding_languages": []string{"python", "java", "cobol"}})
	if first, err := e.handlers.Handle(ctx, pub); !first || err != nil {
		t.Fatal(first, err)
	}
	if first, _ := e.handlers.Handle(ctx, pub); first {
		t.Fatal("duplicate processed")
	}
	if n := e.scalar(`SELECT count(*) FROM sandbox_language_demand WHERE language_id IN (71, 62)`); n != int64(2) {
		t.Fatalf("demand rows %v", n)
	}
	// KEDA reads two numbers per language through definer functions, nothing else.
	if w := e.scalar(`SELECT sandbox_language_warm(62::smallint)`); w != int32(1) {
		t.Fatalf("java warm %v", w)
	}
	if w := e.scalar(`SELECT sandbox_language_warm(60::smallint)`); w != int32(0) {
		t.Fatalf("go warm %v", w)
	}
	e.submit(newSession(tenant), qid, "python", "SUM", "evt-key-depth1")
	if d := e.scalar(`SELECT sandbox_queue_depth(71::smallint)`); d != int64(1) {
		t.Fatalf("queue depth %v", d)
	}
	e.drain()
	if _, err := e.db.Store.Pool.Exec(ctx, `SELECT sandbox_queue_depth(71::smallint)`); err == nil {
		t.Fatal("the app role can call the metrics function")
	}

	// Erasure: the candidate's code is deleted; acknowledged only when asked.
	other := newSession(tenant)
	e.submit(other, qid, "python", "SUM", "evt-key-000002")
	er := event(app.TopicErasureRequested, tenant, map[string]any{
		"tenant_id": tenant, "request_id": newID(), "candidate_id": s.candidate, "reason": "data_subject",
		"ack_required_from": []string{"assessment-svc"}, "due_at": time.Now().Format(time.RFC3339), "occurred_at": time.Now().Format(time.RFC3339),
	})
	if _, err := e.handlers.Handle(ctx, er); err != nil {
		t.Fatal(err)
	}
	if n := e.scalar(`SELECT count(*) FROM coding_submissions WHERE candidate_id = $1`, s.candidate); n != int64(0) {
		t.Fatalf("erased rows left: %v", n)
	}
	if n := e.scalar(`SELECT count(*) FROM coding_submissions WHERE candidate_id = $1`, other.candidate); n != int64(1) {
		t.Fatal("other candidate erased")
	}
	if len(e.outbox(app.TopicErasureAck)) != 0 {
		t.Fatal("acknowledged without being asked")
	}
	req := newID()
	er2 := event(app.TopicErasureRequested, tenant, map[string]any{"tenant_id": tenant, "request_id": req, "candidate_id": other.candidate, "ack_required_from": []string{"sandbox-svc"}})
	if _, err := e.handlers.Handle(ctx, er2); err != nil {
		t.Fatal(err)
	}
	acks := e.outbox(app.TopicErasureAck)
	if len(acks) != 1 || acks[0].Payload["request_id"] != req || acks[0].Payload["service"] != "sandbox-svc" {
		t.Fatalf("ack %v", acks)
	}

	// Poison payloads are rejected (dead-lettered by the transport) and not marked processed.
	bad := event(app.TopicErasureRequested, tenant, map[string]any{"tenant_id": tenant})
	if _, err := e.handlers.Handle(ctx, bad); err == nil || !strings.Contains(err.Error(), "poison") {
		t.Fatalf("poison: %v", err)
	}
	if n := e.scalar(`SELECT count(*) FROM processed_events WHERE event_id = $1`, bad.EventID); n != int64(0) {
		t.Fatal("poison event marked processed")
	}
	if first, _ := e.handlers.Handle(ctx, event("other.topic.x.v1", tenant, map[string]any{})); first {
		t.Fatal("unknown topic handled")
	}

	// Purge: rows and stored bundles go.
	other2 := newID()
	keep := e.verifiedQuestion(other2)
	if _, err := e.handlers.Handle(ctx, event(app.TopicTenantPurged, tenant, map[string]any{"tenant_id": tenant})); err != nil {
		t.Fatal(err)
	}
	if n := e.scalar(`SELECT count(*) FROM coding_submissions WHERE tenant_id = $1`, tenant); n != int64(0) {
		t.Fatalf("purge left %v submissions", n)
	}
	for _, k := range e.blobs.Keys() {
		if strings.Contains(k, tenant) {
			t.Fatalf("bundle %s survived the purge", k)
		}
	}
	if r := e.do("GET", "/v1/test-case-bundles/"+keep+"/versions/1?tenant_id="+other2, e.svc, nil); r.Status != 200 {
		t.Fatal("another tenant's bundle was purged")
	}
}
