package domain

import (
	"fmt"
	"strings"
	"testing"
)

func TestWorstFollowsSeverityOrder(t *testing.T) {
	order := []Verdict{Accepted, WrongAnswer, OutputLimitExceeded, MemoryLimitExceeded, TimeLimitExceeded, RuntimeError, CompilationError, InternalError}
	for i := 1; i < len(order); i++ {
		if got := Worst([]Verdict{order[i-1], order[i], order[i-1]}); got != order[i] {
			t.Fatalf("Worst(%s, %s) = %s", order[i-1], order[i], got)
		}
	}
	if Worst(nil) != Accepted {
		t.Fatal("no cases means accepted")
	}
	if Queued.IsFinal() || Running.IsFinal() || !WrongAnswer.IsFinal() {
		t.Fatal("IsFinal")
	}
}

func TestSummarizeWeightsAndMaxima(t *testing.T) {
	s := Summarize([]CaseResult{
		{Verdict: Accepted, Weight: 3, CPUms: 10, MemoryKB: 100},
		{Verdict: WrongAnswer, Weight: 1, CPUms: 30, MemoryKB: 50},
		{Verdict: Accepted, Weight: 0, CPUms: 20, MemoryKB: 400}, // weight 0 counts as 1
	})
	if s.Verdict != WrongAnswer || s.TestsPassed != 2 || s.TestsTotal != 3 {
		t.Fatalf("summary %+v", s)
	}
	if s.Ratio != 0.8 || s.MaxCPUms != 30 || s.MaxMemoryKB != 400 {
		t.Fatalf("ratio/maxima %+v", s)
	}
	if Points(s.Ratio, 10) != 8 || Points(1.0/3, 10) != 3.33 {
		t.Fatal("points")
	}
	if Summarize(nil).Ratio != 0 {
		t.Fatal("empty ratio")
	}
}

func TestResolveLimits(t *testing.T) {
	py := Language{CPUMultiplier: 3, MemMultiplier: 1.5}
	l, heap := Resolve(LimitOverrides{}, py)
	if l.CPUms != 6000 || l.WallMs != 13000 || l.MemoryKB != 393216 || heap != 256 || l.Processes != 32 || l.OutputKB != 1024 {
		t.Fatalf("python defaults %+v heap %d", l, heap)
	}
	// Author overrides are clipped by the hard caps after multipliers.
	l, heap = Resolve(LimitOverrides{CPUms: 10000, MemoryKB: 1024 * 1024, WallMs: 25000, Processes: 64, OutputKB: 8192}, py)
	if l.CPUms != HardCaps.CPUms || l.MemoryKB != HardCaps.MemoryKB || l.WallMs != 25000 || heap != 1024 {
		t.Fatalf("capped %+v heap %d", l, heap)
	}
	if err := (LimitOverrides{CPUms: 16000}).Validate(); err == nil || !strings.Contains(err.Error(), "INVALID_LIMITS") {
		t.Fatal("cpu above cap must be rejected")
	}
	if err := (LimitOverrides{Processes: 65}).Validate(); err == nil {
		t.Fatal("processes above cap must be rejected")
	}
	if err := (LimitOverrides{CPUms: 3000, MemoryKB: 512 * 1024}).Validate(); err != nil {
		t.Fatal(err)
	}
	argv := Language{}.Argv("java -Xss64m -Xmx${MEM}m Main", 256)
	if strings.Join(argv, "|") != "java|-Xss64m|-Xmx256m|Main" {
		t.Fatalf("argv %v", argv)
	}
}

