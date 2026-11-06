package test

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/testkit"
)

func TestBundleVerification(t *testing.T) {
	e := setup(t)
	tenant := newID()

	t.Run("a correct reference is verified after 5 identical runs", func(t *testing.T) {
		qid := newID()
		r := e.putBundle(tenant, qid, 1, "SUM", nil)
		if r.Status != 201 || r.Body["status"] != "pending" || r.Body["test_count"] != 3.0 || r.Body["sample_count"] != 1.0 {
			t.Fatalf("put: %d %v", r.Status, r.Body)
		}
		before := e.pool.Runs.Load()
		e.drain()
		if runs := e.pool.Runs.Load() - before; runs != 5*3 {
			t.Fatalf("reference ran %d cases, want 15 (5 × 3)", runs)
		}
		got := e.do("GET", "/v1/test-case-bundles/"+qid+"/versions/1?tenant_id="+tenant, e.svc, nil)
		if got.Body["status"] != "verified" || got.Body["verified_at"] == nil {
			t.Fatalf("status %v", got.Body)
		}
		// Same content again: no-op (200, still verified). Different content: immutable.
		if again := e.putBundle(tenant, qid, 1, "SUM", nil); again.Status != 200 || again.Body["status"] != "verified" {
			t.Fatalf("re-put: %d %v", again.Status, again.Body)
		}
		if changed := e.putBundle(tenant, qid, 1, "SUM", map[string]any{"limits": map[string]any{"cpu_ms": 3000}}); changed.Status != 409 || changed.Body["code"] != "BUNDLE_IMMUTABLE" {
			t.Fatalf("changed verified bundle: %d %v", changed.Status, changed.Body)
		}
	})

	t.Run("a flaky reference is rejected, and re-registering re-verifies", func(t *testing.T) {
		qid := newID()
		e.putBundle(tenant, qid, 1, "FLAKY", nil)
		e.drain()
		got := e.do("GET", "/v1/test-case-bundles/"+qid+"/versions/1?tenant_id="+tenant, e.svc, nil)
		if got.Body["status"] != "flaky" || !strings.Contains(fmt.Sprint(got.Body["status_detail"]), "RESULTS_DIFFER") {
			t.Fatalf("flaky: %v", got.Body)
		}
		if r := e.putBundle(tenant, qid, 1, "SUM", nil); r.Status != 201 {
			t.Fatalf("fixed reference: %d %v", r.Status, r.Body)
		}
		e.drain()
		if got := e.do("GET", "/v1/test-case-bundles/"+qid+"/versions/1?tenant_id="+tenant, e.svc, nil); got.Body["status"] != "verified" {
			t.Fatalf("after fix: %v", got.Body)
		}
	})

	t.Run("a wrong or non-compiling reference fails verification", func(t *testing.T) {
		wrong, ce := newID(), newID()
		e.putBundle(tenant, wrong, 1, "PRINT 7", nil)
		e.do("PUT", "/v1/test-case-bundles/"+ce+"/versions/1?tenant_id="+tenant, e.svc, map[string]any{
			"languages": []string{"cpp"}, "tests": sampleTests(),
			"reference_solution": map[string]any{"language": "cpp", "source": "CE"},
		})
		e.drain()
		w := e.do("GET", "/v1/test-case-bundles/"+wrong+"/versions/1?tenant_id="+tenant, e.svc, nil)
		c := e.do("GET", "/v1/test-case-bundles/"+ce+"/versions/1?tenant_id="+tenant, e.svc, nil)
		if w.Body["status"] != "reference_failed" || w.Body["status_detail"] != "wrong_answer: test 1" {
			t.Fatalf("wrong: %v", w.Body)
		}
		if c.Body["status"] != "reference_failed" || c.Body["status_detail"] != "compilation_error: test 1" {
			t.Fatalf("ce: %v", c.Body)
		}
	})

	t.Run("validation", func(t *testing.T) {
		qid := newID()
		cases := []struct {
			extra map[string]any
			code  string
		}{
			{map[string]any{"languages": []string{"cobol"}}, "UNKNOWN_LANGUAGE"},
			{map[string]any{"languages": []string{"sql"}}, "LANGUAGE_DISABLED"},
			{map[string]any{"limits": map[string]any{"cpu_ms": 16000}}, "INVALID_LIMITS"},
			{map[string]any{"checker": map[string]any{"kind": "regex"}}, "INVALID_CHECKER"},
			{map[string]any{"tests": []any{}}, "INVALID_TESTS"},
			{map[string]any{"languages": []string{"cpp"}}, "INVALID_REFERENCE"},
			{map[string]any{"checker": map[string]any{"kind": "custom"}}, "UNKNOWN_LANGUAGE"},
		}
		for _, c := range cases {
			if r := e.putBundle(tenant, qid, 1, "SUM", c.extra); r.Status != 422 || r.Body["code"] != c.code {
				t.Errorf("%v: %d %v", c.extra, r.Status, r.Body)
			}
		}
		if r := e.do("PUT", "/v1/test-case-bundles/"+qid+"/versions/1?tenant_id="+tenant, e.svc, `{"languages":["python"],"tests":[{"input":"1","expected":"1"}],"reference_solution":{"language":"python","source":"SUM"},"oops":1}`); r.Status != 400 || r.Body["code"] != "VALIDATION_FAILED" {
			t.Errorf("unknown field: %d %v", r.Status, r.Body)
		}
		if r := e.do("PUT", "/v1/test-case-bundles/not-a-uuid/versions/1?tenant_id="+tenant, e.svc, map[string]any{}); r.Status != 400 {
			t.Errorf("bad id: %d", r.Status)
		}
	})
}

