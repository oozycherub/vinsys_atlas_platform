// Package config reads the environment (12-factor). Invalid configuration stops the process
// at boot (MASTER_ORCHESTRATION_PROMPT §4.10).
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Config holds both binaries' settings.
type Config struct {
	Env         string
	Port        int
	DatabaseURL string
	LogLevel    string

	AuthIssuer, AuthAudience, AuthJWKSURL, AuthSharedSecret string

	S3Endpoint, S3AccessKey, S3SecretKey, S3Bucket string
	S3Secure                                       bool

	EventSource     string // none | kafka
	KafkaBrokers    []string
	DeadLetterTopic string

	// Worker only.
	WorkerID        string
	WorkerLanguages []string // slugs this image serves
	ImageDigest     string   // this image's digest; must match the registry
	IsolateBin      string
	CgroupRoot      string
	ExtraDirs       []string // read-only mounts in the box beyond isolate's defaults
	BoxFirstID      int
	BoxPoolSize     int
	CacheDir        string
	HealthPort      int
}

var digestRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Load reads and validates the environment. worker selects the worker's extra settings.
func Load(getenv func(string) string, worker bool) (Config, error) {
	var problems []string
	get := func(k, def string) string {
		if v := strings.TrimSpace(getenv(k)); v != "" {
			return v
		}
		return def
	}
	num := func(k string, def, lo, hi int) int {
		v := get(k, strconv.Itoa(def))
		n, err := strconv.Atoi(v)
		if err != nil || n < lo || n > hi {
			problems = append(problems, fmt.Sprintf("%s must be an integer in [%d, %d]", k, lo, hi))
		}
		return n
	}
	need := func(k string) string {
		v := get(k, "")
		if v == "" {
			problems = append(problems, k+" is required")
		}
		return v
	}
	isURL := func(k, v string) {
		if v == "" {
			return
		}
		if u, err := url.Parse(v); err != nil || u.Scheme == "" || u.Host == "" {
			problems = append(problems, k+" must be a URL")
		}
	}
	c := Config{
		Env:              get("NODE_ENV", "development"),
		Port:             num("ATLAS_SANDBOX_PORT", 8089, 1, 65535),
		DatabaseURL:      need("ATLAS_DATABASE_URL"),
		LogLevel:         get("ATLAS_LOG_LEVEL", "info"),
		AuthIssuer:       need("ATLAS_AUTH_ISSUER"),
		AuthAudience:     need("ATLAS_AUTH_AUDIENCE"),
		AuthJWKSURL:      get("ATLAS_AUTH_JWKS_URL", ""),
		AuthSharedSecret: get("ATLAS_AUTH_SHARED_SECRET", ""),
		S3Endpoint:       get("ATLAS_S3_ENDPOINT", ""),
		S3AccessKey:      get("ATLAS_S3_ACCESS_KEY", ""),
		S3SecretKey:      get("ATLAS_S3_SECRET_KEY", ""),
		S3Bucket:         get("ATLAS_SANDBOX_BUCKET", "atlas-sandbox"),
		S3Secure:         get("ATLAS_S3_SECURE", "true") == "true",
		EventSource:      get("ATLAS_SANDBOX_EVENT_SOURCE", "none"),
		DeadLetterTopic:  get("ATLAS_SANDBOX_DEAD_LETTER_TOPIC", "sandbox-svc.events.dlq"),
		WorkerID:         get("ATLAS_JUDGE_WORKER_ID", getenv("HOSTNAME")),
		ImageDigest:      get("ATLAS_JUDGE_IMAGE_DIGEST", ""),
		IsolateBin:       get("ATLAS_JUDGE_ISOLATE_BIN", "/usr/local/bin/isolate"),
		CgroupRoot:       get("ATLAS_JUDGE_CGROUP_ROOT", ""),
		CacheDir:         get("ATLAS_JUDGE_CACHE_DIR", "/var/cache/atlas-judge"),
	}
	for _, d := range strings.Split(get("ATLAS_JUDGE_EXTRA_DIRS", "/etc:noexec"), ",") {
		if d = strings.TrimSpace(d); d != "" {
			if !strings.HasPrefix(d, "/") || strings.Contains(d, "..") || strings.HasPrefix(d, "/proc") || strings.HasPrefix(d, "/sys") || strings.HasPrefix(d, "/var") {
				problems = append(problems, "ATLAS_JUDGE_EXTRA_DIRS entries must be absolute, outside /proc, /sys and /var")
				continue
			}
			c.ExtraDirs = append(c.ExtraDirs, d)
		}
	}
	if c.LogLevel != "debug" && c.LogLevel != "info" && c.LogLevel != "warn" && c.LogLevel != "error" {
		problems = append(problems, "ATLAS_LOG_LEVEL must be debug, info, warn or error")
	}
	isURL("ATLAS_AUTH_JWKS_URL", c.AuthJWKSURL)
	if c.AuthJWKSURL == "" && len(c.AuthSharedSecret) < 32 {
		problems = append(problems, "set ATLAS_AUTH_JWKS_URL (or a shared secret of ≥ 32 characters outside production)")
	}
	if b := get("ATLAS_KAFKA_BROKERS", ""); b != "" {
		for _, s := range strings.Split(b, ",") {
			if s = strings.TrimSpace(s); s != "" {
				c.KafkaBrokers = append(c.KafkaBrokers, s)
			}
		}
	}
	if c.EventSource != "none" && c.EventSource != "kafka" {
		problems = append(problems, "ATLAS_SANDBOX_EVENT_SOURCE must be none or kafka")
	}
	if c.EventSource == "kafka" && len(c.KafkaBrokers) == 0 {
		problems = append(problems, "ATLAS_KAFKA_BROKERS is required when ATLAS_SANDBOX_EVENT_SOURCE=kafka")
	}
	if worker {
		c.BoxFirstID = num("ATLAS_JUDGE_BOX_FIRST_ID", 0, 0, 900)
		c.BoxPoolSize = num("ATLAS_JUDGE_BOX_POOL", 4, 2, 64)
		c.HealthPort = num("ATLAS_JUDGE_HEALTH_PORT", 8090, 1, 65535)
		for _, s := range strings.Split(need("ATLAS_JUDGE_LANGUAGES"), ",") {
			if s = strings.TrimSpace(s); s != "" {
				c.WorkerLanguages = append(c.WorkerLanguages, s)
			}
		}
		if !digestRe.MatchString(c.ImageDigest) {
			problems = append(problems, "ATLAS_JUDGE_IMAGE_DIGEST must be sha256:<64 hex>")
		}
		if c.WorkerID == "" {
			problems = append(problems, "ATLAS_JUDGE_WORKER_ID (or HOSTNAME) is required")
		}
	}
	if c.Env == "production" {
		if c.AuthSharedSecret != "" {
			problems = append(problems, "ATLAS_AUTH_SHARED_SECRET is not allowed in production (shared-secret tokens)")
		}
		if !worker && c.EventSource == "none" {
			problems = append(problems, "ATLAS_SANDBOX_EVENT_SOURCE=none is not allowed in production")
		}
		if c.S3Endpoint == "" {
			problems = append(problems, "ATLAS_S3_ENDPOINT is required in production (in-memory bundles)")
		}
		if worker && strings.Trim(strings.TrimPrefix(c.ImageDigest, "sha256:"), "0") == "" {
			problems = append(problems, "ATLAS_JUDGE_IMAGE_DIGEST must be a real digest in production")
		}
	}
	if len(problems) > 0 {
		return c, errors.New("invalid configuration:\n  - " + strings.Join(problems, "\n  - "))
	}
	return c, nil
}

// FromOS reads the process environment.
func FromOS(worker bool) (Config, error) { return Load(os.Getenv, worker) }
