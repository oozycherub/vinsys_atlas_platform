package app

import (
	"context"
	"fmt"
	"strings"

	"atlas.dev/sandbox-svc/internal/domain"
)

// Byte limits for stored output (PRD §2.2b/d).
const (
	CompileOutputBytes = 16 << 10
	CaseExcerptBytes   = 4 << 10
	RunOutputBytes     = 64 << 10
)

// boxEnv is the whole environment of a boxed process: nothing from the worker leaks in.
var boxEnv = map[string]string{
	"HOME":        "/box",
	"PATH":        "/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin",
	"LANG":        "C.UTF-8",
	"GOCACHE":     "/box/.cache/go",
	"GOPATH":      "/box/.go",
	"GO111MODULE": "off",
	"GOTOOLCHAIN": "local",
	"TMPDIR":      "/box",
}

// CustomChecker is an author's checker program: it reads input.txt, expected.txt and
// output.txt in its own box and exits 0 for a pass, 1 for a fail.
type CustomChecker struct {
	Lang   domain.Language
	Source string
}

// JudgeInput describes one judging job.
type JudgeInput struct {
	Lang          domain.Language
	Overrides     domain.LimitOverrides
	Source        string
	Cases         []domain.TestCase
	Compare       bool // false for custom-stdin runs: report output, check nothing
	Checker       domain.CheckerSpec
	CustomChecker *CustomChecker
	// KeepOutput keeps up to RunOutputBytes of stdout and stderr of the first case (runs).
	KeepOutput bool
}

// JudgeOutput is the result. A sandbox fault is returned as an error instead, so the job is
// retried rather than charged to the candidate.
type JudgeOutput struct {
	Summary       domain.Summary
	Cases         []domain.CaseResult
	CompileOutput *string
	Stdout        *string
	Stderr        *string
}

// Judge compiles once and runs each case in a fresh box state.
type Judge struct{ Pool BoxPool }

// ErrSandbox marks infrastructure failures (box errors, sandbox status XX).
type ErrSandbox struct{ Cause error }

func (e *ErrSandbox) Error() string { return "sandbox fault: " + e.Cause.Error() }
func (e *ErrSandbox) Unwrap() error { return e.Cause }

func fault(format string, args ...any) error { return &ErrSandbox{Cause: fmt.Errorf(format, args...)} }

// Run judges in. Expected outputs never enter the program's box.
func (j *Judge) Run(ctx context.Context, in JudgeInput) (JudgeOutput, error) {
	limits, heap := domain.Resolve(in.Overrides, in.Lang)
	box, err := j.Pool.Acquire(ctx)
	if err != nil {
		return JudgeOutput{}, &ErrSandbox{Cause: err}
	}
	defer j.Pool.Release(box) // the pool hands out fresh boxes and resets them on release
	if err := box.WriteFile(in.Lang.SourceFile, []byte(in.Source)); err != nil {
		return JudgeOutput{}, &ErrSandbox{Cause: err}
	}
	var out JudgeOutput
	if in.Lang.CompileCmd != "" {
		compiled, text, err := compile(ctx, box, in.Lang, heap)
		if err != nil {
			return JudgeOutput{}, err
		}
		out.CompileOutput = &text
		if !compiled {
			out.Summary = domain.Summary{Verdict: domain.CompilationError, TestsTotal: len(in.Cases)}
			return out, nil
		}
	}
	snap, err := box.Snapshot()
	if err != nil {
		return JudgeOutput{}, &ErrSandbox{Cause: err}
	}
	defer snap.Discard()

	var checker *checkerBox
	if in.Compare && in.Checker.Kind == domain.CheckCustom {
		if in.CustomChecker == nil {
			return JudgeOutput{}, fault("custom checker missing")
		}
		checker, err = newCheckerBox(ctx, j.Pool, *in.CustomChecker)
		if err != nil {
			return JudgeOutput{}, err
		}
		defer checker.close()
	}

	argv := in.Lang.Argv(in.Lang.RunCmd, heap)
	for i, tc := range in.Cases {
		if i > 0 || in.Lang.CompileCmd != "" {
			if err := box.Reset(ctx); err != nil {
				return JudgeOutput{}, &ErrSandbox{Cause: err}
			}
			if err := box.Restore(snap); err != nil {
				return JudgeOutput{}, &ErrSandbox{Cause: err}
			}
		}
		res, stdout, stderr, err := runCase(ctx, box, argv, limits, tc)
		if err != nil {
			return JudgeOutput{}, err
		}
		if res.Verdict == domain.Accepted && in.Compare {
			if checker != nil {
				pass, err := checker.check(ctx, tc, stdout)
				if err != nil {
					return JudgeOutput{}, err
				}
				if !pass {
					res.Verdict = domain.WrongAnswer
				}
			} else if !domain.Compare(in.Checker, tc.Expected, stdout) {
				res.Verdict = domain.WrongAnswer
			}
		}
		if in.KeepOutput && i == 0 {
			o, e := clip(stdout, RunOutputBytes), clip(stderr, RunOutputBytes)
			out.Stdout, out.Stderr = &o, &e
		}
		out.Cases = append(out.Cases, res)
	}
	out.Summary = domain.Summarize(out.Cases)
	return out, nil
}

