package domain

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type vectorFile struct {
	KeyHex    string `json:"key_hex"`
	SessionID string `json:"session_id"`
	Vectors   []struct {
		Wire              string `json:"wire"`
		CanonicalUnsigned string `json:"canonical_unsigned"`
		MAC               string `json:"mac"`
		Hash              string `json:"hash"`
	} `json:"vectors"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contracts", "fixtures", "proctor-envelope-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The SDK (JSON.stringify) and the server must agree byte for byte (ADR-0007).
func TestEnvelopeVectorsMatchTheBrowser(t *testing.T) {
	v := loadVectors(t)
	key, _ := hex.DecodeString(v.KeyHex)
	keyFor := func(epoch int) ([]byte, bool) { return key, epoch == 1 }
	prev := ""
	for i, vec := range v.Vectors {
		dec := json.NewDecoder(strings.NewReader(vec.Wire))
		dec.UseNumber()
		var m map[string]any
		if err := dec.Decode(&m); err != nil {
			t.Fatal(err)
		}
		delete(m, "mac")
		got, err := Canonical(m)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != vec.CanonicalUnsigned {
			t.Fatalf("vector %d canonical:\n got %s\nwant %s", i, got, vec.CanonicalUnsigned)
		}
		e, err := ParseEnvelope(json.RawMessage(vec.Wire), v.SessionID, keyFor)
		if err != nil {
			t.Fatalf("vector %d: %v", i, err)
		}
		if e.Hash != vec.Hash || e.PrevHash != prev || e.Seq != int64(i+1) {
			t.Fatalf("vector %d chain: %s prev %q", i, e.Hash, e.PrevHash)
		}
		prev = e.Hash
	}
	// Tampering with any byte breaks the MAC; wrong epochs and sessions are rejected.
	wire := v.Vectors[1].Wire
	if _, err := ParseEnvelope(json.RawMessage(strings.Replace(wire, "4200", "4201", 1)), v.SessionID, keyFor); !errors.Is(err, ErrBadMAC) {
		t.Fatalf("tampered payload: %v", err)
	}
	if _, err := ParseEnvelope(json.RawMessage(wire), v.SessionID, func(int) ([]byte, bool) { return nil, false }); !errors.Is(err, ErrBadMAC) {
		t.Fatal("unknown epoch must fail the MAC")
	}
	if _, err := ParseEnvelope(json.RawMessage(wire), "0192f0c1-0000-7000-8000-000000000000", keyFor); !errors.Is(err, ErrMalformed) {
		t.Fatal("other session accepted")
	}
	bad := []string{
		`not json`,
		`{"session_id":"` + v.SessionID + `","seq":0,"type":"heartbeat","client_ts":1,"key_epoch":1,"payload":{},"prev_hash":"","mac":""}`,
		`{"session_id":"` + v.SessionID + `","seq":1.5,"type":"heartbeat","client_ts":1,"key_epoch":1,"payload":{},"prev_hash":"","mac":""}`,
		`{"session_id":"` + v.SessionID + `","seq":1,"type":"rm_rf","client_ts":1,"key_epoch":1,"payload":{},"prev_hash":"","mac":""}`,
		`{"session_id":"` + v.SessionID + `","seq":1,"type":"heartbeat","client_ts":-1,"key_epoch":1,"payload":{},"prev_hash":"","mac":""}`,
		`{"session_id":"` + v.SessionID + `","seq":1,"type":"heartbeat","client_ts":1,"key_epoch":0,"payload":{},"prev_hash":"","mac":""}`,
		`{"session_id":"` + v.SessionID + `","seq":1,"type":"heartbeat","client_ts":1,"key_epoch":1,"payload":[],"prev_hash":"","mac":""}`,
		`{"session_id":"` + v.SessionID + `","seq":1,"type":"heartbeat","client_ts":1,"key_epoch":1,"payload":{},"mac":""}`,
		`{"session_id":"` + v.SessionID + `","seq":1,"type":"heartbeat","client_ts":1,"key_epoch":1,"payload":{},"prev_hash":""}`,
	}
	for i, b := range bad {
		if _, err := ParseEnvelope(json.RawMessage(b), v.SessionID, keyFor); !errors.Is(err, ErrMalformed) {
			t.Errorf("bad %d: %v", i, err)
		}
	}
	if _, err := Canonical(map[string]any{"x": 1.5}); err == nil {
		t.Fatal("float64 must be rejected (decode with UseNumber)")
	}
	var buf bytes.Buffer
	writeString(&buf, "\x01\x1f\b\f\r")
	if buf.String() != `"\u0001\u001f\b\f\r"` {
		t.Fatalf("escapes %s", buf.String())
	}
}

func TestTrustScoreIsThePRDFormula(t *testing.T) {
	score, breakdown := TrustScore(map[Signal]int{
		SigTabHidden:      2, // 8
		SigFullscreenExit: 9, // 27 → cap 15
		SigFaceMismatch:   1, // 20
		SigTamper:         0,
	})
	if score != 100-8-15-20 || breakdown["fullscreen_exit"] != 15 || breakdown["tab_hidden"] != 8 || len(breakdown) != 3 {
		t.Fatalf("score %d %v", score, breakdown)
	}
	all := map[Signal]int{}
	for _, s := range Signals() {
		all[s] = 100
	}
	if s, _ := TrustScore(all); s != 0 {
		t.Fatalf("floor at 0: %d", s)
	}
	caps := map[Signal]int{SigTabHidden: 30, SigFullscreenExit: 15, SigPaste: 20, SigNoFace: 30, SigMultipleFaces: 40,
		SigFaceMismatch: 60, SigPhoneOrPerson: 40, SigMultipleSpeakers: 24, SigTamper: 50}
	alphas := map[Signal]int{SigTabHidden: 4, SigFullscreenExit: 3, SigPaste: 5, SigNoFace: 6, SigMultipleFaces: 12,
		SigFaceMismatch: 20, SigPhoneOrPerson: 10, SigMultipleSpeakers: 8, SigTamper: 25}
	for s, c := range caps {
		if _, b := TrustScore(map[Signal]int{s: 1}); b[string(s)] != alphas[s] {
			t.Errorf("%s alpha %d", s, b[string(s)])
		}
		if _, b := TrustScore(map[Signal]int{s: 1000}); b[string(s)] != c {
			t.Errorf("%s cap %d", s, b[string(s)])
		}
	}
	for score, band := range map[int]Band{100: Green, 80: Green, 79: Yellow, 50: Yellow, 49: Red, 0: Red} {
		if BandOf(score) != band {
			t.Errorf("band of %d", score)
		}
	}
	if !NeedsReview(Red) || NeedsReview(Yellow) {
		t.Fatal("review")
	}
}

func ev(typ string, payload map[string]any) ClientEvent {
	p := map[string]any{}
	for k, v := range payload {
		if n, ok := v.(int); ok {
			p[k] = json.Number(strings.TrimSpace(strings.Repeat(" ", 0) + itoa(n)))
		} else {
			p[k] = v
		}
	}
	return ClientEvent{Type: typ, Payload: p}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestWindowRules(t *testing.T) {
	r := DefaultRules()
	r.WindowViolation.TerminateAfterCount = 3
	var s State
	if f := s.OnClientEvent(r, nil, ev("tab_hidden", map[string]any{"duration_ms": 9000})); f != nil {
		t.Fatal("green absence is not a violation")
	}
	f := s.OnClientEvent(r, nil, ev("tab_hidden", map[string]any{"duration_ms": 30000}))
	if len(f) != 1 || f[0].Severity != 2 || f[0].Signal != SigTabHidden || s.Counts[SigTabHidden] != 1 {
		t.Fatalf("yellow absence %+v", f)
	}
	f = s.OnClientEvent(r, nil, ev("tab_hidden", map[string]any{"duration_ms": 61000}))
	if f[0].Severity != 3 || f[0].Action != ActionFlag {
		t.Fatalf("red absence %+v", f)
	}
	f = s.OnClientEvent(r, nil, ev("fullscreen_exit", nil))
	if f[0].Action != ActionTerminate || !s.Terminated || s.WindowViolations != 3 {
		t.Fatalf("third window violation terminates %+v", f)
	}
	f = s.OnClientEvent(r, nil, ev("fullscreen_exit", nil))
	if f[0].Action != ActionFlag {
		t.Fatal("termination is announced once")
	}
	// Short absences between green and the 10 s Trust threshold.
	r2 := DefaultRules()
	r2.WindowViolation.Bands.GreenMaxMs = 5000
	var s2 State
	f = s2.OnClientEvent(r2, nil, ev("tab_hidden", map[string]any{"duration_ms": 8000}))
	if len(f) != 1 || f[0].Signal != "" || s2.Counts[SigTabHidden] != 0 {
		t.Fatalf("absence ≤ 10 s is a window violation but not a Trust input: %+v", f)
	}
	// Accommodations and disabled rules.
	var s3 State
	off := NewDisabled([]string{"window_violation", "paste"})
	if s3.OnClientEvent(r, off, ev("tab_hidden", map[string]any{"duration_ms": 99000})) != nil ||
		s3.OnClientEvent(r, off, ev("fullscreen_exit", nil)) != nil ||
		s3.OnClientEvent(r, off, ev("paste", map[string]any{"chars": 900})) != nil {
		t.Fatal("accommodated rules fired")
	}
	if s3.OnClientEvent(r, NewDisabled([]string{"fullscreen"}), ev("fullscreen_exit", nil)) != nil {
		t.Fatal("fullscreen accommodation")
	}
	r.WindowViolation.Enabled = false
	if s3.OnClientEvent(r, nil, ev("fullscreen_exit", nil)) != nil {
		t.Fatal("disabled window rules")
	}
}

func TestOtherClientSignals(t *testing.T) {
	r := DefaultRules()
	var s State
	if s.OnClientEvent(r, nil, ev("paste", map[string]any{"chars": 200})) != nil {
		t.Fatal("200 chars is allowed")
	}
	if f := s.OnClientEvent(r, nil, ev("paste", map[string]any{"chars": 201})); f[0].Signal != SigPaste {
		t.Fatal("paste")
	}
	if f := s.OnClientEvent(r, nil, ev("multi_monitor", nil)); f[0].Rule != "multi_monitor" || f[0].Signal != "" {
		t.Fatal("multi monitor")
	}
	if s.OnClientEvent(r, NewDisabled([]string{"multi_monitor"}), ev("multi_monitor", nil)) != nil {
		t.Fatal("multi monitor accommodation")
	}
	if f := s.OnClientEvent(r, nil, ev("automation_suspected", nil)); f[0].Severity != 1 {
		t.Fatal("automation is low weight")
	}
	if s.OnClientEvent(r, nil, ev("device_lost", map[string]any{"duration_ms": 60000})) != nil {
		t.Fatal("within the 60 s grace")
	}
	if f := s.OnClientEvent(r, nil, ev("device_lost", map[string]any{"duration_ms": 60001})); f[0].Rule != "device_lost" {
		t.Fatal("device lost")
	}
	if s.OnClientEvent(r, nil, ev("heartbeat", nil)) != nil {
		t.Fatal("heartbeat")
	}
}

func cos(v float64) *float64 { return &v }

func good(faces int) FrameResult {
	return FrameResult{Luminance: 120, BlurVariance: 300, Faces: faces, Cosine: cos(0.8)}
}

func TestImageRulesNeedConsecutiveFrames(t *testing.T) {
	r := DefaultRules()
	var s State
	two := good(2)
	for i := 0; i < 2; i++ { // the first and second frame of a streak
		if s.OnFrame(r, nil, two, false) != nil {
			t.Fatal("one or two frames never count")
		}
	}
	// A low-quality frame in between neither counts nor breaks the streak.
	dark := two
	dark.Luminance = 20
	if s.OnFrame(r, nil, dark, false) != nil || s.Streaks[FlagMultipleFaces] != 2 {
		t.Fatal("low-quality frames are excluded")
	}
	f := s.OnFrame(r, nil, two, false)
	if len(f) != 1 || f[0].Rule != FlagMultipleFaces || s.Counts[SigMultipleFaces] != 1 || s.Streaks[FlagMultipleFaces] != 0 {
		t.Fatalf("third consecutive frame: %+v", f)
	}
	// A clean frame resets the streak.
	s.OnFrame(r, nil, two, false)
	s.OnFrame(r, nil, good(1), false)
	if s.Streaks[FlagMultipleFaces] != 0 {
		t.Fatal("streak not reset")
	}
	// Blurry frames are excluded too; mismatch, phone and second person map to their signals.
	blurry := FrameResult{Luminance: 120, BlurVariance: 10}
	if !blurry.LowQuality() || good(1).LowQuality() {
		t.Fatal("quality gate")
	}
	mismatch := FrameResult{Luminance: 120, BlurVariance: 300, Faces: 1, Cosine: cos(0.2), Objects: []string{"phone", "book"}}
	var s2 State
	var got []Finding
	for i := 0; i < 3; i++ {
		got = s2.OnFrame(r, nil, mismatch, false)
	}
	rules := map[string]Finding{}
	for _, g := range got {
		rules[g.Rule] = g
	}
	if rules[FlagFaceMismatch].Action != ActionReview || rules[FlagFaceMismatch].Severity != 3 || rules[FlagPhone].Signal != SigPhoneOrPerson {
		t.Fatalf("mismatch/phone %+v", got)
	}
	if p := (FrameResult{Faces: 1}).Present(); len(p) != 0 {
		t.Fatal("no reference: no mismatch")
	}
	if p := (FrameResult{Faces: 0, Objects: []string{"second_person"}}).Present(); !p[FlagNoFace] || !p[FlagSecondPerson] {
		t.Fatal("present")
	}
	// Disabled flags and flags not configured never fire.
	var s3 State
	r3 := DefaultRules()
	r3.Image.Flags = []string{FlagMultipleFaces}
	for i := 0; i < 3; i++ {
		got = s3.OnFrame(r3, NewDisabled([]string{FlagMultipleFaces}), FrameResult{Luminance: 99, BlurVariance: 99, Faces: 0}, false)
	}
	if got != nil {
		t.Fatalf("unconfigured/disabled flags fired %+v", got)
	}
}

func TestImageTerminationAndLateInference(t *testing.T) {
	r := DefaultRules()
	r.Image.TerminateAfterWarnings = 2
	r.Image.ConsecutiveFramesPerViolation = 1
	none := FrameResult{Luminance: 99, BlurVariance: 99, Faces: 0}
	var s State
	if f := s.OnFrame(r, nil, none, false); f[0].Action != ActionFlag {
		t.Fatal("first violation")
	}
	f := s.OnFrame(r, nil, none, true)
	if f[0].Action != ActionFlag || f[0].Detail["termination_suspended"] != "late_inference" || s.Terminated {
		t.Fatalf("late inference must never terminate: %+v", f)
	}
	if f := s.OnFrame(r, nil, none, false); f[0].Action != ActionTerminate {
		t.Fatalf("on time: %+v", f)
	}
	// TerminateAfterWarnings 0 = never.
	r.Image.TerminateAfterWarnings = 0
	var s2 State
	for i := 0; i < 20; i++ {
		for _, g := range s2.OnFrame(r, nil, none, false) {
			if g.Action == ActionTerminate {
				t.Fatal("0 must never terminate")
			}
		}
	}
}

func TestFrozenVideoAndAudioAndTamper(t *testing.T) {
	r := DefaultRules()
	var s State
	frame := good(1)
	frame.PHash = "abc"
	var got []Finding
	for i := 0; i < FrozenFrameRun; i++ {
		got = s.OnFrame(r, nil, frame, false)
	}
	if len(got) != 1 || got[0].Rule != "tamper_suspected" || got[0].Detail["reason"] != "frozen_video" {
		t.Fatalf("frozen video %+v", got)
	}
	if f := s.OnFrame(r, nil, frame, false); len(f) != 0 {
		t.Fatal("reported once per run")
	}
	frame.PHash = "def"
	s.OnFrame(r, nil, frame, false)
	if s.FrozenRun != 1 {
		t.Fatal("run reset")
	}
	var a State
	if a.OnAudio(r, nil, 2, 5) != nil {
		t.Fatal("5 s of two speakers is below 8 s")
	}
	if f := a.OnAudio(r, nil, 3, 5); f[0].Signal != SigMultipleSpeakers {
		t.Fatal("10 s of several speakers")
	}
	a.OnAudio(r, nil, 2, 5)
	a.OnAudio(r, nil, 1, 5)
	if a.SpeakerSeconds != 0 || a.OnAudio(r, NewDisabled([]string{"audio"}), 2, 50) != nil {
		t.Fatal("reset / accommodation")
	}
	tf := a.Tamper("chain_broken", map[string]any{"seq": 4})
	if tf.Severity != 3 || tf.Detail["seq"] != 4 || a.Counts[SigTamper] != 1 {
		t.Fatal("tamper")
	}
	a.Dismiss(SigTamper)
	a.Dismiss(SigTamper)
	a.Dismiss("")
	if a.Counts[SigTamper] != 0 {
		t.Fatal("dismiss")
	}
}

func TestRulesValidation(t *testing.T) {
	if err := DefaultRules().Validate(); err != nil {
		t.Fatal(err)
	}
	if !DefaultRules().UsesCamera() {
		t.Fatal("camera")
	}
	mutate := []func(*Rules){
		func(r *Rules) { r.WindowViolation.Bands.YellowMaxMs = 1 },
		func(r *Rules) { r.WindowViolation.TerminateAfterCount = -1 },
		func(r *Rules) { r.Image.ConsecutiveFramesPerViolation = 0 },
		func(r *Rules) { r.Image.TerminateAfterWarnings = 101 },
		func(r *Rules) { r.Audio.MultipleSpeakersMinS = 0 },
		func(r *Rules) { r.Image.Flags = []string{"aliens"} },
	}
	for i, m := range mutate {
		r := DefaultRules()
		m(&r)
		if err := r.Validate(); err == nil {
			t.Errorf("mutation %d accepted", i)
		}
	}
	if !ValidAccommodation([]string{"fullscreen", "no_face"}) || ValidAccommodation(nil) || ValidAccommodation([]string{"all"}) {
		t.Fatal("accommodations")
	}
	e := Fail("conflict", "X", "y")
	if e.Error() != "X: y" {
		t.Fatal("error")
	}
}

func TestClockCorrection(t *testing.T) {
	var c ClockState
	now := time.UnixMilli(1_000_000_000).UTC()
	// The client clock runs 2 s behind.
	for i := 0; i < 5; i++ {
		if jump, _ := c.Observe(now, float64(now.UnixMilli()-2000)); jump {
			t.Fatal("steady offset is not a jump")
		}
	}
	if c.OffsetMs != 2000 {
		t.Fatalf("offset %d", c.OffsetMs)
	}
	if got := c.OccurredAt(float64(now.UnixMilli()-2000-500), now); !got.Equal(now.Add(-500 * time.Millisecond)) {
		t.Fatalf("corrected %v", got)
	}
	jump, delta := c.Observe(now, float64(now.UnixMilli()+8000))
	if !jump || delta != -10000 {
		t.Fatalf("jump %v %d", jump, delta)
	}
	// Corrected times far in the future are clamped; events older than 24 h are too late.
	if got := c.OccurredAt(float64(now.Add(time.Hour).UnixMilli()), now); !got.Equal(now.Add(time.Minute)) {
		t.Fatalf("clamp %v", got)
	}
	if !TooLate(now.Add(-25*time.Hour), now) || TooLate(now.Add(-23*time.Hour), now) {
		t.Fatal("late window")
	}
	for i := 0; i < 20; i++ {
		c.Observe(now, float64(now.UnixMilli()))
	}
	if len(c.Samples) != ClockSamples || median([]int64{}) != 0 || median([]int64{1, 3}) != 2 {
		t.Fatal("bounded samples / median")
	}
}
