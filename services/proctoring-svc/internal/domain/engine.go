package domain

import (
	"slices"
	"sort"
)

// Thresholds fixed by the PRD.
const (
	TrustTabHiddenMinMs = 10000 // tab_hidden counts for the Trust Score above 10 s
	PasteMinChars       = 200   // paste counts above 200 characters
	DeviceLostGraceMs   = 60000 // a lost camera/mic is a violation after 60 s
	LateInferenceMs     = 5 * 60 * 1000
	FrozenFrameRun      = 5 // identical frame hashes in a row: looped video / virtual camera
	LowLuminance        = 40.0
	LowBlurVariance     = 60.0
	FaceMatchMinCosine  = 0.45 // ArcFace verification threshold (PRD §2.3b)
)

// Actions on a finding.
const (
	ActionFlag      = "flag"
	ActionReview    = "review"
	ActionTerminate = "terminate"
)

// State is the rules engine's per-session state (stored with the session, updated under lock).
type State struct {
	Counts           map[Signal]int `json:"counts"`
	Streaks          map[string]int `json:"streaks"`
	WindowViolations int            `json:"window_violations"`
	ImageViolations  int            `json:"image_violations"`
	SpeakerSeconds   float64        `json:"speaker_seconds"`
	LastFrameHash    string         `json:"last_frame_hash,omitempty"`
	FrozenRun        int            `json:"frozen_run"`
	Terminated       bool           `json:"terminated"`
}

// Finding is a rule outcome: logged with severity ≥ 2 and announced as a violation.
type Finding struct {
	Rule     string
	Signal   Signal // empty when the finding is not a Trust Score input
	Severity int
	Action   string
	Detail   map[string]any
}

// Disabled is the set of rules turned off by accommodations.
type Disabled map[string]bool

// NewDisabled builds the set.
func NewDisabled(rules []string) Disabled {
	d := Disabled{}
	for _, r := range rules {
		d[r] = true
	}
	return d
}

func (s *State) init() {
	if s.Counts == nil {
		s.Counts = map[Signal]int{}
	}
	if s.Streaks == nil {
		s.Streaks = map[string]int{}
	}
}

// terminate marks the session terminated once; later terminations are plain flags.
func (s *State) terminate(f Finding) Finding {
	if s.Terminated {
		f.Action = ActionFlag
		return f
	}
	s.Terminated = true
	f.Action = ActionTerminate
	return f
}

// OnClientEvent applies a browser signal.
func (s *State) OnClientEvent(r Rules, off Disabled, e ClientEvent) []Finding {
	s.init()
	window := r.WindowViolation.Enabled && !off["window_violation"]
	switch e.Type {
	case "tab_hidden":
		ms := int(Number(e.Payload, "duration_ms"))
		if !window || ms <= r.WindowViolation.Bands.GreenMaxMs {
			return nil
		}
		sev := 2
		if ms > r.WindowViolation.Bands.YellowMaxMs {
			sev = 3
		}
		f := Finding{Rule: "window_violation", Severity: sev, Action: ActionFlag, Detail: map[string]any{"event": "tab_hidden", "duration_ms": ms}}
		if ms > TrustTabHiddenMinMs {
			f.Signal = SigTabHidden
			s.Counts[SigTabHidden]++
		}
		return []Finding{s.window(r, f)}
	case "fullscreen_exit":
		if !window || off["fullscreen"] {
			return nil
		}
		s.Counts[SigFullscreenExit]++
		return []Finding{s.window(r, Finding{Rule: "window_violation", Signal: SigFullscreenExit, Severity: 2, Action: ActionFlag, Detail: map[string]any{"event": "fullscreen_exit"}})}
	case "paste":
		chars := int(Number(e.Payload, "chars"))
		if off["paste"] || chars <= PasteMinChars {
			return nil
		}
		s.Counts[SigPaste]++
		return []Finding{{Rule: "paste", Signal: SigPaste, Severity: 2, Action: ActionFlag, Detail: map[string]any{"chars": chars}}}
	case "multi_monitor":
		if off["multi_monitor"] {
			return nil
		}
		return []Finding{{Rule: "multi_monitor", Severity: 2, Action: ActionFlag, Detail: map[string]any{}}}
	case "automation_suspected":
		// Low weight and spoofable: recorded for reviewers, never scored.
		return []Finding{{Rule: "automation_suspected", Severity: 1, Action: ActionFlag, Detail: map[string]any{}}}
	case "device_lost":
		ms := int(Number(e.Payload, "duration_ms"))
		if ms <= DeviceLostGraceMs {
			return nil
		}
		return []Finding{{Rule: "device_lost", Severity: 2, Action: ActionFlag, Detail: map[string]any{"duration_ms": ms}}}
	}
	return nil
}

func (s *State) window(r Rules, f Finding) Finding {
	s.WindowViolations++
	f.Detail["count"] = s.WindowViolations
	if n := r.WindowViolation.TerminateAfterCount; n > 0 && s.WindowViolations >= n {
		return s.terminate(f)
	}
	return f
}

