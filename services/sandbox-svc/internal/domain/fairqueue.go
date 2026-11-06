package domain

import "sort"

// Lane is a priority lane (PRD §2.2b "Priority lanes").
type Lane string

const (
	LaneInteractive Lane = "interactive" // runs: p95 3 s
	LaneSubmit      Lane = "submit"      // submissions and reference verification: p95 10 s
	LaneBulk        Lane = "bulk"        // re-judging: best effort
)

// LaneWeights share worker time between lanes that have work. Bulk still progresses under
// load (weights, not strict priority), so nothing starves.
var LaneWeights = map[string]int{string(LaneInteractive): 6, string(LaneSubmit): 3, string(LaneBulk): 1}

// FairScheduler is a smooth weighted round robin (as in nginx). Each Pick considers only the
// keys that currently have work, so a key that was idle does not bank credit, and a key with
// one job is served within one round however long another key's backlog is.
// It is not safe for concurrent use; each worker owns its schedulers.
type FairScheduler struct {
	weight  func(key string) int
	current map[string]int
}

// NewFairScheduler uses weight(key) (minimum 1) for each key.
func NewFairScheduler(weight func(key string) int) *FairScheduler {
	return &FairScheduler{weight: weight, current: map[string]int{}}
}

// Pick chooses the next key among those with work. It returns "" for an empty list.
func (s *FairScheduler) Pick(ready []string) string {
	if len(ready) == 0 {
		return ""
	}
	keys := append([]string(nil), ready...)
	sort.Strings(keys) // deterministic tie-breaks
	active := make(map[string]bool, len(keys))
	total, best := 0, ""
	for _, k := range keys {
		active[k] = true
		w := max(1, s.weight(k))
		total += w
		s.current[k] += w
		if best == "" || s.current[k] > s.current[best] {
			best = k
		}
	}
	for k := range s.current {
		if !active[k] {
			delete(s.current, k)
		}
	}
	s.current[best] -= total
	return best
}
