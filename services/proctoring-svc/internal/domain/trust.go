package domain

import "sort"

// Signal is a Trust Score input (PRD §2.3b).
type Signal string

const (
	SigTabHidden        Signal = "tab_hidden" // only absences > 10 s count
	SigFullscreenExit   Signal = "fullscreen_exit"
	SigPaste            Signal = "paste" // only pastes > 200 characters count
	SigNoFace           Signal = "no_face"
	SigMultipleFaces    Signal = "multiple_faces"
	SigFaceMismatch     Signal = "face_mismatch"
	SigPhoneOrPerson    Signal = "phone_or_second_person"
	SigMultipleSpeakers Signal = "multiple_speakers"
	SigTamper           Signal = "tamper_suspected"
)

// weight is α_k and cap_k of the Trust Score formula, exactly as in the PRD.
type weight struct{ Alpha, Cap int }

var weights = map[Signal]weight{
	SigTabHidden:        {4, 30},
	SigFullscreenExit:   {3, 15},
	SigPaste:            {5, 20},
	SigNoFace:           {6, 30},
	SigMultipleFaces:    {12, 40},
	SigFaceMismatch:     {20, 60},
	SigPhoneOrPerson:    {10, 40},
	SigMultipleSpeakers: {8, 24},
	SigTamper:           {25, 50},
}

// Signals lists every Trust Score input in a stable order.
func Signals() []Signal {
	out := make([]Signal, 0, len(weights))
	for s := range weights {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Band is the Trust Score band.
type Band string

const (
	Green  Band = "green"
	Yellow Band = "yellow"
	Red    Band = "red"
)

// TrustScore computes T = max(0, 100 − Σ_k min(cap_k, α_k · n_k)) and the deduction per signal.
func TrustScore(counts map[Signal]int) (int, map[string]int) {
	total := 0
	breakdown := map[string]int{}
	for s, w := range weights {
		n := counts[s]
		if n <= 0 {
			continue
		}
		d := min(w.Cap, w.Alpha*n)
		breakdown[string(s)] = d
		total += d
	}
	return max(0, 100-total), breakdown
}

// BandOf maps a score to its band: ≥ 80 green, 50–79 yellow, < 50 red.
func BandOf(score int) Band {
	switch {
	case score >= 80:
		return Green
	case score >= 50:
		return Yellow
	}
	return Red
}

// NeedsReview: red sessions go to the human review queue; AI never rejects on its own (§4.1).
func NeedsReview(b Band) bool { return b == Red }