func TestSubmissionJudgedWithWeightsAndHiddenTests(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	s := newSession(tenant)

	// Only the hidden weight-3 case fails: 2 of 3 pass, ratio (1 + 1) / (1 + 3 + 1) = 0.4.
	r := e.submit(s, qid, "python", `PRINT 3\n`, "submit-key-0001")
	if r.Status != 202 || r.Body["status"] != "queued" {
		t.Fatalf("submit: %d %v", r.Status, r.Body)
	}
	id := r.Body["submission_id"].(string)
	// Same key, same content: the same submission (one row).
	if again := e.submit(s, qid, "python", `PRINT 3\n`, "submit-key-0001"); again.Body["submission_id"] != id {
		t.Fatalf("idempotency: %v", again.Body)
	}
	if n := e.scalar(`SELECT count(*) FROM coding_submissions WHERE mode = 'submit'`); n != int64(1) {
		t.Fatalf("rows: %v", n)
	}
	// Same key, different code: rejected.
	if reuse := e.submit(s, qid, "python", "SUM", "submit-key-0001"); reuse.Status != 422 || reuse.Body["code"] != "IDEMPOTENCY_KEY_REUSED" {
		t.Fatalf("key reuse: %d %v", reuse.Status, reuse.Body)
	}
	e.drain()

	got := e.submission(tenant, id)
	if got["status"] != "wrong_answer" || got["tests_passed"] != 1.0 || got["tests_total"] != 3.0 {
		t.Fatalf("verdict: %v", got)
	}
	// Case 1 (sample, 3) passes; case 2 (hidden, 10, weight 3) fails; case 3 (hidden, 0) fails.
	if got["score_ratio"] != 0.2 {
		t.Fatalf("ratio %v", got["score_ratio"])
	}
	cases := got["cases"].([]any)
	sample, hidden := cases[0].(map[string]any), cases[1].(map[string]any)
	if sample["verdict"] != "accepted" || sample["stdout"] == nil {
		t.Fatalf("sample case view: %v", sample)
	}
	if _, leaked := hidden["verdict"]; leaked || hidden["passed"] != false || hidden["stdout"] != nil {
		t.Fatalf("hidden case must show pass/fail only: %v", hidden)
	}
	for _, c := range cases {
		for _, k := range []string{"input", "expected"} {
			if _, ok := c.(map[string]any)[k]; ok {
				t.Fatalf("test data leaked: %v", c)
			}
		}
	}
	// One judged event, written with the verdict (outbox).
	events := e.outbox(app.TopicJudged)
	if len(events) != 1 {
		t.Fatalf("events %d", len(events))
	}
	p := events[0].Payload
	if p["submission_id"] != id || p["session_id"] != s.id || p["verdict"] != "wrong_answer" || p["tests_passed"] != 1.0 ||
		p["tests_total"] != 3.0 || p["score_ratio"] != 0.2 || p["submitted_at"] == nil || events[0].Tenant != tenant {
		t.Fatalf("event %v", p)
	}
	// A judged submission is immutable, even for the database owner's app role.
	if _, err := e.db.Owner.Exec(context.Background(), `UPDATE coding_submissions SET status = 'accepted' WHERE submission_id = $1`, id); err == nil {
		t.Fatal("judged submission was changed")
	}

	// Staff see everything except the test data; candidates (service view) never see staff fields.
	staff := testkit.Token(t, "u1", &tenant, []string{"recruiter"}, nil, time.Hour)
	sv := e.do("GET", "/v1/submissions/"+id+"?view=staff", staff, nil)
	if sv.Status != 200 || sv.Body["source"] == nil || sv.Body["cases"].([]any)[1].(map[string]any)["verdict"] != "wrong_answer" {
		t.Fatalf("staff view: %d %v", sv.Status, sv.Body)
	}
	if got["source"] != nil || got["similarity_max"] != nil {
		t.Fatal("candidate view leaks staff fields")
	}
	if r := e.do("GET", "/v1/submissions/"+id+"?view=staff&tenant_id="+tenant, e.svc, nil); r.Status != 403 {
		t.Fatalf("service staff view: %d", r.Status)
	}
	// Tenant isolation: another tenant's staff gets 404.
	other := newID()
	if r := e.do("GET", "/v1/submissions/"+id+"?view=staff", testkit.Token(t, "u2", &other, []string{"recruiter"}, nil, time.Hour), nil); r.Status != 404 {
		t.Fatalf("cross-tenant read: %d", r.Status)
	}
	if r := e.do("GET", "/v1/submissions/"+id+"?view=staff&tenant_id="+other, staff, nil); r.Status != 403 {
		t.Fatalf("tenant user naming another tenant: %d", r.Status)
	}
}

