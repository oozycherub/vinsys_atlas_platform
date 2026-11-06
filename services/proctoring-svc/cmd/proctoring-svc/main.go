// proctoring-svc: session start, signed event ingest, uploads, inference results, rules engine,
// finaliser, review API, event consumer and maintenance (partitions, retention, network gaps).
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
	"atlas.dev/go-platform/logging"
	"atlas.dev/go-platform/pgtx"

	"atlas.dev/proctoring-svc/internal/adapters/blob"
	"atlas.dev/proctoring-svc/internal/adapters/crypto"
	"atlas.dev/proctoring-svc/internal/adapters/httpapi"
	"atlas.dev/proctoring-svc/internal/adapters/postgres"
	"atlas.dev/proctoring-svc/internal/adapters/tenants"
	"atlas.dev/proctoring-svc/internal/app"
	"atlas.dev/proctoring-svc/internal/config"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	log := logging.New("proctoring-svc", cfg.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgtx.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	var blobs app.BlobStore = blob.NewMemory()
	if cfg.S3Endpoint != "" {
		if blobs, err = blob.NewS3(cfg.S3Endpoint, cfg.S3AccessKey, cfg.S3SecretKey, cfg.Bucket, cfg.S3Region, cfg.S3Secure); err != nil {
			return err
		}
	}
	cipher, err := crypto.NewAESGCM(cfg.DataKey)
	if err != nil {
		return err
	}
	var retention app.Retention = &tenants.Static{}
	if cfg.TenantSvcURL != "" {
		cc := &auth.ClientCredentials{TokenURL: cfg.TokenURL, ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret,
			Scopes: []string{"tenant-settings:read"}}
		retention = &tenants.Retention{BaseURL: cfg.TenantSvcURL, Token: cc.Token}
	}
	verifier, err := auth.NewJWTVerifier(ctx, cfg.AuthIssuer, cfg.AuthAudience, cfg.AuthJWKSURL, cfg.AuthSharedSecret, nil)
	if err != nil {
		return err
	}
	svc := &app.Service{Store: &postgres.Store{Pool: pool}, Blobs: blobs, Cipher: cipher, Retention: retention,
		Clock: app.SystemClock{}, Log: log, NewID: pgtx.NewID}
	maint := &app.Maintenance{S: svc, LogRetention: time.Duration(cfg.LogRetentionDays) * 24 * time.Hour}
	go maint.Run(ctx, 30*time.Second)
	if cfg.EventSource == "kafka" {
		go func() {
			if err := kafka.Run(ctx, cfg.KafkaBrokers, app.ConsumerName, cfg.DeadLetterTopic, &app.Handlers{S: svc}, log); err != nil {
				log.Error("event consumer stopped", "err", err)
				stop()
			}
		}()
	}
	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           (&httpapi.Server{S: svc, Verifier: verifier, Log: log}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Info("proctoring-svc listening", "port", cfg.Port)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
