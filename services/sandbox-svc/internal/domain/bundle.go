package domain

import (
	"crypto/sha256"
	"encoding/json"
	"strconv"
)

// TestCase is one hidden or sample case. Expected output stays in the worker.
type TestCase struct {
	ID       string  `json:"id"`
	Input    string  `json:"input"`
	Expected string  `json:"expected"`
	Hidden   bool    `json:"hidden"`
	Weight   float64 `json:"weight"`
}

// BundleContent is what is stored in object storage, keyed by its checksum.
type BundleContent struct {
	Tests []TestCase `json:"tests"`
}

// Bundle limits.
const (
	MaxTests       = 200
	MaxCaseBytes   = 1 << 20 // 1 MB per input or expected output
	MaxBundleBytes = 32 << 20
	MaxSourceBytes = 64 << 10
	MaxStdinBytes  = 64 << 10
	// VerifyRuns is how many times the reference solution runs at publish (flaky-test guard).
	VerifyRuns = 5
)

// ValidateTests checks sizes, weights and that at least one case exists.
func ValidateTests(tests []TestCase) error {
	if len(tests) == 0 || len(tests) > MaxTests {
		return &RuleError{Code: "INVALID_TESTS", Message: "A question needs 1–" + strconv.Itoa(MaxTests) + " test cases."}
	}
	total := 0
	for i, t := range tests {
		if len(t.Input) > MaxCaseBytes || len(t.Expected) > MaxCaseBytes {
			return &RuleError{Code: "INVALID_TESTS", Message: "Test " + strconv.Itoa(i+1) + " is larger than 1 MB."}
		}
		if t.Weight < 0 || t.Weight > 1000 {
			return &RuleError{Code: "INVALID_TESTS", Message: "Test " + strconv.Itoa(i+1) + " has a weight outside 0–1000."}
		}
		total += len(t.Input) + len(t.Expected)
	}
	if total > MaxBundleBytes {
		return &RuleError{Code: "INVALID_TESTS", Message: "The test cases are larger than 32 MB in total."}
	}
	return nil
}

// Encode serialises the bundle and returns its sha256 checksum.
func (b BundleContent) Encode() (data []byte, checksum [32]byte, err error) {
	data, err = json.Marshal(b)
	if err != nil {
		return nil, checksum, err
	}
	return data, sha256.Sum256(data), nil
}

// VerifyOutcome decides a reference solution's verification from its repeated runs: every run
// must accept every case, and every run must agree (otherwise the tests are flaky).
func VerifyOutcome(runs [][]Verdict) (status string, detail string) {
	if len(runs) == 0 {
		return "reference_failed", "NO_RUNS"
	}
	first := runs[0]
	for _, run := range runs[1:] {
		if len(run) != len(first) {
			return "flaky", "RESULTS_DIFFER"
		}
		for i := range run {
			if run[i] != first[i] {
				return "flaky", "RESULTS_DIFFER: test " + strconv.Itoa(i+1)
			}
		}
	}
	for i, v := range first {
		if v == InternalError {
			return "", "" // retry: the sandbox, not the question, failed
		}
		if v != Accepted {
			return "reference_failed", string(v) + ": test " + strconv.Itoa(i+1)
		}
	}
	return "verified", ""
}
