package isolate

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

// fakeIsolate mimics the isolate CLI: --init prints the box root, --cleanup removes it, --run
// records its arguments and writes a meta file chosen by the program name.
const fakeIsolate = `#!/bin/sh
ROOT="$FAKE_ROOT"
id=""; meta=""; mode=""; stdout=""; stderr=""
for a in "$@"; do
  case "$a" in
    --box-id=*) id="${a#--box-id=}" ;;
    --meta=*) meta="${a#--meta=}" ;;
    --stdout=*) stdout="${a#--stdout=}" ;;
    --stderr=*) stderr="${a#--stderr=}" ;;
    --init) mode=init ;;
    --cleanup) mode=cleanup ;;
    --run) mode=run ;;
  esac
done
case "$mode" in
  init) mkdir -p "$ROOT/$id/box"; echo "$ROOT/$id"; exit 0 ;;
  cleanup) rm -rf "$ROOT/$id"; exit 0 ;;
esac
printf '%s\n' "$@" > "$ROOT/args-$id.txt"
prog=""; for a in "$@"; do prog="$a"; done
box="$ROOT/$id/box"
case "$prog" in
  ok) printf 'hello\n' > "$box/$stdout"; printf 'time:0.010\ntime-wall:0.020\ncg-mem:512\nexitcode:0\n' > "$meta"; exit 0 ;;
  fork) printf 'BlockingIOError: [Errno 11] Resource temporarily unavailable\n' > "$box/$stderr"; printf 'status:RE\nexitcode:1\n' > "$meta"; exit 1 ;;
  tle) printf 'status:TO\nmessage:Time limit exceeded (wall clock)\n' > "$meta"; exit 1 ;;
  nometa) exit 1 ;;
esac
printf 'status:XX\nmessage:unknown program\n' > "$meta"; exit 2
`

func setup(t *testing.T) (Config, string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "isolate")
	if err := os.WriteFile(bin, []byte(fakeIsolate), 0o755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "boxes")
	t.Setenv("FAKE_ROOT", root)
	return Config{Bin: bin, ExtraDirs: []string{"/etc:noexec"}}, root
}

