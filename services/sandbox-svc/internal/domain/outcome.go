package domain

import (
	"bufio"
	"strconv"
	"strings"
)

// Outcome is what the box reports about one process run (isolate's meta file, PRD §2.2b).
type Outcome struct {
	Status        string // "", "RE" (non-zero exit), "SG" (signal), "TO" (timeout), "XX" (sandbox error)
	ExitCode      int
	Signal        int
	CPUms         int
	WallMs        int
	MemoryKB      int
	OOMKilled     bool
	TimedOutWall  bool
	Message       string
	ProcessLimit  bool // the pids limit was hit (fork bomb guard)
	OutputTooLong bool // stdout + stderr exceeded the output limit
}

const sigXFSZ = 25 // file size limit exceeded: isolate's --fsize

// ParseMeta reads isolate's `--meta` file ("key:value" lines).
func ParseMeta(text string) Outcome {
	var o Outcome
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		key, value, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		switch key {
		case "status":
			o.Status = value
		case "exitcode":
			o.ExitCode = atoi(value)
		case "exitsig":
			o.Signal = atoi(value)
		case "time":
			o.CPUms = seconds(value)
		case "time-wall":
			o.WallMs = seconds(value)
		case "cg-mem":
			o.MemoryKB = max(o.MemoryKB, atoi(value))
		case "max-rss":
			o.MemoryKB = max(o.MemoryKB, atoi(value))
		case "cg-oom-killed":
			o.OOMKilled = value == "1"
		case "message":
			o.Message = value
			if strings.Contains(value, "wall") {
				o.TimedOutWall = true
			}
		}
	}
	return o
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func seconds(s string) int {
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return int(f * 1000)
}

// Classify maps a finished run to a verdict before output comparison. ok=false means the run
// was clean and the output still has to be checked. Detail explains failures for authors.
func Classify(o Outcome, l Limits) (v Verdict, detail string, ok bool) {
	switch {
	case o.Status == "XX":
		return InternalError, "SANDBOX_ERROR", false
	case o.OOMKilled || (l.MemoryKB > 0 && o.MemoryKB > l.MemoryKB):
		return MemoryLimitExceeded, "", false
	// A fork bomb that hit the pids limit often spins until the time limit: still a fork bomb.
	case o.ProcessLimit && (o.Status == "RE" || o.Status == "SG" || o.Status == "TO"):
		return RuntimeError, "RESOURCE_PROCESSES", false
	case o.Status == "TO":
		if o.TimedOutWall {
			return TimeLimitExceeded, "WALL_TIME", false
		}
		return TimeLimitExceeded, "CPU_TIME", false
	case o.OutputTooLong || (o.Status == "SG" && o.Signal == sigXFSZ):
		return OutputLimitExceeded, "", false
	case o.Status == "SG":
		return RuntimeError, "SIGNAL_" + strconv.Itoa(o.Signal), false
	case o.Status == "RE" || o.ExitCode != 0:
		return RuntimeError, "EXIT_" + strconv.Itoa(o.ExitCode), false
	}
	return Accepted, "", true
}

// ClassifyCompile maps the compile step: any failure is a compilation error, except a sandbox
// fault (internal error, retried).
func ClassifyCompile(o Outcome) (Verdict, bool) {
	if o.Status == "XX" {
		return InternalError, false
	}
	if o.Status != "" || o.ExitCode != 0 || o.OOMKilled {
		return CompilationError, false
	}
	return Accepted, true
}
