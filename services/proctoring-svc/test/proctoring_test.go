package test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"atlas.dev/go-platform/pgtx"

	"atlas.dev/proctoring-svc/internal/app"
	"atlas.dev/proctoring-svc/internal/domain"
)

func TestStartAndResume(t *testing.T) {
	e := setup(t)
	tenant := pgtx.NewID()
	c, r := e.start(tenant, nil, map[string]any{"id_verification": true})
	if r.Status != 200 || r.Body["next_seq"] != 1.0 || r.Body["prev_hash"] != "" || len(c.key) != 32 ||
		!strings.HasPrefix(c.token, "apt_") {
		t.Fatalf("start: %d %v", r.Status, r.Body)
	}
	refs := r.Body["references_required"].([]any)
	if len(refs) != 2 || refs[0] != "selfie" || refs[1] != "id_document" {
		t.Fatalf("references %v", refs)
	}
	c.send(c.envelope("heartbeat", map[string]any{}), c.envelope("heartbeat", map[string]any{}))
	old := c.token
	// A page reload: new token and key epoch, the chain continues where it stopped.
	if r := c.restart(nil, nil); r.Status != 200 || r.Body["next_seq"] != 3.0 || r.Body["prev_hash"] == "" || c.epoch != 2 {
		t.Fatalf("resume: %v", r.Body)
	}
	if r := c.send(c.envelope("heartbeat", map[string]any{})); r.Status != 200 || r.Body["accepted"] != 1.0 {
		t.Fatalf("after resume: %v", r.Body)
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE event_type = 'violation:tamper_suspected'`) != 0 {
		t.Fatal("a resume must not look like tampering")
	}
	if r := e.do("POST", "/v1/proctoring/sessions/"+c.session+"/events", "Proctor "+old, map[string]any{"events": []any{}}); r.Status != 401 {
		t.Fatalf("old token: %d", r.Status)
	}
	// Consent, scope and rule validation.
	body := map[string]any{"assessment_id": pgtx.NewID(), "candidate_id": pgtx.NewID(), "consent": map[string]any{"biometrics": false}}
	if r := e.do("PUT", "/v1/proctoring/sessions/"+pgtx.NewID()+"?tenant_id="+tenant, bearer(e.assess), body); r.Body["code"] != "CONSENT_REQUIRED" {
		t.Fatalf("consent: %v", r.Body)
	}
	noCamera := domain.DefaultRules()
	noCamera.Image.Flags = []string{}
	if _, r := e.start(tenant, &noCamera, map[string]any{"consent": map[string]any{"biometrics": false}}); r.Status != 200 || len(r.Body["references_required"].([]any)) != 0 {
		t.Fatalf("no camera, no biometric consent needed: %v", r.Body)
	}
	bad := domain.DefaultRules()
	bad.Image.ConsecutiveFramesPerViolation = 0
	if _, r := e.start(tenant, &bad, nil); r.Status != 422 || r.Body["code"] != "INVALID_RULES" {
		t.Fatalf("rules: %v", r.Body)
	}
	if r := e.do("PUT", "/v1/proctoring/sessions/"+pgtx.NewID()+"?tenant_id="+tenant, e.staff(tenant, "recruiter"), body); r.Status != 403 {
		t.Fatalf("staff cannot start: %d", r.Status)
	}
	if r := e.do("PUT", "/v1/proctoring/sessions/"+pgtx.NewID(), bearer(e.assess), body); r.Body["code"] != "TENANT_REQUIRED" {
		t.Fatalf("tenant: %v", r.Body)
	}
}

// Acceptance: replayed events are de-duplicated; a broken chain is tamper_suspected; client
// clock skew is corrected.
func TestTamperAndIntegrity(t *testing.T) {
	e := setup(t)
	tenant := pgtx.NewID()
	c, _ := e.start(tenant, nil, nil)
	c.clientLag = time.Hour // the client clock is an hour behind
	batch := []json.RawMessage{c.envelope("heartbeat", map[string]any{}), c.envelope("tab_hidden", map[string]any{"duration_ms": 3000})}
	r := c.send(batch...)
	if r.Status != 200 || r.Body["accepted"] != 2.0 || r.Body["last_seq"] != 2.0 {
		t.Fatalf("first batch: %v", r.Body)
	}
	if r := c.send(batch...); r.Body["duplicates"] != 2.0 || r.Body["accepted"] != 0.0 {
		t.Fatalf("replay: %v", r.Body)
	}
	if n := e.count(`SELECT count(*) FROM proctoring_logs WHERE source = 'client_event'`); n != 2 {
		t.Fatalf("replay stored twice: %d", n)
	}
	var occurred time.Time
	_ = e.db.Owner.QueryRow(context.Background(), `SELECT occurred_at FROM proctoring_logs WHERE seq = 2`).Scan(&occurred)
	if d := occurred.Sub(e.clock.Now()); d > time.Second || d < -time.Second {
		t.Fatalf("clock skew not corrected: occurred %v vs server %v", occurred, e.clock.Now())
	}
	// Gzip bodies are accepted.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	_ = json.NewEncoder(gz).Encode(map[string]any{"sent_at": c.clientNow(), "events": []json.RawMessage{c.envelope("heartbeat", map[string]any{})}})
	_ = gz.Close()
	if r := e.do("POST", "/v1/proctoring/sessions/"+c.session+"/events", "Proctor "+c.token, buf.Bytes(), "Content-Encoding", "gzip"); r.Body["accepted"] != 1.0 {
		t.Fatalf("gzip: %d %v", r.Status, r.Body)
	}
	// A broken chain (an event signed over the wrong previous hash) is tamper_suspected.
	c.prev = strings.Repeat("0", 64)
	if r := c.send(c.envelope("heartbeat", map[string]any{})); r.Body["accepted"] != 1.0 {
		t.Fatalf("broken chain still authentic: %v", r.Body)
	}
	// A forged MAC is rejected and recorded; a gap in seq is recorded.
	forged := c.envelope("tab_hidden", map[string]any{"duration_ms": 999999})
	forged = bytes.Replace(forged, []byte(`"mac":"`), []byte(`"mac":"00`), 1)
	r = c.send(forged)
	if r.Body["rejected"] != 1.0 {
		t.Fatalf("forged MAC: %v", r.Body)
	}
	c.seq += 3 // three events suppressed
	c.send(c.envelope("heartbeat", map[string]any{}))
	reasons := map[string]int{}
	for _, row := range e.outbox(app.TopicViolation) {
		if row.Payload["rule"] == "tamper_suspected" && row.Payload["action"] == "review" {
			reasons["n"]++
		}
	}
	rows, _ := e.db.Owner.Query(context.Background(), `SELECT payload->>'reason' FROM proctoring_logs WHERE event_type = 'violation:tamper_suspected'`)
	for rows.Next() {
		var reason string
		_ = rows.Scan(&reason)
		reasons[reason]++
	}
	rows.Close()
	if reasons["chain_broken"] != 1 || reasons["bad_mac"] != 1 || reasons["sequence_gap"] != 1 || reasons["n"] != 3 {
		t.Fatalf("tamper reasons %v", reasons)
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE source = 'client_event' AND event_type = 'tab_hidden' AND (payload->>'duration_ms')::int = 999999`) != 0 {
		t.Fatal("a forged event reached the log as a client event")
	}
	// A sudden clock jump (> 5 s against the median) is tamper evidence too.
	c.clientLag = time.Hour - 30*time.Second
	c.send(c.envelope("heartbeat", map[string]any{}))
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE payload->>'reason' = 'clock_jump'`) != 1 {
		t.Fatal("clock jump not flagged")
	}
	// Events older than 24 h (an offline queue flushed a day late) are recorded, never scored.
	c2, _ := e.start(tenant, nil, nil)
	c2.send(c2.envelope("heartbeat", map[string]any{})) // a live clock sample: offset 0
	c2.clientLag = 25 * time.Hour
	stale := c2.envelope("tab_hidden", map[string]any{"duration_ms": 90000})
	c2.clientLag = 0
	if r := e.do("POST", "/v1/proctoring/sessions/"+c2.session+"/events", "Proctor "+c2.token,
		map[string]any{"sent_at": c2.clientNow(), "events": []json.RawMessage{stale}}); r.Body["accepted"] != 1.0 || len(r.Body["notices"].([]any)) != 0 {
		t.Fatalf("stale event: %v", r.Body)
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE session_id = $1 AND payload->>'late' = 'true'`, c2.session) != 1 ||
		e.count(`SELECT count(*) FROM proctoring_logs WHERE session_id = $1 AND event_type LIKE 'violation:%'`, c2.session) != 0 {
		t.Fatal("a day-old event drove the rules")
	}
	// Malformed events are rejected without effect; empty batches are refused.
	if r := c.send(json.RawMessage(`{"seq":"x"}`)); r.Body["rejected"] != 1.0 {
		t.Fatalf("malformed: %v", r.Body)
	}
	if r := c.send(); r.Status != 400 {
		t.Fatalf("empty batch: %d", r.Status)
	}
	if r := e.do("POST", "/v1/proctoring/sessions/"+c.session+"/events", "Proctor "+c.token, "not json"); r.Status != 400 {
		t.Fatalf("bad body: %d", r.Status)
	}
	if r := e.do("POST", "/v1/proctoring/sessions/"+c.session+"/events", "Proctor "+c.token, []byte("garbage"), "Content-Encoding", "gzip"); r.Status != 400 {
		t.Fatalf("bad gzip: %d", r.Status)
	}
	// The server-side log chain verifies, and detects edits made behind the service's back.
	if tl := e.timeline(tenant, c.session); tl["chain_valid"] != true {
		t.Fatal("chain should be valid")
	}
	if _, err := e.db.Owner.Exec(context.Background(), `UPDATE proctoring_logs SET payload = '{"edited":true}' WHERE seq = 1`); err != nil {
		t.Fatal(err)
	}
	if tl := e.timeline(tenant, c.session); tl["chain_valid"] != false {
		t.Fatal("an edited row must break the chain")
	}
	// The app role cannot update or delete log rows at all.
	if _, err := e.db.Pool.Exec(context.Background(), `UPDATE proctoring_logs SET severity = 0`); err == nil {
		t.Fatal("app role updated the append-only log")
	}
}

