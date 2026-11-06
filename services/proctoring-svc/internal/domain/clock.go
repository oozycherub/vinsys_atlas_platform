package domain

import (
	"math"
	"sort"
	"time"
)

// Clock correction (PRD §2.3d): each batch carries the client's send time; the server records
// offset = server_now − client_sent_at, keeps the last samples and corrects every event with the
// median. A jump of more than 5 s against the median is a clock_tamper signal.
const (
	ClockSamples   = 15
	ClockJumpMs    = 5000
	MaxEventAgeMs  = 24 * 3600 * 1000 // late (offline) events are accepted up to 24 h
	MaxFutureSkew  = 60 * 1000        // corrected times more than 1 min in the future are clamped
	minJumpSamples = 3
)

// ClockState is the per-session offset history.
type ClockState struct {
	Samples  []int64 `json:"samples"`
	OffsetMs int64   `json:"offset_ms"`
}

// Observe adds a sample and reports whether it jumped away from the median.
func (c *ClockState) Observe(serverNow time.Time, clientSentMs float64) (jump bool, deltaMs int64) {
	sample := serverNow.UnixMilli() - int64(math.Round(clientSentMs))
	if len(c.Samples) >= minJumpSamples {
		deltaMs = sample - c.OffsetMs
		jump = deltaMs > ClockJumpMs || deltaMs < -ClockJumpMs
	}
	c.Samples = append(c.Samples, sample)
	if len(c.Samples) > ClockSamples {
		c.Samples = c.Samples[len(c.Samples)-ClockSamples:]
	}
	c.OffsetMs = median(c.Samples)
	return jump, deltaMs
}

func median(xs []int64) int64 {
	s := append([]int64(nil), xs...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	n := len(s)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// OccurredAt corrects a client timestamp. It never returns a time after serverNow + 1 min.
func (c *ClockState) OccurredAt(clientTsMs float64, serverNow time.Time) time.Time {
	t := time.UnixMilli(int64(math.Round(clientTsMs)) + c.OffsetMs).UTC()
	if limit := serverNow.Add(MaxFutureSkew * time.Millisecond); t.After(limit) {
		return limit
	}
	return t
}

// TooLate reports events older than the 24 h acceptance window.
func TooLate(occurred, serverNow time.Time) bool {
	return serverNow.Sub(occurred) > MaxEventAgeMs*time.Millisecond
}
