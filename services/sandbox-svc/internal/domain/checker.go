package domain

import (
	"math"
	"slices"
	"strconv"
	"strings"
)

// Checker names (PRD §2.2b). `custom` runs the author's checker program in its own box.
const (
	CheckExact          = "exact"
	CheckTrimWS         = "trim_ws"
	CheckFloatTol       = "float_tol"
	CheckUnorderedLines = "unordered_lines"
	CheckCustom         = "custom"
)

// CheckerSpec is a question's comparison rule.
type CheckerSpec struct {
	Kind      string  `json:"kind"`
	Tolerance float64 `json:"tolerance,omitempty"` // float_tol only; default 1e-6
}

// ValidateChecker rejects unknown checkers and silly tolerances.
func ValidateChecker(c CheckerSpec) error {
	switch c.Kind {
	case CheckExact, CheckTrimWS, CheckUnorderedLines, CheckCustom:
		return nil
	case CheckFloatTol:
		if c.Tolerance < 0 || c.Tolerance > 1 {
			return &RuleError{Code: "INVALID_CHECKER", Message: "tolerance must be between 0 and 1."}
		}
		return nil
	}
	return &RuleError{Code: "INVALID_CHECKER", Message: "Unknown checker " + strconv.Quote(c.Kind) + "."}
}

// Compare applies a built-in checker. The expected output is compared here, in the worker,
// after the process has exited: it never enters the box.
func Compare(c CheckerSpec, expected, actual string) bool {
	switch c.Kind {
	case CheckExact:
		return expected == actual
	case CheckFloatTol:
		tol := c.Tolerance
		if tol == 0 {
			tol = 1e-6
		}
		return floatsMatch(strings.Fields(expected), strings.Fields(actual), tol)
	case CheckUnorderedLines:
		a, b := trimmedLines(expected), trimmedLines(actual)
		slices.Sort(a)
		slices.Sort(b)
		return slices.Equal(a, b)
	default: // trim_ws, the default
		return slices.Equal(trimmedLines(expected), trimmedLines(actual))
	}
}

// trimmedLines drops trailing whitespace on each line and trailing blank lines.
func trimmedLines(s string) []string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t\r")
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func floatsMatch(expected, actual []string, tol float64) bool {
	if len(expected) != len(actual) {
		return false
	}
	for i := range expected {
		e, errE := strconv.ParseFloat(expected[i], 64)
		a, errA := strconv.ParseFloat(actual[i], 64)
		if errE != nil || errA != nil {
			if expected[i] != actual[i] {
				return false
			}
			continue
		}
		if math.IsNaN(a) || math.IsInf(a, 0) || math.Abs(e-a) > tol*math.Max(1, math.Abs(e)) {
			return false
		}
	}
	return true
}
