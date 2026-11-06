package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func env(over map[string]string) func(string) string {
	base := map[string]string{
		"ATLAS_DATABASE_URL":        "postgres://u@h/db",
		"ATLAS_AUTH_ISSUER":         "https://id.atlas.test",
		"ATLAS_AUTH_AUDIENCE":       "atlas-api",
		"ATLAS_AUTH_SHARED_SECRET":  "test-only-shared-secret-at-least-32-chars!",
		"ATLAS_PROCTORING_DATA_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
	}
	for k, v := range over {
		base[k] = v
	}
	return func(k string) string { return base[k] }
}

func TestLoad(t *testing.T) {
	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 8091 || c.EventSource != "none" || len(c.DataKey) != 32 || c.LogRetentionDays != 1095 || c.S3Region != "us-east-1" {
		t.Fatalf("defaults %+v", c)
	}
	prod := map[string]string{"NODE_ENV": "production", "ATLAS_AUTH_SHARED_SECRET": "", "ATLAS_AUTH_JWKS_URL": "https://id/jwks",
		"ATLAS_PROCTORING_EVENT_SOURCE": "kafka", "ATLAS_KAFKA_BROKERS": "k:9092", "ATLAS_S3_ENDPOINT": "s3:443",
		"ATLAS_TENANT_SVC_URL": "http://tenant", "ATLAS_IDENTITY_TOKEN_URL": "http://id/token",
		"ATLAS_PROCTORING_CLIENT_ID": "svc", "ATLAS_PROCTORING_CLIENT_SECRET": "s"}
	if _, err := Load(env(prod)); err != nil {
		t.Fatalf("production: %v", err)
	}
	for _, bad := range []struct {
		over map[string]string
		want string
	}{
		{map[string]string{"ATLAS_DATABASE_URL": ""}, "ATLAS_DATABASE_URL"},
		{map[string]string{"ATLAS_PROCTORING_DATA_KEY": "c2hvcnQ="}, "DATA_KEY"},
		{map[string]string{"ATLAS_PROCTORING_DATA_KEY": "%%%"}, "DATA_KEY"},
		{map[string]string{"ATLAS_AUTH_SHARED_SECRET": "x"}, "JWKS"},
		{map[string]string{"ATLAS_LOG_LEVEL": "loud"}, "LOG_LEVEL"},
		{map[string]string{"ATLAS_PROCTORING_PORT": "x"}, "PORT"},
		{map[string]string{"ATLAS_PROCTORING_EVENT_SOURCE": "x"}, "none or kafka"},
		{map[string]string{"ATLAS_PROCTORING_EVENT_SOURCE": "kafka"}, "BROKERS"},
		{map[string]string{"ATLAS_TENANT_SVC_URL": "http://tenant"}, "client credentials"},
		{map[string]string{"ATLAS_TENANT_SVC_URL": "tenant"}, "must be a URL"},
		{map[string]string{"NODE_ENV": "production"}, "not allowed in production"},
	} {
		if _, err := Load(env(bad.over)); err == nil || !strings.Contains(err.Error(), bad.want) {
			t.Errorf("%v: %v", bad.over, err)
		}
	}
}
