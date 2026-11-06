package config

import (
	"log/slog"

	"atlas.dev/go-platform/logging"
	"atlas.dev/go-platform/pgtx"

	"atlas.dev/sandbox-svc/internal/adapters/blob"
	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

// Logger builds the JSON logger (fields as in the TS services).
func Logger(c Config, service string) *slog.Logger { return logging.New(service, c.LogLevel) }

// Blobs builds the bundle store: S3/MinIO when configured, memory otherwise (dev only).
func Blobs(c Config) (app.BlobStore, error) {
	if c.S3Endpoint == "" {
		return blob.NewMemory(), nil
	}
	return blob.NewS3(c.S3Endpoint, c.S3AccessKey, c.S3SecretKey, c.S3Bucket, c.S3Secure)
}

// NewID returns a UUIDv7 (MASTER_ORCHESTRATION_PROMPT §4.8).
func NewID() string { return pgtx.NewID() }

// ServedLanguages selects the registry rows this worker image serves. A row whose digest is not
// this image's digest is refused: the registry pins images by digest, never by tag.
func ServedLanguages(all []domain.Language, slugs []string, imageDigest string, log *slog.Logger) map[int]domain.Language {
	served := map[int]domain.Language{}
	for _, l := range all {
		wanted := false
		for _, s := range slugs {
			wanted = wanted || s == l.Slug
		}
		switch {
		case !wanted:
		case !l.Enabled:
			log.Warn("language disabled in the registry", "language", l.Slug)
		case l.ImageDigest != imageDigest:
			log.Error("registry digest differs from this image; language not served", "language", l.Slug, "registry", l.ImageDigest, "image", imageDigest)
		default:
			served[l.ID] = l
		}
	}
	return served
}
