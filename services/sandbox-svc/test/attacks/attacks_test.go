//go:build attack

package attacks

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"atlas.dev/sandbox-svc/internal/adapters/isolate"
	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

// TestCorpus judges every case of ATTACK_LANG with the real isolate sandbox, inside that
// language's judge image (run.sh). Zero escapes: every probe must report BLOCKED.
func TestCorpus(t *testing.T) {
	lang := os.Getenv("ATTACK_LANG")
	if lang == "" {
		t.Fatal("set ATTACK_LANG (run.sh does)")
	}
	langs, err := LoadRegistry()
	if err != nil {
		t.Fatal(err)
	}
	l, ok := langs[lang]
	if !ok {
		t.Fatalf("unknown language %s", lang)
	}
	// A canary in the worker's own environment must never be visible to candidate code.
	t.Setenv("ATLAS_CANARY_SECRET", "canary-must-not-leak")
	extra := []string{"/etc:noexec"}
	if lang == "java" {
		extra = append(extra, "/opt")
	}
	ctx := context.Background()
	pool, err := isolate.NewPool(ctx, isolate.Config{
		Bin: "/usr/local/bin/isolate", CgroupRoot: "/sys/fs/cgroup/isolate.slice", ExtraDirs: extra,
	}, 0, 4, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	judge := &app.Judge{Pool: pool}
	cases, err := LoadManifest()
	if err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, c := range cases {
		if c.Lang != lang {
			continue
		}
		ran++
		t.Run(c.Name, func(t *testing.T) {
			src, err := c.Source()
			if err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			out, err := judge.Run(ctx, app.JudgeInput{
				Lang: l, Source: src, Compare: true, Checker: domain.CheckerSpec{Kind: domain.CheckTrimWS},
				Cases: []domain.TestCase{{ID: "t1", Input: GoldenInput, Expected: c.Expect(), Weight: 1}},
			})
			elapsed := time.Since(start)
			if err != nil {
				t.Fatalf("sandbox fault: %v", err)
			}
			got := string(out.Summary.Verdict)
			detail := ""
			if len(out.Cases) > 0 {
				detail = out.Cases[0].Detail
			}
			if got != c.Verdict || (c.Detail != "" && detail != c.Detail) {
				stdout := ""
				if len(out.Cases) > 0 {
					stdout = strings.TrimSpace(out.Cases[0].Stdout)
				}
				t.Fatalf("verdict %s/%s, want %s/%s (stdout %q, compile %v)", got, detail, c.Verdict, c.Detail, stdout, deref(out.CompileOutput))
			}
			max := c.MaxSeconds
			if max == 0 {
				max = 40
			}
			if elapsed > time.Duration(max)*time.Second {
				t.Fatalf("took %s (limit %ds): limits not enforced in time", elapsed, max)
			}
			t.Logf("%s in %s", got, elapsed.Round(time.Millisecond))
		})
	}
	if ran == 0 {
		t.Fatalf("no cases for %s", lang)
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