func TestKeyRotation(t *testing.T) {
	e := setup(t)
	c, _ := e.start(pgtx.NewID(), nil, nil)
	e.clock.Advance(app.KeyRotation + time.Second)
	r := c.send(c.envelope("heartbeat", map[string]any{}))
	if r.Body["next_key"] == nil || r.Body["key_epoch"] != 2.0 {
		t.Fatalf("rotation: %v", r.Body)
	}
	c.epoch = 2
	c.key = mustB64(r.Body["next_key"].(string))
	if r := c.send(c.envelope("heartbeat", map[string]any{})); r.Body["accepted"] != 1.0 {
		t.Fatalf("new key: %v", r.Body)
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE event_type = 'violation:tamper_suspected'`) != 0 {
		t.Fatal("rotation looked like tampering")
	}
}

func mustB64(s string) []byte {
	b, _ := json.Marshal(s)
	var out []byte
	_ = json.Unmarshal(b, &out)
	return out
}

// Termination at the threshold emits the event assessment-svc consumes to terminate the session.
// The payload is the contract fixture assessment-svc's own test replays.
func TestWindowRulesTerminateAndNoticeTheClient(t *testing.T) {
	e := setup(t)
	tenant := pgtx.NewID()
	c, _ := e.start(tenant, nil, nil)
	for i := 0; i < 4; i++ {
		r := c.send(c.envelope("tab_hidden", map[string]any{"duration_ms": 30000}))
		if notices := r.Body["notices"].([]any); len(notices) != 1 || notices[0].(map[string]any)["action"] != "flag" {
			t.Fatalf("notice %d: %v", i, r.Body)
		}
	}
	r := c.send(c.envelope("fullscreen_exit", map[string]any{}))
	notice := r.Body["notices"].([]any)[0].(map[string]any)
	if notice["action"] != "terminate" || notice["rule"] != "window_violation" {
		t.Fatalf("5th window violation: %v", r.Body)
	}
	events := e.outbox(app.TopicViolation)
	last := events[len(events)-1].Payload
	if last["action"] != "terminate" || last["session_id"] != c.session || last["tenant_id"] != tenant || last["trust_score"] != 100.0-4*4-3 {
		t.Fatalf("termination event %v", last)
	}
	// Short absences (≤ 10 s) are not violations; pastes > 200 chars count.
	c2, _ := e.start(tenant, nil, nil)
	if r := c2.send(c2.envelope("tab_hidden", map[string]any{"duration_ms": 9000}), c2.envelope("paste", map[string]any{"chars": 512})); len(r.Body["notices"].([]any)) != 1 {
		t.Fatalf("paste only: %v", r.Body)
	}
	writeFixture(t, "proctoring.violation.raised.v1.terminate.json", map[string]any{
		"topic": app.TopicViolation, "payload": last,
	}, "tenant_id", "session_id", "occurred_at")
}

// writeFixture records a produced payload for the consumer's contract test (assessment-svc).
// Ids and times are replaced by placeholders the consumer fills in.
func writeFixture(t *testing.T, name string, v map[string]any, placeholders ...string) {
	t.Helper()
	payload := map[string]any{}
	for k, x := range v["payload"].(map[string]any) {
		payload[k] = x
	}
	for _, p := range placeholders {
		payload[p] = "{{" + p + "}}"
	}
	v["payload"] = payload
	data, _ := json.MarshalIndent(v, "", "  ")
	path := filepath.Join("..", "..", "..", "packages", "contracts", "fixtures", name)
	if old, err := os.ReadFile(path); err == nil && os.Getenv("UPDATE_FIXTURES") == "" {
		if !bytes.Equal(bytes.TrimSpace(old), bytes.TrimSpace(data)) {
			t.Fatalf("%s changed: the producer broke its contract (rerun with UPDATE_FIXTURES=1 if intended)\n%s", name, data)
		}
		return
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAccommodations(t *testing.T) {
	e := setup(t)
	tenant := pgtx.NewID()
	session := pgtx.NewID()
	path := "/v1/proctoring/sessions/" + session + "/accommodations"
	// Granted before the session starts, by a recruiter, with a reason (audited).
	if r := e.do("PUT", path, e.staff(tenant, "reviewer"), map[string]any{"disabled_rules": []string{"window_violation"}, "reason": "screen reader"}); r.Status != 403 {
		t.Fatalf("reviewers cannot grant: %d", r.Status)
	}
	if r := e.do("PUT", path, e.staff(tenant, "recruiter"), map[string]any{"disabled_rules": []string{"everything"}, "reason": "x y z"}); r.Body["code"] != "INVALID_ACCOMMODATION" {
		t.Fatalf("invalid: %v", r.Body)
	}
	if r := e.do("PUT", path, e.staff(tenant, "recruiter"), map[string]any{"disabled_rules": []string{"window_violation", "fullscreen", "window_violation"}, "reason": "uses a screen reader"}); r.Status != 200 {
		t.Fatalf("grant: %d %v", r.Status, r.Body)
	}
	c, r := e.start(tenant, nil, nil)
	_ = r
	c.session = session
	c.restart(nil, nil)
	for i := 0; i < 6; i++ {
		if r := c.send(c.envelope("tab_hidden", map[string]any{"duration_ms": 90000})); len(r.Body["notices"].([]any)) != 0 {
			t.Fatalf("accommodated rule fired: %v", r.Body)
		}
	}
	tl := e.timeline(tenant, session)
	if rules := tl["disabled_rules"].([]any); len(rules) != 2 {
		t.Fatalf("disabled %v", rules)
	}
	audits := 0
	for _, entry := range tl["entries"].([]any) {
		if entry.(map[string]any)["event_type"] == "accommodation_applied" {
			audits++
			if entry.(map[string]any)["payload"].(map[string]any)["reason"] != "uses a screen reader" {
				t.Fatal("audit reason")
			}
		}
	}
	if audits != 1 {
		t.Fatalf("audit rows %d", audits)
	}
	// Granted mid-session: applied at once, audited again.
	if r := e.do("PUT", path, e.staff(tenant, "tenant_admin"), map[string]any{"disabled_rules": []string{"paste"}, "reason": "dictation software"}); r.Status != 200 {
		t.Fatal(r.Body)
	}
	if r := c.send(c.envelope("paste", map[string]any{"chars": 5000}), c.envelope("tab_hidden", map[string]any{"duration_ms": 30000})); len(r.Body["notices"].([]any)) != 1 {
		t.Fatalf("paste disabled, window rules back: %v", r.Body)
	}
}

func TestDetectionCascadeResults(t *testing.T) {
	e := setup(t)
	tenant := pgtx.NewID()
	rules := domain.DefaultRules()
	rules.Image.TerminateAfterWarnings = 2
	c, _ := e.start(tenant, &rules, map[string]any{"id_verification": true})
	// Reference: a selfie with one face is stored (encrypted), the ID matches it.
	me := embedding(1)
	selfie := c.upload("selfie")
	uploaded := e.outbox(app.TopicFrameUploaded)
	if len(uploaded) != 1 || uploaded[0].Payload["kind"] != "selfie" || !strings.HasPrefix(uploaded[0].Payload["object_key"].(string), "t/"+tenant+"/proctor/"+c.session+"/") {
		t.Fatalf("frame announced: %v", uploaded)
	}
	if r := c.infer(selfie, frame(1, me)); r.Status != 204 {
		t.Fatalf("selfie: %d %v", r.Status, r.Body)
	}
	var stored []byte
	_ = e.db.Owner.QueryRow(context.Background(), `SELECT reference_embeddings FROM proctoring_sessions WHERE session_id = $1`, c.session).Scan(&stored)
	if len(stored) == 0 || bytes.Contains(stored, []byte("[[")) || json.Valid(stored) {
		t.Fatal("reference embedding must be stored encrypted")
	}
	id := c.upload("id_document")
	c.infer(id, frame(1, me))
	if tl := e.timeline(tenant, c.session); tl["reference_status"] != "verified" {
		t.Fatalf("reference %v", tl["reference_status"])
	}
	// Redelivered results are ignored.
	if r := c.infer(selfie, frame(1, embedding(9))); r.Status != 204 {
		t.Fatal(r.Body)
	}
	// Two faces in three consecutive frames: one violation. A dark frame in between is excluded.
	two := frame(2, nil)
	dark := frame(2, nil)
	dark["quality"] = map[string]any{"luminance": 20, "blur_variance": 300}
	for i, body := range []map[string]any{two, two, dark, two} {
		c.infer(c.upload("frame"), body)
		got := e.count(`SELECT count(*) FROM proctoring_logs WHERE event_type = 'violation:multiple_faces'`)
		want := 0
		if i == 3 {
			want = 1
		}
		if got != want {
			t.Fatalf("frame %d: %d violations", i, got)
		}
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE event_type = 'inference:frame' AND payload->>'low_quality' = 'true'`) != 1 {
		t.Fatal("low-light frame not labelled low_quality")
	}
	// A mismatched identity (another person's embedding) and a phone, three frames in a row.
	stranger := embedding(42)
	for i := 0; i < 3; i++ {
		c.infer(c.upload("frame"), frame(1, stranger, "phone"))
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE event_type = 'violation:face_mismatch' AND severity = 3`) != 1 ||
		e.count(`SELECT count(*) FROM proctoring_logs WHERE event_type = 'violation:phone'`) != 1 {
		t.Fatal("mismatch / phone")
	}
	// TerminateAfterWarnings = 2 was reached by the second image violation...
	terminations := 0
	for _, ev := range e.outbox(app.TopicViolation) {
		if ev.Payload["action"] == "terminate" {
			terminations++
		}
	}
	if terminations != 1 {
		t.Fatalf("terminations %d", terminations)
	}
	// ...but a frame analysed more than 5 minutes late never terminates.
	c2, _ := e.start(tenant, &rules, nil)
	c2.infer(c2.upload("selfie"), frame(1, me))
	ids := []string{}
	for i := 0; i < 6; i++ {
		ids = append(ids, c2.upload("frame"))
	}
	e.clock.Advance(6 * time.Minute)
	for _, id := range ids {
		c2.infer(id, frame(0, nil))
	}
	for _, ev := range e.outbox(app.TopicViolation) {
		if ev.Payload["session_id"] == c2.session && ev.Payload["action"] == "terminate" {
			t.Fatal("late inference terminated a session")
		}
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE session_id = $1 AND payload->>'termination_suspended' = 'late_inference'`, c2.session) == 0 {
		t.Fatal("suspension not recorded")
	}
	// An ID that does not match the selfie goes to a reviewer.
	c3, _ := e.start(tenant, nil, map[string]any{"id_verification": true})
	c3.infer(c3.upload("selfie"), frame(1, me))
	c3.infer(c3.upload("id_document"), frame(1, stranger))
	if tl := e.timeline(tenant, c3.session); tl["reference_status"] != "id_mismatch" {
		t.Fatal("id mismatch")
	}
	// No face on the selfie: the client is told to retake it.
	c4, _ := e.start(tenant, nil, nil)
	c4.infer(c4.upload("selfie"), frame(0, nil))
	r := c4.send(c4.envelope("heartbeat", map[string]any{}))
	if notices := r.Body["notices"].([]any); len(notices) != 1 || notices[0].(map[string]any)["rule"] != "retake_selfie" {
		t.Fatalf("retake: %v", r.Body)
	}
	// Audio: two speakers for ≥ 8 s.
	c4.infer(c4.upload("audio"), map[string]any{"audio": map[string]any{"speakers": 2, "speech_s": 9, "window_s": 10}})
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE session_id = $1 AND event_type = 'violation:multiple_speakers'`, c4.session) != 1 {
		t.Fatal("audio")
	}
	// Validation and authorisation of results.
	f := c4.upload("frame")
	if r := c4.infer(f, map[string]any{"faces": 1, "embedding": []float32{1, 2}}); r.Status != 400 {
		t.Fatalf("bad embedding: %d", r.Status)
	}
	if r := e.do("POST", "/v1/proctoring/frames/"+f+":inference?tenant_id="+tenant, bearer(e.assess), frame(1, nil)); r.Status != 403 {
		t.Fatalf("wrong scope: %d", r.Status)
	}
	if r := e.do("POST", "/v1/proctoring/frames/"+f+":nope?tenant_id="+tenant, bearer(e.infer), frame(1, nil)); r.Status != 404 {
		t.Fatalf("unknown verb: %d", r.Status)
	}
	if r := c4.infer(pgtx.NewID(), frame(1, nil)); r.Status != 404 {
		t.Fatalf("unknown frame: %d", r.Status)
	}
	if r := c4.infer(f, map[string]any{"error": "object_missing"}); r.Status != 204 {
		t.Fatal("missing object result")
	}
	if r := e.do("POST", "/v1/proctoring/sessions/"+c4.session+"/frames:initiateUpload", "Proctor "+c4.token, map[string]any{"kind": "frame", "content_type": "image/png"}); r.Body["code"] != "UNSUPPORTED_UPLOAD" {
		t.Fatalf("png: %v", r.Body)
	}
}

func TestFinaliseReviewAndEvidence(t *testing.T) {
	e := setup(t)
	tenant := pgtx.NewID()
	c, _ := e.start(tenant, nil, nil)
	me := embedding(3)
	c.infer(c.upload("selfie"), frame(1, me))
	for i := 0; i < 6; i++ { // two multiple_faces violations
		c.infer(c.upload("frame"), frame(2, nil))
	}
	clean := c.upload("frame")
	c.infer(clean, frame(1, me))
	c.send(c.envelope("fullscreen_exit", map[string]any{}))
	c.prev = "broken"
	c.send(c.envelope("heartbeat", map[string]any{})) // tamper_suspected (25)
	// 100 − 2×12 − 3 − 25 = 48 → red, review required.
	if err := e.event(app.TopicSessionSubmitted, tenant, map[string]any{"tenant_id": tenant, "session_id": c.session}); err != nil {
		t.Fatal(err)
	}
	fin := e.outbox(app.TopicFinalized)
	if len(fin) != 1 {
		t.Fatalf("finalized %d", len(fin))
	}
	p := fin[0].Payload
	if p["trust_score"] != 48.0 || p["band"] != "red" || p["review_required"] != true || p["revision"] != 1.0 || p["assessment_id"] != c.assess {
		t.Fatalf("finalized %v", p)
	}
	b := p["breakdown"].(map[string]any)
	if b["multiple_faces"] != 24.0 || b["fullscreen_exit"] != 3.0 || b["tamper_suspected"] != 25.0 {
		t.Fatalf("breakdown %v", b)
	}
	writeFixture(t, "proctoring.session.finalized.v1.red.json", map[string]any{"topic": app.TopicFinalized, "payload": p},
		"tenant_id", "session_id", "assessment_id", "occurred_at")
	// A redelivered submitted event changes nothing; proctoring ended.
	_ = e.event(app.TopicSessionSubmitted, tenant, map[string]any{"tenant_id": tenant, "session_id": c.session})
	if len(e.outbox(app.TopicFinalized)) != 1 {
		t.Fatal("finalized twice")
	}
	if r := c.send(c.envelope("heartbeat", map[string]any{})); r.Body["code"] != "PROCTORING_FINALIZED" {
		t.Fatalf("after finalisation: %v", r.Body)
	}
	// Flagged frames are kept as evidence; clean frames are not copied.
	keys := strings.Join(e.blobs.Keys(), "\n")
	if strings.Count(keys, "/evidence/") != 6 || strings.Contains(keys, "/evidence/"+c.session+"/"+clean) {
		t.Fatalf("evidence %s", keys)
	}
	// Timeline: signed URLs and reviews.
	tl := e.timeline(tenant, c.session)
	var flagID float64
	urls := 0
	for _, entry := range tl["entries"].([]any) {
		m := entry.(map[string]any)
		if m["frame_url"] != nil {
			urls++
			if !strings.Contains(m["frame_url"].(string), "ttl=15m") {
				t.Fatal("signed URL TTL")
			}
		}
		if m["event_type"] == "violation:tamper_suspected" {
			flagID = m["log_id"].(float64)
		}
	}
	if urls == 0 || flagID == 0 || tl["band"] != "red" {
		t.Fatalf("timeline %v", tl)
	}
	// A reviewer dismisses the tamper flag: the session is re-finalised (revision 2), 48 → 73.
	path := "/v1/proctoring/flags/" + itoa(flagID) + ":review"
	if r := e.do("POST", path, e.staff(tenant, "hiring_manager"), map[string]any{"decision": "dismissed"}); r.Status != 403 {
		t.Fatalf("hiring managers read, they do not decide: %d", r.Status)
	}
	r := e.do("POST", path, e.staff(tenant, "reviewer"), map[string]any{"decision": "dismissed", "comment": "page reload"})
	if r.Status != 200 || r.Body["rule"] != "tamper_suspected" {
		t.Fatalf("review: %d %v", r.Status, r.Body)
	}
	fin = e.outbox(app.TopicFinalized)
	if len(fin) != 2 || fin[1].Payload["trust_score"] != 73.0 || fin[1].Payload["band"] != "yellow" || fin[1].Payload["revision"] != 2.0 || fin[1].Payload["review_required"] != false {
		t.Fatalf("re-finalised %v", fin[len(fin)-1].Payload)
	}
	if r := e.do("POST", path, e.staff(tenant, "reviewer"), map[string]any{"decision": "confirmed"}); r.Body["code"] != "ALREADY_REVIEWED" {
		t.Fatalf("second decision: %v", r.Body)
	}
	for _, bad := range []struct {
		path string
		body map[string]any
		code int
	}{
		{path, map[string]any{"decision": "maybe"}, 400},
		{"/v1/proctoring/flags/abc:review", map[string]any{"decision": "confirmed"}, 400},
		{"/v1/proctoring/flags/999999:review", map[string]any{"decision": "confirmed"}, 404},
	} {
		if r := e.do("POST", bad.path, e.staff(tenant, "reviewer"), bad.body); r.Status != bad.code {
			t.Errorf("%s: %d", bad.path, r.Status)
		}
	}
	// A non-violation row is not a flag.
	var startID float64
	for _, entry := range e.timeline(tenant, c.session)["entries"].([]any) {
		if entry.(map[string]any)["event_type"] == "proctoring_started" {
			startID = entry.(map[string]any)["log_id"].(float64)
		}
	}
	if r := e.do("POST", "/v1/proctoring/flags/"+itoa(startID)+":review", e.staff(tenant, "reviewer"), map[string]any{"decision": "confirmed"}); r.Status != 404 {
		t.Fatalf("non-flag: %d", r.Status)
	}
	// Tenant isolation of evidence.
	other := pgtx.NewID()
	if r := e.do("GET", "/v1/proctoring/sessions/"+c.session+"/timeline", e.staff(other, "reviewer"), nil); r.Status != 404 {
		t.Fatalf("cross-tenant timeline: %d", r.Status)
	}
	if r := e.do("GET", "/v1/proctoring/sessions/"+c.session+"/timeline?tenant_id="+other, e.staff(tenant, "reviewer"), nil); r.Status != 403 {
		t.Fatalf("tenant staff naming another tenant: %d", r.Status)
	}
	if r := e.do("GET", "/v1/proctoring/sessions/"+c.session+"/timeline", e.staff(tenant, "candidate"), nil); r.Status != 403 {
		t.Fatalf("candidate timeline: %d", r.Status)
	}
}

func itoa(f float64) string { b, _ := json.Marshal(int64(f)); return string(b) }

func TestLateInferenceRevisesTheReport(t *testing.T) {
	e := setup(t)
	tenant := pgtx.NewID()
	c, _ := e.start(tenant, nil, nil)
	var ids []string
	for i := 0; i < 3; i++ {
		ids = append(ids, c.upload("frame"))
	}
	_ = e.event(app.TopicSessionTerminated, tenant, map[string]any{"tenant_id": tenant, "session_id": c.session})
	for _, id := range ids {
		c.infer(id, frame(2, nil))
	}
	fin := e.outbox(app.TopicFinalized)
	if len(fin) != 2 || fin[0].Payload["trust_score"] != 100.0 || fin[1].Payload["trust_score"] != 88.0 {
		t.Fatalf("late results must revise: %v", fin)
	}
	// Submitted for a session that never started proctoring: nothing to do.
	if err := e.event(app.TopicSessionSubmitted, tenant, map[string]any{"tenant_id": tenant, "session_id": pgtx.NewID()}); err != nil {
		t.Fatal(err)
	}
	if err := e.event(app.TopicSessionStarted, tenant, map[string]any{"tenant_id": tenant, "session_id": pgtx.NewID()}); err != nil {
		t.Fatal(err)
	}
	if err := e.event(app.TopicSessionSubmitted, tenant, map[string]any{"tenant_id": tenant}); err == nil {
		t.Fatal("poison event accepted")
	}
}

// Acceptance: partition retention drops old partitions; frame retention purges frames and
// biometric references; silent sessions get a network_gap (not a violation).
func TestRetentionAndMaintenance(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	tenant := pgtx.NewID()
	e.retention.Days[tenant] = 7
	c, _ := e.start(tenant, nil, nil)
	c.infer(c.upload("selfie"), frame(1, embedding(5)))
	for i := 0; i < 3; i++ {
		c.infer(c.upload("frame"), frame(0, nil))
	}
	clean := c.upload("frame")
	c.infer(clean, frame(1, embedding(5)))
	_ = e.event(app.TopicSessionSubmitted, tenant, map[string]any{"tenant_id": tenant, "session_id": c.session})
	// An old partition (two years ago) as pg_partman would have left it.
	if _, err := e.db.Owner.Exec(ctx, `CREATE TABLE proctoring_logs_2024_01 PARTITION OF proctoring_logs FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')`); err != nil {
		t.Fatal(err)
	}
	rep, err := e.maint.Tick(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.PartitionsDropped) != 1 || rep.PartitionsDropped[0] != "proctoring_logs_2024_01" || rep.FramesPurged != 0 {
		t.Fatalf("tick 1: %+v", rep)
	}
	if e.count(`SELECT count(*) FROM pg_class WHERE relname LIKE 'proctoring_logs_20%'`) < 4 {
		t.Fatal("partitions ahead")
	}
	e.clock.Advance(8 * 24 * time.Hour)
	rep, _ = e.maint.Tick(ctx)
	if rep.FramesPurged != 5 {
		t.Fatalf("frames purged %+v", rep)
	}
	keys := strings.Join(e.blobs.Keys(), "\n")
	if strings.Contains(keys, "/proctor/") || strings.Count(keys, "/evidence/") != 3 {
		t.Fatalf("after retention: %s", keys)
	}
	var refs []byte
	var status string
	_ = e.db.Owner.QueryRow(ctx, `SELECT reference_embeddings, reference_status FROM proctoring_sessions WHERE session_id = $1`, c.session).Scan(&refs, &status)
	if refs != nil || status != "deleted" {
		t.Fatal("biometric references must be deleted at retention end")
	}
	// Retention settings change: the cache is invalidated.
	_ = e.event(app.TopicSettingsUpdated, tenant, map[string]any{"tenant_id": tenant, "changed_keys": []string{"retention_policy.proctoring_frames_days"}})
	if len(e.retention.Invalidated) != 1 {
		t.Fatal("retention cache not invalidated")
	}
	// A candidate whose events stop: one network_gap row, never a violation.
	c2, _ := e.start(tenant, nil, nil)
	c2.send(c2.envelope("heartbeat", map[string]any{}))
	e.clock.Advance(time.Minute)
	e.maint.Tick(ctx)
	e.maint.Tick(ctx)
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE session_id = $1 AND event_type = 'network_gap' AND severity = 0`, c2.session) != 1 {
		t.Fatal("network gap")
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE session_id = $1 AND event_type LIKE 'violation:%'`, c2.session) != 0 {
		t.Fatal("a network gap is not a violation")
	}
	// Evidence copies that failed are retried by maintenance.
	c3, _ := e.start(tenant, nil, nil)
	for i := 0; i < 3; i++ {
		c3.infer(c3.upload("frame"), frame(0, nil))
	}
	e.blobs.Fail = true
	_ = e.event(app.TopicSessionSubmitted, tenant, map[string]any{"tenant_id": tenant, "session_id": c3.session})
	e.blobs.Fail = false
	if rep, _ := e.maint.Tick(ctx); rep.EvidenceCopied != 3 {
		t.Fatalf("evidence retry %+v", rep)
	}
}