// FrameResult is the inference outcome of one webcam frame.
type FrameResult struct {
	Luminance    float64
	BlurVariance float64
	Faces        int
	// Cosine is the best similarity with a reference embedding; nil without a single face or
	// without references.
	Cosine  *float64
	Objects []string // phone, second_person, book, earbuds, laptop
	PHash   string
}

// LowQuality reports frames excluded from violation counting (PRD §2.3d).
func (f FrameResult) LowQuality() bool {
	return f.Luminance < LowLuminance || f.BlurVariance < LowBlurVariance
}

// Present returns the image flags this frame shows.
func (f FrameResult) Present() map[string]bool {
	p := map[string]bool{}
	switch {
	case f.Faces == 0:
		p[FlagNoFace] = true
	case f.Faces >= 2:
		p[FlagMultipleFaces] = true
	case f.Cosine != nil && *f.Cosine < FaceMatchMinCosine:
		p[FlagFaceMismatch] = true
	}
	for _, o := range f.Objects {
		if o == FlagPhone || o == FlagSecondPerson {
			p[o] = true
		}
	}
	return p
}

var flagSignal = map[string]Signal{
	FlagNoFace: SigNoFace, FlagMultipleFaces: SigMultipleFaces, FlagFaceMismatch: SigFaceMismatch,
	FlagPhone: SigPhoneOrPerson, FlagSecondPerson: SigPhoneOrPerson,
}

// OnFrame applies one analysed frame. late: inference lagged more than 5 minutes, so it may
// flag but never terminate.
func (s *State) OnFrame(r Rules, off Disabled, f FrameResult, late bool) []Finding {
	s.init()
	var out []Finding
	if f.PHash != "" {
		if f.PHash == s.LastFrameHash {
			s.FrozenRun++
		} else {
			s.FrozenRun = 1
		}
		s.LastFrameHash = f.PHash
		if s.FrozenRun == FrozenFrameRun {
			out = append(out, s.Tamper("frozen_video", map[string]any{"identical_frames": FrozenFrameRun}))
		}
	}
	if f.LowQuality() {
		return out // excluded: neither counts nor breaks a streak
	}
	present := f.Present()
	flags := append([]string(nil), r.Image.Flags...)
	sort.Strings(flags)
	for _, flag := range flags {
		if off[flag] || !present[flag] {
			s.Streaks[flag] = 0
			continue
		}
		s.Streaks[flag]++
		if s.Streaks[flag] < r.Image.ConsecutiveFramesPerViolation {
			continue
		}
		s.Streaks[flag] = 0
		s.ImageViolations++
		sig := flagSignal[flag]
		s.Counts[sig]++
		finding := Finding{Rule: flag, Signal: sig, Severity: 2, Action: ActionFlag,
			Detail: map[string]any{"frames": r.Image.ConsecutiveFramesPerViolation, "count": s.ImageViolations}}
		if flag == FlagFaceMismatch {
			finding.Severity, finding.Action = 3, ActionReview
		}
		if n := r.Image.TerminateAfterWarnings; n > 0 && s.ImageViolations >= n {
			if late {
				finding.Detail["termination_suspended"] = "late_inference"
			} else {
				finding = s.terminate(finding)
			}
		}
		out = append(out, finding)
	}
	return out
}

// OnAudio applies one analysed audio window.
func (s *State) OnAudio(r Rules, off Disabled, speakers int, windowS float64) []Finding {
	s.init()
	if off["audio"] || speakers < 2 {
		s.SpeakerSeconds = 0
		return nil
	}
	s.SpeakerSeconds += windowS
	if s.SpeakerSeconds < r.Audio.MultipleSpeakersMinS {
		return nil
	}
	s.SpeakerSeconds = 0
	s.Counts[SigMultipleSpeakers]++
	return []Finding{{Rule: "multiple_speakers", Signal: SigMultipleSpeakers, Severity: 2, Action: ActionFlag, Detail: map[string]any{"speakers": speakers}}}
}

// Tamper records a tamper_suspected signal (chain, MAC, clock, frozen video, ...).
func (s *State) Tamper(reason string, detail map[string]any) Finding {
	s.init()
	s.Counts[SigTamper]++
	d := map[string]any{"reason": reason}
	for k, v := range detail {
		d[k] = v
	}
	return Finding{Rule: "tamper_suspected", Signal: SigTamper, Severity: 3, Action: ActionReview, Detail: d}
}

// Dismiss removes a reviewer-dismissed flag from the Trust Score inputs.
func (s *State) Dismiss(sig Signal) {
	s.init()
	if sig != "" && s.Counts[sig] > 0 {
		s.Counts[sig]--
	}
}

// ValidAccommodation checks rule names against what can be disabled.
func ValidAccommodation(rules []string) bool {
	if len(rules) == 0 {
		return false
	}
	for _, r := range rules {
		if !slices.Contains(DisableableRules, r) {
			return false
		}
	}
	return true
}
