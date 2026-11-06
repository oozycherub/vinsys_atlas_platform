package domain

import (
	"hash/fnv"
	"slices"
	"strings"
	"unicode"
)

// Winnowing parameters (PRD §2.2b, MOSS): k-grams of 5 tokens, window of 4 hashes.
const (
	KGram  = 5
	Window = 4
	// SimilarityThreshold raises a code_similarity violation when exceeded.
	SimilarityThreshold = 0.8
	// MinFingerprints skips trivial programs: short canonical solutions look alike by nature.
	MinFingerprints = 12
)

// keywords stay as themselves after normalisation; every other identifier becomes "V",
// so renaming variables does not hide copying. The set covers the registry's languages.
var keywords = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`and as assert async await break case catch char class const continue
		def default defer del do double elif else enum except extends false final finally float for
		from func function go goto if implements import in instanceof int interface is lambda let
		long map new nil none not null or package pass private protected public raise range return
		select self short static struct super switch this throw throws true try type typedef union
		unsigned var void volatile while with yield std cout cin endl include using namespace vector
		string print println printf scanf input len append make chan fmt main`) {
		keywords[w] = true
	}
}

// Tokenize turns source code into normalised tokens: comments and whitespace dropped,
// identifiers → V (keywords kept), numbers → N, string literals → S, operators kept.
func Tokenize(src string) []string {
	var out []string
	r := []rune(src)
	for i := 0; i < len(r); {
		c := r[i]
		switch {
		case unicode.IsSpace(c):
			i++
		case c == '#' || (c == '/' && i+1 < len(r) && r[i+1] == '/'):
			for i < len(r) && r[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(r) && r[i+1] == '*':
			i += 2
			for i+1 < len(r) && !(r[i] == '*' && r[i+1] == '/') {
				i++
			}
			i += 2
		case c == '"' || c == '\'' || c == '`':
			i++
			for i < len(r) && r[i] != c {
				if r[i] == '\\' {
					i++
				}
				i++
			}
			i++
			out = append(out, "S")
		case unicode.IsDigit(c):
			for i < len(r) && (unicode.IsDigit(r[i]) || unicode.IsLetter(r[i]) || r[i] == '.' || r[i] == '_') {
				i++
			}
			out = append(out, "N")
		case unicode.IsLetter(c) || c == '_' || c == '$':
			j := i
			for j < len(r) && (unicode.IsLetter(r[j]) || unicode.IsDigit(r[j]) || r[j] == '_' || r[j] == '$') {
				j++
			}
			word := strings.ToLower(string(r[i:j]))
			if keywords[word] {
				out = append(out, word)
			} else {
				out = append(out, "V")
			}
			i = j
		default:
			out = append(out, string(c))
			i++
		}
	}
	return out
}

// Fingerprint returns the winnowed set of k-gram hashes, sorted and de-duplicated.
func Fingerprint(src string) []int64 {
	tokens := Tokenize(src)
	if len(tokens) < KGram {
		return nil
	}
	hashes := make([]int64, 0, len(tokens)-KGram+1)
	for i := 0; i+KGram <= len(tokens); i++ {
		h := fnv.New64a()
		for _, t := range tokens[i : i+KGram] {
			_, _ = h.Write([]byte(t))
			_, _ = h.Write([]byte{0})
		}
		hashes = append(hashes, int64(h.Sum64()>>1)) //nolint:gosec // shifted right by one bit: always fits in int64
	}
	var picked []int64
	if len(hashes) <= Window {
		picked = append(picked, slices.Min(hashes))
	} else {
		lastIdx := -1
		for start := 0; start+Window <= len(hashes); start++ {
			// rightmost minimum in the window (MOSS's robust winnowing)
			minIdx := start
			for j := start; j < start+Window; j++ {
				if hashes[j] <= hashes[minIdx] {
					minIdx = j
				}
			}
			if minIdx != lastIdx {
				picked = append(picked, hashes[minIdx])
				lastIdx = minIdx
			}
		}
	}
	slices.Sort(picked)
	return slices.Compact(picked)
}

// Similarity is the Jaccard index of two fingerprint sets (sorted, unique). Trivial programs
// (fewer than MinFingerprints hashes on either side) score 0.
func Similarity(a, b []int64) float64 {
	if len(a) < MinFingerprints || len(b) < MinFingerprints {
		return 0
	}
	i, j, common := 0, 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			common++
			i++
			j++
		case a[i] < b[j]:
			i++
		default:
			j++
		}
	}
	return float64(common) / float64(len(a)+len(b)-common)
}