func TestErasureAndPurge(t *testing.T) {
	e := setup(t)
	tenant := pgtx.NewID()
	c, _ := e.start(tenant, nil, nil)
	c.infer(c.upload("frame"), frame(2, nil))
	keep, _ := e.start(tenant, nil, nil)
	keep.send(keep.envelope("heartbeat", map[string]any{}))
	req := pgtx.NewID()
	payload := map[string]any{"tenant_id": tenant, "request_id": req, "candidate_id": c.person, "ack_required_from": []string{"proctoring-svc"}}
	if err := e.event(app.TopicErasureRequested, tenant, payload); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE session_id = $1`, c.session) != 0 ||
		e.count(`SELECT count(*) FROM proctoring_sessions WHERE session_id = $1`, c.session) != 0 ||
		e.count(`SELECT count(*) FROM proctoring_frames WHERE session_id = $1`, c.session) != 0 {
		t.Fatal("erasure left rows")
	}
	if strings.Contains(strings.Join(e.blobs.Keys(), ","), c.session) {
		t.Fatal("erasure left objects")
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE session_id = $1`, keep.session) == 0 {
		t.Fatal("another candidate erased")
	}
	acks := e.outbox(app.TopicErasureAck)
	if len(acks) != 1 || acks[0].Payload["request_id"] != req || acks[0].Payload["service"] != "proctoring-svc" {
		t.Fatalf("ack %v", acks)
	}
	if err := e.event(app.TopicErasureRequested, tenant, map[string]any{"tenant_id": tenant, "request_id": pgtx.NewID(), "candidate_id": pgtx.NewID(), "ack_required_from": []string{}}); err != nil {
		t.Fatal(err)
	}
	if len(e.outbox(app.TopicErasureAck)) != 1 {
		t.Fatal("acknowledged without being asked")
	}
	if err := e.event(app.TopicTenantPurged, tenant, map[string]any{"tenant_id": tenant}); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM proctoring_logs WHERE tenant_id = $1`, tenant) != 0 || len(e.blobs.Keys()) != 0 {
		t.Fatal("purge")
	}
}

func TestProbesAndAuth(t *testing.T) {
	e := setup(t)
	if r := e.do("GET", "/healthz", "", nil); r.Status != 200 {
		t.Fatal("healthz")
	}
	if r := e.do("GET", "/readyz", "", nil); r.Status != 200 {
		t.Fatal("readyz")
	}
	c, _ := e.start(pgtx.NewID(), nil, nil)
	other, _ := e.start(pgtx.NewID(), nil, nil)
	for _, h := range []string{"", "Bearer x", "Proctor nope", "Proctor " + other.token} {
		if r := e.do("POST", "/v1/proctoring/sessions/"+c.session+"/events", h, map[string]any{"events": []any{}}); r.Status != 401 {
			t.Errorf("%q: %d", h, r.Status)
		}
	}
	if r := e.do("POST", "/v1/proctoring/sessions/not-a-uuid/events", "Proctor "+c.token, map[string]any{}); r.Status != 400 {
		t.Fatalf("bad id: %d", r.Status)
	}
	if r := e.do("GET", "/v1/proctoring/sessions/"+c.session+"/timeline", "", nil); r.Status != 401 {
		t.Fatal("timeline needs a token")
	}
}
