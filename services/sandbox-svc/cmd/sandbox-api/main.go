// sandbox-api serves the judge API, consumes events and runs queue maintenance (lease reaper,
// 24 h run purge). Judging happens in cmd/judge-worker.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"atlas.dev/go-platform/auth"
	"atlas.dev/go-platform/kafka"

	"atlas.dev/sandbox-svc/internal/adapters/httpapi"
	"atlas.dev/sandbox-svc/internal/adapters/postgres"
	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/config"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.FromOS(false)
	if err != nil {
		return err
	}
	log := config.Logger(cfg, "sandbox-svc")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := postgres.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer store.Close()
	blobs, err := config.Blobs(cfg)
	if err != nil {
		return err
	}
	verifier, err := auth.NewJWTVerifier(ctx, cfg.AuthIssuer, cfg.AuthAudience, cfg.AuthJWKSURL, cfg.AuthSharedSecret, nil)
	if err != nil {
		return err
	}
	clock := app.SystemClock{}
	api := &app.API{Store: store, Blobs: blobs, Clock: clock, NewID: config.NewID}
	maint := &app.Maintenance{Store: store, Clock: clock, Log: log}
	go maint.Run(ctx, 5*time.Second)
	if cfg.EventSource == "kafka" {
		handlers := &app.Handlers{Store: store, Blobs: blobs, Clock: clock, Log: log, API: api}
		go func() {
			if err := kafka.Run(ctx, cfg.KafkaBrokers, app.ConsumerName, cfg.DeadLetterTopic, handlers, log); err != nil {
				log.Error("event consumer stopped", "err", err)
				stop()
			}
		}()
	}
	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           (&httpapi.Server{API: api, Verifier: verifier, Log: log}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Info("sandbox-svc listening", "port", cfg.Port)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