func TestParseMetaAndClassify(t *testing.T) {
	lim := Limits{MemoryKB: 262144}
	cases := []struct {
		meta    string
		extra   func(*Outcome)
		verdict Verdict
		detail  string
		clean   bool
	}{
		{"time:0.012\ntime-wall:0.030\ncg-mem:2048\nexitcode:0\n", nil, Accepted, "", true},
		{"status:TO\nmessage:Time limit exceeded\ntime:2.010\n", nil, TimeLimitExceeded, "CPU_TIME", false},
		{"status:TO\nmessage:Time limit exceeded (wall clock)\n", nil, TimeLimitExceeded, "WALL_TIME", false},
		{"status:SG\nexitsig:9\ncg-oom-killed:1\ncg-mem:262144\n", nil, MemoryLimitExceeded, "", false},
		{"status:SG\nexitsig:25\n", nil, OutputLimitExceeded, "", false},
		{"status:SG\nexitsig:11\n", nil, RuntimeError, "SIGNAL_11", false},
		{"status:RE\nexitcode:3\n", nil, RuntimeError, "EXIT_3", false},
		{"status:RE\nexitcode:1\n", func(o *Outcome) { o.ProcessLimit = true }, RuntimeError, "RESOURCE_PROCESSES", false},
		{"status:TO\nmessage:Time limit exceeded\n", func(o *Outcome) { o.ProcessLimit = true }, RuntimeError, "RESOURCE_PROCESSES", false},
		{"exitcode:0\n", func(o *Outcome) { o.ProcessLimit = true }, Accepted, "", true},
		{"exitcode:0\n", func(o *Outcome) { o.OutputTooLong = true }, OutputLimitExceeded, "", false},
		{"status:XX\nmessage:box error\n", nil, InternalError, "SANDBOX_ERROR", false},
		{"exitcode:0\nmax-rss:300000\n", nil, MemoryLimitExceeded, "", false},
		{"garbage\nexitcode:0\n", nil, Accepted, "", true},
	}
	for i, c := range cases {
		o := ParseMeta(c.meta)
		if c.extra != nil {
			c.extra(&o)
		}
		v, d, ok := Classify(o, lim)
		if v != c.verdict || d != c.detail || ok != c.clean {
			t.Errorf("case %d: got %s %q %v, want %s %q %v", i, v, d, ok, c.verdict, c.detail, c.clean)
		}
	}
	o := ParseMeta("time:1.5\ntime-wall:2.25\ncg-mem:100\nmax-rss:120\nexitsig:6\n")
	if o.CPUms != 1500 || o.WallMs != 2250 || o.MemoryKB != 120 || o.Signal != 6 {
		t.Fatalf("parsed %+v", o)
	}
	if v, ok := ClassifyCompile(Outcome{ExitCode: 1, Status: "RE"}); v != CompilationError || ok {
		t.Fatal("compile failure")
	}
	if v, ok := ClassifyCompile(Outcome{Status: "TO"}); v != CompilationError || ok {
		t.Fatal("compile timeout is a compilation error")
	}
	if v, _ := ClassifyCompile(Outcome{Status: "XX"}); v != InternalError {
		t.Fatal("sandbox fault while compiling")
	}
	if _, ok := ClassifyCompile(Outcome{}); !ok {
		t.Fatal("clean compile")
	}
}

func TestCheckers(t *testing.T) {
	cases := []struct {
		kind     string
		tol      float64
		exp, act string
		want     bool
	}{
		{CheckExact, 0, "1 2\n", "1 2\n", true},
		{CheckExact, 0, "1 2\n", "1 2", false},
		{CheckTrimWS, 0, "1 2\n3\n", "1 2   \r\n3\n\n\n", true},
		{CheckTrimWS, 0, "1 2\n3", " 1 2\n3", false},
		{"", 0, "a\n", "a", true}, // default is trim_ws
		{CheckFloatTol, 0, "0.3333333 x", "0.33333334 x", true},
		{CheckFloatTol, 0, "1.0", "1.1", false},
		{CheckFloatTol, 0.2, "1.0", "1.1", true},
		{CheckFloatTol, 0, "1e9", "1000000000.0005", true}, // relative for large values
		{CheckFloatTol, 0, "1 2", "1", false},
		{CheckFloatTol, 0, "1", "NaN", false},
		{CheckFloatTol, 0, "yes", "no", false},
		{CheckUnorderedLines, 0, "a\nb\nc\n", "c\na \nb", true},
		{CheckUnorderedLines, 0, "a\nb\n", "a\na\n", false},
	}
	for i, c := range cases {
		if got := Compare(CheckerSpec{Kind: c.kind, Tolerance: c.tol}, c.exp, c.act); got != c.want {
			t.Errorf("case %d (%s): got %v", i, c.kind, got)
		}
	}
	for _, ok := range []CheckerSpec{{Kind: CheckExact}, {Kind: CheckCustom}, {Kind: CheckFloatTol, Tolerance: 1e-9}} {
		if ValidateChecker(ok) != nil {
			t.Fatalf("valid checker %v rejected", ok)
		}
	}
	if ValidateChecker(CheckerSpec{Kind: "regex"}) == nil || ValidateChecker(CheckerSpec{Kind: CheckFloatTol, Tolerance: 2}) == nil {
		t.Fatal("invalid checkers accepted")
	}
}

