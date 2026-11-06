package domain

import (
	"strconv"
	"strings"
)

// Limits are the execution boundaries of one run (PRD §2.2b, "Execution boundaries").
type Limits struct {
	CPUms     int `json:"cpu_ms"`
	WallMs    int `json:"wall_ms"`
	MemoryKB  int `json:"memory_kb"`
	Processes int `json:"processes"`
	OutputKB  int `json:"output_kb"`
	DiskKB    int `json:"disk_kb"`
}

// DefaultLimits apply when the question author sets nothing.
var DefaultLimits = Limits{CPUms: 2000, WallMs: 5000, MemoryKB: 256 * 1024, Processes: 32, OutputKB: 1024, DiskKB: 64 * 1024}

// HardCaps can never be exceeded, by authors or by language multipliers.
var HardCaps = Limits{CPUms: 15000, WallMs: 30000, MemoryKB: 1024 * 1024, Processes: 64, OutputKB: 8 * 1024, DiskKB: 256 * 1024}

// CompileLimits bound the compile step separately (compiler bombs, §2.2d).
var CompileLimits = Limits{CPUms: 10000, WallMs: 20000, MemoryKB: 512 * 1024, Processes: 64, OutputKB: 16, DiskKB: 256 * 1024}

// LimitOverrides are the author's per-question settings; zero means "use the default".
type LimitOverrides struct {
	CPUms     int `json:"cpu_ms,omitempty"`
	WallMs    int `json:"wall_ms,omitempty"`
	MemoryKB  int `json:"memory_kb,omitempty"`
	Processes int `json:"processes,omitempty"`
	OutputKB  int `json:"output_kb,omitempty"`
}

// Validate rejects overrides above the hard caps (authoring error, not silently clipped).
func (o LimitOverrides) Validate() error {
	check := func(name string, v, lo, hi int) error {
		if v != 0 && (v < lo || v > hi) {
			return &RuleError{Code: "INVALID_LIMITS", Message: name + " must be between " + strconv.Itoa(lo) + " and " + strconv.Itoa(hi) + "."}
		}
		return nil
	}
	for _, err := range []error{
		check("cpu_ms", o.CPUms, 100, HardCaps.CPUms),
		check("wall_ms", o.WallMs, 100, HardCaps.WallMs),
		check("memory_kb", o.MemoryKB, 16*1024, HardCaps.MemoryKB),
		check("processes", o.Processes, 1, HardCaps.Processes),
		check("output_kb", o.OutputKB, 1, HardCaps.OutputKB),
	} {
		if err != nil {
			return err
		}
	}
	return nil
}

// Resolve combines defaults, the author's overrides and the language multipliers, then clips to
// the hard caps. The wall time defaults to 2 × CPU + 1 s. `HeapMB` is the memory the program may
// use for its own heap (`${MEM}` in run commands); the cgroup limit is that × the multiplier.
func Resolve(o LimitOverrides, lang Language) (l Limits, heapMB int) {
	l = DefaultLimits
	if o.CPUms > 0 {
		l.CPUms = o.CPUms
	}
	if o.MemoryKB > 0 {
		l.MemoryKB = o.MemoryKB
	}
	if o.Processes > 0 {
		l.Processes = o.Processes
	}
	if o.OutputKB > 0 {
		l.OutputKB = o.OutputKB
	}
	heapMB = l.MemoryKB / 1024
	l.CPUms = min(int(float64(l.CPUms)*nonZero(lang.CPUMultiplier)), HardCaps.CPUms)
	l.MemoryKB = int(float64(l.MemoryKB) * nonZero(lang.MemMultiplier))
	l.WallMs = 2*l.CPUms + 1000
	if o.WallMs > 0 {
		l.WallMs = max(o.WallMs, l.CPUms) // never below the CPU limit
	}
	l.WallMs = min(l.WallMs, HardCaps.WallMs)
	l.MemoryKB = min(l.MemoryKB, HardCaps.MemoryKB)
	l.Processes = min(l.Processes, HardCaps.Processes)
	l.OutputKB = min(l.OutputKB, HardCaps.OutputKB)
	heapMB = min(heapMB, l.MemoryKB/1024)
	return l, heapMB
}

func nonZero(m float64) float64 {
	if m <= 0 {
		return 1
	}
	return m
}

// Language is one row of the registry (`sandbox_languages`).
type Language struct {
	ID            int
	Slug          string
	Name          string
	ImageDigest   string
	SourceFile    string
	CompileCmd    string // empty for interpreted languages
	RunCmd        string
	CPUMultiplier float64
	MemMultiplier float64
	Enabled       bool
}

// Argv expands `${MEM}` and splits a registry command into argv. Commands are plain
// space-separated words (no shell), so the candidate's code is never interpolated.
func (l Language) Argv(cmd string, heapMB int) []string {
	cmd = strings.ReplaceAll(cmd, "${MEM}", strconv.Itoa(max(heapMB, 16)))
	return strings.Fields(cmd)
}
