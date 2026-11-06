// Package attacks holds the red-team corpus (docs/prompts/09 §7–8): hostile programs and golden
// programs judged by the real isolate sandbox. Run it with run.sh (Linux, Docker); the quarterly
// red-team exercise extends programs/ and manifest.json.
package attacks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"

	"atlas.dev/sandbox-svc/internal/domain"
)

// Case is one corpus entry.
type Case struct {
	Name       string `json:"name"`
	Lang       string `json:"lang"`
	File       string `json:"file"`
	Expected   string `json:"expected"`
	Verdict    string `json:"verdict"`
	Detail     string `json:"detail"`
	MaxSeconds int    `json:"max_seconds"`
}

// GoldenInput is the stdin of every case; golden programs print the sum.
const (
	GoldenInput    = "40 2\n"
	GoldenExpected = "42"
)

// Dir is this package's directory.
func Dir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Dir(file)
}

// LoadManifest reads manifest.json.
func LoadManifest() ([]Case, error) {
	data, err := os.ReadFile(filepath.Join(Dir(), "manifest.json"))
	if err != nil {
		return nil, err
	}
	var m struct {
		Cases []Case `json:"cases"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m.Cases, nil
}

// Expect returns the expected output of a case.
func (c Case) Expect() string {
	if c.Expected != "" {
		return c.Expected
	}
	return GoldenExpected
}

// Source reads the case's program.
func (c Case) Source() (string, error) {
	data, err := os.ReadFile(filepath.Join(Dir(), "testdata", "programs", c.File))
	return string(data), err
}

var seedRow = regexp.MustCompile(`^\s*\((\d+), '([a-z0-9_]+)', '([^']+)', (?:'sha256:[0-9a-f]{64}'|'sha256:' \|\| repeat\('0', 64\)), '([^']+)', (NULL|'[^']*'), '([^']+)', ([\d.]+), ([\d.]+), (true|false)\)`)

// LoadRegistry parses the language seed of db/migrations/0012_sandbox.sql, so the corpus always
// runs the exact commands production uses.
func LoadRegistry() (map[string]domain.Language, error) {
	data, err := os.ReadFile(filepath.Join(Dir(), "..", "..", "..", "..", "db", "migrations", "0012_sandbox.sql"))
	if err != nil {
		return nil, err
	}
	out := map[string]domain.Language{}
	for _, line := range regexp.MustCompile(`\r?\n`).Split(string(data), -1) {
		m := seedRow.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		id, _ := strconv.Atoi(m[1])
		cpu, _ := strconv.ParseFloat(m[7], 64)
		mem, _ := strconv.ParseFloat(m[8], 64)
		compile := ""
		if m[5] != "NULL" {
			compile = m[5][1 : len(m[5])-1]
		}
		out[m[2]] = domain.Language{
			ID: id, Slug: m[2], Name: m[3], SourceFile: m[4], CompileCmd: compile, RunCmd: m[6],
			CPUMultiplier: cpu, MemMultiplier: mem, Enabled: m[9] == "true",
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no languages found in the 0012 seed")
	}
	return out, nil
}