func TestVerdictsThroughTheJudge(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	want := map[string][2]string{
		"SUM":   {"accepted", ""},
		"TLE":   {"time_limit_exceeded", "CPU_TIME"},
		"WALL":  {"time_limit_exceeded", "WALL_TIME"},
		"MLE":   {"memory_limit_exceeded", ""},
		"CRASH": {"runtime_error", "SIGNAL_11"},
		"FORK":  {"runtime_error", "RESOURCE_PROCESSES"},
		"HUGE":  {"output_limit_exceeded", ""},
		"ECHO":  {"wrong_answer", ""},
	}
	ids := map[string]string{}
	for script := range want {
		ids[script] = e.submit(newSession(tenant), qid, "python", script, "k-"+script+"-0000000").Body["submission_id"].(string)
	}
	ce := e.submit(newSession(tenant), qid, "cpp", "CE", "k-ce-000000000").Body["submission_id"].(string)
	e.drain()
	for script, w := range want {
		staff := testkit.Token(t, "u", &tenant, []string{"recruiter"}, nil, time.Hour)
		got := e.do("GET", "/v1/submissions/"+ids[script]+"?view=staff", staff, nil).Body
		if got["status"] != w[0] {
			t.Errorf("%s: status %v, want %s", script, got["status"], w[0])
			continue
		}
		if w[1] != "" && got["cases"].([]any)[0].(map[string]any)["detail"] != w[1] {
			t.Errorf("%s: detail %v, want %s", script, got["cases"].([]any)[0], w[1])
		}
	}
	got := e.submission(tenant, ce)
	if got["status"] != "compilation_error" || !strings.Contains(fmt.Sprint(got["compile_output"]), "error") || got["tests_passed"] != 0.0 {
		t.Fatalf("compile error: %v", got)
	}
	// Severity: a submission whose cases mix WA and TLE reports TLE (fixed by the domain tests);
	// here every case of ECHO is WA except "0 0" → still wrong_answer overall.
}

