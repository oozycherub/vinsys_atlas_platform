package attacks

import (
	"testing"

	"atlas.dev/sandbox-svc/internal/domain"
)

// Runs everywhere: the corpus is well-formed and matches the registry (the real run needs Linux).
func TestCorpusIsWellFormed(t *testing.T) {
	cases, err := LoadManifest()
	if err != nil {
		t.Fatal(err)
	}
	langs, err := LoadRegistry()
	if err != nil {
		t.Fatal(err)
	}
	if len(langs) != 7 || langs["java"].SourceFile != "Main.java" || langs["python"].CPUMultiplier != 3 ||
		langs["cpp"].CompileCmd == "" || langs["python"].CompileCmd != "" || langs["sql"].Enabled {
		t.Fatalf("registry parse: %+v", langs)
	}
	golden := map[string]int{}
	required := map[string]bool{
		"fork bomb (Python)": true, "infinite loop (Python)": true, "sleep(999)": true, "2 GB allocation (Python)": true,
		"network connect and DNS": true, "/proc/1/environ": true, "host filesystem": true, "50 MB of stdout": true,
		"C++ template bomb": true,
	}
	for _, c := range cases {
		if _, ok := langs[c.Lang]; !ok {
			t.Errorf("%s: unknown language %s", c.Name, c.Lang)
		}
		if !domain.Verdict(c.Verdict).IsFinal() {
			t.Errorf("%s: verdict %s", c.Name, c.Verdict)
		}
		if src, err := c.Source(); err != nil || src == "" {
			t.Errorf("%s: %v", c.Name, err)
		}
		if c.Verdict == "accepted" || c.Verdict == "wrong_answer" {
			golden[c.Lang]++
		}
		delete(required, c.Name)
	}
	if len(required) > 0 {
		t.Fatalf("acceptance attacks missing from the corpus: %v", required)
	}
	for _, lang := range []string{"python", "java", "cpp", "c", "node", "go"} {
		if golden[lang] < 2 {
			t.Errorf("golden programs for %s: %d (want AC and WA)", lang, golden[lang])
		}
	}
}
