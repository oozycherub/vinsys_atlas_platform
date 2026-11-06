package domain

import (
	"fmt"
	"slices"
)

// Rules is an assessment's proctoring configuration (PRD §2.3b `proctoring_rules`).
type Rules struct {
	WindowViolation WindowRules `json:"window_violation"`
	Image           ImageRules  `json:"image"`
	Audio           AudioRules  `json:"audio"`
	SafeBrowser     bool        `json:"safe_browser"`
}

// WindowRules cover leaving the test (tab hidden, fullscreen exit).
type WindowRules struct {
	Enabled bool `json:"enabled"`
	Bands   struct {
		GreenMaxMs  int `json:"green_max_ms"`
		YellowMaxMs int `json:"yellow_max_ms"`
	} `json:"bands"`
	TerminateAfterCount int `json:"terminate_after_count"` // 0 = never
}

// ImageRules cover webcam frames.
type ImageRules struct {
	ConsecutiveFramesPerViolation int      `json:"consecutive_frames_per_violation"`
	Flags                         []string `json:"flags"`
	Bands                         struct {
		Green  [2]int `json:"green"`
		Yellow [2]int `json:"yellow"`
		RedMin int    `json:"red_min"`
	} `json:"bands"`
	TerminateAfterWarnings int `json:"terminate_after_warnings"` // 0 = never
}

// AudioRules cover the microphone.
type AudioRules struct {
	MultipleSpeakersMinS float64 `json:"multiple_speakers_min_s"`
}

// Image flags.
const (
	FlagNoFace        = "no_face"
	FlagMultipleFaces = "multiple_faces"
	FlagFaceMismatch  = "face_mismatch"
	FlagPhone         = "phone"
	FlagSecondPerson  = "second_person"
)

var imageFlags = []string{FlagNoFace, FlagMultipleFaces, FlagFaceMismatch, FlagPhone, FlagSecondPerson}

// DefaultRules are the PRD defaults.
func DefaultRules() Rules {
	var r Rules
	r.WindowViolation.Enabled = true
	r.WindowViolation.Bands.GreenMaxMs = 10000
	r.WindowViolation.Bands.YellowMaxMs = 60000
	r.WindowViolation.TerminateAfterCount = 5
	r.Image.ConsecutiveFramesPerViolation = 3
	r.Image.Flags = append([]string(nil), imageFlags...)
	r.Image.Bands.Green = [2]int{0, 2}
	r.Image.Bands.Yellow = [2]int{3, 5}
	r.Image.Bands.RedMin = 6
	r.Image.TerminateAfterWarnings = 0
	r.Audio.MultipleSpeakersMinS = 8
	return r
}

// Validate rejects configurations that cannot be applied.
func (r Rules) Validate() error {
	w := r.WindowViolation
	switch {
	case w.Bands.GreenMaxMs < 0 || w.Bands.YellowMaxMs < w.Bands.GreenMaxMs:
		return ruleErr("window_violation.bands must satisfy 0 ≤ green_max_ms ≤ yellow_max_ms")
	case w.TerminateAfterCount < 0 || w.TerminateAfterCount > 100:
		return ruleErr("window_violation.terminate_after_count must be 0–100")
	case r.Image.ConsecutiveFramesPerViolation < 1 || r.Image.ConsecutiveFramesPerViolation > 20:
		return ruleErr("image.consecutive_frames_per_violation must be 1–20")
	case r.Image.TerminateAfterWarnings < 0 || r.Image.TerminateAfterWarnings > 100:
		return ruleErr("image.terminate_after_warnings must be 0–100")
	case r.Audio.MultipleSpeakersMinS < 1 || r.Audio.MultipleSpeakersMinS > 600:
		return ruleErr("audio.multiple_speakers_min_s must be 1–600")
	}
	for _, f := range r.Image.Flags {
		if !slices.Contains(imageFlags, f) {
			return ruleErr(fmt.Sprintf("unknown image flag %q", f))
		}
	}
	return nil
}

// UsesCamera reports whether frames are analysed (biometric consent required).
func (r Rules) UsesCamera() bool { return len(r.Image.Flags) > 0 }

// Rule names that accessibility accommodations can disable (PRD §2.3d).
var DisableableRules = []string{
	"window_violation", "fullscreen", "paste", "multi_monitor", "audio",
	FlagNoFace, FlagMultipleFaces, FlagFaceMismatch, FlagPhone, FlagSecondPerson,
}

// RuleError is a domain error with a stable code.
type RuleError struct {
	Code, Message, Kind string
}

func (e *RuleError) Error() string { return e.Code + ": " + e.Message }

func ruleErr(msg string) error { return &RuleError{Code: "INVALID_RULES", Message: msg} }

// Fail builds a RuleError of a kind (rule, conflict, not_found, forbidden, unauthenticated).
func Fail(kind, code, msg string) error { return &RuleError{Code: code, Message: msg, Kind: kind} }