func TestRuns(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	s := newSession(tenant)

	r := e.run(s, qid, "python", "SUM", nil)
	if r.Status != 202 {
		t.Fatalf("run: %d %v", r.Status, r.Body)
	}
	// Second run within 3 s: throttled with Retry-After.
	th := e.run(s, qid, "python", "SUM", nil)
	if th.Status != 429 || th.Body["code"] != "RUN_THROTTLED" || th.Header.Get("Retry-After") != "3" || th.Body["retry_after"] != 3.0 {
		t.Fatalf("throttle: %d %v %v", th.Status, th.Body, th.Header)
	}
	// Another session is not throttled.
	if other := e.run(newSession(tenant), qid, "python", "SUM", nil); other.Status != 202 {
		t.Fatalf("other session: %d", other.Status)
	}
	e.drain()
	// Sample tests only (1 sample), with output.
	got := e.do("GET", "/v1/runs/"+r.Body["run_id"].(string)+"?tenant_id="+tenant, e.svc, nil).Body
	if got["status"] != "accepted" || len(got["cases"].([]any)) != 1 || got["stdout"] != "3\n" {
		t.Fatalf("sample run: %v", got)
	}
	// Custom stdin: output returned, nothing compared. Runs never emit judged events.
	e.clock.Advance(3 * time.Second)
	in := "40 2"
	r2 := e.run(s, qid, "python", "SUM", &in)
	if r2.Status != 202 {
		t.Fatalf("stdin run: %d %v", r2.Status, r2.Body)
	}
	done := make(chan map[string]any)
	go func() {
		done <- e.do("GET", "/v1/runs/"+r2.Body["run_id"].(string)+"?wait=5&tenant_id="+tenant, e.svc, nil).Body
	}()
	time.Sleep(300 * time.Millisecond) // the long poll is waiting
	e.drain()
	if got := <-done; got["status"] != "accepted" || got["stdout"] != "42\n" {
		t.Fatalf("long-polled stdin run: %v", got)
	}
	if len(e.outbox(app.TopicJudged)) != 0 {
		t.Fatal("runs must not emit judged events")
	}
	// Runs are purged after 24 h; submissions are not.
	sub := e.submit(s, qid, "python", "SUM", "keep-me-000001")
	e.drain()
	e.clock.Advance(25 * time.Hour)
	if _, _, purged, err := e.maint.Tick(context.Background()); err != nil || purged != 3 {
		t.Fatalf("purge: %d %v", purged, err)
	}
	if e.submission(tenant, sub.Body["submission_id"].(string))["status"] != "accepted" {
		t.Fatal("submission purged")
	}
	if got := e.do("GET", "/v1/runs/"+r.Body["run_id"].(string)+"?tenant_id="+tenant, e.svc, nil); got.Status != 404 {
		t.Fatalf("purged run: %d", got.Status)
	}
}