func TestBoxLifecycleAndRun(t *testing.T) {
	cfg, root := setup(t)
	ctx := context.Background()
	pool, err := NewPool(ctx, cfg, 7, 2, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if pool.Size() != 2 {
		t.Fatalf("pool size %d", pool.Size())
	}
	box, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	b := box.(*Box)
	if err := b.WriteFile("main.py", []byte("print(1)")); err != nil {
		t.Fatal(err)
	}
	if err := b.WriteFile("../escape", nil); err == nil {
		t.Fatal("path escape accepted")
	}
	limits := domain.Limits{CPUms: 2000, WallMs: 5000, MemoryKB: 262144, Processes: 32, OutputKB: 1024}
	o, err := b.Run(ctx, app.RunSpec{Argv: []string{"ok"}, Stdin: "input.txt", Stdout: "output.txt", Stderr: "error.txt",
		Limits: limits, Env: map[string]string{"HOME": "/box", "A": "1"}})
	if err != nil {
		t.Fatal(err)
	}
	if o.Status != "" || o.CPUms != 10 || o.MemoryKB != 512 || o.ProcessLimit {
		t.Fatalf("outcome %+v", o)
	}
	args, _ := os.ReadFile(filepath.Join(root, "args-7.txt"))
	for _, want := range []string{"--cg", "--time=2.000", "--wall-time=5.000", "--cg-mem=262144", "--processes=32",
		"--fsize=1024", "--stdin=input.txt", "--env=A=1", "--env=HOME=/box", "--dir=/etc:noexec", "--run"} {
		if !strings.Contains(string(args), want+"\n") {
			t.Errorf("missing %s in %s", want, args)
		}
	}
	if strings.Contains(string(args), "--share-net") {
		t.Fatal("network shared with the box")
	}
	out, cut, err := b.ReadFile("output.txt", 3)
	if err != nil || string(out) != "hel" || !cut {
		t.Fatalf("read %q %v %v", out, cut, err)
	}
	if d, cut, err := b.ReadFile("missing.txt", 10); d != nil || cut || err != nil {
		t.Fatal("missing file")
	}
	// A symlink planted by the program is never followed by the worker.
	_ = os.Symlink("/etc/passwd", filepath.Join(b.path, "link.txt"))
	if d, _, err := b.ReadFile("link.txt", 1000); d != nil || err != nil {
		t.Fatalf("followed a planted symlink: %q %v", d, err)
	}

	// Fork bomb: the runtime's EAGAIN message marks the pids limit.
	o, _ = b.Run(ctx, app.RunSpec{Argv: []string{"fork"}, Stdout: "o", Stderr: "e", Limits: limits})
	if v, d, _ := domain.Classify(o, limits); v != domain.RuntimeError || d != "RESOURCE_PROCESSES" {
		t.Fatalf("fork: %s %s", v, d)
	}
	o, _ = b.Run(ctx, app.RunSpec{Argv: []string{"tle"}, Stdout: "o", Stderr: "e", Limits: limits})
	if v, d, _ := domain.Classify(o, limits); v != domain.TimeLimitExceeded || d != "WALL_TIME" {
		t.Fatalf("tle: %s %s", v, d)
	}
	if _, err := b.Run(ctx, app.RunSpec{Argv: []string{"nometa"}, Stdout: "o", Stderr: "e", Limits: limits}); err == nil {
		t.Fatal("missing meta must be a sandbox fault")
	}

	// Snapshot / restore across a reset (compile once, fresh box per case).
	_ = b.WriteFile("a.out", []byte("binary"))
	_ = os.Chmod(filepath.Join(b.path, "a.out"), 0o755)
	_ = b.WriteFile("compile.err", []byte("warnings"))
	snap, err := b.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	defer snap.Discard()
	if err := b.Reset(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(b.path, "a.out")); !os.IsNotExist(err) {
		t.Fatal("reset left files behind")
	}
	if err := b.Restore(snap); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(b.path, "a.out"))
	if err != nil || fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("restored binary not executable: %v %v", fi, err)
	}
	if _, err := os.Stat(filepath.Join(b.path, "compile.err")); !os.IsNotExist(err) {
		t.Fatal("compiler logs are not artefacts")
	}

	// Release resets in the background and returns the box to the pool.
	pool.Release(b)
	pool.Close()
	if pool.Size() != 2 {
		t.Fatalf("pool size after release %d", pool.Size())
	}
	if _, err := os.Stat(filepath.Join(b.path, "main.py")); !os.IsNotExist(err) {
		t.Fatal("released box was not wiped")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	small, _ := NewPool(ctx, cfg, 20, 1, t.TempDir())
	_, _ = small.Acquire(ctx)
	if _, err := small.Acquire(cancelled); err == nil {
		t.Fatal("acquire on an empty pool must honour the context")
	}
}

func TestPidsEventsFromCgroup(t *testing.T) {
	cfg, _ := setup(t)
	cg := t.TempDir()
	cfg.CgroupRoot = cg
	_ = os.MkdirAll(filepath.Join(cg, "box-3"), 0o755)
	b := &Box{cfg: cfg, id: 3}
	if b.pidsLimitHit() {
		t.Fatal("no events file")
	}
	_ = os.WriteFile(filepath.Join(cg, "box-3", "pids.events"), []byte("max 0\n"), 0o644)
	if b.pidsLimitHit() {
		t.Fatal("zero events")
	}
	_ = os.WriteFile(filepath.Join(cg, "box-3", "pids.events"), []byte("max 17\n"), 0o644)
	if !b.pidsLimitHit() {
		t.Fatal("pids limit hit not detected")
	}
	if _, err := NewPool(context.Background(), Config{Bin: "/nonexistent/isolate"}, 1, 1, t.TempDir()); err == nil {
		t.Fatal("missing isolate binary must fail the pool")
	}
	if err := (&Box{cfg: cfg}).Restore(nil); err == nil {
		t.Fatal("foreign snapshot")
	}
}
