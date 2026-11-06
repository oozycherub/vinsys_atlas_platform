package config

import (
	"io"
	"log/slog"
	"strings"
	"testing"

	"atlas.dev/sandbox-svc/internal/domain"
)

func env(over map[string]string) func(string) string {
	base := map[string]string{
		"ATLAS_DATABASE_URL":       "postgres://u@h/db",
		"ATLAS_AUTH_ISSUER":        "https://id.atlas.test",
		"ATLAS_AUTH_AUDIENCE":      "atlas-api",
		"ATLAS_AUTH_SHARED_SECRET": "test-only-shared-secret-at-least-32-chars!",
		"ATLAS_JUDGE_LANGUAGES":    "python, cpp",
		"ATLAS_JUDGE_IMAGE_DIGEST": "sha256:" + strings.Repeat("0", 64),
		"HOSTNAME":                 "judge-python-abc",
	}
	for k, v := range over {
		base[k] = v
	}
	return func(k string) string { return base[k] }
}

func TestLoad(t *testing.T) {
	c, err := Load(env(nil), false)
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 8089 || c.EventSource != "none" || c.S3Bucket != "atlas-sandbox" || c.DeadLetterTopic != "sandbox-svc.events.dlq" {
		t.Fatalf("defaults %+v", c)
	}
	w, err := Load(env(nil), true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(w.ExtraDirs, ",") != "/etc:noexec" {
		t.Fatalf("extra dirs %v", w.ExtraDirs)
	}
	if w.WorkerID != "judge-python-abc" || strings.Join(w.WorkerLanguages, ",") != "python,cpp" || w.BoxPoolSize != 4 || w.HealthPort != 8090 {
		t.Fatalf("worker %+v", w)
	}
	k, err := Load(env(map[string]string{"ATLAS_SANDBOX_EVENT_SOURCE": "kafka", "ATLAS_KAFKA_BROKERS": "a:9092, b:9092"}), false)
	if err != nil || len(k.KafkaBrokers) != 2 {
		t.Fatalf("kafka %v %v", k.KafkaBrokers, err)
	}
	bad := []struct {
		over   map[string]string
		worker bool
		want   string
	}{
		{map[string]string{"ATLAS_DATABASE_URL": ""}, false, "ATLAS_DATABASE_URL is required"},
		{map[string]string{"ATLAS_AUTH_SHARED_SECRET": "short"}, false, "ATLAS_AUTH_JWKS_URL"},
		{map[string]string{"ATLAS_AUTH_JWKS_URL": "not a url"}, false, "must be a URL"},
		{map[string]string{"ATLAS_SANDBOX_PORT": "0"}, false, "ATLAS_SANDBOX_PORT"},
		{map[string]string{"ATLAS_LOG_LEVEL": "loud"}, false, "ATLAS_LOG_LEVEL"},
		{map[string]string{"ATLAS_SANDBOX_EVENT_SOURCE": "rabbit"}, false, "none or kafka"},
		{map[string]string{"ATLAS_SANDBOX_EVENT_SOURCE": "kafka"}, false, "ATLAS_KAFKA_BROKERS is required"},
		{map[string]string{"ATLAS_JUDGE_IMAGE_DIGEST": "latest"}, true, "ATLAS_JUDGE_IMAGE_DIGEST"},
		{map[string]string{"ATLAS_JUDGE_BOX_POOL": "1"}, true, "ATLAS_JUDGE_BOX_POOL"},
		{map[string]string{"HOSTNAME": ""}, true, "ATLAS_JUDGE_WORKER_ID"},
		{map[string]string{"ATLAS_JUDGE_EXTRA_DIRS": "/var/run/secrets"}, true, "ATLAS_JUDGE_EXTRA_DIRS"},
		{map[string]string{"ATLAS_JUDGE_EXTRA_DIRS": "relative"}, true, "ATLAS_JUDGE_EXTRA_DIRS"},
		{map[string]string{"NODE_ENV": "production"}, false, "not allowed in production"},
		{map[string]string{"NODE_ENV": "production", "ATLAS_AUTH_SHARED_SECRET": "", "ATLAS_AUTH_JWKS_URL": "https://id/jwks"}, false, "ATLAS_SANDBOX_EVENT_SOURCE=none"},
		{map[string]string{"NODE_ENV": "production", "ATLAS_AUTH_SHARED_SECRET": "", "ATLAS_AUTH_JWKS_URL": "https://id/jwks"}, false, "ATLAS_S3_ENDPOINT"},
		{map[string]string{"NODE_ENV": "production", "ATLAS_AUTH_SHARED_SECRET": "", "ATLAS_AUTH_JWKS_URL": "https://id/jwks"}, true, "real digest"},
	}
	for _, b := range bad {
		if _, err := Load(env(b.over), b.worker); err == nil || !strings.Contains(err.Error(), b.want) {
			t.Errorf("%v: %v (want %q)", b.over, err, b.want)
		}
	}
	prod := env(map[string]string{
		"NODE_ENV": "production", "ATLAS_AUTH_SHARED_SECRET": "", "ATLAS_AUTH_JWKS_URL": "https://id/jwks",
		"ATLAS_SANDBOX_EVENT_SOURCE": "kafka", "ATLAS_KAFKA_BROKERS": "k:9092", "ATLAS_S3_ENDPOINT": "s3.amazonaws.com",
	})
	if _, err := Load(prod, false); err != nil {
		t.Fatalf("valid production config: %v", err)
	}
}

func TestServedLanguagesRequireTheImageDigest(t *testing.T) {
	mine, other := "sha256:"+strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64)
	all := []domain.Language{
		{ID: 71, Slug: "python", ImageDigest: mine, Enabled: true},
		{ID: 54, Slug: "cpp", ImageDigest: other, Enabled: true},
		{ID: 82, Slug: "sql", ImageDigest: mine, Enabled: false},
		{ID: 63, Slug: "node", ImageDigest: mine, Enabled: true},
	}
	got := ServedLanguages(all, []string{"python", "cpp", "sql"}, mine, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if len(got) != 1 || got[71].Slug != "python" {
		t.Fatalf("served %v", got)
	}
	c, _ := Load(env(nil), false)
	if _, err := Blobs(c); err != nil {
		t.Fatal(err)
	}
	c.S3Endpoint, c.S3Secure = "127.0.0.1:9000", false
	if _, err := Blobs(c); err != nil {
		t.Fatal(err)
	}
	if a, b := NewID(), NewID(); a == b || len(a) != 36 {
		t.Fatal("ids")
	}
	Logger(c, "test").Info("ok")
}