func TestSubmissionRules(t *testing.T) {
	e := setup(t)
	tenant := newID()
	qid := e.verifiedQuestion(tenant)
	s := newSession(tenant)
	body := func(extra map[string]any) map[string]any {
		b := map[string]any{"language": "python", "source": "SUM", "question_version": 1, "candidate_id": s.candidate}
		for k, v := range extra {
			b[k] = v
		}
		return b
	}
	path := "/v1/sessions/" + s.id + "/questions/" + qid + "/submissions?tenant_id=" + tenant
	cases := []struct {
		extra  map[string]any
		status int
		code   string
	}{
		{map[string]any{"active_until": e.clock.Now().Add(-time.Second).Format(time.RFC3339Nano)}, 409, "SESSION_NOT_ACTIVE"},
		{map[string]any{"language": "java"}, 422, "LANGUAGE_NOT_ALLOWED"},
		{map[string]any{"language": "sql"}, 422, "LANGUAGE_DISABLED"},
		{map[string]any{"source": strings.Repeat("x", 65537)}, 422, "SOURCE_TOO_LARGE"},
		{map[string]any{"question_version": 2}, 422, "BUNDLE_NOT_FOUND"},
		{map[string]any{"stdin": "1"}, 400, "VALIDATION_FAILED"},
		{map[string]any{"candidate_id": "x"}, 400, "VALIDATION_FAILED"},
	}
	for i, c := range cases {
		r := e.do("POST", path, e.svc, body(c.extra), "Idempotency-Key", fmt.Sprintf("rule-key-%04d", i))
		if r.Status != c.status || r.Body["code"] != c.code {
			t.Errorf("case %d: %d %v", i, r.Status, r.Body)
		}
	}
	if r := e.do("POST", path, e.svc, body(nil)); r.Status != 428 || r.Body["code"] != "IDEMPOTENCY_KEY_REQUIRED" {
		t.Errorf("no key: %d %v", r.Status, r.Body)
	}
	// Not yet verified → submissions refused (runs allowed, so authors can try samples).
	pending := newID()
	e.putBundle(tenant, pending, 1, "SUM", nil)
	if r := e.submit(s, pending, "python", "SUM", "pending-key-01"); r.Status != 422 || r.Body["code"] != "BUNDLE_NOT_VERIFIED" {
		t.Errorf("unverified: %d %v", r.Status, r.Body)
	}
	if r := e.run(newSession(tenant), pending, "python", "SUM", nil); r.Status != 202 {
		t.Errorf("run on pending bundle: %d", r.Status)
	}
}

func TestAuth(t *testing.T) {
	e := setup(t)
	tenant := newID()
	staff := testkit.Token(t, "u", &tenant, []string{"recruiter"}, nil, time.Hour)
	noScope := testkit.Token(t, "svc_x", nil, []string{"service"}, []string{"other"}, time.Hour)
	expired := testkit.Token(t, "svc", nil, []string{"service"}, []string{app.ScopeExecute}, -time.Hour)
	r := e.do("GET", "/v1/sandbox/languages", "", nil, "x-request-id", "req-12345678")
	if r.Status != 401 || r.Body["code"] != "UNAUTHENTICATED" || r.Header.Get("Content-Type") != "application/problem+json" ||
		r.Body["request_id"] != "req-12345678" || r.Header.Get("x-request-id") != "req-12345678" || r.Body["type"] != "https://errors.atlas.dev/unauthenticated" {
		t.Fatalf("no token: %d %v", r.Status, r.Body)
	}
	if r := e.do("GET", "/v1/sandbox/languages", expired, nil); r.Status != 401 {
		t.Fatalf("expired: %d", r.Status)
	}
	langs := e.do("GET", "/v1/sandbox/languages", staff, nil)
	items := langs.Body["items"].([]any)
	var slugs []string
	for _, i := range items {
		slugs = append(slugs, i.(map[string]any)["slug"].(string))
	}
	sort.Strings(slugs)
	if strings.Join(slugs, ",") != "c,cpp,go,java,node,python" {
		t.Fatalf("languages: %v", slugs)
	}
	py := items[0].(map[string]any)
	if py["default_limits"] == nil {
		t.Fatalf("limits missing: %v", py)
	}
	qid, s := newID(), newSession(tenant)
	if r := e.do("PUT", "/v1/test-case-bundles/"+qid+"/versions/1", staff, map[string]any{}); r.Status != 400 {
		t.Fatalf("staff cannot register bundles: %d %v", r.Status, r.Body)
	}
	for _, tok := range []string{staff, noScope} {
		if r := e.run(session{tenant: tenant, id: s.id, candidate: s.candidate}, qid, "python", "SUM", nil); r.Status == 403 {
			t.Fatal("service token rejected")
		}
		path := "/v1/sessions/" + s.id + "/questions/" + qid + "/runs?tenant_id=" + tenant
		if r := e.do("POST", path, tok, map[string]any{"language": "python", "source": "x", "question_version": 1, "candidate_id": s.candidate}); r.Status != 403 {
			t.Fatalf("run without the execute scope: %d %v", r.Status, r.Body)
		}
	}
	// Service principals must name the tenant.
	if r := e.do("GET", "/v1/runs/"+newID(), e.svc, nil); r.Status != 400 || r.Body["code"] != "TENANT_REQUIRED" {
		t.Fatalf("tenant required: %d %v", r.Status, r.Body)
	}
	if r := e.do("GET", "/healthz", "", nil); r.Status != 200 {
		t.Fatal("healthz")
	}
	if r := e.do("GET", "/readyz", "", nil); r.Status != 200 {
		t.Fatal("readyz")
	}
	big := `{"languages":["python"],"tests":[{"input":"` + strings.Repeat("x", 41<<20) + `","expected":"1"}]}`
	if r := e.do("PUT", "/v1/test-case-bundles/"+qid+"/versions/1?tenant_id="+tenant, e.svc, big); r.Status != 400 {
		t.Fatalf("oversized body: %d", r.Status)
	}
}

