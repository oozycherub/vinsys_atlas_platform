package testkit

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

// FakeBox interprets a tiny script instead of running real code, so the judge pipeline can be
// tested anywhere. The program is the first box file named in argv (or a.out). Scripts:
//
//	SUM            print the sum of the input's integers
//	ECHO           print the input
//	PRINT <text>   print text (\n escapes allowed)
//	TLE | WALL     time limit (CPU | wall clock)
//	MLE            killed by the cgroup OOM killer
//	CRASH          SIGSEGV
//	FORK           fork bomb: exit 1 with the pids limit hit
//	HUGE           output past the limit
//	FAULT          the sandbox itself fails
//	FLAKY          alternates between SUM and a wrong answer
//	SLEEPMS <n>    sleep n ms, then behave like SUM
//	CE             fails to compile (compiled languages)
//	CHECK          checker: pass iff output.txt == expected.txt (trimmed)
//	CHECKBROKEN    checker crashes
type FakeBox struct {
	mu    sync.Mutex
	files map[string][]byte
	pool  *FakePool
}

// FakePool hands out fake boxes and counts runs.
type FakePool struct {
	Runs    atomic.Int64
	flaky   atomic.Int64
	Resets  atomic.Int64
	FailAll atomic.Bool // every run is a sandbox fault
}

// Acquire returns a fresh box.
func (p *FakePool) Acquire(context.Context) (app.Box, error) {
	return &FakeBox{files: map[string][]byte{}, pool: p}, nil
}

// Release drops the box.
func (p *FakePool) Release(app.Box) {}

func (b *FakeBox) WriteFile(name string, data []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.files[name] = append([]byte(nil), data...)
	return nil
}

func (b *FakeBox) ReadFile(name string, limit int) ([]byte, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	d := b.files[name]
	if len(d) > limit {
		return d[:limit], true, nil
	}
	return d, false, nil
}

func (b *FakeBox) Reset(context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.files = map[string][]byte{}
	b.pool.Resets.Add(1)
	return nil
}

type fakeSnap map[string][]byte

func (fakeSnap) Discard() {}

func (b *FakeBox) Snapshot() (app.Snapshot, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := fakeSnap{}
	for k, v := range b.files {
		s[k] = v
	}
	return s, nil
}

func (b *FakeBox) Restore(s app.Snapshot) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, v := range s.(fakeSnap) {
		b.files[k] = v
	}
	return nil
}

func (b *FakeBox) Run(_ context.Context, spec app.RunSpec) (domain.Outcome, error) {
	b.pool.Runs.Add(1)
	if b.pool.FailAll.Load() {
		return domain.Outcome{}, errors.New("box broken")
	}
	b.mu.Lock()
	var script string
	program := ""
	for _, a := range spec.Argv {
		a = strings.TrimPrefix(a, "./")
		if _, ok := b.files[a]; ok {
			program = a
		}
	}
	script = strings.TrimSpace(string(b.files[program]))
	input := string(b.files[spec.Stdin])
	compiling := strings.HasSuffix(spec.Stdout, "compile.out")
	b.mu.Unlock()

	write := func(name, data string) { _ = b.WriteFile(name, []byte(data)) }
	o := domain.Outcome{CPUms: 5, WallMs: 7, MemoryKB: 1024}
	if compiling {
		if strings.HasPrefix(script, "CE") {
			write(spec.Stderr, "main.cpp:1:1: error: expected unqualified-id")
			o.Status, o.ExitCode = "RE", 1
			return o, nil
		}
		write("a.out", script)
		return o, nil
	}
	cmd, arg, _ := strings.Cut(script, " ")
	switch cmd {
	case "SUM":
		write(spec.Stdout, sum(input))
	case "ECHO":
		write(spec.Stdout, input)
	case "PRINT":
		write(spec.Stdout, strings.ReplaceAll(arg, `\n`, "\n"))
	case "TLE":
		o.Status, o.CPUms = "TO", spec.Limits.CPUms+10
	case "WALL":
		o.Status, o.Message, o.TimedOutWall = "TO", "Time limit exceeded (wall clock)", true
	case "MLE":
		o.Status, o.Signal, o.OOMKilled, o.MemoryKB = "SG", 9, true, spec.Limits.MemoryKB
	case "CRASH":
		o.Status, o.Signal = "SG", 11
	case "FORK":
		o.Status, o.ExitCode, o.ProcessLimit = "RE", 1, true
		write(spec.Stderr, "BlockingIOError: [Errno 11] Resource temporarily unavailable")
	case "HUGE":
		write(spec.Stdout, strings.Repeat("x", spec.Limits.OutputKB*1024+10))
	case "FAULT":
		o.Status, o.Message = "XX", "box error"
	case "FLAKY":
		if b.pool.flaky.Add(1)%2 == 0 {
			write(spec.Stdout, "wrong")
		} else {
			write(spec.Stdout, sum(input))
		}
	case "SLEEPMS":
		ms, _ := strconv.Atoi(arg)
		time.Sleep(time.Duration(ms) * time.Millisecond)
		write(spec.Stdout, sum(input))
	case "CHECK":
		b.mu.Lock()
		got, want := strings.TrimSpace(string(b.files["output.txt"])), strings.TrimSpace(string(b.files["expected.txt"]))
		b.mu.Unlock()
		if got != want {
			o.Status, o.ExitCode = "RE", 1
		}
	case "CHECKBROKEN":
		o.Status, o.ExitCode = "RE", 3
	default:
		// Real source code (plagiarism tests): behave like SUM.
		write(spec.Stdout, sum(input))
	}
	return o, nil
}

func sum(input string) string {
	total := 0
	for _, f := range strings.Fields(input) {
		n, _ := strconv.Atoi(f)
		total += n
	}
	return fmt.Sprintf("%d\n", total)
}
