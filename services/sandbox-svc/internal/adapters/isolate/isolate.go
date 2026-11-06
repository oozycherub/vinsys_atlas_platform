// Package isolate runs programs in isolate boxes (cgroups v2, namespaces, rlimits): layer 2 of
// the sandbox, inside a gVisor pod (layer 1) on the tainted sandbox node pool (PRD §2.2b).
package isolate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

// fileNameRe: box files are flat names written by the worker; nothing can escape /box.
var fileNameRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)

// processLimitHints are what runtimes print when fork/clone fails with EAGAIN under the pids
// limit; with the cgroup's pids.events they identify a fork bomb (RESOURCE_PROCESSES).
var processLimitHints = []string{
	"Resource temporarily unavailable", "BlockingIOError", "fork: retry", "EAGAIN",
	"unable to create native thread", "pthread_create failed", "failed to create new OS thread",
	"Cannot fork", "can't start new thread",
}

// Config describes the isolate installation on the worker.
type Config struct {
	Bin string // isolate binary
	// CgroupRoot is where isolate puts box cgroups (cg_root in isolate's config), used to read
	// pids.events; empty disables that check.
	CgroupRoot string
	// ExtraDirs are read-only mounts beyond isolate's defaults (/bin, /lib, /usr, ...).
	ExtraDirs []string
}

// Box is one isolate box.
type Box struct {
	cfg  Config
	id   int
	path string // the box's /box directory on the worker
	meta string // meta file, outside the box
}