func compile(ctx context.Context, box Box, lang domain.Language, heap int) (bool, string, error) {
	o, err := box.Run(ctx, RunSpec{
		Argv: lang.Argv(lang.CompileCmd, heap), Stdout: "compile.out", Stderr: "compile.err",
		Limits: domain.CompileLimits, Env: boxEnv,
	})
	if err != nil {
		return false, "", &ErrSandbox{Cause: err}
	}
	verdict, ok := domain.ClassifyCompile(o)
	if verdict == domain.InternalError {
		return false, "", fault("compile step: %s", o.Message)
	}
	stdout, _, _ := box.ReadFile("compile.out", CompileOutputBytes)
	stderr, _, _ := box.ReadFile("compile.err", CompileOutputBytes)
	text := clip(string(stdout)+string(stderr), CompileOutputBytes)
	if !ok && o.Status == "TO" {
		text = clip("Compilation exceeded the time limit.\n"+text, CompileOutputBytes)
	}
	if !ok && o.OOMKilled {
		text = clip("Compilation exceeded the memory limit.\n"+text, CompileOutputBytes)
	}
	return ok, text, nil
}

func runCase(ctx context.Context, box Box, argv []string, limits domain.Limits, tc domain.TestCase) (domain.CaseResult, string, string, error) {
	if err := box.WriteFile("input.txt", []byte(tc.Input)); err != nil {
		return domain.CaseResult{}, "", "", &ErrSandbox{Cause: err}
	}
	o, err := box.Run(ctx, RunSpec{Argv: argv, Stdin: "input.txt", Stdout: "output.txt", Stderr: "error.txt", Limits: limits, Env: boxEnv})
	if err != nil {
		return domain.CaseResult{}, "", "", &ErrSandbox{Cause: err}
	}
	budget := limits.OutputKB * 1024
	stdout, outCut, err := box.ReadFile("output.txt", budget)
	if err != nil {
		return domain.CaseResult{}, "", "", &ErrSandbox{Cause: err}
	}
	stderr, errCut, _ := box.ReadFile("error.txt", budget)
	if outCut || errCut || len(stdout)+len(stderr) > budget {
		o.OutputTooLong = true
	}
	verdict, detail, _ := domain.Classify(o, limits)
	if verdict == domain.InternalError {
		return domain.CaseResult{}, "", "", fault("run: %s", o.Message)
	}
	res := domain.CaseResult{
		TestCaseID: tc.ID, Hidden: tc.Hidden, Weight: tc.Weight, Verdict: verdict, Detail: detail,
		CPUms: o.CPUms, WallMs: o.WallMs, MemoryKB: o.MemoryKB,
		Stdout: clip(string(stdout), CaseExcerptBytes),
	}
	if o.Status == "SG" {
		sig := o.Signal
		res.Signal = &sig
	} else {
		code := o.ExitCode
		res.ExitCode = &code
	}
	return res, string(stdout), string(stderr), nil
}

// checkerBox runs an author's checker, compiled once, in its own box.
type checkerBox struct {
	pool BoxPool
	box  Box
	snap Snapshot
	argv []string
}

func newCheckerBox(ctx context.Context, pool BoxPool, c CustomChecker) (*checkerBox, error) {
	box, err := pool.Acquire(ctx)
	if err != nil {
		return nil, &ErrSandbox{Cause: err}
	}
	cb := &checkerBox{pool: pool, box: box}
	if err := box.WriteFile(c.Lang.SourceFile, []byte(c.Source)); err != nil {
		cb.close()
		return nil, &ErrSandbox{Cause: err}
	}
	_, heap := domain.Resolve(domain.LimitOverrides{}, c.Lang)
	if c.Lang.CompileCmd != "" {
		ok, text, err := compile(ctx, box, c.Lang, heap)
		if err != nil || !ok {
			cb.close()
			if err != nil {
				return nil, err
			}
			return nil, fault("custom checker does not compile: %s", firstLine(text))
		}
	}
	if cb.snap, err = box.Snapshot(); err != nil {
		cb.close()
		return nil, &ErrSandbox{Cause: err}
	}
	cb.argv = c.Lang.Argv(c.Lang.RunCmd, heap)
	return cb, nil
}

func (c *checkerBox) check(ctx context.Context, tc domain.TestCase, output string) (bool, error) {
	if err := c.box.Reset(ctx); err != nil {
		return false, &ErrSandbox{Cause: err}
	}
	if err := c.box.Restore(c.snap); err != nil {
		return false, &ErrSandbox{Cause: err}
	}
	for name, data := range map[string]string{"input.txt": tc.Input, "expected.txt": tc.Expected, "output.txt": output} {
		if err := c.box.WriteFile(name, []byte(data)); err != nil {
			return false, &ErrSandbox{Cause: err}
		}
	}
	o, err := c.box.Run(ctx, RunSpec{Argv: c.argv, Stdout: "checker.out", Stderr: "checker.err", Limits: domain.DefaultLimits, Env: boxEnv})
	if err != nil {
		return false, &ErrSandbox{Cause: err}
	}
	switch {
	case o.Status == "" && o.ExitCode == 0:
		return true, nil
	case o.Status == "RE" && o.ExitCode == 1:
		return false, nil
	}
	// A crashing or slow checker is the author's fault, not the candidate's: never a WA.
	return false, fault("custom checker failed: status %q exit %d", o.Status, o.ExitCode)
}

func (c *checkerBox) close() {
	if c.snap != nil {
		c.snap.Discard()
	}
	c.pool.Release(c.box)
}

// clip truncates to at most n bytes and replaces invalid UTF-8 (including a rune cut in half)
// with "?", which never makes the text longer, so binary garbage is stored as text (PRD §2.2d).
func clip(s string, n int) string {
	if len(s) > n {
		s = s[:n]
	}
	return strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "?")
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return clip(line, 200)
}