// Fair queueing (acceptance): a tenant with a 2,000-job backlog does not starve tenants that
// submit one job each: their p95 wait stays under 2 s.
func TestFairQueueing(t *testing.T) {
	e := setup(t)
	big, small := newID(), make([]string, 10)
	bigQ := e.verifiedQuestion(big)
	ctx := context.Background()
	// Questions first: verifying them drains the queue.
	var qids []string
	for i := range small {
		small[i] = newID()
		qids = append(qids, e.verifiedQuestion(small[i]))
	}
	// 2,000 queued jobs for the big tenant, inserted directly (bulk campus drive).
	if _, err := e.db.Owner.Exec(ctx, `
		INSERT INTO coding_submissions (tenant_id, submission_id, session_id, candidate_id, question_id, question_version,
		  language_id, mode, lane, idempotency_key, source_code, source_sha256, status, queued_at)
		SELECT $1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, 1, 71, 'submit', 'submit',
		  'bulk-key-' || g, 'SLEEPMS 2', sha256('x'), 'queued', now() - interval '1 minute' + g * interval '1 ms'
		FROM generate_series(1, 2000) g`, big, bigQ); err != nil {
		t.Fatal(err)
	}
	e.clock.now = time.Now().UTC()
	runCtx, stop := context.WithCancel(ctx)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		w := e.worker(fmt.Sprintf("w-%d", i))
		w.Clock = app.SystemClock{}
		wg.Add(1)
		go func() { defer wg.Done(); w.Run(runCtx, 5*time.Millisecond) }()
	}
	// Small tenants submit one job each while the backlog is being worked.
	ids := map[string]string{}
	for i, tenant := range small {
		time.Sleep(50 * time.Millisecond)
		e.api.Clock = app.SystemClock{}
		r := e.submit(newSession(tenant), qids[i], "python", "SLEEPMS 2", fmt.Sprintf("small-key-%04d", i))
		ids[tenant] = r.Body["submission_id"].(string)
	}
	deadline := time.Now().Add(20 * time.Second)
	var waits []float64
	for tenant, id := range ids {
		for {
			var started *time.Time
			var queued time.Time
			_ = e.db.Owner.QueryRow(ctx, `SELECT queued_at, started_at FROM coding_submissions WHERE submission_id = $1`, id).Scan(&queued, &started)
			if started != nil {
				waits = append(waits, started.Sub(queued).Seconds())
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("tenant %s starved", tenant)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	stop()
	wg.Wait()
	sort.Float64s(waits)
	p95 := waits[int(float64(len(waits))*0.95+0.5)-1]
	remaining := e.scalar(`SELECT count(*) FROM coding_submissions WHERE tenant_id = $1 AND status = 'queued'`, big)
	t.Logf("small-tenant waits p95 %.3fs (max %.3fs); big tenant still queued: %v", p95, waits[len(waits)-1], remaining)
	if p95 >= 2 {
		t.Fatalf("p95 wait %.2fs ≥ 2 s", p95)
	}
	if remaining == int64(0) {
		t.Fatal("the test must measure while the backlog is still queued")
	}
}