func (b *Box) run(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, b.cfg.Bin, append([]string{"--cg", "--box-id=" + strconv.Itoa(b.id)}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil && !strings.Contains(strings.Join(args, " "), "--run") {
		return out, fmt.Errorf("isolate %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// Reset wipes the box: cleanup, then init (a fresh, empty /box).
func (b *Box) Reset(ctx context.Context) error {
	if _, err := b.run(ctx, "--cleanup"); err != nil {
		return err
	}
	out, err := b.run(ctx, "--init")
	if err != nil {
		return err
	}
	b.path = filepath.Join(strings.TrimSpace(string(out)), "box")
	return nil
}

func (b *Box) file(name string) (string, error) {
	if !fileNameRe.MatchString(name) {
		return "", fmt.Errorf("invalid box file name %q", name)
	}
	return filepath.Join(b.path, name), nil
}

// WriteFile writes a file readable by the box user.
func (b *Box) WriteFile(name string, data []byte) error {
	p, err := b.file(name)
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644) //nolint:gosec // the unprivileged box user must read it; nothing secret is written
}

// ReadFile reads at most limit bytes without following symlinks the program may have planted.
func (b *Box) ReadFile(name string, limit int) ([]byte, bool, error) {
	p, err := b.file(name)
	if err != nil {
		return nil, false, err
	}
	fi, err := os.Lstat(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !fi.Mode().IsRegular() {
		return nil, false, nil // a symlink or device planted by the program is ignored
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > limit {
		return data[:limit], true, nil
	}
	return data, false, nil
}

// Run executes one process with the limits and parses isolate's meta file.
func (b *Box) Run(ctx context.Context, spec app.RunSpec) (domain.Outcome, error) {
	_ = os.Remove(b.meta)
	l := spec.Limits
	args := []string{
		"--meta=" + b.meta,
		"--time=" + secs(l.CPUms), "--wall-time=" + secs(l.WallMs), "--extra-time=0.5",
		"--cg-mem=" + strconv.Itoa(l.MemoryKB),
		"--processes=" + strconv.Itoa(max(1, l.Processes)),
		"--fsize=" + strconv.Itoa(max(1, l.OutputKB)),
		"--stdout=" + spec.Stdout, "--stderr=" + spec.Stderr,
	}
	if spec.Stdin != "" {
		args = append(args, "--stdin="+spec.Stdin)
	}
	keys := make([]string, 0, len(spec.Env))
	for k := range spec.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--env="+k+"="+spec.Env[k])
	}
	for _, d := range b.cfg.ExtraDirs {
		args = append(args, "--dir="+d)
	}
	args = append(args, "--run", "--")
	args = append(args, spec.Argv...)
	if _, err := b.run(ctx, args...); err != nil {
		return domain.Outcome{}, err
	}
	meta, err := os.ReadFile(b.meta)
	if err != nil {
		return domain.Outcome{}, fmt.Errorf("meta file missing: %w", err)
	}
	o := domain.ParseMeta(string(meta))
	// The cgroup counter is proof; runtime messages count only for programs that crashed.
	o.ProcessLimit = b.pidsLimitHit() || (o.Status != "TO" && b.stderrHints(spec.Stderr))
	return o, nil
}

func secs(ms int) string { return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64) }

func (b *Box) pidsLimitHit() bool {
	if b.cfg.CgroupRoot == "" {
		return false
	}
	data, err := os.ReadFile(filepath.Join(b.cfg.CgroupRoot, "box-"+strconv.Itoa(b.id), "pids.events"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if n, ok := strings.CutPrefix(line, "max "); ok && strings.TrimSpace(n) != "0" {
			return true
		}
	}
	return false
}

func (b *Box) stderrHints(name string) bool {
	if name == "" {
		return false
	}
	data, _, _ := b.ReadFile(name, 16<<10)
	for _, h := range processLimitHints {
		if bytes.Contains(data, []byte(h)) {
			return true
		}
	}
	return false
}

// snapshot is a copy of the box's top-level regular files in a worker-private directory.
type snapshot struct{ dir string }

func (s *snapshot) Discard() { _ = os.RemoveAll(s.dir) }

// skipped files are compiler scratch and logs, not artefacts.
var skipped = map[string]bool{"compile.out": true, "compile.err": true}

// Snapshot copies the compiled artefacts out of the box.
func (b *Box) Snapshot() (app.Snapshot, error) {
	dir, err := os.MkdirTemp("", "atlas-snap-")
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(b.path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	total := int64(0)
	for _, e := range entries {
		if !e.Type().IsRegular() || skipped[e.Name()] || !fileNameRe.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if total += info.Size(); total > 256<<20 {
			_ = os.RemoveAll(dir)
			return nil, errors.New("compiled artefacts exceed 256 MB")
		}
		data, err := os.ReadFile(filepath.Join(b.path, e.Name()))
		if err != nil {
			_ = os.RemoveAll(dir)
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(dir, e.Name()), data, info.Mode().Perm()|0o444); err != nil {
			_ = os.RemoveAll(dir)
			return nil, err
		}
	}
	return &snapshot{dir: dir}, nil
}

// Restore copies a snapshot into the (fresh) box.
func (b *Box) Restore(s app.Snapshot) error {
	snap, ok := s.(*snapshot)
	if !ok {
		return errors.New("foreign snapshot")
	}
	entries, err := os.ReadDir(snap.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			return err
		}
		data, err := os.ReadFile(filepath.Join(snap.dir, e.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(b.path, e.Name()), data, info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}

// Pool keeps pre-initialised boxes (warm pool, PRD §2.2b): ~30 ms instead of ~400 ms cold.
// Acquire returns a fresh box; Release resets it in the background before reuse.
type Pool struct {
	cfg   Config
	ready chan *Box
	wg    sync.WaitGroup
}

// NewPool initialises boxes firstID..firstID+size-1. Box ids must be unique per node.
func NewPool(ctx context.Context, cfg Config, firstID, size int, metaDir string) (*Pool, error) {
	p := &Pool{cfg: cfg, ready: make(chan *Box, size)}
	for i := 0; i < size; i++ {
		b := &Box{cfg: cfg, id: firstID + i, meta: filepath.Join(metaDir, "meta-"+strconv.Itoa(firstID+i)+".txt")}
		if err := b.Reset(ctx); err != nil {
			return nil, err
		}
		p.ready <- b
	}
	return p, nil
}

// Acquire waits for a fresh box.
func (p *Pool) Acquire(ctx context.Context) (app.Box, error) {
	select {
	case b := <-p.ready:
		return b, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Release wipes the box and returns it to the pool.
func (p *Pool) Release(box app.Box) {
	b, ok := box.(*Box)
	if !ok {
		return
	}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		if err := b.Reset(context.Background()); err != nil {
			// A box that cannot be reset is dropped; the pool shrinks and the readiness probe
			// (pool size) takes the worker out of rotation.
			return
		}
		p.ready <- b
	}()
}

// Size reports how many boxes are ready now.
func (p *Pool) Size() int { return len(p.ready) }

// Close waits for background resets.
func (p *Pool) Close() { p.wg.Wait() }
