// Package domain holds the judge's rules: verdicts, limits, checkers, scheduling and
// plagiarism fingerprints. It imports only the standard library.
package domain

import "math"

// Verdict is the outcome of one test case or a whole submission (PRD §2.2b).
type Verdict string

const (
	Queued              Verdict = "queued"
	Running             Verdict = "running"
	Accepted            Verdict = "accepted"
	WrongAnswer         Verdict = "wrong_answer"
	TimeLimitExceeded   Verdict = "time_limit_exceeded"
	MemoryLimitExceeded Verdict = "memory_limit_exceeded"
	OutputLimitExceeded Verdict = "output_limit_exceeded"
	RuntimeError        Verdict = "runtime_error"
	CompilationError    Verdict = "compilation_error"
	InternalError       Verdict = "internal_error"
)

// severity orders final verdicts: CE > RE > TLE > MLE > OLE > WA > AC. An internal error
// outranks everything, because the result cannot be trusted and is never charged.
var severity = map[Verdict]int{
	Accepted:            1,
	WrongAnswer:         2,
	OutputLimitExceeded: 3,
	MemoryLimitExceeded: 4,
	TimeLimitExceeded:   5,
	RuntimeError:        6,
	CompilationError:    7,
	InternalError:       8,
}

// IsFinal reports whether v is a judged outcome (not queued or running).
func (v Verdict) IsFinal() bool { _, ok := severity[v]; return ok }

// Worst returns the most severe verdict; an empty list is accepted (nothing failed).
func Worst(verdicts []Verdict) Verdict {
	worst := Accepted
	for _, v := range verdicts {
		if severity[v] > severity[worst] {
			worst = v
		}
	}
	return worst
}

// CaseResult is one judged test case.
type CaseResult struct {
	TestCaseID string
	Hidden     bool
	Weight     float64
	Verdict    Verdict
	Detail     string // e.g. RESOURCE_PROCESSES, SIGNAL_11, EXIT_1
	CPUms      int
	WallMs     int
	MemoryKB   int
	ExitCode   *int
	Signal     *int
	Stdout     string // excerpt (≤ 4 KB); never returned for hidden tests
}

// Summary aggregates case results into the submission's verdict and score.
type Summary struct {
	Verdict     Verdict
	TestsPassed int
	TestsTotal  int
	// Ratio is Σ weight(passed) / Σ weight, in [0, 1]. Partial credit is allowed.
	Ratio       float64
	MaxCPUms    int
	MaxMemoryKB int
}

// Summarize applies the PRD rule: the status is the worst case verdict, and the score is the
// weighted share of passed cases.
func Summarize(cases []CaseResult) Summary {
	s := Summary{TestsTotal: len(cases)}
	var all, passed float64
	verdicts := make([]Verdict, 0, len(cases))
	for _, c := range cases {
		verdicts = append(verdicts, c.Verdict)
		w := c.Weight
		if w <= 0 {
			w = 1
		}
		all += w
		if c.Verdict == Accepted {
			s.TestsPassed++
			passed += w
		}
		s.MaxCPUms = max(s.MaxCPUms, c.CPUms)
		s.MaxMemoryKB = max(s.MaxMemoryKB, c.MemoryKB)
	}
	s.Verdict = Worst(verdicts)
	if all > 0 {
		s.Ratio = math.Round(passed/all*10000) / 10000
	}
	return s
}

// Points converts the ratio to points (two decimals).
func Points(ratio, questionPoints float64) float64 {
	return math.Round(ratio*questionPoints*100) / 100
}