// A tenant with one job is served within one round, however long the big tenant's backlog is.
func TestFairSchedulerDoesNotStarveSmallTenant(t *testing.T) {
	s := NewFairScheduler(func(string) int { return 1 })
	for i := 0; i < 50; i++ {
		s.Pick([]string{"big"})
	}
	if got := s.Pick([]string{"big", "small"}); got != "small" && s.Pick([]string{"big", "small"}) != "small" {
		t.Fatal("small tenant not served within one round")
	}
	// Weights: 3:1 over 400 picks.
	w := NewFairScheduler(func(k string) int {
		if k == "gold" {
			return 3
		}
		return 1
	})
	counts := map[string]int{}
	for i := 0; i < 400; i++ {
		counts[w.Pick([]string{"gold", "basic"})]++
	}
	if counts["gold"] != 300 || counts["basic"] != 100 {
		t.Fatalf("weighted shares %v", counts)
	}
	if w.Pick(nil) != "" {
		t.Fatal("empty pick")
	}
	// Idle keys do not bank credit.
	w.Pick([]string{"basic"})
	if _, banked := w.current["gold"]; banked {
		t.Fatal("idle key kept its credit")
	}
}

const original = `
def solve(numbers):
    # sort and sum the top three
    best = sorted(numbers, reverse=True)[:3]
    total = 0
    for value in best:
        total += value
    return total

if __name__ == "__main__":
    data = list(map(int, input().split()))
    print(solve(data))
`

func TestFingerprintSurvivesRenamingAndComments(t *testing.T) {
	renamed := strings.NewReplacer("solve", "f", "numbers", "xs", "best", "top", "total", "acc", "value", "v", "data", "arr").Replace(original)
	renamed = strings.ReplaceAll(renamed, "# sort and sum the top three", "// different comment")
	a, b := Fingerprint(original), Fingerprint(renamed)
	if len(a) < MinFingerprints {
		t.Fatalf("too few fingerprints: %d", len(a))
	}
	if sim := Similarity(a, b); sim <= SimilarityThreshold {
		t.Fatalf("renamed copy similarity %.2f", sim)
	}
	different := `
import heapq
n = int(input())
heap = []
for _ in range(n):
    a, b = input().split()
    heapq.heappush(heap, (int(b), a))
while heap:
    w, name = heapq.heappop(heap)
    print(name, w * 2 if w % 2 else w // 2)
`
	if sim := Similarity(a, Fingerprint(different)); sim > 0.3 {
		t.Fatalf("unrelated programs similarity %.2f", sim)
	}
	if Similarity(Fingerprint("print(1)"), Fingerprint("print(1)")) != 0 {
		t.Fatal("trivial programs must not be compared")
	}
	if Fingerprint("x") != nil {
		t.Fatal("fewer tokens than k")
	}
	toks := Tokenize("/* c */ int x = 0x1F; s = \"a\\\"b\"; y = 'c'")
	if strings.Join(toks, " ") != "int V = N ; V = S ; V = S" {
		t.Fatalf("tokens %v", toks)
	}
}

func TestBundleValidationAndVerification(t *testing.T) {
	if ValidateTests(nil) == nil {
		t.Fatal("no tests")
	}
	if ValidateTests([]TestCase{{Input: strings.Repeat("x", MaxCaseBytes+1)}}) == nil {
		t.Fatal("oversized case")
	}
	if ValidateTests([]TestCase{{Weight: -1}}) == nil {
		t.Fatal("negative weight")
	}
	if ValidateTests([]TestCase{{Input: "1", Expected: "1", Weight: 2}}) != nil {
		t.Fatal("valid tests")
	}
	b := BundleContent{Tests: []TestCase{{ID: "a", Input: "1", Expected: "2"}}}
	d1, c1, _ := b.Encode()
	d2, c2, _ := b.Encode()
	if string(d1) != string(d2) || c1 != c2 {
		t.Fatal("encoding must be deterministic")
	}
	ac := []Verdict{Accepted, Accepted}
	if s, _ := VerifyOutcome([][]Verdict{ac, ac, ac, ac, ac}); s != "verified" {
		t.Fatal(s)
	}
	if s, d := VerifyOutcome([][]Verdict{ac, {Accepted, TimeLimitExceeded}, ac}); s != "flaky" || !strings.Contains(d, "test 2") {
		t.Fatal(s, d)
	}
	if s, d := VerifyOutcome([][]Verdict{{WrongAnswer, Accepted}, {WrongAnswer, Accepted}}); s != "reference_failed" || d != "wrong_answer: test 1" {
		t.Fatal(s, d)
	}
	if s, _ := VerifyOutcome([][]Verdict{{InternalError}, {InternalError}}); s != "" {
		t.Fatal("internal errors must be retried, not judged")
	}
	if s, _ := VerifyOutcome(nil); s != "reference_failed" {
		t.Fatal("no runs")
	}
	if s, _ := VerifyOutcome([][]Verdict{ac, {Accepted}}); s != "flaky" {
		t.Fatal("different lengths")
	}
	e := NotFound("X", "y")
	c := Conflict("C", "d")
	if e.Kind != "not_found" || c.Kind != "conflict" || fmt.Sprint(e) != "X: y" {
		t.Fatal("error helpers")
	}
}
