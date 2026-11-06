// Package logging builds the JSON logger with the fields the TypeScript services use
// (ts, level, msg, service, request_id, tenant_id).
package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// New returns a JSON logger for service at level (debug|info|warn|error).
func New(service, level string) *slog.Logger { return NewTo(os.Stdout, service, level) }

// NewTo writes to w (tests capture logs to check that no PII is written).
func NewTo(w io.Writer, service, level string) *slog.Logger {
	lvl := map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError}[level]
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lvl, ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
		switch a.Key {
		case slog.TimeKey:
			a.Key = "ts"
		case slog.MessageKey:
			a.Key = "msg"
		case slog.LevelKey:
			a.Value = slog.StringValue(strings.ToLower(a.Value.String()))
		}
		return a
	}})
	return slog.New(h).With("service", service)
}

// Discard is a logger that writes nothing (tests).
func Discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
