// Package config reads the environment; invalid configuration stops the process at boot.
package config

import (
	"encoding/base64"
	"errors"
	"net/url"
	"strconv"
	"strings"
)

// Config holds proctoring-svc's settings.
type Config struct {
	Env, LogLevel string
	Port          int
	DatabaseURL   string

	AuthIssuer, AuthAudience, AuthJWKSURL, AuthSharedSecret string

	S3Endpoint, S3AccessKey, S3SecretKey, Bucket, S3Region string
	S3Secure                                               bool

	DataKey []byte // AES-256 key for session keys and biometric references

	TenantSvcURL, TokenURL, ClientID, ClientSecret string

	EventSource     string
	KafkaBrokers    []string
	DeadLetterTopic string

	LogRetentionDays int
}

// Load validates the environment.
func Load(getenv func(string) string) (Config, error) {
	var problems []string
	get := func(k, def string) string {
		if v := strings.TrimSpace(getenv(k)); v != "" {
			return v
		}
		return def
	}
	need := func(k string) string {
		v := get(k, "")
		if v == "" {
			problems = append(problems, k+" is required")
		}
		return v
	}
	num := func(k string, def, lo, hi int) int {
		n, err := strconv.Atoi(get(k, strconv.Itoa(def)))
		if err != nil || n < lo || n > hi {
			problems = append(problems, k+" must be an integer in ["+strconv.Itoa(lo)+", "+strconv.Itoa(hi)+"]")
		}
		return n
	}
	isURL := func(k, v string) {
		if u, err := url.Parse(v); v != "" && (err != nil || u.Scheme == "" || u.Host == "") {
			problems = append(problems, k+" must be a URL")
		}
	}
	c := Config{
		Env:              get("NODE_ENV", "development"),
		LogLevel:         get("ATLAS_LOG_LEVEL", "info"),
		Port:             num("ATLAS_PROCTORING_PORT", 8091, 1, 65535),
		DatabaseURL:      need("ATLAS_DATABASE_URL"),
		AuthIssuer:       need("ATLAS_AUTH_ISSUER"),
		AuthAudience:     need("ATLAS_AUTH_AUDIENCE"),
		AuthJWKSURL:      get("ATLAS_AUTH_JWKS_URL", ""),
		AuthSharedSecret: get("ATLAS_AUTH_SHARED_SECRET", ""),
		S3Endpoint:       get("ATLAS_S3_ENDPOINT", ""),
		S3AccessKey:      get("ATLAS_S3_ACCESS_KEY", ""),
		S3SecretKey:      get("ATLAS_S3_SECRET_KEY", ""),
		Bucket:           get("ATLAS_PROCTORING_BUCKET", "atlas-proctoring"),
		S3Region:         get("ATLAS_S3_REGION", "us-east-1"),
		S3Secure:         get("ATLAS_S3_SECURE", "true") == "true",
		TenantSvcURL:     get("ATLAS_TENANT_SVC_URL", ""),
		TokenURL:         get("ATLAS_IDENTITY_TOKEN_URL", ""),
		ClientID:         get("ATLAS_PROCTORING_CLIENT_ID", ""),
		ClientSecret:     get("ATLAS_PROCTORING_CLIENT_SECRET", ""),
		EventSource:      get("ATLAS_PROCTORING_EVENT_SOURCE", "none"),
		DeadLetterTopic:  get("ATLAS_PROCTORING_DEAD_LETTER_TOPIC", "proctoring-svc.events.dlq"),
		LogRetentionDays: num("ATLAS_PROCTORING_LOG_RETENTION_DAYS", 1095, 30, 3650),
	}
	if !map[string]bool{"debug": true, "info": true, "warn": true, "error": true}[c.LogLevel] {
		problems = append(problems, "ATLAS_LOG_LEVEL must be debug, info, warn or error")
	}
	isURL("ATLAS_AUTH_JWKS_URL", c.AuthJWKSURL)
	isURL("ATLAS_TENANT_SVC_URL", c.TenantSvcURL)
	isURL("ATLAS_IDENTITY_TOKEN_URL", c.TokenURL)
	if c.AuthJWKSURL == "" && len(c.AuthSharedSecret) < 32 {
		problems = append(problems, "set ATLAS_AUTH_JWKS_URL (or a shared secret of ≥ 32 characters outside production)")
	}
	key, err := base64.StdEncoding.DecodeString(need("ATLAS_PROCTORING_DATA_KEY"))
	if err != nil || len(key) != 32 {
		problems = append(problems, "ATLAS_PROCTORING_DATA_KEY must be 32 bytes, base64")
	}
	c.DataKey = key
	for _, b := range strings.Split(get("ATLAS_KAFKA_BROKERS", ""), ",") {
		if b = strings.TrimSpace(b); b != "" {
			c.KafkaBrokers = append(c.KafkaBrokers, b)
		}
	}
	if c.EventSource != "none" && c.EventSource != "kafka" {
		problems = append(problems, "ATLAS_PROCTORING_EVENT_SOURCE must be none or kafka")
	}
	if c.EventSource == "kafka" && len(c.KafkaBrokers) == 0 {
		problems = append(problems, "ATLAS_KAFKA_BROKERS is required when ATLAS_PROCTORING_EVENT_SOURCE=kafka")
	}
	if c.TenantSvcURL != "" && (c.TokenURL == "" || c.ClientID == "" || c.ClientSecret == "") {
		problems = append(problems, "ATLAS_TENANT_SVC_URL needs ATLAS_IDENTITY_TOKEN_URL and the proctoring client credentials")
	}
	if c.Env == "production" {
		for _, p := range []struct {
			bad  bool
			text string
		}{
			{c.AuthSharedSecret != "", "ATLAS_AUTH_SHARED_SECRET is not allowed in production (shared-secret tokens)"},
			{c.EventSource == "none", "ATLAS_PROCTORING_EVENT_SOURCE=none is not allowed in production"},
			{c.S3Endpoint == "", "ATLAS_S3_ENDPOINT is required in production (in-memory frames)"},
			{c.TenantSvcURL == "", "ATLAS_TENANT_SVC_URL is required in production (tenant frame retention)"},
		} {
			if p.bad {
				problems = append(problems, p.text)
			}
		}
	}
	if len(problems) > 0 {
		return c, errors.New("invalid configuration:\n  - " + strings.Join(problems, "\n  - "))
	}
	return c, nil
}
